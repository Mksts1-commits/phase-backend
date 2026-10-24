/**
 * mcp.ts — Phase MCP Apps widget layer (SEP-1865).
 *
 * One MCP endpoint (POST /mcp) on the SAME service — no new Render service,
 * no new env vars. Stateless Streamable HTTP (JSON responses), built with
 * the official SDKs: @modelcontextprotocol/server (2.x) +
 * @modelcontextprotocol/ext-apps/server (registerAppTool/registerAppResource).
 * A fresh McpServer is built per request: the 2.x SDK refuses to reconnect
 * an already-connected server instance, and registration cost is trivial.
 *
 * AUTH MODEL
 * ----------
 * The agent flow already holds a Phase Bearer token (issued at signup).
 * Tools that need identity accept EITHER:
 *   - `accessToken` — the Phase Bearer token (agent path; resolved through
 *     the same session store as the REST routes), or
 *   - `widgetToken` — a short-lived, MCP-only capability token minted by a
 *     show_* tool (widget path). The widget NEVER sees the Bearer token:
 *     the show_* result carries only the scoped widgetToken. Server-side,
 *     the widget session ALSO remembers the accessToken the show_* call
 *     arrived with (memory only, never logged, never sent to the widget,
 *     30-minute TTL, gone on restart) so in-process REST dispatch can
 *     re-attach it as the Bearer header — the REST routes keep resolving
 *     identity exactly as they always have, and the widget never holds a
 *     token that works on REST endpoints directly.
 * Public tools (show_marketplace without a token) work unauthenticated.
 *
 * IN-PROCESS REST DISPATCH
 * ------------------------
 * MCP action tools do NOT duplicate business logic and do NOT HTTP
 * self-call. The existing route modules (issuance, marketplace,
 * agent-interface) are mounted into a private capture table with a
 * capturing sendJson, and tools invoke those exact handlers with a
 * fabricated RouteContext (Authorization header = the caller's token).
 * Same guards, same rate limits, same idempotency, zero drift.
 *
 * WIDGETS
 * -------
 * HTML lives in mcp/widgets/*.html (vanilla JS, no build step). At read
 * time the server inlines the shared bridge (mcp/widgets/bridge.js) and
 * shared CSS (mcp/widgets/shared.css) via placeholder replacement, so the
 * served resource is fully self-contained — no external fetches under the
 * host sandbox CSP. The bridge is a minimal hand-rolled MCP Apps
 * postMessage client (ui/initialize, tools/call, ui/message, ui/open-link,
 * tool-input/tool-result notifications) mirroring the official
 * @modelcontextprotocol/ext-apps App wire protocol; hosts may substitute
 * the official App class — the messages are identical.
 *
 * Everything here is test-mode, matching the platform posture.
 *
 * Mounted from phase-backend.ts: mountMcpRoutes({ route, sendJson, HttpError })
 * (only `route` is used; the handler writes the MCP Web Response directly).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { mountIssuanceRoutes } from "./issuance.js";
import { mountMarketplaceRoutes } from "./marketplace.js";
import { mountAgentInterfaceRoutes } from "./agent-interface.js";
import { resolveBearerUserId } from "./auth.js";
import { getIssuanceStore, renderAgreementText, sha256Hex } from "./issuance.js";

const here = dirname(fileURLToPath(import.meta.url));

export const MCP_UI_BASE = "ui://phase";
export const DASHBOARD_URL = "https://mksts1-commits.github.io/phase-android/app/?tab=dashboard";
export const MARKETPLACE_URL = "https://mksts1-commits.github.io/phase-android/app/?tab=market";

// ---------------------------------------------------------------------------
// Widget HTML (loaded once, placeholders inlined)
// ---------------------------------------------------------------------------

let widgetCache: Record<string, string> | null = null;
function widgetHtml(name: string): string {
  if (!widgetCache) {
    const css = readFileSync(join(here, "mcp", "widgets", "shared.css"), "utf8");
    const bridge = readFileSync(join(here, "mcp", "widgets", "bridge.js"), "utf8");
    const load = (file: string): string =>
      readFileSync(join(here, "mcp", "widgets", file), "utf8")
        .replace("<!-- PHASE_CSS -->", css)
        .replace("<!-- PHASE_BRIDGE -->", bridge);
    widgetCache = {
      "coin-setup": load("coin-setup.html"),
      agreement: load("agreement.html"),
      dashboard: load("dashboard.html"),
      marketplace: load("marketplace.html"),
    };
  }
  const html = widgetCache[name];
  if (!html) throw new Error(`Unknown widget: ${name}`);
  return html;
}

// ---------------------------------------------------------------------------
// Widget session tokens (MCP-only, scoped, short-lived; never the Bearer token)
// ---------------------------------------------------------------------------

const WIDGET_TOKEN_TTL_MS = 30 * 60_000;
interface WidgetSession {
  userId: string;
  /** Bearer token bound at show_* time (memory only; never logged, never sent to widgets). */
  accessToken: string | null;
  createdAt: number;
}
const widgetSessions = new Map<string, WidgetSession>();

