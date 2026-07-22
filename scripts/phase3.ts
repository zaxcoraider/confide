/**
 * Confide — Phase 3: auditor disclosure.
 *
 * The credibility feature. Confidentiality that cannot be selectively lifted is
 * not a treasury product, so this proves the lift works and is *scoped*:
 *
 *   "auditor decrypts all; a third party is denied"   — Phases.md
 *
 * Runs a full lifecycle on a fresh module, then discloses:
 *   1. deploy PayrollModule + enable on the real Safe
 *   2. stage two DIFFERENT encrypted payouts, execute via the Safe
 *   3. BEFORE the grant  — auditor is denied both handles   (the control)
 *   4. Safe calls grantAuditor(auditor, batchId)
 *   5. AFTER the grant   — auditor decrypts BOTH amounts exactly
 *   6. a STRANGER is still denied both                      (the scope check)
 *
 * Step 3 matters as much as step 5: without a before-state, "the auditor can
 * decrypt" proves nothing about the grant having done anything.
 *
 * Run:  npm run phase3        (SKIP_SAFE_FUNDING=1 to reuse a funded Safe)
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

/** Kept small — the Safe's remaining cUSDC is scarce and unreadable to us. */
const PAYOUT_A = parseUnits("1", 6);
const PAYOUT_B = parseUnits("2", 6);

const derivedKey = (label: string) => keccak256(toHex(`confide/phase3/${label}`));

