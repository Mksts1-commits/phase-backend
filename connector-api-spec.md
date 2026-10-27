# Phase Public API — Connector Spec (Draft)

The API surface a Muse connector (and any third-party integration) will call.
Design follows Meta's connector guidance: narrow idempotent endpoints, explicit
typed schemas, human-readable errors, least-privilege scopes, audit trails.

Status: DRAFT — backend is not yet deployed; no endpoint here is live.
Legal gate: user-coin issuance/purchase through an agent needs the Sep 28
legal review before real money or real instruments move.

## Base & versioning

- Base URL: `https://api.phase.example` (placeholder — set on deploy)
- Versioned path prefix: `/api/v1`
- Auth: OAuth 2.0 authorization code flow. Muse acts on behalf of the user;
  every mutating call carries the user's token and is approval-gated client-side.

## Scopes (least privilege)

| Scope | Grants |
|---|---|
| `read:coins` | List coins, coin detail, quotes |
| `read:portfolio` | Holdings, balances, transactions |
| `write:listings` | Draft/submit coin listings, sign issuer agreement |
| `write:orders` | Place buy/sell orders |

## Endpoints

### Coins (marketplace)
- `GET /api/v1/coins?category=&search=&limit=&cursor=` — list coins
  → `{ coins: [{ id, name, ticker, category, tagline, priceUsd, marketCap, issuer: { name, socialProfiles: [{ platform, url }] } }], nextCursor }`
- `GET /api/v1/coins/{id}` — full detail (split, agreement status, socials)
- `GET /api/v1/coins/{id}/quote?side=buy&amount=` — executable quote with expiry

### Issuance (go live)
- `POST /api/v1/coins` — draft a listing. Idempotent: requires `Idempotency-Key` header.
  Body: `{ name, category, tagline, equityPublic, equityRetained, socialProfiles: [{ platform, url }], valueThesis }`
  → `{ id, status: "draft" }`
- `GET /api/v1/coins/{id}/issuer-agreement` — returns the agreement text + PDF URL
- `POST /api/v1/coins/{id}/issuer-agreement/sign` — typed e-signature. Body: `{ legalName, accepted: true }`
  → `{ signedAt }`. A coin cannot publish without this.

### Orders & portfolio
- `POST /api/v1/orders` — idempotent (`Idempotency-Key`). Body: `{ coinId, side: "buy"|"sell", amount, currency }`
  → `{ orderId, status: "filled"|"pending", filledPrice }`
- `GET /api/v1/portfolio` — holdings with live values
- `GET /api/v1/transactions?limit=&cursor=` — ledger

## Cross-cutting conventions

- **Idempotency:** all POSTs accept `Idempotency-Key`; duplicate keys return the original result, never double-execute. (Agents retry.)
- **Errors:** `{ error: "code", message: "human-readable sentence the agent may show the user" }`
- **Pagination:** cursor-based, `limit` default 20, max 100.
- **Rate limits:** per-token bucket; `429` with `Retry-After`.
- **Audit:** every agent-initiated mutation is logged with actor=`connector:muse`, user id, timestamp, and full request/response. Agent traffic is queryable separately from human sessions.
- **Money:** no endpoint moves real funds until the dealer/legal/compliance steps land. Until then, responses carry `"mode": "sandbox"`.

## Connector submission checklist (Meta)

1. Live product on a custom domain
2. This API deployed at the public base URL with OAuth working
3. Landing page explaining Phase
4. Privacy policy, terms of service, support contact
5. Connector manifest: name, description, tool list (the endpoints above), auth scheme, scopes requested
6. Submit via muse.ai/platform → three-step Meta review → directory listing

## Sequencing

1. Deploy backend HTTPS (already on the backend roadmap)
2. Real authN/authZ (OAuth2) — required before any connector
3. Implement this spec against the existing BFF modules (securities, funding, guide)
4. Legal sign-off on agent-initiated issuance/trading (extends the Sep 28 review)
5. Submit connector, iterate on review

---

# Addendum — The Agent Interface (2026-10-23, implemented)

Status update: the backend is live at `https://phase-backend.onrender.com`
and account auth shipped — email+password accounts with server-side
Bearer session tokens (`POST /api/v1/auth/signup` / `login`). Until the
OAuth flow lands for the formal connector submission, agent traffic
authenticates with that Bearer token; the scope model below maps 1:1
onto the OAuth scopes in the table above. All endpoints in this
addendum are implemented in `agent-interface.ts` (plus pre-existing
routes they compose) and carry `"mode": "test"` — Phase rails are
test-mode; no payload here is a real-money claim.

