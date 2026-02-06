use utxo_prototype::encryption::{encrypt_note, generate_keypair, decrypt_note};

fn main() {
    println!("=== Testing Real Encryption ===\n");
    
    // Generate recipient keypair
    let (recipient_secret, recipient_public) = generate_keypair();
    
    println!("Recipient public key: 0x{}", hex_encode(&recipient_public));
    println!("Recipient secret key: 0x{}", hex_encode(&recipient_secret));
    println!();
    
    // Note data to encrypt
    let note_data = b"amount:1000000000000000,owner:test";
    
    // Encrypt
    let encrypted = encrypt_note(note_data, &recipient_public).expect("encryption failed");
    
    println!("Encrypted output:");
    println!("  keyType: {}", encrypted.key_type as u8);
    println!("  ephemeralPubkey: 0x{}", hex_encode(&encrypted.ephemeral_pubkey));
    println!("  nonce: 0x{}", hex_encode(&encrypted.nonce));
    println!("  ciphertext: 0x{}", hex_encode(&encrypted.ciphertext));
    println!();
    
    // Decrypt
    let decrypted = decrypt_note(&encrypted, &recipient_secret);
    
    if let Some(data) = decrypted {
        println!("✅ Decryption successful!");
        println!("Decrypted: {}", String::from_utf8_lossy(&data));
    } else {
        println!("❌ Decryption failed");
    }
}

fn hex_encode(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect()
}