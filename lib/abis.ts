/**
 * Confide — contract ABIs for the frontend.
 *
 * Hand-written on purpose, NOT imported from `hardhat-artifacts/`. That
 * directory is gitignored, and Phase 5 requires a stranger to clone the repo
 * and `npm run build` without ever touching Hardhat. Importing artifacts would
 * break that.
 *
 * Only the surface the UI actually calls is listed here. Keep it that way —
 * every entry is a thing the frontend is allowed to do.
 */

/** Public ERC-20 (Circle USDC on Sepolia, 6 decimals). */
export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

/**
 * ConfidentialUSDC (ERC-7984 wrapper).
 *
 * `inferredTotalSupply` is the PUBLIC number the Treasury screen shows — it is
 * a plain `USDC.balanceOf(wrapper)` read. `confidentialBalanceOf` returns an
 * opaque bytes32 handle; only the holder was granted decrypt access on mint.
 */
export const confidentialUsdcAbi = [
  {
    type: "function",
    name: "inferredTotalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "underlying",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    // wrap(address to, uint256 amount) — NOT wrap(uint256). Requires a prior
    // ERC-20 approve to this contract. Returns a handle the caller holds only
    // transiently; read the balance back via confidentialBalanceOf.
    type: "function",
    name: "wrap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/** PayrollModule — the core of Confide. */
export const payrollModuleAbi = [
  {
    type: "function",
    name: "safe",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "token",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "admin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "currentBatchId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "executed",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isAuditor",
    stateMutability: "view",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "auditor", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "payoutCount",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "payoutAt",
    stateMutability: "view",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "index", type: "uint256" },
    ],
    outputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "bytes32" },
    ],
  },
  {
    // Admin EOA calls this DIRECTLY. Routing it through the Safe reverts with
    // "Owner mismatch" — Nox binds the proof to whoever encrypted it.
    type: "function",
    name: "stagePayout",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "encryptedAmount", type: "bytes32" },
      { name: "inputProof", type: "bytes" },
    ],
    outputs: [
      { name: "batchId", type: "uint256" },
      { name: "index", type: "uint256" },
    ],
  },
  {
    // onlySafe. No proof — the module already owns validated handles.
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [{ name: "batchId", type: "uint256" }],
    outputs: [],
  },
  {
    // onlySafe. Grants decrypt access over every payout handle in the batch.
    type: "function",
    name: "grantAuditor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "auditor", type: "address" },
      { name: "batchId", type: "uint256" },
    ],
    outputs: [],
  },

  // Events — amounts are deliberately absent from all of them.
  {
    type: "event",
    name: "PayoutStaged",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "index", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BatchExecuted",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "count", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AuditorGranted",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "auditor", type: "address", indexed: true },
      { name: "count", type: "uint256", indexed: false },
    ],
  },

  // Custom errors. Listed so viem can decode a revert into a real name —
  // Rules.md §4 requires the UI to show the actual reason, never "went wrong".
  { type: "error", name: "OnlyAdmin", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "OnlySafe", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "BatchAlreadyExecuted", inputs: [{ name: "batchId", type: "uint256" }] },
  { type: "error", name: "BatchEmpty", inputs: [{ name: "batchId", type: "uint256" }] },
  { type: "error", name: "InvalidRecipient", inputs: [] },
  { type: "error", name: "InvalidAuditor", inputs: [] },
  {
    type: "error",
    name: "SafeExecutionFailed",
    inputs: [
      { name: "batchId", type: "uint256" },
      { name: "index", type: "uint256" },
    ],
  },
] as const;

/** Minimal Safe v1.4.1 surface — read-only; writes go through protocol-kit. */
export const safeAbi = [
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;
