// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SP1UTXOVerifier.sol";

contract DeploySP1UTXOVerifier is Script {
    function run() external {
        // SP1 Verifier on Sepolia (v5.2.0)
        address sp1Verifier = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;
        
        vm.startBroadcast();
        
        SP1UTXOVerifier verifier = new SP1UTXOVerifier(sp1Verifier);
        
        console.log("SP1UTXOVerifier deployed at:", address(verifier));
        console.log("Using SP1 Verifier at:", sp1Verifier);
        console.log("Program VKey:", vm.toString(verifier.UTXO_PROGRAM_VKEY()));
        
        vm.stopBroadcast();
    }
}
