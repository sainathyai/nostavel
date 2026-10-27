// `rateLimit` against a fake store (NOS-10).
//
// The five behaviours the old in-memory suite pinned are all here, one layer up:
// allow to the limit, block past it, reset after the window, independent per key,
// and `remaining` decrementing. They are AC 3's regression guard, and they pass
// against any store that counts - which is the point of the seam.
//
// Also here: the failure policy, which is the part of this change with real
// consequences. The Postgres store's atomicity is a database claim and is proven
// against a real one in rate-limit-store.int.test.ts.
import { describe, it, expect, vi } from "vitest";
import { rateLimit, type RateStore } from "./rate-limit-store";

/**
 * A store that counts in memory, honouring the one contract that matters:
 * `(key, windowStart)` identifies a counter, and a hit returns the new count.
 */
function fakeStore(): RateStore & { rows: Map<string, number>; swept: Date[] } {
  const rows = new Map<string, number>();
  const swept: Date[] = [];
  return {
    rows,
    swept,
    async hit(key, windowStart, cap, expiredBefore) {
      swept.push(expiredBefore);
      for (const existing of [...rows.keys()]) {
        const at = Number(existing.split("@").at(-1));
        if (at < expiredBefore.getTime()) rows.delete(existing);
      }
      const id = `${key}@${windowStart.getTime()}`;
      const next = Math.min((rows.get(id) ?? 0) + 1, cap);
      rows.set(id, next);
      return next;
    },
  };
}

const MINUTE = 60_000;
/** A fixed point in time, so no test depends on when it runs. */
const T0 = new Date("2026-10-26T12:00:00.000Z");
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

describe("the fixed-window contract still holds (AC 3)", () => {
  it("allows requests up to the limit within the window", async () => {
    const store = fakeStore();
    for (let i = 0; i < 3; i += 1) {
      const r = await rateLimit("k", { limit: 3, windowMs: MINUTE, onStoreError: "deny", now: at(i) }, store);
      expect(r.ok, `request ${i + 1}`).toBe(true);
    }
  });

  it("blocks once the limit is exceeded within the window", async () => {
    const store = fakeStore();
    const window = { limit: 2, windowMs: MINUTE, onStoreError: "deny" as const };
    await rateLimit("k", { ...window, now: at(0) }, store);
    await rateLimit("k", { ...window, now: at(1) }, store);
    const third = await rateLimit("k", { ...window, now: at(2) }, store);

    expect(third.ok).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", async () => {
    const store = fakeStore();
    const window = { limit: 1, windowMs: MINUTE, onStoreError: "deny" as const };
    await rateLimit("k", { ...window, now: at(0) }, store);
    expect((await rateLimit("k", { ...window, now: at(1) }, store)).ok).toBe(false);
    expect((await rateLimit("k", { ...window, now: at(MINUTE) }, store)).ok).toBe(true);
  });

  it("tracks separate keys independently", async () => {
    const store = fakeStore();
    const window = { limit: 1, windowMs: MINUTE, onStoreError: "deny" as const, now: at(0) };
    await rateLimit("a", window, store);
    expect((await rateLimit("a", window, store)).ok).toBe(false);
    expect((await rateLimit("b", window, store)).ok).toBe(true);
  });

  it("decrements remaining on each allowed call", async () => {
    const store = fakeStore();
    const window = { limit: 3, windowMs: MINUTE, onStoreError: "deny" as const, now: at(0) };
    expect((await rateLimit("k", window, store)).remaining).toBe(2);
    expect((await rateLimit("k", window, store)).remaining).toBe(1);
  });
});

