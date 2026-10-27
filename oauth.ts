/**
 * oauth.ts — OAuth 2.0 authorization server for the Phase backend.
 *
 * Lets a third-party agent client (e.g. a Muse connector) obtain
 * user-authorized tokens instead of a full session:
 *
 *   GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata)
 *   POST /oauth/register    (RFC 7591 dynamic client registration)
 *   GET  /oauth/authorize   (authorization code flow + PKCE, HTML page)
 *   POST /oauth/authorize   (login + consent decision, JSON; the page
 *          submits via fetch and navigates to the returned redirect URL —
 *          the server's dispatcher is JSON-only, so a native form POST
 *          would fail body parsing before reaching this handler)
 *   POST /oauth/token       (authorization_code + refresh_token grants)
 *   POST /oauth/revoke      (RFC 7009, best effort, always 200)
 *
 * Security shape, matching auth.ts conventions:
 * - Codes, tokens, and client secrets are stored only as SHA-256 hashes
 *   (same pattern as password_reset_tokens). A database read never yields
 *   a usable credential. Client secrets are high-entropy random values.
 * - Authorization codes: single-use (claimed atomically), 10-minute
 *   expiry, bound to client_id + redirect_uri + PKCE challenge.
 * - Access tokens: opaque, 1-hour expiry. Refresh tokens: 30-day expiry,
 *   rotated on every use — the old refresh token stops matching and its
 *   reuse is rejected.
 * - PKCE: S256 required for public clients; confidential clients may use
 *   S256 or plain, or omit PKCE entirely.
 * - Scope enforcement lives in resolveBearerAuth() + the per-route
 *   requireScopedUserId helpers in the route modules: session Bearer
 *   tokens keep full access unchanged; OAuth Bearer tokens work only on
 *   the endpoints the brief gates, and only with the required scope.
 *   Everywhere else an OAuth token behaves as unauthenticated.
 * - Grants are audited through the existing audit_log mechanism
 *   (auditLog in sovereign-ledger-core.ts) — no new audit store.
 *
 * Persistence: Postgres when DATABASE_URL is set, otherwise an in-memory
 * store (dev/test) — same dual-mode pattern as auth.ts.
 *
 * Mounted from phase-backend.ts: mountOAuthRoutes({ route, sendJson, HttpError })
 */
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { getPool } from "./db.js";
import { resolveBearerUserId, verifyAccountPassword } from "./auth.js";
import { auditLog } from "./sovereign-ledger-core.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";

export const OAUTH_ISSUER = "https://phase-backend.onrender.com";
export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** The only grantable scopes (connector-api-spec.md). read:marketplace is
 *  public and needs no scope, so it is deliberately NOT grantable. */
export const OAUTH_SCOPES = [
  "read:coins",
  "read:portfolio",
  "read:dashboard",
  "write:listings",
  "write:orders",
  "write:coin-profile",
  "write:watchlist",
  "write:offers",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  "read:coins": "View coins and market listings",
  "read:portfolio": "View your holdings, balances, and transactions",
  "read:dashboard": "View your dashboard",
  "write:listings": "Draft, sign, and mint coins",
  "write:orders": "Place buy and swap orders",
  "write:coin-profile": "Edit your coin's profile and documents",
  "write:watchlist": "Manage your watchlist",
  "write:offers": "Create and manage swap offers",
};

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function bearerFrom(headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers["authorization"];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v || !v.startsWith("Bearer ")) return null;
  return v.slice("Bearer ".length).trim() || null;
}

// ---------------------------------------------------------------------------
// Redirect URI validation (RFC 6749 §3.1.2): https only, except loopback.
// Fragments are never allowed in a registered redirect URI.
// ---------------------------------------------------------------------------

export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:") {
      return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store: Postgres when reachable, in-memory fallback otherwise.
// ---------------------------------------------------------------------------

export interface OAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  allowedScopes: string[];
  isPublic: boolean;
}

