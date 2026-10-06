// Integration test: the sweeper against a REAL Postgres
// (vitest.integration.config.ts). The route's concurrency argument rests on
// `UPDATE ... WHERE status = '<from>' ... RETURNING` being atomic, so the rows
// this file seeds and the route's own queries have to be the same database, not
// a mock, for any of it to mean anything.
//
// WHAT THIS FILE PROMISES THE GUEST — unchanged from before NOS-5 landed:
//
//   a guest whose card was charged ends up with the booking they paid for;
//   a room nobody paid for is released.
//
// HOW THE MECHANISM CHANGED (NOS-5, NOS-46). Before, the only signal was a
// `prebooked` row's `updatedAt`, which says nothing about whether a charge is in
// flight — so a guest mid-payment and a guest who closed the tab were the same
// row, and the sweeper released both. The earlier version of this file asserted
// that shape directly: it swept a backdated row, asserted `status === "expired"`,
// and then that `confirmBooking` could still finalize it. That assertion
// described the bug's own mechanics, so it could not survive the fix — under the
// fix the row is never expired in the first place.
//
// What replaced it:
//   - the guest's browser says "charging now" before any money moves, so the row
//     is `payment_pending` and the sweeper leaves it alone;
//   - if that browser never comes back, the sweeper ASKS THE SUPPLIER, because
//     `book()` refuses an unpaid transaction with code 2014 (measured
//     2026-10-06). The guest is recovered rather than guessed about;
//   - the hold is measured from `prebookedAt`, the moment it was taken, not from
//     the last write to the row.
//
// The `it.fails` marker is gone because the bug is gone. Every assertion below
// is a live one.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookingEvents, bookings } from "@/db/schema";
import { confirmBooking, markPaymentStarting } from "@/lib/booking-service";
import { PREBOOK_HOLD_MINUTES, RECOVER_AFTER_MINUTES } from "@/lib/booking-transitions";
import { POST as sweep } from "./route";
import { seedConfirmableBooking, fakeSharedSecret } from "@/test-support/db-fixtures";
import {
  configureBookError,
  resetFakeSupplier,
  supplierRefusal,
  unpaidRefusal,
} from "@/test-support/fake-liteapi";

// Every supplier call in this file is stubbed, including the ones the sweeper
// now makes itself (NOS-29 AC 6: no test reaches LiteAPI over the network).
vi.mock("@/lib/liteapi", async () => import("@/test-support/fake-liteapi"));

