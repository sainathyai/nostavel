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
  cancellations,
  type NewBooking,
} from "@/db/schema";
import { prebook, book, cancelBooking as cancelSupplierBooking } from "@/lib/liteapi";
import { sendBookingConfirmation } from "@/lib/email";
import { makeRef, extractCancellation } from "@/lib/booking-format";
import { buildCancelPolicy, describeTiers, zoneFor, type RawCancelPolicies } from "@/lib/cancellation";

export type HotelSnapshot = {
  name: string;
  city: string;
  address?: string;
  image?: string | null;
  stars?: number;
  postcode?: string | null;
  /** The property's own arrival/departure times, shown next to the dates. */
  checkinTime?: string | null;
  checkoutTime?: string | null;
  /**
   * Kept so checkout can render cancellation deadlines in PROPERTY-local time.
   * LiteAPI states every deadline in GMT and publishes no property timezone,
   * so the zone is derived from these — see src/lib/cancellation.ts.
   */
  lat?: number | null;
  lng?: number | null;
};

export type RoomSnapshot = {
  title: string;
  beds?: string;
  /** What WE advertised — the board the guest saw and agreed to. */
  board?: string;
  /**
   * The supplier's own board string, kept whenever it differs from `board`.
   * At a hotel where breakfast is a free property amenity, some suppliers
   * still file the rate as "Room Only"; we show "Breakfast included" on the
   * measured evidence, and the guest is owed the record of what they were
   * promised. This field preserves the underlying contract for any dispute,
   * so neither version is lost.
   */
  supplierBoard?: string;
  image?: string | null;
  amenities?: string[];
  sleeps?: number;
  size?: string | null;
  themMinor?: number | null; // Booking.com comparison price (for the price-beat)
  /**
   * The rate itself, before anything the hotel collects on arrival. Stored so
   * checkout can show a real breakdown (rate, then fees due at the property)
   * rather than one opaque total.
   */
  rateMinor?: number | null;
  /** Mandatory charges the HOTEL collects at check-in, not us. */
  feeAtHotelMinor?: number | null;
  /** How that fee was described, already resolved against the tax schema. */
  feeNote?: string | null;
  /** Supplier tax already inside the rate — lets us show a per-night room line. */
  taxInRateMinor?: number | null;
};

/**
 * Void a held rate because the visitor is no longer the person it was priced
 * for, and say so in the ledger.
 *
 * A prebooked offerId carries the margin that was chosen for the session that
 * created it. If that session changes, continuing to payment would charge the
 * WRONG TIER: sign in, hold a member price, sign out, pay, and a non-member has
 * bought member pricing. It is repeatable in seconds and costs us the whole
 * tier difference every time.
 *
 * Deliberately abandons rather than re-prices in place. Editing the total on a
 * checkout page while someone is holding a card is the drip-pricing pattern
 * pricing.ts refuses everywhere else; the guest goes back to the room list and
 * chooses again at a price that was honest when they saw it.
 */
export async function abandonForIdentityChange(
  bookingId: string,
  pricedFor: string | null,
  now: string | null,
): Promise<void> {
  await db.insert(bookingEvents).values({
    bookingId,
    type: "prebook.identity_changed",
    actor: "system",
    payload: { pricedFor, now, reason: "auth state changed between prebook and payment" },
  });
  await db
    .update(bookings)
    .set({ status: "expired", paymentSecret: null, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId));
}

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

  // The offerId was produced by a rates search carrying our margin, so LiteAPI
  // has ALREADY marked this price up and this is the exact figure their payment
  // SDK will charge the guest's card. We record it verbatim.
  //
  // Do not apply a pricing formula here. An earlier version treated this as net
  // and marked it up a second time, which recorded a total ~30% above what the
  // guest was actually charged and would have made the ledger irreconcilable
  // against LiteAPI's commission payouts.
  const price = Number(pb?.sellingPriceToUser ?? pb?.price ?? 0);
  const amountTotalMinor = Math.round(price * 100);

  // Our commission is the markup LiteAPI pays us after the guest checks out;
  // net is what's left, i.e. the true supplier cost. Recording both keeps the
  // ledger reconcilable against the weekly payout.
  const commission = Number(pb?.commission ?? 0);
  const amountCommissionMinor = Math.round(commission * 100);
  const netAmountMinor = amountTotalMinor - amountCommissionMinor;

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
  const hotelSnap = (row.hotelSnapshot ?? {}) as {
    name?: string;
    city?: string;
    lat?: number | null;
    lng?: number | null;
  };
  const roomSnap = (row.roomSnapshot ?? {}) as { title?: string; board?: string };
  // Same source of truth as the checkout page, not the old refundableUntil ?
  // "Free until X" : "Non-refundable" ternary — that binary is exactly the
  // NRFN-discards-the-ladder bug fixed in cancellation.ts, and the email was
  // carrying its own copy of the same mistake.
  const emailCancel = buildCancelPolicy(
    row.cancellationPolicy as RawCancelPolicies | null,
    row.amountTotalMinor / 100,
    zoneFor(hotelSnap.lat, hotelSnap.lng),
  );
  const emailTiers = describeTiers(emailCancel, row.currency);
  const refundLine =
    emailCancel.refundable && emailCancel.freeUntilLong
      ? `Free cancellation until ${emailCancel.freeUntilLong}`
      : emailTiers.length > 0
        ? `Free cancellation has passed, but part of your payment may still be refunded: ${emailTiers.join(" ")}`
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

