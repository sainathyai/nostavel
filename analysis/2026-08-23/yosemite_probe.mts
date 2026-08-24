/**
 * Four questions from the Chicken Ranch / Priceline comparison, 2026-08-23:
 *
 *  1. What is our NET and our MARGIN on lp657d352a, Sep 20-22, 2 nights?
 *     We charge $498.65; Priceline shows $448.00 total for the same hotel.
 *  2. Same for lp6556f7f5, the id that "appeared once for us".
 *  3. Why did one request return "no availability found"? Is the rates call
 *     flaky for this hotel, or was that a real empty response?
 *  4. Why does a hotel appear in one Yosemite search and not the next?
 *
 * Run against the live sandbox. Deliberately repeats each call several times,
 * because questions 3 and 4 are STABILITY questions and a single sample cannot
 * answer either.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;

type Api = { ok: true; data: any; ms: number } | { ok: false; err: string; ms: number };

async function api(method: string, path: string, opts: any = {}): Promise<Api> {
  const t = Date.now();
  let url = BASE + path;
  if (opts.params)
    url += "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])).toString();
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, err: `${res.status} ${JSON.stringify(data).slice(0, 200)}`, ms: Date.now() - t };
    return { ok: true, data, ms: Date.now() - t };
  } catch (e) {
    return { ok: false, err: (e as Error).message, ms: Date.now() - t };
  }
}

const CHECKIN = "2026-09-20";
const CHECKOUT = "2026-09-22";
const A = "lp657d352a"; // the page the guest was on
const B = "lp6556f7f5"; // "appeared once for us", the one Priceline shows

async function rates(hotelIds: string[], cap: number, margin: number) {
  return api("POST", "/hotels/rates", {
    body: {
      hotelIds,
      occupancies: [{ adults: 2 }],
      currency: "USD",
      guestNationality: "US",
      checkin: CHECKIN,
      checkout: CHECKOUT,
      maxRatesPerHotel: cap,
      roomMapping: true,
      timeout: 5,
      margin,
    },
  });
}

console.log("### 1+2. NET, SSP and margin per hotel (margin 0 = truth)\n");
for (const id of [A, B]) {
  const meta = await api("GET", "/data/hotel", { params: { hotelId: id } });
  const name = meta.ok ? (meta.data.data ?? meta.data)?.name : "?";
  console.log(`--- ${id}  ${name}`);

  const r = await rates([id], 2000, 0);
  if (!r.ok) {
    console.log(`    margin-0 call FAILED: ${r.err}`);
    continue;
  }
  const rows = (r.data.data ?? []) as any[];
  const rt = (rows[0]?.roomTypes ?? []) as any[];
  const std = rt.filter((x) => x?.rateType !== "package");
  console.log(`    ${rt.length} plans (${std.length} standard) in ${(r.ms / 1000).toFixed(2)}s`);
  if (!std.length) continue;

  const withNet = std
    .map((x) => ({
      net: x?.offerRetailRate?.amount as number,
      ssp: (x?.suggestedSellingPrice?.amount ?? null) as number | null,
      src: (x?.suggestedSellingPrice?.source ?? null) as string | null,
      name: x?.rates?.[0]?.name,
      board: x?.rates?.[0]?.boardName,
      refundable: (x?.rates?.[0]?.cancellationPolicies?.refundableTag || "") !== "NRFN",
    }))
    .filter((x) => typeof x.net === "number")
    .sort((a, b) => a.net - b.net);

  const cheapest = withNet[0];
  console.log(`    cheapest net  $${cheapest.net.toFixed(2)}   ssp ${cheapest.ssp?.toFixed(2) ?? "null"} (${cheapest.src ?? "-"})`);
  console.log(`      ratio ssp/net = ${cheapest.ssp ? (cheapest.ssp / cheapest.net).toFixed(4) : "-"}  (1.1500 exactly => placeholder, not real)`);

  // How many carry a REAL ssp (sourced, and not the 1.15x placeholder)?
  const real = withNet.filter((x) => x.ssp != null && x.src && Math.abs(x.ssp / x.net - 1.15) > 0.0005);
  console.log(`    plans with a REAL ssp: ${real.length}/${withNet.length}` + (real.length ? `  sources: ${[...new Set(real.map((x) => x.src))].join(", ")}` : ""));
  if (real.length) {
    const tight = real.reduce((m, x) => Math.min(m, (x.ssp! / x.net - 1) * 100), Infinity);
    console.log(`    tightest parity ceiling: ${tight.toFixed(1)}% margin`);
  }

  // Look specifically for the plan the guest saw: "Room, 1 King Bed, Balcony"
  const king = withNet.filter((x) => /king/i.test(x.name ?? "") && /balcon/i.test(x.name ?? ""));
  for (const k of king.slice(0, 4)) {
    console.log(`    KING+BALCONY  net $${k.net.toFixed(2)}  ssp ${k.ssp?.toFixed(2) ?? "null"}  ${k.board}  ${k.refundable ? "RFN" : "NRFN"}`);
  }
  console.log();
}

console.log("\n### 3. Stability: same rates call, 6 times, does it ever come back empty?\n");
for (const id of [A, B]) {
  const marks: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await rates([id], 2000, 0);
    if (!r.ok) marks.push(`ERR(${r.err.slice(0, 40)})`);
    else {
      const rows = (r.data.data ?? []) as any[];
      const n = (rows[0]?.roomTypes ?? []).length;
      marks.push(n === 0 ? "EMPTY" : String(n));
    }
  }
  console.log(`  ${id}: ${marks.join("  ")}`);
}

console.log("\n### 4. Does the Yosemite hotel LIST change between identical searches?\n");
const seen: Set<string>[] = [];
for (let i = 0; i < 4; i++) {
  const r = await api("GET", "/data/hotels", {
    params: { latitude: 37.8651, longitude: -119.5383, radius: 30000, limit: 300 },
  });
  const rows: any[] = r.ok ? (r.data.data ?? []) : [];
  seen.push(new Set(rows.map((h) => h.id)));
  console.log(`  /data/hotels run ${i + 1}: ${rows.length} hotels   A present: ${rows.some((h) => h.id === A)}   B present: ${rows.some((h) => h.id === B)}`);
}
const union = new Set<string>(seen.flatMap((s) => [...s]));
const inAll = [...union].filter((id) => seen.every((s) => s.has(id)));
console.log(`  union ${union.size}, present in ALL runs ${inAll.length}, unstable ${union.size - inAll.length}`);

console.log("\n### 4b. And does the RATES step drop hotels between identical searches?\n");
const ids = [...seen[0]].slice(0, 300);
const withRates: Set<string>[] = [];
for (let i = 0; i < 3; i++) {
  const r = await rates(ids, 40, 0);
  const rows: any[] = r.ok ? (r.data.data ?? []) : [];
  const s = new Set<string>(rows.map((x) => x.hotelId));
  withRates.push(s);
  console.log(`  rates run ${i + 1}: ${s.size}/${ids.length} priced   A: ${s.has(A)}   B: ${s.has(B)}`);
}
const u2 = new Set<string>(withRates.flatMap((s) => [...s]));
const all2 = [...u2].filter((id) => withRates.every((s) => s.has(id)));
console.log(`  union ${u2.size}, in ALL runs ${all2.length}, FLAPPING ${u2.size - all2.length}`);
