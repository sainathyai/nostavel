// The cron caller rule (NOS-65). One test per denied claim, because the security
// review named a fail-open verifier as worse than a leaked secret.
import { describe, it, expect } from "vitest";
import { verifyCronCaller, type TokenClaims, type ExpectedCaller } from "./cron-identity";

const expected: ExpectedCaller = {
  email: "nostavel-uat-sweep-invoker@example-project.iam.gserviceaccount.com",
  subject: "109876543210987654321",
  audience: "https://nostavel-uat.example.com/api/cron/sweep",
};

const NOW = new Date("2026-10-14T12:00:00.000Z");
const nowSeconds = Math.floor(NOW.getTime() / 1000);

/** A token Google would actually issue for this job. */
function goodClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  return {
    iss: "https://accounts.google.com",
    aud: expected.audience,
    email: expected.email,
    email_verified: true,
    sub: expected.subject,
    iat: nowSeconds - 30,
    exp: nowSeconds + 3570,
    ...overrides,
  };
}

describe("the caller we do want", () => {
  it("authorises a Google-signed token from the expected service account", () => {
    expect(verifyCronCaller(goodClaims(), expected, NOW)).toEqual({ ok: true });
  });

  it("accepts the bare issuer spelling, which Google also issues", () => {
    const v = verifyCronCaller(goodClaims({ iss: "accounts.google.com" }), expected, NOW);
    expect(v.ok).toBe(true);
  });

  it("forgives small clock skew in both directions", () => {
    // A scale-to-zero container's clock is the host's. 30 seconds either side of
    // the boundary must not fail a legitimate run.
    const justExpired = goodClaims({ exp: nowSeconds - 30 });
    expect(verifyCronCaller(justExpired, expected, NOW).ok).toBe(true);
    const justIssued = goodClaims({ iat: nowSeconds + 30 });
    expect(verifyCronCaller(justIssued, expected, NOW).ok).toBe(true);
  });
});

describe("the identity checks, which are what stop all of Google Cloud", () => {
  it("refuses a token from the wrong service account", () => {
    // THE MISCONFIGURATION THE SECURITY REVIEW CALLED CRITICAL. Our service is
    // public, so Cloud Run does not validate the token for us. A verifier that
    // checked only the issuer would authorise any Google Cloud customer, because
    // anyone can mint a Google-signed token for any audience.
    const v = verifyCronCaller(
      goodClaims({ email: "attacker@some-other-project.iam.gserviceaccount.com" }),
      expected,
      NOW,
    );
    expect(v).toEqual({ ok: false, reason: "email is not the expected caller" });
  });

  it("refuses the right email with the wrong subject", () => {
    // An email can be recreated on a deleted account; `sub` cannot. Pinning both
    // means deleting and recreating the account does not silently re-authorise.
    const v = verifyCronCaller(goodClaims({ sub: "999" }), expected, NOW);
    expect(v).toEqual({ ok: false, reason: "sub is not the expected caller" });
  });

  it("refuses a token minted for the other cron route", () => {
    const v = verifyCronCaller(
      goodClaims({ aud: "https://nostavel-uat.example.com/api/cron/reconcile" }),
      expected,
      NOW,
    );
    expect(v).toEqual({ ok: false, reason: "aud is not this route" });
  });

  it("refuses a non-Google issuer", () => {
    const v = verifyCronCaller(goodClaims({ iss: "https://evil.example.com" }), expected, NOW);
    expect(v).toEqual({ ok: false, reason: "iss is not Google" });
  });

  it("refuses an unverified email", () => {
    const v = verifyCronCaller(goodClaims({ email_verified: false }), expected, NOW);
    expect(v).toEqual({ ok: false, reason: "email_verified is not true" });
  });

  it("refuses a truthy-but-not-true email_verified", () => {
    // `if (claims.email_verified)` would pass the string "false".
    for (const value of ["true", "false", 1, {}]) {
      const v = verifyCronCaller(goodClaims({ email_verified: value }), expected, NOW);
      expect(v).toEqual({ ok: false, reason: "email_verified is not true" });
    }
  });
});

