# Sepolia submission and recovery

Set `NEAR_RPC_URL`, `NFA_REGISTRY_ID`, `EVM_RPC_URL`,
`NFA_SETTLEMENT_REPORTER_ACCOUNT_ID`, `NFA_SETTLEMENT_REPORTER_KEY_FILE` and
`NFA_DATA_DIR`. The key file has the standard NEAR `account_id`/`secret_key`
shape, stays private and must match the vault's configured reporter. No key is
accepted from an HTTP customer. Give the reporter a FunctionCall access key limited to
`mark_evm_broadcast`, `reconcile_evm` and `report_evm_receipt`, never a full-access key
(`node scripts/authority-inventory.mjs nfa-2` reports it). Reporter signing is serialized
per account with a pid lock, so concurrent settlers cannot collide on one access-key nonce.

Set `EVM_RPC_URLS` to several independent Sepolia providers, comma-separated. Every one
must report the same finalized receipt, and the sender's finalized nonce must have passed
the transaction, before any lock is released. A single URL still works but is reported as a
single trusted provider.

```sh
node scripts/settle-evm.mjs nfa-2
node scripts/settle-evm.mjs nfa-2 --send --watch
```

Default is inspection only. `--send` processes only an already signed, pending,
typed Sepolia operation; it cannot request fresh spending or arbitrary signing.
It saves exact EVM bytes before broadcast, checks the RPC chain before sending,
requires at least three confirmations, a matching canonical block/unchanged
receipt and an RPC finalized head at or beyond the receipt block,
then processes registry mark, vault report and registry reconciliation.
Each NEAR reporter action is signed once and persisted before network submission.
Only its exact bytes are replayed after an unknown response; a new nonce/signature
is not created to replace an unresolved reporter action.

Keep `.data/evm-settlement` and `.data/evm-reporter` on durable private storage.
Never paste or publish these journals; they contain signed transactions. The
handoff archive excludes them. An expired or definitively failed reporter
transaction requires operator inspection of finalized contract state before a
new intent can be authorized. Do not erase an unknown intent to trigger a retry.
There is no timeout-based sale unlock.

## Stuck or uncertain transfers

- **Signer timeout** (`mpc_signature_unresolved`, recovery `retry_evm_signature`):
  the owner or reporter calls `retry_evm_signature`. The vault asks for a
  signature over the identical digest, so any late signature authorizes the same
  transaction.
- **Request never began in the vault:** permissionless `recover_evm_operation`
  fails it from vault status.
- **Not mined**, for example because the fee is below the base fee: the owner calls
  `replace_evm_transfer` with fees at least 10% higher, or `cancel: true` for a
  zero-value self-send. The vault keeps every earlier signed candidate
  (`evm_candidates(nonce)`). The settler journals each as attempt *k*
  (`<token>-<id>-r<k>.json`), observes all of them, and marks and reports whichever
  one is finalized. A landed cancellation consumes the nonce and marks the
  transfer `Failed`.

The NFT stays locked until a finalized receipt proves the nonce was consumed. The upgraded
vault accepts a receipt only for a transaction hash it can rebuild from a signature it holds
for that nonce, so a reporter cannot name an unrelated transaction. These paths need the
upgraded vault (`recovery_interface: 1` in `status`).

A crashed settler's stale `.lock` is reclaimed automatically once its process is gone. A
reporter intent that never landed is retired (kept as `*.expired-*.json`) and re-signed after
48 hours, past NEAR's transaction validity window; reporter calls are state-checked on chain.

The RPC/reporter remains trusted. Reorg and withheld-transaction uncertainty keep
the NFT locked. M02 settled two live Sepolia self-transfers across a sale with
this worker ([evidence](evidence/m02-handover.json)). Replacement and re-sign
paths are verified natively and in the settler tests, not yet on Sepolia.

`GET /v1/nfas/:tokenId/holdings` labels the observed block and unavailable RPC.
It reports an observed balance, not finality or automatically spendable value.
