"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOutAction } from "@/app/actions/auth";
import { prepareBookingAction } from "@/app/actions/booking";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import type {
  Category,
  HotelStay,
  ReviewSnippet,
  RoomOption,
  SearchResult,
} from "@/lib/liteapi";
import type { SeasonalSection } from "@/lib/seasonal";
import { DESTINATIONS } from "@/lib/destinations";

const CAT_LABEL: Record<Category, string> = {
  budget: "Budget",
  comfort: "Comfort",
  luxury: "Luxury",
  convenience: "Central",
};
const CAT_ORDER: Category[] = ["budget", "comfort", "luxury", "convenience"];
const CAT_CLASS: Record<Category, string> = {
  luxury: "border-brass/40 bg-brass/12 text-brass", // soft gold
  comfort: "border-sage/50 bg-sage/15 text-sage", // sage green
  convenience: "border-slate-400/35 bg-slate-400/12 text-slate-600 dark:text-slate-300", // muted slate
  budget: "border-stone-400/40 bg-stone-400/12 text-stone-600 dark:text-stone-300", // quiet stone
};

function reviewLabel(r: number) {
  if (r >= 9.5) return "Exceptional";
  if (r >= 9) return "Superb";
  if (r >= 8) return "Very good";
  if (r >= 7) return "Good";
  return "Rated";
}

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

function ReviewLine({ stay }: { stay: HotelStay }) {
  if (stay.rating == null) return null;
  return (
    <div className="flex items-center gap-1.5 text-[12px]">
      <span className="rounded bg-brass px-1.5 py-0.5 font-mono text-[11px] font-bold text-[#1a1410]">
        {stay.rating.toFixed(1)}
      </span>
      <span className="font-semibold text-ink">{reviewLabel(stay.rating)}</span>
      {stay.reviewCount > 0 && (
        <span className="text-soft">· {stay.reviewCount.toLocaleString()} reviews</span>
      )}
    </div>
  );
}

