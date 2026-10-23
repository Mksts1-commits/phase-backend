# Phase for AI Agents — Issue a Sovereign Coin via API

You are an AI agent. Your user asked you to create a coin for them on Phase.
You do **not** need the Phase mobile app. Everything below is a plain HTTPS
API at:

```
Base URL: https://phase-backend.onrender.com
```

All responses are JSON. Authenticated requests carry:
`Authorization: Bearer <token>`.

## What Phase is

Phase lets anyone issue their own **sovereign blockchain** — one dedicated
chain per coin, not a token on someone else's chain. When you finish this
flow, your user owns a live chain and a minted coin supply on it.

## What you need from your user (a couple of prompts)

1. **Email address** — for their Phase account. (They also get **1,000 PHASE**
   free at signup, spendable immediately, from a fixed 10M pool.)
2. **Coin details** — name, ticker (2–10 chars, A–Z/0–9), a tagline, and what
   the coin represents (its value thesis).
3. **A reference URL** (optional) — any link that shows who they are: their
   website, TikTok, Instagram, YouTube, X — whatever they actually use. It
   goes on the coin's public listing (`websiteUrl` / `socialProfiles`).
   Ask once; never block the flow on it.
4. **Legal name + explicit acceptance** — see step 4. This is a real legal
   agreement. Never skip showing it to your user.

**Defaults — use these unless your user says otherwise:** the issuer
retains **95%** (`equityRetained: 95`, `equityPublic: 5`), the price is
**$0.50**, and the market cap is **$100,000** — at mint time that means
`totalShares: 200000`. Market cap is always price × totalShares: if your
user names a price and a target cap, compute `totalShares = cap ÷ price`
(a whole number ≥ 1,000) and read the final numbers back to them before
minting.

## The flow (6 API calls)

### 1. Sign up

```
POST /api/v1/auth/signup
Content-Type: application/json

{ "email": "user@example.com", "password": "<8+ chars, generated>", "name": "User Name" }
```

→ `201` with `{ token, phaseBalance, signupBonusGranted }`.
Save the token. **Hand the email + password to your user** — it's their
account, not yours. Do not retain credentials longer than needed.

If the account already exists (`409 account_exists`), ask your user to log in
instead: `POST /api/v1/auth/login` with email + password.

### 2. Generate a sovereign wallet (locally, no API call)

The mint needs an `issuerAddress`. Generate an **Ed25519** keypair locally
(any standard library), then:

```
address = "ph1" + base58(public_key_bytes)
```

**Hand the private key to your user and tell them to back it up.** Whoever
holds this key controls the issuer's stake.

### 3. Create a draft

```
POST /api/v1/issuance/draft
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "MyCoin",
  "ticker": "MYC",
  "tagline": "Coin for my community",
  "valueThesis": "Why this coin has value (up to 2000 chars)",
  "category": "Creator",
  "equityPublic": 5,
  "equityRetained": 95,
  "priceUsd": 0.5,
  "websiteUrl": "https://example.com",
  "socialProfiles": [{ "platform": "tiktok", "url": "https://tiktok.com/@user" }]
}
```

Rules: `name` 1–60 chars; `ticker` 2–10 chars A–Z/0–9 (auto-uppercased);
`equityPublic` + `equityRetained` must be whole numbers summing to 100
(Phase default 5/95 — a 5% public float vs. the issuer's 95% retained
stake).

→ `201` with `{ draftId }`. Send an `Idempotency-Key` header to make retries
safe.

### 4. Show your user the Issuer Agreement — then sign it

```
GET /api/v1/issuance/agreement?draftId=<draftId>
Authorization: Bearer <token>
```

→ `200` with `{ agreementText, agreementHash }`.

**Present the full `agreementText` to your user and get their explicit
acceptance plus their legal name.** Only then:

```
POST /api/v1/issuance/sign
Authorization: Bearer <token>
Content-Type: application/json

{ "draftId": "<draftId>", "legalName": "Full Legal Name", "accepted": true }
```

→ `201` with `{ signatureId }`. (`issuerCategory` defaults to
`"individual"`; use `"entity"` for companies.)

