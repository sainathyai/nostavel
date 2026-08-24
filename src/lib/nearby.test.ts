import { describe, expect, it } from "vitest";

import { groupNearby, kindLabel, metresBetween, type RawFeature } from "./nearby";

const HOTEL = { lat: 30.2672, lng: -97.7431 }; // downtown Austin

// ~111 m per 0.001 degree of latitude, so offsets here are readable as metres.
const at = (name: string, kind: string, metresNorth: number): RawFeature => ({
  name,
  kind,
  lat: HOTEL.lat + metresNorth / 111_320,
  lng: HOTEL.lng,
});

describe("metresBetween", () => {
  it("measures a known separation", () => {
    // 0.001 degrees of latitude is ~111 m anywhere on earth.
    expect(metresBetween(HOTEL.lat, HOTEL.lng, HOTEL.lat, HOTEL.lng)).toBe(0);
    expect(metresBetween(HOTEL.lat, HOTEL.lng, HOTEL.lat + 0.001, HOTEL.lng)).toBeCloseTo(111, 0);
  });
});

describe("groupNearby", () => {
  it("sorts each category by distance and labels the walk", () => {
    const groups = groupNearby(
      [at("Far Cafe", "cafe", 640), at("Near Bar", "bar", 80)],
      HOTEL.lat,
      HOTEL.lng,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("Food & drink");
    expect(groups[0].places.map((p) => p.name)).toEqual(["Near Bar", "Far Cafe"]);
    expect(groups[0].places[0].walkMins).toBe(1);
    expect(groups[0].places[1].walkMins).toBe(8);
  });

  it("drops unnamed features and kinds outside the whitelist", () => {
    // "Coupons" and "hvac" are real kinds observed in the live tiles.
    const groups = groupNearby(
      [
        { name: "", kind: "restaurant", lat: HOTEL.lat, lng: HOTEL.lng },
        at("Some Office", "hvac", 50),
        at("Discount Place", "Coupons", 50),
        at("A Hotel", "hotel", 50),
      ],
      HOTEL.lat,
      HOTEL.lng,
    );
    expect(groups).toEqual([]);
  });

  it("drops anything past the nearby radius", () => {
    expect(groupNearby([at("Distant Diner", "restaurant", 1400)], HOTEL.lat, HOTEL.lng)).toEqual([]);
  });

  it("keeps the nearest of a duplicated feature", () => {
    // The same POI arrives once per tile that touches it.
    const groups = groupNearby(
      [at("Rouses", "supermarket", 300), at("Rouses", "supermarket", 120)],
      HOTEL.lat,
      HOTEL.lng,
    );
    expect(groups[0].places).toHaveLength(1);
    expect(groups[0].places[0].metres).toBe(120);
  });

  it("caps a category so one dense block cannot crowd out the rest", () => {
    const many = Array.from({ length: 12 }, (_, i) => at(`Bar ${i}`, "bar", 50 + i));
    const groups = groupNearby([...many, at("Union Station", "station", 900)], HOTEL.lat, HOTEL.lng);
    expect(groups.find((g) => g.category === "Food & drink")!.places).toHaveLength(6);
    expect(groups.find((g) => g.category === "Getting around")!.places).toHaveLength(1);
  });

  it("returns categories in a fixed order, skipping empty ones", () => {
    const groups = groupNearby(
      [at("Union Station", "station", 200), at("Bomba", "restaurant", 100), at("CVS", "pharmacy", 150)],
      HOTEL.lat,
      HOTEL.lng,
    );
    expect(groups.map((g) => g.category)).toEqual(["Food & drink", "Getting around", "Everyday"]);
  });
});

describe("kindLabel", () => {
  it("humanises database-shaped tags", () => {
    expect(kindLabel("fast_food")).toBe("Fast food");
    expect(kindLabel("bus_stop")).toBe("Bus stop");
    expect(kindLabel("chemist")).toBe("Pharmacy");
    expect(kindLabel("restaurant")).toBe("Restaurant");
  });
});
