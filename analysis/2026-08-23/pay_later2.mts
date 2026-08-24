/** What values does paymentType take, here and across a wider sample? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const call = async (m: string, p: string, o: any = {}) => {
  let u = BASE + p; if (o.params) u += "?" + new URLSearchParams(o.params);
  const r = await fetch(u, { method: m, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  return (await r.json().catch(() => ({}))) as any;
};
const rates = (ids: string[]) => call("POST", "/hotels/rates", { body: { hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 200, roomMapping: true, timeout: 5, margin: 0 } });

const tally: Record<string, number> = {};
const walk = (o: any) => {
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    if (/^paymentType$/i.test(k)) tally[String(v)] = (tally[String(v)] ?? 0) + 1;
    else walk(v);
  }
};
let rt: any[] = [];
for (let i = 0; i < 6 && !rt.length; i++) rt = ((await rates(["lp657d352a"])).data ?? [])[0]?.roomTypes ?? [];
walk(rt);
console.log("Chicken Ranch paymentType values:", tally);

// Wider sample: 60 Austin hotels
const ids = ((await call("GET", "/data/hotels", { params: { latitude: 30.2672, longitude: -97.7431, radius: 15000, limit: 60 } })).data ?? []).map((h: any) => h.id);
const wide: Record<string, number> = {};
const walk2 = (o: any) => { if (!o || typeof o !== "object") return; for (const [k, v] of Object.entries(o)) { if (/^paymentType$/i.test(k)) wide[String(v)] = (wide[String(v)] ?? 0) + 1; else walk2(v); } };
walk2(((await rates(ids)).data ?? []));
console.log("Austin (60 hotels) paymentType values:", wide);
