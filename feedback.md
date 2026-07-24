# Feedback — building Confide on iExec Nox

Recorded **as it happened**, from the first spike through a verified end-to-end
run on Ethereum Sepolia. Nothing here is reconstructed after the fact.

Confide is a Safe Module that pays confidential salaries from a Safe treasury.
That shape — a **contract executing a proof created by a different account**,
with a **multisig** in the middle and a **browser** at the front — turned out to
exercise corners of Nox that a single-EOA demo never reaches. Most of what
follows comes from those corners.

Every item below was hit in practice. Where we found a workaround, it is given.

---

## 1. The two that cost the most

### 1.1 `decrypt` has zero clock-skew tolerance, and says so in the language of auth

**This is our headline item.** It cost a full debugging cycle, and it is
invisible to anyone whose clock happens to be correct — so it will hit users
unpredictably and look like a credentials bug.

User decryption signs an EIP-712 `DataAccessAuthorization` whose `notBefore` is
`Math.floor(Date.now() / 1000)` — the **client's** wall clock, with no tolerance
whatsoever. A machine ~20 s fast (utterly routine) presents a token the gateway
considers not-yet-valid and receives:

```
401 Unauthorized: token is not active or expired
```

That message names credentials. The cause is time. Nothing in it points at the
clock.

**Retrying cannot fix it.** Every attempt mints a *fresh* token carrying the same
bad `notBefore`. We burned 91 s of polling proving this. The SDK's own 401
self-heal is also unreachable on a first decrypt: it regenerates and retries only
`if (!isFreshDecryptionMaterial)`, and fresh material already has that flag set.

Measured, not theorised — `scripts/diagnose-clock.ts` in this repo is the
reproduction. On a machine 19.3 s fast, an ordinary decrypt failed and the
identical decrypt with `Date.now` shifted back succeeded, returning correct
plaintext.

**It is strictly worse in a browser, where the client cannot even diagnose it.**
Our Node workaround measures skew from the gateway's `Date` response header. That
is **impossible from a browser**: `Date` is not a CORS-safelisted response
header, so `res.headers.get("date")` returns `null` on every cross-origin
response. A web integration therefore gets a bare 401, no means of discovering
that time is involved, and no way to self-correct. Our frontend now backdates
blindly on the 401 itself, escalating 5 → 15 → 30 minutes, because guessing was
the only option left. An SDK should not force that.

**Asks:**

1. Backdate `notBefore` by a default tolerance in the SDK. 60 s would eliminate
   almost the entire failure class in one line.
2. Have the gateway apply its own leeway, and when it does reject on time
   grounds, **say so** — name clock skew and return the server's current time.
3. Return the server time **in the 401 body**. This fixes every client, browser
   included, with no CORS work at all.
4. Failing 3, send `Access-Control-Expose-Headers: Date` so a browser can at
   least measure the skew itself.
5. Make the 401 self-heal reachable on a first decrypt — though note it only
   helps if the regenerated token differs, which today it does not.

### 1.2 `publicDecrypt` reports an RPC sync race as a permission error

The single costliest piece of friction in the contract phase. Called shortly
after the transaction that marked a handle, it throws:

```
Handle (0x…) does not exist or is not publicly decryptable
```

That message describes an ACL failure. The actual cause is that the SDK's
**on-chain precheck** — a `readContract` of `NoxCompute.isPubliclyDecryptable` —
was served by a load-balanced public RPC node that had not yet imported the block
just mined.

We initially misdiagnosed this as an HTTP 403 from the gateway and spent a
session on the wrong hypothesis. **It is not an HTTP error at all.**

The precheck is also the one part that races, and it is the one part with no
retry: the SDK's internal `retry()` wraps only the subsequent gateway fetch.

**Fix that worked:** `confirmations: 2` on every write receipt. With it, our own
retry loop never fired again.

**Asks:**

1. Wrap the precheck in the same `retry()` that already wraps the gateway fetch.
2. Distinguish "the flag reads false at this block" from "this handle was never
   marked" — reporting the block number read at would make the timing nature
   visible immediately.
3. Document that reads following a write need confirmations. Nothing upstream
   hints at this, and it is the entire fix.

---

## 2. SDK (`@iexec-nox/handle`)

### 2.1 The barrel makes an *optional* peer dependency mandatory under any bundler

`dist/esm/index.js` eagerly re-exports `createEthersHandleClient`, which
statically imports `BrowserProvider` from `ethers`. Both `ethers` and `viem` are
declared **optional** peers — you are meant to pick one — but a bundler resolves
the whole import graph regardless of which factory you call, so a viem-only app
fails to build:

