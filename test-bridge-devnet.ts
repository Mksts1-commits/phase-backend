/**
 * test-bridge-devnet.ts — Phase 1 acceptance: full bridge round-trip.
 *
 * Flow:
 *   A. bridge-config gates (offline): devnet default ok, mainnet refused,
 *      pause/resume with reasons, circuit breaker trips, daily caps.
 *   B. Phase chain + lock TRANSFER to the deterministic vault (offline).
 *   C. Watcher finds + verifies the lock via the shared lock-proof-verify.ts
 *      path (offline); idempotency on re-scan.
 *   D. Devnet round-trip (network; skipped cleanly if devnet unreachable):
 *      fund authority -> mint wrapped -> burn w/ ph1 memo -> unlock back.
 *   E. Bridge HTTP routes: vaults / locks / reserves.
 *   F. anchorStateRoot file/log implementation.
 *
 * Run: npx tsx test-bridge-devnet.ts
 * Env: BLOCK_INTERVAL_MS set below; DATABASE_URL deleted (in-memory store).
 */
process.env.BLOCK_INTERVAL_MS = "250";
process.env.ANCHOR_LOG_PATH = "/tmp/bridge-test-anchored-roots.log";
delete process.env.DATABASE_URL;
delete process.env.BRIDGE_NETWORK;

import crypto from "node:crypto";
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const core: any = await import("./sovereign-ledger-core.js");
const verify: any = await import("./lock-proof-verify.js");
const bridge: any = await import("./bridge.js");
const importer: any = await import("./bridge-importer-solana.js");
const bridgeConfig: any = await import("./bridge-config.js");
const solMint: any = await import("./solana-mint.js");
const web3: any = await import("@solana/web3.js");
const spl: any = await import("@solana/spl-token");
const { mountBridgeRoutes } = await import("./bridge.js");

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// independent base58 (same as test-public-verification.ts)
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

// ---------------------------------------------------------------------------
// A. config gates (offline)
// ---------------------------------------------------------------------------
console.log("A. bridge-config gates");
{
  const cfg = bridgeConfig.loadBridgeConfig();
  check("default network devnet", cfg.network === "devnet");
  check("mainnetApproved false", cfg.mainnetApproved === false);
  bridgeConfig.assertDevnetOnly(); // must not throw
  check("assertDevnetOnly passes", true);

  process.env.BRIDGE_NETWORK = "mainnet";
  let threw = false;
  try { bridgeConfig.loadBridgeConfig(); } catch { threw = true; }
  check("mainnet BRIDGE_NETWORK refused", threw);
  threw = false;
  try { bridgeConfig.assertDevnetOnly(); } catch { threw = true; }
  check("assertDevnetOnly throws on mainnet", threw);
  delete process.env.BRIDGE_NETWORK;

  threw = false;
  try { bridgeConfig.pauseBridge("", "test"); } catch { threw = true; }
  check("pause requires reason", threw);
  bridgeConfig.pauseBridge("test pause", "test");
  check("isBridgePaused true", bridgeConfig.isBridgePaused().paused === true);
  bridgeConfig.resumeBridge("test resume", "test");
  check("resume clears pause", bridgeConfig.isBridgePaused().paused === false);
  const log = bridgeConfig.getBridgeAdminLog();
  check("admin log append-only", log.length >= 2 && log[0].action === "pause" && log[1].action === "resume");

  // circuit breaker: 15% of supply in one window trips the 10% default
  const tripped = bridgeConfig.recordMintForCircuitBreaker("ch_fake", 150n, 1000n, 0);
  check("breaker trips over pct", tripped === true && bridgeConfig.isBridgePaused().paused === true);
  bridgeConfig.resumeBridge("breaker test done", "test");

  // daily caps
  bridgeConfig.setPerCoinDailyCapUsd("ch_fake", 100);
  const over = bridgeConfig.checkDailyCaps("ch_fake", 101);
  check("per-coin cap enforced", over.ok === false);
  const under = bridgeConfig.checkDailyCaps("ch_fake", 50);
  check("under cap ok", under.ok === true);

  // anchorStateRoot file/log impl
  const receipts = await bridgeConfig.anchorStateRoot("ch_fake", 7, "ab".repeat(32));
  check("anchor receipt", receipts.length === 1 && receipts[0].anchor === "file-log" && typeof receipts[0].ref === "string");
  const logText = fs.readFileSync("/tmp/bridge-test-anchored-roots.log", "utf8");
  check("anchor log line", logText.includes('"chainId":"ch_fake"') && logText.includes('"height":7'));
}

