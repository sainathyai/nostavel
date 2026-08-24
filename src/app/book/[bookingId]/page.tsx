import Link from "next/link";
import { redirect } from "next/navigation";
import { getBookingById } from "@/lib/bookings";
import { abandonForIdentityChange } from "@/lib/booking-service";
import { getStripePublishableKey } from "@/lib/liteapi";
import { getCurrentUser } from "@/lib/dal";
import { buildCancelPolicy, describeTiers, zoneFor } from "@/lib/cancellation";
import type { HotelSnapshot, RoomSnapshot } from "@/lib/booking-service";
import CheckoutClient, { type CheckoutSummary } from "./CheckoutClient";
import ThemeToggle from "@/components/ThemeToggle";

function money(minor: number, currency = "USD") {
  return `${currency === "USD" ? "$" : currency + " "}${(minor / 100).toFixed(2)}`;
}

// The full weekday+date. Checkout is the last place a guest can catch a
// wrong-day booking, so it is the one page that never abbreviates the date to
// "Sep 18" — the weekday is what people actually check their plans against.
function fullDate(iso: string) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex flex-1 flex-col bg-parchment text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-parchment">
        <div
          className={
            "mx-auto flex h-14 items-center justify-between px-6 " +
            (wide ? "max-w-[1180px]" : "max-w-[1060px]")
          }
        >
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1.5 text-[12px] text-soft">
              <LockIcon /> Secure checkout
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main
        className={
          "mx-auto w-full flex-1 px-6 py-6 " + (wide ? "max-w-[1180px]" : "max-w-[1060px]")
        }
      >
        {children}
      </main>
    </div>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="gloss rise mx-auto mt-10 max-w-md rounded-xl border border-line bg-surface p-6 text-center">
      <h1 className="font-display text-[22px]">{title}</h1>
      <p className="mt-2 text-[14px] text-soft">{body}</p>
      <Link
        href="/"
        className="btn-brass mt-4 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
      >
        Back to search
      </Link>
    </div>
  );
}

