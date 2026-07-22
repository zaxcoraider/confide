"use client";

/**
 * Shared primitives for the three working screens.
 *
 * Small on purpose. These exist so that the transaction feedback contract from
 * Rules.md §4 — real reason, real tx hash, never a bare spinner — is written
 * once and cannot be forgotten on a screen built at 2am.
 */
import type { ReactNode } from "react";
import { addressUrl, txUrl } from "@/lib/chain";
import { truncateAddress } from "@/lib/format";
import { TX_COPY, type TxPhase } from "@/lib/use-tx";

export function Button({
  children,
  onClick,
  disabled,
  variant = "secondary",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
  title?: string;
}) {
  const base =
    "rounded-input cursor-pointer text-[14px] transition-colors duration-100 " +
    "disabled:cursor-not-allowed disabled:opacity-40";
  const tone =
    variant === "primary"
      ? "bg-wax text-ink px-4 py-2.5 font-medium hover:opacity-90 disabled:hover:opacity-40"
      : "border-rule-strong text-vellum hover:border-wax hover:text-wax border px-4 py-2.5";
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${tone}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-vellum-dim mb-1.5 block text-[13px] font-medium tracking-[0.01em]">
        {label}
      </span>
      {children}
      {hint && <span className="text-vellum-faint mt-1.5 block text-[12px]">{hint}</span>}
    </label>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  disabled,
  mono = true,
  inputMode,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  inputMode?: "decimal" | "numeric" | "text";
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      inputMode={inputMode}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      autoComplete="off"
      className={`bg-ink-inset border-rule focus:border-rule-strong rounded-input w-full border px-3 py-2.5 text-[14px] outline-none transition-colors duration-100 disabled:opacity-40 ${
        mono ? "font-data" : ""
      }`}
    />
  );
}

/** A labelled row of chain metadata. Public by nature, so graphite. */
export function Stat({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="border-rule flex items-baseline justify-between gap-4 border-b py-2.5 last:border-b-0">
      <span className="text-vellum-faint shrink-0 text-[13px]">{label}</span>
      <span className="font-data text-vellum-dim min-w-0 truncate text-[13px]">
        {children}
      </span>
    </div>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  return (
    <a
      href={addressUrl(address)}
      target="_blank"
      rel="noreferrer"
      title={address}
      className="hover:text-vellum underline decoration-dotted underline-offset-4 transition-colors duration-100"
    >
      {label ?? truncateAddress(address)}
    </a>
  );
}

/**
 * The single place a transaction reports itself.
 *
 * Always shows the hash the moment there is one — including on failure, which
 * is exactly when it matters most, because that is the thing the user needs in
 * order to go look at what actually happened.
 */
export function TxStatus({
  phase,
  hash,
  error,
  copy = TX_COPY,
  done,
}: {
  phase: TxPhase;
  hash: string | null;
  error: string | null;
  copy?: Record<TxPhase, string>;
  /** What to say on success. Names the completed action, per Design.md §9. */
  done?: string;
}) {
  if (phase === "idle" && !hash && !error) return null;

  return (
    <div className="mt-3 space-y-1.5">
      {copy[phase] && <p className="text-wax text-[13px]">{copy[phase]}</p>}

      {/* Deliberately NOT verdigris. Design.md §1 reserves green for a value
          that has been decrypted for you; a transaction succeeding is not
          that, and borrowing the colour would blunt the one moment it means
          something. */}
      {phase === "done" && done && (
        <p className="text-vellum-dim text-[13px]">{done}</p>
      )}

      {hash && (
        <p className="font-data text-[12px]">
          <a
            href={txUrl(hash)}
            target="_blank"
            rel="noreferrer"
            className="text-vellum-faint hover:text-vellum-dim underline decoration-dotted underline-offset-4 transition-colors duration-100"
          >
            {hash.slice(0, 18)}… ↗
          </a>
        </p>
      )}

      {/* Rules.md §4: the real reason, verbatim, never "something went wrong". */}
      {error && (
        <p className="text-cinnabar font-data text-[12px] leading-5 break-words">
          {error}
        </p>
      )}
    </div>
  );
}

/** A short explanatory aside. Used to state privacy facts plainly, in place. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <p className="text-vellum-faint max-w-[64ch] text-[13px] leading-6">{children}</p>
  );
}

export function SectionTitle({
  children,
  aside,
}: {
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-display text-[20px]">{children}</h2>
      {aside}
    </div>
  );
}
