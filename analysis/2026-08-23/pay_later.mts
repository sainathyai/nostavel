/** Does LiteAPI expose pay-at-property / pay-later rates, like Priceline's Book & Pay Later? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const rates = async (ids: string[]) => {
  const r = await fetch(BASE + "/hotels/rates", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ hotelIds: ids, occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 2000, roomMapping: true, timeout: 5, margin: 0 }) });
  return ((await r.json()).data ?? [])[0]?.roomTypes ?? [];
};
let rt: any[] = [];
for (let i = 0; i < 6 && !rt.length; i++) rt = await rates(["lp657d352a"]);
console.log("--- full first plan, all keys ---");
console.log(JSON.stringify(rt[0], null, 1).slice(0, 2600));
const blob = JSON.stringify(rt).toLowerCase();
for (const k of ["paymenttype", "paymentmethod", "payat", "paylater", "prepay", "deposit", "guarantee", "commissionable", "paymenttiming"])
  console.log(`  contains ${k}: ${blob.includes(k)}`);