export default async function CheckoutPage(props: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await props.params;
  const booking = await getBookingById(bookingId);

  if (!booking) return <Shell><Notice title="Booking not found" body="We couldn't find this reservation. It may have expired." /></Shell>;
  if (booking.status === "confirmed") redirect(`/book/${bookingId}/confirmation`);
  if (booking.status !== "prebooked") {
    return (
      <Shell>
        <Notice title="This rate is no longer held" body="Held rates expire after a short while. Start a fresh search to book this stay." />
      </Shell>
    );
  }
  if (!booking.paymentSecret) {
    return (
      <Shell>
        <Notice title="Payment session unavailable" body="We couldn't open a secure payment session for this booking. Please start the booking again." />
      </Shell>
    );
  }

  const user = await getCurrentUser();

  // IDENTITY GUARD. The held offerId was priced for whoever was signed in (or
  // not) when it was created. Signing in or out since then changes which of the
  // two prices applies, so the hold is no longer valid for this visitor.
  //
  // Both directions matter. Signed-out-since is the revenue leak; signed-in-
  // since would charge a member the public rate, which is ours to fix, not
  // theirs to absorb.
  const pricedFor = booking.userId ?? null;
  const nowUser = user?.id ?? null;
  if (pricedFor !== nowUser) {
    await abandonForIdentityChange(bookingId, pricedFor, nowUser);
    const back = new URLSearchParams({
      checkin: booking.checkinDate,
      nights: String(booking.nights),
      repriced: nowUser ? "in" : "out",
    });
    redirect(`/stay/${booking.hotelId}?${back.toString()}`);
  }

  const hotel = (booking.hotelSnapshot ?? {}) as HotelSnapshot;
  const room = (booking.roomSnapshot ?? {}) as RoomSnapshot;
  const nameParts = (user?.name ?? "").trim().split(/\s+/).filter(Boolean);

  // The rate we charge. Property fees are collected by the hotel on arrival and
  // are deliberately NOT in this figure — see the breakdown below.
  const dueNowMinor = booking.amountTotalMinor;
  const feeMinor = room.feeAtHotelMinor ?? 0;

  // The authoritative policy is the one the PREBOOK returned, not the one the
  // search showed: prebook is where the rate was actually held, and its amounts
  // already carry our margin (verified x1.12 at margin 12,
  // analysis/2026-08-21/cancel_tiers.py). Rendered in property-local time.
  const zone = zoneFor(hotel.lat, hotel.lng);
  const cancel = buildCancelPolicy(
    booking.cancellationPolicy as Parameters<typeof buildCancelPolicy>[0],
    dueNowMinor / 100,
    zone,
  );

  const summary = {
    hotel: {
      name: hotel.name ?? "Your stay",
      city: hotel.city ?? "",
      stars: hotel.stars ?? 0,
      image: hotel.image ?? null,
      address: [hotel.address, hotel.city, hotel.postcode].filter(Boolean).join(", "),
      checkinTime: hotel.checkinTime ?? null,
      checkoutTime: hotel.checkoutTime ?? null,
    },
    room: {
      title: room.title ?? "Room",
      beds: room.beds ?? "",
      size: room.size ?? null,
      sleeps: room.sleeps ?? booking.adults,
      board: room.board || "Room only",
      // Only when it differs from what we advertised. A guest is owed the
      // supplier's own wording for anything they might have to argue at a desk.
      supplierBoard: room.supplierBoard ?? null,
      image: room.image ?? hotel.image ?? null,
      amenities: room.amenities ?? [],
    },
    stay: {
      checkinLabel: fullDate(booking.checkinDate),
      checkoutLabel: fullDate(booking.checkoutDate),
      nights: booking.nights,
      adults: booking.adults,
    },
    cancel: {
      refundable: cancel.refundable,
      freeUntilLong: cancel.freeUntilLong,
      // Each deadline string already carries its zone abbreviation (CDT), which
      // is what tells a guest whose clock is running.
      tiers: describeTiers(cancel, booking.currency),
    },
    price: {
      currency: booking.currency,
      dueNowLabel: money(dueNowMinor, booking.currency),
      perNightLabel: money(Math.round(dueNowMinor / Math.max(1, booking.nights)), booking.currency),
      feeLabel: feeMinor > 0 ? money(feeMinor, booking.currency) : null,
      feeNote: room.feeNote ?? null,
      tripTotalLabel: money(dueNowMinor + feeMinor, booking.currency),
      // LIKE FOR LIKE. `themMinor` is a RATE, on the same basis as what we
      // charge, and the property's fee is collected from whoever booked --
      // us, Booking.com, or the guest walking in. So the comparison has to add
      // the fee to BOTH sides or to neither. The previous version struck a
      // bare rate against our rate and then printed a trip total just below
      // it that was within 20 cents of the struck figure, which read exactly
      // like the same money split between two payees.
      compareTotalLabel:
        room.themMinor != null && room.themMinor > dueNowMinor
          ? money(room.themMinor + feeMinor, booking.currency)
          : null,
      savingLabel:
        room.themMinor != null && room.themMinor > dueNowMinor
          ? money(room.themMinor - dueNowMinor, booking.currency)
          : null,
    },
    humanRef: booking.humanRef,
    // NOTHING DERIVED FROM amountSupplierMinor GOES IN HERE.
    //
    // This object crosses to the browser. The removed "members save about N%"
    // banner computed 1 - amountSupplierMinor/amountTotalMinor, which is
    // commission/charge -- OUR MARGIN, published to the guest and labelled as
    // their discount. Verified against a real booking (NSTVL-5VHTAZ): charge
    // $590.86, supplier net $534.25, and the page said "save about 10%", i.e.
    // exactly the 9.6% we were taking. It was false as a saving claim and it
    // leaked the one number that must never reach the client.
    //
    // A member saving may only ever be quoted against sourced SSP evidence
    // (pricing.ts: compareAtPrice), never against supplier net.
  } satisfies CheckoutSummary;

  const defaultGuest = {
    firstName: nameParts[0] ?? "",
    lastName: nameParts.slice(1).join(" "),
    email: booking.contactEmail ?? user?.email ?? "",
    phone: booking.contactPhone ?? "",
    line1: "",
    city: "",
    state: "",
    zip: "",
  };
  let stripePk = "";
  try {
    stripePk = await getStripePublishableKey();
  } catch {
    /* handled client-side: empty pk shows a friendly error */
  }

  return (
    <Shell wide>
      <CheckoutClient
        bookingId={bookingId}
        paymentSecret={booking.paymentSecret}
        stripePk={stripePk}
        defaultGuest={defaultGuest}
        signedIn={Boolean(user)}
        summary={summary}
      />
    </Shell>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
