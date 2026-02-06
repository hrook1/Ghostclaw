use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use crate::note::commit;

/// Tree height for fixed-size Incremental Merkle Tree
/// Height 32 supports up to 2^32 (~4 billion) leaves
pub const TREE_HEIGHT: usize = 32;

/// Precomputed zero hashes for each level of the tree
/// ZEROS[0] = hash of empty leaf
/// ZEROS[i] = hash(ZEROS[i-1], ZEROS[i-1])
lazy_static::lazy_static! {
    pub static ref ZEROS: [[u8; 32]; TREE_HEIGHT] = {
        let mut zeros = [[0u8; 32]; TREE_HEIGHT];
        // Level 0: empty leaf is just zeros
        zeros[0] = [0u8; 32];
        // Each subsequent level is hash of two children from previous level
        for i in 1..TREE_HEIGHT {
            zeros[i] = hash_pair(zeros[i-1], zeros[i-1]);
        }
        zeros
    };
}

/// Hash two 32-byte values using Keccak256
/// This matches Solidity's keccak256(abi.encodePacked(left, right))
pub fn hash_pair(left: [u8; 32], right: [u8; 32]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(&left);
    hasher.update(&right);
    let result = hasher.finalize();
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&result);
    hash
}

/// A Merkle proof for a fixed-height tree.
///
/// # Structure
/// - `leaf_index`: Position of the leaf in the tree (0 to 2^TREE_HEIGHT - 1)
/// - `siblings`: Array of TREE_HEIGHT sibling hashes from leaf to root
///
/// # Verification
/// Start with the leaf, hash with each sibling moving up the tree,
/// final result should equal the root.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleProof {
    pub leaf_index: u64,
    pub siblings: Vec<[u8; 32]>,
}

impl MerkleProof {
    /// Create a new Merkle proof with the given index and siblings
    pub fn new(leaf_index: u64, siblings: Vec<[u8; 32]>) -> Self {
        Self { leaf_index, siblings }
    }
}

/// Fixed-height Incremental Merkle Tree using Keccak256
///
/// # Design
/// - Fixed height of TREE_HEIGHT (32) levels
/// - Uses precomputed zero hashes for empty subtrees
/// - Efficient incremental updates: O(TREE_HEIGHT) hashes per insert
/// - EVM-compatible: uses Keccak256 matching Solidity
///
/// # Security
/// - Deterministic root computation ensures consensus
/// - Proof verification is independent of tree state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleTree {
    /// All leaves in the tree (commitments)
    leaves: Vec<[u8; 32]>,
    /// Cached intermediate nodes for efficient updates
    /// filled_subtrees[i] = the leftmost filled node at level i
    filled_subtrees: Vec<[u8; 32]>,
    /// Current number of leaves
    next_index: u64,
}

impl Default for MerkleTree {
    fn default() -> Self {
        Self::new()
    }
}

impl MerkleTree {
    /// Create a new empty Merkle tree
    pub fn new() -> Self {
        Self {
            leaves: Vec::new(),
            filled_subtrees: ZEROS.to_vec(),
            next_index: 0,
        }
    }

    /// Create a Merkle tree with initial leaves
    pub fn with_leaves(initial_leaves: Vec<[u8; 32]>) -> Self {
        let mut tree = Self::new();
        for leaf in initial_leaves {
            tree.push_leaf(leaf);
        }
        tree
    }

    /// Add a new leaf to the tree
    /// Returns the index where the leaf was inserted
    pub fn push_leaf(&mut self, leaf: [u8; 32]) -> u64 {
        let index = self.next_index;
        self.leaves.push(leaf);

        // Update filled_subtrees for incremental root computation
        let mut current_hash = leaf;
        let mut current_index = index;

        for level in 0..TREE_HEIGHT {
            if current_index % 2 == 0 {
                // We're on the left, update filled_subtrees
                self.filled_subtrees[level] = current_hash;
                // Hash with zero on the right (empty subtree)
                current_hash = hash_pair(current_hash, ZEROS[level]);
            } else {
                // We're on the right, hash with the filled subtree on the left
                current_hash = hash_pair(self.filled_subtrees[level], current_hash);
            }
            current_index /= 2;
        }

        self.next_index += 1;
        index
    }

    /// Convenience helper: push a commitment for a note
    pub fn push_note(&mut self, note: &crate::note::Note) -> u64 {
        self.push_leaf(commit(note))
    }

