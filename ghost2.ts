/**
 * Ghost 2.0 — network price discovery for Phase coins.
 *
 * Ghost 1.0 (ghost.ts) prices a coin only from its OWN swaps, valuing the
 * counter-coin at its last cash price, else its ASK. Two limits follow:
 *  (1) when neither side has cash trades, the "implied" price is arithmetic
 *      on two asking prices — circular, not discovery;
 *  (2) prices never propagate: if A<->B and B<->C swap, C learns nothing
 *      from A's real cash price.
 *
 * Ghost 2.0 treats the swap market as what it is — an exchange-rate graph —
 * and estimates every coin's latent log-price jointly, the standard
 * least-squares approach for consistent cross-rate estimation:
 *
 *   each swap is one observation:  log p(target) - log p(offer)
 *                                   = log(offerUnits / units)
 *   coins with real CASH prices anchor the system (fixed, never fitted);
 *   solve the weighted least squares over each connected component;
 *   a component with NO cash anchor yields NO price (honesty rule kept:
 *   barter alone cannot invent a USD price out of nothing).
 *
 * Anchored coins still get a ghost line — via leave-one-out: the coin's own
 * anchor is removed and its price is fitted from its swaps against everyone
 * else's anchors. That divergence between the ghost line and the cash line
 * is the signal (it is how OHYEA's ghost floated above its $1.00 cash price
 * under Ghost 1.0); pinning anchored coins to their cash price would erase it.
 *
 * Edge weights combine three things:
 *   size      — geometric mean of the two unit amounts (a bigger barter is
 *               stronger evidence than a dust swap);
 *   recency   — exponential decay, configurable half-life (default 7 days)
 *               inside a trailing window (default 30 days), replacing
 *               Ghost 1.0's hard 30-day cliff;
 *   diversity — repeated swaps between the same pair of ACCOUNTS are
 *               discounted by 1/sqrt(n): the n-th swap between the same two
 *               people carries less new information, which is also the
 *               wash-ratio defence (a skewed ratio repeated by one pair
 *               cannot drag the network price the way fresh, diverse
 *               counterparties can).
 *
 * Every price carries its provenance: how many swaps support it, how many
 * distinct counterparties, how many hops to the nearest cash anchor, the
 * residual dispersion of its edges, and a 0..1 confidence derived from
 * those. Thin evidence should LOOK thin — the frontend can render the
 * confidence as the width of a translucent band around the ghost line.
 *
 * The solver is a pure module (no DB). computeGhostSeriesNetwork at the
 * bottom is the DB-facing wrapper used by marketplace.ts; on any DB
 * failure it throws and the caller falls back to Ghost 1.0.
 */

import { getPool } from "./db.js";

export interface SwapObservation {
  /** Coin received (the trade's target coin). */
  coinId: string;
  /** Coin given in exchange. */
  offerCoinId: string;
  /** Units of coinId received. */
  units: number;
  /** Units of offerCoinId given. */
  offerUnits: number;
  createdAt: Date | string;
  /** Optional counterparty account ids (the two sides of the swap). */
  actorA?: string;
  actorB?: string;
}

export interface GhostPrice {
  /** Implied USD price (for anchored coins in a plain solve: the cash price). */
  price: number;
  /** 0..1 — evidence strength. Anchored coins in a plain solve are 1. */
  confidence: number;
  /** Swaps incident to this coin inside the window. */
  swaps: number;
  /** Distinct counterparties across those swaps (0 when actors unknown). */
  counterparties: number;
  /** Graph distance to the nearest cash-anchored coin (0 = anchored). */
  anchorHops: number;
  /** Log-space residual dispersion of this coin's edges around the fit. */
  residualStd: number;
}

/** Provenance payload attached to marketplace rows as ghostMeta30d. */
export type GhostCoinMeta = GhostPrice;

export interface GhostSolveOptions {
  /** Reference time: the window ends here. */
  now: Date | string;
  /** Trailing window length in days. Default 30. */
  windowDays?: number;
  /** Recency half-life in days. Default 7. */
  halfLifeDays?: number;
}

interface Edge {
  offer: string;
  target: string;
  /** log p(target) - log p(offer) implied by this swap. */
  y: number;
  w: number;
  actors: [string, string] | null;
}

const DAY_MS = 86_400_000;

function timeOf(d: Date | string): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

