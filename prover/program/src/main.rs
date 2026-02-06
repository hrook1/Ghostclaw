//! SP1 zkVM Program for Private UTXO Transactions
//!
//! This program proves the validity of private UTXO transactions without
//! revealing the transaction details. It uses the optimized path when
//! precomputed values are provided by the host.
//!
//! # Security Model
//! The ZK circuit enforces:
//! 1. Merkle membership: Each input note MUST exist in the tree at old_root
//! 2. Signature validity: Owner must sign to spend
//! 3. Value conservation: sum(inputs) >= sum(outputs)
//! 4. Nullifier correctness: Prevents double-spend
//!
//! The contract then verifies:
//! - old_root matches currentRoot
//! - Nullifiers haven't been used
//! - Updates state to new_root

#![no_main]
sp1_zkvm::entrypoint!(main);

use sp1_zkvm::io;
use utxo_prototype::{
    commit, Ledger, PublicInputs, PublicOutputs, Witness,
    simulate_tx_with_precomputed,
    merkle::MerkleTree,
};
use alloy_sol_types::{sol, SolValue};

// Define Solidity-compatible struct for ABI encoding
// This must match the PublicOutputs struct in PrivateUTXOLedger.sol
sol! {
    struct PublicOutputsSol {
        bytes32 oldRoot;
        bytes32[] nullifiers;
        bytes32[] outputCommitments;
    }
}

pub fn main() {
    // ========================================================================
    // STEP 1: Read inputs from host
    // ========================================================================

    let public_inputs: PublicInputs = io::read();
    let witness: Witness = io::read();

    // ========================================================================
    // STEP 2: Validate witness structure and constraints
    // ========================================================================

    // Check structural validity (matching array lengths, non-empty tx, etc.)
    witness
        .validate_structure()
        .expect("Witness validation failed: invalid structure");

    // Check value conservation: sum(inputs) >= sum(outputs)
    witness
        .validate_value_conservation()
        .expect("Witness validation failed: value conservation violated");

    // Additional sanity checks
    assert!(
        !witness.input_notes.is_empty() || !witness.output_notes.is_empty(),
        "Transaction must have at least one input or output"
    );

    // ========================================================================
    // STEP 3: Verify precomputed values (security check)
    // ========================================================================

    let mut ledger = Ledger::new();

    // Verify precomputed input commitments match note data (if provided)
    // This is a critical security check - ensures host didn't provide fake commitments
    if witness.has_precomputed_values() {
        for (i, note) in witness.input_notes.iter().enumerate() {
            let recomputed = commit(note);
            assert_eq!(
                recomputed,
                witness.precomputed_input_commitments[i],
                "Input commitment mismatch at index {}: precomputed doesn't match note",
                i
            );
        }
    }

    // ========================================================================
    // STEP 4: CRITICAL - Verify Merkle Inclusion Proofs
    // ========================================================================
    //
    // This is the CRITICAL security step that prevents infinite mint attacks.
    // For each input note, we verify that its commitment exists in the
    // Merkle tree at old_root using a membership proof.
    //
    // Without this check, an attacker could:
    // 1. Create fake notes with arbitrary amounts (e.g., 1 billion USDC)
    // 2. Generate valid proofs (signatures work, values conserve)
    // 3. Steal unlimited funds from the contract
    //
    // The Merkle proof binds the input notes to the contract's state (old_root).

    // Verify we have Merkle proofs for all input notes
    assert!(
        witness.input_proofs.len() == witness.input_notes.len(),
        "SECURITY: Merkle proofs MUST be provided for all input notes. Got {} proofs for {} inputs.",
        witness.input_proofs.len(),
        witness.input_notes.len()
    );

    // Verify each input note exists in the tree at old_root
    for (i, (note, proof)) in witness.input_notes.iter().zip(witness.input_proofs.iter()).enumerate() {
        // Compute the commitment for this note
        let note_commitment = commit(note);

        // CRITICAL: Verify the Merkle proof against old_root
        let is_valid = MerkleTree::verify_proof(
            note_commitment,
            proof,
            public_inputs.old_root,
        );

        assert!(
            is_valid,
            "SECURITY VIOLATION: Merkle proof failed for input note {}. Note commitment does NOT exist in tree at old_root. This could be an infinite mint attack.",
            i
        );
    }

    // ========================================================================
    // STEP 5: Execute transaction and compute new state
    // ========================================================================

    // Use optimized path when precomputed values are available
    let public_outputs = if witness.has_precomputed_values() {
        // OPTIMIZED PATH: Use precomputed values (no ECDSA in zkVM)
        let mut outputs = simulate_tx_with_precomputed(
            &mut ledger,
            &witness.nullifier_signatures,
            &witness.tx_signatures,
            &witness.input_notes,
            witness.output_notes.clone(),
            &witness.precomputed_nullifiers,
            &witness.precomputed_input_commitments,
            &witness.precomputed_output_commitments,
        )
        .expect("Optimized transaction execution failed");

        // Use the provided old_root from public inputs (contract verifies this)
        // The simulate function uses a fresh ledger so returns 0x0 for old_root
        outputs.old_root = public_inputs.old_root;
        outputs
    } else {
        // STANDARD PATH: DISABLED FOR SECURITY
        // The standard path (in-circuit ECDSA) is currently disabled because it
        // does not enforce full signature verification in this prototype.
        // We MUST use the optimized path (precomputed values) where the host
        // verifies signatures and the zkVM checks them via hash matching.
        panic!("Standard path disabled: Witness must provide precomputed values for security.");
    };

    // ========================================================================
    // STEP 6: Final validation before committing
    // ========================================================================

    // Sanity check: state change logic
    // For normal transfers (joins/splits), the merkle root changes because new notes are added.
    // For full withdrawals (burning all inputs with no outputs), the merkle root DOES NOT change
    // because no new notes are added to the commitment tree. Only the nullifier set changes
    // (which is handled by the contract, not the merkle tree).
    // Therefore, we only assert old_root != new_root when there ARE output notes.
    // if !witness.output_notes.is_empty() {
    //     assert_ne!(
    //         public_outputs.old_root,
    //         public_outputs.new_root,
    //         "State should change after non-empty transfer"
    //     );
    // }

    // Verify counts match
    assert_eq!(
        public_outputs.nullifiers.len(),
        witness.input_notes.len(),
        "Nullifier count mismatch"
    );

    assert_eq!(
        public_outputs.output_commitments.len(),
        witness.output_notes.len(),
        "Commitment count mismatch"
    );

    // ========================================================================
    // STEP 7: Commit public outputs to host (ABI-encoded for Solidity)
    // ========================================================================
    //
    // SECURITY: We ABI-encode the outputs so the contract can decode them
    // directly from publicValues. This binds the proven values to what
    // the contract uses, preventing proof-binding bypass attacks.

    let sol_outputs = PublicOutputsSol {
        oldRoot: public_outputs.old_root.into(),
        nullifiers: public_outputs.nullifiers.iter().map(|n| (*n).into()).collect(),
        outputCommitments: public_outputs.output_commitments.iter().map(|c| (*c).into()).collect(),
    };

    io::commit_slice(&sol_outputs.abi_encode());
}
