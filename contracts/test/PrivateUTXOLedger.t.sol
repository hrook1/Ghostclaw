// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PrivateUTXOLedger.sol";
import "../src/MerkleTree.sol";

/// @notice Mock SP1 verifier that always passes verification (for testing)
contract MockSP1VerifierForRoots {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {
        // Always passes - used for testing
    }
}

/// @notice Tests for the PrivateUTXOLedger contract that focus on root logic.
/// @dev These tests avoid dealing with dynamic arrays so we can validate
///      core behavior (root continuity + revert paths) first.
/// @dev SECURITY FIX: Tests updated to use new function signatures where
///      outputs are decoded from publicValues (not passed separately).
contract PrivateUTXOLedgerTest is Test {
    // Empty tree root = ZEROS[31] from MerkleTree.sol
    bytes32 constant EMPTY_TREE_ROOT = 0x8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9;

    MockSP1VerifierForRoots mockVerifier;

    function setUp() public {
        mockVerifier = new MockSP1VerifierForRoots();
    }

    /// @notice Helper to encode PublicOutputs as publicValues (mimics SP1 ABI encoding)
    function _encodePublicValues(PrivateUTXOLedger.PublicOutputs memory outputs) internal pure returns (bytes memory) {
        return abi.encode(outputs);
    }

    /// @notice Compute expected root for a single leaf at index 0
    function _computeRootForSingleLeaf(bytes32 leaf) internal pure returns (bytes32) {
        bytes32 current = leaf;
        for (uint256 level = 0; level < 32; level++) {
            current = keccak256(abi.encodePacked(current, MerkleTree.zeros(level)));
        }
        return current;
    }

    /// @notice Basic sanity: root transition with empty tx (no outputs)
    function testRootsMatchRust() public {
        // Empty transaction: no nullifiers, no outputs, root stays the same
        PrivateUTXOLedger.PublicOutputs memory outputs;
        outputs.oldRoot = EMPTY_TREE_ROOT;
        outputs.nullifiers = new bytes32[](0);
        outputs.outputCommitments = new bytes32[](0);

        PrivateUTXOLedger ledger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));
        bytes memory dummyProof = hex"";
        bytes memory publicValues = _encodePublicValues(outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory emptyEncrypted =
            new PrivateUTXOLedger.OutputCiphertext[](0);

        ledger.submitTx(emptyEncrypted, dummyProof, publicValues);

        assertEq(ledger.currentRoot(), EMPTY_TREE_ROOT, "root should remain empty");
    }

    /// @notice Using a wrong oldRoot must revert (root continuity).
    /// @dev This mirrors the require(outputs.oldRoot == currentRoot) check.
    function testRevertsOnWrongOldRoot() public {
        PrivateUTXOLedger.PublicOutputs memory outputs;
        outputs.oldRoot = bytes32(uint256(123)); // clearly not EMPTY_TREE_ROOT
        outputs.nullifiers = new bytes32[](0);
        outputs.outputCommitments = new bytes32[](0);

        PrivateUTXOLedger ledger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));
        bytes memory dummyProof = hex"";
        bytes memory publicValues = _encodePublicValues(outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory emptyEncrypted =
            new PrivateUTXOLedger.OutputCiphertext[](0);

        vm.expectRevert(bytes("Invalid old root"));
        ledger.submitTx(emptyEncrypted, dummyProof, publicValues);
    }

    /// @notice Test that replay protection is enforced via nullifiers, not root freshness.
    /// @dev The contract allows old roots for backward compatibility with delayed proofs.
    ///      Replay protection comes from nullifier uniqueness - if you try to spend the
    ///      same UTXO twice, the nullifier would already be marked as used.
    function testReplayPreventedByNullifiers() public {
        // First, insert a leaf to change the root
        bytes32 commitment = bytes32(uint256(0x1234));
        bytes32 newRoot = _computeRootForSingleLeaf(commitment);
        bytes32 nullifier = bytes32(uint256(0xdead)); // Simulated nullifier

        PrivateUTXOLedger.PublicOutputs memory outputs;
        outputs.oldRoot = EMPTY_TREE_ROOT;
        outputs.nullifiers = new bytes32[](1);
        outputs.nullifiers[0] = nullifier;
        outputs.outputCommitments = new bytes32[](1);
        outputs.outputCommitments[0] = commitment;

        PrivateUTXOLedger ledger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));
        bytes memory dummyProof = hex"";
        bytes memory publicValues = _encodePublicValues(outputs);

        // Create encrypted outputs matching the commitment
        PrivateUTXOLedger.OutputCiphertext[] memory encryptedOutputs =
            new PrivateUTXOLedger.OutputCiphertext[](1);
        encryptedOutputs[0] = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(0)
        });

        // First submit: allowed.
        ledger.submitTx(encryptedOutputs, dummyProof, publicValues);
        assertEq(ledger.currentRoot(), newRoot, "root should advance");

        // Second submit: using old root is allowed, but nullifier is already used!
        vm.expectRevert(bytes("Nullifier already used"));
        ledger.submitTx(encryptedOutputs, dummyProof, publicValues);
    }
}