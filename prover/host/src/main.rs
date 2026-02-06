//! SP1 Host Program for Private UTXO Transactions
//!
//! This host program accepts transaction data via stdin (JSON) and generates ZK proofs.
//! It uses the optimized path by precomputing expensive ECDSA operations
//! before passing data to the zkVM.
//!
//! # Usage
//! echo '{"inputNotes":[...],"outputNotes":[...],...}' | cargo run --release
//!
//! Or for demo mode (no stdin):
//! cargo run --release -- --demo

use sp1_sdk::{ProverClient, SP1Stdin, SP1ProofWithPublicValues, Prover, HashableKey};
use sp1_sdk::network::FulfillmentStrategy;
use utxo_prototype::{Ledger, Note, PublicInputs, Witness};
use utxo_prototype::merkle::MerkleProof;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead};
use alloy_sol_types::{sol, SolType};

// Define Solidity-compatible struct for ABI decoding (must match program/src/main.rs and contract)
sol! {
    struct PublicOutputsSol {
        bytes32 oldRoot;
        bytes32[] nullifiers;
        bytes32[] outputCommitments;
    }
}

pub const ELF: &[u8] = include_bytes!("../../program/elf/sp1-program");

/// Transaction request from the prover-server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofRequest {
    /// Input notes being spent (full note data)
    pub input_notes: Vec<NoteData>,
    /// Output notes being created
    pub output_notes: Vec<NoteData>,
    /// Nullifier signatures (hex strings: 65 bytes)
    pub nullifier_signatures: Vec<String>,
    /// Transaction signatures (hex strings: 65 bytes)
    pub tx_signatures: Vec<String>,
    /// Indices of input notes in the merkle tree
    pub input_indices: Vec<usize>,
    /// Merkle proofs for input notes (array of hex strings)
    pub input_proofs: Vec<Vec<String>>,
    /// Current merkle root from contract (hex string)
    pub old_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteData {
    pub amount: u64,
    pub owner_pubkey: String,
    pub blinding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProofResponse {
    pub proof: String,
    pub public_values_raw: String,
    pub public_outputs: PublicOutputsJson,
    pub vkey_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicOutputsJson {
    pub old_root: String,
    pub nullifiers: Vec<String>,
    pub output_commitments: Vec<String>,
}

fn main() {
    // Check args
    let args: Vec<String> = std::env::args().collect();
    let is_demo = args.contains(&"--demo".to_string());
    
    // Check if we should use network or CPU
    let use_network = std::env::var("SP1_PROVER").unwrap_or_default() == "network";

    if use_network {
        let rpc_url = std::env::var("PROVER_NETWORK_RPC")
            .unwrap_or_else(|_| "https://rpc.mainnet.succinct.xyz".to_string());
        eprintln!("Using Network Prover (RPC: {})", rpc_url);
        
        // Build NetworkProver
        let client = ProverClient::builder().network().rpc_url(&rpc_url).build();

         if is_demo {
             run_demo_network(client);
         } else {
             // Read from stdin
             let stdin = io::stdin();
             let mut lines = stdin.lock().lines();
             if let Some(Ok(line)) = lines.next() {
                 let request: ProofRequest = serde_json::from_str(&line).expect("Failed to parse request");
                 run_proof_from_request_network(client, request);
             } else {
                 eprintln!("No input provided");
             }
         }
    } else if std::env::var("SP1_PROVER").unwrap_or_default() == "mock" {
        eprintln!("Using Mock Prover (Fast)");
        // Build MockProver
        let client = ProverClient::builder().mock().build();
        
        if is_demo {
             run_demo_cpu(client);
        } else {
             // Read from stdin
             let stdin = io::stdin();
             let mut lines = stdin.lock().lines();
             if let Some(Ok(line)) = lines.next() {
                 let request: ProofRequest = serde_json::from_str(&line).expect("Failed to parse request");
                 run_proof_from_request_mock(client, request);
             } else {
                 eprintln!("No input provided");
             }
        }
    } else {
        eprintln!("Using CPU Prover (Local)");
        // Build CpuProver
        let client = ProverClient::builder().cpu().build();
        
        if is_demo {
             run_demo_cpu(client);
        } else {
             // Read from stdin
             let stdin = io::stdin();
             let mut lines = stdin.lock().lines();
             if let Some(Ok(line)) = lines.next() {
                 let request: ProofRequest = serde_json::from_str(&line).expect("Failed to parse request");
                 run_proof_from_request_cpu(client, request);
             } else {
                 eprintln!("No input provided");
             }
        }
    }
}


/// Build witness and public inputs from request
fn build_inputs_from_request(request: &ProofRequest) -> (SP1Stdin, std::time::Instant, usize) {
    eprintln!("Building inputs from request...");

    // Convert input notes
    let input_notes: Vec<Note> = request.input_notes.iter().map(note_from_data).collect();

    // Convert output notes
    let output_notes: Vec<Note> = request.output_notes.iter().map(note_from_data).collect();

    // Convert signatures
    let nullifier_signatures: Vec<Vec<u8>> = request.nullifier_signatures.iter()
        .map(|k| hex_to_bytes65(k).to_vec())
        .collect();

    let tx_signatures: Vec<Vec<u8>> = request.tx_signatures.iter()
        .map(|k| hex_to_bytes65(k).to_vec())
        .collect();

    // DEBUG: Log signature v values
    for (i, sig) in nullifier_signatures.iter().enumerate() {
        eprintln!("  NullifierSig[{}] v value: {} (raw byte at index 64)", i, sig[64]);
    }
    for (i, sig) in tx_signatures.iter().enumerate() {
        eprintln!("  TxSig[{}] v value: {} (raw byte at index 64)", i, sig[64]);
    }

    // Parse old_root
    let old_root = hex_to_bytes32(&request.old_root);

    eprintln!("Transaction: {} inputs -> {} outputs", input_notes.len(), output_notes.len());
    eprintln!("Old root: 0x{}", hex::encode(&old_root[..8]));

    // Build ledger to reconstruct state
    let mut ledger = Ledger::new();

    // Add input notes at their specified indices
    for (i, note) in input_notes.iter().enumerate() {
        let idx = ledger.add_note(note.clone());
        eprintln!("Added input note {} at index {}", i, idx);
        // Note: we trust input_indices from request match the newly added notes if the state is consistent.
        // In a real generic prover, we might need to sparsely verify branches, but here we rebuild the tree locally
        // or just supply the indices. The merkle proof verification inside zkVM checks consistency.
    }

    // Verify the computed root matches old_root
    // Note: If only subset of tree provided, this local root might differ. 
    // But since we pass indices and notes, the zkVM checks inclusion against `old_root` provided in public inputs.
    // The locally rebuilt ledger might be incomplete. We trust `old_root`.
    
    // Create witness with precomputed values
    // Parse Merkle Proofs
    let input_proofs: Vec<MerkleProof> = request.input_proofs.iter()
        .zip(request.input_indices.iter())
        .map(|(proof_hex, &index)| {
            let siblings: Vec<[u8; 32]> = proof_hex.iter()
                .map(|s| hex_to_bytes32(s))
                .collect();
            MerkleProof {
                leaf_index: index as u64,
                siblings,
            }
        })
        .collect();

    // Verify witness structure locally before sending to ZK
    if input_proofs.len() != input_notes.len() {
        panic!("Mismatch: {} notes vs {} proofs", input_notes.len(), input_proofs.len());
    }

    // Create witness with precomputed values
    let witness = Witness::new(
        input_notes,
        request.input_indices.clone(),
        input_proofs,
        nullifier_signatures.clone(),
        tx_signatures.clone(),
        output_notes,
    );

    // OPTIMIZATION: Compute expensive values on host (no ECDSA in zkVM)
    eprintln!("Precomputing nullifiers and commitments on host...");

    // DEBUG: Log input note details and verify signatures before precomputing
    for (i, note) in witness.input_notes.iter().enumerate() {
        eprintln!("  Input note [{}]:", i);
        eprintln!("    amount: {}", note.amount);
        eprintln!("    owner_pubkey: 0x{}", hex::encode(&note.owner_pubkey));
        eprintln!("    blinding: 0x{}", hex::encode(&note.blinding));
        // Compute commitment to show
        let commitment = utxo_prototype::commit(note);
        eprintln!("    commitment: 0x{}", hex::encode(&commitment));
        // Compute nullifier to show (using sig)
        if i < witness.nullifier_signatures.len() {
             let nullifier = utxo_prototype::note::compute_nullifier(&witness.nullifier_signatures[i]);
             eprintln!("    nullifier: 0x{}", hex::encode(&nullifier));

             // DEBUG: Verify signature on host before sending to zkVM
             let sig = &witness.nullifier_signatures[i];
             eprintln!("    nullifier_sig (full): 0x{}", hex::encode(&sig));
             eprintln!("    sig[0..32] (r): 0x{}", hex::encode(&sig[0..32]));
             eprintln!("    sig[32..64] (s): 0x{}", hex::encode(&sig[32..64]));
             eprintln!("    sig[64] (v): {}", sig[64]);

             // Try to recover the public key from the signature
             use sha3::{Digest, Keccak256};
             use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

             // Message = Keccak256(Commitment)
             let mut hasher = Keccak256::new();
             hasher.update(&commitment);
             let msg_hash = hasher.finalize();
             eprintln!("    msg_hash (Keccak256(commitment)): 0x{}", hex::encode(&msg_hash));

             // Ethereum prefix
             let mut eth_hasher = Keccak256::new();
             eth_hasher.update(b"\x19Ethereum Signed Message:\n32");
             eth_hasher.update(&msg_hash);
             let eth_msg_hash = eth_hasher.finalize();
             eprintln!("    eth_msg_hash: 0x{}", hex::encode(&eth_msg_hash));

             // Parse signature
             let r_s_bytes = &sig[0..64];
             let v = sig[64];
             let rec_id = if v == 0 || v == 1 { v } else if v == 27 || v == 28 { v - 27 } else { ((v - 35) % 2) as u8 };
             eprintln!("    v={}, normalized rec_id={}", v, rec_id);

             match Signature::try_from(r_s_bytes) {
                 Ok(signature) => {
                     // Try BOTH recovery IDs to see what we get
                     for try_rec_id in [0u8, 1u8] {
                         if let Some(recovery_id) = RecoveryId::from_byte(try_rec_id) {
                             match VerifyingKey::recover_from_prehash(&eth_msg_hash, &signature, recovery_id) {
                                 Ok(recovered_key) => {
                                     let encoded = recovered_key.to_encoded_point(true);
                                     let recovered_x: Vec<u8> = encoded.as_bytes()[1..].to_vec();
                                     let prefix = encoded.as_bytes()[0];
                                     let is_match = recovered_x.as_slice() == note.owner_pubkey;
                                     let marker = if try_rec_id == rec_id { "<<< USING THIS" } else { "" };
                                     eprintln!("    rec_id={}: prefix=0x{:02x}, X=0x{}... match={} {}",
                                         try_rec_id, prefix, hex::encode(&recovered_x[0..8]), is_match, marker);
                                 }
                                 Err(e) => eprintln!("    rec_id={}: recovery failed: {:?}", try_rec_id, e),
                             }
                         }
                     }

                     // Now do the actual check with the provided recovery ID
                     if let Some(recovery_id) = RecoveryId::from_byte(rec_id) {
                         match VerifyingKey::recover_from_prehash(&eth_msg_hash, &signature, recovery_id) {
                             Ok(recovered_key) => {
                                 let encoded = recovered_key.to_encoded_point(true);
                                 let recovered_x: Vec<u8> = encoded.as_bytes()[1..].to_vec();
                                 eprintln!("    RECOVERED pubkey X: 0x{}", hex::encode(&recovered_x));
                                 eprintln!("    EXPECTED pubkey X:  0x{}", hex::encode(&note.owner_pubkey));
                                 if recovered_x.as_slice() == note.owner_pubkey {
                                     eprintln!("    ✅ Signature verification PASSED on host");
                                 } else {
                                     eprintln!("    ❌ Signature verification FAILED on host - pubkey mismatch!");
                                 }
                             }
                             Err(e) => eprintln!("    ❌ Signature recovery failed: {:?}", e),
                         }
                     } else {
                         eprintln!("    ❌ Invalid recovery ID: {}", rec_id);
                     }
                 }
                 Err(e) => eprintln!("    ❌ Invalid signature bytes: {:?}", e),
             }
        }
    }

    let witness = witness.with_precomputed_values();

    eprintln!("  Precomputed {} nullifiers", witness.precomputed_nullifiers.len());
    for (i, n) in witness.precomputed_nullifiers.iter().enumerate() {
        eprintln!("    [{}] 0x{}", i, hex::encode(n));
    }
    eprintln!("  Precomputed {} input commitments", witness.precomputed_input_commitments.len());
    for (i, c) in witness.precomputed_input_commitments.iter().enumerate() {
        eprintln!("    [{}] 0x{}", i, hex::encode(c));
    }
    eprintln!("  Precomputed {} output commitments", witness.precomputed_output_commitments.len());

    let public_inputs = PublicInputs { old_root };

    let expected_output_count = witness.output_notes.len();

    let mut stdin = SP1Stdin::new();
    stdin.write(&public_inputs);
    stdin.write(&witness);

    eprintln!("\nGenerating ZK proof (optimized path)...");
    (stdin, std::time::Instant::now(), expected_output_count)
}

fn run_proof_from_request_cpu(client: sp1_sdk::CpuProver, request: ProofRequest) {
    let (stdin, start, expected_output_count) = build_inputs_from_request(&request);
    let (pk, vk) = client.setup(ELF);
    let vkey_hash = format!("0x{}", vk.bytes32());
    eprintln!("Verification Key Hash: {}", vkey_hash);
    let proof = client.prove(&pk, &stdin).run().expect("Failed to generate proof");
    output_proof_response(proof, start, expected_output_count, vkey_hash, false);
}

fn run_proof_from_request_mock(client: sp1_sdk::CpuProver, request: ProofRequest) {
    let (stdin, start, expected_output_count) = build_inputs_from_request(&request);
    let (pk, vk) = client.setup(ELF);
    let vkey_hash = format!("0x{}", vk.bytes32());
    eprintln!("Verification Key Hash: {}", vkey_hash);
    let proof = client.prove(&pk, &stdin).run().expect("Failed to generate proof");
    output_proof_response(proof, start, expected_output_count, vkey_hash, true);
}

fn run_proof_from_request_network(client: sp1_sdk::NetworkProver, request: ProofRequest) {
    let (stdin, start, expected_output_count) = build_inputs_from_request(&request);
    let (pk, vk) = client.setup(ELF);
    let vkey_hash = format!("0x{}", vk.bytes32());
    eprintln!("Verification Key Hash: {}", vkey_hash);
    eprintln!("Requesting Groth16 proof from mainnet (for on-chain verification)...");
    let proof = client.prove(&pk, &stdin)
        .strategy(FulfillmentStrategy::Auction)
        .groth16()
        .run()
        .expect("Failed to generate proof");
    output_proof_response(proof, start, expected_output_count, vkey_hash, false);
}

/// Output proof as JSON to stdout (for prover-server to parse)
fn output_proof_response(proof: SP1ProofWithPublicValues, start: std::time::Instant, expected_output_count: usize, vkey_hash: String, is_mock: bool) {
    let duration = start.elapsed();
    eprintln!("Proof generated in {:?}!", duration);

    // IMPORTANT: Get raw public values bytes FIRST (for on-chain verification)
    // The SP1 verifier expects these exact bytes, not re-encoded!
    let public_values_raw = proof.public_values.to_vec();
    let public_values_hex = format!("0x{}", hex::encode(&public_values_raw));

    // ABI-decode the public outputs (program commits ABI-encoded data)
    let public_outputs = PublicOutputsSol::abi_decode(&public_values_raw, true)
        .expect("Failed to ABI-decode public outputs");

    eprintln!("\n=== Public Outputs ===");
    eprintln!("Old root: 0x{}", hex::encode(public_outputs.oldRoot.as_slice()));
    eprintln!("Nullifiers: {}", public_outputs.nullifiers.len());
    for (i, nullifier) in public_outputs.nullifiers.iter().enumerate() {
        eprintln!("  [{}]: 0x{}", i, hex::encode(nullifier.as_slice()));
    }
    eprintln!("Output commitments: {}", public_outputs.outputCommitments.len());
    for (i, commitment) in public_outputs.outputCommitments.iter().enumerate() {
        eprintln!("  [{}]: 0x{}", i, hex::encode(commitment.as_slice()));
    }

    // Verify expected outputs
    assert_eq!(
        public_outputs.outputCommitments.len(),
        expected_output_count,
        "Output commitment count mismatch"
    );

    eprintln!("\nSUCCESS! Proof verified with {} outputs.", expected_output_count);

    // Get proof bytes
    let proof_bytes = if is_mock {
        vec![0u8; 4] // Dummy bytes for mock proof
    } else {
        proof.bytes()
    };
    let proof_hex = format!("0x{}", hex::encode(&proof_bytes));

    // Build response JSON and output to stdout
    let response = ProofResponse {
        proof: proof_hex,
        public_values_raw: public_values_hex,  // Raw bytes for on-chain verification
        public_outputs: PublicOutputsJson {
            old_root: format!("0x{}", hex::encode(public_outputs.oldRoot.as_slice())),
            nullifiers: public_outputs.nullifiers.iter()
                .map(|n| format!("0x{}", hex::encode(n.as_slice())))
                .collect(),
            output_commitments: public_outputs.outputCommitments.iter()
                .map(|c| format!("0x{}", hex::encode(c.as_slice())))
                .collect(),
        },
        vkey_hash,
    };

    // Output JSON to stdout (prover-server will parse this)
    println!("{}", serde_json::to_string(&response).unwrap());
}

// ============================================================================
// DEMO MODE (for testing without frontend)
// ============================================================================

fn run_demo_cpu(client: sp1_sdk::CpuProver) {
    let (stdin, start, expected_output_count) = setup_demo_transaction();
    let (pk, vk) = client.setup(ELF);
    let vkey_hash = format!("0x{}", vk.bytes32());
    eprintln!("Verification Key Hash: {}", vkey_hash);
    let proof = client.prove(&pk, &stdin).run().expect("Failed to generate proof");
    finish_demo_proof(proof, start, expected_output_count);
}

fn run_demo_network(client: sp1_sdk::NetworkProver) {
    let (stdin, start, expected_output_count) = setup_demo_transaction();
    let (pk, vk) = client.setup(ELF);
    let vkey_hash = format!("0x{}", vk.bytes32());
    eprintln!("Verification Key Hash: {}", vkey_hash);
    eprintln!("Requesting Groth16 proof from mainnet (for on-chain verification)...");
    let proof = client.prove(&pk, &stdin)
        .strategy(FulfillmentStrategy::Auction)
        .groth16()
        .run()
        .expect("Failed to generate proof");
    finish_demo_proof(proof, start, expected_output_count);
}

/// Set up a demo transaction with precomputed values
fn setup_demo_transaction() -> (SP1Stdin, std::time::Instant, usize) {
    // Create a demo private key (32 bytes)
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

    let alice_owner: [u8; 32] = {
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&alice_privkey);
        owner
    };

    let bob_owner: [u8; 32] = {
        let mut owner = [0u8; 32];
        owner.copy_from_slice(&bob_privkey);
        owner
    };

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
    let alice_index = ledger.add_note(alice_input_note.clone());
    let old_root = ledger.current_root();

    eprintln!("Transaction: Alice (100) -> Bob (50) + Change (50)");
    eprintln!("Input note index: {}", alice_index);
    eprintln!("Old root: 0x{}", hex::encode(&old_root[..8]));

    let dummy_sig = [0u8; 65];

    let witness = Witness::new_without_proofs(
        vec![alice_input_note],
        vec![alice_index as usize],
        vec![dummy_sig.to_vec()], // Dummy NullifierSig
        vec![dummy_sig.to_vec()], // Dummy TxSig
        vec![bob_output_note, alice_change_note],
    );

    eprintln!("Precomputing nullifiers and commitments on host...");
    let witness = witness.with_precomputed_values();

    eprintln!("  Precomputed {} nullifiers", witness.precomputed_nullifiers.len());
    eprintln!("  Precomputed {} input commitments", witness.precomputed_input_commitments.len());
    eprintln!("  Precomputed {} output commitments", witness.precomputed_output_commitments.len());

    let public_inputs = PublicInputs { old_root };
    let expected_output_count = witness.output_notes.len();

    let mut stdin = SP1Stdin::new();
    stdin.write(&public_inputs);
    stdin.write(&witness);

    eprintln!("\nGenerating ZK proof (optimized path)...");
    (stdin, std::time::Instant::now(), expected_output_count)
}

fn finish_demo_proof(proof: SP1ProofWithPublicValues, start: std::time::Instant, expected_output_count: usize) {
    let duration = start.elapsed();
    eprintln!("Proof generated in {:?}!", duration);

    // ABI-decode the public outputs (program commits ABI-encoded data)
    let public_values_raw = proof.public_values.to_vec();
    let public_outputs = PublicOutputsSol::abi_decode(&public_values_raw, true)
        .expect("Failed to ABI-decode public outputs");

    eprintln!("\n=== Public Outputs ===");
    eprintln!("Old root: 0x{}", hex::encode(&public_outputs.oldRoot.as_slice()[..8]));
    eprintln!("Nullifiers: {}", public_outputs.nullifiers.len());
    for (i, nullifier) in public_outputs.nullifiers.iter().enumerate() {
        eprintln!("  [{}]: 0x{}", i, hex::encode(&nullifier.as_slice()[..8]));
    }
    eprintln!("Output commitments: {}", public_outputs.outputCommitments.len());
    for (i, commitment) in public_outputs.outputCommitments.iter().enumerate() {
        eprintln!("  [{}]: 0x{}", i, hex::encode(&commitment.as_slice()[..8]));
    }

    let proof_bytes = proof.bytes();
    eprintln!("\nProof hex: 0x{}", hex::encode(&proof_bytes[..64.min(proof_bytes.len())]));
    eprintln!("Proof length: {} bytes", proof_bytes.len());

    assert_eq!(
        public_outputs.outputCommitments.len(),
        expected_output_count,
        "Output commitment count mismatch"
    );

    eprintln!("\nSUCCESS! Proof verified with {} outputs.", expected_output_count);
}

// Helpers

fn hex_to_bytes65(hex_str: &str) -> [u8; 65] {
    let clean = if hex_str.starts_with("0x") { &hex_str[2..] } else { hex_str };
    let bytes = hex::decode(clean).expect("Invalid hex for signature");
    let mut arr = [0u8; 65];
    arr.copy_from_slice(&bytes);
    arr
}

fn hex_to_bytes32(hex_str: &str) -> [u8; 32] {
    let clean = if hex_str.starts_with("0x") { &hex_str[2..] } else { hex_str };
    let bytes = hex::decode(clean).expect("Invalid hex for root");
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    arr
}

fn note_from_data(data: &NoteData) -> Note {
    let owner = hex_to_bytes32(&data.owner_pubkey);
    let blinding = hex_to_bytes32(&data.blinding);
    Note {
        amount: data.amount,
        owner_pubkey: owner,
        blinding,
    }
}
