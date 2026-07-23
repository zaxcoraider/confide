/**
 * Confide — shared Nox read-path helpers.
 *
 * Used by both the deploy/spike scripts and (from Phase 4) the frontend, so
 * keep this framework-agnostic: no viem client construction, no React, no
 * node-only imports.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * Every Nox read is preceded by an ON-CHAIN permission check that the SDK
 * performs itself and never retries:
 *
 *   publicDecrypt -> readContract NoxCompute.isPubliclyDecryptable(handle)
 *   decrypt       -> readContract NoxCompute.isViewer(handle, user)
 *
 * If either reads false the SDK throws a message that describes a PERMISSION
 * problem. In practice the overwhelmingly common cause is a SYNC RACE: the read
 * is issued moments after the transaction that granted the permission, and a
 * load-balanced public RPC serves it from a node that has not yet imported that
 * block. The SDK's own `retry()` wraps only the subsequent gateway fetch — the
 * precheck, which is the part that actually races, gets no retry at all.
 *
 * This cost a full session of debugging in Phase 0 (we misread it as an HTTP
 * 403 from the gateway; it is not an HTTP error at all). Two defences, keep
 * both:
 *
 *   1. `confirmations: 2` on every write receipt — the primary fix. With it,
 *      the retry loop below essentially never fires.
 *   2. These helpers — the backstop for TEE compute latency, which is real and
 *      documented at 5-30s for freshly computed handles.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Minimal structural type — avoids depending on the SDK's client type. */
export interface DecryptCapableClient {
  publicDecrypt: (handle: never) => Promise<{ value: unknown }>;
  decrypt: (handle: never) => Promise<{ value: unknown }>;
}

export interface RetryOptions {
  /** Total time to keep polling before giving up. Default 90s. */
  timeoutMs?: number;
  /** Gap between attempts. Default 3s. */
  intervalMs?: number;
  /** Called once per failed attempt — wire to a progress indicator in the UI. */
  onWait?: (attempt: number, elapsedMs: number) => void;
}

/**
 * Errors that mean "not ready yet" rather than "you may never read this".
 *
 * Deliberately matched on message text because the SDK throws plain `Error`s
 * for the precheck, with no code or subclass to switch on. Sourced from
 * publicDecrypt.ts / decrypt.ts in @iexec-nox/handle.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /is not publicly decryptable/i, // publicDecrypt precheck
  /is not authorized to decrypt/i, // decrypt (isViewer) precheck
  /does not exist/i, // shared prefix of both precheck messages
  /not yet computed/i, // gateway: handle exists, TEE still working
  /token is not active or expired/i, // clock skew — see below
];

/**
 * CLOCK SKEW (the 401 above) — measured and confirmed, not theorised.
 *
 * `decrypt` authorises itself with an EIP-712 `DataAccessAuthorization` whose
 * `notBefore` is `Math.floor(Date.now() / 1000)` — the CLIENT's wall clock —
 * with NO skew tolerance whatsoever. A client even slightly fast presents a
 * token the gateway considers not-yet-valid, and gets back
 * HTTP 401 "token is not active or expired".
 *
 * Proven by `scripts/diagnose-clock.ts` on a machine 19.3s fast: an ordinary
 * decrypt failed, and the very same decrypt with `Date.now` shifted back
 * succeeded and returned the correct plaintext.
 *
 * PLAIN RETRYING CANNOT FIX THIS. Each attempt regenerates the authorization
 * with a fresh `notBefore = now`, so a fast clock is *always* ahead no matter
 * how long we poll — we burned 91s of retries proving it. The SDK's own
 * self-healing does not help either: on a 401 it regenerates and retries only
 * `if (!isFreshDecryptionMaterial)`, and on a first decrypt the material is
 * already fresh, so the error falls straight through.
 *
 * The only client-side remedy is to make the SDK see an earlier clock, which
 * `withClockShift` below does for the duration of one call. It is applied
 * lazily — only after a 401 has actually been observed — so a correctly-synced
 * machine never patches anything.
 *
 * The real fix is a correct system clock; this keeps the demo working on a
 * machine we do not control (a judge's, say). Both matter.
 */

const GATEWAY_URL = "https://gateway-testnets.noxprotocol.dev";

/** Below this, skew is not worth compensating for. */
const SKEW_THRESHOLD_MS = 2_000;

/**
 * Extra backdating on top of measured skew. Generous because `expiresAt` is
 * `notBefore + 1h`, so over-shifting costs nothing until it approaches an hour.
 */
const SKEW_MARGIN_MS = 120_000;

/**
 * Backdates applied when skew cannot be MEASURED but a 401 proves it exists.
 *
 * A BROWSER CANNOT MEASURE THE SKEW. `Date` is not a CORS-safelisted response
 * header, so on any cross-origin response `res.headers.get("date")` returns
 * null and `measureClockSkewMs` reports 0 — and the pre-23-Jul logic only
 * compensated when it could put a number on it. The result was that a browser
 * never compensated at all: it retried the same doomed token ten times and gave
 * up after 92s. That is exactly how the first in-browser decrypt failed, on a
 * machine already known to be ~20s fast, while the identical call from Node
 * succeeded.
 *
 * The 401 is itself the evidence. Compensate on it whether or not the size is
 * knowable, and escalate rather than repeat, since retrying an identically
 * skewed token is futile by construction.
 *
 * Over-shifting is nearly free: `expiresAt` is `notBefore + 1h`, so any backdate
 * under roughly 50 minutes still produces a valid token. Hence values that
 * comfortably cover a badly-set clock rather than ones that merely cover ours.
 */
