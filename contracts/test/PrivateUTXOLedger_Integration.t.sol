// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Integration test for mint transactions
contract PrivateUTXOLedgerIntegrationTest is PrivateUTXOLedgerBase {

    /// @notice Test mint transaction with computed roots
    function testRustHostMintTransaction() public {
        // Use EMPTY_TREE_ROOT as old root (contract starts with empty tree)
        bytes32 oldRoot = EMPTY_TREE_ROOT;

        bytes32[] memory nullifiers = new bytes32[](0); // No inputs in mint

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256("test-commitment-1");

        // Compute the expected new root
        bytes32 newRoot = _computeRootForSingleLeaf(commitments[0]);

        // Build outputs
        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(oldRoot, newRoot, nullifiers, commitments);

        // Create ledger starting from empty tree, with mock verifier
        PrivateUTXOLedger testLedger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));

        // Submit transaction
        bytes memory publicValues = _encodePublicValues(outputs);
        testLedger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), publicValues);

        // Verify state updated correctly
        assertEq(testLedger.currentRoot(), newRoot, "Root should update to newRoot");
    }
}