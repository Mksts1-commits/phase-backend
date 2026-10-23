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
 *     the same per-coin structures. Postgres-backed items (business
 *     license documents, funding deposits) earn 0 in this harness —
 *     they are covered by their stores' own suites and live checks.
 *
 * Expected hermetic score for the flow coin:
 *   agreement 20 + legal identity 8 + social connected 12
 *   + reference URL 7 + social profile 6 + full profile 6 = 59.
 */
import * as crypto from "node:crypto";
import { b58encode, startSequencerLoop } from "./sovereign-ledger-core.js";
import { mountAuthRoutes } from "./auth.js";
import { mountIssuanceRoutes } from "./issuance.js";
import { mountAgentInterfaceRoutes } from "./agent-interface.js";
import { mountLegitimacyRoutes } from "./legitimacy.js";
import { getSocialStore } from "./social-auth.js";
import {
  scoreLegitimacy,
  bandForScore,
  summarizeLegitimacy,
  EMPTY_LEGITIMACY_FACTS,
  LEGITIMACY_RUBRIC,
  type LegitimacyFacts,
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
  hasBusinessLicense: true,
  legalIdentityDeclared: true,
  socialConnected: true,
  referenceUrl: "https://example.com",
  socialProfileCount: 2,
  bankLinked: true,
  walletFunded: true,
  tagline: "A tagline",
  valueThesis: "A thesis",
  hasLogo: true,
};

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
      typeof i.hint === "string" && i.hint.length > 0)));

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
    [39, { agreementSigned: true, hasBusinessLicense: true, referenceUrl: "https://x.co" }, "emerging"],
    [40, { agreementSigned: true, hasBusinessLicense: true, legalIdentityDeclared: true }, "established"],
    [64, { agreementSigned: true, bankLinked: true, socialConnected: true, walletFunded: true, referenceUrl: "https://x.co" }, "established"],
    [65, { agreementSigned: true, bankLinked: true, socialConnected: true, walletFunded: true, legalIdentityDeclared: true }, "proven"],
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
  ok("score 59 (20+8+12+7+6+6)", leg?.score === 59, `score=${leg?.score}`);
  ok("59 -> Established", leg?.band === "established" && leg?.bandLabel === "Established");
  const items = new Map<string, any>(
    (leg?.groups ?? []).flatMap((g: any) => g.items.map((i: any) => [i.key, i] as [string, any]))
  );
  ok("agreement_signed earned 20", items.get("agreement_signed")?.done === true && items.get("agreement_signed")?.earned === 20);
  ok("legal_identity earned 8", items.get("legal_identity")?.done === true && items.get("legal_identity")?.earned === 8);
  ok("social_connected earned 12", items.get("social_connected")?.done === true && items.get("social_connected")?.earned === 12);
  ok("reference_url earned 7", items.get("reference_url")?.done === true && items.get("reference_url")?.earned === 7);
  ok("social_profile earned 6", items.get("social_profile")?.done === true && items.get("social_profile")?.earned === 6);
  ok("full_profile earned 6", items.get("full_profile")?.done === true && items.get("full_profile")?.earned === 6);
  ok("business_license unearned (no Pg documents here)", items.get("business_license")?.done === false && items.get("business_license")?.earned === 0);
  ok("wallet_funded unearned (no funding ledger here)", items.get("wallet_funded")?.done === false);
  ok("bank_linked unearned (no source exists)", items.get("bank_linked")?.done === false);
  ok("logo unearned (no field exists)", items.get("logo")?.done === false);
  ok("summary matches coin", r.body.legitimacySummary?.bestScore === 59 &&
    r.body.legitimacySummary?.bestCoinTicker === "LGT" &&
    r.body.legitimacySummary?.netWorthGraduated === false);
  ok("best points at the coin", r.body.best?.coinId === coinId && r.body.best?.legitimacy?.score === 59);

  // The agent dashboard must carry the identical structures.
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(user.token));
  const dashCoin = (r.body.myCoins ?? []).find((c: any) => c.id === coinId);
  ok("dashboard coin carries legitimacy", dashCoin?.legitimacy?.score === 59,
    `score=${dashCoin?.legitimacy?.score}`);
  ok("dashboard legitimacySummary", r.body.legitimacySummary?.bestScore === 59 &&
    r.body.legitimacySummary?.bestCoinTicker === "LGT" &&
    r.body.legitimacySummary?.netWorthGraduated === false);
  ok("dashboard groups match /legitimacy/me",
    JSON.stringify(dashCoin?.legitimacy?.groups) === JSON.stringify(leg?.groups));

  clearInterval(sequencer as any);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
