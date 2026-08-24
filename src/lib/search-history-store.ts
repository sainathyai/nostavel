import "server-only";

import { and, desc, eq, gt } from "drizzle-orm";

import { db } from "@/db";
import { searchHistory } from "@/db/schema";
import {
  RETENTION_DAYS,
  shouldRecord,
  type SearchHistoryEntry,
  type SearchQuery,
} from "./search-history";

// Persistence for search history. The RULES live in search-history.ts, which
// imports nothing, so they stay testable without a database; this file is only
// the two queries.

/**
 * Record a search for a signed-in guest. Best effort by design: history is a
 * convenience, and a database hiccup must never take a results page down with
 * it.
 *
 * Anonymous visitors are not recorded at all. There is no identity to attach a
 * row to, and inventing one (a cookie, a fingerprint) would turn a small
 * convenience into tracking.
 */
export async function recordSearch(
  userId: string | null,
  query: SearchQuery,
  now: Date = new Date(),
): Promise<void> {
  if (!userId) return;
  try {
    const [last] = await db
      .select({ query: searchHistory.query, at: searchHistory.createdAt })
      .from(searchHistory)
      .where(eq(searchHistory.userId, userId))
      .orderBy(desc(searchHistory.createdAt))
      .limit(1);

    const previous: SearchHistoryEntry | null = last
      ? { query: last.query as SearchQuery, at: last.at }
      : null;
    if (!shouldRecord(query, previous, now)) return;

    await db.insert(searchHistory).values({ userId, query, createdAt: now });
  } catch {
    // Swallowed on purpose. See the doc comment: the search page must render.
  }
}

/** The guest's own recent searches, newest first, inside the retention window. */
export async function recentSearches(
  userId: string,
  limit = 10,
  now: Date = new Date(),
): Promise<SearchHistoryEntry[]> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ query: searchHistory.query, at: searchHistory.createdAt })
    .from(searchHistory)
    .where(and(eq(searchHistory.userId, userId), gt(searchHistory.createdAt, cutoff)))
    .orderBy(desc(searchHistory.createdAt))
    .limit(limit);
  return rows.map((r) => ({ query: r.query as SearchQuery, at: r.at }));
}
