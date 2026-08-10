// All US cities LiteAPI recognises (harvested from /data/cities?countryCode=US),
// enriched with state + coordinates from GeoNames (most-populous match by name).
import raw from "@/data/us-cities.json";

export type USCity = { c: string; s: string; lat?: number; lng?: number };

export const US_CITIES = raw as USCity[];
export const US_CITY_SET = new Set(US_CITIES.map((x) => x.c));
