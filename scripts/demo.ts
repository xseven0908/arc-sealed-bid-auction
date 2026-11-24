import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

const COMMIT_WINDOW_SECONDS = 30;
const REVEAL_WINDOW_SECONDS = 30;
const DEPOSIT_CAP = ethers.parseEther("0.02");
const BID_AMOUNT = ethers.parseEther("0.015");

function sleep(seconds: number) {
  console.log(`  waiting ${seconds}s...`);
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function main() {
  const auctionAddress = process.env.AUCTION_ADDRESS;
  if (!auctionAddress)
    throw new Error(
      "Set AUCTION_ADDRESS in .env after running `npm run deploy`.",
    );
  if (!process.env.BIDDER_PRIVATE_KEY)
    throw new Error("Set BIDDER_PRIVATE_KEY in .env for the demo bidder.");

  const [seller] = await ethers.getSigners();
  const bidder = new ethers.Wallet(
    process.env.BIDDER_PRIVATE_KEY,
    ethers.provider,
  );

  const auctionAsSeller = await ethers.getContractAt(
    "SealedBidAuction",
    auctionAddress,
    seller,
  );
  const auctionAsBidder = auctionAsSeller.connect(bidder);

  console.log(`Seller: ${seller.address}`);
  console.log(`Bidder: ${bidder.address}`);

  const id = await auctionAsSeller.auctionCount();
  console.log(`\n1. Creating auction #${id}...`);
  const createTx = await auctionAsSeller.createAuction(
    "starter-kit demo item",
    DEPOSIT_CAP,
    COMMIT_WINDOW_SECONDS,
    REVEAL_WINDOW_SECONDS,
  );
  await createTx.wait();
  console.log(`   tx: ${createTx.hash}`);

  const salt = ethers.hexlify(ethers.randomBytes(32));
  const hash = ethers.solidityPackedKeccak256(
    ["uint256", "bytes32", "address"],
    [BID_AMOUNT, salt, bidder.address],
  );

  console.log(
    `\n2. Bidder committing a sealed bid (real amount hidden on-chain)...`,
  );
  const commitTx = await auctionAsBidder.commitBid(id, hash, {
    value: DEPOSIT_CAP,
  });
  await commitTx.wait();
  console.log(`   tx: ${commitTx.hash}`);

  await sleep(COMMIT_WINDOW_SECONDS + 5);

  console.log(
    `\n3. Bidder revealing the real bid (${ethers.formatEther(BID_AMOUNT)} USDC)...`,
  );
  const revealTx = await auctionAsBidder.revealBid(id, BID_AMOUNT, salt);
  await revealTx.wait();
  console.log(`   tx: ${revealTx.hash}`);

  await sleep(REVEAL_WINDOW_SECONDS + 5);

  console.log(`\n4. Finalizing (O(1) state settlement)...`);
  const finalizeTx = await auctionAsSeller.finalizeAuction(id);
  await finalizeTx.wait();
  console.log(`   tx: ${finalizeTx.hash}`);

  console.log(`\n5. Seller claiming proceeds & Bidder claiming unused deposit...`);
  const proceedsTx = await auctionAsSeller.claimProceeds(id);
  await proceedsTx.wait();
  console.log(`   claimProceeds tx: ${proceedsTx.hash}`);

  const refundTx = await auctionAsBidder.claimRefund(id);
  await refundTx.wait();
  console.log(`   claimRefund tx: ${refundTx.hash}`);

  const info = await auctionAsSeller.getAuction(id);
  console.log(
    `\nResult: winner=${info.highestBidder}, winningBid=${ethers.formatEther(info.highestBid)} USDC`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
