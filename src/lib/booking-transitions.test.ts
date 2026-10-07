import { describe, expect, it } from "vitest";

import {
  CLAIM_STALE_AFTER_MINUTES,
  confirmationPageIntent,
  PREBOOK_HOLD_MINUTES,
  RECOVER_AFTER_MINUTES,
  holdLapsed,
  isUnpaidRefusal,
  recoveryOutcome,
  statusAfterFailedBook,
  sweepDecision,
  type SweepCandidate,
  type TransitionStatus,
} from "./booking-transitions";

const NOW = new Date(Date.UTC(2026, 9, 6, 12, 0, 0));
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const row = (over: Partial<SweepCandidate> = {}): SweepCandidate => ({
  status: "prebooked",
  prebookedAt: minsAgo(1),
  updatedAt: minsAgo(1),
  ...over,
});

describe("the supplier's hold", () => {
  it("lapses at the documented 15 minutes, not before", () => {
    expect(holdLapsed(minsAgo(PREBOOK_HOLD_MINUTES - 1), NOW)).toBe(false);
    expect(holdLapsed(minsAgo(PREBOOK_HOLD_MINUTES), NOW)).toBe(true);
  });

  it("is measured from the prebook, which is why saving guest details cannot move it", () => {
    // THE NOS-46 BUG. The old cutoff read `updatedAt`, and saving the guest
    // form rewrites it - so a guest who filled in their name at minute 14
    // pushed our cutoff out while the supplier's hold died on schedule.
    const r = row({ prebookedAt: minsAgo(20), updatedAt: minsAgo(0) });
    expect(sweepDecision(r, NOW).action).toBe("expire");
  });

  it("treats a row with no recorded prebook moment as still held, not as lapsed", () => {
    // Rows created before this column existed must not all be released on the
    // first sweep after deploy.
    expect(holdLapsed(null, NOW)).toBe(false);
    expect(sweepDecision(row({ prebookedAt: null, updatedAt: minsAgo(99) }), NOW).action).toBe(
      "leave",
    );
  });
});

describe("a hold nobody is paying for", () => {
  it("is left alone while the hold is alive", () => {
    expect(sweepDecision(row({ prebookedAt: minsAgo(5) }), NOW)).toMatchObject({
      action: "leave",
    });
  });

  it("is released once the hold has lapsed", () => {
    expect(sweepDecision(row({ prebookedAt: minsAgo(16) }), NOW)).toMatchObject({
      action: "expire",
    });
  });
});

describe("a guest whose browser said it was charging the card", () => {
  const paying = (over: Partial<SweepCandidate> = {}) =>
    row({ status: "payment_pending", ...over });

  it("is never released on a timer, which is the whole of NOS-5", () => {
    // Both directions of the bug in one assertion: whatever the clock says, a
    // row whose guest may have been charged is not expired by the sweeper.
    for (const m of [0, 1, 5, 14, 16, 60, 60 * 24]) {
      const action = sweepDecision(paying({ prebookedAt: minsAgo(m), updatedAt: minsAgo(m) }), NOW);
      expect(action.action).not.toBe("expire");
    }
  });

  it("is given a moment to finish before we go looking", () => {
    expect(
      sweepDecision(paying({ updatedAt: minsAgo(RECOVER_AFTER_MINUTES - 0.5) }), NOW),
    ).toMatchObject({ action: "leave" });
  });

  it("is resolved by asking the supplier, once the browser has clearly not come back", () => {
    expect(
      sweepDecision(
        paying({ prebookedAt: minsAgo(5), updatedAt: minsAgo(RECOVER_AFTER_MINUTES) }),
        NOW,
      ),
    ).toMatchObject({ action: "recover" });
  });

  it("raises an alert, and still does not expire, once the hold is gone", () => {
    // Past the hold the supplier cannot tell us anything either, so a person
    // has to check whether the guest was charged.
    expect(
      sweepDecision(paying({ prebookedAt: minsAgo(20), updatedAt: minsAgo(20) }), NOW),
    ).toMatchObject({ action: "alert" });
  });
});

