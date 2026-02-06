// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Tests focused on nullifier usage & double-spend prevention.
contract PrivateUTXOLedgerNullifiersTest is PrivateUTXOLedgerBase {
    /// @notice Nullifier starts unused, becomes used after a tx.
    function testMarksNullifierAsUsedOnSubmit() public {
        bytes32 nf = keccak256("nf-1");

        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nf;

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256("commit-1");

        // Compute expected new root
        bytes32 newRoot = _computeRootForSingleLeaf(commitments[0]);

        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(EMPTY_TREE_ROOT, newRoot, nullifiers, commitments);

        assertFalse(ledger.nullifierUsed(nf), "nullifier should start unused");

        bytes memory publicValues = _encodePublicValues(outputs);
        ledger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), publicValues);

        assertTrue(ledger.nullifierUsed(nf), "nullifier should be marked used");
        assertEq(ledger.currentRoot(), newRoot, "root should update");
    }

    /// @notice Reusing the same nullifier in a later tx must revert.
    function testRevertsOnDoubleSpendAcrossTransactions() public {
        bytes32 nf = keccak256("nf-double-spend");

        // First tx: EMPTY_TREE_ROOT -> root1 with nf
        bytes32[] memory commitments1 = new bytes32[](1);
        commitments1[0] = keccak256("commit-ds-1");
        bytes32 root1 = _computeRootForSingleLeaf(commitments1[0]);
        {
            bytes32[] memory nullifiers = new bytes32[](1);
            nullifiers[0] = nf;

            PrivateUTXOLedger.PublicOutputs memory outputs =
                _buildOutputs(EMPTY_TREE_ROOT, root1, nullifiers, commitments1);

            bytes memory publicValues = _encodePublicValues(outputs);
            ledger.submitTx(_dummyEncryptedOutputs(commitments1), _dummyProof(), publicValues);
            assertTrue(ledger.nullifierUsed(nf), "nullifier should be used after first tx");
            assertEq(ledger.currentRoot(), root1, "root should move to root1");
        }

        // Second tx: root1 -> root2, trying to reuse nf.
        bytes32[] memory commitments2 = new bytes32[](1);
        commitments2[0] = keccak256("commit-ds-2");
        // For root2, we'd need to compute root with 2 leaves but for this test the exact root doesn't matter
        // since we expect the tx to revert on nullifier check before root check
        bytes32 root2 = keccak256("root-ds-2");
        {
            bytes32[] memory nullifiers = new bytes32[](1);
            nullifiers[0] = nf;

            PrivateUTXOLedger.PublicOutputs memory outputs =
                _buildOutputs(root1, root2, nullifiers, commitments2);

            bytes memory publicValues = _encodePublicValues(outputs);
            vm.expectRevert(bytes("Nullifier already used"));
            ledger.submitTx(_dummyEncryptedOutputs(commitments2), _dummyProof(), publicValues);
        }
    }

    /// @notice A single tx can include multiple nullifiers; all are marked used.
    function testMarksAllNullifiersInSingleTransaction() public {
        bytes32[] memory nullifiers = new bytes32[](3);
        nullifiers[0] = keccak256("nf-0");
        nullifiers[1] = keccak256("nf-1");
        nullifiers[2] = keccak256("nf-2");

        bytes32[] memory commitments = new bytes32[](2);
        commitments[0] = keccak256("commit-0");
        commitments[1] = keccak256("commit-1");

        // Compute expected root for 2 leaves
        bytes32 root1 = _computeRootForLeaves(commitments);

        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(EMPTY_TREE_ROOT, root1, nullifiers, commitments);

        bytes memory publicValues = _encodePublicValues(outputs);
        ledger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), publicValues);

        for (uint256 i = 0; i < nullifiers.length; i++) {
            assertTrue(
                ledger.nullifierUsed(nullifiers[i]),
                "each nullifier should be marked used"
            );
        }
    }

    /// @notice Different nullifiers are allowed in successive txs.
    function testAllowsDistinctNullifiersAcrossTransactions() public {
        bytes32 nf1 = keccak256("nf-distinct-1");
        bytes32 nf2 = keccak256("nf-distinct-2");

        // Tx1: EMPTY_TREE_ROOT -> root1 with nf1
        bytes32[] memory commitments1 = new bytes32[](1);
        commitments1[0] = keccak256("commit-distinct-1");
        bytes32 root1 = _computeRootForSingleLeaf(commitments1[0]);
        {
            bytes32[] memory nullifiers = new bytes32[](1);
            nullifiers[0] = nf1;

            PrivateUTXOLedger.PublicOutputs memory outputs =
                _buildOutputs(EMPTY_TREE_ROOT, root1, nullifiers, commitments1);

            bytes memory publicValues = _encodePublicValues(outputs);
            ledger.submitTx(_dummyEncryptedOutputs(commitments1), _dummyProof(), publicValues);
        }

        // Tx2: root1 -> root2 with nf2
        bytes32[] memory allCommitments = new bytes32[](2);
        allCommitments[0] = commitments1[0];
        allCommitments[1] = keccak256("commit-distinct-2");
        bytes32 root2 = _computeRootForLeaves(allCommitments);

        bytes32[] memory commitments2 = new bytes32[](1);
        commitments2[0] = allCommitments[1];
        {
            bytes32[] memory nullifiers = new bytes32[](1);
            nullifiers[0] = nf2;

            PrivateUTXOLedger.PublicOutputs memory outputs =
                _buildOutputs(root1, root2, nullifiers, commitments2);

            bytes memory publicValues = _encodePublicValues(outputs);
            ledger.submitTx(_dummyEncryptedOutputs(commitments2), _dummyProof(), publicValues);
        }

        assertTrue(ledger.nullifierUsed(nf1), "nf1 should be used");
        assertTrue(ledger.nullifierUsed(nf2), "nf2 should be used");
        assertEq(ledger.currentRoot(), root2, "root should end at root2");
    }
}