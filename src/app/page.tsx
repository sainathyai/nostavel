import { resolveDest, searchStays, type SearchResult } from "@/lib/liteapi";
import { getSeasonalSections } from "@/lib/seasonal";
import Experience from "./Experience";
import { getCurrentUser } from "@/lib/dal";

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
      });
    } catch (e) {
      error = (e as Error).message;
    }
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
