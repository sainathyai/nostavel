import { describe, expect, it } from "vitest";

import {
  CLAIM_STALE_AFTER_MINUTES,
  PREBOOK_HOLD_MINUTES,
  RECOVER_AFTER_MINUTES,
  holdLapsed,
  isUnpaidRefusal,
  recoveryOutcome,
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
