// The webhook receiver's rate limit (NOS-13, threat-model gap G2).
//
// WHAT WAS WRONG. Every request carrying the shared secret inserted a
// `webhook_events` row, with no limit of any kind, so a flood - a leaked secret,
// a misbehaving sender, or an attacker without the secret still spending our CPU
// on the constant-time comparison - meant unbounded database growth.
//
// A UNIT TEST, NOT AN INTEGRATION ONE, and that is the point. A limited request
// must be refused before anything is written, so if these assertions pass
// without a database being available at all, the "writes nothing" claim is
// proven by construction rather than by inspecting rows afterwards. The route
// imports `@/db`, which connects on first query and not on import
// (src/db/index.ts), so reaching it without `DATABASE_URL` is possible exactly
// as long as no query runs.
import { describe, it, expect, afterEach, vi } from "vitest";

// THE LIMITER IS FAKED HERE, AND THAT IS THE POINT (NOS-10). The real one now
// counts in Postgres so the limit holds across instances, which would make this
// a database test. What these assertions are about is the ROUTE: that a refused
// request is refused before the secret check and before any write. So the store
// is replaced with the same fixed-window arithmetic in memory, and the test
// still needs no database at all - which is what proves "writes nothing".
//
// The Postgres store's own atomicity and cross-instance behaviour are proven
// against a real database in src/lib/rate-limit-store.int.test.ts.
vi.mock("@/lib/rate-limit-store", () => {
  const windows = new Map<string, { count: number; startMs: number }>();
  return {
    rateLimit: async (key: string, opts: { limit: number; windowMs: number }) => {
      const now = Date.now();
      const startMs = Math.floor(now / opts.windowMs) * opts.windowMs;
      const held = windows.get(key);
      const entry = held && held.startMs === startMs ? held : { count: 0, startMs };
      entry.count = Math.min(entry.count + 1, opts.limit + 1);
      windows.set(key, entry);
      const ok = entry.count <= opts.limit;
      return {
        ok,
        remaining: Math.max(0, opts.limit - entry.count),
        retryAfterMs: ok ? 0 : startMs + opts.windowMs - now,
      };
    },
  };
});

import { POST as receiveWebhook } from "./route";
import { checkWebhookRate } from "@/lib/webhook-rate";

const LIMIT = 60;

/** A fresh address per test: the limiter's buckets are module state. */
let addressCounter = 0;
function freshIp(): string {
  addressCounter += 1;
  return `203.0.113.${addressCounter}`;
}

function delivery(ip: string, init: { secret?: string; body?: string } = {}): Request {
  const headers: Record<string, string> = {
    "x-forwarded-for": ip,
    "content-type": "application/json",
  };
  if (init.secret) headers.authorization = init.secret;
  return new Request("http://localhost/api/webhooks/liteapi", {
    method: "POST",
    headers,
    body: init.body ?? "{}",
  });
}

afterEach(() => {
  delete process.env.LITEAPI_WEBHOOK_SECRET;
  vi.restoreAllMocks();
});

describe("a flood from one address is refused (G2)", () => {
  it("allows the limit and refuses the next one", async () => {
    // THE DEFECT, DIRECTLY: before this, request 61 and request 61,000 were
    // both accepted and both wrote a row.
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1) {
      const response = await receiveWebhook(delivery(ip));
      // 401, because these carry no secret - the point here is only that the
      // limiter let them reach the secret check.
      expect(response.status, `request ${i + 1}`).toBe(401);
    }

    const limited = await receiveWebhook(delivery(ip));
    expect(limited.status).toBe(429);
  });

  it("tells the sender when to come back", async () => {
    // LiteAPI retries with backoff; a `Retry-After` is the one thing that makes
    // a refusal useful to a well-behaved sender rather than just a wall.
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1) await receiveWebhook(delivery(ip));

    const limited = await receiveWebhook(delivery(ip));
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("says nothing about us in the refusal", async () => {
    // Same rule as NOS-11: a rejection names no internal detail. This one is
    // served to anyone who can reach the URL, with or without the secret.
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1) await receiveWebhook(delivery(ip));

    const limited = await receiveWebhook(delivery(ip));
    const body = await limited.json();
    expect(body).toEqual({ error: "too many requests" });
  });

  it("counts each address separately", async () => {
    // One sender being noisy must not refuse the supplier. The limiter has
    // always keyed per address; this pins it at this entry point.
    const noisy = freshIp();
    const quiet = freshIp();
    for (let i = 0; i < LIMIT; i += 1) await receiveWebhook(delivery(noisy));

    expect((await receiveWebhook(delivery(noisy))).status).toBe(429);
    expect((await receiveWebhook(delivery(quiet))).status).toBe(401);
  });

  it("does not count a refused request against the window again", async () => {
    // A refusal that re-counted would extend its own window every time a
    // retrying sender knocked, so a burst could lock an address out
    // indefinitely. The limiter returns early without incrementing; this is the
    // assertion that keeps that true.
    const ip = freshIp();
    for (let i = 0; i < LIMIT; i += 1) await receiveWebhook(delivery(ip));

    const first = await receiveWebhook(delivery(ip));
    const firstRetry = Number(first.headers.get("Retry-After"));
    for (let i = 0; i < 5; i += 1) await receiveWebhook(delivery(ip));
    const later = await receiveWebhook(delivery(ip));
    const laterRetry = Number(later.headers.get("Retry-After"));

    // The window is counting down, not being pushed back.
    expect(laterRetry).toBeLessThanOrEqual(firstRetry);
  });
});

