// Create a real prebooked row so the rewritten checkout page can be rendered
// and read end to end without a browser.
//
// It cannot import booking-service or liteapi: both carry `server-only`, which
// throws outside a Next request. So it does the two LiteAPI calls over plain
// fetch (the same bodies src/lib/liteapi.ts sends) and writes the row through
// the schema directly. The SNAPSHOT SHAPE below is the thing under test — it
// must match what StayDetailClient passes to prepareBookingAction.
// Next reads .env.local; plain dotenv does not, so name it.
import { config } from "dotenv";
config({ path: ".env.local" });
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { bookings } from "../../src/db/schema";
import { randomUUID } from "node:crypto";

const KEY = process.env.LITEAPI_KEY!;
const hotelId = process.argv[2] ?? "lp85c07";
const checkin = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
const checkout = new Date(Date.now() + 47 * 864e5).toISOString().slice(0, 10);

const api = async (path: string, body: unknown) => {
  const r = await fetch("https://api.liteapi.travel/v3.0" + path, {
    method: "POST",
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data;
};
const get = async (path: string) => {
  const r = await fetch("https://api.liteapi.travel/v3.0" + path, { headers: { "X-API-Key": KEY } });
  return r.ok ? (await r.json()).data : null;
};

const common = {
  hotelIds: [hotelId], occupancies: [{ adults: 2 }], currency: "USD",
  guestNationality: "US", checkin, checkout, maxRatesPerHotel: 2000,
  roomMapping: true, timeout: 5,
};

const priced = await api("/hotels/rates", { ...common, margin: 12 });
const detail = await get(`/data/hotel?hotelId=${hotelId}`);

// Cheapest bookable standard offer, the same filter the app applies. Pass
// --tiers to prefer an offer with a MULTI-RUNG cancellation ladder instead:
// those are the ones that exercise the part-refundable rendering, and the
// cheapest offer is almost always non-refundable so it never reaches that code.
const wantTiers = process.argv.includes("--tiers");
const offers = (priced?.[0]?.roomTypes ?? [])
  .filter((rt: any) => rt.rateType !== "package" && rt.offerId)
  .map((rt: any) => ({
    rt,
    amt: rt.offerRetailRate?.amount ?? Infinity,
    rungs: (rt.rates?.[0]?.cancellationPolicies?.cancelPolicyInfos ?? []).length,
  }))
  .sort((a: any, b: any) => (wantTiers ? b.rungs - a.rungs || a.amt - b.amt : a.amt - b.amt));
const { rt, amt, rungs } = offers[0];
console.log(`picked offer with ${rungs} cancellation rung(s) at $${amt}`);
const fr = rt.rates?.[0] ?? {};
const fee = (fr.retailRate?.taxesAndFees ?? [])
  .filter((t: any) => !t.included)
  .reduce((s: number, t: any) => s + Number(t.amount || 0), 0);

const pb = await api("/rates/prebook", { offerId: rt.offerId, usePaymentSdk: true });
console.log(`prebook ok — ${pb.prebookId}  price ${pb.price}  commission ${pb.commission}`);

const id = randomUUID();
const db = drizzle(neon(process.env.DATABASE_URL!));
await db.insert(bookings).values({
  id,
  idempotencyKey: "fixture-" + id,
  humanRef: "FIX" + String(Date.now()).slice(-5),
  status: "prebooked",
  userId: null,
  contactEmail: "sandbox@nostavel.com",
  hotelId,
  offerId: rt.offerId,
  prebookId: String(pb.prebookId),
  transactionId: String(pb.transactionId),
  paymentSecret: String(pb.secretKey),
  hotelSnapshot: {
    name: detail?.name ?? "Hotel",
    city: detail?.city ?? "",
    address: detail?.address ?? "",
    image: detail?.main_photo ?? null,
    stars: detail?.starRating ?? 0,
    postcode: detail?.zip ?? null,
    checkinTime: detail?.checkinCheckoutTimes?.checkin_start ?? null,
    checkoutTime: detail?.checkinCheckoutTimes?.checkout ?? null,
    lat: detail?.location?.latitude ?? null,
    lng: detail?.location?.longitude ?? null,
  },
  roomSnapshot: {
    title: fr.name ?? "Room",
    beds: "1 King bed",
    board: /breakfast/i.test(fr.boardName ?? "") ? "Breakfast included" : (fr.boardName ?? "Room only"),
    supplierBoard: fr.boardName ?? null,
    image: detail?.main_photo ?? null,
    amenities: ["Air conditioning", "Free WiFi"],
    sleeps: fr.maxOccupancy ?? 2,
    size: "32 m²",
    // NULL, deliberately. An earlier version wrote `amt * 1.18` here and the
    // checkout page struck it through as "public rate elsewhere" -- a savings
    // claim invented by the fixture. A compare-at may only come from sourced
    // SSP evidence (pricing.ts compareAtPrice); a fixture has none.
    themMinor: null,
    rateMinor: Math.round(amt * 100),
    feeAtHotelMinor: Math.round(fee * 100),
    feeNote: fee > 0 ? `$${Math.round(fee)} resort fee collected by the hotel at check-in` : null,
    taxInRateMinor: null,
  },
  checkinDate: checkin,
  checkoutDate: checkout,
  nights: 2,
  adults: 2,
  currency: "USD",
  amountTotalMinor: Math.round(Number(pb.price) * 100),
  amountSupplierMinor: Math.round((Number(pb.price) - Number(pb.commission ?? 0)) * 100),
  cancellationPolicy: fr.cancellationPolicies ?? null,
  refundableUntil: fr.cancellationPolicies?.cancelPolicyInfos?.[0]?.cancelTime
    ? new Date(fr.cancellationPolicies.cancelPolicyInfos[0].cancelTime.replace(" ", "T") + "Z")
    : null,
});

console.log(`room:  ${fr.name}`);
console.log(`board: ${fr.boardName}   tiers: ${(fr.cancellationPolicies?.cancelPolicyInfos ?? []).length}`);
console.log(`fee due at property: $${fee.toFixed(2)}`);
console.log(`\nhttp://localhost:3000/book/${id}`);
