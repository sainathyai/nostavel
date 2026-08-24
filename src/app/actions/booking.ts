"use server";

// Booking server actions — the client entry point into the ledger. The client
// never sets userId/contactEmail directly; we resolve the signed-in user on the
// server so a guest booking stays a guest booking and a member's booking is
// attached to their account.
import { getCurrentUser } from "@/lib/dal";
import { quoteMatchesSession } from "@/lib/quote-token";
import {
  prepareBooking,
  confirmBooking,
  saveBookingGuest,
  type PrepareInput,
  type PrepareResult,
  type ConfirmResult,
  type GuestInput,
} from "@/lib/booking-service";

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
  try {
    const data = await confirmBooking({ bookingId });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
