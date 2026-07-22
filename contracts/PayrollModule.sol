// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import "encrypted-types/EncryptedTypes.sol";

/// @dev Minimal Safe surface. Only what a module needs.
interface ISafe {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success);
}

/// @dev Minimal ERC-7984 surface, as implemented by ConfidentialUSDC.
interface IConfidentialToken {
    function confidentialTransfer(address to, euint256 amount) external returns (euint256);
}

/**
 * PayrollModule — the core of Confide.
 *
 * A Safe Module that pays contributors confidential amounts out of a Safe's own
 * treasury. The treasury total stays publicly auditable; who is paid how much
 * does not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LIFECYCLE SPLIT — read Architecture.md §2 before touching this
 *
 * Nox binds every encrypted input to BOTH the application contract and the
 * owner that encrypted it. `encryptInput()` hardcodes that owner to the
 * connected signer, and `Nox.fromExternal()` hardcodes `msg.sender` as the
 * owner it validates against. So a proof created by an admin EOA CANNOT be
 * validated in a call whose `msg.sender` is the Safe — it reverts with
 * "Owner mismatch".
 *
 * The design turns that constraint into the product:
 *
 *   stagePayout   admin EOA, called DIRECTLY   proof required, msg.sender == owner
 *   executeBatch  the Safe, m-of-n approved    NO proof — the module already
 *                                              owns the handles
 *
 * which is exactly multisig semantics: propose (one person, sealed) → approve
 * (m-of-n) → execute. No proof-bound call ever routes through the Safe.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SAFE, NOT THIS MODULE, MOVES THE MONEY  (custody Option B)
 *
 * `ERC7984.confidentialTransfer(to, amount)` requires
 * `Nox.isAllowed(amount, msg.sender)` and debits `msg.sender`'s OWN balance.
 * The cUSDC belongs to the Safe, so the Safe must be the caller. Hence:
 *
 *   1. `stagePayout` grants the Safe persistent access to the amount handle
 *      (`Nox.allow(amount, safe)`) at staging time — without this the Safe
 *      cannot spend a handle the module validated.
 *   2. `executeBatch` calls `execTransactionFromModule`, so the SAFE calls the
 *      token and the debit lands on the Safe's balance.
 *
 * Funds never leave the Safe until they land with a recipient. Phase 0.5 Q6
 * proved this shape works on Sepolia.
 *
 * NOTE ON RECIPIENT VISIBILITY: a recipient decrypts their own cUSDC BALANCE,
 * which the token grants them on transfer (`Nox.allow(newToBalance, to)`). The
 * per-payout handle stays module/Safe-scoped until an auditor is granted it in
 * Phase 3.
 */
