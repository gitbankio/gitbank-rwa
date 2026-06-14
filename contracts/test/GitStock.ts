import { expect } from "chai";
import { ethers } from "hardhat";
import type { GitStockFactory, GitStockToken } from "../typechain-types";

describe("GitStock contracts", () => {
  let factory: GitStockFactory;
  let minter: ReturnType<typeof ethers.provider.getSigner> extends Promise<infer T> ? T : never;
  let deployer: ReturnType<typeof ethers.provider.getSigner> extends Promise<infer T> ? T : never;
  let user: ReturnType<typeof ethers.provider.getSigner> extends Promise<infer T> ? T : never;
  let minterAddr: string;
  let deployerAddr: string;
  let userAddr: string;

  before(async () => {
    [deployer, minter, user] = await ethers.getSigners() as any[];
    deployerAddr  = await (deployer as any).getAddress();
    minterAddr    = await (minter as any).getAddress();
    userAddr      = await (user as any).getAddress();

    const Factory = await ethers.getContractFactory("GitStockFactory");
    factory = (await Factory.connect(deployer as any).deploy(minterAddr, deployerAddr)) as GitStockFactory;
    await factory.waitForDeployment();
  });

  // ── GitStockFactory tests ─────────────────────────────────────────────────

  describe("GitStockFactory", () => {
    it("stores minter and deployer correctly", async () => {
      expect(await factory.minter()).to.equal(minterAddr);
      expect(await factory.deployer()).to.equal(deployerAddr);
    });

    it("deploys a GitStockToken for a ticker", async () => {
      const tx = await factory.connect(deployer as any).deployStock("NVDA", "Gitbank NVIDIA", "gitNVDA");
      await tx.wait();

      const addr = await factory.getStock("NVDA");
      expect(addr).to.not.equal(ethers.ZeroAddress);
    });

    it("tracks all deployed tickers", async () => {
      await (await factory.connect(deployer as any).deployStock("AAPL", "Gitbank Apple", "gitAAPL")).wait();
      const tickers = await factory.allTickers();
      expect(tickers).to.include("NVDA");
      expect(tickers).to.include("AAPL");
      expect(await factory.stockCount()).to.equal(2n);
    });

    it("reverts on duplicate ticker", async () => {
      await expect(
        factory.connect(deployer as any).deployStock("NVDA", "Dup", "dup"),
      ).to.be.revertedWith("GitStockFactory: ticker already exists");
    });

    it("reverts if non-deployer tries to add stock", async () => {
      await expect(
        factory.connect(user as any).deployStock("TSLA", "Tesla", "gitTSLA"),
      ).to.be.revertedWith("GitStockFactory: only deployer");
    });
  });

  // ── GitStockToken tests ───────────────────────────────────────────────────

  describe("GitStockToken", () => {
    let nvda: GitStockToken;

    before(async () => {
      const addr = await factory.getStock("NVDA");
      nvda = (await ethers.getContractAt("GitStockToken", addr)) as GitStockToken;
    });

    it("has correct metadata", async () => {
      expect(await nvda.name()).to.equal("Gitbank NVIDIA");
      expect(await nvda.symbol()).to.equal("gitNVDA");
      expect(await nvda.ticker()).to.equal("NVDA");
      expect(await nvda.decimals()).to.equal(9n);
      expect(await nvda.minter()).to.equal(minterAddr);
      expect(await nvda.factory()).to.equal(await factory.getAddress());
    });

    it("minter can mint tokens to user", async () => {
      const amount = 1_000_000_000n; // 1.0 gitNVDA (9 decimals)
      await (await nvda.connect(minter as any).mint(userAddr, amount)).wait();
      expect(await nvda.balanceOf(userAddr)).to.equal(amount);
    });

    it("minter can burn tokens from user", async () => {
      const burnAmt = 500_000_000n; // 0.5 gitNVDA
      await (await nvda.connect(minter as any).burn(userAddr, burnAmt)).wait();
      expect(await nvda.balanceOf(userAddr)).to.equal(500_000_000n);
    });

    it("non-minter cannot mint", async () => {
      await expect(
        nvda.connect(user as any).mint(userAddr, 1n),
      ).to.be.revertedWith("GitStockToken: only minter");
    });

    it("non-minter cannot burn", async () => {
      await expect(
        nvda.connect(user as any).burn(userAddr, 1n),
      ).to.be.revertedWith("GitStockToken: only minter");
    });

    it("transfer is permanently disabled (soul-bound)", async () => {
      await expect(
        nvda.connect(user as any).transfer(deployerAddr, 100n),
      ).to.be.revertedWith("gitStock: soul-bound, transfers disabled");
    });

    it("transferFrom is permanently disabled (soul-bound)", async () => {
      await expect(
        nvda.connect(user as any).transferFrom(userAddr, deployerAddr, 100n),
      ).to.be.revertedWith("gitStock: soul-bound, transfers disabled");
    });

    it("approve is permanently disabled (soul-bound)", async () => {
      await expect(
        nvda.connect(user as any).approve(deployerAddr, 100n),
      ).to.be.revertedWith("gitStock: soul-bound, approvals disabled");
    });
  });
});
