/**
 * legitimacy.ts — the Phase Legitimacy Score.
 *
 * A 0–100 rating per issued coin, computed SERVER-SIDE from real records
 * only: the signed Issuer Agreement, the signature's legal identity, a
 * business-license document on file, OAuth social connections, the coin's
 * reference URL and listed social profiles, a confirmed funding deposit,
 * and a complete coin profile. The client can never claim points — this
 * module reads the same stores the rest of the backend writes, and any
 * item without a backing record earns 0.
 *
 * Bands: 0–14 Meme Territory · 15–39 Emerging · 40–64 Established ·
 * 65–79 Proven · 80–100 Phase Territory. At 80+ the issuer's best coin
 * "graduates": the dashboard's SOFT NET WORTH becomes NET WORTH
 * (legitimacySummary.netWorthGraduated).
 *
 * Two items have NO backing record anywhere in the backend today and
 * therefore always earn 0 until the product grows them:
 *   - bank_linked: no bank-linkage records exist server-side (Plaid was
 *     never integrated; the manual step lives outside this backend).
 *   - logo: coins have no logo/image field in any store.
 * They stay on the checklist so issuers see the full road to 100.
 *
 * Wiring:
 *   - GET /api/v1/agent/dashboard (agent-interface.ts) embeds
 *     `legitimacy` on each myCoins entry + a top-level
 *     `legitimacySummary`, via computeLegitimacyForCoins() below.
 *   - GET /api/v1/legitimacy/me (mounted here) serves the same
 *     structures to the signed-in web app on its Bearer session.
 * Same scorer, same gatherer — one code path.
 *
 * Test-mode throughout, like the rest of the backend.
 */
import { getPool } from "./db.js";
import { resolveBearerUserId } from "./auth.js";
import {
  getIssuanceStore,
  type IssuanceCoin,
  type IssuanceDraft,
  type IssuanceSignature,
} from "./issuance.js";
import { listSocialConnections } from "./social-auth.js";
import { checkRateLimit } from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Rubric (pure) — the single source of truth for keys, points, bands.
// ---------------------------------------------------------------------------

export type LegitimacyGroupKey = "legal" | "presence" | "financial" | "product";
export type LegitimacyBandKey = "meme" | "emerging" | "established" | "proven" | "phase";

export interface LegitimacyFacts {
  agreementSigned: boolean;
  hasBusinessLicense: boolean;
  legalIdentityDeclared: boolean;
  socialConnected: boolean;
  referenceUrl: string | null;
  socialProfileCount: number;
  bankLinked: boolean;
  walletFunded: boolean;
  tagline: string | null;
  valueThesis: string | null;
  hasLogo: boolean;
}

export const EMPTY_LEGITIMACY_FACTS: LegitimacyFacts = {
  agreementSigned: false,
  hasBusinessLicense: false,
  legalIdentityDeclared: false,
  socialConnected: false,
  referenceUrl: null,
  socialProfileCount: 0,
  bankLinked: false,
  walletFunded: false,
  tagline: null,
  valueThesis: null,
  hasLogo: false,
};

interface RubricItem {
  key: string;
  group: LegitimacyGroupKey;
  label: string;
  points: number;
  hint: string;
  earned: (f: LegitimacyFacts) => boolean;
}

const GROUP_LABELS: Record<LegitimacyGroupKey, string> = {
  legal: "Legal",
  presence: "Presence",
  financial: "Financial",
  product: "Product",
};
const GROUP_ORDER: LegitimacyGroupKey[] = ["legal", "presence", "financial", "product"];

const nonEmpty = (s: string | null | undefined): boolean =>
  typeof s === "string" && s.trim().length > 0;

export const LEGITIMACY_RUBRIC: RubricItem[] = [
  {
    key: "agreement_signed", group: "legal", points: 20,
    label: "Issuer Agreement signed",
    hint: "Sign the Issuer Agreement for this coin.",
    earned: (f) => f.agreementSigned,
  },
  {
    key: "business_license", group: "legal", points: 12,
    label: "Business license on file",
    hint: "Upload your business license or registration in the coin's Documentation & Compliance section (document type: business license).",
    earned: (f) => f.hasBusinessLicense,
  },
  {
    key: "legal_identity", group: "legal", points: 8,
    label: "Legal identity declared",
    hint: "Sign with your legal name and declare your issuer type (individual or entity).",
    earned: (f) => f.legalIdentityDeclared,
  },
  {
    key: "social_connected", group: "presence", points: 12,
    label: "Social account connected",
    hint: "Connect TikTok, YouTube, or Instagram to your Phase account.",
    earned: (f) => f.socialConnected,
  },
  {
    key: "reference_url", group: "presence", points: 7,
    label: "Reference URL added",
    hint: "Add your website or a reference link to the coin profile.",
    earned: (f) => nonEmpty(f.referenceUrl),
  },
  {
    key: "social_profile", group: "presence", points: 6,
    label: "Social profile linked",
    hint: "List at least one social profile link on the coin.",
    earned: (f) => f.socialProfileCount > 0,
  },
  {
    key: "bank_linked", group: "financial", points: 15,
    label: "Bank account linked",
    hint: "Link a bank account to your Phase profile (bank linking is not available yet).",
    earned: (f) => f.bankLinked,
  },
  {
    key: "wallet_funded", group: "financial", points: 10,
    label: "Wallet funded",
    hint: "Make a real deposit (USDC, USDT, or card) so your account is funded.",
    earned: (f) => f.walletFunded,
  },
  {
    key: "full_profile", group: "product", points: 6,
    label: "Complete coin profile",
    hint: "Add both a tagline and a value thesis to the coin.",
    earned: (f) => nonEmpty(f.tagline) && nonEmpty(f.valueThesis),
  },
  {
    key: "logo", group: "product", points: 4,
    label: "Coin logo set",
    hint: "Set a logo image for your coin (coin logos are not supported yet).",
    earned: (f) => f.hasLogo,
  },
];

