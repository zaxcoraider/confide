"use client";

/**
 * TEMPORARY de-risking page — delete before Phase 5.
 *
 * Exists to answer one question before any UI is designed: do the three
 * dependencies that have no business working in a browser actually work in a
 * browser?
 *
 *   1. @iexec-nox/handle      — encrypt/decrypt via the Nox gateway
 *   2. @safe-global/protocol-kit — Safe tx building against window.ethereum
 *   3. viem + wagmi reads     — the easy one
 *
 * If this page passes, the frontend plan is sound. If it does not, we find out
 * now rather than on 29 Jul.
 */
import { useState } from "react";
import { formatUnits } from "viem";
import { useAccount, useConnect, usePublicClient, useWalletClient } from "wagmi";
import { confidentialUsdcAbi, safeAbi } from "@/lib/abis";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/chain";
import { decryptWithRetry } from "@/lib/nox";

type Line = { label: string; state: "run" | "ok" | "fail"; detail?: string };

export default function SmokePage() {
  const { address, isConnected, connector } = useAccount();
  const { connect, connectors } = useConnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [lines, setLines] = useState<Line[]>([]);

  const push = (line: Line) => setLines((prev) => [...prev, line]);
  const settle = (label: string, state: "ok" | "fail", detail?: string) =>
    setLines((prev) =>
      prev.map((l) => (l.label === label && l.state === "run" ? { ...l, state, detail } : l)),
    );

  async function step(label: string, fn: () => Promise<string>) {
    push({ label, state: "run" });
    try {
      settle(label, "ok", await fn());
    } catch (error) {
      settle(label, "fail", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function run() {
    setLines([]);
    if (!publicClient || !walletClient || !address) return;

    try {
      await step("viem read: inferredTotalSupply()", async () => {
        const total = (await publicClient.readContract({
          address: ADDRESSES.confidentialUsdc,
          abi: confidentialUsdcAbi,
          functionName: "inferredTotalSupply",
        })) as bigint;
        return `${formatUnits(total, USDC_DECIMALS)} USDC backing the wrapper`;
      });

      await step("viem read: Safe threshold + module", async () => {
        const [threshold, enabled] = await Promise.all([
          publicClient.readContract({
            address: ADDRESSES.safe,
            abi: safeAbi,
            functionName: "getThreshold",
          }),
          publicClient.readContract({
            address: ADDRESSES.safe,
            abi: safeAbi,
            functionName: "isModuleEnabled",
            args: [ADDRESSES.payrollModule],
          }),
        ]);
        return `threshold ${threshold}, module enabled: ${enabled}`;
      });

      // The real question. Dynamic import so a bundling failure surfaces here
      // as a legible error instead of blanking the whole page.
      let handleClient: { encryptInput: Function; decrypt: Function };
      await step("import + init @iexec-nox/handle", async () => {
        const { createViemHandleClient } = await import("@iexec-nox/handle");
        handleClient = await createViemHandleClient(walletClient as never);
        return "handle client constructed against the connected wallet";
      });

      await step("encryptInput(1_000_000, uint256)", async () => {
        const enc = await handleClient.encryptInput(
          1_000_000n,
          "uint256",
          ADDRESSES.payrollModule,
        );
        return `handle ${String(enc.handle).slice(0, 18)}… proof ${
          String(enc.handleProof).length
        } chars`;
      });

      await step("decrypt own cUSDC balance", async () => {
        const handle = (await publicClient.readContract({
          address: ADDRESSES.confidentialUsdc,
          abi: confidentialUsdcAbi,
          functionName: "confidentialBalanceOf",
          args: [address],
        })) as `0x${string}`;

        if (handle === `0x${"0".repeat(64)}`) {
          return "no confidential balance yet (uninitialized handle) — decrypt skipped";
        }
        const value = (await decryptWithRetry(handleClient as never, handle, {
          onWait: (attempt, ms) =>
            settle(
              "decrypt own cUSDC balance",
              "ok",
              `waiting for the TEE — ${Math.round(ms / 1000)}s, attempt ${attempt}`,
            ),
        })) as bigint;
        return `${formatUnits(BigInt(value), USDC_DECIMALS)} cUSDC — DECRYPTED IN BROWSER`;
      });

      await step("import @safe-global/protocol-kit", async () => {
        const Safe = (await import("@safe-global/protocol-kit")).default;
        // NOT window.ethereum: this machine has a second wallet extension that
        // claims the global as a getter-only property, so MetaMask never sets
        // it (visible in the console as "encountered an error setting the
        // global Ethereum provider"). The connector's provider is the one the
        // user actually chose, resolved via EIP-6963.
        const provider = await connector!.getProvider();
        const kit = await Safe.init({
          provider: provider as never,
          signer: address,
          safeAddress: ADDRESSES.safe,
        });
        const owners = await kit.getOwners();
        return `protocol-kit initialized in browser; ${owners.length} owner(s)`;
      });
    } catch {
      // Already rendered by `step`. Stop at the first failure.
    }
  }

  return (
    <main style={{ padding: 32, fontFamily: "ui-monospace, monospace", maxWidth: 900 }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Confide — dependency smoke test</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>
        Temporary. Proves the Nox SDK and Safe kit work in a browser before the UI is built.
      </p>

      {!isConnected ? (
        <button
          onClick={() => connect({ connector: connectors[0]! })}
          style={{ padding: "10px 16px", cursor: "pointer" }}
        >
          Connect MetaMask
        </button>
      ) : (
        <>
          <p style={{ marginBottom: 16 }}>Connected: {address}</p>
          <button onClick={run} style={{ padding: "10px 16px", cursor: "pointer" }}>
            Run smoke test
          </button>
        </>
      )}

      <ul style={{ marginTop: 24, listStyle: "none", padding: 0, lineHeight: 1.7 }}>
        {lines.map((line, i) => (
          <li key={i}>
            {line.state === "run" ? "…" : line.state === "ok" ? "PASS" : "FAIL"} {line.label}
            {line.detail && (
              <div style={{ opacity: 0.65, paddingLeft: 24, whiteSpace: "pre-wrap" }}>
                {line.detail}
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
