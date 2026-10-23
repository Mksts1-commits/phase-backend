/**
 * test-legitimacy.ts — hermetic coverage for the Legitimacy Score.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-legitimacy.ts
 *
 * Two layers:
 *  1. The PURE scorer (scoreLegitimacy): rubric integrity (points sum
 *     to 100), empty facts -> 0 / Meme Territory, the spec's example
 *     sums, a fully-loaded fact set -> 100 / Phase Territory, and every
 *     band edge (14/15, 39/40, 64/65, 79/80).
 *  2. Endpoint shape over the real routes (in-memory stores, no
 *     DATABASE_URL): signup -> draft -> sign -> mint, a social
 *     connection seeded into the shared social store, then
 *     GET /api/v1/legitimacy/me and the agent dashboard must agree on
 *     the same per-coin structures. Postgres-backed items (the
 *     document trio — license/ownership, government ID, bank
 *     statement/report — and funding deposits) earn 0 in this
 *     harness: their earning rules are covered at the pure-predicate
 *     level below, and end-to-end by their stores' own suites and
 *     live checks.
 *
 * Link checks are stubbed (setLinkFetcher) so nothing leaves the box.
 *
 * Expected hermetic score for the flow coin:
 *   agreement 20 + social connected 12 + reference URL 7
 *   + social profile 6 + full profile 6 = 51.
 * (Legal identity earns 0 here BY DESIGN under the current rule: the
 * signature declaration exists, but the government-ID document lives
 * in the Postgres documents store — signature alone no longer earns
 * the 8 points.)
 */
import * as crypto from "node:crypto";
import { b58encode, startSequencerLoop } from "./sovereign-ledger-core.js";
import { mountAuthRoutes } from "./auth.js";
import { mountIssuanceRoutes } from "./issuance.js";
import { mountAgentInterfaceRoutes } from "./agent-interface.js";
import { mountLegitimacyRoutes } from "./legitimacy.js";
import { getSocialStore } from "./social-auth.js";
import { getIssuanceStore } from "./issuance.js";
import { setLinkFetcher, verdictForStatus, verdictForError } from "./link-check.js";
import {
  scoreLegitimacy,
  bandForScore,
  summarizeLegitimacy,
  legitimacyForUser,
  hasBankDocument,
  hasOwnershipDocument,
  ownershipHintFlavor,
  BROKEN_LINK_HINT,
  EMPTY_LEGITIMACY_FACTS,
  EMPTY_PUBLIC_LEGITIMACY,
  publicLegitimacyView,
  LEGITIMACY_RUBRIC,
  type LegitimacyFacts,
  type LegitimacyScore,
} from "./legitimacy.js";

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

// ---------------------------------------------------------------------------
// 1. Pure scorer
// ---------------------------------------------------------------------------

const F = (over: Partial<LegitimacyFacts>): LegitimacyFacts => ({ ...EMPTY_LEGITIMACY_FACTS, ...over });
const FULL: LegitimacyFacts = {
  agreementSigned: true,
  hasOwnershipDocument: true,
  category: "Creator",
  legalIdentityDeclared: true,
  hasGovernmentId: true,
  socialConnected: true,
  referenceUrl: "https://example.com",
  websiteUrlBroken: false,
  socialProfileCount: 2,
  socialProfilesExist: true,
  bankLinked: true,
  walletFunded: true,
  tagline: "A tagline",
  valueThesis: "A thesis",
  hasLogo: true,
  logoBroken: false,
};
const itemOf = (s: LegitimacyScore, key: string) =>
  s.groups.flatMap((g) => g.items).find((i) => i.key === key)!;

