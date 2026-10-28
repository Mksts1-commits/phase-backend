/**
 * agent-interface.ts — Phase as an agent-native interface.
 *
 * The agent is the full interface to Phase, not just the mint funnel.
 * These endpoints let an AI agent (Muse, or any agent a user sends)
 * do everything a person can do in the app, from inside the chat:
 *
 *   GET    /api/v1/agent/dashboard    (Bearer) — one render-ready JSON
 *          document an agent can present as the user's interactive
 *          dashboard visual: balances, my coins with live positions,
 *          recent activity, open swap offers, watchlist, quick actions.
 *          Each coin carries its Legitimacy Score (legitimacy.ts) and
 *          the payload a top-level legitimacySummary (best score +
 *          net-worth graduation at 80+).
 *   GET    /api/v1/agent/marketplace  (public; Bearer optional) —
 *          the marketplace shaped for agent presentation: coin cards
 *          with display-ready strings, search/category filters, cursor
 *          pagination, each card's Phase Cred (legitimacy.ts public
 *          view: score, band, earned proof items), and (when authed)
 *          `mine` / `watchlisted` flags.
 *   GET    /api/v1/agent/watchlist    (Bearer) — my watched coin cards.
 *   POST   /api/v1/agent/watchlist    (Bearer) — watch a coin (idempotent).
 *   DELETE /api/v1/agent/watchlist/:coinId (Bearer) — unwatch (idempotent).
 *   POST   /api/v1/offers/:id/cancel  (Bearer) — buyer cancels their own
 *          open swap offer. (Accept/counter/decline live in offers.ts;
 *          coin profile edits live in coin-edit.ts.)
 *
 * SECURITY: the userId for every private route comes ONLY from the
 * Bearer token (resolveBearerAuth in oauth.ts). A userId in the body or query
 * is not read at all — not even as a hint. Session Bearer tokens keep full
 * access; OAuth Bearer tokens must carry the route's scope
 * (dashboard read:dashboard, watchlist reads read:coins, watchlist writes
 * write:watchlist, offer cancel write:offers) or the call 403s.
 *
 * CONSENT: these are plain APIs; the consent rule lives in the agent
 * protocol (connector-api-spec.md §E and AGENT.md): an agent must state
 * exactly what a write will change and get the user's explicit yes in
 * the conversation before calling any write endpoint.
 *
 * Everything here is test-mode: balances and prices are Phase test
 * rails, not real-money claims. Responses carry `mode: "test"`.
 *
 * Mounted from phase-backend.ts: mountAgentInterfaceRoutes({ route, sendJson, HttpError })
 */
import { getPool } from "./db.js";
import { resolveBearerAuth } from "./oauth.js";
import { getPhaseBalance } from "./bonus.js";
import { getIssuanceStore, coinFloatPosition, type IssuanceCoin } from "./issuance.js";
import { getMarketStore, type MarketTrade } from "./marketplace.js";
import { getOffersStore, type SwapOffer } from "./offers.js";
import { getChainBalance, PUBLIC_FLOAT_ADDRESS, auditLog } from "./sovereign-ledger-core.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";
import {
  computeLegitimacyForCoins,
  computeLegitimacyForCoinsByIssuer,
  publicLegitimacyView,
  scoreLegitimacy,
  summarizeLegitimacy,
  EMPTY_LEGITIMACY_FACTS,
  EMPTY_PUBLIC_LEGITIMACY,
  type LegitimacyScore,
  type PublicLegitimacy,
} from "./legitimacy.js";

export interface AgentInterfaceMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface Ctx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

const ENVELOPE = { network: "sovereign" as const, chain: "phase" as const, mode: "test" as const };

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function fmtUsd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Watchlist store — Postgres when reachable, in-memory fallback otherwise
// (same dual-mode pattern as offers.ts). Table: user_watchlist (021).
// ---------------------------------------------------------------------------

interface WatchlistStore {
  list(userId: string): Promise<string[]>;
  /** Returns true when the coin was newly added, false when already watched. */
  add(userId: string, coinId: string): Promise<boolean>;
  /** Returns true when a row was removed. */
  remove(userId: string, coinId: string): Promise<boolean>;
}

