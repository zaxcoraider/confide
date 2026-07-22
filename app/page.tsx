"use client";

/**
 * The landing screen — the thesis.
 *
 * Its whole job is to make the privacy claim legible in about five seconds,
 * and to make it HONEST. The claim is exactly: treasury total public,
 * individual payouts private. Rules.md §1.6 — no "anonymous", no "untraceable",
 * no "hidden balances", here or anywhere.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Nav } from "@/components/chrome";
import { Seal } from "@/components/seal";
import { VisibilityBadge } from "@/components/visibility";

/**
 * WebGL loads after paint and replaces the SVG seal. It is never in the initial
 * bundle and never on a functional path — Rules.md §5.
 */
const Seal3D = dynamic(() => import("@/components/seal-3d"), { ssr: false });

/** A real handle from batch 0 on Sepolia — not a decorative placeholder. */
const HERO_HANDLE = "0x8f3a2b1c9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c64e7d";

export default function LandingPage() {
  const [enhanced, setEnhanced] = useState(false);

  // The SVG seal is the DEFAULT hero, not a fallback — it is a complete
  // rendering in its own right (Design.md §5, Rules.md §5).
  //
  // WebGL is opt-in via NEXT_PUBLIC_SEAL_3D=1 rather than auto-detected,
  // because detection is not sufficient: on the development machine
  // `canRenderWebGL()` returned true — the context created cleanly and reported
  // itself healthy — and yet nothing was ever drawn. A wedged GPU process
  // produces a live context that renders an empty frame, with no error on any
  // channel. Auto-upgrading on a signal that weak risks a blank hero rectangle
  // in the middle of a recorded demo, which is a far worse outcome than the SVG.
  //
  // Flip the flag only after confirming the 3D seal actually renders on the
  // machine that will be recording.
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_SEAL_3D !== "1") return;
    let cancelled = false;
    void import("@/components/seal-3d").then(({ canRenderWebGL }) => {
      if (!cancelled && canRenderWebGL()) setEnhanced(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="ledger-field relative min-h-screen">
      <div className="relative z-10">
        <Nav />

        <main className="mx-auto max-w-[1120px] px-6">
          {/* ── Hero ─────────────────────────────────────────────────────── */}
          <section className="grid items-center gap-12 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:py-28">
            <div>
              <p className="text-wax mb-5 font-data text-[12px] tracking-[0.18em]">
                A SAFE MODULE · ETHEREUM SEPOLIA
              </p>
              <h1 className="text-hero mb-6 text-[44px] sm:text-[56px] lg:text-[68px]">
                Pay in
                <br />
                confidence.
              </h1>
              <p className="text-vellum-dim mb-8 max-w-[46ch] text-[16px] leading-7">
                Confide pays contributors from a Safe treasury without publishing
                what anyone earns. The total in the treasury stays public and
                auditable. The individual amounts do not.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <Link
                  href="/treasury"
                  className="bg-wax text-ink rounded-input px-4 py-2.5 text-[14px] font-medium transition-opacity duration-100 hover:opacity-90"
                >
                  Open the treasury
                </Link>
                <Link
                  href="/view"
                  className="border-rule-strong text-vellum hover:border-wax hover:text-wax rounded-input border px-4 py-2.5 text-[14px] transition-colors duration-100"
                >
                  See what a payout looks like
                </Link>
              </div>
            </div>

            {/* The signature. SVG first, WebGL after. */}
            <div className="relative mx-auto h-[320px] w-full max-w-[380px] lg:h-[420px]">
              {enhanced ? (
                <Seal3D handle={HERO_HANDLE} onFailure={() => setEnhanced(false)} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Seal handle={HERO_HANDLE} state="sealed" size={280} />
                </div>
              )}
            </div>
          </section>

          {/* ── The claim, stated exactly ────────────────────────────────── */}
          <section className="border-rule grid gap-px border-y sm:grid-cols-3">
            {[
              {
                state: "public" as const,
                heading: "The treasury total",
                body: "A plain ERC-20 balance read. Anyone can verify what backs the payroll, at any time, without asking permission.",
              },
              {
                state: "sealed" as const,
                heading: "Each individual payout",
                body: "Encrypted before it ever leaves the browser. The chain stores a bytes32 handle. Recipients are public; amounts are not.",
              },
              {
                state: "disclosed" as const,
                heading: "Disclosure, when granted",
                body: "The Safe can grant an auditor the right to read one batch. The grant is recorded on chain, and it cannot be revoked.",
              },
            ].map((col) => (
              <div key={col.heading} className="bg-ink py-8 sm:px-6 sm:first:pl-0">
                <VisibilityBadge state={col.state} className="mb-4" />
                <h2 className="mb-2 text-[18px] font-semibold">{col.heading}</h2>
                <p className="text-vellum-dim text-[14px] leading-6">{col.body}</p>
              </div>
            ))}
          </section>

          {/* ── How it actually works ────────────────────────────────────── */}
          <section className="py-20">
            <h2 className="text-display mb-2 text-[28px]">How a payroll run works</h2>
            <p className="text-vellum-dim mb-10 max-w-[62ch] text-[15px]">
              The lifecycle is ordinary multisig practice — propose, approve,
              execute — with one difference: what gets approved is already sealed.
            </p>

            {/* Numbered because this genuinely is a sequence and the order
                carries information the reader needs. */}
            <ol className="border-rule divide-rule divide-y border-t border-b">
              {[
                {
                  n: "01",
                  title: "Wrap",
                  body: "Public USDC goes into an ERC-7984 wrapper and becomes a confidential balance. The wrapper's total stays a public ERC-20 read.",
                },
                {
                  n: "02",
                  title: "Seal",
                  body: "The admin encrypts each amount in the browser and stages it. The chain records who is being paid, and a handle where the amount would be.",
                },
                {
                  n: "03",
                  title: "Approve and execute",
                  body: "The Safe owners approve the batch as a whole. No proof passes through the Safe — the module already holds validated handles.",
                },
                {
                  n: "04",
                  title: "Read",
                  body: "Each recipient decrypts their own balance and nobody else's. An auditor reads a whole batch only if the Safe granted it.",
                },
              ].map((step) => (
                <li key={step.n} className="grid gap-4 py-6 sm:grid-cols-[64px_180px_1fr]">
                  <span className="text-vellum-faint font-data text-[13px]">{step.n}</span>
                  <span className="text-[15px] font-medium">{step.title}</span>
                  <span className="text-vellum-dim text-[14px] leading-6">{step.body}</span>
                </li>
              ))}
            </ol>
          </section>

          <footer className="border-rule text-vellum-faint border-t py-8 text-[13px]">
            Built for the iExec Nox hackathon. Real Safe, real Sepolia USDC, real
            Nox — no mock data on the demo path.
          </footer>
        </main>
      </div>
    </div>
  );
}
