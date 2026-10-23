/**
 * test-issuance-supply.ts — hermetic coverage for the draft-carried supply
 * fix (agreement §2 truthfulness).
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-issuance-supply.ts
 *
 * Fully hermetic (no DATABASE_URL): mounts auth + issuance on the
 * in-memory store and walks real draft -> agreement -> sign -> mint flows.
 *
 * The bug this guards: the agreement's Share Split section used to print
 * a hardcoded "1,000,000 shares" because the supply was only chosen at
 * mint time, after signing. Now the supply is fixed on the draft
 * (explicit, or derived as $100k default cap / price), the agreement
 * prints the draft's real number + split counts, and mint must match
 * the signed supply (422 supply_mismatch otherwise). Legacy drafts
 * (totalShares null) keep the old wording and mint-time supply choice.
 */
import * as crypto from "node:crypto";
import { b58encode, startSequencerLoop } from "./sovereign-ledger-core.js";
import { mountAuthRoutes } from "./auth.js";
import {
  mountIssuanceRoutes,
  getIssuanceStore,
  renderAgreementText,
  sha256Hex,
} from "./issuance.js";

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

// --- fake HTTP plumbing (same pattern as test-agent-interface.ts) --------
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

async function call(method: string, path: string, body: any = {}, headers: Record<string, string> = {}, query = "") {
  const res: any = {};
  const h = handlers.get(`${method} ${path}`);
  if (!h) throw new Error(`no handler for ${method} ${path}`);
  await h({ req: { headers }, res, params: {}, query: new URLSearchParams(query), body });
  return res as { status: number; body: any };
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function main() {
  console.log("issuance supply tests (in-memory)");
  const sequencer = startSequencerLoop();

  const mkUser = async (name: string, email: string) => {
    const r = await call("POST", "/api/v1/auth/signup", { name, email, password: "test-password-123" });
    ok(`signup ${name} 201`, r.status === 201 && !!r.body.token, JSON.stringify(r.body).slice(0, 140));
    return { userId: r.body.userId as string, token: r.body.token as string };
  };
  const alice = await mkUser("Alice", "alice-supply@example.com");
  const bob = await mkUser("Bob", "bob-supply@example.com");

  const draft = async (token: string, body: any) =>
    call("POST", "/api/v1/issuance/draft", body, auth(token));
  const agreement = async (token: string, draftId: string) =>
    call("GET", "/api/v1/issuance/agreement", {}, auth(token), `draftId=${draftId}`);
  const sign = async (token: string, draftId: string) =>
    call("POST", "/api/v1/issuance/sign", { draftId, legalName: "Legal Name", accepted: true }, auth(token));
  const mint = async (token: string, body: any, key: string) =>
    call("POST", "/api/v1/issuance/mint", body, { ...auth(token), "idempotency-key": key });

  // --- 1. explicit totalShares on the draft -------------------------------
  let r = await draft(alice.token, {
    name: "Explicit Coin", ticker: "EXP1", valueThesis: "Explicit supply.",
    equityPublic: 5, equityRetained: 95, priceUsd: 0.25, totalShares: 500000,
  });
  ok("explicit draft 201 + totalShares stored",
    r.status === 201 && r.body.draft?.totalShares === 500000, JSON.stringify(r.body).slice(0, 160));
  r = await agreement(alice.token, r.body.draftId);
  ok("agreement prints explicit supply + split counts",
    r.status === 200
      && r.body.agreementText.includes("500,000 shares of the Coin are minted")
      && r.body.agreementText.includes("5% (25,000 shares) allocated to the public float")
      && r.body.agreementText.includes("95% (475,000 shares) retained by Issuer"),
    (r.body.agreementText ?? "").split("\n").slice(10, 14).join(" | "));

  // --- 2. derived supply: $0.25 -> 400,000 (the original bug report) -------
  r = await draft(alice.token, {
    name: "Derived Coin", ticker: "DRV1", valueThesis: "Derived supply.",
    equityPublic: 5, equityRetained: 95, priceUsd: 0.25,
  });
  ok("derived draft totalShares = 400,000 at $0.25",
    r.status === 201 && r.body.draft?.totalShares === 400000, JSON.stringify(r.body).slice(0, 160));
  const derivedDraftId = r.body.draftId;
  r = await agreement(alice.token, derivedDraftId);
  ok("agreement prints derived 400,000 + 20,000 / 380,000 split",
    r.status === 200
      && r.body.agreementText.includes("400,000 shares of the Coin are minted")
      && r.body.agreementText.includes("5% (20,000 shares) allocated to the public float")
      && r.body.agreementText.includes("95% (380,000 shares) retained by Issuer"),
    (r.body.agreementText ?? "").split("\n").slice(10, 14).join(" | "));
  const derivedHash = r.body.agreementHash;

  // --- 3. invalid explicit supply ------------------------------------------
  r = await draft(alice.token, { name: "Bad", ticker: "BAD1", priceUsd: 1, totalShares: 999 });
  ok("totalShares 999 -> 422 invalid_total_shares",
    r.status === 422 && r.body.error === "invalid_total_shares", JSON.stringify(r.body).slice(0, 140));
  r = await draft(alice.token, { name: "Bad", ticker: "BAD2", priceUsd: 1, totalShares: 1000.5 });
  ok("totalShares 1000.5 -> 422 invalid_total_shares",
    r.status === 422 && r.body.error === "invalid_total_shares", JSON.stringify(r.body).slice(0, 140));

  // --- 4. sign + mint with NO body supply uses the signed supply -----------
  r = await sign(alice.token, derivedDraftId);
  ok("sign derived draft 201 + hash matches agreement",
    r.status === 201 && r.body.agreementHash === derivedHash, JSON.stringify(r.body).slice(0, 140));
  r = await mint(alice.token, { draftId: derivedDraftId, issuerAddress: ph1() }, "mint-drv-1");
  ok("mint without body supply 201 at signed 400,000",
    r.status === 201 && r.body.coin?.totalShares === 400000
      && r.body.coin?.retainedShares === 380000 && r.body.coin?.supply === "400000",
    JSON.stringify(r.body).slice(0, 200));

  // --- 5. derived supply at the $0.50 Phase default -------------------------
  r = await draft(bob.token, {
    name: "Default Coin", ticker: "DFT1", valueThesis: "Default supply.",
    equityPublic: 5, equityRetained: 95, priceUsd: 0.5,
  });
  ok("derived draft totalShares = 200,000 at $0.50",
    r.status === 201 && r.body.draft?.totalShares === 200000, JSON.stringify(r.body).slice(0, 160));
  r = await agreement(bob.token, r.body.draftId);
  ok("agreement prints 200,000",
    r.status === 200 && r.body.agreementText.includes("200,000 shares of the Coin are minted"));

  // --- 6. mint with MATCHING body supply ------------------------------------
  r = await draft(bob.token, {
    name: "Match Coin", ticker: "MCH1", valueThesis: "Matching supply.",
    equityPublic: 5, equityRetained: 95, priceUsd: 0.25,
  });
  const matchDraftId = r.body.draftId;
  await sign(bob.token, matchDraftId);
  r = await mint(bob.token, { draftId: matchDraftId, issuerAddress: ph1(), totalShares: 400000 }, "mint-mch-1");
  ok("mint with matching supply 201",
    r.status === 201 && r.body.coin?.totalShares === 400000, JSON.stringify(r.body).slice(0, 200));

  // --- 7. mint with MISMATCHED body supply -> 422 -----------------------------
  r = await draft(bob.token, {
    name: "Mismatch Coin", ticker: "MSM1", valueThesis: "Mismatched supply.",
    equityPublic: 5, equityRetained: 95, priceUsd: 0.25,
  });
  const mismatchDraftId = r.body.draftId;
  await sign(bob.token, mismatchDraftId);
  r = await mint(bob.token, { draftId: mismatchDraftId, issuerAddress: ph1(), totalShares: 1000000 }, "mint-msm-1");
  ok("mint with mismatched supply -> 422 supply_mismatch",
    r.status === 422 && r.body.error === "supply_mismatch", JSON.stringify(r.body).slice(0, 200));

  // --- 8. legacy draft (no stored supply): old wording + old mint rules -----
  const store = await getIssuanceStore();
  const legacy = await store.createDraft({
    userId: bob.userId, name: "Legacy Coin", ticker: "LEG1", category: "",
    tagline: "", valueThesis: "Pre-supply-field draft.", equityPublic: 5,
    equityRetained: 95, socialProfiles: [], websiteUrl: null, priceUsd: 0.25,
    totalShares: null, idempotencyKey: null,
  });
  r = await agreement(bob.token, legacy.id);
  ok("legacy agreement keeps original 1,000,000 wording",
    r.status === 200
      && r.body.agreementText.includes("1,000,000 shares of the Coin are minted")
      && !r.body.agreementText.includes("(20,000 shares)"),
    (r.body.agreementText ?? "").split("\n").slice(10, 14).join(" | "));
  await sign(bob.token, legacy.id);
  r = await mint(bob.token, { draftId: legacy.id, issuerAddress: ph1(), totalShares: 777000 }, "mint-leg-1");
  ok("legacy mint honors body supply as before",
    r.status === 201 && r.body.coin?.totalShares === 777000, JSON.stringify(r.body).slice(0, 200));

  // --- 9. renderAgreementText unit-level guards -------------------------------
  const baseDraft: any = {
    id: "d", userId: "u", name: "Unit", ticker: "UNT", category: "", tagline: "",
    valueThesis: "V", equityPublic: 5, equityRetained: 95, socialProfiles: [],
    websiteUrl: null, priceUsd: 0.25, status: "draft", createdAt: "", updatedAt: "",
  };
  const legacyText = renderAgreementText({ ...baseDraft, totalShares: null });
  ok("render: null supply -> legacy wording",
    legacyText.includes("At genesis, 1,000,000 shares of the Coin are minted: 5% allocated"));
  const fixedText = renderAgreementText({ ...baseDraft, totalShares: 400000 });
  ok("render: 400,000 supply -> truthful wording + counts",
    fixedText.includes("At genesis, 400,000 shares of the Coin are minted: 5% (20,000 shares) allocated to the public float")
      && fixedText.includes("95% (380,000 shares) retained by Issuer"));
  ok("render: wording change changes the hash",
    sha256Hex(legacyText) !== sha256Hex(fixedText));
  const restOfText = (t: string) => t.split("\n").filter((l) => !l.includes("shares of the Coin are minted") && !l.includes("retained by Issuer")).join("\n");
  ok("render: everything outside §2 lines is identical", restOfText(legacyText) === restOfText(fixedText));

  clearInterval(sequencer as any);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
