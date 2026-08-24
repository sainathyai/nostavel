/**
 * A 30 km /data/hotels query returned 141 hotels of which only 5 are actually
 * within 30 km. Is `radius` a filter or a hint? This decides whether the map's
 * "search this area" can trust it, since we derive it from the viewport.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const get = async (params: any) => {
  const r = await fetch(BASE + "/data/hotels?" + new URLSearchParams(params), { headers: { "X-API-Key": KEY, Accept: "application/json" } });
  return (await r.json()).data ?? [];
};
const hav = (a: number, b: number, c: number, d: number) => { const R = 6371, r = (x: number) => (x * Math.PI) / 180; const dLa = r(c - a), dLo = r(d - b); return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2)); };

for (const [label, lat, lng] of [["Yosemite", 37.8651, -119.5383], ["Austin", 30.2672, -97.7431]] as const) {
  console.log(`\n=== ${label} ===`);
  for (const radius of [5000, 30000, 100000]) {
    const rows: any[] = await get({ latitude: lat, longitude: lng, radius, limit: 300 });
    const d = rows.map((h) => hav(lat, lng, h.latitude, h.longitude)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!d.length) { console.log(`  radius ${radius / 1000} km -> ${rows.length} rows, no coords`); continue; }
    const inside = d.filter((x) => x <= radius / 1000).length;
    console.log(
      `  radius ${String(radius / 1000).padStart(3)} km -> ${String(rows.length).padStart(3)} rows | ` +
      `inside ${String(inside).padStart(3)} (${((inside / d.length) * 100).toFixed(0)}%) | ` +
      `median ${d[Math.floor(d.length / 2)].toFixed(1)} km | max ${d[d.length - 1].toFixed(1)} km`,
    );
  }
}