const FALLBACK_SHIFTS_MS = [300_000, 900_000, 1_800_000];

let skewProbe: Promise<number> | null = null;

/**
 * Positive result means the local clock is AHEAD of the gateway. Cached.
 *
 * Returns 0 in a browser — see FALLBACK_SHIFTS_MS above. A 0 here means
 * "unknown", never "synchronised", and callers must not read it as the latter.
 */
export function measureClockSkewMs(gatewayUrl = GATEWAY_URL): Promise<number> {
  skewProbe ??= (async () => {
    try {
      const before = Date.now();
      const res = await fetch(gatewayUrl, { method: "HEAD" });
      const after = Date.now();
      const header = res.headers.get("date");
      if (!header) return 0;
      // Compare against the request midpoint so round-trip latency nets out.
      return (before + after) / 2 - new Date(header).getTime();
    } catch {
      return 0; // never let the probe itself break a decrypt
    }
  })();
  return skewProbe;
}

/**
 * Run `fn` with `Date.now` reporting `shiftMs` earlier, then always restore.
 *
 * Patching a global is not something to do lightly. It is contained to a single
 * awaited call and restored in `finally`, but anything else running
 * concurrently will observe the shifted clock for that window — acceptable here
 * because the alternative is a decrypt path that simply does not work, and
 * because the shift is only ever applied on a machine already telling the wrong
 * time. If the SDK ever accepts an injectable clock, delete this.
 */
async function withClockShift<T>(shiftMs: number, fn: () => Promise<T>): Promise<T> {
  if (shiftMs <= 0) return fn();
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) - shiftMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

const isClockSkewError = (error: unknown): boolean =>
  /token is not active or expired/i.test(
    error instanceof Error ? error.message : String(error),
  );

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  return (
    /NotYetComputed/i.test(name) ||
    TRANSIENT_PATTERNS.some((p) => p.test(message))
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntilReady(
  read: () => Promise<{ value: unknown }>,
  label: string,
  { timeoutMs = 90_000, intervalMs = 3_000, onWait }: RetryOptions = {},
): Promise<unknown> {
  // Capture the real clock up front: `withClockShift` temporarily rewrites
  // Date.now, and the loop's own timing must not be fooled by that.
  const realNow = Date.now;
  const startedAt = realNow.call(Date);
  const elapsed = () => realNow.call(Date) - startedAt;

  let attempt = 0;
  let lastError: unknown;
  let shiftMs = 0;
  let measured = false;
  let fallback = 0;

  while (elapsed() < timeoutMs) {
    attempt++;
    try {
      const { value } = await withClockShift(shiftMs, read);
      return value;
    } catch (error) {
      lastError = error;

      // Clock skew: retrying unchanged is futile (every attempt mints a fresh
      // token with the same bad notBefore), so change the clock and retry
      // immediately rather than sleeping.
      //
      // Try to measure the skew once, because a measured value makes the logs
      // diagnostic. But never make compensation CONDITIONAL on measuring: a
      // browser cannot read the gateway's Date header at all, and treating that
      // as "no skew" is what made every in-browser decrypt fail. Fall back to
      // fixed backdates, escalating each time.
      if (isClockSkewError(error)) {
        let next: number | null = null;

        if (!measured) {
          measured = true;
          const ms = await measureClockSkewMs();
          if (ms > SKEW_THRESHOLD_MS) next = Math.round(ms) + SKEW_MARGIN_MS;
        }
        if (next === null && fallback < FALLBACK_SHIFTS_MS.length) {
          next = FALLBACK_SHIFTS_MS[fallback++]!;
        }

        // Only worth another attempt if the clock actually moves further back.
        if (next !== null && next > shiftMs) {
          shiftMs = next;
          onWait?.(attempt, elapsed());
          continue;
        }
      }

      // A genuine permission denial and a sync race are indistinguishable by
      // message, so we cannot fail fast on either. Anything NOT matching the
      // known-transient set is a real error and is surfaced immediately.
      if (!isTransient(error)) throw error;
      onWait?.(attempt, elapsed());
      await sleep(intervalMs);
    }
  }

  const seconds = Math.round(elapsed() / 1000);
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const hint = /token is not active or expired/i.test(detail)
    ? ` This is a CLOCK SKEW failure and compensation did not rescue it` +
      `${shiftMs > 0 ? ` (backdated ${Math.round(shiftMs / 1000)}s, still rejected)` : " (no backdate was applied)"}. ` +
      "Fix the system clock: a client running fast makes the auth token " +
      "not-yet-valid, and running more than an hour slow makes it genuinely expired."
    : " If this persists the permission is genuinely missing, not lagging.";
  throw new Error(
    `${label} still not ready after ${seconds}s (${attempt} attempts).${hint} Last error: ${detail}`,
  );
}

/** Decrypt a handle marked `allowPublicDecryption`. Anyone may read it. */
export function publicDecryptWithRetry(
  client: DecryptCapableClient,
  handle: string,
  options?: RetryOptions,
): Promise<unknown> {
  return pollUntilReady(
    () => client.publicDecrypt(handle as never),
    "publicDecrypt",
    options,
  );
}

/**
 * Decrypt a handle the connected signer was granted access to via `Nox.allow`.
 * This is how a payroll recipient reads their own amount, and how an auditor
 * reads a batch after `grantAuditor`.
 */
export function decryptWithRetry(
  client: DecryptCapableClient,
  handle: string,
  options?: RetryOptions,
): Promise<unknown> {
  return pollUntilReady(
    () => client.decrypt(handle as never),
    "decrypt",
    options,
  );
}
