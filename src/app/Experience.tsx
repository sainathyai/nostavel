"use client";

import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { signOutAction } from "@/app/actions/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import type { AmenityKey, Category, HotelStay, ReviewSnippet, SearchResult } from "@/lib/liteapi";
import type { SeasonalSection } from "@/lib/seasonal";
import { DESTINATIONS } from "@/lib/destinations";
import { fallbackArt } from "@/lib/fallback-art";
import { hotelExtrasQueue } from "@/lib/fetch-queue";
import { AmenityIcon } from "@/components/AmenityIcon";
import { ReviewLine } from "@/components/ReviewLine";
import { memberSavingsBand } from "@/lib/member-pricing";

// MapLibre touches window/document at module load — client-only, no SSR.
const StaysMap = dynamic(() => import("@/components/StaysMap"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full w-full place-items-center text-[13px] text-soft">Loading map…</div>
  ),
});

const CAT_LABEL: Record<Category, string> = {
  budget: "Budget",
  comfort: "Comfort",
  luxury: "Luxury",
  convenience: "Central",
};
const CAT_ORDER: Category[] = ["budget", "comfort", "luxury", "convenience"];

type SortKey = "recommended" | "price_low" | "price_high" | "savings";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "recommended", label: "Recommended" },
  { key: "price_low", label: "Price: low to high" },
  { key: "price_high", label: "Price: high to low" },
  { key: "savings", label: "Biggest savings" },
];

function savingsFrac(s: HotelStay) {
  return s.them ? (s.them - s.you) / s.them : 0;
}

// "Best overall": mostly guest score, with savings, review volume, and stars.
function recScore(s: HotelStay) {
  const rating = (s.rating ?? 0) / 10;
  const reviews = Math.min(s.reviewCount / 1500, 1);
  const stars = s.stars / 5;
  return rating * 0.55 + savingsFrac(s) * 0.25 + reviews * 0.1 + stars * 0.1;
}

function sortItems(items: HotelStay[], key: SortKey) {
  const arr = [...items];
  if (key === "price_low") arr.sort((a, b) => a.you - b.you);
  else if (key === "price_high") arr.sort((a, b) => b.you - a.you);
  else if (key === "savings") arr.sort((a, b) => savingsFrac(b) - savingsFrac(a));
  else arr.sort((a, b) => recScore(b) - recScore(a));
  return arr;
}

