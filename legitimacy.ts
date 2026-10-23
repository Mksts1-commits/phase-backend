/**
 * legitimacy.ts — the Phase Legitimacy Score.
 *
 * A 0–100 rating per issued coin, computed SERVER-SIDE from real records
 * only: the signed Issuer Agreement, the signature's legal identity, a
 * license/registration or ownership document on file (license for a
 * business, deed/mortgage for real estate, authenticity/appraisal for
 * collectables), OAuth social connections, the coin's
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
 * The bank item is DOCUMENTARY, not a live bank connection (Mikyas's
 * clarification, 2026-10-23): it is earned when a bank statement or
 * financial report is on file for the coin — the same coin_documents
 * store (and the same gather pattern) as the business license, keyed
 * on the document's type. The logo item reads the coin's real logoUrl
 * field (migration 024). Every rubric item is earnable from records
 * that exist today.
 *
 * Legal identity takes two records: the signed declaration (legal
 * name + issuer type on the signature) AND a government-issued ID
 * document on file for the coin — a declaration nobody verified is
 * only half the proof.
 *
 * URL-fed items (reference URL, social profiles, logo) are earned
 * only by links that actually work (link-check.ts): verdicts are
 * stored on the coin at write time, or computed once, lazily, on the
 * first scored read for legacy coins and persisted. A broken link
 * leaves the item unearned with its own hint.
 *
 * Each item view also carries a `status`: "earned" when done,
 * "coming_soon" when the platform can't accept the proof yet, else
 * "available". Today the only coming-soon case is social_connected
 * while NO social OAuth provider is configured — issuers shouldn't be
 * sent on homework the platform can't take.
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
import { listSocialConnections, anySocialProviderConfigured } from "./social-auth.js";
import { ensureLinkVerdicts, normalizeLinkStatus } from "./link-check.js";
import { checkRateLimit } from "./rate-limit.js";

// ---------------------------------------------------------------------------
// Rubric (pure) — the single source of truth for keys, points, bands.
// ---------------------------------------------------------------------------

export type LegitimacyGroupKey = "legal" | "presence" | "financial" | "product";
export type LegitimacyBandKey = "meme" | "emerging" | "established" | "proven" | "phase";

export interface LegitimacyFacts {
  agreementSigned: boolean;
  /** A license/registration or ownership document is on file for
   *  the coin — business license or registration for businesses; a
   *  deed, mortgage document, property-tax record or lease for real
   *  estate and rentals; a certificate of authenticity, appraisal or
   *  provenance record for collectables (OWNERSHIP_DOCUMENT_TYPES). */
  hasOwnershipDocument: boolean;
  /** The coin's category. Steers the license/ownership item's HINT
   *  only — earning accepts every qualifying document type for every
   *  coin, whatever the category says. */
  category: string | null;
  /** Signed declaration: legal name + issuer type on the signature. */
  legalIdentityDeclared: boolean;
  /** A government-issued ID document is on file for the coin. */
  hasGovernmentId: boolean;
  socialConnected: boolean;
  referenceUrl: string | null;
  /** The reference URL is set AND its stored verdict says broken. */
  websiteUrlBroken: boolean;
  /** Count of listed social profiles whose link is NOT broken. */
  socialProfileCount: number;
  /** At least one social profile is listed (working or not). */
  socialProfilesExist: boolean;
  /** Documentary bank proof: a bank_statement or financial_report
   *  document is on file for the coin (NOT a live bank connection). */
  bankLinked: boolean;
  walletFunded: boolean;
  tagline: string | null;
  valueThesis: string | null;
  hasLogo: boolean;
  /** The logo URL is set AND its stored verdict says broken. */
  logoBroken: boolean;
}

export const EMPTY_LEGITIMACY_FACTS: LegitimacyFacts = {
  agreementSigned: false,
  hasOwnershipDocument: false,
  category: null,
  legalIdentityDeclared: false,
  hasGovernmentId: false,
  socialConnected: false,
  referenceUrl: null,
  websiteUrlBroken: false,
  socialProfileCount: 0,
  socialProfilesExist: false,
  bankLinked: false,
  walletFunded: false,
  tagline: null,
  valueThesis: null,
  hasLogo: false,
  logoBroken: false,
};

/** Platform context the scorer needs for honest availability: whether
 *  a capability is switched on at all. Not user data — deployment state. */
export interface LegitimacyContext {
  /** At least one social OAuth provider has credentials configured. */
  socialProviderConfigured: boolean;
}

const DEFAULT_LEGITIMACY_CONTEXT: LegitimacyContext = {
  socialProviderConfigured: true,
};

