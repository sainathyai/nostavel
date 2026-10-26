---
name: security
description: Authentication, authorization, secrets, webhooks, rate limits and security headers. Read before editing auth, server actions, API routes or next.config.ts.
globs:
  - "src/auth.ts"
  - "src/lib/{dal,guest-verify,webhook-auth,rate-limit,quote-token,signed-claim,booking-access,booking-authz,booking-caller}.ts"
  - "src/lib/{access-gate,deploy-config,health}.ts"
  - "src/lib/{cron-auth,cron-identity}.ts"
  - "src/app/api/**"
  - "src/app/actions/**"
  - "src/proxy.ts"
  - "src/instrumentation.ts"
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
- **Authorization lives in server code, never in the UI.**
- **There IS a proxy file now, and it is not where authorization goes.** `src/proxy.ts` (NOS-60) runs before every request and does exactly two things: refuse every path but `/api/health` when the process's configuration is fatally wrong, and demand the shared environment's access password. The decision is the pure rule `lib/access-gate.ts`; what counts as fatal is `lib/deploy-config.ts`. Neither knows anything about a guest, a booking or a session, and nothing may start relying on it for that - Next's own guidance is that a proxy is not a session or authorization layer, and a bypass of it must never be a bypass of an authorization check. **Each entry point still checks for itself.**
- **Anything exempted in the proxy is exempted from the configuration refusal too**, so that list is a money decision, not a routing convenience. `_next/static/` keeps its trailing slash deliberately: without it the exclusion is an unanchored prefix, and `/_next/staticXYZ` was measured reaching the router with no gate at all.
- **A deployed copy refuses a live supplier key**, and refuses it in two places: every request (`src/proxy.ts`) and every supplier call (`requireSandboxKey` in `lib/liteapi.ts`). One of those is not enough - the second exists precisely because a request that skips the proxy must still not be able to move money. When the live-money gate is built, `requireSandboxKey` is what it has to open deliberately.

## Secrets
- Secrets come from environment variables only. They never appear in code, logs, error messages, props sent to the browser, or analysis outputs.
- **Compare secrets in constant time** with `verifySharedSecret` (`lib/webhook-auth.ts`). Never use `===` on a secret.
- **Server boundary:** modules that touch secrets or supplier data import `server-only` (§2).

## Entry points
- **Webhooks:**
  - verify the shared secret first;
  - store the raw event, and deduplicate on the supplier's event ID;
  - make processing idempotent.
