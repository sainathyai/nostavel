---
name: security
description: Authentication, authorization, secrets, webhooks, rate limits and security headers. Read before editing auth, server actions, API routes or next.config.ts.
globs:
  - "src/auth.ts"
  - "src/lib/{dal,guest-verify,webhook-auth,rate-limit,quote-token,signed-claim,booking-access,booking-authz,booking-caller}.ts"
  - "src/app/api/**"
  - "src/app/actions/**"
  - "next.config.ts"
---

# Security rules

Source of truth: `docs/conventions.md` §2 and `SECURITY.md`. The repository is public and handles guest personal data and payments, so treat every entry point as reachable by an attacker.

## Authorization
- **Every action and route decides who may act before it acts.**
  - **Members:** load the current user through `lib/dal.ts` (`getCurrentUser`) and check that the booking belongs to them.
  - **Guests without an account:** prove access with a signed token or cookie. `lib/signed-claim.ts` is the primitive - seal a claim for a named **purpose**, re-evaluate it against the current request, never trust it on its own. Don't invent a new signing scheme. `lib/quote-token.ts` and `lib/guest-verify.ts` are two older copies of the same pattern.
  - **A signature says we wrote it, not what we wrote it for.** Every signed format here is `base64url(JSON) "." HMAC-SHA256(AUTH_SECRET, body)`, so one verifies as another and only the payload distinguishes them. Sign the purpose into the payload and refuse a token whose purpose is not the one being read. NOS-9: the `/find` challenge cookie is a superset of the verified cookie, so it read as proof of owning an email the holder had never seen a code for.
  - **Validate the shape of anything you unsealed, before using it.** `Date.now() > undefined` is false, and so is every comparison against `NaN`, so an unchecked expiry fails **open**; a field typed `string` that arrives as a number turns a `.trim()` into a thrown `TypeError` inside a decision that was supposed to deny.
  - **Authorizing a booking action:** the decision is `mayActOnBooking` (`lib/booking-authz.ts`), a pure rule; the caller is resolved by `lib/booking-caller.ts` from the session and the cookie jar, never from the request body. A new entry point that acts on a booking asks the rule - including a page, because a page that writes is an entry point too.
  - **Never compare two nullable identities for equality.** `booking.userId === user.id` is true when both are null, which is every anonymous booking against every anonymous visitor. That was NOS-9. Demand a non-null value before comparing, and give the anonymous case its own explicit proof.
- **Authorization lives in server code, never in the UI.** There is no middleware/proxy file, so each entry point checks for itself.

## Secrets
- Secrets come from environment variables only. They never appear in code, logs, error messages, props sent to the browser, or analysis outputs.
- **Compare secrets in constant time** with `verifySharedSecret` (`lib/webhook-auth.ts`). Never use `===` on a secret.
- **Server boundary:** modules that touch secrets or supplier data import `server-only` (§2).

## Entry points
- **Webhooks:**
  - verify the shared secret first;
  - store the raw event, and deduplicate on the supplier's event ID;
  - make processing idempotent.
- **Cron routes** require `Authorization: Bearer CRON_SECRET`.
- **Rate limits:** anything that calls the supplier, sends email or checks a code is rate-limited.
- **Input:** validate at the boundary. Never trust IDs, prices or tiers sent by the browser.
- **Errors:** the guest gets a safe message; the detail goes to the server log.

## Headers and CSP
- Security headers and the Content Security Policy live in `next.config.ts`. The CSP is **report-only** today.
- Any change to headers, the CSP, auth configuration or cookie settings is flagged "security" in the pull request for security review.

## Known gaps: do not copy these patterns
These exist in the code today, each with a ticket. Don't treat them as precedent, and don't extend them.

| Gap | Where | Ticket |
|---|---|---|
| Rate limit is in-memory and keyed on `x-forwarded-for`, which a client can spoof | `src/lib/rate-limit.ts` | NOS-10 |
| Raw supplier error messages returned to users | actions and `src/app/api/stays-in-area` | NOS-11 |
| Four signed formats share `AUTH_SECRET` and one envelope, so each verifies as the others; only the purpose inside the payload tells them apart | `quote-token.ts`, `guest-verify.ts` (two), `signed-claim.ts` | — |
| Booking snapshots not schema-validated | `src/lib/booking-service.ts` | — |
| CSP is report-only; no HSTS header | `next.config.ts` | — |

The full list of pre-production gaps is in `docs/production-readiness.md` §4.

## Reporting
Suspected vulnerabilities go through private vulnerability reporting (`SECURITY.md`), never a public issue or pull request description.
