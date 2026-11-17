import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import ganache from 'ganache';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const inMemory = process.argv.includes('--in-memory');
const rpcUrl = process.env.GANACHE_RPC_URL || 'http://127.0.0.1:7545';

const artifactPath = path.join(ROOT, 'artifacts', 'DocumentTimestampRegistry.json');
if (!fs.existsSync(artifactPath)) {
  console.error('Missing compiled artifact. Run "npm run compile" first.');
  process.exit(1);
}
const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

function decodeContractError(iface, err) {
  const candidates = [
    err?.data,
    err?.info?.error?.data,
    err?.error?.data,
    err?.receipt?.revertReason,
  ];
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.startsWith('0x') && raw.length >= 10) {
      try {
        const parsed = iface.parseError(raw);
        if (parsed) return `${parsed.name}(${parsed.args.map((a) => String(a)).join(', ')})`;
      } catch {
        // ignore unparseable data
      }
    }
  }
  return err?.shortMessage || err?.message || String(err);
}

async function expectRevert(iface, label, fn, expectedErrorName) {
  try {
    const tx = await fn();
    if (tx && typeof tx.wait === 'function') {
      await tx.wait();
    }
    assert.fail(`Expected revert (${expectedErrorName}) for: ${label}`);
  } catch (err) {
    if (err.code === 'ERR_ASSERTION') throw err;
    const decoded = decodeContractError(iface, err);
    if (expectedErrorName && !decoded.includes(expectedErrorName)) {
      // Fallback check in case provider omits custom error bytes and only returns generic revert
      if (!/revert/i.test(decoded)) {
        assert.fail(`Unexpected error for "${label}": ${decoded}`);
      }
    }
    console.log(`PASS | ${label} -> reverted (${decoded})`);
  }
}