class PgWatchlistStore implements WatchlistStore {
  async list(userId: string): Promise<string[]> {
    const r = await getPool().query(
      `SELECT coin_id AS "coinId" FROM user_watchlist WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
    return r.rows.map((x: { coinId: string }) => x.coinId);
  }
  async add(userId: string, coinId: string): Promise<boolean> {
    const r = await getPool().query(
      `INSERT INTO user_watchlist (user_id, coin_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING coin_id`,
      [userId, coinId]
    );
    return r.rows.length > 0;
  }
  async remove(userId: string, coinId: string): Promise<boolean> {
    const r = await getPool().query(
      `DELETE FROM user_watchlist WHERE user_id = $1 AND coin_id = $2 RETURNING coin_id`,
      [userId, coinId]
    );
    return r.rows.length > 0;
  }
}

class MemoryWatchlistStore implements WatchlistStore {
  private byUser = new Map<string, string[]>();
  async list(userId: string): Promise<string[]> {
    return [...(this.byUser.get(userId) ?? [])];
  }
  async add(userId: string, coinId: string): Promise<boolean> {
    const cur = this.byUser.get(userId) ?? [];
    if (cur.includes(coinId)) return false;
    this.byUser.set(userId, [coinId, ...cur]);
    return true;
  }
  async remove(userId: string, coinId: string): Promise<boolean> {
    const cur = this.byUser.get(userId) ?? [];
    if (!cur.includes(coinId)) return false;
    this.byUser.set(userId, cur.filter((c) => c !== coinId));
    return true;
  }
}

let watchlistStorePromise: Promise<WatchlistStore> | null = null;
function getWatchlistStore(): Promise<WatchlistStore> {
  if (!watchlistStorePromise) {
    watchlistStorePromise = (async () => {
      try {
        await getPool().query("SELECT 1");
        return new PgWatchlistStore();
      } catch {
        return new MemoryWatchlistStore();
      }
    })();
  }
  return watchlistStorePromise;
}

// ---------------------------------------------------------------------------
// Coin cards — the presentation shape shared by dashboard + marketplace.
// Field set mirrors GET /api/v1/marketplace/coins (same draft enrichment,
// same float read) and adds display-ready strings for agent rendering.
// ---------------------------------------------------------------------------

interface CoinCard {
  id: string;
  chainId: string;
  name: string;
  ticker: string;
  category: string | null;
  tagline: string | null;
  valueThesis: string | null;
  priceUsd: number;
  supply: string;
  marketCapUsd: number;
  floatAvailable: string;
  isMeme: boolean;
  hasAgreement: boolean;
  issuerUserId: string;
  issuerAddress: string | null;
  socialProfiles: Array<{ platform: string; url: string }>;
  websiteUrl: string | null;
  logoUrl: string | null;
  createdAt: string;
  online: boolean;
  /** Compact public Phase Cred view (marketplace cards only; the
   *  dashboard replaces it with the full LegitimacyScore). */
  legitimacy?: PublicLegitimacy;
  display: { price: string; marketCap: string; headline: string };
  mine?: boolean;
  watchlisted?: boolean;
}

async function coinCard(c: IssuanceCoin): Promise<CoinCard> {
  const issuance = await getIssuanceStore();
  let category: string | null = c.category ?? null;
  let tagline: string | null = null;
  let valueThesis: string | null = null;
  let socialProfiles: Array<{ platform: string; url: string }> = [];
  try {
    const draft = c.draftId ? await issuance.getDraft(c.draftId) : null;
    if (draft) {
      category = draft.category?.trim() ? draft.category : category;
      tagline = draft.tagline?.trim() ? draft.tagline : null;
      valueThesis = draft.valueThesis?.trim() ? draft.valueThesis : null;
      if (draft.socialProfiles) {
        socialProfiles = Array.isArray(draft.socialProfiles)
          ? draft.socialProfiles
          : JSON.parse(draft.socialProfiles as unknown as string);
      }
    }
  } catch { /* keep coin-level fields only */ }
  let floatAvailable = "0";
  try {
    floatAvailable = BigInt(getChainBalance(c.mintAddress, PUBLIC_FLOAT_ADDRESS)).toString();
  } catch { floatAvailable = "0"; }
  const priceUsd = Number(c.priceUsd);
  const marketCapUsd = priceUsd * Number(c.supply);
  return {
    id: c.id,
    chainId: c.mintAddress,
    name: c.name,
    ticker: c.ticker,
    category,
    tagline,
    valueThesis,
    priceUsd,
    supply: c.supply,
    marketCapUsd,
    floatAvailable,
    isMeme: c.isMeme,
    hasAgreement: c.signatureId != null,
    issuerUserId: c.userId,
    issuerAddress: c.issuerAddress ?? null,
    socialProfiles,
    websiteUrl: c.websiteUrl ?? null,
    logoUrl: c.logoUrl ?? null,
    createdAt: c.createdAt,
    online: true,
    display: {
      price: fmtUsd(priceUsd),
      marketCap: fmtUsd(marketCapUsd),
      headline: `${c.name} (${c.ticker}) — ${tagline ?? category ?? "Sovereign coin on Phase"}`,
    },
  };
}

/** Position enrichment for my own coins — mirrors GET /api/v1/issuance/coins.
 *  Delegates to issuance.ts's coinFloatPosition so both stay consistent
 *  (total float = genesis float + cumulative post-mint releases). */
function coinPosition(c: IssuanceCoin): ReturnType<typeof coinFloatPosition> {
  return coinFloatPosition(c);
}

function offerSummary(o: SwapOffer, side: "inbox" | "outbox"): Record<string, unknown> {
  const target = o.targetTicker ?? o.targetChainId;
  const offered = o.offerTicker ?? o.offerChainId;
  return {
    id: o.id,
    side,
    status: o.status,
    targetTicker: o.targetTicker,
    targetChainId: o.targetChainId,
    offerTicker: o.offerTicker,
    offerChainId: o.offerChainId,
    offerUnits: o.offerUnits,
    requestUnits: o.requestUnits,
    counterOfferUnits: o.counterOfferUnits,
    counterRequestUnits: o.counterRequestUnits,
    createdAt: o.createdAt,
    // Inbox 'pending' waits on the seller; outbox 'countered' waits on the buyer.
    needsMyDecision: side === "inbox" ? o.status === "pending" : o.status === "countered",
    summary: side === "inbox"
      ? `Offer: ${o.offerUnits} ${offered} for ${o.requestUnits} ${target} of yours.`
      : `You offered ${o.offerUnits} ${offered} for ${o.requestUnits} ${target}.`,
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountAgentInterfaceRoutes(deps: AgentInterfaceMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError;

  const fail = (ctx: Ctx, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...ENVELOPE, error: code, message });
  };

  /** The ONLY source of userId on private agent routes: the Bearer token.
   *  Session tokens keep full access; OAuth tokens must carry the given
   *  scope (403 insufficient_scope otherwise). */
  const requireScopedUserId = async (ctx: Ctx, scope: string): Promise<string> => {
    const authed = await resolveBearerAuth(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    if (authed.kind === "oauth" && !authed.scopes.includes(scope)) {
      throw new HttpError(403, "insufficient_scope", `This token lacks the ${scope} scope.`);
    }
    return authed.userId;
  };
  const optionalUserId = async (ctx: Ctx): Promise<string | null> => {
    try {
      const authed = await resolveBearerAuth(ctx.req.headers);
      return authed ? authed.userId : null;
    } catch { return null; }
  };
  const clientIp = (ctx: Ctx): string => clientIpFromHeaders(ctx.req.headers);

  async function resolveCoin(idOrChain: string): Promise<IssuanceCoin | null> {
    const issuance = await getIssuanceStore();
    const all = await issuance.listAllCoins();
    return (
      all.find((c) => c.id === idOrChain || c.mintAddress === idOrChain) ??
      (await issuance.getCoinByChainId(idOrChain).catch(() => null))
    );
  }

  // --- GET /api/v1/agent/dashboard ---
  // One render-ready document: the agent presents this as the dashboard
  // visual. Sections degrade independently (partial: true) rather than
  // failing the whole view when one subsystem is unavailable.
  route("GET", "/api/v1/agent/dashboard", async (ctx: Ctx) => {
    try {
      const userId = await requireScopedUserId(ctx, "read:dashboard");
      if (!checkRateLimit(`agent-dash:${userId}`, 60, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      let partial = false;
      const section = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await fn(); } catch { partial = true; return fallback; }
      };

      const issuance = await getIssuanceStore();
      const market = await getMarketStore();

      const account = await section(async () => {
        let email: string | null = null;
        let name: string | null = null;
        try {
          const r = await getPool().query(
            `SELECT email, name FROM issuance_users WHERE id = $1`, [userId]
          );
          if (r.rows.length > 0) { email = r.rows[0].email ?? null; name = r.rows[0].name ?? null; }
        } catch { /* in-memory mode: identity beyond userId is unavailable */ }
        return { userId, email, name };
      }, { userId, email: null as string | null, name: null as string | null });

      const phaseBalance = await section(() => getPhaseBalance(userId), null as number | null);
      const usdBalance = await section(() => market.getBalance(userId, "USD"), null as string | null);
      const lifetimeSalesUsd = await section(() => market.lifetimeSalesUsd(userId), null as string | null);

      const myCoinsRaw = await section(() => issuance.listCoinsByUser(userId), [] as IssuanceCoin[]);
      const myCoinsBase = await Promise.all(myCoinsRaw.map(async (c) => {
        const card = await coinCard(c);
        const position = coinPosition(c);
        return {
          ...card,
          position: {
            ...position,
            // Listing-price value of the retained stake. NOT a market
            // value — realizationRatio says how much float actually sold.
            stakeValueUsdAtList: position.availableUnits != null
              ? Number(position.availableUnits) * Number(c.priceUsd)
              : null,
          },
        };
      }));

      // Legitimacy Score (legitimacy.ts): server-computed from real
      // records only. Degrades to a zero score per coin, never an error.
      const legitimacyByCoin = await section(
        () => computeLegitimacyForCoins(userId, myCoinsRaw),
        new Map<string, LegitimacyScore>()
      );
      const myCoins = myCoinsBase.map((c) => ({
        ...c,
        legitimacy: legitimacyByCoin.get(c.id) ?? scoreLegitimacy(EMPTY_LEGITIMACY_FACTS),
      }));
      const legitimacySummary = summarizeLegitimacy(
        myCoins.map((c) => ({ ticker: c.ticker, legitimacy: c.legitimacy }))
      );

      const recentActivity = await section(async () => {
        const [asBuyer, asSeller] = await Promise.all([
          market.listTrades(userId, "buyer"),
          market.listTrades(userId, "seller"),
        ]);
        const seen = new Map<string, { t: MarketTrade; role: "buyer" | "seller" }>();
        for (const t of asBuyer) seen.set(t.id, { t, role: "buyer" });
        for (const t of asSeller) if (!seen.has(t.id)) seen.set(t.id, { t, role: "seller" });
        return [...seen.values()]
          .sort((a, b) => (a.t.createdAt < b.t.createdAt ? 1 : -1))
          .slice(0, 10)
          .map(({ t, role }) => ({
            id: t.id,
            kind: t.kind,
            role,
            chainId: t.chainId,
            coinId: t.coinId,
            units: t.units,
            amountUsd: t.amountUsd,
            createdAt: t.createdAt,
            summary: t.kind === "swap"
              ? `${role === "buyer" ? "Swapped for" : "Swap received:"} ${t.units} units on ${t.chainId}`
              : `${role === "buyer" ? "Bought" : "Sold"} ${t.units} units for ${fmtUsd(Number(t.amountUsd))}`,
          }));
      }, [] as Array<Record<string, unknown>>);

      const offers = await section(async () => {
        const store = await getOffersStore();
        const [inbox, outbox] = await Promise.all([
          store.listBySeller(userId, true),
          store.listByBuyer(userId, true),
        ]);
        return {
          inbox: inbox.map((o) => offerSummary(o, "inbox")),
          outbox: outbox.map((o) => offerSummary(o, "outbox")),
        };
      }, { inbox: [] as Array<Record<string, unknown>>, outbox: [] as Array<Record<string, unknown>> });

      const watchIds = await section(async () => (await getWatchlistStore()).list(userId), [] as string[]);
      const watchlist = await section(async () => {
        const cards: CoinCard[] = [];
        for (const id of watchIds) {
          const c = await resolveCoin(id);
          if (c) cards.push({ ...(await coinCard(c)), watchlisted: true });
        }
        return cards;
      }, [] as CoinCard[]);

      const decisionsWaiting = [...offers.inbox, ...offers.outbox]
        .filter((o) => o.needsMyDecision).length;
      const summaryParts: string[] = [];
      if (phaseBalance != null) summaryParts.push(`${fmtInt(phaseBalance)} PHASE`);
      if (usdBalance != null) summaryParts.push(`${fmtUsd(Number(usdBalance))} USD`);
      summaryParts.push(`${myCoins.length} coin${myCoins.length === 1 ? "" : "s"} issued`);
      if (watchlist.length > 0) summaryParts.push(`${watchlist.length} watched`);
      if (decisionsWaiting > 0) {
        summaryParts.push(`${decisionsWaiting} swap offer${decisionsWaiting === 1 ? "" : "s"} waiting for your decision`);
      }

      const quickActions: Array<Record<string, unknown>> = [
        { id: "browse_marketplace", label: "Browse the marketplace", method: "GET", path: "/api/v1/agent/marketplace" },
        { id: "mint_new_coin", label: "Mint a new coin", method: "POST", path: "/api/v1/issuance/draft", requiresConfirmation: true },
      ];
      if (myCoins.length > 0) {
        quickActions.push({
          id: "edit_my_coin", label: "Edit my coin's profile (tagline, website, socials)",
          method: "PATCH", path: "/api/v1/coins/:id", requiresConfirmation: true,
        });
      }
      if (decisionsWaiting > 0) {
        quickActions.push({
          id: "review_offers", label: "Review swap offers waiting on you",
          method: "GET", path: "/api/v1/offers/inbox", requiresConfirmation: false,
        });
      }

      sendJson(ctx.res, 200, {
        ...ENVELOPE,
        view: "dashboard",
        generatedAt: new Date().toISOString(),
        partial,
        summary: summaryParts.join(" · "),
        account,
        balances: { PHASE: phaseBalance, USD: usdBalance, lifetimeSalesUsd },
        myCoins,
        legitimacySummary,
        recentActivity,
        openOffers: offers,
        watchlist,
        quickActions,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/agent/marketplace ---
  // Public browse, shaped for agent presentation. Bearer optional: when
  // present, cards carry `mine` and `watchlisted` flags.
  route("GET", "/api/v1/agent/marketplace", async (ctx: Ctx) => {
    try {
      if (!checkRateLimit(`agent-mkt:${clientIp(ctx)}`, 120, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      const userId = await optionalUserId(ctx);
      const search = (ctx.query.get("search") ?? "").trim().toLowerCase();
      const category = (ctx.query.get("category") ?? "").trim().toLowerCase();
      const limitRaw = Number(ctx.query.get("limit") ?? 20);
      const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 20;
      const cursorRaw = Number(ctx.query.get("cursor") ?? 0);
      const offset = Number.isFinite(cursorRaw) && cursorRaw > 0 ? Math.floor(cursorRaw) : 0;

      const issuance = await getIssuanceStore();
      const all = await issuance.listAllCoins();
      let cards = await Promise.all(all.map((c) => coinCard(c)));

      // Phase Cred (public view): the same scorer the dashboard runs,
      // in the compact earned-only shape for marketplace presentation.
      // Degrades to a zero view per card — browsing never fails on it.
      const legitimacyByCoin = await computeLegitimacyForCoinsByIssuer(all).catch(
        () => new Map<string, LegitimacyScore>()
      );
      cards = cards.map((c) => ({
        ...c,
        legitimacy: legitimacyByCoin.has(c.id)
          ? publicLegitimacyView(legitimacyByCoin.get(c.id)!)
          : EMPTY_PUBLIC_LEGITIMACY,
      }));

      const catCounts = new Map<string, number>();
      for (const c of cards) {
        if (c.category) catCounts.set(c.category, (catCounts.get(c.category) ?? 0) + 1);
      }
      const categories = [...catCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name));

      if (search) {
        cards = cards.filter((c) =>
          c.name.toLowerCase().includes(search) ||
          c.ticker.toLowerCase().includes(search) ||
          (c.tagline ?? "").toLowerCase().includes(search));
      }
      if (category) {
        cards = cards.filter((c) => (c.category ?? "").toLowerCase() === category);
      }

      let watchSet = new Set<string>();
      if (userId) {
        watchSet = new Set(await (await getWatchlistStore()).list(userId).catch(() => [] as string[]));
        cards = cards.map((c) => ({ ...c, mine: c.issuerUserId === userId, watchlisted: watchSet.has(c.id) }));
      }

      const total = cards.length;
      const page = cards.slice(offset, offset + limit);
      const nextOffset = offset + limit;
      sendJson(ctx.res, 200, {
        ...ENVELOPE,
        view: "marketplace",
        generatedAt: new Date().toISOString(),
        total,
        categories,
        coins: page,
        nextCursor: nextOffset < total ? String(nextOffset) : null,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/agent/watchlist ---
  route("GET", "/api/v1/agent/watchlist", async (ctx: Ctx) => {
    try {
      const userId = await requireScopedUserId(ctx, "read:coins");
      const ids = await (await getWatchlistStore()).list(userId);
      const coins: CoinCard[] = [];
      for (const id of ids) {
        const c = await resolveCoin(id);
        if (c) coins.push({ ...(await coinCard(c)), watchlisted: true, mine: c.userId === userId });
      }
      sendJson(ctx.res, 200, { ...ENVELOPE, view: "watchlist", coins });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/agent/watchlist --- { coinId } (id or chainId)
  route("POST", "/api/v1/agent/watchlist", async (ctx: Ctx) => {
    try {
      const userId = await requireScopedUserId(ctx, "write:watchlist");
      if (!checkRateLimit(`agent-watch:${userId}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      const body = asRecord(ctx.body);
      const coinId = str(body.coinId).trim();
      if (!coinId) throw new HttpError(400, "missing_coin_id", "Body must include coinId (a coin id or chain id).");
      const coin = await resolveCoin(coinId);
      if (!coin) throw new HttpError(404, "coin_not_found", "No coin with that id.");
      const added = await (await getWatchlistStore()).add(userId, coin.id);
      sendJson(ctx.res, added ? 201 : 200, {
        ...ENVELOPE,
        watchlist: { coinId: coin.id, watching: true, alreadyWatching: !added },
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- DELETE /api/v1/agent/watchlist/:coinId --- (idempotent)
  route("DELETE", "/api/v1/agent/watchlist/:coinId", async (ctx: Ctx) => {
    try {
      const userId = await requireScopedUserId(ctx, "write:watchlist");
      const coin = await resolveCoin(ctx.params.coinId);
      const store = await getWatchlistStore();
      // Remove by canonical id when the coin resolves; otherwise try the
      // raw param (a since-deleted coin should still be unwatchable).
      const removed = await store.remove(userId, coin ? coin.id : ctx.params.coinId);
      sendJson(ctx.res, 200, {
        ...ENVELOPE,
        watchlist: { coinId: coin ? coin.id : ctx.params.coinId, watching: false, wasWatching: removed },
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/offers/:id/cancel ---
  // The buyer withdraws their own open offer. offers.ts covers
  // accept/counter/decline; cancel completes the decision set. Guarded
  // by status, so a replayed cancel returns 409 instead of double-acting.
  route("POST", "/api/v1/offers/:id/cancel", async (ctx: Ctx) => {
    try {
      const userId = await requireScopedUserId(ctx, "write:offers");
      if (!checkRateLimit(`agent-offers:${userId}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      const store = await getOffersStore();
      const offer = await store.getById(ctx.params.id);
      if (!offer) throw new HttpError(404, "offer_not_found", "No offer with that id.");
      if (offer.buyerUserId !== userId) {
        throw new HttpError(403, "forbidden",
          offer.sellerUserId === userId
            ? "You received this offer — decline it instead of cancelling."
            : "Only the buyer who made this offer can cancel it.");
      }
      if (offer.status !== "pending" && offer.status !== "countered") {
        throw new HttpError(409, "offer_not_open", `This offer is already ${offer.status}.`);
      }
      const updated = await store.setDecided(offer.id, "cancelled");
      await auditLog(userId, "swap_offer_cancelled", "swap_offer", offer.id, {
        targetChainId: offer.targetChainId, offerChainId: offer.offerChainId,
      }).catch(() => { /* audit is best-effort */ });
      sendJson(ctx.res, 200, { ...ENVELOPE, offer: updated });
    } catch (err) { fail(ctx, err); }
  });
}
