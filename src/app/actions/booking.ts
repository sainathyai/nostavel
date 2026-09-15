"use server";

// Booking server actions — the client entry point into the ledger. The client
// never sets userId/contactEmail directly; we resolve the signed-in user on the
// server so a guest booking stays a guest booking and a member's booking is
// attached to their account.
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
// (never trust a client-supplied bookingId alone) — a signed-in guest can only
// cancel a booking that belongs to their own account, matching every other
// action in this file.
export async function cancelBookingAction(bookingId: string): Promise<CancelBookingResponse> {
  const ip = await clientIp();
  const rl = rateLimit(`booking-cancel:ip:${ip}`, { limit: 10, windowMs: 60_000 });
  if (!rl.ok) return { ok: false, error: TOO_MANY };

  const user = await getCurrentUser();
  if (!user?.id) return { ok: false, error: "Sign in to manage this booking." };

  const booking = await getBookingById(bookingId);
  if (!booking || booking.userId !== user.id) {
    return { ok: false, error: "Booking not found." };
  }

  try {
    const data = await cancelBooking(bookingId, { actor: "user" });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
