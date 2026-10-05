import { beforeEach, describe, expect, it, vi } from "vitest";

// THE WIRING, NOT THE RULE. src/lib/booking-authz.test.ts proves the decision;
// this proves the three actions actually ask it, with the caller resolved from
// the session and the cookie jar rather than from anything the client sent.
// A perfect rule nobody calls is the shape this bug had in the first place
// (NOS-9): `saveGuestAction` and `confirmBookingAction` had no check at all.

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
  }),
}));

const currentUser = { id: null as string | null };
vi.mock("@/lib/dal", () => ({
  getCurrentUser: async () =>
    currentUser.id ? { id: currentUser.id, email: "m@example.com" } : null,
}));

const row = {
  id: "bkg_1",
  userId: null as string | null,
  contactEmail: "guest@example.com",
};
vi.mock("@/lib/bookings", () => ({
  getBookingById: async (id: string) => (id === row.id ? row : null),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true, remaining: 9 }),
  clientIp: async () => "203.0.113.1",
}));

const saveBookingGuest = vi.fn(async () => undefined);
const confirmBooking = vi.fn(async () => ({ bookingId: "bkg_1" }));
const cancelBooking = vi.fn(async () => ({ bookingId: "bkg_1" }));
const prepareBooking = vi.fn(async () => ({ bookingId: "bkg_1", status: "prebooked" }));
vi.mock("@/lib/booking-service", () => ({
  saveBookingGuest: (...a: unknown[]) => saveBookingGuest(...(a as [])),
  confirmBooking: (...a: unknown[]) => confirmBooking(...(a as [])),
  cancelBooking: (...a: unknown[]) => cancelBooking(...(a as [])),
  prepareBooking: (...a: unknown[]) => prepareBooking(...(a as [])),
}));

process.env.AUTH_SECRET = "test-secret-do-not-use-anywhere-real";

const { ACCESS_COOKIE, readBookingAccess, signBookingAccess } = await import(
  "@/lib/booking-access"
);
const { VERIFIED_COOKIE, createVerifiedSession } = await import("@/lib/guest-verify");
const { signQuote } = await import("@/lib/quote-token");
const { cancelBookingAction, confirmBookingAction, prepareBookingAction, saveGuestAction } =
  await import("./booking");

const guest = { bookingId: "bkg_1", firstName: "A", lastName: "B", email: "guest@example.com" };

// One wording for "no such booking" and for "not yours", so neither action can
// be used to confirm that a guessed id is real.
const NOT_FOUND = "Booking not found.";

beforeEach(() => {
  jar.clear();
  currentUser.id = null;
  row.userId = null;
  row.contactEmail = "guest@example.com";
  vi.clearAllMocks();
});

