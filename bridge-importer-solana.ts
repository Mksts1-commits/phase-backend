/**
 * bridge-importer-solana.ts — the FIRST lock-proof consumer: a Solana importer.
 *
 * It is deliberately ordinary: it uses the same public surfaces any stranger
 * would — buildLockCertificate()/GET /api/v1/bridge/locks/:txId output and
 * lock-proof-verify.ts — plus normal Phase submitTransaction() calls. It is
 * the first importer, not the only one.
 *
 * KEY SEPARATION (enforced structurally):
 *   - Watcher: read-only. Scans the Phase ledger for vault locks and Solana
 *     for wrapped burns. Holds NO private keys. Verifies certificates through
 *     lock-proof-verify.ts and records 'verified' bridge_events rows.
 *   - Signer: consumes 'verified' rows only. Holds the devnet signing keys
 *     (vault keypair = deterministically re-derived — devnet only; SPL mint
 *     authority). On mainnet these would be KMS handles (see bridge-config).
 * The two halves communicate through bridge_events, never shared secrets.
 *
 * Devnet only. assertDevnetOnly() throws on any other BRIDGE_NETWORK.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  store,
  submitTransaction,
  signingMessage,
} from "./sovereign-ledger-core.js";
import {
  ensureVault,
  buildLockCertificate,
  recordBridgeEvent,
  findBridgeEvent,
  setBridgeEventStatus,
  listBridgeEvents,
  getBridgeReserves,
  type BridgeEvent,
} from "./bridge.js";
import {
  parseLockMemo,
  verifyLockCertificate,
  signWithVaultKey,
  vaultRawPubkeyHex,
  isValidPhaseAddress as isValidAddress,
} from "./lock-proof-verify.js";
import {
  assertDevnetOnly,
  isBridgePaused,
  recordMintForCircuitBreaker,
  checkDailyCaps,
  consumeDailyCap,
} from "./bridge-config.js";
import {
  getDevnetRpcUrl,
  createBridgeMint,
  mintToAddress,
} from "./solana-mint.js";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// ---------------------------------------------------------------------------
// WATCHER — read-only, no private keys
// ---------------------------------------------------------------------------

/** Per-chain lock scan cursor (last block height scanned). Rescans are safe: idempotency keys. */
const lockCursors = new Map<string, number>();

/**
 * Scan every vaulted chain for confirmed vault-lock TRANSFERs. For each new
 * lock: verify the certificate via the shared lock-proof-verify.ts path, then
 * record a 'verified' lock event (idempotent: lock:<chainId>:<txId>).
 */
export async function watcherProcessLocks(): Promise<{ found: number; verified: number }> {
  let found = 0;
  let verified = 0;
  for (const [chainId] of store.chains) {
    const vault = ensureVault(chainId);
    const blocks = store.blocksByChain.get(chainId) || [];
    const from = lockCursors.get(chainId) ?? -1;
    for (let h = from + 1; h < blocks.length; h++) {
      for (const tx of blocks[h].transactions) {
        if (tx.type !== "TRANSFER") continue;
        if (tx.payload?.to !== vault.vaultAddress) continue;
        const memo = parseLockMemo(tx.payload?.memo);
        if (memo.ok === false || memo.value.destinationChain !== "solana") continue;
        found++;
        const key = `lock:${chainId}:${tx.txId}`;
        if (findBridgeEvent(key)) continue; // already handled
        // Verify through the exact path a stranger would use.
        const cert = buildLockCertificate(chainId, tx.txId);
        const v = verifyLockCertificate(cert);
        if (!v.ok) {
          recordBridgeEvent({
            chainId, kind: "lock", phaseTxId: tx.txId,
            amount: BigInt(tx.payload.amount), status: "failed",
            idempotencyKey: key,
            detail: { reason: v.ok ? null : (v as { reason: string }).reason },
          });
          continue;
        }
        recordBridgeEvent({
          chainId, kind: "lock", phaseTxId: tx.txId,
          amount: BigInt(tx.payload.amount), status: "verified",
          idempotencyKey: key,
          detail: { destination: memo.value.destinationAddress, blockHeight: tx.blockHeight },
        });
        verified++;
      }
    }
    lockCursors.set(chainId, blocks.length - 1);
  }
  return { found, verified };
}

