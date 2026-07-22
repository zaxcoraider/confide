"use client";

/**
 * The visibility vocabulary — Design.md §1.
 *
 * Every value in Confide is in exactly one of three states, and each state owns
 * one colour. This file is the single place those colours are attached to
 * meaning; nothing else in the app should reach for wax/verdigris/graphite
 * directly. If a new colour meaning is ever needed, it belongs here or nowhere.
 */
import type { ReactNode } from "react";
import { truncateHandle } from "@/lib/format";

export type Visibility = "public" | "sealed" | "disclosed";

const BADGE: Record<Visibility, { label: string; className: string }> = {
  public: {
    label: "PUBLIC",
    className: "text-graphite border border-rule-strong",
  },
  sealed: {
    label: "SEALED",
    className: "text-wax bg-wax-bg border border-transparent",
  },
  disclosed: {
    label: "DISCLOSED",
    className: "text-verdigris bg-verdigris-bg border border-transparent",
  },
};

export function VisibilityBadge({
  state,
  className = "",
}: {
  state: Visibility;
  className?: string;
}) {
  const { label, className: tone } = BADGE[state];
  return (
    <span
      className={`font-data inline-flex shrink-0 items-center rounded-pill px-2 py-[3px] text-[10px] leading-none tracking-[0.08em] ${tone} ${className}`}
    >
      {label}
    </span>
  );
}

/**
 * A public, readable-by-anyone value. Graphite, mono, tabular.
 * Used for the treasury total and every tx hash.
 */
export function PublicValue({
  children,
  size = "lg",
}: {
  children: ReactNode;
  size?: "lg" | "sm";
}) {
  return (
    <span
      className={`font-data text-graphite ${
        size === "lg" ? "text-[28px] leading-tight" : "text-[13px]"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * The default rendering for an encrypted amount: the raw handle, truncated,
 * in wax amber.
 *
 * `dimmed` is what the reveal uses — the handle STAYS on screen at 40% rather
 * than being replaced. Design.md §5: never animate the handle into the amount,
 * because that implies the chain changed, which is false.
 */
export function SealedHandle({
  handle,
  dimmed = false,
  title,
}: {
  handle: string;
  dimmed?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title ?? handle}
      className={`font-data text-wax text-[13px] transition-opacity duration-500 ${
        dimmed ? "opacity-40" : "opacity-100"
      }`}
    >
      {truncateHandle(handle)}
    </span>
  );
}

/**
 * A value decrypted for the connected account specifically. Verdigris.
 * This is the only green in the product.
 */
export function DisclosedAmount({
  amount,
  unit = "cUSDC",
}: {
  amount: string;
  unit?: string;
}) {
  return (
    <span className="font-data text-verdigris text-[18px] leading-6">
      {amount}
      <span className="text-vellum-faint ml-1.5 text-[13px]">{unit}</span>
    </span>
  );
}
