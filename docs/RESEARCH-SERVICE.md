# Bounded Research service

`services/worker/research.mjs` is the tested Node reference runner for reviewed
retrieval and one OpenAI-compatible inference call. The equivalent bounded
WASI P2 guest is active in the existing vault-owned OutLayer Project on testnet.
Scout and Compare finalized on the rebuilt guest. A paid Research no-key smoke
executed there and returned `NOT_STARTED` with a full native NEAR refund.
A dedicated NEAR AI key is privately configured and bound to the exact active
WASM hash and vault. Earlier NEAR-funded attempts failed during OutLayer
resolution. The later HTTPS path finalized seller job `48` and buyer job `51`
with real model inference, priced usage and NFA earnings after an NFT sale.
The local REST adapter now offers a Research quote against the live registry
when configured with its quote policy; public hosting is deferred.

It accepts only a question and up to three titled source URLs. An operator pins
HTTPS source host/path rules, inference endpoint/model, token limits and maximum
cost. Redirects, arbitrary tools, customer-selected endpoints and extra input
fields fail. Every finding needs a source ID and an exact source quotation;
this checks citation inclusion, not the factual truth or support of the claim.
The provider receives public research text and eligible prior work, never vault
keys. Context, prompts, model names and sources cannot authorize spending.

`research-runner.mjs` provides `assertResearchJob` using finalized owner epoch,
active paid commitment and runtime checks before retrieval, inference and
staging. `ResearchAttempts` durably reserves one attempt before a potentially
billed request and records measured usage after a staged result.
Unknown provider outcomes remain reserved until reconciled. Model token charges
use a separate USD ledger; they must not be described as OutLayer NEAR charges.
Configured token rates applied to provider-reported usage are a priced usage
estimate; they are not a verified provider invoice or proof of actual profit.

`ResearchMemory` namespaces staged work by stable vault, independent of the
human owner. It supplies only results matching finalized on-chain commitments.
The Node runner is a local reference adapter. The hosted guest uses OutLayer's
encrypted predecessor-bound storage; a successful pre-upgrade Scout recall on
the rebuilt guest verifies that earlier work stayed reachable.

## Hosted acceptance and limits

The [seller](evidence/paid-async-research-seller.json),
[sale and recall](evidence/async-research-handover.json), and
[buyer continuation](evidence/paid-async-research-buyer-accepted.json) receipts
complete the paid Research sequence. The buyer's prepared input contains the
seller-era finalized output commitment. The hosted recall used the
operator-held vault Payment Key; the buyer signed the later paid job. The
restricted operator observes OutLayer and reports results to the registry,
which binds job ID, runtime, owner epoch, output hash and usage. It does not
verify OutLayer attestation on-chain. Provider-reported usage is a pricing
estimate, not an invoice or proof of net profit. The
[demo replay](research-live-evidence-replay.mp4) assembles distinct receipts,
not a continuous wallet recording.
Official references checked 2026-11-12:
[WASI HTTP](https://app.outlayer.ai/docs/wasi),
[SDK and caller context](https://app.outlayer.ai/docs/sdk),
[secret rules](https://app.outlayer.ai/docs/secrets),
[AI example](https://github.com/out-layer/ai-example).
