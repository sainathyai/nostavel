// Integration test: a refund is not a cancellation (NOS-8, threat-model gap G6).
//
// WHAT THIS PROVES, against a real Postgres rather than a mock: a `booking.refund`
// webhook for a stay that is still going ahead records the money and leaves the
// booking alone. Before this change the dispatcher sent both `booking.cancel` and
// `booking.refund` to `recordSupplierCancellation`, which set `status:
// "cancelled"` unconditionally, so a partial or goodwill refund marked a live stay
// cancelled: the guest's trip page showed a cancelled booking for a hotel they
// were still going to, and reconciliation against the weekly payout was wrong.
//
// It needs a real database because the thing under test is which rows exist
// afterwards, in which table, and that is the whole claim.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents, cancellations, refunds } from "@/db/schema";
import { POST as receiveWebhook } from "./route";
import { seedPrebookedBooking, fakeSharedSecret } from "@/test-support/db-fixtures";
import { buildFakeWebhookPayload } from "@/test-support/fake-liteapi";

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

async function deliver(payload: Record<string, unknown>): Promise<Response> {
  const secret = fakeSharedSecret("liteapi-webhook");
  process.env.LITEAPI_WEBHOOK_SECRET = secret;
  return receiveWebhook(
    new Request("http://localhost/api/webhooks/liteapi", {
      method: "POST",
      headers: { authorization: secret, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

async function stateOf(bookingId: string) {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  const refundRows = await db.select().from(refunds).where(eq(refunds.bookingId, bookingId));
  const cancelRows = await db
    .select()
    .from(cancellations)
    .where(eq(cancellations.bookingId, bookingId));
  const events = await db.select().from(bookingEvents).where(eq(bookingEvents.bookingId, bookingId));
  return {
    status: booking.status,
    refunds: refundRows,
    cancellations: cancelRows,
    eventTypes: events.map((e) => e.type),
  };
}

describe("a refund on a stay that is still going ahead (G6)", () => {
  it("records the money and leaves the booking confirmed", async () => {
    // THE DEFECT, DIRECTLY. This used to end with status "cancelled" and a
    // `cancellations` row.
    const liteapiBookingId = uniqueId("sup-refund-live");
    const seeded = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    const response = await deliver(
      buildFakeWebhookPayload({
        eventId: uniqueId("evt-refund-live"),
        eventName: "booking.refund",
        bookingId: liteapiBookingId,
        status: "CONFIRMED",
        refundAmount: 42.5,
        refundId: "sup-ref-1",
      }),
    );
    expect(response.status).toBe(200);

    const after = await stateOf(seeded.id);
    expect(after.status).toBe("confirmed");
    expect(after.cancellations).toHaveLength(0);
    expect(after.refunds).toHaveLength(1);
    // Minor units, from major units in the payload (§3).
    expect(after.refunds[0].amountMinor).toBe(4250);
    expect(after.refunds[0].supplierRefId).toBe("sup-ref-1");
    expect(after.refunds[0].supplierStatus).toBe("CONFIRMED");
    // And labelled as a refund, not mislabelled as a cancel.
    expect(after.eventTypes).toContain("webhook.booking.refund");
    expect(after.eventTypes).not.toContain("webhook.booking.cancel");
  });

  it("records two partial refunds on one stay, which one row per booking could not", async () => {
    // Part of why refunds are their own table: a stay can be refunded more than
    // once, and `cancellations` is one row per booking once NOS-16 lands.
    const liteapiBookingId = uniqueId("sup-refund-twice");
    const seeded = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    for (const [id, amount] of [
      ["sup-ref-a", 10],
      ["sup-ref-b", 15.25],
    ] as const) {
      const r = await deliver(
        buildFakeWebhookPayload({
          eventId: uniqueId("evt-refund-multi"),
          eventName: "booking.refund",
          bookingId: liteapiBookingId,
          status: "CONFIRMED",
          refundAmount: amount,
          refundId: id,
        }),
      );
      expect(r.status).toBe(200);
    }

    const after = await stateOf(seeded.id);
    expect(after.status).toBe("confirmed");
    expect(after.refunds).toHaveLength(2);
    expect(after.refunds.map((r) => r.amountMinor).sort((a, b) => a - b)).toEqual([1000, 1525]);
  });

  it("writes no money row when the supplier reports no amount", async () => {
    // A zero-value refund row would put a money fact in the ledger that the
    // supplier never asserted. The event is still recorded, because something
    // did happen.
    const liteapiBookingId = uniqueId("sup-refund-noamount");
    const seeded = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    await deliver(
      buildFakeWebhookPayload({
        eventId: uniqueId("evt-refund-noamount"),
        eventName: "booking.refund",
        bookingId: liteapiBookingId,
        status: "CONFIRMED",
      }),
    );

    const after = await stateOf(seeded.id);
    expect(after.status).toBe("confirmed");
    expect(after.refunds).toHaveLength(0);
    expect(after.eventTypes).toContain("webhook.booking.refund");
  });

  it("does not double count a refund on a booking already cancelled", async () => {
    // A cancelled booking's refund belongs to its cancellation, which the
    // cancellation path already recorded. A second row here would count the same
    // money twice at reconciliation.
    const liteapiBookingId = uniqueId("sup-refund-cancelled");
    const seeded = await seedPrebookedBooking({ status: "cancelled", liteapiBookingId });

    await deliver(
      buildFakeWebhookPayload({
        eventId: uniqueId("evt-refund-cancelled"),
        eventName: "booking.refund",
        bookingId: liteapiBookingId,
        status: "CONFIRMED",
        refundAmount: 20,
      }),
    );

    const after = await stateOf(seeded.id);
    expect(after.status).toBe("cancelled");
    expect(after.refunds).toHaveLength(0);
  });
});

describe("what must not change (regression guards)", () => {
  it("still cancels on a refund event whose supplier status says cancelled", async () => {
    // The shape that makes the event name insufficient, and the reason the
    // existing redelivery test in this directory keeps passing unchanged.
    const liteapiBookingId = uniqueId("sup-refund-withcharges");
    const seeded = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    await deliver(
      buildFakeWebhookPayload({
        eventId: uniqueId("evt-refund-withcharges"),
        eventName: "booking.refund",
        bookingId: liteapiBookingId,
        status: "CANCELLED_WITH_CHARGES",
        refundAmount: 30,
      }),
    );

    const after = await stateOf(seeded.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancellations).toHaveLength(1);
    expect(after.refunds).toHaveLength(0);
    expect(after.eventTypes).toContain("webhook.booking.cancel");
  });

  it("still cancels on a plain cancel event", async () => {
    const liteapiBookingId = uniqueId("sup-cancel-plain");
    const seeded = await seedPrebookedBooking({ status: "confirmed", liteapiBookingId });

    await deliver(
      buildFakeWebhookPayload({
        eventId: uniqueId("evt-cancel-plain"),
        eventName: "booking.cancel",
        bookingId: liteapiBookingId,
        status: "CANCELLED",
      }),
    );

    const after = await stateOf(seeded.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancellations).toHaveLength(1);
    expect(after.refunds).toHaveLength(0);
  });
});