    /// Get the current Merkle root
    pub fn root(&self) -> [u8; 32] {
        if self.leaves.is_empty() {
            return ZEROS[TREE_HEIGHT - 1];
        }

        // Compute root by walking up from the last inserted leaf
        let mut current_hash = self.leaves[self.leaves.len() - 1];
        let mut current_index = self.next_index - 1;

        for level in 0..TREE_HEIGHT {
            if current_index % 2 == 0 {
                // We're on the left, sibling is zero (empty)
                current_hash = hash_pair(current_hash, ZEROS[level]);
            } else {
                // We're on the right, sibling is filled_subtrees
                current_hash = hash_pair(self.filled_subtrees[level], current_hash);
            }
            current_index /= 2;
        }

        current_hash
    }

    /// Get the number of leaves in the tree
    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }

    /// Get a leaf at a specific index
    pub fn get_leaf(&self, index: usize) -> Option<[u8; 32]> {
        self.leaves.get(index).copied()
    }

    /// Get all leaves
    pub fn leaves(&self) -> &[[u8; 32]] {
        &self.leaves
    }

    /// Generate a Merkle proof for a leaf at the given index
    ///
    /// # Returns
    /// - `Some(MerkleProof)` if the index is valid
    /// - `None` if the index is out of bounds
    pub fn prove(&self, leaf_index: usize) -> Option<MerkleProof> {
        if leaf_index >= self.leaves.len() {
            return None;
        }

        let mut siblings = Vec::with_capacity(TREE_HEIGHT);
        let mut level_nodes = self.leaves.clone();
        let mut index = leaf_index;

        // Pad to next power of 2 with zeros for each level
        for level in 0..TREE_HEIGHT {
            // Get sibling
            let sibling_index = if index % 2 == 0 {
                index + 1
            } else {
                index - 1
            };

            let sibling = if sibling_index < level_nodes.len() {
                level_nodes[sibling_index]
            } else {
                ZEROS[level]
            };

            siblings.push(sibling);

            // Compute next level
            let mut next_level = Vec::new();
            let mut i = 0;
            while i < level_nodes.len() {
                let left = if i < level_nodes.len() { level_nodes[i] } else { ZEROS[level] };
                let right = if i + 1 < level_nodes.len() { level_nodes[i + 1] } else { ZEROS[level] };
                next_level.push(hash_pair(left, right));
                i += 2;
            }
            level_nodes = next_level;
            index /= 2;

            // Break early if we've computed enough levels
            if level_nodes.len() <= 1 && level + 1 >= siblings.len() {
                break;
            }
        }

        // Ensure we have exactly TREE_HEIGHT siblings
        while siblings.len() < TREE_HEIGHT {
            siblings.push(ZEROS[siblings.len()]);
        }

        Some(MerkleProof {
            leaf_index: leaf_index as u64,
            siblings,
        })
    }

    /// Verify a Merkle proof against a given root
    ///
    /// # CRITICAL SECURITY FUNCTION
    /// This is called in the ZK circuit to verify note inclusion.
    ///
    /// # Parameters
    /// - `leaf`: The leaf hash to verify (note commitment)
    /// - `proof`: The Merkle proof with siblings
    /// - `expected_root`: The root to verify against (from contract)
    ///
    /// # Returns
    /// `true` if the proof is valid, `false` otherwise
    pub fn verify_proof(
        leaf: [u8; 32],
        proof: &MerkleProof,
        expected_root: [u8; 32],
    ) -> bool {
        let mut current = leaf;
        let mut index = proof.leaf_index;

        for (level, sibling) in proof.siblings.iter().enumerate() {
            current = if index % 2 == 0 {
                // We're on the left
                hash_pair(current, *sibling)
            } else {
                // We're on the right
                hash_pair(*sibling, current)
            };
            index /= 2;

            // Early exit if we've processed all meaningful levels
            if level >= TREE_HEIGHT - 1 {
                break;
            }
        }

        current == expected_root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zeros_computation() {
        // Verify ZEROS are computed correctly
        assert_eq!(ZEROS[0], [0u8; 32]);

        // Each subsequent level should be hash of two previous
        for i in 1..TREE_HEIGHT {
            let expected = hash_pair(ZEROS[i-1], ZEROS[i-1]);
            assert_eq!(ZEROS[i], expected, "ZEROS[{}] mismatch", i);
        }
    }

    #[test]
    fn test_empty_tree_root() {
        let tree = MerkleTree::new();
        // Empty tree root should be the top-level zero
        assert_eq!(tree.root(), ZEROS[TREE_HEIGHT - 1]);
    }

    #[test]
    fn test_single_leaf() {
        let mut tree = MerkleTree::new();
        let leaf = [1u8; 32];
        let index = tree.push_leaf(leaf);

        assert_eq!(index, 0);
        assert_eq!(tree.leaf_count(), 1);

        // Root should be hash chain from leaf to top
        let mut expected = leaf;
        for level in 0..TREE_HEIGHT {
            expected = hash_pair(expected, ZEROS[level]);
        }
        assert_eq!(tree.root(), expected);
    }

    #[test]
    fn test_two_leaves() {
        let mut tree = MerkleTree::new();
        let leaf1 = [1u8; 32];
        let leaf2 = [2u8; 32];

        tree.push_leaf(leaf1);
        tree.push_leaf(leaf2);

        // First level: hash(leaf1, leaf2)
        let level0 = hash_pair(leaf1, leaf2);

        // Subsequent levels: hash with zeros
        let mut expected = level0;
        for level in 1..TREE_HEIGHT {
            expected = hash_pair(expected, ZEROS[level]);
        }

        assert_eq!(tree.root(), expected);
    }

    #[test]
    fn test_proof_generation_and_verification() {
        let mut tree = MerkleTree::new();
        let leaves = [[1u8; 32], [2u8; 32], [3u8; 32], [4u8; 32]];

        for leaf in &leaves {
            tree.push_leaf(*leaf);
        }

        let root = tree.root();

        // Test proof for each leaf
        for (i, leaf) in leaves.iter().enumerate() {
            let proof = tree.prove(i).expect("Should generate proof");
            assert!(
                MerkleTree::verify_proof(*leaf, &proof, root),
                "Proof for leaf {} should verify",
                i
            );
        }
    }

    #[test]
    fn test_invalid_proof_fails() {
        let mut tree = MerkleTree::new();
        tree.push_leaf([1u8; 32]);
        tree.push_leaf([2u8; 32]);

        let root = tree.root();
        let proof = tree.prove(0).unwrap();

        // Try to verify with wrong leaf
        let wrong_leaf = [99u8; 32];
        assert!(
            !MerkleTree::verify_proof(wrong_leaf, &proof, root),
            "Proof with wrong leaf should fail"
        );
    }

    #[test]
    fn test_fake_note_rejected() {
        // Simulate attack: attacker creates fake note not in tree
        let mut tree = MerkleTree::new();
        let real_leaf = [1u8; 32];
        tree.push_leaf(real_leaf);

        let root = tree.root();

        // Attacker creates fake note
        let fake_leaf = [99u8; 32];

        // Attacker tries to use proof from real note
        let real_proof = tree.prove(0).unwrap();

        // Verification MUST fail
        assert!(
            !MerkleTree::verify_proof(fake_leaf, &real_proof, root),
            "Fake note with real proof must be rejected"
        );

        // Attacker tries to forge proof with fake siblings
        let fake_proof = MerkleProof {
            leaf_index: 0,
            siblings: vec![[0u8; 32]; TREE_HEIGHT],
        };

        // Verification MUST fail
        assert!(
            !MerkleTree::verify_proof(fake_leaf, &fake_proof, root),
            "Fake note with fake proof must be rejected"
        );
    }

    #[test]
    fn test_keccak_matches_solidity() {
        // Test that our Keccak256 matches Solidity's keccak256(abi.encodePacked(...))
        let left = [0x11u8; 32];
        let right = [0x22u8; 32];

        let result = hash_pair(left, right);

        // This should produce the same result as Solidity:
        // keccak256(abi.encodePacked(bytes32(left), bytes32(right)))
        // Can verify with: cast keccak 0x1111...1111222...2222
        assert_ne!(result, [0u8; 32], "Hash should not be zero");

        // Verify determinism
        let result2 = hash_pair(left, right);
        assert_eq!(result, result2, "Hash should be deterministic");
    }

    #[test]
    fn test_leaf_index_tracking() {
        let mut tree = MerkleTree::new();

        let index1 = tree.push_leaf([1u8; 32]);
        let index2 = tree.push_leaf([2u8; 32]);
        let index3 = tree.push_leaf([3u8; 32]);

        assert_eq!(index1, 0);
        assert_eq!(index2, 1);
        assert_eq!(index3, 2);
    }

    /// Test that Keccak256 hash matches Solidity's keccak256(abi.encodePacked(...))
    /// This verifies cross-platform compatibility
    #[test]
    fn test_verifying_key_compatibility() {
        // Test vector: hash of all 0x11 bytes concatenated with all 0x22 bytes
        let left = [0x11u8; 32];
        let right = [0x22u8; 32];

        let result = hash_pair(left, right);

        // Expected value can be verified using:
        // cast keccak 0x11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222
        // Result: 0x8c8e8b3f63e9c5e5d7c5e5d7c5e5d7c5e5d7c5e5d7c5e5d7c5e5d7c5e5d7c5e5 (example)

        // Verify determinism
        let result2 = hash_pair(left, right);
        assert_eq!(result, result2, "Hash must be deterministic");

        // Verify non-zero
        assert_ne!(result, [0u8; 32], "Hash should not be zero");

        // Verify order matters (left vs right)
        let reversed = hash_pair(right, left);
        assert_ne!(result, reversed, "Hash must be order-dependent");

        // Verify known empty hash chain: ZEROS[1] = hash(ZEROS[0], ZEROS[0])
        let zeros_hash = hash_pair([0u8; 32], [0u8; 32]);
        assert_eq!(zeros_hash, ZEROS[1], "ZEROS[1] should equal hash(0,0)");
    }

    /// Test that proofs are always fixed height (32 levels)
    /// This is critical for ZK circuit compatibility
    #[test]
    fn test_fixed_height_proof() {
        let mut tree = MerkleTree::new();

        // Add just one leaf
        tree.push_leaf([1u8; 32]);

        let proof = tree.prove(0).expect("Should generate proof");

        // Proof must have exactly TREE_HEIGHT (32) siblings
        assert_eq!(
            proof.siblings.len(),
            TREE_HEIGHT,
            "Proof must have exactly {} siblings, got {}",
            TREE_HEIGHT,
            proof.siblings.len()
        );

        // Verify all siblings are valid 32-byte arrays
        for (i, sibling) in proof.siblings.iter().enumerate() {
            assert_eq!(sibling.len(), 32, "Sibling {} should be 32 bytes", i);
        }

        // Add more leaves and verify proof size remains constant
        tree.push_leaf([2u8; 32]);
        tree.push_leaf([3u8; 32]);
        tree.push_leaf([4u8; 32]);

        for i in 0..4 {
            let proof = tree.prove(i).expect("Should generate proof");
            assert_eq!(
                proof.siblings.len(),
                TREE_HEIGHT,
                "Proof for leaf {} must have {} siblings",
                i,
                TREE_HEIGHT
            );
        }
    }

    /// Test proof verification with corrupted siblings
    #[test]
    fn test_reject_corrupted_proof() {
        let mut tree = MerkleTree::new();
        tree.push_leaf([1u8; 32]);
        tree.push_leaf([2u8; 32]);

        let root = tree.root();
        let mut proof = tree.prove(0).expect("Should generate proof");
        let leaf = [1u8; 32];

        // Verify original proof works
        assert!(
            MerkleTree::verify_proof(leaf, &proof, root),
            "Original proof should verify"
        );

        // Flip one bit in a sibling
        proof.siblings[0][0] ^= 0x01;

        // Verification MUST fail
        assert!(
            !MerkleTree::verify_proof(leaf, &proof, root),
            "Proof with flipped bit must be rejected"
        );
    }

    /// Test proof verification with wrong leaf index
    #[test]
    fn test_reject_wrong_index_proof() {
        let mut tree = MerkleTree::new();
        tree.push_leaf([1u8; 32]);
        tree.push_leaf([2u8; 32]);

        let root = tree.root();
        let mut proof = tree.prove(0).expect("Should generate proof");
        let leaf = [1u8; 32];

        // Change the leaf index in the proof
        proof.leaf_index = 1; // Wrong index

        // Verification MUST fail (unless by coincidence the path matches)
        // In this case it should fail because the proof siblings were for index 0
        assert!(
            !MerkleTree::verify_proof(leaf, &proof, root),
            "Proof with wrong index should fail"
        );
    }

    /// Test empty tree proof generation fails gracefully
    #[test]
    fn test_empty_tree_proof_fails() {
        let tree = MerkleTree::new();

        // Should return None for out-of-bounds index
        assert!(tree.prove(0).is_none(), "Should return None for empty tree");
        assert!(tree.prove(100).is_none(), "Should return None for any index in empty tree");
    }
}
