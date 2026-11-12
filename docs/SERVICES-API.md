# NFA services and REST calls

## Model

An NFA is the persistent owner of a vault and one service Project. A **service** is
a bounded, priced capability exposed to customers; a **skill** is code the NFA
uses to perform it. A service defines its input/output schema, active version,
resource cap, fee rule, access rule, memory policy and callback/result schema.
The token's owner can change while the vault account and its project identity
remain stable. A buyer receives control over transferable project memory, not
the seller's personal credentials.

| Service | Customer input | Result | Stage |
| --- | --- | --- | --- |
| Scout | Question and supplied source text/URLs | Extractive, cited brief and content hash | Hosted testnet passed; REST quote and wallet checkout |
| Compare | Question, criteria and supplied option texts | Ranked evidence coverage and content hash | Hosted testnet passed in the same OutLayer Project |
| Research | Question and approved source title/HTTPS URL records | Retrieved-source/model report committed in encrypted memory | Typed adapter and WASI implemented; hosted no-key check passed; real inference pending |
| Monitor | Allowlisted targets, condition, duration | Scheduled alerts and evidence receipts | Design; needs recurring job scheduler and prepaid budget |
| Curator | Items and scoring policy | Ranked collection with provenance | Design; separate guest, fee and output schema |
| Analyst | Uploaded dataset and bounded query | Reproducible report | Design; private data policy and size limits needed |
| Concierge | Explicit allowed API adapter and task | Receipt for an approved action | Design; credential handoff and permissions needed |
| Treasury watcher | Vault and asset watch rules | Read-only risk or balance report | Design; never grant a reporting service spend access |

The active testnet component retains Scout/Compare and adds a candidate Research
handler. Research public quotes remain gated until real inference and buyer
continuation pass; see [RESEARCH-ACCEPTANCE.md](RESEARCH-ACCEPTANCE.md). Discovery advertises
any service, Scout included, as callable only when the owner configures its
on-chain policy and the API has a matching quote policy. Paid jobs run with the
policy's resource limits exactly and an execution deposit of at least 0.001 NEAR;
a customer cannot choose smaller limits or deposits. The other services are examples of products
that can use the same interface once they have their own reviewed guest,
permission model, price policy and public result contract. `Scout` currently
processes **supplied text** deterministically; it does not fetch websites or
run an LLM. A source URL is a citation label, not a fetch instruction. Its
output is evidence of what the supplied text said, not proof that the claim is
true. Execution attestation does not establish factual accuracy.

