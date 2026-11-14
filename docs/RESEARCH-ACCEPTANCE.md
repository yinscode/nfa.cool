# Research acceptance runbook

The paid Research service is a separate typed adapter in the existing stable
vault-owned OutLayer Project. Scout and Compare still process supplied text.
Research retrieves approved URLs, makes a bounded model call, checks exact
source quotations and stores the report in encrypted predecessor storage.
Successful execution does not establish factual accuracy.

## Current testnet status — 2026-11-15

The active Research guest is `a8513acd137f37ce21a820e8d2e9b92b9712970e3c3710b41a4e26df06137588`
with a `research-v8` secret rule limited to that vault and exact WASM hash.
The HTTPS call has a **90-second wall-clock limit** and a **30,000 microUSD
compute cap**; the registry keeps the customer fee in NEAR escrow until a
restricted reporter binds and settles the exact OutLayer call ID. The
registry validates the job ID, runtime, owner epoch, output commitment,
priced model usage and compute cap. The reporter is trusted to check the
hosted result; the registry does not verify an OutLayer attestation on-chain.

Seller-era paid job `48` finalized on testnet with `PRICED_USAGE` of 3,748
microUSD and NFA income of 49.658 testNEAR after settlement. The output hash,
payment, bind and settlement transactions are in
[seller Research evidence](evidence/paid-async-research-seller.json). The
seller then sold NFA-2 to Bob without changing its vault, EVM address or
OutLayer Project UUID. Failed-job refund replay and stale seller upgrade
approval were rejected on testnet. Bob's hosted recall matched the seller-era
Research output hash, and Alice's owner-only recall was rejected. See
[handover evidence](evidence/async-research-handover.json). Bob's paid
continuation job `49` stopped before inference, after the seller-era
quotations increased the prompt size. It received a full customer refund;
the buyer resumed the NFA, raised the approved input allowance to 12,000,
and submitted a fresh job `51`. Job `51` finalized with `PRICED_USAGE` of
4,922 microUSD. Its committed input includes job `48`'s finalized output
hash, and its new output hash is independently recorded with the buyer's
payment and settlement transactions in
[buyer Research evidence](evidence/paid-async-research-buyer-accepted.json).
The [release catalog](../releases/catalog.json) now marks this exact guest
verified; a [read-only live quote](evidence/research-rest-ready.json) reports
Research available with a 90-second HTTPS limit. The
[liability scan](evidence/live-liability-reconciliation.json)
balances after both jobs and the sale.

The buyer's hosted recall used the vault-owned Payment Key held by the
operator; it was not itself a buyer-signed on-chain recall. Bob signed the
subsequent paid job, which carried Alice's finalized work commitment. The
on-chain registry binds and checks the reported output and usage, but trusts
the restricted reporter's observation of OutLayer; attestation is not
verified on-chain.

Two earlier HTTPS paid attempts, jobs `42` and `44`, did not create work.
Job `42` returned an uncertain model outcome; job `44` hit OutLayer's
30-second guest timeout. Both were settled as operator failures with full
customer refund credit. The async resume path was repaired after job `42`;
the exact predecessor bytes were rehearsed locally and the live recovery
upgrade preserved the failed job, balances and pending resume state. See
[recovery rehearsal](evidence/async-research-recovery-upgrade-rehearsal.json),
[rollout](evidence/async-research-recovery-rollout.json) and the two failed
job receipts in `docs/evidence/paid-async-research-first*.json`.

The older NEAR-funded attempts and inactive HTTPS candidates below are kept
as history; they are not the current Research execution path.

