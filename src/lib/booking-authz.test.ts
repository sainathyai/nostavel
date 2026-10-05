import { describe, expect, it } from "vitest";

import {
  mayActOnBooking,
  mintedInThisBrowser,
  type BookingIdentity,
  type Caller,
} from "./booking-authz";

const MEMBER_A = "user_aaa";
const MEMBER_B = "user_bbb";
const BOOKING = "bkg_1111";
const OTHER_BOOKING = "bkg_2222";

const nobody: Caller = { userId: null, accessIds: [], verifiedEmail: null };

const memberBooking: BookingIdentity = {
  id: BOOKING,
  userId: MEMBER_A,
  contactEmail: "a@example.com",
};
const guestBooking: BookingIdentity = {
  id: BOOKING,
  userId: null,
  contactEmail: "guest@example.com",
};

describe("a member's own booking", () => {
  it("lets the member who owns it act, for both purposes", () => {
    const caller = { ...nobody, userId: MEMBER_A };
    expect(mayActOnBooking(caller, memberBooking, "checkout")).toEqual({
      ok: true,
      via: "session",
    });
    expect(mayActOnBooking(caller, memberBooking, "manage")).toEqual({
      ok: true,
      via: "session",
    });
  });

  it("refuses a different signed-in member", () => {
    const caller = { ...nobody, userId: MEMBER_B };
    expect(mayActOnBooking(caller, memberBooking, "checkout").ok).toBe(false);
    expect(mayActOnBooking(caller, memberBooking, "manage").ok).toBe(false);
  });

  it("refuses a signed-out visitor", () => {
    expect(mayActOnBooking(nobody, memberBooking, "checkout").ok).toBe(false);
  });

  it("refuses an access claim that names it", () => {
    // Signing out and reusing the cookie minted while signed in would otherwise
    // walk around the checkout page's tier guard.
    const caller = { ...nobody, accessIds: [BOOKING] };
    expect(mayActOnBooking(caller, memberBooking, "checkout").ok).toBe(false);
    expect(mayActOnBooking(caller, memberBooking, "manage").ok).toBe(false);
  });

  it("refuses a verified email that matches the booking's contact address", () => {
    // Whoever controls the mailbox is not necessarily the account holder, and a
    // member's booking is the account's.
    const caller = { ...nobody, verifiedEmail: "a@example.com" };
    expect(mayActOnBooking(caller, memberBooking, "manage").ok).toBe(false);
  });
});

describe("an anonymous booking", () => {
  it("lets the browser that created it act, for both purposes", () => {
    const caller = { ...nobody, accessIds: [BOOKING] };
    expect(mayActOnBooking(caller, guestBooking, "checkout")).toEqual({
      ok: true,
      via: "access-claim",
    });
    expect(mayActOnBooking(caller, guestBooking, "manage")).toEqual({
      ok: true,
      via: "access-claim",
    });
  });

  it("refuses a visitor holding nothing but the id", () => {
    // THE BUG THIS RULE EXISTS FOR. Both sides are null here, so the obvious
    // `booking.userId === caller.userId` compare would return true and hand a
    // stranger someone else's checkout.
    expect(mayActOnBooking(nobody, guestBooking, "checkout").ok).toBe(false);
    expect(mayActOnBooking(nobody, guestBooking, "manage").ok).toBe(false);
  });

  it("refuses a claim for a different booking", () => {
    const caller = { ...nobody, accessIds: [OTHER_BOOKING] };
    expect(mayActOnBooking(caller, guestBooking, "checkout").ok).toBe(false);
  });

  it("refuses a signed-in member who holds no claim for it", () => {
    const caller = { ...nobody, userId: MEMBER_A };
    expect(mayActOnBooking(caller, guestBooking, "checkout").ok).toBe(false);
  });

  it("accepts a claim listing several bookings, including this one", () => {
    const caller = {
      ...nobody,
      accessIds: [OTHER_BOOKING, BOOKING, "bkg_3333"],
    };
    expect(mayActOnBooking(caller, guestBooking, "checkout").ok).toBe(true);
  });
});

describe("cancelling without an account, later", () => {
  it("accepts a verified email matching the booking, to manage but not to check out", () => {
    const caller = { ...nobody, verifiedEmail: "guest@example.com" };
    expect(mayActOnBooking(caller, guestBooking, "manage")).toEqual({
      ok: true,
      via: "verified-email",
    });
    // Narrower on purpose: nothing in the checkout flow needs this grant.
    expect(mayActOnBooking(caller, guestBooking, "checkout").ok).toBe(false);
  });

  it("ignores case and surrounding space, because the two sides are stored by different code paths", () => {
    const caller = { ...nobody, verifiedEmail: "  GUEST@Example.com " };
    expect(mayActOnBooking(caller, guestBooking, "manage").ok).toBe(true);
  });

  it("refuses a verified email for a different address", () => {
    const caller = { ...nobody, verifiedEmail: "someone@example.com" };
    expect(mayActOnBooking(caller, guestBooking, "manage").ok).toBe(false);
  });

  it("refuses when the booking has no contact address to compare against", () => {
    // An empty or null address must not match an empty or null claim.
    const caller = { ...nobody, verifiedEmail: "" };
    expect(
      mayActOnBooking(caller, { ...guestBooking, contactEmail: null }, "manage")
        .ok,
    ).toBe(false);
    expect(
      mayActOnBooking(
        { ...nobody, verifiedEmail: null },
        { ...guestBooking, contactEmail: null },
        "manage",
      ).ok,
    ).toBe(false);
    expect(
      mayActOnBooking(
        { ...nobody, verifiedEmail: "x@example.com" },
        { ...guestBooking, contactEmail: null },
        "manage",
      ).ok,
    ).toBe(false);
  });
});

describe("telling the browser that started a booking from a stranger", () => {
  it("recognizes a member's own booking in the browser that created it, even signed out", () => {
    // The checkout page needs this to send a member whose session ended back to
    // re-price, rather than telling them their own booking does not exist.
    // Found by the code review of PR #33.
    const caller = { ...nobody, accessIds: [BOOKING] };
    expect(mintedInThisBrowser(caller, memberBooking)).toBe(true);
    // And it is emphatically not an authorization answer.
    expect(mayActOnBooking(caller, memberBooking, "checkout").ok).toBe(false);
  });

  it("does not recognize a stranger holding only the id", () => {
    expect(mintedInThisBrowser(nobody, memberBooking)).toBe(false);
    expect(mintedInThisBrowser({ ...nobody, userId: MEMBER_B }, memberBooking)).toBe(false);
    expect(mintedInThisBrowser({ ...nobody, verifiedEmail: "a@example.com" }, memberBooking)).toBe(false);
  });

  it("does not recognize a claim for a different booking", () => {
    expect(mintedInThisBrowser({ ...nobody, accessIds: [OTHER_BOOKING] }, memberBooking)).toBe(false);
  });
});
