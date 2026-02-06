use sp1_sdk::network::client::NetworkClient;
use sp1_sdk::network::{NetworkMode, NetworkSigner};

#[tokio::main]
async fn main() {
    println!("🔍 Checking SP1 Network Balance...\n");
    
    let private_key = std::env::var("NETWORK_PRIVATE_KEY")
        .expect("❌ NETWORK_PRIVATE_KEY not set");
    
    let signer = NetworkSigner::PrivateKey(private_key);
    let address = "0x93AD852fa514255722D22315d64772BB72aEE40A";
    
    println!("Wallet Address: {}\n", address);
    
    // Try Auction Mode (NEW system - likely has your balance)
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("📍 Checking AUCTION Mode...");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    let client_auction = NetworkClient::new(
        signer.clone(),
        "https://rpc.succinct.xyz",
        NetworkMode::Auction
    );
    
    match client_auction.get_balance().await {
        Ok(balance) => {
            println!("✅ SUCCESS - Auction Balance: {} PROVE", balance);
            if balance > 0 {
                println!("🎉 FOUND YOUR BALANCE!");
            }
        },
        Err(e) => println!("❌ Auction Error: {}", e),
    }
    
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("📍 Checking BASE Mode...");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    
    // Try Base Mode (OLD system - might be empty)
    let client_base = NetworkClient::new(
        signer,
        "https://rpc.succinct.xyz",
        NetworkMode::Base
    );
    
    match client_base.get_balance().await {
        Ok(balance) => {
            println!("✅ Base Balance: {} PROVE", balance);
        },
        Err(e) => println!("❌ Base Error: {}", e),
    }
    
    println!("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    println!("💡 Note: Your balance is likely in Auction mode");
    println!("   This is the new network architecture.");
    println!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}