/** Build weighted edges from raw swaps: size x recency x diversity. */
function buildEdges(swaps: SwapObservation[], now: number, windowDays: number, halfLifeDays: number): Edge[] {
  const from = now - windowDays * DAY_MS;
  const usable = swaps
    .map((s) => ({ s, t: timeOf(s.createdAt) }))
    .filter(({ s, t }) =>
      Number.isFinite(s.units) && s.units > 0 &&
      Number.isFinite(s.offerUnits) && s.offerUnits > 0 &&
      s.coinId !== s.offerCoinId &&
      Number.isFinite(t) && t >= from && t <= now)
    .sort((a, b) => a.t - b.t);

  // Diversity: the n-th swap (1-based) between the same unordered pair of
  // accounts is weighted 1/sqrt(n). Unknown actors -> no discount (and no
  // counterparty credit either).
  const pairCount = new Map<string, number>();
  const edges: Edge[] = [];
  for (const { s, t } of usable) {
    let diversity = 1;
    let actors: [string, string] | null = null;
    if (s.actorA && s.actorB && s.actorA !== s.actorB) {
      actors = [s.actorA, s.actorB];
      const key = [s.actorA, s.actorB].sort().join("|");
      const n = (pairCount.get(key) ?? 0) + 1;
      pairCount.set(key, n);
      diversity = 1 / Math.sqrt(n);
    }
    const size = Math.sqrt(s.units * s.offerUnits);
    const ageDays = Math.max(0, (now - t) / DAY_MS);
    const recency = Math.pow(0.5, ageDays / halfLifeDays);
    edges.push({
      offer: s.offerCoinId,
      target: s.coinId,
      y: Math.log(s.offerUnits / s.units),
      w: size * recency * diversity,
      actors,
    });
  }
  return edges;
}

/**
 * Solve the swap graph for latent USD prices.
 *
 * @param swaps      raw swap observations (any age; windowed inside)
 * @param cashPrices coinId -> last real CASH trade price (the anchors).
 *                   Asking prices are NOT anchors in Ghost 2.0.
 * @returns          one GhostPrice per coin that could be priced; coins in
 *                   anchorless components are absent (no price exists).
 *                   Anchored coins report their cash price, confidence 1.
 */
export function solveGhostPrices(
  swaps: SwapObservation[],
  cashPrices: ReadonlyMap<string, number>,
  opts: GhostSolveOptions,
): Map<string, GhostPrice> {
  const now = timeOf(opts.now);
  const windowDays = opts.windowDays ?? 30;
  const halfLifeDays = opts.halfLifeDays ?? 7;
  const edges = buildEdges(swaps, now, windowDays, halfLifeDays);

  const anchors = new Map<string, number>();
  for (const [id, p] of cashPrices) {
    if (Number.isFinite(p) && p > 0) anchors.set(id, Math.log(p));
  }

  // Adjacency: for coin i, each entry says p(i) = p(j) + d.
  const adj = new Map<string, { j: string; d: number; w: number }[]>();
  const link = (i: string, j: string, d: number, w: number) => {
    const arr = adj.get(i) ?? [];
    arr.push({ j, d, w });
    adj.set(i, arr);
  };
  for (const e of edges) {
    link(e.target, e.offer, e.y, e.w);   // p(target) = p(offer) + y
    link(e.offer, e.target, -e.y, e.w);  // p(offer) = p(target) - y
  }

  const coins = new Set<string>(adj.keys());

  // Anchor hops: BFS over the unweighted graph from all anchors at once.
  const hops = new Map<string, number>();
  const queue: string[] = [];
  for (const id of anchors.keys()) if (coins.has(id)) { hops.set(id, 0); queue.push(id); }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const { j } of adj.get(cur) ?? []) {
      if (!hops.has(j)) { hops.set(j, (hops.get(cur) ?? 0) + 1); queue.push(j); }
    }
  }

  // Weighted least squares by Gauss-Seidel relaxation. Anchors are fixed;
  // unknowns start from their anchored neighbours' implied values (or the
  // global anchor mean) and relax to the weighted average of neighbour
  // estimates — the exact solution of the normal equations for this
  // Laplacian system. Components without an anchor never enter `hops`
  // and are skipped entirely.
  const p = new Map<string, number>();
  for (const [id, lp] of anchors) if (coins.has(id)) p.set(id, lp);
  const anchorMean = anchors.size
    ? [...anchors.values()].reduce((a, b) => a + b, 0) / anchors.size
    : 0;
  for (const id of coins) {
    if (p.has(id) || !hops.has(id)) continue;
    let guess = anchorMean;
    for (const { j, d } of adj.get(id) ?? []) {
      if (anchors.has(j)) { guess = (anchors.get(j) as number) + d; break; }
    }
    p.set(id, guess);
  }
  const unknowns = [...coins].filter((id) => hops.has(id) && !anchors.has(id));
  for (let iter = 0; iter < 1000 && unknowns.length; iter++) {
    let maxDelta = 0;
    for (const id of unknowns) {
      let num = 0, den = 0;
      for (const { j, d, w } of adj.get(id) ?? []) {
        const pj = p.get(j);
        if (pj === undefined) continue;
        num += w * (pj + d);
        den += w;
      }
      if (den === 0) continue;
      const next = num / den;
      maxDelta = Math.max(maxDelta, Math.abs(next - (p.get(id) as number)));
      p.set(id, next);
    }
    if (maxDelta < 1e-12) break;
  }

  // Provenance + residuals per coin.
  const incident = new Map<string, Edge[]>();
  for (const e of edges) {
    for (const id of [e.offer, e.target]) {
      const arr = incident.get(id) ?? [];
      arr.push(e);
      incident.set(id, arr);
    }
  }

  const out = new Map<string, GhostPrice>();
  for (const id of coins) {
    const lp = p.get(id);
    const h = hops.get(id);
    if (lp === undefined || h === undefined) continue;
    const inc = incident.get(id) ?? [];
    let wSum = 0, resW = 0, resN = 0;
    const counterparties = new Set<string>();
    for (const e of inc) {
      const other = e.offer === id ? e.target : e.offer;
      const po = p.get(other);
      if (po !== undefined) {
        // residual of this edge's prediction for p(id)
        const predicted = e.target === id ? po + e.y : po - e.y;
        const r = predicted - lp;
        resW += e.w * r * r;
        resN += e.w;
      }
      wSum += e.w;
      if (e.actors) for (const a of e.actors) counterparties.add(a);
    }
    const residualStd = resN > 0 ? Math.sqrt(resW / resN) : 0;
    const isAnchor = anchors.has(id);
    const confidence = isAnchor
      ? 1
      : Math.min(1, (wSum / (wSum + 20)) * (1 / (1 + residualStd)) * (1 / (1 + 0.1 * h)));
    out.set(id, {
      price: Math.exp(lp),
      confidence,
      swaps: inc.length,
      counterparties: counterparties.size,
      anchorHops: h,
      residualStd,
    });
  }
  // Anchored coins with no swaps still report their cash price.
  for (const [id, lp] of anchors) {
    if (!out.has(id)) {
      out.set(id, { price: Math.exp(lp), confidence: 1, swaps: 0, counterparties: 0, anchorHops: 0, residualStd: 0 });
    }
  }
  return out;
}

