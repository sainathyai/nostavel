import { DESTINATIONS } from "@/lib/destinations";
import { US_CITIES } from "@/lib/us-cities";
import { INTL_CITIES, COUNTRY_NAMES, intlDest, type IntlCity } from "@/lib/intl-cities";
import { levenshtein, fuzzyThreshold } from "@/lib/fuzzy";

export type CitySuggestion = { dest: string; name: string; sub: string };

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

export async function GET(request: Request) {
  const q = (new URL(request.url).searchParams.get("q") || "").trim().toLowerCase();

  if (!q) {
    const featured = DESTINATIONS.slice(0, 6).map((d) => ({
      dest: d.key,
      name: d.name,
      sub: `${d.region}, US`,
    }));
    return Response.json({ results: featured });
  }

  // curated hotspots first (they carry perimeter search + nicer labels)
  const curated: CitySuggestion[] = DESTINATIONS.filter((d) => d.label.toLowerCase().includes(q))
    .slice(0, 4)
    .map((d) => ({ dest: d.key, name: d.name, sub: `${d.region}, US` }));
  const curatedNames = new Set(curated.map((c) => c.name.toLowerCase()));

  const matches = rankedMatch(q);
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

  const cities: CitySuggestion[] = matches
    .filter((x) => !curatedNames.has(x.c.toLowerCase()))
    .slice(0, 5)
    .map((x) => ({ dest: x.c, name: x.c, sub: x.s ? `${x.s}, US` : "US" }));

  const intl: CitySuggestion[] = intlMatch(q)
    .slice(0, 5)
    .map((x) => ({
      dest: intlDest(x),
      name: x.c,
      sub: `${x.r ? x.r + ", " : ""}${COUNTRY_NAMES[x.cc] ?? x.cc}`,
    }));

  return Response.json({ results: [...curated, ...cities, ...intl].slice(0, 8) });
}
