# M01–M06 execution

## M01 — current Sepolia preflight (2026-11-12)

Live preflight verified testnet registry `nfagent-registry-0e9b2a.testnet`,
`nfa-2`, its stable vault/controller, current owner, configured reporter's local
key against a live FullAccess key, no pending operations, Sepolia chain ID and
finalized-block RPC support. NEAR RPC recovered on this attempt.

The current address is `0xADfC9988d9A5ac351F7Cad7fc46D99B270A374c9`.
The user funded this address with 0.1 Sepolia ETH; the funded preflight passed.
No funding was requested for the old one-use vault.
The preflight is read-only and does not claim live transfer acceptance.

Evidence: [m01-preflight.json](evidence/m01-preflight.json).

## M02 — live acceptance in progress

The first bounded self-transfer mined successfully and pending sale was rejected.
The worker retains the lock until the trusted RPC finalized head includes it.
Both demo transfers return ETH to the same funded NFA; only gas leaves it.
Handover and buyer repeat transfer follow settlement.

## M03 — implemented and rehearsed

Typed research configuration, runtime-bound secret reference, service dispatch
and per-NFA USD reservations are implemented without changing the root state
layout. Existing Scout/Compare and one Project per NFA remain. The exact deployed
registry bytes were upgraded in an isolated NEAR sandbox. Its old vault was
rejected before guardian upgrade, then its status was preserved and the owner
explicitly verified the new interface. 67 JavaScript and 56 contract tests pass.
Evidence: [m03-upgrade-rehearsal.json](m03-upgrade-rehearsal.json).

## M04–M06 — pending

WASI runtime, memory/billing acceptance and hosted paid research/demo follow.
Research is not advertised as hosted until real acceptance passes.
