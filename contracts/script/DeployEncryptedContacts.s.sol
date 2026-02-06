// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/EncryptedContacts.sol";

contract DeployEncryptedContacts is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy EncryptedContacts
        EncryptedContacts contacts = new EncryptedContacts();

        console.log("EncryptedContacts deployed to:", address(contacts));
        console.log("Initial contact count:", contacts.getContactCount());

        vm.stopBroadcast();
    }
}
