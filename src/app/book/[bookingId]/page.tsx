import Link from "next/link";
import { redirect } from "next/navigation";
import { getBookingById } from "@/lib/bookings";
import { getStripePublishableKey } from "@/lib/liteapi";
import { getCurrentUser } from "@/lib/dal";
import CheckoutClient from "./CheckoutClient";

type HotelSnap = { name?: string; city?: string; stars?: number; image?: string | null };
type RoomSnap = { title?: string; board?: string };

function money(minor: number, currency = "USD") {
  return `${currency === "USD" ? "$" : currency + " "}${(minor / 100).toFixed(2)}`;
}

function shortDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-parchment text-ink">
      <header className="sticky top-0 z-40 border-b border-line glass">
        <div className="mx-auto flex h-14 max-w-[1060px] items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <span className="flex items-center gap-1.5 text-[12px] text-soft">
            <LockIcon /> Secure checkout
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1060px] flex-1 px-6 py-6">{children}</main>
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
  const hotel = (booking.hotelSnapshot ?? {}) as HotelSnap;
  const room = (booking.roomSnapshot ?? {}) as RoomSnap;
  const nameParts = (user?.name ?? "").trim().split(/\s+/).filter(Boolean);

  const summary = {
    hotelName: hotel.name ?? "Your stay",
    hotelCity: hotel.city ?? "",
    hotelStars: hotel.stars ?? 0,
    hotelImage: hotel.image ?? null,
    roomTitle: room.title ?? "Room",
    board: room.board || "Room only",
    dates: `${shortDate(booking.checkinDate)} → ${shortDate(booking.checkoutDate)}`,
    nights: booking.nights,
    adults: booking.adults,
    refundLine: booking.refundableUntil
      ? `Free cancellation until ${booking.refundableUntil.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : "Non-refundable rate",
    refundable: Boolean(booking.refundableUntil),
    totalLabel: money(booking.amountTotalMinor, booking.currency),
    humanRef: booking.humanRef,
    // Guest (no account) checkout is charged the public rate, not the member
    // net rate — surface that plainly rather than let the gap go unexplained.
    isGuest: !booking.userId,
    guestSavingsPct:
      !booking.userId && booking.amountSupplierMinor && booking.amountSupplierMinor < booking.amountTotalMinor
        ? Math.round((1 - booking.amountSupplierMinor / booking.amountTotalMinor) * 100)
        : 0,
  };

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
    <Shell>
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
