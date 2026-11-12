# OutLayer implementation status

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
