/**
 * Confide — clock-skew diagnostic for Nox user-decryption.
 *
 * `decrypt` fails with HTTP 401 "token is not active or expired". Retrying does
 * not help, because every attempt regenerates the EIP-712 authorization with
 * `notBefore = Math.floor(Date.now() / 1000)` — so a fast client is *always*
 * ahead of the gateway, no matter how long we wait.
 *
 * This isolates the variable: measure the skew, try a normal decrypt, then try
 * an identical decrypt with `Date.now` shifted backwards. If only the second
 * succeeds, clock skew is proven and the SDK's zero tolerance is the bug.
 *
 * Run:  npx tsx scripts/diagnose-clock.ts
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import { config } from "dotenv";

config({ path: ".env.local" });

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const GATEWAY = "https://gateway-testnets.noxprotocol.dev";

const CUSDC_ABI = [
  { name: "confidentialBalanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
] as const;

/** Skew in ms: positive means the local clock is AHEAD of the gateway. */
async function measureSkew(): Promise<number> {
  const before = Date.now();
  const res = await fetch(GATEWAY, { method: "HEAD" });
  const after = Date.now();
  const dateHeader = res.headers.get("date");
  if (!dateHeader) throw new Error("Gateway sent no Date header — cannot measure skew.");
  const serverMs = new Date(dateHeader).getTime();
  // Compare against the midpoint of the request window to net out latency.
  const localMid = (before + after) / 2;
  return localMid - serverMs;
}

async function main() {
  const privKey = process.env.DEPLOYER_PRIVATE_KEY;
  const cUSDC = process.env.NEXT_PUBLIC_CONFIDENTIAL_USDC as `0x${string}` | undefined;
  if (!privKey) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  if (!cUSDC) throw new Error("NEXT_PUBLIC_CONFIDENTIAL_USDC not set");

  const account      = privateKeyToAccount(privKey as `0x${string}`);
  const transport    = http(RPC);
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  const publicClient = createPublicClient({ chain: sepolia, transport });

  const skewMs = await measureSkew();
  console.log(`Clock skew: local is ${(skewMs / 1000).toFixed(1)}s ${skewMs >= 0 ? "AHEAD of" : "BEHIND"} the gateway`);
  console.log("  (Date header has 1s resolution, so treat this as approximate.)\n");

  const handleClient = await createViemHandleClient(walletClient);
  const handle = (await publicClient.readContract({
    address: cUSDC, abi: CUSDC_ABI, functionName: "confidentialBalanceOf", args: [account.address],
  })) as `0x${string}`;
  console.log("Balance handle:", handle, "\n");

  // ── Attempt 1: unmodified clock ───────────────────────────────────────────
  console.log("A. decrypt with the real system clock");
  let normalOk = false;
  try {
    const { value } = await handleClient.decrypt(handle as never);
    console.log(`   ✓ decrypted -> ${value}`);
    normalOk = true;
  } catch (e) {
    console.log(`   ✗ ${(e as Error).message}`);
  }

  // ── Attempt 2: clock shifted back ─────────────────────────────────────────
  // Shift by the measured skew plus a 120s safety margin, so `notBefore` lands
  // comfortably in the gateway's past while `expiresAt` (notBefore + 1h) stays
  // in its future.
  const shiftMs = Math.max(0, Math.round(skewMs)) + 120_000;
  console.log(`\nB. decrypt with Date.now() shifted back ${(shiftMs / 1000).toFixed(0)}s`);

  const realNow = Date.now;
  let shiftedOk = false;
  try {
    // Patch only for the duration of this call, then always restore in finally.
    Date.now = () => realNow.call(Date) - shiftMs;
    const { value } = await handleClient.decrypt(handle as never);
    console.log(`   ✓ decrypted -> ${value}`);
    shiftedOk = true;
  } catch (e) {
    console.log(`   ✗ ${(e as Error).message}`);
  } finally {
    Date.now = realNow;
  }

  console.log("\n── DIAGNOSIS ────────────────────────────────────");
  if (!normalOk && shiftedOk) {
    console.log("  CONFIRMED: clock skew. The SDK's notBefore has zero tolerance.");
    console.log("  Fix the system clock, or shift the clock at the call site.");
  } else if (normalOk) {
    console.log("  Decrypt works unmodified — skew is not the blocker.");
  } else {
    console.log("  Both attempts failed. Skew is NOT the (only) cause — look elsewhere.");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
