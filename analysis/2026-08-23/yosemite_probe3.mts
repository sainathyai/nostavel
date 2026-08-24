/** Nails down which margin produced the $498.65 the guest saw, and the distances. */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
async function api(method: string, path: string, opts: any = {}) {
  let url = BASE + path;
  if (opts.params) url += "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]) => [k, String(v)])).toString();
  const res = await fetch(url, { method, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}
const A = "lp657d352a", B = "lp6556f7f5";
const rates = (id: string, margin: number) => api("POST", "/hotels/rates", { body: { hotelIds: [id], occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 2000, roomMapping: true, timeout: 5, margin } });

for (const margin of [0, 15, 25]) {
  let rt: any[] = [];
  for (let i = 0; i < 8 && !rt.length; i++) rt = ((await rates(A, margin)).data ?? [])[0]?.roomTypes ?? [];
  const king = rt.find((x) => /king/i.test(x?.rates?.[0]?.name ?? ""));
  console.log(`  margin ${String(margin).padStart(2)}:  King+Balcony charged $${Number(king?.offerRetailRate?.amount).toFixed(2)}   cheapest $${Math.min(...rt.map((x) => x.offerRetailRate.amount)).toFixed(2)}`);
}

const hav = (a: number, b: number, c: number, d: number) => { const R = 6371, r = (x: number) => (x * Math.PI) / 180; const dLa = r(c - a), dLo = r(d - b); return 2 * R * Math.asin(Math.sqrt(Math.sin(dLa / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLo / 2) ** 2)); };
console.log();
for (const id of [A, B]) {
  const raw = await api("GET", "/data/hotel", { params: { hotelId: id } });
  const m = raw.data ?? raw;
  console.log(`  ${id} ${String(m.name).slice(0, 40).padEnd(40)} ${m.city ?? "?"}  lat ${m.latitude} lng ${m.longitude}  ${Number.isFinite(m.latitude) ? hav(37.8651, -119.5383, m.latitude, m.longitude).toFixed(1) + " km" : "no coords"} from Yosemite centre (radius 30 km)`);
}
