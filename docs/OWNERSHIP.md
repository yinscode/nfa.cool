# Ownership and transfer threat model

Status: original threat model, with current testnet evidence summarized in
[MILESTONES.md](MILESTONES.md). The registry has minted NFTs; the current live
acceptance NFT is `nfa-2`. Current NEAR/OutLayer and Sepolia handover checks have
passed. The historical T004 one-use vault is retired and must not be funded.
The original attack matrix below is a review checklist, not a statement that
every case has been exercised on live networks.

## Assets, authorities and trust

| Asset / action | Authority | May survive a sale? | Required boundary |
| --- | --- | --- | --- |
| NEAR balance and inventory in `token_id.registry` vault | Vault contract, commanded by registry | Yes | No human or worker full-access vault key; only typed registry commands |
| Derived EVM address and funds | Vault as MPC predecessor plus fixed path | Yes | Never derive from owner's key or allow raw arbitrary payloads |
| NFT ownership and grants | Registry state | New owner only | One guarded transfer routine; epoch invalidates old grants |
| In-flight NEAR or foreign payments | Operation record, nonce, callback or reporter | Must settle before sale | Lock sale while authority outcome is unresolved |
| Agent-owned output, history, public character | Versioned artifacts referenced by registry | Yes | Hash/URI, access policy and provenance |
| Seller's private memory, OAuth grants, copied data | Seller/provider | No automatic transfer | Exclude, revoke app sessions and reconnect provider |
| App-owned membership | Live registry owner lookup | Yes, through reauthorization | Recheck epoch for protected requests |
| Code upgrades and foreign receipt reports | Admin/operator for MVP | Trust assumption | Inventory admin keys and reporter; disclose and constrain |

The registry verifies the immediate caller for owner and delegate operations and
records `(token_id, epoch, op_id, scope, amount, status)` before an asynchronous
vault call. The vault verifies the immediate predecessor is its registry and
rejects repeated or out-of-order operation IDs. An off-chain worker only has an
epoch-scoped grant; it cannot use an access key on the vault. The contract must
reserve amounts and gas before dispatch. A callback may reconcile the exact
recorded operation once; it cannot grant a new privilege to a former holder.

## States and transfer invariant

An NFA is ACTIVE, DRAINING, LISTED or TRANSFER_CALL_PENDING. The registry is
the only mutable authority on ownership. ACTIVE can start budgeted work. DRAINING
stops new privileges and waits for recorded operations. LISTED also freezes
seller-initiated spending, grants, manifest and sale terms. A purchase in the
same registry changes owner and epoch atomically and credits seller proceeds.
All transfer methods, including approved transfers and transfer-call resolution,
must use the same guard. For `nft_transfer_call`, the receiver temporarily appears
as NFT owner before the resolve callback; set TRANSFER_CALL_PENDING first and
permit neither sender nor receiver to start privileged work until resolution.
On acceptance, commit the new epoch and invalidation. On rollback, restore the
old owner and required approvals without issuing a second active owner epoch.
Callback ordering must not allow a transfer to slip between reservation and an
outgoing promise.

For ordinary NEAR calls, transfer requires every authority-bearing operation to
be reconciled. For EVM, a signer response is not settlement: the old holder may
have a valid signature that can be broadcast later. Transfer requires observed
execution or sufficiently finalized same-nonce replacement/cancellation for
every issued signature. If the result is unknown, transfer remains blocked;
there is no normal timeout-based unlock. Registry administration and guardian
contract upgrades remain explicit trusted powers and can change these rules;
the MVP is not immutable or free of operator trust.

## Attack matrix and planned checks

