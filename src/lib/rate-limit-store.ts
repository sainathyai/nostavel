import "server-only";
import { and, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { describeThrown } from "@/lib/action-error";
import { logError } from "@/lib/log";
import { verdictFor, windowStartMs, type RateResult, type RateWindow } from "@/lib/rate-limit";

// Where rate-limit counters actually live (NOS-10).
//
// THE BUG THIS REPLACES. `rateLimit()` kept its counters in a module-scope `Map`.
// Each Cloud Run instance had its own, and every cold start and every deploy
// emptied it, so "10 per minute" was "10 per minute per instance, since the last
// deploy". It guards `prepareBooking` and `confirmBooking` (paid LiteAPI calls),
// the one-time-code email, and the code check itself.
//
// WHY POSTGRES AND NOT REDIS. The database is already provisioned, already
// reached from every request, and needs no new paid service or owner sign-off
// (docs/team/workflow.md puts a new paid dependency with the owner). The cost is
// one round trip per limited call, which is noise beside the multi-second
// supplier calls these limits protect - and the alternative is a limiter that
// does not limit.

/** What the store has to be able to do. A seam, so the rule is testable without a database. */
export type RateStore = {
  /**
   * Record one hit and return the resulting count for the window.
   *
   * Must be atomic: two concurrent callers must get two different numbers.
   */
  hit(key: string, windowStart: Date, cap: number, expiredBefore: Date): Promise<number>;
};

/**
 * One statement for the increment, one for the sweep, in one round trip.
 *
 * ATOMICITY IS THE WHOLE JOB. `INSERT ... ON CONFLICT DO UPDATE SET count =
 * count + 1 RETURNING count` is resolved by Postgres under the row lock it takes
 * itself, so two requests arriving together get 19 and 20, never 19 and 19. No
 * transaction, no advisory lock, and nothing the neon-http driver (one stateless
 * request per query) could not do.
 *
 * `LEAST(count + 1, cap)` bounds the counter. A refused request still increments,
 * which is harmless because the verdict only needs "is it over the limit" - but
 * unbounded it would be an `integer` column climbing for as long as a flood
 * lasts, and `limit + 1` carries the same meaning.
 *
 * THE SWEEP IS IN THE SAME BATCH ON PURPOSE. Expired windows are dead rows, and
 * something has to delete them. A cron job would be a second place to keep in
 * step; a `setInterval` is what the in-memory version did and it dies with the
 * instance. Putting the `DELETE` in the same `db.batch` costs no extra round trip
 * and no extra decision: `window_start` is indexed, the cutoff is a full window
 * before the current one, so it cannot touch the row just written and on the
 * common path it matches nothing. The honest cost is a write statement on every
 * limited request, which at this traffic is cheaper than another moving part.
 */
export const postgresRateStore: RateStore = {
  async hit(key, windowStart, cap, expiredBefore) {
    const [written] = await db.batch([
      db
        .insert(rateLimits)
        .values({ key, windowStart, count: 1 })
        .onConflictDoUpdate({
          target: [rateLimits.key, rateLimits.windowStart],
          set: { count: sql`LEAST(${rateLimits.count} + 1, ${cap})` },
        })
        .returning({ count: rateLimits.count }),
      db.delete(rateLimits).where(and(lt(rateLimits.windowStart, expiredBefore))),
    ]);
    return written[0].count;
  },
};

/**
 * What to do when the store cannot answer. There is no safe default, so there is
 * no default: every call site states its own direction.
 *
 * - `"deny"` for anything that spends money, sends email, or checks a secret.
 *   A limiter outage must not become free supplier calls. It costs nothing in
 *   practice either: if Postgres is unreachable, the action was going to fail at
 *   its first write anyway.
 * - `"allow"` for the inbound supplier webhook only (NOS-13). Its job is not to
 *   refuse but to not lose what the supplier is telling us; a dropped
 *   cancellation leaves a hotel's cancellation unapplied in our ledger.
 */
export type StoreFailurePolicy = "allow" | "deny";

export type RateLimitOptions = RateWindow & {
  onStoreError: StoreFailurePolicy;
  /** Injected for tests; production always reads the clock. */
  now?: Date;
};

/**
 * Count this request against `key`, and say whether it may proceed.
 *
 * Async now, which is the one change every call site sees. The window arithmetic
 * is the pure rule in `rate-limit.ts`; this adds the I/O and the failure policy.
 */
export async function rateLimit(
  key: string,
  options: RateLimitOptions,
  store: RateStore = postgresRateStore,
): Promise<RateResult> {
  const nowMs = (options.now ?? new Date()).getTime();
  const startMs = windowStartMs(nowMs, options.windowMs);
  // One full window back: old enough that nothing current can be inside it, so
  // the sweep can never delete a counter still in use.
  const expiredBefore = new Date(startMs - options.windowMs);

  try {
    const count = await store.hit(key, new Date(startMs), options.limit + 1, expiredBefore);
    return verdictFor(count, nowMs, options);
  } catch (e) {
    // Never throws into the caller either way: an action that returns "try again"
    // is recoverable, an unhandled rejection inside a server action is not.
    const failing = options.onStoreError === "deny" ? "closed" : "open";
    // The BUCKET, not the key. A key ends in a client address or an email, and
    // when the whole store is unreachable neither tells anyone anything the
    // bucket name does not - while both are personal data in a log line.
    const bucket = key.split(":")[0];
    logError(
      "rate_limit.store_unavailable",
      `The rate-limit store is unavailable, failing ${failing} for ${bucket}: ${describeThrown(e)}`,
      { bucket, failing, policy: options.onStoreError },
    );
    return options.onStoreError === "deny"
      ? { ok: false, remaining: 0, retryAfterMs: options.windowMs }
      : { ok: true, remaining: 0, retryAfterMs: 0 };
  }
}
