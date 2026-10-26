// The fixed-window arithmetic, with no store behind it (NOS-10).
//
// These were tests of the in-memory limiter. The counting moved to Postgres, so
// what is left here is the part with no I/O: which window a moment belongs to,
// and what a count means. The five behaviours the old suite pinned are now in
// rate-limit-store.test.ts, where they are exercised through `rateLimit` against
// a fake store - same contract, one layer up.
import { describe, it, expect } from "vitest";
import { clientIpOf, verdictFor, windowStartMs } from "./rate-limit";

describe("which window a moment belongs to", () => {
  it("aligns to the wall clock, so the window is derivable and not stored", () => {
    // This is what lets `(key, window_start)` be the row's identity, which is
    // what lets one atomic statement do the whole job. See the long note in
    // rate-limit.ts.
    expect(windowStartMs(0, 1000)).toBe(0);
    expect(windowStartMs(999, 1000)).toBe(0);
    expect(windowStartMs(1000, 1000)).toBe(1000);
    expect(windowStartMs(1001, 1000)).toBe(1000);
  });

  it("puts two moments in the same minute in the same window", () => {
    const minute = 60_000;
    expect(windowStartMs(1_700_000_001_000, minute)).toBe(
      windowStartMs(1_700_000_030_000, minute),
    );
  });

  it("is honest about the boundary it buys atomicity with", () => {
    // THE COST, PINNED SO IT CANNOT BE FORGOTTEN. A request landing 1ms before a
    // boundary gets a 1ms window, and a caller can therefore use the full limit
    // twice in quick succession across the boundary. The old anchored window had
    // the same 2x burst, just positioned differently. A sliding window is the
    // only shape that does not, and it costs a row per request.
    const minute = 60_000;
    const justBeforeBoundary = 2 * minute - 1;
    const verdict = verdictFor(99, justBeforeBoundary, { limit: 10, windowMs: minute });
    expect(verdict.ok).toBe(false);
    expect(verdict.retryAfterMs).toBe(1);
  });
});

describe("what a count means", () => {
  it("allows the request that reaches the limit exactly", () => {
    // `count` is the value AFTER this request was recorded, because that is what
    // the atomic increment returns. So the limit is `count <= limit`.
    expect(verdictFor(10, 0, { limit: 10, windowMs: 1000 }).ok).toBe(true);
    expect(verdictFor(11, 0, { limit: 10, windowMs: 1000 }).ok).toBe(false);
  });

  it("reports what is left", () => {
    expect(verdictFor(1, 0, { limit: 3, windowMs: 1000 }).remaining).toBe(2);
    expect(verdictFor(3, 0, { limit: 3, windowMs: 1000 }).remaining).toBe(0);
    // Never negative, however far past the limit a flood has pushed the count.
    expect(verdictFor(50, 0, { limit: 3, windowMs: 1000 }).remaining).toBe(0);
  });

  it("counts retry-after from the window, never from the count", () => {
    // A refused request must not be able to push its own window further away.
    // Hammering a limited key would otherwise extend the lockout indefinitely,
    // which is a denial of service a caller can inflict on themselves - and,
    // keyed on a spoofable address, on somebody else.
    const window = { limit: 1, windowMs: 1000 };
    const early = verdictFor(5, 100, window);
    const later = verdictFor(500, 900, window);
    expect(early.retryAfterMs).toBe(900);
    expect(later.retryAfterMs).toBe(100);
  });

  it("asks nothing to wait when it is allowing the request", () => {
    expect(verdictFor(1, 123, { limit: 10, windowMs: 1000 }).retryAfterMs).toBe(0);
  });
});

describe("the address a limit keys on", () => {
  it("takes the client, not the proxy hops", () => {
    const request = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "198.51.100.7, 70.41.3.18, 150.172.238.178" },
    });
    expect(clientIpOf(request)).toBe("198.51.100.7");
  });

  it("degrades to a constant rather than throwing when the header is absent", () => {
    // Behind a proxy that does not set it, every caller shares one bucket. That
    // is a known, separately-tracked gap (the header is also spoofable); what
    // matters here is that the limiter does not take the endpoint down with it.
    expect(clientIpOf(new Request("http://localhost/x"))).toBe("local");
    expect(clientIpOf(new Request("http://localhost/x", { headers: { "x-forwarded-for": " , " } }))).toBe(
      "local",
    );
  });
});
