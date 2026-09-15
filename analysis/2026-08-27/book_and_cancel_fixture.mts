// Throwaway end-to-end fixture: prebook -> pay via Stripe test card (REST, no
// browser) -> book -> confirm the row is `confirmed` -> call cancelBooking()
// -> confirm the row is `cancelled` and a `cancellations` row exists. Exists
// only to verify PUT /bookings/{bookingId}'s real field shape and the new
// booking-service.cancelBooking() function against a LIVE sandbox booking
// that this script itself created (never touches a real historical booking).
import { config } from "dotenv";
config({ path: ".env.local" });
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import { bookings, cancellations, bookingEvents } from "../../src/db/schema";
import { eq } from "drizzle-orm";
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
  if (!r.ok) throw new Error(`${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).data;
};

const common = {
  hotelIds: [hotelId], occupancies: [{ adults: 2 }], currency: "USD",
  guestNationality: "US", checkin, checkout, maxRatesPerHotel: 200,
  roomMapping: true, timeout: 5,
};
const priced = await api("/hotels/rates", { ...common, margin: 12 });
const offers = (priced?.[0]?.roomTypes ?? [])
  .filter((rt: any) => rt.rateType !== "package" && rt.offerId)
  .sort((a: any, b: any) => (a.offerRetailRate?.amount ?? Infinity) - (b.offerRetailRate?.amount ?? Infinity));
const rt = offers[0];
if (!rt) throw new Error("no bookable offer found");
console.log(`offer: $${rt.offerRetailRate?.amount}`);

const pb = await api("/rates/prebook", { offerId: rt.offerId, usePaymentSdk: true });
console.log(`prebook: ${pb.prebookId} secret=${String(pb.secretKey).slice(0, 12)}...`);

const pkRes = await fetch("https://payment-wrapper.liteapi.travel/config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ publicKey: "sandbox" }),
});
const { publicKey: stripePk } = await pkRes.json();
console.log(`stripe publishable key: ${String(stripePk).slice(0, 12)}...`);

// Pay via Stripe REST directly (no browser): confirm the PaymentIntent using
// the publishable key as Bearer auth + a Stripe test card token, the same
// call Stripe.js makes client-side.
const confirmRes = await fetch(
  `https://api.stripe.com/v1/payment_intents/${String(pb.secretKey).split("_secret_")[0]}/confirm`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${stripePk}`,
    },
    body: new URLSearchParams({
      client_secret: String(pb.secretKey),
      payment_method: "pm_card_visa",
    }),
  },
);
const confirmJson = await confirmRes.json();
if (!confirmRes.ok) throw new Error(`stripe confirm ${confirmRes.status}: ${JSON.stringify(confirmJson).slice(0, 400)}`);
console.log(`stripe payment_intent status: ${confirmJson.status}`);

const book = await api("/rates/book", {
  prebookId: pb.prebookId,
  holder: { firstName: "Fixture", lastName: "Guest", email: "sandbox@nostavel.com" },
  guests: [{ occupancyNumber: 1, firstName: "Fixture", lastName: "Guest", email: "sandbox@nostavel.com" }],
  payment: { method: "TRANSACTION_ID", transactionId: pb.transactionId },
});
console.log(`book: bookingId=${book.bookingId} status=${book.status}`);

const id = randomUUID();
const db = drizzle(neon(process.env.DATABASE_URL!));
await db.insert(bookings).values({
  id,
  idempotencyKey: "fixture-cancel-" + id,
  humanRef: "FIX" + String(Date.now()).slice(-5),
  status: "confirmed",
  userId: process.argv[3] ?? null,
  contactEmail: "sandbox@nostavel.com",
  hotelId,
  offerId: rt.offerId,
  prebookId: String(pb.prebookId),
  liteapiBookingId: String(book.bookingId),
  transactionId: String(pb.transactionId),
  hotelSnapshot: { name: "Fixture Hotel", city: "", lat: null, lng: null },
  roomSnapshot: { title: "Room" },
  checkinDate: checkin,
  checkoutDate: checkout,
  nights: 2,
  adults: 2,
  currency: "USD",
  amountTotalMinor: Math.round(Number(pb.price) * 100),
  amountSupplierMinor: Math.round((Number(pb.price) - Number(pb.commission ?? 0)) * 100),
  cancellationPolicy: rt.rates?.[0]?.cancellationPolicies ?? null,
  confirmedAt: new Date(),
});
console.log(`\nledger row: ${id}`);
console.log(`http://localhost:3000/book/${id}/confirmation`);
