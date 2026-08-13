import Link from "next/link";
import { getHotelDetail } from "@/lib/liteapi";
import { getCurrentUser } from "@/lib/dal";
import StayDetailClient from "./StayDetailClient";

function Shell({ children, backHref }: { children: React.ReactNode; backHref: string }) {
  return (
    <div className="flex flex-1 flex-col bg-parchment text-ink">
      <header className="sticky top-0 z-40 border-b border-line glass">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 font-display text-[20px]">
            <span className="h-2.5 w-2.5 rounded-full bg-brass shadow-[0_0_14px_2px_var(--brass-glow)]" />
            Nosta<span className="italic text-brass">vel</span>
          </Link>
          <Link
            href={backHref}
            className="flex items-center gap-1.5 text-[13px] text-soft hover:text-ink"
          >
            <span aria-hidden>←</span> Back to results
          </Link>
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
    notes?: string;
    dest?: string;
    intent?: string;
  }>;
}) {
  const { hotelId } = await props.params;
  const sp = await props.searchParams;

  const checkin = sp.checkin || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const nights = Math.max(1, Math.min(30, Number(sp.nights) || 2));
  const backParams = new URLSearchParams({ checkin, nights: String(nights) });
  if (sp.dest) backParams.set("dest", sp.dest);
  if (sp.notes) backParams.set("notes", sp.notes);
  const backHref = sp.dest ? `/?${backParams.toString()}` : "/";

  let detail;
  try {
    detail = await getHotelDetail({ hotelId, checkin, nights });
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

  const account = await getCurrentUser();

  return (
    <Shell backHref={backHref}>
      <StayDetailClient
        detail={detail}
        checkin={checkin}
        nights={nights}
        intent={sp.intent === "book" ? "book" : "view"}
        isMember={Boolean(account)}
      />
    </Shell>
  );
}
