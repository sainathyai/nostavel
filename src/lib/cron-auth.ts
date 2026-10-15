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
//     One correction the security review insisted on, because the first version
//     of this comment oversold it: `issuer` and `audience` are passed to jose AND
//     checked by the rule, but both read the SAME derived value, so that is one
//     source of truth checked twice rather than two independent checks. jose's
//     genuinely independent contributions are the signature, the algorithm/key
//     binding, and `nbf`, which the rule never looks at. The rule's genuinely
//     independent contributions are `email`, `email_verified`, `sub`, a future
//     `iat`, and the presence and finiteness of `exp` and `iat`.
//
// Why that split: the security review of NOS-65 put it plainly - moving these
// routes off a shared secret moves authentication into a JWT verifier in the money
// path, and a fail-open bug there is worse than a leaked string. So every claim
// decision lives in a file with no I/O and a test per denied claim, and this file
// does nothing but fetch keys and check a signature.
import "server-only";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  CLOCK_SKEW_SECONDS,
  verifyCronCaller,
  type ExpectedCaller,
  type IdentityVerdict,
} from "./cron-identity";
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
 * How a token's signing key is resolved. Injectable for one reason, and it is the
 * reason the security review of NOS-65 called the most important finding.
 *
 * Without this, nothing could test the line that connects the signature layer to
 * the claim rule. Dropping the `verifyCronCaller` call during a refactor would
 * leave 21 green tests, a clean typecheck and a clean lint, while authorising
 * **every Google Cloud customer** to expire holds and drive supplier calls -
 * because jose alone checks the signature, `iss` and `aud`, and anyone can mint a
 * Google-signed token for any audience. That is the exact failure this file's
 * whole structure exists to prevent, and it was undefended.
 *
 * Production always uses Google's live key set: the parameter has a default and no
 * caller passes anything else.
 */
export type KeyResolver = Parameters<typeof jwtVerify>[1];

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
  keys: KeyResolver = GOOGLE_JWKS,
): Promise<CronAuthResult> {
  const header = request.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : header;
  if (!bearer) return { ok: false, reason: "no authorization header" };

  const expected = expectedCronCaller(job);
  // A JWT has two dots and a shared secret does not. This picks the path; it is
  // NOT a security boundary, and the next branch is what makes that true.
  const looksLikeJwt = bearer.split(".").length === 3;

  if (looksLikeJwt) {
    // TOTAL on purpose (security review, M2). The first version only entered
    // this branch when `expected` existed, so a JWT-shaped credential with the
    // identity unconfigured fell through to the shared-secret compare - which
    // made the stated invariant "neither branch can accept the other's
    // credential" false. Not exploitable, because that compare is length-guarded
    // and constant-time, but a claimed invariant that does not hold is how the
    // next person reasons wrongly about this file.
    if (!expected) return { ok: false, reason: "identity is not configured" };
    try {
      const { payload } = await jwtVerify(bearer, keys, {
        // `algorithms` is insurance, not a current fix: jose 6.2.7's key
        // resolver already refuses a secret-based algorithm, so an HS256 token
        // signed with CRON_SECRET cannot resolve a key. Pinned anyway, against a
        // future version that loosens the resolver.
        algorithms: ["RS256"],
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: expected.audience,
        // jose SKIPS the expiry check entirely when `exp` is absent, and only
        // requires `iat` when `maxTokenAge` is set. So these are not decoration:
        // without them jose alone would accept a Google-signed token that never
        // expires. The rule below also demands both, which is the belt.
        requiredClaims: ["exp", "iat", "email", "email_verified", "sub"],
        // The only thing that bounds how long a captured token stays replayable.
        maxTokenAge: "1h",
        // Both layers now judge time against the SAME injected instant. jose's
        // `clockTolerance` defaults to 0 and its `now` is the real clock, so
        // before this the rule's skew allowance was unreachable: jose had already
        // rejected anything one second past expiry. Stricter than documented is
        // still a documented property that did not exist.
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: now,
      });
      const verdict = verifyCronCaller(payload, expected, now);
      return verdict.ok ? { ok: true, via: "oidc" } : verdict;
    } catch {
      // A bad signature, an unreachable key server, a missing required claim, or
      // a malformed token. No detail is surfaced: this route's whole value is
      // being unguessable.
      return { ok: false, reason: "token signature or required claims rejected" };
    }
  }

  if (verifySharedSecret(bearer, process.env.CRON_SECRET)) {
    return { ok: true, via: "shared-secret" };
  }

  return { ok: false, reason: "credential not accepted" };
}
