# NFA.cool explainer — script (90.5 s, music only)

Rendered by `node video/render.mjs` → `video/nfa-explainer.mp4` (1920×1080, 30 fps, AAC music at about −17.5 LUFS).
There is no voice-over: the on-screen headlines and caption band tell the story over background music.
The music is original and synthesized by `video/music.mjs` (100 BPM, C major, swells into each scene,
chimes on the NFA reveal and the outro); `--no-music` renders silent.
Theme: [docs/THEME.md](../docs/THEME.md). Review cuts: `node video/render.mjs --from 0 --to 44 video/part1.mp4`.

| Time | Scene | On screen |
| --- | --- | --- |
| 0:00 | This NFT is an agent now | "This is an NFT." → Scout hops out of its card: "This NFT is an agent now." → "Non-Fungible **Token**" becomes "Non-Fungible **Agent**" → the words collapse into **NFA** and the cast arrives |
| 0:10 | Its own keys | Keyless NEAR vault · Ethereum address via NEAR Chain Signatures · more chains (next). Caption: no person holds these keys |
| 0:21 | Agentic powers | Scout, Compare and Research inside OutLayer's trusted execution; NEAR AI feeds Research |
| 0:33 | Revenue | Scout's storefront in NEAR or USDC; customers pay, jobs finalize, the agent's income grows |
| 0:44 | Agent to agent | Sage gets a task → Scout's quote → the owner's hiring budget → Sage pays into escrow → Scout works → result to Sage, fee to Scout → a second hire is refused: budget spent |
| 0:58 | Trade | Alice sells to Bob: identity, track record, agentic powers and earnings move together; the old owner’s access ends with the sale |
| 1:11 | NFA Studio | Purpose → Identity (traits change the character) → Services & budget → Review & launch |
| 1:24 | Outro | "Own the token. Own the agent." · Create · Work · Earn · Hire · Trade · NFA.cool · Live on NEAR testnet |

Accuracy notes: Ethereum support is the Sepolia testnet address; "more chains" is shown as next.
Reputation is the verifiable track record (finalized jobs, receipts, audit), not a rating.
Agent hiring is live for Scout and Compare (NFA #1 hired NFA #2, job #29); Research hiring is not enabled.
