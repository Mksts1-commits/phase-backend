/**
 * bridge.ts — bridge vault registry, lock-proof certificates, and reserves.
 *
 * Locking is a normal Phase TRANSFER to the chain's deterministic vault address
 * with a `BRIDGE:<destChain>:<destAddress>` memo. No new tx type, no
 * ledger-core changes.
 *
 * The event store is in-memory first (hot path) with best-effort Postgres
 * persistence, mirroring sovereign-ledger-core's own pattern. Every
 * cross-chain step is recorded under a UNIQUE idempotency key so replays are
 * rejected, never double-counted.
 *
 * Exported for the Solana importer (bridge-importer-solana.ts):
 *   ensureVault, getVaultAddress, recordBridgeEvent, findBridgeEvent,
 *   setBridgeEventStatus, getBridgeReserves
 *
 * Mounted from phase-backend.ts:
 *   mountBridgeRoutes({ route, sendJson, HttpError });
 */
import {
  store,
  buildMerkleTree,
  getMerkleProof,
  txMerkleLeaf,
  getChainBalance,
  getSequencerPublicKeyRaw,
  LedgerError,
} from "./sovereign-ledger-core.js";
import {
  deriveVaultAddress,
  parseLockMemo,
  verifyLockCertificate,
} from "./lock-proof-verify.js";
import { checkRateLimit, clientIpFromHeaders } from "./rate-limit.js";

interface Ctx {
  req: any;
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

interface Deps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: any;
}

const PREFIX = "/api/v1/bridge";
const RATE_MAX = 120;
const RATE_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// event store (in-memory hot path + best-effort Postgres)
// ---------------------------------------------------------------------------

export type BridgeEventKind = "lock" | "mint" | "burn" | "unlock";
export type BridgeEventStatus = "seen" | "verified" | "submitted" | "confirmed" | "failed";

export interface BridgeEvent {
  id: number;
  chainId: string;
  kind: BridgeEventKind;
  phaseTxId: string | null;
  destTxSig: string | null;
  amount: bigint;
  status: BridgeEventStatus;
  idempotencyKey: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
}

const vaults = new Map<string, { chainId: string; vaultAddress: string }>();
const events = new Map<string, BridgeEvent>(); // by idempotencyKey
let eventSeq = 1;

async function bridgePool(): Promise<any | null> {
  try {
    const mod: any = await import("./db.js");
    const pool = mod.getPool();
    await pool.query("SELECT 1");
    const t = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'bridge_events'"
    );
    if (t.rowCount === 0) return null;
    return pool;
  } catch {
    return null;
  }
}

