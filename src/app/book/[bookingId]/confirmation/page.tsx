import Link from "next/link";
import { mayActOnBooking } from "@/lib/booking-authz";
import { confirmationPageIntent, holdLapsed, readProviderVerdict } from "@/lib/booking-transitions";
import { resolveCaller } from "@/lib/booking-caller";
import { getBookingById } from "@/lib/bookings";
import { confirmBooking, recordUnresolvedPayment } from "@/lib/booking-service";
import ThemeToggle from "@/components/ThemeToggle";

type HotelSnap = { name?: string; city?: string; stars?: number };
type RoomSnap = { title?: string; board?: string };

function prettyDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function money(minor: number, currency = "USD") {
  return `${currency === "USD" ? "$" : currency + " "}${(minor / 100).toFixed(2)}`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-parchment text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-parchment">
        <div className="mx-auto flex h-14 max-w-[720px] items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[720px] flex-1 px-6 py-10">{children}</main>
    </div>
  );
}

export default async function ConfirmationPage(props: {
  params: Promise<{ bookingId: string }>;
  /**
   * The payment provider's own parameters, appended to the return URL it was
   * given. Read for ONE decision: whether a charge was actually started, which
   * is what decides whether this GET may call the supplier (NOS-51).
   */
  searchParams: Promise<{
    payment_intent?: string | string[];
    redirect_status?: string | string[];
  }>;
}) {
  const { bookingId } = await props.params;
  const sp = await props.searchParams;

  const booking = await getBookingById(bookingId);
  const notFound = (
    <Shell>
      <div className="rounded-xl border border-line bg-surface p-6 text-center">
        <h1 className="font-display text-[22px]">Booking not found</h1>
        <p className="mt-2 text-[14px] text-soft">We couldn&apos;t locate this reservation.</p>
      </div>
    </Shell>
  );
  if (!booking) return notFound;

  // OWNERSHIP (NOS-9). This page had no check of any kind, and it does two
  // things that needed one.
  //
  // It PRINTS `contactEmail` below, so a booking id was a lookup for a guest's
  // email address - and this is the URL that ends up in browser history.
  //
  // It also calls `confirmBooking` directly rather than through
  // `confirmBookingAction`, so the supplier's `book()` - the call that spends
  // the guest's money - was reachable by anyone who opened this URL. A check on
  // the action alone would have been decorative while this page existed.
  //
  // `manage` to look, `checkout` to finalize. Looking is what a guest does when
  // they come back through /find a week later, having proved control of the
  // address on the booking; finalizing is part of the original sitting and asks
  // for the stronger proof.
  const caller = await resolveCaller();
  if (!mayActOnBooking(caller, booking, "manage").ok) return notFound;

  // Finalize on arrival, but ONLY IF A CHARGE WAS ACTUALLY STARTED (NOS-51,
  // D-7.1 A). Opening this URL used to call the supplier's `book()` from any
  // pre-payment state, so a prefetch, a restored tab or a tap in history spent
  // money without the guest deciding to.
  //
  // Which states mean what is a tested rule, not a chain of conditions in a page
  // nothing in CI can exercise - this repository has no component test tier, so
  // a branch that lives here is a branch nothing checks. See
  // confirmationPageIntent for why the provider's redirect is part of the input
  // and not just the status: `payment_pending` is our own best-effort
  // breadcrumb, and `prebooked` does not mean "never charged".
  //
  // Finalizing is idempotent: an already-confirmed booking returns its stored
  // result, so a refresh or a double hit here is safe.
  let errorMsg: string | null = null;
  let finalizing = false;
  let resume = false;
  let unresolved = false;
  const intent = confirmationPageIntent({
    status: booking.status,
    provider: readProviderVerdict(sp),
    holdLapsed: holdLapsed(booking.prebookedAt, new Date()),
  });
  switch (intent) {
    case "finalize":
      if (mayActOnBooking(caller, booking, "checkout").ok) {
        try {
          const result = await confirmBooking({ bookingId });
          // Another request claimed it first (NOS-6). Nothing is wrong: the
          // guest has paid, and their booking is being made by whoever got
          // there first.
          finalizing = result.status === "finalizing";
        } catch (e) {
          errorMsg = (e as Error).message;
        }
      } else {
        errorMsg = "This booking was never completed. Start a fresh search to book this stay.";
      }
      break;
    case "wait":
      // A claim is in flight - the guest refreshed, or the sweeper is finishing
      // the job. Waiting is the honest answer, not an error.
      finalizing = true;
      break;
    case "unresolved":
      // A charge was started and the hold is gone, so the supplier cannot tell
      // us whether money moved. Spend nothing, and WRITE DOWN the one fact we
      // have: the provider sent this browser back here. Without that row the
      // sweeper expires this booking recording "no payment started", which is
      // the opposite of what we know (NOS-51 security review, F1).
      unresolved = true;
      try {
        await recordUnresolvedPayment(
          bookingId,
          "the payment provider returned this browser after the supplier hold lapsed",
        );
      } catch {
        // The guest still gets the honest page. A failed write here must not
        // turn a recoverable situation into an error screen; the reconciler and
        // the sweeper both still see the row.
      }
      break;
    case "resume":
      // The room is still held and nothing says a payment was started. Send
      // them back to the card step rather than calling the supplier or showing
      // a failure: neither is true, and this is the state a prefetch lands in.
      resume = true;
      break;
    case "dead":
      // Reached only for a booking no payment was ever started for, which is
      // why this no longer promises to reverse a charge we may not have taken.
      errorMsg = "This booking could not be completed. Start a fresh search to book this stay.";
      break;
    case "done":
      break;
  }

  // Re-read for the freshest status + ids after finalize.
  const finalBooking = (await getBookingById(bookingId)) ?? booking;
  const hotel = (finalBooking.hotelSnapshot ?? {}) as HotelSnap;
  const room = (finalBooking.roomSnapshot ?? {}) as RoomSnap;
  const confirmed = finalBooking.status === "confirmed";

  // A CHARGE MAY HAVE HAPPENED AND WE CANNOT ASK. Never "start again" here: the
  // guest may have been charged, and telling them to pay a second time is the
  // worst thing this page can do. Say what is true, give them the reference, and
  // say a person is looking - which is now true, because the event above is what
  // a person looks at.
  if (unresolved) {
    return (
      <Shell>
        <div className="rounded-xl border border-brass/35 bg-brass/[0.07] p-6 text-center">
          <h1 className="font-display text-[22px]">We&rsquo;re checking on your payment</h1>
          <p className="mt-2 text-[14px] text-soft">
            Your bank may have taken a payment for this stay, but the hotel released the room
            before we could confirm it. We&rsquo;re looking into it now and will email you.
          </p>
          <p className="mt-2 text-[14px] text-soft">
            Please don&rsquo;t pay again. If a charge shows on your statement it will either be
            completed as a booking or released by your bank.
          </p>
          <p className="mt-1 text-[13px] text-soft">
            Reference <span className="font-mono font-semibold text-ink">{finalBooking.humanRef}</span>
          </p>
          <Link
            href="/trips"
            className="btn-brass mt-5 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
          >
            View my trips
          </Link>
        </div>
      </Shell>
    );
  }

  // NO PAYMENT STARTED, which is also not a failure. The hold may still be
  // alive, so the useful thing is the way back to the card step - not an error
  // about a charge nobody made.
  if (resume && finalBooking.status === "prebooked") {
    return (
      <Shell>
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <h1 className="font-display text-[22px]">Your booking isn&rsquo;t paid yet</h1>
          <p className="mt-2 text-[14px] text-soft">
            We haven&rsquo;t taken a payment for this stay, so there&rsquo;s nothing to confirm
            yet. Your room is held for a short while longer.
          </p>
          <p className="mt-1 text-[13px] text-soft">
            Reference <span className="font-mono font-semibold text-ink">{finalBooking.humanRef}</span>
          </p>
          <Link
            href={`/book/${bookingId}`}
            className="btn-brass mt-5 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
          >
            Continue to payment
          </Link>
        </div>
      </Shell>
    );
  }

  // STILL BEING FINALIZED, which is not a failure. Someone - another tab, or
  // the sweeper - is making this booking right now. Telling the guest that, with
  // their reference, beats both a red error and a spinner that never resolves.
  if (!confirmed && (finalizing || finalBooking.status === "confirming")) {
    return (
      <Shell>
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <h1 className="font-display text-[22px]">We&rsquo;re completing your booking</h1>
          <p className="mt-2 text-[14px] text-soft">
            Your payment went through and we&rsquo;re confirming the room with the hotel now.
            Refresh this page in a moment.
          </p>
          <p className="mt-1 text-[13px] text-soft">
            Reference <span className="font-mono font-semibold text-ink">{finalBooking.humanRef}</span>
          </p>
        </div>
      </Shell>
    );
  }

  if (!confirmed) {
    return (
      <Shell>
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-6 text-center">
          <h1 className="font-display text-[22px]">We couldn&apos;t confirm your stay</h1>
          <p className="mt-2 text-[14px] text-soft">
            {errorMsg ?? "Something went wrong finalizing this booking."}
          </p>
          <p className="mt-1 text-[13px] text-soft">
            Reference <span className="font-mono font-semibold text-ink">{finalBooking.humanRef}</span>
          </p>
          <Link
            href="/"
            className="btn-brass mt-5 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
          >
            Back to search
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="gloss rise overflow-hidden rounded-2xl border border-line bg-surface">
        <div className="border-b border-line bg-parchment/60 p-7 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-sage/20 text-[22px] text-sage">
            ✓
          </div>
          <h1 className="mt-3 font-display text-[26px] tracking-[-0.01em]">You&apos;re booked</h1>
          <p className="mt-1 text-[14px] text-soft">
            Confirmation <span className="font-mono font-semibold text-ink">{finalBooking.humanRef}</span>
          </p>
          {finalBooking.contactEmail && (
            <p className="mt-1 text-[13px] text-soft">
              A confirmation is on its way to {finalBooking.contactEmail}.
            </p>
          )}
        </div>

        <dl className="flex flex-col gap-3 p-7 text-[14px]">
          <Row label="Hotel">
            {hotel.name}
            {hotel.city ? <span className="text-soft"> · {hotel.city}</span> : null}
          </Row>
          <Row label="Room">{room.title ?? "Room"}</Row>
          <Row label="Dates">
            {prettyDate(finalBooking.checkinDate)} → {prettyDate(finalBooking.checkoutDate)}
            <span className="text-soft">
              {" "}· {finalBooking.nights} {finalBooking.nights === 1 ? "night" : "nights"}
            </span>
          </Row>
          {finalBooking.liteapiBookingId && (
            <Row label="Supplier ref">
              <span className="font-mono text-[13px]">{finalBooking.liteapiBookingId}</span>
            </Row>
          )}
          <div className="mt-1 flex items-baseline justify-between border-t border-line pt-3">
            <dt className="font-display text-[16px]">Total paid</dt>
            <dd className="font-mono text-[18px] font-bold tabular-nums">
              {money(finalBooking.amountTotalMinor, finalBooking.currency)}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-3 border-t border-line p-7">
          <Link
            href="/trips"
            className="btn-brass rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
          >
            View my trips
          </Link>
          <Link
            href="/"
            className="smooth rounded-lg border border-line px-5 py-2.5 text-[14px] font-semibold text-ink hover:border-brass hover:-translate-y-px"
          >
            Book another stay
          </Link>
        </div>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-soft">{label}</dt>
      <dd className="text-right text-ink">{children}</dd>
    </div>
  );
}
