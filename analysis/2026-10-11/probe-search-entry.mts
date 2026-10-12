/**
 * NOS-66: can the search bar find a hotel by name, and a neighbourhood by name?
 *
 * Why this exists: the owner could not reach "Holiday Inn Express Waikiki,
 * 2058 Kuhio Avenue, Honolulu" through the app. The hotel IS in sandbox
 * inventory - confirmed by an area search around Honolulu, which returns it as
 * "Holiday Inn Express Waikiki by IHG | 2058 Kuhio Avenue" among 73 results -
 * so nothing is missing from the data. The search ENTRY POINT cannot express
 * either thing the owner tried: typing a hotel name returns nothing, and
 * "Waikiki" resolves to a suburb of Perth, Western Australia.
 *
 * The documentation says `/data/hotels` takes `hotelName` ("loose match,
 * case-insensitive") and `placeId`, and that `/data/places` does text search
 * over localities and hotels. It also prices `/data/places` at **$0.01 per
 * request**, which rules it out as a per-keystroke autocomplete: the whole
 * infrastructure budget for this project is $2-5 a month. `/data/hotels` has no
 * published price and is already on the search path.
 *
 * So the question this probe settles is narrow and decides the design:
 *   1. Does `hotelName` find this hotel, and what does it need alongside it?
 *      (The docs do not mark anything required, but a 400 example says
 *      "countryCode is required".)
 *   2. How loose is "loose match"? A partial name, wrong case, missing brand
 *      suffix - does it still land?
 *   3. Does a locality name work through `/data/places`, and what does it cost
 *      us to find out (one cent per call below, 3 calls).
 *   4. Do the returned records carry the id and coordinates the app needs to
 *      open a hotel page, or would a second call be needed?
 *
 * Nothing here books, prebooks or spends guest money. Sandbox only, asserted
 * below. The `/data/places` calls cost $0.01 each and are limited to three.
 *
 * Run: npx tsx analysis/2026-10-11/probe-search-entry.mts
 *
 * WHAT IT SHOWED, 2026-10-11:
 *   hotelName + countryCode=US     200, one result, the target, with id and coordinates
 *   hotelName with no country      400 "you must search by either country code,
 *                                  latitude and longitude, placeId, lastUpdatedAt, IATA
 *                                  code, or hotelIds" - a country is REQUIRED here
 *   hotelName partial, lower case  200, the target again: the match is genuinely loose
 *   hotelName "holiday inn"        200, 20 hotels in four states, in no useful order
 *   cityName=Waikiki               200 and **0 results** - the supplier has no such city
 *   places textQuery=Waikiki       2 of 3 calls HTTP 429; the one that answered put
 *                                  **Waikiki, Western Australia** first and never offered
 *                                  Honolulu's Waikiki at all
 *
 * Conclusion, recorded in docs/adr/0006-search-entry-point.md: /data/hotels?hotelName for
 * the hotel tier, curated perimeters for the locality tier (measured in
 * probe-localities.mts), /data/places for neither. The placeId leg at the end never ran:
 * the 429 left no placeId to follow, and by then /data/places was ruled out on price
 * anyway. It used require() in an ESM module and would have thrown even with one - fixed
 * here rather than left as a trap for whoever re-runs this.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "raw");
mkdirSync(OUT, { recursive: true });

process.loadEnvFile(join(HERE, "..", "..", ".env.local"));
const KEY = (process.env.LITEAPI_KEY ?? "").trim();
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";

if (!KEY) throw new Error("LITEAPI_KEY is not set in .env.local");
if (!KEY.startsWith("sand_")) {
  throw new Error("refusing to run: LITEAPI_KEY is not a sandbox key (expected the sand_ prefix)");
}

let seq = 0;
async function call(path: string, label: string) {
  const res = await fetch(BASE + path, { headers: { "X-API-Key": KEY } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  seq += 1;
  writeFileSync(
    join(OUT, `${String(seq).padStart(2, "0")}-${label}.json`),
    JSON.stringify({ path, status: res.status, body }, null, 2),
  );
  return { status: res.status, body: body as any };
}

type Hotel = { id?: string; name?: string; address?: string; city?: string; latitude?: number; longitude?: number };

function summarise(label: string, status: number, body: any) {
  const rows: Hotel[] = Array.isArray(body?.data) ? body.data : [];
  console.log(`\n${label}  -> HTTP ${status}, ${rows.length} result(s)`);
  if (status !== 200) {
    console.log("   error:", JSON.stringify(body).slice(0, 200));
    return rows;
  }
  for (const h of rows.slice(0, 5)) {
    const coords = h.latitude != null && h.longitude != null ? `${h.latitude},${h.longitude}` : "NO COORDS";
    console.log(`   - ${h.name ?? "?"} | ${h.address ?? "?"} | id=${h.id ?? "NO ID"} | ${coords}`);
  }
  if (rows.length > 5) console.log(`   ... ${rows.length - 5} more`);
  return rows;
}

const TARGET = /holiday inn express waikiki/i;

async function main() {
  // --- 1. hotelName, with and without a country ---------------------------
  // The exact name first, to establish the hotel is reachable this way at all.
  const a = await call(
    `/data/hotels?hotelName=${encodeURIComponent("Holiday Inn Express Waikiki")}&countryCode=US&limit=20`,
    "hotelname-exact-us",
  );
  const exact = summarise("hotelName='Holiday Inn Express Waikiki' + countryCode=US", a.status, a.body);
  console.log(`   TARGET FOUND: ${exact.some((h) => TARGET.test(h.name ?? ""))}`);

  // Does it need the country at all? If this 400s, every name search has to
  // guess a country, which is a real constraint on the design.
  const b = await call(
    `/data/hotels?hotelName=${encodeURIComponent("Holiday Inn Express Waikiki")}&limit=20`,
    "hotelname-no-country",
  );
  summarise("hotelName only, NO countryCode", b.status, b.body);

  // --- 2. how loose is the loose match? -----------------------------------
  // What a person actually types: lower case, partial, no brand suffix.
  const c = await call(
    `/data/hotels?hotelName=${encodeURIComponent("holiday inn express waik")}&countryCode=US&limit=20`,
    "hotelname-partial-lower",
  );
  const partial = summarise("hotelName='holiday inn express waik' (partial, lower case)", c.status, c.body);
  console.log(`   TARGET FOUND: ${partial.some((h) => TARGET.test(h.name ?? ""))}`);

  // A bare brand, which is the realistic worst case for result volume.
  const d = await call(`/data/hotels?hotelName=${encodeURIComponent("holiday inn")}&countryCode=US&limit=20`, "hotelname-brand");
  summarise("hotelName='holiday inn' (brand only)", d.status, d.body);

  // --- 3. the neighbourhood, via cityName -----------------------------------
  // Free, so worth asking before paying for /data/places: does the supplier
  // treat Waikiki as a city in its own right?
  const e = await call(`/data/hotels?cityName=${encodeURIComponent("Waikiki")}&countryCode=US&limit=20`, "cityname-waikiki");
  summarise("cityName='Waikiki' + countryCode=US", e.status, e.body);

  // --- 4. /data/places, three calls, one cent each --------------------------
  console.log("\n--- /data/places: 3 calls at $0.01 each ---");
  for (const [q, type, label] of [
    ["Waikiki", "locality", "places-waikiki-locality"],
    ["Holiday Inn Express Waikiki", "hotel", "places-hotel-exact"],
    ["Waikiki", "locality,hotel", "places-waikiki-both"],
  ] as const) {
    const r = await call(
      `/data/places?textQuery=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}&language=en`,
      label,
    );
    const rows: Array<{ placeId?: string; displayName?: string; formattedAddress?: string; types?: string[] }> =
      Array.isArray(r.body?.data) ? r.body.data : [];
    console.log(`\nplaces textQuery='${q}' type='${type}' -> HTTP ${r.status}, ${rows.length} result(s)`);
    if (r.status !== 200) console.log("   error:", JSON.stringify(r.body).slice(0, 200));
    for (const p of rows.slice(0, 5)) {
      console.log(`   - ${p.displayName} | ${p.formattedAddress} | ${(p.types ?? []).slice(0, 3).join(",")}`);
      console.log(`     placeId=${p.placeId}`);
    }
  }

  // --- 5. does a placeId resolve to hotels, and how wide? -------------------
  // The docs say a placeId search covers 1 km around the place centre, or a
  // single hotel if the id is a hotel. 1 km is tight for a neighbourhood, so
  // whether this is usable for "Waikiki" is a design input, not a detail.
  const localityPlaces = JSON.parse(
    // re-read what we just wrote rather than keeping it in memory, so the file
    // on disk is what this conclusion rests on
    readFileSync(join(OUT, "06-places-waikiki-locality.json"), "utf8"),
  );
  const firstPlaceId: string | undefined = localityPlaces?.body?.data?.[0]?.placeId;
  if (firstPlaceId) {
    const f = await call(`/data/hotels?placeId=${encodeURIComponent(firstPlaceId)}&limit=50`, "hotels-by-placeid");
    const byPlace = summarise(`hotels by placeId of the first 'Waikiki' locality`, f.status, f.body);
    console.log(`   TARGET FOUND: ${byPlace.some((h) => TARGET.test(h.name ?? ""))}`);
  } else {
    console.log("\nno placeId came back for 'Waikiki', so the placeId path was not tested");
  }

  console.log(`\nraw responses in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
