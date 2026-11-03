/**
 * Volume-accent data (2026-11-03 approved spec): for each coin, the shares
 * traded in the trailing 30 days as a PERCENTAGE OF FLOAT, its prize tier,
 * and the real last-30-trades price series for the graphs.
 *
 * Server-side, from market_trades only — never synthesized. Buys and swaps
 * both count: both settle out of the coin's public float (see
 * marketplace.ts), and market_trades.units are whole coins, so SUM(units)
 * is float shares traded. The price series is trade price_usd values in
 * chronological order (oldest first).
 *
 * Degrades to nulls (unknown, NOT red) when the trades table is
 * unreachable, so a directory/my-coins read never fails on volume. The
 * frontend only accents a price when volumeTier is non-null.
 */

import { getPool } from "./db.js";

export type VolumeTier = "none" | "pale" | "gold" | "strong";

export interface CoinVolume {
  /** Shares traded in the trailing 30 days, as % of current float. Null = unknown. */
  volumePctFloat: number | null;
  /** Prize tier for volumePctFloat. Null = unknown (no accent). */
  volumeTier: VolumeTier | null;
  /** Last up to 30 trade prices, chronological. Null = unknown; [] = no trades. */
  priceSeries30d: number[] | null;
}

export function volumeTierForPct(pct: number | null): VolumeTier | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct <= 0) return "none";
  if (pct <= 2) return "pale";
  if (pct <= 10) return "gold";
  return "strong";
}

/**
 * Current total float shares for a coin: genesis float
 * (totalShares - retainedShares) plus cumulative post-mint releases
 * (floatReleasedShares, migration 028) — the same formula as
 * coinFloatPosition in issuance.ts. Legacy coins without total/retained
 * shares fall back to supply x the draft's public-float percent. Returns
 * null when the float cannot be derived (caller treats volume as unknown).
 */
export function coinTotalFloatShares(
  coin: {
    totalShares?: number | null;
    retainedShares?: number | null;
    floatReleasedShares?: number | null;
    supply?: string | null;
  },
  draftEquityPublic?: number | null,
): number | null {
  const total = coin.totalShares;
  const retained = coin.retainedShares;
  if (total != null && retained != null) {
    const f = total - retained + (coin.floatReleasedShares ?? 0);
    return f > 0 ? f : null;
  }
  if (coin.supply != null && draftEquityPublic != null) {
    const f = Number(coin.supply) * draftEquityPublic / 100;
    return f > 0 ? f : null;
  }
  return null;
}

/**
 * Compute volume for a set of coins. `floats` maps coin id -> current total
 * float shares (null = unknown float). Never throws: on any DB failure every
 * coin gets nulls and the error is logged server-side.
 */
export async function computeCoinVolumes(
  floats: Map<string, number | null>,
): Promise<Map<string, CoinVolume>> {
  const out = new Map<string, CoinVolume>();
  for (const id of floats.keys()) {
    out.set(id, { volumePctFloat: null, volumeTier: null, priceSeries30d: null });
  }
  try {
    const pool = getPool();
    const [volRows, pxRows] = await Promise.all([
      pool.query(
        `SELECT coin_id, SUM(units)::float8 AS shares
           FROM market_trades
          WHERE created_at >= now() - interval '30 days'
          GROUP BY coin_id`,
      ),
      // rn 1 = newest trade per coin; ORDER BY rn DESC yields oldest first.
      pool.query(
        `SELECT coin_id, price_usd::float8 AS price FROM (
           SELECT coin_id, price_usd,
                  ROW_NUMBER() OVER (PARTITION BY coin_id ORDER BY created_at DESC, id DESC) AS rn
             FROM market_trades
         ) t WHERE rn <= 30 ORDER BY coin_id, rn DESC`,
      ),
    ]);
    const shares = new Map<string, number>();
    for (const r of volRows.rows as Array<{ coin_id: string; shares: number }>) {
      shares.set(r.coin_id, Number(r.shares) || 0);
    }
    const series = new Map<string, number[]>();
    for (const r of pxRows.rows as Array<{ coin_id: string; price: number }>) {
      const arr = series.get(r.coin_id) ?? [];
      const p = Number(r.price);
      if (Number.isFinite(p)) arr.push(p);
      series.set(r.coin_id, arr);
    }
    for (const [id, floatShares] of floats) {
      const traded = shares.get(id) ?? 0;
      const pct = floatShares != null ? (traded / floatShares) * 100 : null;
      out.set(id, {
        volumePctFloat: pct,
        volumeTier: volumeTierForPct(pct),
        priceSeries30d: series.get(id) ?? [],
      });
    }
  } catch (e) {
    console.error("[volume] trades query failed — returning unknown volume", e);
  }
  return out;
}
