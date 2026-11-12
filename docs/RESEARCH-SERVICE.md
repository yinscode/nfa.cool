# Bounded research candidate

`services/worker/research.mjs` is a tested Node reference runner for reviewed
retrieval and one OpenAI-compatible inference call. It is **not deployed or
advertised as an OutLayer service**. The existing hosted Scout/Compare runtime
is unchanged. No model key is configured and no paid inference was attempted.

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
It is a local reference adapter, not OutLayer encrypted storage. An OutLayer
adapter must use the same predecessor-bound storage as the existing guest.

## Hosted release gates still required

1. Port the reviewed runner to the WASI P2 guest using the documented
   `wasi-http-client` interface; build and pin immutable bytes. The current local
   default Rust toolchain does not have the WASI P2 target installed.
2. Add a typed research service to the registry/vault allowlist and recall path,
   then test/rehearse exact new bytes. Do not reinterpret the existing Scout
   schema or silently activate different behavior under its service ID.
3. Configure an operator-funded, bounded inference credential and an explicit
   secret reference. The current vault request does not supply `secrets_ref`;
   merely adding an environment variable to the API would not configure OutLayer.
   Lock credentials to reviewed code and stable vault predecessor. Human-owned
   credentials remain revocable and are not advertised as transferable assets.
4. Reconcile model cost, OutLayer cost, NFA margin and refunds independently;
   demonstrate paid execution and buyer continuation on the same Project.

Until these pass, discovery continues to expose only Scout and Compare.
Official references checked 2026-11-12:
[WASI HTTP](https://app.outlayer.ai/docs/wasi),
[SDK and caller context](https://app.outlayer.ai/docs/sdk),
[secret rules](https://app.outlayer.ai/docs/secrets),
[AI example](https://github.com/out-layer/ai-example).
