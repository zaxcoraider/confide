// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {
    ERC20ToERC7984Wrapper
} from "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/**
 * ConfidentialUSDC — the confidential leg of Confide's treasury.
 *
 * An ERC-7984 wrapper over real Circle USDC on Ethereum Sepolia
 * (0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238, 6 decimals). Deposit public
 * USDC, receive a confidential balance held as an encrypted Nox handle.
 *
 * This is deliberately thin. `ERC20ToERC7984Wrapper` already implements the
 * whole wrap/unwrap lifecycle against optimized Nox primitives, and Rules.md
 * forbids reimplementing what a library provides. All this contract does is
 * name the token and bind the underlying.
 *
 * WHY THIS SHAPE IS THE PRIVACY CLAIM
 * ----------------------------------
 * Confide claims the treasury TOTAL is public while individual payouts are
 * private, and this contract is what makes that true rather than aspirational:
 *
 *   - PUBLIC:  `inferredTotalSupply()` is just `USDC.balanceOf(address(this))`,
 *              an ordinary ERC-20 read. Anyone can audit the total backing.
 *   - PRIVATE: `confidentialBalanceOf(account)` returns an encrypted handle.
 *              Only the holder can decrypt it — on mint the base contract calls
 *              `Nox.allow(newBalance, to)`, granting exactly one party access.
 *
 * Note `confidentialTotalSupply()` is encrypted and only ever `allowThis`-ed.
 * That is fine and intentional: the auditable total comes from the underlying
 * ERC-20 balance, not from the encrypted supply counter.
 *
 * API NOTE (verified against package source, do not trust the plan)
 * ----------------------------------------------------------------
 * `Phases.md` assumed `wrap(uint256)`. The real signature in version 0.2.2 of
 * nox-confidential-contracts is `wrap(address to, uint256 amount)`, and it
 * requires an ERC-20 approve to this contract first. It returns the minted
 * `euint256` handle and grants the caller only TRANSIENT access to it
 * (`Nox.allowTransient`), so the value must be read back via
 * `confidentialBalanceOf` rather than from the return value of a later call.
 * Amounts are `euint256`, not the `euint64` OpenZeppelin's version uses, so no
 * rate/compression is needed for 6-decimal USDC.
 */
contract ConfidentialUSDC is ERC20ToERC7984Wrapper {
    constructor(
        IERC20 underlying
    ) ERC20ToERC7984Wrapper("Confidential USDC", "cUSDC", "", underlying) {}
}
