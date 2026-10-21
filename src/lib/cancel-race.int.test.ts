// Integration test: one cancellation per booking, enforced by the database
// (NOS-16, threat-model gap G5).
//
// WHAT THIS PROVES. `cancellations` had only a non-unique index on `bookingId`.
// Both cancellation paths check `row.status === "cancelled"` and then write, and
// the guest path calls the supplier in between, so a supplier webhook cancel can
// land inside that window. Both then insert, and the booking ends up with two
// cancellation rows carrying DIFFERENT refund amounts, because each caller read
// its own supplier response. `cancelBooking`'s idempotent branch afterwards
// reads one row with `.limit(1)` and returns its `refundAmountMinor` to the
// guest, so which of the two amounts the guest is shown is arbitrary.
//
// THE RACE IS DETERMINISTIC HERE, not hoped for. The fake supplier's cancel call
// is held open (`holdCancelCalls`), which parks the guest path inside exactly the
// window between its status check and its write; the webhook cancellation is then
// driven to completion; only then is the gate released. Two same-process calls
// racing on a fast loopback connection would prove nothing on a green run.
//
// It needs a real Postgres because the thing under test is a unique index
// refusing a second row, which only a database can do.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents, cancellations } from "@/db/schema";
import { cancelBooking, recordSupplierCancellation } from "@/lib/booking-service";
import { seedPrebookedBooking } from "@/test-support/db-fixtures";
import {
  resetFakeSupplier,
  configureCancelResult,
  holdCancelCalls,
  releaseCancelCalls,
  waitForCancelCalls,
} from "@/test-support/fake-liteapi";

vi.mock("@/lib/liteapi", async () => import("@/test-support/fake-liteapi"));

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

beforeEach(() => {
  resetFakeSupplier();
});

afterEach(() => {
  // If an assertion throws while the guest path is parked on the gate, don't
  // leave it closed for whatever runs next.
  releaseCancelCalls();
  resetFakeSupplier();
});

async function seedConfirmed() {
  const liteapiBookingId = uniqueId("sup-cancel-race");
  const booking = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });
  return { booking, liteapiBookingId };
}

async function stateOf(bookingId: string) {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  const cancelRows = await db
    .select()
    .from(cancellations)
    .where(eq(cancellations.bookingId, bookingId));
  const events = await db
    .select()
    .from(bookingEvents)
    .where(eq(bookingEvents.bookingId, bookingId));
  return { status: booking.status, cancellations: cancelRows, events };
}

describe("a guest cancel and a webhook cancel racing for the same booking (G5)", () => {
  it("writes one cancellation row, not two", async () => {
    // THE DEFECT, DIRECTLY. Two rows before this change, with 500 and 1200 in
    // them, and nothing deciding which one the guest is later shown.
    const { booking, liteapiBookingId } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: 500 });

    holdCancelCalls();
    const guest = cancelBooking(booking.id);
    // The guest path has now read `status === "confirmed"` and reached the
    // supplier. It has not written anything yet.
    await waitForCancelCalls(1);

    const webhook = await recordSupplierCancellation(liteapiBookingId, {
      refundAmountMinor: 1200,
      status: "CANCELLED",
      raw: { note: "fixture: supplier-reported cancellation" },
    });
    expect(webhook).toEqual({ bookingId: booking.id, alreadyRecorded: false });

    releaseCancelCalls();
    await expect(guest).resolves.toMatchObject({ status: "cancelled" });

    const after = await stateOf(booking.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancellations).toHaveLength(1);
    // The webhook wrote first, so its amount is the one on file.
    expect(after.cancellations[0].refundAmountMinor).toBe(1200);
  });

  it("records the amount it dropped, so the difference does not vanish", async () => {
    // The reason `onConflictDoNothing` alone is not enough. The loser read its
    // own supplier response; absorbing its write silently would leave the 500
    // nowhere - not in `cancellations`, which kept the winner's 1200, and not in
    // the audit trail. The weekly payout reconciliation would then be short by
    // the gap with nothing to explain it.
    const { booking, liteapiBookingId } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: 500 });

    holdCancelCalls();
    const guest = cancelBooking(booking.id);
    await waitForCancelCalls(1);
    await recordSupplierCancellation(liteapiBookingId, {
      refundAmountMinor: 1200,
      status: "CANCELLED",
      raw: { note: "fixture: supplier-reported cancellation" },
    });
    releaseCancelCalls();
    await guest;

    const after = await stateOf(booking.id);
    const conflicts = after.events.filter((e) => e.type === "booking.cancel.conflict");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].payload).toMatchObject({
      source: "user",
      droppedRefundAmountMinor: 500,
      droppedStatus: "CANCELLED",
    });
    // And the cancellation itself is still fully recorded by the winner.
    expect(after.events.map((e) => e.type)).toContain("booking.cancel.confirmed");
  });

  it("still answers the losing caller rather than failing their request", async () => {
    // Without `onConflictDoNothing` the loser's whole batch would roll back on
    // the unique index and the guest would see an error for a cancellation that
    // did happen. The booking is cancelled; the caller is told so.
    const { booking, liteapiBookingId } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: 500 });

    holdCancelCalls();
    const guest = cancelBooking(booking.id);
    await waitForCancelCalls(1);
    await recordSupplierCancellation(liteapiBookingId, {
      refundAmountMinor: 1200,
      status: "CANCELLED",
      raw: { note: "fixture: supplier-reported cancellation" },
    });
    releaseCancelCalls();

    const result = await guest;
    expect(result.status).toBe("cancelled");
    expect(result.bookingId).toBe(booking.id);
  });
});

