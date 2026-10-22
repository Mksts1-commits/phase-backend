/**
 * bridge-config.ts — Phase 2 mainnet hardening hooks. ALL DEFAULT-OFF.
 *
 * This build is DEVNET-ONLY. Mainnet is not enabled here; this file exists so
 * enabling it later is configuration, not re-architecture.
 *
 * KEY SEPARATION (structural rule for the importer):
 * -------------------------------------------------
 * The lock *watcher* (detects vault deposits) and the *mint signer* (authorizes
 * wrapped mints) MUST use different key handles and live in different modules.
 * Rationale: a single compromised host must never be able to both invent a
 * fake lock and mint against it. Concretely:
 *   - bridge-importer-solana.ts is split into Watcher (read-only: scans the
 *     Phase ledger + Solana, builds/verifies certificates, writes
 *     bridge_events rows with status 'verified') and Signer (takes verified
 *     rows, submits mint/burn/unlock transactions).
 *   - Watcher holds NO private keys. Signer holds ONLY the keys it needs, and
 *     on mainnet those come from KMS (see assertMainnetKeys()).
 *   - The two halves communicate through bridge_events rows, never shared
 *     memory secrets.
 */
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// network gate
// ---------------------------------------------------------------------------

export type BridgeNetwork = "devnet";

export interface BridgeConfig {
  network: BridgeNetwork;
  /** Always false in this build. Mainnet requires KMS + explicit approval. */
  mainnetApproved: false;
  circuitBreaker: {
    enabled: boolean;
    pctOfSupply: number; // e.g. 10 = pause if mints > 10% of supply in window
    usdCap: number; // pause if minted USD value exceeds this in window
    windowMin: number;
  };
  dailyCapUsd: number; // global daily bridge-out cap, USD
}

