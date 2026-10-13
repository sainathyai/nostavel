// The typeahead's PLACE tier. Local data only: curated destinations, LiteAPI's
// own US city list, then the international tier.
//
// THIS ROUTE NO LONGER TOUCHES THE SUPPLIER, and that is the fix rather than an
// accident of refactoring. The first version of NOS-66 fetched hotel names from
// here, which created two problems the design reviews caught:
//
//   1. It held answers it already had. Places were computed synchronously and
//      then the handler awaited the supplier for up to 2.5 seconds before
//      returning anything, so a query with real local rows showed an empty
//      dropdown while a network call it did not need finished (ux-designer
//      review of NOS-66).
//   2. `.agents/rules/backend.md` requires every route that calls the supplier
//      to be rate-limited, and this one was not - while `/api/stays-in-area`,
//      one directory away, does it in one line (architecture review, F2).
//
// Both are answered by moving the supplier call to its own route,
// `/api/hotels`, which is rate-limited and reached by a second request. This
// one answers instantly from memory, and says whether a hotel lookup is worth
// making.
import { DESTINATIONS } from "@/lib/destinations";
import { COUNTRY_NAMES, intlDest } from "@/lib/intl-cities";
import {
  exactPlaceMatchCount,
  fuzzyMatch,
  intlMatch,
  rankedMatch,
  type USCityRow,
} from "@/lib/place-search";
import {
  hotelLookupAdvice,
  type HotelLookupAdvice,
  type PlaceSuggestion,
} from "@/lib/search-suggestions";

export type { PlaceSuggestion };

/** Place rows in the dropdown. Hotel rows are added by the client, from /api/hotels. */
const PLACE_LIMIT = 8;

export type CitiesResponse = {
  results: PlaceSuggestion[];
  /**
   * What the client should do about hotels: nothing, fetch now, or offer a row
   * the guest can press. The decision lives in a tested rule rather than in the
   * component, because it is the decision that spends money.
   */
  hotels: HotelLookupAdvice;
};

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
    return Response.json({ results: featured, hotels: "none" } satisfies CitiesResponse);
  }

  // curated hotspots first (they carry perimeter search + nicer labels). This
  // tier is also what fixes a name the supplier's own city list gets WRONG
  // rather than misses - "South Beach" resolves to Staten Island in that list,
  // and a curated entry outranks it from here.
  const curated: PlaceSuggestion[] = DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q))
    .slice(0, 4)
    .map((d) => ({
      kind: "place" as const,
      dest: d.key,
      name: d.name,
      sub: `${d.region}, US`,
    }));
  const curatedNames = new Set(curated.map((c) => c.name.toLowerCase()));

  const matches: USCityRow[] = [...rankedMatch(q)];
  // Only reach for typo tolerance when the exact/prefix/substring pass is thin -
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
    .map((x) => ({
      kind: "place" as const,
      dest: x.c,
      name: x.c,
      sub: x.s ? `${x.s}, US` : "US",
    }));

  const intl: PlaceSuggestion[] = intlMatch(q)
    .slice(0, 5)
    .map((x) => ({
      kind: "place" as const,
      dest: intlDest(x),
      name: x.c,
      sub: `${x.r ? x.r + ", " : ""}${COUNTRY_NAMES[x.cc] ?? x.cc}`,
    }));

  return Response.json({
    results: [...curated, ...cities, ...intl].slice(0, PLACE_LIMIT),
    // Counted on EXACT equality, never substring and never fuzzy. See
    // exactPlaceMatchCount: the substring version made "hilton", "waldorf",
    // "ritz" and "sheraton" unreachable.
    hotels: hotelLookupAdvice({ query: typed, exactPlaceMatches: exactPlaceMatchCount(q) }),
  } satisfies CitiesResponse);
}
