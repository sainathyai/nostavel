// Pure logic shared by the two cron routes (sweep, reconcile) — no db, no
// fetch, so it can be unit-tested without a live DATABASE_URL
// (docs/conventions.md §1: a rule that needs a database to import is in the
// wrong file).

/** The instant before which a row counts as past its TTL. `now` is injectable
 * so a boundary test doesn't depend on the real wall clock. */
export function cutoffFor(ttlMinutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - ttlMinutes * 60_000);
}

/**
 * Does our recorded status agree with what LiteAPI reports for the same
 * booking? LiteAPI's status vocabulary for a live (non-cancel) booking isn't
 * published beyond the cancel endpoint's two outcomes (CANCELLED /
 * CANCELLED_WITH_CHARGES), so this treats an exact-ish match as agreement and
 * anything else — including a status we don't recognize — as worth a human
 * look via `reconcile.mismatch`, rather than guessing at a translation table
 * that might silently swallow a real drift.
 */
export function statusesAgree(ours: "confirmed" | "cancelled", theirs: string | null | undefined): boolean {
  if (!theirs) return false;
  const t = theirs.toUpperCase();
  if (ours === "confirmed") return t === "CONFIRMED" || t === "BOOKED";
  return t.startsWith("CANCELLED");
}

/**
 * A pass's counts as one readable clause, for the `message` an operator reads
 * in the Logs Explorer summary (NOS-69).
 *
 * The same numbers are also written as individual fields, which is what a
 * metric would key on. This is the half a human reads at 3am without expanding
 * anything: "0 recovered" is the number that matters and it should not need a
 * click.
 */
export function summarise(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([name, value]) => `${name}=${value}`);
  return parts.length > 0 ? parts.join(" ") : "nothing to do";
}