console.log("legitimacy scorer (pure)");
{
  const totalPoints = LEGITIMACY_RUBRIC.reduce((s, i) => s + i.points, 0);
  ok("rubric points sum to 100", totalPoints === 100, `sum=${totalPoints}`);
  ok("rubric has 10 items", LEGITIMACY_RUBRIC.length === 10);

  const empty = scoreLegitimacy(EMPTY_LEGITIMACY_FACTS);
  ok("empty facts -> 0", empty.score === 0);
  ok("empty facts -> Meme Territory", empty.band === "meme" && empty.bandLabel === "Meme Territory");
  ok("groups ordered legal/presence/financial/product",
    empty.groups.map((g) => g.key).join(",") === "legal,presence,financial,product");
  ok("every item shaped + unearned",
    empty.groups.every((g) => g.items.every((i) =>
      typeof i.key === "string" && typeof i.label === "string" &&
      typeof i.points === "number" && i.earned === 0 && i.done === false &&
      typeof i.status === "string" &&
      typeof i.hint === "string" && i.hint.length > 0)));
  ok("default context: every unearned item is available (none coming_soon)",
    empty.groups.every((g) => g.items.every((i) => i.status === "available")));

  const spec = scoreLegitimacy(F({
    agreementSigned: true, referenceUrl: "https://example.com",
    tagline: "T", valueThesis: "V",
  }));
  ok("agreement+URL+profile = 33", spec.score === 33, `score=${spec.score}`);
  ok("33 -> Emerging", spec.band === "emerging");

  const full = scoreLegitimacy(FULL);
  ok("fully loaded -> 100", full.score === 100, `score=${full.score}`);
  ok("100 -> Phase Territory", full.band === "phase" && full.bandLabel === "Phase Territory");
  ok("fully loaded: every item done with full points",
    full.groups.every((g) => g.items.every((i) => i.done && i.earned === i.points)));

  // Band edges — each fact set sums exactly to the edge score.
  const edges: Array<[number, Partial<LegitimacyFacts>, string]> = [
    [14, { walletFunded: true, hasLogo: true }, "meme"],
    [15, { bankLinked: true }, "emerging"],
    [39, { agreementSigned: true, hasOwnershipDocument: true, referenceUrl: "https://x.co" }, "emerging"],
    [40, { agreementSigned: true, hasOwnershipDocument: true, legalIdentityDeclared: true, hasGovernmentId: true }, "established"],
    [64, { agreementSigned: true, bankLinked: true, socialConnected: true, walletFunded: true, referenceUrl: "https://x.co" }, "established"],
    [65, { agreementSigned: true, bankLinked: true, socialConnected: true, walletFunded: true, legalIdentityDeclared: true, hasGovernmentId: true }, "proven"],
    [79, { ...FULL, bankLinked: false, tagline: null }, "proven"],
    [80, { ...FULL, agreementSigned: false }, "phase"],
  ];
  for (const [want, facts, band] of edges) {
    const s = scoreLegitimacy(F(facts));
    ok(`edge ${want} sums exactly`, s.score === want, `score=${s.score}`);
    ok(`edge ${want} -> ${band}`, s.band === band && bandForScore(want).band === band);
  }

  const sum = summarizeLegitimacy([
    { ticker: "AAA", legitimacy: scoreLegitimacy(F({ bankLinked: true })) },
    { ticker: "BBB", legitimacy: scoreLegitimacy(FULL) },
  ]);
  ok("summary picks the best coin", sum.bestScore === 100 && sum.bestCoinTicker === "BBB");
  ok("summary graduates at 80+", sum.netWorthGraduated === true);
  const none = summarizeLegitimacy([]);
  ok("summary of no coins", none.bestScore === 0 && none.bestCoinTicker === null && none.netWorthGraduated === false);

  // --- legal_identity: signature declaration AND government ID -------
  const SIGN_FIRST_HINT = "Sign with your legal name and declare your issuer type (individual or entity).";
  const ID_HINT = "Add a government-issued ID to verify your legal name.";
  const liNone = itemOf(scoreLegitimacy(F({})), "legal_identity");
  ok("legal identity: neither record -> 0, sign-first hint",
    liNone.earned === 0 && liNone.done === false && liNone.hint === SIGN_FIRST_HINT, liNone.hint);
  const liSigOnly = itemOf(scoreLegitimacy(F({ legalIdentityDeclared: true })), "legal_identity");
  ok("legal identity: signature only -> 0 with the ID hint",
    liSigOnly.earned === 0 && liSigOnly.done === false && liSigOnly.hint === ID_HINT, liSigOnly.hint);
  const liIdOnly = itemOf(scoreLegitimacy(F({ hasGovernmentId: true })), "legal_identity");
  ok("legal identity: ID only -> 0, sign-first hint",
    liIdOnly.earned === 0 && liIdOnly.done === false && liIdOnly.hint === SIGN_FIRST_HINT, liIdOnly.hint);
  const liBoth = itemOf(scoreLegitimacy(F({ legalIdentityDeclared: true, hasGovernmentId: true })), "legal_identity");
  ok("legal identity: signature + ID -> 8, earned",
    liBoth.earned === 8 && liBoth.done === true && liBoth.status === "earned");

  // --- bank item: documentary predicate -------------------------------
  ok("bank doc: bank_statement earns", hasBankDocument(["bank_statement"]) === true);
  ok("bank doc: financial_report earns", hasBankDocument(["financial_report"]) === true);
  ok("bank doc: business_license does not earn the bank item", hasBankDocument(["business_license"]) === false);
  ok("bank doc: no documents -> no bank points", hasBankDocument([]) === false);
  const bankItem = itemOf(scoreLegitimacy(F({ bankLinked: true })), "bank_linked");
  ok("bank item earns 15 from the document fact, labeled as documents",
    bankItem.earned === 15 && bankItem.label === "Bank statement or reports on file");
  ok("bank item is available (not coming_soon) while unearned",
    itemOf(scoreLegitimacy(F({})), "bank_linked").status === "available");

  // --- license/ownership item: asset-aware documents ------------------
  ok("ownership doc: business_license earns", hasOwnershipDocument(["business_license"]) === true);
  ok("ownership doc: deed earns (real estate)", hasOwnershipDocument(["deed"]) === true);
  ok("ownership doc: certificate_of_authenticity earns (collectables)",
    hasOwnershipDocument(["certificate_of_authenticity"]) === true);
  ok("ownership doc: government_id does not earn this item", hasOwnershipDocument(["government_id"]) === false);
  ok("ownership doc: 'other' does not earn", hasOwnershipDocument(["other"]) === false);
  ok("flavor: Real Estate -> real_estate", ownershipHintFlavor("Real Estate") === "real_estate");
  ok("flavor: Rental Properties -> real_estate", ownershipHintFlavor("Rental Properties") === "real_estate");
  ok("flavor: Collectibles -> collectables", ownershipHintFlavor("Collectibles") === "collectables");
  ok("flavor: Creator/null -> business", ownershipHintFlavor("Creator") === "business" && ownershipHintFlavor(null) === "business");
  const ownDefault = itemOf(scoreLegitimacy(F({})), "business_license");
  ok("ownership item: stable key, new label, business hint by default",
    ownDefault.label === "License / ownership documents on file" && /business license/.test(ownDefault.hint), ownDefault.hint);
  const ownRE = itemOf(scoreLegitimacy(F({ category: "Real Estate" })), "business_license");
  ok("ownership hint: real-estate coin is pointed at deeds/mortgage",
    /deed, mortgage document/.test(ownRE.hint), ownRE.hint);
  const ownCol = itemOf(scoreLegitimacy(F({ category: "Collectibles" })), "business_license");
  ok("ownership hint: collectable coin is pointed at authenticity/appraisal",
    /certificate of authenticity, appraisal/.test(ownCol.hint), ownCol.hint);
  ok("ownership item earns 12 from the document fact",
    itemOf(scoreLegitimacy(F({ hasOwnershipDocument: true })), "business_license").earned === 12);

  // --- availability: social_connected is the only config-dependent one -
  const noProviders = scoreLegitimacy(EMPTY_LEGITIMACY_FACTS, { socialProviderConfigured: false });
  ok("no social provider configured -> social_connected coming_soon",
    itemOf(noProviders, "social_connected").status === "coming_soon");
  ok("no social provider configured -> bank_linked still available",
    itemOf(noProviders, "bank_linked").status === "available");
  const providersUp = scoreLegitimacy(EMPTY_LEGITIMACY_FACTS, { socialProviderConfigured: true });
  ok("provider configured -> social_connected available",
    itemOf(providersUp, "social_connected").status === "available");
  ok("earned beats coming_soon (connected account, providers later removed)",
    itemOf(scoreLegitimacy(F({ socialConnected: true }), { socialProviderConfigured: false }), "social_connected").status === "earned");

  // --- link verdict policy (pure) --------------------------------------
  ok("verdict: 404 broken", verdictForStatus(404) === "broken");
  ok("verdict: 410 broken", verdictForStatus(410) === "broken");
  ok("verdict: 200 ok", verdictForStatus(200) === "ok");
  ok("verdict: 403 ok (bot wall keeps points)", verdictForStatus(403) === "ok");
  ok("verdict: 500 ok (transient)", verdictForStatus(500) === "ok");
  ok("verdict: DNS failure broken",
    verdictForError(Object.assign(new Error("dns"), { cause: { code: "ENOTFOUND" } })) === "broken");
  ok("verdict: connection refused broken",
    verdictForError(Object.assign(new Error("refused"), { code: "ECONNREFUSED" })) === "broken");
  ok("verdict: timeout ok (inconclusive)",
    verdictForError(Object.assign(new Error("slow"), { name: "TimeoutError" })) === "ok");
  ok("verdict: unknown error ok (inconclusive)", verdictForError(new Error("weird")) === "ok");

  // --- logo flip + broken-link hints ------------------------------------
  ok("logo: unset -> 0", itemOf(scoreLegitimacy(F({})), "logo").earned === 0);
  ok("logo: set and working -> 4", itemOf(scoreLegitimacy(F({ hasLogo: true })), "logo").earned === 4);
  const brokenLogo = itemOf(scoreLegitimacy(F({ hasLogo: true, logoBroken: true })), "logo");
  ok("logo: set but broken -> 0 with the broken-link hint",
    brokenLogo.earned === 0 && brokenLogo.hint === BROKEN_LINK_HINT, brokenLogo.hint);
  const brokenRef = itemOf(scoreLegitimacy(F({ referenceUrl: "https://x.co", websiteUrlBroken: true })), "reference_url");
  ok("reference URL: set but broken -> 0 with the broken-link hint",
    brokenRef.earned === 0 && brokenRef.done === false && brokenRef.hint === BROKEN_LINK_HINT, brokenRef.hint);
  const brokenSocial = itemOf(scoreLegitimacy(F({ socialProfileCount: 0, socialProfilesExist: true })), "social_profile");
  ok("social profile: listed but all broken -> 0 with the broken-link hint",
    brokenSocial.earned === 0 && brokenSocial.hint === BROKEN_LINK_HINT, brokenSocial.hint);

  // --- public (marketplace) view: compact, earned-only -------------------
  const pubFull = publicLegitimacyView(scoreLegitimacy(FULL));
  ok("public view: full facts -> 100 / phase band key",
    pubFull.score === 100 && pubFull.band === "phase", JSON.stringify(pubFull).slice(0, 120));
  ok("public view: earned points sum to the score",
    pubFull.earned.reduce((s, i) => s + i.points, 0) === pubFull.score);
  ok("public view: earned entries are {key,label,points} only — no hints, no bandLabel",
    pubFull.earned.length === 10 &&
    pubFull.earned.every((i) => Object.keys(i).sort().join(",") === "key,label,points") &&
    !("bandLabel" in pubFull) && !("groups" in pubFull),
    JSON.stringify(pubFull).slice(0, 160));
  const pubEmpty = publicLegitimacyView(scoreLegitimacy(EMPTY_LEGITIMACY_FACTS));
  ok("public view: empty facts -> 0 / meme / no earned items",
    pubEmpty.score === 0 && pubEmpty.band === "meme" && pubEmpty.earned.length === 0);
  ok("public view: EMPTY_PUBLIC_LEGITIMACY is the zero view",
    EMPTY_PUBLIC_LEGITIMACY.score === 0 && EMPTY_PUBLIC_LEGITIMACY.band === "meme" &&
    EMPTY_PUBLIC_LEGITIMACY.earned.length === 0);
}

