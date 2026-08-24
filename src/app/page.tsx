import { resolveDest, searchStays, type SearchResult } from "@/lib/liteapi";
import { getSeasonalSections } from "@/lib/seasonal";
import Experience from "./Experience";
import { getCurrentUser } from "@/lib/dal";
import { recordSearch } from "@/lib/search-history-store";

// Live rates: render on request, never statically prerender at build.
export const dynamic = "force-dynamic";

function defaultCheckin() {
  return new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ dest?: string; checkin?: string; nights?: string; notes?: string }>;
}) {
  const sp = await searchParams;
  const account = await getCurrentUser();
  const resolved = sp.dest ? resolveDest(sp.dest) : null;
  const query = {
    dest: resolved ? (sp.dest as string) : "nyc",
    checkin: sp.checkin || defaultCheckin(),
    nights: Math.max(1, Math.min(30, Number(sp.nights) || 2)),
    notes: sp.notes || "",
  };

  // Searched: show results for that destination + dates.
  if (resolved) {
    let result: SearchResult | null = null;
    let error: string | null = null;
    try {
      result = await searchStays({
        dest: query.dest,
        checkin: query.checkin,
        nights: query.nights,
        notes: query.notes,
        // Selects which of the two prices these cards quote. `account` is
        // already awaited above; no extra work, no extra request.
        isMember: Boolean(account),
      });
    } catch (e) {
      error = (e as Error).message;
    }

    // Recorded from a GET render, which is a side effect on a read. Accepted
    // deliberately: a search is a navigation, not a form post, so there is no
    // action to hang this off. shouldRecord() absorbs the consequence, since a
    // refresh or a Next prefetch of the same URL would otherwise each add a
    // row. Awaited rather than floated so a slow write cannot outlive the
    // request and be killed mid-statement.
    await recordSearch(account?.id ?? null, {
      dest: query.dest,
      checkin: query.checkin,
      nights: query.nights,
      adults: 2,
      notes: query.notes || null,
    });

    return (
      <Experience
        mode="search"
        query={query}
        result={result}
        searchError={error}
        account={account}
      />
    );
  }

  // Default landing: season-aware destination inspiration. Pure data — no API
  // calls — so the homepage is instant. A click on a place runs its curated search.
  const sections = getSeasonalSections();

  return <Experience mode="browse" query={query} sections={sections} account={account} />;
}