contract PayrollModule {
    struct Payout {
        address recipient;
        euint256 amount;
    }

    /// @dev The Safe that custodies the funds and authorises execution.
    address public immutable safe;

    /// @dev The confidential token being paid out (ConfidentialUSDC).
    address public immutable token;

    /// @dev The EOA permitted to stage payouts. Must be the address that
    /// encrypts amounts, since Nox binds each proof to its encryptor.
    address public immutable admin;

    /// @dev The batch currently open for staging. Advances once executed.
    uint256 public currentBatchId;

    mapping(uint256 batchId => Payout[]) private _payouts;
    mapping(uint256 batchId => bool) public executed;

    error OnlyAdmin(address caller);
    error OnlySafe(address caller);
    error BatchAlreadyExecuted(uint256 batchId);
    error BatchEmpty(uint256 batchId);
    error InvalidRecipient();
    error SafeExecutionFailed(uint256 batchId, uint256 index);

    /// @dev Amounts are deliberately absent from every event — they are the secret.
    event PayoutStaged(uint256 indexed batchId, address indexed recipient, uint256 index);
    event BatchExecuted(uint256 indexed batchId, uint256 count);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert OnlyAdmin(msg.sender);
        _;
    }

    modifier onlySafe() {
        if (msg.sender != safe) revert OnlySafe(msg.sender);
        _;
    }

    constructor(address _safe, address _token, address _admin) {
        safe = _safe;
        token = _token;
        admin = _admin;
    }

    // ── Propose ───────────────────────────────────────────────────────────────

    /**
     * Stage one encrypted payout into the open batch.
     *
     * MUST be called by the admin EOA directly. `Nox.fromExternal` validates the
     * proof against `msg.sender`, and the SDK bound the proof to whoever called
     * `encryptInput`, so routing this through the Safe would revert with
     * "Owner mismatch". That is by design, not a limitation to work around.
     *
     * @param recipient who gets paid. Public — only the AMOUNT is secret.
     * @param encryptedAmount handle from `encryptInput(amount, "uint256", <this contract>)`
     * @param inputProof the matching proof
     */
    function stagePayout(
        address recipient,
        externalEuint256 encryptedAmount,
        bytes calldata inputProof
    ) external onlyAdmin returns (uint256 batchId, uint256 index) {
        if (recipient == address(0)) revert InvalidRecipient();

        batchId = currentBatchId;
        if (executed[batchId]) revert BatchAlreadyExecuted(batchId);

        euint256 amount = Nox.fromExternal(encryptedAmount, inputProof);

        // Persist access for EVERY party that touches this handle later.
        // Transient access from validateInputProof dies at the end of this
        // transaction, and executeBatch runs in a LATER one.
        //
        // All three grants are load-bearing:
        Nox.allowThis(amount); //  1. the module, to read it back in executeBatch
        Nox.allow(amount, safe); //  2. the SAFE, for confidentialTransfer's
        //     `require(Nox.isAllowed(amount, msg.sender))` — the Safe is the caller
        Nox.allow(amount, token); // 3. the TOKEN itself
        //
        // Grant 3 is the non-obvious one and cost us a reverted batch. Nox ACL
        // authorises the CONTRACT THAT EXECUTES a TEE op, not just the caller
        // that supplied the handle. `confidentialTransfer` internally runs
        // `Nox.transfer(fromBalance, toBalance, amount)` with the token as
        // msg.sender, so NoxCompute checks the TOKEN's access to `amount`.
        //
        // In the library's own flow this is invisible: `confidentialTransfer`'s
        // proof-taking overload calls `Nox.fromExternal` inside the token, which
        // grants the token transient access as a side effect. Confide validates
        // the proof in the MODULE instead (it must — see the lifecycle split
        // above), so the token never receives that implicit grant and we have to
        // make it explicit.

        index = _payouts[batchId].length;
        _payouts[batchId].push(Payout({recipient: recipient, amount: amount}));

        emit PayoutStaged(batchId, recipient, index);
    }

    // ── Approve + execute ─────────────────────────────────────────────────────

    /**
     * Execute every payout in a batch. Callable ONLY by the Safe, so the m-of-n
     * owner approval is the authorisation.
     *
     * No proof is involved: the module already owns validated handles, which is
     * precisely why this call can route through the Safe when staging cannot.
     *
     * Each payout is executed via `execTransactionFromModule`, making the SAFE
     * the caller of the token so the debit hits the Safe's own balance.
     */
    function executeBatch(uint256 batchId) external onlySafe {
        if (executed[batchId]) revert BatchAlreadyExecuted(batchId);

        Payout[] storage payouts = _payouts[batchId];
        uint256 count = payouts.length;
        if (count == 0) revert BatchEmpty(batchId);

        // Mark executed before the external calls — this is the reentrancy
        // guard. executeBatch reenters the Safe, which is exactly the path an
        // attacker would try to loop.
        executed[batchId] = true;
        if (batchId == currentBatchId) currentBatchId = batchId + 1;

        for (uint256 i = 0; i < count; i++) {
            Payout storage payout = payouts[i];

            bool success = ISafe(safe).execTransactionFromModule(
                token,
                0,
                abi.encodeCall(
                    IConfidentialToken.confidentialTransfer,
                    (payout.recipient, payout.amount)
                ),
                0 // Operation.Call — never DelegateCall from a module
            );
            if (!success) revert SafeExecutionFailed(batchId, i);
        }

        emit BatchExecuted(batchId, count);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function payoutCount(uint256 batchId) external view returns (uint256) {
        return _payouts[batchId].length;
    }

    /// @dev Returns the encrypted handle. Opaque unless the caller was granted access.
    function payoutAt(
        uint256 batchId,
        uint256 index
    ) external view returns (address recipient, euint256 amount) {
        Payout storage payout = _payouts[batchId][index];
        return (payout.recipient, payout.amount);
    }
}