/**
 * Price every swap-active coin for one moment, the way the CHART needs it:
 * unanchored coins come from the joint solve; anchored coins come from a
 * leave-one-out solve (their own anchor removed) so their ghost price is
 * what swaps imply, not a copy of their cash price. An anchored coin whose
 * component has no OTHER anchor gets no ghost price that day.
 */
function priceActiveCoins(
  swaps: SwapObservation[],
  cashPrices: ReadonlyMap<string, number>,
  opts: GhostSolveOptions,
): Map<string, GhostPrice> {
  const now = timeOf(opts.now);
  const windowDays = opts.windowDays ?? 30;
  const from = now - windowDays * DAY_MS;
  const active = new Set<string>();
  for (const s of swaps) {
    const t = timeOf(s.createdAt);
    if (Number.isFinite(t) && t >= from && t <= now &&
        Number.isFinite(s.units) && s.units > 0 &&
        Number.isFinite(s.offerUnits) && s.offerUnits > 0 &&
        s.coinId !== s.offerCoinId) {
      active.add(s.coinId);
      active.add(s.offerCoinId);
    }
  }
  const out = new Map<string, GhostPrice>();
  const base = solveGhostPrices(swaps, cashPrices, opts);
  for (const id of active) {
    if (cashPrices.has(id)) continue;
    const g = base.get(id);
    if (g) out.set(id, g);
  }
  for (const id of active) {
    if (!cashPrices.has(id)) continue;
    const loo = new Map(cashPrices);
    loo.delete(id);
    const g = solveGhostPrices(swaps, loo, opts).get(id);
    if (g) out.set(id, g);
  }
  return out;
}

/**
 * Daily ghost series per coin, Ghost 1.0-shaped: for each UTC day that has
 * swap activity, price the graph on the trailing window ending that day
 * and record each active coin's ghost price. Days are sparse exactly as in
 * Ghost 1.0, and the chart bridges the gaps.
 *
 * Anchors are static across days (the DB wrapper passes each coin's last
 * cash price in the window; the solve itself is unchanged).
 */
