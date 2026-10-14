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
3. **Legal name + explicit acceptance** — see step 4. This is a real legal
   agreement. Never skip showing it to your user.

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
  "equityPublic": 50,
  "equityRetained": 50,
  "priceUsd": 0.35,
  "websiteUrl": "https://example.com",
  "socialProfiles": [{ "platform": "tiktok", "url": "https://tiktok.com/@user" }]
}
```

Rules: `name` 1–60 chars; `ticker` 2–10 chars A–Z/0–9 (auto-uppercased);
`equityPublic` + `equityRetained` must be whole numbers summing to 100
(default 50/50 — the public float vs. the issuer's retained stake).

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

→ `201` with `{ coin, chainId, genesisHash }`. Your user now owns a live
sovereign chain. The retained stake (per the equity split) sits at their
issuer address.

### 6. (Optional) Point them at their coin

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

## Rules for agents

- **Never sign the Issuer Agreement without the user's explicit, informed
  acceptance.** Show them the text. This is non-negotiable.
- **Hand over credentials.** The account password, Bearer token, and wallet
  private key belong to your user. Deliver them securely and don't keep
  copies.
- **Be honest.** Phase coins are sovereign chains with real issuance
  mechanics; they are not promises of market value. Never claim a coin is
  worth something it isn't.
- **Rate limits** are modest (a few requests per minute per user/IP). If you
  get `429 rate_limited`, wait and retry.
- **Fees:** marketplace purchases carry a 0.80% fee, calculated
  server-side. Minting itself carries no fee.

## Questions

Your user can reach Phase support through the app. For API issues, the error
responses carry a `code` and human-readable `message` — surface the message
to your user.
