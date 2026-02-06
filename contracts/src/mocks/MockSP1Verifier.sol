// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockSP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external pure {
        // Always pass
    }
}
