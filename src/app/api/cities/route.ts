import { DESTINATIONS } from "@/lib/destinations";
import { US_CITIES } from "@/lib/us-cities";
import { INTL_CITIES, COUNTRY_NAMES, intlDest, type IntlCity } from "@/lib/intl-cities";
import { levenshtein, fuzzyThreshold } from "@/lib/fuzzy";
import { listHotelsByName } from "@/lib/liteapi";
import {
  normaliseHotelQuery,
  rankHotelMatches,
  shouldLookUpHotelNames,
  type HotelSuggestion,
  type PlaceSuggestion,
  type Suggestion,
} from "@/lib/hotel-name-search";

export type { PlaceSuggestion, HotelSuggestion, Suggestion };

/** Rows in the dropdown, hotels and places together. */
const RESULT_LIMIT = 8;

type USCityRow = (typeof US_CITIES)[number];

// Cities with matched coordinates went through GeoNames confidently (the
// stronger, better-known entries); ones without are noisier long-tail rows.
// Used only as a secondary ranking signal, not a filter.
function quality(x: USCityRow): number {
  return x.lat != null ? 0 : 1;
}

// Prefix/substring/exact tiers first (cheap, usually right), ranked by data
// quality then name length so "Austin" beats "Austinville" for query "austin".
function rankedMatch(q: string): USCityRow[] {
  const starts: USCityRow[] = [];
  const contains: USCityRow[] = [];
  for (const x of US_CITIES) {
    const lc = x.c.toLowerCase();
    if (lc === q || lc.startsWith(q)) starts.push(x);
    else if (lc.includes(q)) contains.push(x);
  }
  const byQuality = (a: USCityRow, b: USCityRow) => quality(a) - quality(b) || a.c.length - b.c.length;
  starts.sort(byQuality);
  contains.sort(byQuality);
  return [...starts, ...contains];
}

// Typo-tolerant fallback: only runs when exact/prefix/substring matching came
// up short, and only on the query's word length so a 3-letter query doesn't
// fuzzy-match half the dataset.
function fuzzyMatch(q: string): USCityRow[] {
  if (q.length < 3) return [];
  const threshold = fuzzyThreshold(q.length);
  const scored: { x: USCityRow; d: number }[] = [];
  for (const x of US_CITIES) {
    const lc = x.c.toLowerCase();
    const window = lc.slice(0, q.length + threshold); // bound the comparison, cities can be long
    const d = levenshtein(q, window, threshold);
    if (d <= threshold) scored.push({ x, d });
  }
  scored.sort((a, b) => a.d - b.d || quality(a.x) - quality(b.x) || a.x.c.length - b.x.c.length);
  return scored.map((s) => s.x);
}

// International cities have real population data (unlike the US set, which
// only has "has coordinates" as a quality proxy) — rank by population, then
// prefer prefix over substring matches.
function intlMatch(q: string): IntlCity[] {
  const starts: IntlCity[] = [];
  const contains: IntlCity[] = [];
  for (const x of INTL_CITIES) {
    const lc = x.c.toLowerCase();
    if (lc === q || lc.startsWith(q)) starts.push(x);
    else if (lc.includes(q)) contains.push(x);
  }
  const byPop = (a: IntlCity, b: IntlCity) => b.pop - a.pop;
  starts.sort(byPop);
  contains.sort(byPop);
  return [...starts, ...contains];
}

// ---------------------------------------------------------------------------
// The hotel tier (NOS-66, ADR 0006)
//
// This is the only supplier call in the app a person can trigger by TYPING, so
// everything below exists to keep that bounded: a gate on when it fires
// (hotel-name-search.ts), a cache so retyping a character is free, and a
// deadline so a slow supplier delays nobody's dropdown.
// ---------------------------------------------------------------------------

/**
 * Ten minutes. Long enough that backspacing and retyping the same hotel name
 * costs one call; short enough that a hotel appearing in inventory shows up the
 * same session. The cache lives in the serving process and dies with it, which
 * on a scale-to-zero service means it is empty more often than not. That is
 * acceptable: it is a spending brake, not a performance feature.
 */
const HOTEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** Bounded so a crawler typing random strings cannot grow it without limit. */
const HOTEL_CACHE_MAX_ENTRIES = 200;

/**
 * How long the dropdown will wait for the supplier. api() retries a 429 with
 * backoff, which is right for a search page and wrong for a typeahead - a
 * guest would be left with a spinner over a list they could already use. On
 * the deadline we return the local results and drop the lookup.
 */