// ---------------------------------------------------------------------------
// B. Phase chain + lock (offline)
// ---------------------------------------------------------------------------
console.log("B. chain + vault lock");
const issuer = crypto.generateKeyPairSync("ed25519");
const user = crypto.generateKeyPairSync("ed25519");
const issuerAddr = addrOf(issuer);
const userAddr = addrOf(user);

const created: any = await core.createChain({
  coin_name: "Bridge Test Coin",
  ticker: "BRDGT",
  total_supply: "1000000000000", // 1e12 base units, 6 decimals
  decimals: 6,
  equity_public_pct: 0, // issuer keeps 100% so the test can fund the user
  issuer_address: issuerAddr,
});
const chainId: string = created.chain_id;
console.log(`  chain ${chainId}`);
core.startSequencerLoop();

async function submitSignedTransfer(from: any, to: string, amount: string, memo?: string, nonce?: number) {
  const fromAddr = addrOf(from);
  const n = nonce ?? (core.store.getBalanceEntry(chainId, fromAddr).nonce + 1);
  const txId = "tx_" + randomUUID();
  const tx: any = {
    chainId, txId, type: "TRANSFER", sender: fromAddr, nonce: n,
    payload: { to, amount, ...(memo ? { memo } : {}) },
    signatures: [], submittedAt: Date.now(),
  };
  const msg = core.signingMessage(tx);
  const sig = crypto.sign(null, msg, from.privateKey);
  const res: any = await core.submitTransaction(chainId, {
    tx_id: txId, type: "TRANSFER", sender: fromAddr, nonce: n,
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

const fundTx = await submitSignedTransfer(issuer, userAddr, "10000000"); // 10 whole coins to user
await waitConfirmed(fundTx);
check("user funded", core.getChainBalance(chainId, userAddr) === "10000000");

const vault = bridge.ensureVault(chainId);
check("vault deterministic", vault.vaultAddress === verify.deriveVaultAddress(chainId));
check("vault address format", verify.isValidPhaseAddress(vault.vaultAddress));

// independent vault-derivation recompute (raw node:crypto only)
{
  const seed = crypto.createHash("sha256").update("phase-bridge-vault/v1/" + chainId, "utf8").digest();
  const priv = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der", type: "pkcs8",
  });
  const pub = crypto.createPublicKey(priv);
  const der = pub.export({ type: "spki", format: "der" }) as Buffer;
  const expected = "ph1" + b58encode(der.subarray(der.length - 32));
  check("vault derivation independently recomputed", expected === vault.vaultAddress);
}

// the destination: a fresh Solana keypair (its pubkey goes in the lock memo)
const destKp = web3.Keypair.generate();
const destSolAddr = destKp.publicKey.toBase58();
const lockTx = await submitSignedTransfer(user, vault.vaultAddress, "1000000", `BRIDGE:solana:${destSolAddr}`);
await waitConfirmed(lockTx);
check("lock confirmed", core.getChainBalance(chainId, vault.vaultAddress) === "1000000");
check("user debited", core.getChainBalance(chainId, userAddr) === "9000000");

// ---------------------------------------------------------------------------
// C. watcher: find + verify lock (offline)
// ---------------------------------------------------------------------------
console.log("C. watcher verifies lock via shared path");
{
  const r1 = await importer.watcherProcessLocks();
  check("watcher found lock", r1.found === 1, JSON.stringify(r1));
  check("watcher verified lock", r1.verified === 1);
  const ev = bridge.findBridgeEvent(`lock:${chainId}:${lockTx}`);
  check("lock event verified", !!ev && ev.status === "verified" && ev.amount === 1000000n);

  const r2 = await importer.watcherProcessLocks();
  check("watcher rescan finds nothing new", r2.found === 0 && r2.verified === 0, JSON.stringify(r2));
  check("no duplicate lock event", bridge.listBridgeEvents({ kind: "lock" }).length === 1);

  // certificate through the exact third-party path
  const cert = bridge.buildLockCertificate(chainId, lockTx);
  const v = verify.verifyLockCertificate(cert);
  check("certificate verifies", v.ok === true, JSON.stringify(v).slice(0, 200));
  check("cert fields", cert.destination.address === destSolAddr && cert.amount === "1000000");

  // tamper: wrong destination address must fail
  const bad = { ...cert, destination: { ...cert.destination, address: destKp.publicKey.toBase58().slice(0, 10) } };
  check("tampered cert rejected", verify.verifyLockCertificate(bad).ok === false);
}

// ---------------------------------------------------------------------------
// D. devnet round-trip (network; skipped cleanly if unreachable)
// ---------------------------------------------------------------------------
console.log("D. devnet round-trip");
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label + " timed out")), ms))]);

