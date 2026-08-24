/** Exact distance of the two hotels from the Yosemite search centre. */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const get = async (p: string, params: any) => {
  const r = await fetch(BASE + p + "?" + new URLSearchParams(params), { headers: { "X-API-Key": KEY, Accept: "application/json" } });
  return r.json();
};
const hav = (a: number, b: number, c: number, d: number) => { const R = 6371, r = (x: number) => (x * Math.PI) / 180; const dLa = r(c - a), dLo = r(d - b); return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2)); };
const rows: any[] = ((await get("/data/hotels", { latitude: 37.8651, longitude: -119.5383, radius: 200000, limit: 1000 })).data ?? []);
console.log(`200 km sweep from Yosemite centre: ${rows.length} hotels`);
for (const id of ["lp657d352a", "lp6556f7f5"]) {
  const h = rows.find((x) => x.id === id);
  if (!h) { console.log(`  ${id}: not even in the 200 km / 1000-row page`); continue; }
  console.log(`  ${id} ${String(h.name).slice(0, 40).padEnd(40)} ${h.city}  ${hav(37.8651, -119.5383, h.latitude, h.longitude).toFixed(1)} km from centre`);
}
const inside = rows.filter((h) => hav(37.8651, -119.5383, h.latitude, h.longitude) <= 30);
console.log(`  hotels within the 30 km search radius: ${inside.length}`);
