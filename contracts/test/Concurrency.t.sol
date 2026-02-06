// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PrivateUTXOLedger.sol";
import "../src/MerkleTree.sol";

contract MockSP1VerifierForConcurrency {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {
        // Always passes
    }
}

contract ConcurrencyTest is Test {
    using MerkleTree for MerkleTree.Tree;

    PrivateUTXOLedger ledger;
    MockSP1VerifierForConcurrency mockVerifier;
    bytes32 constant EMPTY_TREE_ROOT = 0x8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9;

    function setUp() public {
        mockVerifier = new MockSP1VerifierForConcurrency();
        ledger = new PrivateUTXOLedger(address(0), address(mockVerifier), address(0));
    }

    function _encodePublicValues(PrivateUTXOLedger.PublicOutputs memory outputs) internal pure returns (bytes memory) {
        return abi.encode(outputs);
    }

    function testConcurrentTxSubmission() public {
        // 1. Initial State: Empty Tree
        assertEq(ledger.currentRoot(), EMPTY_TREE_ROOT);

        // 2. User A Deposits (Creates functionality of "Block 1")
        // This is done via normal deposit to advance the state
        bytes32 commitmentA = bytes32(uint256(0xAAAA));
        PrivateUTXOLedger.OutputCiphertext memory cipherA = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitmentA,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(0)
        });
        
        // Passing msg.value to satisfy `deposit` if it was ETH, but token=0 means ETH.
        // We will just use the `deposit` overload that allows skipping value check if logic allows, 
        // or just send value.
        ledger.deposit{value: 1 ether}(commitmentA, cipherA, 1 ether);
        
        bytes32 rootAfterA = ledger.currentRoot();
        assertFalse(rootAfterA == EMPTY_TREE_ROOT);

        // 3. User B generates a proof against `rootAfterA`
        // ... (Offline generation takes time) ...

        // 4. Meanwhile, User C Deposits (Advancing state to Block 2)
        bytes32 commitmentC = bytes32(uint256(0xCCCC));
        PrivateUTXOLedger.OutputCiphertext memory cipherC = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitmentC,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(0)
        });
        ledger.deposit{value: 1 ether}(commitmentC, cipherC, 1 ether);

        bytes32 rootAfterC = ledger.currentRoot();
        assertFalse(rootAfterC == rootAfterA);

        // 5. User B submits their transaction NOW.
        // The proof was generated against `rootAfterA`.
        // The contract is currently at `rootAfterC`.
        // This should SUCCEED with the fix.

        PrivateUTXOLedger.PublicOutputs memory outputs;
        outputs.oldRoot = rootAfterA; // HISTORIC ROOT
        // The ZK proof would have calculated a new root based strictly on A + B.
        // But the contract will ignore this and calculate C + B.
        // Note: newRoot was removed from PublicOutputs struct
        outputs.nullifiers = new bytes32[](1);
        outputs.nullifiers[0] = bytes32(uint256(0xB));
        outputs.outputCommitments = new bytes32[](1);
        outputs.outputCommitments[0] = bytes32(uint256(0xBBBB));

        PrivateUTXOLedger.OutputCiphertext[] memory encryptedB = new PrivateUTXOLedger.OutputCiphertext[](1);
        encryptedB[0] = PrivateUTXOLedger.OutputCiphertext({
            commitment: bytes32(uint256(0xBBBB)),
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(0)
        });

        bytes memory dummyProof = hex"";
        bytes memory publicValues = _encodePublicValues(outputs);

        // SUBMIT
        ledger.submitTx(encryptedB, dummyProof, publicValues);

        // 6. Verify correct state updates
        // The root should have changed again (to include B)
        assertTrue(ledger.currentRoot() != rootAfterC);
        // Nullifier should be spent
        assertTrue(ledger.nullifierUsed(outputs.nullifiers[0]));
    }
}
