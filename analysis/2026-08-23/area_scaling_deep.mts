/** Continuation of area_scaling.mts: where does /hotels/rates actually break? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
async function api(method: string, path: string, opts: any = {}) {
  let url = BASE + path;
  if (opts.params) url += "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(url, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let cur = 80;
const pool = ((await api("GET", "/data/hotels", { params: { latitude: 30.2672, longitude: -97.7431, radius: 30000, limit: 1000 } })).data ?? []) as any[];
const ids: string[] = pool.map((h) => h.id);
for (const n of [400, 500, 700, 1000]) {
  const checkin = addDays(cur++), checkout = addDays(cur + 1);
  const t = Date.now();
  try {
    const d = await api("POST", "/hotels/rates", {
      body: { hotelIds: ids.slice(0, n), occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin, checkout, maxRatesPerHotel: 40, roomMapping: true, timeout: 5, margin: 0 },
    });
    const rows = (d.data ?? d) as any[];
    console.log(`  n=${String(n).padStart(4)}  ${((Date.now() - t) / 1000).toFixed(2)}s   ${String(rows.length).padStart(4)} with rates (${((rows.length / n) * 100).toFixed(0)}%)   ${(JSON.stringify(d).length / 1024 / 1024).toFixed(2)} MB`);
  } catch (e) {
    console.log(`  n=${String(n).padStart(4)}  ERROR ${(e as Error).message}`);
  }
}
