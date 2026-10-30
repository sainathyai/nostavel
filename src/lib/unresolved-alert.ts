// The one alert in this app that is about a guest's money (NOS-56).
//
// WHAT WAS WRONG. The sweeper's whole safety net ends in "alert a person": when
// the supplier's hold has lapsed while a payment was in flight, the row keeps
// its status deliberately and a `payment.unresolved` event is appended, because
// that event is the only record saying a guest may have been charged with no
// booking. **Nothing read it.** No email, no dashboard, no query, no runbook.
// "Alert a person" meant a row in `booking_events`, and decision D-4.2's other
// half was never built.
//
// WHAT THIS LINE IS FOR. It is the one log line in this app whose only purpose
// is to be alerted on: `infra/envs/uat/observability.tf` matches
// `jsonPayload.event="payment.unresolved"` and emails the owner. So it is
// written to be read by a person who is not at a keyboard, in an email, with no
// context - which is why the message names the booking, the amount and what was
// already tried, and ends by pointing at the runbook.
//
// WHAT IT DELIBERATELY DOES NOT CARRY: the guest's name, email or phone. The
// privacy rule (`.agents/rules/security.md`) keeps guest personal data out of
// logs, and an alert that is forwarded into an inbox is the last place to make
// an exception. `humanRef` identifies the booking to a person, `bookingId`
// identifies it to a query, and the runbook's first step is how to get the
// guest's details from either one.
import { logError, type LogFields } from "./log";

export type UnresolvedPayment = {
  bookingId: string;
  /** The short reference the guest was shown, e.g. LNTRN-7QK2. */
  humanRef: string;
  currency: string;
  /** What the guest was asked to pay, in minor units. */
  amountTotalMinor: number;
  /** The supplier's payment transaction, which is what to ask them about. */
  transactionId: string | null;
  prebookId: string | null;
  /** The sweeper's own words for what it tried and what it got back. */
  reason: string;
};

/**
 * The columns the alert reads from a booking.
 *
 * Structural rather than the Drizzle row type, so this module stays free of the
 * schema and a caller can pass a whole row. It is also the list itself: which
 * columns an alert may carry is the privacy decision in this file, and it is
 * made once here rather than at each of the three call sites.
 */
export type AlertableBooking = {
  id: string;
  humanRef: string;
  currency: string;
  amountTotalMinor: number;
  transactionId: string | null;
  prebookId: string | null;
};

/** A booking row and the sweeper's reason, as the alert needs them. */
export function unresolvedFrom(row: AlertableBooking, reason: string): UnresolvedPayment {
  return {
    bookingId: row.id,
    humanRef: row.humanRef,
    currency: row.currency,
    amountTotalMinor: row.amountTotalMinor,
    transactionId: row.transactionId,
    prebookId: row.prebookId,
    reason,
  };
}

/**
 * The amount as a person reads it, with the currency code rather than a symbol.
 *
 * `email.ts` formats money for a guest and uses `$`; this is for whoever is
 * about to look at a supplier dashboard, where the code is what is shown.
 */
function amount(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

/** The line's two halves: the sentence for a person, the fields for a query. */
export function unresolvedPaymentLine(u: UnresolvedPayment): { message: string; fields: LogFields } {
  const supplier = u.transactionId ?? u.prebookId ?? "none recorded";
  return {
    message:
      `A guest may have been charged with no booking. ` +
      `Booking ${u.humanRef}, ${amount(u.amountTotalMinor, u.currency)}, supplier transaction ${supplier}. ` +
      `The sweeper could not resolve it: ${u.reason}. ` +
      `Nothing more happens automatically - follow docs/runbooks/unresolved-payment.md.`,
    fields: {
      bookingId: u.bookingId,
      humanRef: u.humanRef,
      currency: u.currency,
      amountTotalMinor: u.amountTotalMinor,
      transactionId: u.transactionId,
      prebookId: u.prebookId,
      reason: u.reason,
    },
  };
}

/**
 * Write the line that raises the alert.
 *
 * ERROR, not CRITICAL: the app is serving normally and this is one booking, not
 * a dead environment. The severity is not what makes it an alert - the event
 * name is, and the policy watches for it appearing at all.
 *
 * ONCE PER BOOKING, NOT ONCE PER SWEEP. The caller only reaches this when
 * `appendOnce` actually appended, which is why that function now reports
 * whether it did. The sweeper runs every five minutes forever, so a line
 * written on every pass would be an alert the owner mutes within a day - and
 * then the one that matters arrives into a muted channel.
 */
export function alertUnresolvedPayment(u: UnresolvedPayment): void {
  const { message, fields } = unresolvedPaymentLine(u);
  logError("payment.unresolved", message, fields);
}
