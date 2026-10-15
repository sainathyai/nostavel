// Fake LiteAPI supplier client — the double NOS-29's integration suite mocks
// `@/lib/liteapi` with, so no `.int.test.ts` file ever reaches the real
// supplier over the network (NOS-29 AC 6). Read this file to know what a test
// is asserting about; you should not need to open src/lib/liteapi.ts to
// understand what `book()` returns or what shape a webhook payload has.
//
// USAGE — a `.int.test.ts` file that exercises booking-service.ts, the cron
// sweep route or the webhook route mocks the real client with this one:
//
//   vi.mock("@/lib/liteapi", () => import("@/test-support/fake-liteapi"));
//
//   beforeEach(() => resetFakeSupplier());
//
// This module holds MODULE-LEVEL mutable state (call log, gate, configured
// result), not a per-test instance, because `vi.mock`'s factory captures the
// module namespace once and every import of "@/lib/liteapi" for the rest of
// that test file resolves to these same exports — there is no way for a
// factory to hand back a fresh object per test. `resetFakeSupplier()` is the
// per-test reset point instead (call it in `beforeEach`). Tests in different
// files never share this state: `fileParallelism: false`
// (vitest.integration.config.ts) runs files one at a time and each Vitest
// worker starts a fresh module registry per file.
//
// CONTRACT THIS FAKE STANDS IN FOR (verified against src/lib/liteapi.ts,
// 2026-09-22 — re-check that file if this drifts):
//
//   prebook(offerId) -> { prebookId, price, commission, priceDifferencePercent,
//     cancellationChanged, secretKey, transactionId, roomTypes: [...] }
//     `price`/`commission` are MAJOR units (dollars), matching what
//     booking-service.ts's prepareBooking multiplies by 100. `secretKey` and
//     `transactionId` are the Payment SDK's browser card-session identifiers.
//
//   book({ prebookId, firstName, lastName, email, transactionId }) ->
//     { bookingId, transactionId, status } — the point of no return.
//     booking-service.ts's confirmBooking reads `res.bookingId`,
//     `res.transactionId` (falling back to the request's own transactionId)
//     and `res.status`, then writes a `payments` row and a `book.confirmed`
//     booking_events row from this same response.
//
//   cancelBooking(liteapiBookingId) -> { status, cancellationFeeMinor,
//     refundAmountMinor, currency } — money fields already converted to
//     MINOR units, matching the real client's own *100 conversion at that
//     boundary (src/lib/liteapi.ts's cancelBooking).
//
// WHERE THIS DELIBERATELY DIVERGES FROM src/lib/liteapi.ts:
//
//   - No `fetch`, no retry/backoff, no rate-limit handling — that machinery
//     (the `api()` helper's 429 backoff loop) exists to survive a live
//     network this fake never touches.
//   - `book()` can be held open on a gate (`holdBookCalls` /
//     `releaseBookCalls`) so a test can force two concurrent callers to both
//     be "in flight" at once, deterministically, instead of hoping a real
//     race lines up on a fast loopback connection. The real client has
//     nothing like this — it is purely a test control.
//   - Every field a caller doesn't explicitly configure is `null`, never a
//     guessed or derived number. In particular this fake never invents a
//     `commission`, `price` or refund amount — conventions.md §6, "fixtures
//     must not invent data": a fixture's invented `themMinor` once showed up
//     on checkout as a fake public rate, and the same rule applies to
//     anything that ends up in the booking ledger by way of a test double.

import { LiteApiError } from "@/lib/liteapi-error";
export type FakeBookInput = {
  prebookId: string;
  firstName: string;
  lastName: string;
  email: string;
  transactionId: string;
};

export type FakeBookResult = {
  bookingId: string;
  transactionId: string;
  status: string;
};

export type FakeBookCall = {
  args: FakeBookInput;
  /** `Date.now()` when the call reached the fake — for ordering assertions. */
  at: number;
};

export type FakePrebookResult = {
  prebookId: string;
  price: number | null;
  commission: number | null;
  priceDifferencePercent: number;
  cancellationChanged: boolean;
  secretKey: string | null;
  transactionId: string | null;
};

export type FakeCancelResult = {
  status: "CANCELLED" | "CANCELLED_WITH_CHARGES" | string;
  cancellationFeeMinor: number;
  refundAmountMinor: number;
  currency: string;
};

/** Every recorded `book()` call, in the order the fake received them. */
export const bookCalls: FakeBookCall[] = [];

let bookGate: Promise<void> | null = null;
let releaseBookGate: (() => void) | null = null;
let bookResult: Partial<FakeBookResult> = {};
let cancelResult: Partial<FakeCancelResult> = {};

