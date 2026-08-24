// What a signed-in guest has looked for, and nothing more.
//
// SCOPE, DELIBERATELY NARROW. This records the QUESTION, never the answer: a
// destination, dates and party size. It is not a cache and must never become
// one. Rates move (pricing.ts records ~40% of samples moving over a few
// minutes, and analysis/2026-08-21/session_pin.py measured live requotes up to
// $12.93 between calls seconds apart), so a stored result is evidence of what
// we quoted, not a price we may quote again. Keeping that line here is what
// stops "recent searches" quietly becoming stale pricing.
//
// It is also PERSONAL DATA: where someone is going and when. Rows exist only
// for signed-in users and RETENTION_DAYS is the stated life of one.
//
// NO INFRASTRUCTURE IMPORTS. Everything here is a pure rule so it can be tested
// without a database or a network. The persistence lives next door in
// search-history-store.ts.

/** How long a search stays in someone's history before it is swept. */
export const RETENTION_DAYS = 180;

/**
 * Ignore a repeat of the same search inside this window.
 *
 * Necessary because the write happens during a server render of a GET: a
 * refresh, a back-navigation, or Next prefetching the same URL would each
 * otherwise add a row, and "recent searches" would be twelve copies of one.
 */
export const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

export type SearchQuery = {
  dest: string;
  checkin: string; // yyyy-mm-dd
  nights: number;
  adults: number;
  /** Free text the guest typed, when they used the natural-language search. */
  notes?: string | null;
};

/** One row as the rest of the app sees it. */
export type SearchHistoryEntry = { query: SearchQuery; at: Date };

/** Two searches are "the same" when the guest would call them the same. */
export function sameSearch(a: SearchQuery, b: SearchQuery): boolean {
  return (
    a.dest.trim().toLowerCase() === b.dest.trim().toLowerCase() &&
    a.checkin === b.checkin &&
    a.nights === b.nights &&
    a.adults === b.adults
  );
}

/**
 * Should this search be written, given the most recent one on file?
 *
 * `last` is null when there is no history at all. Compared against the LAST
 * entry only: Austin, then New Orleans, then Austin again is three real
 * searches, and looking further back would swallow the third.
 */
export function shouldRecord(
  incoming: SearchQuery,
  last: SearchHistoryEntry | null,
  now: Date = new Date(),
  windowMs: number = DEDUPE_WINDOW_MS,
): boolean {
  if (!last) return true;
  if (!sameSearch(incoming, last.query)) return true;
  return now.getTime() - last.at.getTime() >= windowMs;
}
