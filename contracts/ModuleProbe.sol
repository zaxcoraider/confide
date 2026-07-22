// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {INoxCompute} from "@iexec-nox/nox-protocol-contracts/contracts/interfaces/INoxCompute.sol";
import {TEEType} from "@iexec-nox/nox-protocol-contracts/contracts/utils/TypeUtils.sol";
import "encrypted-types/EncryptedTypes.sol";

interface ISafe {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success);
}

/**
 * PokeTarget — records who called it.
 *
 * The whole point of Phase 0.5 is proving the SAFE executed, not the module.
 * `lastCaller` is how we tell: if it equals the Safe address, the call really
 * went module -> Safe -> target rather than module -> target directly.
 */
contract PokeTarget {
    uint256 public count;
    address public lastCaller;

    function poke() external {
        count++;
        lastCaller = msg.sender;
    }
}

/**
 * ModuleProbe — Phase 0.5 stop-gate for Confide.
 *
 * Phase 0 proved (with a plain Forwarder standing in for the Safe) that
 * INoxCompute.validateInputProof accepts an explicitly-passed owner when the
 * caller is a contract. Phase 0.5 replaces the stand-in with a REAL Safe and
 * asks the two questions that decide the custody model:
 *
 *   Q4. Does a module enabled on a real Safe actually drive it?
 *       -> execFromSafe(): calls execTransactionFromModule and we check that
 *          PokeTarget.lastCaller == the Safe.
 *
 *   Q5. Does the Nox proof path still work from inside a module?
 *       -> stageForOwner(): same escape hatch as HelloNox, but this contract is
 *          a Safe module rather than a bare contract.
 *
 *   Q6. Can BOTH happen in one transaction?
 *       -> stageAndExec(): this is the shape PayrollModule needs — validate an
 *          admin-encrypted amount and move Safe-held funds in a single call.
 *          If Q6 passes, Option B (Safe holds the funds) is viable.
 *
 * Throwaway. Deleted in Phase 5 alongside HelloNox and Forwarder.
 */
contract ModuleProbe {
    address public immutable safe;
    euint256 public stored;

    event ExecutedFromSafe(bool success);
    event Staged(address indexed owner);

    constructor(address _safe) {
        safe = _safe;
    }

    // ── Q4 ── the module drives the Safe.
    function execFromSafe(address target, bytes calldata data) external {
        bool success = ISafe(safe).execTransactionFromModule(target, 0, data, 0);
        require(success, "execTransactionFromModule returned false");
        emit ExecutedFromSafe(success);
    }

    // ── Q5 ── proof validated from inside a module, owner passed explicitly.
    function stageForOwner(address owner, bytes32 handle, bytes calldata proof) external {
        _stage(owner, handle, proof);
        emit Staged(owner);
    }

    // ── Q6 ── both in one transaction. The PayrollModule shape.
    function stageAndExec(
        address owner,
        bytes32 handle,
        bytes calldata proof,
        address target,
        bytes calldata data
    ) external {
        _stage(owner, handle, proof);

        bool success = ISafe(safe).execTransactionFromModule(target, 0, data, 0);
        require(success, "execTransactionFromModule returned false");

        emit Staged(owner);
        emit ExecutedFromSafe(success);
    }

    function _stage(address owner, bytes32 handle, bytes calldata proof) private {
        INoxCompute(Nox.noxComputeContract()).validateInputProof(
            handle,
            owner,
            proof,
            TEEType.Uint256
        );

        euint256 value = euint256.wrap(handle);

        Nox.allowThis(value);
        Nox.allow(value, owner);
        Nox.allowPublicDecryption(value); // Phase 0.5 only — proves the round trip.

        stored = value;
    }
}
