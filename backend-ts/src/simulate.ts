import { ethers } from "ethers";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const API_URL = "http://localhost:4000";
const CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

const ABI = [
  "function createEscrow(address freelancer, uint256 totalBudget) external returns (uint256)",
  "function fundEscrow(uint256 escrowId) external payable",
  "function startWork(uint256 escrowId) external",
  "function submitMilestone(uint256 escrowId) external",
  "function releaseFunds(uint256 escrowId, uint256 amount) external"
];

async function main() {
  console.log("\n==============================================");
  console.log("=== STARTING AUTOMATED TRUSTPAY SIMULATION ===");
  console.log("==============================================\n");

  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  
  // Account #0 (Buyer)
  const buyerWallet = new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
  // Account #1 (Freelancer)
  const freelancerWallet = new ethers.Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", provider);

  console.log(`[Config] Buyer Address:      ${buyerWallet.address}`);
  console.log(`[Config] Freelancer Address: ${freelancerWallet.address}`);

  // Helper function to authenticate wallet signature challenge
  async function authenticate(wallet: ethers.Wallet) {
    const address = wallet.address.toLowerCase();
    const resNonce = await fetch(`${API_URL}/api/auth/nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: address })
    });
    const { nonce } = (await resNonce.json()) as any;
    
    const message = `Sign this message to authenticate with TrustPay: ${nonce}`;
    const signature = await wallet.signMessage(message);

    const resVerify = await fetch(`${API_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: address, signature })
    });
    const { token } = (await resVerify.json()) as any;
    return token;
  }

  console.log("\n[Auth] Authenticating buyer & freelancer wallets with backend...");
  const buyerToken = await authenticate(buyerWallet);
  const freelancerToken = await authenticate(freelancerWallet);
  console.log("[Auth] Session tokens generated successfully.");

  // Get Freelancer ID from Database
  const freelancerDbUser = await prisma.user.findUnique({
    where: { walletAddress: freelancerWallet.address.toLowerCase() }
  });
  if (!freelancerDbUser) {
    throw new Error("Freelancer account missing in database");
  }

  // 1. Buyer creates a job posting
  console.log("\n[Step 1] Buyer publishing job on board...");
  const resJob = await fetch(`${API_URL}/api/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${buyerToken}`
    },
    body: JSON.stringify({
      title: "E2E Automated Task",
      description: "Perform end-to-end payment pipeline verification.",
      budget: "0.01"
    })
  });
  const job = (await resJob.json()) as any;
  console.log(`[DB] Job created: "${job.title}" (Job ID: ${job.id})`);

  // 2. Freelancer applies for the job
  console.log("\n[Step 2] Freelancer applying for job...");
  await fetch(`${API_URL}/api/jobs/${job.id}/apply`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${freelancerToken}` }
  });
  console.log("[DB] Applied successfully.");

  // 3. Buyer hires freelancer (creates escrow in DB)
  console.log("\n[Step 3] Buyer hiring freelancer...");
  const resHire = await fetch(`${API_URL}/api/jobs/${job.id}/hire`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${buyerToken}`
    },
    body: JSON.stringify({
      freelancerId: freelancerDbUser.id,
      milestones: [{ title: "Simulation Milestone", amount: "0.01" }]
    })
  });
  const hireResult = (await resHire.json()) as any;
  const dbEscrowId = hireResult.escrow.id;
  console.log(`[DB] Escrow created in CREATED status. ID: ${dbEscrowId}`);

  // 4. Deploy on-chain escrow
  console.log("\n[Step 4] Deploying escrow contract on-chain...");
  const contractBuyer = new ethers.Contract(CONTRACT_ADDRESS, ABI, buyerWallet);
  const budgetWei = ethers.parseEther("0.01");
  
  // Call createEscrow
  const nonceCreate = await provider.getTransactionCount(buyerWallet.address);
  const txCreate = await contractBuyer.createEscrow(freelancerWallet.address, budgetWei, { nonce: nonceCreate });
  const receipt = await txCreate.wait();
  await new Promise((r) => setTimeout(r, 1000));
  
  // Extract on-chain ID from transaction event logs
  // The local simulation starts nextEscrowId at the next incremental index.
  // We can query nextEscrowId to see what the deployed ID is
  const nextEscrowId = Number(await provider.call({
    to: CONTRACT_ADDRESS,
    data: "0x89cb29dd" // nextEscrowId() signature
  })) - 1;

  console.log(`[On-Chain] Escrow deployed. On-Chain ID: ${nextEscrowId}. Tx: ${txCreate.hash}`);

  // 5. Link DB escrow with on-chain ID
  console.log("\n[Step 5] Linking DB Escrow with On-Chain ID...");
  await fetch(`${API_URL}/api/escrows/${dbEscrowId}/tx`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${buyerToken}`
    },
    body: JSON.stringify({
      onchainId: nextEscrowId,
      txHash: txCreate.hash
    })
  });
  console.log("[DB] Linked successfully.");

  // 6. Fund Escrow Vault on-chain
  console.log("\n[Step 6] Buyer funding the escrow on-chain...");
  const nonceFund = await provider.getTransactionCount(buyerWallet.address);
  const txFund = await contractBuyer.fundEscrow(nextEscrowId, { value: budgetWei, nonce: nonceFund });
  await txFund.wait();
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[On-Chain] Funded. Tx: ${txFund.hash}`);

  // Wait for Rust watcher block confirmations
  console.log("Waiting 3 seconds for Rust watcher daemon to sync block events...");
  await new Promise((r) => setTimeout(r, 3000));

  // Check state in DB
  let escrowStatus = await prisma.escrow.findUnique({ where: { id: dbEscrowId } });
  console.log(`[DB] Current Escrow Status: ${escrowStatus?.status} (Balance: ${escrowStatus?.balance} ETH)`);

  // 7. Freelancer starts work
  console.log("\n[Step 7] Freelancer starting work on-chain...");
  const contractFreelancer = new ethers.Contract(CONTRACT_ADDRESS, ABI, freelancerWallet);
  const nonceStart = await provider.getTransactionCount(freelancerWallet.address);
  const txStart = await contractFreelancer.startWork(nextEscrowId, { nonce: nonceStart });
  await txStart.wait();
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[On-Chain] Work started. Tx: ${txStart.hash}`);
  
  console.log("Waiting 3 seconds for Rust watcher to sync...");
  await new Promise((r) => setTimeout(r, 3000));
  escrowStatus = await prisma.escrow.findUnique({ where: { id: dbEscrowId } });
  console.log(`[DB] Current Escrow Status: ${escrowStatus?.status}`);

  // 8. Freelancer submits work
  console.log("\n[Step 8] Freelancer submitting work milestone...");
  const nonceSubmit = await provider.getTransactionCount(freelancerWallet.address);
  const txSubmit = await contractFreelancer.submitMilestone(nextEscrowId, { nonce: nonceSubmit });
  await txSubmit.wait();
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[On-Chain] Work submitted. Tx: ${txSubmit.hash}`);

  console.log("Waiting 3 seconds for Rust watcher to sync...");
  await new Promise((r) => setTimeout(r, 3000));
  escrowStatus = await prisma.escrow.findUnique({ where: { id: dbEscrowId } });
  console.log(`[DB] Current Escrow Status: ${escrowStatus?.status}`);

  // 9. Buyer releases funds
  console.log("\n[Step 9] Buyer releasing vault funds...");
  const nonceRelease = await provider.getTransactionCount(buyerWallet.address);
  const txRelease = await contractBuyer.releaseFunds(nextEscrowId, budgetWei, { nonce: nonceRelease });
  await txRelease.wait();
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`[On-Chain] Settled & released. Tx: ${txRelease.hash}`);

  console.log("Waiting 4 seconds for Rust watcher to settle final state...");
  await new Promise((r) => setTimeout(r, 4000));
  escrowStatus = await prisma.escrow.findUnique({ where: { id: dbEscrowId } });
  console.log(`[DB] Current Escrow Status: ${escrowStatus?.status}`);

  // 10. Verify Reputation Rating
  const freelancerProfile = await prisma.user.findUnique({
    where: { walletAddress: freelancerWallet.address.toLowerCase() }
  });
  console.log(`\n[DB] Freelancer Updated Reputation Score: ${freelancerProfile?.reputationScore.toFixed(2)} / 10.0`);

  // 11. Fetch Audit Logs Trail
  const auditLogs = await prisma.auditLog.findMany({
    where: { escrowId: dbEscrowId },
    orderBy: { id: "asc" }
  });
  console.log(`\n=== [DB] TOTAL AUDIT TRAIL LOGS CREATED: ${auditLogs.length} ===`);
  for (const log of auditLogs) {
    console.log(`- ${log.previousState} -> ${log.newState} (Actor: ${log.actorRole})`);
  }

  console.log("\n==============================================");
  console.log("=== AUTOMATED SIMULATION COMPLETED SUCCESSFULLY ===");
  console.log("==============================================\n");
}

main().catch(console.error);