/** Every supplier booking id passed to `cancelBooking()`, in order. */
export const cancelCalls: string[] = [];
let cancelGate: Promise<void> | null = null;
let releaseCancelGate: (() => void) | null = null;
let cancelWaiters: CallCountWaiter[] = [];
let bookError: Error | null = null;
/** What `getSupplierBooking` reports, keyed by the supplier's booking id. */
let supplierBookings = new Map<string, unknown>();
let supplierBookingError: Error | null = null;

type CallCountWaiter = { count: number; resolve: () => void };
let callCountWaiters: CallCountWaiter[] = [];

function notifyCallCountWaiters() {
  callCountWaiters = callCountWaiters.filter((w) => {
    if (bookCalls.length < w.count) return true;
    w.resolve();
    return false;
  });
}

/**
 * Clears all recorded calls and any configured gate/result/error. Call this
 * in `beforeEach` — see the module comment for why a per-test instance isn't
 * possible with `vi.mock`.
 */
export function resetFakeSupplier(): void {
  bookCalls.length = 0;
  bookGate = null;
  releaseBookGate = null;
  bookResult = {};
  cancelResult = {};
  cancelCalls.length = 0;
  cancelGate = null;
  releaseCancelGate = null;
  cancelWaiters = [];
  bookError = null;
  supplierBookings = new Map();
  supplierBookingError = null;
  callCountWaiters = [];
}

/** Every subsequent `book()` call awaits this gate before resolving. */
export function holdBookCalls(): void {
  bookGate = new Promise<void>((resolve) => {
    releaseBookGate = resolve;
  });
}

/** Lets every `book()` call currently waiting on the gate resolve. */
export function releaseBookCalls(): void {
  releaseBookGate?.();
  bookGate = null;
  releaseBookGate = null;
}

/**
 * Resolves once at least `count` calls to `book()` have been recorded.
 * Combined with `holdBookCalls()`, this is how a test proves two concurrent
 * `confirmBooking` calls BOTH reached the supplier before either is allowed
 * to finish — waiting on wall-clock timing instead would be flaky.
 */
export function waitForBookCalls(count: number): Promise<void> {
  if (bookCalls.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    callCountWaiters.push({ count, resolve });
  });
}

/** Configure what the next (and subsequent) `book()` calls resolve with. */
export function configureBookResult(result: Partial<FakeBookResult>): void {
  bookResult = result;
}

/**
 * Configure what `getSupplierBooking(id)` reports for one supplier booking id.
 *
 * Added in NOS-64. The reconciler calls `getSupplierBooking` and this fake had no
 * such export, which is the mechanical reason that route had no tests at all: any
 * test that mocked `@/lib/liteapi` left the reconciler calling undefined. A
 * money-safety job was therefore untestable rather than untested.
 */
export function configureSupplierBooking(bookingId: string, value: unknown): void {
  supplierBookings.set(bookingId, value);
}

/** Configure `getSupplierBooking()` to reject, for the unreachable-supplier path. */
export function configureSupplierBookingError(error: Error | null): void {
  supplierBookingError = error;
}

/**
 * Configure what the next (and subsequent) `cancelBooking()` calls resolve with.
 *
 * Added in NOS-7. The fake returned a fixed zero-refund result, which is fine for
 * the happy path and useless for the one that matters: proving the three writes
 * after a successful supplier cancellation are atomic needs a supplier response
 * the DATABASE rejects, so the write fails after the status update has been
 * issued. `refundAmountMinor` is an `integer` column, so a value above 2^31 - 1
 * is refused by Postgres itself rather than by a check we wrote.
 */
export function configureCancelResult(result: Partial<FakeCancelResult>): void {
  cancelResult = result;
}

/**
 * Every subsequent `cancelBooking()` call awaits this gate before resolving.
 *
 * Added in NOS-16, to make the cancellation race DETERMINISTIC rather than
 * hoped for. `cancelBooking` reads the booking's status, calls the supplier, and
 * only then writes. Holding the supplier call open parks the guest path inside
 * exactly that window, so a webhook cancellation can be driven to completion in
 * between and the two writes genuinely collide - the same technique
 * `holdBookCalls` uses for the double-confirm race.
 */
export function holdCancelCalls(): void {
  cancelGate = new Promise<void>((resolve) => {
    releaseCancelGate = resolve;
  });
}

/** Lets every `cancelBooking()` call currently waiting on the gate resolve. */
export function releaseCancelCalls(): void {
  releaseCancelGate?.();
  cancelGate = null;
  releaseCancelGate = null;
}

/** Resolves once at least `count` calls to `cancelBooking()` have been recorded. */
export function waitForCancelCalls(count: number): Promise<void> {
  if (cancelCalls.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    cancelWaiters.push({ count, resolve });
  });
}

/** Configure `book()` to reject instead of resolving, for a failure-path test. */
export function configureBookError(error: Error | null): void {
  bookError = error;
}