interface OAuthCodeRow {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface OAuthTokenRow {
  id: string;
  clientId: string;
  userId: string;
  scope: string[];
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  revokedAt: string | null;
}

interface OAuthStore {
  createClient(c: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  createCode(codeHash: string, row: OAuthCodeRow): Promise<void>;
  getCode(codeHash: string): Promise<OAuthCodeRow | null>;
  /** Atomically claims a code (sets used_at). False when already used. */
  claimCode(codeHash: string): Promise<boolean>;
  createToken(row: OAuthTokenRow): Promise<void>;
  findTokenByAccessHash(hash: string): Promise<OAuthTokenRow | null>;
  findTokenByRefreshHash(hash: string): Promise<OAuthTokenRow | null>;
  /** Rotation: replace hashes + expiries; returns false when not found. */
  rotateToken(id: string, accessHash: string, refreshHash: string, accessExpiresAt: string, refreshExpiresAt: string): Promise<boolean>;
  revokeToken(id: string): Promise<void>;
}

class PgOAuthStore implements OAuthStore {
  private async q<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await getPool().query(text, params as unknown[]);
    return r.rows as T[];
  }

  async createClient(c: OAuthClient): Promise<void> {
    await this.q(
      `INSERT INTO oauth_clients(client_id, client_secret_hash, client_name, redirect_uris, allowed_scopes, is_public)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [c.clientId, c.clientSecretHash, c.clientName, c.redirectUris, c.allowedScopes, c.isPublic]
    );
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const rows = await this.q<{
      clientId: string; clientSecretHash: string | null; clientName: string;
      redirectUris: string[]; allowedScopes: string[]; isPublic: boolean;
    }>(
      `SELECT client_id AS "clientId", client_secret_hash AS "clientSecretHash",
              client_name AS "clientName", redirect_uris AS "redirectUris",
              allowed_scopes AS "allowedScopes", is_public AS "isPublic"
       FROM oauth_clients WHERE client_id = $1`,
      [clientId]
    );
    return rows[0] ?? null;
  }

  async createCode(codeHash: string, row: OAuthCodeRow): Promise<void> {
    await this.q(
      `INSERT INTO oauth_authorization_codes(code_hash, client_id, user_id, redirect_uri, scope, code_challenge, code_challenge_method, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [codeHash, row.clientId, row.userId, row.redirectUri, row.scope, row.codeChallenge, row.codeChallengeMethod, row.expiresAt]
    );
  }

  async getCode(codeHash: string): Promise<OAuthCodeRow | null> {
    const rows = await this.q<{
      clientId: string; userId: string; redirectUri: string; scope: string[];
      codeChallenge: string; codeChallengeMethod: string; expiresAt: string; usedAt: string | null;
    }>(
      `SELECT client_id AS "clientId", user_id AS "userId", redirect_uri AS "redirectUri",
              scope, code_challenge AS "codeChallenge", code_challenge_method AS "codeChallengeMethod",
              expires_at AS "expiresAt", used_at AS "usedAt"
       FROM oauth_authorization_codes WHERE code_hash = $1`,
      [codeHash]
    );
    return rows[0] ?? null;
  }

  async claimCode(codeHash: string): Promise<boolean> {
    const rows = await this.q<{ codeHash: string }>(
      `UPDATE oauth_authorization_codes SET used_at = now()
       WHERE code_hash = $1 AND used_at IS NULL RETURNING code_hash`,
      [codeHash]
    );
    return rows.length > 0;
  }

  async createToken(row: OAuthTokenRow): Promise<void> {
    await this.q(
      `INSERT INTO oauth_tokens(id, client_id, user_id, scope, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.id, row.clientId, row.userId, row.scope, row.accessTokenHash, row.refreshTokenHash, row.accessExpiresAt, row.refreshExpiresAt]
    );
  }

  private rowToToken(r: any): OAuthTokenRow {
    return {
      id: r.id, clientId: r.clientId, userId: r.userId, scope: r.scope,
      accessTokenHash: r.accessTokenHash, refreshTokenHash: r.refreshTokenHash,
      accessExpiresAt: r.accessExpiresAt, refreshExpiresAt: r.refreshExpiresAt,
      revokedAt: r.revokedAt,
    };
  }

  async findTokenByAccessHash(hash: string): Promise<OAuthTokenRow | null> {
    const rows = await this.q(
      `SELECT id, client_id AS "clientId", user_id AS "userId", scope,
              access_token_hash AS "accessTokenHash", refresh_token_hash AS "refreshTokenHash",
              access_expires_at AS "accessExpiresAt", refresh_expires_at AS "refreshExpiresAt",
              revoked_at AS "revokedAt"
       FROM oauth_tokens WHERE access_token_hash = $1`,
      [hash]
    );
    return rows[0] ? this.rowToToken(rows[0]) : null;
  }

  async findTokenByRefreshHash(hash: string): Promise<OAuthTokenRow | null> {
    const rows = await this.q(
      `SELECT id, client_id AS "clientId", user_id AS "userId", scope,
              access_token_hash AS "accessTokenHash", refresh_token_hash AS "refreshTokenHash",
              access_expires_at AS "accessExpiresAt", refresh_expires_at AS "refreshExpiresAt",
              revoked_at AS "revokedAt"
       FROM oauth_tokens WHERE refresh_token_hash = $1`,
      [hash]
    );
    return rows[0] ? this.rowToToken(rows[0]) : null;
  }

  async rotateToken(id: string, accessHash: string, refreshHash: string, accessExpiresAt: string, refreshExpiresAt: string): Promise<boolean> {
    const rows = await this.q<{ id: string }>(
      `UPDATE oauth_tokens SET access_token_hash = $2, refresh_token_hash = $3,
              access_expires_at = $4, refresh_expires_at = $5
       WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt]
    );
    return rows.length > 0;
  }

