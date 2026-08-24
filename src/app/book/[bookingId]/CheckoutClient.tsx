"use client";

// The checkout page is the ROOM-level view of the product.
//
// Search is city level ("which property"), the stay page is hotel level
// ("which room here"), and this page is the one place where a guest is
// committing to ONE room on ONE set of dates. So it carries everything that is
// true of that specific reservation and nowhere else: the exact room and what
// it sleeps, the property's arrival and departure times, the full cancellation
// ladder in the property's own timezone, what we charge now versus what the
// hotel collects at the desk, and who is travelling.
//
// LAYOUT. Details left and scrolling, the money and the card fixed on the
// right. A guest reads the left column once, top to bottom, then acts on the
// right — and the amount they are about to be charged never leaves the screen
// while they do it.

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { saveGuestAction } from "@/app/actions/booking";

type Guest = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  line1: string;
  city: string;
  state: string;
  zip: string;
};

/** Assembled by page.tsx; `satisfies` there keeps the two ends in step. */
export type CheckoutSummary = {
  hotel: {
    name: string;
    city: string;
    stars: number;
    image: string | null;
    address: string;
    checkinTime: string | null;
    checkoutTime: string | null;
  };
  room: {
    title: string;
    beds: string;
    size: string | null;
    sleeps: number;
    board: string;
    supplierBoard: string | null;
    image: string | null;
    amenities: string[];
  };
  stay: { checkinLabel: string; checkoutLabel: string; nights: number; adults: number };
  cancel: {
    refundable: boolean;
    freeUntilLong: string | null;
    tiers: string[];
  };
  price: {
    currency: string;
    dueNowLabel: string;
    perNightLabel: string;
    feeLabel: string | null;
    feeNote: string | null;
    tripTotalLabel: string;
    /** Public price on the SAME basis as tripTotalLabel: fee included in both. */
    compareTotalLabel: string | null;
    savingLabel: string | null;
  };
  humanRef: string;
};

// Minimal Stripe.js typings (we integrate the Payment Element directly rather
// than through LiteAPI's wrapper, which ignores appearance/layout entirely).
type StripePaymentElement = {
  mount: (sel: string) => void;
  on: (ev: string, cb: () => void) => void;
  destroy: () => void;
};
type StripeElements = { create: (type: string, opts: unknown) => StripePaymentElement };
type StripeInstance = {
  elements: (opts: unknown) => StripeElements;
  confirmPayment: (opts: unknown) => Promise<{ error?: { message?: string } }>;
};
type StripeCtor = (pk: string) => StripeInstance;

const STRIPE_JS = "https://js.stripe.com/v3/";
const inputBase =
  "rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-soft focus-visible:border-brass";
const inputClass = inputBase + " w-full";

let stripeLoad: Promise<StripeCtor> | null = null;
function loadStripe(): Promise<StripeCtor> {
  const w = window as unknown as { Stripe?: StripeCtor };
  if (w.Stripe) return Promise.resolve(w.Stripe);
  if (stripeLoad) return stripeLoad;
  stripeLoad = new Promise((resolve, reject) => {
    const done = () => (w.Stripe ? resolve(w.Stripe) : reject(new Error("stripe unavailable")));
    const existing = document.getElementById("stripe-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", () => reject(new Error("stripe load failed")));
      return;
    }
    const s = document.createElement("script");
    s.id = "stripe-js";
    s.src = STRIPE_JS;
    s.async = true;
    s.onload = done;
    s.onerror = () => reject(new Error("stripe load failed"));
    document.body.appendChild(s);
  });
  return stripeLoad;
}

