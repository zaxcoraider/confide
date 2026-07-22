import type { HardhatUserConfig } from "hardhat/config.js";

const RPC     = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const PRIVKEY = process.env.DEPLOYER_PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.35", // required by nox-protocol-contracts@0.2.4 (pragma ^0.8.35)
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },

  networks: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sepolia: {
      type:     "http", // required at runtime in Hardhat v3 (types lag behind)
      url:      RPC,
      accounts: PRIVKEY ? [PRIVKEY] : [],
      chainId:  11155111,
    } as any,
  },

  paths: {
    sources:   "./contracts",
    artifacts: "./hardhat-artifacts",
    cache:     "./hardhat-cache",
  },
};

export default config;
