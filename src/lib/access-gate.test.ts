import { describe, it, expect, vi } from "vitest";
import {
  EXEMPT_PATHS_FOR_TEST,
  isExemptPath,
  parseBasicPassword,
  requestVerdict,
  type VerdictInput,
} from "./access-gate";
import type { ConfigProblem } from "./deploy-config";

const PASSWORD = "p".repeat(20);

const FATAL: ConfigProblem[] = [
  { code: "supplier-key-live", severity: "fatal", message: "not a sandbox key" },
];

function basic(password: string, user = "owner"): string {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

/** A gated, correctly configured environment, with the real comparison shape. */
function input(overrides: Partial<VerdictInput> = {}): VerdictInput {
  return {
    path: "/",
    fatal: [],
    gateEnabled: true,
    authorization: null,
    password: PASSWORD,
    matches: (received, expected) => !!expected && !!received && received === expected,
    ...overrides,
  };
}

describe("the exempt list itself", () => {
  it("is exactly the three routes that carry their own secret, and nothing else", () => {
    // Pinned rather than described. Adding a fourth path is the decision this
    // test exists to force someone to make on purpose: the NOS-60 security
    // review's scenario was a later /api/cron/warm-search, exempted by a prefix
    // and written without a bearer check because "it isn't money", becoming an
    // unauthenticated supplier-and-AI-spending endpoint with no failing test.
    expect(EXEMPT_PATHS_FOR_TEST.EXEMPT_FROM_PASSWORD).toEqual([
      "/api/cron/sweep",
      "/api/cron/reconcile",
      "/api/webhooks/liteapi",
    ]);
    expect(EXEMPT_PATHS_FOR_TEST.HEALTH_PATH).toBe("/api/health");
  });
});

describe("isExemptPath", () => {
  it("exempts the scheduled jobs, which is what keeps guest-money recovery working", () => {
    // The sweeper is the only thing that rescues a guest who was charged and
    // whose browser never came back. A password gate in front of it would
    // silently switch that off, so each of these has its own case rather than
    // sharing one for the list.
    expect(isExemptPath("/api/cron/sweep")).toBe(true);
    expect(isExemptPath("/api/cron/reconcile")).toBe(true);
  });

  it("exempts the supplier's webhook receiver, which cannot log in", () => {
    expect(isExemptPath("/api/webhooks/liteapi")).toBe(true);
  });

  it("does not exempt a route that does not exist yet under an exempt one", () => {
    // The M5 fix. Under the prefix list all three of these were exempt.
    expect(isExemptPath("/api/cron/warm-search")).toBe(false);
    expect(isExemptPath("/api/cron/")).toBe(false);
    expect(isExemptPath("/api/webhooks/stripe")).toBe(false);
  });

  it("does not exempt a path that only starts or ends like an exempt one", () => {
    expect(isExemptPath("/api/cron/sweeper")).toBe(false);
    expect(isExemptPath("/api/cron/sweep/x")).toBe(false);
    expect(isExemptPath("/api/cronjobs")).toBe(false);
    expect(isExemptPath("/x/api/cron/sweep")).toBe(false);
  });

  it("does not exempt an encoded or traversing path, which exact equality gives for free", () => {
    // An earlier commit on this branch added an explicit fence against these,
    // because a prefix test can be fooled by a path that reads as exempt and
    // routes elsewhere. Exact equality is the stronger version of the same
    // protection: no string equals "/api/cron/sweep" and routes anywhere else.
    expect(isExemptPath("/api/cron/%2e%2e/book/abc")).toBe(false);
    expect(isExemptPath("/api/cron/../book/abc")).toBe(false);
    expect(isExemptPath("/api/%63ron/sweep")).toBe(false);
  });

  it("does not exempt the health route, which is handled one rule earlier", () => {
    // Health is exempt from the configuration refusal as well as the password,
    // so it is decided before this function is reached. Asserted so that
    // "isExemptPath says false" is never mistaken for "health is gated".
    expect(isExemptPath("/api/health")).toBe(false);
    expect(requestVerdict(input({ path: "/api/health" }))).toEqual({ action: "allow" });
  });

  it("does not exempt an ordinary page", () => {
    expect(isExemptPath("/")).toBe(false);
    expect(isExemptPath("/book/abc")).toBe(false);
  });
});

describe("parseBasicPassword", () => {
  it("reads the password out of a Basic header", () => {
    expect(parseBasicPassword(basic(PASSWORD))).toBe(PASSWORD);
  });

  it("ignores the username, which carries no secrecy", () => {
    expect(parseBasicPassword(basic(PASSWORD, "anyone"))).toBe(PASSWORD);
    expect(parseBasicPassword(basic(PASSWORD, ""))).toBe(PASSWORD);
  });

  it("keeps a colon inside the password, which is legal", () => {
    expect(parseBasicPassword(basic("a:b:c"))).toBe("a:b:c");
  });

  it("returns nothing for a missing, wrong-scheme or malformed header", () => {
    expect(parseBasicPassword(null)).toBe(null);
    expect(parseBasicPassword("")).toBe(null);
    expect(parseBasicPassword("Bearer " + PASSWORD)).toBe(null);
    expect(parseBasicPassword("Basic")).toBe(null);
    expect(parseBasicPassword("Basic a b")).toBe(null);
    // Decodes to text with no colon: not a credential pair.
    expect(parseBasicPassword("Basic " + Buffer.from("nocolon").toString("base64"))).toBe(null);
  });

  it("does not throw on a value that is not base64 at all", () => {
    expect(() => parseBasicPassword("Basic !!!!")).not.toThrow();
  });

  it("is case-insensitive about the scheme, as the HTTP specification requires", () => {
    expect(parseBasicPassword("basic " + Buffer.from("u:" + PASSWORD).toString("base64"))).toBe(PASSWORD);
  });
});

describe("requestVerdict: the health route", () => {
  it("is served even when the configuration is fatally broken", () => {
    // The whole reason health is checked before configuration: a pipeline that
    // can see a deploy is broken but not why cannot act on it.
    expect(requestVerdict(input({ path: "/api/health", fatal: FATAL }))).toEqual({ action: "allow" });
  });

  it("is served without the password", () => {
    expect(requestVerdict(input({ path: "/api/health", authorization: null }))).toEqual({ action: "allow" });
  });

  it("does not extend that to a path that merely begins with it", () => {
    // Health is the only exemption that also skips the configuration check, so
    // it is the one whose matching has to be exact. Compared with `===` on the
    // whole pathname, which this pins: the NOS-60 security review noted that
    // nothing was watching this line, and a later change to `startsWith` would
    // re-open the class an earlier commit on this branch had just closed.
    expect(requestVerdict(input({ path: "/api/healthz", fatal: FATAL })).action).toBe("unavailable");
    expect(requestVerdict(input({ path: "/api/health/deep", fatal: FATAL })).action).toBe("unavailable");
    expect(requestVerdict(input({ path: "/api/healthz" })).action).toBe("challenge");
    // A trailing slash is not the health route either. The framework redirects
    // it before the proxy sees it (measured against the running image), so this
    // is the fence for that stopping being true, not today's behaviour.
    expect(requestVerdict(input({ path: "/api/health/" })).action).toBe("challenge");
  });
});

describe("requestVerdict: a fatally misconfigured environment", () => {
  it("refuses an ordinary page", () => {
    expect(requestVerdict(input({ fatal: FATAL }))).toEqual({ action: "unavailable", problems: FATAL });
  });

  it("refuses even the caller holding the correct password", () => {
    // This is the money case. A copy carrying a live supplier key must not take
    // a booking from anyone, and the person most likely to be holding the
    // password is the owner, who is also the person most likely to try it.
    const verdict = requestVerdict(input({ fatal: FATAL, authorization: basic(PASSWORD) }));
    expect(verdict.action).toBe("unavailable");
  });

  it("refuses the supplier's webhook and the scheduled jobs too", () => {
    // These carry their own secret, so they are exempt from the PASSWORD - but
    // not from a broken configuration. A sweeper running against a live
    // supplier key is the exact thing being prevented.
    expect(requestVerdict(input({ path: "/api/webhooks/liteapi", fatal: FATAL })).action).toBe("unavailable");
    expect(requestVerdict(input({ path: "/api/cron/sweep", fatal: FATAL })).action).toBe("unavailable");
  });

  it("refuses before consulting the gate at all, even with the gate switched off", () => {
    // Order matters more than either rule on its own: a laptop holding a live
    // key must not serve a booking page just because it has no password to ask
    // for.
    expect(requestVerdict(input({ gateEnabled: false, fatal: FATAL })).action).toBe("unavailable");
  });
});

describe("requestVerdict: a developer's own machine", () => {
  it("serves everything, with no password and no header", () => {
    expect(requestVerdict(input({ gateEnabled: false, password: undefined }))).toEqual({ action: "allow" });
    expect(requestVerdict(input({ gateEnabled: false, path: "/book/abc" }))).toEqual({ action: "allow" });
  });
});

describe("requestVerdict: the password gate", () => {
  it("challenges a visitor with no credentials", () => {
    expect(requestVerdict(input())).toEqual({ action: "challenge" });
  });

  it("challenges a wrong password", () => {
    expect(requestVerdict(input({ authorization: basic("wrong") }))).toEqual({ action: "challenge" });
  });

  it("serves the correct password", () => {
    expect(requestVerdict(input({ authorization: basic(PASSWORD) }))).toEqual({ action: "allow" });
  });

  it("challenges when no password is configured, rather than letting everyone in", () => {
    // Belt and braces: an unset password is already a fatal configuration
    // problem, so this state should be unreachable. If it is ever reached, the
    // answer must not be "no password required".
    expect(requestVerdict(input({ password: undefined, authorization: null })).action).toBe("challenge");
    expect(requestVerdict(input({ password: "", authorization: basic("") })).action).toBe("challenge");
  });

  it("serves the webhook receiver and the scheduled jobs without the password", () => {
    expect(requestVerdict(input({ path: "/api/webhooks/liteapi" }))).toEqual({ action: "allow" });
    expect(requestVerdict(input({ path: "/api/cron/sweep" }))).toEqual({ action: "allow" });
  });

  it("decides through the injected comparison, so the real one is constant-time", () => {
    // .agents/rules/security.md forbids `===` on a secret: a naive compare
    // leaks how many leading bytes matched. This asserts the rule never
    // compares anything itself - it asks - which is what lets src/proxy.ts
    // hand it the one audited implementation.
    const matches = vi.fn().mockReturnValue(true);
    requestVerdict(input({ authorization: basic("whatever"), matches }));
    expect(matches).toHaveBeenCalledWith("whatever", PASSWORD);
  });
});
