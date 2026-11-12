/**
 * creators.ts — public creator lookup (TikTok first).
 *
 *   GET /api/v1/creators/lookup?username=phase.app.apk
 *
 * Read-only proxy to the standalone Creator Lookup service
 * (services/creator-lookup/), which reads the PUBLIC TikTok profile
 * page for a handle (no login, no API key) and returns normalized
 * profile data plus the same conveniences the business lookup offers:
 * { query, profile, snapshotParams, snapshotLink, draftSeed,
 *   attribution }. An agent can autopopulate a Creator-path coin from
 * a single handle: draftSeed carries the name, a suggested ticker,
 * the bio as tagline, and the profile URL as reference + social.
 *
 * Public like the marketplace (published profile facts only, no
 * auth), rate-limited per IP. When CREATOR_LOOKUP_URL is not
 * configured the route answers 503 so agents fall back to the plain
 * intake flow.
 */
import { checkRateLimit as sharedCheckRateLimit, clientIpFromHeaders } from "./rate-limit.js";

export interface CreatorMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => Promise<void>) => void;
  sendJson: (res: any, status: number, body: unknown) => void;
  HttpError: new (status: number, code: string, message: string) => Error;
}

class CreatorHttpError extends Error {
  statusCode: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

interface CreatorCtx {
  req: { headers: Record<string, string | string[] | undefined>; url?: string };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export function mountCreatorRoutes(deps: CreatorMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof CreatorHttpError;

  const fail = (ctx: CreatorCtx, err: unknown): void => {
    if (err instanceof CreatorHttpError || err instanceof HttpError) {
      const e = err as CreatorHttpError;
      sendJson(ctx.res, e.statusCode ?? 500,
        { error: e.code ?? "error", message: e.message });
      return;
    }
    console.error("[creators]", err);
    sendJson(ctx.res, 500, { error: "internal", message: "Internal error." });
  };

  route("GET", "/api/v1/creators/lookup", async (ctx: CreatorCtx) => {
    try {
      const ip = clientIpFromHeaders(ctx.req.headers);
      if (!sharedCheckRateLimit(`creatorlookup:${ip}`, 60, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many lookups; slow down.");
      }
      const username = (ctx.query.get("username") ?? "").trim();
      if (!username) {
        throw new HttpError(400, "missing_username",
          "Query parameter `username` (TikTok handle) is required.");
      }
      const base = (process.env.CREATOR_LOOKUP_URL ?? "").replace(/\/+$/, "");
      if (!base) {
        throw new HttpError(503, "creator_lookup_not_configured",
          "Creator lookup is not configured on this deployment.");
      }
      const upstream = new URL(`${base}/lookup`);
      upstream.searchParams.set("username", username);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      let resp: Response;
      try {
        resp = await fetch(upstream, {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
      } catch {
        throw new HttpError(502, "creator_lookup_unavailable",
          "Creator lookup service did not respond.");
      } finally {
        clearTimeout(timer);
      }
      if (resp.status === 404) {
        throw new HttpError(404, "creator_not_found",
          "No TikTok creator with that username.");
      }
      if (!resp.ok) {
        throw new HttpError(502, "creator_lookup_unavailable",
          `Creator lookup service returned ${resp.status}.`);
      }
      const data: unknown = await resp.json();
      sendJson(ctx.res, 200, data);
    } catch (err) {
      fail(ctx, err);
    }
  });
}