  async revokeToken(id: string): Promise<void> {
    await this.q(`UPDATE oauth_tokens SET revoked_at = now() WHERE id = $1`, [id]);
  }
}

class MemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, OAuthCodeRow>();
  private tokens = new Map<string, OAuthTokenRow>();

  async createClient(c: OAuthClient): Promise<void> { this.clients.set(c.clientId, c); }
  async getClient(clientId: string): Promise<OAuthClient | null> { return this.clients.get(clientId) ?? null; }
  async createCode(codeHash: string, row: OAuthCodeRow): Promise<void> { this.codes.set(codeHash, row); }
  async getCode(codeHash: string): Promise<OAuthCodeRow | null> { return this.codes.get(codeHash) ?? null; }
  async claimCode(codeHash: string): Promise<boolean> {
    const row = this.codes.get(codeHash);
    if (!row || row.usedAt) return false;
    row.usedAt = new Date().toISOString();
    return true;
  }
  async createToken(row: OAuthTokenRow): Promise<void> { this.tokens.set(row.id, row); }
  async findTokenByAccessHash(hash: string): Promise<OAuthTokenRow | null> {
    for (const t of this.tokens.values()) if (t.accessTokenHash === hash) return t;
    return null;
  }
  async findTokenByRefreshHash(hash: string): Promise<OAuthTokenRow | null> {
    for (const t of this.tokens.values()) if (t.refreshTokenHash === hash) return t;
    return null;
  }
  async rotateToken(id: string, accessHash: string, refreshHash: string, accessExpiresAt: string, refreshExpiresAt: string): Promise<boolean> {
    const t = this.tokens.get(id);
    if (!t || t.revokedAt) return false;
    t.accessTokenHash = accessHash;
    t.refreshTokenHash = refreshHash;
    t.accessExpiresAt = accessExpiresAt;
    t.refreshExpiresAt = refreshExpiresAt;
    return true;
  }
  async revokeToken(id: string): Promise<void> {
    const t = this.tokens.get(id);
    if (t) t.revokedAt = new Date().toISOString();
  }
}

let oauthStoreInstance: OAuthStore = new MemoryOAuthStore();
let oauthStorePromise: Promise<OAuthStore> | null = null;

async function getStoreAsync(): Promise<OAuthStore> {
  if ((process.env.DATABASE_URL ?? "").trim()) {
    try {
      await getPool().query("SELECT 1");
      return new PgOAuthStore();
    } catch {
      return oauthStoreInstance; // Postgres configured but unreachable — fall back
    }
  }
  return oauthStoreInstance;
}

