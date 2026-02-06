// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PrivateUTXOLedger_Base.t.sol";

/// @notice Tests for deposit and withdraw functionality
contract PrivateUTXOLedgerDepositWithdrawTest is PrivateUTXOLedgerBase {

    // Updated event signature includes leafIndex
    event Deposited(address indexed from, uint256 amount, bytes32 commitment, uint256 leafIndex);
    event Withdrawn(address indexed to, uint256 amount);
    
    /// @notice Test depositing ETH creates a private note
    function testDeposit() public {
        uint256 depositAmount = 1 ether;
        bytes32 commitment = keccak256("test-commitment");
        
        // Create dummy encrypted output
        PrivateUTXOLedger.OutputCiphertext memory encrypted = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(100)
        });
        
        bytes32 oldRoot = ledger.currentRoot();

        // Expect Deposited event (now includes leafIndex = 0 for first deposit)
        vm.expectEmit(true, false, false, true, address(ledger));
        emit Deposited(address(this), depositAmount, commitment, 0);

        // Deposit ETH
        ledger.deposit{value: depositAmount}(commitment, encrypted, 0);
        
        // Verify state
        assertEq(ledger.totalDeposited(), depositAmount, "Total deposited should match");
        assertEq(address(ledger).balance, depositAmount, "Contract balance should match");
        assertFalse(ledger.currentRoot() == oldRoot, "Root should update");
    }
    
    /// @notice Test withdrawal sends ETH to recipient
    function testWithdraw() public {
        // First deposit
        uint256 depositAmount = 2 ether;
        bytes32 commitment = keccak256("deposit-commitment");
        
        PrivateUTXOLedger.OutputCiphertext memory encrypted = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(100)
        });
        
        ledger.deposit{value: depositAmount}(commitment, encrypted, 0);
        
        // Now withdraw
        uint256 withdrawAmount = 1 ether;
        address recipient = address(0x123);
        
        bytes32 oldRoot = ledger.currentRoot();
        bytes32 newRoot = keccak256(abi.encodePacked(oldRoot, "new-state"));
        
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("spend-nullifier");
        
        PrivateUTXOLedger.PublicOutputs memory outputs = _buildOutputs(
            oldRoot,
            newRoot,
            nullifiers,
            new bytes32[](0) // No new outputs in withdraw
        );
        
        uint256 recipientBalanceBefore = recipient.balance;
        
        // Expect Withdrawn event
        vm.expectEmit(true, false, false, true, address(ledger));
        emit Withdrawn(recipient, withdrawAmount);
        
        // Withdraw - SECURITY FIX: outputs now passed via publicValues
        bytes memory publicValues = _encodePublicValues(outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory emptyOutputs = new PrivateUTXOLedger.OutputCiphertext[](0);
        ledger.withdraw(recipient, withdrawAmount, _dummyProof(), publicValues, emptyOutputs);

        // Verify
        assertEq(recipient.balance, recipientBalanceBefore + withdrawAmount, "Recipient should receive ETH");
        assertEq(ledger.totalDeposited(), depositAmount - withdrawAmount, "Total deposited should decrease");
        assertTrue(ledger.nullifierUsed(nullifiers[0]), "Nullifier should be marked used");
    }
    
    /// @notice Test cannot withdraw more than deposited
    function testCannotWithdrawMoreThanDeposited() public {
        uint256 depositAmount = 1 ether;
        bytes32 commitment = keccak256("deposit");
        
        PrivateUTXOLedger.OutputCiphertext memory encrypted = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(100)
        });
        
        ledger.deposit{value: depositAmount}(commitment, encrypted, 0);
        
        // Try to withdraw more
        bytes32 oldRoot = ledger.currentRoot();
        PrivateUTXOLedger.PublicOutputs memory outputs = _buildOutputs(
            oldRoot,
            keccak256("new-root"),
            new bytes32[](0),
            new bytes32[](0)
        );
        
        bytes memory publicValues = _encodePublicValues(outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory emptyOutputs = new PrivateUTXOLedger.OutputCiphertext[](0);
        vm.expectRevert(bytes("Insufficient contract balance"));
        ledger.withdraw(address(0x123), 2 ether, _dummyProof(), publicValues, emptyOutputs);
    }
    
    /// @notice Test deposit must include ETH
    function testDepositRequiresETH() public {
        bytes32 commitment = keccak256("test");
        PrivateUTXOLedger.OutputCiphertext memory encrypted = PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: new bytes(33),
            nonce: bytes12(0),
            ciphertext: new bytes(100)
        });
        
        vm.expectRevert(bytes("Must deposit ETH"));
        ledger.deposit{value: 0}(commitment, encrypted, 0);
    }
}