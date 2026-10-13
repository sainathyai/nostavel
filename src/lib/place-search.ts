// Matching a typed string against the places we hold locally: the curated
// destinations, LiteAPI's own US city list, and the international tier.
//
// MOVED OUT OF `src/app/api/cities/route.ts` (architecture review of NOS-66,
// F3). These were three functions inside a route, which conventions §1 calls
// the wrong place for a rule - and once NOS-66 made the hotel tier conditional
// on how many places matched, they stopped being presentation and started
// deciding whether a keystroke spends money. Nothing in CI could fail on that
// decision while it lived in a route, which is why "hilton" was unreachable
// for a week and nobody's test went red.
//
// NOT CLIENT-SAFE: this module imports both city datasets (about 1.7 MB of
// JSON). The typeahead's contract and the gate live in `search-suggestions.ts`,
// which a client component may import; this one may only be reached from a
// route or a server component.
import { DESTINATIONS } from "@/lib/destinations";
import { US_CITIES } from "@/lib/us-cities";
import { INTL_CITIES, type IntlCity } from "@/lib/intl-cities";
import { levenshtein, fuzzyThreshold } from "@/lib/fuzzy";

export type USCityRow = (typeof US_CITIES)[number];

// Cities with matched coordinates went through GeoNames confidently (the
// stronger, better-known entries); ones without are noisier long-tail rows.
// Used only as a secondary ranking signal, not a filter.
function quality(x: USCityRow): number {
  return x.lat != null ? 0 : 1;
}

/**
 * Prefix/substring/exact tiers first (cheap, usually right), ranked by data
 * quality then name length so "Austin" beats "Austinville" for query "austin".
 */
export function rankedMatch(q: string): USCityRow[] {
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

/**
 * Typo-tolerant fallback: only runs when exact/prefix/substring matching came
 * up short, and only on the query's word length so a 3-letter query doesn't
 * fuzzy-match half the dataset.
 */
export function fuzzyMatch(q: string): USCityRow[] {
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

/**
 * International cities have real population data (unlike the US set, which
 * only has "has coordinates" as a quality proxy) - rank by population, then
 * prefer prefix over substring matches.
 */
export function intlMatch(q: string): IntlCity[] {
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

/**
 * How many places we hold are called EXACTLY this?
 *
 * THE ONE NUMBER THAT DECIDES WHETHER A KEYSTROKE SPENDS MONEY, which is why it
 * is here, exported and tested, rather than computed inline where the old
 * version computed it.
 *
 * Exact equality on purpose, and this is the whole correction from the
 * architecture review. The old count was substring-based, so "Chilton, WI"
 * suppressed "hilton" and a heliport in the supplier's city list suppressed
 * "sheraton". The question this answers is narrow: *did the guest type the name
 * of a place we know?* If they did, show the place. If they typed something that
 * merely appears inside the name of a place, they did not name that place.
 *
 * Fuzzy matches are deliberately not counted anywhere near this: a fuzzy match
 * is a guess, and a guess is not a reason to withhold a real hotel. The query
 * that opened NOS-66 was "holiday inn".
 *
 * Curated destinations are matched on both the bare name and the "Name, ST"
 * label, because a guest may type either and both are names we hold.
 */
export function exactPlaceMatchCount(q: string): number {
  const query = q.trim().toLowerCase();
  if (!query) return 0;

  let count = 0;
  for (const d of DESTINATIONS) {
    if (d.name.toLowerCase() === query || d.label.toLowerCase() === query) count++;
  }
  for (const x of US_CITIES) {
    if (x.c.toLowerCase() === query) count++;
  }
  for (const x of INTL_CITIES) {
    if (x.c.toLowerCase() === query) count++;
  }
  return count;
}
