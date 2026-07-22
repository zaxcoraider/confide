"use client";

/** TEMPORARY design harness — delete before Phase 5. Renders the seal in every
 *  state, and two different handles side by side to confirm the geometry really
 *  is derived from the bytes rather than decorative. */
import { Seal } from "@/components/seal";
import { DisclosedAmount, SealedHandle, VisibilityBadge } from "@/components/visibility";

const A = "0x8f3a2b1c9d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c64e7d";
const B = "0x1de9c7b5a3918f7d6b5c4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170ff2";

export default function PreviewPage() {
  return (
    <main className="ledger-field relative min-h-screen p-12">
      <div className="relative z-10 mx-auto max-w-[1120px]">
        <h1 className="text-display mb-2 text-[40px]">Seal states</h1>
        <p className="text-vellum-dim mb-12 text-[15px]">
          Geometry is read out of the handle. Two handles, two seals.
        </p>

        <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
          {(["sealed", "working", "disclosed"] as const).map((state) => (
            <div key={state} className="flex flex-col items-center gap-4">
              <Seal handle={A} state={state} size={200} />
              <VisibilityBadge state={state === "disclosed" ? "disclosed" : "sealed"} />
              <code className="text-vellum-faint text-[12px]">{state}</code>
            </div>
          ))}
        </div>

        <hr className="border-rule my-12" />

        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
          {[A, B].map((h) => (
            <div key={h} className="flex flex-col items-center gap-4">
              <Seal handle={h} state="sealed" size={200} />
              <SealedHandle handle={h} />
            </div>
          ))}
        </div>

        <hr className="border-rule my-12" />

        <div className="flex items-center gap-8">
          <SealedHandle handle={A} dimmed />
          <DisclosedAmount amount="2.000000" />
          <VisibilityBadge state="public" />
          <VisibilityBadge state="sealed" />
          <VisibilityBadge state="disclosed" />
        </div>
      </div>
    </main>
  );
}
