# Token checkout, Intents, and NFA hiring

The NFA hiring registry upgrade is live on NEAR testnet and has a paid hosted
Scout acceptance receipt. Direct FT checkout has live Circle testnet USDC
payment, completed-job, and full-refund receipts. Intents remains locally tested
without a live payment. M06 Research acceptance subsequently passed through
the native NEAR and vault Payment Key path; see
[Research acceptance](RESEARCH-ACCEPTANCE.md).

## Stablecoin checkout

The registry still takes native NEAR for execution reserve, storage, and agent income.
`PaymentCheckout` in `services/api/payment-checkout.mjs` acts as a merchant ledger:

1. `POST /v1/nfas/:id/services/:service/checkout/token/quotes` accepts the normal typed
   service `input`, `tokenContract`, and `payer`. The server checks the merchant's
   FT storage registration and free NEAR reserve across outstanding quotes, then creates a five-minute
   token quote using the privately configured atomic-token-per-NEAR rate. The reply
   contains an unsigned NEP-141 `ft_transfer` with a unique quote memo. The merchant
   account must already be registered for that token (NEP-145).
2. The payer signs that transfer. `POST /v1/checkouts/:id/confirm-payment` with `hash`
   verifies final success, signer, token contract, recipient, exact amount and memo.
   The receipt can be claimed only once, even across process restarts.
3. `GET /v1/checkouts/:id/funding-action` returns the pinned native-NEAR registry
   action. The merchant signs it with its own wallet. `POST .../confirm-funding`
   checks the final transaction, exact call arguments and assigned job event before
   recording the job ID. The existing `prepare-start` endpoint starts the job.
4. `POST .../reconcile` reads final job state. A failed job's on-chain
   `refund_credit` determines the proportional token refund, rounded up by at
   most one atomic unit for the payer. For a direct token
   payment, `GET .../refund-action` prepares the merchant's token transfer and
   `POST .../confirm-refund` verifies its final receipt. A late payment is fully
   refundable and cannot fund an expired job quote.

The merchant must reserve enough native NEAR for funding and enough of each token
for refunds. The journal at `NFA_DATA_DIR/checkout/checkout.json` is private and
must be durable. The rate is an operator quote, not a price oracle. Until an
operator funds and reconciles a checkout, its token receipt is a merchant
liability. No automated merchant signer is installed.

Enable the adapter privately with `NFA_CHECKOUT_JSON`:

```json
{"merchantAccountId":"merchant.testnet","assets":{"usdc.testnet":{"atomicPerNear":"3000000"}}}
```

`atomicPerNear` is the number of smallest token units charged for one NEAR; it
must be updated when the exchange rate changes. Use an actual allowlisted FT
contract, not the example IDs. Circle's testnet USDC uses a 64-character
implicit contract account, which the adapter accepts. The dedicated testnet
merchant, token storage registration, reserve, and refund process now have
live receipts. The example rate is illustrative and needs independent review
before any production offer.

## NEAR Intents

`POST /v1/nfas/:id/services/:service/checkout/intents/quotes` asks 1Click for an
`EXACT_OUTPUT` quote that delivers the configured NEP-141 token to the merchant.
The user supplies `originAsset` and `refundTo`. The reply gives the 1Click deposit
address. The adapter checks the returned status, original quote terms, output
asset and amount. It **also requires an independent destination receipt verifier**
before marking the payment funded. Set `NFA_ONECLICK_DESTINATION_SENDERS` to the
known NEAR signers of the destination transaction; the verifier reads the
1Click-listed transaction from final NEAR RPC and requires a NEP-141 transfer
event crediting the exact merchant and at least the quoted amount. If the signer
list is absent, quote creation fails closed; if no matching event is found,
`confirm-payment` fails closed.
1Click has no testnet; this route requires a mainnet registry and merchant and
is not usable with the current testnet deployment. The 1Click JWT remains
server-side in `NFA_ONECLICK_JWT`. An Intents-funded job that fails needs a
separately reviewed return swap to `refundTo`; the current direct-token refund
action does not apply.

## NFA hires NFA

`POST /v1/nfas/:target/services/:service/quotes` accepts `hiredBy:"nfa-2"`.
The quote checks the source NFA's active state and accrued NEAR income. Its
unsigned `hire_reviewed_service_job` action pins the source owner epoch, target
runtime and policy, and exact maximum fee. The source owner can sign it or grant
a worker `NFA_HIRE` for one target token ID, a total yoctoNEAR budget, and an
expiry. The allowance decreases by each gross fee and becomes stale on sale.
The registry moves the fee from source income to target job escrow without
changing aggregate NEAR liabilities. Unused funds and job refunds return to the
source NFA, so they follow its NFT on sale. A source cannot hire itself.

Hiring is currently limited to Scout and Compare. Their public start input lets
the source owner reconstruct a finalized artifact and check it against the
on-chain output commitment through the Studio work endpoint. Research results
remain encrypted to the target vault; Research hiring needs a separate
recipient-bound delivery design before it can be enabled.

## Evidence and remaining payment gates

The [pinned registry WASM](../releases/nfa-registry-hiring-b733b54b7ea955c6.wasm)
has SHA-256 `b733b54b7ea955c6f95042f3ecbe27ad2391dbaa83409416d2dc9cdc790295b4`.
The [exact-current upgrade rehearsal](evidence/hiring-upgrade-rehearsal.json)
preserved nonzero liabilities and NFA identity. The [live read-only preflight](evidence/hiring-upgrade-preflight.json)
matched 0.12760024 NEAR of liabilities and calculated a 0.0140666828161075
testNEAR top-up to retain a 0.1 testNEAR registry reserve after deployment.
The full local judge passed
91 JS, 85 registry, and 25 vault tests, plus a sandbox delegated buyer-hiring flow.
The [testnet rollout](evidence/hiring-testnet-rollout.json) preserved both NFA identities
and 0.12760024 testNEAR of liabilities. The [live hiring acceptance](evidence/hiring-testnet-acceptance.json)
then spent 0.03 testNEAR of `nfa-1` income under a target-bound `NFA_HIRE`
grant. `nfa-2` Scout job 29 finalized on its existing Project. A second
otherwise valid hire was rejected after the grant reached zero, without
reducing source income.
The [Circle USDC checkout acceptance](evidence/ft-checkout-testnet-acceptance.json)
records two 0.037201 test USDC payments: Scout job 30 finalized, while job 31
was cancelled before start, fully refunded in USDC, and its 0.01240012 testNEAR
registry credit was claimed by the merchant. The payer's net spend was exactly
0.037201 test USDC. The acceptance runner uses the same `PaymentCheckout` class
and quote logic as the API; the REST API is still locally served, not publicly
hosted. The [final liability reconciliation](evidence/live-liability-reconciliation.json)
matches 0.14560024 testNEAR after those jobs and the merchant claim. The
Intents route still requires mainnet acceptance; mocked Intents receipts in the
JS suite are local evidence only.

Protocol references: [NEP-141 and NEP-145](https://docs.near.org/primitives/ft/standard),
[NEAR Intents 1Click](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request),
[1Click testnet status](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction).
