# NFA local development and testnet release

The Studio registry release is now deployed on testnet. The former candidate
label is historical. Use [STUDIO-RUNBOOK.md](STUDIO-RUNBOOK.md) for the current
local/sandbox setup, [NFA-STUDIO-STATUS.md](NFA-STUDIO-STATUS.md) for S001–S022,
and [OUTLAYER-TESTNET-EVIDENCE.md](OUTLAYER-TESTNET-EVIDENCE.md) for real hosted
acceptance. Public production hosting has not been provisioned.

Studio provides reviewed character mint/edit, vault and chain-key controls,
transaction policy, delegate grants, runtime/version management, Scout/Compare
service quotes, paid jobs, memory recall, artifact access, sale/transfer and
receipt audit. REST prepares unsigned transactions; wallets sign them.
`npm run studio:sandbox` supplies a strictly local wallet selector for fast work.

The older Node Scout worker remains a separate execution lane. The hosted
release uses the stable NFA vault's OutLayer Project, not an owner-bound storage
cell or a delegated worker pretending to be the OutLayer host. See
[SERVICES-API.md](SERVICES-API.md) for service endpoints.

## Cross-chain safety boundary

The vault derives a fixed Sepolia address and signs a bounded typed native ETH
transfer through NEAR MPC. The registry keeps the NFA locked from request through
positive receipt reconciliation. The worker's EVM journal persists the exact raw
transaction before broadcast and replays those same bytes after uncertainty.
`assemble-evm.mjs` verifies MPC output; `settlement.mjs` checks the observed
receipt. The reporter is trusted; neither RPC data nor finality is proven to
NEAR. A restart-safe broadcast/reporter worker is now implemented and locally
tested; it has not completed a new live EVM release run. See
[EVM-SETTLEMENT-RUNBOOK.md](EVM-SETTLEMENT-RUNBOOK.md). The pinned address must be derived before signing. Other ERC-20s,
NFTs, intents, personal SaaS access and outside custody are not in this release.
