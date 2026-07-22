"use client";

/**
 * Confide — the browser decrypt path.
 *
 * Wraps `lib/nox.ts` (shared with the Phase 0-3 scripts) in React state so a
 * component gets the TEE waiting state for free. Do NOT hand-roll retry logic
 * in a component; the helpers in lib/nox.ts encode two hard-won facts that are
 * invisible from the call site:
 *
 *   1. The SDK's permission precheck is an ONCHAIN read that it never retries,
 *      so a sync race is indistinguishable from a denial (Memory.md fact 9b).
 *   2. `decrypt` has zero clock-skew tolerance and reports skew as a 401 auth
 *      error. Plain retrying CANNOT fix it (Memory.md fact 11).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useAccount, useWalletClient } from "wagmi";
import { decryptWithRetry } from "./nox";

/** Progressive, honest status. Design.md §7 — never a bare spinner. */
export type DecryptPhase = "idle" | "authorising" | "waiting" | "slow" | "done" | "error";

export const PHASE_COPY: Record<DecryptPhase, string> = {
  idle: "",
  authorising: "Authorising…",
  waiting: "Waiting for the TEE…",
  slow: "Still working — this can take up to a minute",
  done: "",
  error: "",
};

type HandleClient = {
  encryptInput: (
    value: bigint,
    type: string,
    applicationContract: string,
  ) => Promise<{ handle: `0x${string}`; handleProof: `0x${string}` }>;
  decrypt: (handle: never) => Promise<{ value: unknown }>;
  publicDecrypt: (handle: never) => Promise<{ value: unknown }>;
};

/**
 * Builds a Nox handle client bound to the connected wallet.
 *
 * The SDK is imported dynamically: it is large, it is only needed once a wallet
 * is connected, and keeping it out of the initial bundle means a bundling
 * problem surfaces as a legible error at call time rather than a blank page.
 */
export function useHandleClient() {
  const { data: walletClient } = useWalletClient();
  const cache = useRef<{ key: string; client: Promise<HandleClient> } | null>(null);

  return useCallback(async (): Promise<HandleClient> => {
    if (!walletClient) {
      throw new Error("Connect a wallet before encrypting or decrypting.");
    }
    const key = `${walletClient.account.address}:${walletClient.chain?.id}`;
    if (cache.current?.key !== key) {
      cache.current = {
        key,
        client: (async () => {
          const { createViemHandleClient } = await import("@iexec-nox/handle");
          return (await createViemHandleClient(walletClient as never)) as unknown as HandleClient;
        })(),
      };
    }
    return cache.current.client;
  }, [walletClient]);
}

/**
 * Encrypt one amount in the browser, producing a handle and its proof.
 *
 * `applicationContract` is the single most error-prone argument in the SDK and
 * the reason this hook takes it explicitly rather than defaulting it. Nox binds
 * a proof to BOTH the encryptor and one contract address, and the address it
 * must be bound to is *the contract that will execute the TEE operation* —
 * which is not always the contract you are calling:
 *
 *   staging a payout   → the PayrollModule  (it runs `Nox.fromExternal`)
 *   moving cUSDC       → the token itself   (it runs the transfer)
 *
 * Get it wrong and the transaction reverts on proof validation with nothing in
 * the message pointing at the cause. Rules.md §3.
 *
 * The proof owner is NOT overridable — the SDK binds it to the connected
 * signer. That is why staging must be an admin EOA call and can never route
 * through the Safe (Architecture.md §2).
 */
export function useEncrypt() {
  const getClient = useHandleClient();
  const [phase, setPhase] = useState<"idle" | "encrypting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const run = useCallback(
    async (amount: bigint, applicationContract: `0x${string}`) => {
      setPhase("encrypting");
      setError(null);
      try {
        const client = await getClient();
        const sealed = await client.encryptInput(amount, "uint256", applicationContract);
        setPhase("done");
        return sealed;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
        return null;
      }
    },
    [getClient],
  );

  return useMemo(
    () => ({ run, reset, phase, error, busy: phase === "encrypting" }),
    [run, reset, phase, error],
  );
}

/**
 * Decrypt one handle as the connected account, with the full waiting state.
 *
 * Returns `null` value until it succeeds. An error is surfaced verbatim —
 * Rules.md §4 forbids swallowing it to make a demo look smooth.
 */
export function useDecrypt() {
  const getClient = useHandleClient();
  const { address } = useAccount();
  const [phase, setPhase] = useState<DecryptPhase>("idle");
  const [value, setValue] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setValue(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (handle: string) => {
      setPhase("authorising");
      setError(null);
      setValue(null);
      try {
        const client = await getClient();
        const result = await decryptWithRetry(client as never, handle, {
          onWait: (_attempt, elapsedMs) =>
            setPhase(elapsedMs > 12_000 ? "slow" : "waiting"),
        });
        setValue(BigInt(result as bigint));
        setPhase("done");
        return BigInt(result as bigint);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
        return null;
      }
    },
    [getClient],
  );

  return useMemo(
    () => ({ run, reset, phase, value, error, account: address }),
    [run, reset, phase, value, error, address],
  );
}