- **Cron routes** accept EITHER a Cloud Scheduler OIDC token or the legacy
  `Authorization: Bearer CRON_SECRET` (NOS-65). The identity decision is the pure
  rule in `cron-identity.ts`, never inline: our Cloud Run service is public, so
  Cloud Run does not validate a token for us, and a verifier that checks the
  issuer without pinning the exact service-account `email` and `sub` authorises
  every Google Cloud customer. The shared-secret path is temporary; see the gap
  table for why it is worth removing and what still blocks that.
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
| Rate limit is keyed on `x-forwarded-for`, which a client can spoof, so one caller can wear many keys and a shared proxy makes many callers wear one. ~~and is in-memory~~ **the store half is closed (NOS-10, 2026-10-26):** counters live in Postgres (`rate_limits`), shared across instances and surviving a cold start, incremented by one atomic upsert. The key remains the open half, and it is the half an attacker chooses | `src/lib/rate-limit.ts`, `src/lib/rate-limit-store.ts` | unfiled - the key, not the store |
| Raw supplier error messages returned to users | actions and `src/app/api/stays-in-area` | NOS-11 |
| Four signed formats share `AUTH_SECRET` and one envelope, so each verifies as the others; only the purpose inside the payload tells them apart | `quote-token.ts`, `guest-verify.ts` (two), `signed-claim.ts` | — |
| Booking snapshots not schema-validated | `src/lib/booking-service.ts` | — |
| CSP is report-only; no HSTS header | `next.config.ts` | — |
| The live-key refusal is **not** the live-money gate: no caps, no allowlist, no kill switch, no acknowledgement. It refuses a non-sandbox key outright, which is all it claims (ADR 0005) | `src/lib/deploy-config.ts`, `requireSandboxKey` in `src/lib/liteapi.ts` | — |
| The environment access gate has no rate limit and no lockout. A refusal is logged, which is the floor, not the fix | `src/proxy.ts` | NOS-62 |
| The deploy identity can read every secret in the test environment, transitively: anything able to deploy an image that runs as the runtime identity reads what that identity reads. Inherent to deploying; the boundary is the federated identity, pinned to one workflow file on `main` | `infra/envs/uat/main.tf`, `.github/workflows/deploy-uat.yml` | — |
| `UAT_DATABASE_URL` is a repository-scoped Actions secret, reachable from any workflow on any merged branch. The reviewer gate protects the deploy job, not the credential | `.github/workflows/deploy-uat.yml` | — |
| Nothing enforces additive-only migrations. No check reads the SQL, so a destructive migration would be planned, approved and applied like any other; the owner's approval is the only place it is caught | `scripts/migrate-plan.mjs` | — |
| **`sweepDecision` expires a lapsed `prebooked` row on the premise that no payment was started, and that premise is not safe.** `markPaymentStartingAction` is best-effort and `CheckoutClient` swallows its failure, so a charge can happen with the row still `prebooked`. The security review of NOS-51 rejected the earlier wording of this row as understating it: the population is NOT just a network accident, because the action returns `{ok:false}` for a rate-limit or authorization refusal and the client never inspects the return value - and that rate limit shares one bucket with `markPaymentFailedAction`, so trying a second card burns two slots. The confirmation page now records `payment.unresolved` when the provider's redirect arrives on a lapsed hold, which covers the case a guest completes; what remains is a guest who is charged and never returns. This is the NOS-5 harm by a narrow path, not a quirk | `src/lib/booking-transitions.ts` (`sweepDecision`), `src/app/book/[bookingId]/CheckoutClient.tsx` | — |
| The delivery pipeline has now run green once (2026-10-10). Still unobserved: that a later deploy preserves secret references, and that a rollback holds until the next merge | `.github/workflows/deploy-uat.yml`, `infra/envs/uat/` | — |
| The nightly reconciler **cannot see a confirmed booking whose `amountSupplierMinor` is null**: `isNotNull` excludes it permanently, and a confirmed booking with no recorded supplier cost is exactly the row most worth reconciling. Found by running it against the test environment, where 2 of 3 candidate rows were excluded this way | `src/app/api/cron/reconcile/route.ts` | NOS-64 |
| ~~Both money-safety jobs run on GitHub's `schedule` event, which delivered 1.6% of the sweeper's runs~~ **CLOSED 2026-10-19 (NOS-65).** Both jobs are Cloud Scheduler's, authorised by OIDC identity. Measured over the 95.3 hours from 2026-10-15 14:35Z: **1138 completed passes against 1145 expected** at `*/5`, 99.4%, with the 7-tick deficit fully accounted for (6 from the deliberate alarm test, 1 late tick) and a worst gap of 10m01s against a 15-minute supplier hold. The `schedule:` blocks are out of both workflows; `workflow_dispatch` remains as the hand-run fallback. For the record, GitHub's schedule fired 27 times over those same four days, 1.6% again, measured independently of the original 13-of-808 | `infra/envs/uat/scheduler.tf` | NOS-65 |
| **`markPaymentFailedAction` reverts a booking out of `payment_pending` on the browser's word that payment failed**, which is correct only if a client-side `confirmPayment` error always means no money moved. Unverified, and Stripe surfaces timeouts and abandonment through the same path as a decline. Deliberately not a ticket: the answer lives in the owner's Stripe dashboard and decides whether the fix is a guard or a provider round-trip. Held as an open question in `docs/production-readiness.md` §8.1 until production testing (D-10.2) | `src/app/actions/booking.ts`, `src/app/book/[bookingId]/CheckoutClient.tsx` | — |

| The cron routes still accept `CRON_SECRET`, a repository-scoped Actions secret reachable from any workflow on any merged branch, so anything able to run a workflow can expire a hold. The same secret also unlocks `/api/health?deep=1`, which returns the **fatal-configuration problem list** naming which secrets a deployed copy is missing, and drives an on-demand database query. The OIDC path **is** now exercised: 1138 real Cloud Scheduler tokens accepted over the four days from 2026-10-15, so keeping the jobs running is no longer a reason to keep the secret branch in these routes. What still is: `workflow_dispatch` is the documented hand-run fallback and authorises with it, and `deploy-uat.yml` consumes the same secret for the smoke step, so deleting the branch would not retire the credential. Whether the cron routes should stop accepting it at all is an open decision, not an oversight | `src/lib/cron-auth.ts`, `src/app/api/health/route.ts`, `.github/workflows/deploy-uat.yml` | NOS-65 |

The full list of pre-production gaps is in `docs/production-readiness.md` §4.

## Reporting
Suspected vulnerabilities go through private vulnerability reporting (`SECURITY.md`), never a public issue or pull request description.
