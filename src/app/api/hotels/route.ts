// The typeahead's HOTEL tier: find hotels by name (NOS-66, ADR 0006).
//
// Its own route, rather than a second job for `/api/cities`, for three reasons
// the design reviews of NOS-66 made concrete:
//
//   1. **It is the only route a keystroke can use to reach the supplier**, so it
//      is the one that must be rate-limited. `.agents/rules/backend.md` requires
//      that of every supplier-calling route, and the first version missed it
//      while editing that same rule to describe what had been built instead -
//      which the architecture review rightly called a rule losing a requirement.
//   2. **The place tier must never wait for it.** Holding rows we already have
//      behind a network call we did not need was the ux-designer's finding.
//      Two requests means the dropdown fills immediately and hotels land when
//      they land.
//   3. The guest can ask for it deliberately. When `/api/cities` advises
//      `offer` rather than `ask`, the dropdown shows a row to press, and that
//      press comes here. A press is not a keystroke, and the budget decision
//      stops being a guess about intent.
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { listHotelsByName } from "@/lib/liteapi";
import {
  MIN_HOTEL_QUERY_LENGTH,
  normaliseHotelQuery,
  rankHotelMatches,
  type HotelSuggestion,
} from "@/lib/search-suggestions";

export type HotelsResponse = { results: HotelSuggestion[] };

/**
 * Ten minutes. Long enough that backspacing and retyping the same hotel name
 * costs one call; short enough that a hotel appearing in inventory shows up the
 * same session. The cache lives in the serving process and dies with it, which
 * on a scale-to-zero service means it is empty more often than not. That is
 * acceptable: it is a spending brake, not a performance feature.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Bounded so a client typing random strings cannot grow it without limit. */
const CACHE_MAX_ENTRIES = 200;

/**
 * The same shape and numbers as `/api/stays-in-area`, which is the other route
 * a visitor can drive into the supplier. Deliberately not looser: this one is
 * cheaper per call, but it is reachable from a keystroke and that is worse.
 *
 * Known limit, and it is the limit of the helper rather than of this route:
 * `clientIp()` reads the first `x-forwarded-for` hop and returns the literal
 * "local" when the header is absent, so everyone behind one NAT shares a
 * bucket. Recorded as a known gap in `.agents/rules/security.md` (NOS-10).
 */
const RATE_LIMIT = { limit: 20, windowMs: 60_000 };

const cache = new Map<string, { at: number; rows: HotelSuggestion[] }>();

export async function GET(request: Request) {
  const typed = (new URL(request.url).searchParams.get("q") || "").trim();
  const key = normaliseHotelQuery(typed);

  // Checked here as well as in the gate the client used, because this route is
  // a URL and a client is not a boundary. A query too short to mean one hotel
  // returns the supplier most of its inventory, which is both a wasted call and
  // a useless list.
  if (key.length < MIN_HOTEL_QUERY_LENGTH) {
    return Response.json({ results: [] } satisfies HotelsResponse);
  }

  // Served before the rate limit on purpose: a cached answer costs nothing and
  // spending a visitor's budget on a question already answered would make the
  // limit itself a reason to fail.
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Response.json({ results: hit.rows } satisfies HotelsResponse);
  }

  const ip = await clientIp();
  const rl = rateLimit(`hotel-name:ip:${ip}`, RATE_LIMIT);
  if (!rl.ok) {
    // 429 rather than an empty list, so the client can say something true
    // instead of "no matches". A silent empty result is how a rate limit turns
    // into "this hotel does not exist".
    return Response.json({ results: [], error: "rate-limited" }, { status: 429 });
  }

  let rows: HotelSuggestion[];
  try {
    // US only: `countryCode` is required at this endpoint and the typeahead has
    // no location while someone is typing. Known limit, recorded in ADR 0006.
    rows = rankHotelMatches(key, await listHotelsByName(key, "US"));
  } catch {
    // A supplier that is unhappy must not break the typeahead. Not cached
    // either, so the next attempt may succeed.
    return Response.json({ results: [] } satisfies HotelsResponse);
  }

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), rows });

  return Response.json({ results: rows } satisfies HotelsResponse);
}
