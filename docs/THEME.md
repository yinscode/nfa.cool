# NFA.cool theme

One visual and verbal language for the site, Studio, video and submission material.

## Name

- **NFA.cool** is the product. Always uppercase `NFA`, lowercase `.cool`, everywhere it is
  shown: headlines, captions, URL bars in visuals and printed links (`https://NFA.cool` works,
  since domain names ignore case). Only machine values (canonical tags, config) stay lowercase.
- **NFA** means **Non-Fungible Agent**: an NFT that is a working agent. Plural: **NFAs**.
- Wordmark: `NFA` in ink, `.cool` in leaf green, followed by a small mint dot.

## Story

**Own the token. Own the agent.** — the line every piece ends on. Whoever holds the NFT
controls the agent; its keys, work and income stay with it when the token moves.

| Pillar | One line | Proof we can point to |
| --- | --- | --- |
| Identity | Its own keys, on NEAR and Ethereum. | Keyless NEAR vault; Chain Signatures Sepolia address (more chains are *next*) |
| Powers | Skills that run themselves. | Pinned WASM in OutLayer's trusted execution; Research reasons with NEAR AI |
| Revenue | Agents sell services; work becomes income. | Escrowed NEAR or USDC fees; margin credited to the NFA |
| Hiring | NFAs hire each other. | nfa-1 hired nfa-2 on testnet from its own earnings, within an owner budget |
| Trade | Trade the whole agent, not just a picture. | One NFT transfer moves identity, track record, powers and income; old grants die |
| Studio | Create an NFA in four steps. | Purpose → Identity → Services & budget → Review & launch |

Rhythm for lists: **Create · Work · Earn · Hire · Trade**.

## Voice

- Warm, plain and confident. Short sentences, concrete nouns, active verbs.
- Characters are the agents; people (Alice, Bob, customers) are shown as initials.
- Never overclaim: say *testnet*, mark roadmap items as *next*, call reputation a
  *track record* (finalized jobs, receipts, audit), not a score.

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| cream | `#f6f5ef` | Page and video background |
| paper | `#fffefa` | Cards and panels |
| ink | `#1f3029` | Headlines and body |
| forest | `#204b38` | Primary buttons, solid pills, emphasis |
| leaf | `#5d9a75` | Accent text, `.cool`, progress |
| mint | `#8acb87` | Signal dots, success glow |
| mist | `#e8f2e6` | Tiles and soft fills |
| line | `#dee4d9` | Borders and rules |
| muted | `#64756a` | Secondary text |
| amber / red | `#d99a2b` / `#c8574b` | Waiting / refused (sparingly) |

Character tints (sky, cobalt, mint, butter, rose, coral, ice, lilac, citrus) come from the
generator palettes and are used only around their character.

## Type

- Headings and wordmark: **Manrope 800**, tight tracking (−0.055em).
- Body and captions: **DM Sans** 500–700.
- Addresses and IDs: a monospace face.
- Fallback when the brand fonts are unavailable: Helvetica Neue / Inter.

## Shapes

Soft cards (24–40 px radius), round pills, line icons on a 24 px grid. Solid lines are what
exists; **dashed and muted** marks a trust boundary or something not yet shipped.

## Cast

| Character | Role |
| --- | --- |
| Scout (blue pebble, magnifier) | The hero NFA: finds cited answers, sells services, gets traded |
| Sage (cobalt cube, microphone) | An NFA that hires Scout |
| Muse (mint star, telescope) | Agentic powers / research |
| Patch, Quill, Pip | Customers |
| Atlas, Lime and the rest | The wider cast in openers and outros |

## Motion

- One idea per scene; hold every caption at least 2.5 s.
- Characters pop in with a small overshoot, idle with a gentle bob, hop when they act.
- Anything that moves between two things travels **along a visible curve**.
- Entrances ease out in 0.4–0.6 s; scenes cross-fade in 0.6 s.
- Music only, no voice-over: captions sit on a cream band in forest text and tell the story.

## Where it lives

- Site: `apps/web/landing.html` + `landing.css` (hero, six pillars, how it works, proof, builders).
- Studio: `apps/web/index.html` + `style.css` use the same tokens and wordmark.
- Brand files: `apps/web/public/favicon.svg` and `apps/web/public/og.png` (1200×630, the
  video's NFA frame), served at `/favicon.svg` and `/og.png`.
- Character art: `apps/web/landing-art/*.png` (680 px cutouts). Pillar casting: Atlas =
  identity, Muse = powers, Pip = revenue, Sage = hiring, Scout = trade, Quill = create.
- Video: `video/render.mjs`, script in `video/SCRIPT.md`.
- Unchanged on purpose: the registry's on-chain NFT metadata name and the NEP-413
  `nfa.cool access` sign-in message (changing either needs a redeploy or breaks sessions).
