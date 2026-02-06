use blake3::Hasher;
use serde::{Deserialize, Serialize};

// Domain separators as constants for better maintainability
const NOTE_COMMITMENT_DOMAIN: &[u8] = b"NOTE_COMMITMENT_v1";
const NULLIFIER_DOMAIN: &[u8] = b"NULLIFIER_v1";

/// A simple UTXO note in our prototype.
///
/// # Privacy Model
/// - `owner_pubkey`: Public - identifies who can spend this note
/// - `amount`: Public in commitment, hidden in witness
/// - `blinding`: Private - adds entropy to prevent commitment analysis
///
/// # Security Properties
/// - Commitment hiding: `blinding` ensures same amount/owner produce different commitments
/// - Spending authority: Only holder of `owner_privkey` can sign for this note
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Note {
    pub amount: u64,
    pub owner_pubkey: [u8; 32],
    pub blinding: [u8; 32],
}

impl Note {
    /// Create a new note with the given parameters.
    pub fn new(
        amount: u64,
        owner_pubkey: [u8; 32],
        blinding: [u8; 32],
    ) -> Self {
        Self {
            amount,
            owner_pubkey,
            blinding,
        }
    }

    /// Compute the commitment for this note.
    ///
    /// This is a convenience method that calls the top-level `commit` function.
    pub fn commitment(&self) -> [u8; 32] {
        commit(self)
    }
}

/// A nullifier is a 32-byte tag indicating "this note has been spent".
///
/// # Protocol Design
/// - Posted publicly on Ethereum when a note is spent
/// - Tracked in the `nullifierUsed` mapping to prevent double-spending
/// - Unlinkable to the original note commitment (privacy property)
pub type Nullifier = [u8; 32];

/// Compute a 32-byte commitment hash for a Note.
///
/// # Commitment Scheme
/// The commitment binds to:
/// - `amount`: The value of the note
/// - `owner_pubkey`: Who can spend it
/// - `blinding`: Random entropy for hiding
///
/// # Security Properties
/// - **Hiding**: Same amount/owner with different blinding produce different commitments
/// - **Binding**: Computationally infeasible to find two notes with same commitment
///
/// # Output
/// This 32-byte hash becomes a leaf in the global Merkle tree on Ethereum.
pub fn commit(note: &Note) -> [u8; 32] {
    let mut hasher = Hasher::new();

    // Domain separator prevents hash collisions with other protocol components
    hasher.update(NOTE_COMMITMENT_DOMAIN);

    // Hash all public and semi-public components
    hasher.update(&note.amount.to_le_bytes());
    hasher.update(&note.owner_pubkey);
    hasher.update(&note.blinding);

    let hash = hasher.finalize();
    *hash.as_bytes()
}

/// Compute a nullifier for a note (with ECDSA ownership verification).
///
/// # Nullifier Construction
/// The nullifier binds to:
/// - `owner_privkey`: Proves ownership (only note owner knows this)
/// - `commitment`: The note's unique identity