let devnet = false;
let connection: any = null;
try {
  connection = importer.newConnection();
  await withTimeout(connection.getVersion(), 20000, "getVersion");
  devnet = true;
  console.log("  devnet reachable");
} catch (e: any) {
  console.log(`  SKIP devnet section: ${e.message}`);
}

async function airdrop(pubkey: any, sol: number) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sig = await withTimeout(
        connection.requestAirdrop(pubkey, Math.floor(sol * 1e9)), 30000, "airdrop"
      );
      await withTimeout(connection.confirmTransaction(sig, "confirmed"), 60000, "airdrop-confirm");
      return;
    } catch (e: any) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

if (devnet) {
  // ensure the SPL mint authority is funded (keypair file created on first use)
  const secretsPath = path.join(process.cwd(), ".secrets", "solana-mint-authority.json");
  let funded = false;
  for (let attempt = 1; attempt <= 2 && !funded; attempt++) {
    try {
      await solMint.createBridgeMint();
      funded = true;
    } catch (e: any) {
      console.log(`  funding authority (attempt ${attempt}): ${String(e.message).slice(0, 120)}`);
      const raw = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
      const authKp = web3.Keypair.fromSecretKey(Uint8Array.from(raw));
      await airdrop(authKp.publicKey, 1);
      console.log("  authority airdropped 1 SOL");
    }
  }
  check("authority funded / mint creatable", funded);
  await airdrop(destKp.publicKey, 0.5);
  console.log("  holder airdropped 0.5 SOL");

  // mint side: verified lock -> wrapped SPL
  const m = await importer.signerProcessMints(connection);
  check("signer minted", m.minted === 1 && m.skipped === 0, JSON.stringify(m));
  const mintEv = bridge.findBridgeEvent(`mint:${chainId}:${lockTx}`);
  check("mint event confirmed", !!mintEv && mintEv.status === "confirmed" && !!mintEv.destTxSig);
  const mintAddress = (mintEv.detail as any).mint;

  const ata = await spl.getAssociatedTokenAddress(new web3.PublicKey(mintAddress), destKp.publicKey);
  const acct = await withTimeout(connection.getAccount(ata, "confirmed"), 30000, "getAccount");
  const bal = spl.unpackAccount(ata, acct, new web3.PublicKey(mintAddress)).amount;
  check("wrapped balance == locked", bal === 1000000n, `balance=${bal}`);
  check("lock event now confirmed", bridge.findBridgeEvent(`lock:${chainId}:${lockTx}`)?.status === "confirmed");

  let r = bridge.getBridgeReserves(chainId);
  check("reserves healthy after mint", r.locked === "1000000" && r.wrappedCirculating === "1000000" && r.healthy === true, JSON.stringify(r));

  // idempotent re-mint: nothing new
  const m2 = await importer.signerProcessMints(connection);
  check("re-mint is no-op", m2.minted === 0, JSON.stringify(m2));

  // burn side: holder burns wrapped with a ph1 memo in ONE solana tx
  const burnIx = spl.createBurnInstruction(ata, new web3.PublicKey(mintAddress), destKp.publicKey, 1000000n);
  const memoIx = new web3.TransactionInstruction({
    keys: [],
    programId: new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    data: Buffer.from(userAddr, "utf8"),
  });
  const burnSig = await withTimeout(
    web3.sendAndConfirmTransaction(connection, new web3.Transaction().add(burnIx, memoIx), [destKp]),
    90000, "burn"
  );
  console.log(`  burn tx ${burnSig}`);

  const burns: any[] = await withTimeout(importer.watcherScanBurns(connection, mintAddress, { limit: 10 }), 60000, "scanBurns");
  const ours = burns.find((b: any) => b.txSig === burnSig);
  check("watcher found our burn", !!ours && ours.amount === 1000000n && ours.phaseAddress === userAddr, JSON.stringify(burns).slice(0, 160));
  const recorded = importer.watcherRecordBurns(chainId, burns);
  check("burn recorded", recorded >= 1);
  const recorded2 = importer.watcherRecordBurns(chainId, burns);
  check("burn record idempotent", recorded2 === 0);

  const u = await importer.signerProcessUnlocks();
  check("signer unlocked", u.unlocked === 1 && u.skipped === 0, JSON.stringify(u));
  const unlockEv = bridge.findBridgeEvent(`unlock:${burnSig}`);
  check("unlock event confirmed", !!unlockEv && unlockEv.status === "confirmed" && !!unlockEv.phaseTxId);

  check("user balance restored", core.getChainBalance(chainId, userAddr) === "10000000");
  check("vault drained", core.getChainBalance(chainId, vault.vaultAddress) === "0");
  r = bridge.getBridgeReserves(chainId);
  check("reserves healthy after unlock", r.locked === "0" && r.wrappedCirculating === "0" && r.healthy === true, JSON.stringify(r));

  // full re-run: everything is a no-op
  const again = await importer.importerOnce(connection);
  check("full re-run no-op", again.mints.minted === 0 && again.unlocks.unlocked === 0, JSON.stringify(again));
}