describe("every claim missing or wrong-typed is a denial, never a pass", () => {
  // THE FAIL-OPEN CLASS, ASSERTED EXHAUSTIVELY. `Date.now() > undefined` is
  // false, so an expiry compared without being checked first lets a token with no
  // `exp` through. Same shape for every other claim.
  const absent = [undefined, null, "", 0, false, {}, [], Number.NaN, Infinity];

  it("has a case for every claim the rule reads, so a new one cannot be forgotten", () => {
    // The loops below name claims by hand, which means a SEVENTH required claim
    // added later would have no absent-or-wrong-type case and would fail open
    // silently. This asserts the hand-written list still covers the whole shape.
    expect(Object.keys(goodClaims()).sort()).toEqual(
      ["aud", "email", "email_verified", "exp", "iat", "iss", "sub"].sort(),
    );
  });

  for (const [claim, reason] of [
    ["iss", "iss is missing or not a string"],
    ["aud", "aud is missing or not a string"],
    ["email", "email is missing or not a string"],
    ["sub", "sub is missing or not a string"],
  ] as const) {
    it(`refuses a token whose ${claim} is absent or the wrong type`, () => {
      for (const value of absent) {
        const v = verifyCronCaller(goodClaims({ [claim]: value }), expected, NOW);
        expect(v, `${claim} = ${JSON.stringify(value)}`).toEqual({ ok: false, reason });
      }
    });
  }

  it("refuses a token with no exp, which is the one that fails open", () => {
    for (const value of [undefined, null, "", "9999999999", Number.NaN, Infinity, -Infinity, {}]) {
      const v = verifyCronCaller(goodClaims({ exp: value }), expected, NOW);
      expect(v, `exp = ${JSON.stringify(value)}`).toEqual({
        ok: false,
        reason: "exp is missing or not a finite number",
      });
    }
  });

  it("refuses a token with no iat", () => {
    for (const value of [undefined, null, "", "123", Number.NaN, Infinity]) {
      const v = verifyCronCaller(goodClaims({ iat: value }), expected, NOW);
      expect(v, `iat = ${JSON.stringify(value)}`).toEqual({
        ok: false,
        reason: "iat is missing or not a finite number",
      });
    }
  });

  it("refuses entirely empty claims", () => {
    expect(verifyCronCaller({}, expected, NOW).ok).toBe(false);
  });
});

describe("time", () => {
  it("refuses a token that expired beyond the skew allowance", () => {
    const v = verifyCronCaller(goodClaims({ exp: nowSeconds - 61 }), expected, NOW);
    expect(v).toEqual({ ok: false, reason: "token has expired" });
  });

  it("refuses a token issued beyond the skew allowance in the future", () => {
    const v = verifyCronCaller(
      goodClaims({ iat: nowSeconds + 61, exp: nowSeconds + 4000 }),
      expected,
      NOW,
    );
    expect(v).toEqual({ ok: false, reason: "token was issued in the future" });
  });

  it("refuses a token that expires before it was issued", () => {
    const v = verifyCronCaller(
      goodClaims({ iat: nowSeconds - 10, exp: nowSeconds - 20 }),
      expected,
      NOW,
    );
    // The reason is pinned like every other test in this file. It did not used
    // to be, and the comment here used to claim "expired first, which is the
    // stronger statement" - which was simply wrong arithmetic: `now > exp + 60`
    // is `now > now + 40`, false. The security review caught it, and noted that
    // the weak assertion is exactly what let the wrong belief survive.
    expect(v).toEqual({ ok: false, reason: "token expires before it was issued" });
  });

  it("admits the exact edge of the skew allowance, in both directions", () => {
    // L3: `nowSeconds > exp + 60` admits exactly `exp + 60`, and
    // `iat - 60 > nowSeconds` admits exactly `now + 60`. The suite probed +/-30
    // and +/-61, so an off-by-one in either comparison shipped green.
    // `iat` moves with `exp` here: leaving it at the default made `iat > exp`
    // true, so the first attempt at this test was denied for the right reason at
    // the wrong boundary. That the rule caught my own bad fixture is mildly
    // reassuring about the rule.
    const atExp = goodClaims({ iat: nowSeconds - 120, exp: nowSeconds - 60 });
    expect(verifyCronCaller(atExp, expected, NOW).ok).toBe(true);
    const pastExp = goodClaims({ iat: nowSeconds - 120, exp: nowSeconds - 61 });
    expect(verifyCronCaller(pastExp, expected, NOW)).toEqual({
      ok: false,
      reason: "token has expired",
    });
    const atEdge = goodClaims({ iat: nowSeconds + 60, exp: nowSeconds + 4000 });
    expect(verifyCronCaller(atEdge, expected, NOW).ok).toBe(true);
    const pastEdge = goodClaims({ iat: nowSeconds + 61, exp: nowSeconds + 4000 });
    expect(verifyCronCaller(pastEdge, expected, NOW).ok).toBe(false);
  });

  it("uses the injected clock, not the real one", () => {
    // The whole suite would rot as the fixture dates pass if this were not true.
    const claims = goodClaims({ iat: 1_000_000, exp: 1_003_600 });
    expect(verifyCronCaller(claims, expected, new Date(1_001_000 * 1000)).ok).toBe(true);
    expect(verifyCronCaller(claims, expected, new Date(1_900_000 * 1000)).ok).toBe(false);
  });
});

describe("the reason never carries a value", () => {
  it("names the claim without echoing what arrived", () => {
    // NOS-67's lesson: a message that echoes a value turns a log into a
    // disclosure, and the rule is categorical rather than per-field.
    const secretish = "sentinel-cron-identity-value";
    const probes: TokenClaims[] = [
      goodClaims({ email: secretish }),
      goodClaims({ sub: secretish }),
      goodClaims({ aud: secretish }),
      goodClaims({ iss: secretish }),
      goodClaims({ exp: secretish }),
      goodClaims({ iat: secretish }),
    ];
    for (const claims of probes) {
      const v = verifyCronCaller(claims, expected, NOW);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).not.toContain(secretish);
    }
  });
});
