# Create, configure and hire an NFA from code

Run `npm ci && npm run check`. Start the persistent sandbox with
`npm run studio:start`, or point at a configured testnet API.

The TypeScript SDK prepares unsigned transactions; a wallet adapter signs them.
`NfaServicesClient` discovers services, quotes input, reconciles payment against
the exact runtime/policy/payer, reads jobs and prepares start transactions.

```js
import {NfaSdk, NfaServicesClient} from '@nfa/sdk';
const sdk = new NfaSdk({registryAccountId, rpcUrl});
const api = new NfaServicesClient({baseUrl});
const quote = await api.quote('nfa-3', 'scout', {question, sources});
// Review the quote; retain exact inputData and quote before asking the wallet.
const payment = await wallet.signAndSendTransaction(quote.unsignedAction);
const {jobId} = await api.inspectPayment({quote,
  hash: payment.transaction.hash, sender: customerAccountId});
const {unsignedAction} = await api.prepareStart('nfa-3', 'scout', jobId, quote.inputData);
await wallet.signAndSendTransaction(unsignedAction);
console.log(await api.job('nfa-3', 'scout', jobId));
```

For creation through paid work, import `createAndRun` from
`examples/create-and-run.mjs`. Supply SDK, API URL, separate owner/customer wallet
adapters, a stable request ID, display name, Scout input, a maximum customer fee
and a durable `checkpoint` with `load()`/`save(state)` methods. It creates an
avatar/manifest, mints, provisions a reviewed OutLayer Project, enables Scout,
pays and starts using the registry-assigned job ID. Invoke again to inspect an
unfinished job; it never allocates a second payment for an uncertain submission.
The example does not derive a cross-chain key or silently top up a low vault.
Minting deposits 6 NEAR; Project setup authorizes up to 0.1 NEAR from the vault;
gas and the explicitly capped customer payment are additional.

The checkpoint must be private and durable before signing. A crashed wallet
redirect with no saved hash requires inspection of wallet history; save the
exact hash after verification. Do not erase the claim and rerun. An expired
unpaid quote needs explicit checkpoint replacement after checking for payment.

## Service package format

See `service-packages/scout.json`, `compare.json` and the research candidate.
Run `node scripts/validate-service-package.mjs` or pass a package filename.
Packages commit input/output schemas, runtime, tools, permissions, memory,
resource limits and pricing responsibilities. Validation does not install code
or authorize a service. Adding a new service requires reviewed contract/guest
adapters and hosted acceptance before its discovery/checkout is enabled.

`GET /v1/service-packages` exposes descriptors, including candidate status.
`GET /openapi.json` serves `docs/openapi.json`. The OpenAPI lists the release
workflow endpoints; transaction-specific arguments remain in the SDK.