interface BurnCandidate {
  txSig: string;
  mint: string;
  amount: bigint;
  phaseAddress: string; // burn memo: ph1... destination for the unlock
}

/**
 * Scan a Solana wrapped mint for burn transactions carrying a `ph1...` memo.
 * Read-only: never signs. `before` paginates backwards.
 */
export async function watcherScanBurns(
  connection: Connection,
  mintAddress: string,
  opts?: { before?: string; limit?: number }
): Promise<BurnCandidate[]> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintAddress);
  } catch {
    throw new Error(`[importer] watcherScanBurns: invalid mint address ${JSON.stringify(mintAddress)}`);
  }
  const limit = opts?.limit ?? 25;
  const sigs = await connection.getSignaturesForAddress(
    mint,
    { before: opts?.before, limit },
    "finalized"
  );
  const out: BurnCandidate[] = [];
  for (const s of sigs) {
    if (s.err) continue; // ignore failed txs
    const tx = await connection.getTransaction(s.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;
    const ix = tx.transaction.message.compiledInstructions;
    const keys = tx.transaction.message.staticAccountKeys;
    let memoAddr: string | null = null;
    let burned: bigint | null = null;
    for (const ci of ix) {
      const programId = keys[ci.programIdIndex].toBase58();
      const data = Buffer.from((ci as any).data ?? []);
      if (programId === MEMO_PROGRAM_ID.toBase58()) {
        const text = data.toString("utf8").trim();
        if (isValidAddress(text)) memoAddr = text;
      }
      if (programId === TOKEN_PROGRAM_ID.toBase58() && data.length >= 9 && data[0] === 8) {
        // TokenInstruction.Burn = 8, amount u64 LE at [1..9)
        burned = data.readBigUInt64LE(1);
      }
    }
    if (memoAddr && burned !== null && burned > 0n) {
      out.push({ txSig: s.signature, mint: mintAddress, amount: burned, phaseAddress: memoAddr });
    }
  }
  return out;
}

/**
 * Record burn candidates as 'verified' burn events
 * (idempotent: burn:<mint>:<txSig>).
 */
