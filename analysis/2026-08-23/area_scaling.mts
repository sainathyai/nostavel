/**
 * Two questions, both raised by "zooming out shows no new results, and the
 * 30-hotel limit is not required":
 *
 *   1. Does /data/hotels honour a radius above our hardcoded 30 km clamp, and
 *      how many hotels does a wider circle actually return?
 *   2. How does ONE /hotels/rates call scale with the number of hotelIds?
 *      Latency, and how many of those hotels come back with any rate at all.
 *
 * Every rates call uses a UNIQUE check-in date, because LiteAPI caches a
 * response for identical params and an earlier sweep measured the cache
 * instead of the API (conventions section 5).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;

async function api(method: string, path: string, opts: { body?: unknown; params?: Record<string, string | number> } = {}) {
  let url = BASE + path;
  if (opts.params) url += "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const AUSTIN = { lat: 30.2672, lng: -97.7431 };
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let dateCursor = 40;
const nextDates = () => {
  const checkin = addDays(dateCursor++);
  const checkout = addDays(dateCursor + 1);
  return { checkin, checkout };
};

console.log("=== Q1: /data/hotels radius vs count (limit 1000) ===");
const radii = [5_000, 15_000, 30_000, 50_000, 100_000, 200_000];
for (const radius of radii) {
  try {
    const t = Date.now();
    const d = await api("GET", "/data/hotels", {
      params: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, radius, limit: 1000 },
    });
    const rows = (d.data ?? d) as any[];
    console.log(`  radius ${String(radius).padStart(7)}m  ->  ${String(rows.length).padStart(4)} hotels  ${((Date.now() - t) / 1000).toFixed(2)}s`);
  } catch (e) {
    console.log(`  radius ${String(radius).padStart(7)}m  ->  ERROR ${(e as Error).message}`);
  }
}

console.log("\n=== Q1b: /data/hotels limit ceiling at radius 30km ===");
for (const limit of [30, 100, 250, 500, 1000, 2000]) {
  try {
    const d = await api("GET", "/data/hotels", {
      params: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, radius: 30_000, limit },
    });
    const rows = (d.data ?? d) as any[];
    console.log(`  limit ${String(limit).padStart(5)}  ->  ${rows.length} hotels`);
  } catch (e) {
    console.log(`  limit ${String(limit).padStart(5)}  ->  ERROR ${(e as Error).message}`);
  }
}

console.log("\n=== Q2: /hotels/rates latency vs hotelId count ===");
const pool = ((await api("GET", "/data/hotels", {
  params: { latitude: AUSTIN.lat, longitude: AUSTIN.lng, radius: 30_000, limit: 1000 },
})).data ?? []) as any[];
const ids: string[] = pool.map((h) => h.id);
console.log(`  pool size: ${ids.length}`);

for (const n of [30, 60, 100, 150, 200, 300]) {
  if (n > ids.length) { console.log(`  n=${n} skipped (pool too small)`); continue; }
  const { checkin, checkout } = nextDates();
  const t = Date.now();
  try {
    const d = await api("POST", "/hotels/rates", {
      body: {
        hotelIds: ids.slice(0, n),
        occupancies: [{ adults: 2 }],
        currency: "USD",
        guestNationality: "US",
        checkin,
        checkout,
        maxRatesPerHotel: 40,
        roomMapping: true,
        timeout: 5,
        margin: 0,
      },
    });
    const rows = (d.data ?? d) as any[];
    const bytes = JSON.stringify(d).length;
    console.log(
      `  n=${String(n).padStart(3)}  ${((Date.now() - t) / 1000).toFixed(2)}s   ` +
        `${String(rows.length).padStart(3)} hotels with rates (${((rows.length / n) * 100).toFixed(0)}%)   ` +
        `${(bytes / 1024).toFixed(0)} KB`,
    );
  } catch (e) {
    console.log(`  n=${String(n).padStart(3)}  ERROR ${(e as Error).message}`);
  }
}