Product premise: **the agent is the full interface to Phase**, not just
the signup+mint funnel. A user can view their dashboard, browse the
marketplace, and tweak their account through their agent, from inside
their AI chat.

## A. Dashboard visual payload

`GET /api/v1/agent/dashboard` — Bearer required. The userId comes ONLY
from the token; a `userId` in query/body is never read.

Returns ONE render-ready JSON document the agent presents as the
user's interactive dashboard visual:

```jsonc
{
  "network": "sovereign", "chain": "phase", "mode": "test",
  "view": "dashboard",
  "generatedAt": "2026-10-23T12:00:00.000Z",
  "partial": false,               // true when a section degraded
  "summary": "1,000 PHASE · $0.00 USD · 1 coin issued · 1 swap offer waiting for your decision.",
  "account": { "userId": "…", "email": "user@example.com", "name": "User" },
  "balances": { "PHASE": 1000, "USD": "0.000000", "lifetimeSalesUsd": "0.000000" },
  "myCoins": [{
    "id": "…", "chainId": "…", "name": "Creator Coin", "ticker": "CRT",
    "category": "Creator", "tagline": "For my community",
    "priceUsd": 2.5, "supply": "100000", "marketCapUsd": 250000,
    "floatAvailable": "50000", "hasAgreement": true,
    "display": { "price": "$2.50", "marketCap": "$250,000.00",
                 "headline": "Creator Coin (CRT) — For my community" },
    "position": {
      "availableUnits": "50000",            // issuer's live on-chain stake
      "publicFloatUnits": "50000",
      "publicFloatSoldUnits": "0",
      "realizationRatio": 0,                // share of float actually bought
      "stakeValueUsdAtList": 125000         // at LIST price — not market value
    }
  }],
  "recentActivity": [{ "id": "…", "kind": "buy", "role": "seller",
    "units": "10.000000", "amountUsd": "25.000000", "createdAt": "…",
    "summary": "Sold 10.000000 units for $25.00" }],
  "openOffers": {
    "inbox":  [{ "id": "…", "status": "pending", "needsMyDecision": true,
                 "summary": "Offer: 20 BYR for 9 CRT of yours." }],
    "outbox": []
  },
  "watchlist": [ /* coin cards, same shape as marketplace */ ],
  "quickActions": [
    { "id": "browse_marketplace", "label": "Browse the marketplace",
      "method": "GET", "path": "/api/v1/agent/marketplace" },
    { "id": "edit_my_coin", "label": "Edit my coin's profile (tagline, website, socials)",
      "method": "PATCH", "path": "/api/v1/coins/:id", "requiresConfirmation": true }
  ]
}
```

Sections degrade independently: if one subsystem is unavailable the
document still returns with that section empty/null and `partial: true`.
Agents should present `summary` first, then the sections the user
asked about, and must keep the listing-vs-realized distinction visible
(`stakeValueUsdAtList` is a list-price figure; `realizationRatio` is
what actually sold).

## B. Marketplace visual payload

`GET /api/v1/agent/marketplace` — public; Bearer optional.
Query: `search` (name/ticker/tagline substring), `category`
(case-insensitive exact), `limit` (1–50, default 20), `cursor`
(opaque offset from `nextCursor`).

Built on the same data path as `GET /api/v1/marketplace/coins` (which
remains the raw directory), reshaped for agent presentation:

```jsonc
{
  "view": "marketplace", "mode": "test", "total": 35,
  "categories": [{ "name": "Creator", "count": 12 }],
  "coins": [{
    "id": "…", "chainId": "…", "name": "Creator Coin", "ticker": "CRT",
    "category": "Creator", "tagline": "…", "valueThesis": "…",
    "priceUsd": 2.5, "supply": "100000", "marketCapUsd": 250000,
    "floatAvailable": "50000", "isMeme": false, "hasAgreement": true,
    "issuerUserId": "…", "issuerAddress": "ph1…",
    "socialProfiles": [{ "platform": "tiktok", "url": "https://…" }],
    "websiteUrl": null, "createdAt": "…", "online": true,
    "display": { "price": "$2.50", "marketCap": "$250,000.00", "headline": "…" },
    "mine": false, "watchlisted": true   // only when Bearer present
  }],
  "nextCursor": "20"
}
```

## C. Tweak / write actions

All writes are Bearer-authenticated, ownership-checked server-side,
and — by protocol rule (§E) — require the user's explicit confirmation
in the conversation before the agent calls them.

