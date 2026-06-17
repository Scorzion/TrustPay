import { useState, useEffect, useRef } from 'react';
import { useAccount, useSignMessage, useWriteContract, usePublicClient } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { io, Socket } from 'socket.io-client';
import { parseEther, decodeEventLog } from 'viem';
import { TRUSTPAY_ABI } from './abi';
import {
  Shield,
  Coins,
  CheckCircle2,
  AlertTriangle,
  User,
  Briefcase,
  Plus,
  RefreshCw,
  FileText,
  Trophy,
  ExternalLink,
  ChevronRight,
  Lock,
  Activity
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const DEFAULT_CONTRACT_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

// Interface definitions
interface UserProfile {
  id: number;
  walletAddress: string;
  role: 'BUYER' | 'FREELANCER' | 'ADMIN';
  reputationScore: number;
}

interface Milestone {
  id: number;
  title: string;
  amount: string;
  status: 'CREATED' | 'FUNDED' | 'SUBMITTED' | 'RELEASED';
}

interface Escrow {
  id: number;
  onchainId: number | null;
  status: 'CREATED' | 'FUNDED' | 'IN_PROGRESS' | 'SUBMITTED' | 'RELEASED' | 'DISPUTED' | 'RESOLVED';
  buyerId: number;
  freelancerId: number;
  balance: string;
  txHash: string | null;
  buyer: UserProfile;
  freelancer: UserProfile;
  job: {
    id: number;
    title: string;
    description: string;
    budget: string;
  };
  milestones: Milestone[];
  auditLogs: {
    id: number;
    previousState: string;
    newState: string;
    actorRole: string;
    txHash: string | null;
    createdAt: string;
    actor: UserProfile | null;
  }[];
}

interface Job {
  id: number;
  title: string;
  description: string;
  budget: string;
  creatorId: number;
  freelancerId: number | null;
  status: 'OPEN' | 'ACTIVE' | 'COMPLETED';
  creator: UserProfile;
  freelancer?: UserProfile | null;
}

function App() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();

  // State Management
  const [contractAddress, setContractAddress] = useState(DEFAULT_CONTRACT_ADDRESS);
  const [authToken, setAuthToken] = useState<string | null>(localStorage.getItem('trustpay_token'));
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [escrows, setEscrows] = useState<Record<number, Escrow>>({});
  const [selectedEscrowId, setSelectedEscrowId] = useState<number | null>(null);
  const [liveLogs, setLiveLogs] = useState<{ id: string; text: string; time: string }[]>([]);
  const socketRef = useRef<Socket | null>(null);

  // Form States
  const [newJobTitle, setNewJobTitle] = useState('');
  const [newJobDesc, setNewJobDesc] = useState('');
  const [newJobBudget, setNewJobBudget] = useState('');
  
  // Hiring Form States
  const [hiringJobId, setHiringJobId] = useState<number | null>(null);
  const [hiringFreelancerAddr, setHiringFreelancerAddr] = useState('');
  const [hiringMilestones, setHiringMilestones] = useState<{ title: string; amount: string }[]>([
    { title: 'Milestone 1', amount: '' }
  ]);

  // Loading States
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);

  // Fetch Jobs List
  const fetchJobs = async () => {
    setLoadingJobs(true);
    try {
      const res = await fetch(`${API_URL}/api/jobs`);
      const data = await res.json();
      if (Array.isArray(data)) {
        setJobs(data);
      }
    } catch (err) {
      console.error('Error fetching jobs:', err);
    } finally {
      setLoadingJobs(false);
    }
  };

  // Sign message and verify with backend to obtain JWT token
  const handleAuth = async () => {
    if (!address) return;
    setAuthLoading(true);
    try {
      // 1. Get nonce from server
      const nonceRes = await fetch(`${API_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address }),
      });
      const { nonce } = await nonceRes.json();

      // 2. Sign message using wallet
      const message = `Sign this message to authenticate with TrustPay: ${nonce}`;
      const signature = await signMessageAsync({ message });

      // 3. Verify signature on server
      const verifyRes = await fetch(`${API_URL}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, signature }),
      });
      const data = await verifyRes.json();

      if (data.token) {
        setAuthToken(data.token);
        setCurrentUser(data.user);
        localStorage.setItem('trustpay_token', data.token);
        addLiveLog('System', `Successfully authenticated wallet: ${address.substring(0, 6)}...${address.substring(38)}`);
      } else {
        alert(data.error || 'Authentication failed');
      }
    } catch (err) {
      console.error('Auth error:', err);
      alert('Failed to authenticate wallet');
    } finally {
      setAuthLoading(false);
    }
  };

  // Fetch Current User Details / Reputation Score
  const fetchProfile = async () => {
    if (!address) return;
    try {
      const res = await fetch(`${API_URL}/api/users/${address}`);
      if (res.status === 200) {
        const user = await res.json();
        setCurrentUser(user);
      }
    } catch (err) {
      console.error('Profile fetch error:', err);
    }
  };

  // Fetch specific Escrow Details
  const fetchEscrowDetails = async (id: number) => {
    try {
      const res = await fetch(`${API_URL}/api/escrows/${id}`);
      if (res.status === 200) {
        const data = await res.json();
        setEscrows(prev => ({ ...prev, [id]: data }));
      }
    } catch (err) {
      console.error('Error fetching escrow details:', err);
    }
  };

  // Set up socket.io connection for real-time state changes
  useEffect(() => {
    socketRef.current = io(API_URL);
    
    socketRef.current.on('global_escrow_update', (event) => {
      addLiveLog('Watcher', `Escrow #${event.escrow_id} state updated to: ${event.status}`);
      fetchEscrowDetails(event.escrow_id);
      fetchJobs();
    });

    fetchJobs();

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []);

  // Sync profile when wallet/auth changes
  useEffect(() => {
    if (address && authToken) {
      fetchProfile();
    } else {
      setCurrentUser(null);
    }
  }, [address, authToken]);

  const addLiveLog = (source: string, text: string) => {
    setLiveLogs(prev => [
      {
        id: Math.random().toString(),
        text: `[${source}] ${text}`,
        time: new Date().toLocaleTimeString(),
      },
      ...prev.slice(0, 19) // Limit to 20 logs
    ]);
  };

  // Create Job (Express POST)
  const handleCreateJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newJobTitle || !newJobDesc || !newJobBudget) return;
    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          title: newJobTitle,
          description: newJobDesc,
          budget: newJobBudget
        })
      });
      if (res.status === 200) {
        addLiveLog('API', `Published new job posting: "${newJobTitle}"`);
        setNewJobTitle('');
        setNewJobDesc('');
        setNewJobBudget('');
        fetchJobs();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to create job');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  // Apply to Job
  const handleApplyJob = async (jobId: number) => {
    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/jobs/${jobId}/apply`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      if (res.status === 200) {
        addLiveLog('API', `Applied to Job #${jobId}`);
        fetchJobs();
      } else {
        const err = await res.json();
        alert(err.error || 'Failed to apply');
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  // Hire Freelancer & Deploy Escrow
  const handleHireSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (hiringJobId === null || !hiringFreelancerAddr) return;
    setActionLoading(true);
    try {
      // 1. Resolve Freelancer Profile to get Database ID
      const userRes = await fetch(`${API_URL}/api/users/${hiringFreelancerAddr}`);
      if (userRes.status !== 200) {
        alert('Freelancer must have authenticated their wallet once on the platform before they can be hired.');
        setActionLoading(false);
        return;
      }
      const freelancerUser = await userRes.json();

      // 2. Call Hire API to create escrow in CREATED state in Postgres database
      const hireRes = await fetch(`${API_URL}/api/jobs/${hiringJobId}/hire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          freelancerId: freelancerUser.id,
          milestones: hiringMilestones.map(m => ({ title: m.title, amount: m.amount }))
        })
      });
      if (hireRes.status !== 200) {
        const err = await hireRes.json();
        alert(err.error || 'Hiring process database configuration failed');
        setActionLoading(false);
        return;
      }

      const { escrow } = await hireRes.json();
      addLiveLog('API', `Escrow DB Record #${escrow.id} created. Initializing contract deployment...`);

      // 3. Deploy/Create Escrow On-Chain using smart contract
      if (!publicClient) {
        alert('Web3 Provider not found. Confirm Metamask connected.');
        setActionLoading(false);
        return;
      }
      
      const budgetWei = parseEther(escrow.job.budget);
      const txHash = await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'createEscrow',
        args: [hiringFreelancerAddr as `0x${string}`, budgetWei],
      });

      addLiveLog('Web3', `Transaction broadcasted: ${txHash.substring(0, 10)}... waiting confirmations`);
      
      // Wait for receipt
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      
      // Parse EscrowCreated event to extract on-chain escrow ID
      let onchainId = null;
      for (const log of receipt.logs) {
        try {
          const event = decodeEventLog({
            abi: TRUSTPAY_ABI,
            eventName: 'EscrowCreated',
            data: log.data,
            topics: log.topics
          });
          onchainId = Number(event.args.escrowId);
          break;
        } catch (_) {}
      }

      if (onchainId === null) {
        throw new Error('Onchain Escrow ID not found in transaction receipt logs');
      }

      addLiveLog('Web3', `Escrow created on-chain. ID: ${onchainId}. Syncing database...`);

      // 4. Link On-Chain Escrow ID & TX Hash to DB Record
      const linkRes = await fetch(`${API_URL}/api/escrows/${escrow.id}/tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify({
          onchainId,
          txHash
        })
      });

      if (linkRes.status === 200) {
        addLiveLog('API', `Linked DB Escrow #${escrow.id} to on-chain ID ${onchainId}`);
        setSelectedEscrowId(escrow.id);
        fetchEscrowDetails(escrow.id);
        setHiringJobId(null);
        fetchJobs();
      } else {
        alert('Failed to sync on-chain ID with database backend.');
      }
    } catch (err: any) {
      console.error(err);
      alert(`Deployment failed: ${err.message || err.toString()}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Fund Escrow (Buyer Web3 transaction)
  const handleFundEscrow = async (escrow: Escrow) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      const budgetWei = parseEther(escrow.job.budget);
      const txHash = await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'fundEscrow',
        args: [BigInt(escrow.onchainId)],
        value: budgetWei,
      });
      addLiveLog('Web3', `Fund transaction submitted: ${txHash.substring(0, 10)}...`);
    } catch (err: any) {
      alert(`Funding failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Start Work (Freelancer Web3 transaction)
  const handleStartWork = async (escrow: Escrow) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'startWork',
        args: [BigInt(escrow.onchainId)],
      });
      addLiveLog('Web3', 'Submitted Start Work contract call');
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Submit Milestone (Freelancer Web3 transaction)
  const handleSubmitMilestone = async (escrow: Escrow) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'submitMilestone',
        args: [BigInt(escrow.onchainId)],
      });
      addLiveLog('Web3', 'Submitted milestone review request');
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Release Funds (Buyer Web3 transaction)
  const handleReleaseFunds = async (escrow: Escrow) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      const budgetWei = parseEther(escrow.job.budget);
      await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'releaseFunds',
        args: [BigInt(escrow.onchainId), budgetWei],
      });
      addLiveLog('Web3', 'Released escrow vault funds to freelancer');
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Reject submission (Buyer Web3 transaction)
  const handleRejectSubmission = async (escrow: Escrow) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'rejectSubmission',
        args: [BigInt(escrow.onchainId)],
      });
      addLiveLog('Web3', 'Rejected review submission, reverting to progress state');
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Raise Dispute (Buyer/Freelancer Web3 transaction)
  const handleRaiseDispute = async (escrow: Escrow) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'raiseDispute',
        args: [BigInt(escrow.onchainId)],
      });
      addLiveLog('Web3', 'Dispute dispute flagged on-chain');
    } catch (err: any) {
      alert(`Action failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Admin Dispute Resolution
  const handleResolveDispute = async (escrow: Escrow, toBuyer: boolean) => {
    if (escrow.onchainId === null) return;
    setActionLoading(true);
    try {
      const recipient = toBuyer ? escrow.buyer.walletAddress : escrow.freelancer.walletAddress;
      const budgetWei = parseEther(escrow.job.budget);
      await writeContractAsync({
        address: contractAddress as `0x${string}`,
        abi: TRUSTPAY_ABI,
        functionName: 'resolveDispute',
        args: [BigInt(escrow.onchainId), recipient as `0x${string}`, budgetWei],
      });
      addLiveLog('Web3', `Dispute resolved in favor of: ${toBuyer ? 'Buyer' : 'Freelancer'}`);
    } catch (err: any) {
      alert(`Dispute resolution failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  // Get color for reputation score
  const getReputationColor = (score: number) => {
    if (score >= 7.5) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
    if (score >= 4.5) return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
    return 'text-rose-400 bg-rose-500/10 border-rose-500/30';
  };

  const getReputationBarColor = (score: number) => {
    if (score >= 7.5) return 'bg-emerald-500';
    if (score >= 4.5) return 'bg-amber-500';
    return 'bg-rose-500';
  };

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-100 flex flex-col relative">
      {/* Background ambient glow effect */}
      <div className="absolute top-0 left-1/4 w-[500px] h-[500px] bg-purple-900/10 rounded-full blur-[120px] pointer-events-none animate-glow"></div>
      <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] bg-blue-900/10 rounded-full blur-[120px] pointer-events-none animate-glow"></div>

      {/* HEADER */}
      <header className="border-b border-slate-800/60 bg-[#090e1a]/80 backdrop-blur-md sticky top-0 z-50 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-violet-500/20">
            <Lock className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold font-display tracking-tight text-white flex items-center">
              TrustPay
              <span className="ml-2 text-xs font-semibold px-2 py-0.5 bg-violet-500/15 text-violet-400 border border-violet-500/30 rounded-full">v1.0 Beta</span>
            </h1>
            <p className="text-xs text-slate-400">Milestone-Based Escrow Protocol</p>
          </div>
        </div>

        <div className="flex items-center space-x-4">
          {/* Custom Web3 Contract address input */}
          <div className="hidden lg:flex items-center space-x-2 bg-slate-900/60 border border-slate-800/80 rounded-lg px-3 py-1.5 text-xs text-slate-300">
            <span className="text-slate-500 font-mono">Contract:</span>
            <input
              type="text"
              value={contractAddress}
              onChange={(e) => setContractAddress(e.target.value)}
              className="bg-transparent border-none outline-none font-mono w-40 text-slate-200 focus:ring-0 p-0 text-xs"
              placeholder="Deploy Address"
            />
          </div>

          <ConnectButton chainStatus="name" showBalance={false} />

          {isConnected && !authToken && (
            <button
              onClick={handleAuth}
              disabled={authLoading}
              className="px-4 py-2 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-sm font-semibold transition-all duration-300 shadow-md shadow-violet-600/20 hover:scale-[1.02]"
            >
              {authLoading ? 'Signing in...' : 'Sign In with Wallet'}
            </button>
          )}

          {authToken && (
            <div className="hidden sm:flex items-center space-x-1.5 px-3 py-1.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-lg text-xs font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
              <span>Secure Session</span>
            </div>
          )}
        </div>
      </header>

      {/* DASHBOARD LAYOUT */}
      <main className="flex-grow p-6 grid grid-cols-1 xl:grid-cols-12 gap-6 max-w-7xl mx-auto w-full z-10">
        
        {/* LEFT COLUMN: User Reputation, Job Board & Actions */}
        <div className="xl:col-span-7 flex flex-col space-y-6">
          
          {/* USER REPUTATION CARD */}
          {currentUser && (
            <div className="glass p-6 rounded-2xl relative overflow-hidden">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-3">
                  <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center border border-slate-700/50">
                    <User className="w-6 h-6 text-slate-300" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-100 font-display">Wallet Account</h3>
                    <p className="text-xs font-mono text-slate-400">
                      {address ? `${address.substring(0, 6)}...${address.substring(38)}` : ''}
                    </p>
                  </div>
                </div>

                <div className={`px-3 py-1.5 border rounded-lg text-xs font-semibold uppercase tracking-wider ${getReputationColor(currentUser.reputationScore)}`}>
                  Score: {currentUser.reputationScore.toFixed(1)} / 10
                </div>
              </div>

              {/* Reputation Rating progress bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Reputation Rating Score</span>
                  <span className="font-semibold text-slate-200">
                    {currentUser.reputationScore >= 7.5 ? '🏆 Top Tier Professional' : currentUser.reputationScore >= 4.5 ? '⭐ Verified Account' : '⚠️ Low Trust Rating'}
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-500 ${getReputationBarColor(currentUser.reputationScore)}`}
                    style={{ width: `${currentUser.reputationScore * 10}%` }}
                  ></div>
                </div>
              </div>
            </div>
          )}

          {/* CREATE JOB BOARD POST */}
          {authToken && (
            <div className="glass p-6 rounded-2xl">
              <div className="flex items-center space-x-2 mb-4">
                <Briefcase className="w-5 h-5 text-violet-400" />
                <h2 className="text-lg font-bold font-display text-white">Publish Escrow Contract Job</h2>
              </div>

              <form onSubmit={handleCreateJob} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Contract / Project Title</label>
                  <input
                    type="text"
                    required
                    value={newJobTitle}
                    onChange={(e) => setNewJobTitle(e.target.value)}
                    className="w-full bg-slate-900/50 border border-slate-800 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-slate-100 outline-none transition-all"
                    placeholder="e.g. Website development milestone contract"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Detailed Description</label>
                  <textarea
                    required
                    rows={3}
                    value={newJobDesc}
                    onChange={(e) => setNewJobDesc(e.target.value)}
                    className="w-full bg-slate-900/50 border border-slate-800 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-slate-100 outline-none transition-all resize-none"
                    placeholder="Provide description of expectations and milestones..."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Escrow Budget (ETH)</label>
                    <input
                      type="number"
                      step="0.001"
                      required
                      value={newJobBudget}
                      onChange={(e) => setNewJobBudget(e.target.value)}
                      className="w-full bg-slate-900/50 border border-slate-800 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-slate-100 outline-none transition-all"
                      placeholder="e.g. 0.05"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="submit"
                      disabled={actionLoading}
                      className="w-full h-[46px] bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-sm font-semibold transition-all duration-200 border border-slate-700 flex items-center justify-center space-x-2"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Post Job</span>
                    </button>
                  </div>
                </div>
              </form>
            </div>
          )}

          {/* ACTIVE HIRING MODAL FORM */}
          {hiringJobId !== null && (
            <div className="glass p-6 rounded-2xl border-violet-500/40 relative">
              <button
                onClick={() => setHiringJobId(null)}
                className="absolute top-4 right-4 text-slate-400 hover:text-slate-200 text-sm"
              >
                ✕ Close
              </button>
              <div className="flex items-center space-x-2 mb-4">
                <Trophy className="w-5 h-5 text-indigo-400" />
                <h2 className="text-lg font-bold font-display text-white">Hire Freelancer & Deploy Escrow</h2>
              </div>
              <p className="text-xs text-slate-400 mb-4">
                Hiring configuration for Job #{hiringJobId}. This initializes the Postgres configuration and deploys the escrow vault on-chain.
              </p>

              <form onSubmit={handleHireSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Freelancer Wallet Address</label>
                  <input
                    type="text"
                    required
                    value={hiringFreelancerAddr}
                    onChange={(e) => setHiringFreelancerAddr(e.target.value)}
                    className="w-full bg-slate-900/50 border border-slate-800 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-slate-100 outline-none transition-all font-mono"
                    placeholder="0x..."
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-medium text-slate-400">Escrow Milestones Setup</label>
                    <button
                      type="button"
                      onClick={() => setHiringMilestones([...hiringMilestones, { title: `Milestone ${hiringMilestones.length + 1}`, amount: '' }])}
                      className="text-xs text-violet-400 hover:underline"
                    >
                      + Add Milestone
                    </button>
                  </div>

                  {hiringMilestones.map((m, idx) => (
                    <div key={idx} className="flex gap-3">
                      <input
                        type="text"
                        required
                        value={m.title}
                        onChange={(e) => {
                          const newM = [...hiringMilestones];
                          newM[idx].title = e.target.value;
                          setHiringMilestones(newM);
                        }}
                        className="flex-grow bg-slate-900/50 border border-slate-800 focus:border-violet-500 rounded-xl px-3 py-2 text-xs text-slate-100 outline-none font-sans"
                        placeholder="Milestone Description"
                      />
                      <input
                        type="number"
                        step="0.001"
                        required
                        value={m.amount}
                        onChange={(e) => {
                          const newM = [...hiringMilestones];
                          newM[idx].amount = e.target.value;
                          setHiringMilestones(newM);
                        }}
                        className="w-24 bg-slate-900/50 border border-slate-800 focus:border-violet-500 rounded-xl px-3 py-2 text-xs text-slate-100 outline-none font-mono"
                        placeholder="ETH"
                      />
                      {hiringMilestones.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setHiringMilestones(hiringMilestones.filter((_, i) => i !== idx))}
                          className="text-rose-400 text-xs px-2 hover:text-rose-300"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                <button
                  type="submit"
                  disabled={actionLoading}
                  className="w-full py-3 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-sm font-semibold transition-all duration-300 flex items-center justify-center space-x-2"
                >
                  <Lock className="w-4 h-4" />
                  <span>Deploy & Launch Escrow</span>
                </button>
              </form>
            </div>
          )}

          {/* GLOBAL JOB BOARDS LIST */}
          <div className="glass p-6 rounded-2xl flex-grow">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2">
                <FileText className="w-5 h-5 text-indigo-400" />
                <h2 className="text-lg font-bold font-display text-white">Escrow Jobs Feed</h2>
              </div>
              <button onClick={fetchJobs} className="p-1 hover:bg-slate-800 rounded-lg text-slate-400 transition-colors">
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {loadingJobs ? (
              <div className="flex flex-col items-center justify-center py-10 space-y-2 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin text-violet-400" />
                <span className="text-xs">Loading jobs...</span>
              </div>
            ) : jobs.length === 0 ? (
              <div className="text-center py-10 text-slate-500 text-sm">
                No active escrow jobs found.
              </div>
            ) : (
              <div className="space-y-4">
                {jobs.map(job => (
                  <div key={job.id} className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/80 hover:border-slate-700/60 transition-all duration-200">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h4 className="font-bold text-white tracking-tight font-display">{job.title}</h4>
                        <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{job.description}</p>
                      </div>
                      <div className="text-right">
                        <span className="font-mono text-sm font-bold text-violet-400">{job.budget} ETH</span>
                        <div className="mt-1">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                            job.status === 'OPEN' ? 'text-sky-400 bg-sky-500/10 border-sky-500/20' :
                            job.status === 'ACTIVE' ? 'text-amber-400 bg-amber-500/10 border-amber-500/20' :
                            'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                          }`}>
                            {job.status}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-between items-center mt-4 pt-3 border-t border-slate-800/60 text-xs text-slate-400">
                      <div>
                        <span>Creator: </span>
                        <span className="font-mono text-slate-300">
                          {job.creator.walletAddress.substring(0, 6)}...{job.creator.walletAddress.substring(38)}
                        </span>
                      </div>

                      <div className="flex items-center space-x-2">
                        {/* If job is open and user is not creator */}
                        {authToken && job.status === 'OPEN' && currentUser && job.creatorId !== currentUser.id && !job.freelancerId && (
                          <button
                            onClick={() => handleApplyJob(job.id)}
                            className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-medium transition-colors border border-slate-700"
                          >
                            Apply for Job
                          </button>
                        )}

                        {/* If job is open and user is creator, show hire options */}
                        {authToken && job.status === 'OPEN' && currentUser && job.creatorId === currentUser.id && (
                          <button
                            onClick={() => {
                              setHiringJobId(job.id);
                              if (job.freelancer) {
                                setHiringFreelancerAddr(job.freelancer.walletAddress);
                              }
                            }}
                            className="px-3 py-1 bg-violet-600 hover:bg-violet-500 text-white rounded-lg font-medium transition-colors"
                          >
                            Hire & Set Escrow
                          </button>
                        )}

                        {/* Show link to escrow details if active */}
                        {job.status === 'ACTIVE' && (
                          <button
                            onClick={() => {
                              setSelectedEscrowId(job.id);
                              fetchEscrowDetails(job.id);
                            }}
                            className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg border border-slate-700 flex items-center space-x-1"
                          >
                            <span>View Escrow</span>
                            <ChevronRight className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN: Active Escrow Detail, Milestone Visuals, Logs */}
        <div className="xl:col-span-5 flex flex-col space-y-6">
          
          {/* ESCROW CONTROL & WORKFLOW */}
          <div className="glass p-6 rounded-2xl">
            <div className="flex items-center space-x-2 mb-4">
              <Shield className="w-5 h-5 text-violet-400" />
              <h2 className="text-lg font-bold font-display text-white">Escrow Payment Controller</h2>
            </div>

            {selectedEscrowId === null ? (
              <div className="text-center py-12 text-slate-500 text-sm">
                Select an active escrow from the feed to view state transition dashboard.
              </div>
            ) : !escrows[selectedEscrowId] ? (
              <div className="flex items-center justify-center py-10 space-y-2 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin text-indigo-400" />
                <span className="text-xs">Loading escrow details...</span>
              </div>
            ) : (() => {
              const esc = escrows[selectedEscrowId];
              const isBuyer = address?.toLowerCase() === esc.buyer.walletAddress.toLowerCase();
              const isFreelancer = address?.toLowerCase() === esc.freelancer.walletAddress.toLowerCase();
              const isAdmin = currentUser?.role === 'ADMIN';

              return (
                <div className="space-y-6">
                  {/* Escrow Brief details */}
                  <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-900 space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-slate-500">Escrow ID (On-Chain)</span>
                      <span className="font-mono text-slate-200 font-semibold">#{esc.onchainId ?? 'Pending'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Project / Job</span>
                      <span className="text-slate-200 font-semibold">{esc.job.title}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Escrow balance</span>
                      <span className="text-violet-400 font-bold font-mono">{esc.balance} ETH</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-slate-500">Freelancer Wallet</span>
                      <span className="font-mono text-slate-200">
                        {esc.freelancer.walletAddress.substring(0, 6)}...{esc.freelancer.walletAddress.substring(38)}
                      </span>
                    </div>
                    {esc.txHash && (
                      <div className="flex justify-between pt-1 border-t border-slate-900/60 mt-1">
                        <span className="text-slate-500">Tx Hash</span>
                        <a
                          href={`https://polygonscan.com/tx/${esc.txHash}`} // Fake or custom
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-violet-400 flex items-center hover:underline"
                        >
                          {esc.txHash.substring(0, 10)}...
                          <ExternalLink className="w-3 h-3 ml-1" />
                        </a>
                      </div>
                    )}
                  </div>

                  {/* VISUAL STATE PIPELINE */}
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-slate-400">Escrow State Timeline</label>
                    <div className="grid grid-cols-4 gap-1.5 text-center text-[10px] font-semibold text-slate-500">
                      <div className={`py-1.5 rounded-lg border ${
                        ['CREATED', 'FUNDED', 'IN_PROGRESS', 'SUBMITTED', 'RELEASED'].includes(esc.status) 
                          ? 'border-violet-500/30 text-violet-400 bg-violet-500/5 font-bold' 
                          : 'border-slate-800'
                      }`}>
                        Created
                      </div>
                      <div className={`py-1.5 rounded-lg border ${
                        ['FUNDED', 'IN_PROGRESS', 'SUBMITTED', 'RELEASED'].includes(esc.status) 
                          ? 'border-violet-500/30 text-violet-400 bg-violet-500/5 font-bold' 
                          : 'border-slate-800'
                      }`}>
                        Funded
                      </div>
                      <div className={`py-1.5 rounded-lg border ${
                        ['IN_PROGRESS', 'SUBMITTED', 'RELEASED'].includes(esc.status) 
                          ? 'border-violet-500/30 text-violet-400 bg-violet-500/5 font-bold' 
                          : 'border-slate-800'
                      }`}>
                        Progress
                      </div>
                      <div className={`py-1.5 rounded-lg border ${
                        esc.status === 'RELEASED' 
                          ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/5 font-bold' 
                          : esc.status === 'DISPUTED'
                          ? 'border-rose-500/30 text-rose-400 bg-rose-500/5 font-bold'
                          : esc.status === 'RESOLVED'
                          ? 'border-amber-500/30 text-amber-400 bg-amber-500/5 font-bold'
                          : 'border-slate-800'
                      }`}>
                        {esc.status === 'DISPUTED' ? 'Disputed' : esc.status === 'RESOLVED' ? 'Resolved' : 'Completed'}
                      </div>
                    </div>
                  </div>

                  {/* INTERACTIVE WORKFLOW ACTIONS */}
                  <div className="space-y-3 pt-3 border-t border-slate-800/40">
                    <label className="text-xs font-semibold text-slate-400 block mb-1">Available Transitions</label>
                    
                    <div className="flex flex-col space-y-2">
                      {/* 1. Buyer needs to fund */}
                      {esc.status === 'CREATED' && isBuyer && (
                        <button
                          onClick={() => handleFundEscrow(esc)}
                          disabled={actionLoading}
                          className="w-full py-2.5 bg-gradient-to-r from-violet-600 to-indigo-600 text-white rounded-xl text-xs font-bold hover:scale-[1.01] transition-transform flex items-center justify-center space-x-2"
                        >
                          <Coins className="w-4 h-4" />
                          <span>Fund Escrow Vault ({esc.job.budget} ETH)</span>
                        </button>
                      )}

                      {/* 2. Freelancer starts work */}
                      {esc.status === 'FUNDED' && isFreelancer && (
                        <button
                          onClick={() => handleStartWork(esc)}
                          disabled={actionLoading}
                          className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-all"
                        >
                          Start Work & Lock Contract
                        </button>
                      )}

                      {/* 3. Freelancer submits milestones */}
                      {esc.status === 'IN_PROGRESS' && isFreelancer && (
                        <button
                          onClick={() => handleSubmitMilestone(esc)}
                          disabled={actionLoading}
                          className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition-all"
                        >
                          Submit Work for Review
                        </button>
                      )}

                      {/* 4. Buyer releases or rejects */}
                      {esc.status === 'SUBMITTED' && isBuyer && (
                        <div className="grid grid-cols-2 gap-3">
                          <button
                            onClick={() => handleReleaseFunds(esc)}
                            disabled={actionLoading}
                            className="py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all"
                          >
                            Release Vault Funds
                          </button>
                          <button
                            onClick={() => handleRejectSubmission(esc)}
                            disabled={actionLoading}
                            className="py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold transition-all"
                          >
                            Reject Work
                          </button>
                        </div>
                      )}

                      {/* Dispute flagging */}
                      {['IN_PROGRESS', 'SUBMITTED'].includes(esc.status) && (isBuyer || isFreelancer) && (
                        <button
                          onClick={() => handleRaiseDispute(esc)}
                          disabled={actionLoading}
                          className="w-full py-2.5 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-xl text-xs font-bold transition-all flex items-center justify-center space-x-1.5"
                        >
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Flag Conflict / Raise Dispute</span>
                        </button>
                      )}

                      {/* ADMIN RESOLUTION PANEL */}
                      {esc.status === 'DISPUTED' && (
                        <div className="p-4 rounded-xl border border-rose-500/20 bg-rose-500/5 space-y-3">
                          <span className="text-[10px] font-bold tracking-wider uppercase text-rose-400 flex items-center">
                            <AlertTriangle className="w-3.5 h-3.5 mr-1" />
                            Arbitration Admin panel
                          </span>
                          <p className="text-[11px] text-slate-400">
                            As admin, resolve the dispute. Vault assets can be released to buyer or freelancer.
                          </p>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              onClick={() => handleResolveDispute(esc, true)}
                              disabled={actionLoading || !isAdmin}
                              className="py-2 bg-rose-600/20 hover:bg-rose-600/30 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-semibold"
                            >
                              Resolve to Buyer
                            </button>
                            <button
                              onClick={() => handleResolveDispute(esc, false)}
                              disabled={actionLoading || !isAdmin}
                              className="py-2 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 text-emerald-300 rounded-lg text-xs font-semibold"
                            >
                              Resolve to Freelancer
                            </button>
                          </div>
                          {!isAdmin && (
                            <p className="text-[10px] text-rose-400/60 text-center">
                              * Only TrustPay Admin account can trigger arbitration.
                            </p>
                          )}
                        </div>
                      )}

                      {/* Completed / resolved state banner */}
                      {['RELEASED', 'RESOLVED'].includes(esc.status) && (
                        <div className="p-4 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center space-x-2 text-xs font-semibold">
                          <CheckCircle2 className="w-4 h-4" />
                          <span>Escrow contract settled successfully</span>
                        </div>
                      )}

                      {/* Visual placeholder message if user has no role */}
                      {!isBuyer && !isFreelancer && !['RELEASED', 'RESOLVED'].includes(esc.status) && (
                        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-center text-xs text-slate-400">
                          Viewing mode active. No transitions available for your account.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* SYSTEM LOGS & AUDIT TRAIL STREAM */}
          <div className="glass p-6 rounded-2xl flex-grow">
            <div className="flex items-center space-x-2 mb-4">
              <Activity className="w-5 h-5 text-indigo-400 animate-pulse" />
              <h2 className="text-lg font-bold font-display text-white">Live On-Chain Audit Logs</h2>
            </div>

            <div className="h-60 overflow-y-auto pr-1 space-y-3 font-mono text-[11px]">
              {liveLogs.length === 0 ? (
                <div className="text-slate-600 flex items-center justify-center h-full">
                  Listening for blockchain transactions...
                </div>
              ) : (
                liveLogs.map(log => (
                  <div key={log.id} className="p-2.5 rounded-lg bg-slate-950/60 border border-slate-900/80 flex items-start space-x-2">
                    <span className="text-violet-400">[{log.time}]</span>
                    <div>
                      <p className="text-slate-300">{log.text}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

      </main>

      {/* FOOTER */}
      <footer className="mt-auto border-t border-slate-900 bg-[#060a12] px-6 py-6 text-center text-xs text-slate-500">
        <p>© 2026 TrustPay. High-trust decentralized milestone finance protocol.</p>
        <p className="mt-1">Built with React, Vite, Tailwind CSS, Solidity & Rust.</p>
      </footer>
    </div>
  );
}

export default App;
