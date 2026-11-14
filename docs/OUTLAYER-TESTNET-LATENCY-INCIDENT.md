# OutLayer testnet execution latency, 2026-11-13

The NFA Research acceptance is blocked by end-to-end latency between
`execution_requested` and OutLayer resolution. The credential and selected
NEAR AI model passed a direct minimal HTTPS probe. The encrypted credential is
bound to the stable vault predecessor and pinned WASM hash. The on-chain
Research requests were valid and paid, but none finalized.

| NFA job | OutLayer request / job | Request UTC | Promise failed UTC | Hosted job record UTC | Result |
| --- | --- | --- | --- | --- | --- |
| 32 | 38478 / 92148 | 12:29:44.629 | 12:31:45.758 | 12:32:34.457 | `resolve_execution`: request not found |
| 33 | 38499 / 92190 | 12:34:53.724 | 12:36:54.182 | 12:37:29.032 | Same error |
| 34 | 38653 / 92625 | 13:05:19.014 | 13:07:20.112 | 13:07:40.787 | Same error |

All three pending promises failed after about 121 seconds. The public hosted
job records appeared 142–170 seconds after request. Each attempt was released
with the contract's recovery method, leaving model usage `UNKNOWN` and the NFA
active with no pending operation. The liability check passes.

OutLayer's contract creates a NEAR yield promise for each request. NEAR's
`promise_yield_create` timeout is a protocol parameter of 200 blocks; changing
the NFA guest's execution limit cannot extend that deadline. See the
[NEAR SDK yield documentation](https://docs.rs/near-sdk/latest/near_sdk/env/fn.promise_yield_create.html)
and [OutLayer contract source](https://github.com/out-layer/outlayer/blob/2d50bfab14389857e6e50e84e76d5652b944e1cc/contract/src/execution.rs#L323).

A paid Scout canary on the **same Project, vault and WASM**, NFA job 35 /
OutLayer request 38672 / hosted job 92686, finalized. Its request was logged at
13:11:01.258 UTC and completion at 13:12:46.758 UTC: about 106 seconds. The
guest's reported execution time was only 1.241 seconds. This canary does not
use the Research secret or model, so the delay is not confined to model
inference. Other testnet NEAR jobs also showed elevated latency during the
investigation. The public receipts do not expose which internal stage was slow.

For OutLayer operations, inspect event relay, coordinator task creation and
claim times, WASM retrieval and compilation, keystore access, and resolve
submission for request IDs 38478, 38499, 38653 and 38672. Confirm that the
request can complete with headroom inside the on-chain promise window. The
public [transaction and release evidence](evidence/m06-real-model-attempts.json)
contains hashes and timestamps without the credential or ciphertext.

The NFA runner now blocks another paid Research retry unless recent NEAR jobs
and a same-Project paid Scout canary each complete within 60 seconds. This is
a safeguard against repeat charges; it does not repair OutLayer's latency.

On 2026-11-14 the user authorized one retry despite the failed health gate.
NFA job 37, OutLayer request 44927, started in transaction
`GWgRh7wMr4i4JRdLw51PEujYybedksabGUjVa7rbSjoB` and reached `UNCERTAIN`.
The reservation was released in transaction
`8gAqH5BWwK7DrPPZnpqt3XXFRWzwo2iQT7LnNecE1ddp`; final status is
`FAILED`, usage `UNKNOWN`, and the registry liability check balances. No
matching hosted row was present among the latest 100 public jobs at the
evidence check time. [One-shot evidence](evidence/m06-research-one-shot-retry.json)
records the exact observation without attributing a cause.

## Additional public checks, 2026-11-13

`GET https://testnet-api.outlayer.ai/public/wasm/exists/578af9bf7adb3a8d40b749ece673b8a8f25d777f7ed2c881a294628f4e3a7dfe`
returned `exists: true`, with a cache creation timestamp of
2026-11-12 20:56:09 UTC. The pinned bytes are therefore in the coordinator's
public WASM cache; this does not prove they are warm in each executor.

`GET https://testnet-api.outlayer.ai/public/workers` showed two online
testnet executors with very short reported uptimes. One executor's uptime
fell from 48 seconds at 14:57:15 UTC to 5 seconds at 14:57:32 UTC while its
worker ID remained the same; its completed and failed counters also increased.
This establishes a worker restart during the sample, not why it restarted.
Repeated restarts could contribute to preparation or queue delay and should
be checked in the operator logs.

OutLayer's existing [testnet WASM timeout issue](https://github.com/out-layer/outlayer/issues/33)
and [cache/worker restart issue](https://github.com/out-layer/outlayer/issues/32)
describe related symptoms. Their root cause need not be the same as this
incident; the request IDs above allow OutLayer to compare the paths.