function oauthStore(): Promise<OAuthStore> {
  if (!oauthStorePromise) {
    oauthStorePromise = getStoreAsync().then((s) => {
      oauthStoreInstance = s;
      return s;
    });
  }
  return oauthStorePromise;
}

// ---------------------------------------------------------------------------
// Unified Bearer resolution + scope enforcement (used by route modules).
// Session tokens keep full access; OAuth tokens are scoped.
// ---------------------------------------------------------------------------

export type BearerAuth =
  | { kind: "session"; userId: string }
  | { kind: "oauth"; userId: string; clientId: string; scopes: string[] };

export async function resolveBearerAuth(
  headers: Record<string, string | string[] | undefined>
): Promise<BearerAuth | null> {
  const sessionUserId = await resolveBearerUserId(headers);
  if (sessionUserId) return { kind: "session", userId: sessionUserId };
  const token = bearerFrom(headers);
  if (!token) return null;
  const row = await (await oauthStore()).findTokenByAccessHash(sha256hex(token));
  if (!row || row.revokedAt) return null;
  if (new Date(row.accessExpiresAt).getTime() <= Date.now()) return null;
  return { kind: "oauth", userId: row.userId, clientId: row.clientId, scopes: row.scope };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface OAuthMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface OAuthCtx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  query: URLSearchParams;
  body: unknown;
}

