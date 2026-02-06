// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PaymentRequests.sol";

contract DeployPaymentRequests is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy PrivatePaymentRequests
        PrivatePaymentRequests requests = new PrivatePaymentRequests();
        
        console.log("PrivatePaymentRequests deployed to:", address(requests));
        
        // Log some info
        console.log("Expiration time:", requests.EXPIRATION_TIME() / 1 days, "days");
        console.log("Request fee:", requests.REQUEST_FEE());
        console.log("Initial request count:", requests.getRequestCount());
        
        vm.stopBroadcast();
    }
}
