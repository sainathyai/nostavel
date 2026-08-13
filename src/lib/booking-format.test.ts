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

  it("returns null policy/refundableUntil when the shape is absent", () => {
    expect(extractCancellation({})).toEqual({ policy: null, refundableUntil: null });
    expect(extractCancellation(null)).toEqual({ policy: null, refundableUntil: null });
    expect(extractCancellation({ roomTypes: [] })).toEqual({
      policy: null,
      refundableUntil: null,
    });
  });

  it("returns a null refundableUntil for a non-refundable (NRFN) policy", () => {
    const policy = { refundableTag: "NRFN", cancelPolicyInfos: [{ cancelTime: "2026-09-01 00:00:00" }] };
    const result = extractCancellation(pb(policy));
    expect(result.policy).toEqual(policy);
    expect(result.refundableUntil).toBeNull();
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
    const result = extractCancellation(pb(policy));
    expect(result.refundableUntil?.toISOString()).toBe("2026-09-01T00:30:00.000Z");
  });

  it("treats the GMT cancelTime string as UTC, not local time", () => {
    const policy = { refundableTag: "RFN", cancelPolicyInfos: [{ cancelTime: "2026-08-24 00:30:00" }] };
    const result = extractCancellation(pb(policy));
    // Regression: this exact bug (local-time misparse) shipped once — see project memory.
    expect(result.refundableUntil?.toISOString()).toBe("2026-08-24T00:30:00.000Z");
  });

  it("returns a null refundableUntil when RFN but cancelPolicyInfos is empty/missing", () => {
    expect(
      extractCancellation(pb({ refundableTag: "RFN", cancelPolicyInfos: [] })).refundableUntil,
    ).toBeNull();
    expect(
      extractCancellation(pb({ refundableTag: "RFN" })).refundableUntil,
    ).toBeNull();
  });

  it("ignores malformed cancelTime entries but still uses the valid ones", () => {
    const policy = {
      refundableTag: "RFN",
      cancelPolicyInfos: [{ cancelTime: "not-a-date" }, { cancelTime: "2026-09-01 00:00:00" }],
    };
    const result = extractCancellation(pb(policy));
    expect(result.refundableUntil?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});
