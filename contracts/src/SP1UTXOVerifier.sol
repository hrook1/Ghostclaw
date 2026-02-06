// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISP1Verifier} from "@sp1-contracts/ISP1Verifier.sol";

/// @title SP1 UTXO Verifier
/// @notice Verifies SP1 Groth16 proofs for private UTXO transactions
contract SP1UTXOVerifier {
    /// @notice The address of the SP1 Groth16 verifier contract on Sepolia
    /// @dev SP1 v5.2.0 verifier: https://docs.succinct.xyz/docs/sp1/verification/onchain/contract-addresses
    address public immutable verifier;

    /// @notice The verification key hash for the UTXO program
    /// @dev Generated from: cargo run --bin get-vkey
    bytes32 public constant UTXO_PROGRAM_VKEY = 0x005448a606415846fd34d5cae708f99c74a5b148e07c09140c1d60a135893c96;

    /// @notice Public outputs from the UTXO ZK proof
    struct PublicOutputs {
        bytes32 oldRoot;
        bytes32 newRoot;
        bytes32[] nullifiers;
        bytes32[] outputCommitments;
    }

    event ProofVerified(
        bytes32 indexed oldRoot,
        bytes32 indexed newRoot,
        uint256 nullifierCount,
        uint256 outputCount
    );

    constructor(address _verifier) {
        verifier = _verifier;
    }

    /// @notice Verifies a UTXO transaction proof
    /// @param proof The encoded SP1 Groth16 proof
    /// @param publicValues The ABI-encoded public outputs from the zkVM
    /// @return outputs The decoded public outputs
    function verifyUTXOProof(
        bytes calldata proof,
        bytes calldata publicValues
    ) external returns (PublicOutputs memory outputs) {
        // Verify the proof against the SP1 verifier
        ISP1Verifier(verifier).verifyProof(UTXO_PROGRAM_VKEY, publicValues, proof);

        // Decode the public values
        outputs = abi.decode(publicValues, (PublicOutputs));

        emit ProofVerified(
            outputs.oldRoot,
            outputs.newRoot,
            outputs.nullifiers.length,
            outputs.outputCommitments.length
        );

        return outputs;
    }

    /// @notice View function to check if a proof would be valid (no state change)
    /// @param proof The encoded SP1 Groth16 proof
    /// @param publicValues The ABI-encoded public outputs
    /// @return valid True if the proof verifies successfully
    function canVerifyProof(
        bytes calldata proof,
        bytes calldata publicValues
    ) external view returns (bool valid) {
        try ISP1Verifier(verifier).verifyProof(UTXO_PROGRAM_VKEY, publicValues, proof) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Decodes public values without verification (for inspection)
    /// @param publicValues The ABI-encoded public outputs
    /// @return outputs The decoded public outputs
    function decodePublicOutputs(
        bytes calldata publicValues
    ) external pure returns (PublicOutputs memory outputs) {
        return abi.decode(publicValues, (PublicOutputs));
    }
}
