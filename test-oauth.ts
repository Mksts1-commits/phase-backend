/**
 * test-oauth.ts — end-to-end coverage for the OAuth 2.0 authorization
 * server (oauth.ts) plus the scope enforcement on agent endpoints.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-oauth.ts
 *
 * Fully hermetic (no DATABASE_URL): in-memory stores, fake HTTP plumbing
 * (same pattern as test-agent-interface.ts). No network, no production
 * data, no secrets — the only credentials here are throwaway test
 * passwords and locally generated PKCE verifiers.
 *
 * Flow covered: register (public + confidential, validation) → metadata
 * → authorize page → deny → allow → code exchange with PKCE → dashboard
 * with the OAuth token (200) → scope-gated write without the scope (403)
 * → refresh + rotation (old refresh rejected) → code reuse (rejected) →
 * wrong PKCE verifier (rejected) → revoke → confidential-client exchange
 * (wrong secret rejected, right secret accepted) → session Bearer flow
 * still works → public marketplace still anonymous.
 *
 * NOT covered here (time-based, would need a 10-minute wait): code
 * expiry and access/refresh token expiry. The expiry checks are the same
 * Date comparisons as the session flow and are exercised by the
 * used/revoked rejection paths.
 */
import * as crypto from "node:crypto";
import { b58encode, startSequencerLoop } from "./sovereign-ledger-core.js";
import { mountAuthRoutes } from "./auth.js";
import { mountOAuthRoutes } from "./oauth.js";
import { mountIssuanceRoutes } from "./issuance.js";
import { mountMarketplaceRoutes } from "./marketplace.js";
import { mountOffersRoutes } from "./offers.js";
import { mountCoinEditRoutes } from "./coin-edit.js";
import { mountAgentInterfaceRoutes } from "./agent-interface.js";

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

// --- fake HTTP plumbing (same pattern as test-agent-interface.ts) ---------
// Extended so HTML routes (GET /oauth/authorize, which uses writeHead/end
// like legal-docs.ts) can be captured too.
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
mountOAuthRoutes(deps);
mountIssuanceRoutes(deps);
mountMarketplaceRoutes(deps);
mountOffersRoutes(deps);
mountCoinEditRoutes(deps);
mountAgentInterfaceRoutes(deps);

