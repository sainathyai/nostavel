import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import InfoPage from "@/components/InfoPage";
import { VERIFIED_COOKIE, readVerifiedEmail } from "@/lib/guest-verify";
import { getConfirmedBookingsByEmail } from "@/lib/bookings";
import type { Booking } from "@/db/schema";

export const dynamic = "force-dynamic";
export const metadata = { title: "Your trips · Nostavel" };

function money(minor: number, currency = "USD") {
  return `${currency === "USD" ? "$" : currency + " "}${(minor / 100).toFixed(2)}`;
}

function prettyDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function GuestTripsPage() {
  const jar = await cookies();
  const email = await readVerifiedEmail(jar.get(VERIFIED_COOKIE)?.value);
  // Not verified (or the session lapsed) — send them back to verify.
  if (!email) redirect("/find");

  const trips = await getConfirmedBookingsByEmail(email);

  return (
    <InfoPage title="Your trips" intro={`Verified as ${email}.`}>
      {trips.length === 0 ? (
        <p className="text-[14px] text-soft">
          No confirmed trips are attached to this email yet.
        </p>
      ) : (
        <div className="flex w-full flex-col gap-3">
          {trips.map((t) => (
            <GuestTripCard key={t.id} trip={t} />
          ))}
        </div>
      )}
    </InfoPage>
  );
}

function GuestTripCard({ trip }: { trip: Booking }) {
  const hotel = (trip.hotelSnapshot ?? {}) as { name?: string; city?: string };
  return (
    <Link
      href={`/book/${trip.id}/confirmation`}
      className="gloss gloss-lift smooth flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 hover:border-brass/50"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[18px] text-ink">{hotel.name || "Stay"}</p>
        {hotel.city && <p className="mt-0.5 text-[13px] text-soft">{hotel.city}</p>}
        <p className="mt-1.5 text-[13px] text-soft">
          {prettyDate(trip.checkinDate)} → {prettyDate(trip.checkoutDate)} · {trip.nights} night
          {trip.nights === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-[12px] text-soft">
          Ref <span className="font-mono text-ink">{trip.humanRef}</span>
        </p>
      </div>
      <div className="shrink-0 text-right font-mono text-[15px] font-bold tabular-nums text-ink">
        {money(trip.amountTotalMinor, trip.currency)}
      </div>
    </Link>
  );
}
