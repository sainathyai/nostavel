// The webhook routing rule (NOS-8). Pure, so every case is reachable without a
// database, a network or a clock.
import { describe, it, expect } from "vitest";
import { webhookIntent, webhookEventType, missingIdWarning } from "./webhook-dispatch";

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

describe("a delivery with no event_id has to be noticed (NOS-14, G3)", () => {
  it("says the cancellation was NOT applied, not merely that an id was missing", () => {
    // THE SEVERE CASE. The branch stores the body and does not dispatch, so a
    // supplier cancellation lands in `webhook_events` while the booking stays
    // confirmed. An operator reading this line has to learn that something needs
    // doing, not that a field was absent.
    const line = missingIdWarning({ eventName: "booking.cancel", supplierStatus: "CANCELLED" });
    expect(line).toContain("NOT APPLIED");
    expect(line).toContain("booking.cancel");
    expect(line).toContain("cancellation");
    expect(line).toMatch(/by hand/i);
  });

  it("names a refund as a refund, because the remedy differs", () => {
    const line = missingIdWarning({ eventName: "booking.refund", supplierStatus: "CONFIRMED" });
    expect(line).toContain("NOT APPLIED");
    expect(line).toContain("refund");
  });

  it("follows the supplier's status, exactly as the dispatcher would have", () => {
    // Derived from `webhookIntent` rather than from the event name, so the
    // warning describes what WOULD have happened. A `booking.refund` carrying
    // CANCELLED_WITH_CHARGES is a cancellation, and the line must say so.
    const line = missingIdWarning({
      eventName: "booking.refund",
      supplierStatus: "CANCELLED_WITH_CHARGES",
    });
    expect(line).toContain("cancellation");
    expect(line).not.toMatch(/as a refund/);
  });

  it("stays quiet about remedies for an event nothing would have applied", () => {
    // `booking.book` and friends are corroboration; the stored row IS the
    // record. Telling an operator to go and apply one by hand would be a false
    // alarm, and a warning that cries wolf is read as noise when it matters.
    for (const name of ["booking.book", "booking.amendment", "booking.book_error"]) {
      const line = missingIdWarning({ eventName: name, supplierStatus: "CANCELLED" });
      expect(line, name).toContain("Nothing to apply");
      expect(line, name).not.toContain("NOT APPLIED");
    }
  });

  it("still names the delivery when the event name is missing too", () => {
    // A body with neither an id nor a name is the least diagnosable delivery
    // there is, so the line must not read as an empty template.
    for (const name of [null, undefined, "", "   "]) {
      const line = missingIdWarning({ eventName: name, supplierStatus: null });
      expect(line, String(name)).toContain("(no event name)");
      expect(line, String(name)).toContain("no event_id");
    }
  });

  it("carries no payload, because the row already has it", () => {
    // Guest personal data never goes into logs (.agents/rules/database.md), and
    // the raw body is the one thing on this path that can hold a name or an
    // email. The event name is enough to act on.
    const line = missingIdWarning({ eventName: "booking.cancel", supplierStatus: "CANCELLED" });
    expect(line).not.toMatch(/@/);
    expect(line.length).toBeLessThan(400);
  });
});
