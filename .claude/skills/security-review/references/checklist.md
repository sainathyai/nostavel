# Security review checklist

For each changed entry point or sensitive code path.

## Authorization
- [ ] Who may perform this is decided in server code before anything changes.
- [ ] Booking actions check ownership: the member's user ID matches, or a signed guest token or cookie proves access.
- [ ] No ID, tier, price or role taken from the browser is trusted without a server-side check.

## Input
- [ ] Input shape is validated at the boundary (types, lengths, formats, allowed values).
- [ ] No input reaches a query, a URL or HTML without the library's escaping or parameterisation.

## Secrets and data exposure
- [ ] Secrets come only from the environment; none are hard-coded, logged, returned or passed as props.
- [ ] Modules holding secrets, supplier responses or net pricing import `server-only`.
- [ ] Error responses give guests a safe message; supplier and database details stay in server logs.
- [ ] Personal data (names, emails, phone numbers) isn't logged or sent anywhere new.
- [ ] No margin or net price reaches the client (conventions §2, §3).

## Abuse and availability
- [ ] Rate-limited if it calls the supplier, sends email, checks a code, or is expensive.
- [ ] The limit key can't be trivially spoofed, or the known gap is acknowledged.
- [ ] Retries and duplicates are safe (idempotency keys, dedupe on external IDs).

## Webhooks and cron
- [ ] Shared secret verified with `verifySharedSecret` (constant time) before any work.
- [ ] Event stored and deduplicated before processing, and processing is idempotent.
- [ ] Cron routes require the bearer secret.

## Money and bookings
- [ ] Amounts are integer minor units; the charge is decided server-side from supplier data.
- [ ] Status transitions are guarded against races (compare-and-swap, or a single writer).
- [ ] Status and its `booking_events` entry are written in one `db.batch`; no ledger updates or deletes.
- [ ] Both the money-losing and the guest-harming direction are tested.

## Platform
- [ ] Changes to headers, the CSP, cookies (httpOnly, secure, sameSite) or auth configuration are deliberate and explained.
- [ ] New dependencies are necessary, maintained, and don't bring known advisories.
- [ ] CI and workflow changes don't expose secrets to pull requests from forks.
