import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const deployerKey = process.env["DEPLOYER_PRIVATE_KEY"];
const accounts = deployerKey ? [deployerKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.34",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    hardhat: {},
    "base-sepolia": {
      url: process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
      accounts,
      chainId: 84532,
    },
    base: {
      url: process.env["BASE_MAINNET_RPC_URL"] ?? "https://mainnet.base.org",
      accounts,
      chainId: 8453,
    },
  },
  etherscan: {
    apiKey: process.env["BASESCAN_API_KEY"] ?? "",
    customChains: [
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts-hardhat",
  },
};

export default config;
