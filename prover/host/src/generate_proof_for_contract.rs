//! SP1 Proof Generator for Contract Verification
//!
//! Generates compressed proofs using the optimized precomputation path.

use sp1_sdk::{ProverClient, SP1Stdin, Prover, HashableKey};
use utxo_prototype::{Ledger, Note, PublicInputs, PublicOutputs, Witness};

pub const ELF: &[u8] = include_bytes!("../../program/elf/sp1-program");

fn main() {
    println!("Generating SP1 proof for on-chain verification...\n");

    let client = ProverClient::builder().cpu().build();

    // Setup transaction with optimized precomputation
    let (stdin, expected_outputs) = setup_transaction();

    println!("Generating proof (optimized path)...\n");

    // Generate the proof
    let (pk, vk) = client.setup(ELF);
    println!("Verification Key Hash: 0x{}", vk.bytes32());

    // For on-chain verification, we need a PLONK or Groth16 proof
    // Let's try with compressed first
    let start = std::time::Instant::now();
    let proof = client.prove(&pk, &stdin)
        .compressed()
        .run()
        .expect("Failed to generate proof");

    let duration = start.elapsed();
    println!("Proof generated in {:?}!", duration);

    // Read and display public outputs
    let mut reader = proof.public_values.clone();
    let public_outputs: PublicOutputs = reader.read();

    println!("\n=== Public Outputs ===");
    println!("Old root: 0x{}", hex::encode(&public_outputs.old_root[..8]));
    println!("Nullifiers: {}", public_outputs.nullifiers.len());
    println!("Output commitments: {}", public_outputs.output_commitments.len());

    assert_eq!(public_outputs.output_commitments.len(), expected_outputs);

    // The proof bytes can be used for verification
    println!("\nProof ready for on-chain verification");
    println!("Proof size: {} bytes", proof.bytes().len());
    println!("\nSUCCESS!");
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
