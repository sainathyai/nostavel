import { createHmac } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { quoteMatchesSession, readQuote, signQuote } from "./quote-token";

// The module refuses to sign without a secret, which is itself a behaviour
// under test further down.
beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-do-not-use-anywhere-real";
});

const T0 = Date.UTC(2026, 7, 22, 12, 0, 0);
const MIN = 60_000;

describe("signQuote / readQuote", () => {
  it("round-trips both tiers", () => {
    expect(readQuote(signQuote("member", T0), T0)).toBe("member");
    expect(readQuote(signQuote("public", T0), T0)).toBe("public");
  });

  it("produces a token small enough to be worth carrying", () => {
    // The whole reason this exists rather than a stored offer set: measured
    // 2026-08-22, one search returns 276 offerIds at ~1200 bytes each.
    expect(signQuote("member", T0).length).toBeLessThan(200);
  });

  it("survives right up to expiry and not past it", () => {
    const t = signQuote("member", T0);
    expect(readQuote(t, T0 + 29 * MIN)).toBe("member");
    expect(readQuote(t, T0 + 31 * MIN)).toBeNull();
  });

  it("rejects a token whose payload was edited", () => {
    // The attack this is for: take a public token, rewrite the tier to member.
    const forged = Buffer.from(JSON.stringify({ t: "member", e: 9_999_999_999 })).toString(
      "base64url",
    );
    const real = signQuote("public", T0);
    const stolenSig = real.slice(real.indexOf(".") + 1);
    expect(readQuote(`${forged}.${stolenSig}`, T0)).toBeNull();
  });

  it("rejects a signature from a different secret", () => {
    const t = signQuote("member", T0);
    const before = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "a-different-secret";
    expect(readQuote(t, T0)).toBeNull();
    process.env.AUTH_SECRET = before;
  });

  it("rejects anything malformed rather than throwing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "no-dot",
      ".onlysig",
      "onlypayload.",
      "!!!.???",
      signQuote("member", T0).replace(".", ".x"),
      Buffer.from("not json").toString("base64url") + ".sig",
    ]) {
      expect(readQuote(bad as string | null, T0)).toBeNull();
    }
  });

  it("rejects a VALIDLY SIGNED payload that claims an unknown tier", () => {
    // Signed with the real secret, so the signature check passes and only the
    // tier check can reject it. A build that does not know a future tier name
    // must refuse it rather than treat it as one it does know.
    const payload = Buffer.from(JSON.stringify({ t: "staff", e: 9_999_999_999 })).toString(
      "base64url",
    );
    const sig = createHmac("sha256", process.env.AUTH_SECRET!)
      .update(payload)
      .digest("base64url");
    // Sanity: this signature really is accepted for a well-formed payload.
    const ok = Buffer.from(JSON.stringify({ t: "member", e: 9_999_999_999 })).toString("base64url");
    const okSig = createHmac("sha256", process.env.AUTH_SECRET!).update(ok).digest("base64url");
    expect(readQuote(`${ok}.${okSig}`, T0)).toBe("member");

    expect(readQuote(`${payload}.${sig}`, T0)).toBeNull();
  });

  it("refuses to sign at all with no secret configured", () => {
    const before = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    // Loud on the issuing side...
    expect(() => signQuote("member", T0)).toThrow(/AUTH_SECRET/);
    // ...and a plain "no" on the reading side, never a 500 on a guest's click.
    expect(readQuote("anything.atall", T0)).toBeNull();
    process.env.AUTH_SECRET = before;
  });
});

describe("quoteMatchesSession", () => {
  const member = () => signQuote("member", T0);
  const pub = () => signQuote("public", T0);

  it("accepts a token that still matches who is asking", () => {
    expect(quoteMatchesSession(member(), true, T0)).toBe(true);
    expect(quoteMatchesSession(pub(), false, T0)).toBe(true);
  });

  it("rejects a member page used by a signed-out visitor", () => {
    // THE LEAK. Sign in, open a stay page, sign out in another tab, click Book.
    // The offerIds in that page are member-priced; the session is not.
    expect(quoteMatchesSession(member(), false, T0)).toBe(false);
  });

  it("rejects a public page used by a member", () => {
    // The other direction costs the GUEST, which is ours to fix rather than
    // theirs to absorb, so it is refused just as firmly.
    expect(quoteMatchesSession(pub(), true, T0)).toBe(false);
  });

  it("rejects an expired token even when the tier is right", () => {
    expect(quoteMatchesSession(member(), true, T0 + 31 * MIN)).toBe(false);
  });

  it("rejects a missing token outright, never defaulting to a tier", () => {
    // A caller that sends nothing must not be treated as either tier by
    // accident. Absent proof is not proof of the cheap side or the dear side.
    expect(quoteMatchesSession(null, true, T0)).toBe(false);
    expect(quoteMatchesSession(null, false, T0)).toBe(false);
    expect(quoteMatchesSession(undefined, false, T0)).toBe(false);
  });
});
