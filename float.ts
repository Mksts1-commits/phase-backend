/**
 * float.ts — post-mint public-float increases for coin issuers.
 *
 * POST /api/v1/coins/:id/float/increase
 *   Owner-only. Moves whole shares from the issuer's retained balance
 *   to the public float address (PUBLIC_FLOAT_ADDRESS) via the ledger's
 *   operator-settled transfer primitive. Total supply NEVER changes —
 *   this only re-splits it between retained and float. There is no
 *   decrease path: released shares cannot come back.
 *
 *   The signed agreement records the GENESIS split; a float increase
 *   releases retained shares on top of it. Sold math must therefore use
 *   the cumulative release (see coinFloatPosition in issuance.ts):
 *   sold = (genesisFloat + floatReleasedShares) - live float balance.
 *
 *   Settlement is async: the transfer queues to the mempool and the
 *   sequencer confirms it in the next block (~2s). The response reports
 *   PROJECTED balances that assume confirmation, and says so.
 *
 *   Idempotency: an optional Idempotency-Key header. A replay of the
 *   same (coin, key) returns the original tx_id without a second
 *   transfer (migration 028 table + a per-coin in-process mutex so
 *   concurrent same-key requests serialize; the backend runs as a
 *   single process, so this covers the real races).
 *
 *   Auth: session Bearer tokens keep full access; OAuth tokens must
 *   carry the write:float scope (oauth.ts). Same helper shape as
 *   coin-edit.ts's requireScopedUserId.
 *
 * Mounted from phase-backend.ts: mountFloatRoutes({ route, sendJson, HttpError })
 */
import { getIssuanceStore } from "./issuance.js";
import { resolveBearerAuth } from "./oauth.js";
import {
  store as ledgerStore,
  getChainBalance,
  settleOperatorTransfer,
  PUBLIC_FLOAT_ADDRESS,
  auditLog,
  LedgerError,
} from "./sovereign-ledger-core.js";

export interface FloatMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
}

interface Ctx {
  req: { headers: Record<string, string | string[] | undefined> };
  res: any;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

const ENVELOPE = { network: "sovereign" as const, chain: "phase" as const };

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

class FloatHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

/** Per-coin promise-chain mutex: serializes same-coin float increases
 *  within this process so check → transfer → record is atomic for
 *  idempotency. Different coins proceed in parallel. */
const coinLocks = new Map<string, Promise<void>>();
async function withCoinLock<T>(coinId: string, fn: () => Promise<T>): Promise<T> {
  const prev = coinLocks.get(coinId) ?? Promise.resolve();
  let release!: () => void;
  const cur = new Promise<void>((resolve) => { release = resolve; });
  const chained = prev.then(() => cur);
  coinLocks.set(coinId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (coinLocks.get(coinId) === chained) coinLocks.delete(coinId);
  }
}

/** Parse { shares } — whole shares only, must be > 0. Accepts a JSON
 *  integer or a digit string; rejects fractions, zero, negatives, and
 *  anything non-numeric with 400 invalid_amount. */
function parseShares(body: unknown): bigint {
  const raw = asRecord(body).shares;
  let n: bigint;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new FloatHttpError(400, "invalid_amount", "shares must be a positive whole number of shares.");
    }
    n = BigInt(raw);
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    n = BigInt(raw.trim());
  } else {
    throw new FloatHttpError(400, "invalid_amount", "shares must be a positive whole number of shares.");
  }
  if (n <= 0n) {
    throw new FloatHttpError(400, "invalid_amount", "shares must be a positive whole number of shares.");
  }
  return n;
}

/** The issuer's spendable balance: committed balance minus transfers
 *  already queued in the mempool from this address (those shares are
 *  committed until their block confirms, but spending them twice would
 *  fail at block application — so they are not spendable). Falls back
 *  to the committed balance if the mempool shape ever surprises us. */
function effectiveBalance(chainId: string, address: string): bigint {
  const committed = BigInt(getChainBalance(chainId, address));
  try {
    const pending = ledgerStore.mempoolByChain.get(chainId) ?? [];
    let out = 0n;
    for (const tx of pending) {
      if (tx.status !== "pending" || tx.type !== "TRANSFER" || tx.sender !== address) continue;
      const payload = tx.payload as { amount?: unknown };
      if (typeof payload.amount === "string") out += BigInt(payload.amount);
    }
    const eff = committed - out;
    return eff < 0n ? 0n : eff;
  } catch {
    return committed;
  }
}

