// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PrivateUTXOLedger.sol";

contract Deploy is Script {
    // SP1 Groth16 Verifier on Sepolia (v5.2.0)
    // https://docs.succinct.xyz/docs/sp1/verification/onchain/contract-addresses
    address constant SP1_VERIFIER_SEPOLIA = 0x397A5f7f3dBd538f23DE225B51f532c34448dA9B;

    // USDC on Sepolia (6 decimals)
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;

    function run() external {
        // Get deployer private key from environment
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);

        // Deploy parameters
        address secp256r1Precompile = address(0); // Not available on Sepolia
        address sp1Verifier = SP1_VERIFIER_SEPOLIA;
        address tokenAddress = USDC_SEPOLIA; // Use USDC for $ denominated balances

        // Deploy contract with SP1 verifier and ERC20 token support
        // Note: Merkle tree initializes to empty state automatically
        PrivateUTXOLedger ledger = new PrivateUTXOLedger(secp256r1Precompile, sp1Verifier, tokenAddress);

        vm.stopBroadcast();

        // Log deployment info
        console.log("");
        console.log("=== Deployment Successful ===");
        console.log("Network: Sepolia");
        console.log("Contract:", address(ledger));
        console.log("SP1 Verifier:", sp1Verifier);
        console.log("Token (USDC):", tokenAddress);
        console.log("UTXO Program VKey:", vm.toString(ledger.UTXO_PROGRAM_VKEY()));
        console.log("Mode: Proof-required (no owner bypass)");
        console.log("");
        console.log("View on Etherscan:");
        console.log("https://sepolia.etherscan.io/address/%s", address(ledger));
        console.log("");
    }
}