describe("a confirmation that was claimed and then went quiet", () => {
  const claimed = (over: Partial<SweepCandidate> = {}) => row({ status: "confirming", ...over });

  it("is believed to be in flight at first", () => {
    expect(
      sweepDecision(claimed({ updatedAt: minsAgo(CLAIM_STALE_AFTER_MINUTES - 0.5) }), NOW),
    ).toMatchObject({ action: "leave" });
  });

  it("has its claim released once stale, so the booking is not stuck forever", () => {
    expect(
      sweepDecision(
        claimed({ prebookedAt: minsAgo(5), updatedAt: minsAgo(CLAIM_STALE_AFTER_MINUTES) }),
        NOW,
      ),
    ).toMatchObject({ action: "reclaim" });
  });

  it("goes to a person, not to expiry, if the hold lapsed while it was stuck", () => {
    expect(
      sweepDecision(claimed({ prebookedAt: minsAgo(20), updatedAt: minsAgo(20) }), NOW),
    ).toMatchObject({ action: "alert" });
  });
});

describe("statuses the sweeper must not touch", () => {
  it("leaves every terminal and pre-supplier state alone", () => {
    const others: TransitionStatus[] = [
      "draft",
      "confirmed",
      "failed",
      "cancelled",
      "expired",
    ];
    for (const status of others) {
      expect(
        sweepDecision(row({ status, prebookedAt: minsAgo(999), updatedAt: minsAgo(999) }), NOW),
      ).toMatchObject({ action: "leave" });
    }
  });
});

describe("reading the supplier's answer about payment", () => {
  it("recognizes the documented unpaid refusal", () => {
    // Measured 2026-10-06: code 2014, "payment not completed".
    expect(isUnpaidRefusal(new Error('book failed: 2014 "payment not completed"'))).toBe(true);
    expect(isUnpaidRefusal(new Error("payment not completed"))).toBe(true);
  });

  it("does not read anything else as proof of non-payment", () => {
    // The one mistake that loses a guest their room: concluding "unpaid" from
    // a message that never said so. The first probe of this API made exactly
    // that class of error twice.
    for (const other of [
      new Error("429 rate limited"),
      new Error("no prebook availability"),
      new Error("socket hang up"),
      new Error("2001 no availability found"),
      new Error(""),
      undefined,
      null,
    ]) {
      expect(isUnpaidRefusal(other)).toBe(false);
    }
  });
});

describe("what a recovery attempt means", () => {
  it("confirms the booking when the guest had paid", () => {
    expect(recoveryOutcome({ ok: true }, false)).toEqual({ outcome: "confirmed" });
    expect(recoveryOutcome({ ok: true }, true)).toEqual({ outcome: "confirmed" });
  });

  it("releases the room only when the supplier says unpaid AND the hold is gone", () => {
    const unpaid = { ok: false as const, error: new Error("2014 payment not completed") };
    expect(recoveryOutcome(unpaid, true).outcome).toBe("expire");
    // Still inside the hold: they may be about to pay. Releasing here would be
    // NOS-5 again, in a new place.
    expect(recoveryOutcome(unpaid, false).outcome).toBe("leave");
  });

  it("alerts rather than guessing when the supplier did not answer", () => {
    for (const error of [new Error("429 rate limited"), new Error("timeout"), new Error("")]) {
      expect(recoveryOutcome({ ok: false, error }, true).outcome).toBe("alert");
      expect(recoveryOutcome({ ok: false, error }, false).outcome).toBe("alert");
    }
  });

  it("never expires a row on silence, at any point in the hold window", () => {
    // The guard that matters: the only route to "expire" is an explicit 2014.
    for (const holdGone of [true, false]) {
      for (const error of [new Error("429"), new Error("ETIMEDOUT"), new Error("nope")]) {
        expect(recoveryOutcome({ ok: false, error }, holdGone).outcome).not.toBe("expire");
      }
    }
  });
});

