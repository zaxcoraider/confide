"use client";

/**
 * Confide — the browser WRITE path.
 *
 * Every state-changing call in the app goes through here so that three rules
 * from Rules.md §4 are structural rather than remembered per call site:
 *
 *   1. SIMULATE FIRST. `simulateContract` runs the call against current state
 *      and reverts with the decoded custom error BEFORE MetaMask ever opens.
 *      A user who is not the admin learns that from a sentence, not from a
 *      failed transaction they paid for.
 *   2. NEVER SWALLOW. The decoded reason and the tx hash are both kept and
 *      surfaced; nothing here degrades to "something went wrong".
 *   3. `confirmations: 2` on the receipt. This is not caution — it is the
 *      primary fix for the sync race documented at the top of lib/nox.ts. A
 *      decrypt issued after a 1-confirmation receipt can hit an RPC node that
 *      has not imported the block and reports a permission error.
 */
import { useCallback, useMemo, useState } from "react";
import type { Abi } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { explainError } from "./format";

export type TxPhase =
  | "idle"
  | "simulating"
  | "signing"
  | "mining"
  | "done"
  | "error";

/** Honest, specific copy. Each phase names what is actually happening. */
export const TX_COPY: Record<TxPhase, string> = {
  idle: "",
  simulating: "Checking the call…",
  signing: "Confirm in your wallet…",
  mining: "Waiting for confirmations…",
  done: "",
  error: "",
};

export interface TxCall {
  address: `0x${string}`;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

export function useTx() {
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setHash(null);
    setError(null);
  }, []);

  const send = useCallback(
    async (call: TxCall): Promise<`0x${string}` | null> => {
      if (!walletClient || !publicClient) {
        setError("Connect a wallet on Ethereum Sepolia first.");
        setPhase("error");
        return null;
      }

      setPhase("simulating");
      setError(null);
      setHash(null);

      try {
        // The revert surfaces HERE, decoded, with the wallet still closed.
        const { request } = await publicClient.simulateContract({
          ...call,
          account: walletClient.account,
        } as never);

        setPhase("signing");
        const txHash = await walletClient.writeContract(request as never);
        setHash(txHash);

        setPhase("mining");
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 2,
        });
        if (receipt.status !== "success") {
          // Mined-and-reverted. Rare after a passing simulation, but it means
          // state moved underneath us — say exactly that.
          throw new Error(
            `${call.functionName} reverted on chain after simulating cleanly. ` +
              `State changed between the two.`,
          );
        }

        setPhase("done");
        return txHash;
      } catch (e) {
        setError(explainError(e));
        setPhase("error");
        return null;
      }
    },
    [walletClient, publicClient],
  );

  const busy = phase === "simulating" || phase === "signing" || phase === "mining";

  return useMemo(
    () => ({ send, reset, phase, hash, error, busy }),
    [send, reset, phase, hash, error, busy],
  );
}
