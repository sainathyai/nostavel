import Link from "next/link";
import { getHotelDetail } from "@/lib/liteapi";
import { getCurrentUser } from "@/lib/dal";
import { signQuote } from "@/lib/quote-token";
import StayDetailClient from "./StayDetailClient";
import ThemeToggle from "@/components/ThemeToggle";

// A default check-in when the guest arrived without one (e.g. a bare hotel
// link). Pulled out of the component body: react-hooks/purity flags any
// impure call (Date.now, new Date) found directly inside a component
// function, even an async Server Component whose "render" runs once per
// request and carries none of the re-render risk the rule exists for. A
// named top-level helper is the accepted escape from that syntactic check —
// same fix Next's own docs use for request-time values in Server Components.
function defaultCheckin(): string {
  return new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
}

function Shell({ children, backHref }: { children: React.ReactNode; backHref: string }) {
  return (
    <div className="flex flex-1 flex-col bg-parchment text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-parchment">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <div className="flex items-center gap-2.5">
            <Link
              href={backHref}
              className="flex items-center gap-1.5 text-[13px] text-soft hover:text-ink"
            >
              <span aria-hidden>←</span> Back to results
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-6 py-6">{children}</main>
    </div>
  );
}

function Notice({ title, body, backHref }: { title: string; body: string; backHref: string }) {
  return (
    <div className="gloss rise mx-auto mt-10 max-w-md rounded-xl border border-line bg-surface p-6 text-center">
      <h1 className="font-display text-[22px]">{title}</h1>
      <p className="mt-2 text-[14px] text-soft">{body}</p>
      <Link
        href={backHref}
        className="btn-brass mt-4 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-[#1a1410]"
      >
        Back to results
      </Link>
    </div>
  );
}

export default async function StayPage(props: {
  params: Promise<{ hotelId: string }>;
  searchParams: Promise<{
    checkin?: string;
    nights?: string;
    /** Set when a held rate was voided because the session changed. */
    repriced?: string;
    notes?: string;
    dest?: string;
    intent?: string;
  }>;
}) {
  const { hotelId } = await props.params;
  const sp = await props.searchParams;

  const checkin = sp.checkin || defaultCheckin();
  const nights = Math.max(1, Math.min(30, Number(sp.nights) || 2));
  const backParams = new URLSearchParams({ checkin, nights: String(nights) });
  if (sp.dest) backParams.set("dest", sp.dest);
  if (sp.notes) backParams.set("notes", sp.notes);
  const backHref = sp.dest ? `/?${backParams.toString()}` : "/";

  // Read the session FIRST. It selects which of the two prices we ask LiteAPI
  // to charge, so it must be known before the priced rates call goes out. This
  // costs nothing: it was already awaited in this same request, just below the
  // fetch instead of above it.
  const account = await getCurrentUser();
  const isMember = Boolean(account);

  let detail;
  try {
    detail = await getHotelDetail({ hotelId, checkin, nights, isMember });
  } catch {
    return (
      <Shell backHref={backHref}>
        <Notice
          title="Couldn't load this stay"
          body="We hit a snag pulling live rates for this hotel. Try again from your search results."
          backHref={backHref}
        />
      </Shell>
    );
  }

  if (!detail.hotel.name || detail.options.length === 0) {
    return (
      <Shell backHref={backHref}>
        <Notice
          title="No rooms available"
          body="This hotel has no priced availability for those dates. Try different dates or another stay."
          backHref={backHref}
        />
      </Shell>
    );
  }

  return (
    <Shell backHref={backHref}>
      {sp.repriced && (
        <div className="mx-auto mb-4 max-w-[1180px] rounded-xl border border-brass/35 bg-brass/[0.07] px-4 py-3 text-[13px] text-ink">
          {sp.repriced === "in"
            ? "You signed in, so we released the held rate and priced these rooms at the member rate. Pick your room again to continue."
            : "You signed out, so we released the held rate and priced these rooms at the public rate. Pick your room again to continue."}
        </div>
      )}
      <StayDetailClient
        detail={detail}
        checkin={checkin}
        nights={nights}
        intent={sp.intent === "book" ? "book" : "view"}
        isMember={isMember}
        /* Signed in the SAME render that chose the margin above, so the claim
           and the prices on this page can never disagree. */
        quoteToken={signQuote(isMember ? "member" : "public")}
      />
    </Shell>
  );
}
