/** Same hotels, but reading RAW rates (bypassing pickPerCancellation) to see
 * what the premium WOULD be before the collapse rule, confirming the rule is
 * actually doing something on this sample rather than finding nothing to do. */
import { config } from "dotenv";
config({ path: ".env.local" });
const BASE = process.env.LITEAPI_BASE_URL || "https://api.liteapi.travel/v3.0";
const KEY = process.env.LITEAPI_KEY!;
const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
const checkout = new Date(Date.now() + 47 * 864e5).toISOString().slice(0, 10);
const call = async (id: string, margin: number) => {
  const r = await fetch(BASE + "/hotels/rates", { method: "POST", headers: { "X-API-Key": KEY, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ hotelIds: [id], occupancies: [{ adults: 2 }], currency: "USD", guestNationality: "US", checkin, checkout, maxRatesPerHotel: 2000, roomMapping: true, timeout: 5, margin }) });
  return (await r.json()).data ?? [];
};
for (const id of ["lp1b919", "lp657d352a", "lp225d01", "lp85c07"]) {
  const rows = await call(id, 25);
  const rt = (rows[0]?.roomTypes ?? []) as any[];
  const byRoom = new Map<number, any[]>();
  for (const x of rt) {
    const key = x.mappedRoomId ?? x.roomTypeId;
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key)!.push(x);
  }
  for (const [key, plans] of byRoom) {
    const nrfn = plans.filter((p) => (p.rates?.[0]?.cancellationPolicies?.refundableTag || "") === "NRFN");
    const rfn = plans.filter((p) => (p.rates?.[0]?.cancellationPolicies?.refundableTag || "") !== "NRFN");
    if (!nrfn.length || !rfn.length) continue;
    const cheapNrfn = Math.min(...nrfn.map((p) => p.offerRetailRate.amount));
    const cheapRfn = Math.min(...rfn.map((p) => p.offerRetailRate.amount));
    const premium = cheapRfn - cheapNrfn;
    if (premium < 20) console.log(`  ${id} room ${key}: NRFN $${cheapNrfn.toFixed(2)} RFN $${cheapRfn.toFixed(2)} premium $${premium.toFixed(2)}  <-- WOULD HAVE SHOWN 2 ROWS BEFORE`);
  }
}
