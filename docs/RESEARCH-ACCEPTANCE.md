# Research acceptance runbook

The paid Research service is a separate typed adapter in the existing stable
vault-owned OutLayer Project. Scout and Compare still process supplied text.
Research retrieves approved URLs, makes a bounded model call, checks exact
source quotations and stores the report in encrypted predecessor storage.
Successful execution does not establish factual accuracy.

## Local loop

```sh
npm run check
sh scripts/check-contracts.sh
npm run outlayer:wasi-build
node scripts/pin-research-runtime.mjs
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
reviewed NFA, vault and Project identity. Complete M02 before contract upgrades.

```sh
node scripts/m06-research-testnet.mjs upload
node scripts/m06-research-testnet.mjs secrets-smoke
node scripts/m06-research-testnet.mjs upgrade
node scripts/m06-research-testnet.mjs stage
node scripts/m06-research-testnet.mjs activate
node scripts/m06-research-testnet.mjs configure-smoke
node scripts/m06-research-testnet.mjs smoke
node scripts/m06-research-testnet.mjs legacy
```

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
guarantee of the upstream bill. Resource ceilings remain 24,000 input tokens,
512 output tokens, 30 seconds and a separate daily USD allowance.

```sh
node scripts/m06-research-testnet.mjs secrets
node scripts/m06-research-testnet.mjs configure
node scripts/m06-research-testnet.mjs research
node scripts/m06-research-testnet.mjs handover
node scripts/m06-research-testnet.mjs buyer
node scripts/m06-research-testnet.mjs verify
```

Research REST checkout stays gated while the release catalog is a candidate.
This explicit operator acceptance runner may stage and test the reviewed
candidate without weakening that public gate. Promote the catalog and service
package only with real research, buyer-job, recall and stable-UUID receipts.

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
