"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { prepareBookingAction } from "@/app/actions/booking";
import type { HotelDetail, RoomOption } from "@/lib/liteapi";
import { fallbackArt } from "@/lib/fallback-art";
import { memberSavingsBand } from "@/lib/member-pricing";
import { ReviewLine } from "@/components/ReviewLine";

type Intent = "view" | "book";

// checkin + nights -> checkout date (yyyy-mm-dd), matching the server's UTC math.
function checkoutDateOf(checkin: string, nights: number) {
  const d = new Date(checkin + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}

// Prepare state for the Book button. On success we navigate to the dedicated
// /book/[id] checkout page — this component only needs to reflect the
// in-flight prepare + any error.
type CheckoutState =
  | { phase: "idle" }
  | { phase: "preparing"; offerId: string }
  | { phase: "error"; offerId: string; message: string };

export default function StayDetailClient({
  detail,
  checkin,
  nights,
  intent,
  isMember,
}: {
  detail: HotelDetail;
  checkin: string;
  nights: number;
  intent: Intent;
  isMember: boolean;
}) {
  const router = useRouter();
  const { hotel, images: gallery, facilities, reviews, checkinTime, checkoutTime, options } = detail;
  const images = gallery.length ? gallery : hotel.photo ? [hotel.photo] : [];
  const [idx, setIdx] = useState(0);
  const [pb, setPb] = useState<CheckoutState>({ phase: "idle" });
  const incl = false; // no fee-inclusion toggle on this page yet — see RoomOptionCard's own fee line

  const idemKeys = useRef<Map<string, string>>(new Map());
  function keyFor(offerId: string) {
    const map = idemKeys.current;
    let k = map.get(offerId);
    if (!k) {
      k = crypto.randomUUID();
      map.set(offerId, k);
    }
    return k;
  }

  const startPrebook = useCallback(
    async (o: RoomOption) => {
      const offerId = o.offerId;
      setPb({ phase: "preparing", offerId });
      const res = await prepareBookingAction({
        idempotencyKey: keyFor(offerId),
        hotelId: hotel.id,
        offerId,
        hotel: {
          name: hotel.name,
          city: hotel.city,
          address: hotel.address,
          image: hotel.photo,
          stars: hotel.stars,
        },
        room: {
          title: o.title,
          beds: o.beds,
          board: o.board,
          image: o.image ?? hotel.photo,
          amenities: o.amenities ?? [],
          sleeps: o.sleeps,
          themMinor: o.them != null ? Math.round(o.them * 100) : null,
        },
        checkinDate: checkin,
        checkoutDate: checkoutDateOf(checkin, nights),
        nights,
        adults: 2,
        currency: o.currency ?? hotel.currency ?? "USD",
      });
      if (!res.ok) {
        setPb({ phase: "error", offerId, message: res.error });
        return;
      }
      router.push(`/book/${res.data.bookingId}`);
    },
    [hotel, checkin, nights, router],
  );

  // Arrived via "Book now" (e.g. a rate held from elsewhere) — jump straight
  // into prebooking the cheapest option instead of making them click again.
  useEffect(() => {
    if (intent === "book" && options[0]) startPrebook(options[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // arrow keys slide the gallery (no Escape — there's no modal to close)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIdx((i) => (images.length ? (i + 1) % images.length : 0));
      if (e.key === "ArrowLeft")
        setIdx((i) => (images.length ? (i - 1 + images.length) % images.length : 0));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [images.length]);

  const baseFrom = options[0]?.you ?? 0;
  const feeFrom = options[0]?.fee ?? 0;
  const fromBase = isMember ? baseFrom : (options[0]?.them ?? baseFrom);
  const fromPrice = incl ? fromBase + feeFrom : fromBase;

  return (
    <div className="rise flex flex-col gap-6 lg:flex-row lg:items-start">
      {/* LEFT — gallery, then room options */}
      <div className="flex min-w-0 flex-1 flex-col gap-6 lg:flex-[1.55]">
        <div
          className="gloss relative h-[320px] w-full shrink-0 overflow-hidden rounded-[16px] border border-line sm:h-[460px]"
          style={{ background: fallbackArt(hotel.id) }}
        >
          <div
            className="flex h-full transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${idx * 100}%)` }}
          >
            {images.map((src, i) => (
              <div key={i} className="relative h-full w-full shrink-0">
                <Image
                  src={src}
                  alt={`${hotel.name} photo ${i + 1}`}
                  fill
                  sizes="(max-width: 1024px) 100vw, 900px"
                  className="object-cover"
                  priority={i === 0}
                />
              </div>
            ))}
          </div>

          {images.length > 1 && (
            <>
              <button
                onClick={() => setIdx((i) => (i - 1 + images.length) % images.length)}
                aria-label="Previous photo"
                className="absolute left-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-lg text-white hover:bg-black/70"
              >
                ‹
              </button>
              <button
                onClick={() => setIdx((i) => (i + 1) % images.length)}
                aria-label="Next photo"
                className="absolute right-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-lg text-white hover:bg-black/70"
              >
                ›
              </button>
              <span className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2.5 py-0.5 font-mono text-[11px] text-white">
                {idx + 1} / {images.length}
              </span>
            </>
          )}
        </div>

        <div>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-[20px]">
              {options.length > 1 ? "Choose your room" : "Room option"}
            </h2>
            <span className="text-[12px] text-soft">
              {nights} {nights === 1 ? "night" : "nights"} · from ${fromPrice} total
            </span>
          </div>

          <div className="flex flex-col gap-4">
            {options.map((o) => (
              <RoomOptionCard
                key={o.offerId}
                o={o}
                seed={hotel.id}
                pb={pb}
                incl={incl}
                isMember={isMember}
                onBook={() => startPrebook(o)}
              />
            ))}
          </div>

          <p className="mt-4 text-center text-[11px] text-soft">
            You pay the price shown. Sandbox bookings never charge a card.
          </p>
        </div>
      </div>

      {/* RIGHT — static details: identity, amenities, reviews */}
      <aside className="flex w-full shrink-0 flex-col gap-5 lg:sticky lg:top-20 lg:w-[380px]">
        <div className="gloss rounded-[16px] border border-line bg-surface p-5">
          <div className="text-[11px] uppercase tracking-[0.1em] text-soft">
            {hotel.city}
            {hotel.stars > 0 ? ` · ${"★".repeat(hotel.stars)}` : ""}
          </div>
          <h1 className="font-display text-[26px] leading-tight tracking-[-0.01em]">{hotel.name}</h1>
          <div className="mt-1.5">
            <ReviewLine stay={hotel} />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-soft">
            {checkinTime && <span>Check-in from {checkinTime}</span>}
            {checkoutTime && <span>Check-out by {checkoutTime}</span>}
          </div>

          {facilities.length > 0 && (
            <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-soft">
                Amenities
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {facilities.map((f) => (
                  <span
                    key={f}
                    className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-soft"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}

          <WhyRecommend hotel={hotel} cheapest={options[0]} facilities={facilities} />
        </div>

        {reviews.length > 0 && (
          <div className="gloss flex flex-col gap-2.5 rounded-[16px] border border-line bg-surface p-5">
            <h3 className="font-display text-[19px]">What guests say</h3>
            {reviews.map((rv, i) => (
              <div key={i} className="rounded-lg border border-line bg-surface p-3">
                {rv.headline && (
                  <div className="text-[13.5px] font-semibold text-ink">“{rv.headline}”</div>
                )}
                {rv.pros && <div className="mt-0.5 line-clamp-3 text-[13px] text-soft">{rv.pros}</div>}
                <div className="mt-1.5 text-[11px] uppercase tracking-wide text-soft">
                  {rv.name}
                  {rv.country ? ` · ${rv.country.toUpperCase()}` : ""}
                  {rv.type ? ` · ${rv.type}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

// Honest reasons drawn only from real signals — never fabricated prose. No
// "categories" here (that's a comparison against other search results, which
// doesn't exist on a standalone hotel page) — just what's true of this hotel.
function recommendReasons(
  hotel: HotelDetail["hotel"],
  cheapest: RoomOption | undefined,
  facilities: string[],
): string[] {
  const out: string[] = [];
  if (cheapest?.them && cheapest.them > cheapest.you) {
    out.push(`$${cheapest.them - cheapest.you} under the Booking.com price`);
  }
  if (hotel.rating != null && hotel.rating >= 8) {
    out.push(
      `${hotel.rating >= 9 ? "Superb" : "Very good"} ${hotel.rating.toFixed(1)} guest score` +
        (hotel.reviewCount >= 200 ? ` across ${hotel.reviewCount.toLocaleString()} reviews` : ""),
    );
  }
  const fac = facilities.find((f) => /pool|spa|breakfast|parking|gym|fitness|beach|view/i.test(f));
  if (fac && out.length < 3) out.push(fac);
  if (hotel.stars >= 4 && out.length < 3) out.push(`${hotel.stars}-star property`);
  return out.slice(0, 3);
}

function WhyRecommend({
  hotel,
  cheapest,
  facilities,
}: {
  hotel: HotelDetail["hotel"];
  cheapest: RoomOption | undefined;
  facilities: string[];
}) {
  const reasons = recommendReasons(hotel, cheapest, facilities);
  if (!reasons.length) return null;
  return (
    <div className="mt-4 flex flex-col gap-2.5 border-t border-line pt-4">
      <h3 className="font-display text-[19px]">Why we recommend it</h3>
      <ul className="flex flex-col gap-2">
        {reasons.map((r, i) => (
          <li key={i} className="flex gap-2 text-[13px] text-ink">
            <span className="text-brass" aria-hidden>
              ✦
            </span>
            <span>{r}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Chip({ tone, children }: { tone: "good" | "muted"; children: React.ReactNode }) {
  return (
    <span
      className={
        "rounded-full px-2.5 py-1 text-[12px] font-medium " +
        (tone === "good"
          ? "border border-sage/40 bg-sage/15 text-sage"
          : "border border-line bg-surface text-soft")
      }
    >
      {children}
    </span>
  );
}

function RoomOptionCard({
  o,
  seed,
  pb,
  incl,
  isMember,
  onBook,
}: {
  o: RoomOption;
  seed: string;
  pb: CheckoutState;
  incl: boolean;
  isMember: boolean;
  onBook: () => void;
}) {
  const active = "offerId" in pb && pb.offerId === o.offerId;
  const you = incl ? o.you + o.fee : o.you;
  const band = memberSavingsBand(o.you, o.them);
  const publicBase = o.them ?? o.you;
  const publicPrice = incl ? publicBase + o.fee : publicBase;
  const meta = [o.beds, o.size, `sleeps ${o.sleeps}`].filter(Boolean).join(" · ");

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-col sm:flex-row">
        <div
          className="relative h-40 w-full shrink-0 sm:h-auto sm:w-40"
          style={{ background: fallbackArt(seed + o.offerId) }}
        >
          {o.image && (
            <Image
              src={o.image}
              alt={o.title}
              fill
              sizes="(max-width: 640px) 100vw, 160px"
              className="object-cover"
            />
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2.5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-display text-[17px] leading-tight">{o.title}</div>
              {meta && <div className="mt-0.5 text-[13px] text-soft">{meta}</div>}
            </div>
            {isMember ? (
              <div className="flex items-baseline justify-end gap-2 font-mono">
                {o.them && you < o.them && (
                  <span className="text-[12px] text-soft line-through tabular-nums">${o.them}</span>
                )}
                <span className="text-[18px] font-bold tabular-nums">${you}</span>
              </div>
            ) : (
              <div className="flex flex-col items-end">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[18px] font-bold tabular-nums">${publicPrice}</span>
                  <span className="text-[11px] text-soft">public</span>
                </div>
                {band > 0 && (
                  <span className="text-[11.5px] font-medium text-brass">Members save up to {band}%</span>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Chip tone={o.breakfast ? "good" : "muted"}>
              {o.breakfast ? "Breakfast included" : o.board}
            </Chip>
            <Chip tone={o.freeCancel ? "good" : "muted"}>
              {o.freeCancel
                ? o.freeCancelUntil
                  ? `Free cancellation until ${o.freeCancelUntil}`
                  : "Free cancellation"
                : "Non-refundable"}
            </Chip>
            {o.amenities.slice(0, 3).map((a) => (
              <Chip key={a} tone="muted">
                {a}
              </Chip>
            ))}
          </div>

          {o.fee > 0 &&
            (incl ? (
              <div className="text-[12px] text-soft">Includes ${o.fee} hotel fee</div>
            ) : (
              <div className="text-[12px] text-soft">{o.mandatory}</div>
            ))}

          {/* Anyone can book — guest checkout is allowed. Non-members are
              charged the public price server-side (enforced in prepareBooking,
              not here); this is just a nudge toward the cheaper member rate. */}
          {!isMember && band > 0 && (
            <p className="text-[11.5px] text-soft">
              <a href="/signin" className="text-brass underline underline-offset-2 hover:text-brassglow">
                Sign in
              </a>{" "}
              first to book at the member rate instead.
            </p>
          )}
          {active && pb.phase === "error" && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-[13px] text-red-500">
              {pb.message}
            </div>
          )}
          {active && pb.phase === "preparing" && (
            <div className="mt-auto text-center text-[13px] text-soft">Holding this rate…</div>
          )}
          {(!active || pb.phase === "error") && (
            <button
              onClick={onBook}
              className="btn-brass mt-auto w-full rounded-lg py-2 text-[13px] font-semibold text-[#1a1410]"
            >
              {active && pb.phase === "error" ? "Try again" : "Book this room"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
