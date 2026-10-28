/**
 * Phase coin issuance API — sovereign in-house minting.
 *
 * Flow: draft -> (digitally sign issuer agreement | declare meme coin) -> mint.
 * Minting provisions a dedicated sovereign chain per coin via
 * ./sovereign-ledger-core.js (each coin gets its own isolated chain —
 * that is the moat). There is no Solana/mainnet code path.
 *
 * Persistence: Postgres when DATABASE_URL is set, otherwise an in-memory
 * store (dev/test). The store interface is identical in both modes.
 *
 * Mounted from phase-backend.ts: mountIssuanceRoutes({ route, sendJson, HttpError })
 */
import { createHash, randomUUID } from "node:crypto";
import { auditLog } from "./sovereign-ledger-core.js";
import { createChain, LedgerError, getChainBalance, PUBLIC_FLOAT_ADDRESS } from "./sovereign-ledger-core.js";
import { getPool } from "./db.js";
import { resolveBearerUserId } from "./auth.js";
import { resolveBearerAuth } from "./oauth.js";
import { checkRateLimit } from "./rate-limit.js";
import { ensureLinkVerdicts, normalizeLinkStatus, type LinkStatusMap } from "./link-check.js";

// ---------------------------------------------------------------------------
// Canonical issuer agreement text.
// Mirrors workspace/phase-android/public/docs/phase-issuer-agreement.pdf
// ("PHASE ISSUER AGREEMENT — Template") in meaning; placeholders are filled
// from the draft at render time. The sha256 of the RENDERED text is what the
// signature record stores.
// ---------------------------------------------------------------------------

const TEMPLATE_ONLY_NOTICE =
  "NOT LEGAL ADVICE. This document was generated automatically " +
  "from information the Issuer provided. It is not a substitute for independent legal " +
  "advice. Issuer and Phase should have legal counsel review this agreement before " +
  "relying on it for any live offering.";

export interface IssuanceDraftInput {
  userId: string;
  name: string;
  ticker: string;
  category?: string;
  tagline?: string;
  valueThesis?: string;
  equityPublic?: number;
  equityRetained?: number;
  socialProfiles?: Array<{ platform: string; url: string }>;
  websiteUrl?: string;
  /** Logo image URL for the coin (migration 024). Flows to the coin at
   *  mint; also settable afterwards via PATCH /api/v1/coins/:id. Earns
   *  the Legitimacy Score's logo points once set on the coin. */
  logoUrl?: string;
  priceUsd?: number; // issuer's starting price per whole coin, USD
  /** Total shares to mint. Fixed on the draft BEFORE the agreement is
   *  signed, so the agreement prints the real supply and mint must match
   *  it. Optional at draft time — the handler derives it from the default
   *  issuance market cap when omitted. Null only on legacy drafts created
   *  before drafts carried a supply. */
  totalShares?: number | null;
}

export interface IssuanceDraft extends Required<Omit<IssuanceDraftInput, "category" | "tagline" | "valueThesis" | "equityPublic" | "equityRetained" | "socialProfiles" | "websiteUrl" | "logoUrl" | "priceUsd" | "totalShares">> {
  id: string;
  category: string;
  tagline: string;
  valueThesis: string;
  equityPublic: number;
  equityRetained: number;
  socialProfiles: Array<{ platform: string; url: string }>;
  websiteUrl: string | null;
  /** Logo image URL chosen at draft time; copied onto the coin at mint.
   *  Null when the issuer hasn't set one (or on drafts that predate it). */
  logoUrl: string | null;
  /** Link-liveness verdicts for this draft's URLs (website, logo,
   *  social profiles), keyed by URL — see link-check.ts. Written once
   *  at draft creation; carried onto the coin at mint. */
  linkStatus: LinkStatusMap;
  priceUsd: number; // issuer's starting price per whole coin, USD
  /** Supply fixed at draft time (see IssuanceDraftInput). Null on legacy
   *  drafts that predate the field — those keep the old mint-time supply
   *  behavior and the legacy agreement wording. */
  totalShares: number | null;
  status: "draft" | "signed" | "minted";
  createdAt: string;
  updatedAt: string;
  /** Optional client-supplied idempotency key — replays return the original draft. */
  idempotencyKey?: string | null;
}

export interface IssuanceSignature {
  id: string;
  draftId: string;
  userId: string;
  legalName: string;
  agreementHash: string;
  agreementText: string;
  signedAt: string;
  /** "individual" | "entity" — which signature-block category was chosen. */
  issuerCategory: string;
  /** Entity signers only: office/title held. */
  title: string | null;
  /** Optional client-supplied idempotency key — replays return the original signature. */
  idempotencyKey?: string | null;
}

export interface IssuanceCoin {
  id: string;
  draftId: string;
  userId: string;
  signatureId: string | null;
  isMeme: boolean;
  name: string;
  ticker: string;
  mintAddress: string;
  txSignature: string;
  supply: string;
  decimals: number;
  priceUsd: number; // issuer's starting price per whole coin, USD (trade price)
  /** The issuer's sovereign wallet address (ph1...): the coin's retained
   *  allocation and the swap-offer destination live here. Null for coins
   *  minted before this column existed. */
  issuerAddress: string | null;
  /** Coin category from the draft (frozen at mint). Null for older coins. */
  category: string | null;
  /** Total shares minted (frozen at mint). Null for older coins. */
  totalShares: number | null;
  /** Shares retained by the issuer = totalShares * draft.equityRetained / 100. */
  retainedShares: number | null;
  /** Cumulative shares released to the public float after mint via
   *  POST /api/v1/coins/:id/float/increase (migration 028). The
   *  genesis float is totalShares - retainedShares; the live total
   *  float is genesis float + floatReleasedShares. Null for rows
   *  written before migration 028 (treated as 0). */
  floatReleasedShares: number | null;
  /** Issuer's website URL (business/asset listings). Null if not provided. */
  websiteUrl: string | null;
  /** Coin logo image URL (migration 024): copied from the draft at mint,
   *  editable afterwards via PATCH /api/v1/coins/:id. Null if unset. */
  logoUrl: string | null;
  /** Link-liveness verdicts for the coin's URLs (website, logo, social
   *  profiles), keyed by URL — see link-check.ts / migration 025. A
   *  stored verdict is never re-checked on read. */
  linkStatus: LinkStatusMap;
  network: "sovereign";
  idempotencyKey: string;
  createdAt: string;
}

// Default fully-diluted market cap a draft targets when the issuer does
// not pick a supply: the supply is derived as cap / price so a default
// draft at $0.50 carries 200,000 shares and one at $0.25 carries 400,000.
export const DEFAULT_ISSUANCE_MARKET_CAP_USD = 100_000;
export const DEFAULT_TOTAL_SHARES = 200_000;

