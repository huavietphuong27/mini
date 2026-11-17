# Document Timestamp Registry

**Course:** DS 441 A - Blockchain: Theory & Practices  
**Student:** Hứa Viết Phương  
**Student ID:** 29211140476  
**Project:** Individual Mini Project — Document Timestamp Registry

---

## Overview

`DocumentTimestampRegistry` proves on-chain that a document's cryptographic SHA-256 (`bytes32`) hash was registered by a specific Ethereum address at a specific blockchain timestamp and block number — **without ever uploading or storing the document contents on-chain**.

### Key Rules Enforced in Solidity (`contracts/DocumentTimestampRegistry.sol`)
- **Open Hash Registration:** Any account (when not paused) can call `registerDocument(bytes32 documentHash, string label)` for a non-zero hash.
- **Duplicate Rejection:** Re-registering an existing `documentHash` (by the same or a different account) reverts with `"Document hash already registered"`.
- **Zero-Hash Validation:** Passing `bytes32(0)` reverts with `"Invalid document hash: zero hash"`.
- **Hash Lookup Without Storing Documents:** `verifyDocument(bytes32 documentHash)` returns `(exists, registrar, timestamp, blockNumber, revoked, revokedAt, label, revokeReason)`.
- **Address-Based Permissions:**
  - **Original Registrar Only:** `revokeDocument(bytes32 documentHash, string reason)` can only be called by the original `registrar`; any other address is rejected (`"Unauthorized: caller is not the original registrar"`). Original `registrar` and `timestamp` remain immutable on-chain.
  - **Contract Owner Only:** `setRegistrationPaused(bool paused)` and `transferOwnership(address newOwner)` revert for non-owner accounts (`"Unauthorized: caller is not contract owner"`).
- **Events:** Emits `DocumentRegistered`, `DocumentRevoked`, `RegistrationPauseToggled`, and `OwnershipTransferred`.

---

## Project Structure

```text
document-timestamp-registry/
├── contracts/
│   └── DocumentTimestampRegistry.sol   # Solidity smart contract
├── python/
│   ├── interact_registry.py            # Python web3.py Ganache client & multi-account demo
│   └── requirements.txt                # Python dependency (web3)
├── frontend/
│   ├── index.html                      # Web3 HTML/JS DApp interface
│   ├── styles.css                      # UI styling
│   ├── app.js                          # ethers.js v6 wallet/Ganache + SHA-256 hashing logic
│   └── contract-config.js              # Auto-generated ABI & bytecode for frontend
├── scripts/
│   ├── compile.mjs                     # Compiles Solidity via solc & updates artifacts/frontend
│   ├── deploy_and_test.mjs             # Automated multi-account test suite (Ganache)
│   └── serve.mjs                       # Local static server for frontend (port 4173)
├── artifacts/
│   └── DocumentTimestampRegistry.json  # Compiled ABI & bytecode
├── package.json
└── README.md
```

---

## Prerequisites & Ganache Network Settings

- **Node.js** (v18+ recommended; tested on Node v24.22.1)
- **Python** (3.10+ recommended; tested on Python 3.12.16) with `web3` (`pip install -r python/requirements.txt`)
- **Ganache** (Ganache GUI, `ganache` CLI, or the bundled `ganache` npm devDependency)
  - **RPC URL:** `http://127.0.0.1:7545`
  - **Chain ID:** `1337` (or `5777` depending on Ganache GUI workspace)
  - **Accounts:** Ganache test accounts & test ETH only (never use real funds or real private keys).

---

## Setup, Compile & Automated Tests

1. Install Node.js dependencies and compile the contract:
   ```bash
   npm install
   npm run compile
   ```

2. Run the full automated test suite (uses an in-memory Ganache instance, no external Ganache needed):
   ```bash
   npm test
   ```

3. Or deploy & test against a running local Ganache at `http://127.0.0.1:7545`:
   ```bash
   npm run test:ganache
   ```
   This also saves the deployed contract address to `artifacts/deployment.json`.

---

## Running the Python `web3.py` Script

1. Install Python dependency:
   ```bash
   pip install -r python/requirements.txt
   ```

2. Start Ganache on `http://127.0.0.1:7545`, then run the multi-account demo (or pass `--deploy` to deploy a fresh contract from Python):
   ```bash
   python python/interact_registry.py --deploy demo
   ```

3. You can also register or verify an individual local file (the file stays local; only its SHA-256 hash is sent):
   ```bash
   python python/interact_registry.py register --file path/to/document.pdf --label "Midterm Report"
   python python/interact_registry.py verify --file path/to/document.pdf
   ```

---

## Running the Web3 Frontend (HTML / JS + ethers.js)

1. Start Ganache on `http://127.0.0.1:7545`.
2. Serve the `frontend/` directory locally:
   ```bash
   npm run serve
   ```
3. Open `http://127.0.0.1:4173` in your browser.
4. Click **Connect Ganache RPC** (with an account dropdown to switch between Account 0, Account 1, etc.) or **Connect MetaMask Wallet** configured for Ganache.
5. Click **Deploy New to Ganache** (or paste an existing deployed address and click **Load Contract**).
6. Test registering a file/hash, looking it up, attempting a duplicate registration from another account, attempting an unauthorized revoke/pause, and inspecting the on-chain events table.

---

## Observed Test Results (`npm test` & `npm run test:ganache`)

- `PASS | Initial state verified (owner set, unpaused, count = 0)`
- `PASS | Account 0 registered docHash1` (`DocumentRegistered` event emitted, `verifyDocument` returned registrar and block timestamp)
- `PASS | Reject zero bytes32 hash -> reverted`
- `PASS | Reject duplicate registration from Account 1 -> reverted`
- `PASS | Account 1 registered docHash2`
- `PASS | Reject unauthorized revoke by non-registrar Account 1 -> reverted`
- `PASS | Reject unauthorized pause by non-owner Account 1 -> reverted`
- `PASS | Account 0 revoked docHash1; original registrar & timestamp preserved`
- `PASS | Reject registration while contract is paused -> reverted`
- `PASS | Owner pause/unpause enforced on-chain and docHash3 registered after unpause`
- `PASS | Registry counts and per-registrar indexes verified (total=3)`

---

## External Libraries & Assistance Cited

- **Solidity (`solc`)**: Smart contract compilation.
- **Ganache (`ganache`)**: Local Ethereum test blockchain.
- **ethers.js v6 (`ethers`)**: Web3 provider, contract interaction, and automated test runner.
- **web3.py (`web3`)**: Python JSON-RPC interaction script (`python/interact_registry.py`).
- **Web Crypto API (`crypto.subtle.digest('SHA-256', ...)`)**: Client-side file hashing in the browser.