OutLayer's [NEAR integration](https://app.outlayer.ai/docs/near-integration)
supports pinned Project executions and callback results. Its
[storage model](https://app.outlayer.ai/docs/storage) isolates data by caller,
which is why the NFA's stable vault is the execution caller in this design.

## Existing REST interface

Start `node services/api/server.mjs` with `NFA_SCOUT_POLICY_JSON` configured as
described in `.env.example`. The upgraded registry must be deployed, the NFA's
Scout project must be `READY`, and the version must be pinned to a hosted WASI
component before a real job can run. Without those gates, discovery reports
unavailable and checkout is blocked.

| HTTP | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/nfas/:tokenId/research` | Read research configuration, daily USD allowance and vault compatibility |
| `GET` | `/v1/nfas/:tokenId/services` | Discover configured service availability and schemas |
| `POST` | `/v1/nfas/:tokenId/services/:serviceId/quotes` | Validate input, fetch OutLayer estimate, return fee and unsigned NEAR payment action |
| `GET` | `/v1/nfas/:tokenId/services/:serviceId/jobs/:jobId` | Read the on-chain status, service binding and public result commitment |
| `POST` | `/v1/nfas/:tokenId/services/:serviceId/jobs/:jobId/prepare-start` | Validate the committed input and return unsigned NEAR start action |

Example request:

```http
POST /v1/nfas/nfa-1/services/scout/quotes
Content-Type: application/json

{"input":{"question":"How does this NFA retain its treasury?","sources":[{"title":"Account specification","url":"https://example.org/account","text":"This NFA retains its treasury in the same NEAR vault account when the NFT owner changes."}]}}
```

The response includes `inputData` (the exact JSON bytes to retain),
`inputHash`, `versionKey`, `policyVersion`, `estimateYocto`, `feeYocto`, `replenishYocto`,
`depositCapYocto`, `deadlineNs`, `limits` and `unsignedAction`. The fee consists
of a 20% estimate headroom plus the configured minimum margin. It is a
**server quote**; the upgraded registry enforces the owner-configured minimum
margin, maximum deposit and limits, while the API may quote a larger margin.
The signed action pins the expected runtime hash and service-policy version,
so a stale quote is rejected before reserving a job or fee. A quote is not a
reservation; there is no server-issued billing quote ID.

1. The caller signs and sends `unsignedAction` using a NEAR wallet. This pays
   `request_reviewed_service_job` on the registry, which escrows the fee and returns a
   registry-assigned job ID. Resolve that ID from the transaction result or an
   indexer; do not guess the next ID.
2. Submit `{"inputData":"<the exact inputData from the quote>"}` to
   `POST /v1/nfas/nfa-1/services/scout/jobs/:jobId/prepare-start`.
   Sign and send its returned `unsignedAction`, or have the configured keeper
   sign the same action. The registry checks the hash and job stage, adds the
   assigned `jobId` to the execution payload, and calls its vault adapter.
3. Poll `GET .../jobs/:jobId`. `REQUESTED`, `EXECUTING`, `RECONCILING`,
   `FINALIZED`, `FAILED`, and `UNCERTAIN` are distinct outcomes. `FINALIZED`
   contains the output commitment/URI; owner memory is recalled separately.
   A definite failure credits a customer refund. `UNCERTAIN` stays locked
   until reconciliation; REST must not synthesize a refund or a success.

The API never takes a wallet private key. Scout commits to
`{question,sources}`; Compare commits to `{question,criteria,sources}` before
the job ID exists. The registry verifies those exact bytes, then inserts the
assigned ID and allowlisted operation into the WASI input. This prevents
preceding operations from invalidating a quote by changing the next ID.

## Adding more services

Keep a shared external REST envelope, with one typed adapter per service:

```text
GET  /v1/nfas/:tokenId/services
POST /v1/nfas/:tokenId/services/:serviceId/quotes
GET  /v1/nfas/:tokenId/services/:serviceId/jobs/:jobId
POST /v1/nfas/:tokenId/services/:serviceId/jobs/:jobId/prepare-start
```

The deployed registry records allowlisted service policies and pins job
service/policy version alongside the runtime version. The vault accepts only
registry-authenticated, typed requests to its approved Project. One Project
serves Scout and Compare; storage prefixes organize their memory but do not
isolate a malicious or unreviewed WASM version. Preserve a global NFA transfer
lock while any sensitive job is
in flight, or define explicit per-service handoff/reconciliation rules. Budget
and refund ledgers should identify the service and separate OutLayer spend,
customer escrow, and NFA income.

Do not map customer-provided `serviceId`, instructions, URLs, or JSON keys to
vault project creation/version management or to a project-bound signing key.
An action service needs a narrow, reviewed adapter with per-NFA scope and spend
limit. A credential or OAuth grant issued to a human is not transferred merely
because the NFT changes hands; it needs a provider-approved handoff or a fresh
grant. OutLayer's signer-based storage would also split memory if Alice and Bob
called it directly. The vault/project identity is the stable storage boundary.

## Later: API-key checkout

A client that only speaks REST could use `POST /v1/.../jobs` with an API key and
prepaid service balance. The server would verify/reconcile payment first, then
a limited relayer would submit the registry request and start action; it would
return `202 Accepted` plus an idempotency key and the on-chain job ID. That
billing and relayer adapter is **not implemented**. Calling OutLayer's HTTPS
execution API directly would change the caller/payment and storage identity;
it would bypass the NFA vault accounting and transferable memory path. Keep
other asset payment adapters, royalties and additional chains separate in separate follow-on releases. The native NEAR funded path has passed hosted
testnet acceptance; these adapters are still separate work.

## Optional x402 checkout after the NEAR funded path

The x402 v2 `exact` NEAR scheme lets a payer authorize one NEP-141
`ft_transfer` with a NEP-366 signed delegate action; a configured facilitator
verifies and settles it. It does **not** pay the registry's current native-NEAR
`request_paid_scout` deposit directly. Keep x402 in an HTTP billing adapter,
outside the vault and the WASI guest.

| Component | Responsibility |
| --- | --- |
| REST API | Creates expiring `(token, service, input hash, version, amount, asset, payee)` quote; serves x402 `402` challenge |
| x402 facilitator | Settles the exact NEP-141 transfer and reports the final inner transfer receipt |
| Merchant ledger | Durably claims one settlement for one quote/job; tracks token receipts, NEAR funding, refunds and reconciliation separately |
| NEAR relayer | Fronts native NEAR from an operator reserve to call `request_paid_scout`, then starts the committed job |
| NFA vault and OutLayer | Run the approved pinned service and return result; never parse x402 headers or customer payment keys |

Proposed route: `POST /v1/nfas/:id/services/scout/jobs` with a quote ID and
`Idempotency-Key`. Without `PAYMENT-SIGNATURE`, respond `402` with the exact
USDC requirement. With a signature, settle once, persist the settlement and
reconcile the native-NEAR funding action before responding `202` with the job
ID and status URL. `GET .../jobs/:jobId` remains the status endpoint. A
repeated request returns the same job; a settled payment with a failed job
submission stays a merchant liability until funded or refunded. If Scout
fails definitively, its native-NEAR registry refund goes to the relayer; the
merchant must separately refund the x402 payer in the original asset. An
uncertain execution or payment remains reserved for reconciliation. This
adapter, including token pricing/conversion and durable idempotency, is **not
implemented** and must not be advertised by service discovery yet.

Sources: [x402 NEAR exact scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_near.md),
[x402 v2 specification](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md).

## Studio operations

| HTTP | Path | Purpose |
| --- | --- | --- |
| GET | `/studio/nfas/:tokenId` | Finalized owner, budgets, ledgers, Project agreement, jobs and audit |
| GET | `/studio/catalog`, `/studio/skills`, `/studio/releases`, `/studio/storage` | Traits, reviewed schema/tool descriptors, pinned releases and durable-store status |
| POST | `/studio/simulate` | Typed deterministic preview and optional OutLayer estimate; no execution charge |
| POST | `/studio/releases/verify` | Download reviewed bytes, verify SHA-256, predecessor manifest and storage import |
| POST | `/studio/transactions/inspect` | Reconcile exact hash, signer, receiver, token and assigned job ID |
| POST | `/studio/transactions/simulate` | Review bounded NEAR or fixed Sepolia unsigned payload |
| GET/POST | `/studio/nfas/:tokenId/work/:jobId` | Current-owner artifact read or verified reconstruction from finalized public start transaction |

All preparation endpoints return unsigned actions. Real operation arguments and
route details live in `services/api/server.mjs`; Studio uses the same interfaces.
See the [runbook](STUDIO-RUNBOOK.md) for recovery and testnet records.