export function ghostSeriesNetwork(
  swaps: SwapObservation[],
  cashPrices: ReadonlyMap<string, number>,
  opts: { windowDays?: number; halfLifeDays?: number } = {},
): Map<string, number[]> {
  const days = [...new Set(swaps.map((s) => new Date(timeOf(s.createdAt)).toISOString().slice(0, 10)))].sort();
  const byCoin = new Map<string, number[]>();
  for (const day of days) {
    const endOfDay = new Date(day + "T23:59:59.999Z");
    const priced = priceActiveCoins(swaps, cashPrices, {
      now: endOfDay,
      windowDays: opts.windowDays ?? 30,
      halfLifeDays: opts.halfLifeDays ?? 7,
    });
    for (const [id, g] of priced) {
      const arr = byCoin.get(id) ?? [];
      arr.push(g.price);
      byCoin.set(id, arr);
    }
  }
  return byCoin;
}

/** Latest ghost price + provenance per swap-active coin (for ghostMeta30d). */
export function ghostLatestMeta(
  swaps: SwapObservation[],
  cashPrices: ReadonlyMap<string, number>,
  opts: GhostSolveOptions,
): Map<string, GhostPrice> {
  return priceActiveCoins(swaps, cashPrices, opts);
}

/**
 * DB wrapper with Ghost 1.0's contract shape: every requested coin id is
 * present in `series` ([] = no ghost points); `meta` carries the latest
 * provenance per coin (null when the coin has no ghost series). THROWS on
 * DB failure so the caller can fall back to Ghost 1.0.
 */
export async function computeGhostSeriesNetwork(
  coinIds: string[],
): Promise<{ series: Map<string, number[] | null>; meta: Map<string, GhostCoinMeta | null> }> {
  const series = new Map<string, number[] | null>();
  const meta = new Map<string, GhostCoinMeta | null>();
  for (const id of coinIds) { series.set(id, []); meta.set(id, null); }
  if (coinIds.length === 0) return { series, meta };

  const pool = getPool();
  const [buyRows, swapRows] = await Promise.all([
    // Cash anchors: last real 'buy' price per coin in the window. Asking
    // prices are deliberately NOT anchors in Ghost 2.0.
    pool.query(
      `SELECT DISTINCT ON (coin_id) coin_id, price_usd::float8 AS price
         FROM market_trades
        WHERE kind = 'buy' AND created_at >= now() - interval '30 days'
        ORDER BY coin_id, created_at DESC, id DESC`,
    ),
    // Both sides of every executed swap in the window, with the two
    // accounts for diversity weighting. offer_units is TEXT: the CASE
    // guard keeps a malformed value from aborting the query (same as v1).
    pool.query(
      `SELECT coin_id, offer_coin_id,
              units::float8 AS units,
              CASE WHEN offer_units ~ '^[0-9]+(\\.[0-9]+)?$'
                   THEN offer_units::float8 ELSE NULL END AS offer_units,
              buyer_user_id, seller_user_id, created_at
         FROM market_trades
        WHERE kind = 'swap' AND created_at >= now() - interval '30 days'
          AND offer_coin_id IS NOT NULL
        ORDER BY created_at ASC, id ASC`,
    ),
  ]);

  const anchors = new Map<string, number>();
  for (const r of buyRows.rows as Array<{ coin_id: string; price: number }>) {
    const p = Number(r.price);
    if (Number.isFinite(p) && p > 0) anchors.set(r.coin_id, p);
  }
  const swaps: SwapObservation[] = (swapRows.rows as Array<{
    coin_id: string; offer_coin_id: string; units: number; offer_units: number | null;
    buyer_user_id: string | null; seller_user_id: string | null; created_at: Date | string;
  }>).map((r) => ({
    coinId: r.coin_id,
    offerCoinId: r.offer_coin_id,
    units: Number(r.units),
    offerUnits: r.offer_units == null ? NaN : Number(r.offer_units),
    createdAt: r.created_at,
    actorA: r.buyer_user_id ?? undefined,
    actorB: r.seller_user_id ?? undefined,
  }));

  // The graph is solved GLOBALLY (all swapped coins, not just the ones
  // being listed): out-of-scope coins are the bridges that carry prices.
  const allSeries = ghostSeriesNetwork(swaps, anchors, {});
  const allMeta = ghostLatestMeta(swaps, anchors, { now: new Date() });
  for (const id of coinIds) {
    const pts = allSeries.get(id) ?? [];
    series.set(id, pts);
    meta.set(id, pts.length ? (allMeta.get(id) ?? null) : null);
  }
  return { series, meta };
}