export function watcherRecordBurns(chainId: string, burns: BurnCandidate[]): number {
  let n = 0;
  for (const b of burns) {
    const key = `burn:${b.mint}:${b.txSig}`;
    const { created } = recordBridgeEvent({
      chainId, kind: "burn", destTxSig: b.txSig,
      amount: b.amount, status: "verified",
      idempotencyKey: key,
      detail: { mint: b.mint, phaseAddress: b.phaseAddress },
    });
    if (created) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// SIGNER — consumes 'verified' rows; holds devnet keys (never the watcher)
// ---------------------------------------------------------------------------

const bridgeMints = new Map<string, string>(); // `${chainId}:solana` -> mintAddress

async function getOrCreateWrappedMint(chainId: string): Promise<string> {
  const k = `${chainId}:solana`;
  let m = bridgeMints.get(k);
  if (!m) {
    // Survive restarts: check the registry table before creating a new mint.
    try {
      const mod: any = await import("./db.js");
      const pool = mod.getPool();
      const r = await pool.query(
        `SELECT mint_address FROM bridge_mints WHERE chain_id = $1 AND destination_chain = 'solana'`,
        [chainId]
      );
      if (r.rows?.[0]?.mint_address) {
        m = r.rows[0].mint_address as string;
        bridgeMints.set(k, m);
        return m;
      }
    } catch {
      /* best-effort */
    }
    const r = await createBridgeMint();
    m = r.mintAddress;
    bridgeMints.set(k, m);
    // best-effort persistence of the registry
    try {
      const mod: any = await import("./db.js");
      const pool = mod.getPool();
      await pool.query(
        `INSERT INTO bridge_mints (chain_id, destination_chain, mint_address) VALUES ($1,'solana',$2)
         ON CONFLICT (chain_id, destination_chain) DO UPDATE SET mint_address = EXCLUDED.mint_address`,
        [chainId, m]
      );
    } catch {
      /* best-effort */
    }
  }
  return m;
}

/** Mint side: 'verified' lock events -> wrapped mints on Solana devnet. */
export async function signerProcessMints(
  connection: Connection
): Promise<{ minted: number; skipped: number }> {
  assertDevnetOnly();
  let minted = 0;
  let skipped = 0;
  // iterate the in-memory event registry via a snapshot helper below
  for (const e of verifiedLocks()) {
    const detail = (e.detail ?? {}) as { destination?: string };
    const destAddress = detail.destination;
    if (!destAddress) {
      setBridgeEventStatus(e.idempotencyKey, "failed", { detail: { reason: "missing destination" } });
      continue;
    }
    const pause = isBridgePaused();
    if (pause.paused) {
      skipped++;
      continue;
    }
    const chain: any = store.chains.get(e.chainId);
    const supply = chain ? BigInt(chain.totalSupply) : 0n;
    // caps are enforced in USD; devnet wrapped tokens have no price feed, so
    // we gate on supply-percentage and the global USD cap with usdValue=0,
    // and record the breaker tick post-mint.
    const capCheck = checkDailyCaps(e.chainId, 0);
    if (capCheck.ok === false) {
      setBridgeEventStatus(e.idempotencyKey, "failed", { detail: { reason: capCheck.reason } });
      skipped++;
      continue;
    }
    try {
      const mintAddr = await getOrCreateWrappedMint(e.chainId);
      const sig = await mintToAddress(mintAddr, destAddress, e.amount);
      recordBridgeEvent({
        chainId: e.chainId, kind: "mint",
        phaseTxId: e.phaseTxId, destTxSig: sig,
        amount: e.amount, status: "confirmed",
        idempotencyKey: `mint:${e.chainId}:${e.phaseTxId}`,
        detail: { mint: mintAddr, lockEventId: e.id },
      });
      setBridgeEventStatus(e.idempotencyKey, "confirmed");
      recordMintForCircuitBreaker(e.chainId, e.amount, supply, 0);
      consumeDailyCap(e.chainId, 0);
      minted++;
    } catch (err) {
      setBridgeEventStatus(e.idempotencyKey, "failed", {
        detail: { reason: err instanceof Error ? err.message : String(err) },
      });
      skipped++;
    }
  }
  return { minted, skipped };
}
function nextVaultNonce(chainId: string, vaultAddr: string): number {
  const committed = (store as any).getBalanceEntry(chainId, vaultAddr).nonce as number;
  const pending = (store.mempoolByChain.get(chainId) || []).filter(
    (t: any) => t.sender === vaultAddr
  );
  if (pending.length) return Math.max(...pending.map((t: any) => t.nonce)) + 1;
  return committed + 1;
}

async function waitForTx(chainId: string, txId: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tx: any = store.txById.get(txId);
    if (tx && tx.blockHeight !== undefined) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`unlock ${txId} not confirmed within ${timeoutMs}ms`);
}

/** Unlock side: 'verified' burn events -> vault TRANSFER to the ph1 address. */
export async function signerProcessUnlocks(): Promise<{ unlocked: number; skipped: number }> {
  assertDevnetOnly();
  let unlocked = 0;
  let skipped = 0;
  for (const e of verifiedBurns()) {
    const detail = (e.detail ?? {}) as { phaseAddress?: string };
    const dest = detail.phaseAddress;
    if (!dest || !isValidAddress(dest)) {
      setBridgeEventStatus(e.idempotencyKey, "failed", { detail: { reason: "bad phase address" } });
      skipped++;
      continue;
    }
    const pause = isBridgePaused();
    if (pause.paused) {
      skipped++;
      continue;
    }
    try {
      const vault = ensureVault(e.chainId);
      const unlockKey = `unlock:${e.destTxSig}`;
      if (findBridgeEvent(unlockKey)) {
        setBridgeEventStatus(e.idempotencyKey, "confirmed");
        continue; // already unlocked — replay safe
      }
      const nonce = nextVaultNonce(e.chainId, vault.vaultAddress);
      const txId = `unlock_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const tx: any = {
        chainId: e.chainId,
        txId,
        type: "TRANSFER",
        sender: vault.vaultAddress,
        nonce,
        payload: { to: dest, amount: e.amount.toString() },
        signatures: [],
        submittedAt: Date.now(),
      };
      const sigHex = signWithVaultKey(e.chainId, signingMessage(tx)).toString("hex");
      tx.signatures = [{ pubkey: vaultRawPubkeyHex(e.chainId), signature: sigHex }];
      const res: any = await submitTransaction(e.chainId, {
        tx_id: txId,
        type: "TRANSFER",
        sender: vault.vaultAddress,
        nonce,
        submitted_at: tx.submittedAt,
        payload: tx.payload,
        signatures: tx.signatures,
      });
      if (res?.status !== 202) {
        throw new Error(`unlock submit rejected: ${JSON.stringify(res?.body)}`);
      }
      await waitForTx(e.chainId, txId);
      recordBridgeEvent({
        chainId: e.chainId, kind: "unlock", phaseTxId: txId,
        destTxSig: e.destTxSig, amount: e.amount, status: "confirmed",
        idempotencyKey: unlockKey,
        detail: { burnEventId: e.id, to: dest },
      });
      setBridgeEventStatus(e.idempotencyKey, "confirmed");
      unlocked++;
    } catch (err) {
      setBridgeEventStatus(e.idempotencyKey, "failed", {
        detail: { reason: err instanceof Error ? err.message : String(err) },
      });
      skipped++;
    }
  }
  return { unlocked, skipped };
}

// ---------------------------------------------------------------------------
// event-registry iteration helpers (watcher <-> signer handoff surface)
// ---------------------------------------------------------------------------

function verifiedLocks(): BridgeEvent[] {
  return listBridgeEvents({ kind: "lock", status: "verified" });
}

function verifiedBurns(): BridgeEvent[] {
  return listBridgeEvents({ kind: "burn", status: "verified" });
}

// ---------------------------------------------------------------------------
// service loop
// ---------------------------------------------------------------------------

export function newConnection(): Connection {
  assertDevnetOnly();
  return new Connection(getDevnetRpcUrl(), "confirmed");
}

export interface ImporterStats {
  locks: { found: number; verified: number };
  mints: { minted: number; skipped: number };
  unlocks: { unlocked: number; skipped: number };
}

/** One full pass: locks -> mints, burns -> unlocks. */
export async function importerOnce(connection?: Connection): Promise<ImporterStats> {
  const conn = connection ?? newConnection();
  const locks = await watcherProcessLocks();
  const mints = await signerProcessMints(conn);
  const unlocks = await signerProcessUnlocks();
  return { locks, mints, unlocks };
}

/** Reserve health across all vaulted chains. */
export function reserveReport(): ReturnType<typeof getBridgeReserves>[] {
  return Array.from(store.chains.keys())
    .filter((id) => (store.chains.get(id) as any)?.status === "active")
    .map((id) => getBridgeReserves(id));
}

// Run as a service: `npx tsx bridge-importer-solana.ts`
const isMain = process.argv[1]?.endsWith("bridge-importer-solana.ts");
if (isMain) {
  assertDevnetOnly();
  const conn = newConnection();
  console.log("[importer] starting on devnet, polling every 15s");
  const tick = async () => {
    try {
      const s = await importerOnce(conn);
      console.log("[importer]", JSON.stringify(s), "paused:", isBridgePaused());
    } catch (err) {
      console.error("[importer] tick failed:", err instanceof Error ? err.message : err);
    }
  };
  void tick();
  setInterval(() => void tick(), 15_000);
}
