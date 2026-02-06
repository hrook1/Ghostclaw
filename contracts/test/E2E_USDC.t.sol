// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PrivateUTXOLedger.sol";
import "../src/EncryptedContacts.sol";
import "../src/PaymentRequests.sol";
import "../src/MerkleTree.sol";
import "./mocks/MockERC20.sol";

/// @title E2E USDC Test Suite
/// @notice Complete end-to-end tests that mimic the real Sepolia testnet setup
/// @dev Uses mock USDC and mock SP1 verifier for fast local testing
contract E2E_USDC_Test is Test {
    // ============================================
    // CONTRACTS
    // ============================================
    PrivateUTXOLedger public ledger;
    EncryptedContacts public contacts;
    PrivatePaymentRequests public paymentRequests;
    MockERC20 public usdc;
    MockSP1Verifier public mockVerifier;

    // ============================================
    // TEST ACCOUNTS
    // ============================================
    address public alice;
    uint256 public alicePrivateKey;
    address public bob;
    uint256 public bobPrivateKey;
    address public relayer;

    // ============================================
    // CONSTANTS
    // ============================================
    /// @notice Empty tree root - ZEROS[31] from MerkleTree.sol
    bytes32 public constant EMPTY_TREE_ROOT = 0x8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9;
    uint256 public constant ONE_USDC = 1e6;
    uint256 public constant INITIAL_BALANCE = 10_000 * ONE_USDC; // 10,000 USDC

    // Track inserted leaves for computing roots
    bytes32[] internal _insertedLeaves;

    // ============================================
    // EVENTS
    // ============================================
    event Deposited(address indexed from, uint256 amount, bytes32 commitment);
    event Withdrawn(address indexed to, uint256 amount);
    event RootUpdated(bytes32 indexed oldRoot, bytes32 indexed newRoot);
    event OutputCommitted(
        bytes32 indexed commitment,
        uint8 keyType,
        bytes ephemeralPubkey,
        bytes12 nonce,
        bytes ciphertext
    );

    // ============================================
    // SETUP
    // ============================================
    function setUp() public {
        // Create test accounts with known private keys
        (alice, alicePrivateKey) = makeAddrAndKey("alice");
        (bob, bobPrivateKey) = makeAddrAndKey("bob");
        relayer = makeAddr("relayer");

        // Deploy mock contracts
        mockVerifier = new MockSP1Verifier();
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy UTXO ledger with USDC
        // Note: Merkle tree initializes to empty state automatically
        ledger = new PrivateUTXOLedger(
            address(0), // no secp256r1 precompile
            address(mockVerifier),
            address(usdc)
        );

        // Deploy auxiliary contracts
        contacts = new EncryptedContacts();
        paymentRequests = new PrivatePaymentRequests();

        // Fund test accounts with USDC
        usdc.mint(alice, INITIAL_BALANCE);
        usdc.mint(bob, INITIAL_BALANCE);

        // Approve ledger to spend USDC
        vm.prank(alice);
        usdc.approve(address(ledger), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(ledger), type(uint256).max);
    }

    // ============================================
    // HELPER FUNCTIONS
    // ============================================

    function _createEncrypted(bytes32 commitment) internal pure returns (PrivateUTXOLedger.OutputCiphertext memory) {
        return PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: hex"04aabbccdd00112233",
            nonce: bytes12(uint96(12345)),
            ciphertext: hex"aabbccdd00112233445566778899"
        });
    }

    function _createPublicOutputs(
        bytes32 oldRoot,
        bytes32, // newRoot removed from struct
        bytes32[] memory nullifiers,
        bytes32[] memory outputCommitments
    ) internal pure returns (bytes memory) {
        PrivateUTXOLedger.PublicOutputs memory outputs = PrivateUTXOLedger.PublicOutputs({
            oldRoot: oldRoot,
            nullifiers: nullifiers,
            outputCommitments: outputCommitments
        });
        return abi.encode(outputs);
    }

    function _emptyNullifiers() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _emptyOutputs() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    /// @notice Compute the Merkle root for a single leaf at index 0
    function _computeRootForSingleLeaf(bytes32 leaf) internal pure returns (bytes32) {
        bytes32 current = leaf;
        for (uint256 level = 0; level < 32; level++) {
            current = keccak256(abi.encodePacked(current, MerkleTree.zeros(level)));
        }
        return current;
    }

    /// @notice Compute the Merkle root for leaves at sequential indices starting from 0
    function _computeRootForLeaves(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) {
            return EMPTY_TREE_ROOT;
        }
        if (leaves.length == 1) {
            return _computeRootForSingleLeaf(leaves[0]);
        }

        // Simulate the incremental tree insertion
        bytes32[32] memory filledSubtrees;
        for (uint256 i = 0; i < 32; i++) {
            filledSubtrees[i] = MerkleTree.zeros(i);
        }

        bytes32 currentRoot;

        for (uint256 idx = 0; idx < leaves.length; idx++) {
            bytes32 currentHash = leaves[idx];
            uint256 currentIndex = idx;

            for (uint256 level = 0; level < 32; level++) {
                if (currentIndex % 2 == 0) {
                    filledSubtrees[level] = currentHash;
                    currentHash = keccak256(abi.encodePacked(currentHash, MerkleTree.zeros(level)));
                } else {
                    currentHash = keccak256(abi.encodePacked(filledSubtrees[level], currentHash));
                }
                currentIndex = currentIndex / 2;
            }

            currentRoot = currentHash;
        }

        return currentRoot;
    }

    /// @notice Track a new leaf and return the new root
    function _insertLeafAndGetRoot(bytes32 leaf) internal returns (bytes32) {
        _insertedLeaves.push(leaf);
        return _computeRootForLeaves(_insertedLeaves);
    }

    /// @notice Get current computed root from tracked leaves
    function _getCurrentComputedRoot() internal view returns (bytes32) {
        return _computeRootForLeaves(_insertedLeaves);
    }

    // ============================================
    // E2E TEST: COMPLETE PRIVACY FLOW
    // ============================================

    /// @notice Full flow: Alice deposits -> transfers to Bob -> Bob withdraws
    function test_E2E_DepositTransferWithdraw() public {
        console.log("=== E2E Test: Deposit -> Transfer -> Withdraw ===");

        // STEP 1: Alice deposits 1000 USDC
        bytes32 commitment = keccak256("alice_deposit_note");
        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), 1000 * ONE_USDC);

        assertEq(ledger.totalDeposited(), 1000 * ONE_USDC, "Deposit amount correct");
        bytes32 root1 = ledger.currentRoot();

        // Track the deposit commitment
        _insertedLeaves.push(commitment);

        // STEP 2: Alice transfers to Bob (600 to Bob, 400 change)
        {
            bytes32[] memory nf = new bytes32[](1);
            nf[0] = keccak256("alice_nf");
            bytes32[] memory outs = new bytes32[](2);
            outs[0] = keccak256("bob_600");
            outs[1] = keccak256("alice_400");

            // Compute new root after inserting the two new outputs
            bytes32 root2 = _insertLeafAndGetRoot(outs[0]);
            root2 = _insertLeafAndGetRoot(outs[1]);

            bytes memory pv = _createPublicOutputs(root1, root2, nf, outs);
            PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](2);
            enc[0] = _createEncrypted(outs[0]);
            enc[1] = _createEncrypted(outs[1]);

            vm.prank(relayer);
            ledger.submitTx(enc, "", pv);

            assertEq(ledger.currentRoot(), root2, "Root updated");
            assertTrue(ledger.nullifierUsed(nf[0]), "Nullifier used");
            root1 = root2; // Update for next step
        }

        // STEP 3: Bob withdraws 600 USDC (no new outputs)
        {
            bytes32[] memory nf = new bytes32[](1);
            nf[0] = keccak256("bob_nf");
            bytes32[] memory outs = new bytes32[](0);
            // No new outputs, so root stays the same
            bytes32 root3 = root1;

            bytes memory pv = _createPublicOutputs(root1, root3, nf, outs);
            PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](0);

            uint256 bobBefore = usdc.balanceOf(bob);
            vm.prank(relayer);
            ledger.withdraw(bob, 600 * ONE_USDC, "", pv, enc);

            assertEq(usdc.balanceOf(bob), bobBefore + 600 * ONE_USDC, "Bob received USDC");
            assertEq(ledger.totalDeposited(), 400 * ONE_USDC, "400 remaining");
        }

        console.log("=== E2E Test Complete ===");
    }

    /// @notice Test multiple users depositing concurrently
    function test_E2E_MultipleUsers() public {
        console.log("=== E2E Test: Multiple Users ===");

        // Alice deposits 500 USDC
        bytes32 c1 = keccak256("alice_500");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 500 * ONE_USDC);

        // Bob deposits 300 USDC
        bytes32 c2 = keccak256("bob_300");
        vm.prank(bob);
        ledger.deposit(c2, _createEncrypted(c2), 300 * ONE_USDC);

        // Total should be 800 USDC
        assertEq(ledger.totalDeposited(), 800 * ONE_USDC, "Total should be 800 USDC");
        assertEq(ledger.getBalance(), 800 * ONE_USDC, "Balance should match");

        console.log("Multiple deposits successful");
    }

    /// @notice Test deposit with change (depositAndTransfer)
    function test_E2E_DepositAndTransfer() public {
        console.log("=== E2E Test: Deposit and Transfer Atomically ===");

        // Alice deposits 1000 USDC and immediately splits it
        bytes32 depositCommitment = keccak256("deposit_1000");
        uint256 depositAmount = 1000 * ONE_USDC;

        // After deposit, root is computed from single leaf insertion
        bytes32 rootAfterDeposit = _computeRootForSingleLeaf(depositCommitment);

        // Transfer: create 2 output notes
        bytes32 nullifier = keccak256("spend_deposit");
        bytes32 output1 = keccak256("output_700");
        bytes32 output2 = keccak256("output_300");

        // Compute final root after adding both outputs
        _insertedLeaves.push(depositCommitment);
        bytes32 finalRoot = _insertLeafAndGetRoot(output1);
        finalRoot = _insertLeafAndGetRoot(output2);

        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nullifier;

        bytes32[] memory outputs = new bytes32[](2);
        outputs[0] = output1;
        outputs[1] = output2;

        bytes memory publicValues = _createPublicOutputs(rootAfterDeposit, finalRoot, nullifiers, outputs);

        PrivateUTXOLedger.OutputCiphertext[] memory encryptedOutputs = new PrivateUTXOLedger.OutputCiphertext[](2);
        encryptedOutputs[0] = _createEncrypted(output1);
        encryptedOutputs[1] = _createEncrypted(output2);

        vm.prank(alice);
        ledger.depositAndTransfer(depositCommitment, encryptedOutputs, "", publicValues, depositAmount);

        assertEq(ledger.currentRoot(), finalRoot, "Root should be final root");
        assertEq(ledger.totalDeposited(), depositAmount, "Total deposited should match");
        assertTrue(ledger.nullifierUsed(nullifier), "Nullifier should be used");

        console.log("Deposit and transfer successful");
    }

    /// @notice Test double-spend prevention
    function test_E2E_DoubleSpendPrevention() public {
        console.log("=== E2E Test: Double Spend Prevention ===");

        // Deposit
        bytes32 commitment = keccak256("deposit");
        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), 1000 * ONE_USDC);

        _insertedLeaves.push(commitment);
        bytes32 currentRoot = ledger.currentRoot();

        // First spend succeeds
        bytes32 nullifier = keccak256("the_nullifier");
        bytes32 output = keccak256("output");
        bytes32 newRoot = _insertLeafAndGetRoot(output);

        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nullifier;
        bytes32[] memory outputs = new bytes32[](1);
        outputs[0] = output;

        bytes memory publicValues = _createPublicOutputs(currentRoot, newRoot, nullifiers, outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory encryptedOutputs = new PrivateUTXOLedger.OutputCiphertext[](1);
        encryptedOutputs[0] = _createEncrypted(output);

        ledger.submitTx(encryptedOutputs, "", publicValues);

        // Try to reuse the same nullifier - should fail
        bytes32 newOutput = keccak256("new_output");
        bytes32 newerRoot = _insertLeafAndGetRoot(newOutput);
        outputs[0] = newOutput;

        bytes memory secondPublicValues = _createPublicOutputs(newRoot, newerRoot, nullifiers, outputs);
        encryptedOutputs[0] = _createEncrypted(newOutput);

        vm.expectRevert("Nullifier already used");
        ledger.submitTx(encryptedOutputs, "", secondPublicValues);

        console.log("Double-spend correctly prevented");
    }

    /// @notice Test withdrawal with change
    function test_E2E_WithdrawWithChange() public {
        console.log("=== E2E Test: Withdraw with Change ===");

        // Deposit 1000 USDC
        bytes32 depositCommitment = keccak256("deposit_1000");
        vm.prank(alice);
        ledger.deposit(depositCommitment, _createEncrypted(depositCommitment), 1000 * ONE_USDC);

        _insertedLeaves.push(depositCommitment);
        bytes32 currentRoot = ledger.currentRoot();

        // Withdraw 300 USDC, keep 700 as change
        uint256 withdrawAmount = 300 * ONE_USDC;
        bytes32 nullifier = keccak256("spend");
        bytes32 changeNote = keccak256("change_700");
        bytes32 newRoot = _insertLeafAndGetRoot(changeNote);

        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nullifier;
        bytes32[] memory outputs = new bytes32[](1);
        outputs[0] = changeNote;

        bytes memory publicValues = _createPublicOutputs(currentRoot, newRoot, nullifiers, outputs);

        PrivateUTXOLedger.OutputCiphertext[] memory changeOutputs = new PrivateUTXOLedger.OutputCiphertext[](1);
        changeOutputs[0] = _createEncrypted(changeNote);

        uint256 bobBefore = usdc.balanceOf(bob);

        ledger.withdraw(bob, withdrawAmount, "", publicValues, changeOutputs);

        assertEq(usdc.balanceOf(bob), bobBefore + withdrawAmount, "Bob should receive 300 USDC");
        assertEq(ledger.totalDeposited(), 700 * ONE_USDC, "700 USDC should remain in ledger");

        console.log("Withdraw with change successful");
    }

    // ============================================
    // CONTACTS TESTS
    // ============================================

    /// @notice Test saving and retrieving encrypted contacts
    function test_E2E_EncryptedContacts() public {
        console.log("=== E2E Test: Encrypted Contacts ===");

        // Alice's owner tag (first 8 bytes of keccak256(alicePubKey))
        bytes8 aliceTag = bytes8(keccak256(abi.encodePacked(alice)));

        // Save a contact (encrypted)
        bytes memory encryptedContact = abi.encodePacked("encrypted_bob_contact_data");

        uint256 contactId = contacts.saveContact(aliceTag, encryptedContact);

        // Retrieve contact
        EncryptedContacts.EncryptedContact memory contact = contacts.getContact(contactId);

        assertEq(contact.ownerTag, aliceTag, "Owner tag should match");
        assertEq(contact.encryptedData, encryptedContact, "Encrypted data should match");

        // Get all contacts for Alice
        uint256[] memory aliceContacts = contacts.getContactsByOwner(aliceTag);
        assertEq(aliceContacts.length, 1, "Alice should have 1 contact");
        assertEq(aliceContacts[0], contactId, "Contact ID should match");

        console.log("Contacts test successful");
    }

    // ============================================
    // PAYMENT REQUESTS TESTS
    // ============================================

    /// @notice Test payment request flow
    function test_E2E_PaymentRequests() public {
        console.log("=== E2E Test: Payment Requests ===");

        // Bob's recipient tag
        bytes8 bobTag = bytes8(keccak256(abi.encodePacked(bob)));

        // Alice creates a payment request to Bob
        bytes memory encryptedRequest = abi.encodePacked("encrypted_request_100_usdc");

        uint256 requestId = paymentRequests.createRequest(bobTag, encryptedRequest);

        // Verify request
        PrivatePaymentRequests.EncryptedRequest memory request = paymentRequests.getRequest(requestId);
        assertEq(request.recipientTag, bobTag, "Recipient tag should match");
        assertEq(uint8(request.status), 0, "Status should be Pending");

        // Bob approves the request (after making payment)
        bytes32 txHash = keccak256("payment_tx_hash");
        paymentRequests.approveRequest(requestId, txHash);

        // Verify approval
        request = paymentRequests.getRequest(requestId);
        assertEq(uint8(request.status), 1, "Status should be Approved");

        console.log("Payment requests test successful");
    }

    /// @notice Test payment request rejection
    function test_E2E_PaymentRequestRejection() public {
        bytes8 bobTag = bytes8(keccak256(abi.encodePacked(bob)));
        bytes memory encryptedRequest = abi.encodePacked("request_data");

        uint256 requestId = paymentRequests.createRequest(bobTag, encryptedRequest);

        // Bob rejects
        paymentRequests.rejectRequest(requestId);

        PrivatePaymentRequests.EncryptedRequest memory request = paymentRequests.getRequest(requestId);
        assertEq(uint8(request.status), 2, "Status should be Rejected");
    }

    /// @notice Test payment request expiration
    function test_E2E_PaymentRequestExpiration() public {
        bytes8 bobTag = bytes8(keccak256(abi.encodePacked(bob)));
        bytes memory encryptedRequest = abi.encodePacked("request_data");

        uint256 requestId = paymentRequests.createRequest(bobTag, encryptedRequest);

        // Fast forward 8 days
        vm.warp(block.timestamp + 8 days);

        // Request should be expired
        assertTrue(paymentRequests.isExpired(requestId), "Request should be expired");

        // Mark as expired
        paymentRequests.markExpired(requestId);

        PrivatePaymentRequests.EncryptedRequest memory request = paymentRequests.getRequest(requestId);
        assertEq(uint8(request.status), 3, "Status should be Expired");
    }

    // ============================================
    // STRESS TESTS
    // ============================================

    /// @notice Test many sequential transactions
    function test_E2E_ManyTransactions() public {
        console.log("=== E2E Test: Many Sequential Transactions ===");

        // Initial deposit
        bytes32 commitment = keccak256("initial");
        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), 5000 * ONE_USDC);

        _insertedLeaves.push(commitment);
        bytes32 currentRoot = ledger.currentRoot();

        // Do 20 sequential transfers
        for (uint256 i = 0; i < 20; i++) {
            bytes32 nullifier = keccak256(abi.encodePacked("nullifier", i));
            bytes32 output = keccak256(abi.encodePacked("output", i));
            bytes32 newRoot = _insertLeafAndGetRoot(output);

            bytes32[] memory nullifiers = new bytes32[](1);
            nullifiers[0] = nullifier;
            bytes32[] memory outputs = new bytes32[](1);
            outputs[0] = output;

            bytes memory publicValues = _createPublicOutputs(currentRoot, newRoot, nullifiers, outputs);
            PrivateUTXOLedger.OutputCiphertext[] memory encrypted = new PrivateUTXOLedger.OutputCiphertext[](1);
            encrypted[0] = _createEncrypted(output);

            ledger.submitTx(encrypted, "", publicValues);

            currentRoot = newRoot;
        }

        assertEq(ledger.totalDeposited(), 5000 * ONE_USDC, "Total should be unchanged");
        console.log("20 sequential transactions successful");
    }

    /// @notice Fuzz test: random deposit amounts
    function testFuzz_DepositAmount(uint256 amount) public {
        amount = bound(amount, 1, 1_000_000_000 * ONE_USDC);

        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.approve(address(ledger), amount);

        bytes32 commitment = keccak256(abi.encodePacked("fuzz", amount));

        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), amount);

        assertEq(ledger.totalDeposited(), amount);
    }

    // ============================================
    // BALANCE TRACKING TESTS (UI CRITICAL)
    // ============================================
    // These tests verify balance consistency - critical for UI display

    /// @notice Test that getBalance() always matches totalDeposited for ERC20
    function test_Balance_ConsistencyAfterDeposit() public {
        console.log("=== Balance Test: Consistency After Deposit ===");

        // Multiple deposits from different users
        vm.prank(alice);
        ledger.deposit(keccak256("a1"), _createEncrypted(keccak256("a1")), 100 * ONE_USDC);

        assertEq(ledger.getBalance(), ledger.totalDeposited(), "Balance should match totalDeposited");
        assertEq(ledger.getBalance(), 100 * ONE_USDC, "Balance should be 100 USDC");

        vm.prank(bob);
        ledger.deposit(keccak256("b1"), _createEncrypted(keccak256("b1")), 250 * ONE_USDC);

        assertEq(ledger.getBalance(), ledger.totalDeposited(), "Balance should still match");
        assertEq(ledger.getBalance(), 350 * ONE_USDC, "Balance should be 350 USDC");

        vm.prank(alice);
        ledger.deposit(keccak256("a2"), _createEncrypted(keccak256("a2")), 50 * ONE_USDC);

        assertEq(ledger.getBalance(), 400 * ONE_USDC, "Balance should be 400 USDC");
        console.log("Balance consistency verified after deposits");
    }

    /// @notice Test balance after withdraw matches expected
    function test_Balance_ConsistencyAfterWithdraw() public {
        console.log("=== Balance Test: Consistency After Withdraw ===");

        // Deposit 1000 USDC
        bytes32 dep = keccak256("dep");
        vm.prank(alice);
        ledger.deposit(dep, _createEncrypted(dep), 1000 * ONE_USDC);

        _insertedLeaves.push(dep);
        bytes32 currentRoot = ledger.currentRoot();

        // Withdraw 300 USDC (no outputs, root stays same)
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("nf1");
        bytes32[] memory outputs = new bytes32[](0);
        bytes memory pv = _createPublicOutputs(currentRoot, currentRoot, nullifiers, outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory empty = new PrivateUTXOLedger.OutputCiphertext[](0);

        ledger.withdraw(bob, 300 * ONE_USDC, "", pv, empty);

        assertEq(ledger.getBalance(), 700 * ONE_USDC, "Balance should be 700 USDC");
        assertEq(ledger.totalDeposited(), 700 * ONE_USDC, "totalDeposited should be 700 USDC");
        assertEq(ledger.getBalance(), ledger.totalDeposited(), "Balance must match totalDeposited");

        // Withdraw another 200 USDC
        currentRoot = ledger.currentRoot();
        nullifiers[0] = keccak256("nf2");
        pv = _createPublicOutputs(currentRoot, currentRoot, nullifiers, outputs);

        ledger.withdraw(bob, 200 * ONE_USDC, "", pv, empty);

        assertEq(ledger.getBalance(), 500 * ONE_USDC, "Balance should be 500 USDC");
        assertEq(ledger.totalDeposited(), 500 * ONE_USDC, "totalDeposited should be 500 USDC");

        console.log("Balance consistency verified after withdrawals");
    }

    /// @notice Test balance unchanged after internal transfers
    function test_Balance_UnchangedAfterTransfer() public {
        console.log("=== Balance Test: Unchanged After Transfer ===");

        // Deposit 500 USDC
        bytes32 dep = keccak256("dep");
        vm.prank(alice);
        ledger.deposit(dep, _createEncrypted(dep), 500 * ONE_USDC);

        _insertedLeaves.push(dep);
        bytes32 currentRoot = ledger.currentRoot();
        uint256 balanceBefore = ledger.getBalance();

        // Do a transfer (no withdrawal)
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("nf");
        bytes32[] memory outputs = new bytes32[](2);
        outputs[0] = keccak256("out1");
        outputs[1] = keccak256("out2");

        bytes32 newRoot = _insertLeafAndGetRoot(outputs[0]);
        newRoot = _insertLeafAndGetRoot(outputs[1]);

        bytes memory pv = _createPublicOutputs(currentRoot, newRoot, nullifiers, outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory encrypted = new PrivateUTXOLedger.OutputCiphertext[](2);
        encrypted[0] = _createEncrypted(outputs[0]);
        encrypted[1] = _createEncrypted(outputs[1]);

        ledger.submitTx(encrypted, "", pv);

        // Balance should be UNCHANGED (only transfers, no deposits or withdrawals)
        assertEq(ledger.getBalance(), balanceBefore, "Balance should not change on transfer");
        assertEq(ledger.totalDeposited(), 500 * ONE_USDC, "totalDeposited unchanged");

        console.log("Balance unchanged after internal transfers");
    }

    /// @notice Test balance with full withdrawal leaves zero
    function test_Balance_ZeroAfterFullWithdrawal() public {
        console.log("=== Balance Test: Zero After Full Withdrawal ===");

        // Deposit 100 USDC
        bytes32 dep = keccak256("dep");
        vm.prank(alice);
        ledger.deposit(dep, _createEncrypted(dep), 100 * ONE_USDC);

        _insertedLeaves.push(dep);
        bytes32 currentRoot = ledger.currentRoot();

        // Withdraw everything (no outputs, root stays same)
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("nf");
        bytes32[] memory outputs = new bytes32[](0);
        bytes memory pv = _createPublicOutputs(currentRoot, currentRoot, nullifiers, outputs);
        PrivateUTXOLedger.OutputCiphertext[] memory empty = new PrivateUTXOLedger.OutputCiphertext[](0);

        ledger.withdraw(bob, 100 * ONE_USDC, "", pv, empty);

        assertEq(ledger.getBalance(), 0, "Balance should be zero");
        assertEq(ledger.totalDeposited(), 0, "totalDeposited should be zero");
        assertEq(usdc.balanceOf(address(ledger)), 0, "Contract USDC balance should be zero");

        console.log("Balance correctly zero after full withdrawal");
    }

    /// @notice Test getBalance returns actual ERC20 balance
    function test_Balance_MatchesActualERC20Balance() public {
        console.log("=== Balance Test: Matches Actual ERC20 Balance ===");

        // Deposit
        vm.prank(alice);
        ledger.deposit(keccak256("d1"), _createEncrypted(keccak256("d1")), 500 * ONE_USDC);

        // getBalance() should return the actual USDC balance of the contract
        uint256 reportedBalance = ledger.getBalance();
        uint256 actualBalance = usdc.balanceOf(address(ledger));

        assertEq(reportedBalance, actualBalance, "getBalance must match actual USDC balance");

        // Also verify totalDeposited matches
        assertEq(ledger.totalDeposited(), actualBalance, "totalDeposited must match actual balance");

        console.log("Balance matches actual ERC20 balance");
    }

    /// @notice Complex scenario: multiple deposits, transfers, withdrawals
    function test_Balance_ComplexScenario() public {
        console.log("=== Balance Test: Complex Scenario ===");

        // Alice deposits 1000
        bytes32 a1 = keccak256("a1");
        vm.prank(alice);
        ledger.deposit(a1, _createEncrypted(a1), 1000 * ONE_USDC);
        assertEq(ledger.getBalance(), 1000 * ONE_USDC, "Step 1: 1000 USDC");

        _insertedLeaves.push(a1);
        bytes32 root1 = ledger.currentRoot();

        // Bob deposits 500
        bytes32 b1 = keccak256("b1");
        vm.prank(bob);
        ledger.deposit(b1, _createEncrypted(b1), 500 * ONE_USDC);
        assertEq(ledger.getBalance(), 1500 * ONE_USDC, "Step 2: 1500 USDC");

        _insertedLeaves.push(b1);
        bytes32 root2 = ledger.currentRoot();

        // Alice transfers to Bob (balance unchanged)
        bytes32[] memory nf1 = new bytes32[](1);
        nf1[0] = keccak256("transfer_nf");
        bytes32[] memory out1 = new bytes32[](1);
        out1[0] = keccak256("bob_note");
        bytes32 root3 = _insertLeafAndGetRoot(out1[0]);
        bytes memory pv1 = _createPublicOutputs(root2, root3, nf1, out1);
        PrivateUTXOLedger.OutputCiphertext[] memory enc1 = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc1[0] = _createEncrypted(out1[0]);
        ledger.submitTx(enc1, "", pv1);
        assertEq(ledger.getBalance(), 1500 * ONE_USDC, "Step 3: Still 1500 USDC after transfer");

        // Alice withdraws 200 (no new outputs, root stays same)
        bytes32[] memory nf2 = new bytes32[](1);
        nf2[0] = keccak256("withdraw_nf");
        bytes memory pv2 = _createPublicOutputs(root3, root3, nf2, _emptyOutputs());
        ledger.withdraw(alice, 200 * ONE_USDC, "", pv2, new PrivateUTXOLedger.OutputCiphertext[](0));
        assertEq(ledger.getBalance(), 1300 * ONE_USDC, "Step 4: 1300 USDC after withdraw");

        // Bob withdraws 300 (no new outputs, root stays same)
        bytes32[] memory nf3 = new bytes32[](1);
        nf3[0] = keccak256("bob_withdraw_nf");
        bytes memory pv3 = _createPublicOutputs(root3, root3, nf3, _emptyOutputs());
        ledger.withdraw(bob, 300 * ONE_USDC, "", pv3, new PrivateUTXOLedger.OutputCiphertext[](0));
        assertEq(ledger.getBalance(), 1000 * ONE_USDC, "Step 5: 1000 USDC after Bob withdraw");

        // Final verification
        assertEq(ledger.getBalance(), ledger.totalDeposited(), "Final: balance matches totalDeposited");
        assertEq(usdc.balanceOf(address(ledger)), 1000 * ONE_USDC, "Final: actual USDC balance correct");

        console.log("Complex scenario balance tracking verified");
    }
}

/// @notice Mock SP1 verifier that accepts empty proofs
contract MockSP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata proofBytes) external pure {
        // Accept empty proofs for testing (matches SP1MockVerifier behavior)
        assert(proofBytes.length == 0);
    }
}