// Honest reasons drawn only from real signals — never fabricated prose.
function recommendReasons(stay: HotelStay, facilities: string[]): string[] {
  const out: string[] = [];
  const save = stay.them ? stay.them - stay.you : 0;
  if (save > 0) out.push(`$${save} under the Booking.com price`);
  if (stay.rating != null && stay.rating >= 8) {
    out.push(
      `${reviewLabel(stay.rating)} ${stay.rating.toFixed(1)} guest score` +
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

function WhyRecommend({ stay, facilities }: { stay: HotelStay; facilities: string[] }) {
  const reasons = recommendReasons(stay, facilities);
  if (!reasons.length) return null;
  return (
    <div className="flex flex-col gap-2.5 border-t border-line pt-4">
      <h4 className="font-display text-[19px]">Why we recommend it</h4>
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

function CategoryBadges({ cats }: { cats: Category[] }) {
  if (!cats.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {[...cats]
        .sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b))
        .map((c) => (
          <span
            key={c}
            className={
              "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
              CAT_CLASS[c]
            }
          >
            {CAT_LABEL[c]}
          </span>
        ))}
    </div>
  );
}

// ---- deterministic dusk gradient, used only when a hotel has no photo ----
function fallbackArt(seed: string) {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n * 31 + seed.charCodeAt(i)) % 360;
  const h2 = (n + 40) % 360;
  return `radial-gradient(120% 90% at 78% 12%, hsl(${h2} 40% 42%) 0%, transparent 55%), linear-gradient(150deg, hsl(${n} 32% 26%), hsl(${(n + 300) % 360} 30% 16%))`;
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

type Query = { dest: string; checkin: string; nights: number };
type Intent = "view" | "book";
type ModalTarget = { stay: HotelStay; intent: Intent };

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
function memberSavingsBand(you: number, them?: number | null): number {
  if (!them || you >= them) return 0;
  return Math.min(60, Math.ceil((((them - you) / them) * 100) / 5) * 5);
}

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
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [mounted, setMounted] = useState(false);
  const [modal, setModal] = useState<ModalTarget | null>(null);
  const [inclFees, setInclFees] = useState(false);

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

  const open = (stay: HotelStay, intent: Intent) => setModal({ stay, intent });

  return (
    <FeesContext.Provider value={inclFees}>
    <MemberContext.Provider value={Boolean(account)}>
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-40 border-b border-line glass">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-6">
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

      {/* compact hero + booking form */}
      <section className="border-b border-line">
        <div className="mx-auto w-full max-w-[1180px] px-6 py-8">
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

      <main className="mx-auto w-full max-w-[1180px] flex-1 px-6">
        {!account && <PublicPricingBanner />}
        {mode === "search" ? (
          <SearchResults
            result={result}
            error={searchError}
            onOpen={open}
            inclFees={inclFees}
            onToggleFees={() => setInclFees((v) => !v)}
          />
        ) : (
          <BrowseRows sections={sections} />
        )}
      </main>

      {modal && (
        <HotelModal
          stay={modal.stay}
          intent={modal.intent}
          query={query}
          onClose={() => setModal(null)}
        />
      )}
    </div>
    </MemberContext.Provider>
    </FeesContext.Provider>
  );
}

function BookingForm({ query }: { query: Query }) {
  const router = useRouter();
  const [dest, setDest] = useState(query.dest);
  const [checkin, setCheckin] = useState(query.checkin);
  const [nights, setNights] = useState(query.nights);
  const [pending, startTransition] = useTransition();
  const today = new Date().toISOString().slice(0, 10);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(() => {
      router.push(`/?dest=${dest}&checkin=${checkin}&nights=${nights}`);
    });
  }

  return (
    <form
      onSubmit={submit}
      className="mt-5 flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-2.5 gloss smooth focus-within:border-brass/50 sm:flex-row sm:items-stretch"
    >
      <DestinationField value={dest} onChange={setDest} />
      <Divider />
      <Field label="Check-in" className="sm:flex-1">
        <input
          type="date"
          value={checkin}
          min={today}
          onChange={(e) => setCheckin(e.target.value)}
          className="w-full bg-transparent text-[15px] text-ink outline-none [color-scheme:light] dark:[color-scheme:dark]"
        />
      </Field>
      <Divider />
      <Field label="Nights" className="sm:w-28">
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
      <button
        type="submit"
        disabled={pending}
        className="btn-brass rounded-lg px-6 py-3 text-[15px] font-semibold text-[#1a1410] disabled:opacity-60 sm:self-stretch"
      >
        {pending ? "Searching…" : "Search"}
      </button>
    </form>
  );
}

type CitySuggestion = { dest: string; name: string; sub: string };

function DestinationField({
  value,
  onChange,
}: {
  value: string;
  onChange: (dest: string) => void;
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
      <div className="flex flex-col justify-center gap-0.5 rounded-lg px-3.5 py-2">
        <span className="text-[11px] uppercase tracking-[0.1em] text-soft">Destination</span>
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
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={"flex flex-col justify-center gap-0.5 rounded-lg px-3.5 py-2 " + className}>
      <span className="text-[11px] uppercase tracking-[0.1em] text-soft">{label}</span>
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
}: {
  result: SearchResult | null;
  error: string | null;
  onOpen: (s: HotelStay, i: Intent) => void;
  inclFees: boolean;
  onToggleFees: () => void;
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
    />
  );
}

function SearchResultsInner({
  result,
  onOpen,
  inclFees,
  onToggleFees,
}: {
  result: SearchResult;
  onOpen: (s: HotelStay, i: Intent) => void;
  inclFees: boolean;
  onToggleFees: () => void;
}) {
  const [active, setActive] = useState<Category | "all">("all");
  const [sort, setSort] = useState<SortKey>("recommended");

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

      <div key={`${active}-${sort}`} className="stagger grid grid-cols-2 gap-4 md:grid-cols-4">
        {shown.map((stay) => (
          <StayCard key={stay.id} stay={stay} onOpen={onOpen} />
        ))}
      </div>
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
  onOpen,
}: {
  stay: HotelStay;
  onOpen: (s: HotelStay, i: Intent) => void;
}) {
  const incl = useInclFees();
  const isMember = useMember();
  const you = incl ? stay.you + stay.feeAtHotel : stay.you;
  const save = stay.them ? stay.them - you : 0;
  const pct = stay.them ? Math.round((save / stay.them) * 100) : 0;
  const band = memberSavingsBand(stay.you, stay.them);
  // Public (parity-safe) price: the SSP if we have one, else our only price.
  const publicBase = stay.them ?? stay.you;
  const publicPrice = incl ? publicBase + stay.feeAtHotel : publicBase;
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
      className="group flex cursor-pointer flex-col overflow-hidden rounded-[14px] border border-line bg-surface gloss gloss-lift smooth hover:border-brass/50 focus-visible:outline-2 focus-visible:outline-brass"
    >
      <div className="relative h-40 w-full" style={{ background: fallbackArt(stay.id) }}>
        {stay.photo && (
          <Image
            src={stay.photo}
            alt={stay.name}
            fill
            sizes="(max-width: 768px) 50vw, 260px"
            className="object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          />
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

      <div className="flex flex-1 flex-col gap-1.5 p-3.5">
        <h3 className="line-clamp-2 min-h-[2.6em] font-display text-[17px] leading-[1.3]">
          {stay.name}
        </h3>
        <ReviewLine stay={stay} />
        <CategoryBadges cats={stay.categories} />

        {isMember ? (
          <>
            <div className="mt-1 flex items-baseline gap-2 font-mono">
              <span className="text-[18px] font-bold tabular-nums">${you}</span>
              {stay.them && (
                <span className="text-[12px] text-soft line-through tabular-nums">${stay.them}</span>
              )}
            </div>
            {incl && stay.feeAtHotel > 0 && (
              <div className="font-mono text-[10.5px] text-soft">incl. ${stay.feeAtHotel} hotel fee</div>
            )}
          </>
        ) : (
          <>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="font-mono text-[18px] font-bold tabular-nums">${publicPrice}</span>
              <span className="text-[11px] text-soft">public</span>
            </div>
            {band > 0 && (
              <div className="text-[11.5px] font-medium text-brass">Members save up to {band}%</div>
            )}
          </>
        )}

        <div className="mt-auto pt-3">
          <span className="inline-flex items-center gap-1 text-[13px] font-medium text-brass underline decoration-brass/40 underline-offset-4 transition-colors group-hover:decoration-brass">
            View rooms
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Large modal: sliding photo gallery + bookable room options
// ---------------------------------------------------------------------------
// Prepare state for the modal's Book button. On success we navigate to the
// dedicated /book/[id] checkout page, so the modal only needs to reflect the
// in-flight prepare + any error; the ledger row + price live on that page.
type CheckoutState =
  | { phase: "idle" }
  | { phase: "preparing"; offerId: string }
  | { phase: "error"; offerId: string; message: string };

// checkin + nights -> checkout date (yyyy-mm-dd), matching the server's UTC math.
function checkoutDateOf(checkin: string, nights: number) {
  const d = new Date(checkin + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + nights);
  return d.toISOString().slice(0, 10);
}

function HotelModal({
  stay,
  intent,
  query,
  onClose,
}: {
  stay: HotelStay;
  intent: Intent;
  query: Query;
  onClose: () => void;
}) {
  const router = useRouter();
  const [images, setImages] = useState<string[]>(stay.photo ? [stay.photo] : []);
  const [options, setOptions] = useState<RoomOption[]>([]);
  const [facilities, setFacilities] = useState<string[]>([]);
  const [reviews, setReviews] = useState<ReviewSnippet[]>([]);
  const [times, setTimes] = useState<{ ci: string | null; co: string | null }>({
    ci: null,
    co: null,
  });
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [pb, setPb] = useState<CheckoutState>({ phase: "idle" });

  // One idempotency key per offer, stable across retries of the same selection so
  // a repeated Book click reuses the same ledger row instead of duplicating it.
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

  // Takes the RoomOption directly (not an offerId lookup) so it doesn't depend on
  // `options` — which the hotel-fetch effect sets. Depending on it here would make
  // this callback churn on every fetch and drive that effect into a render loop.
  const startPrebook = useCallback(
    async (o: RoomOption) => {
      const offerId = o.offerId;
      setPb({ phase: "preparing", offerId });
      const res = await prepareBookingAction({
        idempotencyKey: keyFor(offerId),
        hotelId: stay.id,
        offerId,
        hotel: {
          name: stay.name,
          city: stay.city,
          address: stay.address,
          image: stay.photo,
          stars: stay.stars,
        },
        room: {
          title: o.title ?? stay.room,
          beds: o.beds,
          board: o.board ?? stay.board,
          image: o.image ?? stay.photo,
          amenities: o.amenities ?? [],
          sleeps: o.sleeps,
          themMinor: (o.them ?? stay.them) != null ? Math.round((o.them ?? stay.them)! * 100) : null,
        },
        checkinDate: query.checkin,
        checkoutDate: checkoutDateOf(query.checkin, query.nights),
        nights: query.nights,
        adults: 2,
        currency: o.currency ?? stay.currency ?? "USD",
        usePaymentSdk: true,
      });
      if (!res.ok) {
        setPb({ phase: "error", offerId, message: res.error });
        return;
      }
      // Rate is held + the ledger row is written — hand off to the secure
      // checkout page (guest details + card). Stay in "preparing" through nav.
      router.push(`/book/${res.data.bookingId}`);
    },
    [stay, query, router],
  );

  // fetch curated gallery + hotel facts + room options
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/hotel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hotelId: stay.id, checkin: query.checkin, nights: query.nights }),
        });
        const d = await r.json();
        if (!alive) return;
        if (r.ok) {
          if (d.images?.length) setImages(d.images);
          setFacilities(d.facilities ?? []);
          setReviews(d.reviews ?? []);
          setTimes({ ci: d.checkinTime ?? null, co: d.checkoutTime ?? null });
          const opts: RoomOption[] = d.options?.length
            ? d.options
            : [
                {
                  offerId: stay.offerId,
                  title: stay.room,
                  beds: "",
                  size: null,
                  sleeps: 2,
                  board: stay.board,
                  breakfast: /breakfast/i.test(stay.board),
                  freeCancel: stay.freeCancel,
                  mandatory: null,
                  amenities: [],
                  image: stay.photo,
                  you: stay.you,
                  them: stay.them,
                  currency: stay.currency,
                },
              ];
          setOptions(opts);
          if (intent === "book" && opts[0]) startPrebook(opts[0]);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [stay, query, intent, startPrebook]);

  // keyboard: esc closes, arrows slide the gallery
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

  const incl = useInclFees();
  const isMember = useMember();
  const baseFrom = options[0]?.you ?? stay.you;
  const feeFrom = options[0]?.fee ?? stay.feeAtHotel;
  // Members see the net "from"; everyone else sees the public (SSP) "from".
  const fromBase = isMember ? baseFrom : (options[0]?.them ?? stay.them ?? baseFrom);
  const fromPrice = incl ? fromBase + feeFrom : fromBase;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-[rgba(12,9,16,0.6)] p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rise flex h-full w-full max-w-[1140px] flex-col overflow-hidden border-line bg-parchment shadow-[var(--shadow-lg)] sm:h-[92vh] sm:rounded-2xl sm:border lg:flex-row"
      >
        {/* LEFT — gallery, then room options directly below */}
        <div className="flex min-h-0 flex-1 flex-col lg:flex-[1.55]">
          <div
            className="relative h-64 w-full shrink-0 overflow-hidden sm:h-80"
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
                    sizes="(max-width: 1140px) 100vw, 720px"
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

          {/* rooms scroll independently under the images */}
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h4 className="font-display text-[20px]">
                {options.length > 1 ? "Choose your room" : "Room option"}
              </h4>
              <span className="text-[12px] text-soft">
                {query.nights} {query.nights === 1 ? "night" : "nights"} · from ${fromPrice} total
              </span>
            </div>

            {loading && <div className="py-8 text-center text-sm text-soft">Loading rooms…</div>}

            <div className="flex flex-col gap-4">
              {options.map((o) => (
                <RoomOptionCard
                  key={o.offerId}
                  o={o}
                  seed={stay.id}
                  pb={pb}
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
        <aside className="no-scrollbar flex min-h-0 w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-line bg-surface/50 p-5 lg:w-[380px] lg:border-l lg:border-t-0">
          <div>
            <div className="text-[11px] uppercase tracking-[0.1em] text-soft">
              {stay.city}
              {stay.stars > 0 ? ` · ${"★".repeat(stay.stars)}` : ""}
            </div>
            <h3 className="font-display text-[24px] leading-tight tracking-[-0.01em]">
              {stay.name}
            </h3>
            <div className="mt-1.5">
              <ReviewLine stay={stay} />
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-soft">
              {times.ci && <span>Check-in from {times.ci}</span>}
              {times.co && <span>Check-out by {times.co}</span>}
            </div>
          </div>

          {facilities.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
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

          {reviews.length > 0 && (
            <div className="flex flex-col gap-2.5 border-t border-line pt-4">
              <h4 className="font-display text-[19px]">What guests say</h4>
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

          {!loading && <WhyRecommend stay={stay} facilities={facilities} />}
        </aside>
      </div>
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
  onBook,
}: {
  o: RoomOption;
  seed: string;
  pb: CheckoutState;
  onBook: () => void;
}) {
  const incl = useInclFees();
  const isMember = useMember();
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
              {o.freeCancel ? "Free cancellation" : "Non-refundable"}
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

