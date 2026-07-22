/**
 * Confide — Phase 0.5 stop-gate.
 *
 * Phase 0 used a bare `Forwarder` as a stand-in for the Safe. This replaces the
 * stand-in with a REAL Safe (deployed via @safe-global/protocol-kit, not a fork
 * and not a hand-rolled multisig) and answers the three questions that lock the
 * custody decision:
 *
 *   Q4  A module enabled on a real Safe can drive it (execTransactionFromModule).
 *   Q5  The Nox proof escape hatch still works from inside a module.
 *   Q6  Both in ONE transaction — the exact shape PayrollModule needs.
 *
 * If Q6 passes, Option B (the Safe custodies funds) is viable and we take it.
 * If only Q4/Q5 pass, fall back to Option A (the module custodies funds).
 *
 * Run:  npm run phase05
 */
import { createWalletClient, createPublicClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import Safe from "@safe-global/protocol-kit";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

type Artifact = { abi: unknown[]; bytecode: `0x${string}` };
const artifact = (p: string): Artifact =>
  JSON.parse(readFileSync(resolve(p), "utf8")) as Artifact;

const ok    = (l: string) => console.log(`   ✓ ${l}`);
const fail  = (l: string) => console.log(`   ✗ ${l}`);
const note  = (l: string) => console.log(`   · ${l}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** See scripts/phase0.ts — the SDK's onchain precheck is not retried by the SDK. */
async function decryptWithRetry(
  handleClient: { publicDecrypt: (h: never) => Promise<{ value: unknown }> },
  handle: `0x${string}`,
  { timeoutMs = 90_000, intervalMs = 3_000 } = {},
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const { value } = await handleClient.publicDecrypt(handle as never);
      if (attempt > 1) note(`decrypt ready after ${attempt} attempts`);
      return value;
    } catch (e) {
      lastError = e as Error;
      const msg = lastError.message ?? "";
      const transient =
        /not publicly decryptable/i.test(msg) ||
        /does not exist/i.test(msg) ||
        /not yet computed/i.test(msg);
      if (!transient) throw lastError;
      await sleep(intervalMs);
    }
  }
  throw new Error(`publicDecrypt not ready after ${timeoutMs / 1000}s: ${lastError?.message}`);
}

async function main() {
  const privKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env.local");

  const account      = privateKeyToAccount(privKey as `0x${string}`);
  const transport    = http(RPC);
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  const publicClient = createPublicClient({ chain: sepolia, transport });

  console.log("Network:  Ethereum Sepolia (11155111)");
  console.log("Deployer:", account.address);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log("Balance: ", (Number(balance) / 1e18).toFixed(6), "ETH\n");

  const handleClient = await createViemHandleClient(walletClient);

  // 2 confirmations everywhere — see phase0.ts for why.
  const write = async (address: `0x${string}`, abi: unknown[], functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args } as never);
    return publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  };

  let q4 = false, q5 = false, q6 = false;

  // ── Deploy a real Safe ────────────────────────────────────────────────────
  console.log("Deploying a real Safe (1 owner, threshold 1)...");
  const predictedSafe = {
    safeAccountConfig: { owners: [account.address], threshold: 1 },
  };

  let protocolKit = await Safe.init({ provider: RPC, signer: privKey, predictedSafe });
  const safeAddress = (await protocolKit.getAddress()) as `0x${string}`;

  const alreadyDeployed = await publicClient.getCode({ address: safeAddress });
  if (alreadyDeployed && alreadyDeployed !== "0x") {
    note(`Safe already deployed at ${safeAddress} — reusing`);
  } else {
    const deployTx = await protocolKit.createSafeDeploymentTransaction();
    const hash = await walletClient.sendTransaction({
      to: deployTx.to as `0x${string}`,
      value: BigInt(deployTx.value),
      data: deployTx.data as `0x${string}`,
    });
    await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  }
  ok(`Safe: ${safeAddress}`);

  // Reconnect to the now-deployed Safe.
  protocolKit = await Safe.init({ provider: RPC, signer: privKey, safeAddress });
  const owners = await protocolKit.getOwners();
  const threshold = await protocolKit.getThreshold();
  ok(`owners=${owners.length} threshold=${threshold}  (unmodified Safe, not a fork)`);

  // ── Deploy PokeTarget + ModuleProbe ───────────────────────────────────────
  console.log("\nDeploying PokeTarget + ModuleProbe...");
  const probeArt  = artifact("./hardhat-artifacts/contracts/ModuleProbe.sol/ModuleProbe.json");
  const targetArt = artifact("./hardhat-artifacts/contracts/ModuleProbe.sol/PokeTarget.json");

  const targetHash = await walletClient.deployContract({ abi: targetArt.abi, bytecode: targetArt.bytecode, args: [] } as never);
  const targetAddr = (await publicClient.waitForTransactionReceipt({ hash: targetHash, confirmations: 2 })).contractAddress!;
  ok(`PokeTarget:  ${targetAddr}`);

  const probeHash = await walletClient.deployContract({ abi: probeArt.abi, bytecode: probeArt.bytecode, args: [safeAddress] } as never);
  const probeAddr = (await publicClient.waitForTransactionReceipt({ hash: probeHash, confirmations: 2 })).contractAddress!;
  ok(`ModuleProbe: ${probeAddr}`);

  // ── Enable the module on the Safe ─────────────────────────────────────────
  console.log("\nEnabling ModuleProbe as a Safe module...");
  if (await protocolKit.isModuleEnabled(probeAddr)) {
    note("module already enabled");
  } else {
    const enableTx = await protocolKit.createEnableModuleTx(probeAddr);
    const signed   = await protocolKit.signTransaction(enableTx);
    const res      = await protocolKit.executeTransaction(signed);
    await publicClient.waitForTransactionReceipt({ hash: res.hash as `0x${string}`, confirmations: 2 });
  }
  const enabled = await protocolKit.isModuleEnabled(probeAddr);
  if (!enabled) throw new Error("module enable failed — cannot continue");
  ok(`isModuleEnabled = ${enabled}`);

  const pokeData = encodeFunctionData({ abi: targetArt.abi, functionName: "poke", args: [] } as never);

  const readTarget = async (fn: "count" | "lastCaller") =>
    publicClient.readContract({ address: targetAddr, abi: targetArt.abi, functionName: fn } as never);

  // ── Q4 ── module drives the Safe ──────────────────────────────────────────
  console.log("\nQ4  Module drives a real Safe (execTransactionFromModule)");
  try {
    await write(probeAddr, probeArt.abi, "execFromSafe", [targetAddr, pokeData]);
    ok("ModuleProbe.execFromSafe() mined");

    const count      = (await readTarget("count")) as bigint;
    const lastCaller = (await readTarget("lastCaller")) as string;

    // The decisive check: the target must have been called BY THE SAFE.
    if (count === 1n && lastCaller.toLowerCase() === safeAddress.toLowerCase()) {
      ok(`PokeTarget.lastCaller == Safe  (count=${count})`);
      q4 = true;
    } else {
      fail(`lastCaller=${lastCaller} expected Safe ${safeAddress} (count=${count})`);
    }
  } catch (e) {
    fail((e as Error).message);
  }

  // ── Q5 ── proof validated from inside a module ────────────────────────────
  console.log("\nQ5  Nox proof escape hatch from inside a Safe module");
  try {
    const secret = 2024n;
    const { handle, handleProof } = await handleClient.encryptInput(secret, "uint256", probeAddr);
    ok(`encryptInput(${secret}) owned by EOA ${account.address.slice(0, 10)}...`);

    await write(probeAddr, probeArt.abi, "stageForOwner", [account.address, handle, handleProof]);
    ok("ModuleProbe.stageForOwner() mined");

    const storedHandle = (await publicClient.readContract({
      address: probeAddr, abi: probeArt.abi, functionName: "stored",
    } as never)) as `0x${string}`;

    const value = await decryptWithRetry(handleClient, storedHandle);
    if (BigInt(value as bigint) === secret) { ok(`publicDecrypt -> ${value}  (matches)`); q5 = true; }
    else fail(`publicDecrypt -> ${value}  (expected ${secret})`);
  } catch (e) {
    fail((e as Error).message);
  }

  // ── Q6 ── both in one transaction — the PayrollModule shape ───────────────
  console.log("\nQ6  Proof + Safe execution in ONE tx  (decides custody A vs B)");
  try {
    const secret = 555n;
    const { handle, handleProof } = await handleClient.encryptInput(secret, "uint256", probeAddr);
    ok(`encryptInput(${secret})`);

    await write(probeAddr, probeArt.abi, "stageAndExec", [
      account.address, handle, handleProof, targetAddr, pokeData,
    ]);
    ok("ModuleProbe.stageAndExec() mined");

    const count      = (await readTarget("count")) as bigint;
    const lastCaller = (await readTarget("lastCaller")) as string;
    const safeMoved  = count === 2n && lastCaller.toLowerCase() === safeAddress.toLowerCase();
    if (safeMoved) ok(`Safe executed again in the same tx  (count=${count})`);
    else fail(`Safe did not execute (count=${count}, lastCaller=${lastCaller})`);

    const storedHandle = (await publicClient.readContract({
      address: probeAddr, abi: probeArt.abi, functionName: "stored",
    } as never)) as `0x${string}`;

    const value = await decryptWithRetry(handleClient, storedHandle);
    const decrypted = BigInt(value as bigint) === secret;
    if (decrypted) ok(`publicDecrypt -> ${value}  (matches)`);
    else fail(`publicDecrypt -> ${value}  (expected ${secret})`);

    q6 = safeMoved && decrypted;
  } catch (e) {
    fail((e as Error).message);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log("\n── PHASE 0.5 VERDICT ────────────────────────────");
  console.log(`  Q4 module drives real Safe     ${q4 ? "PASS" : "FAIL"}`);
  console.log(`  Q5 proof from inside module    ${q5 ? "PASS" : "FAIL"}`);
  console.log(`  Q6 proof + exec in one tx      ${q6 ? "PASS" : "FAIL"}`);
  console.log("────────────────────────────────────────");
  if (q4 && q5 && q6) {
    console.log("  CUSTODY -> Option B viable: the Safe can hold the funds.");
    console.log("  The module validates the proof and moves Safe funds in one call.\n");
  } else if (q4 && q5) {
    console.log("  CUSTODY -> Option A: module custodies funds. Q6 failed.\n");
  } else {
    console.log("  STOP. The module path itself is broken — re-plan before Phase 1.\n");
  }

  console.log("Record in Memory.md:");
  console.log(`  Safe        ${safeAddress}`);
  console.log(`  ModuleProbe ${probeAddr}`);
  console.log(`  PokeTarget  ${targetAddr}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
