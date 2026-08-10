"use client";

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

type Summary = {
  hotelName: string;
  hotelCity: string;
  hotelStars: number;
  hotelImage: string | null;
  roomTitle: string;
  board: string;
  dates: string;
  nights: number;
  adults: number;
  refundLine: string;
  refundable: boolean;
  totalLabel: string;
  humanRef: string;
  isGuest: boolean;
  guestSavingsPct: number;
};

// Minimal Stripe.js typings (we integrate the Payment Element directly rather
// than through LiteAPI's wrapper, which ignores appearance/layout entirely).
type StripePaymentElement = { mount: (sel: string) => void; on: (ev: string, cb: () => void) => void };
type StripeElements = { create: (type: string, opts: unknown) => StripePaymentElement };
type StripeInstance = {
  elements: (opts: unknown) => StripeElements;
  confirmPayment: (opts: unknown) => Promise<{ error?: { message?: string } }>;
};
type StripeCtor = (pk: string) => StripeInstance;

const STRIPE_JS = "https://js.stripe.com/v3/";
const inputBase =
  "rounded-lg border border-line bg-surface px-3 py-2.5 text-[14px] text-ink outline-none placeholder:text-soft focus-visible:border-brass";
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
  summary: Summary;
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

  const initedRef = useRef(false);
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
    requestAnimationFrame(() => payRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  // Mount Stripe's Payment Element directly (our own appearance + accordion
  // layout). We mount immediately on load into an off-screen host so the form
  // is warm by the time the guest finishes typing their details; revealing it
  // is then instant. On a successful charge Stripe redirects to returnUrl
  // (/book/<id>/confirmation), where the booking is finalized.
  useEffect(() => {
    if (initedRef.current) return;
    if (!stripePk) return; // handled when the user reaches the paying step
    initedRef.current = true;
    let cancelled = false;
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
        pe.on("ready", () => {
          if (!cancelled) setCardMounted(true);
        });
        pe.mount("#nostavel-pay");
        stripeRef.current = stripe;
        elementsRef.current = elements;
      } catch {
        if (!cancelled) setError("Could not load the secure payment form. Please refresh.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stripePk, paymentSecret]);

  // If the publishable key never arrived, surface it once the guest is ready to pay.
  useEffect(() => {
    if (step === "paying" && !stripePk) {
      setError("Payment is temporarily unavailable. Please try again shortly.");
    }
  }, [step, stripePk]);

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

  return (
    <div className="rise mx-auto flex max-w-[560px] flex-col gap-4">
      {/* Compact order summary */}
      <div className="gloss flex items-stretch gap-3 overflow-hidden rounded-xl border border-line bg-surface p-3">
        {summary.hotelImage && (
          <div className="relative h-[74px] w-[92px] shrink-0 overflow-hidden rounded-lg">
            <Image src={summary.hotelImage} alt={summary.hotelName} fill sizes="120px" className="object-cover" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.12em] text-soft">
            {summary.hotelCity}
            {summary.hotelStars ? ` · ${"★".repeat(summary.hotelStars)}` : ""}
          </div>
          <h2 className="truncate font-display text-[16px] leading-tight">{summary.hotelName}</h2>
          <div className="mt-0.5 truncate text-[12px] text-soft">
            {summary.roomTitle} · {summary.board}
          </div>
          <div className="text-[12px] text-soft">
            {summary.dates} · {summary.nights}n · {summary.adults} adults
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-between text-right">
          <span className="font-mono text-[19px] font-bold tabular-nums">{summary.totalLabel}</span>
          <span className={"text-[11px] " + (summary.refundable ? "text-sage" : "text-soft")}>
            {summary.refundable ? "Free cancellation" : "Non-refundable"}
          </span>
        </div>
      </div>

      {summary.isGuest && summary.guestSavingsPct > 0 && (
        <p className="rounded-lg border border-brass/30 bg-brass/[0.07] px-3.5 py-2.5 text-[12.5px] text-ink">
          You&rsquo;re checking out as a guest at the public rate.{" "}
          <a href="/signin" className="text-brass underline underline-offset-2 hover:text-brassglow">
            Sign in
          </a>{" "}
          next time to save about {summary.guestSavingsPct}% as a member.
        </p>
      )}

      {/* 1 · Your details */}
      <section className="gloss overflow-hidden rounded-xl border border-line bg-surface">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2.5">
            <StepNum n={1} state={step === "details" ? "active" : "done"} />
            <span className="font-display text-[15px]">Your details</span>
          </div>
          {step === "paying" && (
            <button
              type="button"
              onClick={() => setStep("details")}
              className="text-[12.5px] text-brass underline underline-offset-2 hover:text-brassglow"
            >
              Edit
            </button>
          )}
        </header>

        {step === "details" ? (
          <div className="p-5">
            <p className="text-[12.5px] text-soft">
              {signedIn
                ? "Confirmation goes to your account email. Edit anything that differs."
                : "We’ll email your confirmation and reference here."}
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <div className="flex gap-2.5">
                <input className={inputClass} placeholder="First name" autoComplete="given-name"
                  value={guest.firstName} onChange={(e) => setGuest((g) => ({ ...g, firstName: e.target.value }))} />
                <input className={inputClass} placeholder="Last name" autoComplete="family-name"
                  value={guest.lastName} onChange={(e) => setGuest((g) => ({ ...g, lastName: e.target.value }))} />
              </div>
              <input className={inputClass} type="email" inputMode="email" placeholder="Email" autoComplete="email"
                value={guest.email} onChange={(e) => setGuest((g) => ({ ...g, email: e.target.value }))} />
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 focus-within:border-brass">
                <select
                  aria-label="Country code"
                  value={phoneIso}
                  onChange={(e) => setPhoneIso(e.target.value)}
                  className="shrink-0 bg-transparent text-[14px] text-ink outline-none"
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.iso} value={c.iso} className="bg-surface text-ink">
                      {c.flag} {c.dial}
                    </option>
                  ))}
                </select>
                <span className="h-5 w-px shrink-0 bg-line" />
                <input
                  className="w-full min-w-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-soft"
                  type="tel"
                  inputMode="tel"
                  placeholder="Phone number"
                  autoComplete="tel-national"
                  value={guest.phone}
                  onChange={(e) => setGuest((g) => ({ ...g, phone: e.target.value }))}
                />
              </div>

              <div className="mt-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-soft">
                Address
              </div>
              <input className={inputClass} placeholder="Street address" autoComplete="address-line1"
                value={guest.line1} onChange={(e) => setGuest((g) => ({ ...g, line1: e.target.value }))} />
              <div className="flex gap-2.5">
                <input className={inputBase + " min-w-0 flex-1"} placeholder="City" autoComplete="address-level2"
                  value={guest.city} onChange={(e) => setGuest((g) => ({ ...g, city: e.target.value }))} />
                <input className={inputBase + " w-20 shrink-0"} placeholder="State" autoComplete="address-level1"
                  value={guest.state} onChange={(e) => setGuest((g) => ({ ...g, state: e.target.value }))} />
                <input className={inputBase + " w-24 shrink-0"} placeholder="ZIP" autoComplete="postal-code" inputMode="numeric"
                  value={guest.zip} onChange={(e) => setGuest((g) => ({ ...g, zip: e.target.value }))} />
              </div>
            </div>
            {error && <p className="mt-3 text-[13px] text-red-500">{error}</p>}
            <button
              onClick={continueToPayment}
              disabled={!canContinue || saving}
              className="btn-brass mt-4 w-full rounded-lg py-3 text-[15px] font-bold text-[#1a1410] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "One moment…" : "Continue to payment"}
            </button>
          </div>
        ) : (
          // Collapsed recap
          <div className="flex flex-col gap-0.5 px-5 py-4 text-[13px]">
            <div className="text-ink">{guest.firstName} {guest.lastName}</div>
            <div className="text-soft">{guest.email}</div>
            <div className="text-soft">{fullPhone}</div>
            <div className="text-soft">
              {guest.line1}, {guest.city}, {guest.state} {guest.zip}, {dial === "+1" ? "US" : phoneIso}
            </div>
          </div>
        )}
      </section>

      {/* 2 · Payment */}
      <section ref={payRef} className="gloss overflow-hidden rounded-xl border border-line bg-surface">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-center gap-2.5">
            <StepNum n={2} state={step === "paying" ? "active" : "pending"} />
            <span className={"font-display text-[15px] " + (step === "paying" ? "" : "text-soft")}>Payment</span>
          </div>
          <span className="flex items-center gap-1 text-[11px] text-soft">
            <LockGlyph /> Encrypted
          </span>
        </header>

        {step !== "paying" && (
          <p className="px-5 py-6 text-center text-[12.5px] text-soft">
            Complete your details above to unlock secure payment.
          </p>
        )}

        {/* The Stripe host stays mounted the whole time. While the guest is on
            the details step it prewarms off-screen (kept in the DOM with real
            width so Stripe lays out); switching to "paying" just reveals it. */}
        <div className={step === "paying" ? "p-5" : "pointer-events-none absolute -left-[9999px] top-0 h-0 w-[500px] overflow-hidden opacity-0"}>
          <div id="nostavel-pay" className="min-h-[120px]" />
          {step === "paying" && (
            <>
              {error && <p className="pt-3 text-[13px] text-red-500">{error}</p>}
              {!cardMounted && !error && (
                <p className="pt-2 text-center text-[12px] text-soft">Loading secure card form…</p>
              )}
              {cardMounted && !error && (
                <button
                  onClick={submitPayment}
                  disabled={processing}
                  className="btn-brass mt-4 w-full rounded-lg py-3 text-[15px] font-bold text-[#1a1410] disabled:opacity-60"
                >
                  {processing ? "Processing…" : `Pay ${summary.totalLabel}`}
                </button>
              )}
              <p className="mt-3 text-center text-[11px] text-soft">
                Ref <span className="font-mono text-ink">{summary.humanRef}</span> · fees included, price locked.
                Sandbox — test card 4242 4242 4242 4242.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
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