const HOTEL_LOOKUP_DEADLINE_MS = 2500;

const hotelCache = new Map<string, { at: number; rows: HotelSuggestion[] }>();

async function lookUpHotels(query: string): Promise<HotelSuggestion[]> {
  const key = normaliseHotelQuery(query);
  const hit = hotelCache.get(key);
  if (hit && Date.now() - hit.at < HOTEL_CACHE_TTL_MS) return hit.rows;

  let rows: HotelSuggestion[];
  try {
    // US only: countryCode is required at this endpoint and the typeahead has
    // no location while someone is typing. Known limit, recorded in ADR 0006.
    const raw = await listHotelsByName(key, "US");
    rows = rankHotelMatches(key, raw);
  } catch {
    // A supplier that is unhappy must not break the typeahead. Not cached
    // either, so the next keystroke may succeed.
    return [];
  }

  if (hotelCache.size >= HOTEL_CACHE_MAX_ENTRIES) {
    const oldest = hotelCache.keys().next().value;
    if (oldest !== undefined) hotelCache.delete(oldest);
  }
  hotelCache.set(key, { at: Date.now(), rows });
  return rows;
}

function withDeadline(work: Promise<HotelSuggestion[]>): Promise<HotelSuggestion[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), HOTEL_LOOKUP_DEADLINE_MS);
    work
      .then((rows) => {
        clearTimeout(timer);
        resolve(rows);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve([]);
      });
  });
}

export async function GET(request: Request) {
  const typed = (new URL(request.url).searchParams.get("q") || "").trim();
  const q = typed.toLowerCase();

  if (!q) {
    const featured: PlaceSuggestion[] = DESTINATIONS.slice(0, 6).map((d) => ({
      kind: "place",
      dest: d.key,
      name: d.name,
      sub: `${d.region}, US`,
    }));
    return Response.json({ results: featured });
  }

  // curated hotspots first (they carry perimeter search + nicer labels). This
  // tier is also what fixes a name the supplier's city list gets WRONG rather
  // than misses - "South Beach" resolves to Staten Island in that list, and a
  // curated entry outranks it from here.
  const curatedAll = DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q));
  const curated: PlaceSuggestion[] = curatedAll.slice(0, 4).map((d) => ({
    kind: "place",
    dest: d.key,
    name: d.name,
    sub: `${d.region}, US`,
  }));
  const curatedNames = new Set(curated.map((c) => c.name.toLowerCase()));

  const exact = rankedMatch(q);
  const intlExact = intlMatch(q);

  // Counted BEFORE any typo tolerance runs, and used for one decision only:
  // whether this query is worth a supplier call. A fuzzy match is a guess, and
  // a guess must not suppress a real hotel - see shouldLookUpHotelNames.
  const placeMatchCount = curatedAll.length + exact.length + intlExact.length;

  const matches = [...exact];
  // Only reach for typo tolerance when the exact/prefix/substring pass is thin —
  // it's slower (scans the whole dataset) and a real match should win outright.
  if (matches.length < 5) {
    const seen = new Set(matches.map((x) => x.c));
    for (const x of fuzzyMatch(q)) {
      if (seen.has(x.c)) continue;
      seen.add(x.c);
      matches.push(x);
    }
  }

  const cities: PlaceSuggestion[] = matches
    .filter((x) => !curatedNames.has(x.c.toLowerCase()))
    .slice(0, 5)
    .map((x) => ({ kind: "place", dest: x.c, name: x.c, sub: x.s ? `${x.s}, US` : "US" }));

  const intl: PlaceSuggestion[] = intlExact.slice(0, 5).map((x) => ({
    kind: "place",
    dest: intlDest(x),
    name: x.c,
    sub: `${x.r ? x.r + ", " : ""}${COUNTRY_NAMES[x.cc] ?? x.cc}`,
  }));

  const places: Suggestion[] = [...curated, ...cities, ...intl];

  if (!shouldLookUpHotelNames({ query: typed, placeMatchCount })) {
    return Response.json({ results: places.slice(0, RESULT_LIMIT) });
  }

  // Nothing we hold locally names this place, so it is probably a hotel. The
  // hotels go FIRST for the same reason: the query named no place, so the place
  // rows below them are typo guesses.
  const hotels = await withDeadline(lookUpHotels(q));
  const results: Suggestion[] = [...hotels, ...places].slice(0, RESULT_LIMIT);
  return Response.json({ results });
}
