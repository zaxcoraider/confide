/**
 * Confide — Phase 1: ConfidentialUSDC.
 *
 * Deploys the ERC-7984 wrapper over REAL Circle USDC on Sepolia (Rules.md #7:
 * no mock data in the demo path) and proves the round trip that Phases.md
 * defines as done:
 *
 *   "a real wrap on Sepolia produces a balance that decrypts correctly"
 *
 * Checks, in order:
 *   1. deploy ConfidentialUSDC bound to Circle USDC
 *   2. approve + wrap a real amount
 *   3. the PUBLIC total (inferredTotalSupply) moved by exactly that amount
 *   4. the PRIVATE balance handle decrypts, for the holder only, to that amount
 *
 * Step 4 uses user-decryption (`decrypt`), not `publicDecrypt` — a wrapped
 * balance is deliberately readable by exactly one address.
 *
 * Run:  npm run phase1
 */
import { createWalletClient, createPublicClient, http, erc20Abi, formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { decryptWithRetry } from "../lib/nox.js";
import { SEPOLIA_USDC } from "./check-usdc.js";

config({ path: ".env.local" });

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

type Artifact = { abi: unknown[]; bytecode: `0x${string}` };
const artifact = (p: string): Artifact =>
  JSON.parse(readFileSync(resolve(p), "utf8")) as Artifact;

const ok   = (l: string) => console.log(`   ✓ ${l}`);
const fail = (l: string) => console.log(`   ✗ ${l}`);
const note = (l: string) => console.log(`   · ${l}`);

/**
 * How much to wrap per run. Kept small on purpose: Circle's faucet drips slowly
 * and Phase 2 needs USDC left over to fund the Safe.
 */
const PREFERRED_WRAP = parseUnits("5", 6); // 5 USDC

async function main() {
  const privKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env.local");

  const account      = privateKeyToAccount(privKey as `0x${string}`);
  const transport    = http(RPC);
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  const publicClient = createPublicClient({ chain: sepolia, transport });

  console.log("Network:  Ethereum Sepolia (11155111)");
  console.log("Deployer:", account.address);
  const ethBal = await publicClient.getBalance({ address: account.address });
  console.log("Balance: ", (Number(ethBal) / 1e18).toFixed(6), "ETH\n");

  // ── Preflight: do we actually hold USDC to wrap? ──────────────────────────
  const usdcBal = (await publicClient.readContract({
    address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address],
  })) as bigint;
  console.log("Underlying USDC:", SEPOLIA_USDC);
  console.log("  deployer holds:", formatUnits(usdcBal, 6), "USDC");

  if (usdcBal === 0n) {
    console.log("\n  ⚠ Deployer holds 0 USDC — cannot complete the wrap round trip.");
    console.log("    Get testnet USDC: https://faucet.circle.com (Ethereum Sepolia)");
    console.log("    The contract will still deploy; re-run this script once funded.\n");
  }
  const wrapAmount = usdcBal < PREFERRED_WRAP ? usdcBal : PREFERRED_WRAP;

  const handleClient = await createViemHandleClient(walletClient);

  // 2 confirmations — see lib/nox.ts for the sync-race rationale.
  const write = async (address: `0x${string}`, abi: unknown[], functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args } as never);
    return publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  };

  // ── Deploy (or reuse) ─────────────────────────────────────────────────────
  // Re-running this script is normal — the read path has several failure modes
  // worth iterating on — so don't burn gas redeploying. Set
  // NEXT_PUBLIC_CONFIDENTIAL_USDC in .env.local to reuse an existing wrapper.
  const art = artifact("./hardhat-artifacts/contracts/ConfidentialUSDC.sol/ConfidentialUSDC.json");
  const existing = process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC as `0x${string}` | undefined;

  let cUSDC: `0x${string}`;
  if (existing && existing.length === 42) {
    const code = await publicClient.getCode({ address: existing });
    if (!code || code === "0x") throw new Error(`No contract at NEXT_PUBLIC_CONFIDENTIAL_USDC=${existing}`);
    cUSDC = existing;
    note(`reusing ConfidentialUSDC at ${cUSDC}`);
  } else {
    console.log("\nDeploying ConfidentialUSDC...");
    const deployHash = await walletClient.deployContract({
      abi: art.abi, bytecode: art.bytecode, args: [SEPOLIA_USDC],
    } as never);
    cUSDC = (await publicClient.waitForTransactionReceipt({ hash: deployHash, confirmations: 2 })).contractAddress!;
    ok(`ConfidentialUSDC: ${cUSDC}`);
  }

  const read = (functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address: cUSDC, abi: art.abi, functionName, args } as never);

  const [name, symbol, decimals, underlying] = await Promise.all([
    read("name"), read("symbol"), read("decimals"), read("underlying"),
  ]);
  ok(`${name} (${symbol}), ${decimals} decimals`);

  if ((underlying as string).toLowerCase() !== SEPOLIA_USDC.toLowerCase()) {
    fail(`underlying is ${underlying}, expected ${SEPOLIA_USDC}`);
    process.exit(1);
  }
  ok("underlying bound to real Circle USDC");
  if (decimals !== 6) fail(`decimals ${decimals} — expected 6 inherited from USDC`);

  if (wrapAmount === 0n) {
    console.log("\n── PHASE 1 VERDICT ──────────────────────────────");
    console.log("  Deploy   PASS");
    console.log("  Wrap     BLOCKED — deployer holds no USDC");
    console.log("────────────────────────────────────────");
    console.log(`  Fund ${account.address} at https://faucet.circle.com`);
    console.log("  then re-run: npm run phase1\n");
    console.log(`NEXT_PUBLIC_CONFIDENTIAL_USDC=${cUSDC}`);
    return;
  }

  // ── Wrap ──────────────────────────────────────────────────────────────────
  console.log(`\nWrapping ${formatUnits(wrapAmount, 6)} USDC...`);
  const totalBefore = (await read("inferredTotalSupply")) as bigint;

  // Decrypt the prior balance so we can assert on the DELTA. On a fresh wrapper
  // the balance is uninitialized and reads as the zero handle, which has no
  // ciphertext to fetch — treat that as 0 rather than trying to decrypt it.
  const ZERO_HANDLE = "0x".padEnd(66, "0");
  const handleBefore = (await read("confidentialBalanceOf", [account.address])) as `0x${string}`;
  const balanceBefore =
    handleBefore === ZERO_HANDLE
      ? 0n
      : BigInt((await decryptWithRetry(handleClient, handleBefore, {
          onWait: (a, ms) => note(`prior balance not ready, attempt ${a} (${Math.round(ms / 1000)}s)`),
        })) as bigint);
  note(`balance before: ${formatUnits(balanceBefore, 6)} cUSDC`);

  await write(SEPOLIA_USDC, erc20Abi as unknown as unknown[], "approve", [cUSDC, wrapAmount]);
  ok("approve() mined");

  // NOTE: wrap(address to, uint256 amount) — NOT wrap(uint256) as Phases.md assumed.
  await write(cUSDC, art.abi, "wrap", [account.address, wrapAmount]);
  ok("wrap() mined");

  // ── The PUBLIC leg: total supply is an ordinary ERC-20 read ───────────────
  const totalAfter = (await read("inferredTotalSupply")) as bigint;
  const delta = totalAfter - totalBefore;
  if (delta === wrapAmount) {
    ok(`inferredTotalSupply ${formatUnits(totalBefore, 6)} -> ${formatUnits(totalAfter, 6)} (PUBLIC, +${formatUnits(delta, 6)})`);
  } else {
    fail(`total moved by ${formatUnits(delta, 6)}, expected ${formatUnits(wrapAmount, 6)}`);
  }

  // ── The PRIVATE leg: balance is an encrypted handle ───────────────────────
  const balanceHandle = (await read("confidentialBalanceOf", [account.address])) as `0x${string}`;
  ok(`confidentialBalanceOf -> ${balanceHandle.slice(0, 20)}...  (opaque onchain)`);

  const value = await decryptWithRetry(handleClient, balanceHandle, {
    onWait: (attempt, elapsed) => note(`TEE not ready, attempt ${attempt} (${Math.round(elapsed / 1000)}s)`),
  });

  const balanceAfter = BigInt(value as bigint);
  const credited = balanceAfter - balanceBefore;
  const decryptedOk = credited === wrapAmount;
  if (decryptedOk) {
    ok(`decrypt -> ${formatUnits(balanceAfter, 6)} cUSDC  (credited exactly +${formatUnits(credited, 6)})`);
  } else {
    fail(`decrypt -> ${formatUnits(balanceAfter, 6)}, credited ${formatUnits(credited, 6)}, expected +${formatUnits(wrapAmount, 6)}`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n── PHASE 1 VERDICT ──────────────────────────────");
  console.log(`  Deploy + bind real USDC        PASS`);
  console.log(`  Public total moves visibly     ${delta === wrapAmount ? "PASS" : "FAIL"}`);
  console.log(`  Private balance decrypts       ${decryptedOk ? "PASS" : "FAIL"}`);
  console.log("────────────────────────────────────────");
  if (delta === wrapAmount && decryptedOk) {
    console.log("  The privacy claim holds: total public, balance private.");
    console.log("  Proceed to Phase 2 (PayrollModule).\n");
  } else {
    console.log("  Phase 1 incomplete — do not start Phase 2.\n");
  }

  console.log("Record in Memory.md / .env.local:");
  console.log(`  NEXT_PUBLIC_CONFIDENTIAL_USDC=${cUSDC}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