/** Shown instead of the "not added yet" hint when a link exists but
 *  its verdict is broken — a dead link earns nothing. */
export const BROKEN_LINK_HINT = "Your link isn't working — update it to earn these points.";

interface RubricItem {
  key: string;
  group: LegitimacyGroupKey;
  label: string;
  points: number;
  hint: string;
  /** Fact-dependent hint (e.g. a link exists but is broken; a legal
   *  declaration exists but the ID document is missing). Falls back
   *  to the static `hint` when absent. */
  hintFor?: (f: LegitimacyFacts) => string;
  earned: (f: LegitimacyFacts) => boolean;
  /** When this returns true the item cannot be earned right now no
   *  matter what the issuer does — it renders as "coming soon" rather
   *  than as homework. Only for platform-side gaps. */
  comingSoon?: (ctx: LegitimacyContext) => boolean;
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
    // Key stays "business_license" (payloads and the app reference
    // it); the item is asset-aware: ANY qualifying registration or
    // ownership document earns it, and the hint follows the coin's
    // category — deed/mortgage for real estate and rentals,
    // authenticity/appraisal/provenance for collectables, license or
    // registration otherwise.
    key: "business_license", group: "legal", points: 12,
    label: "License / ownership documents on file",
    hint: "Upload your business license or registration in the coin's Documentation & Compliance section (document type: business license).",
    hintFor: (f) => {
      switch (ownershipHintFlavor(f.category)) {
        case "real_estate":
          return "Upload your deed, mortgage document, or related ownership record in the coin's Documentation & Compliance section.";
        case "collectables":
          return "Upload a certificate of authenticity, appraisal, or provenance record in the coin's Documentation & Compliance section.";
        default:
          return "Upload your business license or registration in the coin's Documentation & Compliance section (document type: business license).";
      }
    },
    earned: (f) => f.hasOwnershipDocument,
  },
  {
    key: "legal_identity", group: "legal", points: 8,
    label: "Legal identity declared",
    hint: "Sign with your legal name and declare your issuer type (individual or entity).",
    // The declaration alone is half the proof: a government-issued ID
    // document on file for the coin verifies the name that was signed.
    hintFor: (f) => f.legalIdentityDeclared
      ? "Add a government-issued ID to verify your legal name."
      : "Sign with your legal name and declare your issuer type (individual or entity).",
    earned: (f) => f.legalIdentityDeclared && f.hasGovernmentId,
  },
  {
    key: "social_connected", group: "presence", points: 12,
    label: "Social account connected",
    hint: "Connect TikTok, YouTube, or Instagram to your Phase account.",
    earned: (f) => f.socialConnected,
    comingSoon: (ctx) => !ctx.socialProviderConfigured,
  },
  {
    key: "reference_url", group: "presence", points: 7,
    label: "Reference URL added",
    hint: "Add your website or a reference link to the coin profile.",
    hintFor: (f) => f.websiteUrlBroken
      ? BROKEN_LINK_HINT
      : "Add your website or a reference link to the coin profile.",
    earned: (f) => nonEmpty(f.referenceUrl) && !f.websiteUrlBroken,
  },
  {
    key: "social_profile", group: "presence", points: 6,
    label: "Social profile linked",
    hint: "List at least one social profile link on the coin.",
    hintFor: (f) => f.socialProfileCount === 0 && f.socialProfilesExist
      ? BROKEN_LINK_HINT
      : "List at least one social profile link on the coin.",
    earned: (f) => f.socialProfileCount > 0,
  },
  {
    // Key stays "bank_linked" (payloads and the app reference it); the
    // item is documentary — a bank statement or financial report on
    // file for the coin, NOT a live bank connection.
    key: "bank_linked", group: "financial", points: 15,
    label: "Bank statement or reports on file",
    hint: "Upload a bank statement or financial report in the coin's Documentation & Compliance section (document type: bank statement or financial report).",
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
    hint: "Set a logo image URL for your coin — on the draft before minting, or in the coin profile afterwards.",
    hintFor: (f) => f.logoBroken
      ? BROKEN_LINK_HINT
      : "Set a logo image URL for your coin — on the draft before minting, or in the coin profile afterwards.",
    earned: (f) => f.hasLogo && !f.logoBroken,
  },
];

export function bandForScore(score: number): { band: LegitimacyBandKey; bandLabel: string } {
  if (score >= 80) return { band: "phase", bandLabel: "Phase Territory" };
  if (score >= 65) return { band: "proven", bandLabel: "Proven" };
  if (score >= 40) return { band: "established", bandLabel: "Established" };
  if (score >= 15) return { band: "emerging", bandLabel: "Emerging" };
  return { band: "meme", bandLabel: "Meme Territory" };
}

