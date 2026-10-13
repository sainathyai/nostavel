import { describe, it, expect } from "vitest";
import { exactPlaceMatchCount, rankedMatch, intlMatch } from "./place-search";

// THE REGRESSION GUARD FOR NOS-66's WORST DEFECT.
//
// The first version counted place matches by SUBSTRING, and used that count to
// decide whether a keystroke could reach the hotel supplier. The architecture
// review measured what that did against the real dataset, and the measurement is
// the test: a town called Chilton, a suburb called Hyattsville and a HELIPORT
// called "Sheraton Lakeside Inn Heliport" each made a major hotel brand
// unreachable by name.
//
// These assertions run against the committed dataset (src/data/us-cities.json,
// harvested from LiteAPI's own /data/cities), so they fail if either the rule or
// the data changes underneath the rule.
describe("exactPlaceMatchCount: the number that decides whether typing spends money", () => {
  it("does not treat a brand as a place merely because a town's name contains it", () => {
    // Every one of these was suppressed by the substring version. Measured
    // 2026-10-12: hilton -> Chilton WI, Hilton NY, Hilton Head Island SC;
    // hyatt -> Hyattsville MD; ritz -> Ritzville WA; sheraton -> a heliport.
    expect(exactPlaceMatchCount("hyatt")).toBe(0);
    expect(exactPlaceMatchCount("ritz")).toBe(0);
    expect(exactPlaceMatchCount("sheraton")).toBe(0);
    expect(exactPlaceMatchCount("westin")).toBe(0);
    expect(exactPlaceMatchCount("marriott")).toBe(0);
    expect(exactPlaceMatchCount("holiday inn")).toBe(0);
  });

  it("does treat a name that IS a place as a place", () => {
    // These are real places, so a guest typing them meant the place. The hotel
    // tier is still reachable for them, by pressing a row rather than by typing.
    expect(exactPlaceMatchCount("austin")).toBeGreaterThan(0);
    expect(exactPlaceMatchCount("honolulu")).toBeGreaterThan(0);
    expect(exactPlaceMatchCount("hilton")).toBeGreaterThan(0); // Hilton, NY
    expect(exactPlaceMatchCount("waldorf")).toBeGreaterThan(0); // Waldorf, MD
  });

  it("counts a curated locality by either the name or the labelled form", () => {
    expect(exactPlaceMatchCount("waikiki")).toBeGreaterThan(0);
    expect(exactPlaceMatchCount("waikiki, hi")).toBeGreaterThan(0);
  });

  it("ignores case and surrounding space, because a guest's typing has both", () => {
    expect(exactPlaceMatchCount("  AUSTIN ")).toBe(exactPlaceMatchCount("austin"));
  });

  it("is zero for an empty query rather than counting everything", () => {
    expect(exactPlaceMatchCount("")).toBe(0);
    expect(exactPlaceMatchCount("   ")).toBe(0);
  });
});

describe("the matchers, moved out of the route unchanged", () => {
  it("ranks an exact city above a longer one that merely starts the same way", () => {
    const names = rankedMatch("austin").map((x) => x.c);
    expect(names[0]).toBe("Austin");
    expect(names).toContain("Austintown");
    expect(names.indexOf("Austin")).toBeLessThan(names.indexOf("Austintown"));
  });

  it("ranks international matches by population, which is the signal that tier has", () => {
    const hits = intlMatch("paris");
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < Math.min(hits.length, 5); i++) {
      // within the prefix tier, population descends
      if (hits[i - 1]!.c.toLowerCase().startsWith("paris") && hits[i]!.c.toLowerCase().startsWith("paris")) {
        expect(hits[i - 1]!.pop).toBeGreaterThanOrEqual(hits[i]!.pop);
      }
    }
  });
});
