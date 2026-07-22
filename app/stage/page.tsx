"use client";

/**
 * PAYROLL — propose, approve, disclose.
 *
 * This screen is the lifecycle split from Architecture.md §2 made visible. The
 * split is not an implementation detail to hide behind one button; it IS the
 * product, and it is exactly multisig semantics:
 *
 *   STAGE     the admin EOA, calling the module DIRECTLY, one payout at a time.
 *             A proof is required and it is bound to the encryptor, so this call
 *             can never route through the Safe — it would revert "Owner
 *             mismatch". Staging is a proposal, not a payment.
 *
 *   EXECUTE   the Safe, m-of-n approved, paying the whole batch. No proof is
 *             involved: the module already holds validated handles. This is
 *             precisely why this call CAN go through the Safe when staging
 *             cannot.
 *
 *   DISCLOSE  the Safe again. An auditor is granted decrypt access over a
 *             batch's payout handles. Authorised by the owners, scoped to one
 *             batch, and permanent — Nox has no revocation.
 *
 * The staged list below shows what the chain actually records: the recipient in
 * the clear, and a handle where the amount would be. That is the honest claim
 * (Rules.md §1.6) — recipients are public, amounts are not.
 */
import { useMemo, useState } from "react";
import { isAddress, parseUnits } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { Card, ConnectGate, Screen } from "@/components/chrome";
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
import { SealedHandle, VisibilityBadge } from "@/components/visibility";
import { payrollModuleAbi } from "@/lib/abis";
import { ADDRESSES, USDC_DECIMALS } from "@/lib/chain";
import { truncateAddress } from "@/lib/format";
import { useEncrypt } from "@/lib/use-nox";
import { SAFE_COPY, useSafeExecute } from "@/lib/use-safe";
import { useTx } from "@/lib/use-tx";