async function call(method: string, path: string, body: any = {}, headers: Record<string, string> = {}, query = "") {
  const chunks: string[] = [];
  const res: any = {
    writeHead(status: number, hdrs: Record<string, string>) { res.status = status; res.headers = hdrs; },
    end(chunk?: string) { if (chunk) chunks.push(chunk); res.rawBody = chunks.join(""); },
  };
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
  return res as { status: number; body: any; headers?: Record<string, string>; rawBody?: string };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const b64url = (s: string) => crypto.createHash("sha256").update(s).digest("base64url");
const redirectParams = (url: string) => new URL(url).searchParams;

async function main() {
  console.log("oauth tests (in-memory)");
  const sequencer = startSequencerLoop();

  // --- metadata -------------------------------------------------------------
  let r = await call("GET", "/.well-known/oauth-authorization-server");
  ok("metadata 200", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  ok("metadata issuer", r.body.issuer === "https://phase-backend.onrender.com");
  ok("metadata endpoints", r.body.authorization_endpoint === "https://phase-backend.onrender.com/oauth/authorize"
    && r.body.token_endpoint === "https://phase-backend.onrender.com/oauth/token"
    && r.body.registration_endpoint === "https://phase-backend.onrender.com/oauth/register"
    && r.body.revocation_endpoint === "https://phase-backend.onrender.com/oauth/revoke");
  ok("metadata scopes", Array.isArray(r.body.scopes_supported)
    && ["read:coins", "read:portfolio", "read:dashboard", "write:listings", "write:orders", "write:coin-profile", "write:watchlist", "write:offers"]
      .every((s) => r.body.scopes_supported.includes(s)));
  ok("metadata pkce", Array.isArray(r.body.code_challenge_methods_supported)
    && r.body.code_challenge_methods_supported.includes("S256"));

  // --- registration -----------------------------------------------------------
  r = await call("POST", "/oauth/register", {
    client_name: "Test Agent Client", redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
  });
  ok("register public 201", r.status === 201 && !!r.body.client_id && !r.body.client_secret, JSON.stringify(r.body).slice(0, 160));
  const publicClient = r.body.client_id as string;

  r = await call("POST", "/oauth/register", {
    client_name: "Bad Redirect", redirect_uris: ["http://evil.example/cb"],
  });
  ok("register bad redirect 400", r.status === 400 && r.body.error === "invalid_redirect_uri");
  r = await call("POST", "/oauth/register", {
    client_name: "Bad Scope", redirect_uris: ["https://client.example/callback"], scope: "read:everything",
  });
  ok("register bad scope 400", r.status === 400 && r.body.error === "invalid_scope");
  r = await call("POST", "/oauth/register", {
    client_name: "Confidential Client", redirect_uris: ["https://conf.example/cb"],
  });
  ok("register confidential 201", r.status === 201 && !!r.body.client_id && !!r.body.client_secret, JSON.stringify(r.body).slice(0, 160));
  const confClient = r.body.client_id as string;
  const confSecret = r.body.client_secret as string;

  // --- user + session flow still works ----------------------------------------
  r = await call("POST", "/api/v1/auth/signup", { name: "OAuth User", email: "oauth-user@example.com", password: "test-password-123" });
  ok("signup 201", r.status === 201 && !!r.body.token, JSON.stringify(r.body).slice(0, 140));
  const sessionToken = r.body.token as string;
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(sessionToken));
  ok("session dashboard 200", r.status === 200 && r.body.view === "dashboard");

  // --- authorize page -----------------------------------------------------------
  const verifier = "test-verifier-" + crypto.randomBytes(16).toString("hex");
  const challenge = b64url(verifier);
  const authzQ = `client_id=${publicClient}&redirect_uri=${encodeURIComponent("https://client.example/callback")}`
    + `&response_type=code&scope=${encodeURIComponent("read:dashboard")}&state=state-123`
    + `&code_challenge=${challenge}&code_challenge_method=S256`;
  r = await call("GET", "/oauth/authorize", {}, {}, authzQ);
  ok("authorize page 200", r.status === 200 && typeof r.rawBody === "string"
    && r.rawBody.includes("Test Agent Client") && r.rawBody.includes("View your dashboard"), (r.rawBody ?? "").slice(0, 120));
  r = await call("GET", "/oauth/authorize", {}, {},
    `client_id=${publicClient}&redirect_uri=${encodeURIComponent("https://not-registered.example/cb")}&response_type=code`);
  ok("authorize bad redirect page 400", r.status === 400 && (r.rawBody ?? "").includes("redirect_uri"));

  // --- deny ---------------------------------------------------------------------
  r = await call("POST", "/oauth/authorize", {
    client_id: publicClient, redirect_uri: "https://client.example/callback", response_type: "code",
    scope: "read:dashboard", state: "state-123", code_challenge: challenge, code_challenge_method: "S256",
    email: "oauth-user@example.com", password: "test-password-123", decision: "deny",
  });
  ok("deny redirects access_denied", r.status === 200 && redirectParams(r.body.redirect).get("error") === "access_denied"
    && redirectParams(r.body.redirect).get("state") === "state-123");

  // --- allow + exchange -----------------------------------------------------------
  r = await call("POST", "/oauth/authorize", {
    client_id: publicClient, redirect_uri: "https://client.example/callback", response_type: "code",
    scope: "read:dashboard", state: "state-123", code_challenge: challenge, code_challenge_method: "S256",
    email: "oauth-user@example.com", password: "test-password-123", decision: "allow",
  });
  const codeParams = redirectParams(r.body.redirect);
  ok("allow redirects code+state", r.status === 200 && !!codeParams.get("code") && codeParams.get("state") === "state-123");
  const code = codeParams.get("code")!;

  r = await call("POST", "/oauth/token", {
    grant_type: "authorization_code", code, redirect_uri: "https://client.example/callback",
    client_id: publicClient, code_verifier: verifier,
  });
  ok("token exchange 200", r.status === 200 && !!r.body.access_token && !!r.body.refresh_token
    && r.body.token_type === "Bearer" && r.body.expires_in === 3600 && r.body.scope === "read:dashboard",
    JSON.stringify(r.body).slice(0, 160));
  const accessToken = r.body.access_token as string;
  const refreshToken = r.body.refresh_token as string;

  // --- scope enforcement ------------------------------------------------------------
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(accessToken));
  ok("oauth dashboard 200", r.status === 200 && r.body.view === "dashboard");
  r = await call("POST", "/api/v1/agent/watchlist", { coinId: "nope" }, auth(accessToken));
  ok("watchlist write without scope 403", r.status === 403 && r.body.error === "insufficient_scope", JSON.stringify(r.body).slice(0, 120));

  // read:coins token: watchlist GET ok, dashboard 403
  const verifier2 = "v2-" + crypto.randomBytes(16).toString("hex");
  r = await call("POST", "/oauth/authorize", {
    client_id: publicClient, redirect_uri: "https://client.example/callback", response_type: "code",
    scope: "read:coins", state: "s2", code_challenge: b64url(verifier2), code_challenge_method: "S256",
    email: "oauth-user@example.com", password: "test-password-123", decision: "allow",
  });
  const code2 = redirectParams(r.body.redirect).get("code")!;
  r = await call("POST", "/oauth/token", {
    grant_type: "authorization_code", code: code2, redirect_uri: "https://client.example/callback",
    client_id: publicClient, code_verifier: verifier2,
  });
  const coinsToken = r.body.access_token as string;
  r = await call("GET", "/api/v1/agent/watchlist", {}, auth(coinsToken));
  ok("watchlist read with read:coins 200", r.status === 200 && r.body.view === "watchlist");
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(coinsToken));
  ok("dashboard without read:dashboard 403", r.status === 403 && r.body.error === "insufficient_scope");

  // --- refresh + rotation -------------------------------------------------------------
  r = await call("POST", "/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: publicClient });
  ok("refresh 200", r.status === 200 && !!r.body.access_token && !!r.body.refresh_token && r.body.access_token !== accessToken);
  const newRefresh = r.body.refresh_token as string;
  const newAccess = r.body.access_token as string;
  r = await call("POST", "/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, client_id: publicClient });
  ok("old refresh rejected", r.status === 400 && r.body.error === "invalid_grant");
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(newAccess));
  ok("rotated access works", r.status === 200);

  // --- code reuse -------------------------------------------------------------------------
  r = await call("POST", "/oauth/token", {
    grant_type: "authorization_code", code, redirect_uri: "https://client.example/callback",
    client_id: publicClient, code_verifier: verifier,
  });
  ok("code reuse rejected", r.status === 400 && r.body.error === "invalid_grant");

  // --- wrong PKCE verifier -------------------------------------------------------------------
  const verifier3 = "v3-" + crypto.randomBytes(16).toString("hex");
  r = await call("POST", "/oauth/authorize", {
    client_id: publicClient, redirect_uri: "https://client.example/callback", response_type: "code",
    scope: "read:dashboard", state: "s3", code_challenge: b64url(verifier3), code_challenge_method: "S256",
    email: "oauth-user@example.com", password: "test-password-123", decision: "allow",
  });
  const code3 = redirectParams(r.body.redirect).get("code")!;
  r = await call("POST", "/oauth/token", {
    grant_type: "authorization_code", code: code3, redirect_uri: "https://client.example/callback",
    client_id: publicClient, code_verifier: "wrong-verifier",
  });
  ok("wrong PKCE rejected", r.status === 400 && r.body.error === "invalid_grant");

  // --- revoke ----------------------------------------------------------------------------------
  r = await call("POST", "/oauth/revoke", { token: newRefresh });
  ok("revoke 200", r.status === 200 && r.body.ok === true);
  r = await call("POST", "/oauth/token", { grant_type: "refresh_token", refresh_token: newRefresh, client_id: publicClient });
  ok("revoked refresh rejected", r.status === 400 && r.body.error === "invalid_grant");

  // --- confidential client ----------------------------------------------------------------------
  const verifier4 = "v4-" + crypto.randomBytes(16).toString("hex");
  r = await call("POST", "/oauth/authorize", {
    client_id: confClient, redirect_uri: "https://conf.example/cb", response_type: "code",
    scope: "read:dashboard", state: "s4", code_challenge: b64url(verifier4), code_challenge_method: "S256",
    email: "oauth-user@example.com", password: "test-password-123", decision: "allow",
  });
  const code4 = redirectParams(r.body.redirect).get("code")!;
  r = await call("POST", "/oauth/token", {
    grant_type: "authorization_code", code: code4, redirect_uri: "https://conf.example/cb",
    client_id: confClient, client_secret: "wrong-secret", code_verifier: verifier4,
  });
  ok("confidential wrong secret 401", r.status === 401 && r.body.error === "invalid_client");
  r = await call("POST", "/oauth/token", {
    grant_type: "authorization_code", code: code4, redirect_uri: "https://conf.example/cb",
    client_id: confClient, client_secret: confSecret, code_verifier: verifier4,
  });
  ok("confidential exchange 200", r.status === 200 && !!r.body.access_token);

  // --- public endpoints unaffected ------------------------------------------------------------------
  r = await call("GET", "/api/v1/agent/marketplace", {}, {});
  ok("marketplace anonymous 200", r.status === 200 && r.body.view === "marketplace");
  r = await call("GET", "/api/v1/agent/marketplace", {}, auth(accessToken));
  ok("marketplace with oauth token 200", r.status === 200 && r.body.view === "marketplace");

  clearInterval(sequencer as unknown as NodeJS.Timeout);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("oauth tests crashed:", err);
  process.exit(2);
});
