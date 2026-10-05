// WHO MAY ACT ON A BOOKING. A pure rule: no database, no cookie jar, no clock.
// The wiring that fetches a session, reads the sealed access claim and loads the
// row lives in the server actions and pages; this file only decides.
//
// THE HOLE THIS FILLS (NOS-9). `saveGuestAction` and `confirmBookingAction`
// performed no ownership check of any kind, so anyone who learned a bookingId
// could overwrite its lead guest before payment, or trigger the supplier's
// `book()` call against someone else's held rate. `cancelBookingAction` did
// check, but only against a session, so a guest who booked without an account
// could never cancel their own booking.
//
// WHY A NULL COMPARE IS NOT A CHECK. The obvious shape,
// `booking.userId === caller.userId`, is true when BOTH are null -- which is
// every anonymous booking against every anonymous visitor. The same `null ===
// null` trap already caught us in the checkout page's tier guard
// (src/lib/quote-token.ts). So the session path below demands a non-null
// `booking.userId` before it compares anything, and an anonymous booking is
// reachable only by presenting a claim that names it.

/**
 * What the caller is holding. All three are resolved server-side; none of them
 * is ever read from the request body.
 */
export type Caller = {
  /** The signed-in user's id, or null for an anonymous visitor. */
  userId: string | null;
  /**
   * Booking ids named by this browser's sealed access claim -- the proof that
   * this browser is the one that created those bookings. See
   * src/lib/booking-access.ts.
   */
  accessIds: readonly string[];
  /**
   * An address this browser proved it controls through the /find one-time-code
   * flow (src/lib/guest-verify.ts), or null.
   */
  verifiedEmail: string | null;
};

/** Only the identity fields of a booking row. Deliberately not the whole row. */
export type BookingIdentity = {
  id: string;
  userId: string | null;
  contactEmail: string | null;
};

/**
 * `checkout` covers the actions that finish a booking in the same sitting
 * (guest details, confirm). `manage` covers acting on a booking later, which a
 * guest may reach long after the checkout claim has expired.
 */
export type Purpose = "checkout" | "manage";

/** How access was granted, so a caller can log it and a test can be specific. */
export type Grant = "session" | "access-claim" | "verified-email";

export type Decision = { ok: true; via: Grant } | { ok: false };

const DENY: Decision = { ok: false };

function sameEmail(a: string | null, b: string | null): boolean {
  // `typeof`, not just `!a`. This is reached with whatever a cookie produced,
  // and a signed token whose shape nobody checked can hand back a truthy
  // NUMBER - at which point `.trim()` throws, and this rule neither allows nor
  // denies, across a server-action boundary that must not throw
  // (docs/conventions.md section 1). Deny-by-default has to include "I was
  // handed something that is not an email". Found by the NOS-9 security review.
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * May this caller act on this booking?
 *
 * Deny is the default: every path below is an explicit grant, so a field we
 * forget to consider refuses rather than waves through.
 */
export function mayActOnBooking(
  caller: Caller,
  booking: BookingIdentity,
  purpose: Purpose,
): Decision {
  // A MEMBER'S BOOKING belongs to that member's session and to nothing else.
  // Note the non-null demand on both sides before the compare.
  if (booking.userId !== null) {
    if (caller.userId !== null && caller.userId === booking.userId) {
      return { ok: true, via: "session" };
    }
    // Deliberately no fallback. A claim or a verified email must not reach a
    // member's booking: signing out and reusing a cookie would otherwise walk
    // around the checkout page's tier guard, and a shared email address would
    // reach an account that is not the caller's.
    return DENY;
  }

  // AN ANONYMOUS BOOKING. The claim is the proof of having created it, and it
  // has to name this exact booking -- a claim for one booking presented against
  // another is no proof at all.
  if (caller.accessIds.includes(booking.id)) {
    return { ok: true, via: "access-claim" };
  }

  // LATER, WITHOUT AN ACCOUNT. The checkout claim is short-lived by design, so
  // cancelling next week cannot depend on it. Proving control of the address on
  // the booking is the same standard /find already applies to showing the
  // booking at all, and it is not offered for `checkout`: nothing in the
  // checkout flow needs it, and the narrower grant is the safer one.
  if (
    purpose === "manage" &&
    sameEmail(caller.verifiedEmail, booking.contactEmail)
  ) {
    return { ok: true, via: "verified-email" };
  }

  return DENY;
}
