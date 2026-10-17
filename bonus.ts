/**
 * bonus.ts — signup bonus pool (fixed pool, admin-adjustable).
 *
 * New users receive BONUS_PER_SIGNUP (1000) PHASE on signup, drawn from a
 * fixed pool. The pool never mints beyond its configured total_supply.
 * Admins raise the cap via POST /api/v1/admin/bonus-pool (append-only
 * version rows, latest wins — same pattern as fee_config).
 * When the pool is exhausted, signups simply get no bonus (no error).
 *
 * Mounted from phase-backend.ts: mountBonusRoutes({ route, sendJson, HttpError })
 */
import { getPool, dbQueryOne } from "./db.js";
import { isAdminUser } from "./fee.js";

export interface BonusMountDeps {
  route: (method: string, path: string, handler: (ctx: any) => void | Promise<void>) => void;
  sendJson: (res: any, statusCode: number, body: unknown) => void;
  HttpError: new (statusCode: number, code: string, message: string) => Error;
  // Passed in (not imported) so auth.ts can import this module without a cycle.
  resolveBearerUserId: (headers: Record<string, string | string[] | undefined>) => Promise<string | null>;
}

const ENVELOPE = { network: "sovereign" as const, chain: "phase" as const };

/** PHASE credited to each new signup while the pool lasts. */
export const BONUS_PER_SIGNUP = 1000;

class BonusHttpError extends Error {
  constructor(public statusCode: number, public code: string, message: string) {
    super(message);
  }
}

export interface BonusPoolStatus {
  totalSupply: number;
  distributed: number;
  remaining: number;
  bonusPerSignup: number;
}

export async function getBonusPoolStatus(): Promise<BonusPoolStatus> {
  const pool = await dbQueryOne<{ total_supply: string }>(
    `SELECT total_supply FROM bonus_pool ORDER BY version DESC LIMIT 1`
  );
  const dist = await dbQueryOne<{ distributed: string }>(
    `SELECT distributed FROM bonus_pool_distributed WHERE id = 1`
  );
  const totalSupply = Number(pool?.total_supply ?? 0);
  const distributed = Number(dist?.distributed ?? 0);
  return {
    totalSupply,
    distributed,
    remaining: Math.max(0, totalSupply - distributed),
    bonusPerSignup: BONUS_PER_SIGNUP,
  };
}

export async function getPhaseBalance(userId: string): Promise<number> {
  const row = await dbQueryOne<{ phase_balance: string }>(
    `SELECT phase_balance FROM issuance_users WHERE id = $1`,
    [userId]
  );
  return Number(row?.phase_balance ?? 0);
}

/**
 * Credit the signup bonus once per user. Idempotent via bonus_granted.
 * Atomically reserves from the pool — if the pool can't cover the bonus,
 * the user simply gets nothing (returns false, no error).
 */
export async function grantSignupBonus(userId: string): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const already = await client.query(
      `SELECT bonus_granted FROM issuance_users WHERE id = $1 FOR UPDATE`,
      [userId]
    );
    if (already.rows.length === 0 || already.rows[0].bonus_granted) {
      await client.query("ROLLBACK");
      return already.rows.length > 0; // true if already granted before
    }
    const reserve = await client.query(
      `UPDATE bonus_pool_distributed
       SET distributed = distributed + $1, updated_at = NOW()
       WHERE id = 1
         AND distributed + $1 <= (SELECT total_supply FROM bonus_pool ORDER BY version DESC LIMIT 1)
       RETURNING distributed`,
      [BONUS_PER_SIGNUP]
    );
    if (reserve.rows.length === 0) {
      // Pool exhausted — mark granted (so we don't retry forever) but pay nothing.
      await client.query(
        `UPDATE issuance_users SET bonus_granted = TRUE WHERE id = $1`,
        [userId]
      );
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `UPDATE issuance_users SET phase_balance = phase_balance + $1, bonus_granted = TRUE WHERE id = $2`,
      [BONUS_PER_SIGNUP, userId]
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Admin: raise the pool cap by appending a new version row. */
export async function addBonusSupply(createdBy: string, addSupply: number, reason?: string): Promise<BonusPoolStatus> {
  if (!Number.isInteger(addSupply) || addSupply <= 0 || addSupply > 1_000_000_000) {
    throw new BonusHttpError(422, "invalid_supply", "addSupply must be a positive whole number (max 1B).");
  }
  const latest = await dbQueryOne<{ total_supply: string }>(
    `SELECT total_supply FROM bonus_pool ORDER BY version DESC LIMIT 1`
  );
  const newTotal = Number(latest?.total_supply ?? 0) + addSupply;
  await getPool().query(
    `INSERT INTO bonus_pool (total_supply, created_by, reason) VALUES ($1, $2, $3)`,
    [newTotal, createdBy, reason?.slice(0, 280) ?? null]
  );
  return getBonusPoolStatus();
}

/** Spend PHASE from the user's balance. Returns the new balance. */
export async function spendPhase(userId: string, amount: number): Promise<number> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BonusHttpError(422, "invalid_amount", "amount must be a positive number.");
  }
  const units = Math.floor(amount);
  if (units < 1) throw new BonusHttpError(422, "amount_too_small", "amount must be at least 1 PHASE.");
  const row = await dbQueryOne<{ phase_balance: string }>(
    `UPDATE issuance_users SET phase_balance = phase_balance - $1
     WHERE id = $2 AND phase_balance >= $1
     RETURNING phase_balance`,
    [units, userId]
  );
  if (!row) throw new BonusHttpError(422, "insufficient_balance", "Not enough PHASE coins.");
  return Number(row.phase_balance);
}

