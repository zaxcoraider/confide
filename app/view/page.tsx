"use client";

/**
 * DISCLOSURE — the screen where the claim either holds or does not.
 *
 * Two audiences, one page, because they are the same question asked twice:
 * *what am I entitled to read?*
 *
 *   RECIPIENT  decrypts their own cUSDC balance. The token granted them access
 *              when it credited them, so this succeeds — for them, and for
 *              nobody else.
 *
 *   AUDITOR    reads a whole batch, but only after the Safe granted it. Before
 *              the grant the same button produces a permission error, and that
 *              is worth seeing: it is the control that makes the grant mean
 *              something. Without a visible "denied" state, "the auditor can
 *              decrypt" says nothing.
 *
 * The batch table is the split screen from Design.md §8, built into the product
 * rather than staged for the video: left is what the chain stores for everyone,
 * right is what this specific connected account is permitted to read. Same row
 * heights, so a payout lines up across the divide.
 */
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { Card, ConnectGate, Screen } from "@/components/chrome";
import { Reveal } from "@/components/reveal";
import { AddressLink, Field, Input, Note, SectionTitle } from "@/components/ui";
import {
  DisclosedAmount,
  SealedHandle,
  VisibilityBadge,
} from "@/components/visibility";
import { confidentialUsdcAbi, payrollModuleAbi } from "@/lib/abis";
import { ADDRESSES } from "@/lib/chain";
import { formatAmount, isUninitializedHandle, truncateAddress } from "@/lib/format";
import { PHASE_COPY, useDecrypt } from "@/lib/use-nox";

export default function ViewPage() {
  return (
    <Screen
      title="Disclosure"
      lede="Connect and read what you are entitled to read. A recipient sees their
            own amount. An auditor sees a batch, if the Safe granted it. Everyone
            else sees a handle."
    >
      <ConnectGate>
        <YourPay />
        <AuditBatch />
      </ConnectGate>
    </Screen>
  );
}

/** The recipient half. One value, one seal, one break. */
function YourPay() {
  const { address } = useAccount();

  const { data: handle } = useReadContract({
    address: ADDRESSES.confidentialUsdc,
    abi: confidentialUsdcAbi,
    functionName: "confidentialBalanceOf",
    args: [address!],
    query: { enabled: Boolean(address) },
  });

  return (
    <section className="mb-12">
      <SectionTitle aside={<VisibilityBadge state="sealed" />}>
        Your balance
      </SectionTitle>

      {handle && !isUninitializedHandle(handle) && address ? (
        <Reveal
          handle={handle}
          label="Your cUSDC balance"
          sublabel={`confidentialBalanceOf(${truncateAddress(address)})`}
        />
      ) : (
        <Card>
          <Note>
            This account holds no cUSDC. Once a batch that includes you is
            executed, your balance appears here and only you can read it.
          </Note>
        </Card>
      )}
    </section>
  );
}

