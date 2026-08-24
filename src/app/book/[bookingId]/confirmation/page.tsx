import Link from "next/link";
import { getBookingById } from "@/lib/bookings";
import { confirmBooking } from "@/lib/booking-service";
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

export default async function ConfirmationPage(props: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await props.params;

  const booking = await getBookingById(bookingId);
  if (!booking) {
    return (
      <Shell>
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <h1 className="font-display text-[22px]">Booking not found</h1>
          <p className="mt-2 text-[14px] text-soft">We couldn&apos;t locate this reservation.</p>
        </div>
      </Shell>
    );
  }

  // Finalize on arrival. Idempotent: an already-confirmed booking just returns its
  // stored result, so a refresh or double-hit here is safe.
  let errorMsg: string | null = null;
  if (booking.status === "prebooked") {
    try {
      await confirmBooking({ bookingId });
    } catch (e) {
      errorMsg = (e as Error).message;
    }
  } else if (booking.status !== "confirmed") {
    errorMsg = "This booking could not be completed. If you were charged, it will be reversed.";
  }

  // Re-read for the freshest status + ids after finalize.
  const finalBooking = (await getBookingById(bookingId)) ?? booking;
  const hotel = (finalBooking.hotelSnapshot ?? {}) as HotelSnap;
  const room = (finalBooking.roomSnapshot ?? {}) as RoomSnap;
  const confirmed = finalBooking.status === "confirmed";

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
