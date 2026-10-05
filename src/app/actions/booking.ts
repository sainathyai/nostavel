"use server";

// Booking server actions — the client entry point into the ledger. The client
// never sets userId/contactEmail directly; we resolve the signed-in user on the
// server so a guest booking stays a guest booking and a member's booking is
// attached to their account.
import { cookies } from "next/headers";
import { ACCESS_COOKIE, ACCESS_TTL_SEC, addBookingAccess } from "@/lib/booking-access";
import { mayActOnBooking, type Purpose } from "@/lib/booking-authz";
import { resolveCaller } from "@/lib/booking-caller";
import { getCurrentUser } from "@/lib/dal";
import { quoteMatchesSession } from "@/lib/quote-token";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import {
  prepareBooking,
  confirmBooking,
  saveBookingGuest,
  cancelBooking,
  type PrepareInput,
  type PrepareResult,
  type ConfirmResult,
  type GuestInput,
  type CancelBookingResult,
} from "@/lib/booking-service";
import { getBookingById } from "@/lib/bookings";

// Every action here either costs a real LiteAPI supplier call (prepare,
// confirm) or writes to the ledger (guest details). Placeholder limits — no
// traffic to measure against yet, since there's no deploy — tune once real
// numbers exist (docs/conventions.md section 5).
const TOO_MANY = "Too many attempts. Wait a moment and try again.";

// NON-ENUMERABLE BY DESIGN. One message for "no such booking" and for "not
// yours", because two messages would turn these actions into an oracle that
// confirms a guessed booking id exists. `findGuestBooking` in src/lib/bookings.ts
// already holds this line for the same reason.
const NOT_FOUND = "Booking not found.";

/**
 * May the caller act on this booking? (NOS-9.)
 *
 * Resolves the caller server-side, loads the row, and defers the decision to
 * the pure rule in src/lib/booking-authz.ts.
 *
 * Returns only the verdict. An earlier version handed back the row "so a caller
 * does not fetch it twice", which was not true of any call site: each service
 * function does its own fresh `select`, and should, because it needs the row as
 * it is at the moment it writes. Keeping the duplicate query and dropping the
 * claim is the honest version.
 *
 * Both halves run unconditionally, in parallel, so a booking id that does not
 * exist and one that is not yours cost the same work. Sequencing this - bailing
 * out before resolving the caller - would make the two measurably different.
 */
async function authorize(
  bookingId: string,
  purpose: Purpose,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [caller, booking] = await Promise.all([resolveCaller(), getBookingById(bookingId)]);
  if (!booking) return { ok: false, error: NOT_FOUND };
  if (!mayActOnBooking(caller, booking, purpose).ok) return { ok: false, error: NOT_FOUND };
  return { ok: true };
}

// The client supplies the selection snapshot + an idempotency key; the server
// fills identity.
export type PrepareBookingArgs = Omit<PrepareInput, "userId" | "contactEmail"> & {
  /**
   * Proof of the tier the page holding these offerIds was priced at, issued by
   * the same server render that chose the margin. See src/lib/quote-token.ts.
   */
  quoteToken: string;
};

export type PrepareBookingResponse =
  | { ok: true; data: PrepareResult }
  | { ok: false; error: string };

export async function prepareBookingAction(
  args: PrepareBookingArgs,
): Promise<PrepareBookingResponse> {
  const ip = await clientIp();
  const rl = rateLimit(`booking-prepare:ip:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) return { ok: false, error: TOO_MANY };

  const user = await getCurrentUser();

  // TIER GUARD. `args.offerId` was priced by LiteAPI at whichever margin the
  // rendering session implied, and nothing in the offerId itself reveals which.
  // Without this check, a page rendered while signed in keeps its member-priced
  // offerIds after a sign-out in another tab, and booking one of them would
  // record userId=null against a member price — which the checkout identity
  // guard cannot catch, because null === null.
  if (!quoteMatchesSession(args.quoteToken, Boolean(user))) {
    return {
      ok: false,
      error:
        "Your prices are out of date because your sign-in changed. Refresh this page to see current rates.",
    };
  }

  // Rate parity: a signed-in member pays the net rate; an anonymous guest can
  // still check out, but is charged the public (SSP) rate, never the net rate —
  // enforced in prepareBooking (server-only), not just hidden in the UI.
  try {
    // The token is proof for THIS call, not part of the ledger record, so it
    // is dropped rather than snapshotted.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { quoteToken, ...selection } = args;
    const data = await prepareBooking({
      ...selection,
      userId: user?.id ?? null,
      contactEmail: user?.email ?? null,
    });

    // PROOF OF HAVING CREATED THIS BOOKING, minted in the same call that
    // creates it. Without it an anonymous guest is indistinguishable from a
    // stranger who has learned the booking id, which is what let anyone drive
    // save-guest and confirm before NOS-9. A member does not need it - their
    // session is the proof - but it costs nothing and keeps one code path.
    const jar = await cookies();
    jar.set(ACCESS_COOKIE, addBookingAccess(jar.get(ACCESS_COOKIE)?.value, data.bookingId), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: ACCESS_TTL_SEC,
    });

    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type SaveGuestResponse = { ok: true } | { ok: false; error: string };

// Persist the lead guest before payment. Called from the checkout page.
export async function saveGuestAction(input: GuestInput): Promise<SaveGuestResponse> {
  const ip = await clientIp();
  const rl = rateLimit(`booking-guest:ip:${ip}`, { limit: 20, windowMs: 60_000 });
  if (!rl.ok) return { ok: false, error: TOO_MANY };

  // Overwriting the lead guest on someone else's held rate was free before
  // NOS-9: this action read a bookingId from the client and trusted it.
  const auth = await authorize(input.bookingId, "checkout");
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    await saveBookingGuest(input);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type ConfirmBookingResponse =
  | { ok: true; data: ConfirmResult }
  | { ok: false; error: string };

// Finalizes a prepared booking on the returnUrl. The bookingId scopes the row;
// the guest + transaction were already stored, so no other input is needed.
export async function confirmBookingAction(bookingId: string): Promise<ConfirmBookingResponse> {
  const ip = await clientIp();
  const rl = rateLimit(`booking-confirm:ip:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) return { ok: false, error: TOO_MANY };

  // This one spends money: `confirmBooking` calls the supplier's `book()`.
  // Before NOS-9 any caller could fire it against any held rate.
  const auth = await authorize(bookingId, "checkout");
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const data = await confirmBooking({ bookingId });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type CancelBookingResponse =
  | { ok: true; data: CancelBookingResult }
  | { ok: false; error: string };

// Guest-initiated cancellation from /trips. Identity is resolved server-side
// (never trust a client-supplied bookingId alone): a member can cancel their
// own account's booking, and a guest with no account can cancel a booking they
// have proved is theirs.
export async function cancelBookingAction(bookingId: string): Promise<CancelBookingResponse> {
  const ip = await clientIp();
  const rl = rateLimit(`booking-cancel:ip:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) return { ok: false, error: TOO_MANY };

  // `manage`, not `checkout`: a guest may cancel long after the checkout claim
  // has expired, so this purpose also accepts proof of control over the
  // booking's own email address (the /find one-time-code flow). Before NOS-9
  // this action demanded a session, which meant a guest who booked without an
  // account could never cancel their own booking at all.
  const auth = await authorize(bookingId, "manage");
  if (!auth.ok) return { ok: false, error: auth.error };

  try {
    const data = await cancelBooking(bookingId, { actor: "user" });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
