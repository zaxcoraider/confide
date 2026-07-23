"use client";

/**
 * TREASURY — the screen that makes the privacy claim checkable.
 *
 * The claim is exactly: *treasury total public, individual payouts private*
 * (Rules.md §1.6). This screen shows both halves of it side by side, from real
 * chain reads, so a viewer can verify rather than believe:
 *
 *   left   `inferredTotalSupply()` — an ordinary ERC-20 balance read. Anyone,
 *          including someone who never connects a wallet, sees the exact total.
 *   right  the Safe's `confidentialBalanceOf` — an opaque bytes32. Nobody can
 *          read it. Not the public, not an owner of the Safe, not us.
 *
 * The right-hand side deliberately offers NO decrypt button. Nox ACL is
 * per-address and knows nothing about Safe ownership: the token granted the
 * Safe *contract address* access on transfer, and being an owner of that Safe
 * confers no decryption rights whatsoever. Showing a button that could only
 * ever fail would teach the wrong model of how this works.
 *
 * Fact 14 constraint: the treasury total shown here MUST be the wrapper's
 * public supply, never a decrypted balance — there is no one who could decrypt
 * the latter, by design.
 */
import { useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { Card, ConnectGate, Screen } from "@/components/chrome";
import { Reveal } from "@/components/reveal";
import {
  AddressLink,
  Button,
  Field,
  Input,
  Note,
  SectionTitle,
  Stat,
  TxStatus,
} from "@/components/ui";
import { PublicValue, SealedHandle, VisibilityBadge } from "@/components/visibility";
import { confidentialUsdcAbi, erc20Abi, payrollModuleAbi, safeAbi } from "@/lib/abis";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/chain";
import { formatAmount, isUninitializedHandle, truncateAddress } from "@/lib/format";
import { useTx } from "@/lib/use-tx";

export default function TreasuryPage() {
  const { address } = useAccount();

  // ── Public reads. None of these need a connected wallet, which is the point.
  const { data: chain, refetch } = useReadContracts({
    contracts: [
      {
        address: ADDRESSES.confidentialUsdc,
        abi: confidentialUsdcAbi,
        functionName: "inferredTotalSupply",
      },
      {
        address: ADDRESSES.confidentialUsdc,
        abi: confidentialUsdcAbi,
        functionName: "confidentialBalanceOf",
        args: [ADDRESSES.safe],
      },
      { address: ADDRESSES.safe, abi: safeAbi, functionName: "getOwners" },
      { address: ADDRESSES.safe, abi: safeAbi, functionName: "getThreshold" },
      {
        address: ADDRESSES.safe,
        abi: safeAbi,
        functionName: "isModuleEnabled",
        args: [ADDRESSES.payrollModule],
      },
      {
        address: ADDRESSES.payrollModule,
        abi: payrollModuleAbi,
        functionName: "currentBatchId",
      },
    ],
  });

  const totalSupply = chain?.[0]?.result as bigint | undefined;
  const safeHandle = chain?.[1]?.result as `0x${string}` | undefined;
  const owners = chain?.[2]?.result as readonly `0x${string}`[] | undefined;
  const threshold = chain?.[3]?.result as bigint | undefined;
  const moduleEnabled = chain?.[4]?.result as boolean | undefined;
  const batchId = chain?.[5]?.result as bigint | undefined;

  return (
    <Screen
      title="Treasury"
      lede="The wrapper's total is a plain ERC-20 read — anyone can audit it without
            permission or a wallet. What the Safe holds inside it is sealed, and
            stays sealed even for the people who own the Safe."
    >
      <TheSplit totalSupply={totalSupply} safeHandle={safeHandle} />

      <div className="mt-10 grid gap-6 lg:grid-cols-2">
        <Card>
          <SectionTitle
            aside={<VisibilityBadge state="public" />}
          >
            The Safe
          </SectionTitle>
          <div className="mb-4">
            <Stat label="Address">
              <AddressLink address={ADDRESSES.safe} />
            </Stat>
            <Stat label="Owners">
              {owners ? owners.map((o) => truncateAddress(o)).join(", ") : "—"}
            </Stat>
            <Stat label="Threshold">
              {threshold !== undefined && owners
                ? `${threshold} of ${owners.length}`
                : "—"}
            </Stat>
            <Stat label="Payroll module">
              {moduleEnabled === undefined ? (
                "—"
              ) : moduleEnabled ? (
                // Not verdigris: green marks a value disclosed to you, never a
                // healthy status. Design.md §1.
                <span className="text-vellum">enabled</span>
              ) : (
                <span className="text-cinnabar">not enabled</span>
              )}
            </Stat>
            <Stat label="Module address">
              <AddressLink address={ADDRESSES.payrollModule} />
            </Stat>
            <Stat label="Open batch">
              {batchId !== undefined ? `#${batchId}` : "—"}
            </Stat>
          </div>
          <Note>
            Confide is installed with <code>enableModule()</code> on an unmodified
            Safe. It adds a way to spend the treasury; it removes none of the
            existing ones, and the owners keep full control of both.
          </Note>
        </Card>

        <Card>
          <SectionTitle>Wrap USDC</SectionTitle>
          <ConnectGate>
            <WrapFlow onDone={() => void refetch()} />
          </ConnectGate>
        </Card>
      </div>

      <section className="mt-10">
        <SectionTitle>Your confidential balance</SectionTitle>
        <ConnectGate>
          {address && <YourBalance address={address} />}
        </ConnectGate>
      </section>
    </Screen>
  );
}

/**
 * The two halves of the claim, at the same scale, on one row.
 * Design.md §8 — build the demo's key comparison into the product itself.
 */
function TheSplit({
  totalSupply,
  safeHandle,
}: {
  totalSupply: bigint | undefined;
  safeHandle: `0x${string}` | undefined;
}) {
  const sealed = safeHandle && !isUninitializedHandle(safeHandle);

  return (
    <div className="border-rule bg-ink-raised rounded-card grid overflow-hidden border md:grid-cols-2">
      <div className="border-rule border-b p-6 md:border-r md:border-b-0">
        <div className="mb-3 flex items-center gap-3">
          <span className="text-vellum-dim text-[13px] font-medium">
            Wrapped in the treasury
          </span>
          <VisibilityBadge state="public" />
        </div>
        <PublicValue>
          {totalSupply !== undefined ? formatAmount(totalSupply) : "—"}
        </PublicValue>
        <span className="text-vellum-faint font-data ml-2 text-[13px]">USDC</span>
        <p className="text-vellum-faint mt-3 max-w-[38ch] text-[13px] leading-6">
          A public ERC-20 balance read on the wrapper. No wallet, no permission,
          no indexer required.
        </p>
      </div>

      <div className="p-6">
        <div className="mb-3 flex items-center gap-3">
          <span className="text-vellum-dim text-[13px] font-medium">
            What the Safe holds
          </span>
          <VisibilityBadge state="sealed" />
        </div>
        <div className="flex h-[34px] items-center">
          {sealed ? (
            <SealedHandle handle={safeHandle} />
          ) : (
            <span className="text-vellum-faint font-data text-[13px]">
              not yet funded
            </span>
          )}
        </div>
        <p className="text-vellum-faint mt-3 max-w-[38ch] text-[13px] leading-6">
          An encrypted handle. Access is granted per address, and it was granted
          to the Safe contract — owning the Safe does not let you read it.
        </p>
      </div>
    </div>
  );
}

/**
 * approve → wrap. Two transactions, shown as two, because that is what they are.
 *
 * `wrap` pulls the public token via `transferFrom`, so the allowance has to
 * exist first. Neither the two-step shape nor the fact that `wrap` returns a
 * handle the caller holds only transiently is obvious from the interface —
 * both are recorded as friction in the feedback notes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THERE IS A DESTINATION CHOICE
 *
 * `wrap` is `wrap(address to, uint256 amount)` (fact 12), and the `to` is the
 * whole difference between funding yourself and funding the treasury. Without
 * the choice this screen could only ever mint to the connected account, and the
 * Safe — which is what actually pays a batch — would have no route to being
 * funded from the product at all.
 *
 * Wrapping straight to the Safe is also strictly better than the path
 * `scripts/phase2.ts` takes (wrap to admin, then `confidentialTransfer` to the
 * Safe): it is one transaction instead of two and needs no proof, because the
 * token mints and calls `Nox.allow(newBalance, to)` itself.
 *
 * Getting this wrong is expensive and SILENT: a batch paid out of a Safe that
 * holds too little does not revert, it clamps the transfer to zero (fact 15).
 */
function WrapFlow({ onDone }: { onDone: () => void }) {
  const { address } = useAccount();
  const [amount, setAmount] = useState("");

  // Defaults to the treasury: this is the Treasury screen, and funding the Safe
  // is the act the rest of the product depends on.
  const [destination, setDestination] = useState<"safe" | "self">("safe");

  const approveTx = useTx();
  const wrapTx = useTx();

  const { data: balances, refetch } = useReadContracts({
    contracts: [
      {
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address!],
      },
      {
        address: ADDRESSES.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address!, ADDRESSES.confidentialUsdc],
      },
    ],
    query: { enabled: Boolean(address) },
  });

  const usdcBalance = balances?.[0]?.result as bigint | undefined;
  const allowance = balances?.[1]?.result as bigint | undefined;

  const parsed = useMemo(() => {
    if (!amount.trim()) return null;
    try {
      const value = parseUnits(amount.trim(), USDC_DECIMALS);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [amount]);

  const needsApproval =
    parsed !== null && allowance !== undefined && allowance < parsed;
  const overBalance =
    parsed !== null && usdcBalance !== undefined && parsed > usdcBalance;

  const busy = approveTx.busy || wrapTx.busy;

  async function approve() {
    if (!parsed) return;
    const hash = await approveTx.send({
      address: ADDRESSES.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [ADDRESSES.confidentialUsdc, parsed],
    });
    if (hash) void refetch();
  }

  async function wrap() {
    if (!parsed || !address) return;
    const to = destination === "safe" ? ADDRESSES.safe : address;
    const hash = await wrapTx.send({
      address: ADDRESSES.confidentialUsdc,
      abi: confidentialUsdcAbi,
      functionName: "wrap",
      args: [to, parsed],
    });
    if (hash) {
      setAmount("");
      void refetch();
      onDone();
    }
  }

  return (
    <div className="space-y-4">
      <Stat label="Your public USDC">
        {usdcBalance !== undefined ? `${formatAmount(usdcBalance)} USDC` : "—"}
      </Stat>

      <Field
        label="Amount to wrap"
        hint="Public USDC in, confidential cUSDC out. The wrapper's total supply rises publicly; the balance inside it does not."
      >
        <Input
          value={amount}
          onChange={setAmount}
          placeholder="5.00"
          inputMode="decimal"
          disabled={busy}
        />
      </Field>

      <Field
        label="Credit to"
        hint={
          destination === "safe"
            ? "The Safe is what pays a batch, so this is how the treasury is funded. Once credited, nobody can read the balance — not even the Safe's owners."
            : "Mints to your own account. You will be able to read this balance, because the token grants the holder access."
        }
      >
        <div className="flex gap-2">
          {(
            [
              ["safe", "The treasury", truncateAddress(ADDRESSES.safe)],
              ["self", "Your account", address ? truncateAddress(address) : "—"],
            ] as const
          ).map(([value, label, sub]) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              onClick={() => setDestination(value)}
              aria-pressed={destination === value}
              className={`rounded-input flex-1 cursor-pointer border px-3 py-2 text-left transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 ${
                destination === value
                  ? "border-wax text-wax"
                  : "border-rule text-vellum-faint hover:border-rule-strong"
              }`}
            >
              <span className="block text-[13px]">{label}</span>
              <span className="font-data block text-[12px] opacity-70">{sub}</span>
            </button>
          ))}
        </div>
      </Field>

      {amount.trim() && parsed === null && (
        <p className="text-cinnabar text-[13px]">
          Enter an amount in USDC, e.g. 5 or 5.25.
        </p>
      )}
      {overBalance && (
        <p className="text-cinnabar text-[13px]">
          That is more than your public USDC balance. Top up at{" "}
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noreferrer"
            className="underline decoration-dotted underline-offset-4"
          >
            faucet.circle.com
          </a>
          .
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <Button
          onClick={approve}
          disabled={!parsed || !needsApproval || busy || overBalance}
          title={
            needsApproval ? undefined : "The wrapper already has enough allowance."
          }
        >
          1 · Approve
        </Button>
        <Button
          variant="primary"
          onClick={wrap}
          disabled={!parsed || needsApproval || busy || overBalance}
        >
          2 · Wrap to cUSDC
        </Button>
      </div>

      <TxStatus {...approveTx} done="Allowance set." />
      <TxStatus
        {...wrapTx}
        done={
          destination === "safe"
            ? "Wrapped into the treasury. The public total above rose by exactly this much; what the Safe holds stayed a handle."
            : "Wrapped. Your balance is now confidential."
        }
      />
    </div>
  );
}

/**
 * Your own cUSDC balance — the one confidential value on this screen that you
 * personally are entitled to read. The token granted you access when it minted
 * to you, so this decrypt is expected to succeed.
 */
function YourBalance({ address }: { address: `0x${string}` }) {
  const { data } = useReadContracts({
    contracts: [
      {
        address: ADDRESSES.confidentialUsdc,
        abi: confidentialUsdcAbi,
        functionName: "confidentialBalanceOf",
        args: [address],
      },
    ],
  });

  const handle = data?.[0]?.result as `0x${string}` | undefined;

  if (!handle || isUninitializedHandle(handle)) {
    return (
      <Card>
        <Note>
          You hold no cUSDC yet. Wrap some USDC above, or wait to be paid — a
          payout creates your balance.
        </Note>
      </Card>
    );
  }

  return (
    <Reveal
      handle={handle}
      label="Your cUSDC balance"
      sublabel={`confidentialBalanceOf(${truncateAddress(address)})`}
      actionLabel="Break the seal"
    />
  );
}
