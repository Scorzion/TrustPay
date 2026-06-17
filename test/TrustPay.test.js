const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TrustPay Escrow Contract", function () {
  let TrustPay;
  let trustpay;
  let admin, buyer, freelancer, recipient, malicious;

  beforeEach(async function () {
    [admin, buyer, freelancer, recipient, malicious] = await ethers.getSigners();
    TrustPay = await ethers.getContractFactory("TrustPay");
    trustpay = await TrustPay.deploy();
  });

  describe("Deployment", function () {
    it("Should set the correct admin", async function () {
      expect(await trustpay.admin()).to.equal(admin.address);
    });
  });

  describe("Escrow Creation", function () {
    it("Should create an escrow with correct details", async function () {
      const budget = ethers.parseEther("1.0");
      
      await expect(trustpay.connect(buyer).createEscrow(freelancer.address, budget))
        .to.emit(trustpay, "EscrowCreated")
        .withArgs(0, buyer.address, freelancer.address, budget);

      const escrow = await trustpay.escrows(0);
      expect(escrow.buyer).to.equal(buyer.address);
      expect(escrow.freelancer).to.equal(freelancer.address);
      expect(escrow.totalBudget).to.equal(budget);
      expect(escrow.balance).to.equal(0n);
      expect(escrow.state).to.equal(0); // State.Created
    });

    it("Should revert if freelancer is address(0) or buyer", async function () {
      const budget = ethers.parseEther("1.0");
      await expect(trustpay.connect(buyer).createEscrow(ethers.ZeroAddress, budget))
        .to.be.revertedWith("Invalid freelancer address");

      await expect(trustpay.connect(buyer).createEscrow(buyer.address, budget))
        .to.be.revertedWith("Buyer cannot be freelancer");
    });
  });

  describe("Escrow Funding", function () {
    let escrowId;
    const budget = ethers.parseEther("2.0");

    beforeEach(async function () {
      const tx = await trustpay.connect(buyer).createEscrow(freelancer.address, budget);
      const receipt = await tx.wait();
      escrowId = 0; // First escrow created
    });

    it("Should fund the escrow successfully", async function () {
      await expect(trustpay.connect(buyer).fundEscrow(escrowId, { value: budget }))
        .to.emit(trustpay, "EscrowFunded")
        .withArgs(escrowId, budget);

      const escrow = await trustpay.escrows(escrowId);
      expect(escrow.balance).to.equal(budget);
      expect(escrow.state).to.equal(1); // State.Funded
    });

    it("Should revert if funded with incorrect amount", async function () {
      const incorrectAmount = ethers.parseEther("1.0");
      await expect(trustpay.connect(buyer).fundEscrow(escrowId, { value: incorrectAmount }))
        .to.be.revertedWith("Incorrect funding amount");
    });

    it("Should revert if non-buyer tries to fund", async function () {
      await expect(trustpay.connect(malicious).fundEscrow(escrowId, { value: budget }))
        .to.be.revertedWith("Only buyer allowed");
    });
  });

  describe("Escrow Work & Submission", function () {
    let escrowId;
    const budget = ethers.parseEther("1.0");

    beforeEach(async function () {
      await trustpay.connect(buyer).createEscrow(freelancer.address, budget);
      escrowId = 0;
      await trustpay.connect(buyer).fundEscrow(escrowId, { value: budget });
    });

    it("Should transition through startWork and submitMilestone", async function () {
      // Start work
      await expect(trustpay.connect(freelancer).startWork(escrowId))
        .to.emit(trustpay, "EscrowInProgress")
        .withArgs(escrowId);

      expect((await trustpay.escrows(escrowId)).state).to.equal(2); // State.InProgress

      // Submit milestone
      await expect(trustpay.connect(freelancer).submitMilestone(escrowId))
        .to.emit(trustpay, "EscrowSubmitted")
        .withArgs(escrowId);

      expect((await trustpay.escrows(escrowId)).state).to.equal(3); // State.Submitted
    });

    it("Should allow buyer to reject submission back to InProgress", async function () {
      await trustpay.connect(freelancer).startWork(escrowId);
      await trustpay.connect(freelancer).submitMilestone(escrowId);

      await expect(trustpay.connect(buyer).rejectSubmission(escrowId))
        .to.emit(trustpay, "EscrowInProgress")
        .withArgs(escrowId);

      expect((await trustpay.escrows(escrowId)).state).to.equal(2);
    });

    it("Should revert work start/submission if unauthorized", async function () {
      await expect(trustpay.connect(malicious).startWork(escrowId))
        .to.be.revertedWith("Only freelancer allowed");

      await expect(trustpay.connect(freelancer).submitMilestone(escrowId))
        .to.be.revertedWith("Escrow not in progress");
    });
  });

  describe("Releasing Funds & Refunds", function () {
    let escrowId;
    const budget = ethers.parseEther("1.0");

    beforeEach(async function () {
      await trustpay.connect(buyer).createEscrow(freelancer.address, budget);
      escrowId = 0;
      await trustpay.connect(buyer).fundEscrow(escrowId, { value: budget });
      await trustpay.connect(freelancer).startWork(escrowId);
      await trustpay.connect(freelancer).submitMilestone(escrowId);
    });

    it("Should release funds and transfer native assets", async function () {
      const freelancerBalanceBefore = await ethers.provider.getBalance(freelancer.address);

      await expect(trustpay.connect(buyer).releaseFunds(escrowId, budget))
        .to.emit(trustpay, "FundsReleased")
        .withArgs(escrowId, budget);

      const freelancerBalanceAfter = await ethers.provider.getBalance(freelancer.address);
      expect(freelancerBalanceAfter - freelancerBalanceBefore).to.equal(budget);

      const escrow = await trustpay.escrows(escrowId);
      expect(escrow.balance).to.equal(0n);
      expect(escrow.state).to.equal(4); // State.Released
    });

    it("Should refund buyer if freelancer triggers it", async function () {
      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

      await expect(trustpay.connect(freelancer).refund(escrowId, budget))
        .to.emit(trustpay, "Refunded")
        .withArgs(escrowId, budget);

      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(budget);

      const escrow = await trustpay.escrows(escrowId);
      expect(escrow.balance).to.equal(0n);
      expect(escrow.state).to.equal(6); // State.Resolved
    });
  });

  describe("Disputes & Resolution", function () {
    let escrowId;
    const budget = ethers.parseEther("1.0");

    beforeEach(async function () {
      await trustpay.connect(buyer).createEscrow(freelancer.address, budget);
      escrowId = 0;
      await trustpay.connect(buyer).fundEscrow(escrowId, { value: budget });
      await trustpay.connect(freelancer).startWork(escrowId);
    });

    it("Should raise dispute and block actions", async function () {
      await expect(trustpay.connect(buyer).raiseDispute(escrowId))
        .to.emit(trustpay, "DisputeRaised")
        .withArgs(escrowId, buyer.address);

      const escrow = await trustpay.escrows(escrowId);
      expect(escrow.state).to.equal(5); // State.Disputed
    });

    it("Should resolve dispute and partition funds correctly (admin)", async function () {
      await trustpay.connect(buyer).raiseDispute(escrowId);

      const freelancerShare = ethers.parseEther("0.4");
      const buyerShare = ethers.parseEther("0.6");

      const freelancerBalanceBefore = await ethers.provider.getBalance(freelancer.address);
      const buyerBalanceBefore = await ethers.provider.getBalance(buyer.address);

      // Resolve dispute, awarding 0.4 MATIC to freelancer and 0.6 MATIC back to buyer
      await expect(trustpay.connect(admin).resolveDispute(escrowId, freelancer.address, freelancerShare))
        .to.emit(trustpay, "DisputeResolved")
        .withArgs(escrowId, freelancer.address, freelancerShare);

      const freelancerBalanceAfter = await ethers.provider.getBalance(freelancer.address);
      const buyerBalanceAfter = await ethers.provider.getBalance(buyer.address);

      expect(freelancerBalanceAfter - freelancerBalanceBefore).to.equal(freelancerShare);
      expect(buyerBalanceAfter - buyerBalanceBefore).to.equal(buyerShare);

      const escrow = await trustpay.escrows(escrowId);
      expect(escrow.balance).to.equal(0n);
      expect(escrow.state).to.equal(6); // State.Resolved
    });

    it("Should revert if unauthorized tries to resolve dispute", async function () {
      await trustpay.connect(buyer).raiseDispute(escrowId);

      await expect(trustpay.connect(buyer).resolveDispute(escrowId, freelancer.address, budget))
        .to.be.revertedWith("Only admin allowed");
    });
  });
});
