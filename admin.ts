/**
 * admin.ts — secure administrative API for the Phase fee & treasury system.
 *
 * Every endpoint requires an admin session:
 *   - Authorization: Bearer <token> belonging to a user with
 *     issuance_users.is_admin = TRUE, or whose email is listed in
 *     PHASE_ADMIN_EMAILS (comma-separated, case-insensitive).
 * Ordinary users get 403. Every administrative action is audit-logged.
 *
 * Exception — the coin factory routes (POST/GET /api/v1/admin/coins and
 * DELETE /api/v1/admin/coins/:id) also accept the batch key header
 * X-Admin-Key (env PHASE_ADMIN_API_KEY). Key-issued coins are owned by
 * the account named in env PHASE_ADMIN_ISSUER_EMAIL. The key reaches
 * nothing else: fees, treasury and user administration stay session-only.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { resolveBearerUserId } from "./auth.js";
import { checkRateLimit as sharedCheckRateLimit, clientIpFromHeaders } from "./rate-limit.js";
import { auditLog, createChain, LedgerError, store as ledgerStore } from "./sovereign-ledger-core.js";
import { dbQuery, dbQueryOne } from "./db.js";
import { getIssuanceStore, cleanGoogleRating } from "./issuance.js";
import { ensureLinkVerdicts, normalizeLinkStatus } from "./link-check.js";
import {
  getFeeConfig,
  setFeeConfig,
  isAdminUser,
  getTreasuryAccountId,
  getTreasuryBalances,
  ensureTreasuryAccount,
  requestWithdrawal,
  listWithdrawals,
  getWithdrawal,
  approveWithdrawal,
  executeWithdrawal,
  runFeeReconciliation,
  latestReconciliation,
  runProductionChecks,
  fromMicroUnits,
  toMicroUnits,
  type FeeRecord,
} from "./fee.js";

export interface AdminMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => Promise<void>) => void;
  sendJson: (res: any, status: number, body: unknown) => void;
  HttpError: new (status: number, code: string, message: string) => Error;
}

class AdminHttpError extends Error {
  statusCode: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

interface AdminCtx {
  req: { headers: Record<string, string | string[] | undefined>; url?: string };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export function mountAdminRoutes(deps: AdminMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof AdminHttpError;

  const fail = (ctx: AdminCtx, err: unknown): void => {
    if (err instanceof AdminHttpError || err instanceof HttpError) {
      const e = err as AdminHttpError;
      sendJson(ctx.res, (e as { statusCode?: number }).statusCode ?? 500,
        { error: (e as { code?: string }).code ?? "error", message: e.message });
      return;
    }
    console.error("[admin]", err);
    sendJson(ctx.res, 500, { error: "internal", message: "Internal error." });
  };

  const asRecord = (body: unknown): Record<string, unknown> =>
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const clientIp = (ctx: AdminCtx): string => clientIpFromHeaders(ctx.req.headers);

  /** Admin gate: authenticated session + admin privilege. Returns admin userId. */
  const requireAdmin = async (ctx: AdminCtx): Promise<string> => {
    const userId = await resolveBearerUserId(ctx.req.headers);
    if (!userId) throw new HttpError(401, "unauthorized", "Admin sign-in required.");
    if (!(await isAdminUser(userId))) {
      await auditLog(userId, "admin_access_denied", "admin", undefined, {
        path: ctx.req.url,
      });
      throw new HttpError(403, "forbidden", "Administrator privileges required.");
    }
    return userId;
  };

  const rateLimitAdmin = (ctx: AdminCtx): void => {
    if (!sharedCheckRateLimit(`admin:${clientIp(ctx)}`, 120, 60_000)) {
      throw new HttpError(429, "rate_limited", "Too many admin requests — wait a minute.");
    }
  };

  // --- Coin factory gate (create / list / delete below) ---
  // These routes accept EITHER an admin session (requireAdmin above) OR
  // the batch key in the X-Admin-Key header (env PHASE_ADMIN_API_KEY,
  // timing-safe compared). The key reaches ONLY the coin factory routes:
  // fees, treasury and user administration stay session-only. With the
  // key there is no signup or login — the coins are issued to the
  // existing account named by env PHASE_ADMIN_ISSUER_EMAIL, so that
  // account owns them (dashboard, edits, claims) from the start.
  const adminKeyMatches = (ctx: AdminCtx): boolean => {
    const expected = process.env.PHASE_ADMIN_API_KEY;
    if (!expected) return false;
    const raw = ctx.req.headers["x-admin-key"];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) return false;
    const a = createHash("sha256").update(provided).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  };

  const resolveIssuerUserId = async (): Promise<string> => {
    const email = (process.env.PHASE_ADMIN_ISSUER_EMAIL || "").trim();
    if (!email) {
      throw new HttpError(503, "admin_not_configured", "PHASE_ADMIN_ISSUER_EMAIL is not set.");
    }
    const row = await dbQueryOne(
      `SELECT id FROM issuance_users WHERE lower(email) = lower($1)`,
      [email]
    );
    if (!row) {
      throw new HttpError(503, "admin_issuer_not_found", `No Phase account exists for ${email}.`);
    }
    return row.id as string;
  };

  /** Returns the acting userId and how the caller authenticated. For key
   *  calls the acting id IS the issuer account (it owns what it makes). */
  const requireCoinFactoryAdmin = async (
    ctx: AdminCtx
  ): Promise<{ userId: string; via: string }> => {
    if (adminKeyMatches(ctx)) {
      return { userId: await resolveIssuerUserId(), via: "api_key" };
    }
    return { userId: await requireAdmin(ctx), via: "session" };
  };

  // --- GET /api/v1/admin/me — is the current user an admin? ---
  // Lets the app decide whether to show the admin dashboard. Returns 200
  // with { isAdmin: false } for non-admins (never 403) so the client can
  // probe without triggering access-denied audits.
  route("GET", "/api/v1/admin/me", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const userId = await resolveBearerUserId(ctx.req.headers);
      if (!userId) throw new HttpError(401, "unauthorized", "Sign-in required.");
      sendJson(ctx.res, 200, { userId, isAdmin: await isAdminUser(userId) });
    } catch (err) { fail(ctx, err); }
  });

  // --- DELETE /api/v1/admin/coins/:id — remove a coin (admin) ---
  // Deletes the coin, its sovereign chain (cascades blocks/balances), draft,
  // signature, and documents. Refuses coins with trading activity. Admin-only.

  // --- POST /api/v1/admin/coins — coin factory: create + mint in one call ---
  // Mints an UNSIGNED coin (the issuance meme path: no agreement signature)
  // for directory / placeholder listings — e.g. pre-opening a coin for each
  // business in an outreach directory. The real coin is the one the business
  // later signs and mints itself; these stay visibly unsigned (is_meme,
  // no_agreement) until claimed. Same validation, chain provisioning and
  // storage as POST /api/v1/issuance/draft + /mint, fused into one call.
  // Auth: admin session, or X-Admin-Key (see the coin factory gate above).
  // Session admins may name another owner via issuerEmail; key calls always
  // issue to the PHASE_ADMIN_ISSUER_EMAIL account.
  route("POST", "/api/v1/admin/coins", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const { userId: actingId, via } = await requireCoinFactoryAdmin(ctx);
      const body = asRecord(ctx.body);

      let ownerId = actingId;
      if (via === "session" && typeof body.issuerEmail === "string" && body.issuerEmail.trim()) {
        const row = await dbQueryOne(
          `SELECT id FROM issuance_users WHERE lower(email) = lower($1)`,
          [body.issuerEmail.trim()]
        );
        if (!row) {
          throw new HttpError(422, "issuer_not_found", `No Phase account exists for ${body.issuerEmail}.`);
        }
        ownerId = row.id as string;
      }

      // Validation mirrors the issuance draft + mint rules.
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 1 || name.length > 60) {
        throw new HttpError(422, "invalid_name", "name must be 1-60 characters");
      }
      const ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
      if (!/^[A-Z0-9]{2,10}$/.test(ticker)) {
        throw new HttpError(422, "invalid_ticker", "ticker must be 2-10 characters, A-Z and 0-9 only");
      }
      const equityPublic = body.equityPublic === undefined ? 5 : Number(body.equityPublic);
      const equityRetained = body.equityRetained === undefined ? 95 : Number(body.equityRetained);
      if (![equityPublic, equityRetained].every((n) => Number.isInteger(n) && n >= 0 && n <= 100)
          || equityPublic + equityRetained !== 100) {
        throw new HttpError(422, "invalid_split",
          "equityPublic and equityRetained must be whole numbers 0-100 that sum to 100");
      }
      const priceUsd = body.priceUsd === undefined ? 0.5 : Number(body.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 1_000_000_000) {
        throw new HttpError(422, "invalid_price", "priceUsd must be a positive number.");
      }
      const totalShares = Number(body.totalShares);
      if (!Number.isInteger(totalShares) || totalShares < 1000) {
        throw new HttpError(422, "invalid_total_shares", "totalShares must be a whole number >= 1000.");
      }
      // Same ceiling as issuance.ts MAX_ISSUANCE_MARKET_CAP_USD.
      if (priceUsd * totalShares > 500_000_000) {
        throw new HttpError(422, "market_cap_exceeded",
          "Market cap at issuance exceeds the $500M limit. Lower the price or the supply.");
      }
      const issuerAddress = typeof body.issuerAddress === "string" ? body.issuerAddress.trim() : "";
      if (!issuerAddress) {
        throw new HttpError(400, "missing_issuer_address",
          "Body must include issuerAddress: the Phase sovereign wallet address (ph1...) that holds the retained stake.");
      }
      const category = typeof body.category === "string" ? body.category.trim() : "";
      const tagline = typeof body.tagline === "string" ? body.tagline.trim().slice(0, 280) : "";
      const valueThesis = typeof body.valueThesis === "string" ? body.valueThesis.trim().slice(0, 2000) : "";
      const websiteUrl = typeof body.websiteUrl === "string" ? body.websiteUrl.trim().slice(0, 500) || null : null;
      const socialProfiles = Array.isArray(body.socialProfiles)
        ? (body.socialProfiles as Array<{ platform?: string; url?: string }>)
            .filter((s) => s && typeof s.url === "string" && s.url.trim())
            .map((s) => ({ platform: typeof s.platform === "string" ? s.platform.trim() : "", url: s.url.trim() }))
        : [];
      const googleRating = cleanGoogleRating((body as Record<string, unknown>).googleRating);

      const idemRaw = ctx.req.headers["idempotency-key"] ?? ctx.req.headers["x-idempotency-key"];
      const idemHeader = Array.isArray(idemRaw) ? idemRaw[0] : idemRaw;
      const idemKey = (typeof idemHeader === "string" && idemHeader.trim())
        || (typeof body.idempotencyKey === "string" && body.idempotencyKey.trim())
        || `admin-${randomUUID()}`;

      const s = await getIssuanceStore();

      // Idempotent replay: same key -> original coin, no second mint.
      const replay = await s.getCoinByIdempotency(idemKey);
      if (replay) {
        sendJson(ctx.res, 200, {
          idempotentReplay: true, coin: replay,
          chainId: replay.mintAddress, genesisHash: replay.txSignature,
        });
        return;
      }

      const dupe = await dbQueryOne(`SELECT id FROM issuance_coins WHERE ticker = $1`, [ticker]);
      if (dupe) {
        throw new HttpError(409, "ticker_taken", `Ticker ${ticker} is already in use.`);
      }

      await s.ensureUser(ownerId);
      const linkStatus = await ensureLinkVerdicts(
        [websiteUrl, null, ...socialProfiles.map((p) => p.url)],
        null
      );
      const draft = await s.createDraft({
        userId: ownerId,
        name,
        ticker,
        category,
        tagline,
        valueThesis,
        equityPublic,
        equityRetained,
        socialProfiles,
        websiteUrl,
        logoUrl: null,
        googleRating,
        linkStatus,
        priceUsd,
        totalShares,
        idempotencyKey: `admin-draft:${idemKey}`,
      });

      let chain: { chain_id: string; genesis_hash: string };
      try {
        chain = await createChain({
          coin_name: name,
          ticker,
          total_supply: String(totalShares),
          decimals: 6,
          equity_public_pct: equityPublic,
          issuer_address: issuerAddress,
          is_meme: true,
          issuance_draft_id: draft.id,
          issuance_signature_id: null,
          covenant_hash: undefined,
        });
      } catch (e) {
        if (e instanceof LedgerError) throw new HttpError(e.status ?? 422, e.code ?? "chain_error", e.message);
        throw e;
      }

      const coinLinkStatus = await ensureLinkVerdicts(
        [websiteUrl, null, ...socialProfiles.map((p) => p.url)],
        normalizeLinkStatus(draft.linkStatus)
      );
      const coin = await s.storeCoin({
        draftId: draft.id,
        userId: ownerId,
        signatureId: null,
        isMeme: true,
        name,
        ticker,
        mintAddress: chain.chain_id,
        txSignature: chain.genesis_hash,
        supply: String(totalShares),
        decimals: 6,
        priceUsd,
        issuerAddress,
        category: category || null,
        totalShares,
        retainedShares: Math.round((totalShares * equityRetained) / 100),
        floatReleasedShares: 0,
        websiteUrl,
        logoUrl: null,
        linkStatus: coinLinkStatus,
        idempotencyKey: idemKey,
      });
      await s.setDraftStatus(draft.id, "minted");
      await auditLog(actingId, "admin_coin_created", "issuance_coin", coin.id,
        { ticker, chainId: chain.chain_id, ownerId, via, unsigned: true });

      sendJson(ctx.res, 201, {
        idempotentReplay: false, coin, chainId: chain.chain_id, genesisHash: chain.genesis_hash,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/coins — the factory account's coins ---
  route("GET", "/api/v1/admin/coins", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const { userId } = await requireCoinFactoryAdmin(ctx);
      const s = await getIssuanceStore();
      const coins = await s.listCoinsByUser(userId);
      sendJson(ctx.res, 200, { coins });
    } catch (err) { fail(ctx, err); }
  });

  // --- PATCH /api/v1/admin/coins/:id — admin override for coin metadata ---
  // Updates tagline, websiteUrl, socialProfiles, googleRating. For support
  // interventions. Gate: admin session OR the coin-factory key (same gate
  // as the factory create/delete), so batch directory coins can be
  // enriched with their public socials + Google rating by the operator.
  route("PATCH", "/api/v1/admin/coins/:id", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const { userId: adminId } = await requireCoinFactoryAdmin(ctx);
      const coinId = ctx.params.id;
      const body = asRecord(ctx.body);
      const coin = await dbQueryOne(
        `SELECT id, draft_id AS "draftId", link_status AS "linkStatus" FROM issuance_coins WHERE id = $1`,
        [coinId]
      );
      if (!coin) throw new HttpError(404, "coin_not_found", "No coin with that id.");
      const out: Record<string, unknown> = {};
      if (coin.draftId && ("socialProfiles" in body || "tagline" in body || "googleRating" in body)) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if ("socialProfiles" in body) {
          const raw = body.socialProfiles;
          if (!Array.isArray(raw)) throw new HttpError(422, "invalid_social", "socialProfiles must be an array.");
          params.push(JSON.stringify(raw));
          sets.push(`social_profiles = $${params.length}`);
          out.socialProfiles = raw;
        }
        if ("tagline" in body) {
          params.push(String(body.tagline || "").slice(0, 140) || null);
          sets.push(`tagline = $${params.length}`);
          out.tagline = body.tagline;
        }
        if ("googleRating" in body) {
          const gr = cleanGoogleRating(body.googleRating);
          params.push(gr ? JSON.stringify(gr) : null);
          sets.push(`google_rating = $${params.length}`);
          out.googleRating = gr;
        }
        if (sets.length > 0) {
          params.push(coin.draftId);
          await dbQuery(
            `UPDATE issuance_drafts SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`,
            params
          );
        }
      }
      if ("websiteUrl" in body) {
        const w = body.websiteUrl == null || String(body.websiteUrl).trim() === "" ? null : String(body.websiteUrl).trim();
        await dbQuery(`UPDATE issuance_coins SET website_url = $1 WHERE id = $2`, [w, coinId]);
        out.websiteUrl = w;
      }
      // Liveness verdicts for social URLs set here, merged into the
      // coin's stored map (same contract as the owner PATCH): a profile
      // only counts for Cred once its URL carries a live verdict.
      if (Array.isArray(body.socialProfiles) && body.socialProfiles.length > 0) {
        const urls = (body.socialProfiles as Array<{ url?: unknown }>)
          .map((x) => (typeof x?.url === "string" ? x.url.trim() : ""))
          .filter(Boolean);
        if (urls.length > 0) {
          const before = normalizeLinkStatus(coin.linkStatus);
          const merged = await ensureLinkVerdicts(urls, before);
          if (Object.keys(merged).length !== Object.keys(before).length) {
            await dbQuery(`UPDATE issuance_coins SET link_status = $1::jsonb WHERE id = $2`,
              [JSON.stringify(merged), coinId]);
          }
          out.linkStatus = merged;
        }
      }
      await auditLog(adminId, "admin_coin_updated", "issuance_coin", coinId, out);
      sendJson(ctx.res, 200, { updated: true, id: coinId, ...out });
    } catch (err) { fail(ctx, err); }
  });
  route("DELETE", "/api/v1/admin/coins/:id", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      // Coin factory gate: an admin session OR the batch key may delete.
      const { userId: adminId, via } = await requireCoinFactoryAdmin(ctx);
      const coinId = ctx.params.id;
      const coin = await dbQueryOne(
        `SELECT id, draft_id AS "draftId", mint_address AS "mintAddress", ticker FROM issuance_coins WHERE id = $1`,
        [coinId]
      );
      if (!coin) throw new HttpError(404, "coin_not_found", "No coin with that id.");
      // Refuse to delete coins that have real trading activity.
      const trades = await dbQueryOne(
        `SELECT COUNT(*)::int AS n FROM fee_ledger WHERE asset_id = $1`,
        [coinId]
      );
      if (trades && trades.n > 0) {
        throw new HttpError(409, "coin_has_activity", "Coin has trading activity; refusing to delete.");
      }
      // Child ledger rows first (in case any lack ON DELETE cascades),
      // then the chain itself, then the issuance records.
      await dbQuery(`DELETE FROM sovereign_txs WHERE chain_id = $1`, [coin.mintAddress]);
      await dbQuery(`DELETE FROM sovereign_balances WHERE chain_id = $1`, [coin.mintAddress]);
      await dbQuery(`DELETE FROM sovereign_blocks WHERE chain_id = $1`, [coin.mintAddress]);
      await dbQuery(`DELETE FROM sovereign_mempool WHERE chain_id = $1`, [coin.mintAddress]);
      await dbQuery(`DELETE FROM sovereign_chains WHERE chain_id = $1`, [coin.mintAddress]);
      await dbQuery(`DELETE FROM coin_documents WHERE coin_id = $1`, [coinId]);
      await dbQuery(`DELETE FROM float_increase_requests WHERE coin_id = $1`, [coinId]);
      await dbQuery(`DELETE FROM issuance_signatures WHERE draft_id = $1`, [coin.draftId]);
      await dbQuery(`DELETE FROM issuance_coins WHERE id = $1`, [coinId]);
      await dbQuery(`DELETE FROM issuance_drafts WHERE id = $1`, [coin.draftId]);
      // Drop the in-memory ledger copy too — otherwise the chain, and its
      // ticker reservation, linger until the next restart and the ticker
      // cannot be re-issued.
      ledgerStore.chains.delete(coin.mintAddress);
      ledgerStore.tickerIndex.delete(coin.ticker);
      ledgerStore.blocksByChain.delete(coin.mintAddress);
      ledgerStore.balances.delete(coin.mintAddress);
      ledgerStore.mempoolByChain.delete(coin.mintAddress);
      for (const [txId, tx] of ledgerStore.txById) {
        if (tx.chainId === coin.mintAddress) ledgerStore.txById.delete(txId);
      }
      await auditLog(adminId, "admin_coin_deleted", "issuance_coin", coinId, {
        ticker: coin.ticker, chainId: coin.mintAddress, via,
      });
      sendJson(ctx.res, 200, { deleted: true, id: coinId, ticker: coin.ticker });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/fees/config — current fee configuration ---
  route("GET", "/api/v1/admin/fees/config", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const cfg = await getFeeConfig();
      sendJson(ctx.res, 200, { config: cfg });
    } catch (err) { fail(ctx, err); }
  });

  // --- PUT /api/v1/admin/fees/config — change the fee rate (versioned) ---
  route("PUT", "/api/v1/admin/fees/config", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const feeBps = Number(body.feeBps);
      if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
        throw new HttpError(422, "invalid_fee_bps", "feeBps must be an integer 0..10000.");
      }
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined;
      const cfg = await setFeeConfig(feeBps, adminId, reason);
      sendJson(ctx.res, 200, { config: cfg });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/fees/summary — dashboard aggregates ---
  route("GET", "/api/v1/admin/fees/summary", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const days = Math.min(Math.max(Number(ctx.query.get("days") ?? 30) || 30, 1), 365);

      const config = await getFeeConfig();

      const today = await dbQuery<{
        transaction_type: string; asset_symbol: string;
        tx_count: string; gross: string; fees: string;
      }>(
        `SELECT transaction_type, asset_symbol, COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= date_trunc('day', now()) AND status = 'settled'
         GROUP BY transaction_type, asset_symbol`
      );

      const byDay = await dbQuery<{
        day: string; asset_symbol: string;
        tx_count: string; gross: string; fees: string;
      }>(
        `SELECT date_trunc('day', created_at)::date::text AS day, asset_symbol,
                COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= now() - ($1 || ' days')::interval AND status = 'settled'
         GROUP BY 1, 2 ORDER BY 1 DESC`,
        [String(days)]
      );

      const byAsset = await dbQuery<{
        asset_symbol: string; tx_count: string; gross: string; fees: string;
      }>(
        `SELECT asset_symbol, COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= now() - ($1 || ' days')::interval AND status = 'settled'
         GROUP BY asset_symbol ORDER BY SUM(fee_quantity) DESC`,
        [String(days)]
      );

      const byType = await dbQuery<{
        transaction_type: string; tx_count: string; gross: string; fees: string;
      }>(
        `SELECT transaction_type, COUNT(*)::text AS tx_count,
                COALESCE(SUM(gross_quantity),0)::text AS gross,
                COALESCE(SUM(fee_quantity),0)::text AS fees
         FROM fee_ledger
         WHERE created_at >= now() - ($1 || ' days')::interval AND status = 'settled'
         GROUP BY transaction_type`,
        [String(days)]
      );

      const statusCounts = await dbQuery<{ status: string; n: string }>(
        `SELECT status, COUNT(*)::text AS n FROM fee_ledger GROUP BY status`
      );

      const treasuryAccountId = getTreasuryAccountId();
      await ensureTreasuryAccount(treasuryAccountId);
      const treasuryBalances = await getTreasuryBalances(treasuryAccountId);
      const withdrawals = await listWithdrawals(undefined, 10);
      const reconciliation = await latestReconciliation();

      sendJson(ctx.res, 200, {
        config,
        treasuryAccountId,
        today,
        byDay,
        byAsset,
        byType,
        statusCounts,
        treasuryBalances,
        recentWithdrawals: withdrawals,
        reconciliation,
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/fees/ledger — fee records (JSON or CSV export) ---
  route("GET", "/api/v1/admin/fees/ledger", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const asset = ctx.query.get("asset")?.toUpperCase() || null;
      const transactionType = ctx.query.get("transactionType") || null;
      const status = ctx.query.get("status") || null;
      const limit = Math.min(Number(ctx.query.get("limit") ?? 100) || 100, 1000);
      const offset = Math.max(Number(ctx.query.get("offset") ?? 0) || 0, 0);
      const format = ctx.query.get("format") ?? "json";

      const conds: string[] = [];
      const params: unknown[] = [];
      if (asset) { params.push(asset); conds.push(`asset_symbol = $${params.length}`); }
      if (transactionType) { params.push(transactionType); conds.push(`transaction_type = $${params.length}`); }
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

      const countRow = await dbQueryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM fee_ledger ${where}`, params
      );
      const rows = await dbQuery<FeeRecord>(
        `SELECT fee_id AS "feeId", idempotency_key AS "idempotencyKey",
                transaction_id AS "transactionId", transaction_type AS "transactionType",
                user_id AS "userId", asset_id AS "assetId", asset_symbol AS "assetSymbol",
                gross_quantity::text AS "grossQuantity", fee_bps AS "feeBps",
                fee_quantity::text AS "feeQuantity", net_quantity::text AS "netQuantity",
                treasury_account_id AS "treasuryAccountId", status,
                coin_tx_id AS "coinTxId", created_at AS "createdAt", settled_at AS "settledAt"
         FROM fee_ledger ${where}
         ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      await auditLog(adminId, "fee_ledger_exported", "fee_ledger", undefined, {
        format, asset, transactionType, status, limit, offset,
      });

      if (format === "csv") {
        const header = "fee_id,transaction_id,transaction_type,user_id,asset_symbol,gross_quantity,fee_bps,fee_quantity,net_quantity,treasury_account_id,status,coin_tx_id,created_at,settled_at";
        const lines = rows.map((r) =>
          [r.feeId, r.transactionId ?? "", r.transactionType, r.userId, r.assetSymbol,
           r.grossQuantity, String(r.feeBps), r.feeQuantity, r.netQuantity,
           r.treasuryAccountId, r.status, r.coinTxId ?? "", r.createdAt, r.settledAt ?? ""]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")
        );
        ctx.res.writeHead(200, {
          "Content-Type": "text/csv",
          "Content-Disposition": "attachment; filename=phase-fee-ledger.csv",
        });
        ctx.res.end(header + "\n" + lines.join("\n"));
        return;
      }
      sendJson(ctx.res, 200, { total: Number(countRow?.n ?? 0), limit, offset, records: rows });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/treasury/balances ---
  route("GET", "/api/v1/admin/treasury/balances", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const accountId = getTreasuryAccountId();
      await ensureTreasuryAccount(accountId);
      sendJson(ctx.res, 200, {
        treasuryAccountId: accountId,
        balances: await getTreasuryBalances(accountId),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/treasury/withdrawals — request a withdrawal ---
  route("POST", "/api/v1/admin/treasury/withdrawals", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const assetSymbol = String(body.assetSymbol ?? "").trim();
      const amount = String(body.amount ?? "").trim();
      const destinationRef = String(body.destinationRef ?? "").trim();
      if (!assetSymbol) throw new HttpError(422, "missing_asset", "assetSymbol is required.");
      if (!amount) throw new HttpError(422, "missing_amount", "amount is required.");
      if (!destinationRef) {
        throw new HttpError(422, "missing_destination",
          "destinationRef is required (opaque reference to the approved destination — never a secret).");
      }
      // Validate the amount parses as positive money before touching the DB.
      toMicroUnits(amount);
      const wd = await requestWithdrawal({
        assetSymbol,
        amount,
        destinationRef,
        provider: typeof body.provider === "string" ? body.provider : "manual",
        note: typeof body.note === "string" ? body.note : undefined,
        requestedBy: adminId,
      });
      sendJson(ctx.res, 201, { withdrawal: wd });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/treasury/withdrawals ---
  route("GET", "/api/v1/admin/treasury/withdrawals", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const status = ctx.query.get("status") || undefined;
      sendJson(ctx.res, 200, { withdrawals: await listWithdrawals(status) });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/treasury/withdrawals/:id/approve ---
  route("POST", "/api/v1/admin/treasury/withdrawals/:id/approve", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const wd = await approveWithdrawal(ctx.params.id, adminId, body.approve !== false, {
        selfApprove: body.selfApprove === true,
      });
      sendJson(ctx.res, 200, { withdrawal: wd });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/treasury/withdrawals/:id/execute ---
  route("POST", "/api/v1/admin/treasury/withdrawals/:id/execute", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const wd = await executeWithdrawal(
        ctx.params.id,
        adminId,
        typeof body.providerRef === "string" ? body.providerRef : undefined
      );
      sendJson(ctx.res, 200, { withdrawal: wd });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/reconciliation/run ---
  route("POST", "/api/v1/admin/reconciliation/run", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const body = asRecord(ctx.body);
      const periodDays = Math.min(Math.max(Number(body.periodDays ?? 1) || 1, 1), 90);
      const result = await runFeeReconciliation(periodDays);
      await auditLog(adminId, "fee_reconciliation_manual_run", "reconciliation",
        result.runId != null ? String(result.runId) : undefined,
        { invariantOk: result.invariantOk });
      sendJson(ctx.res, 200, { reconciliation: result });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/reconciliation/latest ---
  route("GET", "/api/v1/admin/reconciliation/latest", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      sendJson(ctx.res, 200, { reconciliation: await latestReconciliation() });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/system/checks — production safety checks ---
  route("GET", "/api/v1/admin/system/checks", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      sendJson(ctx.res, 200, { checks: await runProductionChecks() });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/admin/users/admins — who can administer ---
  route("GET", "/api/v1/admin/users/admins", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      await requireAdmin(ctx);
      const rows = await dbQuery<{ id: string; email: string | null; name: string | null }>(
        `SELECT id, email, name FROM issuance_users WHERE is_admin = TRUE ORDER BY email`
      );
      sendJson(ctx.res, 200, { admins: rows });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/users/:id/grant — flag a user as admin ---
  route("POST", "/api/v1/admin/users/:id/grant", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      const target = await dbQueryOne<{ id: string }>(
        `UPDATE issuance_users SET is_admin = TRUE WHERE id = $1 RETURNING id`,
        [ctx.params.id]
      );
      if (!target) throw new HttpError(404, "user_not_found", "No such user.");
      await auditLog(adminId, "admin_granted", "user", target.id, {});
      sendJson(ctx.res, 200, { ok: true, userId: target.id });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/users/:id/revoke — remove admin flag ---
  route("POST", "/api/v1/admin/users/:id/revoke", async (ctx: AdminCtx) => {
    try {
      rateLimitAdmin(ctx);
      const adminId = await requireAdmin(ctx);
      if (ctx.params.id === adminId) {
        throw new HttpError(422, "cannot_revoke_self", "You cannot revoke your own admin access.");
      }
      await dbQuery(`UPDATE issuance_users SET is_admin = FALSE WHERE id = $1`, [ctx.params.id]);
      await auditLog(adminId, "admin_revoked", "user", ctx.params.id, {});
      sendJson(ctx.res, 200, { ok: true, userId: ctx.params.id });
    } catch (err) { fail(ctx, err); }
  });
}
