// Who is allowed to run a money-safety job, as a pure rule (NOS-65).
//
// WHY THIS FILE IS PURE, AND WHY IT IS PARANOID
//
// Cloud Scheduler invokes `/api/cron/sweep` and `/api/cron/reconcile` with a
// Google-signed OIDC token instead of a shared secret, because the secret would
// have to travel through Terraform to reach the job's headers and no secret value
// may do that (ADR 0005). OIDC trusts an *identity* rather than a string, so the
// constraint is satisfied by construction rather than by care.
//
// The cost of that, named plainly by the security review of NOS-65: authentication
// moves from 25 tested lines of constant-time compare to a JWT verifier, in the
// money path. **A fail-open bug here is worse than a leaked secret**, because a
// secret at least has one obvious comparison. So the claim checking is a pure
// function with no I/O, no clock of its own and no network, and every branch is a
// denial with a reason.
//
// THE MISCONFIGURATION THAT MATTERS. Our Cloud Run service is public
// (`allUsers` invoker), so **Cloud Run does not validate the token for us** -
// only an IAM-gated service does that, and IAM is per service, not per path. If
// this rule checked the issuer and stopped there, any Google Cloud customer could
// mint a token for our audience and run the sweeper. The caller's exact
// service-account identity is therefore pinned by `email` AND by `sub`, the
// account's immutable unique id, because an email can be recreated on a deleted
// account and `sub` cannot.
//
// WHY EVERY MISSING CLAIM IS A DENIAL. `Date.now() > undefined` is `false`, so an
// expiry check written the obvious way passes a token with no `exp` at all. That
// is the exact shape of defect this repository keeps finding: the rule was right
// and the wiring let the bad case through. Every claim is therefore required,
// type-checked, and finite-checked before it is compared.

/** What the token must prove, supplied by the route from configuration. */
export type ExpectedCaller = {
  /** The service account Cloud Scheduler uses for this job. */
  email: string;
  /** That account's immutable unique id, which outlives a recreated email. */
  subject: string;
  /** The exact URL the job targets, which is what the token is audience-bound to. */
  audience: string;
};

/** The claims we care about, as they arrive: anything may be missing or wrong-typed. */
export type TokenClaims = {
  iss?: unknown;
  aud?: unknown;
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
};

export type IdentityVerdict = { ok: true } | { ok: false; reason: string };

/** Google's issuer for a service-account OIDC token. Both spellings are issued. */
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * How much clock skew to forgive, in seconds.
 *
 * Small on purpose: a scale-to-zero container's clock comes from the host, not
 * from us. 60 seconds is the usual allowance for signed-token verification.
 *
 * It does NOT govern replay, and an earlier version of this comment claimed it
 * did. `exp` governs replay, and a Cloud Scheduler OIDC token is good for about
 * an hour, so a captured token stays usable for its remaining lifetime - roughly
 * 60 times longer than this constant suggests. There is no `jti` cache and no
 * nonce. That is accepted rather than overlooked: a replayed sweep is an extra
 * sweep, and the job is built to be safe to run repeatedly. The lever that
 * actually bounds the window is `maxTokenAge` in `cron-auth.ts`.
 *
 * Exported so the signature layer forgives exactly the same amount. It did not
 * used to: jose's `clockTolerance` defaults to 0, so this allowance was
 * unreachable in practice (security review of NOS-65, M1).
 */
export const CLOCK_SKEW_SECONDS = 60;

/** A claim is only usable as a time if it is a real, finite number. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A claim is only usable as an identity if it is a non-empty string. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Decide whether these claims authorise a cron run.
 *
 * `now` is injected (conventions §2): the caller owns the clock, so a test can
 * sit on an expiry boundary without sleeping.
 *
 * Returns a reason on every denial, for the log. The reason names the claim, never
 * its value, because this runs on a path whose whole job is to be unguessable and
 * an echoed value is how a log becomes a disclosure (the same rule that caught
 * NOS-67's value-echoing messages).
 */
export function verifyCronCaller(
  claims: TokenClaims,
  expected: ExpectedCaller,
  now: Date,
): IdentityVerdict {
  const iss = nonEmptyString(claims.iss);
  if (!iss) return { ok: false, reason: "iss is missing or not a string" };
  if (!GOOGLE_ISSUERS.includes(iss)) return { ok: false, reason: "iss is not Google" };

  // The audience is what stops a token minted for the sweeper being replayed
  // against the reconciler, and what stops a token minted for someone else's
  // service being replayed against ours.
  const aud = nonEmptyString(claims.aud);
  if (!aud) return { ok: false, reason: "aud is missing or not a string" };
  if (aud !== expected.audience) return { ok: false, reason: "aud is not this route" };

  // THE CHECK THAT STOPS ALL OF GOOGLE CLOUD FROM BEING AUTHORISED.
  const email = nonEmptyString(claims.email);
  if (!email) return { ok: false, reason: "email is missing or not a string" };
  if (email !== expected.email) return { ok: false, reason: "email is not the expected caller" };

  // Google sets this true for a service account. Requiring it explicitly means a
  // token shaped like a human's unverified account cannot pass as the job.
  if (claims.email_verified !== true) {
    return { ok: false, reason: "email_verified is not true" };
  }

  const sub = nonEmptyString(claims.sub);
  if (!sub) return { ok: false, reason: "sub is missing or not a string" };
  if (sub !== expected.subject) return { ok: false, reason: "sub is not the expected caller" };

  // Expiry last, and explicitly, because this is the claim whose absence fails
  // open if it is compared without being checked first.
  const exp = finiteNumber(claims.exp);
  if (exp === null) return { ok: false, reason: "exp is missing or not a finite number" };
  const iat = finiteNumber(claims.iat);
  if (iat === null) return { ok: false, reason: "iat is missing or not a finite number" };

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (nowSeconds > exp + CLOCK_SKEW_SECONDS) return { ok: false, reason: "token has expired" };
  // A token issued in the future is either a clock problem or a forgery, and
  // either way it is not something to act on.
  if (iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: "token was issued in the future" };
  }
  if (iat > exp) return { ok: false, reason: "token expires before it was issued" };

  return { ok: true };
}
