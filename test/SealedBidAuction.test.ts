import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const COMMIT_WINDOW = 3600; // 1 hour
const REVEAL_WINDOW = 3600;

function commitHash(amount: bigint, salt: string, bidder: string) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "bytes32", "address"],
    [amount, salt, bidder],
  );
}

describe("SealedBidAuction (v0.2 O(1) Finalization & Pull Claims)", function () {
  async function deployAndCreate(depositCap = ethers.parseEther("1.0")) {
    const [seller, alice, bob, carol] = await ethers.getSigners();
    const Auction = await ethers.getContractFactory("SealedBidAuction");
    const auction = await Auction.deploy();

    await auction
      .connect(seller)
      .createAuction(
        "vintage watch",
        depositCap,
        COMMIT_WINDOW,
        REVEAL_WINDOW,
      );

    return { auction, seller, alice, bob, carol, depositCap };
  }

  it("runs a full auction: highest revealed bid wins, seller pulls proceeds, loser pulls full refund, winner pulls unused deposit", async function () {
    const { auction, seller, alice, bob, depositCap } =
      await deployAndCreate();

    const aliceAmount = ethers.parseEther("0.7");
    const aliceSalt = ethers.hexlify(ethers.randomBytes(32));
    const bobAmount = ethers.parseEther("0.4");
    const bobSalt = ethers.hexlify(ethers.randomBytes(32));

    await auction
      .connect(alice)
      .commitBid(0, commitHash(aliceAmount, aliceSalt, alice.address), {
        value: depositCap,
      });
    await auction
      .connect(bob)
      .commitBid(0, commitHash(bobAmount, bobSalt, bob.address), {
        value: depositCap,
      });

    await time.increase(COMMIT_WINDOW + 1);

    await expect(auction.connect(alice).revealBid(0, aliceAmount, aliceSalt))
      .to.emit(auction, "BidRevealed")
      .withArgs(0n, alice.address, aliceAmount);
    await auction.connect(bob).revealBid(0, bobAmount, bobSalt);

    await time.increase(REVEAL_WINDOW + 1);

    await expect(auction.finalizeAuction(0))
      .to.emit(auction, "AuctionFinalized")
      .withArgs(0n, alice.address, aliceAmount, aliceAmount);

    // Seller claims winning bid proceeds
    const sellerBefore = await ethers.provider.getBalance(seller.address);
    const sellerTx = await auction.connect(seller).claimProceeds(0);
    const sellerReceipt = await sellerTx.wait();
    const sellerGas = sellerReceipt!.gasUsed * sellerReceipt!.gasPrice;
    const sellerAfter = await ethers.provider.getBalance(seller.address);
    expect(sellerAfter - sellerBefore + sellerGas).to.equal(aliceAmount);

    // Bob (loser) claims full deposit refund
    const bobBefore = await ethers.provider.getBalance(bob.address);
    const bobTx = await auction.connect(bob).claimRefund(0);
    const bobReceipt = await bobTx.wait();
    const bobGas = bobReceipt!.gasUsed * bobReceipt!.gasPrice;
    const bobAfter = await ethers.provider.getBalance(bob.address);
    expect(bobAfter - bobBefore + bobGas).to.equal(depositCap);

    // Alice (winner) claims unused deposit (1.0 - 0.7 = 0.3 USDC)
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    const aliceTx = await auction.connect(alice).claimRefund(0);
    const aliceReceipt = await aliceTx.wait();
    const aliceGas = aliceReceipt!.gasUsed * aliceReceipt!.gasPrice;
    const aliceAfter = await ethers.provider.getBalance(alice.address);
    expect(aliceAfter - aliceBefore + aliceGas).to.equal(
      depositCap - aliceAmount,
    );

    // Contract balance is now 0 (full fund conservation)
    expect(
      await ethers.provider.getBalance(await auction.getAddress()),
    ).to.equal(0n);
  });

  it("forfeits the deposit of a bidder who never reveals and prevents them from claiming a refund", async function () {
    const { auction, seller, alice, bob, depositCap } =
      await deployAndCreate();
    const amount = ethers.parseEther("0.5");
    const salt = ethers.hexlify(ethers.randomBytes(32));

    await auction
      .connect(alice)
      .commitBid(0, commitHash(amount, salt, alice.address), {
        value: depositCap,
      });
    await auction
      .connect(bob)
      .commitBid(0, commitHash(amount, salt, bob.address), {
        value: depositCap,
      }); // Bob never reveals

    await time.increase(COMMIT_WINDOW + 1);
    await auction.connect(alice).revealBid(0, amount, salt);
    await time.increase(REVEAL_WINDOW + 1);

    await expect(auction.finalizeAuction(0))
      .to.emit(auction, "AuctionFinalized")
      .withArgs(0n, alice.address, amount, amount + depositCap);

    // Unrevealed bidder Bob cannot claim a refund
    await expect(auction.connect(bob).claimRefund(0)).to.be.revertedWith(
      "did not reveal bid",
    );

    // Seller claims Alice's winning bid + Bob's forfeited deposit
    const sellerBefore = await ethers.provider.getBalance(seller.address);
    const tx = await auction.connect(seller).claimProceeds(0);
    const receipt = await tx.wait();
    const gas = receipt!.gasUsed * receipt!.gasPrice;
    const sellerAfter = await ethers.provider.getBalance(seller.address);

    expect(sellerAfter - sellerBefore + gas).to.equal(amount + depositCap);
  });

  it("is immune to DoS from a malicious bidder contract that reverts in receive()", async function () {
    const { auction, seller, alice, depositCap } = await deployAndCreate();
    const MaliciousBidder =
      await ethers.getContractFactory("MaliciousBidder");
    const badBidder = await MaliciousBidder.deploy();
    const badAddr = await badBidder.getAddress();

    const aliceAmount = ethers.parseEther("0.8");
    const aliceSalt = ethers.hexlify(ethers.randomBytes(32));
    const badAmount = ethers.parseEther("0.5");
    const badSalt = ethers.hexlify(ethers.randomBytes(32));

    await auction
      .connect(alice)
      .commitBid(0, commitHash(aliceAmount, aliceSalt, alice.address), {
        value: depositCap,
      });
    await badBidder.commit(
      await auction.getAddress(),
      0,
      commitHash(badAmount, badSalt, badAddr),
      { value: depositCap },
    );

    await time.increase(COMMIT_WINDOW + 1);
    await auction.connect(alice).revealBid(0, aliceAmount, aliceSalt);
    await badBidder.reveal(await auction.getAddress(), 0, badAmount, badSalt);

    await time.increase(REVEAL_WINDOW + 1);

    // In v0.1, finalizeAuction looped and called .transfer() to badBidder, reverting the entire auction!
    // In v0.2, finalizeAuction is O(1) and succeeds regardless of badBidder's reverting receive().
    await expect(auction.finalizeAuction(0)).to.emit(
      auction,
      "AuctionFinalized",
    );

    // Seller and honest winner Alice can claim their funds normally
    await expect(auction.connect(seller).claimProceeds(0)).to.emit(
      auction,
      "ProceedsClaimed",
    );
    await expect(auction.connect(alice).claimRefund(0)).to.emit(
      auction,
      "RefundClaimed",
    );

    // badBidder's own claim fails while rejectReceive is true, hurting only itself
    await expect(
      badBidder.claim(await auction.getAddress(), 0),
    ).to.be.revertedWith("refund transfer failed");

    // If badBidder fixes its receive(), it can recover its refund
    await badBidder.setRejectReceive(false);
    await expect(badBidder.claim(await auction.getAddress(), 0)).to.emit(
      auction,
      "RefundClaimed",
    );
  });

  it("enforces first-reveal-wins tie-breaking when two bidders reveal identical amounts", async function () {
    const { auction, alice, bob, depositCap } = await deployAndCreate();
    const sameAmount = ethers.parseEther("0.6");
    const saltA = ethers.hexlify(ethers.randomBytes(32));
    const saltB = ethers.hexlify(ethers.randomBytes(32));

    await auction
      .connect(alice)
      .commitBid(0, commitHash(sameAmount, saltA, alice.address), {
        value: depositCap,
      });
    await auction
      .connect(bob)
      .commitBid(0, commitHash(sameAmount, saltB, bob.address), {
        value: depositCap,
      });

    await time.increase(COMMIT_WINDOW + 1);
    await auction.connect(alice).revealBid(0, sameAmount, saltA);
    await auction.connect(bob).revealBid(0, sameAmount, saltB);
    await time.increase(REVEAL_WINDOW + 1);

    await auction.finalizeAuction(0);
    const info = await auction.getAuction(0);
    expect(info.highestBidder).to.equal(alice.address);
    expect(await auction.claimableRefund(0, alice.address)).to.equal(
      depositCap - sameAmount,
    );
    expect(await auction.claimableRefund(0, bob.address)).to.equal(depositCap);
  });

  it("allows seller to cancel an auction only when zero bids have been committed", async function () {
    const { auction, seller, alice, depositCap } = await deployAndCreate();

    await expect(auction.connect(alice).cancelAuction(0)).to.be.revertedWith(
      "only seller can cancel",
    );
    await expect(auction.connect(seller).cancelAuction(0))
      .to.emit(auction, "AuctionCancelled")
      .withArgs(0n);

    await expect(
      auction
        .connect(alice)
        .commitBid(0, ethers.id("test"), { value: depositCap }),
    ).to.be.revertedWith("auction cancelled");
  });

  it("prevents double-claiming refunds or proceeds", async function () {
    const { auction, seller, alice, depositCap } = await deployAndCreate();
    const amount = ethers.parseEther("0.4");
    const salt = ethers.hexlify(ethers.randomBytes(32));

    await auction
      .connect(alice)
      .commitBid(0, commitHash(amount, salt, alice.address), {
        value: depositCap,
      });
    await time.increase(COMMIT_WINDOW + 1);
    await auction.connect(alice).revealBid(0, amount, salt);
    await time.increase(REVEAL_WINDOW + 1);
    await auction.finalizeAuction(0);

    await auction.connect(seller).claimProceeds(0);
    await expect(
      auction.connect(seller).claimProceeds(0),
    ).to.be.revertedWith("proceeds already claimed");

    await auction.connect(alice).claimRefund(0);
    await expect(auction.connect(alice).claimRefund(0)).to.be.revertedWith(
      "refund already claimed",
    );
  });

  it("rejects a commit after the commit window closes or with wrong deposit", async function () {
    const { auction, alice, depositCap } = await deployAndCreate();

    await expect(
      auction
        .connect(alice)
        .commitBid(0, ethers.id("bid"), { value: depositCap - 1n }),
    ).to.be.revertedWith("deposit must equal depositCap");

    await time.increase(COMMIT_WINDOW + 1);

    await expect(
      auction
        .connect(alice)
        .commitBid(0, ethers.id("bid"), { value: depositCap }),
    ).to.be.revertedWith("commit window closed");
  });

  it("rejects a reveal whose hash does not match the commitment", async function () {
    const { auction, alice, depositCap } = await deployAndCreate();
    const amount = ethers.parseEther("0.5");
    const salt = ethers.hexlify(ethers.randomBytes(32));

    await auction
      .connect(alice)
      .commitBid(0, commitHash(amount, salt, alice.address), {
        value: depositCap,
      });
    await time.increase(COMMIT_WINDOW + 1);

    await expect(
      auction.connect(alice).revealBid(0, amount + 1n, salt),
    ).to.be.revertedWith("reveal does not match commitment");
  });

  it("rejects finalizing before the reveal window closes or finalizing twice", async function () {
    const { auction } = await deployAndCreate();
    await time.increase(COMMIT_WINDOW + 1);

    await expect(auction.finalizeAuction(0)).to.be.revertedWith(
      "reveal window still open",
    );

    await time.increase(REVEAL_WINDOW + 1);
    await auction.finalizeAuction(0);
    await expect(auction.finalizeAuction(0)).to.be.revertedWith(
      "already finalized",
    );
  });
});
