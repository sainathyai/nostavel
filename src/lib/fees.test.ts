import { describe, it, expect } from "vitest";
import { classifyFee, summarizeFees } from "./fees";

// Descriptions and amounts below are verbatim from live LiteAPI responses
// captured in analysis/fees2-raw.csv.
describe("classifyFee", () => {
  it("names government levies as taxes", () => {
    for (const d of ["TAX", "taxes", "SALESTAX", "LODGING", "Tax"]) {
      expect(classifyFee(d, 100).isTax).toBe(true);
    }
  });

  it("NEVER calls hotel revenue a tax", () => {
    // The whole point of this module. A resort fee is not a levy.
    for (const d of ["RESORT", "destination_fee", "Destination charge", "Amenity Fee"]) {
      const f = classifyFee(d, 40);
      expect(f.isTax).toBe(false);
      expect(f.label).not.toMatch(/tax/i);
    }
  });

  it("does not invent a category for descriptions that name nothing", () => {
    for (const d of ["OTHERS", "", "   ", "Fee"]) {
      const f = classifyFee(d, 12);
      expect(f.isTax).toBe(false);
      expect(f.label).toBe("charge due at the property");
    }
  });

  it("distinguishes the two charges that collided in the old label map", () => {
    // Both rendered as bare "tax" before; only one of them is.
    expect(classifyFee("RESORT", 40).label).toBe("resort fee");
    expect(classifyFee("TAX", 97.93).label).toBe("tax");
  });
});

describe("summarizeFees", () => {
  it("ignores charges already inside the displayed price", () => {
    const s = summarizeFees([
      { included: true, description: "SALESTAX", amount: 43.27 },
      { included: false, description: "RESORT", amount: 40 },
    ]);
    expect(s.dueAtPropertyTotal).toBe(40);
    expect(s.dueAtProperty).toHaveLength(1);
  });

  it("does NOT multiply a per-night fee by nights", () => {
    // Verified live: the same rate returned $40.00 across 2 nights and
    // $140.00 across 7 — LiteAPI has already done the multiplication.
    // Re-applying it here was the bug that inflated guest totals.
    expect(summarizeFees([{ included: false, description: "RESORT", amount: 140 }])
      .dueAtPropertyTotal).toBe(140);
  });

  it("says 'taxes and fees' only when both are actually present", () => {
    const mixed = summarizeFees([
      { included: false, description: "TAX", amount: 97.93 },
      { included: false, description: "RESORT", amount: 40 },
    ]);
    expect(mixed.note).toBe("$138 taxes and fees collected by the hotel at check-in");

    const feesOnly = summarizeFees([
      { included: false, description: "RESORT", amount: 40 },
      { included: false, description: "Amenity Fee", amount: 20 },
    ]);
    expect(feesOnly.note).toBe("$60 fees collected by the hotel at check-in");
    expect(feesOnly.note).not.toMatch(/tax/i);
  });

  it("names the single charge precisely when there is only one", () => {
    expect(summarizeFees([{ included: false, description: "destination_fee", amount: 40 }]).note)
      .toBe("$40 destination fee collected by the hotel at check-in");
  });

  it("returns no note when nothing is collected on site", () => {
    expect(summarizeFees([{ included: true, description: "TAX", amount: 58 }]).note).toBeNull();
    expect(summarizeFees([]).note).toBeNull();
  });

  // The live case this exists for: Kimpton Arras files a $20/night Destination
  // Charge, and one supplier reports the 2-night $40 of it as "Taxes and Fees".
  describe("the hotel's own tax schema overrules an ambiguous supplier label", () => {
    const KIMPTON = [
      { name: "Destination Charge", included: true, type: "fixed", fixedAmount: 20, perNight: true, perAdult: false },
      { name: "Tax", included: false, type: "percentage", percentageRate: 13, perNight: false, perAdult: false },
    ];

    it("renames a vague line to the levy whose amount it matches", () => {
      const s = summarizeFees([{ included: false, description: "Taxes and Fees", amount: 40 }], {
        nights: 2,
        adults: 2,
        schema: KIMPTON,
      });
      expect(s.dueAtProperty[0].label).toBe("destination fee");
      expect(s.dueAtProperty[0].isTax).toBe(false);
      expect(s.note).toBe("$40 destination fee collected by the hotel at check-in");
      expect(s.note).not.toMatch(/tax/i);
    });

    it("leaves the amount alone — only the wording is corrected", () => {
      const s = summarizeFees([{ included: false, description: "Taxes and Fees", amount: 40 }], {
        nights: 2,
        schema: KIMPTON,
      });
      expect(s.dueAtPropertyTotal).toBe(40);
    });

    it("does not overrule a description that names a real category", () => {
      const s = summarizeFees([{ included: false, description: "TAX", amount: 40 }], {
        nights: 2,
        schema: KIMPTON,
      });
      expect(s.dueAtProperty[0].label).toBe("tax");
      expect(s.dueAtProperty[0].isTax).toBe(true);
    });

    it("stays neutral when the amount matches nothing filed", () => {
      const s = summarizeFees([{ included: false, description: "Taxes and Fees", amount: 37.5 }], {
        nights: 2,
        schema: KIMPTON,
      });
      expect(s.dueAtProperty[0].label).toBe("taxes and fees");
    });

    it("never matches a percentage levy — the base is not knowable here", () => {
      const s = summarizeFees([{ included: false, description: "Mandatory Charge", amount: 73.04 }], {
        nights: 2,
        schema: KIMPTON,
      });
      expect(s.dueAtProperty[0].label).not.toBe("tax");
    });

    it("refuses to choose when two filed levies share the amount", () => {
      const s = summarizeFees([{ included: false, description: "OTHERS", amount: 40 }], {
        nights: 2,
        schema: [
          ...KIMPTON,
          { name: "Resort Fee", included: false, type: "fixed", fixedAmount: 40, perNight: false },
        ],
      });
      expect(s.dueAtProperty[0].label).toBe("charge due at the property");
    });

    it("works with no schema at all", () => {
      const s = summarizeFees([{ included: false, description: "Taxes and Fees", amount: 40 }]);
      expect(s.dueAtProperty[0].label).toBe("taxes and fees");
    });
  });
});
