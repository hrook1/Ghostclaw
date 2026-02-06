use sp1_sdk::ProverClient;

#[tokio::main]
async fn main() {
    println!("Checking Succinct Network balance...\n");
    
    let client = ProverClient::builder().network().build();
    
    println!("✅ Client created successfully!");
    
    // Call the get_balance method
    match client.get_balance().await {
        Ok(balance) => {
            println!("🎉 SUCCESS! Balance found: {} credits", balance);
            println!("\nYour SDK balance: {}", balance);
            println!("Your explorer shows: 133 PROVE");
            
            if balance.is_zero() {
                println!("\n❌ SDK reports 0 balance even though explorer shows 133 PROVE");
                println!("This confirms the sync issue between SDK and explorer database");
            } else {
                println!("\n✅ BALANCE IS SYNCED! You can generate proofs now!");
            }
        }
        Err(e) => {
            println!("❌ Error getting balance: {:?}", e);
        }
    }
}