describe("the constraint itself", () => {
  it("refuses a second cancellation row for the same booking", async () => {
    // AC 1, at the database level rather than through application logic: the
    // guarantee has to survive code that forgets to handle the conflict.
    const { booking } = await seedConfirmed();

    await db.insert(cancellations).values({ bookingId: booking.id, status: "CANCELLED" });
    await expect(
      db.insert(cancellations).values({ bookingId: booking.id, status: "CANCELLED" }),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(cancellations)
      .where(eq(cancellations.bookingId, booking.id));
    expect(rows).toHaveLength(1);
  });

  it("still allows one cancellation row per booking across different bookings", async () => {
    // The constraint is per booking, not global. A regression guard, because a
    // unique index on the wrong column would also pass the test above.
    const first = await seedConfirmed();
    const second = await seedConfirmed();

    await db.insert(cancellations).values({ bookingId: first.booking.id, status: "CANCELLED" });
    await db.insert(cancellations).values({ bookingId: second.booking.id, status: "CANCELLED" });

    for (const seeded of [first, second]) {
      const rows = await db
        .select()
        .from(cancellations)
        .where(eq(cancellations.bookingId, seeded.booking.id));
      expect(rows).toHaveLength(1);
    }
  });
});

describe("what must not change (regression guards)", () => {
  it("writes no conflict event on an ordinary single cancellation", async () => {
    // The event means "a write was dropped". If it appeared on every
    // cancellation it would be noise, and the reconciler reads these.
    const { booking } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: 500 });

    await cancelBooking(booking.id);

    const after = await stateOf(booking.id);
    expect(after.cancellations).toHaveLength(1);
    expect(after.events.map((e) => e.type)).not.toContain("booking.cancel.conflict");
  });

  it("leaves the already-cancelled early return untouched", async () => {
    // A redelivered webhook or a double-click never reaches the insert at all,
    // so it must not produce a conflict event either.
    const liteapiBookingId = uniqueId("sup-cancel-race-idem");
    const booking = await seedPrebookedBooking({ status: "cancelled", liteapiBookingId });

    const result = await recordSupplierCancellation(liteapiBookingId, {
      refundAmountMinor: 1200,
      status: "CANCELLED",
      raw: { note: "fixture: redelivered cancellation" },
    });
    expect(result).toEqual({ bookingId: booking.id, alreadyRecorded: true });

    const after = await stateOf(booking.id);
    expect(after.cancellations).toHaveLength(0);
    expect(after.events).toHaveLength(0);
  });
});
