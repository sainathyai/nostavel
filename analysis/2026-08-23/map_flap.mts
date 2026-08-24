/** Does Chicken Ranch flap in and out of a MAP area search? Same viewport each time. */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const A = "lp657d352a";
const call = async (m: string, p: string, o: any = {}) => {
  let u = BASE + p;
  if (o.params) u += "?" + new URLSearchParams(o.params);
  const r = await fetch(u, { method: m, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  return (await r.json().catch(() => ({}))) as any;
};
// Jamestown viewport, as the map would send it
const hotels: any[] = (await call("GET", "/data/hotels", { params: { latitude: 37.9527, longitude: -120.4219, radius: 15000, limit: 300 } })).data ?? [];
const ids = hotels.map((h) => h.id);
console.log(`hotel list: ${ids.length} hotels, Chicken Ranch present: ${ids.includes(A)}`);

let inList = 0;
for (let i = 0; i < 10; i++) {
  const d = await call("POST", "/hotels/rates", { body: { hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 40, roomMapping: true, timeout: 5, margin: 0 } });
  const rows: any[] = d.data ?? [];
  const entry = rows.find((x) => x.hotelId === A);
  const n = entry?.roomTypes?.length ?? 0;
  if (n) inList++;
  process.stdout.write(`${n ? n : "MISSING"}  `);
}
console.log(`\nChicken Ranch priced in ${inList}/10 identical area searches`);
