# NFA demonstration — reviewer runbook

Positioning: **Buy an agent with its accounts, capabilities, eligible memory and
business history.** The NFT changes its controller; the stable vault and its
service Project stay in place.

## Reproduce the local acceptance

```sh
npm run check
npm run studio:start
node scripts/sdk-example-check.mjs
node scripts/sdk-example-check.mjs
node scripts/studio-ux-check.mjs --restart
```

The SDK check creates one NFA and paid job, then resumes it. The second run must
return the same IDs without another payment. Its stable private checkpoint stays
in `.data`; do not publish it. If local test balances run low, explicitly use
`node scripts/fund-local-dev.mjs alice.test.near 20`. This faucet checks the local
genesis and never runs on testnet.

The integration run creates a fresh NFA, enables Scout and Compare, tests an
unresolved launch action, charges a customer, blocks sale during pending work,
finalizes work, sells to Bob, rejects Alice's retained session, edits the
character, recalls eligible pre-sale work and earns from another customer job.
Restart preserves the owner, manifest, vault, Project UUID and finalized work.

The 2026-11-12 run created `nfa-6` in the persistent sandbox and passed **13
checks**. Its UUID is `p0000000000000005`; Bob owns it; two jobs credited 0.04
testNEAR of earnings from 0.0448 testNEAR of customer fees, with 0.0048 testNEAR
of execution replenishment. Those are **local NEAR receipts with an OutLayer
mock**, not new hosted OutLayer or Sepolia evidence.

Run `npm run demo:reel` to regenerate the 42-second labeled
[evidence walkthrough](release-evidence-walkthrough.mp4) from those recorded
results and the actual browser capture. It requires `ffmpeg` and the project's
existing Node dependencies.

## Suggested 90-second live presentation

| Time | Show | Explain |
| --- | --- | --- |
| 0–15s | Compact creation | Purpose, identity, services/budget, review; avatar is one step |
| 15–30s | Public profile and paid job | Customer pays for a bounded service; receipt assigns the job ID |
| 30–45s | Pending sale rejection, then finalized result | Outstanding authority must settle before ownership moves |
| 45–65s | Alice lists; Bob buys | Same vault, chain address and Project UUID; new owner/epoch |
| 65–80s | Bob recalls work and another customer hires it | Eligible business history and capabilities continue |
| 80–90s | Alice rejected; SDK example | Ownership controls behavior and the primitive is reusable |

Use the local mode label throughout local recordings. The generated evidence
walkthrough is a replay of test results/screenshots, not a continuous recording
of live wallet interactions. A final public testnet recording remains pending
the deployment and external-wallet acceptance in PUBLIC-DEPLOYMENT.md.

## Current evidence

- [Local release receipts](evidence/release-demo.json)
- [Buyer profile after restart](release-buyer-profile.jpg)
- [Earlier real OutLayer testnet sequence](OUTLAYER-TESTNET-EVIDENCE.md)
- [Original task reconciliation](ORIGINAL-PLAN-STATUS.md)

## Trust boundaries to disclose

The settlement reporter and guardian have privileged roles. RPC observations
are not foreign-state proofs. Scout/Compare are supplied-text deterministic
services. The research runner is a separate candidate, not a hosted LLM release.
Attestation does not prove factual accuracy. The seller may retain downloaded
copies; human OAuth grants do not automatically follow the NFT.
