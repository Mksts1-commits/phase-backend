/**
 * test-fees-math.ts — pure unit tests for the 80-bps fee engine.
 *
 * Run:  cd ~/workspace/phase-backend && npx tsx test-fees-math.ts
 *
 * No DATABASE_URL required: covers only the integer-exact calculation
 * layer (fee.ts math). DB-backed atomicity/idempotency tests live in
 * test-fees-integration.ts.
 *
 * Rounding spec under test: fee = floor(gross_base_units * fee_bps / 10_000),
 * net = gross - fee. JavaScript floating point is never authoritative.
 */
import {
  toMicroUnits,
  fromMicroUnits,
  calculateFee,
  calculateFeeOnDecimal,
  calculateTradeFee,
  calculateTradeFeeWithWaiver,
  isFeeWaived,
  FEE_WAIVER_USD_MICRO,
  FEE_MIN_WHOLE_UNITS,
  feeIdempotencyKey,
  FEE_BPS_DENOMINATOR,
  assetDecimals,
  toBaseUnits,
  fromBaseUnits,
  coinUnitsToDecimal,
  decimalToCoinUnits,
  markFeeSettled,
} from "./fee.js";
import { grossUnitsForNet } from "./marketplace.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = String(actual);
  const e = String(expected);
  if (a === e) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}: got ${a}, want ${e}`); }
}

console.log("fee math — spec examples");
{
  // Mike's canonical example: 10,000 PHI gross -> 80 PHI fee -> 9,920 net.
  const gross = toMicroUnits("10000");
  const { fee, net } = calculateFee(gross, 80);
  eq("gross 10000 @80bps fee == 80 units", fromMicroUnits(fee), "80.000000");
  eq("gross 10000 @80bps net == 9920 units", fromMicroUnits(net), "9920.000000");
}

console.log("fee math — rounding boundaries (floor)");
{
  // 1 microunit gross -> fee floors to 0; user keeps everything.
  let r = calculateFee(1n, 80);
  eq("1 microunit -> fee 0", r.fee, 0n);
  eq("1 microunit -> net 1", r.net, 1n);

  // floor(124 * 80 / 10000) = floor(0.992) = 0
  r = calculateFee(124n, 80);
  eq("124 mu -> fee 0", r.fee, 0n);

  // floor(125 * 80 / 10000) = floor(1.0) = 1
  r = calculateFee(125n, 80);
  eq("125 mu -> fee 1", r.fee, 1n);

  // floor(126 * 80 / 10000) = floor(1.008) = 1
  r = calculateFee(126n, 80);
  eq("126 mu -> fee 1", r.fee, 1n);

  // Exact: 100.00 USD -> fee 0.80, net 99.20
  const d = calculateFeeOnDecimal("100.00", 80);
  eq("100.00 USD -> fee 0.80", d.feeDecimal, "0.800000");
  eq("100.00 USD -> net 99.20", d.netDecimal, "99.200000");

  // Dust: 0.01 USD = 10_000 microunits -> fee 80 microunits = 0.000080
  const dust = calculateFeeOnDecimal("0.01", 80);
  eq("0.01 USD -> fee 0.000080", dust.feeDecimal, "0.000080");
  eq("0.01 USD -> net 0.009920", dust.netDecimal, "0.009920");
  // True dust: 1 microunit -> fee floors to 0
  const dust2 = calculateFeeOnDecimal("0.000001", 80);
  eq("0.000001 USD -> fee 0.000000", dust2.feeDecimal, "0.000000");
  eq("0.000001 USD -> net 0.000001", dust2.netDecimal, "0.000001");

  // Boundary: 1.25 USD -> fee exactly 0.01
  const b = calculateFeeOnDecimal("1.25", 80);
  eq("1.25 USD -> fee 0.010000", b.feeDecimal, "0.010000");
  eq("1.25 USD -> net 1.240000", b.netDecimal, "1.240000");
}

console.log("fee math — conservation (gross == fee + net)");
{
  const cases: Array<[string, number]> = [
    ["0.000001", 80], ["0.07", 80], ["1.00", 80], ["999.99", 80],
    ["123456789.123456", 80], ["100.00", 0], ["100.00", 10000], ["50.00", 1],
  ];
  for (const [gross, bps] of cases) {
    const g = toMicroUnits(gross);
    const { fee, net } = calculateFee(g, bps);
    ok(`conservation gross=${gross} bps=${bps}`, fee + net === g);
    ok(`fee non-negative gross=${gross}`, fee >= 0n);
    ok(`fee <= gross gross=${gross}`, fee <= g);
  }
  eq("denominator constant", FEE_BPS_DENOMINATOR, 10000);
}

console.log("fee math — microunit parsing");
{
  eq("parse 1.5", toMicroUnits("1.5"), 1500000n);
  eq("parse 0.000001", toMicroUnits("0.000001"), 1n);
  // More than 6 decimals truncates (never rounds up the fee).
  eq("parse 1.0000009 truncates", toMicroUnits("1.0000009"), 1000000n);
  eq("round-trip 42.42", fromMicroUnits(toMicroUnits("42.42")), "42.420000");
  // Reconciliation differences can be negative — must not throw.
  eq("fromMicroUnits(-5)", fromMicroUnits(-5n), "-0.000005");
  let threw = false;
  try { toMicroUnits("-1"); } catch { threw = true; }
  ok("toMicroUnits rejects negative input", threw);
}

console.log("fee math — idempotency keys");
{
  eq("buy key", feeIdempotencyKey("buy", "abc"), "fee:buy:abc");
  eq("swap key", feeIdempotencyKey("swap", "abc"), "fee:swap:abc");
  ok("buy vs swap keys differ",
    feeIdempotencyKey("buy", "abc") !== feeIdempotencyKey("swap", "abc"));
}

console.log("fee math — asset precision registry");
{
  eq("USD decimals", assetDecimals("USD"), 6);
  eq("PHI decimals (whole coins)", assetDecimals("PHI"), 0);
  eq("unknown coin decimals", assetDecimals("XYZ"), 0);
  eq("toBaseUnits USD", toBaseUnits("USD", "1.5"), 1500000n);
  eq("toBaseUnits PHI whole", toBaseUnits("PHI", "5"), 5n);
  eq("fromBaseUnits USD", fromBaseUnits("USD", 1500000n), "1.500000");
  eq("fromBaseUnits PHI", fromBaseUnits("PHI", 5n), "5");
  let threw = false;
  try { toBaseUnits("PHI", "1.5"); } catch { threw = true; }
  ok("toBaseUnits rejects fractional coins", threw);
  threw = false;
  try { toBaseUnits("PHI", "-1"); } catch { threw = true; }
  ok("toBaseUnits rejects negative coins", threw);
}

console.log("fee math — coin unit conversions (exact, 6dp text <-> whole coins)");
{
  eq("coinUnitsToDecimal(5)", coinUnitsToDecimal(5n), "5.000000");
  eq("coinUnitsToDecimal(0)", coinUnitsToDecimal(0n), "0.000000");
  eq("decimalToCoinUnits 5.000000", decimalToCoinUnits("5.000000"), 5n);
  eq("decimalToCoinUnits 5 (legacy)", decimalToCoinUnits("5"), 5n);
  eq("round-trip 12345", decimalToCoinUnits(coinUnitsToDecimal(12345n)), 12345n);
  let threw = false;
  try { decimalToCoinUnits("1.5"); } catch { threw = true; }
  ok("decimalToCoinUnits rejects fractional coins", threw);
  threw = false;
  try { coinUnitsToDecimal(-1n); } catch { threw = true; }
  ok("coinUnitsToDecimal rejects negative", threw);
}

console.log("fee math — canonical buy fee in purchased-asset units");
{
  // Mike's canonical example: gross 10,000 PHI -> 80 PHI fee -> 9,920 PHI buyer.
  const gross = 10000n;
  const fee = (gross * 80n) / 10000n;
  const net = gross - fee;
  eq("fee units", fee, 80n);
  eq("net units", net, 9920n);
  eq("fee text", coinUnitsToDecimal(fee), "80.000000");
  eq("net text", coinUnitsToDecimal(net), "9920.000000");
  // Conservation: fee + net == gross (exact, no remainder lost).
  ok("conservation", fee + net === gross);
  // Floor rounding: 1 unit @ 80bps -> 0 fee (remainder stays with buyer).
  const smallFee = (1n * 80n) / 10000n;
  eq("1 unit fee floors to 0", smallFee, 0n);
  eq("1 unit net stays 1", 1n - smallFee, 1n);
}

console.log("fee math — markFeeSettled idempotency signal");
{
  // A mock client: first call transitions pending -> settled (rowCount 1),
  // a retry on the already-settled row transitions nothing (rowCount 0).
  const mock = (rowCount: number) => ({
    query: async () => ({ rowCount }),
  });
  eq("first settle transitions", await markFeeSettled(mock(1), "k", "tx1"), true);
  eq("retry on settled fee does not transition", await markFeeSettled(mock(0), "k", "tx1"), false);
}

console.log("fee math — 1-coin minimum floor (calculateTradeFee)");
{
  eq("floor constant is 1 whole coin", FEE_MIN_WHOLE_UNITS, 1n);
  // Dust cases: 80bps rounds to 0 -> floor binds, fee = 1.
  eq("1 unit -> fee 1 (floor)", calculateTradeFee(1n, 80), 1n);
  eq("2 units -> fee 1 (floor)", calculateTradeFee(2n, 80), 1n);
  eq("124 units -> fee 1 (floor, bps gives 0)", calculateTradeFee(124n, 80), 1n);
  // At 125 units the bps cut reaches exactly 1 -> floor no longer binds.
  eq("125 units -> fee 1 (bps)", calculateTradeFee(125n, 80), 1n);
  eq("1000 units -> fee 8 (bps)", calculateTradeFee(1000n, 80), 8n);
  eq("100000 units -> fee 800 (bps)", calculateTradeFee(100000n, 80), 800n);
  // Conservation still holds: fee + net = gross.
  for (const u of [1n, 2n, 124n, 125n, 1000n]) {
    const f = calculateTradeFee(u, 80);
    ok(`conservation at ${u} units`, f + (u - f) === u);
  }
  // A 1-unit trade nets 0 under the floor -> settlement must reject it.
  eq("1-unit trade nets 0 (too small to settle)", 1n - calculateTradeFee(1n, 80), 0n);
  eq("2-unit trade nets 1 (settleable)", 2n - calculateTradeFee(2n, 80), 1n);
  // Invalid inputs throw.
  let threw = false;
  try { calculateTradeFee(10n, -1); } catch { threw = true; }
  ok("negative bps throws", threw);
  threw = false;
  try { calculateTradeFee(-5n, 80); } catch { threw = true; }
  ok("negative units throws", threw);
}

console.log("fee math — de minimis waiver (isFeeWaived / calculateTradeFeeWithWaiver)");
{
  eq("waiver threshold is $0.05", FEE_WAIVER_USD_MICRO, 50_000n);
  // At 80 bps the nominal fee on $6.24 is $0.04992 < $0.05 -> waived.
  ok("$6.24 @80bps waived", isFeeWaived(toMicroUnits("6.24"), 80));
  // $6.25 -> exactly $0.05 -> NOT less than -> fee applies.
  ok("$6.25 @80bps not waived", !isFeeWaived(toMicroUnits("6.25"), 80));
  // Exact integer boundary: grossUsdMicro * bps < 500_000_000.
  ok("499_999_999 product waived", isFeeWaived(6_249_999n, 80)); // 6_249_999*80 = 499_999_920
  ok("500_000_000 product not waived", !isFeeWaived(6_250_000n, 80)); // = 500_000_000
  ok("$0 gross waived", isFeeWaived(0n, 80));
  ok("0 bps waived", isFeeWaived(toMicroUnits("100"), 0));
  ok("$1000 @80bps not waived", !isFeeWaived(toMicroUnits("1000"), 80));

  // Waiver-aware trade fee: 2 units of a $1 coin = $2 gross -> free.
  eq("2 units @ $1 -> fee 0 (waived)", calculateTradeFeeWithWaiver(2n, 80, 2n * toMicroUnits("1")), 0n);
  // 10 units @ $1 = $10 gross -> 80bps = $0.08 >= $0.05 -> 1-coin floor binds.
  eq("10 units @ $1 -> fee 1 (floor)", calculateTradeFeeWithWaiver(10n, 80, 10n * toMicroUnits("1")), 1n);
  // 200 units @ $1 = $200 -> bps cut = 1 coin, floor = 1.
  eq("200 units @ $1 -> fee 1", calculateTradeFeeWithWaiver(200n, 80, 200n * toMicroUnits("1")), 1n);
  // 1000 units @ $1 -> bps cut = 8 coins.
  eq("1000 units @ $1 -> fee 8", calculateTradeFeeWithWaiver(1000n, 80, 1000n * toMicroUnits("1")), 8n);
  // Cheap coin: 100 units @ $0.05 = $5 gross -> waived even though bps cut is 0.
  eq("100 units @ $0.05 -> fee 0 (waived)", calculateTradeFeeWithWaiver(100n, 80, 100n * toMicroUnits("0.05")), 0n);
  // Conservation holds with the waiver: fee + net = gross.
  for (const [u, p] of [[2n, "1"], [10n, "1"], [1000n, "1"]] as Array<[bigint, string]>) {
    const f = calculateTradeFeeWithWaiver(u, 80, u * toMicroUnits(p));
    ok(`conservation at ${u} units @ $${p}`, f + (u - f) === u);
  }
  // Invalid inputs throw.
  let threw = false;
  try { isFeeWaived(-1n, 80); } catch { threw = true; }
  ok("negative grossUsd throws", threw);
  threw = false;
  try { isFeeWaived(100n, -1); } catch { threw = true; }
  ok("negative bps throws", threw);

  // grossUnitsForNet with the waiver: net 2 @ $1 -> gross 2 (free, no +1).
  const oneDollar = toMicroUnits("1");
  eq("net 2 @ $1 -> gross 2 (waived)", grossUnitsForNet(2n, 80, oneDollar), 2n);
  // net 100 @ $1 = $100 -> not waived -> gross 101 (1-coin floor).
  eq("net 100 @ $1 -> gross 101", grossUnitsForNet(100n, 80, oneDollar), 101n);
  // Waiver boundary through grossUnitsForNet: net 6 @ $1 = $6 < $6.25 -> free.
  eq("net 6 @ $1 -> gross 6 (waived)", grossUnitsForNet(6n, 80, oneDollar), 6n);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
