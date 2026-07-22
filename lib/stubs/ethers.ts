/**
 * Build-time stub for `ethers`. Aliased in `next.config.ts`.
 *
 * WHY THIS EXISTS
 *
 * `@iexec-nox/handle` declares `ethers` and `viem` as OPTIONAL peer
 * dependencies — you pick one. But its barrel (`dist/esm/index.js`) eagerly
 * re-exports `createEthersHandleClient`, which statically imports
 * `BrowserProvider` from `ethers`. A bundler resolves the whole import graph
 * regardless of what you actually call, so the "optional" peer becomes
 * mandatory the moment the package is used from a bundled app.
 *
 * It never surfaced in the Phase 0-3 scripts because `tsx` resolves lazily.
 * It is fatal under Turbopack:
 *   Module not found: Can't resolve 'ethers'
 *
 * Confide is viem-only (Rules.md §5 forbids pulling in ethers), and only
 * `createViemHandleClient` is ever called — so the aliased-away code is
 * genuinely unreachable rather than merely unused. If anything ever does reach
 * it, the throw below makes that loud instead of silent.
 *
 * The upstream fix is a subpath export (`@iexec-nox/handle/viem`) or a lazy
 * import inside the factory. Recorded in feedback.md.
 */

export class BrowserProvider {
  constructor() {
    throw new Error(
      "ethers is stubbed out in this project. Confide is viem-only — use " +
        "createViemHandleClient, not createEthersHandleClient. See lib/stubs/ethers.ts.",
    );
  }
}
