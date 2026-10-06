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
// Never cached: a cached health check reports the state of a process that may no
// longer exist. Reading the query string already forces this, so this line is
// documentation of intent that also survives the query string going away.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";

  if (!deep) {
    const health = buildHealth({ env: process.env, detail: false, database: "not-checked" });
    // 503 rather than 200-with-ok-false, so a pipeline step can be a plain
    // `curl --fail` and still be correct.
    return Response.json(health, { status: health.ok ? 200 : 503 });
  }

  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : auth;
  if (!verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let database: DatabaseCheck;
  try {
    // The cheapest possible round-trip that proves the credential works and the
    // database answers. Reads no table on purpose: a health check that depends
    // on the schema reports a migration as an outage.
    await db.execute(sql`select 1`);
    database = "ok";
  } catch {
    // Swallowed on purpose: the reason could carry the connection string, and
    // this response is the one thing a misconfigured copy still serves.
    database = "unreachable";
  }

  const health = buildHealth({ env: process.env, detail: true, database });
  return Response.json(health, { status: health.ok ? 200 : 503 });
}
