/**
 * Follow-up to yosemite_probe.mts, which found three things worth chasing:
 *   - lp657d352a returned an EMPTY rates response on 2 of 6 identical calls
 *   - lp6556f7f5 returns 13 plans and ZERO standard ones (all rateType package)
 *   - neither hotel is in the Yosemite /data/hotels list at all
 *
 * So: is the emptiness a TIMEOUT effect? what is our actual net/margin when the
 * call succeeds? and how far are these hotels from the search centre?
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;

async function api(method: string, path: string, opts: any = {}) {
  let url = BASE + path;
  if (opts.params)
    url += "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

const CHECKIN = "2026-09-20", CHECKOUT = "2026-09-22";
const A = "lp657d352a", B = "lp6556f7f5";

const rates = (ids: string[], cap: number, margin: number, timeout: number) =>
  api("POST", "/hotels/rates", {
    body: {
      hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US",
      checkin: CHECKIN, checkout: CHECKOUT, maxRatesPerHotel: cap, roomMapping: true, timeout, margin,
    },
  });

console.log("### A. Is the empty response a TIMEOUT effect? 8 calls per setting\n");
for (const timeout of [5, 10, 20]) {
  const marks: string[] = [];
  let empties = 0;
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    const d = await rates([A], 2000, 0, timeout);
    const rt = ((d.data ?? [])[0]?.roomTypes ?? []) as any[];
    if (!rt.length) empties++;
    marks.push(`${rt.length}/${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  console.log(`  timeout ${String(timeout).padStart(2)}:  ${marks.join("  ")}   -> ${empties}/8 EMPTY`);
}

console.log("\n### B. What our numbers actually are for lp657d352a when it answers\n");
let base: any[] = [];
for (let i = 0; i < 6 && !base.length; i++) {
  const d = await rates([A], 2000, 0, 20);
  base = ((d.data ?? [])[0]?.roomTypes ?? []) as any[];
}
if (!base.length) console.log("  never answered");
else {
  console.log(`  ${base.length} plans, rateTypes: ${JSON.stringify(base.reduce((m: any, x) => ((m[x.rateType ?? "undefined"] = (m[x.rateType ?? "undefined"] ?? 0) + 1), m), {}))}`);
  for (const rt of base) {
    const net = rt?.offerRetailRate?.amount;
    const ssp = rt?.suggestedSellingPrice?.amount ?? null;
    const r0 = rt?.rates?.[0];
    const fees = (r0?.retailRate?.taxesAndFees ?? []) as any[];
    const due = fees.filter((f) => f?.included === false).reduce((s, f) => s + (f.amount ?? 0), 0);
    const inc = fees.filter((f) => f?.included === true).reduce((s, f) => s + (f.amount ?? 0), 0);
    console.log(
      `   - ${String(r0?.name ?? "?").slice(0, 46).padEnd(46)} ${String(r0?.boardName ?? "").padEnd(12)}` +
        ` net $${Number(net).toFixed(2).padStart(8)}  ssp ${ssp == null ? "  null" : "$" + Number(ssp).toFixed(2)}` +
        `  ratio ${ssp ? (ssp / net).toFixed(4) : "-"}  src ${rt?.suggestedSellingPrice?.source ?? "-"}` +
        `  taxIn $${inc.toFixed(2)} dueAtProp $${due.toFixed(2)}  ${(r0?.cancellationPolicies?.refundableTag) ?? "?"}`,
    );
  }
  const nets = base.map((x) => x?.offerRetailRate?.amount).filter((n) => typeof n === "number") as number[];
  const cheapest = Math.min(...nets);
  console.log(`\n  cheapest net for the stay: $${cheapest.toFixed(2)}`);
  for (const [label, m] of [["public 25%", 25], ["member 15%", 15]] as const) {
    console.log(`    at ${label}: guest pays ~$${(cheapest * (1 + m / 100)).toFixed(2)}   we keep ~$${(cheapest * (m / 100)).toFixed(2)}`);
  }
  console.log(`  guest was shown $498.65 => implied net multiple ${(498.65 / cheapest).toFixed(4)}  (margin ${(((498.65 / cheapest) - 1) * 100).toFixed(1)}%)`);
}

console.log("\n### C. lp6556f7f5 — all package? what would it have sold for?\n");
const db = await rates([B], 2000, 0, 20);
const brt = ((db.data ?? [])[0]?.roomTypes ?? []) as any[];
console.log(`  ${brt.length} plans, rateTypes: ${JSON.stringify(brt.reduce((m: any, x) => ((m[x.rateType ?? "undefined"] = (m[x.rateType ?? "undefined"] ?? 0) + 1), m), {}))}`);
for (const rt of brt.slice(0, 5)) {
  const r0 = rt?.rates?.[0];
  console.log(`   - ${String(r0?.name ?? "?").slice(0, 44).padEnd(44)} net $${Number(rt?.offerRetailRate?.amount).toFixed(2)}  ssp ${rt?.suggestedSellingPrice?.amount ?? "null"}  rateType ${rt?.rateType}`);
}

console.log("\n### D. Where are these hotels relative to the Yosemite search centre?\n");
const hav = (a: number, b: number, c: number, d: number) => {
  const R = 6371, r = (x: number) => (x * Math.PI) / 180;
  const dLa = r(c - a), dLo = r(d - b);
  return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2));
};
for (const id of [A, B]) {
  const m = (await api("GET", "/data/hotel", { params: { hotelId: id } })).data ?? {};
  const km = hav(37.8651, -119.5383, m.latitude, m.longitude);
  console.log(`  ${id}  ${String(m.name).slice(0, 42).padEnd(42)} ${m.city}  ${km.toFixed(1)} km from centre (search radius 30 km)`);
}
