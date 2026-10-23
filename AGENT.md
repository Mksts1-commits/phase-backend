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
**$0.50**, and the market cap is **$100,000** — on the draft that means
`totalShares: 200000`. Market cap is always price × totalShares: if your
user names a price and a target cap, compute `totalShares = cap ÷ price`
(a whole number ≥ 1,000) and read the final numbers back to them before
creating the draft — the agreement they sign prints exactly these
numbers.

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
  "totalShares": 200000,
  "websiteUrl": "https://example.com",
  "socialProfiles": [{ "platform": "tiktok", "url": "https://tiktok.com/@user" }]
}
```

Rules: `name` 1–60 chars; `ticker` 2–10 chars A–Z/0–9 (auto-uppercased);
`equityPublic` + `equityRetained` must be whole numbers summing to 100
(Phase default 5/95 — a 5% public float vs. the issuer's 95% retained
stake).

**The supply is decided here, not at mint.** The draft accepts
`totalShares` (a whole number ≥ 1,000), and the Issuer Agreement prints
that exact supply — the total plus the public-float and retained share
counts — for your user to sign. If you omit `totalShares`, it is derived
from the default $100,000 market cap: `totalShares = 100,000 ÷ priceUsd`
(so $0.50 → 200,000; $0.25 → 400,000). Have the economics conversation
with your user BEFORE the draft: once the agreement is signed, the
supply is locked (see step 5).

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

{ "draftId": "<draftId>", "issuerAddress": "ph1..." }
```

**Mint does not pick the supply.** It mints exactly the `totalShares`
fixed on the draft in step 3 — the number printed in the agreement your
user signed. Omit `totalShares` here; if you pass one that differs from
the draft's, the mint is rejected with `422 supply_mismatch`. To change
the supply, go back to step 3: create a new draft and have your user
sign the new agreement. Send an `Idempotency-Key` header — minting is
irreversible and the key makes retries safe.

**Market-cap limit:** price × totalShares may not exceed **$500M USD** at
issuance. Exceeding it returns `422 market_cap_exceeded` — set a lower
price or supply on the draft.

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

Each `myCoins` entry also carries a `legitimacy` object — the coin's
Legitimacy Score (see the next section) — and the payload a top-level
`legitimacySummary`: `{ bestScore, bestCoinTicker,
netWorthGraduated }` across your user's coins.

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

## Legitimacy Score — help your user climb

Every issued coin has a **Legitimacy Score from 0 to 100**: the more
real-world proof an issuer attaches to their coin — a signed agreement,
license/ownership documents, connected socials, a reference URL, a
funded wallet — the higher it climbs. Bands: **0–14 Meme Territory** ·
15–39 Emerging · 40–64 Established · 65–79 Proven · **80–100 Phase
Territory**. At 80+, the issuer's soft net worth graduates to actual
net worth (`legitimacySummary.netWorthGraduated: true`).

The score rides along in the dashboard payload: each `myCoins` entry
has `legitimacy: { score, band, bandLabel, groups, redFlags }`, where `groups`
(Legal / Presence / Financial / Product) list every item with its
`points`, `earned`, `done`, a `hint` for what's missing, and a
`status`: `"earned"` (done), `"available"` (earnable today — the user
just hasn't done it), or `"coming_soon"` (the platform can't accept
this proof yet — today that's the social-connection item while no
social provider is configured on the platform). Treat a
`coming_soon` item as platform-not-ready, never as user homework.

How to use it:

- **Show your user their score and band** when you present their
  dashboard — lead with the best coin (`legitimacySummary`).
