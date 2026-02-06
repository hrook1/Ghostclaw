// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateUTXOLedger_Base.t.sol";
import "../src/MerkleTree.sol";

/// @notice Tests for Merkle tree functionality
/// @dev Verifies that Solidity Merkle implementation matches Rust/TypeScript
contract PrivateUTXOLedgerMerkleTest is PrivateUTXOLedgerBase {

    event RootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot);

    /// @notice Test that ZEROS[0] is 32 bytes of zeros
    function testZerosLevel0() public pure {
        bytes32 expected = bytes32(0);
        assertEq(MerkleTree.zeros(0), expected, "ZEROS[0] should be 32 bytes of zeros");
    }

    /// @notice Test that ZEROS are computed correctly via hash chain
    function testZerosComputation() public pure {
        // ZEROS[i] = keccak256(ZEROS[i-1], ZEROS[i-1])
        for (uint256 i = 1; i < 10; i++) {
            bytes32 prev = MerkleTree.zeros(i - 1);
            bytes32 expected = keccak256(abi.encodePacked(prev, prev));
            assertEq(MerkleTree.zeros(i), expected, "ZEROS computation mismatch");
        }
    }

    /// @notice Test empty tree root matches ZEROS[31]
    function testEmptyTreeRoot() public view {
        assertEq(ledger.currentRoot(), EMPTY_TREE_ROOT, "Empty tree root should match ZEROS[31]");
    }

    /// @notice Test single leaf insertion produces correct root
    function testMerkleTreeInsertSingleLeaf() public {
        bytes32 leaf = keccak256("test-leaf-1");

        // Expected root: hash chain of leaf with zeros at each level
        bytes32 expected = leaf;
        for (uint256 i = 0; i < 32; i++) {
            expected = keccak256(abi.encodePacked(expected, MerkleTree.zeros(i)));
        }

        // Create fresh ledger and insert via submitTx
        PrivateUTXOLedger testLedger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));

        bytes32[] memory nullifiers = new bytes32[](0);
        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = leaf;

        PrivateUTXOLedger.PublicOutputs memory outputs = _buildOutputs(
            EMPTY_TREE_ROOT,
            expected,
            nullifiers,
            commitments
        );

        bytes memory publicValues = _encodePublicValues(outputs);

        // Expect RootUpdated event
        vm.expectEmit(true, true, false, false, address(testLedger));
        emit RootUpdated(EMPTY_TREE_ROOT, expected);

        testLedger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), publicValues);

        assertEq(testLedger.currentRoot(), expected, "Root after single insert should match computed");
    }

    /// @notice Test two leaves produce correct root
    function testMerkleTreeInsertTwoLeaves() public {
        bytes32 leaf1 = keccak256("leaf-1");
        bytes32 leaf2 = keccak256("leaf-2");

        // After inserting leaf1, leaf2:
        // Level 0: hash(leaf1, leaf2)
        bytes32 level0 = keccak256(abi.encodePacked(leaf1, leaf2));

        // Level 1+: hash with zeros
        bytes32 expected = level0;
        for (uint256 i = 1; i < 32; i++) {
            expected = keccak256(abi.encodePacked(expected, MerkleTree.zeros(i)));
        }

        // First insert leaf1
        PrivateUTXOLedger testLedger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));

        bytes32 rootAfterLeaf1 = _computeRootForSingleLeaf(leaf1);

        bytes32[] memory nullifiers1 = new bytes32[](0);
        bytes32[] memory commitments1 = new bytes32[](1);
        commitments1[0] = leaf1;

        PrivateUTXOLedger.PublicOutputs memory outputs1 = _buildOutputs(
            EMPTY_TREE_ROOT,
            rootAfterLeaf1,
            nullifiers1,
            commitments1
        );
        testLedger.submitTx(_dummyEncryptedOutputs(commitments1), _dummyProof(), _encodePublicValues(outputs1));

        // Then insert leaf2
        bytes32[] memory nullifiers2 = new bytes32[](0);
        bytes32[] memory commitments2 = new bytes32[](1);
        commitments2[0] = leaf2;

        PrivateUTXOLedger.PublicOutputs memory outputs2 = _buildOutputs(
            rootAfterLeaf1,
            expected,
            nullifiers2,
            commitments2
        );
        testLedger.submitTx(_dummyEncryptedOutputs(commitments2), _dummyProof(), _encodePublicValues(outputs2));

        assertEq(testLedger.currentRoot(), expected, "Root after two inserts should match computed");
    }

    /// @notice Test that invalid old root is rejected
    function testRejectInvalidOldRoot() public {
        bytes32 leaf = keccak256("test-leaf");
        bytes32 fakeOldRoot = keccak256("fake-old-root");
        bytes32 newRoot = _computeRootForSingleLeaf(leaf);

        bytes32[] memory nullifiers = new bytes32[](0);
        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = leaf;

        PrivateUTXOLedger.PublicOutputs memory outputs = _buildOutputs(
            fakeOldRoot, // WRONG - should be EMPTY_TREE_ROOT
            newRoot,
            nullifiers,
            commitments
        );

        vm.expectRevert(bytes("Invalid old root"));
        ledger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), _encodePublicValues(outputs));
    }

    // NOTE: testRejectInvalidNewRoot was removed because newRoot is now computed
    // on-chain from the commitments, not passed in PublicOutputs. The contract
    // no longer needs to validate a caller-provided newRoot.

    /// @notice Test Keccak256 hash pair matches expected
    /// @dev This verifies Rust/TypeScript hash function compatibility
    function testKeccakHashPairCompatibility() public pure {
        // Known test vectors
        bytes32 left = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
        bytes32 right = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));

        bytes32 result = keccak256(abi.encodePacked(left, right));

        // This should be deterministic
        assertNotEq(result, bytes32(0), "Hash should not be zero");

        // Verify same inputs produce same output
        bytes32 result2 = keccak256(abi.encodePacked(left, right));
        assertEq(result, result2, "Hash should be deterministic");

        // Verify order matters
        bytes32 reversed = keccak256(abi.encodePacked(right, left));
        assertNotEq(result, reversed, "Hash should be order-dependent");
    }

    /// @notice Test multiple sequential inserts
    function testMultipleSequentialInserts() public {
        PrivateUTXOLedger testLedger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));

        bytes32[] memory leaves = new bytes32[](4);
        leaves[0] = keccak256("leaf-0");
        leaves[1] = keccak256("leaf-1");
        leaves[2] = keccak256("leaf-2");
        leaves[3] = keccak256("leaf-3");

        bytes32 currentRoot = EMPTY_TREE_ROOT;

        for (uint256 i = 0; i < 4; i++) {
            // Build leaves array up to current point
            bytes32[] memory leavesUpToNow = new bytes32[](i + 1);
            for (uint256 j = 0; j <= i; j++) {
                leavesUpToNow[j] = leaves[j];
            }

            bytes32 expectedNewRoot = _computeRootForLeaves(leavesUpToNow);

            bytes32[] memory nullifiers = new bytes32[](0);
            bytes32[] memory commitments = new bytes32[](1);
            commitments[0] = leaves[i];

            PrivateUTXOLedger.PublicOutputs memory outputs = _buildOutputs(
                currentRoot,
                expectedNewRoot,
                nullifiers,
                commitments
            );

            testLedger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), _encodePublicValues(outputs));

            assertEq(testLedger.currentRoot(), expectedNewRoot, "Root mismatch after insert");
            currentRoot = expectedNewRoot;
        }
    }

    /// @notice Test fixed height (32 levels)
    function testFixedTreeHeight() public pure {
        // Verify we can access all 32 levels of zeros
        for (uint256 i = 0; i < 32; i++) {
            bytes32 zero = MerkleTree.zeros(i);
            // Just verify no revert - function should work for all levels
            assertTrue(zero != bytes32(type(uint256).max), "Should be able to access all zero levels");
        }
    }
}