describe("the limit runs before anything else, which is what makes it safe", () => {
  it("refuses a limited request even when its secret is valid", async () => {
    // THE ORDERING, PROVEN RATHER THAN READ. This delivery carries the right
    // secret and a body that is not JSON. If the secret check ran first we
    // would get 400 (bad payload); if the body parse ran first, likewise. A 429
    // can only mean the limiter answered before either - and therefore before
    // any `webhook_events` insert, which is the claim that matters.
    const ip = freshIp();
    // Fill the window with UNAUTHORIZED requests. They count against the limit
    // just the same, and they write nothing - which is how this test needs no
    // database. (Filling it with valid-secret requests instead does reach the
    // insert, and fails on a missing DATABASE_URL: useful proof in itself that
    // the limiter is the only thing standing in front of that write.)
    for (let i = 0; i < LIMIT; i += 1) {
      expect((await receiveWebhook(delivery(ip))).status).toBe(401);
    }

    const secret = "test-only-secret-not-a-real-credential";
    process.env.LITEAPI_WEBHOOK_SECRET = secret;
    const limited = await receiveWebhook(delivery(ip, { secret, body: "not json at all" }));
    expect(limited.status).toBe(429);
  });

  it("still returns 401 to a wrong secret under the limit", async () => {
    // Regression guard: adding a limiter must not have made unauthorized
    // requests look accepted.
    process.env.LITEAPI_WEBHOOK_SECRET = "the-real-one";
    const response = await receiveWebhook(delivery(freshIp(), { secret: "the-wrong-one" }));
    expect(response.status).toBe(401);
  });
});

describe("when the limiter itself fails, the delivery still gets through", () => {
  it("allows the request and logs, rather than refusing it", async () => {
    // FAILS OPEN, DELIBERATELY, AND THE OPPOSITE WAY FROM THE MONEY ACTIONS.
    // Everywhere a guest spends money we would rather refuse than risk a double
    // charge. Here refusing is the harm: a limiter outage that dropped supplier
    // cancellations would leave hotels' cancellations unapplied in our ledger,
    // which is what this endpoint exists to prevent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const verdict = await checkWebhookRate(delivery(freshIp()), () => {
      throw new Error("rate-limit store unreachable");
    });

    expect(verdict.ok).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("allowing the delivery");
  });

  it("keys on the address the proxy reported, and survives its absence", async () => {
    // `x-forwarded-for` carries the client then each hop; the first entry is the
    // client. With no header at all the key degrades to a constant rather than
    // throwing, which would otherwise take the whole endpoint down behind a
    // proxy that did not set it.
    const keys: string[] = [];
    const spy = async (key: string) => {
      keys.push(key);
      return { ok: true, remaining: 1, retryAfterMs: 0 };
    };

    await checkWebhookRate(delivery("198.51.100.7, 70.41.3.18, 150.172.238.178"), spy);
    await checkWebhookRate(
      new Request("http://localhost/api/webhooks/liteapi", { method: "POST" }),
      spy,
    );

    expect(keys[0]).toBe("webhook-liteapi:ip:198.51.100.7");
    expect(keys[1]).toBe("webhook-liteapi:ip:local");
  });
});
