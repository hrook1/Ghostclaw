use axum::{
    extract::ws::{WebSocket, WebSocketUpgrade},
    response::IntoResponse,
    routing::get,
    Router,
};
use sp1_sdk::{ProverClient, SP1Stdin};
use tokio::sync::mpsc;

const ELF: &[u8] = include_bytes!("../../sp1-program/target/riscv32im-succinct-zkvm-elf/release/sp1-program");

#[tokio::main]
async fn main() {
    println!("🚀 Starting Local SP1 Prover CLI");
    println!("📡 WebSocket server on ws://localhost:3001");
    
    let app = Router::new()
        .route("/", get(ws_handler));

    axum::Server::bind(&"0.0.0.0:3001".parse().unwrap())
        .serve(app.into_make_service())
        .await
        .unwrap();
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    while let Some(msg) = socket.recv().await {
        let msg = match msg {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("WebSocket error: {}", e);
                break;
            }
        };

        if let axum::extract::ws::Message::Text(text) = msg {
            let request: serde_json::Value = serde_json::from_str(&text).unwrap();
            
            if request["type"] == "prove" {
                tokio::spawn(async move {
                    generate_proof_with_progress(socket, request["witness"].clone()).await;
                });
                return;
            }
        }
    }
}

async fn generate_proof_with_progress(
    mut socket: WebSocket,
    witness_json: serde_json::Value,
) {
    // Send progress updates
    let _ = socket.send(axum::extract::ws::Message::Text(
        serde_json::json!({
            "type": "progress",
            "percent": 10,
            "message": "Setting up prover..."
        }).to_string()
    )).await;

    let client = ProverClient::from_env();
    let (pk, _vk) = client.setup(ELF);

    let _ = socket.send(axum::extract::ws::Message::Text(
        serde_json::json!({
            "type": "progress",
            "percent": 20,
            "message": "Generating proof..."
        }).to_string()
    )).await;

    // Deserialize witness
    let mut stdin = SP1Stdin::new();
    // ... serialize witness into stdin ...

    match client.prove(&pk, &stdin).plonk().run() {
        Ok(proof) => {
            let _ = socket.send(axum::extract::ws::Message::Text(
                serde_json::json!({
                    "type": "proof",
                    "proof": hex::encode(proof.bytes()),
                    "publicOutputs": {} // Extract from proof
                }).to_string()
            )).await;
        }
        Err(e) => {
            let _ = socket.send(axum::extract::ws::Message::Text(
                serde_json::json!({
                    "type": "error",
                    "message": e.to_string()
                }).to_string()
            )).await;
        }
    }
}