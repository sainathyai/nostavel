# Spike NOS-45: when does the guest's money move, and what can we learn afterwards?

- **Ticket:** [NOS-45](https://syrav.atlassian.net/browse/NOS-45)
- **Date:** 2026-10-03
- **Why:** the NOS-5 fix (sweeper expiring a hold mid-payment) and the NOS-6 fix
  (two concurrent `book()` calls) both need to know what the supplier actually does with
  a charge. Designing the recovery path on an assumption is how a guest ends up charged
  with no booking.
- **How:** `analysis/2026-10-03/probe-payment-timing.mts` against the **sandbox** key
  (the script refuses to run without the `sand_` prefix), plus LiteAPI's own
  documentation. Raw responses are in that folder's `raw/`, which git ignores
  (conventions §8).

## Established

### 1. `transactionId` exists before any money moves

`POST /rates/prebook` with `usePaymentSdk: true` returns **both** `transactionId` and
`secretKey` in the same response, before the guest has seen a card form. LiteAPI's docs
say the same: "Each call to prebook generates a new transactionId and prebookId."

**This invalidates an assumption in our code.** `confirmBooking`
(`src/lib/booking-service.ts`) refuses to book when `row.transactionId` is null, and its
comment reads "No guest charge, no booking". That check does not prove a charge: the id
is minted at prebook. The same mistaken reading is in `src/lib/liteapi.ts`'s `book()`
comment. Neither is a security hole — refusing *without* an id is still correct — but
anything built on "has a transactionId, so the guest paid" would be wrong, and the
sweeper fix was going to be built on exactly that.

### 2. There is no transaction-status, refund or void route at the obvious shapes

Probed `GET /payments/{id}`, `GET /transactions/{id}`, `GET /rates/prebook/{id}`,
`POST /payments/{id}/refund`, `POST /payments/{id}/void`.

**Careful with the signal:** this gateway answers an unknown route with **HTTP 200 and an
empty body**, not a 404. All five came back 200-with-nothing, which means "no such route",
not "route exists". A probe that reads only status codes would have concluded the
opposite — the first version of this probe did.

So the server cannot ask the supplier whether a transaction was paid, at least not
through these shapes.

### 3. The prebook hold is 15 minutes; our sweeper uses 30

LiteAPI documents a 15-minute TTL on the prebook state. `PREBOOK_TTL_MINUTES = 30` in
`src/app/api/cron/sweep/route.ts`.

**This is a second defect, in the opposite direction from NOS-5, filed as NOS-46.** Between minute 15 and
minute 30 our row still says `prebooked` and the checkout page still works, while the
supplier's hold is already gone. A guest who pays in that window is charged against a
dead prebook and `book()` then fails. NOS-5 is "we expire too eagerly"; this is "we keep
the door open after the room is gone".

Writing the ticket turned up something worse than the wrong number. The sweeper's cutoff is
measured against `bookings.updatedAt`, and `saveBookingGuest` writes `updatedAt` on a row
that is still `prebooked` - so a guest who fills in their details at minute 14 pushes our
cutoff to minute 44 while the supplier's hold died at minute 15. The window we enforce is
"30 minutes since the last write", not 30 minutes since the prebook. Changing 30 to 15 alone
would not fix it. There is also no expiry field anywhere in the prebook response
(all 24 keys are in this folder's raw capture), so the value has to live in our code with
its source attached. NOS-46 carries all three.

### 4. An unfinalized charge is a hold, and it releases itself

LiteAPI: "In the case of a lost booking, the payment hold will stay for 1-2 business days
before being released when the booking is not finalized."

So the money is authorized, not captured, and an unbooked charge reverses on its own.
That settles the recovery path: **alert and leave the row alone** (decision D-4.2 A) is
right, and we do not need a refund API we could not find anyway. What we must not do is
mark such a row `expired` and forget it, because the guest's statement shows a pending
charge they cannot explain.

## Settled 2026-10-06: `book()` does verify the charge

`book()` against a prebook whose transaction nobody paid returns:

```
HTTP 400
code 2014   description "payment not completed"   message "booking incomplete"
```

Probe: `analysis/2026-10-06/probe-book-idempotency.mts`. The 2026-10-03 attempt could not
tell, for two reasons: it was rate limited (429), and it tried only the first offer, which
sandbox inventory refuses with "no prebook availability" (code 2001). The new probe walks
offers until one holds.

**This is the most useful thing the spike produced.** The sections above establish that the
server has no way to ask whether a guest was charged — no transaction-status route, and
(checked 2026-10-06 against LiteAPI's webhook event list: 22 events, all booking and flight
lifecycle) **no payment webhook of any kind**. So the server appeared to have no
authoritative source at all.

It has one: **attempting the booking is the payment check.** A row that may or may not have
been charged is resolved by trying to book it — it books if the guest paid, and answers 2014
if they did not. That is what the sweeper now does (NOS-5), and it is why decision D-4.2
("alert a person and leave the row alone") became D-4.12 ("find out first, alert only if you
cannot"). Bounded by the hold window: past 15 minutes the call fails for a different reason
and a person has to look.

Only an explicit 2014 may release a room. A timeout, a 429 or an empty body is not evidence
of non-payment — the first version of this probe made that class of error twice, and the
sweeper's tests now assert against it directly.

## Open

### What does a second identical `book()` do once payment HAS completed?

Unresolved, and not resolvable from a script: it needs a real card payment, which the probe
cannot make. One booking returned twice and two rooms reserved are very different problems.
NOS-6's claim step is built as though the worse answer were true.

## What this changes in Segment 4

| Plan as written | After the spike |
|---|---|
| The sweeper will not expire a row that has a `transactionId` | Useless: every `prebooked` row has one from the start. The server needs a signal of its own |
| TTL stays 30 minutes | 30 minutes is wrong twice over. The sweeper's cutoff and the checkout page's own expiry need to agree with the supplier's 15 |
| A charged-but-unbooked row may need refunding | The hold releases itself in 1-2 business days. Alert, record, never silently expire |
| Payment state is the supplier's to tell us | We own it: the client tells the server before it charges, and that transition is the only thing standing between a guest and an unexplained charge. It has to be hard to lose |
