import "server-only";

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
