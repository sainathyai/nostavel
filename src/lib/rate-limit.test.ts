import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rateLimit } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit within the window", () => {
    const key = `k-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      const r = rateLimit(key, { limit: 3, windowMs: 1000 });
      expect(r.ok).toBe(true);
    }
  });

  it("blocks once the limit is exceeded within the window", () => {
    const key = `k-${Math.random()}`;
    rateLimit(key, { limit: 2, windowMs: 1000 });
    rateLimit(key, { limit: 2, windowMs: 1000 });
    const third = rateLimit(key, { limit: 2, windowMs: 1000 });
    expect(third.ok).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    const key = `k-${Math.random()}`;
    rateLimit(key, { limit: 1, windowMs: 1000 });
    expect(rateLimit(key, { limit: 1, windowMs: 1000 }).ok).toBe(false);
    vi.setSystemTime(1001);
    expect(rateLimit(key, { limit: 1, windowMs: 1000 }).ok).toBe(true);
  });

  it("tracks separate keys independently", () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    rateLimit(a, { limit: 1, windowMs: 1000 });
    const secondA = rateLimit(a, { limit: 1, windowMs: 1000 });
    const firstB = rateLimit(b, { limit: 1, windowMs: 1000 });
    expect(secondA.ok).toBe(false);
    expect(firstB.ok).toBe(true);
  });

  it("decrements remaining on each allowed call", () => {
    const key = `k-${Math.random()}`;
    const first = rateLimit(key, { limit: 3, windowMs: 1000 });
    const second = rateLimit(key, { limit: 3, windowMs: 1000 });
    expect(first.remaining).toBe(2);
    expect(second.remaining).toBe(1);
  });
});
