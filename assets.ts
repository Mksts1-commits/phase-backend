/**
 * assets.ts — public real-estate (property) lookup.
 *
 *   GET /api/v1/assets/lookup?address=13311+Yonge+St,+Richmond+Hill,+ON&value=850000
 *
 * Read-only proxy to the property endpoint of the standalone lookup
 * service (services/business-lookup/, BUSINESS_LOOKUP_URL), which
 * resolves a full address via OpenStreetMap/Nominatim to a normalized
 * property record: { query, matches[], economics, snapshotParams,
 * snapshotLink, draftSeed, ambiguous, attribution }. The seed carries
 * category "Real Estate" with a Residential/Commercial subsection when
 * the map data says which. An optional `value` (the owner's estimate of
 * the property's worth) anchors the suggested market cap in the
 * snapshot economics; without it the Phase standard $100K applies.
 *
 * Public like the marketplace (published map facts only, no auth),
 * rate-limited per IP. When BUSINESS_LOOKUP_URL is not configured the
 * route answers 503 so agents fall back to the plain intake flow.
 */
import { checkRateLimit as sharedCheckRateLimit, clientIpFromHeaders } from "./rate-limit.js";

export interface AssetMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => Promise<void>) => void;
  sendJson: (res: any, status: number, body: unknown) => void;
  HttpError: new (status: number, code: string, message: string) => Error;
}

class AssetHttpError extends Error {
  statusCode: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

interface AssetCtx {
  req: { headers: Record<string, string | string[] | undefined>; url?: string };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export function mountAssetRoutes(deps: AssetMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof AssetHttpError;

  const fail = (ctx: AssetCtx, err: unknown): void => {
    if (err instanceof AssetHttpError || err instanceof HttpError) {
      const e = err as AssetHttpError;
      sendJson(ctx.res, e.statusCode ?? 500,
        { error: e.code ?? "error", message: e.message });
      return;
    }
    console.error("[assets]", err);
    sendJson(ctx.res, 500, { error: "internal", message: "Internal error." });
  };

  route("GET", "/api/v1/assets/lookup", async (ctx: AssetCtx) => {
    try {
      const ip = clientIpFromHeaders(ctx.req.headers);
      if (!sharedCheckRateLimit(`assetlookup:${ip}`, 60, 60_000)) {
        throw new HttpError(429, "rate_limited", "Too many lookups; slow down.");
      }
      const address = (ctx.query.get("address") ?? "").trim();
      if (!address) {
        throw new HttpError(400, "missing_address",
          "Query parameter `address` (full property address) is required.");
      }
      const base = (process.env.BUSINESS_LOOKUP_URL ?? "").replace(/\/+$/, "");
      if (!base) {
        throw new HttpError(503, "asset_lookup_not_configured",
          "Asset lookup is not configured on this deployment.");
      }
      const upstream = new URL(`${base}/property`);
      upstream.searchParams.set("address", address);
      const value = ctx.query.get("value");
      if (value) upstream.searchParams.set("value", value);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      let resp: Response;
      try {
        resp = await fetch(upstream, {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
      } catch {
        throw new HttpError(502, "asset_lookup_unavailable",
          "Asset lookup service did not respond.");
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        throw new HttpError(502, "asset_lookup_unavailable",
          `Asset lookup service returned ${resp.status}.`);
      }
      const data: unknown = await resp.json();
      sendJson(ctx.res, 200, data);
    } catch (err) {
      fail(ctx, err);
    }
  });
}