/** Per-item availability, so a UI can tell "you haven't done this"
 *  (available) from "the platform can't take this yet" (coming_soon):
 *  - "earned": the record exists; points are in the score.
 *  - "available": earnable today; the issuer just hasn't done it.
 *  - "coming_soon": not earnable today for platform reasons. */
export type LegitimacyItemStatus = "earned" | "available" | "coming_soon";

export interface LegitimacyItemView {
  key: string;
  label: string;
  points: number;
  earned: number;
  done: boolean;
  status: LegitimacyItemStatus;
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

/** Pure scorer: facts in, display-ready score out. Deterministic.
 *  The optional context only drives each item's availability `status`;
 *  it never changes points. */
export function scoreLegitimacy(
  facts: LegitimacyFacts,
  context: LegitimacyContext = DEFAULT_LEGITIMACY_CONTEXT
): LegitimacyScore {
  let score = 0;
  const byGroup = new Map<LegitimacyGroupKey, LegitimacyItemView[]>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);
  for (const item of LEGITIMACY_RUBRIC) {
    const done = item.earned(facts);
    const earned = done ? item.points : 0;
    score += earned;
    const status: LegitimacyItemStatus = done
      ? "earned"
      : item.comingSoon?.(context)
        ? "coming_soon"
        : "available";
    byGroup.get(item.group)!.push({
      key: item.key,
      label: item.label,
      points: item.points,
      earned,
      done,
      status,
      hint: item.hintFor ? item.hintFor(facts) : item.hint,
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
  socialProviderConfigured: boolean;
}

async function gatherUserFacts(userId: string): Promise<UserFacts> {
  let socialConnected = false;
  try {
    socialConnected = (await listSocialConnections(userId)).length > 0;
  } catch { /* social store unavailable — not earned */ }

  // Deployment state, not user data: is ANY social OAuth provider
  // configured? Drives social_connected's availability status only.
  let socialProviderConfigured = false;
  try {
    socialProviderConfigured = anySocialProviderConfigured();
  } catch { /* treat as unconfigured — the item shows coming soon */ }

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

  return { socialConnected, walletFunded, socialProviderConfigured };
}

/** Document types that earn the license/ownership item
 *  (coin-edit.ts DOC_TYPES): registration or ownership proof for any
 *  asset class — business, real estate/rental, collectables. ANY of
 *  them earns the item for ANY coin; the coin's category only steers
 *  the hint, never blocks earning. */
export const OWNERSHIP_DOCUMENT_TYPES = [
  "business_license", "business_registration",
  "deed", "mortgage_document", "property_tax", "lease_agreement",
  "certificate_of_authenticity", "appraisal", "provenance_record",
] as const;

/** Pure predicate over a coin's document types: any qualifying
 *  license/registration or ownership document on file earns the
 *  license/ownership item. */
export function hasOwnershipDocument(docTypes: readonly string[]): boolean {
  return docTypes.some((t) => (OWNERSHIP_DOCUMENT_TYPES as readonly string[]).includes(t));
}

/** Which document menu a coin's category points at. Category is free
 *  text on the draft/coin ("Real Estate", "smallBusiness",
 *  "Collectibles", …), so this is a keyword read, not an enum —
 *  anything unrecognized falls back to the business menu. */
export function ownershipHintFlavor(
  category: string | null | undefined
): "real_estate" | "collectables" | "business" {
  const c = (category ?? "").toLowerCase();
  if (/real[\s_-]?estate|realty|propert|rental|housing|land|mortgage/.test(c)) return "real_estate";
  if (/collect|antique|memorabilia|rare|wine|artwork|fine[\s_-]?art/.test(c)) return "collectables";
  return "business";
}

/** Document types that earn the bank item (coin-edit.ts DOC_TYPES). */
export const BANK_DOCUMENT_TYPES = ["bank_statement", "financial_report"] as const;

/** Pure predicate over a coin's document types: a bank statement or a
 *  financial report on file earns the bank item. */
export function hasBankDocument(docTypes: readonly string[]): boolean {
  return docTypes.some((t) => (BANK_DOCUMENT_TYPES as readonly string[]).includes(t));
}

/** The distinct document types on file for a coin (coin_documents —
 *  the Documentation & Compliance store). Empty when the store is
 *  unavailable, so document items degrade to "not earned". */
async function coinDocumentTypes(coinId: string): Promise<string[]> {
  try {
    const r = await getPool().query(
      `SELECT DISTINCT doc_type AS "docType" FROM coin_documents WHERE coin_id = $1`,
      [coinId]
    );
    return r.rows.map((row: { docType: unknown }) => String(row.docType));
  } catch { /* documents store unavailable — not earned */ return []; }
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

  const docTypes = await coinDocumentTypes(coin.id);

  // Link verdicts live on the coin (written at draft/PATCH/mint time).
  // A legacy coin can carry URLs with no verdict yet — check those
  // once, here, and persist the merged map, so no URL is re-checked
  // on later reads.
  const websiteUrl = coin.websiteUrl ?? draft?.websiteUrl ?? null;
  const profileUrls = profiles.map((p) => p.url);
  const storedVerdicts = normalizeLinkStatus(coin.linkStatus);
  const verdicts = await ensureLinkVerdicts(
    [websiteUrl, coin.logoUrl, ...profileUrls],
    storedVerdicts
  );
  if (Object.keys(verdicts).length !== Object.keys(storedVerdicts).length) {
    await issuance.updateCoinLinkStatus(coin.id, verdicts).catch(() => {});
  }
  const isBroken = (url: string | null): boolean =>
    !!url && verdicts[url]?.verdict === "broken";

  return {
    agreementSigned: !!signature,
    hasOwnershipDocument: hasOwnershipDocument(docTypes),
    category: coin.category ?? draft?.category ?? null,
    legalIdentityDeclared,
    hasGovernmentId: docTypes.includes("government_id"),
    socialConnected: userFacts.socialConnected,
    referenceUrl: websiteUrl,
    websiteUrlBroken: isBroken(websiteUrl),
    // Only profiles whose link works count toward the item.
    socialProfileCount: profiles.filter((p) => !isBroken(p.url)).length,
    socialProfilesExist: profiles.length > 0,
    // Documentary, not a live link: a bank statement or financial
    // report document on file for the coin earns this (same store and
    // pattern as the business license, above).
    bankLinked: hasBankDocument(docTypes),
    walletFunded: userFacts.walletFunded,
    tagline: draft?.tagline ?? null,
    valueThesis: draft?.valueThesis ?? null,
    // The coin's real logo field (migration 024): set on the draft and
    // carried to the coin at mint, or later via PATCH logoUrl.
    hasLogo: nonEmpty(coin.logoUrl),
    logoBroken: isBroken(coin.logoUrl),
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
  const context: LegitimacyContext = {
    socialProviderConfigured: userFacts.socialProviderConfigured,
  };
  for (const coin of coins) {
    const facts = await factsForCoin(coin, userFacts);
    out.set(coin.id, scoreLegitimacy(facts, context));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public (marketplace) view — compact and earned-only. The marketplace
// shows every coin's Phase Cred to everyone: the score, the band key,
// and the proof items actually earned. It never exposes the unearned
// items or their hints (those are the owner's climb checklist —
// dashboard-only), and it never carries the legacy bandLabel string:
// consumers derive display labels from the numeric score / band key.
// ---------------------------------------------------------------------------

export interface PublicLegitimacy {
  score: number;
  band: LegitimacyBandKey;
  earned: Array<{ key: string; label: string; points: number }>;
}

export function publicLegitimacyView(s: LegitimacyScore): PublicLegitimacy {
  const earned: PublicLegitimacy["earned"] = [];
  for (const g of s.groups) {
    for (const it of g.items) {
      if (it.done) earned.push({ key: it.key, label: it.label, points: it.points });
    }
  }
  return { score: s.score, band: s.band, earned };
}

export const EMPTY_PUBLIC_LEGITIMACY: PublicLegitimacy = publicLegitimacyView(
  scoreLegitimacy(EMPTY_LEGITIMACY_FACTS)
);

/** Score a mixed-issuer coin list (the marketplace directory): group by
 *  issuer so each issuer's user-level facts are gathered once, then run
 *  the same scorer the dashboard uses. Keyed by coin id. */
export async function computeLegitimacyForCoinsByIssuer(
  coins: IssuanceCoin[]
): Promise<Map<string, LegitimacyScore>> {
  const out = new Map<string, LegitimacyScore>();
  const byUser = new Map<string, IssuanceCoin[]>();
  for (const c of coins) {
    const arr = byUser.get(c.userId);
    if (arr) arr.push(c);
    else byUser.set(c.userId, [c]);
  }
  for (const [userId, userCoins] of byUser) {
    const scores = await computeLegitimacyForCoins(userId, userCoins);
    for (const [id, s] of scores) out.set(id, s);
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
