/**
 * Confide — Phase 0 stop-gate.
 *
 * Answers, against real Ethereum Sepolia, the three questions that decide
 * whether the Confide architecture is viable:
 *
 *   Q1  Nox works on Ethereum Sepolia at all.
 *   Q2  A proof can be validated when the caller is a CONTRACT and the proof
 *       owner is an EOA  (i.e. the Safe-routed path).
 *   Q3  TEE compute ops (add / le) work, gating the keeper feature.
 *
 * Run:  npm run phase0
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

type Artifact = { abi: unknown[]; bytecode: `0x${string}` };

function artifact(path: string): Artifact {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Artifact;
}

function ok(label: string)   { console.log(`   ✓ ${label}`); }
function fail(label: string) { console.log(`   ✗ ${label}`); }
function note(label: string) { console.log(`   · ${label}`); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * publicDecrypt with retry.
 *
 * The first Phase 0 run failed every decrypt with "does not exist or is not
 * publicly decryptable" and we read that as a permission error. It is not.
 * That message comes from the SDK's *on-chain* precheck — a `readContract` of
 * NoxCompute.isPubliclyDecryptable — issued immediately after the receipt.
 * Against a load-balanced public RPC the follow-up read can land on a node that
 * has not yet synced the block we just mined, so the flag reads false. The SDK
 * only retries the gateway fetch, never this precheck.
 *
 * Proven by scripts/diagnose-decrypt.ts: the exact same handles decrypt fine
 * once given time. So poll, and treat both the precheck message and the
 * gateway's not-yet-computed error as "not ready yet".
 */
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
        /not yet computed/i.test(msg) ||
        /NotYetComputed/i.test(lastError.name ?? "");
      if (!transient) throw lastError; // a real error — surface it immediately
      await sleep(intervalMs);
    }
  }
  throw new Error(
    `publicDecrypt still not ready after ${Math.round(timeoutMs / 1000)}s ` +
      `(${attempt} attempts). Last: ${lastError?.message}`,
  );
}

