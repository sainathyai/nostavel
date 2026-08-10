// International cities: harvested live from LiteAPI's /data/cities per country
// (ground truth for "is this actually searchable"), joined against GeoNames
// cities5000 (population >= 5000, worldwide) for region name + coordinates.
// Priority tier (2026-08-10): Europe + major hubs. US stays in us-cities.ts,
// its own separately-harvested dataset — unrelated format, unrelated history.
import raw from "@/data/intl-cities.json";

export type IntlCity = { c: string; r: string; cc: string; lat: number; lng: number; pop: number };
export const INTL_CITIES = raw as IntlCity[];

export const COUNTRY_NAMES: Record<string, string> = {
  FR: "France", GB: "United Kingdom", IT: "Italy", ES: "Spain", DE: "Germany",
  PT: "Portugal", NL: "Netherlands", CH: "Switzerland", GR: "Greece", AT: "Austria",
  IE: "Ireland", JP: "Japan", AE: "United Arab Emirates", MX: "Mexico", TH: "Thailand",
  CA: "Canada", AU: "Australia", SG: "Singapore", KR: "South Korea", TR: "Turkey",
  ID: "Indonesia",
};

// Namespaced so an international city can never collide with a bare US city
// name (e.g. Paris, TX vs Paris, FR) in the `dest` URL param / resolveDest.
export function intlDest(city: IntlCity): string {
  return `intl:${city.cc}:${city.c}`;
}

export const INTL_CITY_BY_DEST = new Map(INTL_CITIES.map((c) => [intlDest(c), c]));
