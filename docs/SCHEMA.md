# T005 identity, operations and events

`(registryAccountId, tokenId)` is immutable. `vaultAccountId` binds once at
successful provisioning. Owner and `ownerEpoch` change only on a finalized
transfer; rollback keeps the original epoch. Lifecycle and pending operations
belong to the registry. The vault never derives authority from the transaction
signer or a cached owner address.

Fixtures in `packages/shared/fixtures/` use camelCase in the API and SDK.
Rust contract arguments and NEAR views use snake_case, with a fixed mapping:

| SDK/API | Contract | Meaning |
| --- | --- | --- |
| `tokenId` | `token_id` | Permanent registry token ID |
| `vaultAccountId` | `vault_id` | Keyless sub-account |
| `ownerEpoch` | `epoch` | Current authority version |
| `lifecycle` | `lifecycle` | ACTIVE, DRAINING, LISTED, TRANSFER_CALL_PENDING |
| `id`, `status` | `operation_id`, `status` | Monotonic operation and disposition |
| `manifestHash`, `manifestUri` | `manifest_hash`, `manifest_uri` | Public content commitment and URI |

Operation statuses are REQUESTED before dispatch, SUBMITTED for a pending
promise/signature, FINALIZED after a positive callback or authenticated receipt,
FAILED after a definite failure without residual authority, and UNCERTAIN
when a signature or foreign state may still be actionable. A missing EVM
transaction is not evidence of failure. `NfaManifest` describes public
character, skills and credentials without disclosing personal OAuth secrets.
NFA events use `EVENT_JSON` envelopes; NFT mint/transfer events use NEP-297.

The MVP's EVM receipt reporter is trusted and must be named in deployment
records. It cannot clear an uncertain foreign operation merely because a
request timed out; a mined same-nonce transaction or a governed recovery
procedure is required. This is an application trust assumption, not a NEAR
Chain Signatures guarantee.