export default function StagePage() {
  const { address } = useAccount();

  const { data: admin } = useReadContract({
    address: ADDRESSES.payrollModule,
    abi: payrollModuleAbi,
    functionName: "admin",
  });

  const { data: batchId, refetch: refetchBatch } = useReadContract({
    address: ADDRESSES.payrollModule,
    abi: payrollModuleAbi,
    functionName: "currentBatchId",
  });

  const { data: count, refetch: refetchCount } = useReadContract({
    address: ADDRESSES.payrollModule,
    abi: payrollModuleAbi,
    functionName: "payoutCount",
    args: [batchId!],
    query: { enabled: batchId !== undefined },
  });

  const refetchAll = () => {
    void refetchBatch();
    void refetchCount();
  };

  const isAdmin =
    Boolean(address) && Boolean(admin) && address!.toLowerCase() === admin!.toLowerCase();

  return (
    <Screen
      title="Payroll"
      lede="Amounts are encrypted in your browser before they are submitted. The
            chain records who is being paid and a handle where the amount would
            be — never the amount itself."
    >
      <ConnectGate>
        <div className="border-rule bg-ink-raised rounded-card mb-8 flex flex-wrap items-center gap-x-8 gap-y-3 border px-6 py-4">
          <span className="text-vellum-dim text-[13px]">
            Open batch{" "}
            <span className="font-data text-vellum">
              #{batchId !== undefined ? String(batchId) : "—"}
            </span>
          </span>
          <span className="text-vellum-dim text-[13px]">
            Staged{" "}
            <span className="font-data text-vellum">
              {count !== undefined ? String(count) : "—"}
            </span>
          </span>
          <span className="text-vellum-faint text-[13px]">
            Admin <AddressLink address={admin ?? ADDRESSES.payrollModule} />
          </span>
        </div>

        {!isAdmin && admin && (
          <Card className="mb-8">
            <Note>
              Staging is restricted to the admin EOA{" "}
              <span className="font-data text-vellum-dim">
                {truncateAddress(admin)}
              </span>
              , and that is not a policy choice — Nox binds every encrypted input
              to the account that encrypted it, so only that account can produce a
              proof this module will accept. You are connected as{" "}
              <span className="font-data text-vellum-dim">
                {address ? truncateAddress(address) : "—"}
              </span>
              . Switch accounts to stage a payout.
            </Note>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <SectionTitle>Stage a payout</SectionTitle>
            <StageForm
              disabled={!isAdmin}
              batchId={batchId}
              onStaged={refetchAll}
            />
          </Card>

          <Card>
            <SectionTitle aside={<VisibilityBadge state="sealed" />}>
              What the chain records
            </SectionTitle>
            <StagedList batchId={batchId} count={count} />
          </Card>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card>
            <SectionTitle>Approve and execute</SectionTitle>
            <ExecuteBatch batchId={batchId} count={count} onExecuted={refetchAll} />
          </Card>

          <Card>
            <SectionTitle>Disclose to an auditor</SectionTitle>
            <GrantAuditor openBatchId={batchId} openBatchCount={count} />
          </Card>
        </div>
      </ConnectGate>
    </Screen>
  );
}

/**
 * Seal one amount and stage it.
 *
 * Two steps run back to back and are reported separately, because they fail for
 * completely different reasons: encryption is a gateway/TEE round trip, staging
 * is a chain transaction. Collapsing them into one status would make a failure
 * ambiguous exactly when it matters.
 */
function StageForm({
  disabled,
  batchId,
  onStaged,
}: {
  disabled: boolean;
  batchId: bigint | undefined;
  onStaged: () => void;
}) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const encrypt = useEncrypt();
  const tx = useTx();

  const recipientValid = isAddress(recipient.trim());
  const parsed = useMemo(() => {
    if (!amount.trim()) return null;
    try {
      const value = parseUnits(amount.trim(), USDC_DECIMALS);
      return value > 0n ? value : null;
    } catch {
      return null;
    }
  }, [amount]);

  const busy = encrypt.busy || tx.busy;
  const ready = recipientValid && parsed !== null && !disabled && !busy;

  async function stage() {
    if (!parsed || !recipientValid) return;

    // The application contract is the MODULE — it is what runs
    // `Nox.fromExternal` on this proof. Binding it to the token instead would
    // revert on validation with nothing in the message pointing at the cause.
    const sealed = await encrypt.run(parsed, ADDRESSES.payrollModule);
    if (!sealed) return;

    const hash = await tx.send({
      address: ADDRESSES.payrollModule,
      abi: payrollModuleAbi,
      functionName: "stagePayout",
      args: [recipient.trim() as `0x${string}`, sealed.handle, sealed.handleProof],
    });

    if (hash) {
      setRecipient("");
      setAmount("");
      encrypt.reset();
      onStaged();
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Recipient" hint="Public. Only the amount is confidential.">
        <Input
          value={recipient}
          onChange={setRecipient}
          placeholder="0x…"
          disabled={disabled || busy}
        />
      </Field>
      {recipient.trim() && !recipientValid && (
        <p className="text-cinnabar text-[13px]">That is not a valid address.</p>
      )}

      <Field
        label="Amount"
        hint="Encrypted in this browser before it is submitted. It is never sent anywhere in the clear."
      >
        <Input
          value={amount}
          onChange={setAmount}
          placeholder="2500.00"
          inputMode="decimal"
          disabled={disabled || busy}
        />
      </Field>
      {amount.trim() && parsed === null && (
        <p className="text-cinnabar text-[13px]">
          Enter an amount in cUSDC, e.g. 2500 or 2500.50.
        </p>
      )}

      <Button variant="primary" onClick={stage} disabled={!ready}>
        Seal payout
      </Button>

      {encrypt.busy && (
        <p className="text-wax mt-3 text-[13px]">Sealing the amount…</p>
      )}
      {encrypt.error && (
        <p className="text-cinnabar font-data mt-3 text-[12px] leading-5 break-words">
          {encrypt.error}
        </p>
      )}

      <TxStatus
        {...tx}
        done={`Payout sealed into batch #${batchId !== undefined ? String(batchId) : "—"}.`}
      />
    </div>
  );
}

/**
 * The staged batch, exactly as the chain holds it.
 *
 * This is the shot the demo holds on: a real ledger where every recipient is
 * legible and every amount is a bytes32. Nothing here is a placeholder — the
 * handles are read from `payoutAt`.
 */
function StagedList({
  batchId,
  count,
}: {
  batchId: bigint | undefined;
  count: bigint | undefined;
}) {
  const indices = useMemo(
    () => (count === undefined ? [] : Array.from({ length: Number(count) }, (_, i) => i)),
    [count],
  );

  const { data } = useReadContracts({
    contracts: indices.map((i) => ({
      address: ADDRESSES.payrollModule,
      abi: payrollModuleAbi,
      functionName: "payoutAt",
      args: [batchId!, BigInt(i)],
    })),
    query: { enabled: batchId !== undefined && indices.length > 0 },
  });

  if (!count || indices.length === 0) {
    return (
      <Note>
        Nothing staged in this batch yet. Each payout you seal is added here, and
        the whole batch is paid in one Safe transaction.
      </Note>
    );
  }

  return (
    <div>
      <div className="border-rule text-vellum-faint mb-1 grid grid-cols-[1fr_auto] gap-4 border-b pb-2 text-[12px] tracking-[0.01em]">
        <span>Recipient</span>
        <span>Amount</span>
      </div>
      <ul>
        {indices.map((i) => {
          const row = data?.[i]?.result as
            | readonly [`0x${string}`, `0x${string}`]
            | undefined;
          return (
            <li
              key={i}
              className="border-rule grid grid-cols-[1fr_auto] items-center gap-4 border-b py-3 last:border-b-0"
            >
              <span className="font-data text-graphite min-w-0 truncate text-[13px]">
                {row ? <AddressLink address={row[0]} /> : "—"}
              </span>
              {row ? <SealedHandle handle={row[1]} /> : <span>—</span>}
            </li>
          );
        })}
      </ul>
      <Note>
        <span className="mt-4 block">
          Recipients are public; amounts are handles. This is the whole claim, and
          it is verifiable in a block explorer — the same rows look identical
          there.
        </span>
      </Note>
    </div>
  );
}

/** executeBatch — onlySafe. The owners authorise the batch as a whole. */
function ExecuteBatch({
  batchId,
  count,
  onExecuted,
}: {
  batchId: bigint | undefined;
  count: bigint | undefined;
  onExecuted: () => void;
}) {
  const safe = useSafeExecute();

  const empty = !count || count === 0n;

  async function execute() {
    if (batchId === undefined) return;
    const hash = await safe.execute({
      to: ADDRESSES.payrollModule,
      abi: payrollModuleAbi,
      functionName: "executeBatch",
      args: [batchId],
    });
    if (hash) onExecuted();
  }

  return (
    <div className="space-y-4">
      <Stat label="Batch">
        #{batchId !== undefined ? String(batchId) : "—"}
      </Stat>
      <Stat label="Payouts">{count !== undefined ? String(count) : "—"}</Stat>
      <Stat label="Total">
        <span className="text-wax">sealed</span>
      </Stat>

      <Note>
        The Safe pays every payout in the batch in one transaction. No proof
        passes through the Safe — the module already holds validated handles, and
        the funds never leave the Safe until they land with a recipient.
      </Note>

      <Button variant="primary" onClick={execute} disabled={empty || safe.busy}>
        Execute as the Safe
      </Button>

      <TxStatus {...safe} copy={SAFE_COPY} done="Batch executed. Recipients can now read their own amounts." />
    </div>
  );
}

/**
 * grantAuditor — onlySafe. The credibility feature.
 *
 * Two things are stated in the UI rather than buried, because both are true and
 * a treasury tool that hid them would deserve the distrust:
 *
 *   - the grant covers PAYOUT handles for one batch, not recipients' balances.
 *     An auditor learns what each person was paid in this batch, not what they
 *     hold. Balance handles belong to the token and are not ours to give away.
 *   - the grant is PERMANENT. Nox has no ACL revocation today.
 */
function GrantAuditor({
  openBatchId,
  openBatchCount,
}: {
  openBatchId: bigint | undefined;
  openBatchCount: bigint | undefined;
}) {
  const [auditor, setAuditor] = useState("");
  const [batch, setBatch] = useState("");
  const safe = useSafeExecute();

  /**
   * Default to the most recent batch that actually HAS payouts, which is not
   * the open one after an execution: `executeBatch` advances `currentBatchId`,
   * so the open batch is empty and `grantAuditor` would revert `BatchEmpty`
   * every time. An auditor is nearly always asking about the batch that just
   * went out.
   */
  const defaultBatchId =
    openBatchId === undefined
      ? null
      : openBatchCount && openBatchCount > 0n
        ? openBatchId
        : openBatchId > 0n
          ? openBatchId - 1n
          : 0n;

  const effectiveBatch = batch.trim()
    ? /^\d+$/.test(batch.trim())
      ? BigInt(batch.trim())
      : null
    : defaultBatchId;

  const auditorValid = isAddress(auditor.trim());

  async function grant() {
    if (!auditorValid || effectiveBatch === null) return;
    const hash = await safe.execute({
      to: ADDRESSES.payrollModule,
      abi: payrollModuleAbi,
      functionName: "grantAuditor",
      args: [auditor.trim() as `0x${string}`, effectiveBatch],
    });
    if (hash) setAuditor("");
  }

  return (
    <div className="space-y-4">
      <Field label="Auditor address">
        <Input
          value={auditor}
          onChange={setAuditor}
          placeholder="0x…"
          disabled={safe.busy}
        />
      </Field>
      {auditor.trim() && !auditorValid && (
        <p className="text-cinnabar text-[13px]">That is not a valid address.</p>
      )}

      <Field
        label="Batch"
        hint={
          defaultBatchId !== null
            ? `Defaults to #${String(defaultBatchId)} — the most recent batch with payouts in it.`
            : undefined
        }
      >
        <Input
          value={batch}
          onChange={setBatch}
          placeholder={defaultBatchId !== null ? String(defaultBatchId) : "0"}
          inputMode="numeric"
          disabled={safe.busy}
        />
      </Field>
      {batch.trim() && effectiveBatch === null && (
        <p className="text-cinnabar text-[13px]">Enter a batch number.</p>
      )}

      <Note>
        Grants this address the right to decrypt every payout amount in the batch
        — what each person was paid, not what they hold. The grant is authorised
        by the Safe, recorded on chain as <code>AuditorGranted</code>, and{" "}
        <span className="text-vellum-dim">permanent</span>: Nox has no way to
        revoke access once given.
      </Note>

      <Button
        onClick={grant}
        disabled={!auditorValid || effectiveBatch === null || safe.busy}
      >
        Grant as the Safe
      </Button>

      <TxStatus {...safe} copy={SAFE_COPY} done="Auditor granted. The disclosure is itself on chain." />
    </div>
  );
}
