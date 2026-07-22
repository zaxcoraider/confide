import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: {
    // The home directory also contains a package-lock.json, so Next infers the
    // wrong workspace root and resolves modules from there. Pin it.
    root: path.resolve(import.meta.dirname),

    resolveAlias: {
      // @iexec-nox/handle's barrel eagerly imports its ethers adapter, making
      // an OPTIONAL peer dependency mandatory under a bundler. Confide is
      // viem-only, so alias it to a stub that throws if anything ever reaches
      // it. Full explanation in lib/stubs/ethers.ts.
      ethers: "./lib/stubs/ethers.ts",
    },
  },

  // Hardhat lives in the same repo. Keep its output out of the web build.
  outputFileTracingExcludes: {
    "*": ["./contracts/**", "./hardhat-artifacts/**", "./hardhat-cache/**"],
  },
};

export default config;
