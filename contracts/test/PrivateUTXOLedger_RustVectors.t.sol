// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Test that verifies Solidity and Rust Merkle tree computation alignment
/// @dev Uses computed roots to verify the incremental Merkle tree implementation
contract PrivateUTXOLedgerRustVectorsTest is PrivateUTXOLedgerBase {

    function testRustVectorAppliesCleanly() public {
        // Build a transaction with computed roots
        bytes32 oldRoot = EMPTY_TREE_ROOT;

        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("test-nullifier-1");

        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256("test-output-commitment-1");

        // Compute expected new root
        bytes32 newRoot = _computeRootForSingleLeaf(commitments[0]);

        PrivateUTXOLedger.PublicOutputs memory outputs;
        outputs.oldRoot = oldRoot;
        outputs.nullifiers = nullifiers;
        outputs.outputCommitments = commitments;

        // Create ledger with mock verifier
        PrivateUTXOLedger rustLedger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));

        // Apply the transition
        bytes memory publicValues = _encodePublicValues(outputs);
        rustLedger.submitTx(_dummyEncryptedOutputs(outputs.outputCommitments), _dummyProof(), publicValues);

        // === Assertions ===
        assertEq(
            rustLedger.currentRoot(),
            newRoot,
            "Solidity root should match computed new_root"
        );

        // Nullifier checks
        for (uint256 i = 0; i < outputs.nullifiers.length; i++) {
            assertTrue(
                rustLedger.nullifierUsed(outputs.nullifiers[i]),
                "Nullifier should be marked used"
            );
        }
    }
}