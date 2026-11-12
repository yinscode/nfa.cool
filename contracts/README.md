# NFA contracts

- `vault/` is the one-use T004 testnet spike. It trapped test assets; **never
  fund its address again**. See `../docs/NEAR-SPIKE.md`.
- `vault-v2/` supports repeated bounded EVM transfers, reporter-confirmed nonce
  advancement, NEAR withdrawals, and guardian upgrade. A keyless testnet vault
  withdrew twice; upgrade was tested before its key was removed. Its guardian is
  an explicit trust assumption.
- The local OutLayer candidate adds registry-only project/version calls, pinned
  skill execution, stable vault-predecessor storage identity and owner-authorized
  memory recall. It is not yet deployed or tested with hosted OutLayer workers.
- `registry/` wraps pinned NEAR NFT standards v5.30.1 for NEP-171, metadata,
  approvals and enumeration. Guarded transfers and async provisioning have
  native VM tests. The earlier corrected registry is deployed on testnet; the
  latest grant, Scout, pinned wallet, EVM lock and sale candidate is local only. Its first
  provision made a funded keyless vault; after the old mint callback failed,
  recovery minted its NFT exactly once. Direct and approved transfers,
  transfer-call rollback and post-transfer treasury authority passed live.

Run `sh scripts/check-contracts.sh` from the project root. It builds the vault
before the registry, which embeds the vault WASM. The pinned standards crate is
vendored under `vendor/` with its upstream MIT license.