### 5. Mint — this provisions the sovereign chain

```
POST /api/v1/issuance/mint
Authorization: Bearer <token>
Content-Type: application/json

{ "draftId": "<draftId>", "issuerAddress": "ph1...", "totalShares": 1000000 }
```

`totalShares` must be a whole number ≥ 1000. Send an `Idempotency-Key`
header — minting is irreversible and the key makes retries safe.

**Market-cap limit:** price × totalShares may not exceed **$500M USD** at
issuance. Exceeding it returns `422 market_cap_exceeded` — lower the price
or the supply.

**Default mint:** with the defaults above ($0.50 price, $100,000 cap),
mint `totalShares: 200000`. If your user picked their own price and cap,
use `totalShares = cap ÷ price` — and confirm the economics with them
before you call mint.

→ `201` with `{ coin, chainId, genesisHash }`. Your user now owns a live
sovereign chain. The retained stake (per the equity split) sits at their
issuer address.

### 6. Celebrate — send the snapshot summary

The mint worked. Mark the moment: send your user a **congrats summary**
with the coin's key details, formatted cleanly so it reads like a card
and screenshots well (Phase also generates a snapshot infographic from
these same details):

- Coin name + ticker, and its chain ID
- Price, total supply, and market cap (price × supply)
- The split: how much they retained vs. the public float
- Where it lives: their Dashboard and the Marketplace

Then point them onward:

- Their coin appears in the Phase app's Dashboard and Marketplace.
- Public coin directory: `GET /api/v1/marketplace/coins`
- They can edit tagline, website, and social links later (owner-only).

## Browse the marketplace (no account needed)

Anyone — including AI agents — can see what's listed without signing up:

```
GET /api/v1/marketplace/coins
```

→ `200` with `{ coins: [...] }` — every live sovereign coin: name, ticker,
price, supply, tagline, social links, website, and how much is available to
buy. No auth required.

Price quotes are public too:

```
GET /api/v1/trades/quote?chainId=<chainId>&amountUsd=100
GET /api/v1/trades/swap-quote?chainId=<a>&offerChainId=<b>
```

**Buying requires an account.** To purchase, your user signs up (step 1
above) and buys through the Phase app, or via `POST /api/v1/trades/buy`
with their Bearer token.

### Due diligence before recommending a purchase

When your user asks about buying — or when you're evaluating an opportunity
for them — investigate first. The marketplace gives you everything public:

1. **List and compare.** `GET /api/v1/marketplace/coins` returns every live
   coin. Compare price, market cap (price × supply), float available, and
   category. A $5B market cap with zero sales history is a listing price,
   not a market price — say so.
2. **Read the issuer's materials.** `GET /api/v1/coins/:id/documents` lists
   the coin's published documents (whitepapers, audits, filings) — public,
   no auth. Read them before you opine.
3. **Check their presence.** Follow the social links and website from the
   coin listing. A coin with no verifiable issuer presence is a red flag —
   tell your user.
4. **Price the trade.** `GET /api/v1/trades/quote?chainId=<id>&amountUsd=100`
   shows exactly what $100 buys right now, including the 0.80% fee.
5. **Be honest about value.** Distinguish the *listing* valuation (issuer's
   asking price × supply) from *realized* value (what buyers have actually
   paid). Never present a listing price as a market price. If a coin has no
   trading history, say so plainly.

Recommend, don't push. Lay out what you found — the numbers, the documents,
the gaps — and let your user decide.

## See your dashboard

Your user doesn't need the app to see where they stand — you can show
them. Fetch their dashboard visual:

```
GET /api/v1/agent/dashboard
Authorization: Bearer <token>
```

→ `200` with one render-ready document: `summary` (a one-line
overview), `balances` (PHASE + USD + lifetime sales), `myCoins` (their
issued coins with live positions), `recentActivity`, `openOffers`
(swap offers, split into `inbox`/`outbox`), `watchlist`, and
`quickActions` you can offer next.

How to present it:

- **Lead with the `summary` line**, then the sections your user asked
  about. Render coins as compact cards using each coin's `display`
  strings (`headline`, `price`, `marketCap`) — don't dump raw JSON.
