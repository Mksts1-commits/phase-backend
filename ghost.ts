/**
 * Ghost line (2026-11-03 approved design): a dotted, swap-implied price
 * series for a coin's chart, computed server-side from REAL coin-for-coin
 * swaps only — never synthesized, interpolated, or smoothed into existence.
 *
 * Mechanism (barter-ratio / implied cross-rate pricing): a swap of
 * offerUnits of coin O for units of coin T implies a USD price for T of
 *   offerUnits * refPrice(O) / units,
 * and symmetrically for O. The reference price for the counter-coin is its
 * last cash ('buy') trade price in the trailing 30 days, else its recorded
 * asking price (issuance_coins.price_usd, always present). Each swap
 * therefore yields one implied point per coin involved.
 *
 * Honesty notes, read before changing this file:
 * - Instant swaps price off the two coins' recorded asks, so their implied
 *   points anchor near the asks; real fluctuation comes from negotiated
 *   (consent-based) swaps, where the parties set the ratio themselves.
 * - Trade rows record GROSS target units (the buyer receives net of the
 *   <=80bps + 1-coin Phase fee). The fee wedge is negligible against
 *   negotiated ratios and is documented, not hidden.
 * - Points are size-weighted (VWAP-style) into one point per day with
 *   swaps, weighted by the coin's own units in each swap, so one lopsided
 *   peer-negotiated swap cannot spike the line. Days without swaps
 *   contribute NO point — the frontend bridges gaps with straight segments
 *   (standard chart behaviour) and must never invent points.
 * - Degrades to nulls (unknown) on any DB failure, so a directory/my-coins
 *   read never fails on the ghost series. The frontend draws the ghost
 *   line only when the series is a non-empty array.
 */

import { getPool } from "./db.js";

export interface SwapRow {
  coin_id: string;
  offer_coin_id: string;
  units: number;
  offer_units: number | null;
  created_at: Date | string;
}

/**
 * Pure swap-implied-price math (no DB): one size-weighted point per coin
 * per UTC day with swaps. Kept separate from the query code so it can be
 * unit-tested without a database. Only coins present in `coinIds` are
 * returned; swaps referencing other coins still contribute implied points
 * for the in-scope side.
 */
export function ghostDailyVwap(
  swaps: SwapRow[],
  refs: Map<string, number>,
  coinIds: Set<string>,
): Map<string, number[]> {
  const buckets = new Map<string, Map<string, { wsum: number; w: number }>>();
  const addPoint = (coinId: string, day: string, price: number, weight: number) => {
    if (!coinIds.has(coinId)) return;
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(weight) || weight <= 0) return;
    let byDay = buckets.get(coinId);
    if (!byDay) { byDay = new Map(); buckets.set(coinId, byDay); }
    const b = byDay.get(day) ?? { wsum: 0, w: 0 };
    b.wsum += price * weight;
    b.w += weight;
    byDay.set(day, b);
  };
  for (const r of swaps) {
    const units = Number(r.units);
    const offerUnits = r.offer_units == null ? NaN : Number(r.offer_units);
    if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(offerUnits) || offerUnits <= 0) continue;
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    const refOffer = refs.get(r.offer_coin_id);
    const refTarget = refs.get(r.coin_id);
    // Target coin's implied price, weighted by target units received.
    if (refOffer != null) addPoint(r.coin_id, day, (offerUnits * refOffer) / units, units);
    // Offer coin's implied price, weighted by offer units given.
    if (refTarget != null) addPoint(r.offer_coin_id, day, (units * refTarget) / offerUnits, offerUnits);
  }
  const out = new Map<string, number[]>();
  for (const id of coinIds) {
    const byDay = buckets.get(id);
    if (!byDay) { out.set(id, []); continue; }
    const days = [...byDay.keys()].sort();
    out.set(id, days.map((d) => {
      const b = byDay.get(d)!;
      return b.wsum / b.w;
    }));
  }
  return out;
}

/**
 * Compute the ghost series for a set of coins (issuance_coins UUIDs).
 * Returns a map coin id -> daily size-weighted swap-implied USD prices,
 * chronological (oldest first). Null = unknown (DB failure); [] = no swaps.
 */
export async function computeGhostSeries(
  coinIds: string[],
): Promise<Map<string, number[] | null>> {
  const out = new Map<string, number[] | null>();
  for (const id of coinIds) out.set(id, []);
  if (coinIds.length === 0) return out;
  try {
    const pool = getPool();
    const [buyRows, askRows, swapRows] = await Promise.all([
      // Last cash price per coin in the window.
      pool.query(
        `SELECT DISTINCT ON (coin_id) coin_id, price_usd::float8 AS price
           FROM market_trades
          WHERE kind = 'buy' AND created_at >= now() - interval '30 days'
          ORDER BY coin_id, created_at DESC, id DESC`,
      ),
      pool.query(
        `SELECT id, price_usd::float8 AS price FROM issuance_coins WHERE id = ANY($1)`,
        [coinIds],
      ),
      // Both sides of every executed swap in the window. offer_units is
      // TEXT: the CASE guard keeps a malformed value from aborting the
      // whole query (it becomes NULL and the row is skipped in JS).
      pool.query(
        `SELECT coin_id, offer_coin_id,
                units::float8 AS units,
                CASE WHEN offer_units ~ '^[0-9]+(\\.[0-9]+)?$'
                     THEN offer_units::float8 ELSE NULL END AS offer_units,
                created_at
           FROM market_trades
          WHERE kind = 'swap' AND created_at >= now() - interval '30 days'
            AND offer_coin_id IS NOT NULL
          ORDER BY created_at ASC, id ASC`,
      ),
    ]);
    const ref = new Map<string, number>();
    for (const r of buyRows.rows as Array<{ coin_id: string; price: number }>) {
      const p = Number(r.price);
      if (Number.isFinite(p) && p > 0) ref.set(r.coin_id, p);
    }
    for (const r of askRows.rows as Array<{ id: string; price: number }>) {
      if (!ref.has(r.id)) {
        const p = Number(r.price);
        if (Number.isFinite(p) && p > 0) ref.set(r.id, p);
      }
    }
    const series = ghostDailyVwap(
      swapRows.rows as SwapRow[],
      ref,
      new Set(coinIds),
    );
    for (const [coinId, pts] of series) out.set(coinId, pts);
  } catch (e) {
    console.error("[ghost] swap query failed — returning unknown ghost series", e);
    for (const id of coinIds) out.set(id, null);
  }
  return out;
}