/** Supply for a draft whose creator did not pick one: the default market
 *  cap divided by the draft's price (whole shares, never below the 1,000
 *  mint minimum). Falls back to DEFAULT_TOTAL_SHARES without a price. */
export function deriveDraftTotalShares(priceUsd: number): number {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return DEFAULT_TOTAL_SHARES;
  return Math.max(1000, Math.round(DEFAULT_ISSUANCE_MARKET_CAP_USD / priceUsd));
}

function fmtShares(n: number): string {
  return n.toLocaleString("en-US");
}

/** Render the agreement for a draft: blanks filled, ready to sign. */
export function renderAgreementText(d: IssuanceDraft): string {
  // §2 prints the draft's real supply once drafts carry one. Legacy drafts
  // (totalShares null — created before the field existed) keep the original
  // template wording byte-for-byte, so agreements already rendered or
  // signed against them keep their exact text and hash.
  const draftTotal = d.totalShares == null ? null : Number(d.totalShares);
  let splitLines: string[];
  if (draftTotal != null && Number.isFinite(draftTotal) && draftTotal > 0) {
    const retainedShares = Math.round((draftTotal * d.equityRetained) / 100);
    const publicShares = draftTotal - retainedShares;
    splitLines = [
      `At genesis, ${fmtShares(draftTotal)} shares of the Coin are minted: ${d.equityPublic}% (${fmtShares(publicShares)} shares) allocated to the public float and`,
      `${d.equityRetained}% (${fmtShares(retainedShares)} shares) retained by Issuer (the "Sovereign Split").`,
    ];
  } else {
    splitLines = [
      `At genesis, 1,000,000 shares of the Coin are minted: ${d.equityPublic}% allocated to the public float and`,
      `${d.equityRetained}% retained by Issuer (the "Sovereign Split").`,
    ];
  }
  return [
    "PHASE ISSUER AGREEMENT",
    "Template — generated by Phase Platforms",
    "",
    `This Issuer Agreement ("Agreement") is made by the undersigned issuer ("Issuer") for the benefit of each`,
    `person who purchases shares of the coin described below (each, a "Purchaser").`,
    "",
    "1. The Coin",
    `Issuer is listing "${d.name}" (${d.ticker}) (the "Coin") on the Phase network. Issuer describes the`,
    `basis of the Coin's value as follows:`,
    `"${d.valueThesis || "—"}" (the "Value Thesis").`,
    "",
    "2. Share Split",
    ...splitLines,
    "",
    "3. Issuer Representations",
    "Issuer represents and warrants to each Purchaser that:",
    " (a) Identity & Authority. Issuer is the person or business named below and has full authority to enter",
    "into this Agreement and to tokenize and offer the described value.",
    "(b) Accuracy. All information Issuer provided about the Coin — including identity, audience,",
    "financial, and business information — is true and complete to Issuer's knowledge, with no material",
    "fact omitted and no misleading statement.",
    "(c) Rights. Tokenizing and offering the described value does not infringe the intellectual-property,",
    "publicity, or other rights of any third party.",
    "(d) Compliance. Issuer will comply with all applicable laws and regulations in connection with the",
    "Coin.",
    "",
    "4. Value Sharing",
    "Issuer intends that any future income, appreciation, royalties, or other economic value generated by the",
    "activity or asset described for this Coin will be reflected in the Coin's share price, in proportion to the",
    "Sovereign Split, for as long as shares remain publicly held.",
    "",
    "5. Purchaser Acknowledgments",
    "Each Purchaser acknowledges that:",
    " (i) no return is guaranteed and the Coin's value may decline, including to zero;",
    "(ii) the Coin trades on an isolated ledger whose price moves independently of any other chain or asset",
    "on the Phase network;",
    "(iii) this is a prototype market and the Coin is a demonstration instrument unless and until offered",
    "under applicable law with appropriate disclosures.",
    "",
    "6. Term",
    "This Agreement remains in effect for as long as any shares of the Coin are publicly held.",
    "",
    "7. Governing Terms",
    "This Agreement incorporates Phase's Onchaining Terms & Consent by reference. In the event of conflict,",
    "this Agreement controls as between Issuer and Purchasers.",
    "",
    "Signatures",
    "Issuer legal name (print): ________________________________________",
    "Signature: ________________________________________",
    "By typing their full name in the Phase app, Issuer signs this Agreement electronically.",
    "Date: ____________________",
    "",
    TEMPLATE_ONLY_NOTICE,
  ].join("\n");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Store: Postgres when DATABASE_URL is set, in-memory fallback otherwise.
// ---------------------------------------------------------------------------

/** One float-increase idempotency record (migration 028). A replay of
 *  the same (coin, Idempotency-Key) returns the original tx_id without
 *  a second transfer. */
export interface FloatIncreaseRequest {
  coinId: string;
  idempotencyKey: string;
  txId: string;
  shares: number;
  createdAt: string;
}

export interface IssuanceStore {
  ensureUser(userId: string, email?: string): Promise<void>;
  createDraft(d: Omit<IssuanceDraft, "id" | "status" | "createdAt" | "updatedAt" | "linkStatus"> & { linkStatus?: LinkStatusMap }): Promise<IssuanceDraft>;
  getDraft(id: string): Promise<IssuanceDraft | null>;
  getDraftByIdempotency(key: string): Promise<IssuanceDraft | null>;
  setDraftStatus(id: string, status: IssuanceDraft["status"]): Promise<void>;
  storeSignature(s: Omit<IssuanceSignature, "id" | "signedAt">): Promise<IssuanceSignature>;
  getSignatureByDraft(draftId: string): Promise<IssuanceSignature | null>;
  getSignatureById(id: string): Promise<IssuanceSignature | null>;
  getSignatureByIdempotency(key: string): Promise<IssuanceSignature | null>;
  getCoinByIdempotency(key: string): Promise<IssuanceCoin | null>;
  getCoinByDraft(draftId: string): Promise<IssuanceCoin | null>;
  getCoinByChainId(chainId: string): Promise<IssuanceCoin | null>;
  storeCoin(c: Omit<IssuanceCoin, "id" | "createdAt" | "network" | "linkStatus"> & { linkStatus?: LinkStatusMap }): Promise<IssuanceCoin>;
  /** Persist the coin's link-verdict map (lazy score-time checks write
   *  their verdicts back so each URL is checked at most once). */
  updateCoinLinkStatus(coinId: string, linkStatus: LinkStatusMap): Promise<void>;
  getCoinById(id: string): Promise<IssuanceCoin | null>;
  /** Add to the coin's cumulative released float (migration 028). */
  addFloatReleased(coinId: string, shares: number): Promise<void>;
  getFloatIncreaseRequest(coinId: string, key: string): Promise<FloatIncreaseRequest | null>;
  recordFloatIncreaseRequest(r: Omit<FloatIncreaseRequest, "createdAt">): Promise<FloatIncreaseRequest>;
  listCoinsByUser(userId: string): Promise<IssuanceCoin[]>;
  /** Every issued coin, newest first — powers the public marketplace directory. */
  listAllCoins(): Promise<IssuanceCoin[]>;
}

class PgIssuanceStore implements IssuanceStore {
  private async q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await getPool().query(text, params as unknown[]);
    return r.rows as T[];
  }

  async ensureUser(userId: string, email?: string): Promise<void> {
    await this.q(
      `INSERT INTO issuance_users(id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = COALESCE(EXCLUDED.email, issuance_users.email)`,
      [userId, email ?? null]
    );
  }

  async createDraft(d: Omit<IssuanceDraft, "id" | "status" | "createdAt" | "updatedAt" | "linkStatus"> & { linkStatus?: LinkStatusMap }): Promise<IssuanceDraft> {
    const id = randomUUID();
    const rows = await this.q<IssuanceDraft>(
      `INSERT INTO issuance_drafts
         (id, user_id, name, ticker, category, tagline, value_thesis, equity_public,
          equity_retained, social_profiles, website_url, logo_url, link_status, price_usd, total_shares, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,'draft',$16)
       RETURNING id, user_id AS "userId", name, ticker, category, tagline,
                 value_thesis AS "valueThesis", equity_public AS "equityPublic",
                 equity_retained AS "equityRetained",
                 social_profiles AS "socialProfiles", website_url AS "websiteUrl",
                 logo_url AS "logoUrl", link_status AS "linkStatus",
                 price_usd AS "priceUsd", total_shares::float8 AS "totalShares",
                 status,
                 created_at AS "createdAt", updated_at AS "updatedAt",
                 idempotency_key AS "idempotencyKey"`,
      [id, d.userId, d.name, d.ticker, d.category, d.tagline, d.valueThesis,
       d.equityPublic, d.equityRetained, JSON.stringify(d.socialProfiles),
       d.websiteUrl ?? null, d.logoUrl ?? null, JSON.stringify(d.linkStatus ?? {}),
       d.priceUsd, d.totalShares ?? null, d.idempotencyKey ?? null]
    );
    return rows[0]!;
  }

  async getDraft(id: string): Promise<IssuanceDraft | null> {
    const rows = await this.q<IssuanceDraft>(
      `SELECT id, user_id AS "userId", name, ticker, category, tagline,
              value_thesis AS "valueThesis", equity_public AS "equityPublic",
              equity_retained AS "equityRetained",
              social_profiles AS "socialProfiles", website_url AS "websiteUrl",
              logo_url AS "logoUrl", link_status AS "linkStatus",
              price_usd AS "priceUsd", total_shares::float8 AS "totalShares",
              status,
              created_at AS "createdAt", updated_at AS "updatedAt",
              idempotency_key AS "idempotencyKey"
       FROM issuance_drafts WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  async getDraftByIdempotency(key: string): Promise<IssuanceDraft | null> {
    const rows = await this.q<IssuanceDraft>(
      `SELECT id, user_id AS "userId", name, ticker, category, tagline,
              value_thesis AS "valueThesis", equity_public AS "equityPublic",
              equity_retained AS "equityRetained",
              social_profiles AS "socialProfiles", website_url AS "websiteUrl",
              logo_url AS "logoUrl", link_status AS "linkStatus",
              price_usd AS "priceUsd", total_shares::float8 AS "totalShares",
              status,
              created_at AS "createdAt", updated_at AS "updatedAt",
              idempotency_key AS "idempotencyKey"
       FROM issuance_drafts WHERE idempotency_key = $1`,
      [key]
    );
    return rows[0] ?? null;
  }

  async setDraftStatus(id: string, status: IssuanceDraft["status"]): Promise<void> {
    await this.q(`UPDATE issuance_drafts SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  }

  async storeSignature(s: Omit<IssuanceSignature, "id" | "signedAt">): Promise<IssuanceSignature> {
    const id = randomUUID();
    const rows = await this.q<IssuanceSignature>(
      `INSERT INTO issuance_signatures
         (id, draft_id, user_id, legal_name, agreement_hash, agreement_text,
          issuer_category, title, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, draft_id AS "draftId", user_id AS "userId",
                 legal_name AS "legalName", agreement_hash AS "agreementHash",
                 agreement_text AS "agreementText", signed_at AS "signedAt",
                 issuer_category AS "issuerCategory", title,
                 idempotency_key AS "idempotencyKey"`,
      [id, s.draftId, s.userId, s.legalName, s.agreementHash, s.agreementText,
       s.issuerCategory ?? "individual", s.title ?? null, s.idempotencyKey ?? null]
    );
    return rows[0]!;
  }

  async getSignatureByDraft(draftId: string): Promise<IssuanceSignature | null> {
    const rows = await this.q<IssuanceSignature>(
      `SELECT id, draft_id AS "draftId", user_id AS "userId",
              legal_name AS "legalName", agreement_hash AS "agreementHash",
              agreement_text AS "agreementText", signed_at AS "signedAt",
              issuer_category AS "issuerCategory", title
       FROM issuance_signatures WHERE draft_id = $1`,
      [draftId]
    );
    return rows[0] ?? null;
  }

  async getSignatureById(id: string): Promise<IssuanceSignature | null> {
    const rows = await this.q<IssuanceSignature>(
      `SELECT id, draft_id AS "draftId", user_id AS "userId",
              legal_name AS "legalName", agreement_hash AS "agreementHash",
              agreement_text AS "agreementText", signed_at AS "signedAt",
              issuer_category AS "issuerCategory", title
       FROM issuance_signatures WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  async getSignatureByIdempotency(key: string): Promise<IssuanceSignature | null> {
    const rows = await this.q<IssuanceSignature>(
      `SELECT id, draft_id AS "draftId", user_id AS "userId",
              legal_name AS "legalName", agreement_hash AS "agreementHash",
              agreement_text AS "agreementText", signed_at AS "signedAt",
              issuer_category AS "issuerCategory", title,
              idempotency_key AS "idempotencyKey"
       FROM issuance_signatures WHERE idempotency_key = $1`,
      [key]
    );
    return rows[0] ?? null;
  }

  async getCoinByIdempotency(key: string): Promise<IssuanceCoin | null> {
    const rows = await this.q<IssuanceCoin>(`SELECT ${COIN_COLS} FROM issuance_coins WHERE idempotency_key = $1`, [key]);
    return rows[0] ?? null;
  }

  async getCoinByDraft(draftId: string): Promise<IssuanceCoin | null> {
    const rows = await this.q<IssuanceCoin>(`SELECT ${COIN_COLS} FROM issuance_coins WHERE draft_id = $1`, [draftId]);
    return rows[0] ?? null;
  }

  async getCoinByChainId(chainId: string): Promise<IssuanceCoin | null> {
    const rows = await this.q<IssuanceCoin>(`SELECT ${COIN_COLS} FROM issuance_coins WHERE mint_address = $1`, [chainId]);
    return rows[0] ?? null;
  }

  async storeCoin(c: Omit<IssuanceCoin, "id" | "createdAt" | "network" | "linkStatus"> & { linkStatus?: LinkStatusMap }): Promise<IssuanceCoin> {
    const id = randomUUID();
    const rows = await this.q<IssuanceCoin>(
      `INSERT INTO issuance_coins
         (id, draft_id, user_id, signature_id, is_meme, name, ticker,
          mint_address, tx_signature, supply, decimals, price_usd, issuer_address,
          category, total_shares, retained_shares, website_url, logo_url, link_status, network, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,'sovereign',$20)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COIN_COLS}`,
      [id, c.draftId, c.userId, c.signatureId, c.isMeme, c.name, c.ticker,
       c.mintAddress, c.txSignature, c.supply, c.decimals, c.priceUsd, c.issuerAddress ?? null,
       c.category ?? null, c.totalShares ?? null, c.retainedShares ?? null, c.websiteUrl ?? null,
       c.logoUrl ?? null, JSON.stringify(c.linkStatus ?? {}), c.idempotencyKey]
    );
    // Lost the race: another request with the same key already stored a coin.
    const existing = await this.getCoinByIdempotency(c.idempotencyKey);
    if (!existing) throw new Error("idempotency conflict without existing coin");
    return existing;
  }

  async updateCoinLinkStatus(coinId: string, linkStatus: LinkStatusMap): Promise<void> {
    await this.q(`UPDATE issuance_coins SET link_status = $1::jsonb WHERE id = $2`,
      [JSON.stringify(linkStatus), coinId]);
  }

  async getCoinById(id: string): Promise<IssuanceCoin | null> {
    const rows = await this.q<IssuanceCoin>(`SELECT ${COIN_COLS} FROM issuance_coins WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async addFloatReleased(coinId: string, shares: number): Promise<void> {
    await this.q(
      `UPDATE issuance_coins SET float_released_shares = float_released_shares + $2 WHERE id = $1`,
      [coinId, shares]
    );
  }

  async getFloatIncreaseRequest(coinId: string, key: string): Promise<FloatIncreaseRequest | null> {
    const rows = await this.q<FloatIncreaseRequest>(
      `SELECT coin_id AS "coinId", idempotency_key AS "idempotencyKey",
              tx_id AS "txId", shares, created_at AS "createdAt"
       FROM float_increase_requests WHERE coin_id = $1 AND idempotency_key = $2`,
      [coinId, key]
    );
    return rows[0] ?? null;
  }

  async recordFloatIncreaseRequest(r: Omit<FloatIncreaseRequest, "createdAt">): Promise<FloatIncreaseRequest> {
    const rows = await this.q<FloatIncreaseRequest>(
      `INSERT INTO float_increase_requests (coin_id, idempotency_key, tx_id, shares)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (coin_id, idempotency_key) DO NOTHING
       RETURNING coin_id AS "coinId", idempotency_key AS "idempotencyKey",
                 tx_id AS "txId", shares, created_at AS "createdAt"`,
      [r.coinId, r.idempotencyKey, r.txId, r.shares]
    );
    if (rows[0]) return rows[0];
    const existing = await this.getFloatIncreaseRequest(r.coinId, r.idempotencyKey);
    if (!existing) throw new Error("float increase request lost after insert conflict");
    return existing;
  }

  async listCoinsByUser(userId: string): Promise<IssuanceCoin[]> {
    return this.q<IssuanceCoin>(
      `SELECT ${COIN_COLS} FROM issuance_coins WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );
  }

  async listAllCoins(): Promise<IssuanceCoin[]> {
    return this.q<IssuanceCoin>(
      `SELECT ${COIN_COLS} FROM issuance_coins ORDER BY created_at DESC`
    );
  }
}

const COIN_COLS = `id, draft_id AS "draftId", user_id AS "userId",
  signature_id AS "signatureId", is_meme AS "isMeme", name, ticker,
  mint_address AS "mintAddress", tx_signature AS "txSignature",
  supply, decimals, price_usd AS "priceUsd", issuer_address AS "issuerAddress",
  category, total_shares AS "totalShares", retained_shares AS "retainedShares",
  float_released_shares AS "floatReleasedShares",
  website_url AS "websiteUrl", logo_url AS "logoUrl", link_status AS "linkStatus",
  network, idempotency_key AS "idempotencyKey",
  created_at AS "createdAt"`;

class MemoryIssuanceStore implements IssuanceStore {
  private users = new Map<string, { email?: string }>();
  private drafts = new Map<string, IssuanceDraft>();
  private draftsByKey = new Map<string, IssuanceDraft>();
  private sigsByDraft = new Map<string, IssuanceSignature>();
  private sigsByKey = new Map<string, IssuanceSignature>();
  private coins = new Map<string, IssuanceCoin>();
  private coinsByKey = new Map<string, IssuanceCoin>();
  private floatRequests = new Map<string, FloatIncreaseRequest>();

  async ensureUser(userId: string, email?: string): Promise<void> {
    if (!this.users.has(userId)) this.users.set(userId, { email });
  }
  async createDraft(d: Omit<IssuanceDraft, "id" | "status" | "createdAt" | "updatedAt" | "linkStatus"> & { linkStatus?: LinkStatusMap }): Promise<IssuanceDraft> {
    const now = new Date().toISOString();
    const draft: IssuanceDraft = { ...d, linkStatus: d.linkStatus ?? {}, id: randomUUID(), status: "draft", createdAt: now, updatedAt: now };
    this.drafts.set(draft.id, draft);
    if (draft.idempotencyKey) this.draftsByKey.set(draft.idempotencyKey, draft);
    return draft;
  }
  async getDraft(id: string): Promise<IssuanceDraft | null> {
    return this.drafts.get(id) ?? null;
  }
  async getDraftByIdempotency(key: string): Promise<IssuanceDraft | null> {
    return this.draftsByKey.get(key) ?? null;
  }
  async setDraftStatus(id: string, status: IssuanceDraft["status"]): Promise<void> {
    const d = this.drafts.get(id);
    if (d) { d.status = status; d.updatedAt = new Date().toISOString(); }
  }
  async storeSignature(s: Omit<IssuanceSignature, "id" | "signedAt">): Promise<IssuanceSignature> {
    const sig: IssuanceSignature = { ...s, id: randomUUID(), signedAt: new Date().toISOString() };
    this.sigsByDraft.set(s.draftId, sig);
    if (sig.idempotencyKey) this.sigsByKey.set(sig.idempotencyKey, sig);
    return sig;
  }
  async getSignatureByDraft(draftId: string): Promise<IssuanceSignature | null> {
    return this.sigsByDraft.get(draftId) ?? null;
  }
  async getSignatureById(id: string): Promise<IssuanceSignature | null> {
    for (const s of this.sigsByDraft.values()) if (s.id === id) return s;
    return null;
  }
  async getSignatureByIdempotency(key: string): Promise<IssuanceSignature | null> {
    return this.sigsByKey.get(key) ?? null;
  }
  async getCoinByIdempotency(key: string): Promise<IssuanceCoin | null> {
    return this.coinsByKey.get(key) ?? null;
  }
  async getCoinByDraft(draftId: string): Promise<IssuanceCoin | null> {
    for (const c of this.coins.values()) if (c.draftId === draftId) return c;
    return null;
  }
  async getCoinByChainId(chainId: string): Promise<IssuanceCoin | null> {
    for (const c of this.coins.values()) if (c.mintAddress === chainId) return c;
    return null;
  }
  async storeCoin(c: Omit<IssuanceCoin, "id" | "createdAt" | "network" | "linkStatus"> & { linkStatus?: LinkStatusMap }): Promise<IssuanceCoin> {
    const existing = this.coinsByKey.get(c.idempotencyKey);
    if (existing) return existing;
    const coin: IssuanceCoin = { ...c, linkStatus: c.linkStatus ?? {}, network: "sovereign", id: randomUUID(), createdAt: new Date().toISOString() };
    this.coins.set(coin.id, coin);
    this.coinsByKey.set(coin.idempotencyKey, coin);
    return coin;
  }
  async updateCoinLinkStatus(coinId: string, linkStatus: LinkStatusMap): Promise<void> {
    const coin = this.coins.get(coinId);
    if (coin) coin.linkStatus = linkStatus;
  }

  async getCoinById(id: string): Promise<IssuanceCoin | null> {
    return this.coins.get(id) ?? null;
  }

  async addFloatReleased(coinId: string, shares: number): Promise<void> {
    const coin = this.coins.get(coinId);
    if (coin) coin.floatReleasedShares = (coin.floatReleasedShares ?? 0) + shares;
  }

  async getFloatIncreaseRequest(coinId: string, key: string): Promise<FloatIncreaseRequest | null> {
    return this.floatRequests.get(`${coinId}:${key}`) ?? null;
  }

  async recordFloatIncreaseRequest(r: Omit<FloatIncreaseRequest, "createdAt">): Promise<FloatIncreaseRequest> {
    const k = `${r.coinId}:${r.idempotencyKey}`;
    const existing = this.floatRequests.get(k);
    if (existing) return existing;
    const row: FloatIncreaseRequest = { ...r, createdAt: new Date().toISOString() };
    this.floatRequests.set(k, row);
    return row;
  }
  async listCoinsByUser(userId: string): Promise<IssuanceCoin[]> {
    return [...this.coins.values()].filter((c) => c.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  async listAllCoins(): Promise<IssuanceCoin[]> {
    return [...this.coins.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

let storeInstance: IssuanceStore | null = null;
let storeMode: "postgres" | "memory" = "memory";

/** Which backing store is active. Useful for /healthz and logs. */
export function issuanceStoreMode(): "postgres" | "memory" {
  void getStore();
  return storeMode;
}

async function pgReachable(): Promise<boolean> {
  try {
    const pool = getPool();
    // Short-lived check: never hang boot on a dead database.
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}

// Resolved once, lazily, on first use (async init guarded by a promise).
let storeInit: Promise<IssuanceStore> | null = null;
function getStoreAsync(): Promise<IssuanceStore> {
  if (!storeInit) {
    storeInit = (async () => {
      if (await pgReachable()) {
        storeMode = "postgres";
        storeInstance = new PgIssuanceStore();
      } else {
        storeMode = "memory";
        console.warn(
          "[issuance] Postgres unreachable — using in-memory store. " +
          "Coins/drafts will NOT survive a restart. Set DATABASE_URL to a live Postgres for durability."
        );
        storeInstance = new MemoryIssuanceStore();
      }
      return storeInstance;
    })();
  }
  return storeInit;
}

function getStore(): IssuanceStore {
  // Synchronous accessor for code paths that already run inside async fns:
  // falls back to memory until the async probe completes, then swaps.
  // In practice every route handler awaits getStoreAsync() via `store()`.
  if (!storeInstance) {
    storeInstance = new MemoryIssuanceStore();
    void getStoreAsync().then((s) => { storeInstance = s; });
  }
  return storeInstance;
}

/** Async store accessor — every route handler must go through this. */
function store(): Promise<IssuanceStore> {
  return getStoreAsync();
}

/** Shared store accessor for sibling modules (marketplace settlement). */
export function getIssuanceStore(): Promise<IssuanceStore> {
  return getStoreAsync();
}

/** Shared float/sold math for GET /api/v1/issuance/coins and the agent
 *  dashboard's coinPosition — one implementation so both stay consistent.
 *
 *  Genesis float = totalShares - retainedShares. Total float adds the
 *  cumulative post-mint releases (floatReleasedShares, migration 028).
 *  Sold = totalFloat - live float-address balance, clamped
 *  [0, totalFloat]. publicFloatUnits is the TOTAL float (genesis +
 *  released), not just the genesis float: after a release it grows, so
 *  sold stays consistent. The old formula (genesis float minus balance)
 *  understated sold to zero-or-negative once released shares sold.
 *
 *  NOTE on async settlement: floatReleasedShares increments when the
 *  increase is QUEUED, but the float balance only moves when the block
 *  confirms (~2s later). In that window sold transiently includes the
 *  pending release; it resolves at confirmation. */
export function coinFloatPosition(c: IssuanceCoin): {
  availableUnits: string | null;
  publicFloatUnits: string | null;
  publicFloatSoldUnits: string | null;
  floatAvailableUnits: string | null;
  floatReleasedUnits: string | null;
  realizationRatio: number | null;
} {
  let availableUnits: string | null = null;
  let floatAvailableUnits: string | null = null;
  let publicFloatUnits: string | null = null;
  let publicFloatSoldUnits: string | null = null;
  let realizationRatio: number | null = null;
  const released = c.floatReleasedShares != null
    ? BigInt(Math.round(Number(c.floatReleasedShares)))
    : 0n;
  const floatReleasedUnits = released.toString();
  try {
    if (c.issuerAddress) {
      // getChainBalance returns whole-coin base units on this ledger.
      availableUnits = BigInt(getChainBalance(c.mintAddress, c.issuerAddress)).toString();
    }
  } catch { /* chain unknown on this node — leave null */ }
  try {
    const total = c.totalShares != null ? BigInt(Math.round(Number(c.totalShares))) : null;
    const retained = c.retainedShares != null ? BigInt(Math.round(Number(c.retainedShares))) : null;
    if (total != null && retained != null && total > 0n) {
      const initialFloat = total - retained;
      const totalFloat = initialFloat + released;
      if (totalFloat > 0n) {
        const floatUnits = BigInt(getChainBalance(c.mintAddress, PUBLIC_FLOAT_ADDRESS));
        floatAvailableUnits = floatUnits.toString();
        let sold = totalFloat - floatUnits;
        if (sold < 0n) sold = 0n;
        if (sold > totalFloat) sold = totalFloat;
        publicFloatUnits = totalFloat.toString();
        publicFloatSoldUnits = sold.toString();
        realizationRatio = Number(sold) / Number(totalFloat);
      }
    }
  } catch { /* leave null */ }
  return { availableUnits, publicFloatUnits, publicFloatSoldUnits, floatAvailableUnits, floatReleasedUnits, realizationRatio };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface IssuanceMountDeps {
  // `any` on res/ctx keeps this module decoupled from phase-backend.ts while
  // remaining assignable from its (res: ServerResponse) => void helpers.
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface IssuanceCtx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

const NETWORK_ENVELOPE = { network: "sovereign" as const, chain: "phase" as const };

function asRecord(body: unknown): Record<string, unknown> {
  return (body !== null && typeof body === "object" && !Array.isArray(body))
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Maximum fully-diluted market cap at issuance (price × total supply, USD).
// Set by Mike on 2026-10-14; lift by changing this constant and redeploying.
const MAX_ISSUANCE_MARKET_CAP_USD = 500_000_000;

function validateTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(t)) {
    throw new IssuanceHttpError(422, "invalid_ticker", "ticker must be 2-10 characters, A-Z and 0-9 only");
  }
  return t;
}

// Local error type so this module works without importing phase-backend.ts.
class IssuanceHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export function mountIssuanceRoutes(deps: IssuanceMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof IssuanceHttpError;

  const fail = (ctx: IssuanceCtx, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...NETWORK_ENVELOPE, error: code, message });
  };

  // The userId for private routes ALWAYS comes from the authenticated Bearer
  // session. A client-supplied userId in the body/query is never trusted: if
  // one is present and disagrees with the session, the request is rejected.
  const requireUserId = async (ctx: IssuanceCtx): Promise<string> => {
    const authed = await resolveBearerUserId(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    const body = asRecord(ctx.body);
    const claimed = str(body.userId) || str(ctx.query.get("userId"));
    if (claimed && claimed !== authed) {
      throw new HttpError(403, "forbidden", "This request is for a different user.");
    }
    return authed;
  };

  /** Scoped variant for issuance writes (draft/sign/mint): session tokens
   *  keep full access; OAuth tokens must carry write:listings. The
   *  claimed-userId guard above is preserved. */
  const requireScopedUserId = async (ctx: IssuanceCtx, scope: string): Promise<string> => {
    const authed = await resolveBearerAuth(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    if (authed.kind === "oauth" && !authed.scopes.includes(scope)) {
      throw new HttpError(403, "insufficient_scope", `This token lacks the ${scope} scope.`);
    }
    const body = asRecord(ctx.body);
    const claimed = str(body.userId) || str(ctx.query.get("userId"));
    if (claimed && claimed !== authed.userId) {
      throw new HttpError(403, "forbidden", "This request is for a different user.");
    }
    return authed.userId;
  };

  /** Optional idempotency key for draft/sign: header or body, null when absent. */
  const idemKeyOf = (ctx: IssuanceCtx, body: Record<string, unknown>): string | null => {
    const header = ctx.req.headers["idempotency-key"] ?? ctx.req.headers["x-idempotency-key"];
    const h = Array.isArray(header) ? header[0] : header;
    const key = (typeof h === "string" && h.trim()) || str(body.idempotencyKey).trim();
    return key || null;
  };

  const idempotencyKey = (ctx: IssuanceCtx): string => {
    const header = ctx.req.headers["idempotency-key"] ?? ctx.req.headers["x-idempotency-key"];
    const h = Array.isArray(header) ? header[0] : header;
    const body = asRecord(ctx.body);
    const key = str(h) || str(body.idempotencyKey);
    if (!key) {
      throw new HttpError(400, "missing_idempotency_key",
        "POST /api/v1/issuance/mint requires an Idempotency-Key header (or idempotencyKey in the body).");
    }
    return key;
  };

  // --- POST /api/v1/issuance/draft ---
  route("POST", "/api/v1/issuance/draft", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = await requireScopedUserId(ctx, "write:listings");
      if (!checkRateLimit(`issuance:draft:${userId}`, 10, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many draft requests — wait a minute and try again.");
      }
      const draftIdemKey = idemKeyOf(ctx, body);
      const s = await store();
      if (draftIdemKey) {
        const replay = await s.getDraftByIdempotency(draftIdemKey);
        if (replay) {
          if (replay.userId !== userId) throw new HttpError(403, "forbidden", "This idempotency key belongs to a different user.");
          sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, draftId: replay.id, status: replay.status, draft: replay, idempotentReplay: true });
          return;
        }
      }
      const name = str(body.name).trim();
      if (name.length < 1 || name.length > 60) {
        throw new HttpError(422, "invalid_name", "name must be 1-60 characters");
      }
      const ticker = validateTicker(str(body.ticker));
      const equityPublic = body.equityPublic === undefined ? 50 : Number(body.equityPublic);
      const equityRetained = body.equityRetained === undefined ? 50 : Number(body.equityRetained);
      if (![equityPublic, equityRetained].every((n) => Number.isInteger(n) && n >= 0 && n <= 100)
          || equityPublic + equityRetained !== 100) {
        throw new HttpError(422, "invalid_split",
          "equityPublic and equityRetained must be whole numbers 0-100 that sum to 100");
      }
      const socialProfiles = Array.isArray(body.socialProfiles)
        ? (body.socialProfiles as Array<{ platform?: string; url?: string }>)
            .filter((s) => s && typeof s.url === "string" && s.url.trim())
            .map((s) => ({ platform: str(s.platform).trim(), url: str(s.url).trim() }))
        : [];
      const priceUsdRaw = body.priceUsd ?? body.price_usd;
      const priceUsd = priceUsdRaw === undefined ? 10 : Number(priceUsdRaw);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 1_000_000_000) {
        throw new HttpError(422, "invalid_price", "priceUsd must be a positive number.");
      }
      // The supply is fixed HERE, on the draft — before the agreement is
      // rendered and signed — so the agreement prints the real number and
      // the mint must honor it. Explicit value wins; otherwise derive it
      // from the default issuance market cap ($100k / price).
      let totalShares: number;
      if (body.totalShares !== undefined) {
        totalShares = Number(body.totalShares);
        if (!Number.isInteger(totalShares) || totalShares < 1000) {
          throw new HttpError(422, "invalid_total_shares", "totalShares must be a whole number >= 1000.");
        }
      } else {
        totalShares = deriveDraftTotalShares(priceUsd);
      }

      const websiteUrl = str(body.websiteUrl ?? body.website_url).trim().slice(0, 500) || null;
      const logoUrl = str(body.logoUrl ?? body.logo_url).trim().slice(0, 500) || null;
      // Link-liveness verdicts are computed ONCE, here at write time,
      // and stored on the draft (link-check.ts). The verdicts travel
      // to the coin at mint; the scorer never re-checks a stored URL.
      const linkStatus = await ensureLinkVerdicts(
        [websiteUrl, logoUrl, ...socialProfiles.map((p) => p.url)],
        null
      );

      await s.ensureUser(userId, str(body.email) || undefined);
      const draft = await s.createDraft({
        userId,
        name,
        ticker,
        category: str(body.category).trim(),
        tagline: str(body.tagline).trim().slice(0, 280),
        valueThesis: str(body.valueThesis ?? body.value_thesis).trim().slice(0, 2000),
        equityPublic,
        equityRetained,
        socialProfiles,
        websiteUrl,
        logoUrl,
        linkStatus,
        priceUsd,
        totalShares,
        idempotencyKey: draftIdemKey,
      });
      await auditLog(userId, "issuance_draft_created", "issuance_draft", draft.id,
        { ticker: draft.ticker, name: draft.name });
      sendJson(ctx.res, 201, { ...NETWORK_ENVELOPE, draftId: draft.id, status: draft.status, draft });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/issuance/agreement?draftId= ---
  route("GET", "/api/v1/issuance/agreement", async (ctx) => {
    try {
      const draftId = str(ctx.query.get("draftId"));
      if (!draftId) throw new HttpError(400, "missing_draft_id", "Query parameter draftId is required.");
      const _st = await store();
      const draft = await _st.getDraft(draftId);
      if (!draft) throw new HttpError(404, "draft_not_found", "No draft with that id.");
      const agreementText = renderAgreementText(draft);
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        draftId,
        agreementText,
        agreementHash: sha256Hex(agreementText),
        templateNote: TEMPLATE_ONLY_NOTICE,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/issuance/sign ---
  route("POST", "/api/v1/issuance/sign", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = await requireScopedUserId(ctx, "write:listings");
      if (!checkRateLimit(`issuance:sign:${userId}`, 10, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many sign requests — wait a minute and try again.");
      }
      const draftId = str(body.draftId);
      if (!draftId) throw new HttpError(400, "missing_draft_id", "Body must include draftId.");
      const signIdemKey = idemKeyOf(ctx, body);
      const s = await store();
      if (signIdemKey) {
        const replaySig = await s.getSignatureByIdempotency(signIdemKey);
        if (replaySig) {
          if (replaySig.userId !== userId) throw new HttpError(403, "forbidden", "This idempotency key belongs to a different user.");
          sendJson(ctx.res, 200, {
            ...NETWORK_ENVELOPE,
            signatureId: replaySig.id,
            draftId: replaySig.draftId,
            legalName: replaySig.legalName,
            agreementHash: replaySig.agreementHash,
            signedAt: replaySig.signedAt,
            issuerCategory: replaySig.issuerCategory,
            title: replaySig.title,
            idempotentReplay: true,
          });
          return;
        }
      }
      const legalName = str(body.legalName).trim();
      if (legalName.length < 2) {
        throw new HttpError(422, "invalid_legal_name", "legalName is required: type your full legal name to sign.");
      }
      if (body.accepted !== true) {
        throw new HttpError(422, "not_accepted", "accepted must be true: you must accept the agreement to sign it.");
      }
      const issuerCategory = str(body.issuerCategory).trim().toLowerCase() || "individual";
      if (issuerCategory !== "individual" && issuerCategory !== "entity") {
        throw new HttpError(422, "invalid_issuer_category", "issuerCategory must be 'individual' or 'entity'.");
      }
      const title = str(body.title).trim().slice(0, 120) || null;
      const draft = await s.getDraft(draftId);
      if (!draft) throw new HttpError(404, "draft_not_found", "No draft with that id.");
      if (draft.userId !== userId) throw new HttpError(403, "forbidden", "This draft belongs to a different user.");
      if (await s.getCoinByDraft(draftId)) {
        throw new HttpError(409, "already_minted", "This draft has already been minted.");
      }
      const agreementText = renderAgreementText(draft);
      const sig = await s.storeSignature({
        draftId,
        userId,
        legalName,
        agreementHash: sha256Hex(agreementText),
        agreementText,
        issuerCategory,
        title,
        idempotencyKey: signIdemKey,
      });
      await s.setDraftStatus(draftId, "signed");
      await auditLog(userId, "issuance_agreement_signed", "issuance_signature", sig.id,
        { draftId, agreementHash: sig.agreementHash });
      sendJson(ctx.res, 201, {
        ...NETWORK_ENVELOPE,
        signatureId: sig.id,
        draftId,
        legalName: sig.legalName,
        agreementHash: sig.agreementHash,
        signedAt: sig.signedAt,
        issuerCategory: sig.issuerCategory,
        title: sig.title,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/issuance/mint ---
  route("POST", "/api/v1/issuance/mint", async (ctx) => {
    try {
      const body = asRecord(ctx.body);
      const userId = await requireScopedUserId(ctx, "write:listings");
      if (!checkRateLimit(`issuance:mint:${userId}`, 10, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many mint requests — wait a minute and try again.");
      }
      const draftId = str(body.draftId);
      if (!draftId) throw new HttpError(400, "missing_draft_id", "Body must include draftId.");
      const isMeme = body.meme === true;
      const key = idempotencyKey(ctx);

      const s = await store();

      // Idempotent replay: same key -> original coin, no second mint.
      const replay = await s.getCoinByIdempotency(key);
      if (replay) {
        sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, idempotentReplay: true, coin: replay });
        return;
      }

      const draft = await s.getDraft(draftId);
      if (!draft) throw new HttpError(404, "draft_not_found", "No draft with that id.");
      if (draft.userId !== userId) throw new HttpError(403, "forbidden", "This draft belongs to a different user.");
      if (await s.getCoinByDraft(draftId)) {
        throw new HttpError(409, "already_minted", "This draft has already been minted.");
      }

      let signatureId: string | null = null;
      let agreementHash: string | undefined;
      if (!isMeme) {
        const sig = await s.getSignatureByDraft(draftId);
        if (!sig) {
          throw new HttpError(422, "signature_required",
            "This draft has no signed issuer agreement. Sign it first (POST /api/v1/issuance/sign), or mint as a meme coin with {\"meme\": true}.");
        }
        signatureId = sig.id;
        agreementHash = sig.agreementHash;
      }

      // Provision a dedicated sovereign chain for this coin in-house.
      // Each coin gets its own isolated chain — that is the moat.
      // Throws LedgerError on invalid input -> mapped to 4xx by fail().
      const issuerAddress = str(body.issuerAddress);
      if (!issuerAddress) {
        throw new HttpError(400, "missing_issuer_address",
          "Body must include issuerAddress: your Phase sovereign wallet address (ph1...).");
      }
      const totalSharesRaw = body.totalShares;
      let totalShares: number;
      const draftShares = draft.totalShares == null ? null : Number(draft.totalShares);
      if (draftShares != null && Number.isInteger(draftShares) && draftShares >= 1000) {
        // The supply was fixed on the draft before the agreement was
        // signed — the mint MUST use it. A different body value means the
        // caller is trying to mint something other than what was signed.
        if (totalSharesRaw !== undefined && Number(totalSharesRaw) !== draftShares) {
          throw new HttpError(422, "supply_mismatch",
            `totalShares (${Number(totalSharesRaw)}) does not match the supply fixed in the signed agreement (${draftShares}). ` +
            "The supply is set on the draft before signing; create a new draft to change it.");
        }
        totalShares = draftShares;
      } else {
        // Legacy draft (created before drafts carried a supply): the mint
        // body chooses the supply, exactly as before.
        totalShares = totalSharesRaw === undefined ? 100000 : Number(totalSharesRaw);
        if (!Number.isInteger(totalShares) || totalShares < 1000) {
          throw new HttpError(422, "invalid_total_shares", "totalShares must be a whole number >= 1000.");
        }
      }
      // Market-cap gate: price × supply may not exceed $500M at issuance.
      const marketCapUsd = draft.priceUsd * totalShares;
      if (marketCapUsd > MAX_ISSUANCE_MARKET_CAP_USD) {
        throw new HttpError(422, "market_cap_exceeded",
          `Market cap at issuance ($${marketCapUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}) exceeds the $500M limit. Lower the price or the supply.`);
      }
      const chain = await createChain({
        coin_name: draft.name,
        ticker: draft.ticker,
        total_supply: String(totalShares),
        decimals: 6,
        equity_public_pct: draft.equityPublic,
        issuer_address: issuerAddress,
        is_meme: isMeme,
        issuance_draft_id: draftId,
        issuance_signature_id: signatureId,
        covenant_hash: agreementHash,
      });

      // The coin inherits the draft's link verdicts; any URL without
      // one (legacy drafts) is checked now, once, at mint.
      const coinLinkStatus = await ensureLinkVerdicts(
        [draft.websiteUrl, draft.logoUrl, ...(draft.socialProfiles ?? []).map((p) => p.url)],
        normalizeLinkStatus(draft.linkStatus)
      );

      const coin = await s.storeCoin({
        draftId,
        userId,
        signatureId,
        isMeme,
        name: draft.name,
        ticker: draft.ticker,
        mintAddress: chain.chain_id,
        txSignature: chain.genesis_hash,
        supply: String(totalShares),
        decimals: 6,
        priceUsd: draft.priceUsd,
        issuerAddress,
        category: draft.category || null,
        totalShares,
        retainedShares: Math.round((totalShares * draft.equityRetained) / 100),
        floatReleasedShares: 0,
        websiteUrl: draft.websiteUrl || null,
        logoUrl: draft.logoUrl || null,
        linkStatus: coinLinkStatus,
        idempotencyKey: key,
      });
      await s.setDraftStatus(draftId, "minted");
      await auditLog(userId, "issuance_coin_minted", "issuance_coin", coin.id,
        { draftId, ticker: coin.ticker, chainId: coin.mintAddress, supply: coin.supply });

      sendJson(ctx.res, 201, {
        ...NETWORK_ENVELOPE,
        idempotentReplay: false,
        coin,
        chainId: chain.chain_id,
        genesisHash: chain.genesis_hash,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/issuance/coins?userId= ---
  route("GET", "/api/v1/issuance/coins", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const _st2 = await store();
      const coins = await _st2.listCoinsByUser(userId);
      // Enrich with live position data the Dashboard needs (shared
      // coinFloatPosition helper — same math as the agent dashboard):
      //  - availableUnits: the issuer's current on-chain balance of this coin
      //    (their real, spendable stake — replaces any local guess).
      //  - floatAvailableUnits: the public float address's LIVE balance.
      //  - floatReleasedUnits: cumulative post-mint float increases.
      //  - realization: how much of the public float has actually been
      //    purchased, so the app can show a "soft" (listing-price) net worth
      //    separately from market-backed demand.
      const enriched = coins.map((c) => ({ ...c, ...coinFloatPosition(c) }));
      sendJson(ctx.res, 200, { ...NETWORK_ENVELOPE, userId, coins: enriched });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/issuance/coins/:id ---
  route("GET", "/api/v1/issuance/coins/:id", async (ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const _st2 = await store();
      const coins = await _st2.listCoinsByUser(userId);
      const coin = coins.find((c) => c.id === ctx.params.id || c.mintAddress === ctx.params.id);
      if (!coin) throw new HttpError(404, "coin_not_found", "No coin with that id or chain id for this user.");
      sendJson(ctx.res, 200, {
        ...NETWORK_ENVELOPE,
        coin,
        chainId: coin.mintAddress,
      });
    } catch (err) { fail(ctx, err); }
  });
}
