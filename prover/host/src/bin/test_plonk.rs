//! Quick PLONK vs Groth16 comparison test

use sp1_sdk::{HashableKey, ProverClient, SP1Stdin, Prover};
use sp1_sdk::network::FulfillmentStrategy;
use utxo_prototype::{Ledger, Note, PublicInputs, Witness};

pub const ELF: &[u8] = include_bytes!("../../../program/elf/sp1-program");

fn main() {
    let proof_type = std::env::var("PROOF_TYPE").unwrap_or_else(|_| "groth16".to_string());

    println!("Testing {} proof generation...\n", proof_type.to_uppercase());

    let rpc_url = std::env::var("PROVER_NETWORK_RPC")
        .unwrap_or_else(|_| "https://rpc.mainnet.succinct.xyz".to_string());

    let client = ProverClient::builder()
        .network()
        .rpc_url(&rpc_url)
        .build();

    let stdin = setup_transaction();
    let start = std::time::Instant::now();

    let (pk, vk) = client.setup(ELF);
    println!("Verification Key Hash: 0x{}", vk.bytes32());

    let proof = match proof_type.as_str() {
        "plonk" => {
            println!("Requesting PLONK proof...");
            client.prove(&pk, &stdin)
                .strategy(FulfillmentStrategy::Auction)
                .plonk()
                .run()
                .expect("Failed to generate PLONK proof")
        }
        _ => {
            println!("Requesting Groth16 proof...");
            client.prove(&pk, &stdin)
                .strategy(FulfillmentStrategy::Auction)
                .groth16()
                .run()
                .expect("Failed to generate Groth16 proof")
        }
    };

    let duration = start.elapsed();

    let proof_bytes = proof.bytes();
    println!("\n=== {} Results ===", proof_type.to_uppercase());
    println!("Time: {:?}", duration);
    println!("Proof size: {} bytes", proof_bytes.len());
    println!("Proof hex: 0x{}...", &hex::encode(&proof_bytes)[..64]);
}

fn setup_transaction() -> SP1Stdin {
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

    let alice_input_note = Note {
        amount: 100,
        owner_pubkey: alice_owner,
        blinding: [0x42; 32],
    };

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

    let mut ledger = Ledger::new();
    ledger.add_note(alice_input_note.clone());
    let old_root = ledger.current_root();

    let dummy_sig = [0u8; 65];

    let witness = Witness::new_without_proofs(
        vec![alice_input_note],
        vec![0],
        vec![dummy_sig.to_vec()],
        vec![dummy_sig.to_vec()],
        vec![bob_output_note, alice_change_note],
    ).with_precomputed_values();

    let public_inputs = PublicInputs { old_root };

    let mut stdin = SP1Stdin::new();
    stdin.write(&public_inputs);
    stdin.write(&witness);
    stdin
}
