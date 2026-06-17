import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { ethers } from "ethers";
import { PrismaClient, Role, JobStatus, EscrowStatus } from "@prisma/client";
import { createClient } from "redis";

dotenv.config();

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "trustpay_super_secret_key";
const nonces: Record<string, string> = {}; // In-memory nonce cache

// Authentication Middleware
interface AuthenticatedRequest extends express.Request {
  user?: { id: number; walletAddress: string; role: Role };
}

const authenticateToken = (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: "Access token missing" });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid or expired token" });
    req.user = user as any;
    next();
  });
};

// --- AUTH ENDPOINTS ---

app.post("/api/auth/nonce", (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: "Wallet address required" });
  
  const nonce = Math.floor(Math.random() * 1000000).toString();
  nonces[walletAddress.toLowerCase()] = nonce;
  res.json({ nonce });
});

app.post("/api/auth/verify", async (req, res) => {
  const { walletAddress, signature } = req.body;
  if (!walletAddress || !signature) {
    return res.status(400).json({ error: "Wallet address and signature required" });
  }

  const addrLower = walletAddress.toLowerCase();
  const nonce = nonces[addrLower];
  if (!nonce) return res.status(400).json({ error: "Nonce expired or not found" });

  try {
    const message = `Sign this message to authenticate with TrustPay: ${nonce}`;
    const recoveredAddress = ethers.verifyMessage(message, signature);
    
    if (recoveredAddress.toLowerCase() !== addrLower) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    // Delete nonce to prevent replay attack
    delete nonces[addrLower];

    // Find or create user
    let user = await prisma.user.findUnique({ where: { walletAddress: addrLower } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          walletAddress: addrLower,
          role: Role.BUYER // Default role
        }
      });
    }

    const token = jwt.sign(
      { id: user.id, walletAddress: user.walletAddress, role: user.role },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({ token, user });
  } catch (error) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// --- USER PROFILE & REPUTATION ---

app.get("/api/users/:address", async (req, res) => {
  const { address } = req.params;
  try {
    const user = await prisma.user.findUnique({
      where: { walletAddress: address.toLowerCase() },
      include: {
        reputationLogs: true
      }
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

// --- JOBS ENDPOINTS ---

app.get("/api/jobs", async (req, res) => {
  try {
    const jobs = await prisma.job.findMany({
      include: {
        creator: true,
        freelancer: true
      }
    });
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

app.post("/api/jobs", authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { title, description, budget } = req.body;
  if (!title || !description || !budget) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const job = await prisma.job.create({
      data: {
        title,
        description,
        budget,
        creatorId: req.user!.id,
        status: JobStatus.OPEN
      }
    });
    res.json(job);
  } catch (error) {
    res.status(500).json({ error: "Failed to create job" });
  }
});

app.post("/api/jobs/:id/apply", authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  try {
    const job = await prisma.job.findUnique({ where: { id: parseInt(id) } });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.creatorId === req.user!.id) {
      return res.status(400).json({ error: "Creators cannot apply to their own jobs" });
    }

    // Assign freelancer
    const updatedJob = await prisma.job.update({
      where: { id: job.id },
      data: {
        freelancerId: req.user!.id,
        status: JobStatus.OPEN // Keep open until hire/lock
      }
    });
    res.json(updatedJob);
  } catch (error) {
    res.status(500).json({ error: "Application failed" });
  }
});

app.post("/api/jobs/:id/hire", authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { freelancerId, milestones } = req.body; // Array of { title, amount }
  
  if (!freelancerId || !milestones || milestones.length === 0) {
    return res.status(400).json({ error: "Freelancer and milestone definitions required" });
  }

  try {
    const job = await prisma.job.findUnique({ where: { id: parseInt(id) } });
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.creatorId !== req.user!.id) {
      return res.status(403).json({ error: "Only job creator can hire" });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Update Job status
      const updatedJob = await tx.job.update({
        where: { id: job.id },
        data: {
          freelancerId,
          status: JobStatus.ACTIVE
        }
      });

      // Create Escrow in CREATED status
      const escrow = await tx.escrow.create({
        data: {
          buyerId: req.user!.id,
          freelancerId,
          jobId: job.id,
          status: EscrowStatus.CREATED,
          balance: 0.0,
          milestones: {
            create: milestones.map((m: any) => ({
              title: m.title,
              amount: m.amount,
              status: "CREATED"
            }))
          }
        },
        include: {
          milestones: true
        }
      });

      // Insert initial audit log
      await tx.auditLog.create({
        data: {
          escrowId: escrow.id,
          previousState: "NONE",
          newState: "CREATED",
          actorId: req.user!.id,
          actorRole: req.user!.role,
        }
      });

      return { job: updatedJob, escrow };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Hiring process failed" });
  }
});

// --- ESCROW DETAILS ---

app.get("/api/escrows/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const escrow = await prisma.escrow.findUnique({
      where: { id: parseInt(id) },
      include: {
        job: true,
        buyer: true,
        freelancer: true,
        milestones: true,
        auditLogs: {
          include: { actor: true },
          orderBy: { createdAt: "desc" }
        }
      }
    });
    if (!escrow) return res.status(404).json({ error: "Escrow not found" });
    res.json(escrow);
  } catch (error) {
    res.status(500).json({ error: "Database error" });
  }
});

// API endpoint to link on-chain escrow ID and txHash to DB
app.post("/api/escrows/:id/tx", authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { id } = req.params;
  const { onchainId, txHash } = req.body;
  if (!txHash) return res.status(400).json({ error: "Transaction hash required" });

  try {
    const escrow = await prisma.escrow.update({
      where: { id: parseInt(id) },
      data: {
        onchainId: onchainId ? parseInt(onchainId) : undefined,
        txHash
      }
    });
    res.json(escrow);
  } catch (error) {
    res.status(500).json({ error: "Failed to link transaction" });
  }
});

// --- REDIS PUB/SUB & WEBSOCKETS ---

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379"
});

redisClient.on("error", (err) => console.error("Redis Error", err));

async function startRedisSubscriber() {
  await redisClient.connect();
  const subscriber = redisClient.duplicate();
  await subscriber.connect();

  console.log("Redis Pub/Sub Subscriber connected.");
  await subscriber.subscribe("escrow_updates", (message) => {
    try {
      const event = JSON.parse(message);
      console.log(`Received update for Escrow ${event.escrow_id}: ${event.status}`);
      
      // Stream notification to all connected websocket clients
      io.emit(`escrow_update:${event.escrow_id}`, event);
      io.emit("global_escrow_update", event);
    } catch (e) {
      console.error("Failed to parse PubSub message", e);
    }
  });
}

// Start Server
const PORT = process.env.PORT || 4000;
server.listen(PORT, async () => {
  console.log(`Express API Server running on port ${PORT}`);
  try {
    await startRedisSubscriber();
  } catch (e) {
    console.error("Failed to connect Redis Subscriber", e);
  }
});
