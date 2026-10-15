// Integration test: a cancellation is one fact, so it is one transaction
// (NOS-7, threat-model gap G1).
//
// WHAT THIS PROVES, and why it needs a real Postgres. Both cancellation paths
// used to write three rows as three unwrapped awaits: the booking's status, the
// `cancellations` row, and the audit event. A crash, a timeout or a statement
// the database refuses between them left the booking marked `cancelled` with no
// cancellation record. That is not a tidiness problem. `cancelBooking`'s
// idempotent branch reads the single `cancellations` row and returns
// `refundAmountMinor ?? 0` TO THE GUEST, so a missing row tells a guest who is
// owed money that they are owed nothing, and the ledger agrees with it.
//
// The only honest way to test a rollback is to make a real database refuse a
// real statement in the middle of the write. HOW THE FAILURE IS INDUCED, in
// each case, is a value Postgres itself rejects, not a mock that throws:
//
//   - `cancellations.refundAmountMinor` is an `integer` column, so a supplier
//     response above 2^31 - 1 fails on the SECOND statement of the batch, after
//     the status update has already been issued. That is precisely the window
//     the bug lived in.
//   - `booking_events.payload` is `jsonb`, and Postgres rejects a `\u0000`
//     escape in jsonb input. That fails the SECOND statement of the refund
//     path's pair, after the money row has been issued.
//
// A mocked connection cannot prove any of this: there is no transaction to roll
// back, so the test would only be asserting that the mock did what the test
// told it to.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents, cancellations, refunds } from "@/db/schema";
import {
  cancelBooking,
  recordSupplierCancellation,
  recordSupplierRefund,
} from "@/lib/booking-service";
import { seedPrebookedBooking } from "@/test-support/db-fixtures";
import { resetFakeSupplier, configureCancelResult } from "@/test-support/fake-liteapi";

// No test in this repo reaches LiteAPI over the network (NOS-29 AC 6).
vi.mock("@/lib/liteapi", async () => import("@/test-support/fake-liteapi"));

/** Above `integer`'s maximum (2^31 - 1), so Postgres refuses the insert. */
const OVER_INT4_MAX = 2_147_483_648;

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

beforeEach(() => {
  resetFakeSupplier();
});

afterEach(() => {
  resetFakeSupplier();
});

async function stateOf(bookingId: string) {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  const cancelRows = await db
    .select()
    .from(cancellations)
    .where(eq(cancellations.bookingId, bookingId));
  const refundRows = await db.select().from(refunds).where(eq(refunds.bookingId, bookingId));
  const events = await db
    .select()
    .from(bookingEvents)
    .where(eq(bookingEvents.bookingId, bookingId));
  return {
    status: booking.status,
    cancellations: cancelRows,
    refunds: refundRows,
    eventTypes: events.map((e) => e.type),
  };
}

async function seedConfirmed() {
  const liteapiBookingId = uniqueId("sup-cancel-atomic");
  const booking = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });
  return { booking, liteapiBookingId };
}

describe("the guest cancellation path writes three rows or none (G1)", () => {
  it("records status, cancellation and event together on success", async () => {
    // The happy path, asserted because `db.batch` takes its statements as an
    // array: a wrong order or a dropped element would still compile and still
    // pass a rollback test.
    const { booking } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: 4250, currency: "USD" });

    const result = await cancelBooking(booking.id);
    expect(result.refundAmountMinor).toBe(4250);

    const after = await stateOf(booking.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancellations).toHaveLength(1);
    expect(after.cancellations[0].refundAmountMinor).toBe(4250);
    expect(after.eventTypes).toContain("booking.cancel.confirmed");
  });

  it("leaves the booking confirmed when the cancellation row cannot be written", async () => {
    // THE DEFECT, DIRECTLY. Before NOS-7 the status update had already
    // committed by the time the `cancellations` insert failed, so this booking
    // ended as `cancelled` with no cancellation record - and the idempotent
    // branch then reported a refund of 0 to a guest whose refund the ledger had
    // no row for. The amount below is an induced fault, not a supplier figure.
    const { booking } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: OVER_INT4_MAX });

    await expect(cancelBooking(booking.id)).rejects.toThrow();

    const after = await stateOf(booking.id);
    expect(after.status).toBe("confirmed");
    expect(after.cancellations).toHaveLength(0);
    expect(after.eventTypes).not.toContain("booking.cancel.confirmed");
  });

  it("records that the write failed, because the supplier has already cancelled", async () => {
    // What atomicity does NOT fix, pinned so it cannot quietly regress. The
    // supplier call succeeded before the rolled-back write, so our ledger now
    // says `confirmed` for a stay that is gone. The reconciler finds that
    // divergence, but only if something recorded it happened.
    const { booking } = await seedConfirmed();
    configureCancelResult({ status: "CANCELLED", refundAmountMinor: OVER_INT4_MAX });

    await expect(cancelBooking(booking.id)).rejects.toThrow();

    const after = await stateOf(booking.id);
    expect(after.eventTypes).toContain("booking.cancel.requested");
    expect(after.eventTypes).toContain("booking.cancel.failed");
  });
});

