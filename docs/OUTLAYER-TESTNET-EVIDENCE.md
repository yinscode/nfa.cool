# Studio and OutLayer testnet acceptance — 2026-11-12

**Passed:** vault-owned Scout and Compare, customer payment/replenishment,
Alice-to-Bob sale, Bob character revision and old-memory recall, old-owner/session
rejection, different pinned runtime with unchanged UUID, pending listing lock,
definite guest failure, full customer refund and safe owner resume.

| Identity | Value |
| --- | --- |
| Registry | `nfagent-registry-0e9b2a.testnet` |
| NFT / stable vault | `nfa-2` / `nfa-2.nfagent-registry-0e9b2a.testnet` |
| Project / UUID | `nfa-2.nfagent-registry-0e9b2a.testnet/scout` / `p0000000000000163` |
| V1 SHA-256 | `b2cf2dd2b606ec158ad275d3d15cc5934197d3d9a494d01279a552167c41cbf9` |
| V2 SHA-256 | `88b8ab0b0cdc589b46f4407e1738a15fdc8c090a1a70cd783e83d36634337a9e` |
| Registry release SHA-256 | `99fd106f60d79b4b4fa289fee9c2630b0412fd25ddb849ab04243344c1bb0636` |
| Registry upgrade transaction | `HCRLKhogd8DadMV3PVNa83CYEv8h9hr6a8vekS1LPpHk` |

The same keyless vault owns the Project and is the storage predecessor before
and after sale. Changing the human signer alone is not the storage design.
The guest embeds `storage_account: predecessor`. Current registry, vault and
OutLayer views agree. The pinned Sepolia address also stayed unchanged.
Existing `nfa-1` state survived the registry upgrade; the acceptance uses a
newly created vault to avoid silently assuming old vault code changed.

## Transactions

