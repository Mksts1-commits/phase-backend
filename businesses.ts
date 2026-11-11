/**
 * businesses.ts — public business lookup.
 *
 *   GET /api/v1/businesses/lookup?q=Aladdin+Shawarma&city=Vaughan&region=ON&country=CA
 *
 * Read-only proxy to the standalone Business Lookup service
 * (services/business-lookup/), which serves the Overture Maps Places
 * store for the US + Canada (~19.4M open businesses). The backend holds
 * no copy of the multi-GB store itself; it forwards the query to
 * BUSINESS_LOOKUP_URL and returns the service's JSON unchanged:
 * { query, matches[], snapshotParams, snapshotLink, draftSeed,
 *   ambiguous, attribution }.
 *
 * Public like the marketplace (published business facts only, no auth),
 * rate-limited per IP. When BUSINESS_LOOKUP_URL is not configured the
 * route answers 503 so agents fall back to the plain intake flow.
 */
import { checkRateLimit as sharedCheckRateLimit, clientIpFromHeaders } from "./rate-limit.js";

export interface BusinessMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => Promise<void>) => void;
  sendJson: (res: any, status: number, body: unknown) => void;
  HttpError: new (status: number, code: string, message: string) => Error;
}

class BusinessHttpError extends Error {
  statusCode: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

interface BusinessCtx {
  req: { headers: Record<string, string | string[] | undefined>; url?: string };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export function mountBusinessRoutes(deps: BusinessMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof BusinessHttpError;

  const fail = (ctx: BusinessCtx, err: unknown): void => {
    if (err instanceof BusinessHttpError || err instanceof HttpError) {
      const e = err as BusinessHttpError;
      sendJson(ctx.res, e.statusCode ?? 500,
        { error: e.code ?? "error", message: e.message });
      return;
    }
    console.error("[businesses]", err);
    sendJson(ctx.res, 500, { error: "internal", message: "Internal error." });
  };

  route("GET", "/api/v1/businesses/lookup", async (ctx: BusinessCtx) => {
    try {
      const ip = clientIpFromHeaders(ctx.req.headers);
      if (!sharedCheckRateLimit(`bizlookup:${ip}`, 60, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many lookups; slow down.");
      }
      const q = (ctx.query.get("q") ?? "").trim();
      if (!q) {
        throw new HttpError(400, "missing_q",
          "Query parameter `q` (business name) is required.");
      }
      const base = (process.env.BUSINESS_LOOKUP_URL ?? "").replace(/\/+$/, "");
      if (!base) {
        throw new HttpError(503, "lookup_not_configured",
          "Business lookup is not configured on this deployment.");
      }
      const upstream = new URL(`${base}/lookup`);
      upstream.searchParams.set("q", q);
      for (const k of ["city", "region", "country", "limit"] as const) {
        const v = ctx.query.get(k);
        if (v) upstream.searchParams.set(k, v);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      let resp: Response;
      try {
        resp = await fetch(upstream, {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
      } catch {
        throw new HttpError(502, "lookup_unavailable",
          "Business lookup service did not respond.");
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        throw new HttpError(502, "lookup_unavailable",
          `Business lookup service returned ${resp.status}.`);
      }
      const data: unknown = await resp.json();
      sendJson(ctx.res, 200, data);
    } catch (err) {
      fail(ctx, err);
    }
  });
}
