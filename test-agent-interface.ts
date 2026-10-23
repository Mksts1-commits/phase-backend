/**
 * test-agent-interface.ts — hermetic coverage for the agent interface.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-agent-interface.ts
 *
 * Fully hermetic (no DATABASE_URL): exercises the real routes for
 *   GET  /api/v1/agent/dashboard     (Bearer-only identity, aggregates)
 *   GET  /api/v1/agent/marketplace   (public visual payload + filters)
 *   GET/POST/DELETE /api/v1/agent/watchlist
 *   POST /api/v1/offers/:id/cancel   (buyer-only, status-guarded)
 * plus regression checks on PATCH /api/v1/coins/:id (coin-edit) and
 * GET /api/v1/marketplace/coins.
 *
 * Security focus: a userId supplied in query/body is never honored —
 * the dashboard always describes the Bearer token's owner.
 */
import * as crypto from "node:crypto";
import { createChain, b58encode, startSequencerLoop } from "./sovereign-ledger-core.js";
import { mountAuthRoutes } from "./auth.js";
import { mountIssuanceRoutes, getIssuanceStore } from "./issuance.js";
import { mountMarketplaceRoutes } from "./marketplace.js";
import { mountOffersRoutes } from "./offers.js";
import { mountCoinEditRoutes } from "./coin-edit.js";
import { mountAgentInterfaceRoutes } from "./agent-interface.js";

if (process.env.DATABASE_URL) {
  console.error("Refusing to run: unset DATABASE_URL so the test stays hermetic (in-memory).");
  process.exit(2);
}
process.env.PHASE_TREASURY_SOVEREIGN_ADDRESS = "ph1" + b58encode(crypto.randomBytes(32));

