"use client";

/** Shared app chrome: wallet connection, chain guard, navigation. */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN_ID } from "@/lib/chain";
import { truncateAddress } from "@/lib/format";

const NAV = [
  { href: "/treasury", label: "Treasury" },
  { href: "/stage", label: "Payroll" },
  { href: "/view", label: "Disclosure" },
];

export function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  if (!isConnected) {
    const connector = connectors[0];
    return (
      <button
        disabled={!connector || isPending}
        onClick={() => connector && connect({ connector })}
        className="border-rule-strong hover:border-wax hover:text-wax rounded-input cursor-pointer border px-3 py-1.5 font-data text-[12px] transition-colors duration-100 disabled:opacity-40"
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  }

  // Wrong-chain is a hard stop, not a warning. Rules.md §1.1 — Sepolia only.
  if (chainId !== CHAIN_ID) {
    return (
      <button
        onClick={() => switchChain({ chainId: CHAIN_ID })}
        className="border-cinnabar text-cinnabar rounded-input cursor-pointer border px-3 py-1.5 font-data text-[12px]"
      >
        Switch to Sepolia
      </button>
    );
  }

  return (
    <button
      onClick={() => disconnect()}
      title="Disconnect"
      className="border-rule text-vellum-dim hover:border-rule-strong hover:text-vellum rounded-input cursor-pointer border px-3 py-1.5 font-data text-[12px] transition-colors duration-100"
    >
      {truncateAddress(address!)}
    </button>
  );
}

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-rule sticky top-0 z-50 border-b bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1120px] items-center gap-8 px-6">
        <Link href="/" className="text-display text-[17px] tracking-tight">
          Confide
        </Link>
        <nav className="flex flex-1 items-center gap-6">
          {NAV.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`text-[13px] transition-colors duration-100 ${
                  active ? "text-vellum" : "text-vellum-faint hover:text-vellum-dim"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <WalletButton />
      </div>
    </header>
  );
}

/** Standard screen shell — ledger field, nav, centred column. */
export function Screen({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ledger-field relative min-h-screen">
      <div className="relative z-10">
        <Nav />
        <main className="mx-auto max-w-[1120px] px-6 py-12">
          <h1 className="text-display mb-2 text-[28px]">{title}</h1>
          {lede && <p className="text-vellum-dim mb-10 max-w-[62ch] text-[15px]">{lede}</p>}
          {children}
        </main>
      </div>
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-rule bg-ink-raised rounded-card border p-6 ${className}`}>
      {children}
    </div>
  );
}

/** Every state that isn't "connected on Sepolia" resolves to an invitation. */
export function ConnectGate({ children }: { children: React.ReactNode }) {
  const { isConnected, chainId } = useAccount();

  if (!isConnected) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <p className="text-vellum-dim text-[15px]">
          Connect a wallet on Ethereum Sepolia to continue.
        </p>
        <WalletButton />
      </Card>
    );
  }
  if (chainId !== CHAIN_ID) {
    return (
      <Card className="flex flex-col items-start gap-4">
        <p className="text-vellum-dim text-[15px]">
          Confide runs on Ethereum Sepolia only. Switch networks to continue.
        </p>
        <WalletButton />
      </Card>
    );
  }
  return <>{children}</>;
}
