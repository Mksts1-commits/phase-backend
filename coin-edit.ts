/**
 * coin-edit.ts — post-issuance editing for coin owners.
 *
 * PATCH /api/v1/coins/:id
 *   Owner-only. Editable: the linked draft's social_profiles + tagline,
 *   and the coin's website_url. Economic fundamentals (name, ticker,
 *   supply, price, value thesis) are intentionally NOT editable —
 *   they were frozen at mint and, for the thesis, signed in the
 *   minting agreement.
 *
 * POST /api/v1/coins/:id/documents          (owner, JSON+base64)
 * GET  /api/v1/coins/:id/documents          (public, metadata list)
 * GET  /api/v1/coins/:id/documents/:docId   (public, download)
 * DELETE /api/v1/coins/:id/documents/:docId (owner)
 *
 * Documents power the dashboard's Documentation & Compliance section.
 * Files are stored as BYTEA (10 MB max per file, 10 max per coin).
 *
 * Mounted from phase-backend.ts: mountCoinEditRoutes({ route, sendJson, HttpError })
 */
import { randomUUID } from "node:crypto";
import { getPool } from "./db.js";
import { resolveBearerUserId } from "./auth.js";

export interface CoinEditMountDeps {
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

const ENVELOPE = { network: "sovereign" as const, chain: "phase" as const };

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

class CoinEditHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

const SOCIAL_PLATFORMS = new Set(["tiktok", "youtube", "instagram", "x", "facebook"]);
const DOC_MIME_ALLOW = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_DOCS_PER_COIN = 10;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

function cleanUrl(raw: string, maxLen: number): string | null {
  const u = raw.trim().slice(0, maxLen);
  if (!u) return null;
  if (!URL_RE.test(u)) throw new CoinEditHttpError(422, "invalid_url", `Not a valid http(s) URL: ${u.slice(0, 80)}`);
  return u;
}

export function mountCoinEditRoutes(deps: CoinEditMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof CoinEditHttpError;

  const fail = (ctx: Ctx, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...ENVELOPE, error: code, message });
  };

  const requireUserId = async (ctx: Ctx): Promise<string> => {
    const authed = await resolveBearerUserId(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    return authed;
  };

  /** The coin row, or 404. Ownership is checked by the caller. */
  async function getCoin(id: string): Promise<{ id: string; userId: string; draftId: string | null }> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, user_id AS "userId", draft_id AS "draftId" FROM issuance_coins WHERE id = $1`,
      [id]
    );
    if (r.rows.length === 0) throw new HttpError(404, "coin_not_found", "No coin with that id.");
    return r.rows[0];
  }

  async function requireOwner(ctx: Ctx, userId: string): Promise<{ id: string; draftId: string | null }> {
    const coin = await getCoin(ctx.params.id);
    if (coin.userId !== userId) throw new HttpError(403, "forbidden", "Only the issuer can edit this coin.");
    return coin;
  }

  // --- PATCH /api/v1/coins/:id ---
  route("PATCH", "/api/v1/coins/:id", async (ctx: Ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const coin = await requireOwner(ctx, userId);
      const body = asRecord(ctx.body);

      const pool = getPool();
      const out: Record<string, unknown> = {};

      // Draft-owned fields: social profiles + tagline.
      if (coin.draftId && ("socialProfiles" in body || "tagline" in body)) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if ("socialProfiles" in body) {
          const raw = body.socialProfiles;
          if (!Array.isArray(raw)) throw new HttpError(422, "invalid_social", "socialProfiles must be an array.");
          if (raw.length > 8) throw new HttpError(422, "invalid_social", "At most 8 social profiles.");
          const cleaned = raw.map((p) => {
            const pr = asRecord(p);
            const platform = str(pr.platform).trim().toLowerCase();
            if (!SOCIAL_PLATFORMS.has(platform)) {
              throw new HttpError(422, "invalid_social", `Unsupported platform: ${platform || "(blank)"}.`);
            }
            const url = cleanUrl(str(pr.url), 500);
            if (!url) throw new HttpError(422, "invalid_social", `Missing URL for ${platform}.`);
            return { platform, url };
          });
          // De-dupe by platform, keep last.
          const byPlatform = new Map<string, { platform: string; url: string }>();
          for (const p of cleaned) byPlatform.set(p.platform, p);
          params.push(JSON.stringify([...byPlatform.values()]));
          sets.push(`social_profiles = $${params.length}`);
          out.socialProfiles = [...byPlatform.values()];
        }
        if ("tagline" in body) {
          const tagline = str(body.tagline).trim().slice(0, 140) || null;
          params.push(tagline);
          sets.push(`tagline = $${params.length}`);
          out.tagline = tagline;
        }
        if (sets.length > 0) {
          params.push(coin.draftId);
          await pool.query(
            `UPDATE issuance_drafts SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${params.length}`,
            params
          );
        }
      }

      // Coin-owned field: website URL.
      if ("websiteUrl" in body) {
        const websiteUrl = body.websiteUrl == null || str(body.websiteUrl).trim() === ""
          ? null
          : cleanUrl(str(body.websiteUrl), 500);
        await pool.query(`UPDATE issuance_coins SET website_url = $1 WHERE id = $2`, [websiteUrl, coin.id]);
        out.websiteUrl = websiteUrl;
      }

      sendJson(ctx.res, 200, { ...ENVELOPE, id: coin.id, ...out });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/coins/:id/documents ---
  route("POST", "/api/v1/coins/:id/documents", async (ctx: Ctx) => {
    try {
      const userId = await requireUserId(ctx);
      const coin = await requireOwner(ctx, userId);
      const body = asRecord(ctx.body);

      const filename = str(body.filename).trim().replace(/[\\/]/g, "_").slice(0, 120);
      if (!filename) throw new HttpError(422, "invalid_filename", "filename is required.");
      const mimeType = str(body.mimeType).trim().toLowerCase();
      if (!DOC_MIME_ALLOW.has(mimeType)) {
        throw new HttpError(422, "invalid_mime", "Only PDF and image files (png, jpeg, webp, gif) are accepted.");
      }
      const b64 = str(body.dataBase64).replace(/\s+/g, "");
      if (!b64) throw new HttpError(422, "missing_data", "dataBase64 is required.");
      let data: Buffer;
      try {
        data = Buffer.from(b64, "base64");
      } catch {
        throw new HttpError(422, "invalid_data", "dataBase64 is not valid base64.");
      }
      if (data.length === 0 || data.length > MAX_DOC_BYTES) {
        throw new HttpError(422, "file_too_large", `File must be between 1 byte and 10 MB.`);
      }

      const pool = getPool();
      const count = await pool.query(`SELECT COUNT(*)::int AS n FROM coin_documents WHERE coin_id = $1`, [coin.id]);
      if (count.rows[0].n >= MAX_DOCS_PER_COIN) {
        throw new HttpError(422, "too_many_documents", `At most ${MAX_DOCS_PER_COIN} documents per coin.`);
      }

      const id = randomUUID();
      await pool.query(
        `INSERT INTO coin_documents (id, coin_id, user_id, filename, mime_type, size_bytes, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, coin.id, userId, filename, mimeType, data.length, data]
      );
      sendJson(ctx.res, 201, {
        ...ENVELOPE,
        document: { id, filename, mimeType, sizeBytes: data.length },
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/coins/:id/documents ---
  route("GET", "/api/v1/coins/:id/documents", async (ctx: Ctx) => {
    try {
      await getCoin(ctx.params.id); // 404 if unknown; list itself is public
      const pool = getPool();
      const r = await pool.query(
        `SELECT id, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
                created_at AS "createdAt"
         FROM coin_documents WHERE coin_id = $1 ORDER BY created_at ASC`,
        [ctx.params.id]
      );
      sendJson(ctx.res, 200, { ...ENVELOPE, documents: r.rows });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/coins/:id/documents/:docId ---
  route("GET", "/api/v1/coins/:id/documents/:docId", async (ctx: Ctx) => {
    try {
      const pool = getPool();
      const r = await pool.query(
        `SELECT filename, mime_type AS "mimeType", data FROM coin_documents
         WHERE id = $1 AND coin_id = $2`,
        [ctx.params.docId, ctx.params.id]
      );
      if (r.rows.length === 0) throw new HttpError(404, "document_not_found", "No document with that id.");
      const doc = r.rows[0];
      const bytes: Buffer = doc.data;
      ctx.res.writeHead(200, {
        "Content-Type": doc.mimeType,
        "Content-Length": bytes.length,
        "Content-Disposition": `inline; filename="${doc.filename.replace(/"/g, "")}"`,
      });
      ctx.res.end(bytes);
    } catch (err) {
      // Binary route: JSON errors only when headers not sent yet.
      try {
        fail(ctx, err);
      } catch { /* headers already sent */ }
    }
  });

  // --- DELETE /api/v1/coins/:id/documents/:docId ---
  route("DELETE", "/api/v1/coins/:id/documents/:docId", async (ctx: Ctx) => {
    try {
      const userId = await requireUserId(ctx);
      await requireOwner(ctx, userId);
      const pool = getPool();
      const r = await pool.query(
        `DELETE FROM coin_documents WHERE id = $1 AND coin_id = $2 RETURNING id`,
        [ctx.params.docId, ctx.params.id]
      );
      if (r.rows.length === 0) throw new HttpError(404, "document_not_found", "No document with that id.");
      sendJson(ctx.res, 200, { ...ENVELOPE, deleted: r.rows[0].id });
    } catch (err) { fail(ctx, err); }
  });
}