async function persistVaultRow(chainId: string, vaultAddress: string): Promise<void> {
  try {
    const pool = await bridgePool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO bridge_vaults (chain_id, vault_address) VALUES ($1, $2)
       ON CONFLICT (chain_id) DO NOTHING`,
      [chainId, vaultAddress]
    );
  } catch {
    /* best-effort */
  }
}

async function persistEventRow(e: BridgeEvent): Promise<void> {
  try {
    const pool = await bridgePool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO bridge_events
         (chain_id, kind, phase_tx_id, dest_tx_sig, amount, status, idempotency_key, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        e.chainId, e.kind, e.phaseTxId, e.destTxSig,
        e.amount.toString(), e.status, e.idempotencyKey,
        e.detail ? JSON.stringify(e.detail) : null,
      ]
    );
  } catch {
    /* best-effort */
  }
}

/** Register (or fetch) the deterministic vault for a chain. */
export function ensureVault(chainId: string): { chainId: string; vaultAddress: string } {
  const chain: any = store.chains.get(chainId);
  if (!chain) {
    const err: any = new Error("Unknown chain.");
    err.code = "chain_not_found";
    err.statusCode = 404;
    throw err;
  }
  let v = vaults.get(chainId);
  if (!v) {
    v = { chainId, vaultAddress: deriveVaultAddress(chainId) };
    vaults.set(chainId, v);
    void persistVaultRow(chainId, v.vaultAddress);
  }
  return v;
}

export function getVaultAddress(chainId: string): string | null {
  return vaults.get(chainId)?.vaultAddress ?? null;
}

/**
 * Record a bridge event exactly once. Returns { event, created } — when the
 * idempotency key already exists, `created` is false and the existing event
 * is returned (replay safe).
 */
export function recordBridgeEvent(args: {
  chainId: string;
  kind: BridgeEventKind;
  phaseTxId?: string | null;
  destTxSig?: string | null;
  amount: bigint;
  status?: BridgeEventStatus;
  idempotencyKey: string;
  detail?: Record<string, unknown> | null;
}): { event: BridgeEvent; created: boolean } {
  const existing = events.get(args.idempotencyKey);
  if (existing) return { event: existing, created: false };
  const e: BridgeEvent = {
    id: eventSeq++,
    chainId: args.chainId,
    kind: args.kind,
    phaseTxId: args.phaseTxId ?? null,
    destTxSig: args.destTxSig ?? null,
    amount: args.amount,
    status: args.status ?? "seen",
    idempotencyKey: args.idempotencyKey,
    detail: args.detail ?? null,
    createdAt: Date.now(),
  };
  events.set(args.idempotencyKey, e);
  void persistEventRow(e);
  return { event: e, created: true };
}

export function findBridgeEvent(idempotencyKey: string): BridgeEvent | null {
  return events.get(idempotencyKey) ?? null;
}

/** Iterate events with optional filters — the watcher<->signer handoff surface. */
export function listBridgeEvents(filter?: {
  chainId?: string;
  kind?: BridgeEventKind;
  status?: BridgeEventStatus;
}): BridgeEvent[] {
  const out: BridgeEvent[] = [];
  for (const e of events.values()) {
    if (filter?.chainId && e.chainId !== filter.chainId) continue;
    if (filter?.kind && e.kind !== filter.kind) continue;
    if (filter?.status && e.status !== filter.status) continue;
    out.push(e);
  }
  return out;
}

export function setBridgeEventStatus(
  idempotencyKey: string,
  status: BridgeEventStatus,
  patch?: { phaseTxId?: string; destTxSig?: string; detail?: Record<string, unknown> }
): void {
  const e = events.get(idempotencyKey);
  if (!e) return;
  e.status = status;
  if (patch?.phaseTxId !== undefined) e.phaseTxId = patch.phaseTxId;
  if (patch?.destTxSig !== undefined) e.destTxSig = patch.destTxSig;
  if (patch?.detail !== undefined) e.detail = patch.detail;
  void persistEventRow(e);
}

export interface BridgeReserves {
  chainId: string;
  vaultAddress: string | null;
  locked: string; // base units, vault balance on Phase
  wrappedCirculating: string; // base units, minted - burned across destinations
  lastCheckedAt: string; // ISO
  healthy: boolean; // locked == wrappedCirculating
}

/** Per-chain reserves: locked on Phase vs wrapped circulating elsewhere. */
export function getBridgeReserves(chainId: string): BridgeReserves {
  const vault = vaults.get(chainId);
  let locked = 0n;
  if (vault) {
    try {
      locked = BigInt(getChainBalance(chainId, vault.vaultAddress));
    } catch {
      locked = 0n;
    }
  }
  let minted = 0n;
  let burned = 0n;
  for (const e of events.values()) {
    if (e.chainId !== chainId || e.status === "failed") continue;
    if (e.kind === "mint" && e.status === "confirmed") minted += e.amount;
    if (e.kind === "burn" && e.status === "confirmed") burned += e.amount;
  }
  const circulating = minted - burned;
  return {
    chainId,
    vaultAddress: vault?.vaultAddress ?? null,
    locked: locked.toString(),
    wrappedCirculating: circulating.toString(),
    lastCheckedAt: new Date().toISOString(),
    healthy: locked === circulating,
  };
}

// ---------------------------------------------------------------------------
// lock-proof certificate construction
// ---------------------------------------------------------------------------

export function buildLockCertificate(chainId: string, txId: string): Record<string, unknown> {
  const chain: any = store.chains.get(chainId);
  if (!chain) {
    const err: any = new Error("Unknown chain.");
    err.code = "chain_not_found";
    err.statusCode = 404;
    throw err;
  }
  const tx: any = store.txById.get(txId);
  if (!tx || tx.chainId !== chainId || tx.blockHeight === undefined) {
    const err: any = new Error("Unknown or unconfirmed transaction.");
    err.code = "lock_not_found";
    err.statusCode = 404;
    throw err;
  }
  if (tx.type !== "TRANSFER") {
    const err: any = new Error("Not a transfer.");
    err.code = "not_a_lock";
    err.statusCode = 400;
    throw err;
  }
  const vault = ensureVault(chainId);
  if (tx.payload?.to !== vault.vaultAddress) {
    const err: any = new Error("Transaction is not a vault lock.");
    err.code = "not_to_vault";
    err.statusCode = 400;
    throw err;
  }
  const memo = parseLockMemo(tx.payload?.memo);
  if (memo.ok === false) {
    const err: any = new Error(`Invalid lock memo: ${memo.error}.`);
    err.code = "bad_lock_memo";
    err.statusCode = 400;
    throw err;
  }
  const blocks: any[] = store.blocksByChain.get(chainId) || [];
  const block = blocks[tx.blockHeight];
  if (!block) {
    const err: any = new Error("Block not found.");
    err.code = "block_not_found";
    err.statusCode = 404;
    throw err;
  }
  const leaves = block.transactions.map(txMerkleLeaf);
  const { levels } = buildMerkleTree(leaves);
  const proof = getMerkleProof(levels, tx.txIndex);

  const cert = {
    standard: "phase-lock-proof/1",
    chainId,
    lockTxId: tx.txId,
    locker: tx.sender,
    amount: BigInt(tx.payload.amount).toString(),
    decimals: chain.decimals,
    destination: {
      chain: memo.value.destinationChain,
      address: memo.value.destinationAddress,
    },
    blockHeight: tx.blockHeight,
    stateRoot: block.stateRoot,
    tx: {
      chainId: tx.chainId,
      txId: tx.txId,
      type: tx.type,
      sender: tx.sender,
      nonce: tx.nonce,
      payload: tx.payload,
      signatures: tx.signatures,
      submittedAt: tx.submittedAt,
    },
    txProof: {
      tx_root: block.txRoot,
      proof: proof.map((p: any) => p.hash),
      proof_directions: proof.map((p: any) => (p.isRight ? "right" : "left")),
      leaf_index: tx.txIndex,
    },
    headerHash: block.headerHash,
    sequencerSig: block.sequencerSig,
    sequencerPubkey: getSequencerPublicKeyRaw().toString("hex"),
  };

  // Self-check through the exact third-party path before serving.
  const v = verifyLockCertificate(cert);
  if (v.ok === false) {
    const err: any = new Error(`Built certificate failed verification: ${v.reason}.`);
    err.code = "cert_self_check_failed";
    err.statusCode = 500;
    throw err;
  }
  return cert;
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export function mountBridgeRoutes(deps: Deps): void {
  const { route, sendJson, HttpError } = deps;

  const limited = (ctx: Ctx): void => {
    const headers = (ctx.req?.headers ?? {}) as Record<string, string | string[] | undefined>;
    const ip = clientIpFromHeaders(headers);
    if (!checkRateLimit(`bridge:${ip}`, RATE_MAX, RATE_WINDOW_MS)) {
      throw new HttpError(429, "rate_limited", "Too many requests — slow down.");
    }
  };

  const fail = (ctx: Ctx, err: unknown): void => {
    if (err instanceof LedgerError) {
      sendJson(ctx.res, err.status, { error: err.code, message: err.message });
      return;
    }
    const statusCode =
      (err as { statusCode?: number }).statusCode ?? 500;
    const code = (err as { code?: string }).code ?? "internal_error";
    sendJson(ctx.res, statusCode, {
      error: code,
      message: err instanceof Error ? err.message : String(err),
    });
  };

  // GET /api/v1/bridge/vaults/:chainId — deterministic vault address + proof
  route("GET", `${PREFIX}/vaults/:chainId`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const vault = ensureVault(ctx.params.chainId);
      sendJson(ctx.res, 200, {
        chain_id: vault.chainId,
        vault_address: vault.vaultAddress,
        derivation:
          'ph1 + base58(Ed25519_pubkey(sha256("phase-bridge-vault/v1/" + chainId))) — recompute it yourself',
      });
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/bridge/locks/:txId — full lock-proof certificate
  // Query: ?chainId=ch_... (required: txIds are not globally unique lookups)
  route("GET", `${PREFIX}/locks/:txId`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const chainId = ctx.query.get("chainId");
      if (!chainId) {
        throw new HttpError(400, "missing_chainId", "Query param chainId is required.");
      }
      const cert = buildLockCertificate(chainId, ctx.params.txId);
      sendJson(ctx.res, 200, cert);
    } catch (err) {
      fail(ctx, err);
    }
  });

  // GET /api/v1/bridge/reserves — per-chain locked vs wrapped
  // Query: ?chainId=ch_... (optional; omit for all vaulted chains)
  route("GET", `${PREFIX}/reserves`, async (ctx: Ctx) => {
    try {
      limited(ctx);
      const only = ctx.query.get("chainId");
      const ids = only ? [only] : Array.from(vaults.keys());
      const out = ids.map((id) => {
        try {
          return getBridgeReserves(id);
        } catch {
          return {
            chainId: id, vaultAddress: null, locked: "0",
            wrappedCirculating: "0",
            lastCheckedAt: new Date().toISOString(), healthy: true,
          };
        }
      });
      sendJson(ctx.res, 200, { reserves: out });
    } catch (err) {
      fail(ctx, err);
    }
  });
}
