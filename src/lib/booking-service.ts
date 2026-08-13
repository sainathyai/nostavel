// Booking ledger service (server-only). Turns a room selection into a durable
// ledger row and advances it through the lifecycle. LiteAPI is the source of
// truth for status; here we snapshot everything at each step so a past record is
// never corrupted by later supplier changes.
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  bookings,
  bookingEvents,
  bookingGuests,
  payments,
  type NewBooking,
} from "@/db/schema";
import { prebook, book } from "@/lib/liteapi";
import { sendBookingConfirmation } from "@/lib/email";
import { memberPrice, guestPrice } from "@/lib/pricing";
import { makeRef, extractCancellation } from "@/lib/booking-format";

export type HotelSnapshot = {
  name: string;
  city: string;
  address?: string;
  image?: string | null;
  stars?: number;
};

export type RoomSnapshot = {
  title: string;
  beds?: string;
  board?: string;
  image?: string | null;
  amenities?: string[];
  sleeps?: number;
  themMinor?: number | null; // Booking.com comparison price (for the price-beat)
};

export type PrepareInput = {
  // Client-generated, stable per "Book" click — the idempotency guard.
  idempotencyKey: string;
  userId: string | null;
  contactEmail: string | null;
  hotelId: string;
  offerId: string;
  hotel: HotelSnapshot;
  room: RoomSnapshot;
  checkinDate: string; // yyyy-mm-dd
  checkoutDate: string;
  nights: number;
  adults: number;
  currency: string;
};

export type PrepareResult = {
  bookingId: string;
  humanRef: string;
  prebookId: string;
  status: "prebooked";
  amountTotalMinor: number;
  currency: string;
  priceChangedPct: number;
  refundableUntil: string | null;
  cancellationChanged: boolean;
  // Present only on the Payment SDK path — the browser card session secret.
  paymentSecret: string | null;
  transactionId: string | null;
};

