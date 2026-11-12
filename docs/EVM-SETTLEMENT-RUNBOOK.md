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

The RPC/reporter remains trusted. Reorg and withheld-transaction uncertainty keep
the NFT locked. The new worker is locally verified; no new live Sepolia sequence
is claimed. The release gate remains: fund the current NFA address, settle one
transfer, prove pending-sale rejection, sell, preserve its address, and settle a
buyer's next transfer while rejecting the former owner's commands.

`GET /v1/nfas/:tokenId/holdings` labels the observed block and unavailable RPC.
It reports an observed balance, not finality or automatically spendable value.