export function bandForScore(score: number): { band: LegitimacyBandKey; bandLabel: string } {
  if (score >= 80) return { band: "phase", bandLabel: "Phase Territory" };
  if (score >= 65) return { band: "proven", bandLabel: "Proven" };
  if (score >= 40) return { band: "established", bandLabel: "Established" };
  if (score >= 15) return { band: "emerging", bandLabel: "Emerging" };
  return { band: "meme", bandLabel: "Meme Territory" };
}

export interface LegitimacyItemView {
  key: string;
  label: string;
  points: number;
  earned: number;
  done: boolean;
  hint: string;
}
export interface LegitimacyGroupView {
  key: LegitimacyGroupKey;
  label: string;
  items: LegitimacyItemView[];
}
export interface LegitimacyScore {
  score: number;
  band: LegitimacyBandKey;
  bandLabel: string;
  groups: LegitimacyGroupView[];
}

/** Pure scorer: facts in, display-ready score out. Deterministic. */
export function scoreLegitimacy(facts: LegitimacyFacts): LegitimacyScore {
  let score = 0;
  const byGroup = new Map<LegitimacyGroupKey, LegitimacyItemView[]>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);
  for (const item of LEGITIMACY_RUBRIC) {
    const done = item.earned(facts);
    const earned = done ? item.points : 0;
    score += earned;
    byGroup.get(item.group)!.push({
      key: item.key,
      label: item.label,
      points: item.points,
      earned,
      done,
      hint: item.hint,
    });
  }
  const { band, bandLabel } = bandForScore(score);
  return {
    score,
    band,
    bandLabel,
    groups: GROUP_ORDER.map((g) => ({ key: g, label: GROUP_LABELS[g], items: byGroup.get(g)! })),
  };
}

export interface LegitimacySummary {
  bestScore: number;
  bestCoinTicker: string | null;
  netWorthGraduated: boolean;
}

export function summarizeLegitimacy(
  entries: Array<{ ticker: string; legitimacy: LegitimacyScore }>
): LegitimacySummary {
  let bestScore = 0;
  let bestCoinTicker: string | null = null;
  for (const e of entries) {
    if (e.legitimacy.score > bestScore) {
      bestScore = e.legitimacy.score;
      bestCoinTicker = e.ticker;
    }
  }
  return { bestScore, bestCoinTicker, netWorthGraduated: bestScore >= 80 };
}

// ---------------------------------------------------------------------------
// Gatherer — facts from real records. User-level facts are read once and
// shared across the user's coins; every source degrades to "not earned"
// when its store is unavailable (e.g. no Postgres in hermetic tests), so
// the score never invents points.
// ---------------------------------------------------------------------------

interface UserFacts {
  socialConnected: boolean;
  walletFunded: boolean;
}

async function gatherUserFacts(userId: string): Promise<UserFacts> {
  let socialConnected = false;
  try {
    socialConnected = (await listSocialConnections(userId)).length > 0;
  } catch { /* social store unavailable — not earned */ }

  let walletFunded = false;
  try {
    // The funding ledger's crediting rule (crypto-funding + stripe-funding):
    // a deposit counts once status='confirmed' AND verified=true. The
    // signup bonus never writes ledger_entries, so it cannot earn this.
    const r = await getPool().query(
      `SELECT 1 FROM ledger_entries
        WHERE user_id = $1 AND kind IN ('deposit', 'fiat_deposit')
          AND status = 'confirmed' AND verified = true
        LIMIT 1`,
      [userId]
    );
    walletFunded = r.rows.length > 0;
  } catch { /* no funding ledger reachable — not earned */ }

  return { socialConnected, walletFunded };
}

