# Cars and flights: initial assessment

Written 2026-08-23. **Not a commitment, and nothing here is built.** Parked
deliberately so the hotel product can be finished first. Revisit only after
`docs/production-readiness.md` is closed out.

---

## 1. The licensing question, answered

**LiteAPI already sells flights.** Their site advertises 600+ airlines with
real-time search across GDS, NDC and low-cost carriers, presented as live rather
than announced. Their public reference docs still only document hotels, and their
`llms.txt` index confirms flight webhook events exist (`flight.prebook`,
`flight.book.confirmed`, `flight.book.cancelled`, and so on), so the capability
is real but likely gated by contract tier.

**Action: ask our account contact whether flights are on our tier.** That single
answer decides whether flights are one more adapter or a different company.

### Accreditation is not the binding constraint

You avoid IATA/ARC accreditation by selling through a partner who is both
merchant of record and ticketing agent. Duffel states this explicitly ("piggyback
on our accreditations and airline agreements"). LiteAPI is already merchant of
record for our hotel bookings, so flights through them would almost certainly
work the same way, on the same contract.

What *does* bind us, regardless of who tickets, is **US DOT seller obligation**:

- full-fare advertising, taxes and fees in the first price shown
- the 24-hour free cancellation / hold rule
- baggage fee disclosure
- code-share disclosure
- automatic refunds on cancelled or significantly changed flights

The last one is the expensive one. It means detecting a schedule change and
issuing a refund *without the passenger chasing us*. That is a process, not a
page. Put it to a travel-regulatory advisor alongside the commission-taxability
question already open for SYRAV, rather than deciding from a blog post.

## 2. What our codebase would carry over

Measured 2026-08-23 across `src/lib`, 4,304 lines excluding tests:

| | lines | share |
|---|---:|---:|
| Drop-in generic: quote token, search history, guest verify, rate limit, email, ledger reads | 928 | 22% |
| Booking spine (`booking-service.ts`), shape reuses | 518 | 12% |
| Same shape, different rules: pricing, cancellation, fees | 667 | 16% |
| Hotel-specific, needs a sibling | 2,191 | **51%** |

The hotel-specific half is mostly `liteapi.ts` at 1,703 lines, and that is the
honest shape of the work: **a vertical is a supplier adapter plus a set of domain
rules, on a spine that already exists.** Everything built in the tier/security
work generalises for free. The quote token does not care what is being priced.

## 3. Cars

Low liability on **pay-at-counter**, and the booking state machine really is the
one we already have: quote, hold, confirm, cancel. We never touch the money, and
the deposit authorisation is between the renter and the rental company.

Two corrections to the "cars are easy" instinct:

**The cash flow is worse than hotels.** LiteAPI pays us commission after checkout
on a charge that already happened. Pay-at-counter car commission is paid after
the rental *completes*, and a no-show earns nothing. We would be carrying a
receivable on an event that might not occur, on a booking we were not paid to
make. Prepaid cars pay better and sooner but hand us the refund liability, which
is the thing the pay-at-counter model was chosen to avoid.

**Cars are more fee-complex than hotels, not less.** Young driver surcharge,
one-way fee, airport concession recovery, CDW/LDW/SLI, fuel policy, additional
driver, mileage caps, cross-border restrictions. `fees.ts` exists because hotels
had two awkward cases; cars would need considerably more of that machinery, and
the disclosure burden falls on whoever displays the price.

## 4. Flights

The cost is operational, not code. A hotel booking is fire-and-forget: once
confirmed, nothing happens until the guest arrives. **A flight booking has to be
watched from sale to departure** — schedule changes, cancellations, equipment
swaps, involuntary reissue, irregular operations — plus ticketing time limits,
fare rules far harder than a two-rung cancellation ladder, and a void window.

That is a support function with an on-call component. The code is the small part:
our booking status enum is hotel-shaped (`draft → prebooked → payment_pending →
confirmed`) and would need at minimum a `ticketed` state and a reissue path.

## 5. Recommendation

**Cars first, and not as a vertical.** Build it as an *attach* on the existing
stay flow: we already know the city, the dates and the guest. Offer a car on the
confirmation page and in the trip view. That reuses the whole spine, gives a
conversion surface we do not have to buy traffic for, and fits the concierge
positioning better than a second search box.

**Flights only through LiteAPI, and only after cars.** Same contract and same
merchant of record means one more adapter. A separate partner with separate
obligations means a different company, not a feature.

**One structural piece first, regardless.** `booking-service.ts` is hotel-shaped
in its snapshot types and its status enum. Generalising it to
`product: "stay" | "car" | "flight"` is a day of work now and a painful migration
later.

Rough sizing, assuming the supplier question resolves cleanly: **cars, three to
four weeks** to a working attach flow. **Flights, months, plus a permanent
operational obligation.**

## 6. Open questions before either starts

1. Does LiteAPI's flights product exist on our contract tier?
2. Are we willing to carry post-rental receivables on cars, or do we want prepaid
   and the refund liability that comes with it?
3. Who answers the phone when a flight is cancelled at 6am?

## Sources

- <https://www.liteapi.travel/>
- <https://docs.liteapi.travel/llms.txt>
- <https://duffel.com/already-selling-flights>
- <https://duffel.com/blog/benefits-of-using-duffel-content-services-duffels-accredited-agency-network>
- <https://track360.io/blog/car-rental-transfer-affiliate-programs-operator-guide-2026>
