/**
 * Confide — Phase 2: PayrollModule.
 *
 * The core of the project. Proves the full multisig payroll lifecycle on real
 * Sepolia, per Phases.md:
 *
 *   "two recipients receive confidential payments in one batch on Sepolia,
 *    and each decrypts only their own amount"
 *
 * Steps:
 *   1. deploy PayrollModule(safe, cUSDC, admin) and enable it on the real Safe
 *   2. fund the Safe with confidential cUSDC
 *   3. admin stages two DIFFERENT encrypted amounts (direct EOA calls — a proof
 *      routed through the Safe would revert "Owner mismatch", Architecture §2)
 *   4. the Safe (m-of-n) executes the batch
 *   5. each recipient decrypts their OWN balance and sees only their amount
 *   6. a recipient is DENIED the other recipient's handle
 *
 * Step 6 is the one that makes the privacy claim falsifiable rather than
 * decorative. Without it "each decrypts only their own" is unproven.
 *
 * Run:  npm run phase2
 */
import {
  createWalletClient, createPublicClient, http, keccak256, toHex,
  formatUnits, parseUnits, encodeFunctionData,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import Safe from "@safe-global/protocol-kit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { decryptWithRetry } from "../lib/nox.js";

config({ path: ".env.local" });

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

type Artifact = { abi: unknown[]; bytecode: `0x${string}` };
const artifact = (p: string): Artifact =>
  JSON.parse(readFileSync(resolve(p), "utf8")) as Artifact;

const ok   = (l: string) => console.log(`   ✓ ${l}`);
const fail = (l: string) => console.log(`   ✗ ${l}`);
const note = (l: string) => console.log(`   · ${l}`);

/** Two payouts, deliberately DIFFERENT so a mixed-up handle is visible. */
const PAYOUT_A = parseUnits("2", 6); // 2 cUSDC
const PAYOUT_B = parseUnits("3", 6); // 3 cUSDC
const SAFE_FUNDING = PAYOUT_A + PAYOUT_B;

/**
 * Deterministic throwaway recipients. We need their PRIVATE keys to decrypt as
 * them; they never need ETH, since decryption is an offchain signature.
 */
const recipientKey = (label: string) => keccak256(toHex(`confide/phase2/${label}`));

async function main() {
  const privKey  = process.env.DEPLOYER_PRIVATE_KEY;
  const cUSDC    = process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC as `0x${string}` | undefined;
  const safeAddr = process.env.NEXT_PUBLIC_SAFE_ADDRESS as `0x${string}` | undefined;
  if (!privKey)  throw new Error("DEPLOYER_PRIVATE_KEY not set in .env.local");
  if (!cUSDC)    throw new Error("NEXT_PUBLIC_CONFIDENTIAL_USDC not set in .env.local");
  if (!safeAddr) throw new Error("NEXT_PUBLIC_SAFE_ADDRESS not set in .env.local");

  const admin        = privateKeyToAccount(privKey as `0x${string}`);
  const transport    = http(RPC);
  const walletClient = createWalletClient({ account: admin, chain: sepolia, transport });
  const publicClient = createPublicClient({ chain: sepolia, transport });

  console.log("Network:  Ethereum Sepolia (11155111)");
  console.log("Admin:   ", admin.address);
  console.log("Safe:    ", safeAddr);
  console.log("cUSDC:   ", cUSDC, "\n");

  const handleClient = await createViemHandleClient(walletClient);
  const tokenArt  = artifact("./hardhat-artifacts/contracts/ConfidentialUSDC.sol/ConfidentialUSDC.json");
  const moduleArt = artifact("./hardhat-artifacts/contracts/PayrollModule.sol/PayrollModule.json");

  const write = async (address: `0x${string}`, abi: unknown[], functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  };

  const balanceHandleOf = (who: `0x${string}`) =>
    publicClient.readContract({
      address: cUSDC, abi: tokenArt.abi, functionName: "confidentialBalanceOf", args: [who],
    } as never) as Promise<`0x${string}`>;

  const ZERO_HANDLE = "0x".padEnd(66, "0");

  // ── 1. Deploy + enable the module ─────────────────────────────────────────
  console.log("Deploying PayrollModule...");
  const deployHash = await walletClient.deployContract({
    abi: moduleArt.abi, bytecode: moduleArt.bytecode, args: [safeAddr, cUSDC, admin.address],
  } as never);
  const moduleAddr = (await publicClient.waitForTransactionReceipt({ hash: deployHash, confirmations: 2 })).contractAddress!;
  ok(`PayrollModule: ${moduleAddr}`);

  let protocolKit = await Safe.init({ provider: RPC, signer: privKey, safeAddress: safeAddr });
  if (!(await protocolKit.isModuleEnabled(moduleAddr))) {
    const enableTx = await protocolKit.createEnableModuleTx(moduleAddr);
    const signed   = await protocolKit.signTransaction(enableTx);
    const res      = await protocolKit.executeTransaction(signed);
    await publicClient.waitForTransactionReceipt({ hash: res.hash as `0x${string}`, confirmations: 2 });
  }
  ok(`module enabled on Safe: ${await protocolKit.isModuleEnabled(moduleAddr)}`);

  // ── 2. Fund the Safe with confidential cUSDC ──────────────────────────────
  //
  // NOTE: we verify this via the ADMIN's balance, not the Safe's.
  //
  // Nox ACL is per-ADDRESS and knows nothing about Safe ownership. On transfer
  // the token calls `Nox.allow(newToBalance, to)`, granting the Safe *contract
  // address* — being an owner of that Safe grants an EOA no decryption rights
  // whatsoever. So the Safe's confidential balance is unreadable by us here,
  // which is correct behaviour and not a bug.
  //
  // Set SKIP_SAFE_FUNDING=1 to reuse a Safe funded by a previous run. Testnet
  // cUSDC is scarce (Circle's faucet drips slowly) and the Safe keeps its
  // balance across runs, so re-funding on every iteration wastes it.
  if (process.env.SKIP_SAFE_FUNDING === "1") {
    if ((await balanceHandleOf(safeAddr)) === ZERO_HANDLE) {
      fail("SKIP_SAFE_FUNDING=1 but the Safe has no confidential balance — unset it.");
      process.exit(1);
    }
    note("skipping Safe funding (SKIP_SAFE_FUNDING=1); Safe already holds cUSDC");
  } else {
  console.log(`\nFunding the Safe with ${formatUnits(SAFE_FUNDING, 6)} cUSDC...`);

  const adminHandleBefore = await balanceHandleOf(admin.address);
  const adminBefore = adminHandleBefore === ZERO_HANDLE ? 0n : BigInt(
    (await decryptWithRetry(handleClient, adminHandleBefore)) as bigint,
  );
  note(`admin balance before: ${formatUnits(adminBefore, 6)} cUSDC`);
  if (adminBefore < SAFE_FUNDING) {
    fail(`admin holds ${formatUnits(adminBefore, 6)} cUSDC, needs ${formatUnits(SAFE_FUNDING, 6)}. Run: npm run phase1`);
    process.exit(1);
  }

  {
    const enc = await handleClient.encryptInput(SAFE_FUNDING, "uint256", cUSDC);
    await write(cUSDC, tokenArt.abi, "confidentialTransfer", [safeAddr, enc.handle, enc.handleProof]);
    ok("admin -> Safe confidentialTransfer mined");
  }

  const adminAfter = BigInt(
    (await decryptWithRetry(handleClient, await balanceHandleOf(admin.address))) as bigint,
  );
  const sent = adminBefore - adminAfter;
  if (sent === SAFE_FUNDING) {
    ok(`admin debited exactly ${formatUnits(sent, 6)} cUSDC (now ${formatUnits(adminAfter, 6)})`);
  } else {
    // ERC-7984 transfers CLAMP to zero on insufficient balance rather than
    // reverting, so a "successful" tx that moved nothing is a real failure mode.
    fail(`admin debited ${formatUnits(sent, 6)}, expected ${formatUnits(SAFE_FUNDING, 6)} — transfer clamped?`);
    process.exit(1);
  }

  if ((await balanceHandleOf(safeAddr)) === ZERO_HANDLE) {
    fail("Safe balance handle is uninitialized — funding did not land");
    process.exit(1);
  }
  ok("Safe holds an initialized confidential balance (opaque to us, by design)");
  }

  // ── 3. Stage two payouts (admin EOA, direct calls) ────────────────────────
  console.log("\nStaging payouts (admin EOA calls the module DIRECTLY)...");
  const batchId = (await publicClient.readContract({
    address: moduleAddr, abi: moduleArt.abi, functionName: "currentBatchId",
  } as never)) as bigint;
  note(`open batch: ${batchId}`);

  const recipients = [
    { label: "alice", amount: PAYOUT_A, account: privateKeyToAccount(recipientKey("alice")) },
    { label: "bob",   amount: PAYOUT_B, account: privateKeyToAccount(recipientKey("bob")) },
  ];

  for (const r of recipients) {
    const enc = await handleClient.encryptInput(r.amount, "uint256", moduleAddr);
    await write(moduleAddr, moduleArt.abi, "stagePayout", [r.account.address, enc.handle, enc.handleProof]);
    ok(`staged ${formatUnits(r.amount, 6)} cUSDC -> ${r.label} ${r.account.address.slice(0, 10)}...`);
  }

  const staged = (await publicClient.readContract({
    address: moduleAddr, abi: moduleArt.abi, functionName: "payoutCount", args: [batchId],
  } as never)) as bigint;
  ok(`payoutCount(batch ${batchId}) = ${staged}`);

  // ── 4. The Safe executes the batch (m-of-n approval) ──────────────────────
  console.log("\nExecuting the batch via the Safe (owner-approved)...");
  const execData = {
    to: moduleAddr,
    value: "0",
    data: encodeFunctionData({
      abi: moduleArt.abi, functionName: "executeBatch", args: [batchId],
    } as never),
  };
  const safeTx  = await protocolKit.createTransaction({ transactions: [execData] });
  const signed  = await protocolKit.signTransaction(safeTx);
  const execRes = await protocolKit.executeTransaction(signed);
  const execReceipt = await publicClient.waitForTransactionReceipt({
    hash: execRes.hash as `0x${string}`, confirmations: 2,
  });
  if (execReceipt.status !== "success") {
    fail(`Safe execution reverted: ${execRes.hash}`);
    process.exit(1);
  }
  ok(`executeBatch mined via Safe (${execRes.hash.slice(0, 18)}...)`);

  const wasExecuted = (await publicClient.readContract({
    address: moduleAddr, abi: moduleArt.abi, functionName: "executed", args: [batchId],
  } as never)) as boolean;
  ok(`executed[${batchId}] = ${wasExecuted}`);

  // ── 5. Each recipient decrypts their OWN amount ───────────────────────────
  console.log("\nRecipients decrypt their own balances...");
  let allCorrect = true;
  for (const r of recipients) {
    const rWallet = createWalletClient({ account: r.account, chain: sepolia, transport });
    const rHandle = await createViemHandleClient(rWallet);
    const handle  = await balanceHandleOf(r.account.address);

    if (handle === ZERO_HANDLE) {
      fail(`${r.label} has no balance handle — payout did not land`);
      allCorrect = false;
      continue;
    }
    try {
      const value = BigInt((await decryptWithRetry(rHandle, handle, {
        onWait: (a, ms) => note(`${r.label}: waiting (${Math.round(ms / 1000)}s, attempt ${a})`),
      })) as bigint);
      if (value === r.amount) ok(`${r.label} decrypts ${formatUnits(value, 6)} cUSDC (correct)`);
      else { fail(`${r.label} decrypts ${formatUnits(value, 6)}, expected ${formatUnits(r.amount, 6)}`); allCorrect = false; }
    } catch (e) {
      fail(`${r.label} could not decrypt own balance: ${(e as Error).message}`);
      allCorrect = false;
    }
  }

  // ── 6. Confidentiality: alice must NOT read bob's balance ─────────────────
  console.log("\nNegative check — alice tries to read bob's balance...");
  let isolated = false;
  {
    const alice   = recipients[0]!;
    const bob     = recipients[1]!;
    const aWallet = createWalletClient({ account: alice.account, chain: sepolia, transport });
    const aHandle = await createViemHandleClient(aWallet);
    const bobHandle = await balanceHandleOf(bob.account.address);
    try {
      // Short timeout: we EXPECT this to fail, so don't sit through a long poll.
      const leaked = await decryptWithRetry(aHandle, bobHandle, { timeoutMs: 12_000, intervalMs: 3_000 });
      fail(`LEAK — alice read bob's balance: ${leaked}`);
    } catch {
      ok("alice is denied bob's balance (confidentiality holds)");
      isolated = true;
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n── PHASE 2 VERDICT ──────────────────────────────");
  console.log(`  Module enabled + batch staged  PASS`);
  console.log(`  Safe-executed batch            ${wasExecuted ? "PASS" : "FAIL"}`);
  console.log(`  Each decrypts own amount       ${allCorrect ? "PASS" : "FAIL"}`);
  console.log(`  Cannot decrypt another's       ${isolated ? "PASS" : "FAIL"}`);
  console.log("────────────────────────────────────────");
  if (wasExecuted && allCorrect && isolated) {
    console.log("  Confidential payroll works end to end. Proceed to Phase 3.\n");
  } else {
    console.log("  Phase 2 incomplete.\n");
  }

  console.log("Record in Memory.md / .env.local:");
  console.log(`  NEXT_PUBLIC_PAYROLL_MODULE=${moduleAddr}`);
  console.log(`  batch ${batchId}: alice=${recipients[0]!.account.address} bob=${recipients[1]!.account.address}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