**2026-11-14 HTTPS candidate:** The HTTP write repair is staged but inactive at
`f959f859af13e783e35df24c857b8e4a54739f7a6525248cffd4c2fe1d5b26b9`.
Its separate `research-v6` secret profile is bound to this exact hash and the
NFA vault. A read-only near-ai model listing returned HTTP 200 and included
the privately configured model. See [staging evidence](evidence/research-https-staged.json)
and [provider preflight](evidence/research-provider-preflight.json). The
operator used the registry's existing FullAccess key to deploy the exact
proposed registry bytes on testnet before the public delay; this is recorded
as a governance bypass in [direct deployment evidence](evidence/payment-key-direct-bypass.json).
The vault upgrade then passed through proposal and current-owner approval.
Its first apply ran out of prepaid gas; the journaled 300 Tgas retry succeeded.
The vault-owned Payment Key is issued and funded with 0.50 testnet USDC.e
([upgrade evidence](evidence/payment-key-upgrade-testnet.json)). The first paid
HTTPS Research diagnostic failed at a WASI HTTP body write over 4,096 bytes;
the vault-owned HTTPS recall of finalized Scout job 26 succeeded and matched
its on-chain commitment ([diagnostic evidence](evidence/vault-https-diagnostics.json)).
The repaired candidate writes bounded chunks. Its fresh paid diagnostic
completed with `inferenceOutcome: succeeded` and priced model usage, then
returned a customer-fault Research result because the model output did not
pass the report checks. Neither diagnostic settled an NFA paid job; the later
seller and buyer acceptance above uses the active `a8513acd…` guest.

## Local loop

```sh
npm run check
sh scripts/check-contracts.sh
npm run outlayer:wasi-build
node scripts/pin-reviewed-runtime.mjs
sh scripts/build-outlayer-sandbox.sh
NEAR_SANDBOX_BIN_PATH="$PWD/.deps/bin/near-sandbox" node scripts/research-sandbox-check.mjs
```

The receipt integration uses a deterministic OutLayer fixture. It proves
contract dispatch, refunds, owner resume, sale, buyer recall and finalized-only
context, but does not exercise hosted HTTP, credential decryption or a TEE.
The native guest tests separately exercise durable inference-attempt behavior.

## Live sequence

`scripts/m06-research-testnet.mjs` is journaled by phase. Rerun the same phase
after an uncertain network outcome; inspect its saved transaction rather than
creating a replacement intent. It accepts only NEAR testnet and the current
reviewed NFA, vault and Project identity. The reviewed registry and both vaults
are already deployed ([evidence](evidence/reviewed-testnet-rollout.json)).

```sh
node scripts/m06-research-testnet.mjs upload
node scripts/m06-research-testnet.mjs secrets-smoke
node scripts/m06-research-testnet.mjs stage
node scripts/m06-research-testnet.mjs activate
node scripts/m06-research-testnet.mjs configure-smoke
node scripts/m06-research-testnet.mjs smoke
```

Those phases completed with the rebuilt `578af9bf…` guest. The hosted no-key
smoke job refunded the customer and required owner resume. The
`research-v4-smoke` profile contains no API key; the real-model profile is
`research-v4`.

The smoke profile contains only the provider name. A successful hosted smoke
classifies a missing model key as NOT_STARTED, credits the customer's full
native NEAR refund and requires the owner's explicit resume. It is not a
successful research report or proof that the model endpoint works.

For actual inference, create `./.env.research` with three entries:

```dotenv
NFA_RESEARCH_API_KEY=<dedicated provider key>
NFA_RESEARCH_PROVIDER=near-ai
NFA_RESEARCH_MODEL=<reviewed provider model ID>
```

`openai` is the other supported provider. Do not paste credentials into chat or
commit this file. Review the model's current rates: the example token rates in
the script are configured USD usage estimates, not a provider invoice or a
guarantee of the upstream bill. This older NEAR-funded route used a
512-output-token and 30-second cap; the active HTTPS configuration above uses
12,000 input tokens, 2,048 output tokens, a 90-second hosted wall-clock limit
and the same separate daily USD allowance.

```sh
node scripts/m06-research-testnet.mjs secrets
node scripts/m06-research-testnet.mjs configure
node scripts/m06-research-testnet.mjs research
node scripts/m06-research-testnet.mjs handover
node scripts/m06-research-testnet.mjs buyer
node scripts/m06-research-testnet.mjs verify
```

