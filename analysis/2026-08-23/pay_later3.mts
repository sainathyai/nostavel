/** Where does the string "paymentType" actually live in the response? */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const r = async () => {
  const res = await fetch(BASE + "/hotels/rates", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ hotelIds: ["lp657d352a"], occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin: "2026-09-20", checkout: "2026-09-22", maxRatesPerHotel: 2000, roomMapping: true, timeout: 5, margin: 0 }) });
  return await res.json();
};
let d: any = {};
for (let i = 0; i < 6; i++) { d = await r(); if (((d.data ?? [])[0]?.roomTypes ?? []).length) break; }
const s = JSON.stringify(d);
let i = s.toLowerCase().indexOf("paymenttype");
while (i !== -1) { console.log("...", s.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, " "), "\n"); i = s.toLowerCase().indexOf("paymenttype", i + 1); }
if (!s.toLowerCase().includes("paymenttype")) console.log("not present in this response at all");
