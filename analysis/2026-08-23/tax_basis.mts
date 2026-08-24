/** Is our $413 net tax-INCLUSIVE while Priceline's $448 is tax-exclusive? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const call = async (m: string, p: string, o: any = {}) => {
  let u = BASE + p; if (o.params) u += "?" + new URLSearchParams(o.params);
  const r = await fetch(u, { method: m, headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: o.body ? JSON.stringify(o.body) : undefined });
  return (await r.json().catch(() => ({}))) as any;
};
const meta = await call("GET", "/data/hotel", { params: { hotelId: "lp657d352a" } });
const h = meta.data ?? meta;
console.log("filed taxes:", JSON.stringify(h.hotelTaxes ?? h.taxes ?? "none"));

let rt: any[] = [];
for (let i = 0; i < 6 && !rt.length; i++)
  rt = ((await call("POST", "/hotels/rates", { body: { hotelIds: ["lp657d352a"], occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 2000, roomMapping: true, timeout: 5, margin: 0 } })).data ?? [])[0]?.roomTypes ?? [];

for (const x of rt) {
  const net = x.offerRetailRate.amount;
  const fees = (x.rates[0]?.retailRate?.taxesAndFees ?? []) as any[];
  const inc = fees.filter((f) => f.included).reduce((s, f) => s + f.amount, 0);
  const exc = fees.filter((f) => !f.included).reduce((s, f) => s + f.amount, 0);
  const room = net - inc;
  console.log(`${String(x.rates[0].name).slice(0,34).padEnd(34)} net $${net.toFixed(2)}  taxIncluded $${inc.toFixed(2)}  roomOnly $${room.toFixed(2)}  ($${(room/2).toFixed(2)}/night)  taxRate ${((inc/room)*100).toFixed(1)}%  dueAtProp $${exc.toFixed(2)}`);
  console.log(`   fee lines: ${JSON.stringify(fees)}`);
}