export function mountFloatRoutes(deps: FloatMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof FloatHttpError;

  const fail = (ctx: Ctx, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...ENVELOPE, error: code, message });
  };

  /** Scoped variant: session tokens keep full access; OAuth tokens
   *  must carry write:float. Same shape as coin-edit.ts. */
  const requireScopedUserId = async (ctx: Ctx, scope: string): Promise<string> => {
    const authed = await resolveBearerAuth(ctx.req.headers);
    if (!authed) throw new HttpError(401, "unauthorized", "Sign in required.");
    if (authed.kind === "oauth" && !authed.scopes.includes(scope)) {
      throw new HttpError(403, "insufficient_scope", `This token lacks the ${scope} scope.`);
    }
    return authed.userId;
  };

  const idempotencyKey = (ctx: Ctx): string | null => {
    const raw = ctx.req.headers["idempotency-key"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    const key = (v ?? "").trim();
    return key ? key : null;
  };

  // --- POST /api/v1/coins/:id/float/increase ---
  route("POST", "/api/v1/coins/:id/float/increase", async (ctx: Ctx) => {
    try {
      const userId = await requireScopedUserId(ctx, "write:float");
      const shares = parseShares(ctx.body);
      const key = idempotencyKey(ctx);

      const issuance = await getIssuanceStore();
      const coin = await issuance.getCoinById(ctx.params.id);
      if (!coin) throw new HttpError(404, "coin_not_found", "No coin with that id.");
      if (coin.userId !== userId) {
        throw new HttpError(403, "forbidden", "Only the issuer can edit this coin.");
      }
      if (!coin.issuerAddress) {
        throw new HttpError(409, "no_issuer_address", "This coin has no issuer address on record, so its retained balance cannot be released.");
      }
      // Chain must exist and be active — checked here (not via the
      // balance lookup, which auto-creates zero entries for unknown
      // chains) so the error codes stay exact.
      const chain = ledgerStore.chains.get(coin.mintAddress);
      if (!chain) throw new HttpError(404, "chain_not_found", "Unknown chain for this coin.");
      if (chain.status !== "active") throw new HttpError(409, "chain_not_active", "This coin's chain is not active.");

      const result = await withCoinLock(coin.id, async () => {
        // Idempotent replay: same (coin, key) returns the original tx.
        if (key) {
          const existing = await issuance.getFloatIncreaseRequest(coin.id, key);
          if (existing) return { txId: existing.txId, shares: BigInt(existing.shares), replay: true, snapshotFloat: null as bigint | null, snapshotRetained: null as bigint | null };
        }
        const balance = effectiveBalance(coin.mintAddress, coin.issuerAddress as string);
        if (shares > balance) {
          throw new HttpError(
            409,
            "insufficient_balance",
            `Insufficient retained balance: you hold ${balance.toString()} shares, tried to release ${shares.toString()}.`
          );
        }
        // Snapshot pre-transfer balances: projections are computed from
        // these, not re-read after queueing, so a block confirming
        // between queue and response cannot double-count the shares.
        const snapshotFloat = BigInt(getChainBalance(coin.mintAddress, PUBLIC_FLOAT_ADDRESS));
        const snapshotRetained = BigInt(getChainBalance(coin.mintAddress, coin.issuerAddress as string));
        let txId: string;
        try {
          const settled = await settleOperatorTransfer(
            coin.mintAddress,
            coin.issuerAddress as string,
            PUBLIC_FLOAT_ADDRESS,
            shares.toString(),
            "float increase"
          );
          txId = settled.tx_id;
        } catch (err) {
          // LedgerError carries .code + .status (404 chain_not_found,
          // 409 chain_not_active / insufficient_balance, 400
          // invalid_amount); anything else is a 500.
          if (err instanceof LedgerError) throw new HttpError(err.status, err.code, err.message);
          const e = err as { code?: string; status?: number };
          if (e.code && e.status) throw new HttpError(e.status, e.code, err instanceof Error ? err.message : String(err));
          throw err;
        }
        await issuance.addFloatReleased(coin.id, Number(shares));
        if (key) {
          await issuance.recordFloatIncreaseRequest({
            coinId: coin.id,
            idempotencyKey: key,
            txId,
            shares: Number(shares),
          });
        }
        await auditLog(userId, "float_increase", "coin", coin.id, {
          shares: shares.toString(),
          txId,
          chainId: coin.mintAddress,
        });
        return { txId, shares, replay: false, snapshotFloat, snapshotRetained };
      });

      // Projections assume the queued transfer confirms: pre-transfer
      // snapshot ± shares. Total supply never changes — this only
      // re-splits it. For a replay the increase already happened, so
      // the projections are simply the current live balances.
      const liveFloat = BigInt(getChainBalance(coin.mintAddress, PUBLIC_FLOAT_ADDRESS));
      const liveRetained = BigInt(getChainBalance(coin.mintAddress, coin.issuerAddress));
      const projectedFloatAvailable = result.replay
        ? liveFloat
        : (result.snapshotFloat as bigint) + result.shares;
      const projectedRetained = result.replay
        ? liveRetained
        : (result.snapshotRetained as bigint) - result.shares;
      const total = coin.totalShares != null ? BigInt(Math.round(Number(coin.totalShares))) : null;
      const projectedFloatPct = total != null && total > 0n
        ? Number((projectedFloatAvailable * 10000n) / total) / 100
        : null;

      sendJson(ctx.res, 200, {
        ...ENVELOPE,
        tx_id: result.txId,
        status: "pending",
        shares: result.shares.toString(),
        idempotentReplay: result.replay,
        projectedFloatAvailable: projectedFloatAvailable.toString(),
        projectedRetained: projectedRetained.toString(),
        projectedFloatPct,
        message: result.replay
          ? "Replay of an earlier float increase: same transaction, no second transfer."
          : "Float increase queued for settlement (mempool → block, ~seconds). Projections assume confirmation; total supply never changes.",
      });
    } catch (err) { fail(ctx, err); }
  });
}
