import { beforeAll, describe, expect, it } from "vitest";

import { mayActOnBooking } from "./booking-authz";
import { signBookingAccess } from "./booking-access";
import { createChallenge, createVerifiedSession, readVerifiedEmail } from "./guest-verify";
import { signQuote } from "./quote-token";

// FOUR SIGNED FORMATS, ONE KEY. The challenge cookie, the verified cookie, the
// quote token and the booking access claim are all "base64url(JSON) . HMAC-SHA256
// over AUTH_SECRET". guest-verify's `crypto.subtle` HMAC and quote-token's
// `node:crypto` HMAC are byte-identical over the same body, so every one of these
// verifies as every other. Nothing but the payload's own field names
// distinguishes them, and two of the four share field names.
//
// Found by the security-architect review of PR #33 (NOS-9). The read half was
// already on main; what NOS-9 added was a grant that turns it into a write.
beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-do-not-use-anywhere-real";
});

describe("a verified-email cookie must come from the code flow and nothing else", () => {
  it("does not accept the challenge cookie as proof of the email", async () => {
    // THE ESCALATION. `requestGuestCode` sets the challenge cookie in the
    // REQUESTER's browser and emails the code to the address on the booking. So
    // anyone who knows a guest's email and lead last name is handed a sealed
    // token naming that address - and the challenge payload is a superset of
    // the verified payload, with `e` and `x` meaning the same thing. Accepting
    // it skips the one-time code entirely.
    const challenge = await createChallenge("victim@example.com", "123456");
    expect(await readVerifiedEmail(challenge)).toBeNull();
  });

  it("still accepts a real verified session", async () => {
    expect(await readVerifiedEmail(await createVerifiedSession("guest@example.com"))).toBe(
      "guest@example.com",
    );
  });

  it("does not accept a quote token, whose `e` is an expiry number, not an email", async () => {
    expect(await readVerifiedEmail(signQuote("member"))).toBeNull();
  });

  it("does not accept a booking access claim", async () => {
    expect(await readVerifiedEmail(signBookingAccess(["bkg_1"]))).toBeNull();
  });

  it("rejects a payload whose expiry is missing or not a number, rather than failing open", async () => {
    // `Date.now() > undefined` is false, so an absent expiry read as "not yet
    // expired". Every comparison against NaN is false, which makes a
    // fail-closed check look like a fail-open one.
    expect(await readVerifiedEmail(signQuote("public"))).toBeNull();
  });
});

describe("the authorization rule decides; it does not throw", () => {
  it("refuses a non-string verified email instead of raising a TypeError", () => {
    // `mayActOnBooking`'s contract is deny-by-default. A throw is neither allow
    // nor deny, and it crosses the server-action boundary, which
    // docs/conventions.md section 1 forbids.
    const caller = { userId: null, accessIds: [], verifiedEmail: 1760000000 as unknown as string };
    const booking = { id: "bkg_1", userId: null, contactEmail: "guest@example.com" };
    expect(() => mayActOnBooking(caller, booking, "manage")).not.toThrow();
    expect(mayActOnBooking(caller, booking, "manage").ok).toBe(false);
  });

  it("refuses the other shapes a bad cookie can produce", () => {
    const booking = { id: "bkg_1", userId: null, contactEmail: "guest@example.com" };
    for (const bad of [{}, [], true, 0, NaN, { e: "guest@example.com" }]) {
      const caller = { userId: null, accessIds: [], verifiedEmail: bad as unknown as string };
      expect(() => mayActOnBooking(caller, booking, "manage")).not.toThrow();
      expect(mayActOnBooking(caller, booking, "manage").ok).toBe(false);
    }
  });
});
