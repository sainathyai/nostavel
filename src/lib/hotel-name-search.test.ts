import { describe, it, expect } from "vitest";
import {
  HOTEL_SUGGESTION_LIMIT,
  normaliseHotelQuery,
  rankHotelMatches,
  shouldLookUpHotelNames,
  type HotelNameRow,
} from "./hotel-name-search";
import { DESTINATIONS } from "./destinations";

// The hotel the owner could not find, exactly as the supplier returned it on
// 2026-10-11 (analysis/2026-10-11/probe-search-entry.mts). Used as a fixture
// rather than invented, so a change in the supplier's shape shows up here.
const TARGET: HotelNameRow = {
  id: "lp1dafc",
  name: "Holiday Inn Express Waikiki by IHG",
  address: "2058 Kuhio Avenue",
  city: "Honolulu",
};

describe("shouldLookUpHotelNames", () => {
  it("asks the supplier when the query names no place we hold", () => {
    // The query that opened NOS-66.
    expect(shouldLookUpHotelNames({ query: "holiday inn", placeMatchCount: 0 })).toBe(true);
  });

  it("does not ask when a local tier already matched the name", () => {
    expect(shouldLookUpHotelNames({ query: "austin", placeMatchCount: 1 })).toBe(false);
  });

  it("does not ask for a query too short to mean one hotel", () => {
    expect(shouldLookUpHotelNames({ query: "hol", placeMatchCount: 0 })).toBe(false);
    expect(shouldLookUpHotelNames({ query: "   hol  ", placeMatchCount: 0 })).toBe(false);
  });

  it("counts a four-character brand as long enough", () => {
    expect(shouldLookUpHotelNames({ query: "nobu", placeMatchCount: 0 })).toBe(true);
  });

  it("never asks for an empty query", () => {
    expect(shouldLookUpHotelNames({ query: "", placeMatchCount: 0 })).toBe(false);
    expect(shouldLookUpHotelNames({ query: "    ", placeMatchCount: 0 })).toBe(false);
  });

  // A place match suppresses the lookup, so the thing that counts as a place
  // match decides what costs money. Fuzzy matches must not be counted by the
  // caller; this is the assertion that says so in one place.
  it("treats any non-zero place match as enough, however many there are", () => {
    expect(shouldLookUpHotelNames({ query: "holiday inn", placeMatchCount: 1 })).toBe(false);
    expect(shouldLookUpHotelNames({ query: "holiday inn", placeMatchCount: 99 })).toBe(false);
  });
});

describe("normaliseHotelQuery", () => {
  it("collapses case and whitespace so retyping the same name is one query", () => {
    expect(normaliseHotelQuery("  Holiday   Inn  ")).toBe("holiday inn");
    expect(normaliseHotelQuery("HOLIDAY INN")).toBe(normaliseHotelQuery("holiday inn"));
  });
});

