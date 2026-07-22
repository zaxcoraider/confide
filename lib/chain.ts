/**
 * Confide — chain configuration.
 *
 * Ethereum Sepolia (11155111) ONLY. Rules.md §1.1: if anything here ever names
 * another chain, it is a bug, not a feature.
 */
import { createConfig, http } from "wagmi";
import { sepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const CHAIN = sepolia;
export const CHAIN_ID = 11155111 as const;

function required(name: string, value: string | undefined): `0x${string}` {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill in the ` +
        `deployed addresses (see README).`,
    );
  }
  return value as `0x${string}`;
}

/**
 * Read at module scope so a missing address fails at startup with a clear
 * message, rather than as an undefined address deep inside a contract call.
 */
export const ADDRESSES = {
  confidentialUsdc: required(
    "NEXT_PUBLIC_CONFIDENTIAL_USDC",
    process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC,
  ),
  payrollModule: required(
    "NEXT_PUBLIC_PAYROLL_MODULE",
    process.env.NEXT_PUBLIC_PAYROLL_MODULE,
  ),
  safe: required("NEXT_PUBLIC_SAFE_ADDRESS", process.env.NEXT_PUBLIC_SAFE_ADDRESS),
  /** Circle's testnet USDC. Faucet: https://faucet.circle.com */
  usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as `0x${string}`,
} as const;

export const USDC_DECIMALS = 6;

export const RPC_URL =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

export const EXPLORER = "https://sepolia.etherscan.io";
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`;

export const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http(RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
