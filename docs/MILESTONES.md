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

## M06 — paid Research acceptance passed on testnet

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

M06's paid Research acceptance passed on testnet with the later HTTPS path.
Seller job `48` and buyer job `51` both finalized with priced NEAR AI usage,
output commitments and NFA income. Between them, Alice sold the NFA to Bob;
the vault, Sepolia address and OutLayer Project UUID persisted. Bob's hosted
recall matched job `48`'s output, and his signed paid continuation included
that finalized work commitment. The exact active guest is verified in the
release catalog and a live read-only Research quote reports available. See
[RESEARCH-ACCEPTANCE.md](RESEARCH-ACCEPTANCE.md),
[seller evidence](evidence/paid-async-research-seller.json),
[sale and recall](evidence/async-research-handover.json), and
[buyer evidence](evidence/paid-async-research-buyer-accepted.json).
The operator remains trusted for hosted HTTPS result observation; OutLayer
attestation is not verified on-chain. Public hosting remains deferred.

## Reviewed rollout — 2026-11-13

The registry and both vaults were upgraded on NEAR testnet to the reviewed
hashes. A one-time migration initialized **0.11580012 NEAR** of prior customer
credits, seller proceeds and unclaimed income; the local upgrade rehearsal
also covered an outstanding legacy escrow. Pre/post checks preserved both
NFT identities, vaults, `nfa-2`'s Sepolia address and Project UUID, balances,
and vault state. A later hosted recall read pre-upgrade Scout work. See
[liability-upgrade-rehearsal.json](evidence/liability-upgrade-rehearsal.json) and
[reviewed-testnet-rollout.json](evidence/reviewed-testnet-rollout.json).
After subsequent live jobs and the security-test sale, a read-only scan of all
stored payout and income rows reconciled exactly to the counter at
**0.12760024 NEAR** with positive reserve above storage and liabilities
([evidence](evidence/live-liability-reconciliation.json)).

The rebuilt `578af9bf…` guest is active on the existing Project. Its
no-key hosted Research smoke failed as `NOT_STARTED`, credited the full
customer refund and required owner resume. A replayed release could not
credit a second refund. On `nfa-1`, a vault upgrade approved before sale
returned `false` after the owner epoch changed; the old owner could not
approve again. The proposal was canceled. See
[reviewed-security-regressions.json](evidence/reviewed-security-regressions.json).

Three receiver-specific reporter FunctionCall keys, a restricted admin key,
two receiver-specific guardian keys and restricted OutLayer maintenance keys
were tested on testnet. The admin key proposed a pinned registry hash and
was refused before the 48-hour delay. A new proposal for the exact current
registry bytes is [scheduled](evidence/restricted-self-upgrade-scheduled.json)
through the restricted key; its delayed apply and remaining FullAccess key
removal await that public time gate. The earlier three OutLayer resolution
failures were safely released. The later HTTPS path completed two paid
real-model jobs across sale, with one refunded oversized continuation retry.