async function uniqueHumanRef(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const ref = makeRef();
    const hit = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(eq(bookings.humanRef, ref))
      .limit(1);
    if (!hit[0]) return ref;
  }
  // Astronomically unlikely; fall back to a longer, still-unique ref.
  return `${makeRef()}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

// Draft -> prebooked. Idempotent on `idempotencyKey`: a retry of the same click
// returns the existing row rather than creating a duplicate or re-charging.
export async function prepareBooking(input: PrepareInput): Promise<PrepareResult> {
  // 1. Idempotency — reuse an existing row for this key.
  const existing = await db
    .select()
    .from(bookings)
    .where(eq(bookings.idempotencyKey, input.idempotencyKey))
    .limit(1);

  let bookingId: string;
  let humanRef: string;

  if (existing[0]) {
    const row = existing[0];
    bookingId = row.id;
    humanRef = row.humanRef;
    // Already prebooked — hand back what we have; don't hit the supplier again.
    if (row.status === "prebooked" && row.prebookId) {
      return {
        bookingId,
        humanRef,
        prebookId: row.prebookId,
        status: "prebooked",
        amountTotalMinor: row.amountTotalMinor,
        currency: row.currency,
        priceChangedPct: row.priceDiffPct ?? 0,
        refundableUntil: row.refundableUntil ? row.refundableUntil.toISOString() : null,
        cancellationChanged: false,
        paymentSecret: row.paymentSecret,
        transactionId: row.transactionId,
      };
    }
  } else {
    // 2. Create the draft row + its first event.
    humanRef = await uniqueHumanRef();
    const draft: NewBooking = {
      humanRef,
      userId: input.userId,
      contactEmail: input.contactEmail,
      status: "draft",
      hotelId: input.hotelId,
      hotelSnapshot: input.hotel,
      offerId: input.offerId,
      boardName: input.room.board ?? null,
      roomSnapshot: input.room,
      checkinDate: input.checkinDate,
      checkoutDate: input.checkoutDate,
      nights: input.nights,
      adults: input.adults,
      currency: input.currency,
      amountTotalMinor: 0, // authoritative amount is set from the prebook below
      idempotencyKey: input.idempotencyKey,
    };
    const inserted = await db.insert(bookings).values(draft).returning({ id: bookings.id });
    bookingId = inserted[0].id;
    await db.insert(bookingEvents).values({
      bookingId,
      type: "draft.created",
      actor: "user",
      payload: { offerId: input.offerId, hotelId: input.hotelId },
    });
  }

  // 3. Supplier prebook — the authoritative price + cancellation policy.
  let pb: Record<string, unknown>;
  try {
    pb = (await prebook(input.offerId)) as Record<string, unknown>;
  } catch (e) {
    await db.insert(bookingEvents).values({
      bookingId,
      type: "prebook.failed",
      actor: "system",
      payload: { error: (e as Error).message },
    });
    await db
      .update(bookings)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
    throw e;
  }

  const price = Number(pb?.price ?? 0);
  const netAmountMinor = Math.round(price * 100);

  // Nobody — member or guest — is ever charged raw supplier net. The SAME
  // pricing formula used to compute the price shown in search results (see
  // lib/pricing.ts) is applied here, so what a member is shown always matches
  // what they're charged. A guest pays the public/SSP price (never a member's
  // discounted price). amountSupplierMinor always records the true net cost.
  const isMember = Boolean(input.userId);
  const sspMinor = input.room.themMinor ?? null;
  const amountTotalMinor = isMember
    ? memberPrice(netAmountMinor, sspMinor)
    : guestPrice(netAmountMinor, sspMinor);

  const priceDiffPct = Number(pb?.priceDifferencePercent ?? 0);
  const cancellationChanged = Boolean(pb?.cancellationChanged);
  const prebookId = String(pb?.prebookId ?? "");
  const { policy: cancellationPolicy, refundableUntil } = extractCancellation(pb);
  const paymentSecret = pb?.secretKey != null ? String(pb.secretKey) : null;
  const transactionId = pb?.transactionId != null ? String(pb.transactionId) : null;

  // Both are required to charge the guest. If LiteAPI didn't hand us a card
  // session, stop here — continuing would leave a bookable row whose only
  // remaining payment route is billing our own account.
  if (!transactionId || !paymentSecret) {
    await db.insert(bookingEvents).values({
      bookingId,
      type: "prebook.failed",
      actor: "system",
      payload: { error: "no guest payment session returned", prebookId: String(pb?.prebookId ?? "") },
    });
    await db
      .update(bookings)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(bookings.id, bookingId));
    throw new Error("Payment is unavailable for this rate. Please try another room.");
  }

  // 4. Advance to prebooked, snapshotting price + policy, and log it.
  await db
    .update(bookings)
    .set({
      status: "prebooked",
      prebookId,
      transactionId,
      paymentSecret,
      amountTotalMinor,
      amountSupplierMinor: netAmountMinor,
      priceChanged: priceDiffPct !== 0,
      priceDiffPct,
      cancellationPolicy,
      refundableUntil,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, bookingId));
  await db.insert(bookingEvents).values({
    bookingId,
    type: "prebook.ok",
    actor: "system",
    // Don't persist the client secret into the append-only log.
    payload: { ...pb, secretKey: undefined },
  });

  return {
    bookingId,
    humanRef,
    prebookId,
    status: "prebooked",
    amountTotalMinor,
    currency: input.currency,
    priceChangedPct: priceDiffPct,
    refundableUntil: refundableUntil ? refundableUntil.toISOString() : null,
    cancellationChanged,
    paymentSecret,
    transactionId,
  };
}

/* ------------------------------------------------------------------ */
/* Finalize: prebooked -> confirmed                                    */
/* ------------------------------------------------------------------ */

export type BillingAddress = {
  line1: string;
  city: string;
  state: string;
  zip: string;
};

export type GuestInput = {
  bookingId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  address?: BillingAddress | null;
};

// Capture the lead guest BEFORE payment. The Payment SDK redirects away on
// success, so the finalize step (confirmBooking, on the returnUrl) has no form
// data — it reads the guest from here. Upserts the single lead row + sets the
// booking's contact email/phone.
export async function saveBookingGuest(input: GuestInput): Promise<void> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, input.bookingId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error("Booking not found");
  if (row.status !== "prebooked") {
    throw new Error(`Booking is not open for guest details (status: ${row.status})`);
  }

  const existing = await db
    .select({ id: bookingGuests.id })
    .from(bookingGuests)
    .where(and(eq(bookingGuests.bookingId, row.id), eq(bookingGuests.isLead, true)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(bookingGuests)
      .set({ firstName: input.firstName, lastName: input.lastName })
      .where(eq(bookingGuests.id, existing[0].id));
  } else {
    await db.insert(bookingGuests).values({
      bookingId: row.id,
      firstName: input.firstName,
      lastName: input.lastName,
      isLead: true,
      roomIndex: 0,
    });
  }

  await db
    .update(bookings)
    .set({
      contactEmail: input.email.toLowerCase(),
      contactPhone: input.phone ?? row.contactPhone,
      billingAddress: input.address ?? row.billingAddress,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, row.id));
}

export type ConfirmInput = { bookingId: string };

export type ConfirmResult = {
  bookingId: string;
  humanRef: string;
  status: "confirmed";
  liteapiBookingId: string | null;
  supplierStatus: string;
};

// Finalize on the returnUrl: books against the row's prebookId + transactionId
// (the SDK charge), advances the ledger to confirmed, records the payment, and
// appends the terminal event. Idempotent — a retry of an already-confirmed
// booking hands back the stored result rather than double-booking.
export async function confirmBooking(input: ConfirmInput): Promise<ConfirmResult> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, input.bookingId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error("Booking not found");

  // Already done — return what we have, don't hit the supplier again.
  if (row.status === "confirmed") {
    return {
      bookingId: row.id,
      humanRef: row.humanRef,
      status: "confirmed",
      liteapiBookingId: row.liteapiBookingId,
      supplierStatus: "CONFIRMED",
    };
  }
  if (row.status !== "prebooked" || !row.prebookId) {
    throw new Error(`Booking is not ready to confirm (status: ${row.status})`);
  }

  // The lead guest was captured before payment; without it we can't book.
  const guests = await db
    .select()
    .from(bookingGuests)
    .where(and(eq(bookingGuests.bookingId, row.id), eq(bookingGuests.isLead, true)))
    .limit(1);
  const lead = guests[0];
  if (!lead || !row.contactEmail) {
    throw new Error("Guest details are missing for this booking");
  }

  // No guest charge, no booking. LiteAPI's only other payment methods bill our
  // own account for the room, so a missing transactionId must stop the flow
  // rather than quietly fall through to us paying for a stranger's stay.
  if (!row.transactionId) {
    throw new Error("Booking has no guest payment transaction; refusing to book");
  }

  // Supplier book — the point of no return.
  let res: Record<string, unknown>;
  try {
    res = (await book({
      prebookId: row.prebookId,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: row.contactEmail,
      transactionId: row.transactionId,
    })) as Record<string, unknown>;
  } catch (e) {
    await db.insert(bookingEvents).values({
      bookingId: row.id,
      type: "book.failed",
      actor: "system",
      payload: { error: (e as Error).message },
    });
    await db
      .update(bookings)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(bookings.id, row.id));
    throw e;
  }

  const liteapiBookingId = res?.bookingId != null ? String(res.bookingId) : null;
  const bookTransactionId = res?.transactionId != null ? String(res.transactionId) : row.transactionId;
  const supplierStatus = String(res?.status ?? "CONFIRMED");
  const now = new Date();

  await db
    .update(bookings)
    .set({
      status: "confirmed",
      liteapiBookingId,
      transactionId: bookTransactionId,
      confirmedAt: now,
      updatedAt: now,
      // The card session secret has served its purpose — drop it.
      paymentSecret: null,
    })
    .where(eq(bookings.id, row.id));

  await db.insert(payments).values({
    bookingId: row.id,
    transactionId: bookTransactionId,
    method: "sdk",
    status: "succeeded", // book() only returns on a settled charge in this flow
    amountMinor: row.amountTotalMinor,
    currency: row.currency,
    providerRaw: res,
  });

  await db.insert(bookingEvents).values({
    bookingId: row.id,
    type: "book.confirmed",
    actor: "system",
    payload: res,
  });

  // Send the confirmation email. Best-effort and only on this real transition
  // (the already-confirmed early return above skips it, so it fires once).
  const hotelSnap = (row.hotelSnapshot ?? {}) as { name?: string; city?: string };
  const roomSnap = (row.roomSnapshot ?? {}) as { title?: string; board?: string };
  const refundLine = row.refundableUntil
    ? `Free cancellation until ${row.refundableUntil.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
    : "Non-refundable rate";
  await sendBookingConfirmation({
    to: row.contactEmail,
    bookingId: row.id,
    humanRef: row.humanRef,
    guestName: `${lead.firstName} ${lead.lastName}`.trim(),
    hotelName: hotelSnap.name ?? "Your stay",
    hotelCity: hotelSnap.city,
    roomTitle: roomSnap.title ?? "Room",
    board: roomSnap.board,
    checkinDate: row.checkinDate,
    checkoutDate: row.checkoutDate,
    nights: row.nights,
    amountMinor: row.amountTotalMinor,
    currency: row.currency,
    refundLine,
    supplierRef: liteapiBookingId,
  });

  return {
    bookingId: row.id,
    humanRef: row.humanRef,
    status: "confirmed",
    liteapiBookingId,
    supplierStatus,
  };
}
