// The rule for the typeahead's hotel tier: when to ask the supplier about a
// hotel name at all, and how to order what comes back. Pure - no fetch, no
// clock, no secrets - because the decision worth testing here is "does typing
// this cost a supplier call", and that must be checkable without a network.
// The call itself lives in liteapi.ts; the wiring in src/app/api/cities.
// See docs/adr/0006-search-entry-point.md.

/** A hotel row as the typeahead needs it, narrowed from the supplier's shape. */
export type HotelNameRow = {
  id?: string | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
};

// The two things the typeahead can offer. They are a discriminated union
// because picking one does something quite different from picking the other: a
// place runs a search, a hotel opens that hotel. Declared HERE rather than in
// the route that serves them, because the client component that renders them
// cannot import from a module that reaches the supplier.
export type PlaceSuggestion = {
  kind: "place";
  /** Resolved by resolveDest: a curated key, a bare US city, or "intl:CC:Name". */
  dest: string;
  name: string;
  sub: string;
};

export type HotelSuggestion = {
  kind: "hotel";
  /** The hotel's supplier id. Picking a hotel opens /stay/<hotelId>. */
  hotelId: string;
  name: string;
  /** Street and city, so two hotels with the same name are tellable apart. */
  sub: string;
};

export type Suggestion = PlaceSuggestion | HotelSuggestion;

/**
 * Shortest query we will spend a supplier call on. Four characters is enough
 * for a real brand ("nobu", "aman") and short enough that nobody has to finish
 * a word. Below it the supplier's loose match returns most of its inventory,
 * which is both a wasted call and a useless list.
 */
export const MIN_HOTEL_QUERY_LENGTH = 4;

/** How many hotels the typeahead will show. The dropdown holds 8 rows in all. */
export const HOTEL_SUGGESTION_LIMIT = 5;

/** Collapse whitespace and case so "  Holiday  Inn " and "holiday inn" are one query. */
export function normaliseHotelQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Should this query cost a supplier call?
 *
 * `placeMatchCount` must count only the local tiers that matched by EXACT,
 * PREFIX or SUBSTRING - never a fuzzy match. A fuzzy match is a guess, and a
 * guess is not a reason to withhold a real hotel: the query that opened
 * NOS-66 was "holiday inn", which names no city but is one character of
 * typo-tolerance away from looking like it might.
 *
 * So: if the query names a place we know, we show places and never ask the
 * supplier. If it names nothing we know, it is probably a hotel.
 */
export function shouldLookUpHotelNames(args: { query: string; placeMatchCount: number }): boolean {
  const q = normaliseHotelQuery(args.query);
  if (q.length < MIN_HOTEL_QUERY_LENGTH) return false;
  if (args.placeMatchCount > 0) return false;
  return true;
}

/**
 * Order the supplier's loose match so the closest name wins.
 *
 * Measured 2026-10-11 (analysis/2026-10-11/probe-search-entry.mts): the
 * supplier's `hotelName` match is case-insensitive and partial, and it does not
 * rank. "holiday inn" returned 20 hotels in Orlando, the Grand Canyon,
 * Nashville and San Francisco in that order, with nothing to say which one the
 * person meant. Prefix before substring, then shorter name first, so
 * "Holiday Inn Express Waikiki by IHG" beats
 * "Holiday Inn Express & Suites Orlando At SeaWorld - With Free Shuttle..." for
 * the query "holiday inn express waik".
 *
 * Rows with no id are dropped: the only thing a suggestion does is link to
 * /stay/<hotelId>, so a row we cannot link to is not a suggestion.
 */
export function rankHotelMatches(query: string, rows: readonly HotelNameRow[]): HotelSuggestion[] {
  const q = normaliseHotelQuery(query);
  type Entry = { row: HotelNameRow; name: string };
  const starts: Entry[] = [];
  const contains: Entry[] = [];
  // The supplier's match is looser than ours: it can return a row whose name
  // contains neither the query nor any part of it we can see. Those are kept,
  // because it knows things about its own inventory that we do not, but they
  // rank below every name we can explain.
  const other: Entry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const id = (row.id ?? "").trim();
    const name = (row.name ?? "").trim();
    if (!id || !name) continue;
    if (seen.has(id)) continue; // one hotel, one suggestion, whatever the supplier sends
    seen.add(id);
    const lc = name.toLowerCase();
    if (lc.startsWith(q)) starts.push({ row, name });
    else if (lc.includes(q)) contains.push({ row, name });
    else other.push({ row, name });
  }

  const byLength = (a: Entry, b: Entry) => a.name.length - b.name.length;
  starts.sort(byLength);
  contains.sort(byLength);
  other.sort(byLength);

  return [...starts, ...contains, ...other].slice(0, HOTEL_SUGGESTION_LIMIT).map(({ row, name }) => ({
    kind: "hotel" as const,
    hotelId: (row.id ?? "").trim(),
    name,
    sub: subtitleFor(row),
  }));
}

/**
 * The second line under a hotel name. Street plus city, because the owner's
 * report named the hotel by its address ("2058 Kuhio Avenue"), and because
 * "Holiday Inn Express" alone appears dozens of times in one country.
 */
function subtitleFor(row: HotelNameRow): string {
  const parts = [(row.address ?? "").trim(), (row.city ?? "").trim()].filter(Boolean);
  return parts.join(", ");
}