async function coinHasBusinessLicense(coinId: string): Promise<boolean> {
  try {
    const r = await getPool().query(
      `SELECT 1 FROM coin_documents WHERE coin_id = $1 AND doc_type = 'business_license' LIMIT 1`,
      [coinId]
    );
    return r.rows.length > 0;
  } catch { /* documents store unavailable — not earned */ return false; }
}

function draftSocialProfiles(draft: IssuanceDraft | null): Array<{ platform: string; url: string }> {
  if (!draft?.socialProfiles) return [];
  const raw: unknown = draft.socialProfiles;
  const arr = Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw as string); } catch { return []; } })();
  return Array.isArray(arr) ? arr : [];
}

export async function factsForCoin(
  coin: IssuanceCoin,
  userFacts: UserFacts
): Promise<LegitimacyFacts> {
  const issuance = await getIssuanceStore();

  let signature: IssuanceSignature | null = null;
  if (coin.signatureId) {
    signature = await issuance.getSignatureById(coin.signatureId).catch(() => null);
  }
  if (!signature && coin.draftId) {
    signature = await issuance.getSignatureByDraft(coin.draftId).catch(() => null);
  }

  let draft: IssuanceDraft | null = null;
  if (coin.draftId) {
    draft = await issuance.getDraft(coin.draftId).catch(() => null);
  }

  const profiles = draftSocialProfiles(draft);
  const legalIdentityDeclared =
    !!signature &&
    nonEmpty(signature.legalName) &&
    (signature.issuerCategory === "individual" || signature.issuerCategory === "entity");

  return {
    agreementSigned: !!signature,
    hasBusinessLicense: await coinHasBusinessLicense(coin.id),
    legalIdentityDeclared,
    socialConnected: userFacts.socialConnected,
    referenceUrl: coin.websiteUrl ?? draft?.websiteUrl ?? null,
    socialProfileCount: profiles.length,
    // No bank-linkage records exist server-side — never earnable today.
    bankLinked: false,
    walletFunded: userFacts.walletFunded,
    tagline: draft?.tagline ?? null,
    valueThesis: draft?.valueThesis ?? null,
    // Coins have no logo field in any store — never earnable today.
    hasLogo: false,
  };
}

/** Score every coin in the list; returns a map keyed by coin id. */
export async function computeLegitimacyForCoins(
  userId: string,
  coins: IssuanceCoin[]
): Promise<Map<string, LegitimacyScore>> {
  const out = new Map<string, LegitimacyScore>();
  if (coins.length === 0) return out;
  const userFacts = await gatherUserFacts(userId);
  for (const coin of coins) {
    const facts = await factsForCoin(coin, userFacts);
    out.set(coin.id, scoreLegitimacy(facts));
  }
  return out;
}

export interface UserLegitimacy {
  coins: Array<{
    coinId: string;
    ticker: string;
    name: string;
    legitimacy: LegitimacyScore;
  }>;
  summary: LegitimacySummary;
  best: { coinId: string; ticker: string; legitimacy: LegitimacyScore } | null;
}

/** The one code path behind both the agent dashboard and /legitimacy/me. */
export async function legitimacyForUser(userId: string): Promise<UserLegitimacy> {
  const issuance = await getIssuanceStore();
  const coins = await issuance.listCoinsByUser(userId);
  const scores = await computeLegitimacyForCoins(userId, coins);
  const entries = coins.map((c) => ({
    coinId: c.id,
    ticker: c.ticker,
    name: c.name,
    legitimacy: scores.get(c.id) ?? scoreLegitimacy(EMPTY_LEGITIMACY_FACTS),
  }));
  const summary = summarizeLegitimacy(entries);
  const bestEntry = entries.find((e) => e.ticker === summary.bestCoinTicker) ?? null;
  return {
    coins: entries,
    summary,
    best: bestEntry
      ? { coinId: bestEntry.coinId, ticker: bestEntry.ticker, legitimacy: bestEntry.legitimacy }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Route: GET /api/v1/legitimacy/me — the web app's view (Bearer session).
// ---------------------------------------------------------------------------

export interface LegitimacyMountDeps {
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

export function mountLegitimacyRoutes(deps: LegitimacyMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError;

  const fail = (ctx: Ctx, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...ENVELOPE, error: code, message });
  };

  route("GET", "/api/v1/legitimacy/me", async (ctx: Ctx) => {
    try {
      const authed = await resolveBearerUserId(ctx.req.headers);
      if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
      if (!checkRateLimit(`legitimacy-me:${authed}`, 60, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      const { coins, summary, best } = await legitimacyForUser(authed);
      sendJson(ctx.res, 200, {
        ...ENVELOPE,
        view: "legitimacy",
        userId: authed,
        coins,
        legitimacySummary: summary,
        best,
      });
    } catch (err) { fail(ctx, err); }
  });
}
