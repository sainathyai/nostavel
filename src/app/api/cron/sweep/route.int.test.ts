// Integration test: proves the NOS-5 sweeper-vs-payment-in-flight gap
// against a REAL Postgres (vitest.integration.config.ts) — the sweep
// route's own concurrency argument (its file comment) rests on Postgres's
// `UPDATE ... WHERE status = 'prebooked' ... RETURNING` being atomic, so the
// row this test seeds and the route's actual query need to be the same
// database, not a mock, for the gap to mean anything.
//
// WHAT THIS PROVES: a `prebooked` row can sit in that status for the WHOLE
// gap between the guest's card being charged (client-side, via the Payment
// SDK — see confirmBooking's own comment: "No guest charge, no booking")
// and the guest's browser returning to the returnUrl to call confirmBooking.
// Nothing in the schema or the sweep route distinguishes "abandoned, guest
// never reached payment" from "payment already charged, guest hasn't come
// back yet" — both are just a `prebooked` row whose `updatedAt` hasn't
// moved. If that gap exceeds PREBOOK_TTL_MINUTES (a slow bank 3-D Secure
// challenge, a flaky redirect, a guest who leaves the tab open), the
// sweeper expires the row — clearing paymentSecret, flipping status to
// `expired` — and confirmBooking, called moments later by the guest's own
// returning browser, refuses to finalize a non-`prebooked` row. The card
// was charged; there is no booking, and nothing un-does the charge.
//
// WHAT WOULD MAKE THIS PASS: NOS-5 giving the sweeper (or confirmBooking) a
// way to tell "payment already initiated" apart from "truly abandoned" —
// for example, a `payment_pending` transition written when the guest's
// browser reaches the payment step, which the sweeper's WHERE clause would
// then exclude, so a row mid-charge is never swept out from under a guest.
// When that lands, this test's assertion (confirmBooking can still finalize
// a booking whose prebook aged past the TTL while payment was in flight)
// starts passing, which `it.fails` turns into a hard suite failure until
// this marker is removed — see the ticket (NOS-29/NOS-33) for why that is
// deliberate, not a placeholder.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings } from "@/db/schema";
import { confirmBooking } from "@/lib/booking-service";
import { cutoffFor } from "@/lib/cron-format";
import { POST as sweep } from "./route";
import { seedConfirmableBooking, fakeSharedSecret } from "@/test-support/db-fixtures";
import { resetFakeSupplier } from "@/test-support/fake-liteapi";

// confirmBooking (called after the sweep, simulating the guest's return
// trip) still reaches @/lib/liteapi's `book` — stubbed so this file never
// touches the real supplier (NOS-29 AC 6). See fake-liteapi.ts for the
// contract it mimics.
vi.mock("@/lib/liteapi", async () => import("@/test-support/fake-liteapi"));

// Mirrors route.ts's own PREBOOK_TTL_MINUTES, which the route does not
// export. Duplicated here deliberately — a silent drift between this value
// and the route's real one is exactly the kind of thing that would make
// this test wrong about which side of the TTL boundary it is testing.
const PREBOOK_TTL_MINUTES = 30;

beforeEach(() => {
  resetFakeSupplier();
});

describe("sweeping a prebooked hold whose payment is already in flight (NOS-5)", () => {
  it.fails("still lets the guest's return trip finalize the booking they were already charged for", async () => {
    const cronSecret = fakeSharedSecret("cron");
    process.env.CRON_SECRET = cronSecret;

    // Backdated using cutoffFor — the same pure rule the sweep route itself
    // applies (docs/conventions.md §6: inject the clock, don't wait on it) —
    // rather than sleeping 30 real minutes for the TTL to elapse.
    const longAgo = cutoffFor(PREBOOK_TTL_MINUTES + 1, new Date());
    const { booking } = await seedConfirmableBooking({ updatedAt: longAgo });

    // In the real flow the guest's card has already been charged via the
    // Payment SDK at this point — entirely client-side, before
    // confirmBooking is ever called. There is no column on `bookings` that
    // records that fact today; that absence is the gap NOS-5 is about. This
    // row is otherwise indistinguishable from a hold the guest simply
    // walked away from.
    const sweepResponse = await sweep(
      new Request("http://localhost/api/cron/sweep", {
        method: "POST",
        headers: { authorization: `Bearer ${cronSecret}` },
      }),
    );
    expect(sweepResponse.status).toBe(200);

    const [sweptRow] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    // Confirms the sweep actually reached this row — if this fails, the
    // test isn't exercising the TTL path at all and the assertion below
    // would be vacuous.
    expect(sweptRow.status).toBe("expired");

    // The guest's browser now returns to the returnUrl and confirmBooking
    // runs, exactly as it would for a real completed charge. A fix must let
    // this still succeed; today it throws "Booking is not ready to confirm",
    // and the guest is left charged with no confirmed booking and nothing
    // in the UI to explain why — the guest-harming direction. It is also
    // money-losing for us: a charged, unconfirmed booking is a support
    // ticket and likely a manual refund, not a sale.
    await expect(confirmBooking({ bookingId: booking.id })).resolves.toMatchObject({
      status: "confirmed",
    });
  });
});