// ---------------------------------------------------------------------------
// D2. offline unlock path: simulated verified burn -> vault signs unlock
// (runs when devnet is unreachable; exercises the vault signing path
// end-to-end on the Phase ledger without Solana)
// ---------------------------------------------------------------------------
console.log("D2. offline unlock via simulated verified burn");
let unlockedOffline = false;
if (!devnet) {
  // Simulate the books as the real flow would leave them: a confirmed mint
  // (devnet unreachable, so we record what mintToAddress would have recorded)
  // followed by the burn the watcher would have seen.
  bridge.recordBridgeEvent({
    chainId, kind: "mint", phaseTxId: lockTx, destTxSig: "simulated_mint_sig",
    amount: 1000000n, status: "confirmed",
    idempotencyKey: `mint:${chainId}:${lockTx}`,
    detail: { mint: "simMint", simulated: true },
  });
  bridge.setBridgeEventStatus(`lock:${chainId}:${lockTx}`, "confirmed");
  const simSig = "simulated_burn_sig_no_solana";
  const { created: burnCreated } = bridge.recordBridgeEvent({
    chainId, kind: "burn", destTxSig: simSig,
    amount: 1000000n, status: "verified",
    idempotencyKey: `burn:simMint:${simSig}`,
    detail: { mint: "simMint", phaseAddress: userAddr, simulated: true },
  });
  check("simulated burn recorded", burnCreated === true);
  const u = await importer.signerProcessUnlocks();
  check("signer unlocked offline", u.unlocked === 1 && u.skipped === 0, JSON.stringify(u));
  const unlockEv = bridge.findBridgeEvent(`unlock:${simSig}`);
  check("unlock event confirmed", !!unlockEv && unlockEv.status === "confirmed" && !!unlockEv.phaseTxId);
  check("user balance restored", core.getChainBalance(chainId, userAddr) === "10000000");
  check("vault drained", core.getChainBalance(chainId, vault.vaultAddress) === "0");
  // the unlock tx was signed by the vault key: verify via the ledger's rules
  const unlockTx = core.store.txById.get(unlockEv.phaseTxId);
  check("unlock tx confirmed on ledger", !!unlockTx && unlockTx.blockHeight !== undefined && unlockTx.sender === vault.vaultAddress);
  unlockedOffline = true;

  // burn-scan parsing logic against a fabricated Solana tx (no network)
  const MEMO_S = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  const TOKEN_S = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const burnData = Buffer.alloc(9);
  burnData[0] = 8; // TokenInstruction.Burn
  burnData.writeBigUInt64LE(1000000n, 1);
  const fakeMint = destKp.publicKey.toBase58(); // valid-format stand-in
  const fakeConn = {
    getSignaturesForAddress: async () => [{ signature: "sig1", err: null }, { signature: "sig2", err: "failed" }],
    getTransaction: async (sig: string) => sig === "sig1" ? ({
      transaction: {
        message: {
          staticAccountKeys: [MEMO_S, TOKEN_S].map((s) => ({ toBase58: () => s })),
          compiledInstructions: [
            { programIdIndex: 0, data: Buffer.from(userAddr, "utf8") },
            { programIdIndex: 1, data: burnData },
          ],
        },
      },
    }) : null,
  };
  const parsed = await importer.watcherScanBurns(fakeConn, fakeMint, { limit: 10 });
  check("burn parser finds burn+memo", parsed.length === 1 && parsed[0].txSig === "sig1" && parsed[0].amount === 1000000n && parsed[0].phaseAddress === userAddr, JSON.stringify(parsed, (_, v) => typeof v === "bigint" ? v.toString() : v));
}