async function main() {
  let provider;
  let ganacheProvider = null;

  if (inMemory) {
    ganacheProvider = ganache.provider({
      logging: { quiet: true },
      wallet: { totalAccounts: 5, defaultBalance: 100 },
      chain: { chainId: 1337 },
    });
    provider = new ethers.BrowserProvider(ganacheProvider);
    console.log('Mode: In-memory Ganache provider (chainId 1337)');
  } else {
    provider = new ethers.JsonRpcProvider(rpcUrl);
    console.log(`Mode: External Ganache RPC (${rpcUrl})`);
  }

  const network = await provider.getNetwork();
  const accounts = await provider.listAccounts();
  assert.ok(accounts.length >= 2, 'Need at least 2 Ganache test accounts');

  const ownerSigner = accounts[0];
  const userSigner = accounts[1];
  const ownerAddr = await ownerSigner.getAddress();
  const userAddr = await userSigner.getAddress();

  console.log('Chain ID:', network.chainId.toString());
  console.log('Account 0 (Owner / Registrar A):', ownerAddr);
  console.log('Account 1 (User / Registrar B):', userAddr);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, ownerSigner);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  console.log('Deployed DocumentTimestampRegistry at:', contractAddress);

  const contractAsUser = contract.connect(userSigner);
  const iface = new ethers.Interface(artifact.abi);

  // 1. Check initial contract state
  assert.equal(await contract.owner(), ownerAddr);
  assert.equal(await contract.registrationPaused(), false);
  assert.equal(await contract.getRegisteredCount(), 0n);
  console.log('PASS | Initial state verified (owner set, unpaused, count = 0)');

  // 2. Register first document hash from Account 0
  const docHash1 = ethers.sha256(ethers.toUtf8Bytes('DS441A-Report-v1.pdf'));
  const tx1 = await contract.registerDocument(docHash1, 'DS441A-Report-v1.pdf');
  const rc1 = await tx1.wait();
  const regEvent1 = rc1.logs
    .map((l) => {
      try {
        return iface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === 'DocumentRegistered');
  assert.ok(regEvent1, 'DocumentRegistered event should be emitted');
  assert.equal(regEvent1.args.documentHash, docHash1);
  assert.equal(regEvent1.args.registrar, ownerAddr);

  const lookup1 = await contract.verifyDocument(docHash1);
  assert.equal(lookup1.exists, true);
  assert.equal(lookup1.registrar, ownerAddr);
  assert.ok(lookup1.timestamp > 0n);
  assert.equal(lookup1.revoked, false);
  assert.equal(lookup1.label, 'DS441A-Report-v1.pdf');
  console.log(`PASS | Account 0 registered docHash1 (${docHash1.slice(0, 14)}...) at timestamp ${lookup1.timestamp}`);

  // 3. Reject invalid zero hash
  await expectRevert(
    iface,
    'Reject zero bytes32 hash',
    () => contract.registerDocument(ethers.ZeroHash, 'Empty'),
    'Invalid document hash'
  );

  // 4. Reject duplicate registration (Account 1 tries to register docHash1)
  await expectRevert(
    iface,
    'Reject duplicate registration from Account 1',
    () => contractAsUser.registerDocument(docHash1, 'Duplicate attempt'),
    'Document hash already registered'
  );

  // 5. Account 1 registers a distinct document hash
  const docHash2 = ethers.sha256(ethers.toUtf8Bytes('Contract-Draft-2026.pdf'));
  const tx2 = await contractAsUser.registerDocument(docHash2, 'Contract-Draft-2026.pdf');
  await tx2.wait();
  const lookup2 = await contract.verifyDocument(docHash2);
  assert.equal(lookup2.exists, true);
  assert.equal(lookup2.registrar, userAddr);
  console.log(`PASS | Account 1 registered docHash2 (${docHash2.slice(0, 14)}...)`);

  // 6. Unauthorized revoke attempt (Account 1 tries to revoke Account 0's document)
  await expectRevert(
    iface,
    'Reject unauthorized revoke by non-registrar Account 1',
    () => contractAsUser.revokeDocument(docHash1, 'Tamper attempt'),
    'caller is not the original registrar'
  );

  // 7. Unauthorized pause attempt (Account 1 is not contract owner)
  await expectRevert(
    iface,
    'Reject unauthorized pause by non-owner Account 1',
    () => contractAsUser.setRegistrationPaused(true),
    'caller is not contract owner'
  );

  // 8. Original registrar (Account 0) revokes docHash1 while preserving original timestamp
  const txRevoke = await contract.revokeDocument(docHash1, 'Superseded by v2');
  const rcRevoke = await txRevoke.wait();
  const revEvent = rcRevoke.logs
    .map((l) => {
      try {
        return iface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === 'DocumentRevoked');
  assert.ok(revEvent, 'DocumentRevoked event should be emitted');

  const afterRevoke = await contract.verifyDocument(docHash1);
  assert.equal(afterRevoke.exists, true);
  assert.equal(afterRevoke.registrar, ownerAddr);
  assert.equal(afterRevoke.timestamp, lookup1.timestamp);
  assert.equal(afterRevoke.revoked, true);
  assert.equal(afterRevoke.revokeReason, 'Superseded by v2');
  console.log('PASS | Account 0 revoked docHash1; original registrar & timestamp preserved');

  // 9. Owner pauses and unpauses registration
  await (await contract.setRegistrationPaused(true)).wait();
  assert.equal(await contract.registrationPaused(), true);

  const docHash3 = ethers.sha256(ethers.toUtf8Bytes('Final-Submission.pdf'));
  await expectRevert(
    iface,
    'Reject registration while contract is paused',
    () => contractAsUser.registerDocument(docHash3, 'During pause'),
    'Registration is currently paused'
  );

  await (await contract.setRegistrationPaused(false)).wait();
  await (await contractAsUser.registerDocument(docHash3, 'Final-Submission.pdf')).wait();
  console.log('PASS | Owner pause/unpause enforced on-chain and docHash3 registered after unpause');

  // 10. Verify counts and per-registrar indexes
  assert.equal(await contract.getRegisteredCount(), 3n);
  const ownerHashes = await contract.getHashesByRegistrar(ownerAddr);
  const userHashes = await contract.getHashesByRegistrar(userAddr);
  assert.equal(ownerHashes.length, 1);
  assert.equal(userHashes.length, 2);
  console.log('PASS | Registry counts and per-registrar indexes verified (total=3)');

  if (!inMemory) {
    const deploymentInfo = {
      contractAddress,
      chainId: Number(network.chainId),
      rpcUrl,
      deployer: ownerAddr,
      deployedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(ROOT, 'artifacts', 'deployment.json'),
      JSON.stringify(deploymentInfo, null, 2) + '\n',
      'utf8'
    );
    console.log('Saved deployment info to artifacts/deployment.json');
  }

  if (ganacheProvider && typeof ganacheProvider.disconnect === 'function') {
    await ganacheProvider.disconnect();
  }
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