// Style the Stripe Payment Element to match Nostavel's dusk/lamplight tokens via
// Stripe's appearance API. Reads the active theme at mount; `?pt=stripe|flat|night`
// overrides it for previewing.
function buildAppearance(themeOverride?: string | null) {
  const attr = document.documentElement.getAttribute("data-theme");
  const dark =
    attr === "dark" ||
    (attr !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const P = dark
    ? { bg: "#221b2d", field: "#17131f", text: "#ede6da", subtle: "#a79dae", line: "#352c44", brass: "#d9a455" }
    : { bg: "#ffffff", field: "#ffffff", text: "#211b2b", subtle: "#6a6172", line: "#e2d8c7", brass: "#b9772b" };
  const valid = ["stripe", "flat", "night"];
  const theme = themeOverride && valid.includes(themeOverride) ? themeOverride : dark ? "night" : "flat";
  return {
    theme,
    labels: "floating",
    variables: {
      colorPrimary: P.brass,
      colorBackground: P.bg,
      colorText: P.text,
      colorTextSecondary: P.subtle,
      colorTextPlaceholder: P.subtle,
      colorDanger: "#e5484d",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSizeBase: "13px",
      spacingUnit: "2.8px",
      spacingGridRow: "10px",
      borderRadius: "9px",
    },
    rules: {
      ".Input": { backgroundColor: P.field, border: `1px solid ${P.line}`, boxShadow: "none", padding: "9px 11px" },
      ".Input:focus": { border: `1px solid ${P.brass}`, boxShadow: "none" },
      ".Label": { color: P.subtle },
      // Accordion: unselected methods collapse to small rows, the active one
      // expands. Theme the rows to match the rest of the checkout.
      ".AccordionItem": {
        backgroundColor: P.field,
        border: `1px solid ${P.line}`,
        boxShadow: "none",
        padding: "11px 13px",
      },
      ".AccordionItem:hover": { borderColor: P.brass },
      ".AccordionItem--selected": { borderColor: P.brass, backgroundColor: P.field },
    },
  };
}

// Split a stored phone ("+1 (281) 965-9730", or a doubled "+1 +1 …") into a
// country + national number, stripping ALL leading dial codes so it can't
// accumulate. Only strips "+NN" prefixes, never a bare leading digit.
function splitPhone(raw: string): { iso: string; number: string } {
  let t = (raw || "").trim();
  let iso = "US";
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of COUNTRIES) {
      if (t.startsWith(c.dial)) {
        iso = c.iso;
        t = t.slice(c.dial.length).trim();
        changed = true;
        break;
      }
    }
  }
  return { iso, number: t };
}

const COUNTRIES = [
  { iso: "US", flag: "🇺🇸", dial: "+1" },
  { iso: "CA", flag: "🇨🇦", dial: "+1" },
  { iso: "GB", flag: "🇬🇧", dial: "+44" },
  { iso: "IN", flag: "🇮🇳", dial: "+91" },
  { iso: "AU", flag: "🇦🇺", dial: "+61" },
  { iso: "DE", flag: "🇩🇪", dial: "+49" },
  { iso: "FR", flag: "🇫🇷", dial: "+33" },
  { iso: "MX", flag: "🇲🇽", dial: "+52" },
  { iso: "JP", flag: "🇯🇵", dial: "+81" },
  { iso: "AE", flag: "🇦🇪", dial: "+971" },
];

