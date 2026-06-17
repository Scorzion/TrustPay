// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract TrustPay is ReentrancyGuard {
    address public admin;

    enum State { Created, Funded, InProgress, Submitted, Released, Disputed, Resolved }

    struct Escrow {
        uint256 id;
        address payable buyer;
        address payable freelancer;
        uint256 totalBudget;
        uint256 balance;
        State state;
    }

    // escrowId => Escrow record
    mapping(uint256 => Escrow) public escrows;
    uint256 public nextEscrowId;

    event EscrowCreated(uint256 indexed escrowId, address indexed buyer, address indexed freelancer, uint256 totalBudget);
    event EscrowFunded(uint256 indexed escrowId, uint256 amount);
    event EscrowInProgress(uint256 indexed escrowId);
    event EscrowSubmitted(uint256 indexed escrowId);
    event FundsReleased(uint256 indexed escrowId, uint256 amount);
    event DisputeRaised(uint256 indexed escrowId, address indexed raisedBy);
    event DisputeResolved(uint256 indexed escrowId, address indexed recipient, uint256 amount);
    event Refunded(uint256 indexed escrowId, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin allowed");
        _;
    }

    modifier onlyBuyer(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].buyer, "Only buyer allowed");
        _;
    }

    modifier onlyFreelancer(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].freelancer, "Only freelancer allowed");
        _;
    }

    modifier onlyParticipants(uint256 escrowId) {
        require(msg.sender == escrows[escrowId].buyer || msg.sender == escrows[escrowId].freelancer, "Only participants allowed");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function createEscrow(address payable _freelancer, uint256 _totalBudget) external returns (uint256) {
        require(_freelancer != address(0), "Invalid freelancer address");
        require(_freelancer != msg.sender, "Buyer cannot be freelancer");
        require(_totalBudget > 0, "Budget must be greater than 0");

        uint256 escrowId = nextEscrowId++;
        escrows[escrowId] = Escrow({
            id: escrowId,
            buyer: payable(msg.sender),
            freelancer: _freelancer,
            totalBudget: _totalBudget,
            balance: 0,
            state: State.Created
        });

        emit EscrowCreated(escrowId, msg.sender, _freelancer, _totalBudget);
        return escrowId;
    }

    function fundEscrow(uint256 escrowId) external payable onlyBuyer(escrowId) nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.Created, "Escrow already funded or resolved");
        require(msg.value == escrow.totalBudget, "Incorrect funding amount");

        escrow.balance += msg.value;
        escrow.state = State.Funded;

        emit EscrowFunded(escrowId, msg.value);
    }

    function startWork(uint256 escrowId) external onlyFreelancer(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.Funded, "Escrow not funded yet");
        
        escrow.state = State.InProgress;
        emit EscrowInProgress(escrowId);
    }

    function submitMilestone(uint256 escrowId) external onlyFreelancer(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.InProgress, "Escrow not in progress");

        escrow.state = State.Submitted;
        emit EscrowSubmitted(escrowId);
    }

    function rejectSubmission(uint256 escrowId) external onlyBuyer(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.Submitted, "Escrow not submitted");

        escrow.state = State.InProgress;
        emit EscrowInProgress(escrowId);
    }

    function releaseFunds(uint256 escrowId, uint256 amount) external onlyBuyer(escrowId) nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.Submitted || escrow.state == State.InProgress, "Invalid state for release");
        require(amount > 0 && amount <= escrow.balance, "Invalid release amount");

        escrow.balance -= amount;
        
        if (escrow.balance == 0) {
            escrow.state = State.Released;
        }

        (bool success, ) = escrow.freelancer.call{value: amount}("");
        require(success, "Transfer failed");

        emit FundsReleased(escrowId, amount);
    }

    function raiseDispute(uint256 escrowId) external onlyParticipants(escrowId) {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.InProgress || escrow.state == State.Submitted, "Cannot dispute this escrow");

        escrow.state = State.Disputed;
        emit DisputeRaised(escrowId, msg.sender);
    }

    function resolveDispute(uint256 escrowId, address payable recipient, uint256 amount) external onlyAdmin() nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.Disputed, "Escrow not in dispute");
        require(recipient == escrow.buyer || recipient == escrow.freelancer, "Recipient must be participant");
        require(amount <= escrow.balance, "Amount exceeds balance");

        escrow.balance -= amount;
        uint256 remaining = escrow.balance;
        escrow.balance = 0;
        escrow.state = State.Resolved;

        // Transfer resolved amount to recipient
        if (amount > 0) {
            (bool success, ) = recipient.call{value: amount}("");
            require(success, "Recipient transfer failed");
        }

        // Return remaining funds to the buyer
        if (remaining > 0) {
            (bool success, ) = escrow.buyer.call{value: remaining}("");
            require(success, "Buyer refund transfer failed");
        }

        emit DisputeResolved(escrowId, recipient, amount);
    }

    function refund(uint256 escrowId, uint256 amount) external onlyFreelancer(escrowId) nonReentrant {
        Escrow storage escrow = escrows[escrowId];
        require(escrow.state == State.Funded || escrow.state == State.InProgress || escrow.state == State.Submitted, "Invalid state for refund");
        require(amount > 0 && amount <= escrow.balance, "Invalid refund amount");

        escrow.balance -= amount;
        
        if (escrow.balance == 0) {
            escrow.state = State.Resolved;
        }

        (bool success, ) = escrow.buyer.call{value: amount}("");
        require(success, "Transfer failed");

        emit Refunded(escrowId, amount);
    }
}