export type CancelBookingResult = {
  bookingId: string;
  humanRef: string;
  status: "cancelled";
  refundAmountMinor: number;
  cancellationFeeMinor: number;
  currency: string;
  /** True when the guest gets some or all of their money back. */
  refunded: boolean;
};

/**
 * Guest- or admin-initiated cancellation of a CONFIRMED booking.
 *
 * The penalty preview shown before this is called is computed from the SAME
 * stored `cancellationPolicy` (buildCancelPolicy over cancelPolicyInfos, never
 * the bare refundableTag — see the long note in cancellation.ts and
 * docs/production-readiness.md §1.1, the bug this must not reintroduce on the
 * cancellation side after Phase 1 fixed it on display). This function does not
 * recompute that preview; it trusts the caller showed it and asked to proceed,
 * then reads the REAL outcome back from LiteAPI's own response rather than
 * assuming the preview was exact.
 */
export async function cancelBooking(
  bookingId: string,
  opts: { actor: "user" | "admin" } = { actor: "user" },
): Promise<CancelBookingResult> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1);
  const row = rows[0];
  if (!row) throw new Error("Booking not found");

  if (row.status === "cancelled") {
    // Idempotent: a retry (double-click, redelivered action) returns the
    // stored outcome instead of calling the supplier again.
    const existing = await db
      .select()
      .from(cancellations)
      .where(eq(cancellations.bookingId, row.id))
      .limit(1);
    const c = existing[0];
    return {
      bookingId: row.id,
      humanRef: row.humanRef,
      status: "cancelled",
      refundAmountMinor: c?.refundAmountMinor ?? 0,
      cancellationFeeMinor: 0,
      currency: row.currency,
      refunded: (c?.refundAmountMinor ?? 0) > 0,
    };
  }
  if (row.status !== "confirmed" || !row.liteapiBookingId) {
    throw new Error(`Booking cannot be cancelled (status: ${row.status})`);
  }

  await db.insert(bookingEvents).values({
    bookingId: row.id,
    type: "booking.cancel.requested",
    actor: opts.actor,
  });

  let result;
  try {
    result = await cancelSupplierBooking(row.liteapiBookingId);
  } catch (e) {
    await db.insert(bookingEvents).values({
      bookingId: row.id,
      type: "booking.cancel.failed",
      actor: "system",
      payload: { error: (e as Error).message },
    });
    throw e;
  }

  const now = new Date();
  await db
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(eq(bookings.id, row.id));

  await db.insert(cancellations).values({
    bookingId: row.id,
    status: result.status,
    refundAmountMinor: result.refundAmountMinor,
  });

  await db.insert(bookingEvents).values({
    bookingId: row.id,
    type: "booking.cancel.confirmed",
    actor: opts.actor,
    payload: result,
  });

  return {
    bookingId: row.id,
    humanRef: row.humanRef,
    status: "cancelled",
    refundAmountMinor: result.refundAmountMinor,
    cancellationFeeMinor: result.cancellationFeeMinor,
    currency: result.currency,
    refunded: result.refundAmountMinor > 0,
  };
}

/**
 * A SUPPLIER-initiated cancellation or refund, learned from a webhook rather
 * than asked for. If our row is already `cancelled` (we did it, or a
 * redelivered webhook is telling us twice) this is a no-op — the row already
 * reflects the truth and re-writing it would duplicate the ledger's audit
 * trail. Otherwise this is exactly the gap docs/production-readiness.md §2.3
 * calls the single highest-value missing piece: without it, a hotel or
 * wholesaler cancelling on their end is invisible to us until someone checks
 * LiteAPI's dashboard by hand.
 */
export async function recordSupplierCancellation(
  liteapiBookingId: string,
  payload: { refundAmountMinor?: number | null; status?: string | null; raw: unknown },
): Promise<{ bookingId: string; alreadyRecorded: boolean } | null> {
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.liteapiBookingId, liteapiBookingId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  if (row.status === "cancelled") {
    return { bookingId: row.id, alreadyRecorded: true };
  }

  const now = new Date();
  await db
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(eq(bookings.id, row.id));

  await db.insert(cancellations).values({
    bookingId: row.id,
    status: payload.status ?? "confirmed",
    refundAmountMinor: payload.refundAmountMinor ?? null,
  });

  await db.insert(bookingEvents).values({
    bookingId: row.id,
    type: "webhook.booking.cancel",
    actor: "webhook",
    payload: payload.raw as object,
  });

  return { bookingId: row.id, alreadyRecorded: false };
}
