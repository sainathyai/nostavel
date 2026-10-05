# NOS-10 spike: when does the guest's money move, and what can we learn afterwards?

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

**This is a second defect, in the opposite direction from NOS-5.** Between minute 15 and
minute 30 our row still says `prebooked` and the checkout page still works, while the
supplier's hold is already gone. A guest who pays in that window is charged against a
dead prebook and `book()` then fails. NOS-5 is "we expire too eagerly"; this is "we keep
the door open after the room is gone".

### 4. An unfinalized charge is a hold, and it releases itself

LiteAPI: "In the case of a lost booking, the payment hold will stay for 1-2 business days
before being released when the booking is not finalized."

So the money is authorized, not captured, and an unbooked charge reverses on its own.
That settles the recovery path: **alert and leave the row alone** (decision D-4.2 A) is
right, and we do not need a refund API we could not find anyway. What we must not do is
mark such a row `expired` and forget it, because the guest's statement shows a pending
charge they cannot explain.

## Open

### Does `book()` verify the charge?

Unresolved. The attempt returned **HTTP 429, rate limited** — which says nothing about
payment. The first version of this probe reported that as "refused, so `book()` verifies
the charge", which was wrong, and the script now distinguishes "the supplier refused" from
"the supplier did not answer".

Re-run `npx tsx analysis/2026-10-03/probe-payment-timing.mts --book` after the limit
resets. It matters because if `book()` refuses an unpaid transaction, then attempting the
booking *is* the payment check, and the sweeper's recovery step can simply try it.

## What this changes in Segment 4

| Plan as written | After the spike |
|---|---|
| The sweeper will not expire a row that has a `transactionId` | Useless: every `prebooked` row has one from the start. The server needs a signal of its own |
| TTL stays 30 minutes | 30 minutes is wrong twice over. The sweeper's cutoff and the checkout page's own expiry need to agree with the supplier's 15 |
| A charged-but-unbooked row may need refunding | The hold releases itself in 1-2 business days. Alert, record, never silently expire |
| Payment state is the supplier's to tell us | We own it: the client tells the server before it charges, and that transition is the only thing standing between a guest and an unexplained charge. It has to be hard to lose |
