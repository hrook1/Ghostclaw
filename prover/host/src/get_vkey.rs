use sp1_sdk::{HashableKey, ProverClient, Prover};

pub const ELF: &[u8] = include_bytes!("../../program/elf/sp1-program");

fn main() {
    println!("Getting verification key for SP1 program...\n");
    
    let client = ProverClient::builder().cpu().build();
    let (_, vk) = client.setup(ELF);
    
    println!("Verification Key Hash: 0x{}", vk.bytes32());
    println!("\nUse this in your Solidity verifier contract!");
}
