// SPDX-License-Identifier: MIT
pragma solidity >=0.8.19 <0.9.0;

/**
 * @title DocumentTimestampRegistry
 * @notice Decentralized registry proving a document's SHA-256 / bytes32 hash
 *         was registered by a specific address at a specific blockchain timestamp.
 *         Only cryptographic hashes and minimal metadata are stored on-chain;
 *         the document file itself never leaves the user's machine.
 */
contract DocumentTimestampRegistry {
    struct DocumentRecord {
        bytes32 documentHash;
        address registrar;
        uint256 timestamp;
        uint256 blockNumber;
        bool exists;
        bool revoked;
        uint256 revokedAt;
        string label;
        string revokeReason;
    }

    address public owner;
    bool public registrationPaused;

    mapping(bytes32 => DocumentRecord) private records;
    bytes32[] private registeredHashes;
    mapping(address => bytes32[]) private hashesByRegistrar;

    event DocumentRegistered(
        bytes32 indexed documentHash,
        address indexed registrar,
        uint256 timestamp,
        uint256 blockNumber,
        string label
    );

    event DocumentRevoked(
        bytes32 indexed documentHash,
        address indexed registrar,
        uint256 revokedAt,
        string reason
    );

    event RegistrationPauseToggled(address indexed caller, bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    uint256 public constant MAX_LABEL_LENGTH = 128;

    modifier onlyOwner() {
        require(msg.sender == owner, "Unauthorized: caller is not contract owner");
        _;
    }

    modifier whenNotPaused() {
        require(!registrationPaused, "Registration is currently paused");
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /**
     * @notice Register a document hash on-chain. Any non-paused user can register
     *         a previously unregistered non-zero hash. Duplicate hashes are rejected.
     * @param documentHash SHA-256 (or Keccak-256) 32-byte digest of the document.
     * @param label Optional short label/reference (max 128 bytes); never store document contents.
     */
    function registerDocument(bytes32 documentHash, string calldata label) external whenNotPaused {
        require(documentHash != bytes32(0), "Invalid document hash: zero hash");
        require(bytes(label).length <= MAX_LABEL_LENGTH, "Label exceeds 128 bytes");

        DocumentRecord storage existing = records[documentHash];
        require(!existing.exists, "Document hash already registered");

        records[documentHash] = DocumentRecord({
            documentHash: documentHash,
            registrar: msg.sender,
            timestamp: block.timestamp,
            blockNumber: block.number,
            exists: true,
            revoked: false,
            revokedAt: 0,
            label: label,
            revokeReason: ""
        });

        registeredHashes.push(documentHash);
        hashesByRegistrar[msg.sender].push(documentHash);

        emit DocumentRegistered(documentHash, msg.sender, block.timestamp, block.number, label);
    }

    /**
     * @notice Revoke a previously registered document record.
     *         Only the original registrar address can revoke it.
     *         The original registrar and registration timestamp remain immutable on-chain.
     */
    function revokeDocument(bytes32 documentHash, string calldata reason) external {
        DocumentRecord storage record = records[documentHash];
        require(record.exists, "Document not found");
        require(msg.sender == record.registrar, "Unauthorized: caller is not the original registrar");
        require(!record.revoked, "Document already revoked");

        record.revoked = true;
        record.revokedAt = block.timestamp;
        record.revokeReason = reason;

        emit DocumentRevoked(documentHash, msg.sender, block.timestamp, reason);
    }

    /**
     * @notice Pause or unpause new document registrations. Owner-only administrative action.
     */
    function setRegistrationPaused(bool paused) external onlyOwner {
        registrationPaused = paused;
        emit RegistrationPauseToggled(msg.sender, paused);
    }

    /**
     * @notice Transfer contract ownership to a new non-zero address. Owner-only.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner: zero address");
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    /**
     * @notice Look up a document hash without storing the document itself.
     */
    function verifyDocument(bytes32 documentHash)
        external
        view
        returns (
            bool exists,
            address registrar,
            uint256 timestamp,
            uint256 blockNumber,
            bool revoked,
            uint256 revokedAt,
            string memory label,
            string memory revokeReason
        )
    {
        DocumentRecord storage record = records[documentHash];
        return (
            record.exists,
            record.registrar,
            record.timestamp,
            record.blockNumber,
            record.revoked,
            record.revokedAt,
            record.label,
            record.revokeReason
        );
    }

    function getRegisteredCount() external view returns (uint256) {
        return registeredHashes.length;
    }

    function getHashAt(uint256 index) external view returns (bytes32) {
        return registeredHashes[index];
    }

    function getHashesByRegistrar(address registrar) external view returns (bytes32[] memory) {
        return hashesByRegistrar[registrar];
    }
}
