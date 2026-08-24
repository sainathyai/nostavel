import { describe, expect, it } from "vitest";

import { buildCancelPolicy, describeTiers, zoneFor } from "./cancellation";

// Verbatim from a live margin-0 response (analysis/2026-08-21/cancel_tiers.py).
// Two rungs: half the stay from Oct 17, all of it from Oct 19. `timezone` was
// "GMT" on all 255 tier entries measured, which is the whole reason this file
// converts rather than trusting the wall clock.
const TWO_TIER = {
  refundableTag: "RFN",
  cancelPolicyInfos: [
    { cancelTime: "2026-10-17 01:59:00", amount: 286.85, currency: "USD", type: "amount", timezone: "GMT" },
    { cancelTime: "2026-10-19 18:00:00", amount: 573.7, currency: "USD", type: "amount", timezone: "GMT" },
  ],
};

const NON_REFUNDABLE = { refundableTag: "NRFN", cancelPolicyInfos: [] };

const AUSTIN = { lat: 30.2672, lng: -97.7431 }; // America/Chicago, UTC-5 in Oct
const BEFORE = new Date("2026-09-01T00:00:00Z");

describe("zoneFor", () => {
  it("derives the property zone from coordinates", () => {
    expect(zoneFor(AUSTIN.lat, AUSTIN.lng)).toBe("America/Chicago");
    expect(zoneFor(48.8566, 2.3522)).toBe("Europe/Paris");
  });

  it("is null without coordinates, so callers fall back to UTC", () => {
    expect(zoneFor(null, null)).toBeNull();
    expect(zoneFor(30.2672, undefined)).toBeNull();
  });
});

describe("buildCancelPolicy", () => {
  it("renders the deadline in PROPERTY-local time, not GMT", () => {
    const zone = zoneFor(AUSTIN.lat, AUSTIN.lng);
    const p = buildCancelPolicy(TWO_TIER, 573.7, zone, BEFORE);

    // 2026-10-17 01:59 GMT is 2026-10-16 20:59 CDT. This is the bug: formatted
    // as UTC the guest reads "Oct 17" and believes they have a day they do not.
    expect(p.freeUntilShort).toBe("Oct 16");
    expect(p.freeUntilLong).toContain("8:59 PM");
    expect(p.freeUntilLong).toContain("CDT");
  });

  it("still formats without a zone, in UTC", () => {
    const p = buildCancelPolicy(TWO_TIER, 573.7, null, BEFORE);
    expect(p.freeUntilShort).toBe("Oct 17");
    expect(p.freeUntilLong).toContain("UTC");
  });

  it("keeps every rung, not just the first", () => {
    const p = buildCancelPolicy(TWO_TIER, 573.7, zoneFor(AUSTIN.lat, AUSTIN.lng), BEFORE);
    expect(p.refundable).toBe(true);
    expect(p.tiers).toHaveLength(2);
    expect(p.tiers[0].share).toBeCloseTo(0.5, 2);
    expect(p.tiers[1].share).toBeCloseTo(1, 2);
  });

  it("treats NRFN as never refundable", () => {
    const p = buildCancelPolicy(NON_REFUNDABLE, 400, null, BEFORE);
    expect(p.refundable).toBe(false);
    expect(p.freeUntilShort).toBeNull();
    expect(p.tiers).toEqual([]);
  });

  it("does not call a rate refundable once its free window has closed", () => {
    // Booked inside the cancellation window: the tag still says RFN, but there
    // is no free cancellation left to advertise.
    const after = new Date("2026-10-18T00:00:00Z");
    const p = buildCancelPolicy(TWO_TIER, 573.7, null, after);
    expect(p.refundable).toBe(false);
    expect(p.freeUntilShort).toBeNull();
    // The rungs survive — the guest still needs to know what cancelling costs.
    expect(p.tiers).toHaveLength(2);
  });

  it("orders rungs by time even if the supplier does not", () => {
    const scrambled = {
      refundableTag: "RFN",
      cancelPolicyInfos: [TWO_TIER.cancelPolicyInfos[1], TWO_TIER.cancelPolicyInfos[0]],
    };
    const p = buildCancelPolicy(scrambled, 573.7, null, BEFORE);
    expect(p.tiers[0].amount).toBe(286.85);
  });
});

describe("describeTiers", () => {
  it("says nothing when one rung takes the whole stay", () => {
    // Identical in meaning to "free until X" — printing it twice is noise.
    const single = {
      refundableTag: "RFN",
      cancelPolicyInfos: [
        { cancelTime: "2026-10-16 10:00:00", amount: 628.23, type: "amount", timezone: "GMT" },
      ],
    };
    expect(describeTiers(buildCancelPolicy(single, 628.23, null, BEFORE))).toEqual([]);
  });

  it("spells out a partial penalty window", () => {
    const lines = describeTiers(buildCancelPolicy(TWO_TIER, 573.7, null, BEFORE));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/you lose \$287 \(50%\)/);
    expect(lines[0]).toMatch(/until/);
    expect(lines[1]).toMatch(/full \$574/);
  });
});