| Check | Finalized transaction |
| --- | --- |
| Mint | [FnrDMKvaq2YXfGysUszezuf9nUCvfoD1YWUXirVUeD7H](https://test.nearblocks.io/txns/FnrDMKvaq2YXfGysUszezuf9nUCvfoD1YWUXirVUeD7H) |
| Scout | [3vMtgjdpSCQYY6mZix4h3xCtRNCWxXZc4Mmmy6Ao3ADt](https://test.nearblocks.io/txns/3vMtgjdpSCQYY6mZix4h3xCtRNCWxXZc4Mmmy6Ao3ADt) |
| Compare | [3CJ3rzg1VmUQjTEk6BuBsXrD4fb5jhqjFAJ8XGdon7Rt](https://test.nearblocks.io/txns/3CJ3rzg1VmUQjTEk6BuBsXrD4fb5jhqjFAJ8XGdon7Rt) |
| List | [J8rG5QaQUjZKCdmmoQMiRix6mBRpUWe4dUMAaPsefx3q](https://test.nearblocks.io/txns/J8rG5QaQUjZKCdmmoQMiRix6mBRpUWe4dUMAaPsefx3q) |
| Buy | [HUdVDWJs3iHJL7t2BQFxNaByqSw1Nsqjwhk73qZFUYY3](https://test.nearblocks.io/txns/HUdVDWJs3iHJL7t2BQFxNaByqSw1Nsqjwhk73qZFUYY3) |
| Buyer character edit | [2EmSPUAHVBiT4KfLXURP8R3SfbZcmc71S6AmTKMrY9QK](https://test.nearblocks.io/txns/2EmSPUAHVBiT4KfLXURP8R3SfbZcmc71S6AmTKMrY9QK) |
| Buyer memory recall | [TFhDciYMmAB68LRYbqnwKADZYdYKAjFj66ieNwCwDrD](https://test.nearblocks.io/txns/TFhDciYMmAB68LRYbqnwKADZYdYKAjFj66ieNwCwDrD) |
| Old owner recall rejected | [CqwxmxaUjZdDwucXBuP2NkExsTYhQGcLoMJ68yExRLVb](https://test.nearblocks.io/txns/CqwxmxaUjZdDwucXBuP2NkExsTYhQGcLoMJ68yExRLVb) |
| Activate V2 | [4RJWc79Y8LuDkKpYvToLrG9XkgV4LZbvANZdgLtiF9s3](https://test.nearblocks.io/txns/4RJWc79Y8LuDkKpYvToLrG9XkgV4LZbvANZdgLtiF9s3) |
| Recall V1 memory under V2 | [AkdhSnxc8HCpJV7S55uLLMM6V7VGy3EeTA6MD6C8Ndju](https://test.nearblocks.io/txns/AkdhSnxc8HCpJV7S55uLLMM6V7VGy3EeTA6MD6C8Ndju) |
| Listing during pending job rejected | [E4PQWS6dzZ1m4CPD8Wvf7kDEw9Mmnt7PAmViUpQoxw8R](https://test.nearblocks.io/txns/E4PQWS6dzZ1m4CPD8Wvf7kDEw9Mmnt7PAmViUpQoxw8R) |
| Definite guest failure | [47qzDNhQWNMsTXZwNDZTkrR6Y1ChTKJyanB72MpSaFQm](https://test.nearblocks.io/txns/47qzDNhQWNMsTXZwNDZTkrR6Y1ChTKJyanB72MpSaFQm) |
| Proved vault clear and resumed | [8KjBZ7WrHQ5bZQibw21d4rS3rBv14JQ77QrT9dmNsJpB](https://test.nearblocks.io/txns/8KjBZ7WrHQ5bZQibw21d4rS3rBv14JQ77QrT9dmNsJpB) |
| Customer refund withdrawn | [JDAgpv1QTomgCGsuBg7zu3FQTGvw5BAXFkuGkhM5ngVS](https://test.nearblocks.io/txns/JDAgpv1QTomgCGsuBg7zu3FQTGvw5BAXFkuGkhM5ngVS) |
| Reviewed quote paid and completed | [4H8wxVPWYZzaL9TLgEwCZhsHtPZH58tZBW2vU77LjnjM](https://test.nearblocks.io/txns/4H8wxVPWYZzaL9TLgEwCZhsHtPZH58tZBW2vU77LjnjM) |

The latest quote method rejected stale runtime and policy versions without
incrementing the operation counter, then accepted a current quote as job 11.
The V2 release appends metadata only; executable logic is unchanged. It is a
version/storage-continuity check, not a claim of new runtime functionality.

## Measured execution costs

Native NEAR amounts below exclude transaction gas and Project storage.
Scout/Compare fee was 0.01240012 NEAR: 0.00240012 replenished the vault and
0.01 became NFA income. The OutLayer unused deposit refund also returns to the
vault. These are different flows; do not count the deposit refund as customer
income. After the extra reviewed quote, NFA unclaimed income was 0.03 NEAR;
customer escrow and replenishment liability were both zero. The definite failed
job credited its entire fee back to the customer and that credit was withdrawn.

| Hosted operation | Charged NEAR | Unused deposit refund NEAR | Worker ms |
| --- | --- | --- | --- |
| scout | 0.0010879 | 0.00131222 | 879 |
| compare | 0.0011184 | 0.00128172 | 1184 |
| buyer-recall | 0.0011474 | 0.0018526 | 1474 |
| version-recall | 0.0011563 | 0.0018437 | 1563 |
| reviewed-quote | 0.001091 | 0.00130912 | 910 |

## Execution evidence

[Saved task quotes](evidence/studio-attestations.json) bind five finalized
operations to their expected executed WASM, caller, Project and exact wrapped
execution input. Each TDX quote v4 report-data hash matches its task fields.
The registry's artifact commitment differs from the worker's stdout hash;
the record labels both. Full artifacts are separately reconstructed from public
start input and checked against finalized artifact commitments.

This capture does **not** independently verify Intel collateral/certificate
chains. Attested execution does not prove source claims or LLM factual accuracy.
Scout/Compare are bounded deterministic handlers of supplied public text.

Public replay records:

- [Main demo](evidence/studio-testnet.json)
- [Failure, refund, version and empty-cache checks](evidence/studio-final-gates.json)
- [Stale quote and paid job](evidence/studio-reviewed-quote.json)
- [Runtime staging](evidence/outlayer-v2.json)
- [Old deployed bytecode upgrade rehearsal](studio-upgrade-rehearsal.json)
- [Full sandbox measurements](evidence/studio-sandbox.json)
- [Build hashes](evidence/studio-builds.json)

## Earlier worker failures

The first disposable signer-owned probe did fail. Public worker diagnosis later
showed execution-result submission reporting `Execution request not found` after
compilation/queue delay outlived the yielded request. A separately journaled
warm execution succeeded, followed by both services and recall; the vault-owned
acceptance above then passed. No failed probe was relabeled successful, and no
ambiguous paid transaction was blindly resent. Original diagnostic records are
retained under `deployments/` locally. The disposable probe UUID `p000000000000015f`
is distinct from the NFA's UUID `p0000000000000163`.