// The real constants, imported rather than copied. The earlier version kept its
// own `PREBOOK_TTL_MINUTES = 30` with a comment admitting the route did not
// export it — so a change in one place would leave this test asserting about a
// boundary that no longer existed, and passing anyway (NOS-46).
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function runSweep(): Promise<Record<string, number>> {
  const cronSecret = fakeSharedSecret("cron");
  process.env.CRON_SECRET = cronSecret;
  const response = await sweep(
    new Request("http://localhost/api/cron/sweep", {
      method: "POST",
      headers: { authorization: `Bearer ${cronSecret}` },
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function statusOf(id: string): Promise<string> {
  const [row] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return row.status;
}

async function eventTypes(id: string): Promise<string[]> {
  const rows = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, id));
  return rows.map((r) => r.type);
}

/** Put the row's last write far enough back that the sweeper stops waiting. */
async function wentQuiet(id: string, minutes: number): Promise<void> {
  await db.update(bookings).set({ updatedAt: minsAgo(minutes) }).where(eq(bookings.id, id));
}

beforeEach(() => {
  resetFakeSupplier();
});

describe("a guest who is paying when the sweeper runs (NOS-5)", () => {
  it("is left alone, and their own return trip still completes the booking", async () => {
    const { booking } = await seedConfirmableBooking({ prebookedAt: minsAgo(5) });
    // What the browser does immediately before the card is charged.
    await markPaymentStarting(booking.id);

    await runSweep();

    // THE BUG, DIRECTLY: this used to be "expired".
    expect(await statusOf(booking.id)).toBe("payment_pending");

    // And the promise this file has always made.
    await expect(confirmBooking({ bookingId: booking.id })).resolves.toMatchObject({
      status: "confirmed",
    });
  });

  it("is rescued by the sweeper when their browser never comes back at all", async () => {
    // The case nothing could handle before: the charge succeeded, the redirect
    // was lost, the guest is gone. Asking the supplier makes it recoverable.
    const { booking } = await seedConfirmableBooking({ prebookedAt: minsAgo(5) });
    await markPaymentStarting(booking.id);
    await wentQuiet(booking.id, RECOVER_AFTER_MINUTES + 1);

    const counts = await runSweep();

    expect(counts.recovered).toBe(1);
    expect(await statusOf(booking.id)).toBe("confirmed");
    expect(await eventTypes(booking.id)).toContain("payment.recovered");
  });

  it("is never released on silence from the supplier", async () => {
    // The mistake that would reintroduce NOS-5 somewhere new: reading "we could
    // not reach the supplier" as "the guest did not pay". A rate limit is the
    // realistic version, and the sweeper itself can provoke one.
    configureBookError(supplierRefusal(4290, "exceeded the allowed request limit", "too many requests"));
    const { booking } = await seedConfirmableBooking({ prebookedAt: minsAgo(5) });
    await markPaymentStarting(booking.id);
    await wentQuiet(booking.id, RECOVER_AFTER_MINUTES + 1);

    await runSweep();

    // EXACT, not `not.toBe("expired")`. The first version of this assertion was
    // the weaker one, and it passed while the row was being written `failed` -
    // terminal, outside the sweeper's candidate set, unrecoverable for a guest
    // who had paid. The code review spotted it by noticing that the test two
    // cases down asserts an exact status and this one did not. A test whose
    // assertion is weaker than its neighbour's is where a non-fix hides.
    expect(await statusOf(booking.id)).toBe("payment_pending");
    expect(await eventTypes(booking.id)).toContain("payment.unresolved");
  });

  it("is not released even when the supplier says unpaid, while the hold is still alive", async () => {
    // Provably unpaid — but they may be finishing a slow card step right now.
    // Releasing here would be the same bug with a better excuse.
    // The real refusal, built through the real error class - see unpaidRefusal().
    configureBookError(unpaidRefusal());
    const { booking } = await seedConfirmableBooking({ prebookedAt: minsAgo(5) });
    await markPaymentStarting(booking.id);
    await wentQuiet(booking.id, RECOVER_AFTER_MINUTES + 1);

    await runSweep();

    expect(await statusOf(booking.id)).toBe("payment_pending");
  });

  it("is reported for a person to look at once the hold lapsed mid-payment", async () => {
    // Past the hold the supplier cannot answer either. The row keeps its status
    // on purpose: marking it `expired` would close the only record saying a
    // human still has to check whether this guest was charged.
    const { booking } = await seedConfirmableBooking({
      prebookedAt: minsAgo(PREBOOK_HOLD_MINUTES + 5),
    });
    await markPaymentStarting(booking.id);
    await wentQuiet(booking.id, PREBOOK_HOLD_MINUTES + 5);

    const counts = await runSweep();

    expect(counts.alerts).toBe(1);
    expect(await statusOf(booking.id)).toBe("payment_pending");
    expect(await eventTypes(booking.id)).toContain("payment.unresolved");
  });
});

describe("a room nobody paid for (the complementary promise)", () => {
  it("is released once the supplier's hold has lapsed", async () => {
    // The sweeper still has to do its original job. A "fix" that simply stopped
    // expiring anything would pass every test above.
    const { booking } = await seedConfirmableBooking({
      prebookedAt: minsAgo(PREBOOK_HOLD_MINUTES + 1),
    });

    const counts = await runSweep();

    expect(counts.holdsExpired).toBe(1);
    expect(await statusOf(booking.id)).toBe("expired");
    expect(await eventTypes(booking.id)).toContain("hold.expired");
  });

  it("is left alone while the hold is still alive", async () => {
    const { booking } = await seedConfirmableBooking({ prebookedAt: minsAgo(5) });
    await runSweep();
    expect(await statusOf(booking.id)).toBe("prebooked");
  });

  it("is not kept alive by the guest editing the form, which is the NOS-46 bug", async () => {
    // The old cutoff read `updatedAt`, so a write at minute 14 pushed it out to
    // minute 44 while the supplier's hold died at 15. Here the hold is long gone
    // and the row was written a moment ago: the old code kept it, this releases
    // it.
    const { booking } = await seedConfirmableBooking({
      prebookedAt: minsAgo(PREBOOK_HOLD_MINUTES + 10),
    });
    await db.update(bookings).set({ updatedAt: new Date() }).where(eq(bookings.id, booking.id));

    await runSweep();

    expect(await statusOf(booking.id)).toBe("expired");
  });
});

describe("a confirmation that was claimed and then abandoned", () => {
  it("has its claim released so the booking is not stuck forever", async () => {
    // A process that claims a booking and dies would otherwise leave a row
    // nothing is allowed to finalize — including the guest's own browser.
    const { booking } = await seedConfirmableBooking({ prebookedAt: minsAgo(5) });
    await db
      .update(bookings)
      .set({ status: "confirming", updatedAt: minsAgo(10) })
      .where(eq(bookings.id, booking.id));

    await runSweep();

    // It may also be recovered on the same pass; both are correct for a guest
    // who has paid, so the assertion is "no longer stuck".
    expect(await statusOf(booking.id)).not.toBe("confirming");
    expect(await eventTypes(booking.id)).toContain("confirm.claim_released");
  });
});
