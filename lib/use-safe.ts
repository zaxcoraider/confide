"use client";

/**
 * Confide — executing a call AS the Safe, from the browser.
 *
 * `executeBatch` and `grantAuditor` are both `onlySafe`. They are not admin
 * powers; they are things the treasury's owners authorise together. So the
 * frontend cannot call them directly — it has to build a Safe transaction,
 * collect the owner signature, and let the Safe make the call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO TRAPS, BOTH ALREADY PAID FOR
 *
 * 1. NEVER pass `window.ethereum` to `Safe.init` (Memory.md fact 17). On a
 *    machine with more than one wallet extension, `window.ethereum` is claimed
 *    by whichever extension won the race — here a second wallet defines it as a
 *    getter-only property and MetaMask never sets it at all. `connector
 *    .getProvider()` returns the EIP-6963 provider for the wallet the user
 *    actually chose, which is the only correct source.
 *
 * 2. protocol-kit is imported dynamically. It is large, it is needed only for
 *    two buttons, and keeping it out of the initial bundle means a resolution
 *    problem shows up as a legible error at click time rather than a blank app.
 */
import { useCallback, useMemo, useState } from "react";
import { encodeFunctionData, type Abi } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { ADDRESSES, RPC_URL } from "./chain";
import { explainError } from "./format";
import type { TxPhase } from "./use-tx";

export const SAFE_COPY: Record<TxPhase, string> = {
  idle: "",
  simulating: "Building the Safe transaction…",
  signing: "Sign as a Safe owner…",
  mining: "Waiting for confirmations…",
  done: "",
  error: "",
};

export interface SafeCall {
  to: `0x${string}`;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Execute `call` through the Safe, signed by the connected owner.
 *
 * Single-signature path only: it creates, signs, and executes in one go, which
 * completes when the connected owner alone satisfies the threshold. For a
 * higher threshold the transaction needs co-signers and belongs in the Safe
 * app — we surface that rather than pretending to handle it.
 */
export function useSafeExecute() {
  const { address, connector } = useAccount();
  const publicClient = usePublicClient();

  const [phase, setPhase] = useState<TxPhase>("idle");
  const [hash, setHash] = useState<`0x${string}` | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setHash(null);
    setError(null);
  }, []);

  const execute = useCallback(
    async (call: SafeCall): Promise<`0x${string}` | null> => {
      if (!address || !connector || !publicClient) {
        setError("Connect a Safe owner on Ethereum Sepolia first.");
        setPhase("error");
        return null;
      }

      setPhase("simulating");
      setError(null);
      setHash(null);

      try {
        const { default: Safe } = await import("@safe-global/protocol-kit");

        // The wallet the user picked — never window.ethereum. See fact 17.
        const provider = (await connector.getProvider()) as never;

        const kit = await Safe.init({
          provider,
          signer: address,
          safeAddress: ADDRESSES.safe,
        });

        // Fail with a sentence, not a revert, when the reason is structural.
        if (!(await kit.isOwner(address))) {
          throw new Error(
            `${address} is not an owner of this Safe. This action is authorised ` +
              `by the treasury's owners, not by an individual.`,
          );
        }
        const threshold = await kit.getThreshold();
        if (threshold > 1) {
          throw new Error(
            `This Safe requires ${threshold} signatures. Confide signs as one ` +
              `owner and executes; collect the remaining signatures in the Safe ` +
              `app, then execute there.`,
          );
        }

        const safeTx = await kit.createTransaction({
          transactions: [
            {
              to: call.to,
              value: "0",
              data: encodeFunctionData({
                abi: call.abi,
                functionName: call.functionName,
                args: call.args,
              } as never),
            },
          ],
        });

        setPhase("signing");
        const signed = await kit.signTransaction(safeTx);
        const result = await kit.executeTransaction(signed);
        const txHash = result.hash as `0x${string}`;
        setHash(txHash);

        setPhase("mining");
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 2,
        });

        // A Safe transaction that fails INSIDE the module still mines
        // successfully at the Safe level in some configurations, and
        // `execTransactionFromModule` swallows the inner revert entirely
        // (Memory.md — this whole class of failure is undiagnosable from
        // outside). So check the receipt status explicitly and say plainly
        // that the reason is not recoverable from the chain.
        if (receipt.status !== "success") {
          throw new Error(
            `The Safe transaction reverted (${txHash}). A module call that fails ` +
              `inside the Safe does not report its reason — the usual cause is ` +
              `the Safe holding less cUSDC than the batch total.`,
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
    [address, connector, publicClient],
  );

  const busy = phase === "simulating" || phase === "signing" || phase === "mining";

  return useMemo(
    () => ({ execute, reset, phase, hash, error, busy }),
    [execute, reset, phase, hash, error, busy],
  );
}

/** Kept beside the hook so a caller never has to know the RPC default. */
export const SAFE_RPC = RPC_URL;
