// Integration test: the limiter counts atomically, in shared storage (NOS-10).
//
// WHY THIS CANNOT BE A UNIT TEST. The claim is about Postgres: that `INSERT ...
// ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` is resolved under
// the row lock the database takes itself, so two requests arriving together get
// two different numbers. A fake store proves the arithmetic around it (see
// rate-limit-store.test.ts) and nothing about that. The old limiter's defect was
// precisely a read-then-write in process memory, so replacing it with another
// read-then-write that happened to be in SQL would be the same bug in a new
// place.
import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";
import { rateLimit, postgresRateStore } from "@/lib/rate-limit-store";

const MINUTE = 60_000;

let keyCounter = 0;
/** A key nothing else in this file or run has used. */
function freshKey(): string {
  keyCounter += 1;
  return `int-test:${Date.now()}:${keyCounter}`;
}

async function countsFor(key: string) {
  return db.select().from(rateLimits).where(eq(rateLimits.key, key));
}

beforeEach(async () => {
  // Only this file's own rows; nothing else writes keys with this prefix.
  await db.delete(rateLimits).where(sql`${rateLimits.key} LIKE 'int-test:%'`);
});

describe("two requests at the same moment cannot both be the last one (AC 4)", () => {
  it("admits exactly the limit when 30 callers race for 10 slots", async () => {
    // THE RACE, RUN FOR REAL. Thirty concurrent HTTP round trips to the same
    // counter. A read-then-write implementation lets several of them read 9 and
    // all write 10, so more than ten are admitted. The upsert cannot: each
    // caller's increment is resolved by Postgres in turn.
    const key = freshKey();
    const window = { limit: 10, windowMs: MINUTE, onStoreError: "deny" as const };

    const verdicts = await Promise.all(
      Array.from({ length: 30 }, () => rateLimit(key, window)),
    );

    expect(verdicts.filter((v) => v.ok)).toHaveLength(10);
    expect(verdicts.filter((v) => !v.ok)).toHaveLength(20);
  });

  it("gives every racing caller a different count", async () => {
    // The same claim from the store's own side: no two hits return the same
    // number, which is the definition of the increment being atomic.
    const key = freshKey();
    const windowStart = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
    const expiredBefore = new Date(windowStart.getTime() - MINUTE);

    const counts = await Promise.all(
      Array.from({ length: 20 }, () =>
        postgresRateStore.hit(key, windowStart, 1000, expiredBefore),
      ),
    );

    expect(new Set(counts).size).toBe(20);
    expect(Math.max(...counts)).toBe(20);
  });
});

describe("the count lives in the database, not in a process (AC 1, AC 2)", () => {
  it("writes one row per key and window, and keeps counting it", async () => {
    const key = freshKey();
    const window = { limit: 5, windowMs: MINUTE, onStoreError: "deny" as const };

    await rateLimit(key, window);
    await rateLimit(key, window);

    const rows = await countsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    // Which is what a second instance, or the same instance after a cold start,
    // reads: there is no other copy of this number anywhere.
  });

  it("starts a fresh counter in the next window", async () => {
    const key = freshKey();
    const nowMs = Date.now();
    const window = { limit: 1, windowMs: MINUTE, onStoreError: "deny" as const };

    const first = await rateLimit(key, { ...window, now: new Date(nowMs) });
    const second = await rateLimit(key, { ...window, now: new Date(nowMs) });
    const nextWindow = await rateLimit(key, { ...window, now: new Date(nowMs + MINUTE) });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(nextWindow.ok).toBe(true);
  });

  it("bounds the counter instead of climbing for as long as a flood lasts", async () => {
    // A refused request still increments, which is harmless - but `count` is an
    // `integer`, so `LEAST(count + 1, limit + 1)` keeps it meaningful and finite.
    const key = freshKey();
    const window = { limit: 2, windowMs: MINUTE, onStoreError: "deny" as const };

    for (let i = 0; i < 8; i += 1) await rateLimit(key, window);

    const rows = await countsFor(key);
    expect(rows[0].count).toBe(3);
  });
});

describe("expired windows do not accumulate", () => {
  it("sweeps rows older than a full window, and spares the current one", async () => {
    // Nothing else deletes these rows: no cron, and the `setInterval` the
    // in-memory version used died with its instance. The sweep rides along in
    // the same batch as the increment.
    const key = freshKey();
    const nowMs = Math.floor(Date.now() / MINUTE) * MINUTE;

    // A counter from three windows ago, written directly.
    await db
      .insert(rateLimits)
      .values({ key, windowStart: new Date(nowMs - 3 * MINUTE), count: 7 });
    expect(await countsFor(key)).toHaveLength(1);

    await rateLimit(key, {
      limit: 5,
      windowMs: MINUTE,
      onStoreError: "deny",
      now: new Date(nowMs),
    });

    const rows = await countsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0].windowStart.getTime()).toBe(nowMs);
    expect(rows[0].count).toBe(1);
  });

  it("does not sweep the window immediately before this one", async () => {
    // The cutoff is a full window back, not "anything older than now": a
    // request arriving one millisecond into a new window must not wipe the
    // counter that was still being written a moment earlier, because a caller
    // could then alternate across the boundary forever.
    const key = freshKey();
    const nowMs = Math.floor(Date.now() / MINUTE) * MINUTE;

    await db.insert(rateLimits).values({ key, windowStart: new Date(nowMs - MINUTE), count: 4 });
    await rateLimit(key, {
      limit: 5,
      windowMs: MINUTE,
      onStoreError: "deny",
      now: new Date(nowMs),
    });

    const rows = await countsFor(key);
    expect(rows).toHaveLength(2);
  });
});
