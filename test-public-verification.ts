/**
 * test-public-verification.ts — Phase 0 acceptance test.
 *
 * Spins up an in-memory sovereign chain, submits real signed transfers, then
 * serves the NEW public routes over real HTTP and verifies every proof WITHOUT
 * an auth header, recomputing all hashes independently with raw node:crypto
 * (not the ledger core), plus a second pass through lock-proof-verify.ts
 * (the standalone third-party code path).
 *
 * No DATABASE_URL (in-memory store), no Solana network.
 * Run: npx tsx test-public-verification.ts
 */
process.env.BLOCK_INTERVAL_MS = "250";
delete process.env.DATABASE_URL;

import crypto from "node:crypto";
import http from "node:http";
import { randomUUID } from "node:crypto";

const core: any = await import("./sovereign-ledger-core.js");
const verify: any = await import("./lock-proof-verify.js");
const { mountBridgePublicRoutes } = await import("./bridge-public.js");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ---------------------------------------------------------------------------
// independent primitives (raw node:crypto only — NOT the ledger core)
// ---------------------------------------------------------------------------
const sha256 = (...bufs: Buffer[]) => {
  const h = crypto.createHash("sha256");
  for (const b of bufs) h.update(b);
  return h.digest();
};
function canonicalize(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}
// base58 (bitcoin alphabet), independent copy
const ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(buf: Buffer): string {
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of buf) num = num * 256n + BigInt(b);
  let out = "";
  while (num > 0n) { out = ALPH[Number(num % 58n)] + out; num /= 58n; }
  return ALPH[0].repeat(zeros) + out;
}
function rawPubkey(kp: crypto.KeyObject): Buffer {
  const der = kp.export({ type: "spki", format: "der" }) as Buffer;
  return der.subarray(der.length - 32);
}
const addrOf = (kp: { publicKey: crypto.KeyObject }) => "ph1" + b58encode(rawPubkey(kp.publicKey));
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function pubkeyObj(rawHex: string): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawHex, "hex")]),
    format: "der", type: "spki",
  });
}

// ---------------------------------------------------------------------------
// chain setup
// ---------------------------------------------------------------------------
const issuer = crypto.generateKeyPairSync("ed25519");
const alice = crypto.generateKeyPairSync("ed25519");
const issuerAddr = addrOf(issuer);
const aliceAddr = addrOf(alice);

const created: any = await core.createChain({
  coin_name: "Public Verification Test",
  ticker: "PVTEST",
  total_supply: "1000000",
  decimals: 0,
  equity_public_pct: 0,
  issuer_address: issuerAddr,
});
const chainId: string = created.chain_id;
console.log(`chain ${chainId}`);

core.startSequencerLoop();

async function submitSignedTransfer(from: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject }, to: string, amount: string, memo?: string) {
  const fromAddr = addrOf(from);
  // nonce: committed nonce + 1 (fresh chain in this test)
  const txId = "tx_" + randomUUID();
  const tx: any = {
    chainId, txId, type: "TRANSFER", sender: fromAddr, nonce: 1,
    payload: { to, amount, ...(memo ? { memo } : {}) },
    signatures: [], submittedAt: Date.now(),
  };
  const msg = core.signingMessage(tx);
  const sig = crypto.sign(null, msg, from.privateKey);
  const res: any = await core.submitTransaction(chainId, {
    tx_id: txId, type: "TRANSFER", sender: fromAddr, nonce: 1,
    submitted_at: tx.submittedAt, payload: tx.payload,
    signatures: [{ pubkey: rawPubkey(from.publicKey).toString("hex"), signature: sig.toString("hex") }],
  });
  if (res.status !== 202) throw new Error("submit failed: " + JSON.stringify(res.body));
  return txId;
}

