"use client";

/**
 * THE REVEAL — the single most important interaction in the product.
 * Design.md §5/§6.
 *
 * The rule that governs every line here: the handle STAYS. It dims to 40% and
 * the amount stacks BELOW it. The handle is never replaced by the amount and
 * never animates into it, because that would imply the chain changed. It did
 * not. The argument this interaction makes is:
 *
 *     this is still exactly what the chain stores;
 *     you are simply permitted to read it.
 *
 * Break that and the product's whole claim goes with it.
 */
import { AnimatePresence, motion } from "motion/react";
import { formatAmount } from "@/lib/format";
import { PHASE_COPY, useDecrypt } from "@/lib/use-nox";
import { Seal, type SealState } from "./seal";
import { DisclosedAmount, SealedHandle, VisibilityBadge } from "./visibility";

export function Reveal({
  handle,
  label,
  sublabel,
  sealSize = 148,
  /** Copy for the action. Named for what happens, and kept through the flow. */
  actionLabel = "Break the seal",
}: {
  handle: string;
  label: string;
  sublabel?: string;
  sealSize?: number;
  actionLabel?: string;
}) {
  const { run, phase, value, valueHandle, error } = useDecrypt();

  const busy = phase === "authorising" || phase === "waiting" || phase === "slow";
  // The handle must match the one this value was decrypted FROM. A balance
  // handle changes whenever the balance does — wrap more, get paid — and this
  // component keeps its state across that change. Checking `phase === "done"`
  // alone would show the new handle beside the old amount, which is the one
  // lie this interaction cannot tell.
  const disclosed = phase === "done" && value !== null && valueHandle === handle;
  const sealState: SealState = disclosed ? "disclosed" : busy ? "working" : "sealed";

  return (
    <div className="border-rule bg-ink-raised rounded-card flex flex-col items-center gap-5 border p-6 sm:flex-row sm:items-center sm:gap-8">
      <div className="shrink-0">
        <Seal handle={handle} state={sealState} size={sealSize} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-3">
          <span className="text-vellum-dim text-[13px] font-medium">{label}</span>
          <VisibilityBadge state={disclosed ? "disclosed" : "sealed"} />
        </div>

        {sublabel && (
          <p className="text-vellum-faint mb-3 font-data text-[12px]">{sublabel}</p>
        )}

        {/* The handle. Dims on disclosure — never removed. */}
        <div className="mb-2">
          <SealedHandle handle={handle} dimmed={disclosed} />
        </div>

        {/* The amount stacks below. */}
        <AnimatePresence mode="wait">
          {disclosed ? (
            <motion.div
              key="amount"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1], delay: 0.2 }}
            >
              <DisclosedAmount amount={formatAmount(value!)} />
            </motion.div>
          ) : busy ? (
            <motion.p
              key={phase}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-wax text-[13px]"
            >
              {PHASE_COPY[phase]}
            </motion.p>
          ) : (
            <motion.button
              key="action"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => run(handle)}
              className="border-rule-strong text-vellum hover:border-wax hover:text-wax rounded-input cursor-pointer border px-3 py-1.5 text-[13px] transition-colors duration-100"
            >
              {actionLabel}
            </motion.button>
          )}
        </AnimatePresence>

        {/* Rules.md §4: the real reason, never "something went wrong". */}
        {error && (
          <p className="text-cinnabar mt-3 font-data text-[12px] leading-5 break-words">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
