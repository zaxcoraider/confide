/**
 * Confide — decrypt read-path diagnostic.
 *
 * Phase 0 mined every transaction but every publicDecrypt failed. The error
 * text ("not publicly decryptable") reads like a permission problem; Memory.md
 * hypothesised gateway latency. This script separates the layers against the
 * contracts deployed on 21 Jul, whose handles are now ~a day old — far past any
 * TEE or indexer lag. Whatever fails here fails for a structural reason.
 *
 *   L1  read stored / withinBudget handles from HelloNox
 *   L2  decode the handle header (chainId, teeType, unique bit)
 *   L3  NoxCompute.isPubliclyDecryptable(handle)   <- the SDK's precheck
 *   L4  handleClient.publicDecrypt(handle)         <- the gateway fetch
 *
 * Run:  npx tsx scripts/diagnose-decrypt.ts
 */
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";
import { config } from "dotenv";

config({ path: ".env.local" });

const RPC = process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";

const HELLO_NOX   = "0x21e1e963cd5b91a7a447da22ee2a47145c071c1f" as const;
const NOX_COMPUTE = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF" as const;

const HELLO_ABI = [
  { name: "stored",       inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
  { name: "withinBudget", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view", type: "function" },
] as const;

const NOX_ABI = [
  { name: "isPubliclyDecryptable", inputs: [{ name: "handle", type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view", type: "function" },
] as const;

/** Handle layout: [0]=version [1-4]=chainId [5]=teeType [6]=attrs [7-31]=digest */
function describeHandle(h: `0x${string}`) {
  const b = h.slice(2);
  const version = b.slice(0, 2);
  const chainId = parseInt(b.slice(2, 10), 16);
  const teeType = parseInt(b.slice(10, 12), 16);
  const attrs   = parseInt(b.slice(12, 14), 16);
  // HandleUtils.isPublicHandle: (handle[6] & ATTR_IS_UNIQUE_HANDLE) == 0
  const unique  = (attrs & 0x01) !== 0;
  return { version, chainId, teeType, attrs: `0x${attrs.toString(16).padStart(2, "0")}`, unique };
}

const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  const privKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privKey) throw new Error("DEPLOYER_PRIVATE_KEY not set in .env.local");

  const account      = privateKeyToAccount(privKey as `0x${string}`);
  const transport    = http(RPC);
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  const publicClient = createPublicClient({ chain: sepolia, transport });

  console.log("HelloNox:  ", HELLO_NOX);
  console.log("NoxCompute:", NOX_COMPUTE, "\n");

  const handleClient = await createViemHandleClient(walletClient);

  for (const fn of ["stored", "withinBudget"] as const) {
    console.log(`── ${fn} ${"─".repeat(50 - fn.length)}`);

    // L1 — read the handle back out of storage
    let handle: `0x${string}`;
    try {
      handle = (await publicClient.readContract({
        address: HELLO_NOX, abi: HELLO_ABI, functionName: fn,
      })) as `0x${string}`;
      console.log("  L1 handle:", handle);
    } catch (e) {
      console.log("  L1 FAILED:", (e as Error).message);
      continue;
    }

    if (handle === ZERO) {
      console.log("  L1 is the ZERO handle — nothing was ever stored here.\n");
      continue;
    }

    // L2 — decode the header
    const d = describeHandle(handle);
    console.log(`  L2 header: version=${d.version} chainId=${d.chainId} teeType=${d.teeType} attrs=${d.attrs} unique=${d.unique}`);
    if (!d.unique) {
      console.log("     ^ NOT unique => isPublicHandle() is true. allowPublicDecryption would have REVERTED.");
    }

    // L3 — the SDK's on-chain precheck, in isolation
    try {
      const flag = await publicClient.readContract({
        address: NOX_COMPUTE, abi: NOX_ABI, functionName: "isPubliclyDecryptable", args: [handle],
      });
      console.log(`  L3 isPubliclyDecryptable = ${flag}`);
      if (!flag) console.log("     ^ THIS is what the SDK error means. On-chain flag, not gateway lag.");
    } catch (e) {
      console.log("  L3 FAILED:", (e as Error).message);
    }

    // L4 — the actual gateway fetch (handles are ~a day old; no lag excuse)
    try {
      const { value, solidityType } = await handleClient.publicDecrypt(handle as never);
      console.log(`  L4 publicDecrypt -> ${value}  (${solidityType})`);
    } catch (e) {
      console.log("  L4 FAILED:", (e as Error).message);
      const cause = (e as Error).cause;
      if (cause) console.log("     cause:", cause);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