async function waitConfirmed(txId: string, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const rec = core.store.txById.get(txId);
    if (rec && rec.blockHeight !== undefined) return rec;
    if (Date.now() - t0 > timeoutMs) throw new Error("tx never confirmed: " + txId);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const txId = await submitSignedTransfer(issuer, aliceAddr, "1500");
const rec = await waitConfirmed(txId);
console.log(`transfer confirmed at height ${rec.blockHeight}`);

// ---------------------------------------------------------------------------
// minimal real HTTP server mounting ONLY the public routes
// ---------------------------------------------------------------------------
type Handler = (ctx: any) => void | Promise<void>;
const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: Handler }> = [];
function compilePath(path: string) {
  const paramNames: string[] = [];
  const patternStr = path.split("/").map((seg) => {
    if (seg.startsWith(":")) { paramNames.push(seg.slice(1)); return "([^/]+)"; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  return { pattern: new RegExp(`^${patternStr}$`), paramNames };
}
class HttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
function sendJson(res: any, statusCode: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}
mountBridgePublicRoutes({
  route: (m: string, p: string, h: Handler) => routes.push({ method: m, ...compilePath(p), handler: h }),
  sendJson, HttpError: HttpError as any,
});
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const r = routes.find((rt) => rt.method === req.method && rt.pattern.test(url.pathname));
    if (!r) { sendJson(res, 404, { error: "not_found" }); return; }
    const m = url.pathname.match(r.pattern)!;
    const params: Record<string, string> = {};
    r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    await r.handler({ req, res, params, query: url.searchParams, body: {} });
  } catch (e: any) {
    sendJson(res, e.statusCode ?? 500, { error: e.code ?? "internal_error" });
  }
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;
const get = async (path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json() };
};

// ---------------------------------------------------------------------------
// the actual acceptance checks — NO auth header anywhere
// ---------------------------------------------------------------------------
console.log("public verifiability — no auth");
{
  const { status, body } = await get("/api/v1/public/chains");
  check("chains 200", status === 200);
  const c = body.chains.find((x: any) => x.chainId === chainId);
  check("chain listed", !!c, JSON.stringify(body).slice(0, 120));
  check("chain fields", c && c.ticker === "PVTEST" && c.currentSupply === "1000000" && typeof c.decimals === "number");
}
{
  const { status, body } = await get(`/api/v1/public/chains/${chainId}/blocks/latest`);
  check("latest block 200", status === 200);
  check("header fields", body.height >= 1 && /^[0-9a-f]{64}$/.test(body.header_hash) && /^[0-9a-f]{128}$/.test(body.sequencer_sig));
  check("no tx list on header route", body.transactions === undefined);
}
{
  const { status } = await get(`/api/v1/public/chains/ch_nope/blocks/latest`);
  check("unknown chain 404", status === 404);
}

// pin the sequencer key from the announcement
let pinnedHex = "";
{
  const { status, body } = await get("/api/v1/public/sequencer");
  check("sequencer 200", status === 200);
  check("announcement message format", body.announcement.message === `phase-sequencer/v1|${body.pubkey_hex}`);
  const okSig = crypto.verify(
    null,
    Buffer.from(body.announcement.message, "utf8"),
    pubkeyObj(body.pubkey_hex),
    Buffer.from(body.announcement.signature_hex, "hex")
  );
  check("announcement signature verifies", okSig);
  pinnedHex = body.pubkey_hex;
}

// balance proof — independent recomputation
let worked: any = {};
{
  const { status, body } = await get(`/api/v1/public/chains/${chainId}/proofs/balance/${aliceAddr}`);
  check("balance proof 200", status === 200, `status=${status}`);
  check("balance value", body.balance === "1500" && body.nonce === 0);

  // manual leaf recompute (independent of ledger core AND verify module)
  const leaf = sha256(Buffer.from(`${chainId}|${aliceAddr}|${body.balance}|${body.nonce}`, "utf8"));
  let computed = leaf;
  for (let i = 0; i < body.proof.length; i++) {
    const sib = Buffer.from(body.proof[i], "hex");
    computed = body.proof_directions[i] === "right" ? sha256(computed, sib) : sha256(sib, computed);
  }
  check("manual merkle walk == state_root", computed.toString("hex") === body.state_root);
  const headerOk = crypto.verify(
    null, Buffer.from(body.header_hash, "hex"), pubkeyObj(pinnedHex), Buffer.from(body.sequencer_sig, "hex")
  );
  check("manual sequencer sig over header_hash", headerOk);

  // second pass through the standalone third-party module
  const vr = verify.verifyBalanceProof({
    chainId, address: aliceAddr, balance: body.balance, nonce: body.nonce,
    state_root: body.state_root,
    proof: body.proof.map((h: string, i: number) => ({ hash: h, isRight: body.proof_directions[i] === "right" })),
    headerHash: body.header_hash, sequencerSig: body.sequencer_sig, sequencerPubkey: pinnedHex,
  });
  check("lock-proof-verify.ts agrees", vr.ok === true, vr.reason ?? "");

  worked = { chainId, aliceAddr, balance: body.balance, nonce: body.nonce, height: body.height,
    leaf: leaf.toString("hex"), state_root: body.state_root, header_hash: body.header_hash };
}

// transaction proof — independent recomputation
{
  const { status, body } = await get(`/api/v1/public/chains/${chainId}/proofs/transaction/${txId}`);
  check("tx proof 200", status === 200);
  // rebuild the wire object manually (snake_case, canonical key order)
  const wire: any = {
    chain_id: chainId, tx_id: txId, type: "TRANSFER", sender: issuerAddr, nonce: 1,
    payload: { amount: "1500", to: aliceAddr },
    signatures: body.tx_signatures ?? undefined,
  };
  // NOTE: signatures are part of the leaf; fetch the full tx from the block instead
  const blk = await get(`/api/v1/public/chains/${chainId}/blocks/${body.block_height}`);
  const fullTx = blk.body.transactions.find((t: any) => (t.tx_id ?? t.txId) === txId);
  check("tx found in block", !!fullTx);
  const wireFull = {
    chain_id: fullTx.chain_id ?? fullTx.chainId,
    tx_id: fullTx.tx_id ?? fullTx.txId,
    type: fullTx.type, sender: fullTx.sender, nonce: fullTx.nonce,
    payload: fullTx.payload, signatures: fullTx.signatures,
    submitted_at: fullTx.submitted_at ?? fullTx.submittedAt,
  };
  void wire;
  const leaf = sha256(Buffer.from(txId, "utf8"), Buffer.from(canonicalize(wireFull), "utf8"));
  let computed = leaf;
  for (let i = 0; i < body.proof.length; i++) {
    const sib = Buffer.from(body.proof[i], "hex");
    computed = body.proof_directions[i] === "right" ? sha256(computed, sib) : sha256(sib, computed);
  }
  check("manual tx merkle walk == tx_root", computed.toString("hex") === body.tx_root);
}

console.log("\n--- worked example (real values) ---");
console.log(`chainId      = ${worked.chainId}`);
console.log(`address      = ${worked.aliceAddr}`);
console.log(`balance      = "${worked.balance}"  nonce = ${worked.nonce}  height = ${worked.height}`);
console.log(`leaf         = SHA256("${worked.chainId}|${worked.aliceAddr}|${worked.balance}|${worked.nonce}")`);
console.log(`             = ${worked.leaf}`);
console.log(`state_root   = ${worked.state_root}   (walk matches ✓)`);
console.log(`header_hash  = ${worked.header_hash}   (sequencer sig ✓)`);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
