// The webhook routing rule (NOS-8). Pure, so every case is reachable without a
// database, a network or a clock.
import { describe, it, expect } from "vitest";
import { webhookIntent, webhookEventType } from "./webhook-dispatch";

describe("a refund is not a cancellation, which is the bug (G6)", () => {
  it("records a refund without cancelling when the stay is still going ahead", () => {
    // THE DEFECT, DIRECTLY. This routed to `recordSupplierCancellation` before,
    // which unconditionally set status cancelled - so a partial or goodwill
    // refund showed the guest a live stay marked cancelled, and the weekly
    // payout reconciliation was wrong for that booking.
    expect(webhookIntent({ eventName: "booking.refund", supplierStatus: "CONFIRMED" })).toBe(
      "refund",
    );
  });

  it("still cancels when the supplier says the booking is cancelled", () => {
    // The shape that makes the event name insufficient: the supplier sends
    // `booking.refund` with CANCELLED_WITH_CHARGES for a cancellation that kept
    // some money. There is an integration test asserting this exact payload, and
    // it expects a cancellation.
    expect(
      webhookIntent({ eventName: "booking.refund", supplierStatus: "CANCELLED_WITH_CHARGES" }),
    ).toBe("cancellation");
  });

  it("treats a refund with no supplier status as a refund, not a cancellation", () => {
    // The cautious direction: absent evidence that the booking ended, do not end
    // it. A wrongly-recorded refund is a reporting problem; a wrongly-cancelled
    // live booking is a guest arriving at a hotel with no room.
    for (const s of [null, undefined, "", "   "]) {
      expect(webhookIntent({ eventName: "booking.refund", supplierStatus: s })).toBe("refund");
    }
  });
});

describe("cancel events", () => {
  it("cancels on a cancel event, exactly as today", () => {
    expect(webhookIntent({ eventName: "booking.cancel", supplierStatus: "CANCELLED" })).toBe(
      "cancellation",
    );
  });

  it("cancels on a cancel event that carries no status", () => {
    // The event name is the fallback when the payload says nothing.
    for (const s of [null, undefined, "", "  "]) {
      expect(webhookIntent({ eventName: "booking.cancel", supplierStatus: s })).toBe("cancellation");
    }
  });

  it("follows the supplier over the event name when the two disagree", () => {
    // A `booking.cancel` whose payload says the booking is CONFIRMED is
    // contradictory. The status is the field describing the booking; the event
    // name describes the message. Trusting the message here would cancel a live
    // stay on the strength of a label.
    expect(webhookIntent({ eventName: "booking.cancel", supplierStatus: "CONFIRMED" })).toBe(
      "refund",
    );
  });
});

describe("reading someone else's free-text status", () => {
  it("ignores case and surrounding space", () => {
    for (const s of ["cancelled", " CANCELLED ", "Cancelled_With_Charges", "cancelled_by_guest"]) {
      expect(webhookIntent({ eventName: "booking.refund", supplierStatus: s })).toBe(
        "cancellation",
      );
    }
  });

  it("accepts the American spelling, because this field is not ours", () => {
    expect(webhookIntent({ eventName: "booking.refund", supplierStatus: "CANCELED" })).toBe(
      "cancellation",
    );
  });

  it("treats an unrecognised CANCELLED variant as cancelled rather than guessing", () => {
    // The supplier has already shown it appends qualifiers. Reading an unknown
    // one as "not cancelled" would leave our ledger claiming a stay the supplier
    // has ended, which is the worse direction.
    expect(
      webhookIntent({ eventName: "booking.refund", supplierStatus: "CANCELLED_SOMETHING_NEW" }),
    ).toBe("cancellation");
  });

  it("does not match a status that merely contains the word", () => {
    // A prefix test, not a substring one: "NOT_CANCELLED" must not read as
    // cancelled.
    expect(webhookIntent({ eventName: "booking.refund", supplierStatus: "NOT_CANCELLED" })).toBe(
      "refund",
    );
    expect(
      webhookIntent({ eventName: "booking.refund", supplierStatus: "UNCANCELLED" }),
    ).toBe("refund");
  });
});

describe("everything else is ignored", () => {
  it("ignores the events whose stored webhook_events row is the whole record", () => {
    for (const name of [
      "booking.book",
      "booking.amendment",
      "booking.hotelConfirmationNumber",
      "booking.book_error",
      "",
      null,
      undefined,
    ]) {
      expect(webhookIntent({ eventName: name, supplierStatus: "CANCELLED" })).toBe("ignore");
    }
  });

  it("does not let a cancelled status turn an unrelated event into a cancellation", () => {
    // The status only qualifies an event we already act on. Otherwise a
    // `booking.book` carrying a stale CANCELLED status would cancel a booking we
    // had just made.
    expect(webhookIntent({ eventName: "booking.book", supplierStatus: "CANCELLED" })).toBe("ignore");
  });

  it("does not match an event name by prefix or with stray spacing", () => {
    expect(webhookIntent({ eventName: "booking.cancellation", supplierStatus: null })).toBe(
      "ignore",
    );
    expect(webhookIntent({ eventName: "  booking.cancel  ", supplierStatus: null })).toBe(
      "cancellation",
    );
  });
});

describe("the audit label is derived, not hardcoded", () => {
  it("labels a refund as a refund", () => {
    // The old code wrote `webhook.booking.cancel` whichever event triggered it,
    // so a refund was mislabelled in the audit trail too. The trail is what the
    // reconciler and a human both read.
    expect(webhookEventType("refund")).toBe("webhook.booking.refund");
  });

  it("labels a cancellation exactly as before, so existing readers are unaffected", () => {
    expect(webhookEventType("cancellation")).toBe("webhook.booking.cancel");
  });
});