/// Compute a nullifier from a signature.
///
/// # Logic
/// Nullifier = Hash(NULLIFIER_DOMAIN || signature)
///
/// # Privacy
/// - The signature should be over the note commitment.
/// - Since the signature is deterministic (RFC 6979), the nullifier is stable.
/// - Observers see Hash(Sig), which they cannot link to the user/pubkey.
pub fn compute_nullifier(signature: &[u8]) -> Nullifier {
    let mut hasher = Hasher::new();
    hasher.update(NULLIFIER_DOMAIN);
    hasher.update(signature);
    let hash = hasher.finalize();
    *hash.as_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_signature_produces_consistent_nullifier() {
        let signature = [7u8; 65];
        let nullifier1 = compute_nullifier(&signature);
        let nullifier2 = compute_nullifier(&signature);
        assert_eq!(nullifier1, nullifier2);
    }

    #[test]
    fn test_different_signature_produces_different_nullifier() {
        let sig1 = [7u8; 65];
        let mut sig2 = [7u8; 65];
        sig2[0] = 8;

        let nullifier1 = compute_nullifier(&sig1);
        let nullifier2 = compute_nullifier(&sig2);
        assert_ne!(nullifier1, nullifier2);
    }

    #[test]
    fn test_commitment_and_nullifier_are_different() {
        let note = Note::new(100, [1; 32], [2; 32]);
        let commitment = commit(&note);
        let signature = [7u8; 65];
        let nullifier = compute_nullifier(&signature);

        assert_ne!(commitment, nullifier);
    }

    // ========================================================================
    // CROSS-LANGUAGE TEST VECTORS
    // These test vectors MUST produce identical results in:
    // - Rust (this file)
    // - TypeScript (wallet-ui/lib/blockchain/__tests__/crypto.test.ts)
    // ========================================================================

    /// Test vectors for commitment computation.
    /// Format: (amount, owner_pubkey, blinding) -> expected_commitment_hex
    ///
    /// These MUST match the TypeScript implementation in:
    /// wallet-ui/lib/blockchain/__tests__/crypto.test.ts
    #[test]
    fn test_cross_language_commitment_vectors() {
        let vectors: Vec<(u64, [u8; 32], [u8; 32], &str)> = vec![
            // Vector 1: All zeros
            (
                0,
                [0u8; 32],
                [0u8; 32],
                "1e8af20d48ee936d9103eababd56c1e38bf109efb7989b952c3fd8567a0acea0"
            ),
            // Vector 2: Amount = 1, zeros for rest
            (
                1,
                [0u8; 32],
                [0u8; 32],
                "48d08168fd95f6a20372352f24fff272d5fc196b83d301261e3256c426ca250d"
            ),
            // Vector 3: Amount = 1000000 (1 USDC)
            (
                1_000_000,
                [0u8; 32],
                [0u8; 32],
                "0831eb81730f6f4d00d39710f63ee4369a7f30c5fedd5dc47b3dfeea6c14decd"
            ),
            // Vector 4: All 0x01 bytes
            (
                1,
                [1u8; 32],
                [1u8; 32],
                "ce6f22ebe3b967fe49cddfe0ee25f09720c315b839ede22b919735073cbce0c9"
            ),
            // Vector 5: All 0xff bytes, max amount
            (
                u64::MAX,
                [0xff; 32],
                [0xff; 32],
                "9372b028a291b1de5689336039318b863f7d86f176c8dd3f18cac918267edb84"
            ),
            // Vector 6: Real-world like values (50 USDC)
            (
                50_000_000,
                [
                    0x02, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
                    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
                    0x02, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
                    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
                ],
                [
                    0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
                    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
                    0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe,
                    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
                ],
                "6c2bbe93adf453791e71160f24326d9b19918db75db9d0228e15e1a6b08b59a5"
            ),
        ];

        // Verify each vector produces the expected commitment
        for (i, (amount, owner, blinding, expected)) in vectors.iter().enumerate() {
            let note = Note::new(*amount, *owner, *blinding);
            let commitment = commit(&note);
            let hex_str: String = commitment.iter().map(|b| format!("{:02x}", b)).collect();
            assert_eq!(
                hex_str, *expected,
                "Commitment vector {} mismatch: got {}, expected {}",
                i + 1, hex_str, expected
            );
        }
    }

    /// Test vectors for nullifier computation.
    /// Format: signature (65 bytes) -> expected_nullifier_hex
    ///
    /// These MUST match the TypeScript implementation in:
    /// wallet-ui/lib/blockchain/__tests__/crypto.test.ts
    #[test]
    fn test_cross_language_nullifier_vectors() {
        let vectors: Vec<([u8; 65], &str)> = vec![
            // Vector 1: All zeros signature
            (
                [0u8; 65],
                "aaa2bc62243a9dcd2abf1711297594b30fd61f7a8fd6a04d8c87fbd7040520ae"
            ),
            // Vector 2: All 0x07 (from original test)
            (
                [7u8; 65],
                "db54b7046a9a8bf09b94c5bf269f81bb0a11dba770b7e20ff48e5918cf98c950"
            ),
            // Vector 3: All 0xff
            (
                [0xff; 65],
                "4a9e054aca596985fd24974695a7fca4fa971c2bac49dd6beb5d10795bc7a988"
            ),
            // Vector 4: Realistic signature pattern (r, s, v=27)
            (
                {
                    let mut sig = [0u8; 65];
                    // r (32 bytes): 0, 2, 4, 6, ..., 62
                    for i in 0..32 { sig[i] = (i * 2) as u8; }
                    // s (32 bytes): 96, 99, 102, ..., 189
                    for i in 32..64 { sig[i] = (i * 3) as u8; }
                    // v = 27
                    sig[64] = 27;
                    sig
                },
                "be8e3d764b861480b9aa78501f0b70ce2e8776fe85f601eca4992de8be990e8d"
            ),
            // Vector 5: Same as 4 but v = 28
            (
                {
                    let mut sig = [0u8; 65];
                    for i in 0..32 { sig[i] = (i * 2) as u8; }
                    for i in 32..64 { sig[i] = (i * 3) as u8; }
                    sig[64] = 28;
                    sig
                },
                "1730ab08c018defec6017e624816c3f99bd86566f98bf30c6cff30876ef1bf93"
            ),
        ];

        // Verify each vector produces the expected nullifier
        for (i, (sig, expected)) in vectors.iter().enumerate() {
            let nullifier = compute_nullifier(sig);
            let hex_str: String = nullifier.iter().map(|b| format!("{:02x}", b)).collect();
            assert_eq!(
                hex_str, *expected,
                "Nullifier vector {} mismatch: got {}, expected {}",
                i + 1, hex_str, expected
            );
        }
    }
}
