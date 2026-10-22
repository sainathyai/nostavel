import "server-only";
import { headers } from "next/headers";

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

// Best-effort in-memory rate limiter (per server instance). Adequate for the
// current friends-&-family scope; swap for a shared store (Redis/Upstash)
// before any real public traffic. Fixed window keyed by an arbitrary string
// (e.g. a client IP or an email).
type Entry = { count: number; resetAt: number };
const buckets = new Map<string, Entry>();

export type RateResult = { ok: boolean; remaining: number; retryAfterMs: number };

export function rateLimit(
  key: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): RateResult {
  const now = Date.now();
  const e = buckets.get(key);
  if (!e || now >= e.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterMs: 0 };
  }
  if (e.count >= limit) {
    return { ok: false, remaining: 0, retryAfterMs: e.resetAt - now };
  }
  e.count += 1;
  return { ok: true, remaining: limit - e.count, retryAfterMs: 0 };
}

// Opportunistic cleanup so the map can't grow unbounded. Unref'd so it never
// keeps the process alive on its own.
if (typeof setInterval !== "undefined") {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of buckets) if (now >= e.resetAt) buckets.delete(k);
  }, 60_000);
  (t as unknown as { unref?: () => void }).unref?.();
}
