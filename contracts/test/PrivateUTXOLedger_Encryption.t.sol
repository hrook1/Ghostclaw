// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Test encrypted outputs end-to-end
contract PrivateUTXOLedgerEncryptionTest is PrivateUTXOLedgerBase {

    // Event now includes leafIndex
    event OutputCommitted(
        bytes32 indexed commitment,
        uint8 keyType,
        bytes ephemeralPubkey,
        bytes12 nonce,
        bytes ciphertext,
        uint256 leafIndex
    );

    /// @notice Test mint with encrypted output
    function testMintWithEncryptedOutput() public {
        bytes32 oldRoot = EMPTY_TREE_ROOT;

        bytes32[] memory nullifiers = new bytes32[](0);
        bytes32[] memory commitments = new bytes32[](1);
        commitments[0] = keccak256("encrypted-test-commitment");

        // Compute expected new root
        bytes32 newRoot = _computeRootForSingleLeaf(commitments[0]);

        PrivateUTXOLedger.PublicOutputs memory outputs =
            _buildOutputs(oldRoot, newRoot, nullifiers, commitments);

        // Build encrypted output
        PrivateUTXOLedger.OutputCiphertext[] memory encryptedOutputs =
            new PrivateUTXOLedger.OutputCiphertext[](1);

        encryptedOutputs[0] = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitments[0],
            keyType: 0,
            ephemeralPubkey: hex"02364a683c5b676ceef3ccdb5e059ca7b79a49b720c878fc573ccb5f1a57c8748e",
            nonce: 0x97aef39623e84d93b6f6ac71,
            ciphertext: hex"9939c3fe54d8d0c8ea688bfed2d68ef81d1aa6e4cdb69e7ccc0efde9fa2b7078"
        });

        // Create ledger with mock verifier
        PrivateUTXOLedger testLedger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));

        // Expect OutputCommitted event (note: leafIndex is now included)
        vm.expectEmit(true, false, false, true, address(testLedger));
        emit OutputCommitted(
            encryptedOutputs[0].commitment,
            encryptedOutputs[0].keyType,
            encryptedOutputs[0].ephemeralPubkey,
            encryptedOutputs[0].nonce,
            encryptedOutputs[0].ciphertext,
            0 // leafIndex for first insert
        );

        // Submit transaction
        bytes memory publicValues = _encodePublicValues(outputs);
        testLedger.submitTx(encryptedOutputs, _dummyProof(), publicValues);

        // Verify state updated
        assertEq(testLedger.currentRoot(), newRoot, "Root should update");
    }
}