| Seller/attacker path | Prevention rule | Test to require |
| --- | --- | --- |
| Keep a full-access vault key or deploy a substitute contract | Provision without such a key; record deployed code hash and upgrade policy | Enumerate keys/code before and after sale; reject unauthorized deployment |
| Call the vault directly as former owner or worker | Vault accepts only registry predecessor with unique operation ID | Direct call and forged `signer_account_id` fail |
| Reuse NFT approval, worker grant or signed app session | Epoch increment and grant/approval invalidation; app queries current epoch | Previously approved transfer, delegated spend and cookie fail after sale |
| Race two withdrawals or spend near the reserve floor | Reserve balances and budget before dispatch; idempotent callback | Concurrent calls cannot overspend; failed callback refunds once |
| Submit work before sale, dispatch a payment after sale | Register operation before promise; DRAINING blocks new work | Seller queues work, buys concurrently, worker restarts; no post-sale dispatch |
| Seller retains unbroadcast EVM signature | Pending nonce remains guarded until execution or finalized same-nonce invalidation | Withhold signature until after attempted sale; sale stays blocked |
| RPC times out or sees no pending transaction | No inference of cancellation from absence or timer | Drop broadcasts and callbacks; NFA remains DRAINING with recovery path |
| Mutate recipient/chain/fee after owner approves | Typed transaction built under contract checks; chain-specific path | Substitute each field, cross-chain replay and raw digest; all rejected |
| Seller drains or changes skills after posting listing | LISTED freezes outgoing actions and mutable promise terms | Bypass UI, call contract directly; listing remains honest |
| Use `nft_transfer_call` receiver to bypass sale guard or cause rollback | Guard receiver/callback/resolution, lock conflicting operations | Receiver accepts, rejects, errors and triggers concurrent actions |
| Replay a failed mint or account creation | Immutable ID reservation and idempotent provisioning | Failed account init cannot mint twice or strand an untracked funded account |
| Fake income, holdings or credentials in the UI | Distinguish customer receipts, foreign observations and issuer claims | Prefund vs earn, stale RPC vs finalized receipt, forged issuer |
| Keep a protected app session after sale | Check registry epoch on protected actions, revoke cached tokens | Seller uses old cookie while Bob enters with fresh login |
| Keep personal OAuth/API key | Mark as seller-owned; exclude or require reconnection | Buyer cannot read seller's provider account; seller's key stops working in app |
| Retain a copy of prior agent output | Cannot erase information already copied | UI explains what remains accessible; no impossible secrecy claim |
| Operator upgrades registry/vault or lies about foreign execution | Pin/inventory code, admin and reporter; narrow authority, audit logs | Explicit trust disclosure and upgrade/reporter failure test |

## Decisions still needing live evidence

- Is the per-NFA account created without any full-access key, with guaranteed
  recovery from partial initialization? Test the exact account-creation path.
- Can the deployed signer provide the configured ECDSA domain and derived public
  key for vault predecessor/path? Record contract version and actual responses.
- How is an EVM nonce proven consumed or canceled? The MVP may use a configured
  reporter, but sale must remain locked if the reporter is stale or unavailable.
- What happens to holdings when token contracts have transfer approvals, staking
  or delayed withdrawals? Exclude those asset types until separately audited.
- Upgrade powers (review M4). Vault code changes only by a guardian proposal that the
  current owner approves through the registry (`approve_vault_upgrade`, valid one day,
  not while listed) or after a public seven-day delay shown in vault `status`.
  Approval is bound to the ownership epoch: transfer or sale invalidates it, including
  approval messages delivered after the handover. Before deployment the vault asks the
  registry to validate the epoch and lock handovers until deployment settles. The delayed
  recovery path can upgrade a stuck or listed agent, but cannot race a transfer-call;
  buyers cannot buy across deployment. Use 300 TGas for `emergency_upgrade` to cover
  the authorization/deployment/callback chain. Deploy the compatible registry before
  upgrading vaults; legacy timestamp-only approvals need fresh owner approval. The
  registry can upgrade itself through `propose_registry_upgrade` and, two days later,
  `apply_registry_upgrade`; that bound is only real once the operator deletes the
  registry's full-access key. `node scripts/authority-inventory.mjs` lists every key,
  role and pending proposal.
- Review every registry upgrade/admin path and whether TLA's shared wallet design
  can be adapted legally. Its repository exposes no license at the checked commit;
  do not copy its code pending a license grant or separate verification.
