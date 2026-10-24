# Phase MCP Apps widgets

Interactive widgets for AI agents (Muse, ChatGPT, and any MCP Apps host),
served from the same backend — no new Render service, no new env vars.

## Endpoint

```
POST https://phase-backend.onrender.com/mcp
```

Stateless Streamable HTTP with JSON responses (no SSE stream, no session
id). `GET /mcp` returns 405 — this endpoint is POST-only by design.

Client config (any MCP client that supports Streamable HTTP):

```json
{
  "mcpServers": {
    "phase": {
      "url": "https://phase-backend.onrender.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

Server: `mcp.ts`, built with the official SDKs —
`@modelcontextprotocol/server` (2.x) +
`@modelcontextprotocol/ext-apps/server` (`registerAppTool` /
`registerAppResource`). A fresh MCP server is built per request (the 2.x
SDK refuses to reconnect an already-connected instance).

## Tools

| Tool | Visibility | Args | What it does |
|---|---|---|---|
| `show_coin_setup` | model + app | `name?`, `ticker?`, `category?`, `priceUsd?`, `marketCapUsd?`, `retainedPct?` | Returns setup defaults + prefill and renders the setup widget. The widget sends chosen values back to the agent via `ui/message`; it never mints. |
| `show_agreement` | model + app | `draftId`, `legalName?`, `issuerAddress?`, `accessToken?`, `widgetToken?` | Returns the full agreement text, the deal recap (price, cap, total supply, retained/float counts), and a widget session. Renders the sign-and-approve widget. |
| `sign_agreement` | app only | `draftId`, `legalName`, `accepted: true`, `issuerCategory?`, `title?`, `idempotencyKey?`, `accessToken?`, `widgetToken?` | Signs the draft via the existing `POST /api/v1/issuance/sign` route (in-process). |
| `mint_coin` | app only | `draftId`, `issuerAddress?`, `idempotencyKey?`, `accessToken?`, `widgetToken?` | Mints a signed draft via the existing `POST /api/v1/issuance/mint` route (in-process). `issuerAddress` falls back to the user's own coin address; without any address it fails closed with `issuer_address_required`. |
| `show_dashboard` | model + app | `accessToken?`, `widgetToken?` | Returns the agent dashboard payload and renders the dashboard widget. |
| `show_marketplace` | model + app | `search?`, `category?`, `limit?`, `cursor?`, `accessToken?`, `widgetToken?` | Returns the agent marketplace payload and renders the marketplace widget. Public without a token (no `mine`/`watchlisted` flags, no watch). Trading is manual: the detail view links to the web app Marketplace. |
| `set_watchlist` | app only | `coinId`, `watch: boolean`, `accessToken?`, `widgetToken?` | Watches/unwatches via the existing agent watchlist routes (in-process). |

There is deliberately no buy/sell tool. Trading is manual by design (2026-10-24 decision): the user logs into the Phase web app and places trades themselves, under their own login. The widget never executes a trade.

`show_*` tools carry `_meta.ui.resourceUri` (plus the legacy
`_meta["ui/resourceUri"]` key, auto-populated by the SDK). Action tools
carry `visibility: ["app"]`, so only widgets call them — text-only agents
keep using the REST endpoints documented in AGENT.md.

## UI resources

| URI | Widget |
|---|---|
| `ui://phase/coin-setup.html` | Setup form: name, ticker (auto-suggest), category chips (Creator/Business/Community/Personal), price slider + numeric ($0.05–$5.00), market-cap chips ($50K/$100K/$250K/$1M + custom), ownership slider (retained 50–99%). Live math: `totalShares = round(cap ÷ price)`, retained/float in counts AND %. |
| `ui://phase/agreement.html` | Scrollable full agreement text, deal recap, legal-name input, explicit "I agree" checkbox, Sign & approve (disabled until checkbox + name), then a final confirm card with Mint it / Edit setup, then a success view with the dashboard + marketplace links. Errors render inline. |
| `ui://phase/dashboard.html` | Summary, balances, my coins with display positions + Phase Cred mini-rings, open offers (decisions flagged), watchlist, recent activity, quick-action buttons (sent to the agent as messages), Refresh, standing dashboard link. |
| `ui://phase/marketplace.html` | Search + category chips, band-themed coin cards, in-widget detail (proof list, issuer links), Watch/Unwatch, Buy with quantity → confirm → result states, standing marketplace link. |

