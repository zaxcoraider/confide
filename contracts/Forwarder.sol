// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

interface IHelloNox {
    function storeForOwner(address owner, bytes32 handle, bytes calldata proof) external;
}

/**
 * Forwarder — spike harness only. Delete after Phase 0.
 *
 * Stands in for a Safe: it calls HelloNox on behalf of an EOA, so that from
 * HelloNox's perspective `msg.sender` is a contract while the proof owner is a
 * human EOA. If HelloNox.storeForOwner() succeeds through this Forwarder, the
 * same call will succeed through a real Safe via execTransactionFromModule.
 */
contract Forwarder {
    function forward(
        address target,
        address owner,
        bytes32 handle,
        bytes calldata proof
    ) external {
        IHelloNox(target).storeForOwner(owner, handle, proof);
    }
}