function asRecord(body: unknown): Record<string, unknown> {
  return (body !== null && typeof body === "object" && !Array.isArray(body))
    ? (body as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON-encode a value for embedding inside a <script> block. */
function jsonForScript(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}

function parseScopeParam(raw: string | null, allowed: string[]): string[] | null {
  // Omitted scope defaults to the client's full allowed set (RFC 6749 §3.3).
  if (raw === null || raw.trim() === "") return [...allowed];
  const scopes = raw.trim().split(/\s+/);
  for (const s of scopes) {
    if (!(OAUTH_SCOPES as readonly string[]).includes(s)) return null;
    if (!allowed.includes(s)) return null;
  }
  return scopes;
}

function redirectWith(base: string, params: Record<string, string>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function sendHtml(res: any, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`
    + `<body style="font-family:sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#0b100d">`
    + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`
    + `<p><a href="https://is.gd/mintmycoin">Phase</a></p></body></html>`;
}

/** Client authentication for the token endpoint: Basic header or body
 *  client_id + client_secret. Returns the client, or null when the
 *  credentials do not authenticate it. Public clients need no secret. */
async function authenticateClient(
  ctx: OAuthCtx,
  body: Record<string, unknown>
): Promise<OAuthClient | null> {
  let clientId = str(body.client_id);
  let clientSecret = str(body.client_secret);
  const authHeader = ctx.req.headers["authorization"];
  const h = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (h && h.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(h.slice("Basic ".length), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        clientId = decoded.slice(0, idx);
        clientSecret = decoded.slice(idx + 1);
      }
    } catch { /* fall through to body credentials */ }
  }
  if (!clientId) return null;
  const s = await oauthStore();
  const client = await s.getClient(clientId);
  if (!client) return null;
  if (client.isPublic) return client; // public clients authenticate with PKCE, not a secret
  if (!clientSecret || !client.clientSecretHash) return null;
  // Constant-time comparison of hashes.
  const a = Buffer.from(sha256hex(clientSecret), "hex");
  const b = Buffer.from(client.clientSecretHash, "hex");
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? client : null;
}

export function mountOAuthRoutes(deps: OAuthMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError;

  const fail = (ctx: OAuthCtx, err: unknown): void => {
    const e = err as { statusCode?: number; code?: string };
    const statusCode = e.statusCode ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { error: code, message });
  };

  const clientIp = (ctx: OAuthCtx): string => clientIpFromHeaders(ctx.req.headers);

  // --- GET /.well-known/oauth-authorization-server (RFC 8414) ---
  route("GET", "/.well-known/oauth-authorization-server", async (ctx) => {
    try {
      sendJson(ctx.res, 200, {
        issuer: OAUTH_ISSUER,
        authorization_endpoint: `${OAUTH_ISSUER}/oauth/authorize`,
        token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
        registration_endpoint: `${OAUTH_ISSUER}/oauth/register`,
        revocation_endpoint: `${OAUTH_ISSUER}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256", "plain"],
        scopes_supported: [...OAUTH_SCOPES],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
        revocation_endpoint_auth_methods_supported: ["none"],
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /oauth/register (RFC 7591) ---
  route("POST", "/oauth/register", async (ctx) => {
    try {
      if (!checkRateLimit(`oauth:register:${clientIp(ctx)}`, 10, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many registration attempts — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const clientName = str(body.client_name).trim().slice(0, 120);
      if (!clientName) {
        throw new HttpError(400, "invalid_client_metadata", "client_name is required.");
      }
      const rawUris = body.redirect_uris;
      if (!Array.isArray(rawUris) || rawUris.length === 0) {
        throw new HttpError(400, "invalid_redirect_uri", "redirect_uris must be a non-empty array.");
      }
      const redirectUris: string[] = [];
      for (const u of rawUris) {
        if (typeof u !== "string" || !isValidRedirectUri(u)) {
          throw new HttpError(400, "invalid_redirect_uri",
            `Redirect URI rejected (must be https, or http loopback): ${typeof u === "string" ? u : ""}`);
        }
        redirectUris.push(u);
      }
      // Scope: omitted means all scopes are allowed; a provided scope must
      // be a subset of the grantable set.
      let allowedScopes: string[];
      if (body.scope === undefined || body.scope === null || str(body.scope).trim() === "") {
        allowedScopes = [...OAUTH_SCOPES];
      } else {
        const requested = str(body.scope).trim().split(/\s+/);
        for (const s of requested) {
          if (!(OAUTH_SCOPES as readonly string[]).includes(s)) {
            throw new HttpError(400, "invalid_scope", `Unknown scope: ${s}`);
          }
        }
        allowedScopes = requested;
      }
      const authMethod = str(body.token_endpoint_auth_method).trim();
      const isPublic = authMethod === "none";
      const clientId = "client_" + randomBytes(12).toString("hex");
      let clientSecret: string | null = null;
      let clientSecretHash: string | null = null;
      if (!isPublic) {
        clientSecret = randomBytes(32).toString("hex");
        clientSecretHash = sha256hex(clientSecret);
      }
      const s = await oauthStore();
      await s.createClient({ clientId, clientSecretHash, clientName, redirectUris, allowedScopes, isPublic });
      await auditLog(`oauth_client:${clientId}`, "oauth_client_registered", "oauth_clients", clientId, {
        clientName, redirectUris, allowedScopes, isPublic,
      }).catch(() => { /* audit is best-effort */ });
      sendJson(ctx.res, 201, {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        client_name: clientName,
        redirect_uris: redirectUris,
        scope: allowedScopes.join(" "),
        token_endpoint_auth_method: isPublic ? "none" : "client_secret_basic",
      });
    } catch (err) { fail(ctx, err); }
  });

  // Shared authorize-parameter validation. Returns the validated client,
  // redirect URI, scopes, and state — or throws an HttpError. When
  // redirectTarget is set, the caller redirects the error there; when it
  // is null (client or redirect_uri itself invalid), the caller renders
  // an error page instead.
  async function validateAuthorizeParams(query: URLSearchParams, body: Record<string, unknown>): Promise<{
    client: OAuthClient; redirectUri: string; scopes: string[]; state: string;
    codeChallenge: string; codeChallengeMethod: string; redirectTarget: string | null;
  }> {
    const pick = (k: string): string => {
      const q = query.get(k);
      if (q !== null) return q;
      return str(body[k]);
    };
    const clientId = pick("client_id");
    const redirectUri = pick("redirect_uri");
    const responseType = pick("response_type");
    const scopeRaw = query.get("scope") ?? (body.scope !== undefined ? str(body.scope) : null);
    const state = pick("state");
    const codeChallenge = pick("code_challenge");
    const codeChallengeMethod = pick("code_challenge_method") || "plain";

    const s = await oauthStore();
    const client = clientId ? await s.getClient(clientId) : null;
    if (!client) {
      throw new HttpError(400, "invalid_client", "Unknown client_id.");
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      throw new HttpError(400, "invalid_redirect_uri", "redirect_uri does not exactly match a registered URI.");
    }
    // From here on, errors can safely redirect back to the client.
    const redirectTarget = redirectUri;
    if (responseType && responseType !== "code") {
      const e = new HttpError(302, "unsupported_response_type", "Only response_type=code is supported.");
      (e as any).redirect = redirectWith(redirectTarget, { error: "unsupported_response_type", ...(state ? { state } : {}) });
      throw e;
    }
    const scopes = parseScopeParam(scopeRaw, client.allowedScopes);
    if (!scopes || scopes.length === 0) {
      const e = new HttpError(302, "invalid_scope", "Requested scope is unknown or exceeds the registered scope.");
      (e as any).redirect = redirectWith(redirectTarget, { error: "invalid_scope", ...(state ? { state } : {}) });
      throw e;
    }
    if (client.isPublic) {
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        const e = new HttpError(302, "invalid_request", "Public clients must use PKCE with code_challenge_method=S256.");
        (e as any).redirect = redirectWith(redirectTarget, { error: "invalid_request", ...(state ? { state } : {}) });
        throw e;
      }
    } else if (codeChallenge && codeChallengeMethod !== "S256" && codeChallengeMethod !== "plain") {
      const e = new HttpError(302, "invalid_request", "code_challenge_method must be S256 or plain.");
      (e as any).redirect = redirectWith(redirectTarget, { error: "invalid_request", ...(state ? { state } : {}) });
      throw e;
    }
    return { client, redirectUri, scopes, state, codeChallenge, codeChallengeMethod, redirectTarget };
  }

  // --- GET /oauth/authorize — login + consent page ---
  route("GET", "/oauth/authorize", async (ctx) => {
    try {
      if (!checkRateLimit(`oauth:authorize-page:${clientIp(ctx)}`, 60, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many requests — wait a moment and try again.");
      }
      let v: Awaited<ReturnType<typeof validateAuthorizeParams>>;
      try {
        v = await validateAuthorizeParams(ctx.query, {});
      } catch (err) {
        const redirect = (err as any).redirect as string | undefined;
        if (redirect) {
          // Real 302 so a browser (or a test following redirects) lands on
          // the client's redirect URI with the OAuth error code.
          ctx.res.writeHead(302, { Location: redirect });
          ctx.res.end();
          return;
        }
        const e = err as { statusCode?: number; message?: string };
        sendHtml(ctx.res, e.statusCode ?? 400, errorPage("Authorization failed", e.message ?? "Invalid authorization request."));
        return;
      }
      const scopeItems = v.scopes.map((s) =>
        `<li><strong>${escapeHtml(s)}</strong> — ${escapeHtml(SCOPE_DESCRIPTIONS[s as OAuthScope] ?? s)}</li>`).join("");
      const params = {
        client_id: v.client.clientId,
        redirect_uri: v.redirectUri,
        scope: v.scopes.join(" "),
        state: v.state,
        code_challenge: v.codeChallenge,
        code_challenge_method: v.codeChallengeMethod,
        response_type: "code",
      };
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorize ${escapeHtml(v.client.clientName)} — Phase</title></head>`
        + `<body style="font-family:sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#0b100d">`
        + `<h1>Authorize ${escapeHtml(v.client.clientName)}</h1>`
        + `<p><strong>${escapeHtml(v.client.clientName)}</strong> is asking to access your Phase account with these permissions:</p>`
        + `<ul>${scopeItems}</ul>`
        + `<p>Sign in with your Phase email and password, then Allow or Deny. Nothing is shared until you click Allow.</p>`
        + `<form id="authz"><label>Email<br><input name="email" type="email" required style="width:100%;padding:8px"></label><br><br>`
        + `<label>Password<br><input name="password" type="password" required style="width:100%;padding:8px"></label><br><br>`
        + `<button type="submit" data-decision="allow" style="padding:10px 20px;background:#00a651;color:#fff;border:0;cursor:pointer">Allow</button> `
        + `<button type="submit" data-decision="deny" style="padding:10px 20px;cursor:pointer">Deny</button></form>`
        + `<p id="msg" style="color:#d92d20"></p>`
        + `<script>const PARAMS = ${jsonForScript(params)};`
        + `let decision = "allow";`
        + `document.querySelectorAll("button[data-decision]").forEach(b => b.addEventListener("click", () => { decision = b.dataset.decision; }));`
        + `document.getElementById("authz").addEventListener("submit", async (ev) => {`
        + `ev.preventDefault(); const fd = new FormData(ev.target);`
        + `const res = await fetch("/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/json" },`
        + `body: JSON.stringify({ ...PARAMS, email: fd.get("email"), password: fd.get("password"), decision }) });`
        + `const data = await res.json();`
        + `if (data.redirect) { window.location = data.redirect; }`
        + `else { document.getElementById("msg").textContent = data.message || data.error || "Something went wrong."; }`
        + `});</script></body></html>`;
      sendHtml(ctx.res, 200, html);
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /oauth/authorize — login + consent decision (JSON) ---
  route("POST", "/oauth/authorize", async (ctx) => {
    try {
      if (!checkRateLimit(`oauth:authorize:${clientIp(ctx)}`, 20, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many authorization attempts — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      let v: Awaited<ReturnType<typeof validateAuthorizeParams>>;
      try {
        v = await validateAuthorizeParams(ctx.query, body);
      } catch (err) {
        const redirect = (err as any).redirect as string | undefined;
        if (redirect) {
          sendJson(ctx.res, 200, { redirect });
          return;
        }
        throw err;
      }
      const decision = str(body.decision);
      if (decision === "deny") {
        sendJson(ctx.res, 200, {
          redirect: redirectWith(v.redirectUri, { error: "access_denied", ...(v.state ? { state: v.state } : {}) }),
        });
        return;
      }
      if (decision !== "allow") {
        throw new HttpError(400, "invalid_request", 'decision must be "allow" or "deny".');
      }
      const email = str(body.email).trim();
      const password = str(body.password);
      if (!email || !password) {
        throw new HttpError(401, "invalid_credentials", "Email and password are required.");
      }
      // Never log the password; verification reuses auth.ts's scrypt check.
      const account = await verifyAccountPassword(email, password);
      if (!account) {
        throw new HttpError(401, "invalid_credentials", "No account found for that email and password.");
      }
      const code = randomBytes(32).toString("base64url");
      const s = await oauthStore();
      await s.createCode(sha256hex(code), {
        clientId: v.client.clientId,
        userId: account.id,
        redirectUri: v.redirectUri,
        scope: v.scopes,
        codeChallenge: v.codeChallenge,
        codeChallengeMethod: v.codeChallengeMethod,
        expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
        usedAt: null,
      });
      sendJson(ctx.res, 200, {
        redirect: redirectWith(v.redirectUri, { code, ...(v.state ? { state: v.state } : {}) }),
      });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /oauth/token ---
  route("POST", "/oauth/token", async (ctx) => {
    try {
      if (!checkRateLimit(`oauth:token:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many token requests — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const grantType = str(body.grant_type);
      const s = await oauthStore();

      if (grantType === "authorization_code") {
        const code = str(body.code);
        const redirectUri = str(body.redirect_uri);
        if (!code || !redirectUri) {
          throw new HttpError(400, "invalid_request", "code and redirect_uri are required.");
        }
        const client = await authenticateClient(ctx, body);
        if (!client) {
          throw new HttpError(401, "invalid_client", "Client authentication failed.");
        }
        const row = await s.getCode(sha256hex(code));
        if (!row || row.clientId !== client.clientId || row.redirectUri !== redirectUri) {
          throw new HttpError(400, "invalid_grant", "Authorization code is invalid.");
        }
        if (row.usedAt || new Date(row.expiresAt).getTime() <= Date.now()) {
          throw new HttpError(400, "invalid_grant", "Authorization code is expired or already used.");
        }
        // PKCE verification (skipped only when the code carries no challenge,
        // which confidential clients may omit at authorize time).
        if (row.codeChallenge) {
          const verifier = str(body.code_verifier);
          const ok = row.codeChallengeMethod === "S256"
            ? verifier !== "" && pkceS256(verifier) === row.codeChallenge
            : verifier === row.codeChallenge;
          if (!ok) {
            throw new HttpError(400, "invalid_grant", "PKCE code_verifier does not match the challenge.");
          }
        }
        const claimed = await s.claimCode(sha256hex(code));
        if (!claimed) {
          throw new HttpError(400, "invalid_grant", "Authorization code is expired or already used.");
        }
        const accessToken = randomUUID() + randomUUID();
        const refreshToken = randomUUID() + randomUUID();
        await s.createToken({
          id: randomUUID(),
          clientId: client.clientId,
          userId: row.userId,
          scope: row.scope,
          accessTokenHash: sha256hex(accessToken),
          refreshTokenHash: sha256hex(refreshToken),
          accessExpiresAt: new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
          refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
          revokedAt: null,
        });
        await auditLog(row.userId, "oauth_authorized", "oauth_clients", client.clientId, {
          scopes: row.scope,
        }).catch(() => { /* audit is best-effort */ });
        sendJson(ctx.res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: Math.floor(ACCESS_TTL_MS / 1000),
          refresh_token: refreshToken,
          scope: row.scope.join(" "),
        });
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = str(body.refresh_token);
        if (!refreshToken) {
          throw new HttpError(400, "invalid_request", "refresh_token is required.");
        }
        const client = await authenticateClient(ctx, body);
        if (!client) {
          throw new HttpError(401, "invalid_client", "Client authentication failed.");
        }
        const row = await s.findTokenByRefreshHash(sha256hex(refreshToken));
        if (!row || row.clientId !== client.clientId || row.revokedAt) {
          throw new HttpError(400, "invalid_grant", "Refresh token is invalid.");
        }
        if (new Date(row.refreshExpiresAt).getTime() <= Date.now()) {
          throw new HttpError(400, "invalid_grant", "Refresh token is expired.");
        }
        // Rotation: the old refresh token stops matching after this update.
        const accessToken = randomUUID() + randomUUID();
        const newRefreshToken = randomUUID() + randomUUID();
        const rotated = await s.rotateToken(row.id, sha256hex(accessToken), sha256hex(newRefreshToken),
          new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
          new Date(Date.now() + REFRESH_TTL_MS).toISOString());
        if (!rotated) {
          throw new HttpError(400, "invalid_grant", "Refresh token is invalid.");
        }
        await auditLog(row.userId, "oauth_token_refreshed", "oauth_clients", client.clientId, {
          scopes: row.scope,
        }).catch(() => { /* audit is best-effort */ });
        sendJson(ctx.res, 200, {
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: Math.floor(ACCESS_TTL_MS / 1000),
          refresh_token: newRefreshToken,
          scope: row.scope.join(" "),
        });
        return;
      }

      throw new HttpError(400, "unsupported_grant_type", `Grant type not supported: ${grantType || "(missing)"}`);
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /oauth/revoke (RFC 7009, best effort) ---
  route("POST", "/oauth/revoke", async (ctx) => {
    try {
      if (!checkRateLimit(`oauth:revoke:${clientIp(ctx)}`, 30, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many revocation attempts — wait a minute and try again.");
      }
      const body = asRecord(ctx.body);
      const token = str(body.token);
      if (token) {
        const s = await oauthStore();
        const byAccess = await s.findTokenByAccessHash(sha256hex(token));
        const row = byAccess ?? await s.findTokenByRefreshHash(sha256hex(token));
        if (row && !row.revokedAt) {
          await s.revokeToken(row.id);
          await auditLog(row.userId, "oauth_token_revoked", "oauth_clients", row.clientId, {}).catch(() => { /* best-effort */ });
        }
      }
      // RFC 7009 §2.2.1: unknown tokens still return 200.
      sendJson(ctx.res, 200, { ok: true });
    } catch (err) { fail(ctx, err); }
  });
}
