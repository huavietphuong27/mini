(() => {
  const state = {
    mode: null, // 'ganache' | 'metamask'
    provider: null,
    signer: null,
    account: null,
    contract: null,
    contractAddress: null,
    owner: null,
    paused: false,
  };

  const $ = (id) => document.getElementById(id);

  function shortAddr(addr) {
    if (!addr) return '-';
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  }

  function formatUtc(ts) {
    if (!ts || Number(ts) === 0) return '-';
    return new Date(Number(ts) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  }

  function setBanner(type, message) {
    const el = $('statusBanner');
    el.className = `status-banner ${type}`;
    el.textContent = message;
  }

  function addLog(type, title, detail) {
    const list = $('eventLog');
    const item = document.createElement('div');
    item.className = `log-item ${type}`;
    const time = new Date().toLocaleTimeString();
    item.innerHTML = `<strong>[${time}] ${escapeHtml(title)}</strong><div class="mono" style="margin-top:4px; color: var(--muted)">${escapeHtml(detail)}</div>`;
    list.prepend(item);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function sha256Buffer(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    return (
      '0x' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
  }

  async function sha256File(file) {
    const buffer = await file.arrayBuffer();
    return sha256Buffer(buffer);
  }

  async function sha256Text(text) {
    const encoded = new TextEncoder().encode(text);
    return sha256Buffer(encoded);
  }

  function decodeError(err) {
    const cfg = window.CONTRACT_CONFIG;
    if (cfg && cfg.abi && window.ethers) {
      const iface = new ethers.Interface(cfg.abi);
      const candidates = [err?.data, err?.info?.error?.data, err?.error?.data];
      for (const raw of candidates) {
        if (typeof raw === 'string' && raw.startsWith('0x') && raw.length >= 10) {
          try {
            const parsed = iface.parseError(raw);
            if (parsed) {
              return `Contract Error ${parsed.name}(${parsed.args.map((a) => String(a)).join(', ')})`;
            }
          } catch {
            // ignore
          }
        }
      }
    }
    return err?.reason || err?.shortMessage || err?.info?.error?.message || err?.message || String(err);
  }

  function ensureContractLoaded() {
    if (!state.contract || !state.signer) {
      throw new Error('Connect to Ganache/MetaMask and load or deploy a contract first.');
    }
  }

  async function updateAccountStats() {
    if (!state.provider || !state.account) return;
    const balanceWei = await state.provider.getBalance(state.account);
    $('statAccount').textContent = state.account;
    $('statBalance').textContent = `${Number(ethers.formatEther(balanceWei)).toFixed(4)} ETH`;
    const net = await state.provider.getNetwork();
    $('networkBadge').textContent = `Chain: ${net.chainId.toString()}`;
    $('connectionBadge').textContent = state.mode === 'metamask' ? 'MetaMask Connected' : 'Ganache RPC Connected';
    $('connectionBadge').className = 'pill ok';
  }

  async function refreshContractState() {
    if (!state.contract) return;
    const [owner, paused, total] = await Promise.all([
      state.contract.owner(),
      state.contract.registrationPaused(),
      state.contract.getRegisteredCount(),
    ]);
    state.owner = owner;
    state.paused = paused;

    $('statOwner').textContent = owner;
    $('statPaused').textContent = paused ? 'PAUSED' : 'ACTIVE';
    $('statPaused').style.color = paused ? '#fcd34d' : '#86efac';
    $('statTotal').textContent = total.toString();

    const isOwner = state.account && owner.toLowerCase() === state.account.toLowerCase();
    $('roleBadge').textContent = isOwner ? 'Role: Contract Owner' : 'Role: Regular User';
    $('roleBadge').className = isOwner ? 'pill ok' : 'pill warn';

    await updateAccountStats();
    await loadRegisteredTable(Number(total));
    await loadRecentEvents();
  }

  async function loadRegisteredTable(totalCount) {
    const tbody = $('registryTableBody');
    if (!state.contract || totalCount === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="color: var(--muted)">No document hashes registered yet.</td></tr>';
      return;
    }
    const rows = [];
    const maxRows = Math.min(totalCount, 50);
    for (let i = totalCount - 1; i >= totalCount - maxRows; i--) {
      const hash = await state.contract.getHashAt(i);
      const rec = await state.contract.verifyDocument(hash);
      const statusPill = rec.revoked
        ? '<span class="pill err">Revoked</span>'
        : '<span class="pill ok">Active</span>';
      rows.push(`
        <tr>
          <td>${i + 1}</td>
          <td class="mono">${escapeHtml(hash)}</td>
          <td>${escapeHtml(rec.label || '-')}</td>
          <td class="mono" title="${escapeHtml(rec.registrar)}">${escapeHtml(shortAddr(rec.registrar))}</td>
          <td>${escapeHtml(formatUtc(rec.timestamp))}</td>
          <td>${statusPill}</td>
          <td>
            <button type="button" data-inspect="${escapeHtml(hash)}">Inspect</button>
          </td>
        </tr>
      `);
    }
    tbody.innerHTML = rows.join('');
    tbody.querySelectorAll('button[data-inspect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const h = btn.getAttribute('data-inspect');
        $('verifyHashInput').value = h;
        $('revokeHashInput').value = h;
        verifyHash(h);
      });
    });
  }

  async function loadRecentEvents() {
    if (!state.contract) return;
    const latest = await state.provider.getBlockNumber();
    const fromBlock = Math.max(0, latest - 5000);
    const events = await state.contract.queryFilter('*', fromBlock, latest);
    const list = $('eventLog');
    // Keep user action logs at top if needed; show on-chain events cleanly
    const existingChainHeader = document.getElementById('chainEventsHeader');
    if (existingChainHeader) existingChainHeader.remove();
    list.querySelectorAll('.chain-event').forEach((el) => el.remove());

    for (const ev of events.slice().reverse().slice(0, 20)) {
      const item = document.createElement('div');
      item.className = 'log-item chain-event';
      const argsStr = ev.args ? ev.args.map((a) => String(a)).join(' | ') : '';
      item.innerHTML = `<strong>[On-Chain Event] ${escapeHtml(ev.fragment?.name || 'Event')} (Block #${ev.blockNumber})</strong><div class="mono" style="margin-top:4px; color: var(--muted)">${escapeHtml(argsStr)}</div>`;
      list.appendChild(item);
    }
  }

  async function connectGanache() {
    try {
      const rpcUrl = $('rpcUrlInput').value.trim() || 'http://127.0.0.1:7545';
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const accounts = await provider.send('eth_accounts', []);
      if (!accounts || accounts.length === 0) {
        throw new Error('No unlocked accounts returned by Ganache.');
      }

      state.mode = 'ganache';
      state.provider = provider;

      const select = $('accountSelect');
      select.innerHTML = accounts
        .map((addr, idx) => `<option value="${addr}">Account ${idx}: ${addr}</option>`)
        .join('');
      select.disabled = false;

      state.account = accounts[0];
      state.signer = await provider.getSigner(state.account);
      await updateAccountStats();

      setBanner('ok', `Connected to Ganache RPC at ${rpcUrl} with ${accounts.length} unlocked accounts.`);
      addLog('ok', 'Ganache Connected', `RPC=${rpcUrl} | Active=${state.account}`);

      if (state.contractAddress) {
        await loadContract(state.contractAddress);
      }
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Ganache connection failed: ${msg}`);
      addLog('err', 'Ganache Connection Error', msg);
    }
  }

  async function connectMetaMask() {
    try {
      if (!window.ethereum) {
        throw new Error('MetaMask / EIP-1193 wallet not detected. Use Ganache RPC mode or install MetaMask.');
      }
      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const addr = await signer.getAddress();

      state.mode = 'metamask';
      state.provider = provider;
      state.signer = signer;
      state.account = addr;

      const select = $('accountSelect');
      select.innerHTML = `<option value="${addr}">Wallet: ${addr}</option>`;
      select.disabled = true;

      await updateAccountStats();
      setBanner('ok', `Connected MetaMask account ${addr}`);
      addLog('ok', 'MetaMask Connected', addr);

      if (state.contractAddress) {
        await loadContract(state.contractAddress);
      }
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `MetaMask connection failed: ${msg}`);
      addLog('err', 'MetaMask Error', msg);
    }
  }

  async function loadContract(addrInput) {
    try {
      if (!state.provider || !state.signer) {
        throw new Error('Connect Ganache RPC or MetaMask first.');
      }
      const addr = (addrInput || $('contractAddressInput').value).trim();
      if (!ethers.isAddress(addr)) {
        throw new Error('Enter a valid Ethereum contract address (0x...).');
      }
      const code = await state.provider.getCode(addr);
      if (!code || code === '0x') {
        throw new Error('No contract bytecode found at this address on the connected network.');
      }
      const cfg = window.CONTRACT_CONFIG;
      if (!cfg || !cfg.abi) {
        throw new Error('Missing contract-config.js ABI.');
      }
      state.contractAddress = ethers.getAddress(addr);
      $('contractAddressInput').value = state.contractAddress;
      state.contract = new ethers.Contract(state.contractAddress, cfg.abi, state.signer);

      await refreshContractState();
      setBanner('ok', `Loaded DocumentTimestampRegistry at ${state.contractAddress}`);
      addLog('ok', 'Contract Loaded', state.contractAddress);
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Load contract failed: ${msg}`);
      addLog('err', 'Load Contract Error', msg);
    }
  }

  async function deployContract() {
    try {
      if (!state.provider || !state.signer) {
        throw new Error('Connect Ganache RPC or MetaMask first.');
      }
      const cfg = window.CONTRACT_CONFIG;
      if (!cfg || !cfg.abi || !cfg.bytecode || cfg.bytecode === '0x') {
        throw new Error('Missing compiled bytecode in contract-config.js. Run "npm run compile".');
      }
      setBanner('info', 'Deploying DocumentTimestampRegistry to Ganache...');
      const factory = new ethers.ContractFactory(cfg.abi, cfg.bytecode, state.signer);
      const contract = await factory.deploy();
      await contract.waitForDeployment();
      const deployedAddr = await contract.getAddress();
      $('contractAddressInput').value = deployedAddr;
      await loadContract(deployedAddr);
      addLog('ok', 'Contract Deployed', `Address=${deployedAddr} | Owner=${state.account}`);
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Deployment failed: ${msg}`);
      addLog('err', 'Deploy Error', msg);
    }
  }

  async function registerDocument() {
    try {
      ensureContractLoaded();
      const hash = $('regHashInput').value.trim();
      const label = $('regLabelInput').value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error('Provide a valid 0x-prefixed 32-byte SHA-256 hex hash.');
      }
      setBanner('info', `Sending registerDocument transaction from ${shortAddr(state.account)}...`);
      const tx = await state.contract.registerDocument(hash, label);
      const receipt = await tx.wait();
      setBanner('ok', `Registered hash ${shortAddr(hash)} in tx ${receipt.hash}`);
      addLog('ok', 'DocumentRegistered', `Hash=${hash} | By=${state.account} | Tx=${receipt.hash}`);
      $('verifyHashInput').value = hash;
      await refreshContractState();
      await verifyHash(hash);
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Registration rejected: ${msg}`);
      addLog('err', 'Registration Rejected', msg);
    }
  }

  async function verifyHash(overrideHash) {
    try {
      ensureContractLoaded();
      const hash = (overrideHash || $('verifyHashInput').value).trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error('Provide a valid 0x-prefixed 32-byte SHA-256 hex hash.');
      }
      const rec = await state.contract.verifyDocument(hash);
      const box = $('verifyResult');
      if (!rec.exists) {
        box.innerHTML = `<span class="pill warn">Not Registered</span><div style="margin-top:8px">No on-chain timestamp exists for <span class="mono">${escapeHtml(hash)}</span>.</div>`;
        return;
      }
      box.innerHTML = `
        <div style="margin-bottom: 8px">
          ${rec.revoked ? '<span class="pill err">Registered (Revoked)</span>' : '<span class="pill ok">Verified On-Chain</span>'}
        </div>
        <dl>
          <dt>Document Hash</dt><dd class="mono">${escapeHtml(hash)}</dd>
          <dt>First Registrar</dt><dd class="mono">${escapeHtml(rec.registrar)}</dd>
          <dt>Block Timestamp</dt><dd>${escapeHtml(formatUtc(rec.timestamp))} (${rec.timestamp.toString()})</dd>
          <dt>Block Number</dt><dd>${rec.blockNumber.toString()}</dd>
          <dt>Label</dt><dd>${escapeHtml(rec.label || '-')}</dd>
          ${rec.revoked ? `<dt>Revoked At</dt><dd>${escapeHtml(formatUtc(rec.revokedAt))}</dd><dt>Revoke Reason</dt><dd>${escapeHtml(rec.revokeReason || '-')}</dd>` : ''}
        </dl>
      `;
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Lookup failed: ${msg}`);
      addLog('err', 'Lookup Error', msg);
    }
  }

  async function revokeDocument() {
    try {
      ensureContractLoaded();
      const hash = $('revokeHashInput').value.trim();
      const reason = $('revokeReasonInput').value.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error('Provide a valid 0x-prefixed 32-byte hash.');
      }
      setBanner('info', `Sending revokeDocument from ${shortAddr(state.account)}...`);
      const tx = await state.contract.revokeDocument(hash, reason);
      const receipt = await tx.wait();
      setBanner('ok', `Revoked ${shortAddr(hash)} in tx ${receipt.hash}`);
      addLog('ok', 'DocumentRevoked', `Hash=${hash} | By=${state.account} | Reason=${reason}`);
      await refreshContractState();
      await verifyHash(hash);
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Revoke rejected: ${msg}`);
      addLog('err', 'Revoke Rejected', msg);
    }
  }

  async function togglePause() {
    try {
      ensureContractLoaded();
      const target = !state.paused;
      setBanner('info', `Calling setRegistrationPaused(${target}) from ${shortAddr(state.account)}...`);
      const tx = await state.contract.setRegistrationPaused(target);
      const receipt = await tx.wait();
      setBanner('ok', `Registration paused set to ${target} (tx ${receipt.hash})`);
      addLog('ok', 'RegistrationPauseToggled', `Paused=${target} | By=${state.account}`);
      await refreshContractState();
    } catch (err) {
      const msg = decodeError(err);
      setBanner('err', `Owner action rejected: ${msg}`);
      addLog('err', 'Owner Action Rejected', msg);
    }
  }

  // Event bindings
  $('connectGanacheBtn').addEventListener('click', connectGanache);
  $('connectMetaMaskBtn').addEventListener('click', connectMetaMask);
  $('loadContractBtn').addEventListener('click', () => loadContract());
  $('deployContractBtn').addEventListener('click', deployContract);
  $('refreshStateBtn').addEventListener('click', refreshContractState);
  $('reloadTableBtn').addEventListener('click', refreshContractState);
  $('registerBtn').addEventListener('click', registerDocument);
  $('verifyBtn').addEventListener('click', () => verifyHash());
  $('revokeBtn').addEventListener('click', revokeDocument);
  $('togglePauseBtn').addEventListener('click', togglePause);
  $('clearLogBtn').addEventListener('click', () => {
    $('eventLog').innerHTML = '';
  });

  $('accountSelect').addEventListener('change', async (e) => {
    if (state.mode !== 'ganache' || !state.provider) return;
    state.account = e.target.value;
    state.signer = await state.provider.getSigner(state.account);
    if (state.contractAddress && window.CONTRACT_CONFIG) {
      state.contract = new ethers.Contract(state.contractAddress, window.CONTRACT_CONFIG.abi, state.signer);
      await refreshContractState();
    } else {
      await updateAccountStats();
    }
    addLog('info', 'Account Switched', `Active account: ${state.account}`);
  });

  $('regFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $('regHashInput').value = await sha256File(file);
    if (!$('regLabelInput').value.trim()) {
      $('regLabelInput').value = file.name.slice(0, 128);
    }
  });

  $('verifyFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const h = await sha256File(file);
    $('verifyHashInput').value = h;
    if (state.contract) {
      await verifyHash(h);
    }
  });

  $('hashRegTextBtn').addEventListener('click', async () => {
    const txt = $('regTextInput').value;
    if (!txt) return;
    $('regHashInput').value = await sha256Text(txt);
  });

  if (window.ethereum) {
    window.ethereum.on('accountsChanged', () => {
      if (state.mode === 'metamask') connectMetaMask();
    });
    window.ethereum.on('chainChanged', () => {
      if (state.mode === 'metamask') connectMetaMask();
    });
  }
})();