function mintWidgetToken(userId: string, accessToken: string | null): string {
  const now = Date.now();
  for (const [t, s] of widgetSessions) {
    if (now - s.createdAt > WIDGET_TOKEN_TTL_MS) widgetSessions.delete(t);
  }
  const token = `wgt_${randomUUID()}`;
  widgetSessions.set(token, { userId, accessToken, createdAt: now });
  return token;
}

function resolveWidgetSession(token: string | undefined | null): WidgetSession | null {
  if (!token) return null;
  const s = widgetSessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > WIDGET_TOKEN_TTL_MS) {
    widgetSessions.delete(token);
    return null;
  }
  return s;
}

interface Caller {
  userId: string;
  /** Bearer token to attach to in-process REST dispatch (arg or bound session). */
  restToken: string | null;
}

async function resolveCaller(args: {
  accessToken?: string;
  widgetToken?: string;
}): Promise<Caller | null> {
  const viaWidget = resolveWidgetSession(args.widgetToken);
  if (viaWidget) {
    return { userId: viaWidget.userId, restToken: viaWidget.accessToken ?? args.accessToken ?? null };
  }
  if (args.accessToken) {
    const userId = await resolveBearerUserId({ authorization: `Bearer ${args.accessToken}` });
    if (!userId) return null;
    return { userId, restToken: args.accessToken };
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-process REST dispatch (captured handlers, same code as the REST routes)
// ---------------------------------------------------------------------------

class RestError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type CapturedHandler = (ctx: any) => void | Promise<void>;
const restHandlers = new Map<string, CapturedHandler>();
let restCaptured = false;

function captureRoute(method: string, path: string, handler: CapturedHandler): void {
  restHandlers.set(`${method} ${path}`, handler);
}

/** Mount the REST modules into the private capture table (once). */
function ensureRestCaptured(): void {
  if (restCaptured) return;
  restCaptured = true;
  const deps: any = {
    route: captureRoute,
    sendJson: (res: any, status: number, body: unknown) => {
      res.__mcpCaptured = { status, body };
    },
    HttpError: RestError,
  };
  mountIssuanceRoutes(deps);
  mountMarketplaceRoutes(deps);
  mountAgentInterfaceRoutes(deps);
}

function matchHandler(
  method: string,
  path: string,
): { handler: CapturedHandler; params: Record<string, string> } | null {
  const exact = restHandlers.get(`${method} ${path}`);
  if (exact) return { handler: exact, params: {} };
  for (const [key, handler] of restHandlers) {
    const [km, kp] = key.split(" ", 2);
    if (km !== method) continue;
    const names = [...kp.matchAll(/:([^/]+)/g)].map((m) => m[1]);
    const re = new RegExp("^" + kp.replace(/:[^/]+/g, "([^/]+)") + "$");
    const m = path.match(re);
    if (m) {
      const params: Record<string, string> = {};
      names.forEach((n, i) => {
        params[n] = decodeURIComponent(m[i + 1]);
      });
      return { handler, params };
    }
  }
  return null;
}

interface RestResult {
  ok: boolean;
  status: number;
  body: any;
}

/**
 * Invoke a REST route in-process. `token` becomes the Authorization header
 * (the route's own resolveBearerUserId does the rest). Throws RestError on
 * transport-level failure; REST error bodies surface as ok:false.
 */
async function restCall(
  method: string,
  path: string,
  opts: {
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
    query?: Record<string, string>;
  } = {},
): Promise<RestResult> {
  ensureRestCaptured();
  const found = matchHandler(method, path);
  if (!found) throw new RestError(404, "rest_route_not_found", `No REST route for ${method} ${path}`);
  const res: any = {};
  const headers: Record<string, string | string[] | undefined> = {
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.headers ?? {}),
  };
  const query = new URLSearchParams(opts.query ?? {});
  try {
    await found.handler({
      req: { headers, socket: { remoteAddress: "127.0.0.1" } },
      res,
      params: found.params,
      query,
      body: opts.body ?? {},
    });
  } catch (err: any) {
    // Modules throw their injected HttpError (our RestError) on hard failure.
    if (err instanceof RestError) {
      return { ok: false, status: err.statusCode, body: { error: err.code, message: err.message } };
    }
    throw err;
  }
  const captured = res.__mcpCaptured as { status: number; body: any } | undefined;
  if (!captured) {
    throw new RestError(500, "rest_no_response", `REST handler for ${method} ${path} produced no response`);
  }
  const status = captured.status;
  const body = captured.body ?? {};
  const isErr = status >= 400 || typeof body?.error === "string";
  return { ok: !isErr, status, body };
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

const UI = (resourceUri: string) => ({ ui: { resourceUri } });

function okResult(data: unknown, resourceUri?: string): any {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const out: any = {
    content: [{ type: "text", text }],
    structuredContent: data,
  };
  if (resourceUri) out._meta = UI(resourceUri);
  return out;
}

function errResult(code: string, message: string, resourceUri?: string): any {
  const data = { error: code, message };
  const out: any = {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    isError: true,
  };
  if (resourceUri) out._meta = UI(resourceUri);
  return out;
}

function restErrToResult(r: RestResult): any {
  const code = r.body?.error ?? "rest_error";
  const message = r.body?.message ?? `REST call failed (${r.status})`;
  return errResult(String(code), String(message));
}

async function userIssuerAddress(userId: string): Promise<string | null> {
  try {
    const s = await getIssuanceStore();
    const coins = await s.listCoinsByUser(userId);
    return coins[0]?.issuerAddress ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server construction (per request — see header note)
// ---------------------------------------------------------------------------

const accessArgs = {
  accessToken: z.string().optional(),
  widgetToken: z.string().optional(),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: "phase", version: "1.0.0" });

  // --- 1. Coin setup -------------------------------------------------------
  registerAppTool(
    server,
    "show_coin_setup",
    {
      title: "Show coin setup",
      description:
        "Show the interactive coin-setup widget: name, ticker, category, price, market cap, and ownership split with live supply math. The widget sends the chosen values back to the agent, which creates the draft — the widget itself never mints.",
      inputSchema: z.object({
        name: z.string().optional(),
        ticker: z.string().optional(),
        category: z.string().optional(),
        priceUsd: z.number().optional(),
        marketCapUsd: z.number().optional(),
        retainedPct: z.number().optional(),
      }),
      _meta: UI(`${MCP_UI_BASE}/coin-setup.html`),
    },
    async (args) => {
      const prefill: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) prefill[k] = v;
      return okResult(
        {
          prefill,
          defaults: {
            priceUsd: 0.5,
            marketCapUsd: 100000,
            retainedPct: 95,
            categories: ["Creator", "Business", "Community", "Personal"],
          },
        },
        `${MCP_UI_BASE}/coin-setup.html`,
      );
    },
  );

  // --- 2. Agreement: show --------------------------------------------------
  registerAppTool(
    server,
    "show_agreement",
    {
      title: "Show Issuer Agreement",
      description:
        "Show the sign-and-approve widget for a draft: the full agreement text, the deal recap (price, cap, total supply, retained/float counts), a legal-name input, an explicit agreement checkbox, then a final confirm card with Mint / Edit setup. Requires the user's Phase token.",
      inputSchema: z.object({
        draftId: z.string(),
        legalName: z.string().optional(),
        issuerAddress: z.string().optional(),
        ...accessArgs,
      }),
      _meta: UI(`${MCP_UI_BASE}/agreement.html`),
    },
    async (args) => {
      const caller = await resolveCaller(args);
      if (!caller) return errResult("sign_in_required", "Sign in required: pass the user's Phase accessToken.", `${MCP_UI_BASE}/agreement.html`);
      const userId = caller.userId;
      let draft: any;
      try {
        const s = await getIssuanceStore();
        draft = await s.getDraft(args.draftId);
      } catch (e: any) {
        return errResult("draft_lookup_failed", e?.message ?? "Could not load the draft.", `${MCP_UI_BASE}/agreement.html`);
      }
      if (!draft) return errResult("draft_not_found", "No draft with that id.", `${MCP_UI_BASE}/agreement.html`);
      if (draft.userId !== userId) return errResult("forbidden", "This draft belongs to a different user.", `${MCP_UI_BASE}/agreement.html`);
      const totalShares = Number(draft.totalShares);
      const retainedPct = Number(draft.equityRetained);
      const retainedShares = Math.round((totalShares * retainedPct) / 100);
      const recap = {
        name: draft.name,
        ticker: draft.ticker,
        priceUsd: Number(draft.priceUsd),
        marketCapUsd: Number(draft.priceUsd) * totalShares,
        totalShares,
        retainedPct,
        publicPct: 100 - retainedPct,
        retainedShares,
        floatShares: totalShares - retainedShares,
      };
      const store = await getIssuanceStore();
      const coin = await store.getCoinByDraft(args.draftId).catch(() => null);
      const widgetToken = mintWidgetToken(userId, caller.restToken);
      if (coin) {
        return okResult(
          {
            draftId: args.draftId,
            status: "minted",
            recap,
            coin: { id: coin.id, name: coin.name, ticker: coin.ticker, chainId: coin.mintAddress },
            widgetToken,
          },
          `${MCP_UI_BASE}/agreement.html`,
        );
      }
      const sig = await store.getSignatureByDraft(args.draftId).catch(() => null);
      const agreementText = renderAgreementText(draft);
      return okResult(
        {
          draftId: args.draftId,
          status: sig ? "signed" : "draft",
          signed: !!sig,
          signedBy: sig ? sig.legalName : null,
          agreementText,
          agreementHash: sha256Hex(agreementText),
          recap,
          legalName: args.legalName ?? "",
          issuerAddress: args.issuerAddress ?? (await userIssuerAddress(userId)),
          widgetToken,
        },
        `${MCP_UI_BASE}/agreement.html`,
      );
    },
  );

  // --- 2b. Agreement: sign (widget-only) ------------------------------------
  registerAppTool(
    server,
    "sign_agreement",
    {
      title: "Sign Issuer Agreement",
      description:
        "Sign a draft's Issuer Agreement. Widget-only: called from the agreement widget after the user checks the agreement box and types their legal name.",
      inputSchema: z.object({
        draftId: z.string(),
        legalName: z.string(),
        accepted: z.boolean(),
        issuerCategory: z.string().optional(),
        title: z.string().optional(),
        idempotencyKey: z.string().optional(),
        ...accessArgs,
      }),
      _meta: { ui: { resourceUri: `${MCP_UI_BASE}/agreement.html`, visibility: ["app"] } },
    },
    async (args) => {
      const caller = await resolveCaller(args);
      if (!caller) return errResult("sign_in_required", "Sign in required.");
      if (!caller.restToken) {
        return errResult("access_token_required", "Signing requires the user's Phase session. Ask your agent to reopen the agreement.");
      }
      if (args.accepted !== true) return errResult("not_accepted", "accepted must be true: the user must accept the agreement to sign it.");
      if (!args.legalName || args.legalName.trim().length < 2) {
        return errResult("invalid_legal_name", "legalName is required: type your full legal name to sign.");
      }
      const r = await restCall("POST", "/api/v1/issuance/sign", {
        token: caller.restToken,
        body: {
          draftId: args.draftId,
          legalName: args.legalName,
          accepted: true,
          issuerCategory: args.issuerCategory ?? "individual",
          title: args.title ?? undefined,
          idempotencyKey: args.idempotencyKey ?? undefined,
        },
      });
      if (!r.ok) return restErrToResult(r);
      return okResult({ signed: true, ...r.body });
    },
  );

  // --- 2c. Mint (widget-only) ----------------------------------------------
  registerAppTool(
    server,
    "mint_coin",
    {
      title: "Mint coin",
      description:
        "Mint a signed draft into a live coin. Widget-only: called from the agreement widget's final confirm card. Requires the issuer's Phase wallet address (ph1...) — resolved from the user's existing coins when not supplied.",
      inputSchema: z.object({
        draftId: z.string(),
        issuerAddress: z.string().optional(),
        idempotencyKey: z.string().optional(),
        ...accessArgs,
      }),
      _meta: { ui: { resourceUri: `${MCP_UI_BASE}/agreement.html`, visibility: ["app"] } },
    },
    async (args) => {
      const caller = await resolveCaller(args);
      if (!caller) return errResult("sign_in_required", "Sign in required.");
      if (!caller.restToken) {
        return errResult("access_token_required", "Minting requires the user's Phase session. Ask your agent to reopen the agreement.");
      }
      const issuerAddress = args.issuerAddress ?? (await userIssuerAddress(caller.userId));
      if (!issuerAddress) {
        return errResult(
          "issuer_address_required",
          "No Phase wallet address on file for this user. Ask the agent for the user's Phase wallet address (ph1...) and pass it as issuerAddress.",
        );
      }
      const key = args.idempotencyKey ?? randomUUID();
      const r = await restCall("POST", "/api/v1/issuance/mint", {
        token: caller.restToken,
        body: { draftId: args.draftId, issuerAddress },
        headers: { "idempotency-key": key },
      });
      if (!r.ok) return restErrToResult(r);
      const coin = r.body?.coin ?? {};
      return okResult({
        minted: true,
        idempotentReplay: r.body?.idempotentReplay ?? false,
        coin: {
          id: coin.id,
          name: coin.name,
          ticker: coin.ticker,
          chainId: r.body?.chainId ?? coin.mintAddress,
          supply: coin.supply,
          priceUsd: coin.priceUsd,
        },
      });
    },
  );

  // --- 3. Dashboard ----------------------------------------------------------
  registerAppTool(
    server,
    "show_dashboard",
    {
      title: "Show dashboard",
      description:
        "Show the interactive dashboard widget: balances, my coins with live positions and Phase Cred, open swap offers, watchlist, recent activity, and quick actions. Requires the user's Phase token.",
      inputSchema: z.object({ ...accessArgs }),
      _meta: UI(`${MCP_UI_BASE}/dashboard.html`),
    },
    async (args) => {
      const caller = await resolveCaller(args);
      if (!caller) return errResult("sign_in_required", "Sign in required: pass the user's Phase accessToken.", `${MCP_UI_BASE}/dashboard.html`);
      if (!caller.restToken) {
        return errResult("access_token_required", "Loading the dashboard requires the user's Phase session.", `${MCP_UI_BASE}/dashboard.html`);
      }
      const r = await restCall("GET", "/api/v1/agent/dashboard", { token: caller.restToken });
      if (!r.ok) return restErrToResult(r);
      return okResult({ ...r.body, widgetToken: mintWidgetToken(caller.userId, caller.restToken) }, `${MCP_UI_BASE}/dashboard.html`);
    },
  );

  // --- 4. Marketplace --------------------------------------------------------
  registerAppTool(
    server,
    "show_marketplace",
    {
      title: "Show marketplace",
      description:
        "Show the interactive marketplace widget: search, category chips, band-themed coin cards with Phase Cred, coin detail with proof list, watch/unwatch, and buy. Public without a token; pass the user's Phase token for mine/watchlisted flags and buy/watch actions.",
      inputSchema: z.object({
        search: z.string().optional(),
        category: z.string().optional(),
        limit: z.number().optional(),
        cursor: z.string().optional(),
        ...accessArgs,
      }),
      _meta: UI(`${MCP_UI_BASE}/marketplace.html`),
    },
    async (args) => {
      const caller = await resolveCaller(args);
      const query: Record<string, string> = {};
      if (args.search) query.search = args.search;
      if (args.category) query.category = args.category;
      if (args.limit) query.limit = String(Math.min(50, Math.max(1, Math.floor(args.limit))));
      if (args.cursor) query.cursor = args.cursor;
      const r = await restCall("GET", "/api/v1/agent/marketplace", {
        token: caller?.restToken ?? null,
        query,
      });
      if (!r.ok) return restErrToResult(r);
      return okResult(
        { ...r.body, widgetToken: caller ? mintWidgetToken(caller.userId, caller.restToken) : null },
        `${MCP_UI_BASE}/marketplace.html`,
      );
    },
  );

  // --- 4b. Watchlist (widget-only) -------------------------------------------
  registerAppTool(
    server,
    "set_watchlist",
    {
      title: "Set watchlist",
      description: "Watch or unwatch a coin. Widget-only: called from the marketplace widget.",
      inputSchema: z.object({
        coinId: z.string(),
        watch: z.boolean(),
        ...accessArgs,
      }),
      _meta: { ui: { resourceUri: `${MCP_UI_BASE}/marketplace.html`, visibility: ["app"] } },
    },
    async (args) => {
      const caller = await resolveCaller(args);
      if (!caller) return errResult("sign_in_required", "Sign in required.");
      if (!caller.restToken) {
        return errResult("access_token_required", "Watchlist changes require the user's Phase session. Ask your agent to reopen the marketplace.");
      }
      const r = args.watch
        ? await restCall("POST", "/api/v1/agent/watchlist", { token: caller.restToken, body: { coinId: args.coinId } })
        : await restCall("DELETE", `/api/v1/agent/watchlist/${encodeURIComponent(args.coinId)}`, { token: caller.restToken });
      if (!r.ok) return restErrToResult(r);
      return okResult({ coinId: args.coinId, watching: args.watch, ...r.body?.watchlist });
    },
  );

  // NOTE: there is deliberately NO buy/sell tool. Trading is manual:
  // the user logs into the Phase web app and places trades themselves,
  // under their own login. The marketplace widget links them there
  // instead of executing a trade. This keeps trade accountability with
  // the user, not the agent.

  // --- UI resources -----------------------------------------------------------
  const widgets: Array<[string, string, string]> = [
    ["Coin setup view", `${MCP_UI_BASE}/coin-setup.html`, "coin-setup"],
    ["Agreement view", `${MCP_UI_BASE}/agreement.html`, "agreement"],
    ["Dashboard view", `${MCP_UI_BASE}/dashboard.html`, "dashboard"],
    ["Marketplace view", `${MCP_UI_BASE}/marketplace.html`, "marketplace"],
  ];
  for (const [name, uri, file] of widgets) {
    registerAppResource(server, name, uri, { description: `Interactive Phase widget: ${name}` }, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: widgetHtml(file) }],
    }));
  }

  return server;
}

