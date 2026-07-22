import { formatUnits } from "viem";
import { USDC_DECIMALS } from "./chain";

/**
 * Truncate a bytes32 handle as `0x8f3a2b1c…4e7d` — first 10, last 4.
 * Design.md §5: never show all 66 characters; it destroys the layout and reads
 * as noise rather than as a sealed value.
 */
export function truncateHandle(handle: string): string {
  if (handle.length <= 18) return handle;
  return `${handle.slice(0, 10)}…${handle.slice(-4)}`;
}

/** Addresses get a tighter truncation than handles — they are secondary. */
export function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** cUSDC has 6 decimals. Always render all six so columns align. */
export function formatAmount(value: bigint): string {
  return Number(formatUnits(value, USDC_DECIMALS)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

export const ZERO_HANDLE = `0x${"0".repeat(64)}` as const;

export const isUninitializedHandle = (handle: string) => handle === ZERO_HANDLE;

/**
 * Turn a thrown chain error into something a human can act on.
 *
 * Rules.md §4: surface the REAL reason and the tx hash. Never "Something went
 * wrong". viem puts the decoded custom error name on `cause.data.errorName`
 * when the ABI carries the error definition — which is why lib/abis.ts lists
 * every custom error the module can throw.
 */
export function explainError(error: unknown): string {
  if (!error) return "Unknown error.";

  const walk = (e: unknown, depth = 0): string | null => {
    if (!e || depth > 6) return null;
    const obj = e as Record<string, unknown>;

    const data = obj.data as { errorName?: string; args?: unknown[] } | undefined;
    if (data?.errorName) {
      const args = data.args?.length ? `(${data.args.map(String).join(", ")})` : "()";
      return `${data.errorName}${args}`;
    }
    if (typeof obj.shortMessage === "string" && obj.shortMessage) {
      const nested = walk(obj.cause, depth + 1);
      return nested ?? obj.shortMessage;
    }
    return walk(obj.cause, depth + 1);
  };

  const decoded = walk(error);
  const raw = error instanceof Error ? error.message : String(error);
  const base = decoded ?? raw;

  // Translate the module's custom errors into what to actually do about them.
  const guidance: Record<string, string> = {
    OnlyAdmin: "Only the admin EOA that encrypts amounts can stage a payout. Switch accounts.",
    OnlySafe: "This call is authorised by the Safe, not by an individual owner.",
    BatchAlreadyExecuted: "That batch has already been paid out. Stage a new one.",
    BatchEmpty: "There is nothing staged in that batch yet.",
    InvalidRecipient: "The recipient address cannot be the zero address.",
    InvalidAuditor: "The auditor address cannot be the zero address.",
    SafeExecutionFailed:
      "The Safe could not complete a transfer. The most common cause is the Safe " +
      "holding less cUSDC than the batch total.",
  };

  for (const [name, hint] of Object.entries(guidance)) {
    if (base.startsWith(name)) return `${base} — ${hint}`;
  }
  return base;
}