| Action | Endpoint | Scope | Idempotency |
|---|---|---|---|
| Edit my coin's tagline / website / socials | `PATCH /api/v1/coins/:id` | `write:coin-profile` | Naturally idempotent (field set) |
| Upload / delete my coin's documents | `POST` / `DELETE /api/v1/coins/:id/documents[/:docId]` | `write:coin-profile` | Upload: count-capped; delete: 404 on replay |
| Watch a coin | `POST /api/v1/agent/watchlist` `{ coinId }` (id or chainId) | `write:watchlist` | Idempotent — re-add returns 200 `alreadyWatching: true` |
| Unwatch a coin | `DELETE /api/v1/agent/watchlist/:coinId` | `write:watchlist` | Idempotent — always 200 |
| Cancel my open swap offer | `POST /api/v1/offers/:id/cancel` | `write:offers` | Status-guarded — replay returns 409 `offer_not_open` |
| Create / accept / counter / decline offers | `POST /api/v1/offers`, `/:id/accept`, `/:id/counter`, `/:id/decline` | `write:offers` | `Idempotency-Key` on create; status-guarded decisions |
| Draft / sign / mint a coin | `POST /api/v1/issuance/draft`, `/sign`, `/mint` | `write:listings` | `Idempotency-Key` required on mint |
| Buy / swap | `POST /api/v1/trades/buy`, `/trades/swap` | `write:orders` | `Idempotency-Key` |

New scopes for the connector manifest: `read:dashboard` (covers §A),
`read:marketplace` (public; no scope needed unauthenticated),
`write:coin-profile`, `write:watchlist`, `write:offers`.

Watchlist storage: `user_watchlist` table (migration 021).

## D. Presentation conventions for agents

- Lead with the payload's `summary` line; render coin collections as
  compact cards (headline, price, market cap, float available), not
  raw JSON dumps.
- When a payload says `partial: true`, tell the user some figures
  couldn't be loaded rather than presenting the view as complete.
- Surface `needsMyDecision: true` offers first — they are the only
  dashboard items that block another person.
- Always keep list price vs. realized value distinct (see §A).

## E. Consent conventions (hard rules)

- **No silent writes.** Before any §C call, the agent states exactly
  what will change (field, old → new; or the action and its target)
  and gets the user's explicit yes in the conversation. Only then does
  it call. This extends the existing Issuer-Agreement rule: signing
  already requires showing the full text and explicit acceptance.
- **Confirmation is conversational, not a body flag** — the server
  enforces auth + ownership; the agent enforces consent. An agent that
  cannot obtain a clear yes must not call the write.
- **Report back.** After a write, the agent shows the server's result
  (e.g. the updated card, the cancelled offer's status) so the user
  can verify the change landed.
- **Honesty.** All payloads are test-mode. Never present balances,
  prices, or stake values as real-money value, and never promise
  returns.

---

# Addendum — OAuth 2.0 authorization server (2026-10-27, LIVE)

Status update: the OAuth flow this spec required is implemented and live
at `https://phase-backend.onrender.com` (commit `ed42d3d`, migration 027).
The session Bearer tokens from the earlier addendum keep working unchanged;
OAuth tokens are the path for third-party connector clients.

- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata
  (issuer exactly `https://phase-backend.onrender.com`)
- `POST /oauth/register` — RFC 7591 dynamic client registration
  (`client_name` + `redirect_uris`, https only except http loopback;
  `token_endpoint_auth_method: "none"` for public clients)
- `GET /oauth/authorize` — authorization code flow + PKCE (S256 required
  for public clients); server-rendered login + consent page showing the
  client name and each requested scope in plain language
- `POST /oauth/authorize` — login + consent decision (JSON, returns the
  redirect URL with `code` + `state`); codes are single-use, 10-minute
  expiry, bound to client + redirect URI + PKCE challenge
- `POST /oauth/token` — `authorization_code` and `refresh_token` grants
  (access 1h, refresh 30d with rotation); secrets, codes, and tokens are
  stored only as SHA-256 hashes
- `POST /oauth/revoke` — RFC 7009, always 200

Scope enforcement on the agent endpoints: session tokens keep full access;
OAuth tokens must carry the route's scope or the call 403s with
`insufficient_scope` — dashboard `read:dashboard`, watchlist reads
`read:coins`, watchlist writes `write:watchlist`, offers `write:offers`,
coin edits `write:coin-profile`, issuance `write:listings`, trades
`write:orders`. Marketplace reads stay public.

Verified live end-to-end 2026-10-27: metadata → registration → signup →
authorize → code exchange → OAuth dashboard 200 → out-of-scope write 403
→ code-reuse rejection. Local suite `test-oauth.ts`: 31 passed, 0 failed.

Still gated (not cleared by this work): directory submission remains gated
on legal sign-off for agent-initiated issuance. The manual-trading rule
(agent never buys/sells/swaps on a user's behalf) is unchanged.