/**
 * The supplier refusing because nobody has paid for the transaction.
 *
 * Built through the REAL error class, from the real captured body
 * (analysis/2026-10-06/raw/04_POST__rates_book.json), because a test that
 * invents its own error shape proves nothing about production. The NOS-5
 * security review found exactly that: the detector matched a literal this
 * fixture used to hand it - `new Error('book failed: 2014 "payment not
 * completed"')` - while the real client throws `LiteAPI 400: booking
 * incomplete`, which the detector could not match at all. The test passed and
 * the feature did not work.
 */
export function unpaidRefusal(): LiteApiError {
  return new LiteApiError(400, {
    error: { code: 2014, description: "payment not completed", message: "booking incomplete" },
  });
}

/** A refusal that is NOT about payment, in the same real shape. */
export function supplierRefusal(code: number, description: string, message: string): LiteApiError {
  return new LiteApiError(400, { error: { code, description, message } });
}

export async function book(input: FakeBookInput): Promise<FakeBookResult> {
  bookCalls.push({ args: input, at: Date.now() });
  notifyCallCountWaiters();
  if (bookGate) await bookGate;
  if (bookError) throw bookError;
  return {
    bookingId: bookResult.bookingId ?? "fake-booking-" + input.prebookId,
    transactionId: bookResult.transactionId ?? input.transactionId,
    status: bookResult.status ?? "CONFIRMED",
  };
}

/**
 * Not exercised by NOS-33's three tests (they seed an already-`prebooked`
 * row directly — see src/test-support/db-fixtures.ts — rather than driving
 * prepareBooking), but implemented so this fake is a complete stand-in for
 * any future `.int.test.ts` that does exercise the prebook step. Every money
 * field defaults to `null`: a caller that needs a concrete price must say so
 * explicitly, this fake never invents one.
 */
export async function prebook(offerId: string): Promise<FakePrebookResult> {
  return {
    prebookId: "fake-prebook-" + offerId,
    price: null,
    commission: null,
    priceDifferencePercent: 0,
    cancellationChanged: false,
    secretKey: null,
    transactionId: null,
  };
}

/** Mirrors `cancelBooking` in src/lib/liteapi.ts. Configured by `configureCancelResult`. */
export async function cancelBooking(liteapiBookingId: string): Promise<FakeCancelResult> {
  cancelCalls.push(liteapiBookingId);
  cancelWaiters = cancelWaiters.filter((w) => {
    if (cancelCalls.length < w.count) return true;
    w.resolve();
    return false;
  });
  if (cancelGate) await cancelGate;
  return {
    status: "CANCELLED",
    cancellationFeeMinor: 0,
    refundAmountMinor: 0,
    currency: "USD",
    ...cancelResult,
  };
}

/**
 * A LiteAPI webhook delivery shaped like the documented envelope
 * (src/lib/webhook-format.ts's `parseWebhookEnvelope`): `event_id` is the
 * dedupe key, `event_name` the type, and `request`/`response` are BOTH
 * JSON-stringified — "parse twice" is the docs' own phrasing, and
 * webhook-format.ts's parser expects exactly that shape. Every field not
 * passed in is either a fixed literal the real envelope always carries
 * (`sandbox: true`) or explicitly required from the caller (`eventId`,
 * `bookingId`) — nothing here is invented supplier data.
 */
export function buildFakeWebhookPayload(opts: {
  eventId: string;
  eventName: string;
  bookingId: string;
  status?: string;
  /**
   * Major units, as the supplier sends them: `extractRefundAmountMinor` reads
   * `refund_amount` and multiplies by 100. Added in NOS-8, where a refund that
   * is not a cancellation has to be expressible at all.
   */
  refundAmount?: number;
  refundId?: string;
}): Record<string, unknown> {
  const response: Record<string, unknown> = {
    bookingId: opts.bookingId,
    status: opts.status ?? "CANCELLED",
  };
  if (opts.refundAmount !== undefined) response.refund_amount = opts.refundAmount;
  if (opts.refundId !== undefined) response.refundId = opts.refundId;
  return {
    event_id: opts.eventId,
    event_name: opts.eventName,
    sandbox: true,
    request: JSON.stringify({ bookingId: opts.bookingId }),
    response: JSON.stringify(response),
  };
}

/**
 * The supplier's own view of a booking, as the reconciler asks for it.
 *
 * An id nobody configured resolves to `{ status: "confirmed" }`, because the
 * common case in a reconciliation test is "the supplier agrees" and spelling that
 * out in every test would bury the case each one is actually about.
 */
export async function getSupplierBooking(bookingId: string): Promise<unknown> {
  if (supplierBookingError) throw supplierBookingError;
  if (supplierBookings.has(bookingId)) return supplierBookings.get(bookingId);
  return { status: "confirmed" };
}