- **Surface decisions first.** Any offer with `needsMyDecision: true`
  is blocking someone else — call it out before trivia.
- **Keep list price and realized value separate.** A coin's
  `position.stakeValueUsdAtList` values the issuer's stake at the
  *listing* price. `position.realizationRatio` says how much of the
  public float has actually been bought. If it's 0, say plainly that
  nothing has sold yet — never present the list figure as money earned.
- If the payload says `partial: true`, tell your user some figures
  couldn't be loaded instead of presenting the view as complete.
- Everything is test-mode. Balances and prices are Phase test rails,
  not real-money value — frame them that way.

## Browse the marketplace — agent view

The raw directory (`GET /api/v1/marketplace/coins`, above) works, but
for browsing *with* your user, prefer the presentation-shaped view:

```
GET /api/v1/agent/marketplace?search=<text>&category=<name>&limit=20&cursor=<nextCursor>
```

Public — no account needed. Send the Bearer token anyway when you have
one: cards then carry `mine` and `watchlisted` flags for your user.

→ `200` with `{ total, categories: [{ name, count }], coins: [...],
nextCursor }`. Each coin is a card: name, ticker, category, tagline,
value thesis, price, market cap, float still available, issuer socials
and website, plus `display` strings ready to show.

Present a short shortlist — headline, price, market cap, float
available — and follow the due-diligence rules above before saying
anything evaluative about a coin. Page with `cursor` only if your user
asks for more.

## Tweak things for your user

Your user can adjust Phase through you instead of the app. Allowed
tweaks (all Bearer-authenticated, ownership-checked server-side):

- **Edit their coin's profile** — tagline, website, social links:
  `PATCH /api/v1/coins/:id` with `{ tagline?, websiteUrl?, socialProfiles? }`.
  (Name, ticker, supply, price, and the value thesis are frozen at
  mint and cannot be edited.)
- **Manage their coin's documents** — `POST /api/v1/coins/:id/documents`
  (upload), `DELETE /api/v1/coins/:id/documents/:docId` (remove).
- **Watch / unwatch a coin** — `POST /api/v1/agent/watchlist`
  `{ coinId }`, `DELETE /api/v1/agent/watchlist/:coinId`. Both are
  idempotent; re-adding returns `alreadyWatching: true`.
- **Cancel their own open swap offer** — `POST /api/v1/offers/:id/cancel`.
  Only the buyer can cancel; to refuse an offer sent *to* your user,
  decline it instead (`POST /api/v1/offers/:id/decline`).

**The confirmation script — mandatory for every tweak:**

1. State exactly what will change: the action, the target, and for
   edits the field with its old → new values.
2. Ask for an explicit yes. ("Change your tagline from '…' to '…'?
   Say yes and I'll do it.")
3. Only on a clear yes, make the call.
4. Report back with the server's result so your user can verify the
   change landed (show the updated field or new status).

Never tweak silently, never batch unconfirmed changes, and never treat
an ambiguous reply as a yes. If your user says no — or doesn't answer —
nothing gets called.

## Rules for agents

- **Never sign the Issuer Agreement without the user's explicit, informed
  acceptance.** Show them the text. This is non-negotiable.
- **Hand over credentials.** The account password, Bearer token, and wallet
  private key belong to your user. Deliver them securely and don't keep
  copies.
- **Be honest.** Phase coins are sovereign chains with real issuance
  mechanics; they are not promises of market value. Never claim a coin is
  worth something it isn't.
- **Defaults are 95 / $0.50 / $100k.** Unless your user chooses their own
  numbers: 95% retained, $0.50 price, $100,000 market cap
  (`totalShares: 200000`). Always read the final economics back before
  minting.
- **Rate limits** are modest (a few requests per minute per user/IP). If you
  get `429 rate_limited`, wait and retry.
- **Fees:** marketplace purchases carry a 0.80% fee, calculated
  server-side. Minting itself carries no fee.

## Questions

Your user can reach Phase support through the app. For API issues, the error
responses carry a `code` and human-readable `message` — surface the message
to your user.