```
Module not found: Can't resolve 'ethers'
```

It does not surface in Node, because `tsx` resolves lazily. It bites the first
time you build a frontend, which is exactly when you are least expecting a
packaging problem.

Deep-importing the viem factory is **not** possible either: the `exports` map
only exposes `"."`.

**Workaround:** alias `ethers` to a throwing stub (`lib/stubs/ethers.ts`, wired in
`next.config.ts`), so the unreachable code stays unreachable and says so if it
ever isn't.

**Asks:** publish subpath exports (`@iexec-nox/handle/viem`, `/ethers`) so each
adapter is opt-in; **or** have the factories import their provider lazily inside
the function body.

### 2.2 `encryptInput`'s `owner` is not overridable, and this is the biggest architectural constraint in the SDK

`encryptInput.ts` sets `owner = await blockchainService.getAddress()`. There is no
parameter to override it.

This is not a small detail — it dictates the entire shape of any application
where the encryptor and the caller differ, which includes **every multisig
integration**. We designed around it (staging happens from the admin EOA
directly; the Safe only authorises already-sealed batches), and the constraint
ultimately became the product's propose→approve→execute lifecycle. But we
discovered it by reading package source, not documentation.

**Ask:** state it prominently in the docs, with the multisig implication spelled
out.

### 2.3 A decrypted value comes back with no link to the handle it came from

`decrypt` returns the plaintext alone. Handles are **mutable per balance** — a
balance handle changes every time the balance does — so any UI that caches a
decryption keys it wrong by default, and will happily render a *fresh* handle
beside a *stale* amount. That is a silently-wrong confidential UI: it asserts a
decryption that never happened.

We hit exactly this and now track the originating handle alongside every value.

**Ask:** return the handle alongside the value, or state plainly in the docs that
maintaining the pairing is the caller's responsibility.

### 2.4 Restricted input types

`encryptInput` supports only `bool, uint16, uint256, int16, int256`. Worth
stating up front — it is discoverable only by trying.

---

## 3. Contracts (`nox-protocol-contracts`, `nox-confidential-contracts`)

### 3.1 `Nox.fromExternal()` is unusable for any contract-to-contract or multisig flow

It hardcodes `msg.sender` as the owner it validates against:

```solidity
_noxComputeContract().validateInputProof(handle, msg.sender, handleProof, TEEType.Uint256);
```

So a contract executing a proof an EOA created always reverts `"Owner mismatch"`.
Stock `ERC7984Base.confidentialTransfer()` inherits the same limitation.

**The workaround is undocumented anywhere upstream.** Call the interface directly,
which *does* take an explicit owner:

```solidity
INoxCompute(Nox.noxComputeContract()).validateInputProof(handle, owner, proof, TEEType.Uint256);
euint256 value = euint256.wrap(handle);
```

We proved this works on Sepolia before committing to the architecture. Without
it, this project would not exist in its current form.

**Ask:** document the escape hatch, and ideally add a `fromExternalFor(handle,
owner, proof)` overload so it is discoverable from the library itself.

### 3.2 The ACL grants a TEE operation needs are unguessable

**Nothing states that the contract which *executes* an operation needs access to
the input handles — not merely the caller that supplied them.**

Paying from a Safe module needs **three** grants:

```solidity
Nox.allowThis(amount);     // the module, to read it back later
Nox.allow(amount, safe);   // the Safe — it is the caller of the token
Nox.allow(amount, token);  // the TOKEN — it executes the TEE operation
```

The third is invisible unless you read `ERC7984Base` line by line, because in the
library's own path it happens implicitly: the proof-taking `confidentialTransfer`
overload runs `Nox.fromExternal` *inside* the token, granting it transient access
as a side effect. Any integration that validates the proof elsewhere — as ours
must, per 3.1 — never receives that implicit grant.

**Missing it reverted a whole batch**, with no usable diagnostic (see 3.3).

**Asks:** state the rule plainly in the ACL docs, and have `NoxCompute` revert
with a named error identifying **which address** lacked access to **which
handle**.

### 3.3 ERC-7984 transfers clamp to zero instead of reverting

On insufficient balance, `Nox.select(success, amount, 0)` means a transfer moves
**nothing** and the transaction still succeeds. Combined with 3.2, a
misconfigured integration mines cleanly and pays nobody.

