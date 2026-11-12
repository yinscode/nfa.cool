# nfa.gent — own the whole agent

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
reviewed Scout/Compare WASI runtime in a vault-owned Project, with predecessor-
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

Release limitations: public web/API hosting and final external-wallet recording
are pending. The new EVM settler has local tests, not a new live Sepolia release
run. Its reporter is trusted. Full Intel attestation collateral verification has
not been independently completed. The research/LLM reference runner is a
candidate; WASI integration and hosted/model billing acceptance remain open.
Net profit is not claimed from gross receipts. Personal OAuth, royalties,
Intents/1Click, x402 and additional chains are separate later products.

Live URL: **pending deployment**. Final video: **pending live acceptance**.
Use [DEMO-SCRIPT.md](DEMO-SCRIPT.md), [RELEASE-PLAN.md](RELEASE-PLAN.md) and
[OUTLAYER-TESTNET-EVIDENCE.md](OUTLAYER-TESTNET-EVIDENCE.md) for reproducibility
and the exact boundary between implemented, locally verified and hosted work.
