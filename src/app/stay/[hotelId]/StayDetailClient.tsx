"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { prepareBookingAction } from "@/app/actions/booking";
import type {
  HotelDetail,
  HotelFacts,
  RoomOption,
  RoomRate,
  SentimentCategory,
} from "@/lib/liteapi";
import { fallbackArt } from "@/lib/fallback-art";
import { memberSavingsBand } from "@/lib/member-pricing";
import { ReviewLine } from "@/components/ReviewLine";
import { kindLabel, type NearbyGroup } from "@/lib/nearby";

// MapLibre touches window/document at module load — client-only, and loaded
// only on this page rather than in the shared bundle.
const HotelMap = dynamic(() => import("@/components/HotelMap"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-[13px] text-soft">Loading map…</div>
  ),
});

type Intent = "view" | "book";

// How many room cards render before the "show all" control appears. A mapped
// hotel returns its real room list (measured 6-22 rooms per hotel, 50 at the
// worst-case property), which is the right thing to HAVE but not to open with.
const VISIBLE_ROOMS = 8;

// "Fri, Sep 18" — UTC-pinned so it matches the date the search actually sent,
// not the viewer's local midnight.
function fullDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

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
  quoteToken,
}: {
  detail: HotelDetail;
  checkin: string;
  nights: number;
  intent: Intent;
  isMember: boolean;
  /** Opaque. Carried straight back to prepareBookingAction, never read here. */
  quoteToken: string;
}) {
  const router = useRouter();
  const {
    hotel,
    images: gallery,
    facilities,
    reviews,
    checkinTime,
    checkoutTime,
    options,
    breakfastAllRates,
    description,
    importantInfo,
    pros,
    cons,
    sentiment,
    facts,
    accessibility,
    accessibilityCertificate,
    allFacilities,
    reviewsTotal,
  } = detail;
  const images = gallery.length ? gallery : hotel.photo ? [hotel.photo] : [];
  const [idx, setIdx] = useState(0);
  const [pb, setPb] = useState<CheckoutState>({ phase: "idle" });
  const [showAll, setShowAll] = useState(false);
  const [refundableOnly, setRefundableOnly] = useState(false);
  // Filled in by the map once its tiles are parsed. Absent on first paint by
  // design: this is derived from the basemap, so it cannot be server-rendered
  // without downloading tiles on the server for a section that is a bonus.
  const [nearby, setNearby] = useState<NearbyGroup[]>([]);
  // Stable, or HotelMap's effect would tear down and rebuild the map on every
  // parent render.
  const handleNearby = useCallback((groups: NearbyGroup[]) => setNearby(groups), []);

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
    async (room: RoomOption, rate: RoomRate) => {
      const offerId = rate.offerId;
      setPb({ phase: "preparing", offerId });
      const res = await prepareBookingAction({
        quoteToken,
        idempotencyKey: keyFor(offerId),
        hotelId: hotel.id,
        offerId,
        hotel: {
          name: hotel.name,
          city: hotel.city,
          address: hotel.address,
          image: hotel.photo,
          stars: hotel.stars,
          postcode: hotel.postcode,
          checkinTime,
          checkoutTime,
          lat: hotel.lat,
          lng: hotel.lng,
        },
        room: {
          title: room.title,
          beds: room.beds,
          board: rate.boardLabel,
          supplierBoard: rate.board !== rate.boardLabel ? rate.board : undefined,
          image: room.image ?? hotel.photo,
          amenities: room.amenities ?? [],
          sleeps: rate.sleeps,
          size: room.size,
          themMinor: rate.them != null ? Math.round(rate.them * 100) : null,
          rateMinor: Math.round(rate.you * 100),
          feeAtHotelMinor: Math.round(rate.fee * 100),
          feeNote: rate.mandatory,
          taxInRateMinor: null,
        },
        checkinDate: checkin,
        checkoutDate: checkoutDateOf(checkin, nights),
        nights,
        adults: 2,
        currency: rate.currency ?? hotel.currency ?? "USD",
      });
      if (!res.ok) {
        setPb({ phase: "error", offerId, message: res.error });
        return;
      }
      router.push(`/book/${res.data.bookingId}`);
    },
    [hotel, checkin, nights, router, checkinTime, checkoutTime, quoteToken],
  );

  // Arrived via "Book now" (e.g. a rate held from elsewhere) — jump straight
  // into prebooking the cheapest rate of the cheapest room.
  useEffect(() => {
    const first = options[0];
    if (intent === "book" && first?.rates[0]) startPrebook(first, first.rates[0]);
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

  // The filter narrows the RATES inside each room, and a room with nothing left
  // drops out — so "free cancellation" answers "which rooms can I still get
  // refundable, and at what price", not just "hide some rows".
  //
  // There is deliberately no breakfast filter. Each room now offers exactly one
  // rate per cancellation policy, so filtering on board would hide whole rooms
  // over an attribute the guest cannot choose anyway.
  const filtered = useMemo(() => {
    const out: RoomOption[] = [];
    for (const room of options) {
      const rates = room.rates.filter((r) => !refundableOnly || r.freeCancel);
      if (rates.length) out.push({ ...room, rates, from: Math.min(...rates.map((r) => r.total)) });
    }
    return out.sort((a, b) => a.from - b.from);
  }, [options, refundableOnly]);

  const shown = showAll ? filtered : filtered.slice(0, VISIBLE_ROOMS);
  const rateCount = options.reduce((n, r) => n + r.rates.length, 0);
  const cheapest = filtered[0]?.rates[0];
  const fromPrice = cheapest ? (isMember ? cheapest.you : (cheapest.them ?? cheapest.you)) : 0;

  const checkoutDate = checkoutDateOf(checkin, nights);

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
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h2 className="font-display text-[20px]">
              {options.length > 1 ? "Choose your room" : "Room option"}
            </h2>
            <span className="text-[12px] text-soft">from ${fromPrice} total</span>
          </div>
          {/* The stay itself, next to the prices it produced. Every figure on
              this page is for these dates, and a guest arriving from a shared
              link has no other way to know which search they are looking at. */}
          <div className="mb-1 text-[13px]">
            <span className="font-medium text-ink">{fullDate(checkin)}</span>
            <span className="mx-1.5 text-soft" aria-hidden>
              →
            </span>
            <span className="font-medium text-ink">{fullDate(checkoutDate)}</span>
            <span className="text-soft">
              {" · "}
              {nights} {nights === 1 ? "night" : "nights"} · 2 adults
            </span>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-soft">
            <span>
              {options.length} {options.length === 1 ? "room" : "rooms"} · {rateCount} rate
              {rateCount === 1 ? "" : "s"}
            </span>
            {/* Said once, because at this hotel it is true of the property, not
                of a rate. Repeating it on every row implies a choice that the
                measured price gap says does not exist. */}
            {breakfastAllRates && (
              <span className="rounded-full border border-sage/40 bg-sage/15 px-2 py-0.5 text-[11.5px] font-medium text-sage">
                Breakfast included with every rate
              </span>
            )}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Toggle on={refundableOnly} onClick={() => setRefundableOnly((v) => !v)}>
              Free cancellation
            </Toggle>
            {refundableOnly && (
              <button
                onClick={() => setRefundableOnly(false)}
                className="px-1 text-[12px] text-soft underline underline-offset-2 hover:text-ink"
              >
                Clear
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface p-5 text-center text-[13px] text-soft">
              No refundable rooms at this hotel for these dates.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              {shown.map((room) => (
                <RoomCard
                  key={room.roomId}
                  room={room}
                  seed={hotel.id}
                  pb={pb}
                  isMember={isMember}
                  hideBoardChip={breakfastAllRates}
                  onBook={(rate) => startPrebook(room, rate)}
                />
              ))}
            </div>
          )}

          {filtered.length > VISIBLE_ROOMS && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mt-4 w-full rounded-lg border border-line bg-surface py-2.5 text-[13px] font-semibold text-ink hover:border-brass"
            >
              {showAll
                ? "Show fewer rooms"
                : `Show all ${filtered.length} rooms (${filtered.length - VISIBLE_ROOMS} more)`}
            </button>
          )}

          <p className="mt-4 text-center text-[11px] text-soft">
            You pay the price shown. Sandbox bookings never charge a card.
          </p>
        </div>

        {description.length > 0 && (
          <section className="gloss rounded-[16px] border border-line bg-surface p-5">
            <h2 className="font-display text-[19px]">About this hotel</h2>
            <div className="mt-2.5 flex flex-col gap-3">
              {description.map((b, i) => (
                <div key={i}>
                  {b.heading && (
                    <h3 className="text-[13px] font-semibold text-ink">{b.heading}</h3>
                  )}
                  <p className="text-[13.5px] leading-relaxed text-soft">{b.text}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Age limits, deposits and ID rules belong BEFORE the booking, not in
            a confirmation email. A 21+ check-in policy can invalidate the whole
            booking for the guest who did not read it. */}
        {importantInfo.length > 0 && (
          <section className="rounded-[16px] border border-brass/35 bg-brass/[0.06] p-5">
            <h2 className="font-display text-[19px]">Good to know before you book</h2>
            <ul className="mt-2 flex flex-col gap-1.5">
              {importantInfo.map((line, i) => (
                <li key={i} className="flex gap-2 text-[13px] text-ink">
                  <span className="text-brass" aria-hidden>
                    !
                  </span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {hotel.lat != null && hotel.lng != null && (
          <section className="gloss overflow-hidden rounded-[16px] border border-line bg-surface">
            <div className="flex flex-wrap items-baseline justify-between gap-2 p-5 pb-3">
              <h2 className="font-display text-[19px]">Where you'll be</h2>
              <p className="text-[12.5px] text-soft">
                {[hotel.address, hotel.city, hotel.postcode].filter(Boolean).join(", ")}
              </p>
            </div>
            {/* Location is the one attribute a photo cannot convey and a
                sentence rarely does. The pin carries no price: there is one
                property here, so a number would only repeat the list above. */}
            <div className="h-[320px] w-full border-t border-line">
              <HotelMap
                lat={hotel.lat}
                lng={hotel.lng}
                name={hotel.name}
                onNearby={handleNearby}
              />
            </div>

            {/* Read out of the same tiles the map above just drew — no extra
                request, no places API. Names and walking distances only: the
                basemap has no ratings or opening hours, and inventing either
                would be worse than omitting them. */}
            {nearby.length > 0 && (
              <div className="border-t border-line p-5">
                <h3 className="text-[11px] uppercase tracking-[0.1em] text-soft">
                  What&apos;s nearby
                </h3>
                <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  {nearby.map((group) => (
                    <div key={group.category}>
                      <div className="text-[12.5px] font-medium text-ink">{group.category}</div>
                      <ul className="mt-1 flex flex-col gap-1">
                        {group.places.map((p) => (
                          <li
                            key={`${p.name}|${p.kind}`}
                            className="flex items-baseline justify-between gap-3 text-[12.5px]"
                            title={`${p.metres} m in a straight line`}
                          >
                            <span className="truncate text-soft">
                              <span className="text-ink">{p.name}</span>
                              <span className="text-soft"> · {kindLabel(p.kind)}</span>
                            </span>
                            <span className="shrink-0 tabular-nums text-soft">
                              {p.walkMins} min
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] text-soft">
                  Walking times are estimated from straight-line distance. Places data
                  from OpenStreetMap.
                </p>
              </div>
            )}
          </section>
        )}

        {allFacilities.length > facilities.length && (
          <AllAmenities facilities={allFacilities} />
        )}
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
          {/* The stay repeated here, next to the property's own check-in and
              check-out times — the two are read together ("I arrive Friday;
              can I get in before 3pm?") and were previously columns apart. */}
          <div className="mt-3 rounded-lg border border-line bg-parchment2 px-3 py-2 text-[12.5px]">
            <div>
              <span className="font-medium text-ink">{fullDate(checkin)}</span>
              <span className="mx-1.5 text-soft" aria-hidden>
                →
              </span>
              <span className="font-medium text-ink">{fullDate(checkoutDate)}</span>
              <span className="text-soft">
                {" · "}
                {nights} {nights === 1 ? "night" : "nights"} · 2 adults
              </span>
            </div>
            {(checkinTime || checkoutTime) && (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-soft">
                {checkinTime && <span>Check-in from {checkinTime}</span>}
                {checkoutTime && <span>Check-out by {checkoutTime}</span>}
              </div>
            )}
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

          <WhyRecommend hotel={hotel} cheapest={cheapest} facilities={facilities} />

          <HotelFactsList facts={facts} checkinTime={checkinTime} checkoutTime={checkoutTime} />
        </div>

        {sentiment.length > 0 && (
          <div className="gloss rounded-[16px] border border-line bg-surface p-5">
            <h3 className="font-display text-[19px]">
              What guests rate it on
              {reviewsTotal > 0 && (
                <span className="ml-1.5 text-[12px] font-normal text-soft">
                  {reviewsTotal.toLocaleString()} reviews
                </span>
              )}
            </h3>
            {/* Both lists, always. Showing only the praise would make the page
                marketing copy; the cons are what actually separate two hotels
                with the same 7.9. */}
            {(pros.length > 0 || cons.length > 0) && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {pros.map((x) => (
                  <span
                    key={x}
                    className="rounded-full border border-sage/40 bg-sage/15 px-2.5 py-1 text-[12px] text-sage"
                  >
                    + {x}
                  </span>
                ))}
                {cons.map((x) => (
                  <span
                    key={x}
                    className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-soft"
                  >
                    − {x}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3.5 flex flex-col gap-2.5">
              {sentiment.map((c) => (
                <ScoreBar key={c.name} category={c} />
              ))}
            </div>
          </div>
        )}

        {accessibility && accessibility.supported.length > 0 && (
          <div className="gloss rounded-[16px] border border-line bg-surface p-5">
            <h3 className="font-display text-[19px]">Accessibility</h3>
            <p className="mt-1 text-[12.5px] text-soft">
              Surveyed provision for these needs. Absence from this list means the survey found
              none, not that it went unchecked.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {accessibility.supported.map((a) => (
                <span
                  key={a}
                  className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-soft"
                >
                  {a}
                </span>
              ))}
            </div>
            {accessibilityCertificate && (
              /* Linked, not embedded: the certificate page pulls stylesheets
                 and fonts from a third-party host. */
              <a
                href={accessibilityCertificate}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2.5 inline-block text-[12.5px] text-brass underline underline-offset-2 hover:text-brassglow"
              >
                Read the full accessibility survey
              </a>
            )}
          </div>
        )}

        {reviews.length > 0 && (
          <div className="gloss flex flex-col gap-2.5 rounded-[16px] border border-line bg-surface p-5">
            <h3 className="font-display text-[19px]">What guests say</h3>
            {reviews.map((rv, i) => (
              <div key={i} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-start justify-between gap-2">
                  {rv.headline ? (
                    <div className="text-[13.5px] font-semibold text-ink">“{rv.headline}”</div>
                  ) : (
                    <span />
                  )}
                  {rv.score != null && (
                    <span className="shrink-0 rounded-md bg-sage/15 px-1.5 py-0.5 font-mono text-[12px] font-semibold text-sage tabular-nums">
                      {rv.score.toFixed(1)}
                    </span>
                  )}
                </div>
                {rv.pros && (
                  <div className="mt-0.5 line-clamp-3 text-[13px] text-soft">
                    <span className="text-sage">+</span> {rv.pros}
                  </div>
                )}
                {rv.cons && (
                  <div className="mt-1 line-clamp-2 text-[13px] text-soft">
                    <span aria-hidden>−</span> {rv.cons}
                  </div>
                )}
                <div className="mt-1.5 text-[11px] uppercase tracking-wide text-soft">
                  {rv.name}
                  {rv.country ? ` · ${rv.country.toUpperCase()}` : ""}
                  {rv.type ? ` · ${rv.type}` : ""}
                  {rv.date ? ` · ${rv.date}` : ""}
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
  cheapest: RoomRate | undefined,
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
  cheapest: RoomRate | undefined;
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

// A category score with its explanation. The bar exists so ten categories can
// be compared at a glance; the sentence exists because "Location 7.55" does not
// tell you the area was described as intimidating, and that is the part that
// changes a decision.
function ScoreBar({ category }: { category: SentimentCategory }) {
  const pct = Math.max(0, Math.min(100, (category.rating / 10) * 100));
  const tone =
    category.rating >= 8.5 ? "bg-sage" : category.rating >= 7 ? "bg-brass" : "bg-soft";
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] text-ink">{category.name}</span>
        <span className="font-mono text-[12.5px] font-semibold tabular-nums">
          {category.rating.toFixed(1)}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div className={"h-full rounded-full " + tone} style={{ width: `${pct}%` }} />
      </div>
      {category.note && <p className="mt-1 text-[12px] leading-snug text-soft">{category.note}</p>}
    </div>
  );
}

// The practical questions a guest asks before booking, all of which we already
// receive and were dropping: who runs it, can I park, can I bring the dog.
function HotelFactsList({
  facts,
  checkinTime,
  checkoutTime,
}: {
  facts: HotelFacts;
  checkinTime: string | null;
  checkoutTime: string | null;
}) {
  const rows: [string, string][] = [];
  if (checkinTime) rows.push(["Check-in", `from ${checkinTime}`]);
  if (checkoutTime) rows.push(["Check-out", `by ${checkoutTime}`]);
  if (facts.chain) rows.push(["Part of", facts.chain]);
  if (facts.hotelType) rows.push(["Property type", facts.hotelType]);
  // "PAID" verbatim would read as shouting, and inventing "Paid parking
  // available" would add an availability claim the field does not make.
  if (facts.parking) rows.push(["Parking", facts.parking.toLowerCase()]);
  if (facts.petsAllowed != null) rows.push(["Pets", facts.petsAllowed ? "allowed" : "not allowed"]);
  if (facts.childAllowed != null)
    rows.push(["Children", facts.childAllowed ? "welcome" : "not allowed"]);
  if (facts.airportCode) rows.push(["Nearest airport", facts.airportCode]);
  if (facts.phone) rows.push(["Phone", facts.phone]);
  if (!rows.length) return null;

  return (
    <div className="mt-4 border-t border-line pt-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-soft">
        The practical details
      </h3>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-soft">{k}</dt>
            <dd className="text-right text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// The complete amenity list, collapsed by default. The rail above shows a
// curated ten; someone hunting for one specific thing — a kettle, a laundry,
// airport pickup — needs all of them, and 49 chips would otherwise bury the
// room list they came here for.
function AllAmenities({ facilities }: { facilities: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="gloss rounded-[16px] border border-line bg-surface p-5">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <h2 className="font-display text-[19px]">
          All amenities
          <span className="ml-1.5 text-[12px] font-normal text-soft">{facilities.length}</span>
        </h2>
        <span className="text-[12.5px] text-brass">{open ? "Hide" : "Show all"}</span>
      </button>
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 text-[13px] text-soft sm:grid-cols-2 lg:grid-cols-3">
          {facilities.map((f) => (
            <div key={f} className="flex gap-2">
              <span className="text-sage" aria-hidden>
                ·
              </span>
              <span>{f}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Toggle({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={
        "rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors " +
        (on
          ? "border-brass bg-brass/15 text-ink"
          : "border-line bg-surface text-soft hover:border-brass")
      }
    >
      {children}
    </button>
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

// One physical room, with every commercial variant of it underneath. The room
// is what a guest picks; board and cancellation terms are how they pick which
// version of it — so those belong inside the same card, not as separate
// look-alike cards competing over the same bed.
function RoomCard({
  room,
  seed,
  pb,
  isMember,
  hideBoardChip,
  onBook,
}: {
  room: RoomOption;
  seed: string;
  pb: CheckoutState;
  isMember: boolean;
  hideBoardChip: boolean;
  onBook: (rate: RoomRate) => void;
}) {
  const meta = [room.beds, room.size, `sleeps ${room.sleeps}`].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
      {/* Photo on top rather than in a 160px side strip: at two or three
          columns the room actually gets shown, and the old layout left a wide
          empty band to the right of every short rate list. */}
      <div
        className="relative h-36 w-full shrink-0"
        style={{ background: fallbackArt(seed + room.roomId) }}
      >
        {room.image && (
          <Image
            src={room.image}
            alt={room.title}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1536px) 50vw, 33vw"
            className="object-cover"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div>
          <div className="font-display text-[15.5px] leading-tight">{room.title}</div>
          {meta && <div className="mt-0.5 text-[12.5px] text-soft">{meta}</div>}
        </div>

        {room.amenities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {room.amenities.slice(0, 2).map((a) => (
              <Chip key={a} tone="muted">
                {a}
              </Chip>
            ))}
          </div>
        )}

        {/* mt-auto pins the rates to the bottom so tiles of unequal text still
            line their prices up across a row. */}
        <div className="mt-auto flex flex-col divide-y divide-line border-t border-line pt-1">
          {room.rates.map((rate) => (
            <RateRow
              key={rate.offerId}
              rate={rate}
              pb={pb}
              isMember={isMember}
              hideBoardChip={hideBoardChip}
              onBook={() => onBook(rate)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RateRow({
  rate,
  pb,
  isMember,
  hideBoardChip,
  onBook,
}: {
  rate: RoomRate;
  pb: CheckoutState;
  isMember: boolean;
  hideBoardChip: boolean;
  onBook: () => void;
}) {
  const active = "offerId" in pb && pb.offerId === rate.offerId;
  const band = memberSavingsBand(rate.you, rate.them);
  // Same fee added to both sides of every comparison below, so the "up to X%"
  // savings teaser and the strikethrough gap stay exactly as wide as they are
  // on the rate alone — only the two numbers being compared move to totals.
  const publicTotal = (rate.them ?? rate.you) + rate.fee;

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex flex-wrap gap-1">
        {!(hideBoardChip && rate.breakfast) && (
          <Chip tone={rate.breakfast ? "good" : "muted"}>{rate.boardLabel}</Chip>
        )}
        {/* The chip is the short property-LOCAL date. The exact instant, with
            its zone, is on hover and in the title for assistive tech — a
            deadline a guest may rely on should never be only a bare date. */}
        <span title={rate.freeCancelUntilLong ?? undefined}>
          <Chip tone={rate.freeCancel ? "good" : "muted"}>
            {rate.freeCancel
              ? rate.freeCancelUntil
                ? `Free until ${rate.freeCancelUntil}`
                : "Free cancellation"
              : "Non-refundable"}
          </Chip>
        </span>
      </div>

      {/* The penalty LADDER is deliberately not here. A room tile has to make
          one comparison easy — this room, this price, refundable or not — and
          two extra sentences per rate drowned that. The full terms live on
          checkout, where the guest has chosen a room and reads them once. */}

      <div className="flex items-center justify-between gap-2">
        {isMember ? (
          <div className="flex items-baseline gap-1.5 font-mono">
            {rate.them && rate.you < rate.them && (
              <span className="text-[11.5px] text-soft line-through tabular-nums">
                ${rate.them + rate.fee}
              </span>
            )}
            <span className="text-[17px] font-bold tabular-nums">${rate.total}</span>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-[17px] font-bold tabular-nums">${publicTotal}</span>
              <span className="text-[10.5px] text-soft">public</span>
            </div>
            {band > 0 && (
              <span className="text-[11px] font-medium text-brass">Members save {band}%</span>
            )}
          </div>
        )}

        {active && pb.phase === "preparing" ? (
          <span className="text-[12px] text-soft">Holding…</span>
        ) : (
          <button
            onClick={onBook}
            className="btn-brass shrink-0 rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a1410]"
          >
            {active && pb.phase === "error" ? "Retry" : "Book"}
          </button>
        )}
      </div>

      {/* The bold price above is always the total, so it's the number that
          compares fairly across rates — this line only explains the split
          when some of that total is collected later rather than now. */}
      {rate.fee > 0 ? (
        <div className="text-[11.5px] leading-snug text-soft">
          ${rate.you} due now, then {rate.mandatory}
        </div>
      ) : (
        <div className="text-[11.5px] text-soft">All taxes and fees included</div>
      )}

      {active && pb.phase === "error" && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-[13px] text-red-500">
          {pb.message}
        </div>
      )}
    </div>
  );
}