describe("the supplier-webhook cancellation path writes three rows or none (G1)", () => {
  it("leaves the booking confirmed when the cancellation row cannot be written", async () => {
    // Same defect, the other path. This one is reached from the webhook route,
    // which stores the delivery first and leaves `webhook_events.processedAt`
    // null when dispatch throws - so the breadcrumb already exists here and the
    // only thing that must not survive is a half-applied cancellation.
    const { booking, liteapiBookingId } = await seedConfirmed();

    await expect(
      recordSupplierCancellation(liteapiBookingId, {
        refundAmountMinor: OVER_INT4_MAX,
        status: "CANCELLED",
        raw: { note: "fixture: supplier-reported cancellation" },
      }),
    ).rejects.toThrow();

    const after = await stateOf(booking.id);
    expect(after.status).toBe("confirmed");
    expect(after.cancellations).toHaveLength(0);
    expect(after.eventTypes).not.toContain("webhook.booking.cancel");
  });

  it("records status, cancellation and event together on success", async () => {
    const { booking, liteapiBookingId } = await seedConfirmed();

    const result = await recordSupplierCancellation(liteapiBookingId, {
      refundAmountMinor: 1000,
      status: "CANCELLED",
      raw: { note: "fixture: supplier-reported cancellation" },
    });
    expect(result).toEqual({ bookingId: booking.id, alreadyRecorded: false });

    const after = await stateOf(booking.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancellations).toHaveLength(1);
    expect(after.eventTypes).toContain("webhook.booking.cancel");
  });
});

describe("the refund path writes its money row and its event together (G1)", () => {
  it("records no refund when the audit event cannot be written", async () => {
    // The same defect in the function NOS-8 added, which NOS-7 was written
    // before and therefore does not name. A `refunds` row with no audit event
    // is money in the ledger that the audit trail does not account for, and the
    // audit trail is what the reconciler reads.
    //
    // The failure is induced on the SECOND statement here, not the first: a
    // `\u0000` escape is rejected by `jsonb` input, so the money row is the one
    // that has to roll back.
    const { booking, liteapiBookingId } = await seedConfirmed();

    await expect(
      recordSupplierRefund(liteapiBookingId, {
        refundAmountMinor: 4250,
        status: "CONFIRMED",
        supplierRefId: uniqueId("sup-ref"),
        raw: { note: "fixture: payload Postgres refuses\u0000" },
      }),
    ).rejects.toThrow();

    const after = await stateOf(booking.id);
    expect(after.status).toBe("confirmed");
    expect(after.refunds).toHaveLength(0);
    expect(after.eventTypes).not.toContain("webhook.booking.refund");
  });

  it("records the refund and its event together on success", async () => {
    const { booking, liteapiBookingId } = await seedConfirmed();

    const result = await recordSupplierRefund(liteapiBookingId, {
      refundAmountMinor: 4250,
      status: "CONFIRMED",
      supplierRefId: uniqueId("sup-ref"),
      raw: { note: "fixture: supplier-reported refund" },
    });
    expect(result).toEqual({ bookingId: booking.id, recorded: true });

    const after = await stateOf(booking.id);
    expect(after.status).toBe("confirmed");
    expect(after.refunds).toHaveLength(1);
    expect(after.eventTypes).toContain("webhook.booking.refund");
  });
});
