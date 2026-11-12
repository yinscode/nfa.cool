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

## M02 — live acceptance passed

Both bounded self-transfers finalized on Sepolia and reconciled on NEAR testnet.
Pending sale was rejected, Alice purchased the NFT, the vault/address/Project
remained identical, and the old seller command failed. Nonce advanced twice and
no pending authority remained. Both transfers returned ETH to the same funded
NFA; only gas left it. Exact reporter transactions and finalized observations:
[evidence/m02-handover.json](evidence/m02-handover.json).

## M03 — implemented and rehearsed

Typed research configuration, runtime-bound secret reference, service dispatch
and per-NFA USD reservations are implemented without changing the root state
layout. Existing Scout/Compare and one Project per NFA remain. The exact deployed
registry bytes were upgraded in an isolated NEAR sandbox. Its old vault was
rejected before guardian upgrade, then its status was preserved and the owner
explicitly verified the new interface. 67 JavaScript and 56 contract tests pass.
Evidence: [m03-upgrade-rehearsal.json](m03-upgrade-rehearsal.json).

## M04 — built and pinned

The WASI P2 guest retains Scout/Compare, retrieves approved HTTPS sources and
calls one reviewed inference provider with bounded tokens/time/cost. The stable
vault predecessor is checked against runtime identity. Six native tests cover
idempotency, unknown model outcomes, citations and memory after a human signer
change. The same HTTP-capable component also ran Scout and Compare in the
existing disposable hosted probe Project; both matched the reviewed output
codec, and runtime/input/report-data bindings and actual compute charges were
checked. This is not vault-owned research acceptance. See
[evidence/m04-component-smoke.json](evidence/m04-component-smoke.json). The artifact and locked source hashes are recorded in
[evidence/m04-runtime.json](evidence/m04-runtime.json). Hosted Research remains
unavailable in public REST quotes until its real acceptance passes.

## M05 — local acceptance passed

An isolated NEAR sandbox ran paid research fixtures, refunded an unknown model
outcome, required owner resume, sold the NFT, rejected the old owner, recalled
old work for the buyer and supplied only finalized pre-sale work to a new job.
The vault and Project UUID persisted. Customer escrow and pending replenishment
ended at zero; native NEAR refunds/income and USD reservations stayed separate.
The guest tests cover durable attempt idempotency; 42 registry and 15 vault
native tests pass. See [evidence/m05-memory-billing.json](evidence/m05-memory-billing.json).
The receipt fixture does not execute WASI HTTP, a model or a TEE.

## M06 — hosted compatibility passed; model credential required

The rehearsed registry and vault bytes are deployed on NEAR testnet. A bounded
0.7 testNEAR transfer from the existing test funder covered additional registry
storage after the first deployment was definitively rejected for insufficient
storage balance. The funded retry used a separate signed transaction. Vault
state, Sepolia nonce/receipt and Project UUID were preserved.

The candidate is active in the same vault-owned Project. A real hosted job
returned NOT_STARTED without a model credential, credited the full customer
NEAR refund, and resumed only through the owner's explicit action. Scout and
Compare finalized on the new runtime; Alice recalled pre-sale Scout work under
that runtime. Runtime/input/report-data bindings and actual OutLayer compute
charges are recorded in [evidence/m06-preparation.json](evidence/m06-preparation.json).

M06 is **not complete**. Real model inference, research-specific buyer follow-up
and the final research demo remain. Public research quotes stay disabled while
the catalog is a candidate. Put a dedicated provider key, provider name and model
ID in the Git-ignored `.env.research` file; see
[RESEARCH-ACCEPTANCE.md](RESEARCH-ACCEPTANCE.md). No unrelated environment key is
used. Secret access is restricted to the stable vault predecessor and exact
reviewed WASM build. Public hosting remains deferred.