describe("rankHotelMatches", () => {
  it("puts a prefix match above a substring match", () => {
    const rows: HotelNameRow[] = [
      { id: "b", name: "The Westin Something", address: "2 St", city: "Austin" },
      { id: "a", name: "Westin Austin Downtown", address: "1 St", city: "Austin" },
    ];
    expect(rankHotelMatches("westin", rows).map((r) => r.hotelId)).toEqual(["a", "b"]);
  });

  it("prefers the shorter name inside a tier, which is the one the person meant", () => {
    // Measured: "holiday inn" returns 20 hotels in no useful order, the longest
    // of which is a marketing sentence.
    const rows: HotelNameRow[] = [
      {
        id: "long",
        name: "Holiday Inn Express & Suites Orlando At SeaWorld by IHG - With Free Shuttle Service to SeaWorld Parks",
        address: "10771 International Drive",
        city: "Orlando",
      },
      TARGET,
    ];
    expect(rankHotelMatches("holiday inn", rows)[0]?.hotelId).toBe("lp1dafc");
  });

  it("finds the owner's hotel from a partial, lower-case query", () => {
    const out = rankHotelMatches("holiday inn express waik", [TARGET]);
    expect(out).toEqual([
      {
        kind: "hotel",
        hotelId: "lp1dafc",
        name: "Holiday Inn Express Waikiki by IHG",
        sub: "2058 Kuhio Avenue, Honolulu",
      },
    ]);
  });

  it("drops a row it could not link to", () => {
    const rows: HotelNameRow[] = [
      { id: "", name: "No Id Hotel", city: "Austin" },
      { id: null, name: "Null Id Hotel", city: "Austin" },
      { id: "x", name: "", city: "Austin" },
      { id: "y", name: "   ", city: "Austin" },
      TARGET,
    ];
    expect(rankHotelMatches("hotel", rows).map((r) => r.hotelId)).toEqual(["lp1dafc"]);
  });

  it("shows one hotel once, however many times the supplier sends it", () => {
    const out = rankHotelMatches("holiday", [TARGET, { ...TARGET }, { ...TARGET }]);
    expect(out).toHaveLength(1);
  });

  it("keeps a match it cannot explain, but ranks it below every match it can", () => {
    // The supplier's match is looser than ours; a row whose name does not
    // contain the query is still a row it chose to return.
    const rows: HotelNameRow[] = [
      { id: "opaque", name: "Aulani Resort", address: "92 Olani St", city: "Kapolei" },
      TARGET,
    ];
    expect(rankHotelMatches("holiday inn", rows).map((r) => r.hotelId)).toEqual([
      "lp1dafc",
      "opaque",
    ]);
  });

  it("never returns more rows than the dropdown can show", () => {
    const rows: HotelNameRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `h${i}`,
      name: `Holiday Inn Number ${i}`,
      address: `${i} Main St`,
      city: "Somewhere",
    }));
    expect(rankHotelMatches("holiday", rows)).toHaveLength(HOTEL_SUGGESTION_LIMIT);
  });

  it("leaves the subtitle empty rather than printing a stray comma", () => {
    const out = rankHotelMatches("ghost", [{ id: "g", name: "Ghost Hotel" }]);
    expect(out[0]?.sub).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The curated localities (NOS-66, ADR 0006). These guard the DATA, because the
// data is a claim: lat, lng and a radius asserting where a neighbourhood is.
// ---------------------------------------------------------------------------

/** Metres between two coordinates. Same formula as the probe that sourced them. */
function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180;
  const lb = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

describe("curated localities", () => {
  it("offers Waikiki as a destination, which is what the owner could not search for", () => {
    const hit = DESTINATIONS.filter((d) => d.label.toLowerCase().includes("waikiki"));
    expect(hit).toHaveLength(1);
    expect(hit[0]?.type).toBe("locality");
  });

  // The acceptance test for the whole ticket, and the one that would catch a
  // mistyped centre: the hotel's coordinates are the supplier's own, measured
  // 2026-10-11, and they have to land inside the perimeter we invented.
  it("puts the owner's hotel inside the Waikiki perimeter", () => {
    const waikiki = DESTINATIONS.find((d) => d.key === "waikiki");
    expect(waikiki).toBeDefined();
    const distance = metres(waikiki!.lat, waikiki!.lng, 21.2837, -157.831031);
    expect(distance).toBeLessThan(waikiki!.radius);
    // Not merely inside: well inside, so a small future tightening of the
    // radius does not silently drop it. Measured at 525 m.
    expect(distance).toBeLessThan(1000);
  });

  it("keeps South Beach on the right coast", () => {
    const sb = DESTINATIONS.find((d) => d.key === "southbeach");
    expect(sb?.region).toBe("FL");
    // South Beach, NY (Staten Island, 40.58/-74.08) is what the supplier's own
    // city list resolves the name to. Ours must not be anywhere near it.
    expect(metres(sb!.lat, sb!.lng, 40.5833, -74.0761)).toBeGreaterThan(1_000_000);
  });

  it("keeps every locality tighter than a city, which is the point of having one", () => {
    const localities = DESTINATIONS.filter((d) => d.type === "locality");
    expect(localities.length).toBeGreaterThan(0);
    for (const l of localities) {
      expect(l.radius).toBeLessThanOrEqual(3000);
      expect(l.radius).toBeGreaterThanOrEqual(1000); // the supplier's own floor
    }
  });

  it("gives every destination a unique key", () => {
    const keys = DESTINATIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
