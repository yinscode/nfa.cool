# NEAR HACKATHON submission

Rules: https://nearhackathon.com/HACKATHON.md (re-read the live version before submitting).
Deadline: **2026-11-14 23:59 UTC** (2026-11-15 06:59 Bangkok). Submit **once**, at
https://nearhackathon.com/#apply (or `POST https://nearhackathon.com/api/applications`).
Submissions cannot be edited; corrections go through https://nearhackathon.com/request-changes.
Each repository can be submitted only once.

## Checklist

| Requirement | Status |
| --- | --- |
| Public repository by the deadline, kept public through judging | Done: https://github.com/yinscode/nfa.cool |
| LICENSE file | Done: MIT |
| README explains the product and problem, with "do X → see Y" steps | Done: [Try it yourself](../README.md#try-it-yourself) |
| Demo post on X: says built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon, has video or screenshots | Done: https://x.com/yins_xyz/status/2121730500964573394 |
| Judges can open the demo | Done: https://NFA.cool (hosted testnet preview) and `npm run judge` locally |
| Prior work separated and disclosed | Done: [Hackathon scope and prior work](../README.md#hackathon-scope-and-prior-work) |
| Libraries, templates and AI-generated code listed | Done: [Built with](../README.md#built-with) |
| Testnet-only is eligible for all tracks | Yes |

## Form answers

| Field | Answer |
| --- | --- |
| Project name | NFA.cool |
| Lead name | *(yours)* |
| Email | *(yours)* |
| Team size | *(yours)* |
| Tracks | `nfts` (NFTs That Do Something), `agents` (Agent Economy), `business` (Autonomous Business) |
| Mainnet NEAR payout account | *(yours: a mainnet account, not testnet)* |
| Repository | https://github.com/yinscode/nfa.cool |
| Demo post | https://x.com/yins_xyz/status/2121730500964573394 |
| Contact notice | Tick the consent box |

### Project description (1419 of 2000 characters)

```text
NFA.cool turns an NFT into a working AI agent: a Non-Fungible Agent. Each NFA has its own accounts (a keyless NEAR vault and an Ethereum Sepolia address derived with Chain Signatures), skills that run as pinned WASM in OutLayer's trusted execution (Research reasons with NEAR AI), paid services with escrow and income, and an on-chain track record. NFAs can hire each other from their own earnings within a budget the owner sets. Selling the NFT hands the buyer the whole working agent: the same vault, address, skills and eligible finalized work, while ownership epochs cut off the former owner.

Live on NEAR testnet: NFA #2 has finished 12 paid jobs. NFA #1 hired NFA #2 (job #29), and a second hire past the budget was refused on-chain. A sale moved the owner epoch from 2 to 3, and the buyer ran a new paid job on the seller's finished work. USDC checkout ran on testnet through the acceptance runner.

Try it at https://NFA.cool (hosted testnet preview): browse live NFAs and get quotes, or create one in NFA Studio in four steps. Agents use REST and MCP to find, hire, create and update NFAs; every action comes back unsigned for a wallet to sign. Judges: `npm ci && npm run judge` replays creation, paid jobs, hiring, sale, recovery and an agent-driven launch in a local NEAR sandbox with no keys; `npm run verify:testnet` re-checks the live facts read-only. Every claim and its evidence is in docs/CLAIMS.json.
```
