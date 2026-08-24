/** Key is paymentTypes (plural, array). Any hotel offering anything but NUITEE_PAY? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const call = async (m: string, p: string, o: any = {}) => {
  let u = BASE + p; if (o.params) u += "?" + new URLSearchParams(o.params);
  const r = await fetch(u, { method: m, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  return (await r.json().catch(() => ({}))) as any;
};
for (const [label, lat, lng] of [["Austin", 30.2672, -97.7431], ["NYC", 40.7128, -74.006], ["London", 51.5072, -0.1276]] as const) {
  const ids = ((await call("GET", "/data/hotels", { params: { latitude: lat, longitude: lng, radius: 15000, limit: 80 } })).data ?? []).map((h: any) => h.id);
  const d = await call("POST", "/hotels/rates", { body: { hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 200, roomMapping: true, timeout: 5, margin: 0 } });
  const t: Record<string, number> = {};
  for (const m of JSON.stringify(d).matchAll(/"paymentTypes":\[([^\]]*)\]/g)) t[m[1] || "(empty)"] = (t[m[1] || "(empty)"] ?? 0) + 1;
  console.log(`${label.padEnd(8)} ${ids.length} hotels ->`, t);
}
