//! SP1 Groth16 Proof Generator for On-Chain Verification
//!
//! Generates Groth16 proofs suitable for on-chain verification.
//! Uses the optimized precomputation path for faster proving.

use sp1_sdk::{HashableKey, ProverClient, SP1Stdin, Prover};
use std::fs;
use utxo_prototype::{Ledger, Note, PublicInputs, PublicOutputs, Witness};

pub const ELF: &[u8] = include_bytes!("../../../program/elf/sp1-program");

fn main() {
    println!("Generating SP1 Groth16 proof for on-chain verification...\n");

    // Check if we should use network or CPU
    let use_network = std::env::var("SP1_PROVER").unwrap_or_default() == "network";

    // Setup transaction with optimized precomputation
    let (stdin, expected_outputs) = setup_transaction();

    if use_network {
        println!("Using Succinct Prover Network (Mainnet) for Groth16 proof...\n");
        // Use mainnet RPC endpoint for the new prover network
        let rpc_url = std::env::var("PROVER_NETWORK_RPC")
            .unwrap_or_else(|_| "https://rpc.mainnet.succinct.xyz".to_string());
        println!("RPC URL: {}", rpc_url);

        let client = ProverClient::builder()
            .network()
            .rpc_url(&rpc_url)
            .build();
        generate_groth16_network(client, stdin, expected_outputs);
    } else {
        println!("NOTE: Groth16 proofs require the Succinct Prover Network.");
        println!("Set SP1_PROVER=network and NETWORK_PRIVATE_KEY to generate Groth16 proofs.\n");
        println!("Generating compressed proof locally instead (for testing)...\n");
        let client = ProverClient::builder().cpu().build();
        generate_compressed_local(client, stdin, expected_outputs);
    }
}

/// Set up a demo transaction with precomputed values
fn setup_transaction() -> (SP1Stdin, usize) {
    // Create demo private keys
    let alice_privkey: [u8; 32] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
        0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
        0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    ];

    let bob_privkey: [u8; 32] = [
        0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28,
        0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30,
        0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
        0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40,
    ];

    let alice_owner: [u8; 32] = alice_privkey;
    let bob_owner: [u8; 32] = bob_privkey;

    // Create input note (Alice has 100)
    let alice_input_note = Note {
        amount: 100,
        owner_pubkey: alice_owner,
        blinding: [0x42; 32],
    };

    // Create output notes
    let bob_output_note = Note {
        amount: 50,
        owner_pubkey: bob_owner,
        blinding: [0x43; 32],
    };

    let alice_change_note = Note {
        amount: 50,
        owner_pubkey: alice_owner,
        blinding: [0x44; 32],
    };

    // Build ledger to compute old_root
    let mut ledger = Ledger::new();
    let alice_index = ledger.add_note(alice_input_note.clone());
    let old_root = ledger.current_root();

    println!("Transaction: Alice (100) -> Bob (50) + Change (50)");
    println!("Old root: 0x{}", hex::encode(&old_root[..8]));

    // Create witness
    let dummy_sig = [0u8; 65];

    // Create witness and precompute values on host (using constructor without proofs for Phase 1)
    let witness = Witness::new_without_proofs(
        vec![alice_input_note],
        vec![alice_index as usize],
        vec![dummy_sig.to_vec()],
        vec![dummy_sig.to_vec()],
        vec![bob_output_note, alice_change_note],
    );

    println!("Precomputing nullifiers and commitments on host...");
    let witness = witness.with_precomputed_values();
    println!("  Precomputed {} nullifiers, {} input commits, {} output commits",
        witness.precomputed_nullifiers.len(),
        witness.precomputed_input_commitments.len(),
        witness.precomputed_output_commitments.len());

    let public_inputs = PublicInputs { old_root };
    let expected_outputs = witness.output_notes.len();

    let mut stdin = SP1Stdin::new();
    stdin.write(&public_inputs);
    stdin.write(&witness);

    (stdin, expected_outputs)
}