describe("where a booking goes when the supplier call fails", () => {
  const refusal = (code: number) => Object.assign(new Error("LiteAPI 400: nope"), { code });

  it("never sends a guest who may have paid to a terminal state", () => {
    // `failed` is terminal - nothing recovers it. Writing it on a row where a
    // payment was started means that guest is charged and no further attempt is
    // ever made. The first version of this fix did exactly that for a timeout,
    // and the test that should have caught it asserted only that the row was not
    // `expired`, which was true of `failed` too. Found by the NOS-5 code review.
    for (const error of [
      refusal(2014),
      refusal(4290),
      refusal(9999),
      new Error("ETIMEDOUT"),
      new Error(""),
      undefined,
    ]) {
      expect(statusAfterFailedBook(error, "payment_pending")).toBe("payment_pending");
    }
  });

  it("keeps an unpaid hold recoverable rather than failing it", () => {
    // Nobody has paid YET is not the same as this booking cannot happen.
    expect(statusAfterFailedBook(refusal(2014), "prebooked")).toBe("prebooked");
  });

  it("does not treat silence as a refusal", () => {
    // A timeout, a dropped socket, a gateway error page: no structured code, so
    // no answer. Recording that as `failed` is recording a refusal we never got.
    for (const error of [new Error("ETIMEDOUT"), new Error("socket hang up"), null, "boom"]) {
      expect(statusAfterFailedBook(error, "prebooked")).toBe("prebooked");
    }
    // A rate limit is silence wearing a code.
    expect(statusAfterFailedBook(refusal(4290), "prebooked")).toBe("prebooked");
  });

  it("ends the booking when the supplier definitively refuses one nobody paid for", () => {
    // No availability, a dead prebook, bad guest data: a real no, and the row
    // had no payment in flight, so there is nothing to strand.
    expect(statusAfterFailedBook(refusal(2001), "prebooked")).toBe("failed");
  });
});

describe("reading the real supplier error, not a test fiction", () => {
  it("detects the unpaid refusal from the code, where the supplier actually puts it", () => {
    // The captured body: code 2014, description "payment not completed",
    // message "booking incomplete". The client used to throw only the message,
    // so a text matcher saw "booking incomplete" and said "not an unpaid
    // refusal" - which made the whole release path dead code.
    const real = Object.assign(new Error("LiteAPI 400: booking incomplete"), {
      code: 2014,
      description: "payment not completed",
    });
    expect(isUnpaidRefusal(real)).toBe(true);
  });

  it("does not mistake another coded refusal for an unpaid one", () => {
    const other = Object.assign(new Error("LiteAPI 400: no availability found"), {
      code: 2001,
      description: "no prebook availability",
    });
    expect(isUnpaidRefusal(other)).toBe(false);
  });
});

describe("what the confirmation page does with each state", () => {
  it("finalizes from the state the happy path actually arrives in", () => {
    // THE CRITICAL BUG BOTH REVIEWS FOUND. The browser marks `payment_pending`
    // before charging, so that - not `prebooked` - is how a paying guest
    // arrives. A page that finalized only from `prebooked` showed every
    // successful payment a failure.
    expect(confirmationPageIntent("payment_pending")).toBe("finalize");
    // Still accepted: a browser that failed to send the heads-up charged anyway.
    expect(confirmationPageIntent("prebooked")).toBe("finalize");
  });

  it("waits rather than failing when another caller holds the claim", () => {
    expect(confirmationPageIntent("confirming")).toBe("wait");
  });

  it("shows the confirmation when it is done", () => {
    expect(confirmationPageIntent("confirmed")).toBe("done");
  });

  it("only calls a booking dead where no payment was ever started", () => {
    // The states that may say "this could not be completed" to a guest. If a
    // payment-bearing state ever appears here, a paying guest is being told
    // their booking failed - so this list is the assertion.
    for (const status of ["draft", "failed", "cancelled", "expired"] as const) {
      expect(confirmationPageIntent(status)).toBe("dead");
    }
  });

  it("has an answer for every status, so a new one cannot fall through silently", () => {
    const all: TransitionStatus[] = [
      "draft",
      "prebooked",
      "payment_pending",
      "confirming",
      "confirmed",
      "failed",
      "cancelled",
      "expired",
    ];
    for (const status of all) {
      expect(["finalize", "wait", "done", "dead"]).toContain(confirmationPageIntent(status));
    }
  });
});
