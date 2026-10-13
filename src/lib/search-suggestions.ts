// THE TYPEAHEAD'S WHOLE CONTRACT: what a suggestion is, what picking one does,
// when asking the supplier about a hotel name is warranted, and how to order
// what comes back.
//
// Pure - no fetch, no clock, no secrets, and no city dataset - because two
// different callers need it and one of them is a client component. The
// datasets and the matchers over them live in `place-search.ts`, which the
// browser must never import; the supplier call lives in `liteapi.ts`.
//
// RENAMED from `hotel-name-search.ts`, because that name was honest about one
// tier while the file held the contract for both, and a client component was
// importing it for the *place* type. Named for what it holds (the architecture
// review of NOS-66, F7).
//
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
 * What should happen about hotels for this query: nothing, ask now, or offer.
 *
 * TWO DECISIONS, NOT ONE, AND THE FIRST VERSION HAD THEM ON THE WRONG AXIS.
 * That version suppressed the hotel tier whenever the query matched the
 * supplier's city list by SUBSTRING, and the architecture review of NOS-66
 * measured what that actually did:
 *
 *   hilton    suppressed by  Chilton WI | Hilton NY | Hilton Head Island SC
 *   hyatt     suppressed by  Hyattsville MD
 *   waldorf   suppressed by  Waldorf MD
 *   ritz      suppressed by  Ritzville WA
 *   sheraton  suppressed by  "Sheraton Lakeside Inn Heliport"
 *   westin, marriott, nobu, "holiday inn"   fired
 *
 * Single-word brands failed and multi-word queries worked, which is the inverse
 * of what a typeahead needs. A heliport in the supplier's own junk-laden city
 * list was enough to make a major chain unreachable. The ADR's sentence "if the
 * query names a place we know, we show places" was true of the code and false as
 * a description: "Waldorf" does not name a place the guest means.
 *
 * So:
 *
 * 1. **`ask` - automatic, costs a call.** Only when the query is NOT itself the
 *    name of a place we hold. Exact equality, not prefix and not substring: if
 *    you typed the name of a city, you meant the city. This fires for `hyatt`,
 *    `ritz`, `sheraton` and `holiday inn`, and not for `austin`.
 * 2. **`offer` - a row the guest can press.** For a query long enough to mean a
 *    hotel that we are not going to spend on automatically, the dropdown offers
 *    "Search hotels named X". A press, not a keystroke. `hilton` and `waldorf`
 *    land here, so no brand is unreachable, and the budget decision stops being
 *    a guess about intent.
 *
 * `exactPlaceMatches` must count only EXACT name equality across the local
 * tiers, and never a fuzzy match - a fuzzy match is a guess, and a guess is not
 * a reason to withhold a real hotel. See `exactPlaceMatchCount` in
 * `place-search.ts`, which is the only thing that should compute it.
 */
export type HotelLookupAdvice = "none" | "ask" | "offer";

export function hotelLookupAdvice(args: {
  query: string;
  exactPlaceMatches: number;
}): HotelLookupAdvice {
  const q = normaliseHotelQuery(args.query);
  if (q.length < MIN_HOTEL_QUERY_LENGTH) return "none";
  return args.exactPlaceMatches > 0 ? "offer" : "ask";
}

/**
 * Where picking a suggestion goes.
 *
 * A DECISION, SO IT LIVES IN LIB. The first version built this URL inline
 * inside `Experience.tsx`, which put the routing decision in the one layer this
 * repository has no test tier for - and it silently dropped `dest` and `notes`,
 * so `StayPage`'s own "back to results" fell through to `/` and a guest who
 * picked a hotel had no results list to return to (architecture review, F6).
 *
 * A place sets the destination and is resolved by the search page, so it has no
 * href of its own; `null` says so rather than inventing one.
 */
export function suggestionHref(
  suggestion: Suggestion,
  context: { checkin: string; nights: number; dest?: string; notes?: string },
): string | null {
  if (suggestion.kind !== "hotel") return null;

  const params = new URLSearchParams({
    checkin: context.checkin,
    nights: String(context.nights),
  });
  // Carried so the hotel page can offer the way back to the search the guest
  // came from. Omitted when absent rather than sent empty, because
  // StayPage branches on presence.
  if (context.dest) params.set("dest", context.dest);
  if (context.notes) params.set("notes", context.notes);

  return `/stay/${encodeURIComponent(suggestion.hotelId)}?${params.toString()}`;
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
