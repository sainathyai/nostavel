import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/dal";
import { getUserBookings } from "@/lib/bookings";
import { signOutAction } from "@/app/actions/auth";
import type { Booking } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function TripsPage() {
  const user = await getCurrentUser();
  if (!user?.id) redirect("/signin");

  const trips = await getUserBookings(user.id);
  const upcoming = trips.filter((t) => t.status === "confirmed");
  const other = trips.filter((t) => t.status !== "confirmed");

  return (
    <main className="min-h-screen bg-parchment">
      <header className="sticky top-0 z-40 border-b border-line glass">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <div className="flex items-center gap-2.5">
            <Link
              href="/"
              className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-brass hover:text-ink"
            >
              Book a stay
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-brass hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="rise mx-auto w-full max-w-[900px] px-6 py-10">
        <h1 className="font-display text-[30px] text-ink">My trips</h1>
        <p className="mt-1.5 text-[14px] text-soft">
          {user.email ? `Signed in as ${user.email}.` : "Your booked stays live here."}
        </p>

        {trips.length === 0 ? (
          <div className="gloss mt-10 rounded-2xl border border-line bg-surface px-6 py-14 text-center">
            <p className="font-display text-[20px] text-ink">No trips yet</p>
            <p className="mx-auto mt-2 max-w-sm text-[14px] text-soft">
              When you book a stay, it&apos;ll show up here with your confirmation and cancellation
              details.
            </p>
            <Link
              href="/"
              className="btn-brass mt-6 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
            >
              Find a stay
            </Link>
          </div>
        ) : (
          <div className="mt-8 flex flex-col gap-8">
            {upcoming.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="text-[13px] font-medium uppercase tracking-wide text-soft">Confirmed</h2>
                {upcoming.map((t) => (
                  <TripCard key={t.id} trip={t} />
                ))}
              </section>
            )}
            {other.length > 0 && (
              <section className="flex flex-col gap-3">
                <h2 className="text-[13px] font-medium uppercase tracking-wide text-soft">
                  In progress &amp; past
                </h2>
                {other.map((t) => (
                  <TripCard key={t.id} trip={t} />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

const STATUS_STYLE: Record<string, string> = {
  confirmed: "bg-sage/15 text-sage border-sage/30",
  draft: "bg-line/40 text-soft border-line",
  prebooked: "bg-brass/10 text-brass border-brass/30",
  payment_pending: "bg-brass/10 text-brass border-brass/30",
  failed: "bg-red-500/10 text-red-500 border-red-500/30",
  cancelled: "bg-line/40 text-soft border-line",
  expired: "bg-line/40 text-soft border-line",
};

function TripCard({ trip }: { trip: Booking }) {
  const hotel = (trip.hotelSnapshot ?? {}) as {
    name?: string;
    city?: string;
    image?: string;
  };
  const money = `${trip.currency} ${(trip.amountTotalMinor / 100).toFixed(2)}`;

  return (
    <div className="gloss smooth flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 hover:border-brass/40">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-display text-[18px] text-ink">{hotel.name || "Stay"}</p>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${
              STATUS_STYLE[trip.status] ?? STATUS_STYLE.draft
            }`}
          >
            {trip.status.replace("_", " ")}
          </span>
        </div>
        {hotel.city && <p className="mt-0.5 text-[13px] text-soft">{hotel.city}</p>}
        <p className="mt-1.5 text-[13px] text-soft">
          {trip.checkinDate} → {trip.checkoutDate} · {trip.nights} night
          {trip.nights === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-[12px] text-soft">
          Ref <span className="font-mono text-ink">{trip.humanRef}</span>
        </p>
      </div>
      <div className="shrink-0 text-right font-mono text-[15px] font-bold tabular-nums text-ink">
        {money}
      </div>
    </div>
  );
}