let passed = 0;
let failed = 0;
function ok(name: string, cond: unknown, detail = "") {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name} ${detail}`); }
}
function ph1(): string {
  return "ph1" + b58encode(crypto.randomBytes(32));
}

// --- fake HTTP plumbing (same pattern as test-offers.ts) -------------------
const handlers = new Map<string, (ctx: any) => Promise<void> | void>();
class HttpError extends Error {
  statusCode: number; code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message); this.statusCode = statusCode; this.code = code;
  }
}
const deps = {
  route: (m: string, p: string, h: any) => { handlers.set(`${m} ${p}`, h); },
  sendJson: (res: any, status: number, body: unknown) => { res.status = status; res.body = body; },
  HttpError: HttpError as any,
};
mountAuthRoutes(deps);
mountIssuanceRoutes(deps);
mountMarketplaceRoutes(deps);
mountOffersRoutes(deps);
mountCoinEditRoutes(deps);
mountAgentInterfaceRoutes(deps);

async function call(method: string, path: string, body: any = {}, headers: Record<string, string> = {}, query = "") {
  const res: any = {};
  let h = handlers.get(`${method} ${path}`);
  const params: Record<string, string> = {};
  if (!h) {
    for (const [k, v] of handlers) {
      const [km, kp] = k.split(" ", 2);
      if (km !== method) continue;
      const kre = "^" + kp.replace(/:[^/]+/g, "([^/]+)") + "$";
      const m = path.match(new RegExp(kre));
      if (m) {
        const names = [...kp.matchAll(/:([^/]+)/g)].map((x) => x[1]);
        names.forEach((n, i) => { params[n] = m[i + 1]; });
        h = v;
        break;
      }
    }
  }
  if (!h) throw new Error(`no handler for ${method} ${path}`);
  await h({ req: { headers }, res, params, query: new URLSearchParams(query), body });
  return res as { status: number; body: any };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function main() {
  console.log("agent-interface tests (in-memory)");
  const sequencer = startSequencerLoop();

  // --- users ------------------------------------------------------------------
  const mkUser = async (name: string, email: string) => {
    const r = await call("POST", "/api/v1/auth/signup", { name, email, password: "test-password-123" });
    ok(`signup ${name} 201`, r.status === 201 && !!r.body.token, JSON.stringify(r.body).slice(0, 140));
    return { userId: r.body.userId as string, token: r.body.token as string };
  };
  const seller = await mkUser("Seller", "seller-agent@example.com");
  const buyer = await mkUser("Buyer", "buyer-agent@example.com");
  const sellerAddr = ph1();
  const buyerAddr = ph1();

  // --- seller mints a real coin through the agent flow -------------------------
  let r = await call("POST", "/api/v1/issuance/draft", {
    name: "Creator Coin", ticker: "CRT", tagline: "For my community",
    valueThesis: "Community membership and perks.", category: "Creator",
    equityPublic: 50, equityRetained: 50, priceUsd: 2.5, totalShares: 100000,
    socialProfiles: [{ platform: "tiktok", url: "https://tiktok.com/@crt" }],
  }, auth(seller.token));
  ok("draft 201", r.status === 201 && !!r.body.draftId, JSON.stringify(r.body).slice(0, 140));
  const draftId = r.body.draftId;

  r = await call("GET", "/api/v1/issuance/agreement", {}, auth(seller.token), `draftId=${draftId}`);
  ok("agreement 200", r.status === 200 && typeof r.body.agreementText === "string");
  r = await call("POST", "/api/v1/issuance/sign",
    { draftId, legalName: "Seller Legal Name", accepted: true }, auth(seller.token));
  ok("sign 201", r.status === 201 && !!r.body.signatureId, JSON.stringify(r.body).slice(0, 140));

  r = await call("POST", "/api/v1/issuance/mint",
    { draftId, issuerAddress: sellerAddr, totalShares: 100000 },
    { ...auth(seller.token), "idempotency-key": "mint-crt-1" });
  ok("mint 201", r.status === 201 && !!r.body.coin?.id, JSON.stringify(r.body).slice(0, 200));
  const sellerCoin = r.body.coin;
  const sellerChainId: string = sellerCoin.mintAddress;

  // --- buyer seeds a coin directly (store-level, like test-offers) -------------
  const buyerChain = await createChain({
    coin_name: "Buyer Coin", ticker: "BYR", total_supply: "100000",
    decimals: 6, equity_public_pct: 50, issuer_address: buyerAddr, is_meme: true,
  });
  const buyerChainId: string = buyerChain.chain_id;
  const issuance = await getIssuanceStore();
  await issuance.storeCoin({
    draftId: "draft-byr", userId: buyer.userId, signatureId: "sig-byr",
    isMeme: true, name: "Buyer Coin", ticker: "BYR", mintAddress: buyerChainId,
    txSignature: buyerChain.genesis_hash, supply: "100000", decimals: 6,
    priceUsd: 10, issuerAddress: buyerAddr, idempotencyKey: "coin-byr",
    category: null, totalShares: 100000, retainedShares: 50000, websiteUrl: null, logoUrl: null,
  });

  // --- dashboard: auth + identity ----------------------------------------------
  r = await call("GET", "/api/v1/agent/dashboard");
  ok("dashboard without token 401", r.status === 401 && r.body.error === "unauthorized");
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(seller.token), `userId=${buyer.userId}`);
  ok("dashboard ignores ?userId= (token wins)",
    r.status === 200 && r.body.account?.userId === seller.userId, JSON.stringify(r.body.account));
  ok("dashboard view + mode", r.body.view === "dashboard" && r.body.mode === "test");
  ok("dashboard balances shaped", r.body.balances && "USD" in r.body.balances && "PHASE" in r.body.balances);
  ok("dashboard summary present", typeof r.body.summary === "string" && r.body.summary.length > 0);
  ok("dashboard quickActions include marketplace",
    Array.isArray(r.body.quickActions) && r.body.quickActions.some((a: any) => a.id === "browse_marketplace"));

  // --- dashboard: my coins with position -----------------------------------------
  const dashCoin = r.body.myCoins?.find((c: any) => c.id === sellerCoin.id);
  ok("dashboard myCoins has minted coin", !!dashCoin);
  ok("myCoins availableUnits = retained 50000", dashCoin?.position?.availableUnits === "50000",
    JSON.stringify(dashCoin?.position));
  ok("myCoins realizationRatio = 0", dashCoin?.position?.realizationRatio === 0);
  ok("myCoins card has display price", dashCoin?.display?.price === "$2.50");

  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(buyer.token));
  ok("buyer dashboard myCoins excludes seller coin",
    r.status === 200 && !(r.body.myCoins ?? []).some((c: any) => c.id === sellerCoin.id));

  // --- marketplace visual -----------------------------------------------------------
  r = await call("GET", "/api/v1/agent/marketplace");
  ok("marketplace public 200", r.status === 200 && r.body.view === "marketplace");
  ok("marketplace lists both coins", r.body.total === 2, `total=${r.body.total}`);
  const crtCard = (r.body.coins ?? []).find((c: any) => c.ticker === "CRT");
  ok("card display strings", crtCard?.display?.price === "$2.50" && crtCard?.display?.marketCap === "$250,000.00",
    JSON.stringify(crtCard?.display));
  ok("card carries category + tagline", crtCard?.category === "Creator" && crtCard?.tagline === "For my community");
  ok("categories include Creator", (r.body.categories ?? []).some((c: any) => c.name === "Creator" && c.count === 1));

  r = await call("GET", "/api/v1/agent/marketplace", {}, {}, "search=crt");
  ok("search filters by ticker", r.status === 200 && r.body.total === 1 && r.body.coins[0].ticker === "CRT");
  r = await call("GET", "/api/v1/agent/marketplace", {}, {}, "category=creator");
  ok("category filter (case-insensitive)", r.status === 200 && r.body.total === 1);
  r = await call("GET", "/api/v1/agent/marketplace", {}, {}, "category=Nope");
  ok("category filter empty", r.status === 200 && r.body.total === 0);
  r = await call("GET", "/api/v1/agent/marketplace", {}, {}, "limit=1");
  ok("pagination page 1 + cursor", r.status === 200 && r.body.coins.length === 1 && r.body.nextCursor === "1");
  r = await call("GET", "/api/v1/agent/marketplace", {}, {}, "limit=1&cursor=1");
  ok("pagination page 2 ends", r.status === 200 && r.body.coins.length === 1 && r.body.nextCursor === null);

  r = await call("GET", "/api/v1/agent/marketplace", {}, auth(seller.token));
  const mineCard = (r.body.coins ?? []).find((c: any) => c.ticker === "CRT");
  ok("authed card flags mine=true for issuer", mineCard?.mine === true && mineCard?.watchlisted === false);

  // --- watchlist ----------------------------------------------------------------------
  r = await call("POST", "/api/v1/agent/watchlist", { coinId: sellerCoin.id });
  ok("watchlist without token 401", r.status === 401);
  r = await call("POST", "/api/v1/agent/watchlist", { coinId: "no-such-coin" }, auth(buyer.token));
  ok("watchlist unknown coin 404", r.status === 404 && r.body.error === "coin_not_found");
  r = await call("POST", "/api/v1/agent/watchlist", { coinId: sellerCoin.id }, auth(buyer.token));
  ok("watchlist add 201", r.status === 201 && r.body.watchlist?.watching === true);
  r = await call("POST", "/api/v1/agent/watchlist", { coinId: sellerChainId }, auth(buyer.token));
  ok("watchlist re-add by chainId idempotent 200",
    r.status === 200 && r.body.watchlist?.alreadyWatching === true);
  r = await call("GET", "/api/v1/agent/watchlist", {}, auth(buyer.token));
  ok("watchlist lists the coin", r.status === 200 && r.body.coins?.length === 1 && r.body.coins[0].ticker === "CRT");
  r = await call("GET", "/api/v1/agent/marketplace", {}, auth(buyer.token));
  ok("marketplace flags watchlisted for buyer",
    (r.body.coins ?? []).find((c: any) => c.ticker === "CRT")?.watchlisted === true);
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(buyer.token));
  ok("dashboard includes watchlist", (r.body.watchlist ?? []).length === 1);

  // --- tweak: coin profile edit (existing endpoint, agent flow regression) --------------
  // NOTE: coin-edit.ts is Postgres-only (no in-memory fallback), so in this
  // hermetic harness the owner/non-owner checks below self-skip when the
  // store reports DATABASE_URL missing; they are covered live instead.
  r = await call("PATCH", `/api/v1/coins/${sellerCoin.id}`, { tagline: "x" });
  ok("PATCH coin without token 401", r.status === 401);
  const probe = await call("PATCH", `/api/v1/coins/${sellerCoin.id}`, { tagline: "probe" }, auth(seller.token));
  if (probe.status === 500 && /DATABASE_URL/.test(probe.body?.message ?? "")) {
    console.log("  SKIP PATCH owner/non-owner checks (coin-edit needs Postgres; covered live)");
  } else {
    r = await call("PATCH", `/api/v1/coins/${sellerCoin.id}`, { tagline: "New tagline from agent" }, auth(buyer.token));
    ok("PATCH coin by non-owner 403", r.status === 403);
    r = await call("PATCH", `/api/v1/coins/${sellerCoin.id}`, { tagline: "New tagline from agent" }, auth(seller.token));
    ok("PATCH coin by owner 200", r.status === 200 && r.body.tagline === "New tagline from agent",
      JSON.stringify(r.body).slice(0, 140));
    const patchPathWorks = r.status === 200;
    r = await call("GET", "/api/v1/agent/marketplace", {}, {}, "search=CRT");
    ok("tweak visible in marketplace card", r.body.coins?.[0]?.tagline === "New tagline from agent");
    // Logo (migration 024): owner can set and clear logoUrl via the
    // same PATCH; the value rides the coin record. Asserted only
    // where the PATCH path actually works (Postgres present), so this
    // harness's environmental failure set is unchanged; covered live.
    if (patchPathWorks) {
      r = await call("PATCH", `/api/v1/coins/${sellerCoin.id}`, { logoUrl: "https://cdn.example.com/crt-logo.png" }, auth(seller.token));
      ok("PATCH logoUrl by owner 200 + echoed", r.status === 200 && r.body.logoUrl === "https://cdn.example.com/crt-logo.png",
        JSON.stringify(r.body).slice(0, 140));
      r = await call("PATCH", `/api/v1/coins/${sellerCoin.id}`, { logoUrl: null }, auth(seller.token));
      ok("PATCH logoUrl null clears", r.status === 200 && r.body.logoUrl === null,
        JSON.stringify(r.body).slice(0, 140));
    } else {
      console.log("  SKIP logoUrl PATCH checks (coin-edit needs Postgres; covered live)");
    }
  }

  // --- offers: create, dashboard visibility, cancel rules --------------------------------
  r = await call("POST", "/api/v1/offers", {
    targetChainId: sellerChainId, offerChainId: buyerChainId,
    offerUnits: "20", requestUnits: "9", buyerAddress: buyerAddr, idempotencyKey: "agent-offer-1",
  }, auth(buyer.token));
  ok("offer create 201", r.status === 201 && !!r.body.offer?.id, JSON.stringify(r.body).slice(0, 160));
  const offerId = r.body.offer?.id;

  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(seller.token));
  const inboxOffer = (r.body.openOffers?.inbox ?? []).find((o: any) => o.id === offerId);
  ok("seller dashboard inbox shows offer needing decision",
    !!inboxOffer && inboxOffer.needsMyDecision === true, JSON.stringify(r.body.openOffers));
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(buyer.token));
  const outboxOffer = (r.body.openOffers?.outbox ?? []).find((o: any) => o.id === offerId);
  ok("buyer dashboard outbox shows offer", !!outboxOffer && outboxOffer.needsMyDecision === false);

  r = await call("POST", `/api/v1/offers/${offerId}/cancel`, {});
  ok("cancel without token 401", r.status === 401);
  r = await call("POST", `/api/v1/offers/${offerId}/cancel`, {}, auth(seller.token));
  ok("seller cancel 403 (decline instead)", r.status === 403 && /decline/i.test(r.body.message ?? ""));
  r = await call("POST", "/api/v1/offers/nope/cancel", {}, auth(buyer.token));
  ok("cancel unknown offer 404", r.status === 404);
  r = await call("POST", `/api/v1/offers/${offerId}/cancel`, {}, auth(buyer.token));
  ok("buyer cancel 200 cancelled", r.status === 200 && r.body.offer?.status === "cancelled",
    JSON.stringify(r.body).slice(0, 160));
  r = await call("POST", `/api/v1/offers/${offerId}/cancel`, {}, auth(buyer.token));
  ok("re-cancel 409 offer_not_open", r.status === 409 && r.body.error === "offer_not_open");
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(buyer.token));
  ok("cancelled offer leaves dashboard outbox",
    !(r.body.openOffers?.outbox ?? []).some((o: any) => o.id === offerId));

  // --- watchlist remove (after offer flow, order-independent) ------------------------------
  r = await call("DELETE", `/api/v1/agent/watchlist/${sellerCoin.id}`, {}, auth(buyer.token));
  ok("watchlist remove 200", r.status === 200 && r.body.watchlist?.watching === false && r.body.watchlist?.wasWatching === true);
  r = await call("DELETE", `/api/v1/agent/watchlist/${sellerCoin.id}`, {}, auth(buyer.token));
  ok("watchlist remove idempotent", r.status === 200 && r.body.watchlist?.wasWatching === false);
  r = await call("GET", "/api/v1/agent/watchlist", {}, auth(buyer.token));
  ok("watchlist empty after remove", r.status === 200 && r.body.coins?.length === 0);

  // --- regression: legacy marketplace directory ----------------------------------------------
  r = await call("GET", "/api/v1/marketplace/coins");
  ok("legacy /marketplace/coins still lists coins",
    r.status === 200 && (r.body.coins ?? []).length === 2, JSON.stringify(r.body).slice(0, 120));

  clearInterval(sequencer as any);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