// ---------------------------------------------------------------------------
// E. bridge HTTP routes (offline)
// ---------------------------------------------------------------------------
console.log("E. bridge HTTP routes");
{
  type Handler = (ctx: any) => void | Promise<void>;
  const routes: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: Handler }> = [];
  const compilePath = (p: string) => {
    const paramNames: string[] = [];
    const patternStr = p.split("/").map((seg) => {
      if (seg.startsWith(":")) { paramNames.push(seg.slice(1)); return "([^/]+)"; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    return { pattern: new RegExp(`^${patternStr}$`), paramNames };
  };
  class HttpError extends Error {
    constructor(public statusCode: number, public code: string, message: string) { super(message); }
  }
  const sendJson = (res: any, statusCode: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
    res.end(json);
  };
  mountBridgeRoutes({ route: (m: string, p: string, h: Handler) => routes.push({ method: m, ...compilePath(p), handler: h }), sendJson, HttpError: HttpError as any });
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
  const get = async (p: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`);
    return { status: res.status, body: await res.json() };
  };

  const vv = await get(`/api/v1/bridge/vaults/${chainId}`);
  check("vault route 200", vv.status === 200 && vv.body.vault_address === vault.vaultAddress);
  const v404 = await get(`/api/v1/bridge/vaults/ch_nope`);
  check("vault route 404", v404.status === 404);

  const l = await get(`/api/v1/bridge/locks/${lockTx}?chainId=${chainId}`);
  check("lock cert route 200", l.status === 200 && l.body.standard === "phase-lock-proof/1");
  check("served cert verifies", verify.verifyLockCertificate(l.body).ok === true);
  const l400 = await get(`/api/v1/bridge/locks/${lockTx}`);
  check("lock route needs chainId", l400.status === 400);
  const l404 = await get(`/api/v1/bridge/locks/tx_nope?chainId=${chainId}`);
  check("lock route 404", l404.status === 404);

  const rs = await get(`/api/v1/bridge/reserves?chainId=${chainId}`);
  check("reserves route 200", rs.status === 200 && Array.isArray(rs.body.reserves));
  const row = rs.body.reserves[0];
  const expectLocked = (devnet || unlockedOffline) ? "0" : "1000000";
  check("reserves row sane", row && row.chainId === chainId && row.locked === expectLocked && row.healthy === true, JSON.stringify(row));

  server.close();
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
console.log(`\nbridge-devnet: ${pass} pass, ${fail} fail`);
console.log(`devnet section: ${devnet ? "RAN (full round-trip)" : "SKIPPED (devnet unreachable)"}`);
process.exit(fail ? 1 : 0);