We now assert on **decrypted deltas**, never on transaction success. That is the
right discipline regardless, but it should not be the only line of defence.

**Ask:** offer a strict-mode transfer that reverts, so failures are loud.

### 3.4 Version and toolchain traps

- **`nox-protocol-contracts@0.2.2` silently lacks Ethereum Sepolia.**
  `noxComputeContract()` does not know chain 11155111 and reverts
  `"Nox: Unsupported chain"` — **at runtime**, not at compile time.
- **`0.2.4` raised its pragma to `^0.8.35`** (from `^0.8.27`). This is the *same*
  Solidity-version-mismatch friction reported in the previous hackathon's
  feedback — still unresolved, and now a wider gap.
- **Hardhat's bundled solc list rejects 0.8.35** as "not released yet" even though
  it is on npm. Recovery is `npx hardhat clean --global`, which is not
  discoverable from the error.
- **`0.2.4` silently moved `contracts/shared/` → `contracts/utils/`**
  (`TypeUtils.sol`, `HandleUtils.sol`). No migration note; the failure is an
  opaque Hardhat resolver error.
- **`@iexec-nox/handle` below `beta.13` has no ETH Sepolia entry** in
  `NETWORK_CONFIGS`.

**Ask:** a compatibility matrix — SDK version × contracts version × supported
chains × required solc — would have saved every one of these.

### 3.5 `wrap()` ergonomics

`wrap(address to, uint256 amount)` requires a prior ERC-20 `approve`, and returns
a handle the caller holds only **transiently** — read the balance back via
`confidentialBalanceOf` rather than trusting the returned value. Neither is
apparent from the interface.

**Ask:** a `permit`-based wrapper, or docs stating the transient-access lifetime.

---

## 4. Docs and onboarding

- **`nox-hardhat-starter`, linked from the official brief, is a 404.** That repo
  does not exist. This is the first link a participant follows.
- **`nox-hardhat-plugin` exists on GitHub but is not published to npm**, so it
  cannot be installed the way its README implies.
- Docs moved to `docs.noxprotocol.io` without the brief being updated.

These are cheap to fix and they shape the first hour of every participant's
experience.

---

## 5. A theme: errors name the wrong layer

Four separate failures cost us disproportionate time for the same reason — **the
error described a different subsystem than the one that failed**:

| Actual cause | What the error said |
|:--|:--|
| RPC node lagging a block | "not publicly decryptable" — an ACL failure |
| Client clock 20 s fast | "token is not active or expired" — an auth failure |
| Token lacked handle access | an opaque Safe revert with no reason at all |
| Insufficient balance | *nothing* — the transaction succeeded and moved zero |

Individually each is a small wording issue. Together they are the dominant cost
of building on Nox today, because they send you to the wrong layer and you lose
the session before you even start on the real cause.

**The single highest-leverage improvement would be error messages that name the
layer that actually failed, and include the state they observed** — the block
they read at, the server's clock, the address that lacked access, the handle in
question.

---

## 6. What worked well

Not a courtesy section — these genuinely removed risk:

- **The TEE compute primitives are the good part.** `Nox.add`, `Nox.le` and
  `Nox.select` work on Sepolia and make homomorphic logic feel ordinary. Being
  able to compute over encrypted values *inside a contract*, and publish only a
  boolean, is a genuinely different capability.
- **`validateInputProof` taking an explicit `owner`** is the hook that makes
  multisig-shaped applications possible at all. It only needs documenting.
- **ERC-7984 integrates cleanly with unmodified Safe.** We enabled a module on a
  canonical Safe and moved confidential balances through
  `execTransactionFromModule` with no forking or patching of anything.
- **`euint256` matches ERC-20 semantics directly**, so 6-decimal USDC needed no
  rate or compression layer — a real simplification over fixed-width alternatives.
- **Handle headers are self-describing.** `[0]` version, `[1-4]` chain id, `[5]`
  TEE type, `[6]` attributes, `[7-31]` digest. Once we decoded that, debugging
  got substantially easier — and it makes a fabricated handle obvious at a glance.

---

## 7. Not Nox's bug, but it compounds one

`Safe.execTransactionFromModule` returns `success = false` rather than bubbling
the inner revert reason. Every ACL failure in §3.2 therefore surfaces as an
opaque Safe revert with no clue as to cause. Nox cannot fix this — but named,
specific `NoxCompute` errors would survive the loss of the revert *string*, since
the failure would at least be attributable before it crosses the Safe boundary.
