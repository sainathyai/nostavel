// GET /api/health — is this copy of the app worth sending visitors to?
//
// Asked by the delivery pipeline after every deploy, before any traffic is
// moved, and by anything watching the environment afterwards. The decision of
// what a healthy answer looks like is src/lib/health.ts; this file is the
// request, the credential check and the one database probe.
//
// NOT BEHIND THE PASSWORD GATE (src/lib/access-gate.ts), and deliberately still
// answering when the app has refused to serve everything else: a pipeline that
// can see a deploy is broken but not why is a pipeline that cannot act.
//
// ?deep=1 NEEDS THE OPERATIONS SECRET, for two reasons. The problem list names
// exactly which secret a deployed copy is missing, which is a map of its
// weaknesses; and the probe makes this app run a query on demand, which is not
// a lever to hand to anonymous callers. Same `Authorization: Bearer <CRON_SECRET>`
// the sweeper and the reconciler use, compared the same constant-time way.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { buildHealth, type DatabaseCheck } from "@/lib/health";
import { verifySharedSecret } from "@/lib/webhook-auth";

export const runtime = "nodejs";
// Never rendered ahead of time: a cached health check reports the state of a
// process that may no longer exist. Reading the query string already forces
// this, so this line is documentation of intent that also survives the query
// string going away.
export const dynamic = "force-dynamic";

/**
 * Sent on every answer, because `dynamic = "force-dynamic"` does not imply it.
 *
 * Measured against the real image (2026-10-06): this route's responses carried
 * NO cache-control header at all. The NOS-60 security review expected the
 * framework to add one and said so as a prediction rather than a measurement;
 * the prediction was wrong. Without this, anything between the pipeline and the
 * app - a CDN, a proxy, a browser - may serve a previous revision's `ok: true`
 * to the step that decides whether to move traffic, which is the one answer
 * that must always be about the process answering right now.
 *
 * src/proxy.ts sets its own for the same reason rather than relying on this.
 */
const NO_STORE = { "cache-control": "no-store" };

/**
 * How long the database probe waits before calling the database unreachable.
 *
 * Two seconds: long enough for a cold Neon endpoint to answer a `select 1`,
 * short enough that a deploy step reading this route cannot be held open by a
 * misconfigured connection string.
 */
const PROBE_TIMEOUT_MS = 2000;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    const health = buildHealth({ env: process.env, detail: false, database: "not-checked" });
    // 503 rather than 200-with-ok-false, so a pipeline step can be a plain
    // `curl --fail` and still be correct.
    return Response.json(health, { status: health.ok ? 200 : 503, headers: NO_STORE });
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  let database: DatabaseCheck;
  try {
    // The cheapest possible round-trip that proves the credential works and the
    // database answers. Reads no table on purpose: a health check that depends
    // on the schema reports a migration as an outage.
    //
    // BOUNDED, BECAUSE A HANG IS WORSE THAN A FAILURE. A present-but-wrong
    // DATABASE_URL can leave the driver's HTTP request outstanding for a long
    // time, and the pipeline step reading this route would hang with it
    // (NOS-60 security review, L3). "Took longer than two seconds" and "is
    // unreachable" are the same answer for this route's purpose, and this route
    // exists to give an answer.
    //
    // Raced rather than aborted: the neon-http driver takes no AbortSignal, so
    // the query is abandoned rather than cancelled. That leaks nothing - the
    // promise settles into a void - and a request this route gave up on is one
    // whose answer nobody wants.
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS)),
    ]);
    database = "ok";
  } catch {
    // Swallowed on purpose: the reason could carry the connection string, and
    // this response is the one thing a misconfigured copy still serves.
    database = "unreachable";
  }

  const health = buildHealth({ env: process.env, detail: true, database });
  return Response.json(health, { status: health.ok ? 200 : 503, headers: NO_STORE });
}