fn generate_groth16_network(client: sp1_sdk::NetworkProver, stdin: SP1Stdin, expected_outputs: usize) {
    let start = std::time::Instant::now();

    let (pk, vk) = client.setup(ELF);
    println!("Verification Key Hash: 0x{}", vk.bytes32());

    println!("\nGenerating Groth16 proof (optimized path)...");

    // Generate Groth16 proof for on-chain verification
    let proof = client.prove(&pk, &stdin)
        .groth16()
        .run()
        .expect("Failed to generate Groth16 proof");

    let duration = start.elapsed();
    println!("\nProof generated in {:?}!", duration);

    // Extract proof bytes and public values
    let proof_bytes = proof.bytes();
    let public_values = proof.public_values.to_vec();

    println!("\n=== PROOF DATA FOR ON-CHAIN VERIFICATION ===");
    println!("Proof (hex): 0x{}", hex::encode(&proof_bytes));
    println!("Public Values (hex): 0x{}", hex::encode(&public_values));
    println!("Proof size: {} bytes", proof_bytes.len());

    // Save to files for easy access
    fs::write("proof.bin", &proof_bytes).expect("Failed to write proof");
    fs::write("public_values.bin", &public_values).expect("Failed to write public values");

    // Also save as hex strings
    fs::write("proof.hex", format!("0x{}", hex::encode(&proof_bytes))).expect("Failed to write proof hex");
    fs::write("public_values.hex", format!("0x{}", hex::encode(&public_values))).expect("Failed to write public values hex");

    println!("\nFiles saved:");
    println!("  - proof.bin / proof.hex");
    println!("  - public_values.bin / public_values.hex");

    // Read and display the public outputs
    let mut reader = proof.public_values.clone();
    let public_outputs: PublicOutputs = reader.read();
    print_public_outputs(&public_outputs, expected_outputs);
}

fn generate_compressed_local(client: sp1_sdk::CpuProver, stdin: SP1Stdin, expected_outputs: usize) {
    let start = std::time::Instant::now();

    let (pk, vk) = client.setup(ELF);
    println!("Verification Key Hash: 0x{}", vk.bytes32());

    println!("\nGenerating compressed proof locally (optimized path)...");

    // Generate compressed proof (not suitable for on-chain but good for testing)
    let proof = client.prove(&pk, &stdin)
        .compressed()
        .run()
        .expect("Failed to generate proof");

    let duration = start.elapsed();
    println!("\nProof generated in {:?}!", duration);

    let public_values = proof.public_values.to_vec();

    println!("\n=== COMPRESSED PROOF DATA ===");
    println!("Public Values (hex): 0x{}", hex::encode(&public_values));

    // Save public values to files
    fs::write("public_values.bin", &public_values).expect("Failed to write public values");
    fs::write("public_values.hex", format!("0x{}", hex::encode(&public_values))).expect("Failed to write public values hex");

    println!("\nNOTE: Compressed proofs cannot be verified on-chain.");
    println!("For on-chain verification, use SP1_PROVER=network to generate Groth16 proof.");

    // Read and display the public outputs
    let mut reader = proof.public_values.clone();
    let public_outputs: PublicOutputs = reader.read();
    print_public_outputs(&public_outputs, expected_outputs);
}

fn print_public_outputs(outputs: &PublicOutputs, expected_outputs: usize) {
    println!("\n=== Public Outputs ===");
    println!("Old root: 0x{}", hex::encode(&outputs.old_root[..8]));
    println!("Nullifiers: {}", outputs.nullifiers.len());
    for (i, nullifier) in outputs.nullifiers.iter().enumerate() {
        println!("  [{}]: 0x{}", i, hex::encode(&nullifier[..8]));
    }
    println!("Output commitments: {}", outputs.output_commitments.len());
    for (i, commitment) in outputs.output_commitments.iter().enumerate() {
        println!("  [{}]: 0x{}", i, hex::encode(&commitment[..8]));
    }

    assert_eq!(outputs.output_commitments.len(), expected_outputs, "Output count mismatch");
    println!("\nSUCCESS! Proof verified with {} outputs.", expected_outputs);
}