function prettyDate(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function truncate(s: string, n = 30) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

type Query = { dest: string; checkin: string; nights: number; notes: string };
type Intent = "view" | "book";

// When true, displayed prices include the mandatory fee collected at the hotel.
const FeesContext = createContext(false);
const useInclFees = () => useContext(FeesContext);

// True only for signed-in members. Non-members never see the discounted net
// rate (rate-parity: we may not display below-SSP prices publicly) — they see
// the public price plus a rounded "up to" savings teaser, and must sign in to
// see or book the member rate.
const MemberContext = createContext(false);
const useMember = () => useContext(MemberContext);

// Public-facing savings teaser: rounded UP to the nearest 5%, capped, and always
// shown as "up to" so the exact member price can't be reverse-engineered.
export type Account = {
  name?: string | null;
  email?: string | null;
  image?: string | null;
} | null;

// Header account control: a "Sign in" link when logged out, or an avatar menu
// (My trips / Sign out) when logged in. Sign-out is a server action via <form>.
function AccountMenu({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!account) {
    return (
      <Link
        href="/signin"
        className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-brass hover:text-ink"
      >
        Sign in
      </Link>
    );
  }

  const label = account.name || account.email || "Account";
  const initial = (account.name || account.email || "?").trim().charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-2.5 text-[13px] text-ink hover:border-brass"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {account.image && imgOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={account.image}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setImgOk(false)}
            className="h-6 w-6 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brass text-[12px] font-semibold text-[#1a1410]">
            {initial}
          </span>
        )}
        <span className="max-w-[120px] truncate">{label}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-56 overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        >
          <div className="border-b border-line px-4 py-3">
            <p className="truncate text-[13px] font-medium text-ink">{account.name || "Signed in"}</p>
            {account.email && <p className="truncate text-[12px] text-soft">{account.email}</p>}
          </div>
          <Link
            href="/trips"
            onClick={() => setOpen(false)}
            role="menuitem"
            className="block px-4 py-2.5 text-[13px] text-ink hover:bg-parchment2"
          >
            My trips
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              role="menuitem"
              className="block w-full px-4 py-2.5 text-left text-[13px] text-ink hover:bg-parchment2"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default function Experience({
  mode,
  query,
  sections = [],
  result = null,
  searchError = null,
  account = null,
}: {
  mode: "browse" | "search";
  query: Query;
  sections?: SeasonalSection[];
  result?: SearchResult | null;
  searchError?: string | null;
  account?: Account;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [mounted, setMounted] = useState(false);
  const [inclFees, setInclFees] = useState(true);
  // Netflix-style "which tile did I come from" cue: set right before
  // navigating to a hotel's page, read once when the list mounts (e.g. on
  // browser back), then faded out — a lightweight substitute for a full
  // shared-element transition.
  const [justViewedId, setJustViewedId] = useState<string | null>(null);
  useEffect(() => {
    try {
      const id = sessionStorage.getItem("lastViewedStayId");
      if (id) {
        setJustViewedId(id);
        sessionStorage.removeItem("lastViewedStayId");
        const t = setTimeout(() => setJustViewedId(null), 2600);
        return () => clearTimeout(t);
      }
    } catch {
      // sessionStorage unavailable (privacy mode etc.) — no highlight, no harm
    }
  }, []);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function currentTheme() {
    if (theme) return theme;
    return typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  // Pre-mount, render a stable label so server and client HTML match.
  const themeLabel = !mounted ? "Dusk" : currentTheme() === "dark" ? "Daylight" : "Dusk";

  // A tile click opens a lightweight preview first — more photos, rating,
  // amenities, price — with no booking machinery in it, so there's nothing
  // to lose if it's closed by accident. Only the preview's own "Explore
  // rooms" button commits to the full page (room selection + booking).
  const [preview, setPreview] = useState<HotelStay | null>(null);
  const open = (stay: HotelStay) => setPreview(stay);

  const explore = (stay: HotelStay) => {
    try {
      sessionStorage.setItem("lastViewedStayId", stay.id);
    } catch {
      // sessionStorage unavailable — the return-highlight just won't show
    }
    const params = new URLSearchParams({
      checkin: query.checkin,
      nights: String(query.nights),
      dest: query.dest,
    });
    if (query.notes) params.set("notes", query.notes);
    router.push(`/stay/${stay.id}?${params.toString()}`);
  };

  return (
    <FeesContext.Provider value={inclFees}>
    <MemberContext.Provider value={Boolean(account)}>
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-40 border-b border-line glass">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </a>
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setTheme(currentTheme() === "dark" ? "light" : "dark")}
              className="rounded-full border border-line px-3 py-1.5 text-[13px] text-soft hover:border-brass hover:text-ink"
            >
              {themeLabel}
            </button>
            <AccountMenu account={account} />
          </div>
        </div>
      </header>

      {/* Full hero on browse; once there's a result, the search itself is the
          focus — shrink to a slim bar so tiles get the room. */}
      {mode === "search" && result ? (
        <section className="border-b border-line">
          <div className="mx-auto w-full max-w-[1440px] px-6 py-3">
            <BookingForm query={query} compact />
          </div>
        </section>
      ) : (
        <section className="border-b border-line">
          <div className="mx-auto w-full max-w-[1440px] px-6 py-8">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-brass">
                  Your travel concierge
                </p>
                <h1 className="font-display text-[clamp(24px,3.4vw,34px)] leading-tight tracking-[-0.01em]">
                  Fewer places. The <span className="italic text-brass">right</span> ones.
                </h1>
              </div>
              <p className="max-w-[42ch] text-[13.5px] text-soft">
                Tell us where and when. We come back with a short list worth booking, taxes and fees
                included, usually for less than the big sites charge.
              </p>
            </div>
            <BookingForm query={query} />
          </div>
        </section>
      )}

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-6">
        {!account && <PublicPricingBanner />}
        {mode === "search" ? (
          <SearchResults
            result={result}
            error={searchError}
            onOpen={open}
            inclFees={inclFees}
            onToggleFees={() => setInclFees((v) => !v)}
            justViewedId={justViewedId}
          />
        ) : (
          <BrowseRows sections={sections} />
        )}
      </main>

      {preview && (
        <HotelPreviewModal
          stay={preview}
          nights={query.nights}
          onClose={() => setPreview(null)}
          onExplore={() => {
            setPreview(null);
            explore(preview);
          }}
        />
      )}
    </div>
    </MemberContext.Provider>
    </FeesContext.Provider>
  );
}

// Quick-look preview: more photos, rating, amenities, price — everything a
// visitor needs to decide "is this worth exploring further" without leaving
// the results page. No booking logic lives here, so Escape/backdrop-click
// closing it can never lose anything; "Explore rooms" is the only path to
// the full page (room selection + booking).
// Same "honest reasons" framing as the old modal — category-aware, since
// (unlike the standalone /stay page) this preview has the full search-result
// HotelStay on hand, categories included.
function previewReasons(stay: HotelStay, facilities: string[]): string[] {
  const out: string[] = [];
  const save = stay.them ? stay.them - stay.you : 0;
  if (save > 0) out.push(`$${save} under the Booking.com price`);
  if (stay.rating != null && stay.rating >= 8) {
    out.push(
      `${stay.rating >= 9 ? "Superb" : "Very good"} ${stay.rating.toFixed(1)} guest score` +
        (stay.reviewCount >= 200 ? ` across ${stay.reviewCount.toLocaleString()} reviews` : ""),
    );
  }
  if (stay.categories.includes("convenience")) out.push("Central to the area's main sights");
  else if (stay.categories.includes("luxury")) out.push("One of the top-tier stays here");
  else if (stay.categories.includes("comfort")) out.push("A dependable, well-reviewed pick");
  else if (stay.categories.includes("budget")) out.push("Among the best value in this search");
  const fac = facilities.find((f) => /pool|spa|breakfast|parking|gym|fitness|beach|view/i.test(f));
  if (fac && out.length < 3) out.push(fac);
  if (stay.stars >= 4 && out.length < 3) out.push(`${stay.stars}-star property`);
  return out.slice(0, 3);
}

function HotelPreviewModal({
  stay,
  nights,
  onClose,
  onExplore,
}: {
  stay: HotelStay;
  nights: number;
  onClose: () => void;
  onExplore: () => void;
}) {
  const isMember = useMember();
  const incl = useInclFees();
  const [images, setImages] = useState<string[]>(stay.photo ? [stay.photo] : []);
  const [amenities, setAmenities] = useState<AmenityKey[]>([]);
  const [facilities, setFacilities] = useState<string[]>([]);
  const [reviews, setReviews] = useState<ReviewSnippet[]>([]);
  const [times, setTimes] = useState<{ ci: string | null; co: string | null }>({
    ci: null,
    co: null,
  });
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/hotel-preview/${stay.id}`);
        const d = await r.json();
        if (cancelled) return;
        if (Array.isArray(d.images) && d.images.length) setImages(d.images);
        if (Array.isArray(d.amenities)) setAmenities(d.amenities);
        if (Array.isArray(d.facilities)) setFacilities(d.facilities);
        if (Array.isArray(d.reviews)) setReviews(d.reviews);
        setTimes({ ci: d.checkinTime ?? null, co: d.checkoutTime ?? null });
      } catch {
        // keep the single listing photo; the rest of the panel just stays sparse
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stay.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") setIdx((i) => (images.length ? (i + 1) % images.length : 0));
      if (e.key === "ArrowLeft")
        setIdx((i) => (images.length ? (i - 1 + images.length) % images.length : 0));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, images.length]);

  const you = incl ? stay.you + stay.feeAtHotel : stay.you;
  const perNight = Math.round(you / nights);
  const publicBase = stay.them ?? stay.you;
  const publicPrice = incl ? publicBase + stay.feeAtHotel : publicBase;
  const publicPerNight = Math.round(publicPrice / nights);
  const band = memberSavingsBand(stay.you, stay.them);
  const reasons = previewReasons(stay, facilities);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-[rgba(12,9,16,0.6)] p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rise flex h-full w-full max-w-[960px] flex-col overflow-hidden border-line bg-parchment shadow-[var(--shadow-lg)] sm:h-auto sm:max-h-[90vh] sm:rounded-2xl sm:border"
      >
        <div
          className="relative h-[280px] w-full shrink-0 overflow-hidden sm:h-[420px]"
          style={{ background: fallbackArt(stay.id) }}
        >
          <div
            className="flex h-full transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${idx * 100}%)` }}
          >
            {images.map((src, i) => (
              <div key={i} className="relative h-full w-full shrink-0">
                <Image
                  src={src}
                  alt={`${stay.name} photo ${i + 1}`}
                  fill
                  sizes="(max-width: 960px) 100vw, 960px"
                  className="object-cover"
                  priority={i === 0}
                />
              </div>
            ))}
          </div>

          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-black/50 text-lg text-white hover:bg-black/70"
          >
            ×
          </button>

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

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
            <div>
              <div className="text-[11px] uppercase tracking-[0.1em] text-soft">
                {stay.city}
                {stay.stars > 0 ? ` · ${"★".repeat(stay.stars)}` : ""}
              </div>
              <h3 className="font-display text-[26px] leading-tight tracking-[-0.01em]">
                {stay.name}
              </h3>
              <div className="mt-1.5">
                <ReviewLine stay={stay} />
              </div>
              {stay.address && <p className="mt-1.5 text-[13px] text-soft">{stay.address}</p>}
              {(times.ci || times.co) && (
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-soft">
                  {times.ci && <span>Check-in from {times.ci}</span>}
                  {times.co && <span>Check-out by {times.co}</span>}
                </div>
              )}

              {amenities.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  {amenities.map((a) => (
                    <AmenityIcon key={a} kind={a} size={20} />
                  ))}
                </div>
              )}

              {facilities.length > 0 && (
                <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-soft">
                    Amenities
                  </h4>
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

              {reasons.length > 0 && (
                <div className="mt-4 flex flex-col gap-2.5 border-t border-line pt-4">
                  <h4 className="font-display text-[17px]">Why we recommend it</h4>
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
              )}
            </div>

            {reviews.length > 0 && (
              <div className="flex flex-col gap-2.5 border-t border-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
                <h4 className="font-display text-[17px]">What guests say</h4>
                {reviews.map((rv, i) => (
                  <div key={i} className="rounded-lg border border-line bg-surface p-3">
                    {rv.headline && (
                      <div className="text-[13.5px] font-semibold text-ink">“{rv.headline}”</div>
                    )}
                    {rv.pros && (
                      <div className="mt-0.5 line-clamp-3 text-[13px] text-soft">{rv.pros}</div>
                    )}
                    <div className="mt-1.5 text-[11px] uppercase tracking-wide text-soft">
                      {rv.name}
                      {rv.country ? ` · ${rv.country.toUpperCase()}` : ""}
                      {rv.type ? ` · ${rv.type}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/60 p-4 sm:p-5">
          <div>
            {isMember ? (
              <>
                <div className="text-[11px] text-soft tabular-nums">${perNight}/night</div>
                <div className="flex items-baseline gap-1.5 font-mono">
                  <span className="text-[22px] font-bold tabular-nums">${you}</span>
                  <span className="text-[11px] text-soft">total</span>
                  {stay.them && stay.them > you && (
                    <span className="text-[13px] text-soft line-through tabular-nums">${stay.them}</span>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="text-[11px] text-soft tabular-nums">${publicPerNight}/night</div>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[22px] font-bold tabular-nums">${publicPrice}</span>
                  <span className="text-[12px] text-soft">public · total</span>
                </div>
              </>
            )}
            {!isMember && band > 0 && (
              <div className="text-[11.5px] font-medium text-brass">Members save up to {band}%</div>
            )}
          </div>
          <button
            onClick={onExplore}
            className="btn-brass shrink-0 rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
          >
            Explore rooms →
          </button>
        </div>
      </div>
    </div>
  );
}

function BookingForm({ query, compact = false }: { query: Query; compact?: boolean }) {
  const router = useRouter();
  const [dest, setDest] = useState(query.dest);
  const [checkin, setCheckin] = useState(query.checkin);
  const [nights, setNights] = useState(query.nights);
  const [notes, setNotes] = useState(query.notes);
  const [pending, startTransition] = useTransition();
  const today = new Date().toISOString().slice(0, 10);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(() => {
      const notesParam = notes.trim() ? `&notes=${encodeURIComponent(notes.trim())}` : "";
      router.push(`/?dest=${dest}&checkin=${checkin}&nights=${nights}${notesParam}`);
    });
  }

  return (
    <form
      onSubmit={submit}
      className={
        "flex flex-col gap-2.5 rounded-xl border border-line bg-surface gloss smooth focus-within:border-brass/50 sm:flex-row sm:items-stretch " +
        (compact ? "p-1.5" : "mt-5 p-2.5")
      }
    >
      <DestinationField value={dest} onChange={setDest} compact={compact} />
      <Divider />
      <Field label="Check-in" className="sm:flex-1" compact={compact}>
        <input
          type="date"
          value={checkin}
          min={today}
          onChange={(e) => setCheckin(e.target.value)}
          className="w-full bg-transparent text-[15px] text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]"
        />
      </Field>
      <Divider />
      <Field label="Nights" className="sm:w-28" compact={compact}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNights((n) => Math.max(1, n - 1))}
            className="grid h-6 w-6 place-items-center rounded-full border border-line text-soft hover:border-brass hover:text-ink"
            aria-label="One fewer night"
          >
            −
          </button>
          <span className="min-w-6 text-center text-[15px] font-semibold tabular-nums">{nights}</span>
          <button
            type="button"
            onClick={() => setNights((n) => Math.min(30, n + 1))}
            className="grid h-6 w-6 place-items-center rounded-full border border-line text-soft hover:border-brass hover:text-ink"
            aria-label="One more night"
          >
            +
          </button>
        </div>
      </Field>
      <Divider />
      <Field label="Preferences" className="sm:flex-[1.6]" compact={compact}>
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What are you looking for? e.g. quiet, near downtown, pool"
          className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-soft/60"
        />
      </Field>
      <button
        type="submit"
        disabled={pending}
        className={
          "btn-brass rounded-lg text-[15px] font-semibold text-[#1a1410] disabled:opacity-60 sm:self-stretch " +
          (compact ? "px-5 py-2" : "px-6 py-3")
        }
      >
        {pending ? (compact ? "Updating…" : "Searching…") : compact ? "Update search" : "Search"}
      </button>
    </form>
  );
}

type CitySuggestion = { dest: string; name: string; sub: string };

function DestinationField({
  value,
  onChange,
  compact = false,
}: {
  value: string;
  onChange: (dest: string) => void;
  compact?: boolean;
}) {
  const initial = DESTINATIONS.find((d) => d.key === value)?.name ?? value;
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [results, setResults] = useState<CitySuggestion[]>([]);
  const justPicked = useRef(false);

  // debounced autocomplete over curated hotspots + all US cities
  useEffect(() => {
    if (justPicked.current) {
      justPicked.current = false;
      return;
    }
    const id = setTimeout(async () => {
      try {
        const r = await fetch(`/api/cities?q=${encodeURIComponent(text)}`);
        const d = await r.json();
        setResults(d.results || []);
        setHi(0);
      } catch {
        setResults([]);
      }
    }, 150);
    return () => clearTimeout(id);
  }, [text]);

  function pick(s: CitySuggestion) {
    justPicked.current = true;
    onChange(s.dest);
    setText(s.name);
    setOpen(false);
  }

  return (
    <div className="relative sm:flex-[2]">
      <div
        className={
          "flex flex-col justify-center gap-0.5 rounded-lg " + (compact ? "px-2.5 py-1" : "px-3.5 py-2")
        }
      >
        <span
          className={"uppercase tracking-[0.1em] text-soft " + (compact ? "text-[9.5px]" : "text-[11px]")}
        >
          Destination
        </span>
        <input
          value={text}
          placeholder="Search any US city…"
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setHi((h) => Math.min(h + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHi((h) => Math.max(h - 1, 0));
            } else if (e.key === "Enter" && open && results[hi]) {
              e.preventDefault();
              pick(results[hi]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          className="w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-soft"
        />
      </div>

      {open && results.length > 0 && (
        <ul className="no-scrollbar absolute left-0 top-full z-30 mt-1 max-h-72 w-[min(360px,88vw)] overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-[0_24px_60px_-30px_rgba(24,18,10,0.6)]">
          {results.map((s, i) => (
            <li key={s.dest}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setHi(i)}
                className={
                  "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] " +
                  (i === hi ? "bg-parchment2" : "")
                }
              >
                <span className="text-brass">◍</span>
                <span className="font-medium text-ink">{s.name}</span>
                <span className="ml-auto text-[12px] text-soft">{s.sub}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({
  label,
  className = "",
  compact = false,
  children,
}: {
  label: string;
  className?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      className={
        "flex flex-col justify-center gap-0.5 rounded-lg " +
        (compact ? "px-2.5 py-1 " : "px-3.5 py-2 ") +
        className
      }
    >
      <span
        className={
          "uppercase tracking-[0.1em] text-soft " + (compact ? "text-[9.5px]" : "text-[11px]")
        }
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Divider() {
  return <div className="hidden w-px self-stretch bg-line sm:block" />;
}

// Shown to logged-out visitors: they see public prices only; the member rate is
// unlocked by signing in. Keeps us parity-compliant while teasing the value.
function PublicPricingBanner() {
  return (
    <div className="smooth mt-5 flex items-center justify-between gap-3 rounded-xl border border-brass/30 bg-brass/[0.07] px-4 py-2.5">
      <p className="text-[13px] text-ink">
        You&rsquo;re seeing public prices.{" "}
        <span className="text-soft">Sign in to unlock member rates, usually well below these.</span>
      </p>
      <Link
        href="/signin"
        className="btn-brass shrink-0 whitespace-nowrap rounded-lg px-3.5 py-1.5 text-[13px] font-semibold text-[#1a1410]"
      >
        Sign in
      </Link>
    </div>
  );
}

function SearchResults({
  result,
  error,
  onOpen,
  inclFees,
  onToggleFees,
  justViewedId,
}: {
  result: SearchResult | null;
  error: string | null;
  onOpen: (s: HotelStay, i: Intent) => void;
  inclFees: boolean;
  onToggleFees: () => void;
  justViewedId: string | null;
}) {
  if (error) {
    return (
      <div className="mt-8 rounded-xl border border-line bg-surface p-6 text-soft">
        We could not load rates just now. {error}
      </div>
    );
  }
  if (!result || result.items.length === 0) {
    return (
      <div className="mt-8 rounded-xl border border-line bg-surface p-6 text-soft">
        No priced stays came back for those dates. Try different dates or another destination.
      </div>
    );
  }
  return (
    <SearchResultsInner
      result={result}
      onOpen={onOpen}
      inclFees={inclFees}
      onToggleFees={onToggleFees}
      justViewedId={justViewedId}
    />
  );
}

function SearchResultsInner({
  result,
  onOpen,
  inclFees,
  onToggleFees,
  justViewedId,
}: {
  result: SearchResult;
  onOpen: (s: HotelStay, i: Intent) => void;
  inclFees: boolean;
  onToggleFees: () => void;
  justViewedId: string | null;
}) {
  const [active, setActive] = useState<Category | "all">("all");
  const [sort, setSort] = useState<SortKey>("recommended");
  const [view, setView] = useState<"list" | "map">("list");
  const isMember = useMember();

  const counts = CAT_ORDER.map((c) => ({
    cat: c,
    n: result.items.filter((i) => i.categories.includes(c)).length,
  })).filter((x) => x.n > 0);

  const filtered =
    active === "all" ? result.items : result.items.filter((i) => i.categories.includes(active));
  const shown = sortItems(filtered, sort);

  return (
    <section className="pt-7">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-display text-[24px] tracking-[-0.01em]">
          {result.items.length} stays in {result.city}
        </h2>
        <span className="text-[13px] text-soft">
          {prettyDate(result.checkin)} · {result.nights} {result.nights === 1 ? "night" : "nights"}
        </span>
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <FilterChip on={active === "all"} onClick={() => setActive("all")}>
            All <span className="ml-1 opacity-55">{result.items.length}</span>
          </FilterChip>
          {counts.map(({ cat, n }) => (
            <FilterChip key={cat} on={active === cat} onClick={() => setActive(cat)}>
              {CAT_LABEL[cat]} <span className="ml-1 opacity-55">{n}</span>
            </FilterChip>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
            <button
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              className={
                "smooth rounded-md px-3 py-1 text-[13px] font-medium " +
                (view === "list" ? "bg-brass text-[#1a1410]" : "text-soft hover:text-ink")
              }
            >
              List
            </button>
            <button
              onClick={() => setView("map")}
              aria-pressed={view === "map"}
              className={
                "smooth rounded-md px-3 py-1 text-[13px] font-medium " +
                (view === "map" ? "bg-brass text-[#1a1410]" : "text-soft hover:text-ink")
              }
            >
              Map
            </button>
          </div>
          <FeesToggle on={inclFees} onToggle={onToggleFees} />
          <label className="flex items-center gap-2 text-[13px] text-soft">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink outline-none focus-visible:border-brass"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key} className="bg-surface text-ink">
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {view === "map" ? (
        <div className="gloss h-[min(75vh,760px)] min-h-[520px] w-full overflow-hidden rounded-[14px] border border-line">
          <StaysMap
            stays={shown}
            onOpen={onOpen}
            isMember={isMember}
            inclFees={inclFees}
            checkin={result.checkin}
            nights={result.nights}
          />
        </div>
      ) : (
        <div key={`${active}-${sort}`} className="stagger grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((stay) => (
            <StayCard
              key={stay.id}
              stay={stay}
              nights={result.nights}
              onOpen={onOpen}
              justViewed={stay.id === justViewedId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FilterChip({
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
        "rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors " +
        (on
          ? "border-brass bg-brass text-[#1a1410]"
          : "border-line text-soft hover:border-brass hover:text-ink")
      }
    >
      {children}
    </button>
  );
}

function FeesToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-pressed={on}
      className={
        "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] transition-colors " +
        (on
          ? "border-brass bg-brass/10 text-brass"
          : "border-line text-soft hover:border-brass hover:text-ink")
      }
    >
      <span
        className={
          "flex h-4 w-7 items-center rounded-full px-0.5 transition-colors " +
          (on ? "bg-brass" : "bg-line")
        }
      >
        <span
          className={
            "h-3 w-3 rounded-full bg-white transition-transform " + (on ? "translate-x-3" : "")
          }
        />
      </span>
      Include taxes &amp; fees
    </button>
  );
}

function BrowseRows({ sections }: { sections: SeasonalSection[] }) {
  return (
    <>
      {sections.map((sec) => (
        <section key={sec.key} className="pt-6 pb-2">
          <div className="mb-4 flex items-baseline justify-between gap-3">
            <div>
              <h2 className="font-display text-[24px] tracking-[-0.01em]">{sec.title}</h2>
              <p className="mt-1 text-sm text-soft">{sec.blurb}</p>
            </div>
            <span className="whitespace-nowrap text-xs uppercase tracking-[0.12em] text-brass">
              {sec.badge}
            </span>
          </div>
          <div className="rail stagger grid grid-flow-col auto-cols-[minmax(210px,1fr)] gap-4 overflow-x-auto pb-3.5 md:grid-flow-row md:grid-cols-3 md:overflow-visible">
            {sec.destinations.map((d) => (
              <DestinationCard key={d.key} d={d} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

// A place to go, not a specific hotel. Clicking runs the curated search for it.
function DestinationCard({ d }: { d: SeasonalSection["destinations"][number] }) {
  return (
    <Link
      href={`/?dest=${d.key}`}
      className="group relative flex h-52 flex-col justify-end overflow-hidden rounded-[14px] border border-line gloss gloss-lift smooth hover:border-brass/50 focus-visible:outline-2 focus-visible:outline-brass"
      style={{ background: fallbackArt(d.key) }}
    >
      {d.image && (
        <Image
          src={d.image}
          alt={d.name}
          fill
          sizes="(max-width: 768px) 60vw, 300px"
          className="object-cover transition-transform duration-300 group-hover:scale-[1.04]"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />
      <div className="relative p-4">
        <div className="text-[11px] uppercase tracking-[0.12em] text-white/70">{d.region}</div>
        <h3 className="font-display text-[21px] leading-tight text-white">{d.name}</h3>
        <p className="mt-0.5 text-[12.5px] text-white/85">{d.blurb}</p>
      </div>
    </Link>
  );
}

function StayCard({
  stay,
  nights,
  onOpen,
  justViewed = false,
}: {
  stay: HotelStay;
  nights: number;
  onOpen: (s: HotelStay, i: Intent) => void;
  justViewed?: boolean;
}) {
  const incl = useInclFees();
  const isMember = useMember();
  const you = incl ? stay.you + stay.feeAtHotel : stay.you;
  const perNight = Math.round(you / nights);
  const save = stay.them ? stay.them - you : 0;
  const pct = stay.them ? Math.round((save / stay.them) * 100) : 0;
  const band = memberSavingsBand(stay.you, stay.them);
  // Public (parity-safe) price: the SSP if we have one, else our only price.
  const publicBase = stay.them ?? stay.you;
  const publicPrice = incl ? publicBase + stay.feeAtHotel : publicBase;
  const publicPerNight = Math.round(publicPrice / nights);

  // Gallery + amenity icons both live behind one lazy fetch — the bulk
  // search listing only carries a single photo and no facility list per
  // hotel. Owned here (not inside the gallery) since amenities render in
  // the text block below, not the image area.
  const [images, setImages] = useState<string[]>(stay.photo ? [stay.photo] : []);
  const [amenities, setAmenities] = useState<AmenityKey[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const release = await hotelExtrasQueue.acquire();
      try {
        const r = await fetch(`/api/hotel-images/${stay.id}`);
        const d = await r.json();
        if (cancelled) return;
        if (Array.isArray(d.images) && d.images.length) setImages(d.images);
        if (Array.isArray(d.amenities)) setAmenities(d.amenities);
      } catch {
        // leave the single listing photo + no amenity row — not worth retrying
      } finally {
        release();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stay.id]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(stay, "view")}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(stay, "view");
        }
      }}
      aria-label={`View ${stay.name}`}
      className={
        "group flex cursor-pointer flex-col overflow-hidden rounded-[14px] border bg-surface gloss gloss-lift smooth hover:border-brass/50 focus-visible:outline-2 focus-visible:outline-brass " +
        (justViewed ? "border-brass ring-2 ring-brass/60" : "border-line")
      }
    >
      <StayCardGallery stay={stay} images={images} isMember={isMember} pct={pct} band={band} />

      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <h3 className="line-clamp-1 font-display text-[19px] leading-tight">{stay.name}</h3>
        <div className="flex items-center gap-2">
          <ReviewLine stay={stay} />
        </div>

        <div className="mt-1 flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {amenities.map((a) => (
              <AmenityIcon key={a} kind={a} size={20} />
            ))}
          </div>
          {isMember ? (
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-[11px] text-soft tabular-nums">${perNight}/night</span>
              <div className="flex items-baseline gap-1.5 font-mono">
                <span className="text-[22px] font-bold tabular-nums">${you}</span>
                <span className="text-[11px] text-soft">total</span>
              </div>
              {stay.them && stay.them > you && (
                <span className="text-[12.5px] text-soft line-through tabular-nums">${stay.them}</span>
              )}
            </div>
          ) : (
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-[11px] text-soft tabular-nums">${publicPerNight}/night</span>
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-[22px] font-bold tabular-nums">${publicPrice}</span>
                <span className="text-[11px] text-soft">public · total</span>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3">
          {!isMember && band > 0 ? (
            <div className="text-[12.5px] font-medium text-brass">Members save up to {band}%</div>
          ) : (
            <span />
          )}
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[13px] font-medium text-brass">
            View
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// Image-first card gallery: one photo up front (from the search-results
// listing), more arrive once the card's lazy /api/hotel-images fetch (owned
// by the parent StayCard) resolves — this component just renders whatever
// `images` it's given and lets the visitor swipe/click through them.
function StayCardGallery({
  stay,
  images,
  isMember,
  pct,
  band,
}: {
  stay: HotelStay;
  images: string[];
  isMember: boolean;
  pct: number;
  band: number;
}) {
  const [idx, setIdx] = useState(0);
  const touchX = useRef<number | null>(null);

  const go = useCallback(
    (dir: 1 | -1, e?: React.SyntheticEvent) => {
      e?.stopPropagation();
      setIdx((i) => {
        const len = images.length || 1;
        return (i + dir + len) % len;
      });
    },
    [images.length],
  );

  return (
    <div
      className="relative h-64 w-full overflow-hidden"
      style={{ background: fallbackArt(stay.id) }}
      onTouchStart={(e) => {
        touchX.current = e.touches[0].clientX;
      }}
      onTouchEnd={(e) => {
        if (touchX.current == null) return;
        const dx = e.changedTouches[0].clientX - touchX.current;
        touchX.current = null;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1, e);
      }}
    >
      {images[idx] && (
        <Image
          key={images[idx]}
          src={images[idx]}
          alt={stay.name}
          fill
          sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 440px"
          className="object-cover"
        />
      )}

      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label="Previous photo"
            onClick={(e) => go(-1, e)}
            className="absolute left-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-black/60"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Next photo"
            onClick={(e) => go(1, e)}
            className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-black/40 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 hover:bg-black/60"
          >
            ›
          </button>
        </>
      )}

      {images.length > 1 && images.length <= 8 && (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1">
          {images.map((_, i) => (
            <span
              key={i}
              className={
                "h-1 w-1 rounded-full transition-colors " + (i === idx ? "bg-white" : "bg-white/40")
              }
            />
          ))}
        </div>
      )}

      {isMember && pct > 0 && (
        <span className="absolute left-2.5 top-2.5 rounded-full bg-black/35 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-white/15 backdrop-blur-md">
          {pct}% off
        </span>
      )}
      {!isMember && band > 0 && (
        <span className="absolute left-2.5 top-2.5 rounded-full bg-black/35 px-2.5 py-1 text-[11px] font-semibold text-white ring-1 ring-white/15 backdrop-blur-md">
          Member rate
        </span>
      )}
      {stay.stars > 0 && (
        <span className="absolute bottom-2.5 right-3 text-[13px] tracking-[1px] text-brassglow [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
          {"★".repeat(stay.stars)}
        </span>
      )}
    </div>
  );
}