describe("a visitor holding nothing but the booking id", () => {
  it("cannot save guest details", async () => {
    expect(await saveGuestAction(guest)).toEqual({ ok: false, error: NOT_FOUND });
    expect(saveBookingGuest).not.toHaveBeenCalled();
  });

  it("cannot trigger the supplier booking call", async () => {
    expect(await confirmBookingAction("bkg_1")).toEqual({ ok: false, error: NOT_FOUND });
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it("cannot cancel", async () => {
    expect(await cancelBookingAction("bkg_1")).toEqual({ ok: false, error: NOT_FOUND });
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("gets the same answer for an id that does not exist at all", async () => {
    expect(await confirmBookingAction("bkg_nope")).toEqual({ ok: false, error: NOT_FOUND });
  });
});

describe("the guest who created the booking, with no account", () => {
  beforeEach(() => {
    jar.set(ACCESS_COOKIE, signBookingAccess(["bkg_1"]));
  });

  it("saves guest details and confirms, without being asked to sign in", async () => {
    // THE REGRESSION GUARD THAT MATTERS. A fix that turned anonymous checkout
    // into a forced sign-up would pass every rejection test above.
    expect(await saveGuestAction(guest)).toEqual({ ok: true });
    expect(saveBookingGuest).toHaveBeenCalledWith(guest);
    expect((await confirmBookingAction("bkg_1")).ok).toBe(true);
    expect(confirmBooking).toHaveBeenCalledWith({ bookingId: "bkg_1" });
  });

  it("can cancel in the same sitting", async () => {
    expect((await cancelBookingAction("bkg_1")).ok).toBe(true);
    expect(cancelBooking).toHaveBeenCalledWith("bkg_1", { actor: "user" });
  });

  it("is refused once the claim has expired", async () => {
    jar.set(ACCESS_COOKIE, signBookingAccess(["bkg_1"], Date.now() - 48 * 3600 * 1000));
    expect((await confirmBookingAction("bkg_1")).ok).toBe(false);
    expect(confirmBooking).not.toHaveBeenCalled();
  });

  it("is refused when the claim names a different booking", async () => {
    jar.set(ACCESS_COOKIE, signBookingAccess(["bkg_someone_else"]));
    expect((await saveGuestAction(guest)).ok).toBe(false);
    expect(saveBookingGuest).not.toHaveBeenCalled();
  });
});

describe("cancelling later, without an account", () => {
  it("accepts proof of control over the address on the booking", async () => {
    // No access claim at all — this is the guest coming back through /find days
    // later, which before NOS-9 was impossible: the action demanded a session.
    jar.set(VERIFIED_COOKIE, await createVerifiedSession("guest@example.com"));
    expect((await cancelBookingAction("bkg_1")).ok).toBe(true);
    expect(cancelBooking).toHaveBeenCalled();
  });

  it("does not accept a verified address for a different booking's guest", async () => {
    jar.set(VERIFIED_COOKIE, await createVerifiedSession("someone@example.com"));
    expect((await cancelBookingAction("bkg_1")).ok).toBe(false);
    expect(cancelBooking).not.toHaveBeenCalled();
  });

  it("does not let a verified address drive checkout", async () => {
    jar.set(VERIFIED_COOKIE, await createVerifiedSession("guest@example.com"));
    expect((await confirmBookingAction("bkg_1")).ok).toBe(false);
  });
});

describe("a member's booking", () => {
  beforeEach(() => {
    row.userId = "user_a";
    row.contactEmail = "m@example.com";
  });

  it("is still cancellable by that member, exactly as before", async () => {
    currentUser.id = "user_a";
    expect((await cancelBookingAction("bkg_1")).ok).toBe(true);
  });

  it("is not reachable by a different signed-in member", async () => {
    currentUser.id = "user_b";
    expect((await saveGuestAction(guest)).ok).toBe(false);
    expect((await confirmBookingAction("bkg_1")).ok).toBe(false);
    expect((await cancelBookingAction("bkg_1")).ok).toBe(false);
  });

  it("is not reachable with an access claim after signing out", async () => {
    currentUser.id = null;
    jar.set(ACCESS_COOKIE, signBookingAccess(["bkg_1"]));
    expect((await confirmBookingAction("bkg_1")).ok).toBe(false);
  });
});

describe("prepare mints the proof", () => {
  const args = () =>
    ({ quoteToken: signQuote("public"), idempotencyKey: "k" }) as Parameters<
      typeof prepareBookingAction
    >[0];

  it("writes a claim naming the new booking", async () => {
    expect((await prepareBookingAction(args())).ok).toBe(true);
    expect(readBookingAccess(jar.get(ACCESS_COOKIE))).toEqual(["bkg_1"]);
  });

  it("leaves an earlier booking's claim in place", async () => {
    jar.set(ACCESS_COOKIE, signBookingAccess(["bkg_earlier"]));
    await prepareBookingAction(args());
    expect(readBookingAccess(jar.get(ACCESS_COOKIE))).toEqual(["bkg_earlier", "bkg_1"]);
  });
});
