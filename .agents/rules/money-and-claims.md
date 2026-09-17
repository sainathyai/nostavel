---
name: money-and-claims
description: Pricing, fees, cancellation terms and anything a guest could act on. Read before touching prices, savings, deadlines or checkout.
globs:
  - "src/lib/{pricing,fees,member-pricing,cancellation,booking-service,booking-format,quote-token}.ts"
  - "src/app/book/**"
  - "src/app/stay/**"
---

# Money and guest claims

Source of truth: `docs/conventions.md` §3 and §4. A mistake here costs money or misleads a guest, so the bar is higher than anywhere else in the repo.

## Money (§3)
- **Storage:** integer minor units plus an explicit currency (`*Minor` fields). Never floats.
- **Converting supplier prices:** supplier prices are floats. Convert once, at the edge, with an explicit rounding choice.
- **Never compare across bases.**
  - A nightly rate is not a trip total.
  - A price with fees is not a price without them. If a fee is on one side of a comparison, it goes on the other side too.
  - The checkout once struck a public rate through against our rate and printed a total underneath. It read as one price split between two payees.
- **Savings need sourced evidence.** `compareAtPrice` returns null when there is none, and null means show nothing. Never derive a saving from supplier net. That is our margin, not the guest's discount.
- **Round in the guest's favour.** `displayPrice` rounds up, so the charge is never above the number shown.
- **Margins** (`MEMBER_MARGIN_PCT`, `PUBLIC_MARGIN_PCT`) are business decisions. Change them only with an explicit decision recorded in the ticket or an ADR.

## Price integrity
- **Tier binding:** the tier a guest was quoted is bound by a signed quote token (`lib/quote-token.ts`, HMAC with a 30-minute TTL). `quoteMatchesSession` rejects both a member price used by a signed-out visitor and a public price used by a member. Keep both directions.
- **Charge amount:** what the guest pays is decided on the server from the prebook response, never from a value the browser sent.

## Claims to a guest (§4)
Anything on screen a guest could act on (a deadline, saving, fee or inclusion) needs a source in the API response or a measurement in `analysis/`. If neither exists, don't show it.
- **Cancellation deadlines** are in the property's local time, derived from its latitude and longitude. LiteAPI states them in GMT, and a GMT date was once a day late for Austin.
- **"Breakfast included"** passes the measured price-gap gate. It's never inferred.
- **Estimates say so:** "estimated from straight-line distance".

## Tests for this area
- Test the direction that loses money **and** the direction that harms the guest.
- Fixtures never invent prices. If the real value would be null, the fixture uses null (a fixture's invented `themMinor` once showed up on checkout as a fake public rate).
- Assert exact integer amounts, including at rounding boundaries.

## Hand-off
Changes here should be flagged "money / guest claim" in the pull request, so review looks at them specifically.
