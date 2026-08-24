/** What does a second "fill in the missing hotels" rates round actually cost? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const call = async (m: string, p: string, o: any = {}) => {
  let u = BASE + p; if (o.params) u += "?" + new URLSearchParams(o.params);
  const r = await fetch(u, { method: m, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  return (await r.json().catch(() => ({}))) as any;
};
const rates = (ids: string[]) => call("POST", "/hotels/rates", { body: { hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 40, roomMapping: true, timeout: 5, margin: 0 } });

for (const [label, lat, lng, radius] of [["Jamestown", 37.9527, -120.4219, 15000], ["Austin", 30.2672, -97.7431, 15000], ["Yosemite", 37.8651, -119.5383, 30000]] as const) {
  const hotels: any[] = (await call("GET", "/data/hotels", { params: { latitude: lat, longitude: lng, radius, limit: 300 } })).data ?? [];
  const ids = hotels.map((h) => h.id);
  let t = Date.now();
  const r1: any[] = (await rates(ids)).data ?? [];
  const ms1 = Date.now() - t;
  const have = new Set(r1.filter((x) => (x.roomTypes ?? []).length).map((x) => x.hotelId));
  const missing = ids.filter((id) => !have.has(id));
  t = Date.now();
  const r2: any[] = missing.length ? ((await rates(missing)).data ?? []) : [];
  const ms2 = Date.now() - t;
  const rescued = r2.filter((x) => (x.roomTypes ?? []).length).length;
  console.log(`${label.padEnd(10)} ${String(ids.length).padStart(3)} ids | round1 ${(ms1/1000).toFixed(1)}s -> ${have.size} priced, ${missing.length} missing | round2 ${(ms2/1000).toFixed(1)}s -> RESCUED ${rescued} (+${((rescued/Math.max(1,have.size))*100).toFixed(0)}%)`);
}