// ============================================
// ADVERSARIAL TEST CONTRACT
// ============================================

/// @title Adversarial E2E Tests
/// @notice Tests designed to break the system - edge cases, attacks, and malicious inputs
contract E2E_Adversarial_Test is Test {
    PrivateUTXOLedger public ledger;
    EncryptedContacts public contacts;
    PrivatePaymentRequests public paymentRequests;
    MockERC20 public usdc;
    MockSP1Verifier public mockVerifier;
    ReentrancyAttacker public attacker;

    address public alice;
    address public bob;
    address public malicious;

    bytes32 public constant EMPTY_TREE_ROOT = 0x8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9;
    uint256 public constant ONE_USDC = 1e6;

    // Track inserted leaves for computing roots
    bytes32[] internal _insertedLeaves;

    function setUp() public {
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        malicious = makeAddr("malicious");

        mockVerifier = new MockSP1Verifier();
        usdc = new MockERC20("USD Coin", "USDC", 6);

        ledger = new PrivateUTXOLedger(
            address(0),
            address(mockVerifier),
            address(usdc)
        );

        contacts = new EncryptedContacts();
        paymentRequests = new PrivatePaymentRequests();

        usdc.mint(alice, 100_000 * ONE_USDC);
        usdc.mint(bob, 100_000 * ONE_USDC);
        usdc.mint(malicious, 100_000 * ONE_USDC);

        vm.prank(alice);
        usdc.approve(address(ledger), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(ledger), type(uint256).max);
        vm.prank(malicious);
        usdc.approve(address(ledger), type(uint256).max);
    }

    function _createEncrypted(bytes32 commitment) internal pure returns (PrivateUTXOLedger.OutputCiphertext memory) {
        return PrivateUTXOLedger.OutputCiphertext({
            commitment: commitment,
            keyType: 0,
            ephemeralPubkey: hex"04aabbccdd00112233",
            nonce: bytes12(uint96(12345)),
            ciphertext: hex"aabbccdd00112233445566778899"
        });
    }

    function _createPublicOutputs(
        bytes32 oldRoot,
        bytes32, // newRoot removed from struct
        bytes32[] memory nullifiers,
        bytes32[] memory outputCommitments
    ) internal pure returns (bytes memory) {
        PrivateUTXOLedger.PublicOutputs memory outputs = PrivateUTXOLedger.PublicOutputs({
            oldRoot: oldRoot,
            nullifiers: nullifiers,
            outputCommitments: outputCommitments
        });
        return abi.encode(outputs);
    }

    /// @notice Compute the Merkle root for a single leaf at index 0
    function _computeRootForSingleLeaf(bytes32 leaf) internal pure returns (bytes32) {
        bytes32 current = leaf;
        for (uint256 level = 0; level < 32; level++) {
            current = keccak256(abi.encodePacked(current, MerkleTree.zeros(level)));
        }
        return current;
    }

    /// @notice Compute the Merkle root for leaves at sequential indices starting from 0
    function _computeRootForLeaves(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) {
            return EMPTY_TREE_ROOT;
        }
        if (leaves.length == 1) {
            return _computeRootForSingleLeaf(leaves[0]);
        }

        bytes32[32] memory filledSubtrees;
        for (uint256 i = 0; i < 32; i++) {
            filledSubtrees[i] = MerkleTree.zeros(i);
        }

        bytes32 currentRoot;

        for (uint256 idx = 0; idx < leaves.length; idx++) {
            bytes32 currentHash = leaves[idx];
            uint256 currentIndex = idx;

            for (uint256 level = 0; level < 32; level++) {
                if (currentIndex % 2 == 0) {
                    filledSubtrees[level] = currentHash;
                    currentHash = keccak256(abi.encodePacked(currentHash, MerkleTree.zeros(level)));
                } else {
                    currentHash = keccak256(abi.encodePacked(filledSubtrees[level], currentHash));
                }
                currentIndex = currentIndex / 2;
            }

            currentRoot = currentHash;
        }

        return currentRoot;
    }

    /// @notice Track a new leaf and return the new root
    function _insertLeafAndGetRoot(bytes32 leaf) internal returns (bytes32) {
        _insertedLeaves.push(leaf);
        return _computeRootForLeaves(_insertedLeaves);
    }

    // ============================================
    // ZERO AMOUNT EDGE CASES
    // ============================================

    /// @notice Test deposit with zero amount should fail
    function test_Adversarial_DepositZeroAmount() public {
        bytes32 commitment = keccak256("zero_deposit");

        vm.prank(alice);
        vm.expectRevert("Must deposit tokens");
        ledger.deposit(commitment, _createEncrypted(commitment), 0);
    }

    /// @notice Test withdraw with zero amount should fail
    function test_Adversarial_WithdrawZeroAmount() public {
        // First deposit
        bytes32 commitment = keccak256("deposit");
        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), 1000 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("nf");
        bytes32[] memory outputs = new bytes32[](0);
        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nullifiers, outputs);

        vm.expectRevert("Amount must be positive");
        ledger.withdraw(bob, 0, "", pv, new PrivateUTXOLedger.OutputCiphertext[](0));
    }

    // ============================================
    // OVERFLOW/UNDERFLOW TESTS
    // ============================================

    /// @notice Test that withdrawing more than deposited fails
    function test_Adversarial_WithdrawMoreThanDeposited() public {
        bytes32 commitment = keccak256("deposit");
        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = keccak256("nf");
        bytes32[] memory outputs = new bytes32[](0);
        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nullifiers, outputs);

        vm.expectRevert("Insufficient contract balance");
        ledger.withdraw(bob, 200 * ONE_USDC, "", pv, new PrivateUTXOLedger.OutputCiphertext[](0));
    }

    /// @notice Test massive deposit (close to uint256 max)
    function test_Adversarial_MassiveDeposit() public {
        uint256 hugeAmount = type(uint256).max / 2;
        usdc.mint(alice, hugeAmount);

        vm.prank(alice);
        usdc.approve(address(ledger), hugeAmount);

        bytes32 commitment = keccak256("huge_deposit");

        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), hugeAmount);

        assertEq(ledger.totalDeposited(), hugeAmount, "Should handle huge deposits");
    }

    /// @notice Test totalDeposited underflow protection
    function test_Adversarial_TotalDepositedUnderflow() public {
        // Deposit 100 USDC
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();

        // Try to withdraw more than totalDeposited (even if contract somehow had tokens)
        // This should fail due to balance check
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("r2"), nf, new bytes32[](0));

        vm.expectRevert("Insufficient contract balance");
        ledger.withdraw(bob, 200 * ONE_USDC, "", pv, new PrivateUTXOLedger.OutputCiphertext[](0));
    }

    // ============================================
    // ROOT MANIPULATION ATTACKS
    // ============================================

    /// @notice Test submitting with wrong old root fails
    function test_Adversarial_WrongOldRoot() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        // Use a fake old root
        bytes32 fakeOldRoot = keccak256("fake_root");
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes memory pv = _createPublicOutputs(fakeOldRoot, keccak256("newroot"), nf, outs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        vm.expectRevert("Invalid old root");
        ledger.submitTx(enc, "", pv);
    }

    /// @notice Test concurrent transactions - both using same old root succeeds
    /// @dev The contract allows historical roots to enable concurrent proof generation.
    ///      Both transactions can succeed as long as nullifiers are unique.
    function test_ConcurrentTxWithSameOldRoot() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);
        _insertedLeaves.push(c1);

        bytes32 currentRoot = ledger.currentRoot();

        // First transaction
        bytes32[] memory nf1 = new bytes32[](1);
        nf1[0] = keccak256("nf1");
        bytes32[] memory outs1 = new bytes32[](1);
        outs1[0] = keccak256("out1");
        bytes32 newRoot1 = _insertLeafAndGetRoot(outs1[0]);
        bytes memory pv1 = _createPublicOutputs(currentRoot, newRoot1, nf1, outs1);
        PrivateUTXOLedger.OutputCiphertext[] memory enc1 = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc1[0] = _createEncrypted(outs1[0]);

        ledger.submitTx(enc1, "", pv1);

        // Second transaction uses same old root but different nullifiers/outputs
        // This is ALLOWED by design - enables concurrent proof generation
        bytes32[] memory nf2 = new bytes32[](1);
        nf2[0] = keccak256("nf2"); // Different nullifier
        bytes32[] memory outs2 = new bytes32[](1);
        outs2[0] = keccak256("out2"); // Different output

        // Note: We still use currentRoot (before first tx) as oldRoot
        // This is valid because validRoots tracks ALL historical roots
        bytes memory pv2 = _createPublicOutputs(currentRoot, bytes32(0), nf2, outs2);
        PrivateUTXOLedger.OutputCiphertext[] memory enc2 = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc2[0] = _createEncrypted(outs2[0]);

        // This should SUCCEED because:
        // 1. currentRoot is still in validRoots
        // 2. nf2 is a new nullifier (not used before)
        // 3. newRoot is computed on-chain from actual insertions
        ledger.submitTx(enc2, "", pv2);

        // Both transactions succeeded - verify state
        assertTrue(ledger.nullifierUsed(nf1[0]), "nf1 should be used");
        assertTrue(ledger.nullifierUsed(nf2[0]), "nf2 should be used");
    }

    // ============================================
    // NULLIFIER COLLISION ATTACKS
    // ============================================

    /// @notice Test nullifier reuse in same transaction
    function test_Adversarial_DuplicateNullifiersInSameTx() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32 duplicateNullifier = keccak256("duplicate");

        // Two identical nullifiers in same tx
        bytes32[] memory nf = new bytes32[](2);
        nf[0] = duplicateNullifier;
        nf[1] = duplicateNullifier;
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nf, outs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        // Second iteration should fail when marking same nullifier
        vm.expectRevert("Nullifier already used");
        ledger.submitTx(enc, "", pv);
    }

    /// @notice Test nullifier reuse across transactions
    function test_Adversarial_NullifierReuseAcrossTx() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);
        _insertedLeaves.push(c1);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32 theNullifier = keccak256("the_nullifier");

        // First tx
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = theNullifier;
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out1");
        bytes32 newRoot1 = _insertLeafAndGetRoot(outs[0]);
        bytes memory pv = _createPublicOutputs(currentRoot, newRoot1, nf, outs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        ledger.submitTx(enc, "", pv);

        // Second tx reusing nullifier
        bytes32 newRoot = ledger.currentRoot();
        outs[0] = keccak256("out2");
        bytes32 newRoot2 = _insertLeafAndGetRoot(outs[0]);
        bytes memory pv2 = _createPublicOutputs(newRoot, newRoot2, nf, outs);
        enc[0] = _createEncrypted(outs[0]);

        vm.expectRevert("Nullifier already used");
        ledger.submitTx(enc, "", pv2);
    }

    // ============================================
    // COMMITMENT MISMATCH ATTACKS
    // ============================================

    /// @notice Test encrypted output commitment doesn't match public outputs
    function test_Adversarial_CommitmentMismatch() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("correct_commitment");

        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nf, outs);

        // Encrypted output has DIFFERENT commitment
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(keccak256("wrong_commitment"));

        vm.expectRevert("Commitment mismatch");
        ledger.submitTx(enc, "", pv);
    }

    /// @notice Test encrypted outputs count doesn't match public outputs count
    function test_Adversarial_OutputCountMismatch() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](2); // 2 outputs
        outs[0] = keccak256("out1");
        outs[1] = keccak256("out2");

        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nf, outs);

        // Only 1 encrypted output (mismatch)
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        vm.expectRevert("Ciphertext count mismatch");
        ledger.submitTx(enc, "", pv);
    }

    /// @notice Test deposit commitment mismatch
    function test_Adversarial_DepositCommitmentMismatch() public {
        bytes32 commitment = keccak256("commitment");

        // Encrypted output has different commitment
        PrivateUTXOLedger.OutputCiphertext memory enc = _createEncrypted(keccak256("different"));

        vm.prank(alice);
        vm.expectRevert("Commitment mismatch");
        ledger.deposit(commitment, enc, 100 * ONE_USDC);
    }

    // ============================================
    // KEY TYPE ATTACKS
    // ============================================

    /// @notice Test unsupported key type fails
    function test_Adversarial_UnsupportedKeyType() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nf, outs);

        // Create encrypted output with invalid key type
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = PrivateUTXOLedger.OutputCiphertext({
            commitment: outs[0],
            keyType: 99, // Invalid key type
            ephemeralPubkey: hex"04aabbccdd00112233",
            nonce: bytes12(uint96(12345)),
            ciphertext: hex"aabbccdd"
        });

        vm.expectRevert("Unsupported key type");
        ledger.submitTx(enc, "", pv);
    }

    /// @notice Test secp256r1 key type without precompile configured
    function test_Adversarial_Secp256r1WithoutPrecompile() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = ledger.currentRoot();
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nf, outs);

        // secp256r1 key type (1) but no precompile configured
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = PrivateUTXOLedger.OutputCiphertext({
            commitment: outs[0],
            keyType: 1,
            ephemeralPubkey: hex"04aabbccdd00112233",
            nonce: bytes12(uint96(12345)),
            ciphertext: hex"aabbccdd"
        });

        vm.expectRevert("secp256r1 not supported");
        ledger.submitTx(enc, "", pv);
    }

    // ============================================
    // METADATA ATTACKS
    // ============================================

    /// @notice Test metadata size limit enforcement
    function test_Adversarial_MetadataTooLarge() public {
        bytes32 commitment = keccak256("deposit");

        // Create metadata larger than 100KB limit
        bytes memory hugeMetadata = new bytes(100_001);
        for (uint i = 0; i < hugeMetadata.length; i++) {
            hugeMetadata[i] = 0xAA;
        }

        vm.prank(alice);
        vm.expectRevert("Metadata too large");
        ledger.deposit(commitment, _createEncrypted(commitment), hugeMetadata, 100 * ONE_USDC);
    }

    /// @notice Test metadata at exactly limit works
    function test_Adversarial_MetadataAtLimit() public {
        bytes32 commitment = keccak256("deposit");

        // Metadata at exactly 99,999 bytes (under 100KB)
        bytes memory maxMetadata = new bytes(99_999);

        vm.prank(alice);
        ledger.deposit(commitment, _createEncrypted(commitment), maxMetadata, 100 * ONE_USDC);

        bytes memory retrieved = ledger.getMetadata(commitment);
        assertEq(retrieved.length, 99_999, "Metadata should be stored");
    }

    // ============================================
    // ERC20 EDGE CASES
    // ============================================

    /// @notice Test deposit with insufficient approval
    function test_Adversarial_InsufficientApproval() public {
        address charlie = makeAddr("charlie");
        usdc.mint(charlie, 1000 * ONE_USDC);

        // Only approve 50 USDC
        vm.prank(charlie);
        usdc.approve(address(ledger), 50 * ONE_USDC);

        bytes32 commitment = keccak256("deposit");

        vm.prank(charlie);
        vm.expectRevert(); // SafeERC20 will revert
        ledger.deposit(commitment, _createEncrypted(commitment), 100 * ONE_USDC);
    }

    /// @notice Test deposit with insufficient balance
    function test_Adversarial_InsufficientBalance() public {
        address charlie = makeAddr("charlie");
        usdc.mint(charlie, 50 * ONE_USDC);

        vm.prank(charlie);
        usdc.approve(address(ledger), type(uint256).max);

        bytes32 commitment = keccak256("deposit");

        vm.prank(charlie);
        vm.expectRevert(); // SafeERC20 will revert
        ledger.deposit(commitment, _createEncrypted(commitment), 100 * ONE_USDC);
    }

    /// @notice Test sending ETH with ERC20 deposit fails
    function test_Adversarial_ETHWithERC20Deposit() public {
        bytes32 commitment = keccak256("deposit");

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert("Cannot send ETH for token deposit");
        ledger.deposit{value: 1 ether}(commitment, _createEncrypted(commitment), 100 * ONE_USDC);
    }

    // ============================================
    // CONTACTS ADVERSARIAL TESTS
    // ============================================

    /// @notice Test contact with zero owner tag fails
    function test_Adversarial_ContactZeroOwnerTag() public {
        vm.expectRevert(EncryptedContacts.InvalidContact.selector);
        contacts.saveContact(bytes8(0), hex"aabbccdd");
    }

    /// @notice Test contact with empty data fails
    function test_Adversarial_ContactEmptyData() public {
        bytes8 tag = bytes8(keccak256("owner"));

        vm.expectRevert(EncryptedContacts.EmptyData.selector);
        contacts.saveContact(tag, "");
    }

    /// @notice Test updating non-existent contact fails
    function test_Adversarial_UpdateNonExistentContact() public {
        vm.expectRevert(EncryptedContacts.ContactNotFound.selector);
        contacts.updateContact(999, hex"aabbccdd");
    }

    /// @notice Test getting non-existent contact fails
    function test_Adversarial_GetNonExistentContact() public {
        vm.expectRevert(EncryptedContacts.ContactNotFound.selector);
        contacts.getContact(999);
    }

    /// @notice Test deleting non-existent contact fails
    function test_Adversarial_DeleteNonExistentContact() public {
        vm.expectRevert(EncryptedContacts.ContactNotFound.selector);
        contacts.deleteContact(999);
    }

    /// @notice Test anyone can update any contact (no access control)
    function test_Adversarial_ContactNoAccessControl() public {
        bytes8 aliceTag = bytes8(keccak256("alice"));
        uint256 contactId = contacts.saveContact(aliceTag, hex"aabbccddeeff0011");

        // Malicious user can update Alice's contact
        vm.prank(malicious);
        contacts.updateContact(contactId, hex"deadbeefcafebabe");

        EncryptedContacts.EncryptedContact memory contact = contacts.getContact(contactId);
        assertEq(contact.encryptedData, hex"deadbeefcafebabe", "Anyone can update contacts");
    }

    /// @notice Test anyone can delete any contact (no access control)
    function test_Adversarial_ContactDeleteNoAccessControl() public {
        bytes8 aliceTag = bytes8(keccak256("alice"));
        uint256 contactId = contacts.saveContact(aliceTag, hex"aabbccddeeff0011");

        // Malicious user can delete Alice's contact
        vm.prank(malicious);
        contacts.deleteContact(contactId);

        EncryptedContacts.EncryptedContact memory contact = contacts.getContact(contactId);
        assertEq(contact.encryptedData.length, 0, "Contact should be deleted");
    }

    // ============================================
    // PAYMENT REQUESTS ADVERSARIAL TESTS
    // ============================================

    /// @notice Test request with zero recipient tag fails
    function test_Adversarial_RequestZeroRecipientTag() public {
        vm.expectRevert(PrivatePaymentRequests.InvalidRequest.selector);
        paymentRequests.createRequest(bytes8(0), hex"aabbccdd");
    }

    /// @notice Test request with empty payload fails
    function test_Adversarial_RequestEmptyPayload() public {
        bytes8 tag = bytes8(keccak256("recipient"));

        vm.expectRevert(PrivatePaymentRequests.InvalidRequest.selector);
        paymentRequests.createRequest(tag, "");
    }

    /// @notice Test approving non-existent request fails
    function test_Adversarial_ApproveNonExistentRequest() public {
        vm.expectRevert(PrivatePaymentRequests.RequestNotFound.selector);
        paymentRequests.approveRequest(999, keccak256("txhash"));
    }

    /// @notice Test rejecting non-existent request fails
    function test_Adversarial_RejectNonExistentRequest() public {
        vm.expectRevert(PrivatePaymentRequests.RequestNotFound.selector);
        paymentRequests.rejectRequest(999);
    }

    /// @notice Test double approval fails
    function test_Adversarial_DoubleApproval() public {
        bytes8 tag = bytes8(keccak256("recipient"));
        uint256 requestId = paymentRequests.createRequest(tag, hex"aabbccdd");

        paymentRequests.approveRequest(requestId, keccak256("tx1"));

        vm.expectRevert(PrivatePaymentRequests.RequestNotPending.selector);
        paymentRequests.approveRequest(requestId, keccak256("tx2"));
    }

    /// @notice Test approving rejected request fails
    function test_Adversarial_ApproveRejectedRequest() public {
        bytes8 tag = bytes8(keccak256("recipient"));
        uint256 requestId = paymentRequests.createRequest(tag, hex"aabbccdd");

        paymentRequests.rejectRequest(requestId);

        vm.expectRevert(PrivatePaymentRequests.RequestNotPending.selector);
        paymentRequests.approveRequest(requestId, keccak256("txhash"));
    }

    /// @notice Test approving expired request fails
    /// @dev Note: Solidity reverts undo all state changes, so the "mark as expired"
    ///      in the contract is lost when the function reverts. The status remains Pending.
    ///      To actually mark as expired, must call markExpired() separately.
    function test_Adversarial_ApproveExpiredRequest() public {
        bytes8 tag = bytes8(keccak256("recipient"));
        uint256 requestId = paymentRequests.createRequest(tag, hex"aabbccdd");

        // Fast forward past expiration
        vm.warp(block.timestamp + 8 days);

        // Approving should fail
        vm.expectRevert(PrivatePaymentRequests.RequestAlreadyExpired.selector);
        paymentRequests.approveRequest(requestId, keccak256("txhash"));

        // Status remains Pending (revert undoes the Expired assignment)
        PrivatePaymentRequests.EncryptedRequest memory req = paymentRequests.getRequest(requestId);
        assertEq(uint8(req.status), 0, "Status should still be Pending (revert undid state change)");

        // Must explicitly call markExpired to actually update state
        paymentRequests.markExpired(requestId);
        req = paymentRequests.getRequest(requestId);
        assertEq(uint8(req.status), 3, "Now should be marked Expired");
    }

    /// @notice Test marking non-expired request as expired fails
    function test_Adversarial_MarkNonExpiredAsExpired() public {
        bytes8 tag = bytes8(keccak256("recipient"));
        uint256 requestId = paymentRequests.createRequest(tag, hex"aabbccdd");

        // Only 1 day passed (not expired yet - 7 day expiration)
        vm.warp(block.timestamp + 1 days);

        vm.expectRevert(PrivatePaymentRequests.InvalidRequest.selector);
        paymentRequests.markExpired(requestId);
    }

    /// @notice Test anyone can approve/reject requests (no access control)
    function test_Adversarial_RequestNoAccessControl() public {
        bytes8 bobTag = bytes8(keccak256("bob"));
        uint256 requestId = paymentRequests.createRequest(bobTag, hex"aabbccdd");

        // Malicious user can approve Bob's request without Bob's consent
        vm.prank(malicious);
        paymentRequests.approveRequest(requestId, keccak256("fake_tx"));

        PrivatePaymentRequests.EncryptedRequest memory req = paymentRequests.getRequest(requestId);
        assertEq(uint8(req.status), 1, "Malicious approval succeeded");
    }

    // ============================================
    // DEPOSITANDTRANSFER EDGE CASES
    // ============================================

    /// @notice Test depositAndTransfer with zero deposit commitment fails
    function test_Adversarial_DepositAndTransferZeroCommitment() public {
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes32 depositCommitment = bytes32(0);
        // Use computed root for deposit commitment (will fail validation before root check)
        bytes32 rootAfterDeposit = _computeRootForSingleLeaf(depositCommitment);
        bytes32 finalRoot = _computeRootForSingleLeaf(outs[0]); // Doesn't matter - validation fails first
        bytes memory pv = _createPublicOutputs(rootAfterDeposit, finalRoot, nf, outs);

        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        vm.prank(alice);
        vm.expectRevert("Invalid deposit commitment");
        ledger.depositAndTransfer(depositCommitment, enc, "", pv, 100 * ONE_USDC);
    }

    /// @notice Test depositAndTransfer with no outputs fails
    function test_Adversarial_DepositAndTransferNoOutputs() public {
        bytes32 depositCommitment = keccak256("deposit");
        bytes32 rootAfterDeposit = _computeRootForSingleLeaf(depositCommitment);

        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](0); // No outputs

        bytes memory pv = _createPublicOutputs(rootAfterDeposit, rootAfterDeposit, nf, outs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](0);

        vm.prank(alice);
        vm.expectRevert("Must have outputs");
        ledger.depositAndTransfer(depositCommitment, enc, "", pv, 100 * ONE_USDC);
    }

    // ============================================
    // GAS GRIEFING / DOS TESTS
    // ============================================

    /// @notice Test many nullifiers in single transaction
    function test_Adversarial_ManyNullifiers() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);
        _insertedLeaves.push(c1);

        bytes32 currentRoot = ledger.currentRoot();

        // Create 100 nullifiers
        uint256 numNullifiers = 100;
        bytes32[] memory nf = new bytes32[](numNullifiers);
        for (uint i = 0; i < numNullifiers; i++) {
            nf[i] = keccak256(abi.encodePacked("nullifier", i));
        }

        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes32 newRoot = _insertLeafAndGetRoot(outs[0]);
        bytes memory pv = _createPublicOutputs(currentRoot, newRoot, nf, outs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        uint256 gasBefore = gasleft();
        ledger.submitTx(enc, "", pv);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for 100 nullifiers:", gasUsed);
        assertTrue(gasUsed < 5_000_000, "Should not use excessive gas");
    }

    /// @notice Test many outputs in single transaction
    function test_Adversarial_ManyOutputs() public {
        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        ledger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);
        _insertedLeaves.push(c1);

        bytes32 currentRoot = ledger.currentRoot();

        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");

        // Create 50 outputs
        uint256 numOutputs = 50;
        bytes32[] memory outs = new bytes32[](numOutputs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](numOutputs);
        for (uint i = 0; i < numOutputs; i++) {
            outs[i] = keccak256(abi.encodePacked("output", i));
            enc[i] = _createEncrypted(outs[i]);
        }

        // Compute the new root after inserting all outputs
        bytes32 newRoot = currentRoot;
        for (uint i = 0; i < numOutputs; i++) {
            newRoot = _insertLeafAndGetRoot(outs[i]);
        }

        bytes memory pv = _createPublicOutputs(currentRoot, newRoot, nf, outs);

        uint256 gasBefore = gasleft();
        ledger.submitTx(enc, "", pv);
        uint256 gasUsed = gasBefore - gasleft();

        console.log("Gas used for 50 outputs:", gasUsed);
        assertTrue(gasUsed < 5_000_000, "Should not use excessive gas");
    }

    // ============================================
    // PERMIT2 EDGE CASES
    // ============================================

    /// @notice Test Permit2 deposit for non-ERC20 ledger fails
    function test_Adversarial_Permit2OnETHLedger() public {
        // Create ETH ledger
        PrivateUTXOLedger ethLedger = new PrivateUTXOLedger(
            address(0),
            address(mockVerifier),
            address(0) // ETH ledger
        );

        bytes32 commitment = keccak256("deposit");
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: address(usdc),
                amount: 100 * ONE_USDC
            }),
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        vm.expectRevert("Permit2 only for ERC20");
        ethLedger.depositWithPermit2(
            commitment,
            _createEncrypted(commitment),
            100 * ONE_USDC,
            permit,
            "",
            alice
        );
    }

    /// @notice Test Permit2 with wrong token fails
    function test_Adversarial_Permit2WrongToken() public {
        MockERC20 otherToken = new MockERC20("Other", "OTH", 18);

        bytes32 commitment = keccak256("deposit");
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: address(otherToken), // Wrong token
                amount: 100 * ONE_USDC
            }),
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        vm.expectRevert("Wrong token");
        ledger.depositWithPermit2(
            commitment,
            _createEncrypted(commitment),
            100 * ONE_USDC,
            permit,
            "",
            alice
        );
    }

    /// @notice Test Permit2 with insufficient permit amount fails
    function test_Adversarial_Permit2InsufficientAmount() public {
        bytes32 commitment = keccak256("deposit");
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: address(usdc),
                amount: 50 * ONE_USDC // Less than requested
            }),
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });

        vm.expectRevert("Insufficient permit amount");
        ledger.depositWithPermit2(
            commitment,
            _createEncrypted(commitment),
            100 * ONE_USDC,
            permit,
            "",
            alice
        );
    }

    // ============================================
    // SP1 VERIFIER EDGE CASES
    // ============================================

    /// @notice Test submitting with no SP1 verifier configured fails
    function test_Adversarial_NoVerifierConfigured() public {
        // Create ledger without verifier
        PrivateUTXOLedger noVerifierLedger = new PrivateUTXOLedger(
            address(0),
            address(0), // No verifier
            address(usdc)
        );

        usdc.mint(alice, 1000 * ONE_USDC);
        vm.prank(alice);
        usdc.approve(address(noVerifierLedger), type(uint256).max);

        bytes32 c1 = keccak256("d1");
        vm.prank(alice);
        noVerifierLedger.deposit(c1, _createEncrypted(c1), 100 * ONE_USDC);

        bytes32 currentRoot = noVerifierLedger.currentRoot();
        bytes32[] memory nf = new bytes32[](1);
        nf[0] = keccak256("nf");
        bytes32[] memory outs = new bytes32[](1);
        outs[0] = keccak256("out");

        bytes memory pv = _createPublicOutputs(currentRoot, keccak256("newroot"), nf, outs);
        PrivateUTXOLedger.OutputCiphertext[] memory enc = new PrivateUTXOLedger.OutputCiphertext[](1);
        enc[0] = _createEncrypted(outs[0]);

        vm.expectRevert("SP1 verifier not configured");
        noVerifierLedger.submitTx(enc, "", pv);
    }
}

/// @notice Reentrancy attacker contract
contract ReentrancyAttacker {
    PrivateUTXOLedger public ledger;
    bool public attacking;
    uint256 public attackCount;

    constructor(address _ledger) {
        ledger = PrivateUTXOLedger(_ledger);
    }

    receive() external payable {
        // Attempt reentrancy on ETH withdraw
        if (attacking && attackCount < 3) {
            attackCount++;
            // Can't actually reenter withdraw since we'd need valid nullifiers/proofs
        }
    }
}