/** The auditor half — a whole batch, side by side with what the chain shows. */
function AuditBatch() {
  const { address } = useAccount();
  const [input, setInput] = useState("");

  const { data: currentBatchId } = useReadContract({
    address: ADDRESSES.payrollModule,
    abi: payrollModuleAbi,
    functionName: "currentBatchId",
  });

  const batchId = useMemo(() => {
    const raw = input.trim();
    if (!raw) {
      // Default to the most recent batch that could hold anything: the open one
      // if it is the first, otherwise the one before it.
      if (currentBatchId === undefined) return null;
      return currentBatchId > 0n ? currentBatchId - 1n : 0n;
    }
    return /^\d+$/.test(raw) ? BigInt(raw) : null;
  }, [input, currentBatchId]);

  const { data: meta } = useReadContracts({
    contracts: [
      {
        address: ADDRESSES.payrollModule,
        abi: payrollModuleAbi,
        functionName: "payoutCount",
        args: [batchId!],
      },
      {
        address: ADDRESSES.payrollModule,
        abi: payrollModuleAbi,
        functionName: "executed",
        args: [batchId!],
      },
      {
        address: ADDRESSES.payrollModule,
        abi: payrollModuleAbi,
        functionName: "isAuditor",
        args: [batchId!, address!],
      },
    ],
    query: { enabled: batchId !== null && Boolean(address) },
  });

  const count = meta?.[0]?.result as bigint | undefined;
  const executed = meta?.[1]?.result as boolean | undefined;
  const granted = meta?.[2]?.result as boolean | undefined;

  const indices = useMemo(
    () => (count === undefined ? [] : Array.from({ length: Number(count) }, (_, i) => i)),
    [count],
  );

  const { data: payouts } = useReadContracts({
    contracts: indices.map((i) => ({
      address: ADDRESSES.payrollModule,
      abi: payrollModuleAbi,
      functionName: "payoutAt",
      args: [batchId!, BigInt(i)],
    })),
    query: { enabled: batchId !== null && indices.length > 0 },
  });

  return (
    <section>
      <SectionTitle
        aside={
          granted === undefined ? null : granted ? (
            <span className="text-verdigris font-data text-[12px] tracking-[0.02em]">
              GRANTED TO YOU
            </span>
          ) : (
            <span className="text-vellum-faint font-data text-[12px] tracking-[0.02em]">
              NOT GRANTED TO YOU
            </span>
          )
        }
      >
        Audit a batch
      </SectionTitle>

      <div className="mb-6 max-w-[280px]">
        <Field
          label="Batch"
          hint={
            currentBatchId !== undefined
              ? `Batches 0 to ${String(currentBatchId)} exist. #${String(currentBatchId)} is open.`
              : undefined
          }
        >
          <Input
            value={input}
            onChange={setInput}
            placeholder={batchId !== null ? String(batchId) : "0"}
            inputMode="numeric"
          />
        </Field>
      </div>

      {batchId === null ? (
        <Card>
          <Note>Enter a batch number.</Note>
        </Card>
      ) : !count ? (
        <Card>
          <Note>Batch #{String(batchId)} has no payouts staged.</Note>
        </Card>
      ) : (
        <>
          <div className="border-rule bg-ink-raised rounded-card overflow-hidden border">
            {/* The divide, labelled. This is the whole argument in two headings. */}
            <div className="border-rule text-vellum-faint grid grid-cols-1 gap-px border-b text-[12px] tracking-[0.01em] md:grid-cols-2">
              <div className="flex items-center gap-3 px-6 py-3">
                <span>What the chain stores</span>
                <VisibilityBadge state="sealed" />
              </div>
              <div className="border-rule flex items-center gap-3 px-6 py-3 md:border-l">
                <span>What you can read</span>
                {granted && <VisibilityBadge state="disclosed" />}
              </div>
            </div>

            <ul>
              {indices.map((i) => {
                const row = payouts?.[i]?.result as
                  | readonly [`0x${string}`, `0x${string}`]
                  | undefined;
                return (
                  <PayoutRow
                    key={`${String(batchId)}-${i}`}
                    index={i}
                    recipient={row?.[0]}
                    handle={row?.[1]}
                    granted={granted}
                  />
                );
              })}
            </ul>
          </div>

          <p className="text-vellum-faint mt-4 max-w-[72ch] text-[13px] leading-6">
            Batch #{String(batchId)} · {String(count)}{" "}
            {count === 1n ? "payout" : "payouts"} ·{" "}
            {executed ? "executed" : "not yet executed"}.{" "}
            {granted
              ? "The Safe granted this account access to these payout amounts. It does not grant access to what any recipient holds — only to what they were paid in this batch."
              : "This account has not been granted access to this batch. Breaking a seal below will fail with a permission error, which is exactly what a disclosure grant changes."}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * One payout, both sides of the divide, at the same row height.
 *
 * The handle stays put when the amount appears — it does not animate into it.
 * The chain did not change; the reader's permission did. Design.md §5.
 */
function PayoutRow({
  index,
  recipient,
  handle,
  granted,
}: {
  index: number;
  recipient: `0x${string}` | undefined;
  handle: `0x${string}` | undefined;
  /** From `isAuditor` on chain. Undefined until that read lands. */
  granted: boolean | undefined;
}) {
  const { run, phase, value, error } = useDecrypt();

  const busy = phase === "authorising" || phase === "waiting" || phase === "slow";
  const disclosed = phase === "done" && value !== null;

  return (
    <li className="border-rule grid grid-cols-1 border-b last:border-b-0 md:grid-cols-2">
      {/* Left: the public record. Recipient in the clear, amount as a handle. */}
      <div className="flex min-h-[68px] items-center gap-4 px-6 py-4">
        <span className="text-vellum-faint font-data w-6 shrink-0 text-[12px]">
          {String(index).padStart(2, "0")}
        </span>
        <span className="font-data text-graphite min-w-0 flex-1 truncate text-[13px]">
          {recipient ? <AddressLink address={recipient} /> : "—"}
        </span>
        {handle ? <SealedHandle handle={handle} dimmed={disclosed} /> : <span>—</span>}
      </div>

      {/* Right: what this account is permitted to read. */}
      <div className="border-rule flex min-h-[68px] items-center px-6 py-4 md:border-l">
        {disclosed ? (
          <DisclosedAmount amount={formatAmount(value!)} />
        ) : busy ? (
          <span className="text-wax text-[13px]">{PHASE_COPY[phase]}</span>
        ) : error ? (
          // The real message, never a paraphrase — a denial and a TEE timeout
          // read very differently, and flattening both to "denied" would hide a
          // genuine failure behind an expected one. Rules.md §4.
          //
          // But when `isAuditor` already read false, the outcome is not in
          // doubt, and the retry helper's wording ("still not ready", "if this
          // persists") describes a timeout because it cannot tell the two
          // apart. The page can. So state the refusal plainly and keep the
          // gateway's own words underneath it, unedited.
          <div title={error} className="min-w-0">
            {granted === false && (
              <span className="text-cinnabar mb-1 block text-[13px]">
                Not permitted to read this payout.
              </span>
            )}
            <span className="text-cinnabar font-data line-clamp-2 block text-[11px] leading-4 break-words opacity-70">
              {error}
            </span>
          </div>
        ) : (
          <button
            // When `isAuditor` already reads false, the denial is a FACT, not a
            // hypothesis — cut the poll short rather than spending 90s
            // pretending we might be watching a sync race. The attempt is still
            // made, and still reports the gateway's own words, because a
            // refusal you can see happen is the control that makes the grant in
            // T15 mean anything. Rules.md §4 — never fake either outcome.
            onClick={() =>
              handle && run(handle, granted === false ? { timeoutMs: 12_000 } : undefined)
            }
            disabled={!handle}
            className="border-rule-strong text-vellum hover:border-wax hover:text-wax rounded-input cursor-pointer border px-3 py-1.5 text-[13px] transition-colors duration-100 disabled:opacity-40"
          >
            Break the seal
          </button>
        )}
      </div>
    </li>
  );
}
