// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PrivateUTXOLedger.sol";
import "../src/MerkleTree.sol";

/// @notice Mock SP1 verifier that always passes verification (for testing)
contract MockSP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {
        // Always passes - used for testing
    }
}

abstract contract PrivateUTXOLedgerBase is Test {
    /// @notice Empty tree root (ZEROS[31] from MerkleTree.sol)
    bytes32 internal constant EMPTY_TREE_ROOT = 0x8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9;

    PrivateUTXOLedger internal ledger;
    MockSP1Verifier internal mockVerifier;

    function setUp() public virtual {
        mockVerifier = new MockSP1Verifier();
        ledger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));
    }

    function _emptyOutputs(bytes32 oldRoot, bytes32 newRoot)
        internal
        pure
        returns (PrivateUTXOLedger.PublicOutputs memory outputs)
    {
        outputs.oldRoot = oldRoot;
        outputs.nullifiers = new bytes32[](0);
        outputs.outputCommitments = new bytes32[](0);
    }

    function _buildOutputs(
        bytes32 oldRoot,
        bytes32 newRoot,
        bytes32[] memory nullifiers,
        bytes32[] memory outputCommitments
    ) internal pure returns (PrivateUTXOLedger.PublicOutputs memory outputs) {
        outputs.oldRoot = oldRoot;
        outputs.nullifiers = nullifiers;
        outputs.outputCommitments = outputCommitments;
    }

    function _emptyEncryptedOutputs()
        internal
        pure
        returns (PrivateUTXOLedger.OutputCiphertext[] memory)
    {
        return new PrivateUTXOLedger.OutputCiphertext[](0);
    }

    function _dummyEncryptedOutputs(bytes32[] memory commitments)
        internal
        pure
        returns (PrivateUTXOLedger.OutputCiphertext[] memory encrypted)
    {
        encrypted = new PrivateUTXOLedger.OutputCiphertext[](commitments.length);
        for (uint i = 0; i < commitments.length; i++) {
            encrypted[i] = PrivateUTXOLedger.OutputCiphertext({
                commitment: commitments[i],
                keyType: 0,
                ephemeralPubkey: new bytes(33),
                nonce: bytes12(0),
                ciphertext: new bytes(0)
            });
        }
    }

    function _dummyProof() internal pure returns (bytes memory) {
        return hex"";
    }

    /// @notice Helper to encode PublicOutputs as publicValues (mimics SP1 ABI encoding)
    /// @dev SECURITY FIX: Contract now decodes outputs from publicValues, not passed separately
    function _encodePublicValues(PrivateUTXOLedger.PublicOutputs memory outputs) internal pure returns (bytes memory) {
        return abi.encode(outputs);
    }

    /// @notice Compute the Merkle root for a single leaf at index 0
    /// @dev This matches MerkleTree.insert() for the first leaf
    function _computeRootForSingleLeaf(bytes32 leaf) internal pure returns (bytes32) {
        bytes32 current = leaf;
        for (uint256 level = 0; level < 32; level++) {
            // At each level, hash with the zero hash (we're always on the left for index 0)
            current = keccak256(abi.encodePacked(current, MerkleTree.zeros(level)));
        }
        return current;
    }

    /// @notice Compute the Merkle root for leaves at sequential indices starting from 0
    /// @dev Simulates incremental insertion like MerkleTree.insert()
    function _computeRootForLeaves(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) {
            return EMPTY_TREE_ROOT;
        }
        if (leaves.length == 1) {
            return _computeRootForSingleLeaf(leaves[0]);
        }

        // Simulate the incremental tree insertion
        bytes32[32] memory filledSubtrees;
        for (uint256 i = 0; i < 32; i++) {
            filledSubtrees[i] = MerkleTree.zeros(i);
        }

        bytes32 currentRoot;

        for (uint256 idx = 0; idx < leaves.length; idx++) {
            bytes32 currentHash = leaves[idx];
            uint256 currentIndex = idx;

            for (uint256 level = 0; level < 32; level++) {
                if (currentIndex % 2 == 0) {
                    // We're on the left, update filled subtree
                    filledSubtrees[level] = currentHash;
                    // Hash with zero on right (empty subtree)
                    currentHash = keccak256(abi.encodePacked(currentHash, MerkleTree.zeros(level)));
                } else {
                    // We're on the right, hash with filled subtree on left
                    currentHash = keccak256(abi.encodePacked(filledSubtrees[level], currentHash));
                }
                currentIndex = currentIndex / 2;
            }

            currentRoot = currentHash;
        }

        return currentRoot;
    }
}