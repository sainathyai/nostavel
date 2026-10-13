/**
 * NOS-66: pick and verify a perimeter for each curated locality.
 *
 * Why this exists: the owner could not find "Holiday Inn Express Waikiki" by
 * typing "Waikiki". The typeahead is entirely local data - curated
 * DESTINATIONS, then LiteAPI's own US city list (src/data/us-cities.json,
 * harvested from /data/cities?countryCode=US), then the international tier -
 * and "Waikiki" is in none of them. Measured the same day:
 * `/data/hotels?cityName=Waikiki&countryCode=US` returns **0 results**, so the
 * supplier does not treat it as a city either.
 *
 * Checked against the harvested list, most famous lodging neighbourhoods are
 * already there as cities (Hollywood CA, La Jolla, Lahaina, Wailea, Kihei,
 * Pigeon Forge, Sunny Isles Beach, Clearwater Beach, Lake Buena Vista). Only
 * three candidates are actually broken, and they break in two different ways:
 *
 *   Waikiki        absent entirely
 *   French Quarter absent entirely
 *   South Beach    present, but as South Beach **NY** (Staten Island), so the
 *                  name resolves to the wrong coast
 *
 * A curated DESTINATIONS entry fixes all three, because curated matches are
 * prepended in /api/cities. But a curated entry is a perimeter - lat, lng and
 * a radius in metres - and those numbers are a claim about where a
 * neighbourhood is. This probe is the source for that claim: for each
 * candidate centre and radius it asks the supplier which hotels fall inside,
 * and prints their street addresses so the boundary can be judged rather than
 * asserted. A radius that is too small misses the strip; too large and
 * "Waikiki" quietly becomes "Honolulu".
 *
 * Only /data/hotels is used, the same endpoint the search path already calls.
 * /data/places is deliberately NOT used: it costs $0.01 per request, it
 * returned 429 twice in three calls on the sandbox, and for the query that
 * started this it ranks **Waikiki, Western Australia** first and never offers
 * Honolulu's Waikiki at all (see probe-search-entry.mts).
 *
 * Nothing here books, prebooks or spends guest money. Sandbox only, asserted
 * below.
 *
 * Run: npx tsx analysis/2026-10-11/probe-localities.mts
 */
import { mkdirSync, writeFileSync } from "node:fs";
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

type Hotel = { id?: string; name?: string; address?: string; city?: string; latitude?: number; longitude?: number };

async function hotels(params: Record<string, string | number>, label: string): Promise<{ status: number; rows: Hotel[] }> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${BASE}/data/hotels?${qs}`, { headers: { "X-API-Key": KEY } });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  writeFileSync(join(OUT, `loc-${label}.json`), JSON.stringify({ params, status: res.status, body }, null, 2));
  return { status: res.status, rows: Array.isArray(body?.data) ? body.data : [] };
}

// metres between two coordinates, so a hotel's distance from the centre can be
// printed rather than guessed at from the address
function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180;
  const lb = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Candidate centres. These are the hypothesis; the output below is the test.
// Each centre is the middle of the lodging strip the NAME means to a guest,
// not the centroid of the administrative area.
const CANDIDATES = [
  { key: "waikiki", name: "Waikiki", region: "HI", lat: 21.2793, lng: -157.8292, radius: 2200, label: "waikiki" },
  { key: "frenchquarter", name: "French Quarter", region: "LA", lat: 29.9584, lng: -90.0644, radius: 1500, label: "frenchquarter" },
  { key: "southbeach", name: "South Beach", region: "FL", lat: 25.7823, lng: -80.1322, radius: 2000, label: "southbeach" },
];

// The hotel the owner could not reach. If a Waikiki perimeter does not contain
// this, the perimeter is wrong - this is the acceptance test for the whole ticket.
const TARGET = /holiday inn express waikiki/i;

async function main() {
  for (const c of CANDIDATES) {
    const r = await hotels({ latitude: c.lat, longitude: c.lng, radius: c.radius, limit: 50 }, c.label);
    console.log(`\n=== ${c.name}, ${c.region}  centre ${c.lat},${c.lng}  radius ${c.radius}m ===`);
    if (r.status !== 200) {
      console.log(`   HTTP ${r.status} - see raw/loc-${c.label}.json`);
      continue;
    }
    const withDist = r.rows.map((h) => ({
      h,
      d: h.latitude != null && h.longitude != null ? metres(c.lat, c.lng, h.latitude, h.longitude) : -1,
    }));
    withDist.sort((a, b) => a.d - b.d);
    console.log(`   ${r.rows.length} hotel(s)`);
    for (const { h, d } of withDist) {
      console.log(`   ${String(d).padStart(5)}m  ${h.name ?? "?"} | ${h.address ?? "?"} | ${h.city ?? "?"}`);
    }
    const far = withDist.filter((x) => x.d > c.radius).length;
    console.log(`   furthest: ${withDist.at(-1)?.d ?? "-"}m, outside the stated radius: ${far}`);
    if (c.key === "waikiki") {
      console.log(`   TARGET (Holiday Inn Express Waikiki) INSIDE: ${r.rows.some((h) => TARGET.test(h.name ?? ""))}`);
    }
  }

  // For contrast: how many does the existing Honolulu perimeter return? If
  // Waikiki's set is a small, recognisable subset of it, the locality earns its
  // place; if it is nearly the same set, the entry is only a synonym.
  const hono = await hotels({ latitude: 21.2793, longitude: -157.8293, radius: 9000, limit: 200 }, "honolulu-9km");
  console.log(`\nexisting Honolulu perimeter (9000m): ${hono.rows.length} hotel(s)`);

  console.log(`\nraw responses in ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
