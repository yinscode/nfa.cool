# M01–M06 execution

## M01 — current Sepolia preflight (2026-11-12)

Live preflight verified testnet registry `nfagent-registry-0e9b2a.testnet`,
`nfa-2`, its stable vault/controller, current owner, configured reporter's local
key against a live FullAccess key, no pending operations, Sepolia chain ID and
finalized-block RPC support. NEAR RPC recovered on this attempt.

The current address is `0xADfC9988d9A5ac351F7Cad7fc46D99B270A374c9`.
It has zero ETH and nonce zero. M02 is waiting for 0.005 Sepolia test ETH at
this verified address; no funding was requested for the old one-use vault.
The preflight is read-only and does not claim live transfer acceptance.

Evidence: [m01-preflight.json](evidence/m01-preflight.json).

## M02 — pending test ETH

The typed submission/reporter worker is implemented and locally tested. The
new live request, pending-sale rejection, handover and buyer repeat transfer
remain open until the current NFA has test ETH.

## M03 — in progress

Adding a separately typed research configuration, runtime-bound secret reference,
service dispatch and per-NFA USD usage reservations without changing the old
contract state layout. Existing Scout/Compare and one Project per NFA remain.

## M04–M06 — pending

WASI runtime, memory/billing acceptance and hosted paid research/demo follow.
Research is not advertised as hosted until real acceptance passes.
