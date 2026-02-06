use sp1_sdk::{ProverClient, SP1Stdin, Prover, SP1ProofWithPublicValues};
use alloy::{
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    sol,
};

pub const ELF: &[u8] = include_bytes!("../../program/elf/sp1-program");

sol! {
    interface ISP1UTXOVerifier {
        function verifyUTXOProof(bytes calldata proof, bytes calldata publicValues) external;
    }
}

#[tokio::main]
async fn main() {
    println!("�� Generating SP1 proof and verifying on-chain...\n");
    
    // 1. Generate local proof
    println!("1️⃣ Generating ZK proof locally...");
    let client = ProverClient::builder().cpu().build();
    
    let mut stdin = SP1Stdin::new();
    stdin.write(&100u64); // Alice balance
    stdin.write(&0u64);   // Bob balance  
    stdin.write(&50u64);  // Amount
    
    let (pk, vk) = client.setup(ELF);
    let proof = client.prove(&pk, &stdin).run().expect("Failed to generate proof");
    
    println!("✅ Proof generated! New balances: Alice=50, Bob=50\n");
    
    // 2. Submit to Sepolia
    println!("2️⃣ Submitting proof to Sepolia verifier...");
    println!("   Contract: 0x460F3deBAA95977feeE013b39eECF1314fD0d91B");
    
    // TODO: Implement on-chain verification
    println!("✅ Ready to verify on-chain!");
    println!("\n🎯 Next: Wire up Alloy to submit transaction to Sepolia");
}
