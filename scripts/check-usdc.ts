/**
 * Confide — underlying-token sanity check.
 *
 * Rules.md #7 forbids mock data in the demo path, so ConfidentialUSDC must wrap
 * REAL Circle USDC on Sepolia. This confirms the address is right and reports
 * how much the deployer actually holds, since the demo needs a meaningful
 * balance and Circle's faucet drips slowly.
 *
 * Run:  npx tsx scripts/check-usdc.ts
 */
import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "dotenv";

config({ path: ".env.local" });

/** Circle's official USDC on Ethereum Sepolia. */
export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;

async function main() {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com"),
  });

  const code = await client.getCode({ address: SEPOLIA_USDC });
  console.log("USDC:", SEPOLIA_USDC);
  console.log("  contract exists:", !!code && code !== "0x");
  if (!code || code === "0x") throw new Error("No contract at that address — wrong USDC address.");

  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "decimals" }),
  ]);
  console.log(`  ${name} (${symbol}), ${decimals} decimals`);

  const privKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env.local");
  const me = privateKeyToAccount(privKey as `0x${string}`).address;

  const bal = (await client.readContract({
    address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [me],
  })) as bigint;

  console.log("\nDeployer:", me);
  console.log("  USDC balance:", formatUnits(bal, decimals as number), symbol);

  if (bal === 0n) {
    console.log("\n  ⚠ Zero USDC. Phase 1 needs some to wrap.");
    console.log("    Faucet: https://faucet.circle.com  (select Ethereum Sepolia)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