- **Turn the missing items into next steps.** Read the `done: false`
  items as a checklist ("Add a reference URL · +7", "Connect a social
  account · +12") and offer to do the ones you can do through the API
  (profile edits, document uploads — with the confirmation script).
- **Never promise points.** The score is computed by the server from
  real records only — a signed agreement on file, an actual deposit,
  a document uploaded with the right type. There is no way to set
  or inflate it from the client, and saying "this will give you +12"
  before the record exists is a guess; say "this is the item that
  earns +12 once it's on file" instead.
- **Every item is earnable today.** The proof records behind the
  less obvious items:
  - **Legal identity (8)** needs BOTH the signed declaration (legal
    name + issuer type on the signature) AND a government-issued ID
    uploaded as a document (`docType: "government_id"`). Ask your
    user for the ID document as part of completing their legal proof
    set — the document trio is: license/ownership documents,
    government ID, and bank statements/reports.
  - **License / ownership documents (12)** is earned by the
    registration or ownership proof that fits the coin's asset:
    businesses → business license or registration
    (`"business_license"` / `"business_registration"`); real estate
    and rentals → deed, mortgage document, property tax record, or
    lease (`"deed"` / `"mortgage_document"` / `"property_tax"` /
    `"lease_agreement"`); collectables → certificate of
    authenticity, appraisal, or provenance record
    (`"certificate_of_authenticity"` / `"appraisal"` /
    `"provenance_record"`). Any of them earns the item for any coin;
    the category only changes which one you should ask for.
  - **Bank statement or reports on file (15)** is documents, not a
    live bank connection: a bank statement or financial report
    uploaded as a document (`docType: "bank_statement"` or
    `"financial_report"`).
  - **Coin logo (4)**: set `logoUrl` — on the issuance draft before
    minting, or later via the coin-profile PATCH — to an image URL
    your user provides.
- **Links are verified live.** The reference URL, social profile,
  and logo points are earned only by links that actually work: the
  platform checks each URL once (when it's set, or on first scoring
  for older coins) and a dead link earns nothing — the item's hint
  will say the link isn't working. Confirm a URL opens before you
  submit it for your user.

### Red flags — an automatic cap at Meme

Points are not the whole story. A coin carrying **any one red flag**
is capped in Meme Territory (effective score at most 14) no matter
how many points it earned — the points stay on record (`rawScore`),
but the `score`, the band, and net-worth graduation all follow the
cap, and the flags are public: the marketplace shows them too. The
four flags (`legitimacy.redFlags: [{ key, label }]`):

1. **No signed Issuer Agreement** (`no_agreement`) — including meme
   coins minted without one — or an agreement signed with a name
   that reads as gibberish (`gibberish_signer`).
2. **A linked page doesn't work** (`dead_link`) — the coin's website
   URL, or any listed social profile, failed its liveness check.
   (A link that was never added is not a flag — it just earns 0.)
3. **No value thesis** (`no_thesis`), or one that reads as
   gibberish (`gibberish_thesis`).
4. **Issuer email domain can't receive mail** (`bad_email_domain`) —
   the account's email domain publishes no MX records and resolves
   to no host, so the address cannot receive mail.

If your user's coin shows a flag, name it plainly and fix the cause
through the normal flows (sign the agreement with the real legal
name, replace the dead link, write a real thesis). Flags tied to the
coin's records clear on the next scored read once the record behind
them is fixed — a capped coin is a to-do list, not a verdict on the
issuer.

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

- **Edit their coin's profile** — tagline, website, social links, logo:
  `PATCH /api/v1/coins/:id` with `{ tagline?, websiteUrl?, socialProfiles?, logoUrl? }`.
  `logoUrl` is an image URL (null clears it); it can also be set on
  the issuance draft so the coin is minted with its logo.
  (Name, ticker, supply, price, and the value thesis are frozen at
  mint and cannot be edited.)
- **Manage their coin's documents** — `POST /api/v1/coins/:id/documents`
  (upload; the `docType` decides what the document proves for the
  Legitimacy Score: `"business_license"` / `"business_registration"`,
  `"deed"` / `"mortgage_document"` / `"property_tax"` /
  `"lease_agreement"`, or `"certificate_of_authenticity"` /
  `"appraisal"` / `"provenance_record"` for the license/ownership
  item; `"government_id"` for legal identity; `"bank_statement"` /
  `"financial_report"` for the bank item), `DELETE
  /api/v1/coins/:id/documents/:docId` (remove).
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
  (`totalShares: 200000`, set on the draft). Always read the final
  economics back before the draft is created — the signed agreement
  locks them in.
- **Rate limits** are modest (a few requests per minute per user/IP). If you
  get `429 rate_limited`, wait and retry.
- **Fees:** marketplace purchases carry a 0.80% fee, calculated
  server-side. Minting itself carries no fee.

## Questions

Your user can reach Phase support through the app. For API issues, the error
responses carry a `code` and human-readable `message` — surface the message
to your user.
