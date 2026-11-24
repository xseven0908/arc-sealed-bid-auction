// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISealedBidAuction {
    function commitBid(uint256 id, bytes32 commitHash) external payable;

    function revealBid(uint256 id, uint256 amount, bytes32 salt) external;

    function claimRefund(uint256 id) external returns (uint256);
}

/// @notice Simulates a malicious bidder contract that reverts in receive() to attempt a
/// denial-of-service attack against push-payment auction finalization.
contract MaliciousBidder {
    bool public rejectReceive = true;

    function setRejectReceive(bool reject) external {
        rejectReceive = reject;
    }

    function commit(
        address auction,
        uint256 id,
        bytes32 commitHash
    ) external payable {
        ISealedBidAuction(auction).commitBid{value: msg.value}(id, commitHash);
    }

    function reveal(
        address auction,
        uint256 id,
        uint256 amount,
        bytes32 salt
    ) external {
        ISealedBidAuction(auction).revealBid(id, amount, salt);
    }

    function claim(address auction, uint256 id) external returns (uint256) {
        return ISealedBidAuction(auction).claimRefund(id);
    }

    receive() external payable {
        require(!rejectReceive, "MaliciousBidder: receive reverted");
    }
}
