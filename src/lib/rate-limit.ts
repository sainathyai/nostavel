import "server-only";
import { headers } from "next/headers";

// The fixed-window arithmetic, and nothing else (NOS-10).
//
// WHAT MOVED AND WHY. This module used to hold the counters in a module-scope
// `Map`, which made "20 per minute" mean "20 per minute PER INSTANCE, reset by
// every cold start and every deploy". Cloud Run runs up to two instances here,
// so the real limit was already double the written one, and a redeploy set every
// counter back to zero. These limits guard paid supplier calls, email sends and a
// one-time-code check, so the number mattering is the whole point.
//
// The counting now happens in Postgres (`src/lib/rate-limit-store.ts`). What
// stays here is the part with no I/O in it: which window a moment belongs to, and
// what a count means. Pure, so every boundary is testable without a database
// (docs/conventions.md §1, the rule/store split).

// The IP a rate limit keys on. Works from both a server action and a route
// handler — `headers()` reads the same incoming request either way. Was
// duplicated verbatim in find.ts and interpret-query.ts before this existed;
// consolidated here since it exists only to feed rateLimit() a key.
export async function clientIp(): Promise<string> {
  const h = await headers();
  return firstForwardedIp(h.get("x-forwarded-for"));
}

/**
 * The same key, taken from a route handler's OWN `Request` (NOS-13).
 *
 * WHY BOTH EXIST. `clientIp()` reads Next's request-scoped `headers()`, which a
 * server action has no other way to reach. A route handler is handed the
 * `Request` itself, so it does not need that scope - and depending on it there
 * has a cost: calling `headers()` outside a Next request context throws, which
 * makes a route that uses it untestable except through a mock of `next/headers`.
 * The webhook receiver is called directly by its own tests, so it takes this one.
 *
 * The parsing rule lives in one place so the two cannot drift: the first entry of
 * `x-forwarded-for` is the client as the proxy saw it, and the rest are hops.
 */
export function clientIpOf(request: Request): string {
  return firstForwardedIp(request.headers.get("x-forwarded-for"));
}

function firstForwardedIp(value: string | null): string {
  return (value ?? "").split(",")[0]?.trim() || "local";
}

export type RateResult = { ok: boolean; remaining: number; retryAfterMs: number };

export type RateWindow = { limit: number; windowMs: number };

/**
 * The start of the window a moment falls in, aligned to the wall clock.
 *
 * ALIGNED, NOT ANCHORED TO THE FIRST REQUEST, and the difference is the reason
 * the store can be atomic. An anchored window has to live in a mutable row
 * ("this window ends at T"), so admitting a request means read, decide, write -
 * which is exactly the race where two instances both read 19 and both write 20.
 * An aligned window is derivable from the clock, so it can be part of the row's
 * identity, and one `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1
 * RETURNING count` does the whole job with no read-then-write at all.
 *
 * The cost, stated rather than buried: an anchored window gave each key a full
 * `windowMs` from its first request; an aligned one gives it only the remainder
 * of the current window. Both are fixed windows, and both allow up to twice the
 * limit across a boundary (the limit at the end of one window, the limit at the
 * start of the next). A sliding window would not, but it needs a row per request
 * and a count over a range, which is a different and much heavier design.
 */
export function windowStartMs(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs) * windowMs;
}

/**
 * What a count means, given the limit and where we are in the window.
 *
 * `count` is the value AFTER this request was recorded, because that is what the
 * atomic increment returns. So the limit is `count <= limit`: the request that
 * takes the count to exactly the limit is the last allowed one.
 *
 * `retryAfterMs` comes from the window, never from the count, so a refused
 * request cannot push its own window further away - a caller hammering a limited
 * key would otherwise extend its own lockout indefinitely.
 */
export function verdictFor(count: number, nowMs: number, window: RateWindow): RateResult {
  const ok = count <= window.limit;
  const resetAt = windowStartMs(nowMs, window.windowMs) + window.windowMs;
  return {
    ok,
    remaining: Math.max(0, window.limit - count),
    retryAfterMs: ok ? 0 : Math.max(0, resetAt - nowMs),
  };
}