// ---------------------------------------------------------------------------
// Mount: POST /mcp (Streamable HTTP, stateless, JSON responses)
// ---------------------------------------------------------------------------

export function mountMcpRoutes(deps: {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
}): void {
  const { route } = deps;

  route("POST", "/mcp", async (ctx: { req: IncomingMessage; res: ServerResponse; rawBody?: Buffer; body: unknown }) => {
    try {
      const raw = ctx.rawBody !== undefined ? ctx.rawBody.toString("utf8") : JSON.stringify(ctx.body ?? {});
      const headers = new Headers();
      for (const [k, v] of Object.entries(ctx.req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      const webReq = new Request("http://localhost/mcp", { method: "POST", headers, body: raw });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await buildServer().connect(transport);
      const webRes = await transport.handleRequest(webReq);
      const text = await webRes.text();
      const outHeaders: Record<string, string> = {};
      webRes.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      ctx.res.writeHead(webRes.status, { "Content-Type": "application/json", ...outHeaders });
      ctx.res.end(text);
    } catch (err) {
      console.error("[mcp] request failed:", err instanceof Error ? err.message : String(err));
      const body = JSON.stringify({ error: "mcp_internal_error", message: "MCP request failed" });
      ctx.res.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      ctx.res.end(body);
    }
  });

  route("GET", "/mcp", async (ctx: { res: ServerResponse }) => {
    const body = JSON.stringify({
      error: "method_not_allowed",
      message: "POST JSON-RPC to /mcp. This endpoint is stateless and does not serve SSE streams.",
    });
    ctx.res.writeHead(405, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    ctx.res.end(body);
  });
}