On 2026-11-13 the dedicated NEAR AI key and `z-ai/glm-5.3-flash` model passed a
minimal direct provider probe. The encrypted `research-v4` row was stored with
the reviewed vault and exact WASM hash access rule, and Research was configured
on testnet. Three paid hosted jobs, IDs 32–34, each became `UNCERTAIN` after
OutLayer reported `resolve_execution: Execution request not found`. All were
released through the contract recovery path. Their final status is `FAILED`,
model usage is `UNKNOWN`, the NFA is idle with Alice still owning it, and the
native liability check is balanced. See
[real-model attempt evidence](evidence/m06-real-model-attempts.json). Chain
receipts show each request promise failing after 120–121 seconds. A separate
paid Scout canary, job 35, finalized on the same Project but took about 106
seconds end to end; recent unrelated testnet NEAR jobs also slowed. The exact
internal stage causing the delay is not visible in public receipts. See the
[OutLayer incident report](OUTLAYER-TESTNET-LATENCY-INCIDENT.md) for request IDs
and the operator-side checks needed to resolve it.

On 2026-11-14, a user-directed one-shot NEAR-funded retry created job 37 while
the health gate reported no recent qualifying latency samples. It reached
`UNCERTAIN`, was released, and ended `FAILED` with usage `UNKNOWN`. The registry
liability reconciliation passed. OutLayer had no matching row among its latest
100 public jobs when checked. See [one-shot evidence](evidence/m06-research-one-shot-retry.json).

The following advice applies only to the older NEAR-funded runner. Do not run
its `handover`, `buyer` or `verify` until a job on that route reaches
`FINALIZED` with `PRICED_USAGE`. The journal preserves all failed attempts;
another retry needs a new transaction label and evidence that hosted processing
can settle with headroom inside the on-chain promise window. The runner now
requires both recent overall testnet latency and a recent same-Project Scout
canary below 60 seconds before another Research payment.

After OutLayer has addressed the delay, repeat the paid canary and continue
only when the health gate passes:

```sh
node scripts/m06-research-testnet.mjs diagnostic-scout
node scripts/m06-research-testnet.mjs health
node scripts/m06-research-testnet.mjs research-retry
node scripts/m06-research-testnet.mjs handover
node scripts/m06-research-testnet.mjs buyer
node scripts/m06-research-testnet.mjs verify
```

If a canary or Research job becomes uncertain, run the journaled `release`
phase, verify the NFA is idle, and investigate before paying for another run.
That route did not record a buyer continuation. The later HTTPS route above
did, and its exact guest is verified in the release catalog. Public web/API
hosting remains deferred; local REST availability requires an operator quote
policy.

## Credentials and ownership

The operator's encrypted secret row is Project-bound and explicitly referenced
by owner-configured research settings. Its access condition requires both the
stable NFA vault predecessor and the exact measured WASM hash. The condition
does not name the changing human signer. The row remains operator-owned and
revocable; the NFT transfers the agent's control, not ownership of the operator's
provider account. No personal OAuth identity is transferred.

The encryption helper follows official ECIES v1: X25519, HKDF-SHA256 with
`outlayer-keystore-v1`, and ChaCha20-Poly1305. The public-key request sends only
placeholder values for name validation. Actual credentials are encrypted
locally before their ciphertext is stored on chain. Key lookup trusts the
OutLayer HTTPS service; independent Intel collateral validation is still open.

References used to check the wire format and access ABI:

- https://app.outlayer.ai/docs/secrets
- https://github.com/out-layer/outlayer-cli/blob/bfea235ad37d4fc18b90c45634ec7d13f6e167cd/src/crypto.rs
- https://github.com/out-layer/outlayer-cli/blob/bfea235ad37d4fc18b90c45634ec7d13f6e167cd/src/commands/secrets.rs
- https://github.com/out-layer/outlayer/blob/2d50bfab14389857e6e50e84e76d5652b944e1cc/keystore-worker/src/api.rs

## Current delivery limit

Owner recall returns a commitment-checked summary. The full nondeterministic
research report remains in encrypted predecessor storage and is available to
the next approved research job. Scout/Compare artifact reconstruction from
supplied text does not apply to Research. A full report download needs a
separately reviewed encrypted export adapter; do not expose private memory as
plaintext on-chain chunks.
