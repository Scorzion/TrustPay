# 🛡️ TrustPay: Distributed Escrow & Milestone Payment Platform

TrustPay is a secure, milestone-based distributed escrow payment platform. It utilizes a robust hybrid-backend architecture to achieve maximum performance, security, and real-time state synchronization.

---

## 🏗️ System Architecture

TrustPay is designed to separate concerns between user/job management (TypeScript REST API) and high-concurrency event-driven blockchain syncing/state enforcement (Rust Daemon):

```
                     ┌──────────────────┐
                     │  React Frontend  │
                     └────────┬─────────┘
                              │
                     REST API │ WebSockets (Socket.io)
                              ▼
        ┌───────────────────────────────────────────┐
        │        TypeScript Express Backend         │
        └─────────────────────┬─────────────────────┘
                              │
                    Reads/    │ Redis Pub/Sub
                    Writes    │ (Realtime alerts)
                              ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  PostgreSQL  │ ◄─── │ Rust Engine  │ ◄─── │ Hardhat/EVM  │
│   Database   │      │  (Watcher)   │      │  RPC Node    │
└──────────────┘      └───────┬──────┘      └──────────────┘
                              │
                              ▼
                      ┌──────────────┐
                      │  Redis Lock  │
                      │  (Redlock)   │
                      └──────────────┘
```

1. **Smart Contracts (Solidity):** Deployed on-chain to act as the trustless vault and state-holder for the funds.
2. **TypeScript API Gateway:** Manages authentication (nonce-based wallet signatures), user profiles, jobs metadata, and Socket.io broadcasts.
3. **Rust Watcher Engine:** A highly concurrent background service that listens to smart contract events, ensures 2+ block confirmations, manages locks via Redis (Redlock), performs state transitions inside database transactions, and calculates reputation scores.
4. **React Dashboard:** A premium Web3 client application allowing buyers and freelancers to interact with the platform, manage disputes, and track reputation.

---

## ⚡ Key Features

* **Milestone Payments:** Buyers fund escrows, and payments are unlocked step-by-step upon freelancer milestone completion.
* **Cryptographic Nonce Auth:** Passwordless authentication using Web3 wallet signatures.
* **Append-Only Audit Logs:** Every state change of an escrow triggers an immutable transaction log record.
* **Double-Safety Concurrency:**
  * Distributed Redis Locks (Redlock) to prevent parallel processing of the same Escrow.
  * Optimistic Concurrency Control (OCC) using a version column in PostgreSQL.
* **Automated Reputation System:** Dynamically re-calculates user scores based on successful milestones and dispute histories.

---

## 🛠️ Tech Stack

* **Contracts:** Solidity `0.8.20`, Hardhat, Ethers.js
* **TS Server:** Node.js, Express, Prisma ORM, PostgreSQL, Redis Pub/Sub, Socket.io
* **Rust Daemon:** Tokio Async Runtime, SQLx, Ethers-rs, Redis-rs, BigDecimal
* **Frontend:** React 19, Vite, Tailwind CSS v4, Wagmi, RainbowKit

---

## 🚀 Getting Started

### 📋 Prerequisites
Ensure you have the following installed locally:
* Node.js (v18+) & npm
* Rust & Cargo (stable)
* PostgreSQL & Redis

---

### 1. Smart Contract Setup & Node
Start a local Hardhat blockchain node and deploy the contract:
```bash
# Install root dependencies
npm install

# Run the local blockchain network
npx hardhat node
```
In a new terminal, deploy the smart contract to the local network:
```bash
npx hardhat run scripts/deploy.js --network localhost
```
*Note the deployed contract address (typically `0x5FbDB2315678afecb367f032d93F642f64180aa3` on local runs).*

---

### 2. TypeScript API Gateway Setup
1. Navigate to the TypeScript server directory:
   ```bash
   cd backend-ts
   npm install
   ```
2. Configure `.env` using `.env.example` as a template:
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/trustpay?schema=public"
   JWT_SECRET="your_jwt_secret_here"
   REDIS_URL="redis://127.0.0.1:6379"
   PORT=4000
   ```
3. Run migrations and start the dev server:
   ```bash
   npx prisma migrate dev
   npm run dev
   ```

---

### 3. Rust Watcher Daemon Setup
1. Navigate to the Rust backend:
   ```bash
   cd backend-rust
   ```
2. Configure `.env` in `backend-rust`:
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/trustpay?schema=public"
   REDIS_URL="redis://127.0.0.1:6379"
   RPC_URL="http://127.0.0.1:8545"
   CONTRACT_ADDRESS="0x5FbDB2315678afecb367f032d93F642f64180aa3"
   ```
3. Build and run the daemon:
   ```bash
   cargo run
   ```

---

### 4. React Frontend Setup
1. Navigate to the frontend app:
   ```bash
   cd frontend
   npm install
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. Open `http://localhost:5173` in your browser. Configure MetaMask to connect to Localhost (`http://127.0.0.1:8545`, Chain ID `31337`).

---

## 🔒 Security & Concurrency Controls

### Redlock + SQL Transactions
When an event (e.g., `MilestoneReleased`) is captured by the Rust watcher:
1. The daemon attempts to acquire a Redis lock for `lock:escrow:<escrow_id>`.
2. Once the lock is acquired, it starts a PostgreSQL transaction:
   * Selects the current state of the escrow and its version.
   * Performs validation rules (state transitions check).
   * Executes the update and increments the version:
     ```sql
     UPDATE escrows SET status = $1, version = version + 1 WHERE id = $2 AND version = $3;
     ```
   * Appends an entry to the `audit_logs` table.
3. The transaction is committed and the Redis lock is released.