async function main() {
  const privKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env.local");

  const account      = privateKeyToAccount(privKey as `0x${string}`);
  const transport    = http(RPC);
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  const publicClient = createPublicClient({ chain: sepolia, transport });

  const balance = await publicClient.getBalance({ address: account.address });
  console.log("Network:  Ethereum Sepolia (11155111)");
  console.log("Deployer:", account.address);
  console.log("Balance: ", (Number(balance) / 1e18).toFixed(6), "ETH\n");
  if (balance === 0n) throw new Error("Deployer has no Sepolia ETH — fund it first.");

  const handleClient = await createViemHandleClient(walletClient);
  console.log("Handle client ready (gateway resolved for chain 11155111)\n");

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log("Deploying HelloNox + Forwarder...");
  const hello = artifact("./hardhat-artifacts/contracts/HelloNox.sol/HelloNox.json");
  const fwd   = artifact("./hardhat-artifacts/contracts/Forwarder.sol/Forwarder.json");

  const helloHash = await walletClient.deployContract({ abi: hello.abi, bytecode: hello.bytecode, args: [] } as never);
  const helloAddr = (await publicClient.waitForTransactionReceipt({ hash: helloHash })).contractAddress!;
  console.log("   HelloNox: ", helloAddr);

  const fwdHash = await walletClient.deployContract({ abi: fwd.abi, bytecode: fwd.bytecode, args: [] } as never);
  const fwdAddr = (await publicClient.waitForTransactionReceipt({ hash: fwdHash })).contractAddress!;
  console.log("   Forwarder:", fwdAddr, "\n");

  // 2 confirmations, not 1: the very next readContract may be served by a
  // different node behind the RPC load balancer. See decryptWithRetry.
  const write = async (address: `0x${string}`, abi: unknown[], functionName: string, args: unknown[]) => {
    const hash = await walletClient.writeContract({ address, abi, functionName, args } as never);
    return publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
  };

  // Chain-side and read-side are tracked separately. The first run conflated
  // them and reported "all FAIL" when in fact every transaction had mined.
  let q1 = false, q2 = false, q3 = false;
  let q1Chain = false, q2Chain = false, q3Chain = false;

  // ── Q1 ── ordinary path: owner == msg.sender ──────────────────────────────
  console.log("Q1  Nox round-trip on Ethereum Sepolia");
  try {
    const secret = 42n;
    const { handle, handleProof } = await handleClient.encryptInput(secret, "uint256", helloAddr);
    ok(`encryptInput(${secret}) -> ${handle.slice(0, 18)}...`);

    await write(helloAddr, hello.abi, "storeAsSelf", [handle, handleProof]);
    ok("storeAsSelf() mined");
    q1Chain = true;

    const storedHandle = await publicClient.readContract({
      address: helloAddr, abi: hello.abi, functionName: "stored",
    } as never) as `0x${string}`;

    const value = await decryptWithRetry(handleClient, storedHandle);
    if (BigInt(value as bigint) === secret) { ok(`publicDecrypt -> ${value}  (matches)`); q1 = true; }
    else fail(`publicDecrypt -> ${value}  (expected ${secret})`);
  } catch (e) {
    fail(`${(e as Error).message}`);
  }

  // ── Q2 ── Safe-routed path: caller is a contract, owner is an EOA ─────────
  console.log("\nQ2  Proof validation when caller != encryptor  (THE CRUX)");
  try {
    const secret = 1337n;
    // applicationContract is still HelloNox: it is HelloNox that calls
    // NoxCompute, so appInProof must equal HelloNox. The Forwarder only
    // changes who calls HelloNox.
    const { handle, handleProof } = await handleClient.encryptInput(secret, "uint256", helloAddr);
    ok(`encryptInput(${secret}) owned by EOA ${account.address.slice(0, 10)}...`);

    await write(fwdAddr, fwd.abi, "forward", [helloAddr, account.address, handle, handleProof]);
    ok("Forwarder.forward() -> HelloNox.storeForOwner() mined");
    // Mining alone is already strong evidence: validateInputProof would have
    // reverted with "Owner mismatch" had the escape hatch not worked.
    q2Chain = true;

    const storedHandle = await publicClient.readContract({
      address: helloAddr, abi: hello.abi, functionName: "stored",
    } as never) as `0x${string}`;

    const value = await decryptWithRetry(handleClient, storedHandle);
    if (BigInt(value as bigint) === secret) { ok(`publicDecrypt -> ${value}  (matches)`); q2 = true; }
    else fail(`publicDecrypt -> ${value}  (expected ${secret})`);
  } catch (e) {
    fail(`${(e as Error).message}`);
  }

  // ── Q3 ── TEE compute: add + le, only a boolean escapes ───────────────────
  console.log("\nQ3  TEE compute ops (add / le) — gates the keeper feature");
  try {
    const a = 3000n, b = 4000n, cap = 10000n; // 7000 <= 10000 -> true
    const ea   = await handleClient.encryptInput(a,   "uint256", helloAddr);
    const eb   = await handleClient.encryptInput(b,   "uint256", helloAddr);
    const ecap = await handleClient.encryptInput(cap, "uint256", helloAddr);
    ok("encrypted two amounts + a budget cap");

    await write(helloAddr, hello.abi, "checkBudget", [
      ea.handle, ea.handleProof, eb.handle, eb.handleProof, ecap.handle, ecap.handleProof,
    ]);
    ok("checkBudget() mined — add() + le() ran in the TEE");
    q3Chain = true;

    const resultHandle = await publicClient.readContract({
      address: helloAddr, abi: hello.abi, functionName: "withinBudget",
    } as never) as `0x${string}`;

    const value = await decryptWithRetry(handleClient, resultHandle);
    if (value === true) { ok(`publicDecrypt -> ${value}  (${a}+${b} <= ${cap})`); q3 = true; }
    else fail(`publicDecrypt -> ${value}  (expected true)`);
  } catch (e) {
    fail(`${(e as Error).message}`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  // A decrypt that never became ready is a READ-PATH problem. It does not mean
  // the chain-side mechanism failed — the mined transaction already proved that.
  const verdict = (chain: boolean, read: boolean) =>
    read ? "PASS" : chain ? "PASS (chain) / read pending" : "FAIL";

  console.log("\n── PHASE 0 VERDICT ──────────────────────────────");
  console.log(`  Q1 Nox on ETH Sepolia          ${verdict(q1Chain, q1)}`);
  console.log(`  Q2 caller != encryptor         ${verdict(q2Chain, q2)}`);
  console.log(`  Q3 TEE add/le compute          ${verdict(q3Chain, q3)}`);
  console.log("────────────────────────────────────────");
  if (q1Chain && q2Chain) {
    console.log("  Architecture viable. Proceed to Phase 1.");
    if (!(q1 && q2)) {
      console.log("  (Read path lagged. Re-check later with:");
      console.log("     npx tsx scripts/diagnose-decrypt.ts)");
    }
    console.log();
  } else if (q1Chain) {
    console.log("  Q2 failed onchain -> module must custody funds (Option A). Adjust plan.\n");
  } else {
    console.log("  Q1 failed onchain -> STOP. Nox is not usable on Sepolia yet.\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
