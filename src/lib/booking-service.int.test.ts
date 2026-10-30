// Integration test: proves the NOS-6 double-confirm race against a REAL
// Postgres (vitest.integration.config.ts), not a simulated race. The
// concurrency behaviour under test is what happens when two overlapping
// UPDATEs race against Postgres's own row-level atomicity, and that can only
// be proven by actually racing two calls against a real database — a mocked
// connection has no concurrency to get wrong.
//
// WHAT THIS PROVES: confirmBooking (src/lib/booking-service.ts) reads a
// booking row with a plain SELECT, checks `row.status === "prebooked"`, and
// only then calls the supplier and writes the row back with a bare
// `UPDATE ... WHERE id = ...` — no `WHERE status = 'prebooked'`
// compare-and-swap, no `RETURNING` row count checked (contrast the cron
// sweep route, which does exactly that — see its own file comment). Two
// concurrent calls for the same bookingId can both pass the SELECT-time
// check before either has written back, so both reach the supplier's
// `book()`, and this booking is charged and booked twice.
//
// WHAT WOULD MAKE THIS PASS: NOS-6 turning confirmBooking's read-then-write
// into the same compare-and-swap idiom the sweep route already uses
// (`UPDATE bookings SET status = 'confirmed' WHERE id = ... AND status =
// 'prebooked' RETURNING id`), so only one of two concurrent calls ever sees
// a non-empty RETURNING and calls the supplier. When that lands, this
// test's assertions start passing, which `it.fails` turns into a hard suite
// failure until the marker is removed — see the ticket (NOS-29/NOS-33) for
// why that is deliberate, not a placeholder.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { payments, bookingEvents } from "@/db/schema";
import { confirmBooking, recordUnresolvedPayment } from "@/lib/booking-service";
import { seedConfirmableBooking } from "@/test-support/db-fixtures";
import {
  bookCalls,
  resetFakeSupplier,
  holdBookCalls,
  releaseBookCalls,
  waitForBookCalls,
} from "@/test-support/fake-liteapi";

// Stands in for the real supplier for every call this file makes — see
// src/test-support/fake-liteapi.ts for the contract it mimics and where it
// deliberately diverges. No test in this repo may reach LiteAPI over the
// network (NOS-29 AC 6).
vi.mock("@/lib/liteapi", async () => import("@/test-support/fake-liteapi"));

beforeEach(() => {
  resetFakeSupplier();
});

afterEach(() => {
  // Belt-and-braces: if an assertion above throws while calls are still
  // parked on the gate, don't leave it closed for whatever runs next.
  releaseBookCalls();
});

describe("confirmBooking under two concurrent calls for the same booking (NOS-6)", () => {
  it("charges and books the supplier only once for one bookingId", async () => {
    const { booking } = await seedConfirmableBooking();

    // Hold every book() call open until BOTH concurrent confirmBooking calls
    // have reached the supplier — deterministic proof of the race window,
    // not a hope that two same-process calls happen to overlap on a fast
    // loopback connection. Nothing in confirmBooking writes the row back
    // until AFTER book() resolves, so by the time both calls are recorded
    // here, both have already independently passed the `status ===
    // "prebooked"` read — which is the exact moment the race exists in.
    holdBookCalls();
    const first = confirmBooking({ bookingId: booking.id });
    const second = confirmBooking({ bookingId: booking.id });
    // Bounded, not unbounded: once NOS-6 lands, a compare-and-swapped second
    // call may fail its own status check and never reach book() at all —
    // waiting for exactly two calls would then hang forever post-fix. 500ms
    // is generous for two same-process calls against a local containerised
    // Postgres to both reach their first supplier call, if they are going to.
    await Promise.race([waitForBookCalls(2), new Promise((r) => setTimeout(r, 500))]);
    releaseBookCalls();
    const results = await Promise.allSettled([first, second]);

    // The money-losing direction: a compare-and-swapped confirm lets only
    // one caller ever reach the supplier, so the guest's card is charged
    // once, not twice.
    expect(bookCalls.length).toBe(1);

    // The guest-harming direction: a second, silently-accepted confirm
    // writes a second `payments` row and a second `book.confirmed` ledger
    // entry for money that was only ever charged once by the supplier — a
    // reconciliation record that lies about what happened, which is exactly
    // the job docs/conventions.md §8 gives this table.
    const paymentRows = await db.select().from(payments).where(eq(payments.bookingId, booking.id));
    expect(paymentRows.length).toBe(1);

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id));
    expect(events.filter((e) => e.type === "book.confirmed").length).toBe(1);

    // Both callers still get a real answer either way — this suite is about
    // the double-charge, not about one request hanging or crashing.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("the confirmation page's unresolved payment, which also has to reach a person (NOS-56)", () => {
  // THE THIRD WRITE SITE. NOS-56's acceptance criteria name the sweeper's two
  // cases; this one is a guest's browser coming back from the payment provider
  // onto a lapsed hold, which is the only one of the three where the guest
  // demonstrably reached the card step. Alerting on the other two and not this
  // one would have left the loudest case silent.
  async function unresolvedAlerts(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await run();
      return error.mock.calls
        .map((call) => {
          try {
            return JSON.parse(String(call[0])) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is Record<string, unknown> => entry?.event === "payment.unresolved");
    } finally {
      error.mockRestore();
    }
  }

  it("records the event and raises the alert, with the booking and the money on it", async () => {
    const { booking } = await seedConfirmableBooking({ amountTotalMinor: 41255 });

    const alerts = await unresolvedAlerts(() =>
      recordUnresolvedPayment(booking.id, "the provider's redirect arrived on a lapsed hold"),
    );

    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id));
    expect(events.filter((e) => e.type === "payment.unresolved")).toHaveLength(1);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "ERROR",
      humanRef: booking.humanRef,
      amountTotalMinor: 41255,
      transactionId: booking.transactionId,
    });
    expect(String(alerts[0].message)).toContain("USD 412.55");
    // The guest's address is on the row and must not be in the alert.
    expect(JSON.stringify(alerts[0])).not.toContain(booking.contactEmail!);
  });

  it("stays silent on a refresh, because this page is a URL a guest will reload", async () => {
    // The event is already idempotent per booking; the alert has to be too, or
    // a guest refreshing the page becomes a stream of identical emails.
    const { booking } = await seedConfirmableBooking();

    const first = await unresolvedAlerts(() => recordUnresolvedPayment(booking.id, "redirect on a lapsed hold"));
    const second = await unresolvedAlerts(() => recordUnresolvedPayment(booking.id, "redirect on a lapsed hold"));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, booking.id));
    expect(events.filter((e) => e.type === "payment.unresolved")).toHaveLength(1);
  });
});
