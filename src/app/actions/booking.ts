"use server";

// Booking server actions — the client entry point into the ledger. The client
// never sets userId/contactEmail directly; we resolve the signed-in user on the
// server so a guest booking stays a guest booking and a member's booking is
// attached to their account.
import { getCurrentUser } from "@/lib/dal";
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
export type PrepareBookingArgs = Omit<PrepareInput, "userId" | "contactEmail">;

export type PrepareBookingResponse =
  | { ok: true; data: PrepareResult }
  | { ok: false; error: string };

export async function prepareBookingAction(
  args: PrepareBookingArgs,
): Promise<PrepareBookingResponse> {
  const user = await getCurrentUser();
  // Rate parity: a signed-in member pays the net rate; an anonymous guest can
  // still check out, but is charged the public (SSP) rate, never the net rate —
  // enforced in prepareBooking (server-only), not just hidden in the UI.
  try {
    const data = await prepareBooking({
      ...args,
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
