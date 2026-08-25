import { describe, it, expect } from "vitest";
import { makeRef, extractCancellation } from "./booking-format";

describe("makeRef", () => {
  it("has the NSTVL- prefix and a 6-char unambiguous-alphabet suffix", () => {
    for (let i = 0; i < 50; i++) {
      const ref = makeRef();
      expect(ref).toMatch(/^NSTVL-[23456789A-HJ-NP-Z]{6}$/);
    }
  });

  it("excludes ambiguous characters 0/O/1/I", () => {
    for (let i = 0; i < 200; i++) {
      const suffix = makeRef().slice("NSTVL-".length);
      expect(suffix).not.toMatch(/[01OI]/);
    }
  });
});

describe("extractCancellation", () => {
  function pb(cancellationPolicies: unknown) {
    return { roomTypes: [{ rates: [{ cancellationPolicies }] }] };
  }

  // Fixed reference point so "already past" checks don't depend on the real
  // wall clock (conventions.md section 6) — every fixture date below is
  // deliberately relative to this, not to whatever day the suite happens to
  // run on.
  const BEFORE = new Date("2026-08-01T00:00:00Z");

  it("returns null policy/refundableUntil when the shape is absent", () => {
    expect(extractCancellation({})).toEqual({ policy: null, refundableUntil: null });
    expect(extractCancellation(null)).toEqual({ policy: null, refundableUntil: null });
    expect(extractCancellation({ roomTypes: [] })).toEqual({
      policy: null,
      refundableUntil: null,
    });
  });

  it("ignores refundableTag: a future ladder sets refundableUntil even when tagged NRFN", () => {
    // LiteAPI's NRFN tag does not mean "no ladder" — see the note above
    // extractCancellation. A tag-driven short-circuit here previously forced
    // refundableUntil to null whenever the tag said NRFN, regardless of what
    // the ladder actually said.
    const policy = { refundableTag: "NRFN", cancelPolicyInfos: [{ cancelTime: "2026-09-01 00:00:00" }] };
    const result = extractCancellation(pb(policy), BEFORE);
    expect(result.policy).toEqual(policy);
    expect(result.refundableUntil?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("returns null when the (tagged or not) ladder's earliest rung has already passed", () => {
    // The realistic NRFN shape: not a missing ladder, an already-active one.
    const policy = { refundableTag: "NRFN", cancelPolicyInfos: [{ cancelTime: "2026-07-01 00:00:00" }] };
    const after = new Date("2026-08-15T00:00:00Z");
    expect(extractCancellation(pb(policy), after).refundableUntil).toBeNull();
  });

  it("computes refundableUntil as the EARLIEST cancelTime for a refundable (RFN) policy", () => {
    const policy = {
      refundableTag: "RFN",
      cancelPolicyInfos: [
        { cancelTime: "2026-09-05 12:00:00" },
        { cancelTime: "2026-09-01 00:30:00" }, // earliest
        { cancelTime: "2026-09-10 00:00:00" },
      ],
    };
    const result = extractCancellation(pb(policy), BEFORE);
    expect(result.refundableUntil?.toISOString()).toBe("2026-09-01T00:30:00.000Z");
  });

  it("treats the GMT cancelTime string as UTC, not local time", () => {
    const policy = { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2026-08-24 00:30:00" }] };
    const result = extractCancellation(pb(policy), BEFORE);
    // Regression: this exact bug (local-time misparse) shipped once — see project memory.
    expect(result.refundableUntil?.toISOString()).toBe("2026-08-24T00:30:00.000Z");
  });

  it("returns a null refundableUntil when RFN but cancelPolicyInfos is empty/missing", () => {
    expect(
      extractCancellation(pb({ refundableTag: "RFN", cancelPolicyInfos: [] }), BEFORE).refundableUntil,
    ).toBeNull();
    expect(
      extractCancellation(pb({ refundableTag: "RFN" }), BEFORE).refundableUntil,
    ).toBeNull();
  });

  it("ignores malformed cancelTime entries but still uses the valid ones", () => {
    const policy = {
      refundableTag: "RFN",
      cancelPolicyInfos: [{ cancelTime: "not-a-date" }, { cancelTime: "2026-09-01 00:00:00" }],
    };
    const result = extractCancellation(pb(policy), BEFORE);
    expect(result.refundableUntil?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});