function num(env: string, def: number): number {
  const v = process.env[env];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`[bridge-config] ${env} must be a non-negative number, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * Fail-loud config load. Anything other than devnet throws unless
 * BRIDGE_MAINNET_APPROVED=true AND KMS keys are present — and KMS is not
 * implemented in this build, so mainnet is unreachable by construction.
 */
export function loadBridgeConfig(): BridgeConfig {
  const network = (process.env.BRIDGE_NETWORK ?? "devnet").trim().toLowerCase();
  if (network !== "devnet") {
    throw new Error(
      `[bridge-config] REFUSED: BRIDGE_NETWORK=${JSON.stringify(
        process.env.BRIDGE_NETWORK
      )} — this build is devnet-only. Mainnet requires KMS-held keys and ` +
        `BRIDGE_MAINNET_APPROVED=true, neither of which exists here.`
    );
  }
  return {
    network: "devnet",
    mainnetApproved: false,
    circuitBreaker: {
      enabled: process.env.BRIDGE_CB_ENABLED !== "false",
      pctOfSupply: num("BRIDGE_CB_PCT", 10),
      usdCap: num("BRIDGE_CB_USD", 100_000),
      windowMin: num("BRIDGE_CB_WINDOW_MIN", 60),
    },
    dailyCapUsd: num("BRIDGE_DAILY_CAP_USD", 50_000),
  };
}

/** Throw unless we are on devnet. Call at importer startup. */
export function assertDevnetOnly(): void {
  loadBridgeConfig(); // throws on anything but devnet
}

/**
 * Refuse to start if a mainnet key would come from a file. Fail loud, same
 * pattern as the fee-config rule: missing KMS on mainnet is fatal, never a
 * silent fallback.
 */
export function assertMainnetKeys(): void {
  throw new Error(
    "[bridge-config] REFUSED: mainnet key material must come from KMS/HSM. " +
      "No KMS integration exists in this build — mainnet is disabled."
  );
}

// ---------------------------------------------------------------------------
// circuit breaker
// ---------------------------------------------------------------------------

interface MintTick {
  at: number;
  amountBaseUnits: bigint;
  usdValue: number; // 0 when unknown
}

const mintTicks = new Map<string, MintTick[]>(); // chainId -> recent mints
let paused: { reason: string; at: number; actor: string } | null = null;
const adminLog: Array<{ action: string; actor: string; reason: string; at: number }> = [];

async function persistAdminLog(action: string, actor: string, reason: string): Promise<void> {
  adminLog.push({ action, actor, reason, at: Date.now() });
  try {
    const mod: any = await import("./db.js");
    const pool = mod.getPool();
    await pool.query(
      `INSERT INTO bridge_admin_log (action, actor, reason) VALUES ($1,$2,$3)`,
      [action, actor, reason]
    );
  } catch {
    /* best-effort */
  }
}

export function isBridgePaused(): { paused: boolean; reason?: string } {
  return paused ? { paused: true, reason: paused.reason } : { paused: false };
}

/** Manual pause. Reason is required and append-only logged. */
export function pauseBridge(reason: string, actor: string): void {
  if (!reason || !reason.trim()) throw new Error("[bridge-config] pause reason is required");
  paused = { reason, at: Date.now(), actor };
  void persistAdminLog("pause", actor, reason);
}

/** Manual resume. Reason is required and append-only logged. */
export function resumeBridge(reason: string, actor: string): void {
  if (!reason || !reason.trim()) throw new Error("[bridge-config] resume reason is required");
  paused = null;
  mintTicks.clear();
  void persistAdminLog("resume", actor, reason);
}

export function getBridgeAdminLog(): ReadonlyArray<{ action: string; actor: string; reason: string; at: number }> {
  return adminLog;
}

/**
 * Record a wrapped mint for circuit-breaker accounting. Returns true when the
 * breaker tripped (bridge is now paused). Pure accounting — the caller must
 * still check isBridgePaused() before minting.
 */
export function recordMintForCircuitBreaker(
  chainId: string,
  amountBaseUnits: bigint,
  currentSupplyBaseUnits: bigint,
  usdValue = 0
): boolean {
  const cfg = loadBridgeConfig().circuitBreaker;
  if (!cfg.enabled) return false;
  const now = Date.now();
  const windowMs = cfg.windowMin * 60_000;
  const ticks = (mintTicks.get(chainId) ?? []).filter((t) => now - t.at < windowMs);
  ticks.push({ at: now, amountBaseUnits, usdValue });
  mintTicks.set(chainId, ticks);

  const sumUnits = ticks.reduce((a, t) => a + t.amountBaseUnits, 0n);
  const sumUsd = ticks.reduce((a, t) => a + t.usdValue, 0);
  const pctOfSupply =
    currentSupplyBaseUnits > 0n ? Number((sumUnits * 10_000n) / currentSupplyBaseUnits) / 100 : 0;

  if (pctOfSupply > cfg.pctOfSupply || sumUsd > cfg.usdCap) {
    pauseBridge(
      `circuit-breaker: ${pctOfSupply.toFixed(2)}% of supply / $${sumUsd.toFixed(2)} minted in ${cfg.windowMin}m ` +
        `(limits ${cfg.pctOfSupply}% / $${cfg.usdCap})`,
      "system:circuit-breaker"
    );
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// daily caps
// ---------------------------------------------------------------------------

const dailyMintedUsd = new Map<string, number>(); // dayKey -> usd
const perCoinDailyUsd = new Map<string, number>(); // `${dayKey}:${chainId}` -> usd
const perCoinDailyCaps = new Map<string, number>(); // chainId -> usd cap override

export function setPerCoinDailyCapUsd(chainId: string, usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("[bridge-config] cap must be >= 0");
  perCoinDailyCaps.set(chainId, usd);
}

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check (but do not consume) daily caps. Returns {ok} or {ok:false, reason}.
 * The caller consumes via consumeDailyCap() only AFTER a successful mint.
 */
export function checkDailyCaps(chainId: string, usdValue: number): { ok: true } | { ok: false; reason: string } {
  const cfg = loadBridgeConfig();
  const dk = dayKey();
  const globalUsed = dailyMintedUsd.get(dk) ?? 0;
  if (globalUsed + usdValue > cfg.dailyCapUsd)
    return { ok: false, reason: `global daily cap $${cfg.dailyCapUsd} would be exceeded` };
  const coinCap = perCoinDailyCaps.get(chainId);
  if (coinCap !== undefined) {
    const used = perCoinDailyUsd.get(`${dk}:${chainId}`) ?? 0;
    if (used + usdValue > coinCap)
      return { ok: false, reason: `per-coin daily cap $${coinCap} would be exceeded` };
  }
  return { ok: true };
}

export function consumeDailyCap(chainId: string, usdValue: number): void {
  const dk = dayKey();
  dailyMintedUsd.set(dk, (dailyMintedUsd.get(dk) ?? 0) + usdValue);
  perCoinDailyUsd.set(`${dk}:${chainId}`, (perCoinDailyUsd.get(`${dk}:${chainId}`) ?? 0) + usdValue);
}

// ---------------------------------------------------------------------------
// root anchoring — interface + file/log implementation now
// ---------------------------------------------------------------------------

export interface RootAnchorReceipt {
  anchor: string; // which anchor produced this
  ref: string; // pointer a verifier can follow (path, tx sig, CID…)
  at: string; // ISO timestamp
}

export interface RootAnchor {
  name: string;
  anchor(chainId: string, height: number, stateRoot: string): Promise<RootAnchorReceipt>;
}

/**
 * File/log anchor (ships now): appends one JSON line per checkpoint to
 * ./data/anchored-roots.log — an append-only local log. This is the
 * convenient default, never the only copy (see docs/LOCK_PROOF_STANDARD.md §6).
 */
export class FileLogAnchor implements RootAnchor {
  name = "file-log";
  constructor(private logPath = "./data/anchored-roots.log") {}
  async anchor(chainId: string, height: number, stateRoot: string): Promise<RootAnchorReceipt> {
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const line = JSON.stringify({
      chainId, height, stateRoot,
      sha256: crypto.createHash("sha256").update(`${chainId}|${height}|${stateRoot}`).digest("hex"),
      at: new Date().toISOString(),
    });
    await fs.appendFile(this.logPath, line + "\n", "utf8");
    return { anchor: this.name, ref: this.logPath, at: new Date().toISOString() };
  }
}

// Phase 2 implementations (documented, not built here):
// - OnChainAnchor: posts the 32-byte root as calldata/event on a cheap L1/L2.
//   Cannot be denied or back-dated (OpenTimestamps-style). Needs a funded
//   keypair + RPC config — see TODO(PHASE2).
// - ArweaveIpfsAnchor: stores root+header+txs content-addressed; anchors the
//   CID on-chain so the pointer is immutable.
// - GitRepoAnchor: commits (height, stateRoot, anchorTxRef) to a public repo;
//   hash-chained via commit parents.
// - Mirror API: GET /api/v1/public/roots serves the checkpoint log so third
//   parties can republish roots independently with one call.

const anchors: RootAnchor[] = [
  new FileLogAnchor(process.env.ANCHOR_LOG_PATH || "./data/anchored-roots.log"),
];

/** Anchor a state root with every configured anchor. Returns all receipts. */
export async function anchorStateRoot(
  chainId: string,
  height: number,
  stateRoot: string
): Promise<RootAnchorReceipt[]> {
  if (!/^[0-9a-f]{64}$/i.test(stateRoot)) throw new Error("[bridge-config] stateRoot must be 64 hex chars");
  if (!Number.isInteger(height) || height < 0) throw new Error("[bridge-config] bad height");
  const receipts: RootAnchorReceipt[] = [];
  for (const a of anchors) receipts.push(await a.anchor(chainId, height, stateRoot));
  return receipts;
}