All widgets are vanilla JS, no build step. HTML lives in
`mcp/widgets/*.html`; the server inlines the shared bridge
(`mcp/widgets/bridge.js`) and shared CSS (`mcp/widgets/shared.css`) at
read time, so each served resource is fully self-contained (no external
fetches under the host sandbox CSP).

## How widgets talk back

The bridge (`PhaseBridge`, inlined in every widget) is a minimal
hand-rolled MCP Apps postMessage client — chosen over bundling the
official `@modelcontextprotocol/ext-apps` App class so widgets need no
CDN fetch and no build step. The wire protocol mirrors the official App
class exactly, so hosts may substitute it:

- `ui/initialize` → `ui/notifications/initialized` handshake
- `tools/call` (forwarded by the host to this MCP server)
- `ui/message` (widget → agent chat)
- `ui/open-link` (dashboard / marketplace / issuer links)
- Host → widget: `ui/notifications/tool-input`, `ui/notifications/tool-result`
- Widget → host: `ui/notifications/size-changed` (auto-resize)

If no host answers the handshake (widget opened standalone), widgets
render a "open this inside your AI agent" fallback instead of hanging.

## Auth model

The agent flow already holds a Phase Bearer token (issued at signup).
Tools that need identity accept either:

- `accessToken` — the Phase Bearer token (agent path; resolved through
  the same session store as the REST routes), or
- `widgetToken` — a short-lived, MCP-only capability token minted by a
  `show_*` tool (widget path).

The widget NEVER sees the Bearer token. Server-side, the widget session
also remembers the accessToken the `show_*` call arrived with (memory
only, never logged, never sent to the widget, 30-minute TTL, gone on
restart) so in-process REST dispatch can re-attach it as the Bearer
header — REST routes keep resolving identity exactly as they always
have, and a widget token on its own is useless against REST endpoints.

## Implementation notes

- **No duplicated business logic.** Action tools dispatch the existing
  REST route handlers in-process (the modules are mounted into a private
  capture table with a capturing `sendJson`). Same guards, same rate
  limits, same idempotency as REST. `show_agreement` reads the draft
  store directly (`getDraft`, `renderAgreementText`) for its recap.
- **Numbers rule.** Widgets show score % and real money/share counts.
  Per-item Cred point values are NEVER rendered (payloads may carry
  them; widgets render earned-proof labels only).
- **Band theming matches the app.** Meme `#d92d20`, Phase `#2f7bff`,
  middle bands brand green `#16a34a` — on ticker chips, Buy buttons,
  and Cred rings.
- **Every mutation shows its result state** (loading → success/error);
  nothing is silent. Errors are mapped to human-readable messages
  (`supply_mismatch`, `already_minted`, `insufficient balance`, …).
- **Test mode everywhere.** No new secrets, no new env vars, no
  mainnet, no live payments.

## Known limits

- **No trade execution.** The widget never buys or sells; its detail
  view links to the web app Marketplace where the user trades under
  their own login. Note: cash buys on live currently cannot settle for
  new buyers — `POST /api/v1/trades/buy` debits `market_balances` USD,
  which nothing on live credits (deposits land in separate ledgers).
  That gap is intentionally left open while trading stays manual.
- **PHASE balance is null in memory mode.** `bonus.ts` has no memory
  fallback, so the dashboard widget shows PHASE 0 without Postgres.
  Balances resolve normally on Render.
- **Widget sessions are memory-only.** A restart invalidates all
  widget tokens; the agent simply re-issues the widget.
- **Mint needs an issuer wallet address.** Pass it to `show_agreement`
  (the agent has it from signup keygen) or make sure the user already
  has a coin; otherwise `mint_coin` fails closed.
- **Host support varies.** MCP Apps is new; some hosts render widgets,
  others fall back to the text tool results. The text results always
  carry the full data, so nothing is lost on a non-widget host.
- **Not yet wired into AGENT.md.** The agent-facing widget guidance
  (when to call `show_*` vs. text flow) is a separate, pending doc edit.

## Deploy notes (for the person deploying)

- Same Render service (`phase-backend`), same start command. `npm
  install` picks up the three new dependencies
  (`@modelcontextprotocol/server`, `@modelcontextprotocol/ext-apps`,
  `zod`) — commit includes the updated `package.json` +
  `package-lock.json`.
- No migration, no env change, no new service. After deploy, verify:
  `POST /mcp` with an MCP client → `tools/list` shows the 8 tools.
- Local smoke test (memory mode, no Postgres): boot with `DATABASE_URL`
  unset and no `.env` present, then drive `/mcp` with an MCP client.
  The repo-external exercise script used during development is not
  committed; the tool/result shapes above are the contract to check.
