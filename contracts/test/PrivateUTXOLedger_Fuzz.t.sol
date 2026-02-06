// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Simple fuzz tests for PrivateUTXOLedger.
contract PrivateUTXOLedgerFuzzTest is PrivateUTXOLedgerBase {
    /// @dev Fuzz that we can always do a valid single-nullifier tx,
    ///      provided we start from the correct root and the nullifier
    ///      hasn't been used yet.
    function testFuzz_SingleTxNoDoubleSpend(bytes32 nf, bytes32 commitmentSeed) public {
        // Avoid trivial collisions with zero (not necessary, but tidy).
        vm.assume(nf != bytes32(0));

        // Build a single-nullifier tx from EMPTY_TREE_ROOT -> computed root
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nf;

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256(abi.encodePacked("commit", nf, commitmentSeed));

        // Compute the correct new root
        bytes32 newRoot = _computeRootForSingleLeaf(commitments[0]);

        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(EMPTY_TREE_ROOT, newRoot, nullifiers, commitments);

        // First submit should always succeed (since mapping is clean).
        bytes memory publicValues = _encodePublicValues(outputs);
        ledger.submitTx(_dummyEncryptedOutputs(commitments), _dummyProof(), publicValues);

        // Root should now be newRoot, nullifier should be used.
        assertEq(ledger.currentRoot(), newRoot);
        assertTrue(ledger.nullifierUsed(nf));

        // Second submit: update oldRoot to match current state, keeping same nullifier
        // This way it will pass the root check and fail on the nullifier check
        bytes32[] memory commitments2 = new bytes32[](1);
        commitments2[0] = keccak256(abi.encodePacked("commit2", nf, commitmentSeed));

        // For simplicity, we don't compute exact root - we expect to fail on nullifier check first
        PrivateUTXOLedger.PublicOutputs memory outputs2 =
            _buildOutputs(newRoot, keccak256(abi.encodePacked("root2", newRoot)), nullifiers, commitments2);

        bytes memory publicValues2 = _encodePublicValues(outputs2);
        vm.expectRevert(bytes("Nullifier already used"));
        ledger.submitTx(_dummyEncryptedOutputs(commitments2), _dummyProof(), publicValues2);
    }
}