# Studio product flow — six-point completion

Updated 2026-11-12. All six requested changes are implemented. This release
reuses the existing NEAR contracts; no contract upgrade or new testnet spending
was needed for the UI work.

| Point | Delivered | Verification |
| --- | --- | --- |
| 1. Find existing NFAs | Persistent sandbox chain/accounts, named collection cards, explicit network banner and switch, browser-native public testnet reads | Restart retained owner, character, Project UUID and finalized work. Browser loaded the original testnet `nfa-1` and `nfa-2`. |
| 2. Navigation | My NFAs is the home page; Create NFA and Market are the top-level actions. Public profile belongs to an individual NFA. | Browser navigation and direct `/create`, `/studio`, `/nfa/:id` routes. |
| 3. Compact creation | Purpose → Identity → Services & budget → Review & launch. Generated character preview; customization collapsed; both services selectable. | Browser created `Lumen Research` as local `nfa-3` with Scout and Compare. |
| 4. Resumable launch | Stable request ID and network-scoped plan; exact receipt binding before another action; mint, Project, policies, reserve and optional key steps derived from confirmed state. | Browser refresh after mint resumed at Project creation. Integration injected an unresolved receipt and proved the planner waits instead of repeating it. |
| 5. Public profile | Identity, services, pricing, ownership and work commitments; human-readable hiring form; current paid OutLayer quote/payment/assigned-ID/start/status; no owner management forms. | Browser customer bought Compare, refreshed after payment, recovered job ID 2 and finalized it. Owner work remains separately gated in Studio. |
| 6. Complete verification | Shared planner/API flow, paid work, pending sale lock, sale, buyer edit/recall, old-session rejection and persistent restart; browser creation and checkout. | `scripts/studio-ux-check.mjs --restart` passed all 11 integration checks; 65 JavaScript tests and web/SDK release checks pass. |

## Running workspace

The updated persistent workspace runs at `http://127.0.0.1:3102/studio`.
Port 3102 is the new default. Older temporary servers can still be running on
other ports; their current web bundle redirects safe collection-page visits to the updated
workspace, retaining the selected local account. Wallet callbacks and pending
actions remain in their original workspace. They are not silently killed or treated
as the same chain. Old temporary sandbox state is not migrated across chains.

`npm run studio:start` starts in the background; `studio:status` reports its
instance; `studio:stop` requests authenticated, graceful local shutdown. The
control token stays in the private local runtime file and is never returned by
`/config`. Foreground `studio:sandbox` uses the same persistent chain. The
standalone `sandbox:check` remains an isolated disposable integration suite.

The NEAR database, genesis, local test-wallet keys and workspace ID are retained
under `.data/sandbox-chain`; artifacts remain under `.data/sandbox`. Do not
publish these files. Restart reuses accounts, existing Project state and keys.
If a local node survived its API process, its recorded RPC/genesis identity is
checked before reuse. A mismatched or locked node fails rather than resetting
the workspace. The handoff archive excludes `.data` entirely.

## Testnet viewing and authority

Select **NEAR testnet · public view** in the network picker to discover and
inspect the previously created NFAs. This mode reads the public RPC from the
browser, verifies published manifest hashes and disables signing. It works
without a background API process retaining an external RPC connection. The
SDK now binds native browser `fetch` to its global receiver.

Owner mutations and checkout on real testnet still require a working testnet
API and the appropriate signing wallet. The full new creation and checkout UI
was exercised with the local sandbox wallet; external MyNearWallet redirects
were not automated. Public profile links include network, registry and (for
sandbox) workspace identity, preventing the same `nfa-2` ID from silently
opening on a different chain. A sandbox public link is a local development URL,
not a public Internet deployment.

## Launch and billing details

Minting deposits 6 NEAR: 5.8 to the new vault including code storage, 0.2 to
registry storage. Project setup can spend up to 0.1 NEAR from that vault.
Operating reserve is a target available balance; a separate wallet transfer is
prepared only for a confirmed shortfall. Gas is additional. An uncertain
funding receipt is never inferred from a balance change or blindly repeated.

The selected job earnings are an on-chain minimum margin, not a fixed all-in
price. API quotes take the greater of that floor and the operator's configured
minimum, then add the quoted execution reserve. A real test used a 0.02 NEAR
margin and verified the quote respected it. Service inputs/recall summaries
remain public; runtime attestation does not establish source truth.

## Evidence

- [Integration proof](evidence/studio-ux.json)
- [Compact launch screenshot](studio-compact-launch.jpg)
- [Public profile screenshot](studio-public-profile.jpg)
- [Live testnet discovery screenshot](studio-testnet-discovery.jpg)
- [Earlier hosted testnet proof](OUTLAYER-TESTNET-EVIDENCE.md)

The local OutLayer mock does not provide the real MPC signer, so optional
Sepolia derivation is disabled in sandbox creation. It remains available through
a configured testnet API and the existing reviewed adapter.

The 11 integration checks were local NEAR receipts with the OutLayer mock.
Real hosted Scout/Compare, sale, memory and refund evidence remains the earlier
separate testnet acceptance; no mock result is labeled attested execution.

Legacy collection bookmark verification: the old port 3100 opened the persistent
3102 workspace with Alice selected. My NFAs showed `nfa-1` and `nfa-3`;
`nfa-2` remained owned by Bob. The bootstrap loads one stylesheet before the
application module, avoiding a failed dynamic CSS preload. Final web/SDK builds
and all 54 JavaScript tests passed.

The later release demonstration expands this to 13 local checks, including a buyer earning from the next customer job and separated economics/inventory. See [RELEASE-PLAN.md](RELEASE-PLAN.md) for the newer release milestones and outstanding live gates.
