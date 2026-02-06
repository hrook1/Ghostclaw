# Stage 1: Build Rust Prover Binary
# Rebuild trigger: 2025-12-12 security fix with ABI-encoded outputs
FROM debian:bookworm AS builder
WORKDIR /app

# Install build dependencies and Rust nightly
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    pkg-config \
    libssl-dev \
    clang \
    cmake \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly

ENV PATH="/root/.cargo/bin:${PATH}"

COPY . .

# Build the host binary in release mode using the specific manifest
# Package name is sp1-host (from prover/host/Cargo.toml)
RUN cargo build --release --manifest-path prover/host/Cargo.toml --bin sp1-host

# Stage 2: Runtime
FROM node:20-bookworm-slim
WORKDIR /app

# Install dependencies (OpenSSL is required for some Rust crates)
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

# Copy Node server dependencies
COPY prover-server/package*.json ./
RUN npm install --production

# Copy Node server code
COPY prover-server/prover-server.js ./

# Copy compiled binary from builder
# Cargo output is relative to the manifest location's target dir
COPY --from=builder /app/prover/host/target/release/sp1-host /app/sp1-host

# Copy ELF (SP1 Program)
COPY prover/program/elf/ /app/prover/program/elf/

# Environment
ENV SP1_HOST_BINARY=/app/sp1-host
ENV PORT=3001
ENV SP1_PROVER=network
# Default RPC (can be overridden)
ENV PROVER_NETWORK_RPC=https://rpc.mainnet.succinct.xyz

EXPOSE 3001

CMD ["node", "prover-server.js"]