export default function CheckoutClient({
  bookingId,
  paymentSecret,
  stripePk,
  defaultGuest,
  signedIn,
  summary,
}: {
  bookingId: string;
  paymentSecret: string;
  stripePk: string;
  defaultGuest: Guest;
  signedIn: boolean;
  summary: CheckoutSummary;
}) {
  const [guest, setGuest] = useState<Guest>(() => ({
    ...defaultGuest,
    phone: splitPhone(defaultGuest.phone).number,
  }));
  const [phoneIso, setPhoneIso] = useState(() => splitPhone(defaultGuest.phone).iso);
  const dial = COUNTRIES.find((c) => c.iso === phoneIso)?.dial ?? "+1";
  const rawNum = guest.phone.trim();
  const fullPhone = !rawNum ? "" : rawNum.startsWith("+") ? rawNum : `${dial} ${rawNum}`;

  const [step, setStep] = useState<"details" | "paying">("details");
  const [saving, setSaving] = useState(false);
  const [cardMounted, setCardMounted] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stripeRef = useRef<StripeInstance | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const payRef = useRef<HTMLDivElement | null>(null);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email.trim());
  const canContinue = Boolean(
    guest.firstName.trim() &&
      guest.lastName.trim() &&
      emailValid &&
      guest.phone.trim() &&
      guest.line1.trim() &&
      guest.city.trim() &&
      guest.state.trim() &&
      guest.zip.trim(),
  );

  async function continueToPayment() {
    setError(null);
    setSaving(true);
    const res = await saveGuestAction({
      bookingId,
      firstName: guest.firstName.trim(),
      lastName: guest.lastName.trim(),
      email: guest.email.trim(),
      phone: fullPhone,
      address: {
        line1: guest.line1.trim(),
        city: guest.city.trim(),
        state: guest.state.trim(),
        zip: guest.zip.trim(),
      },
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStep("paying");
    // Bring the freshly unlocked payment section into view.
    requestAnimationFrame(() => payRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  // Mount Stripe's Payment Element (our own appearance + accordion layout) into
  // the visible container.
  //
  // Do NOT reintroduce an off-screen prewarm host: Stripe measures its host at
  // mount, so mounting into a zero-height hidden element produced an iframe
  // that reported `ready` and then rendered nothing once revealed.
  //
  // Do NOT reintroduce a once-only mount guard either: React remounts effects
  // (StrictMode in dev, and any real remount in production), and a guard that
  // skips the second run leaves the Element attached to a DOM node React has
  // already thrown away.
  //
  // On a successful charge Stripe redirects to returnUrl
  // (/book/<id>/confirmation), where the booking is finalized.
  useEffect(() => {
    if (!stripePk) return; // surfaced by shownError once payment is reachable
    let cancelled = false;
    let element: StripePaymentElement | null = null;

    (async () => {
      try {
        const Stripe = await loadStripe();
        if (cancelled) return;
        const stripe = Stripe(stripePk);
        const themeOverride = new URLSearchParams(window.location.search).get("pt");
        const elements = stripe.elements({
          clientSecret: paymentSecret,
          appearance: buildAppearance(themeOverride),
        });
        const pe = elements.create("payment", {
          // Accordion: the active method stays enlarged, the rest shrink to rows.
          layout: { type: "accordion", defaultCollapsed: false, radios: false, spacedAccordionItems: true },
          wallets: { applePay: "never", googlePay: "never" },
        });
        if (cancelled) return;
        pe.on("ready", () => setCardMounted(true));
        pe.mount("#nostavel-pay");
        element = pe;
        stripeRef.current = stripe;
        elementsRef.current = elements;
      } catch {
        if (!cancelled) setError("Could not load the secure payment form. Please refresh.");
      }
    })();

    return () => {
      cancelled = true;
      // Detaches the iframe so the next mount starts clean instead of racing a
      // dead one. Guarded: destroy() throws if the Element is already gone.
      try {
        element?.destroy();
      } catch {
        /* already torn down */
      }
    };
  }, [stripePk, paymentSecret]);

  // If the publishable key never arrived, surface it once the guest is ready to
  // pay. Derived at render rather than pushed into state by an effect: it is a
  // pure function of (step, stripePk) and setting state from an effect for it
  // caused a cascading render (react-hooks/set-state-in-effect).
  const shownError =
    error ?? (step === "paying" && !stripePk
      ? "Payment is temporarily unavailable. Please try again shortly."
      : null);

  async function submitPayment() {
    if (!stripeRef.current || !elementsRef.current || processing) return;
    setProcessing(true);
    setError(null);
    const { error: err } = await stripeRef.current.confirmPayment({
      elements: elementsRef.current,
      confirmParams: { return_url: `${window.location.origin}/book/${bookingId}/confirmation` },
    });
    // Reached only on an immediate failure; success redirects away.
    if (err) {
      setError(err.message || "Your payment could not be completed.");
      setProcessing(false);
    }
  }

  const { hotel, room, stay, cancel, price } = summary;
  const roomMeta = [room.beds, room.size, `Sleeps ${room.sleeps}`].filter(Boolean).join(" · ");

  return (
    <div className="rise flex flex-col gap-5">
      {/* The property heads the whole page rather than sitting inside one
          column. It is the subject of both sides, and repeating it inside a
          rail summary was costing height the payment element needed. */}
      <header className="flex items-center gap-3.5">
        {hotel.image && (
          <div className="relative h-[58px] w-[72px] shrink-0 overflow-hidden rounded-lg">
            <Image src={hotel.image} alt={hotel.name} fill sizes="100px" className="object-cover" />
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.12em] text-soft">
            {hotel.city}
            {hotel.stars ? ` · ${"★".repeat(hotel.stars)}` : ""}
          </div>
          <h1 className="truncate font-display text-[21px] leading-tight">{hotel.name}</h1>
          <p className="truncate text-[12.5px] text-soft">{hotel.address || hotel.city}</p>
        </div>
      </header>

      {/* items-start is what lets the right column stick: a stretched grid item
          is already full height and has nothing to scroll within. The rail is
          the wider half of the split now — it holds two forms, while the left
          is reference text that reads fine narrow. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_460px]">
        {/* ========== LEFT: what you are buying, and what it costs ========== */}
        <div className="flex min-w-0 flex-col gap-4">
          {/* 1 · The exact room */}
          <Card>
            <CardHead left={<span className="font-display text-[15px]">Your room</span>} />
            <div className="flex flex-col gap-4 p-5 sm:flex-row">
              {room.image && (
                <div className="relative h-[120px] w-full shrink-0 overflow-hidden rounded-lg sm:w-[160px]">
                  <Image src={room.image} alt={room.title} fill sizes="200px" className="object-cover" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-[16.5px] leading-tight">{room.title}</h3>
                {roomMeta && <p className="mt-0.5 text-[12.5px] text-soft">{roomMeta}</p>}
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <Pill tone="good">{room.board}</Pill>
                  <Pill tone={cancel.refundable ? "good" : "muted"}>
                    {cancel.refundable ? "Free cancellation" : "Non-refundable"}
                  </Pill>
                  {room.amenities.slice(0, 3).map((a) => (
                    <Pill key={a} tone="muted">
                      {a}
                    </Pill>
                  ))}
                </div>
                {/* Where our wording and the supplier's contract differ, the
                    guest gets both. States the fact and nothing more: an
                    earlier version asserted breakfast was included, which is
                    only one of the reasons the two strings can diverge. */}
                {room.supplierBoard && room.supplierBoard !== room.board && (
                  <p className="mt-2.5 text-[11.5px] leading-snug text-soft">
                    We advertised this as “{room.board}”. The supplier files it as “
                    {room.supplierBoard}”; both are on your reservation record.
                  </p>
                )}
              </div>
            </div>
          </Card>

          {/* 2 · When */}
          <Card>
            <CardHead left={<span className="font-display text-[15px]">Your stay</span>} />
            <div className="grid gap-px bg-line sm:grid-cols-2">
              <div className="bg-surface p-4">
                <Label>Check-in</Label>
                <div className="mt-1 text-[14.5px] font-medium">{stay.checkinLabel}</div>
                <div className="text-[12.5px] text-soft">
                  {hotel.checkinTime ? `From ${hotel.checkinTime}` : "Check-in time on request"}
                </div>
              </div>
              <div className="bg-surface p-4">
                <Label>Check-out</Label>
                <div className="mt-1 text-[14.5px] font-medium">{stay.checkoutLabel}</div>
                <div className="text-[12.5px] text-soft">
                  {hotel.checkoutTime ? `By ${hotel.checkoutTime}` : "Check-out time on request"}
                </div>
              </div>
            </div>
            <div className="border-t border-line px-4 py-3 text-[13px] text-soft">
              {stay.nights} {stay.nights === 1 ? "night" : "nights"} · {stay.adults} adults · 1 room
            </div>
          </Card>

          {/* 3 · The terms */}
          <Card>
            <CardHead
              left={<span className="font-display text-[15px]">Cancellation</span>}
              right={
                <span className={"text-[12px] " + (cancel.refundable ? "text-sage" : "text-soft")}>
                  {cancel.refundable ? "Refundable" : "Non-refundable"}
                </span>
              }
            />
            <div className="flex flex-col gap-2 p-5 text-[13px]">
              {cancel.refundable && cancel.freeUntilLong ? (
                <p>
                  <span className="text-ink">Cancel free of charge until </span>
                  <span className="font-medium text-ink">{cancel.freeUntilLong}</span>
                  <span className="text-soft"> and you are refunded in full.</span>
                </p>
              ) : (
                <p className="text-soft">
                  This rate cannot be refunded or changed once booked. It is priced lower than
                  the refundable rate for exactly that reason.
                </p>
              )}

              {/* The escalating rungs. Most rates have none; when they do, the
                  information is in the GUEST's favour — the stay is often still
                  part-refundable well after the free window closes, and showing
                  only the first deadline reads as "cancel now or lose it all". */}
              {cancel.tiers.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1.5 border-l-2 border-line pl-3 text-soft">
                  {cancel.tiers.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              )}

              {(cancel.freeUntilLong || cancel.tiers.length > 0) && (
                <p className="mt-1 text-[11.5px] text-soft">
                  Times are the property&rsquo;s own clock, not yours.
                </p>
              )}
            </div>
          </Card>

          {/* 4 · Every number, in one place. Moved off the right rail so the
              rail carries only the two things a guest still has to DO. A price
              block is read carefully once, not watched continuously — and the
              amount being charged still follows them, on the Pay button. */}
          <Card>
            <CardHead left={<span className="font-display text-[15px]">Price</span>} />
            {/* One basis for the whole card: build the trip total from its
                parts, compare against the public price on that same total, and
                only then split out what is payable now versus at the desk.
                Every line here answers "of this one number, which part is
                whose" — nothing is compared across bases. */}
            <dl className="flex flex-col gap-2 p-5 text-[13.5px]">
              <Row
                label={`Room rate · ${price.perNightLabel} × ${stay.nights}${stay.nights === 1 ? " night" : " nights"}`}
                value={price.dueNowLabel}
              />
              {price.feeLabel && (
                <Row label="Property fees, paid on arrival" value={price.feeLabel} />
              )}

              <div className="my-1 h-px bg-line" />

              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-ink">
                  Total cost of the stay
                </span>
                <span className="shrink-0 font-mono text-[16px] font-semibold tabular-nums">
                  {price.tripTotalLabel}
                </span>
              </div>

              {price.compareTotalLabel && price.savingLabel && (
                <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 truncate text-soft">
                    Booked elsewhere{" "}
                    <span className="tabular-nums line-through">{price.compareTotalLabel}</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums text-sage">
                    you save {price.savingLabel}
                  </span>
                </div>
              )}

              <div className="my-1 h-px bg-line" />

              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium text-ink">Due now</span>
                <span className="shrink-0 font-mono text-[22px] font-bold tabular-nums">
                  {price.dueNowLabel}
                </span>
              </div>
              <p className="text-[11.5px] leading-snug text-soft">
                Taxes included, charged in {price.currency} when you pay.
                {price.feeLabel
                  ? ` The property collects the remaining ${price.feeLabel} directly at check-in — it is not ours to take or to refund.`
                  : ""}
              </p>
            </dl>
          </Card>
        </div>

        {/* ========== RIGHT: the two things left to DO ====================== */}
        <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20">
        {/* Who is travelling. Sits with the money and the card: the whole
            act of BOOKING is one column, and the left is reference. */}
        <Card>
          <CardHead
            left={
              <>
                <StepNum n={1} state={step === "details" ? "active" : "done"} />
                <span className="font-display text-[15px]">Guest details</span>
              </>
            }
            right={
              step === "paying" && (
                <button
                  type="button"
                  onClick={() => setStep("details")}
                  className="text-[12.5px] text-brass underline underline-offset-2 hover:text-brassglow"
                >
                  Edit
                </button>
              )
            }
          />

          {step === "details" ? (
            <div className="min-w-0 p-4">
              <p className="text-[11.5px] leading-snug text-soft">
                Names must match the lead guest&rsquo;s ID. We&rsquo;ll email the confirmation
                {signedIn ? " to the address below." : " and your reference here."}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex gap-2">
                  <input className={inputClass} placeholder="First name" autoComplete="given-name"
                    value={guest.firstName} onChange={(e) => setGuest((g) => ({ ...g, firstName: e.target.value }))} />
                  <input className={inputClass} placeholder="Last name" autoComplete="family-name"
                    value={guest.lastName} onChange={(e) => setGuest((g) => ({ ...g, lastName: e.target.value }))} />
                </div>
                <input className={inputClass} type="email" inputMode="email" placeholder="Email" autoComplete="email"
                  value={guest.email} onChange={(e) => setGuest((g) => ({ ...g, email: e.target.value }))} />
                <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 focus-within:border-brass">
                  <select
                    aria-label="Country code"
                    value={phoneIso}
                    onChange={(e) => setPhoneIso(e.target.value)}
                    className="shrink-0 bg-transparent text-[13px] text-ink outline-none"
                  >
                    {COUNTRIES.map((c) => (
                      <option key={c.iso} value={c.iso} className="bg-surface text-ink">
                        {c.flag} {c.dial}
                      </option>
                    ))}
                  </select>
                  <span className="h-5 w-px shrink-0 bg-line" />
                  <input
                    className="w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-soft"
                    type="tel"
                    inputMode="tel"
                    placeholder="Phone number"
                    autoComplete="tel-national"
                    value={guest.phone}
                    onChange={(e) => setGuest((g) => ({ ...g, phone: e.target.value }))}
                  />
                </div>

                <div className="mt-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-soft">
                  Billing address
                </div>
                <input className={inputClass} placeholder="Street address" autoComplete="address-line1"
                  value={guest.line1} onChange={(e) => setGuest((g) => ({ ...g, line1: e.target.value }))} />
                <div className="flex gap-2">
                  <input className={inputBase + " min-w-0 flex-1"} placeholder="City" autoComplete="address-level2"
                    value={guest.city} onChange={(e) => setGuest((g) => ({ ...g, city: e.target.value }))} />
                  <input className={inputBase + " w-[74px] shrink-0"} placeholder="State" autoComplete="address-level1"
                    value={guest.state} onChange={(e) => setGuest((g) => ({ ...g, state: e.target.value }))} />
                  <input className={inputBase + " w-[92px] shrink-0"} placeholder="ZIP" autoComplete="postal-code" inputMode="numeric"
                    value={guest.zip} onChange={(e) => setGuest((g) => ({ ...g, zip: e.target.value }))} />
                </div>
              </div>
              {shownError && step === "details" && (
                <p className="mt-3 text-[13px] text-red-500">{shownError}</p>
              )}
              <button
                onClick={continueToPayment}
                disabled={!canContinue || saving}
                className="btn-brass mt-3 w-full rounded-lg py-2.5 text-[14px] font-bold text-[#1a1410] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "One moment…" : "Continue to payment"}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 px-4 py-3 text-[12.5px]">
              <div className="truncate text-ink">
                {guest.firstName} {guest.lastName}
                <span className="text-soft"> · {fullPhone}</span>
              </div>
              <div className="truncate text-soft" title={guest.email}>
                {guest.email}
              </div>
              <div
                className="truncate text-soft"
                title={`${guest.line1}, ${guest.city}, ${guest.state} ${guest.zip}`}
              >
                {guest.line1}, {guest.city}, {guest.state} {guest.zip}
              </div>
            </div>
          )}
        </Card>

        {/* Payment */}
        <div ref={payRef} className="gloss overflow-hidden rounded-xl border border-line bg-surface">
          <CardHead
            left={
              <>
                <StepNum n={2} state={step === "paying" ? "active" : "pending"} />
                <span className="font-display text-[15px]">Payment</span>
              </>
            }
            right={
              <span className="flex items-center gap-1 text-[11px] text-soft">
                <LockGlyph /> Encrypted
              </span>
            }
          />

          <div className="p-4">
            {/* Always visible, always in its real container. Nothing about the
                card form depends on the guest-details step; only PAYING does. */}
            <div id="nostavel-pay" className="min-h-[140px]" />

            {shownError && <p className="pt-3 text-[13px] text-red-500">{shownError}</p>}
            {!cardMounted && !shownError && (
              <p className="pt-2 text-center text-[12px] text-soft">Loading secure card form…</p>
            )}

            {cardMounted && !shownError && (
              // Disabled rather than hidden. A guest who can see the button
              // knows what is left to do; a guest who cannot is just stuck.
              <button
                onClick={submitPayment}
                disabled={processing || step !== "paying"}
                title={step !== "paying" ? "Save your guest details first" : undefined}
                className="btn-brass mt-4 w-full rounded-lg py-3 text-[15px] font-bold text-[#1a1410] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {processing
                  ? "Processing…"
                  : step !== "paying"
                    ? "Add your guest details to pay"
                    : `Pay ${price.dueNowLabel}`}
              </button>
            )}

            <p className="mt-3 text-center text-[11px] leading-relaxed text-soft">
              Ref <span className="font-mono text-ink">{summary.humanRef}</span> · price locked.
            </p>

            {/* Sandbox only. Stripe will not let anyone, us included, write a
                card number into the Element — that is the point of it being an
                iframe on Stripe's origin — so the number is shown to be copied
                rather than prefilled. */}
            <div className="mt-2 rounded-lg border border-dashed border-line px-3 py-2 text-[11px] leading-relaxed text-soft">
              <span className="font-semibold uppercase tracking-[0.08em]">Sandbox</span> · test card{" "}
              <span className="select-all font-mono text-ink">4242 4242 4242 4242</span>, any future
              expiry, any CVC, any ZIP.
            </div>
          </div>
        </div>

          <p className="px-1 text-[11px] leading-relaxed text-soft">
            By paying you agree to the property&rsquo;s cancellation terms shown on this page and
            to Nostavel&rsquo;s{" "}
            <a href="/terms" className="underline underline-offset-2 hover:text-ink">
              terms of service
            </a>
            .
          </p>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ atoms -- */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="gloss overflow-hidden rounded-xl border border-line bg-surface">
      {children}
    </section>
  );
}

function CardHead({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <header className="flex h-[46px] items-center justify-between border-b border-line px-5">
      <div className="flex items-center gap-2.5">{left}</div>
      {right}
    </header>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10.5px] uppercase tracking-[0.1em] text-soft">{children}</span>
  );
}

function Row({
  label,
  value,
  muted,
  strike,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strike?: boolean;
}) {
  return (
    <div className={"flex items-baseline justify-between gap-3 " + (muted ? "text-soft" : "")}>
      {/* min-w-0 lets the label shrink; the amount is the half that must never
          be clipped, so it is the one that refuses to. */}
      <span className="min-w-0 truncate">{label}</span>
      <span className={"shrink-0 tabular-nums " + (strike ? "line-through" : "")}>{value}</span>
    </div>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "good" | "muted" }) {
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[11.5px] " +
        (tone === "good"
          ? "border border-sage/40 bg-sage/10 text-sage"
          : "border border-line text-soft")
      }
    >
      {children}
    </span>
  );
}

function StepNum({ n, state }: { n: number; state: "active" | "done" | "pending" }) {
  return (
    <span
      className={
        "grid h-[22px] w-[22px] place-items-center rounded-full text-[11px] font-bold " +
        (state === "done"
          ? "bg-sage/25 text-sage"
          : state === "active"
            ? "bg-brass text-[#1a1410]"
            : "border border-line text-soft")
      }
    >
      {state === "done" ? "✓" : n}
    </span>
  );
}

function LockGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