/** Expect a decrypt to FAIL. Short timeout — we are not waiting out a real poll. */
async function expectDenied(
  client: { publicDecrypt: (h: never) => Promise<{ value: unknown }>; decrypt: (h: never) => Promise<{ value: unknown }> },
  handle: `0x${string}`,
): Promise<boolean> {
  try {
    const leaked = await decryptWithRetry(client, handle, { timeoutMs: 10_000, intervalMs: 3_000 });
    fail(`LEAK — decrypted ${leaked}`);
    return false;
  } catch {
    return true;
  }
}

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
  console.log("Safe:    ", safeAddr, "\n");

  const handleClient = await createViemHandleClient(walletClient);
  const tokenArt  = artifact("./hardhat-artifacts/contracts/ConfidentialUSDC.sol/ConfidentialUSDC.json");
  const moduleArt = artifact("./hardhat-artifacts/contracts/PayrollModule.sol/PayrollModule.json");

  const write = async (address: `0x${string}`, abi: unknown[], functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args } as never);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return receipt;
  };

  const ZERO_HANDLE = "0x".padEnd(66, "0");
  const balanceHandleOf = (who: `0x${string}`) =>
    publicClient.readContract({
      address: cUSDC, abi: tokenArt.abi, functionName: "confidentialBalanceOf", args: [who],
    } as never) as Promise<`0x${string}`>;

  /** Run a transaction from the Safe itself (m-of-n approved). */
  const execViaSafe = async (kit: Safe, to: `0x${string}`, data: `0x${string}`) => {
    const tx     = await kit.createTransaction({ transactions: [{ to, value: "0", data }] });
    const signed = await kit.signTransaction(tx);
    const res    = await kit.executeTransaction(signed);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: res.hash as `0x${string}`, confirmations: 2,
    });
    if (receipt.status !== "success") throw new Error(`Safe execution reverted (${res.hash})`);
    return res.hash as `0x${string}`;
  };

  // ── 1. Deploy + enable ────────────────────────────────────────────────────
  console.log("Deploying PayrollModule (now with grantAuditor)...");
  const deployHash = await walletClient.deployContract({
    abi: moduleArt.abi, bytecode: moduleArt.bytecode, args: [safeAddr, cUSDC, admin.address],
  } as never);
  const moduleAddr = (await publicClient.waitForTransactionReceipt({ hash: deployHash, confirmations: 2 })).contractAddress!;
  ok(`PayrollModule: ${moduleAddr}`);

  const protocolKit = await Safe.init({ provider: RPC, signer: privKey, safeAddress: safeAddr });
  if (!(await protocolKit.isModuleEnabled(moduleAddr))) {
    const enableTx = await protocolKit.createEnableModuleTx(moduleAddr);
    const signed   = await protocolKit.signTransaction(enableTx);
    const res      = await protocolKit.executeTransaction(signed);
    await publicClient.waitForTransactionReceipt({ hash: res.hash as `0x${string}`, confirmations: 2 });
  }
  ok(`module enabled on Safe: ${await protocolKit.isModuleEnabled(moduleAddr)}`);

  if (process.env.SKIP_SAFE_FUNDING !== "1") {
    const total = PAYOUT_A + PAYOUT_B;
    console.log(`\nFunding the Safe with ${formatUnits(total, 6)} cUSDC...`);
    const enc = await handleClient.encryptInput(total, "uint256", cUSDC);
    await write(cUSDC, tokenArt.abi, "confidentialTransfer", [safeAddr, enc.handle, enc.handleProof]);
    ok("admin -> Safe confidentialTransfer mined");
  } else {
    note("skipping Safe funding (SKIP_SAFE_FUNDING=1)");
  }
  if ((await balanceHandleOf(safeAddr)) === ZERO_HANDLE) {
    fail("Safe has no confidential balance — cannot execute a batch.");
    process.exit(1);
  }

  // ── 2. Stage + execute ────────────────────────────────────────────────────
  console.log("\nStaging + executing a batch...");
  const batchId = (await publicClient.readContract({
    address: moduleAddr, abi: moduleArt.abi, functionName: "currentBatchId",
  } as never)) as bigint;

  const recipients = [
    { label: "alice", amount: PAYOUT_A, account: privateKeyToAccount(derivedKey("alice")) },
    { label: "bob",   amount: PAYOUT_B, account: privateKeyToAccount(derivedKey("bob")) },
  ];
  for (const r of recipients) {
    const enc = await handleClient.encryptInput(r.amount, "uint256", moduleAddr);
    await write(moduleAddr, moduleArt.abi, "stagePayout", [r.account.address, enc.handle, enc.handleProof]);
    ok(`staged ${formatUnits(r.amount, 6)} cUSDC -> ${r.label}`);
  }

  await execViaSafe(protocolKit, moduleAddr, encodeFunctionData({
    abi: moduleArt.abi, functionName: "executeBatch", args: [batchId],
  } as never));
  ok(`batch ${batchId} executed via Safe`);

  // The payout handles the auditor will read. Opaque to everyone right now.
  const payoutHandles: `0x${string}`[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const [, amount] = (await publicClient.readContract({
      address: moduleAddr, abi: moduleArt.abi, functionName: "payoutAt", args: [batchId, BigInt(i)],
    } as never)) as [string, `0x${string}`];
    payoutHandles.push(amount);
  }
  ok(`payout handles: ${payoutHandles.map((h) => h.slice(0, 12) + "...").join(", ")}`);

  // ── 3. Control: auditor denied BEFORE the grant ───────────────────────────
  const auditor  = privateKeyToAccount(derivedKey("auditor"));
  const stranger = privateKeyToAccount(derivedKey("stranger"));
  const clientFor = async (acct: typeof auditor) =>
    createViemHandleClient(createWalletClient({ account: acct, chain: sepolia, transport }));

  console.log("\nBEFORE the grant — auditor should be denied...");
  const auditorClient = await clientFor(auditor);
  let deniedBefore = true;
  for (let i = 0; i < payoutHandles.length; i++) {
    const denied = await expectDenied(auditorClient, payoutHandles[i]!);
    if (denied) ok(`auditor denied payout ${i} (as expected)`);
    else deniedBefore = false;
  }

  // ── 4. The Safe grants disclosure ─────────────────────────────────────────
  console.log("\nSafe grants the auditor disclosure over the batch...");
  await execViaSafe(protocolKit, moduleAddr, encodeFunctionData({
    abi: moduleArt.abi, functionName: "grantAuditor", args: [auditor.address, batchId],
  } as never));
  const recorded = (await publicClient.readContract({
    address: moduleAddr, abi: moduleArt.abi, functionName: "isAuditor", args: [batchId, auditor.address],
  } as never)) as boolean;
  ok(`grantAuditor mined; isAuditor[${batchId}][auditor] = ${recorded}`);

  // ── 5. Auditor decrypts EVERY amount ──────────────────────────────────────
  console.log("\nAFTER the grant — auditor decrypts the whole batch...");
  let auditorSeesAll = true;
  for (let i = 0; i < payoutHandles.length; i++) {
    const expected = recipients[i]!.amount;
    try {
      const value = BigInt((await decryptWithRetry(auditorClient, payoutHandles[i]!, {
        onWait: (a, ms) => note(`auditor waiting (${Math.round(ms / 1000)}s, attempt ${a})`),
      })) as bigint);
      if (value === expected) ok(`auditor reads payout ${i} = ${formatUnits(value, 6)} cUSDC (${recipients[i]!.label}, correct)`);
      else { fail(`auditor reads ${formatUnits(value, 6)}, expected ${formatUnits(expected, 6)}`); auditorSeesAll = false; }
    } catch (e) {
      fail(`auditor could not decrypt payout ${i}: ${(e as Error).message}`);
      auditorSeesAll = false;
    }
  }

  // ── 6. Scope: a stranger is still denied ──────────────────────────────────
  console.log("\nScope check — an unrelated address must still be denied...");
  const strangerClient = await clientFor(stranger);
  let strangerDenied = true;
  for (let i = 0; i < payoutHandles.length; i++) {
    const denied = await expectDenied(strangerClient, payoutHandles[i]!);
    if (denied) ok(`stranger denied payout ${i}`);
    else strangerDenied = false;
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n── PHASE 3 VERDICT ──────────────────────────────");
  console.log(`  Auditor denied before grant    ${deniedBefore ? "PASS" : "FAIL"}`);
  console.log(`  Auditor decrypts all after     ${auditorSeesAll ? "PASS" : "FAIL"}`);
  console.log(`  Stranger still denied          ${strangerDenied ? "PASS" : "FAIL"}`);
  console.log("────────────────────────────────────────");
  if (deniedBefore && auditorSeesAll && strangerDenied) {
    console.log("  Selective disclosure works and is SCOPED. Confidential, not opaque.\n");
  } else {
    console.log("  Phase 3 incomplete.\n");
  }

  console.log("Record in Memory.md / .env.local:");
  console.log(`  NEXT_PUBLIC_PAYROLL_MODULE=${moduleAddr}`);
  console.log(`  batch ${batchId} — auditor ${auditor.address}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
