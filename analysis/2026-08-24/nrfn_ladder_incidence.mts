/**
 * How often does an NRFN-tagged plan actually carry a populated
 * cancelPolicyInfos ladder? This is the number behind the Phase 1 fix in
 * cancellation.ts / booking-format.ts: both used to discard the ladder
 * whenever refundableTag said "NRFN", on the assumption that NRFN meant
 * nothing to show. LiteAPI's own docs say otherwise ("NRFN bookings still
 * may refund most of the cost"), and this measures how often that's true in
 * the sandbox.
 *
 * Prints, per hotel and in total: NRFN plan count, how many of those carry a
 * non-empty ladder, and one example plan so the shape can be sanity-checked
 * by eye.
 *
 *     npx tsx analysis/2026-08-24/nrfn_ladder_incidence.mts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;

// Batched, not one hotel per call: at ~180 hotels this is the difference
// between a handful of requests and a couple hundred, and searchStaysInArea
// already established that latency here tracks the timeout, not hotel count
// (see analysis/2026-08-23/area_scaling.mts).
async function ratesBatch(hotelIds: string[], checkin: string, checkout: string) {
  const r = await fetch(BASE + "/hotels/rates", {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      hotelIds,
      occupancies: [{ adults: 2 }],
      currency: "USD",
      guestNationality: "US",
      checkin,
      checkout,
      maxRatesPerHotel: 40,
      roomMapping: true,
      timeout: 5,
      margin: 0,
    }),
  });
  const d: any = await r.json().catch(() => ({}));
  return (d.data ?? []) as { hotelId: string; roomTypes: any[] }[];
}

async function hotelIdsNear(lat: number, lng: number, limit: number) {
  const r = await fetch(
    BASE + "/data/hotels?" + new URLSearchParams({ latitude: String(lat), longitude: String(lng), radius: "30000", limit: String(limit) }),
    { headers: { "X-API-Key": KEY, Accept: "application/json" } },
  );
  const d: any = await r.json().catch(() => ({}));
  return ((d.data ?? []) as any[]).map((h) => h.id as string);
}

// A handful of known hotels plus a wider live pull across three cities, since
// a 5-hotel sample turned up zero NRFN+ladder plans and that result needed
// checking against more data before it means anything.
const CITIES: [number, number][] = [
  [30.2672, -97.7431], // Austin
  [40.7128, -74.006], // NYC
  [51.5072, -0.1276], // London
];
const pulled = (await Promise.all(CITIES.map(([lat, lng]) => hotelIdsNear(lat, lng, 60)))).flat();
const HOTELS = [...new Set(["lp1b919", "lp657d352a", "lp225d01", "lp40992", "lp85c07", ...pulled])];
const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
const checkout = new Date(Date.now() + 47 * 864e5).toISOString().slice(0, 10);
console.log(`Sampling ${HOTELS.length} hotels\n`);

let totalNrfn = 0;
let totalWithLadder = 0;
let example: unknown = null;
const perHotel = new Map<string, { nrfn: number; withLadder: number }>();

const CHUNK = 60;
for (let i = 0; i < HOTELS.length; i += CHUNK) {
  const chunk = HOTELS.slice(i, i + CHUNK);
  const rows = await ratesBatch(chunk, checkin, checkout);
  for (const row of rows) {
    const stats = perHotel.get(row.hotelId) ?? { nrfn: 0, withLadder: 0 };
    for (const x of row.roomTypes ?? []) {
      const cp = x?.rates?.[0]?.cancellationPolicies;
      const tag = String(cp?.refundableTag ?? "").toUpperCase();
      if (tag !== "NRFN") continue;
      stats.nrfn++;
      totalNrfn++;
      const infos = cp?.cancelPolicyInfos ?? [];
      if (infos.length > 0) {
        stats.withLadder++;
        totalWithLadder++;
        if (!example) example = { hotelId: row.hotelId, refundableTag: tag, cancelPolicyInfos: infos };
      }
    }
    perHotel.set(row.hotelId, stats);
  }
}

for (const [hotelId, { nrfn, withLadder }] of perHotel) {
  if (!nrfn) continue;
  console.log(
    `  ${hotelId}  NRFN plans: ${String(nrfn).padStart(3)}   with a populated ladder: ${String(withLadder).padStart(3)}  (${((withLadder / nrfn) * 100).toFixed(0)}%)`,
  );
}

console.log(
  `\nHotels with any priced rates: ${perHotel.size}/${HOTELS.length}`,
);
console.log(
  `Total: ${totalNrfn} NRFN plans, ${totalWithLadder} carry a populated ladder` +
    (totalNrfn ? ` (${((totalWithLadder / totalNrfn) * 100).toFixed(1)}%)` : ""),
);
if (example) {
  console.log("\nExample NRFN plan with a populated ladder:");
  console.log(JSON.stringify(example, null, 1));
} else {
  console.log("\nNo NRFN+ladder example found in this sample — widen HOTELS if this matters.");
}
