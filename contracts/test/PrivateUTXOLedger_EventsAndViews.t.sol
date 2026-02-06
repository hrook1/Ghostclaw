// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Tests focused on events + simple getters `currentRoot`, `nullifierUsed`).
contract PrivateUTXOLedgerEventsAndViewsTest is PrivateUTXOLedgerBase {
    // Re-declare events so forge-std's expectEmit can use them.
    event RootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot);

    /// @notice `currentRoot` is wired to the state variable and updates on submitTx.
    function testCurrentRootViewReflectsLatestState() public {
        assertEq(ledger.currentRoot(), EMPTY_TREE_ROOT, "initial root mismatch");

        // Empty tx - root stays the same
        PrivateUTXOLedger.PublicOutputs memory outputs =
            _emptyOutputs(EMPTY_TREE_ROOT, EMPTY_TREE_ROOT);

        bytes memory publicValues = _encodePublicValues(outputs);
        ledger.submitTx(_emptyEncryptedOutputs(), _dummyProof(), publicValues);

        assertEq(ledger.currentRoot(), EMPTY_TREE_ROOT, "currentRoot should remain empty");
    }

    /// @notice `nullifierUsed` returns false for untouched nullifiers.
    function testNullifierUsedFalseForUnseenNullifier() public {
        bytes32 nf = keccak256("views-unseen-nf");
        assertFalse(ledger.nullifierUsed(nf), "unseen nullifier should be false");
    }

    /// @notice `nullifierUsed` returns true after being used in a transaction.
    function testNullifierUsedTrueAfterSpend() public {
        bytes32 nf = keccak256("views-spent-nf");

        // Tx with nullifier but no outputs - root stays the same
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nf;

        bytes32[] memory commitments = new bytes32[](0);

        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(EMPTY_TREE_ROOT, EMPTY_TREE_ROOT, nullifiers, commitments);

        bytes memory publicValues = _encodePublicValues(outputs);
        ledger.submitTx(_emptyEncryptedOutputs(), _dummyProof(), publicValues);

        assertTrue(ledger.nullifierUsed(nf), "spent nullifier should be true");
    }

    /// @notice RootUpdated event fires with the expected parameters.
    function testEmitsRootUpdated() public {
        // Create a tx with commitments to change the root
        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256("event-commit-0");

        // Compute expected new root after inserting commitment
        bytes32 expectedNewRoot = _computeRootForSingleLeaf(commitments[0]);

        bytes32[] memory nullifiers = new bytes32[](0);

        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(EMPTY_TREE_ROOT, expectedNewRoot, nullifiers, commitments);

        // Expect RootUpdated
        vm.expectEmit(true, true, true, true, address(ledger));
        emit RootUpdated(EMPTY_TREE_ROOT, expectedNewRoot);

        bytes memory publicValues = _encodePublicValues(outputs);
        ledger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), publicValues);
    }
}