export function mountBonusRoutes(deps: BonusMountDeps): void {
  const { route, sendJson } = deps;
  const HttpError = deps.HttpError as unknown as typeof BonusHttpError;

  const fail = (ctx: any, err: unknown): void => {
    const e = err as { statusCode?: number; status?: number; code?: string };
    const statusCode = e.statusCode ?? e.status ?? 500;
    const code = e.code ?? "internal_error";
    const message = err instanceof Error ? err.message : String(err);
    sendJson(ctx.res, statusCode, { ...ENVELOPE, error: code, message });
  };

  const requireAdmin = async (ctx: any): Promise<string> => {
    const userId = await deps.resolveBearerUserId(ctx.req.headers);
    if (!userId) throw new HttpError(401, "unauthorized", "Sign in required.");
    if (!(await isAdminUser(userId))) throw new HttpError(403, "forbidden", "Admin only.");
    return userId;
  };

  // --- GET /api/v1/admin/bonus-pool ---
  route("GET", "/api/v1/admin/bonus-pool", async (ctx: any) => {
    try {
      await requireAdmin(ctx);
      sendJson(ctx.res, 200, { ...ENVELOPE, pool: await getBonusPoolStatus() });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/admin/bonus-pool ---
  // Body: { addSupply, reason? } — raises the cap; append-only.
  route("POST", "/api/v1/admin/bonus-pool", async (ctx: any) => {
    try {
      const adminId = await requireAdmin(ctx);
      const body = (ctx.body !== null && typeof ctx.body === "object" && !Array.isArray(ctx.body))
        ? (ctx.body as Record<string, unknown>) : {};
      const addSupply = typeof body.addSupply === "number" ? body.addSupply : NaN;
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      const pool = await addBonusSupply(adminId, addSupply, reason);
      sendJson(ctx.res, 200, { ...ENVELOPE, pool });
    } catch (err) { fail(ctx, err); }
  });

  // --- GET /api/v1/bonus-pool (public) ---
  // Public pool status for the landing page "X of 10,000 claimed" counter.
  // No auth required — reveals only aggregate counts, no user data.
  route("GET", "/api/v1/bonus-pool", async (ctx: any) => {
    try {
      sendJson(ctx.res, 200, { ...ENVELOPE, pool: await getBonusPoolStatus() });
    } catch (err) { fail(ctx, err); }
  });

  // --- POST /api/v1/account/phase-spend ---
  // Spend PHASE from the caller's balance (e.g. investing with PHASE).
  // Body: { amount } — whole PHASE units.
  route("POST", "/api/v1/account/phase-spend", async (ctx: any) => {
    try {
      const userId = await deps.resolveBearerUserId(ctx.req.headers);
      if (!userId) throw new HttpError(401, "unauthorized", "Sign in required.");
      const body = (ctx.body !== null && typeof ctx.body === "object" && !Array.isArray(ctx.body))
        ? (ctx.body as Record<string, unknown>) : {};
      const amount = typeof body.amount === "number" ? body.amount : NaN;
      const phaseBalance = await spendPhase(userId, amount);
      sendJson(ctx.res, 200, { ...ENVELOPE, phaseBalance });
    } catch (err) { fail(ctx, err); }
  });
}
