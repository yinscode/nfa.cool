# Stable testnet hosting

> **Status:** [NFA.cool](https://NFA.cool) runs as a hosted testnet preview (Scout and Compare
> quotes; Research uses a separate hosted acceptance path). The external-wallet acceptance
> checklist below is still open.

The API serves the compiled web UI and REST on the same origin. Use a persistent
Node 22 container behind HTTPS. Do not publish the local sandbox wallet bridge.

1. Build `docker build -t nfa-studio .` (build runs the JavaScript acceptance tests).
2. Mount a durable writable volume at `/data`, owned by uid 1000. Set
   `NFA_DURABLE_DATA=1` only after this mount exists. The flag is an operator
   assertion, not automatic proof of persistence.
3. Set `NFA_PUBLIC_ORIGIN=https://<your-host>`, `NFA_REGISTRY_ID` and
   `NEAR_RPC_URL`. Set the reviewed Scout/Compare quote policies from
   `.env.example`. Keep these in the host's secret/configuration manager.
4. Route HTTPS to container port 3102. Use `/healthz` for process liveness and
   `/readyz` for registry/storage readiness. RPC failure returns 503 without
   implying that the process or an outstanding transaction has disappeared.
5. Back up `/data`; restore to another instance before calling deployment durable.
   Run one API instance initially: wallet sessions and rate limits are in memory.
   Sign in again after restart. Proxy rate limits are required for a shared proxy
   IP; forwarding headers are not trusted as client identities by this API.
6. S3 is optional with a persistent volume. The S3 adapter needs AWS CLI v2 and
   its credential chain in the runtime image; the default image uses the volume.
   Never expose a private work bucket directly as a public website.

## External-wallet acceptance (must run on the final HTTPS origin)

- Connect MyNearWallet; confirm expected testnet registry and owner.
- Create with a distinct request ID; interrupt after mint and resume without a
  duplicate NFT, Project or funding transfer.
- Pay for Scout; refresh after payment; inspect its exact finalized receipt and
  assigned job ID; start and observe finalization.
- Recall work with NEP-413. Verify the challenge's origin/callback use the public
  origin, rather than a loopback URL.
- Alice lists; Bob buys and recalls prior work; Alice's old session is rejected.
- Restart the API/container; artwork, manifests and inputs remain available.

No public deployment is claimed until its URL, image digest, durable-volume
restore evidence and external-wallet receipts are recorded in RELEASE-PLAN.md.

Run `NFA_STUDIO_URL=https://<your-host> NFA_RELEASE_TOKEN_ID=nfa-2 npm run
release:preflight -- --live` against the final deployment. It checks configuration,
readiness, packages, API schema and business views; it does not replace the
external-wallet checklist above. Backend RPC credentials stay server-side;
browser configuration uses the approved public testnet RPC.
