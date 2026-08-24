# Functional testing strategy

Written 2026-08-24. Covers manual/exploratory testing of the live app, not
`npm test` (111 unit tests already cover pricing, cancellation, quote tokens,
search history — see `docs/conventions.md` section 6). This is what a human
needs to click through before trusting the app with a real guest.

---

## 1. Search → results

- [ ] US city, curated destination (e.g. `austin`), and international city
      each return results
- [ ] Unknown destination text fails gracefully, not a 500
- [ ] Date in the past is rejected or clamped, not silently accepted
- [ ] Nights = 1 and nights = 30 (the clamp boundaries) both work
- [ ] Zero-result destination shows an empty state, not a blank page
- [ ] Category filters (budget/comfort/luxury/convenience) narrow correctly
- [ ] Every sort order (price low/high, savings, recommended) actually reorders
- [ ] "Show more" reveals the next page and resets correctly when filter/sort
      changes mid-scroll
- [ ] Fees toggle changes both the displayed price AND the sort order

## 2. Map

- [ ] Pins load, priced correctly for signed-out vs signed-in
- [ ] Pan/zoom arms "Search this area"; clicking it re-queries and un-arms
- [ ] Zooming out past ~100 km still returns something, with the
      "near the centre" note
- [ ] Theme toggle cross-fades the map colors, does not flash-white
- [ ] Basemap failure (kill network) shows the fallback message, not a blank
      rectangle

## 3. Hotel detail

- [ ] Loads for a hotel with only 1 rate plan and one with 50+
- [ ] Refundable/non-refundable rows: confirm a >$20 premium shows both, a
      <$20 premium shows only the refundable row (2026-08-24 change)
- [ ] Cancellation deadline shows property-local time with correct zone
      abbreviation, not GMT
- [ ] Nearby POIs render, grouped, with plausible walk times
- [ ] Photo gallery swipes/arrows work
- [ ] "No availability" only appears after genuinely retrying — pick a hotel
      known to flake (Chicken Ranch, `lp657d352a`) and refresh 10+ times

## 4. Sign-in / member pricing

- [ ] Signed-out visitor sees public price, no member banner
- [ ] Signed-in member sees the lower price and the member banner
- [ ] **Sign out mid-session on a stay page, refresh** — price must
      re-quote at public tier, never keep showing the member number
- [ ] Open the same stay in two tabs, one signed in one not — verify each
      tab shows its own tier (quote token isolation)

## 5. Checkout

- [ ] Guest details form validates required fields before Continue
- [ ] Payment form actually renders (this broke once — StrictMode/effect bug)
- [ ] Sandbox card `4242 4242 4242 4242` completes a booking
- [ ] A declined test card shows a real error, not a silent failure
- [ ] **Sign out during checkout** — booking must be abandoned and the guest
      redirected, not charged at a stale price
- [ ] Confirmation page shows the right reference, dates, price breakdown
- [ ] **Confirmation email actually arrives** — currently broken for anyone but
      the account owner (Resend domain unverified). This is the one to check
      first; everything downstream of it is moot until it's fixed.
- [ ] Refresh the checkout page mid-flow — does not double-charge or duplicate
      the booking (idempotency key)

## 6. Trips / account

- [ ] `/trips` lists a completed booking with correct status
- [ ] Search history shows recent searches for a signed-in guest, nothing for
      a signed-out one

## 7. Cross-cutting

- [ ] Every page above in both light and dark theme
- [ ] Mobile viewport (not just resized desktop — a real phone or device
      emulation) for search, detail, and checkout
- [ ] Slow network (throttle to 3G) — does anything render broken instead of
      loading, especially the map and payment form
- [ ] Back button after booking doesn't allow re-submitting payment

## What this list does NOT cover

Everything in `docs/production-readiness.md` that isn't built yet has no
test here because there's nothing to test: cancellation, refunds, admin,
webhooks, reconciliation. Add sections here as those ship.
