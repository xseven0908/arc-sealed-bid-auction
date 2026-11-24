> [!CAUTION]
> **Disclaimer / 免责声明**
> This project is for personal testing, education, and Arc Testnet experimentation only. It is unaudited, not production-ready, provided "as is" with no warranties or guarantees of any kind, and interacts with real testnet funds. Do not use with real mainnet assets or rely on it for financial, business, or trust decisions. The author accepts no responsibility or liability for any loss or damage arising from its use.
> 本项目仅供个人测试、教育与 Arc Testnet 实验使用，未经安全审计，不适用于生产环境或真实资产，不提供任何形式的保证或承诺，且会与真实的测试网资金交互。因使用本项目而产生的任何直接或间接损失或损害，作者概不负责。

# Arc Sealed-Bid Auction (v0.2.0)

[![CI](https://github.com/xseven0908/arc-sealed-bid-auction/actions/workflows/ci.yml/badge.svg)](https://github.com/xseven0908/arc-sealed-bid-auction/actions/workflows/ci.yml)
[![Arc Testnet](https://img.shields.io/badge/network-Arc%20Testnet-6c5ce7)](https://docs.arc.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A commit-reveal sealed-bid auction settled in native USDC on [Arc Testnet](https://docs.arc.io), refactored in **v0.2.0** to use **O(1) finalization** and **pull-payment claims (`claimRefund` / `claimProceeds`)** so malicious bidder contracts or large participant counts can never DoS settlement.

## Why fixed-deposit commit-reveal + O(1) pull settlement?

### 1. Fixed `depositCap` prevents bid-amount leakage
Arc has a privacy feature on its roadmap — Arc Privacy Sector (APS) — which is not yet available on Testnet (*"Privacy features are on the roadmap and not yet available on Arc"* — `docs.arc.io/arc/concepts/opt-in-privacy`).
In a standard commit-reveal auction, if a bidder's `msg.value` deposit equals their actual bid, observers immediately learn the bid size during the commit window. Here, every bidder locks the same fixed `depositCap` during `commitBid`, so the deposit carries zero information about the real bid until `revealBid`.

### 2. O(1) Finalization + Pull Claims prevent Push-Payment DoS (v0.2 upgrade)
In naive auction implementations (including v0.1 of this repo), `finalizeAuction` loops over `bidders[]` and pushes refunds via `.transfer()`. That creates two critical vulnerabilities:
1. **Griefing / DoS by a reverting contract bidder**: A single smart contract bidder whose `receive()` reverts causes `finalizeAuction` to revert for everyone, permanently locking all funds.
2. **Unbounded loop gas exhaustion**: If enough bidders participate, iterating over `bidders[]` exceeds the block gas limit.

In **v0.2.0**:
- `finalizeAuction(id)` runs in **O(1) constant gas**: it computes `unrevealedCount = commitCount - revealedCount` and `sellerProceeds = highestBid + unrevealedCount * depositCap` without any loop or external transfer.
- `claimRefund(id)`: Losing revealed bidders pull their full `depositCap`; the winner pulls their unused deposit (`depositCap - highestBid`). Unrevealed bidders forfeit their deposit as a no-show penalty.
- `claimProceeds(id)`: The seller pulls `sellerProceeds` independently.
- **Explicit tie-breaking**: First revealed bid at the top price wins (`amount > highestBid`).
- **Seller cancellation**: `cancelAuction(id)` lets the seller cancel an auction if zero bids have been committed.

## Contract API (`contracts/SealedBidAuction.sol`)

- `createAuction(item, depositCap, commitWindow, revealWindow)` — seller opens an auction.
- `commitBid(id, commitHash)` — bidder locks `depositCap` in native USDC with `keccak256(abi.encodePacked(amount, salt, bidderAddress))`.
- `revealBid(id, amount, salt)` — bidder discloses their real bid (`0 < amount <= depositCap`); verified against their commitment.
- `finalizeAuction(id)` — O(1) settlement callable by anyone once `revealDeadline` passes.
- `claimRefund(id)` — pull-payment refund for revealed losing bidders and winner's unused deposit.
- `claimProceeds(id)` — pull-payment proceeds for the seller (winning bid + forfeited no-show deposits).
- `cancelAuction(id)` — seller cancels an auction when `commitCount == 0`.

## Setup & Usage

```bash
npm install
cp .env.example .env
```

Set `PRIVATE_KEY` (seller/deployer) and `BIDDER_PRIVATE_KEY` (a second wallet, for `scripts/demo.ts`) — both need testnet USDC for gas from the [Circle faucet](https://faucet.circle.com).

```bash
npm run compile
npm run typecheck
npm test              # 9 passing unit & security tests (including MaliciousBidder DoS test)
npm run deploy        # deploy to Arc Testnet, copy the address into .env as AUCTION_ADDRESS
npm run demo          # runs a full commit -> reveal -> finalize -> claim cycle live
```

## Verified on Arc Testnet

- All 9 local unit and security tests pass (happy path with pull claims, no-show deposit forfeiture, `MaliciousBidder` reverting-receiver DoS immunity, first-reveal-wins tie-breaking, zero-bid seller cancellation, double-claim rejection, and timing/hash validations).
- Live end-to-end Testnet deployment (v0.1 baseline):
  - Contract: [`0x6ebD4dBb45a124f2ff1B209C4Be186B5F4Eec334`](https://testnet.arcscan.app/address/0x6ebD4dBb45a124f2ff1B209C4Be186B5F4Eec334)
  - Full cycle: [createAuction](https://testnet.arcscan.app/tx/0x3dc0aae4f53e8bafd53f65003674d59b5dd911aabf8c7cd4c92c0509c07a66e8) → [commitBid](https://testnet.arcscan.app/tx/0x8b069f0651c8016442b76d4c4c38032f3a1f5983b17e1ad42260fe7cb75ad76a) → [revealBid](https://testnet.arcscan.app/tx/0x7fdc74eb300a4f5b42adc2534dd6d1da5dd9caada5547738156a905b1ef44c5d) → [finalizeAuction](https://testnet.arcscan.app/tx/0xb054820c42fd56c6531ffa2e25ae8eb5ac91dca84e682dc5ff1a99d88b87c6ce)
