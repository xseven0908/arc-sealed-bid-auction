// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SealedBidAuction
/// @notice Commit-reveal sealed-bid auction settled in native USDC with O(1) finalization
/// and pull-payment claims (`claimRefund` / `claimProceeds`).
///
/// Why fixed-deposit commit-reveal + O(1) pull settlement:
/// 1. Fixed `depositCap` stops observers from inferring a bid's size from `msg.value` during
///    the commit window.
/// 2. O(1) `finalizeAuction` computes seller proceeds from `commitCount` and `revealedCount`
///    without looping over an unbounded `bidders[]` array, preventing block-gas exhaustion.
/// 3. Pull-based `claimRefund()` and `claimProceeds()` ensure a malicious bidder contract with
///    a reverting `receive()` cannot DoS the auction or lock other participants' funds.
///
/// Tie-breaking rule: strict inequality (`amount > a.highestBid`), so the earliest revealed
/// bid at the top price wins (first-reveal-wins on ties).
///
/// @dev DISCLAIMER / 免责声明: For personal testing, education, and Arc Testnet experimentation
/// only. Unaudited, provided "as is" without warranties of any kind. Do not use with real
/// mainnet assets. 仅供个人测试、教育与 Arc Testnet 实验使用，未经安全审计，不提供任何形式的保证。
contract SealedBidAuction {
    enum Phase {
        Commit,
        Reveal,
        Finalized,
        Cancelled
    }

    struct AuctionData {
        address seller;
        string item;
        uint256 depositCap;
        uint256 commitDeadline;
        uint256 revealDeadline;
        bool finalized;
        bool cancelled;
        bool proceedsClaimed;
        address highestBidder;
        uint256 highestBid;
        uint256 commitCount;
        uint256 revealedCount;
        uint256 sellerProceeds;
    }

    mapping(uint256 => AuctionData) private auctions;
    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public revealed;
    mapping(uint256 => mapping(address => uint256)) public revealedAmounts;
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    uint256 public auctionCount;

    uint256 private locked = 1;

    modifier nonReentrant() {
        require(locked == 1, "reentrancy locked");
        locked = 2;
        _;
        locked = 1;
    }

    event AuctionCreated(
        uint256 indexed id,
        address indexed seller,
        string item,
        uint256 depositCap,
        uint256 commitDeadline,
        uint256 revealDeadline
    );
    event BidCommitted(uint256 indexed id, address indexed bidder);
    event BidRevealed(
        uint256 indexed id,
        address indexed bidder,
        uint256 amount
    );
    event AuctionFinalized(
        uint256 indexed id,
        address indexed winner,
        uint256 winningBid,
        uint256 sellerProceeds
    );
    event AuctionCancelled(uint256 indexed id);
    event RefundClaimed(
        uint256 indexed id,
        address indexed bidder,
        uint256 amount
    );
    event ProceedsClaimed(
        uint256 indexed id,
        address indexed seller,
        uint256 amount
    );

    function createAuction(
        string calldata item,
        uint256 depositCap,
        uint256 commitWindow,
        uint256 revealWindow
    ) external returns (uint256 id) {
        require(bytes(item).length > 0, "item required");
        require(depositCap > 0, "depositCap must be > 0");
        require(
            commitWindow > 0 && revealWindow > 0,
            "windows must be > 0"
        );

        id = auctionCount++;
        AuctionData storage a = auctions[id];
        a.seller = msg.sender;
        a.item = item;
        a.depositCap = depositCap;
        a.commitDeadline = block.timestamp + commitWindow;
        a.revealDeadline = a.commitDeadline + revealWindow;

        emit AuctionCreated(
            id,
            msg.sender,
            item,
            depositCap,
            a.commitDeadline,
            a.revealDeadline
        );
    }

    /// @param commitHash keccak256(abi.encodePacked(amount, salt, msg.sender))
    function commitBid(uint256 id, bytes32 commitHash) external payable {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        require(!a.cancelled, "auction cancelled");
        require(block.timestamp < a.commitDeadline, "commit window closed");
        require(msg.value == a.depositCap, "deposit must equal depositCap");
        require(commitHash != bytes32(0), "empty commitment");
        require(
            commitments[id][msg.sender] == bytes32(0),
            "already committed"
        );

        commitments[id][msg.sender] = commitHash;
        a.commitCount += 1;

        emit BidCommitted(id, msg.sender);
    }

    function revealBid(uint256 id, uint256 amount, bytes32 salt) external {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        require(!a.cancelled, "auction cancelled");
        require(
            block.timestamp >= a.commitDeadline,
            "commit window still open"
        );
        require(block.timestamp < a.revealDeadline, "reveal window closed");
        require(
            commitments[id][msg.sender] != bytes32(0),
            "no commitment found"
        );
        require(!revealed[id][msg.sender], "already revealed");
        require(
            commitments[id][msg.sender] ==
                keccak256(abi.encodePacked(amount, salt, msg.sender)),
            "reveal does not match commitment"
        );
        require(amount > 0, "bid amount must be > 0");
        require(
            amount <= a.depositCap,
            "revealed amount exceeds depositCap"
        );

        revealed[id][msg.sender] = true;
        revealedAmounts[id][msg.sender] = amount;
        a.revealedCount += 1;

        // First-reveal-wins tie-breaking rule
        if (amount > a.highestBid) {
            a.highestBid = amount;
            a.highestBidder = msg.sender;
        }

        emit BidRevealed(id, msg.sender, amount);
    }

    /// @notice O(1) finalization callable by anyone after the reveal window closes.
    /// Computes seller proceeds from winning bid + no-show forfeited deposits without iterating
    /// over bidders. Winner, losing revealed bidders, and seller pull their funds independently.
    function finalizeAuction(uint256 id) external {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        require(!a.cancelled, "auction cancelled");
        require(
            block.timestamp >= a.revealDeadline,
            "reveal window still open"
        );
        require(!a.finalized, "already finalized");

        a.finalized = true;
        uint256 unrevealedCount = a.commitCount - a.revealedCount;
        uint256 forfeitedDeposits = unrevealedCount * a.depositCap;
        a.sellerProceeds = a.highestBid + forfeitedDeposits;

        emit AuctionFinalized(
            id,
            a.highestBidder,
            a.highestBid,
            a.sellerProceeds
        );
    }

    /// @notice Seller can cancel an auction only if zero bids have been committed.
    function cancelAuction(uint256 id) external {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        require(msg.sender == a.seller, "only seller can cancel");
        require(!a.finalized && !a.cancelled, "auction not active");
        require(a.commitCount == 0, "cannot cancel with committed bids");

        a.cancelled = true;
        emit AuctionCancelled(id);
    }

    /// @notice Revealed losing bidders claim their full depositCap; the winner claims their
    /// unused deposit (`depositCap - highestBid`). Unrevealed bidders forfeit their deposit.
    function claimRefund(
        uint256 id
    ) external nonReentrant returns (uint256 refundAmount) {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        require(a.finalized, "auction not finalized");
        require(revealed[id][msg.sender], "did not reveal bid");
        require(!refundClaimed[id][msg.sender], "refund already claimed");

        refundAmount = msg.sender == a.highestBidder
            ? a.depositCap - a.highestBid
            : a.depositCap;
        require(refundAmount > 0, "no refund due");

        refundClaimed[id][msg.sender] = true;
        emit RefundClaimed(id, msg.sender, refundAmount);

        (bool ok, ) = payable(msg.sender).call{value: refundAmount}("");
        require(ok, "refund transfer failed");
    }

    /// @notice Seller claims the winning bid plus any forfeited no-show deposits.
    function claimProceeds(
        uint256 id
    ) external nonReentrant returns (uint256 proceedsAmount) {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        require(a.finalized, "auction not finalized");
        require(msg.sender == a.seller, "only seller can claim proceeds");
        require(!a.proceedsClaimed, "proceeds already claimed");
        require(a.sellerProceeds > 0, "no proceeds to claim");

        proceedsAmount = a.sellerProceeds;
        a.proceedsClaimed = true;
        emit ProceedsClaimed(id, msg.sender, proceedsAmount);

        (bool ok, ) = payable(a.seller).call{value: proceedsAmount}("");
        require(ok, "proceeds transfer failed");
    }

    function claimableRefund(
        uint256 id,
        address bidder
    ) external view returns (uint256) {
        if (id >= auctionCount) return 0;
        AuctionData storage a = auctions[id];
        if (!a.finalized || !revealed[id][bidder] || refundClaimed[id][bidder]) {
            return 0;
        }
        return
            bidder == a.highestBidder
                ? a.depositCap - a.highestBid
                : a.depositCap;
    }

    function getAuction(
        uint256 id
    )
        external
        view
        returns (
            address seller,
            string memory item,
            uint256 depositCap,
            uint256 commitDeadline,
            uint256 revealDeadline,
            bool finalized,
            address highestBidder,
            uint256 highestBid,
            uint256 bidderCount
        )
    {
        require(id < auctionCount, "invalid auction id");
        AuctionData storage a = auctions[id];
        return (
            a.seller,
            a.item,
            a.depositCap,
            a.commitDeadline,
            a.revealDeadline,
            a.finalized,
            a.highestBidder,
            a.highestBid,
            a.commitCount
        );
    }
}
