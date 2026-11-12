# Sepolia submission and recovery

Set `NEAR_RPC_URL`, `NFA_REGISTRY_ID`, `EVM_RPC_URL`,
`NFA_SETTLEMENT_REPORTER_ACCOUNT_ID`, `NFA_SETTLEMENT_REPORTER_KEY_FILE` and
`NFA_DATA_DIR`. The key file has the standard NEAR `account_id`/`secret_key`
shape, stays private and must match the vault's configured reporter. No key is
accepted from an HTTP customer. Use a single reporter process per account.

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
Stale `.lock` files after a process crash also require checking that no writer is
active before manual recovery. There is no timeout-based sale unlock.

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

The NFT stays locked until a finalized receipt proves the nonce was consumed. If a
different signature over an identical payload lands, the reporter records its hash
with `mark_evm_broadcast(..., attempt: null)` before reporting. These paths need
the upgraded vault (`recovery_interface: 1` in `status`).

The RPC/reporter remains trusted. Reorg and withheld-transaction uncertainty keep
the NFT locked. M02 settled two live Sepolia self-transfers across a sale with
this worker ([evidence](evidence/m02-handover.json)). Replacement and re-sign
paths are verified natively and in the settler tests, not yet on Sepolia.

`GET /v1/nfas/:tokenId/holdings` labels the observed block and unavailable RPC.
It reports an observed balance, not finality or automatically spendable value.
