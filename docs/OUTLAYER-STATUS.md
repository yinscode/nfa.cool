# OutLayer implementation status

2026-11-15 update: The vault-owned HTTPS Payment Key, exact-hash secret
access and a 90-second Research guest are active on testnet. Paid Research
job `48` completed with real NEAR AI inference, a finalized output commitment
and NFA earnings. Alice sold NFA-2 to Bob afterward; the vault, address and
Project UUID stayed stable. The refund replay and stale seller upgrade
regressions passed again. Bob's hosted recall matched the seller-era Research
hash. His paid continuation job `51` also finalized with real inference and
a prepared input containing job `48`'s finalized work commitment. The exact
guest is now verified in the local release catalog, and a live read-only
Research quote is available when the local API is configured with its quote
policy. The operator reports HTTPS outcomes; the registry does not verify
OutLayer attestation on-chain.
The current registry is
`f9c750ad48e369b79e65f3de6c6533602b09658c3202e389d96dbfba154c1353`;
the two preceding failed HTTPS jobs were refunded and the async resume fix
was rehearsed before that registry upgrade. See
[Research acceptance](RESEARCH-ACCEPTANCE.md),
[seller receipt](evidence/paid-async-research-seller.json),
[buyer receipt](evidence/paid-async-research-buyer-accepted.json) and
[recovery rollout](evidence/async-research-recovery-rollout.json).

2026-11-14 update: An HTTP write repair for the HTTPS-aware Research guest is
staged as an inactive candidate with a secret grant pinned to its exact WASM hash. The near-ai
credential and configured model passed a read-only provider listing. The
registry's existing FullAccess key was used on testnet to deploy the exact
proposed bytes before the public delay. The owner-approved vault upgrade,
vault-owned Payment Key issuance and 0.50 testnet USDC.e top-up completed.
The first vault apply exhausted its 250 Tgas prepayment; a journaled 300 Tgas
retry succeeded. A vault-owned HTTPS recall matched finalized Scout job 26.
The first paid Research diagnostic failed at a WASI HTTP body write over
4,096 bytes; the repaired candidate writes bounded chunks. Its retry reached
near-ai inference and recorded priced usage, but its report failed output
validation. Neither call settled an NFA Research job. See
[HTTPS probe](OUTLAYER-HTTPS-ASYNC-PROBE.md) and
[diagnostic evidence](evidence/vault-https-diagnostics.json).

2026-11-13 update: the reviewed registry/vault code and rebuilt
Scout/Compare/Research guest are live on the same testnet Project. Fresh
Scout/Compare jobs and a recall of pre-upgrade work finalized on the new
guest. A paid Research no-key smoke refunded in full. Three real-model Research
attempts hit an OutLayer resolution error and were released; the NFA was idle
and buyer continuation was open at that checkpoint. See
[M06 reviewed preparation](evidence/m06-reviewed-preparation.json). The table
below records the earlier Studio release gate.

Updated 2026-11-12. **C001–C017 and Studio S001–S022 passed their release gates.**
One stable vault owns one OutLayer Project, running reviewed Scout and Compare
services with separate native NEAR ledgers. Real paid jobs, buyer recall,
version-continuity recall, definite failure/refund and recovery passed on testnet.

| Area | Result |
| --- | --- |
| Runtime and storage | WASI P2 predecessor-bound component; exact immutable bytes verified; same UUID across signer and version changes |
| Contracts | Actual-old-bytecode upgrade rehearsal; current registry deployed; newly minted keyless vault |
| Billing | Paid Scout/Compare finalized; separate service escrow/income/replenishment; failed fee credited and withdrawn |
| REST/Studio | Typed quotes pin policy/runtime; assigned job ID from finalized receipt; owner-only management and work access |
| Access/transfer | Alice sold to Bob; Bob edited and recalled; old Alice action/session rejected; pending sale blocked |
| Recovery | Explicit reconciliation/retry, journaled intents, no timeout refund; definite-failure resume proves vault clear |
| Artifacts | S3-compatible adapter tested with AWS CLI, hash/tamper/empty-cache tests; demo public art published FastFS |
| Evidence | Five task quote report-data bindings checked; Intel collateral chain not independently verified |
| Validation | 52 JS, 14 vault, 36 registry tests; full paid sandbox; real hosted acceptance |

[Studio status](NFA-STUDIO-STATUS.md) lists per-task completion.
[Testnet evidence](OUTLAYER-TESTNET-EVIDENCE.md) contains transactions, hashes and
costs. [Runbook](STUDIO-RUNBOOK.md) describes local startup and recovery.

Production public hosting and object-bucket configuration have not been provisioned.
C018/x402 remains an explicitly separate later adapter. Royalties, Intents,
additional chains and personal OAuth handoff are also outside this release.
Inputs and recall summaries are public on NEAR; shared Project namespaces are
not service isolation. No attestation claim establishes factual accuracy.
