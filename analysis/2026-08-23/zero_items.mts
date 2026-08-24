/** Why does a Jamestown area search sometimes return 0 items? Which call is empty? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const call = async (m: string, p: string, o: any = {}) => {
  let u = BASE + p; if (o.params) u += "?" + new URLSearchParams(o.params);
  const r = await fetch(u, { method: m, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
for (let i = 0; i < 8; i++) {
  const h = await call("GET", "/data/hotels", { params: { latitude: 37.9527, longitude: -120.4219, radius: 15000, limit: 300 } });
  const ids = ((h.body.data ?? []) as any[]).map((x) => x.id);
  const r = await call("POST", "/hotels/rates", { body: { hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 40, roomMapping: true, timeout: 5, margin: 0 } });
  const rows = (r.body.data ?? []) as any[];
  console.log(`run ${i + 1}: /data/hotels ${h.status} -> ${ids.length} ids | /hotels/rates ${r.status} -> ${rows.length} rows` + (rows.length === 0 ? `  BODY: ${JSON.stringify(r.body).slice(0, 220)}` : ""));
}