describe("the thing the in-memory limiter could not do (AC 1, AC 2)", () => {
  it("holds across callers that share no memory", async () => {
    // THE DEFECT, DIRECTLY. Two Cloud Run instances each had their own `Map`, so
    // a limit of 3 was 3 per instance. Here two callers share only the store,
    // which is what a second instance has, and the limit is 3 in total.
    const store = fakeStore();
    const window = { limit: 3, windowMs: MINUTE, onStoreError: "deny" as const, now: at(0) };
    const instanceA = (key: string) => rateLimit(key, window, store);
    const instanceB = (key: string) => rateLimit(key, window, store);

    const verdicts = [
      await instanceA("shared"),
      await instanceB("shared"),
      await instanceA("shared"),
      await instanceB("shared"),
    ];

    expect(verdicts.filter((v) => v.ok)).toHaveLength(3);
    expect(verdicts.at(-1)!.ok).toBe(false);
  });

  it("survives a cold start, because the count is not in the process", async () => {
    // AC 2. A redeploy or a scale-to-zero emptied the old map, so every counter
    // went back to 0 while the window was still running.
    const store = fakeStore();
    const window = { limit: 2, windowMs: MINUTE, onStoreError: "deny" as const };
    await rateLimit("k", { ...window, now: at(0) }, store);

    // A "new process": nothing carried over but the store itself.
    const afterRestart = await rateLimit("k", { ...window, now: at(1000) }, store);
    expect(afterRestart.ok).toBe(true);
    expect(afterRestart.remaining).toBe(0);
    expect((await rateLimit("k", { ...window, now: at(2000) }, store)).ok).toBe(false);
  });

  it("sweeps windows that are over, and never the one in use", async () => {
    // The in-memory version had a `setInterval` that died with the instance.
    // Rows are swept by the store on every hit; the cutoff is a full window back,
    // so it can never delete the counter being written.
    const store = fakeStore();
    const window = { limit: 5, windowMs: MINUTE, onStoreError: "deny" as const };
    await rateLimit("k", { ...window, now: at(0) }, store);
    expect(store.rows.size).toBe(1);

    await rateLimit("k", { ...window, now: at(3 * MINUTE) }, store);
    // The old window is gone, the current one is there.
    expect(store.rows.size).toBe(1);
    expect([...store.rows.keys()][0]).toContain(String(T0.getTime() + 3 * MINUTE));

    const cutoff = store.swept.at(-1)!.getTime();
    expect(cutoff).toBeLessThan(T0.getTime() + 3 * MINUTE);
  });
});

describe("when the store cannot answer (AC 5)", () => {
  const broken: RateStore = {
    async hit() {
      throw new Error("relation \"rate_limits\" does not exist");
    },
  };

  it("fails CLOSED where money, email or a secret is involved", async () => {
    // The default for everything except the inbound webhook. A limiter outage
    // must not become free supplier calls - and it costs nothing in practice,
    // because an action whose database is unreachable was going to fail at its
    // own first write anyway.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const verdict = await rateLimit(
      "booking-confirm:ip:1.2.3.4",
      { limit: 10, windowMs: MINUTE, onStoreError: "deny" },
      broken,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.retryAfterMs).toBe(MINUTE);
    expect(String(error.mock.calls[0][0])).toContain("failing closed");
    error.mockRestore();
  });

  it("fails OPEN for the inbound supplier webhook", async () => {
    // The one call site that goes the other way (NOS-13). Its job is not to
    // refuse but to not lose what the supplier is telling us: a dropped
    // cancellation leaves a hotel's cancellation unapplied in our ledger.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const verdict = await rateLimit(
      "webhook-liteapi:ip:1.2.3.4",
      { limit: 60, windowMs: MINUTE, onStoreError: "allow" },
      broken,
    );

    expect(verdict.ok).toBe(true);
    expect(String(error.mock.calls[0][0])).toContain("failing open");
    error.mockRestore();
  });

  it("never throws into the caller, whichever direction it takes", async () => {
    // An action returning "try again" is recoverable. An unhandled rejection
    // inside a server action is a 500 with a digest and no reference.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const onStoreError of ["deny", "allow"] as const) {
      await expect(
        rateLimit("k", { limit: 1, windowMs: MINUTE, onStoreError }, broken),
      ).resolves.toBeDefined();
    }
    error.mockRestore();
  });

  it("says which way it went, so an outage is diagnosable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await rateLimit("k", { limit: 1, windowMs: MINUTE, onStoreError: "deny" }, broken);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain("[rate-limit]");
    expect(line).toContain("store unavailable");
    error.mockRestore();
  });
});
