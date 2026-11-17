"""
Ganache Web3.py interaction & demonstration script for DocumentTimestampRegistry.

Course: DS 441 A - Blockchain: Theory & Practices
Student: Hua Viet Phuong (29211140476)
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from web3 import Web3
from web3.exceptions import ContractLogicError, Web3Exception

RPC_URL = "http://127.0.0.1:7545"
# Paste the deployed contract address from Remix or leave empty to auto-load from artifacts/deployment.json
CONTRACT_ADDRESS = ""

ROOT_DIR = Path(__file__).resolve().parent.parent
ARTIFACT_PATH = ROOT_DIR / "artifacts" / "DocumentTimestampRegistry.json"
DEPLOYMENT_PATH = ROOT_DIR / "artifacts" / "deployment.json"

# Optional fallback ABI JSON string (automatically populated if artifacts/DocumentTimestampRegistry.json exists)
ABI_JSON = "[]"


def load_artifact() -> dict[str, Any]:
    if ARTIFACT_PATH.exists():
        return json.loads(ARTIFACT_PATH.read_text(encoding="utf-8"))
    abi = json.loads(ABI_JSON)
    if not isinstance(abi, list) or not abi:
        raise ValueError(
            "ABI not found. Run 'npm run compile' to generate artifacts/DocumentTimestampRegistry.json "
            "or paste the ABI JSON array into ABI_JSON."
        )
    return {"abi": abi, "bytecode": ""}


def resolve_contract_address(cli_address: str | None) -> str:
    if cli_address:
        return cli_address
    if CONTRACT_ADDRESS:
        return CONTRACT_ADDRESS
    if DEPLOYMENT_PATH.exists():
        deployment = json.loads(DEPLOYMENT_PATH.read_text(encoding="utf-8"))
        addr = deployment.get("contractAddress", "")
        if addr:
            return addr
    raise ValueError(
        "No deployed contract address found. Paste the deployed address into CONTRACT_ADDRESS, "
        "pass --address 0x..., or pass --deploy to deploy a fresh instance to Ganache."
    )


def connect_ganache(rpc_url: str) -> Web3:
    w3 = Web3(Web3.HTTPProvider(rpc_url, request_kwargs={"timeout": 10}))
    if not w3.is_connected():
        raise ConnectionError(
            f"Cannot connect to Ganache at {rpc_url}. Check that Ganache is running and the URL is correct."
        )
    return w3


def deploy_contract(w3: Web3, artifact: dict[str, Any], deployer: str) -> str:
    bytecode = artifact.get("bytecode")
    if not bytecode:
        raise ValueError("Bytecode missing in artifact. Run 'npm run compile' first.")
    factory = w3.eth.contract(abi=artifact["abi"], bytecode=bytecode)
    tx_hash = factory.constructor().transact({"from": deployer, "gas": 3_000_000})
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    address = receipt["contractAddress"]
    DEPLOYMENT_PATH.parent.mkdir(parents=True, exist_ok=True)
    DEPLOYMENT_PATH.write_text(
        json.dumps(
            {
                "contractAddress": address,
                "chainId": w3.eth.chain_id,
                "rpcUrl": RPC_URL,
                "deployer": deployer,
                "deployedAt": datetime.now(timezone.utc).isoformat(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Deployed DocumentTimestampRegistry at {address} (tx: {tx_hash.hex()})")
    return address


def compute_sha256_bytes32(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def parse_bytes32_hex(value: str) -> bytes:
    cleaned = value[2:] if value.startswith("0x") else value
    if len(cleaned) != 64:
        raise ValueError("Expected a 32-byte (64-hex-character) SHA-256 hash.")
    return bytes.fromhex(cleaned)


def print_record(doc_hash_hex: str, record: tuple[Any, ...]) -> None:
    exists, registrar, timestamp, block_number, revoked, revoked_at, label, revoke_reason = record
    print(f"\nLookup for hash {doc_hash_hex}:")
    if not exists:
        print("  Status: NOT REGISTERED")
        return
    utc_time = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print("  Status       :", "REVOKED" if revoked else "REGISTERED (ACTIVE)")
    print("  Registrar    :", registrar)
    print("  Timestamp    :", f"{timestamp} ({utc_time})")
    print("  Block Number :", block_number)
    print("  Label        :", label or "(none)")
    if revoked:
        rev_utc = datetime.fromtimestamp(revoked_at, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        print("  Revoked At   :", f"{revoked_at} ({rev_utc})")
        print("  Revoke Reason:", revoke_reason or "(none)")


def run_demo(w3: Web3, contract: Any, accounts: list[str]) -> None:
    if len(accounts) < 2:
        raise RuntimeError("At least 2 unlocked Ganache accounts are required for the multi-account demo.")

    acct0, acct1 = accounts[0], accounts[1]
    print("\n--- Multi-Account Demo Workflow ---")
    print("Account 0 (Owner / Registrar A):", acct0)
    print("Account 1 (User  / Registrar B):", acct1)

    sample_content = f"DS441A-Demo-Document-{datetime.now(timezone.utc).timestamp()}".encode("utf-8")
    doc_hash = compute_sha256_bytes32(sample_content)
    doc_hash_hex = "0x" + doc_hash.hex()

    # 1. Successful registration by Account 0
    print(f"\n[1] Account 0 registering hash {doc_hash_hex} ...")
    tx_hash = contract.functions.registerDocument(doc_hash, "Python Demo Document.pdf").transact(
        {"from": acct0, "gas": 300_000}
    )
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    print(f"    SUCCESS | Tx: {tx_hash.hex()} | Gas used: {receipt['gasUsed']}")

    # 2. Hash lookup without storing the document
    record = contract.functions.verifyDocument(doc_hash).call()
    print_record(doc_hash_hex, record)

    # 3. Duplicate registration attempt by Account 1 (expected to revert)
    print("\n[2] Account 1 attempting duplicate registration of the same hash (should fail) ...")
    try:
        bad_tx = contract.functions.registerDocument(doc_hash, "Duplicate attempt").transact(
            {"from": acct1, "gas": 300_000}
        )
        w3.eth.wait_for_transaction_receipt(bad_tx)
        raise AssertionError("Duplicate registration unexpectedly succeeded!")
    except (ContractLogicError, Web3Exception, ValueError) as exc:
        print(f"    REJECTED AS EXPECTED | Duplicate blocked by contract: {exc}")

    # 4. Unauthorized revocation attempt by Account 1 (expected to revert)
    print("\n[3] Account 1 attempting to revoke Account 0's document (should fail) ...")
    try:
        unauth_tx = contract.functions.revokeDocument(doc_hash, "Unauthorized").transact(
            {"from": acct1, "gas": 300_000}
        )
        w3.eth.wait_for_transaction_receipt(unauth_tx)
        raise AssertionError("Unauthorized revocation unexpectedly succeeded!")
    except (ContractLogicError, Web3Exception, ValueError) as exc:
        print(f"    REJECTED AS EXPECTED | Address-based permission enforced: {exc}")

    # 5. Unauthorized pause attempt by Account 1 (expected to revert)
    print("\n[4] Account 1 attempting owner-only pause (should fail) ...")
    try:
        pause_tx = contract.functions.setRegistrationPaused(True).transact({"from": acct1, "gas": 200_000})
        w3.eth.wait_for_transaction_receipt(pause_tx)
        raise AssertionError("Unauthorized pause unexpectedly succeeded!")
    except (ContractLogicError, Web3Exception, ValueError) as exc:
        print(f"    REJECTED AS EXPECTED | Owner-only permission enforced: {exc}")

    # 6. Second account registers its own unique document hash
    doc_hash_2 = compute_sha256_bytes32(sample_content + b"-v2")
    doc_hash_2_hex = "0x" + doc_hash_2.hex()
    print(f"\n[5] Account 1 registering a distinct hash {doc_hash_2_hex} ...")
    tx_hash_2 = contract.functions.registerDocument(doc_hash_2, "Account1-Report.pdf").transact(
        {"from": acct1, "gas": 300_000}
    )
    w3.eth.wait_for_transaction_receipt(tx_hash_2)
    print(f"    SUCCESS | Tx: {tx_hash_2.hex()}")
    print_record(doc_hash_2_hex, contract.functions.verifyDocument(doc_hash_2).call())

    total = contract.functions.getRegisteredCount().call()
    print(f"\nTotal registered document hashes on-chain: {total}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Interact with DocumentTimestampRegistry on Ganache.")
    parser.add_argument("--rpc", default=RPC_URL, help="Ganache JSON-RPC URL (default: http://127.0.0.1:7545)")
    parser.add_argument("--address", default=None, help="Deployed contract address")
    parser.add_argument("--deploy", action="store_true", help="Deploy a new contract instance to Ganache first")
    parser.add_argument("--account-index", type=int, default=0, help="Ganache account index to sign transactions")

    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("demo", help="Run the full multi-account registration, lookup, and rejection demo")

    reg = subparsers.add_parser("register", help="Hash a file or text locally and register its SHA-256 hash")
    reg_group = reg.add_mutually_exclusive_group(required=True)
    reg_group.add_argument("--file", type=Path, help="Path to local file (only SHA-256 hash is sent on-chain)")
    reg_group.add_argument("--text", help="Text whose UTF-8 SHA-256 hash will be registered")
    reg_group.add_argument("--hash", dest="raw_hash", help="Precomputed 0x-prefixed 32-byte hex hash")
    reg.add_argument("--label", default="", help="Optional short label (max 128 bytes)")

    ver = subparsers.add_parser("verify", help="Look up a document hash on-chain")
    ver_group = ver.add_mutually_exclusive_group(required=True)
    ver_group.add_argument("--file", type=Path, help="Path to local file to hash and verify")
    ver_group.add_argument("--text", help="Text to hash and verify")
    ver_group.add_argument("--hash", dest="raw_hash", help="0x-prefixed 32-byte hex hash")

    args = parser.parse_args()
    artifact = load_artifact()
    abi = artifact["abi"]

    w3 = connect_ganache(args.rpc)
    accounts = w3.eth.accounts
    if not accounts:
        raise RuntimeError("No unlocked Ganache accounts found.")

    if args.deploy:
        target_address = deploy_contract(w3, artifact, accounts[args.account_index])
    else:
        target_address = resolve_contract_address(args.address)

    if not Web3.is_address(target_address):
        raise ValueError("Invalid deployed contract address.")

    address = Web3.to_checksum_address(target_address)
    if not w3.eth.get_code(address):
        raise ValueError("No contract code at this address on the connected network. Check the address and Ganache.")

    contract = w3.eth.contract(address=address, abi=abi)

    print("Connected to Ganache and DocumentTimestampRegistry!")
    print("Chain ID:", w3.eth.chain_id)
    print("Contract:", address)
    print("Owner   :", contract.functions.owner().call())
    print("Available unlocked accounts:", len(accounts))

    command = args.command or "demo"
    if command == "demo":
        run_demo(w3, contract, accounts)
        return

    if args.file is not None:
        digest = compute_sha256_bytes32(args.file.read_bytes())
    elif args.text is not None:
        digest = compute_sha256_bytes32(args.text.encode("utf-8"))
    else:
        digest = parse_bytes32_hex(args.raw_hash)
    digest_hex = "0x" + digest.hex()

    if command == "register":
        sender = accounts[args.account_index]
        tx_hash = contract.functions.registerDocument(digest, args.label).transact({"from": sender, "gas": 300_000})
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        print(f"Registered {digest_hex} from {sender} | Tx: {tx_hash.hex()} | Gas: {receipt['gasUsed']}")
        print_record(digest_hex, contract.functions.verifyDocument(digest).call())
    elif command == "verify":
        print_record(digest_hex, contract.functions.verifyDocument(digest).call())


if __name__ == "__main__":
    main()
