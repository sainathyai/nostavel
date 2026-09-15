// Verifies booking-service.cancelBooking() end to end against a real fixture
// booking: calls the real LiteAPI PUT /bookings/{id}, checks the ledger row
// flips to cancelled, a cancellations row lands, and the booking_events
// timeline is correct.
import { config } from "dotenv";
config({ path: ".env.local" });

const { Module } = await import("node:module");
const { fileURLToPath } = await import("node:url");
const origResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (req: string, ...rest: unknown[]) {
  if (req === "server-only") return fileURLToPath(new URL("../2026-08-21/_noop.cjs", import.meta.url));
  return origResolve.call(this, req, ...rest);
};

const { cancelBooking } = await import("../../src/lib/booking-service");
const { drizzle } = await import("drizzle-orm/neon-http");
const { neon } = await import("@neondatabase/serverless");
const { bookings, cancellations, bookingEvents } = await import("../../src/db/schema");
const { eq } = await import("drizzle-orm");

const bookingId = process.argv[2];
if (!bookingId) throw new Error("usage: cancel_service_probe.mts <bookingId>");

const result = await cancelBooking(bookingId, { actor: "user" });
console.log("cancelBooking() result:", result);

const db = drizzle(neon(process.env.DATABASE_URL!));
const row = (await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1))[0];
console.log("booking.status:", row.status, "cancelledAt:", row.cancelledAt);

const cRows = await db.select().from(cancellations).where(eq(cancellations.bookingId, bookingId));
console.log("cancellations rows:", cRows);

const eRows = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
console.log(
  "booking_events:",
  eRows.map((e: any) => e.type),
);

// Idempotency: calling again should return the stored outcome, not re-cancel.
const again = await cancelBooking(bookingId, { actor: "user" });
console.log("second call (idempotent):", again);
