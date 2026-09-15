// Abandoned-hold sweeper. docs/production-readiness.md §2.2: rows sit at
// `prebooked` forever today, holding a live Stripe `paymentSecret`, because
// nothing ever expires them. Two distinct cleanups, per the doc's split:
//
// 1. Abandoned holds — `prebooked` past its TTL, guest never reached payment.
// 2. Failed-payment cleanup — `payment_pending` past its TTL with no
//    succeeded `payments` row, i.e. the card was never actually charged.
//
// SAFE UNDER CONCURRENT RUNS WITHOUT A LOCK: each transition is a single
// `UPDATE ... WHERE status = '<from>' ... RETURNING`, and Postgres's own
// row-level atomicity is the mutex — a second overlapping run's WHERE clause
// simply matches nothing once the first run has already flipped a row's
// status, the same compare-and-swap idea `idempotencyKey` already relies on
// elsewhere in this codebase. No advisory lock or lock table needed (the
// neon-http driver is stateless per query anyway, so a lock spanning two
// queries couldn't be held reliably regardless).
//
// Triggered by a scheduled GitHub Actions workflow
// (.github/workflows/cron-sweep.yml) rather than a platform-specific cron —
// no deploy target is chosen yet, and this works under any future host.
import { and, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { bookings, bookingEvents } from "@/db/schema";
import { verifySharedSecret } from "@/lib/webhook-auth";
import { cutoffFor } from "@/lib/cron-format";

export const runtime = "nodejs";

const PREBOOK_TTL_MINUTES = 30;

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const cutoff = cutoffFor(PREBOOK_TTL_MINUTES, now);

  const expiredHolds = await db
    .update(bookings)
    .set({ status: "expired", paymentSecret: null, updatedAt: now })
    .where(and(eq(bookings.status, "prebooked"), lt(bookings.updatedAt, cutoff)))
    .returning({ id: bookings.id });

  const abandonedPayments = await db
    .update(bookings)
    .set({ status: "expired", paymentSecret: null, updatedAt: now })
    .where(and(eq(bookings.status, "payment_pending"), lt(bookings.updatedAt, cutoff)))
    .returning({ id: bookings.id });

  if (expiredHolds.length > 0) {
    await db.insert(bookingEvents).values(
      expiredHolds.map((r) => ({ bookingId: r.id, type: "hold.expired", actor: "system" as const })),
    );
  }
  if (abandonedPayments.length > 0) {
    await db.insert(bookingEvents).values(
      abandonedPayments.map((r) => ({ bookingId: r.id, type: "payment.abandoned", actor: "system" as const })),
    );
  }

  return Response.json({
    ok: true,
    holdsExpired: expiredHolds.length,
    paymentsAbandoned: abandonedPayments.length,
  });
}
