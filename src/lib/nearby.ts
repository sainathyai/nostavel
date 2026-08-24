// What is around a hotel, read out of the basemap we are already rendering.
//
// WHY NOT A PLACES API. LiteAPI's /data/places is a geocoder, not a POI search:
// it requires a textQuery and ignores coordinates entirely ("restaurant" at
// Austin coordinates returned Restaurant Depot in North Charleston, SC). The
// obvious replacements — Google Places, Foursquare — are metered per request on
// a page we want to render freely.
//
// The basemap already answers the question. Protomaps' vector tiles carry a
// `pois` layer with a name and a `kind` per feature, and MapLibre has ALREADY
// downloaded and parsed the tiles around the hotel in order to draw the map. So
// this costs no request, no key, and no vendor: it is a read of data sitting in
// the map instance.
//
// Measured on the live 2026-08-21 planet build, one z15 tile per hotel
// (analysis/2026-08-21/poi_probe.mjs):
//
//   Austin downtown   422 named POIs within 1.2 km
//   New Orleans FQ    410
//   Asheville         117
//
// with 163 restaurants, 115 bars, 43 cafes, 21 museums and real transit stops
// across the three. Note the planet build's maxZoom is 15, so a z15 tile IS the
// deepest data that exists — zooming the map in reveals no POI we cannot see.
//
// WHAT THIS IS NOT. OSM has names, kinds and coordinates. It has no ratings, no
// opening hours, no photos, and no notion of whether a restaurant is any good.
// If we ever want those, that is the point at which a paid source earns its fee.

export type NearbyPlace = {
  name: string;
  kind: string;
  /** Metres from the hotel, straight line. */
  metres: number;
  /** Rounded walking minutes at 80 m/min, minimum 1. */
  walkMins: number;
};

export type NearbyGroup = {
  category: string;
  places: NearbyPlace[];
};

/**
 * A whitelist, deliberately, not a blocklist. The `kind` vocabulary is open —
 * the same three tiles produced "Coupons", "hvac", "occult" and
 * "Natural_Soap_and Skincare Products" as kinds — so anything not named here is
 * dropped rather than shown to a guest. Hotels are excluded on purpose: they
 * are competitors and no guest needs them.
 */
const CATEGORIES: { label: string; kinds: string[] }[] = [
  {
    label: "Food & drink",
    kinds: [
      "restaurant", "cafe", "bar", "pub", "fast_food", "brewery", "biergarten",
      "deli", "bakery", "ice_cream", "confectionery", "food_court", "nightclub",
    ],
  },
  {
    label: "Culture & sights",
    kinds: [
      "museum", "gallery", "artwork", "attraction", "theatre", "monument",
      "memorial", "arts_centre", "viewpoint", "events_venue", "place_of_worship",
      "zoo", "stadium",
    ],
  },
  {
    label: "Parks & outdoors",
    kinds: ["park", "garden", "dog_park", "trailhead", "marina", "beach", "peak", "forest"],
  },
  {
    label: "Getting around",
    kinds: [
      "station", "bus_station", "bus_stop", "tram_stop", "subway_entrance",
      "ferry_terminal", "aerodrome", "bicycle_rental",
    ],
  },
  {
    label: "Everyday",
    kinds: [
      "supermarket", "convenience", "pharmacy", "chemist", "bank", "atm",
      "post_office", "marketplace", "library", "laundry",
    ],
  },
];

const KIND_TO_CATEGORY = new Map<string, string>();
for (const c of CATEGORIES) for (const k of c.kinds) KIND_TO_CATEGORY.set(k, c.label);

/** Tidy display names for kinds whose OSM tag reads like a database column. */
const KIND_LABEL: Record<string, string> = {
  fast_food: "Fast food",
  ice_cream: "Ice cream",
  place_of_worship: "Place of worship",
  bus_stop: "Bus stop",
  bus_station: "Bus station",
  tram_stop: "Tram stop",
  subway_entrance: "Subway",
  ferry_terminal: "Ferry",
  bicycle_rental: "Bike share",
  arts_centre: "Arts centre",
  events_venue: "Venue",
  dog_park: "Dog park",
  food_court: "Food court",
  chemist: "Pharmacy",
  aerodrome: "Airport",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, " ");
}

/** Great-circle metres. Straight line, not a walking route — see WALK_NOTE. */
export function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLng = (bLng - aLng) * r;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Straight-line distance understates a real walk, so the minutes here are a
 * lower bound. We say "walk" rather than printing a precise duration for that
 * reason; a routed number would need Valhalla, which docs/planner-research.md
 * already scopes as a later, separate service.
 */
const WALK_METRES_PER_MIN = 80;

/** Beyond this a place is not "nearby" and stops helping a guest choose. */
export const NEARBY_RADIUS_M = 1000;

/** Per category, so one dense restaurant block cannot crowd out transit. */
const PER_CATEGORY = 6;

export type RawFeature = {
  name?: unknown;
  kind?: unknown;
  lat: number;
  lng: number;
};

/**
 * Group raw POI features into the sections the stay page renders.
 *
 * Deduplicated on name+kind: the same feature appears once per tile it touches,
 * and chains genuinely repeat (two CVS Pharmacy branches 27 m apart in the
 * Austin sample, one tagged `pharmacy` and one `chemist`), so the nearest wins.
 */
export function groupNearby(
  features: RawFeature[],
  hotelLat: number,
  hotelLng: number,
): NearbyGroup[] {
  const best = new Map<string, NearbyPlace>();

  for (const f of features) {
    const name = typeof f.name === "string" ? f.name.trim() : "";
    const kind = typeof f.kind === "string" ? f.kind : "";
    // An unnamed feature is a dot on a map, not something to tell a guest about.
    if (!name || !KIND_TO_CATEGORY.has(kind)) continue;

    const metres = metresBetween(hotelLat, hotelLng, f.lat, f.lng);
    if (metres > NEARBY_RADIUS_M) continue;

    const key = `${name.toLowerCase()}|${kind}`;
    const existing = best.get(key);
    if (existing && existing.metres <= metres) continue;
    best.set(key, {
      name,
      kind,
      metres: Math.round(metres),
      walkMins: Math.max(1, Math.round(metres / WALK_METRES_PER_MIN)),
    });
  }

  const groups: NearbyGroup[] = [];
  for (const c of CATEGORIES) {
    const places = [...best.values()]
      .filter((p) => KIND_TO_CATEGORY.get(p.kind) === c.label)
      .sort((a, b) => a.metres - b.metres)
      .slice(0, PER_CATEGORY);
    if (places.length) groups.push({ category: c.label, places });
  }
  return groups;
}
