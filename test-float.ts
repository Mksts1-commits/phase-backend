/**
 * test-float.ts — end-to-end coverage for the float-increase route
 * (float.ts) plus the corrected sold math (coinFloatPosition).
 *
 * Run:  cd ~/workspace/fresh-clones/backend && npx tsx test-float.ts
 *
 * Fully hermetic (no DATABASE_URL): in-memory issuance store + ledger
 * (same pattern as test-agent-interface.ts). No network, no production
 * data, no secrets — the only credentials here are throwaway test
 * passwords.
 *
 * Flow covered: signup → draft → sign → mint (50/50 split, 100,000
 * shares: 50,000 retained, 50,000 genesis float) → non-owner 403 →
 * shares 0 / fraction / negative 400 → exceeds balance 409 → unknown
 * coin 404 → success queues transfer + increments released + returns
 * projections → idempotent replay returns the same tx_id without a
 * second transfer or a second release → sequencer confirms → live
 * float balance moves → simulated sale via settleFloatTransfer →
 * sold math proves the fix: sold = (genesis + released) - balance
 * (the old formula would have understated it).
 */
import * as crypto from "node:crypto";
import {
  b58encode,
  startSequencerLoop,
  settleFloatTransfer,
  PUBLIC_FLOAT_ADDRESS,
  getChainBalance,
} from "./sovereign-ledger-core.js";
import { mountAuthRoutes } from "./auth.js";
import { mountIssuanceRoutes } from "./issuance.js";
import { mountMarketplaceRoutes } from "./marketplace.js";
import { mountOffersRoutes } from "./offers.js";
import { mountCoinEditRoutes } from "./coin-edit.js";
import { mountAgentInterfaceRoutes } from "./agent-interface.js";
import { mountFloatRoutes } from "./float.js";

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
function ph1(): string {
  return "ph1" + b58encode(crypto.randomBytes(32));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- fake HTTP plumbing (same pattern as test-agent-interface.ts) ---------
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
mountIssuanceRoutes(deps);
mountMarketplaceRoutes(deps);
mountOffersRoutes(deps);
mountCoinEditRoutes(deps);
mountAgentInterfaceRoutes(deps);
mountFloatRoutes(deps);

async function call(method: string, path: string, body: any = {}, headers: Record<string, string> = {}, query = "") {
  const res: any = {};
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
  return res as { status: number; body: any };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function main() {
  console.log("float-increase tests (in-memory)");
  const sequencer = startSequencerLoop();

  const mkUser = async (name: string, email: string) => {
    const r = await call("POST", "/api/v1/auth/signup", { name, email, password: "test-password-123" });
    ok(`signup ${name} 201`, r.status === 201 && !!r.body.token, JSON.stringify(r.body).slice(0, 140));
    return { userId: r.body.userId as string, token: r.body.token as string };
  };
  const seller = await mkUser("Seller", "seller-float@example.com");
  const buyer = await mkUser("Buyer", "buyer-float@example.com");
  const sellerAddr = ph1();
  const buyerAddr = ph1();

  // --- mint a 50/50 coin: 100,000 shares, 50,000 retained, 50,000 float ---
  let r = await call("POST", "/api/v1/issuance/draft", {
    name: "Float Coin", ticker: "FLT", tagline: "For my community",
    valueThesis: "Community membership and perks.", category: "Creator",
    equityPublic: 50, equityRetained: 50, priceUsd: 2.5, totalShares: 100000,
    socialProfiles: [{ platform: "tiktok", url: "https://tiktok.com/@flt" }],
  }, auth(seller.token));
  ok("draft 201", r.status === 201 && !!r.body.draftId, JSON.stringify(r.body).slice(0, 140));
  const draftId = r.body.draftId;
  r = await call("GET", "/api/v1/issuance/agreement", {}, auth(seller.token), `draftId=${draftId}`);
  ok("agreement 200", r.status === 200 && typeof r.body.agreementText === "string");
  r = await call("POST", "/api/v1/issuance/sign",
    { draftId, legalName: "Seller Legal Name", accepted: true }, auth(seller.token));
  ok("sign 201", r.status === 201 && !!r.body.signatureId, JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", "/api/v1/issuance/mint",
    { draftId, issuerAddress: sellerAddr, totalShares: 100000 },
    { ...auth(seller.token), "idempotency-key": "mint-flt-1" });
  ok("mint 201", r.status === 201 && !!r.body.coin?.id, JSON.stringify(r.body).slice(0, 200));
  const coinId: string = r.body.coin.id;
  const chainId: string = r.body.coin.mintAddress;
  ok("genesis retained 50000", getChainBalance(chainId, sellerAddr) === "50000", getChainBalance(chainId, sellerAddr));
  ok("genesis float 50000", getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS) === "50000");

  const floatPath = `/api/v1/coins/${coinId}/float/increase`;

  // --- validation + auth failures ------------------------------------------
  r = await call("POST", floatPath, { shares: 100 }, auth(buyer.token));
  ok("non-owner 403", r.status === 403 && r.body.error === "forbidden", JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", floatPath, { shares: 0 }, auth(seller.token));
  ok("shares 0 → 400 invalid_amount", r.status === 400 && r.body.error === "invalid_amount", JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", floatPath, { shares: 1.5 }, auth(seller.token));
  ok("shares fraction → 400 invalid_amount", r.status === 400 && r.body.error === "invalid_amount", JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", floatPath, { shares: -5 }, auth(seller.token));
  ok("shares negative → 400 invalid_amount", r.status === 400 && r.body.error === "invalid_amount", JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", floatPath, { shares: 50001 }, auth(seller.token));
  ok("exceeds balance → 409 insufficient_balance", r.status === 409 && r.body.error === "insufficient_balance", JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", "/api/v1/coins/nope/float/increase", { shares: 10 }, auth(seller.token));
  ok("unknown coin 404", r.status === 404 && r.body.error === "coin_not_found", JSON.stringify(r.body).slice(0, 140));
  r = await call("POST", floatPath, { shares: 100 }, {});
  ok("no auth 401", r.status === 401, JSON.stringify(r.body).slice(0, 140));

  // --- success + idempotent replay ------------------------------------------
  r = await call("POST", floatPath, { shares: 10000 },
    { ...auth(seller.token), "idempotency-key": "float-1" });
  ok("increase 200", r.status === 200 && !!r.body.tx_id && r.body.status === "pending", JSON.stringify(r.body).slice(0, 200));
  const txId = r.body.tx_id as string;
  ok("projected float 60000", r.body.projectedFloatAvailable === "60000", JSON.stringify(r.body).slice(0, 200));
  ok("projected retained 40000", r.body.projectedRetained === "40000", JSON.stringify(r.body).slice(0, 200));
  ok("projected float pct 60", r.body.projectedFloatPct === 60, JSON.stringify(r.body).slice(0, 200));

  r = await call("POST", floatPath, { shares: 10000 },
    { ...auth(seller.token), "idempotency-key": "float-1" });
  ok("replay same tx_id", r.status === 200 && r.body.tx_id === txId && r.body.idempotentReplay === true, JSON.stringify(r.body).slice(0, 200));

  // Released counted exactly once (not twice after the replay).
  r = await call("GET", "/api/v1/issuance/coins", {}, auth(seller.token));
  const listed = (r.body.coins || []).find((c: any) => c.id === coinId);
  ok("released 10000 after replay", listed?.floatReleasedUnits === "10000", JSON.stringify(listed).slice(0, 300));

  // --- sequencer confirms: live float moves, sold still 0 -------------------
  await sleep(4500);
  ok("confirmed float 60000", getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS) === "60000", getChainBalance(chainId, PUBLIC_FLOAT_ADDRESS));
  ok("confirmed retained 40000", getChainBalance(chainId, sellerAddr) === "40000");
  r = await call("GET", "/api/v1/issuance/coins", {}, auth(seller.token));
  const afterConfirm = (r.body.coins || []).find((c: any) => c.id === coinId);
  ok("floatAvailableUnits 60000", afterConfirm?.floatAvailableUnits === "60000", JSON.stringify(afterConfirm).slice(0, 300));
  ok("publicFloatUnits 60000 (genesis + released)", afterConfirm?.publicFloatUnits === "60000", JSON.stringify(afterConfirm).slice(0, 300));
  ok("sold 0 after confirm", afterConfirm?.publicFloatSoldUnits === "0", JSON.stringify(afterConfirm).slice(0, 300));

  // --- simulated sale: 20000 units leave the float ---------------------------
  await settleFloatTransfer(chainId, buyerAddr, "20000", "test sale");
  await sleep(4500);
  r = await call("GET", "/api/v1/issuance/coins", {}, auth(seller.token));
  const afterSale = (r.body.coins || []).find((c: any) => c.id === coinId);
  ok("floatAvailableUnits 40000 after sale", afterSale?.floatAvailableUnits === "40000", JSON.stringify(afterSale).slice(0, 300));
  // The fix: sold = (50000 + 10000) - 40000 = 20000. The old formula
  // (genesis - balance, clamped) would have reported 10000.
  ok("sold 20000 (not old-formula 10000)", afterSale?.publicFloatSoldUnits === "20000", JSON.stringify(afterSale).slice(0, 300));

  // --- agent dashboard position carries the same fields ----------------------
  r = await call("GET", "/api/v1/agent/dashboard", {}, auth(seller.token));
  const dashCoin = (r.body.myCoins || []).find((c: any) => c.ticker === "FLT");
  const pos = dashCoin?.position;
  ok("dashboard floatAvailableUnits 40000", pos?.floatAvailableUnits === "40000", JSON.stringify(dashCoin).slice(0, 300));
  ok("dashboard sold 20000", pos?.publicFloatSoldUnits === "20000", JSON.stringify(dashCoin).slice(0, 300));

  clearInterval(sequencer);
  console.log(`\nfloat tests: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