// ---------------------------------------------------------------------------
// 2. Endpoint shape (real routes, in-memory)
// ---------------------------------------------------------------------------

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
mountAgentInterfaceRoutes(deps);
mountLegitimacyRoutes(deps);

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
  console.log("legitimacy endpoints (in-memory)");
  const sequencer = startSequencerLoop();
  // Hermetic link checks: every URL "works" until a flow below says
  // otherwise. Installed BEFORE any draft is written — drafts check
  // their URLs at write time.
  setLinkFetcher(async () => 200);

  let r = await call("POST", "/api/v1/auth/signup",
    { name: "Legit", email: "legit@example.com", password: "test-password-123" });
  ok("signup 201", r.status === 201 && !!r.body.token, JSON.stringify(r.body).slice(0, 140));
  const user = { userId: r.body.userId as string, token: r.body.token as string };

  r = await call("GET", "/api/v1/legitimacy/me");
  ok("/legitimacy/me without token 401", r.status === 401 && r.body.error === "unauthorized");

  r = await call("GET", "/api/v1/legitimacy/me", {}, auth(user.token));
  ok("/legitimacy/me empty user 200", r.status === 200 && Array.isArray(r.body.coins) && r.body.coins.length === 0);
  ok("empty summary shape", r.body.legitimacySummary?.bestScore === 0 &&
    r.body.legitimacySummary?.bestCoinTicker === null &&
    r.body.legitimacySummary?.netWorthGraduated === false && r.body.best === null);

  // Mint a fully-profiled coin through the real flow.
  r = await call("POST", "/api/v1/issuance/draft", {
    name: "Legit Coin", ticker: "LGT", tagline: "Real business, onchain",
    valueThesis: "Revenue share from a real studio.", category: "Creator",
    equityPublic: 50, equityRetained: 50, priceUsd: 2.5, totalShares: 100000,
    websiteUrl: "https://legit.example.com",
    socialProfiles: [{ platform: "youtube", url: "https://youtube.com/@legit" }],
  }, auth(user.token));
  ok("draft 201", r.status === 201 && !!r.body.draftId, JSON.stringify(r.body).slice(0, 140));
  const draftId = r.body.draftId;

  r = await call("POST", "/api/v1/issuance/sign",
    { draftId, legalName: "Legit Legal Name", issuerCategory: "entity", title: "Founder", accepted: true },
    auth(user.token));
  ok("sign 201", r.status === 201 && !!r.body.signatureId, JSON.stringify(r.body).slice(0, 140));

  r = await call("POST", "/api/v1/issuance/mint",
    { draftId, issuerAddress: ph1(), totalShares: 100000 },
    { ...auth(user.token), "idempotency-key": "mint-lgt-1" });
  ok("mint 201", r.status === 201 && !!r.body.coin?.id, JSON.stringify(r.body).slice(0, 200));
  const coinId = r.body.coin?.id;

  // Seed an OAuth connection into the shared social store (the records
  // the /social routes serve) — legitimacy must read the same store.
  await getSocialStore().saveConnection({
    userId: user.userId, provider: "youtube", providerUserId: "yt-1",
    username: "legit", displayName: "Legit", avatarUrl: null, followerCount: 10,
    accessToken: "test-token", refreshToken: null, expiresAt: null, scopes: [],
  });

  r = await call("GET", "/api/v1/legitimacy/me", {}, auth(user.token));
  ok("/legitimacy/me 200 with the coin", r.status === 200 && r.body.coins?.length === 1,
    JSON.stringify(r.body).slice(0, 200));
  const entry = r.body.coins?.[0];
  ok("coin entry identity", entry?.coinId === coinId && entry?.ticker === "LGT");
  const leg = entry?.legitimacy;
  ok("score 51 (20+12+7+6+6)", leg?.score === 51, `score=${leg?.score}`);
  ok("51 -> Established", leg?.band === "established" && leg?.bandLabel === "Established");
  const items = new Map<string, any>(
    (leg?.groups ?? []).flatMap((g: any) => g.items.map((i: any) => [i.key, i] as [string, any]))
  );
  ok("agreement_signed earned 20", items.get("agreement_signed")?.done === true && items.get("agreement_signed")?.earned === 20);
  // The signature declaration exists, but legal identity ALSO needs a
  // government-ID document (Postgres documents store) — 0 here, with
  // the ID hint. Design rule, not a regression.
  ok("legal_identity unearned: signature alone no longer earns (ID document is Pg-backed)",
    items.get("legal_identity")?.done === false && items.get("legal_identity")?.earned === 0);
  ok("legal_identity hint asks for the government ID",
    items.get("legal_identity")?.hint === "Add a government-issued ID to verify your legal name.",
    items.get("legal_identity")?.hint);
  ok("legal_identity status available", items.get("legal_identity")?.status === "available");
  ok("social_connected earned 12 + status earned",
    items.get("social_connected")?.done === true && items.get("social_connected")?.earned === 12 &&
    items.get("social_connected")?.status === "earned");
  ok("reference_url earned 7", items.get("reference_url")?.done === true && items.get("reference_url")?.earned === 7);
  ok("social_profile earned 6", items.get("social_profile")?.done === true && items.get("social_profile")?.earned === 6);
  ok("full_profile earned 6", items.get("full_profile")?.done === true && items.get("full_profile")?.earned === 6);
  ok("business_license unearned (no Pg documents here)", items.get("business_license")?.done === false && items.get("business_license")?.earned === 0);
  ok("business_license labeled License / ownership documents",
    items.get("business_license")?.label === "License / ownership documents on file");
  ok("wallet_funded unearned (no funding ledger here)", items.get("wallet_funded")?.done === false);
  ok("bank_linked unearned (no Pg documents here)", items.get("bank_linked")?.done === false && items.get("bank_linked")?.earned === 0);
  ok("bank_linked available + labeled as documents",
    items.get("bank_linked")?.status === "available" &&
    items.get("bank_linked")?.label === "Bank statement or reports on file");
  ok("logo unearned (none set on this coin) + available",
    items.get("logo")?.done === false && items.get("logo")?.status === "available");
  ok("summary matches coin", r.body.legitimacySummary?.bestScore === 51 &&
    r.body.legitimacySummary?.bestCoinTicker === "LGT" &&
    r.body.legitimacySummary?.netWorthGraduated === false);
  ok("best points at the coin", r.body.best?.coinId === coinId && r.body.best?.legitimacy?.score === 51);

  // The agent dashboard must carry the identical structures.
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(user.token));
  const dashCoin = (r.body.myCoins ?? []).find((c: any) => c.id === coinId);
  ok("dashboard coin carries legitimacy", dashCoin?.legitimacy?.score === 51,
    `score=${dashCoin?.legitimacy?.score}`);
  ok("dashboard legitimacySummary", r.body.legitimacySummary?.bestScore === 51 &&
    r.body.legitimacySummary?.bestCoinTicker === "LGT" &&
    r.body.legitimacySummary?.netWorthGraduated === false);
  ok("dashboard groups match /legitimacy/me",
    JSON.stringify(dashCoin?.legitimacy?.groups) === JSON.stringify(leg?.groups));

  // --- Logo coin: draft logoUrl flows to the coin and earns the 4 -----
  r = await call("POST", "/api/v1/issuance/draft", {
    name: "Logo Coin", ticker: "LGT2", tagline: "Has a logo",
    valueThesis: "Logo thesis.", category: "Creator",
    equityPublic: 50, equityRetained: 50, priceUsd: 1, totalShares: 1000,
    websiteUrl: "https://logo.example.com",
    logoUrl: "https://cdn.example.com/logo.png",
    socialProfiles: [],
  }, auth(user.token));
  ok("logo draft 201", r.status === 201 && !!r.body.draftId, JSON.stringify(r.body).slice(0, 140));
  const logoDraftId = r.body.draftId;
  r = await call("POST", "/api/v1/issuance/sign",
    { draftId: logoDraftId, legalName: "Legit Legal Name", issuerCategory: "entity", title: "Founder", accepted: true },
    auth(user.token));
  ok("logo coin sign 201", r.status === 201, JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", "/api/v1/issuance/mint",
    { draftId: logoDraftId, issuerAddress: ph1(), totalShares: 1000 },
    { ...auth(user.token), "idempotency-key": "mint-lgt2-1" });
  ok("logo coin mint 201, logoUrl carried onto the coin",
    r.status === 201 && r.body.coin?.logoUrl === "https://cdn.example.com/logo.png",
    JSON.stringify(r.body).slice(0, 200));
  r = await call("GET", "/api/v1/legitimacy/me", {}, auth(user.token));
  const logoEntry = (r.body.coins ?? []).find((c: any) => c.ticker === "LGT2");
  const logoItem = itemOf(logoEntry.legitimacy, "logo");
  ok("logo item earned 4 for a working logo URL",
    logoItem.done === true && logoItem.earned === 4 && logoItem.status === "earned");
  ok("logo coin score 49 (20+12+7+6+4)", logoEntry.legitimacy.score === 49,
    `score=${logoEntry.legitimacy.score}`);

  // --- Broken-link coin: a dead reference URL earns nothing -----------
  setLinkFetcher(async (url: string) => (url.includes("dead.example.com") ? 404 : 200));
  r = await call("POST", "/api/v1/issuance/draft", {
    name: "Dead Link Coin", ticker: "DED1", category: "Creator",
    equityPublic: 50, equityRetained: 50, priceUsd: 1, totalShares: 1000,
    websiteUrl: "https://dead.example.com",
    socialProfiles: [],
  }, auth(user.token));
  ok("dead-link draft 201", r.status === 201 && !!r.body.draftId, JSON.stringify(r.body).slice(0, 140));
  const deadDraftId = r.body.draftId;
  r = await call("POST", "/api/v1/issuance/sign",
    { draftId: deadDraftId, legalName: "Legit Legal Name", issuerCategory: "entity", title: "Founder", accepted: true },
    auth(user.token));
  r = await call("POST", "/api/v1/issuance/mint",
    { draftId: deadDraftId, issuerAddress: ph1(), totalShares: 1000 },
    { ...auth(user.token), "idempotency-key": "mint-ded1-1" });
  ok("dead-link coin mint 201", r.status === 201 && !!r.body.coin?.id, JSON.stringify(r.body).slice(0, 160));
  r = await call("GET", "/api/v1/legitimacy/me", {}, auth(user.token));
  const deadEntry = (r.body.coins ?? []).find((c: any) => c.ticker === "DED1");
  const deadRef = itemOf(deadEntry.legitimacy, "reference_url");
  ok("dead reference URL earns 0 with the broken-link hint",
    deadRef.done === false && deadRef.earned === 0 && deadRef.hint === BROKEN_LINK_HINT, deadRef.hint);
  ok("dead-link coin score 32 (20+12 only)", deadEntry.legitimacy.score === 32,
    `score=${deadEntry.legitimacy.score}`);

  // --- Legacy coin: no stored verdict -> checked once, then persisted --
  r = await call("POST", "/api/v1/auth/signup",
    { name: "Legacy", email: "legacy@example.com", password: "test-password-123" });
  ok("legacy user signup 201", r.status === 201 && !!r.body.userId, JSON.stringify(r.body).slice(0, 140));
  const legacyUserId = r.body.userId as string;
  let fetchCount = 0;
  setLinkFetcher(async () => { fetchCount++; return 200; });
  const store = await getIssuanceStore();
  // Direct store writes = a pre-link-check coin: URLs on the records,
  // linkStatus empty (no verdicts anywhere).
  const legacyDraft = await store.createDraft({
    userId: legacyUserId, name: "Legacy Link", ticker: "LEG2", category: "",
    tagline: "", valueThesis: "", equityPublic: 5, equityRetained: 95,
    socialProfiles: [], websiteUrl: "https://legacy.example.com", logoUrl: null,
    priceUsd: 1, totalShares: null, idempotencyKey: null,
  });
  await store.storeCoin({
    draftId: legacyDraft.id, userId: legacyUserId, signatureId: null,
    isMeme: false, name: "Legacy Link", ticker: "LEG2", mintAddress: "ch_legacy2",
    txSignature: "tx-legacy2", supply: "1000", decimals: 6,
    priceUsd: 1, issuerAddress: ph1(), idempotencyKey: "coin-leg2",
    category: null, totalShares: null, retainedShares: null,
    websiteUrl: "https://legacy.example.com", logoUrl: null,
  });
  const first = await legitimacyForUser(legacyUserId);
  const legacyEntry = first.coins.find((c) => c.ticker === "LEG2");
  ok("legacy coin: reference URL earns after the one lazy check",
    !!legacyEntry && itemOf(legacyEntry.legitimacy, "reference_url").done === true);
  ok("lazy check fetched exactly once", fetchCount === 1, `fetches=${fetchCount}`);
  const storedCoin = (await store.listCoinsByUser(legacyUserId)).find((c) => c.ticker === "LEG2");
  ok("verdict persisted on the coin record",
    storedCoin?.linkStatus?.["https://legacy.example.com"]?.verdict === "ok",
    JSON.stringify(storedCoin?.linkStatus));
  await legitimacyForUser(legacyUserId);
  ok("second scored read does not re-fetch", fetchCount === 1, `fetches=${fetchCount}`);
  setLinkFetcher(null);

  clearInterval(sequencer as any);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
