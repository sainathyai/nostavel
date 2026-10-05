import "server-only";

import { sealClaim, unsealClaim } from "@/lib/signed-claim";

// PROOF THAT THIS BROWSER IS THE ONE THAT CREATED A BOOKING.
//
// An anonymous guest has no account to own their booking with, so until now
// nothing distinguished them from a stranger who had learned the booking id
// (NOS-9). This is the missing distinction: a sealed claim, minted by
// `prepareBookingAction` in the same call that creates the row, naming the
// bookings this browser made. It grants nothing on its own -- the decision is
// `mayActOnBooking` in src/lib/booking-authz.ts, which checks it against the
// row and against the current session.
//
// WHY A COOKIE AND NOT THE URL. The checkout URL is pasted into chats, kept in
// history and handed to a referrer. A proof of ownership in it is a proof
// anyone downstream of the link also holds. httpOnly keeps it out of reach of
// page scripts as well.
//
// WHY A LIST. One browser can book more than once, and the second prepare must
// not silently revoke the first booking's proof.

export const ACCESS_COOKIE = "nv_booking_access";

/** What this claim is for. Signed into the payload; see signed-claim.ts. */
const PURPOSE = "booking-access";

// Long enough for a slow card step -- bank 3-D Secure interstitials are the
// reason this is hours and not minutes -- and short enough that it is not a
// standing key to the booking. Cancelling later does not depend on it: that
// path proves control of the booking's email address instead
// (src/lib/guest-verify.ts, and the `manage` purpose in booking-authz.ts).
export const ACCESS_TTL_SEC = 2 * 60 * 60;

// A cap, because this cookie is sent on every request to the origin and an
// uncapped list is a slow leak into all of them. Eviction is oldest-first, so
// the cap is also an over-rejection risk: a comparison shopper who clicks Book
// on more rooms than this inside the claim window loses proof of the earliest,
// and is told "Booking not found" on their own live booking. Raised from ten to
// twenty after the NOS-9 security review pointed that out: each id is a
// 36-character uuid, so twenty keeps the cookie near a kilobyte, well inside
// the 4KB limit, while putting the eviction out of reach of real browsing.
const MAX_IDS = 20;

/** Seal a claim naming exactly these booking ids. */
export function signBookingAccess(
  bookingIds: readonly string[],
  now = Date.now(),
): string {
  const ids = bookingIds
    .filter((id) => typeof id === "string" && id.length > 0)
    .slice(-MAX_IDS);
  return sealClaim(PURPOSE, ids, ACCESS_TTL_SEC, now);
}

/**
 * The booking ids a claim names. An empty array for a missing, malformed,
 * forged or expired claim, so a call site cannot accidentally treat "no proof"
 * as a different case from "bad proof".
 */
export function readBookingAccess(
  token: string | null | undefined,
  now = Date.now(),
): string[] {
  const data = unsealClaim(PURPOSE, token, now);
  if (!Array.isArray(data)) return [];
  return data
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .slice(-MAX_IDS);
}

/**
 * Add a booking to whatever claim this browser already holds, and return the
 * new claim. Re-sealing resets the expiry on the whole list, which is the
 * behaviour we want: a guest mid-checkout on their second booking should not
 * lose the first one's proof to a clock that started earlier.
 */
export function addBookingAccess(
  token: string | null | undefined,
  bookingId: string,
  now = Date.now(),
): string {
  const existing = readBookingAccess(token, now).filter(
    (id) => id !== bookingId,
  );
  return signBookingAccess([...existing, bookingId], now);
}
