# nfa.cool — Non Fungible Agent

An NFA is an NFT that controls a persistent software account. It can hold a
treasury, expose paid services, retain eligible work and change owners while
keeping the same vault and service identity.

Creators use a compact Studio flow to choose a purpose and character, configure
reviewed services and budgets, then launch. Customers hire the NFA through its
public profile or REST API. Owners manage service policies, spending permissions,
runtime versions and eligible memory. A buyer can take over the working account
and business history through an NFT purchase.

NEAR provides the NFT/controller contract, keyless vault accounts, asynchronous
execution and callbacks, native payment accounting and ownership epochs. Chain
Signatures derives a stable Sepolia identity from the vault. OutLayer runs the
reviewed Scout/Compare/Research WASI runtime in a vault-owned Project, with predecessor-
bound storage so a different human signer does not split the agent's memory.

The differentiator is the handover: pending work blocks sale, old owner/session
authority fails after transfer, and the buyer retains the same vault, approved
runtime and eligible prior work. The SDK and service API make the primitive
usable outside the web UI.

Implemented: character generation/editor, resumable creation, treasury/policies,
bounded delegation, OutLayer Project/version controls, native NEAR paid services,
owner-gated artifact access, memory recall, audit, fixed-price trading, business
accounting views and transfer inventory. Earlier hosted testnet acceptance covers
Scout/Compare, sale, buyer recall, runtime continuity and failure/refund recovery.
The newest 13-check local sequence adds a buyer's next paid job and restart.

The reviewed registry and both vaults are on NEAR testnet. Existing income,
payout credits and escrow were accounted for in the liability migration;
nonzero legacy escrow was rehearsed locally before deployment. The later
async Research registry upgrade was rehearsed against the exact prior bytes
and preserved identity, balances and pending state. The active guest is
`a8513acd…`, with secret access bound to that exact WASM hash and the stable
vault. See the [migration rehearsal](evidence/liability-upgrade-rehearsal.json),
[reviewed rollout](evidence/reviewed-testnet-rollout.json) and
[async recovery rollout](evidence/async-research-recovery-rollout.json).

Paid Research acceptance now has two finalized real-model jobs on the same
NFA: Alice's job `48` produced priced NEAR AI usage and NFA income; after the
sale, Bob recalled its output through the vault's hosted Payment Key and
signed a new paid job `51` whose committed input includes job `48`'s finalized
output hash. The vault, Sepolia address and OutLayer Project UUID stayed the
same across sale. Failed-job refund replay, stale seller upgrade approval and
Alice's owner-only recall were rejected on testnet. Two earlier HTTPS jobs
failed and refunded; Bob's first oversized continuation also refunded before
the successful retry. See [seller](evidence/paid-async-research-seller.json),
[sale and recall](evidence/async-research-handover.json),
[buyer continuation](evidence/paid-async-research-buyer-accepted.json), and
[balanced live liabilities](evidence/live-liability-reconciliation.json).

Release limitations: public web/API hosting and a continuous wallet screen
recording are deferred. The [42-second testnet evidence replay](research-live-evidence-replay.mp4)
assembles separate verified receipts; it is labeled as a replay. The new EVM
settler has local tests, not a new live Sepolia release run. The restricted
HTTPS reporter is live, but the registry trusts it to observe OutLayer; full
Intel collateral verification and on-chain OutLayer attestation verification
are not implemented. A restricted registry admin has proposed the exact
current code for a full delayed apply rehearsal. Its [48-hour gate](evidence/restricted-self-upgrade-scheduled.json)
must elapse before applying with that key and removing remaining FullAccess
keys. Bob's hosted recall used the operator-held vault Payment Key; the later
buyer paid job was Bob-signed.
Net profit is not claimed from gross receipts. Capped NFA-to-NFA hiring is
implemented and has a live testnet paid Scout receipt. Direct FT checkout has
live Circle testnet USDC completed-job and refund receipts. Intents quoting is
locally implemented but has not accepted a live payment.
See [payment and hiring status](PAYMENT-AND-HIRING.md).
Personal OAuth, royalties, x402 and additional chains remain later products.

Live URL: **public hosting deferred**. Demo: [testnet evidence replay](research-live-evidence-replay.mp4)
and the separate [local walkthrough](release-evidence-walkthrough.mp4).
Use [DEMO-SCRIPT.md](DEMO-SCRIPT.md), [RELEASE-PLAN.md](RELEASE-PLAN.md) and
[OUTLAYER-TESTNET-EVIDENCE.md](OUTLAYER-TESTNET-EVIDENCE.md) for reproducibility
and the exact boundary between implemented, locally verified and hosted work.
