// Shared DB fixture helpers for src/**/*.int.test.ts (vitest.integration.config.ts
// only — never imported by npm test / npm run verify). Every helper here
// writes against the real, containerised Postgres compose.test.yml starts;
// nothing is mocked at this layer, only the supplier client is (see
// fake-liteapi.ts). Two rules from .claude/rules/database.md and
// docs/conventions.md §6 govern everything below:
//
//   1. Fixtures invent no data. Where the schema forces a NOT NULL value and
//      no real figure exists (amountTotalMinor, hotelSnapshot, ...), the
//      value used is a clearly-labelled placeholder, never a plausible-
//      looking fabricated price or name — see the comments beside each one.
//   2. booking_events is an append-only reconciliation ledger in production;
//      rows any of these helpers cause to be written (directly, or via a
//      cascade delete from resetTestDatabase()) are disposable TEST fixtures
//      inside a throwaway, per-run Postgres container (compose.test.yml is
//      torn down with `docker compose down -v` after every `npm run test:int`
//      run — see scripts/test-int.mjs) — never a real reconciliation record.
//      resetTestDatabase()'s cascade delete of booking_events is a deliberate,
//      documented exception to "never delete ledger rows", scoped to this
//      throwaway database only. Do not reuse this helper, or the pattern,
//      against anything but the compose.test.yml container.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bookings,
  bookingGuests,
  bookingEvents,
  payments,
  cancellations,
  webhookEvents,
  type NewBooking,
  type Booking,
  type BookingGuest,
} from "@/db/schema";

/**
 * Seeds a `prebooked` booking ready for `confirmBooking` (NOS-6) or the sweep
 * route (NOS-5): prebookId, transactionId and paymentSecret are all present,
 * matching what `prepareBooking` leaves behind on a real prebook. Every id
 * defaults to a fresh `randomUUID()`-derived value so concurrent tests never
 * collide, without needing to truncate between them.
 *
 * `amountTotalMinor` defaults to 0, not a plausible-looking price: no
 * supplier ever priced this fixture, and conventions.md §6 says a fixture
 * that invents a number is exactly how a fake price ends up on a real
 * checkout page. The column is NOT NULL, so `0` — not `null` — is the
 * honest placeholder here; these tests assert row/event *counts*, never a
 * dollar amount, so nothing depends on this value being realistic.
 */
export async function seedPrebookedBooking(
  overrides: Partial<NewBooking> & { updatedAt?: Date } = {},
): Promise<Booking> {
  const id = randomUUID();
  const { updatedAt, ...bookingOverrides } = overrides;

  const draft: NewBooking = {
    humanRef: "TEST-" + id.slice(0, 8).toUpperCase(),
    userId: null,
    contactEmail: `fixture+${id}@example.invalid`,
    status: "prebooked",
    hotelId: "fixture-hotel-" + id,
    // Not a real property: a fixture snapshot, never rendered to a guest.
    hotelSnapshot: { name: "Fixture Hotel", city: "Fixture City" },
    offerId: "fixture-offer-" + id,
    boardName: null,
    roomSnapshot: { title: "Fixture Room" },
    checkinDate: "2026-10-01",
    checkoutDate: "2026-10-03",
    nights: 2,
    adults: 2,
    currency: "USD",
    amountTotalMinor: 0, // see the function comment — no sourced price exists
    idempotencyKey: "fixture-idem-" + id,
    prebookId: "fixture-prebook-" + id,
    transactionId: "fixture-txn-" + id,
    paymentSecret: "fixture-secret-" + id,
    ...bookingOverrides,
  };

  const [row] = await db.insert(bookings).values(draft).returning();

  if (updatedAt) {
    // `.insert().returning()` reflects the column's `defaultNow()`, which a
    // TTL-boundary test can't control from the insert alone — the sweeper's
    // WHERE clause reads `bookings.updatedAt` directly (see cron sweep
    // route.ts), so this is the one column a test must be able to backdate.
    const [patched] = await db
      .update(bookings)
      .set({ updatedAt })
      .where(eq(bookings.id, row.id))
      .returning();
    return patched;
  }
  return row;
}

/** Attaches a lead guest to a booking — required before `confirmBooking` will proceed. */
export async function seedLeadGuest(
  bookingId: string,
  overrides: Partial<BookingGuest> = {},
): Promise<BookingGuest> {
  const [row] = await db
    .insert(bookingGuests)
    .values({
      bookingId,
      firstName: "Fixture",
      lastName: "Guest",
      isLead: true,
      roomIndex: 0,
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * A `prebooked` booking with its lead guest already attached — the minimum
 * `confirmBooking` needs to proceed past its guard checks. This is what
 * NOS-6's double-confirm race and NOS-5's sweeper-vs-payment-in-flight test
 * both start from.
 */
export async function seedConfirmableBooking(
  overrides: Partial<NewBooking> & { updatedAt?: Date } = {},
): Promise<{ booking: Booking; guest: BookingGuest }> {
  const booking = await seedPrebookedBooking(overrides);
  const guest = await seedLeadGuest(booking.id);
  return { booking, guest };
}

/**
 * Assembled at runtime, never a literal secret in this file (conventions.md
 * §6 / the tests rule) — used as the value for both `process.env.CRON_SECRET`
 * / `process.env.LITEAPI_WEBHOOK_SECRET` in a test and the request's
 * `Authorization: Bearer <...>` header, so the two sides match without either
 * being a credential that could be mistaken for a real one.
 */
export function fakeSharedSecret(label: string): string {
  return `test-${label}-` + randomUUID();
}

/**
 * Clears every table these fixtures write to, INCLUDING booking_events via
 * cascade delete from `bookings` — see the file-level comment for why that
 * is safe here specifically (a throwaway, per-run Postgres container) and
 * nowhere else. Not required for correctness between the three NOS-33 tests
 * (every fixture id above is already unique per call), but kept as a
 * belt-and-braces reset for any future `.int.test.ts` file that wants a
 * clean slate rather than unique-id isolation.
 */
export async function resetTestDatabase(): Promise<void> {
  // Table names are literal strings, not interpolated identifiers, matching
  // exactly the `pgTable("bookings", ...)` / `pgTable("webhook_events", ...)`
  // names in src/db/schema.ts.
  await db.execute(sql.raw("truncate table bookings cascade"));
  // Not reachable via cascade from `bookings` (no FK relationship): cleared
  // separately so a webhook-dedupe test can start from an empty table too.
  await db.execute(sql.raw("truncate table webhook_events"));
}

// Re-exported so a test file that wants to assert directly against a row
// (e.g. "there is exactly one payments row for this booking") doesn't need
// its own separate import of the schema tables already in scope here.
export { bookings, bookingGuests, bookingEvents, payments, cancellations, webhookEvents };
