// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, externalEuint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";
import "encrypted-types/EncryptedTypes.sol";

/**
 * HelloNox — Phase 0 stop-gate for Confide.
 *
 * This contract exists to answer three questions before any product code is
 * written. If any of them fails, the 12-day plan is not viable and we find out
 * on day one instead of day eight.
 *
 *  Q1. Does Nox work at all on Ethereum Sepolia (11155111)?
 *      → storeAsSelf()  : the ordinary path, owner == msg.sender.
 *
 *  Q2. Can a proof be validated when the CALLER is not the ENCRYPTOR?
 *      → storeForOwner(): the Safe-routed path.
 *
 *      This is the architectural crux of Confide. Nox.fromExternal() hardcodes
 *      msg.sender as the proof owner, so it cannot be used when a Safe executes
 *      a transaction on behalf of the admin who encrypted the value. We bypass
 *      the library helper and call INoxCompute.validateInputProof() directly,
 *      which accepts `owner` as an explicit parameter.
 *
 *  Q3. Do TEE compute ops (add / le) work on Sepolia?
 *      → checkBudget()  : gates the keeper feature (Phase 3.5).
 */
contract HelloNox {
    euint256 public stored;
    ebool    public withinBudget;

    event Stored(address indexed caller, address indexed owner);
    event BudgetChecked(address indexed caller);

    // ── Q1 ── Ordinary path: the caller is the one who encrypted the value.
    function storeAsSelf(externalEuint256 handle, bytes calldata proof) external {
        euint256 value = Nox.fromExternal(handle, proof);

        Nox.allowThis(value);
        Nox.allow(value, msg.sender);
        Nox.allowPublicDecryption(value); // Phase 0 only — proves the round trip.

        stored = value;
        emit Stored(msg.sender, msg.sender);
    }

    // ── Q2 ── Safe-routed path: `owner` encrypted the value, msg.sender executes.
    //
    // Note we take a raw bytes32 rather than externalEuint256: we are calling
    // NoxCompute directly, so there is no library wrapper to unwrap it for us.
    function storeForOwner(address owner, bytes32 handle, bytes calldata proof) external {
        INoxCompute(Nox.noxComputeContract()).validateInputProof(
            handle,
            owner,
            proof,
            TEEType.Uint256
        );

        euint256 value = euint256.wrap(handle);

        Nox.allowThis(value);
        Nox.allow(value, owner);
        Nox.allowPublicDecryption(value); // Phase 0 only.

        stored = value;
        emit Stored(msg.sender, owner);
    }

    // ── Q3 ── TEE compute: accumulate encrypted amounts, compare against an
    // encrypted cap, and publish ONLY the resulting boolean. This is the shape
    // the Confide keeper uses to enforce a budget it cannot read.
    function checkBudget(
        externalEuint256 amountA,
        bytes calldata proofA,
        externalEuint256 amountB,
        bytes calldata proofB,
        externalEuint256 cap,
        bytes calldata proofCap
    ) external {
        euint256 a      = Nox.fromExternal(amountA, proofA);
        euint256 b      = Nox.fromExternal(amountB, proofB);
        euint256 budget = Nox.fromExternal(cap, proofCap);

        euint256 total  = Nox.add(a, b);
        ebool    result = Nox.le(total, budget);

        Nox.allowThis(result);
        Nox.allowPublicDecryption(result); // only one bit ever escapes

        withinBudget = result;
        emit BudgetChecked(msg.sender);
    }
}
