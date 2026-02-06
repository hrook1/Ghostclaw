// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PrivateUTXOLedger.sol";
import "../src/mocks/MockSP1Verifier.sol";
import "../test/mocks/MockERC20.sol";
import "../src/EncryptedContacts.sol";
import "../src/PaymentRequests.sol";

contract DeployLocal is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy Mock Verifier
        MockSP1Verifier verifier = new MockSP1Verifier();

        // 2. Deploy Mock Token (USDC)
        MockERC20 token = new MockERC20("USDC", "USDC", 6);

        // 3. Deploy Ledger
        PrivateUTXOLedger ledger = new PrivateUTXOLedger(address(0), address(verifier), address(token));

        // 4. Deploy EncryptedContacts
        EncryptedContacts contacts = new EncryptedContacts();

        // 5. Deploy PrivatePaymentRequests
        PrivatePaymentRequests requests = new PrivatePaymentRequests();

        vm.stopBroadcast();

        console.log("MockVerifier:", address(verifier));
        console.log("MockToken:", address(token));
        console.log("PrivateUTXOLedger:", address(ledger));
        console.log("EncryptedContacts:", address(contacts));
        console.log("PrivatePaymentRequests:", address(requests));
    }
}
