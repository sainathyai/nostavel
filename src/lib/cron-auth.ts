// Authorising a cron run: signature first, then the pure rule (NOS-65).
//
// Two layers, deliberately.
//
//  1. `jose` verifies the token's SIGNATURE against Google's published keys. No
//     valid signature, no verdict. This is the part that cannot be a pure
//     function, because it needs the network.
//  2. `verifyCronCaller` in `cron-identity.ts` decides whether the *caller* is
//     allowed. It is pure, it takes an injected clock, and it is the authoritative
//     gate: `jose`'s own issuer and audience options are set as well, but as
//     defence in depth rather than as the decision. Both must pass.
//
// Why that split: the security review of NOS-65 put it plainly - moving these
// routes off a shared secret moves authentication into a JWT verifier in the money
// path, and a fail-open bug there is worse than a leaked string. So every claim
// decision lives in a file with no I/O and a test per denied claim, and this file
// does nothing but fetch keys and check a signature.
import "server-only";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { verifyCronCaller, type ExpectedCaller, type IdentityVerdict } from "./cron-identity";
import { verifySharedSecret } from "./webhook-auth";

/**
 * Google's public keys for service-account identity tokens.
 *
 * Module-level so the fetch is shared and cached across requests in one
 * container. `jose` refetches on an unknown `kid`, which is what makes key
 * rotation a non-event, and it throws rather than returning a verdict if the
 * fetch fails - so a key-server outage stops the job rather than opening it.
 * Stopping is the right failure here, and NOS-65's absence alert is what makes a
 * stopped job visible instead of silent.
 */
const GOOGLE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

/**
 * What a route expects of its caller, from the environment.
 *
 * None of these are secrets: a service-account email, its numeric id, and our own
 * URL. They are configuration, so they travel through Terraform like any other
 * environment value, which is the whole reason this approach exists (ADR 0005
 * forbids a secret value going that way, and Cloud Scheduler can only carry a
 * shared secret in the job's headers).
 *
 * Returns null when the environment is incomplete, which a caller must treat as
 * "cannot authorise by identity" rather than as "authorised".
 */
export function expectedCronCaller(job: "sweep" | "reconcile"): ExpectedCaller | null {
  const prefix = job === "sweep" ? "CRON_SWEEP_INVOKER" : "CRON_RECONCILE_INVOKER";
  const email = process.env[`${prefix}_EMAIL`];
  const subject = process.env[`${prefix}_SUB`];
  const appUrl = process.env.APP_URL;
  if (!email || !subject || !appUrl) return null;
  // The audience Cloud Scheduler is configured with is the exact job URL, so it
  // is derived here from the same APP_URL the rest of the app uses rather than
  // configured twice. Two copies of a URL drift, and NOS-67 was exactly that.
  return { email, subject, audience: `${appUrl.replace(/\/$/, "")}/api/cron/${job}` };
}

export type CronAuthResult = IdentityVerdict & { via?: "oidc" | "shared-secret" };

/**
 * Authorise a cron request.
 *
 * Accepts EITHER a Cloud Scheduler OIDC token or the legacy
 * `Bearer <CRON_SECRET>`, and that is temporary on purpose. The shared secret is
 * how `workflow_dispatch` still works, which NOS-65 keeps until Cloud Scheduler
 * has been seen to deliver for 72 hours and the absence alert has been seen to
 * fire. Removing the secret path is the last step of NOS-65, and it is worth
 * doing: `CRON_SECRET` is a repository-scoped Actions secret reachable from any
 * workflow on any merged branch, so while it is accepted here, anything able to
 * run a workflow can expire a hold.
 *
 * Tried in that order because the OIDC path is the one we want to exercise, and
 * because a request carrying a valid token should never fall through to a
 * comparison against a secret it does not have.
 */
export async function authorizeCronRequest(
  request: Request,
  job: "sweep" | "reconcile",
  now: Date,
): Promise<CronAuthResult> {
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : header;
  if (!bearer) return { ok: false, reason: "no authorization header" };

  const expected = expectedCronCaller(job);
  // A JWT has two dots and a shared secret does not, so this picks the path
  // without either branch being able to accept the other's credential.
  const looksLikeJwt = bearer.split(".").length === 3;

  if (looksLikeJwt && expected) {
    try {
      const { payload } = await jwtVerify(bearer, GOOGLE_JWKS, {
        // Defence in depth. The decision is `verifyCronCaller` below.
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: expected.audience,
      });
      const verdict = verifyCronCaller(payload, expected, now);
      return verdict.ok ? { ok: true, via: "oidc" } : verdict;
    } catch {
      // A bad signature, an unreachable key server, or a malformed token. No
      // detail is surfaced: the reason goes no further than this string, because
      // this route's whole value is being unguessable.
      return { ok: false, reason: "token signature could not be verified" };
    }
  }

  if (verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return { ok: true, via: "shared-secret" };
  }

  return {
    ok: false,
    reason: looksLikeJwt && !expected ? "identity is not configured" : "credential not accepted",
  };
}
