// Read helpers over the booking ledger. Server-only.
import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingGuests, type Booking } from "@/db/schema";

// All bookings owned by a signed-in user, newest first.
export async function getUserBookings(userId: string): Promise<Booking[]> {
  return db.select().from(bookings).where(eq(bookings.userId, userId)).orderBy(desc(bookings.createdAt));
}

// A single booking by id — used by the checkout + confirmation pages.
export async function getBookingById(bookingId: string): Promise<Booking | null> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  return rows[0] ?? null;
}

// A single booking by LiteAPI's own booking id — used by the webhook receiver
// and reconciliation, both of which only ever hear the SUPPLIER's id, never
// ours.
export async function findBookingByLiteapiId(liteapiBookingId: string): Promise<Booking | null> {
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.liteapiBookingId, liteapiBookingId))
    .limit(1);
  return rows[0] ?? null;
}

// A single booking looked up by its human ref + contact email — the guest path
// (no account needed). Both must match so a ref alone can't reveal a booking.
export async function findGuestBooking(humanRef: string, email: string): Promise<Booking | null> {
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.humanRef, humanRef.trim().toUpperCase()),
        eq(bookings.contactEmail, email.trim().toLowerCase()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Confirmed bookings whose contact email + LEAD guest last name match — the
// locate step of the guest "find my trip" flow. Used only to decide whether to
// send a verification code; the code (not this) is the security gate, and the
// caller must NOT reveal whether this returned anything (non-enumerable).
export async function findConfirmedBookingsByEmailAndLastName(
  email: string,
  lastName: string,
): Promise<Booking[]> {
  const rows = await db
    .select({ booking: bookings })
    .from(bookings)
    .innerJoin(bookingGuests, eq(bookingGuests.bookingId, bookings.id))
    .where(
      and(
        eq(bookings.contactEmail, email.trim().toLowerCase()),
        eq(bookings.status, "confirmed"),
        eq(bookingGuests.isLead, true),
        sql`lower(${bookingGuests.lastName}) = ${lastName.trim().toLowerCase()}`,
      ),
    )
    .orderBy(desc(bookings.createdAt));
  // Dedupe by id (defensive — one lead per booking, but joins can surprise).
  const seen = new Set<string>();
  const out: Booking[] = [];
  for (const r of rows) {
    if (seen.has(r.booking.id)) continue;
    seen.add(r.booking.id);
    out.push(r.booking);
  }
  return out;
}

// All confirmed bookings for a verified email — the guest trips list shown
// AFTER the one-time code has been verified.
export async function getConfirmedBookingsByEmail(email: string): Promise<Booking[]> {
  return db
    .select()
    .from(bookings)
    .where(and(eq(bookings.contactEmail, email.trim().toLowerCase()), eq(bookings.status, "confirmed")))
    .orderBy(desc(bookings.createdAt));
}
