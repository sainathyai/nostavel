# Production readiness: what is missing before real guests and real money

Written 2026-08-23 from an audit of this repo plus LiteAPI's own documentation.
**Nothing here is built yet.** This is the gap list and the order to close it in.

The honest summary: the *booking* path is in good shape. What is missing is
everything that happens **after** a booking, everything an operator needs to see,
and the hardening that turns a demo into a system that can take a stranger's
money.

---

## 0. What already exists (do not rebuild)

The audit turned up several things that are half-present, which changes the cost
of the work considerably.

**Tables that exist in `src/db/schema.ts` and are completely unused:**

| table | purpose it was reserved for |
|---|---|
| `cancellations` | booking id, LiteAPI cancellation id, refund amount, status |
| `webhook_events` | raw inbound callbacks, deduped on `external_id` |
| `saved_hotels` | favourites |

`search_history` was in the same state until 2026-08-22 and took about an hour to
wire up once found. Check this list before designing anything new.

**LiteAPI already provides far more than we use.** From `docs.liteapi.travel/llms.txt`:

- `PUT /bookings/{id}` — cancel a confirmed booking
- `GET /bookings`, `GET /bookings/{id}`, `POST /bookings/search`
- **Vouchers**: full CRUD, usage limits, minimum spend, max discount, validity
  window, plus `GET /vouchers/history` for redemptions
- **Loyalty**: guest enrolment, points balance, redeem points to vouchers
- **Analytics**: `POST /analytics/report`, `/analytics/weekly`, `/analytics/markets`,
  `/analytics/hotels`, `POST /commissions/report`, per-hotel sales/profit reports
- **Webhooks** for the whole booking lifecycle

**Already built and sound:** append-only `booking_events` audit trail, an
idempotency key on every booking, the signed quote token, the checkout identity
guard, 111 tests, and the two-tier margin.

---

## 1. Correctness bugs found during this audit

Fix these first. They are small, and two of them are things we currently tell
guests that are not true.

### 1.1 Our non-refundable copy is wrong

The checkout page says *"This rate cannot be refunded or changed once booked."*
LiteAPI's own documentation says the `NRFN` tag applies if **ANY** portion of the
booking is not refunded, and that "`NRFN` bookings still may refund most of the
cost". A guest reading our sentence would not cancel a booking that would in fact
have refunded them most of their money.

**Fix:** render from `cancelPolicyInfos` in all cases, not from the tag. The
ladder already handles this; the tag branch is the one that lies.

### 1.2 Legacy ledger rows

Measured 2026-08-23, `analysis/2026-08-23/ledger_rows.mts`. 27 rows total, and
they fall into three eras:

| era | rows | `amount_supplier_minor` | note |
|---|---:|---|---|
| `LNTRN-*`, 2026-08-03 to 08-05 | 16 | **NULL** | written before we recorded supplier net at all |
| `NSTVL-*`, 2026-08-12 onward | 8 | populated, 4.8%–16.7% | the real ledger |
| `FIX*` | 3 | populated | prebook fixtures, not guest bookings |

Plus one `failed` row with `amount_total_minor = 0`.

**Why this matters, in one sentence:** commission is `total - supplier_net`, and
for 16 rows the net is unknown. Any report that writes `total - (net ?? 0)` will
book **$972.29 of pure profit that never existed** from the two confirmed legacy
rows alone (`LNTRN-795BNM` $601.26 and `LNTRN-YPES66` $371.03), and the three
`FIX*` rows would count as revenue on top of that.

**Decision (2026-08-23): exclude, do not annotate, and do it in the query not the
data.** The ledger is append-only and must not be rewritten (conventions §8), so
reports select `where amount_supplier_minor is not null and human_ref not like
'FIX%'`. That rule belongs in **one** place — the reporting store — never copied
into each view. The rows stay exactly as they are; only the reports skip them.

### 1.3 The basemap is still on a third party's daily build

Covered in the map discussion: Protomaps deletes builds after ~5 days, and the
runtime date-walk is a patch. Sprites and glyphs are a second, undefended
dependency. ~$2/month on R2 to own all three.

---

## 2. Booking lifecycle: the missing half

### 2.1 Cancellation (nothing exists)

There is no cancellation flow at all. `PUT /bookings/{id}` is never called, the
`cancellations` table is never written, and a guest on `/trips` has no way to
cancel. Support would have to do it by hand in LiteAPI's dashboard, leaving our
ledger permanently wrong.

Needed:
- guest-initiated cancel from `/trips`, gated on the policy ladder we already
  compute, showing the exact penalty **before** confirming
- write `cancellations` + a `booking.cancel.requested` / `.confirmed` event
- handle the partial-refund case honestly (see 1.1)
- an operator-initiated cancel path with a reason, from the admin dashboard

### 2.2 Automatic cancellation (the sweeper)

Two distinct jobs, often conflated:

**Abandoned holds.** A prebook holds a rate and holds a `payment_secret`. Rows
sit at `prebooked` forever today; the `expired` status exists but nothing sets it
except the identity guard. A sweeper should expire prebooks past their TTL and
drop the payment secret.

**Failed-payment cleanup.** A `payment_pending` row whose Stripe intent never
succeeded needs releasing rather than lingering as a phantom reservation.

Both are cron jobs with an advisory lock so two instances cannot double-run.

### 2.3 Webhooks (table exists, receiver does not)

LiteAPI sends `booking.book`, `booking.cancel`, `booking.refund`,
`booking.amendment`, `booking.checkinInstruction`,
`booking.book.hotelConfirmationNumber`, plus `*_error` variants. Delivery is
**at-least-once with exponential backoff**, so the receiver must be idempotent —
which is exactly why `webhook_events.external_id` is unique.

Authentication is a **shared secret sent as the `authorization` header**. There
is no signature scheme and no documented IP allowlist, so the secret is the whole
control: it must be a high-entropy value in env, compared in constant time, and
the endpoint must return 2xx only after the event is durably stored.

This is the single highest-value missing piece. Without it we only learn about a
supplier-side cancellation or an amendment if someone happens to look.

### 2.4 Reconciliation

Even with webhooks, state drifts. A nightly job should walk `GET /bookings`,
compare against our ledger, and write a `reconcile.mismatch` event rather than
silently correcting. `POST /commissions/report` gives the money side, which is
what actually needs to tie out against payouts.

---

## 3. Support operations

### 3.1 Coupons — DECIDED 2026-08-23: margin reduction, percentage only

**Settled:** coupons are a margin reduction. LiteAPI vouchers are **not** enabled,
now or later, because they require an account credit card LiteAPI can charge.
Coupons and credits are issued to **signed-in users only** — an anonymous visitor
has no identity to scope a code to, and a code that anyone can paste is a code
that ends up on a deals forum.

**Percentage only in v1.** Fixed-amount coupons ("$25 off") are deferred, and the
reason is structural rather than effort:

1. **We do not control the final price, we control the margin.** A percentage is
   applied to the same base LiteAPI is already computing from. A fixed amount has
   to be solved backwards: `margin_new = (charge_old - 25) / net - 1`. That is
   arithmetic on a number that has not settled yet.
2. **The price moves between search and prebook.** `price_changed` and
   `price_diff_pct` exist on `bookings` precisely because it does. A percentage
   stays correct when the supplier reprices; a solved-backwards fixed amount is
   wrong by whatever the drift was, and the guest sees "$25 off" and gets $23.40.
3. **A fixed amount can exceed the whole margin.** $25 off a $180 booking at 15%
   margin is more than the margin exists to give. That needs a partial-apply rule
   ("we gave you $16 of the $25"), which is a worse guest experience than a
   percentage that simply clamps at `MIN_MARGIN_PCT`.
4. **Currency.** Supplier net can be non-USD. A fixed amount needs an FX rate at
   apply time; a percentage needs nothing.
5. **Rounding direction.** `displayPrice` ceilings in the guest's favour, so an
   exact fixed amount would frequently render a cent off its own promise.

Revisit fixed amounts only if a real campaign needs them, and if so, apply them at
prebook against the *repriced* number rather than at search.

#### Background: why LiteAPI's vouchers were rejected

LiteAPI vouchers are applied at prebook with a `voucherCode` field and look ideal.
**But their own guide says: "for a $100 booking, the customer's card will be
charged $80 while the attached account credit card will cover the other $20."**

That requires an account credit card on file that LiteAPI can charge — the
mechanism deliberately excluded ("we don't want way 2 or any part of it at all").
It is *narrower* than way 2 (only the discount we chose to fund, not a stranger's
whole stay) but it is the same mechanism, so it is out.

**How margin reduction works instead.** We already control `margin` per request,
decided server-side, after the session is known. A coupon becomes a smaller
margin on the priced call: LiteAPI charges the guest less directly, no card of
ours is involved, and the cost comes out of our commission automatically.

Constraint worth stating plainly: **the discount ceiling is our margin.** With
`MIN_MARGIN_PCT = 5`, a member booking at 15% margin can absorb roughly 9% off
the charged price; a public-tier booking at 40% margin has far more room. Deep
discounts on thin-margin hotels are impossible by construction, which is arguably
the right behaviour — but it means **the coupon UI must show the discount it
actually applied, computed server-side, never the coupon's nominal value.** A
"10% off" code that only had room for 8% has to say 8%.

We need our own `coupons` table (code, percent, min spend, usage limit, per-user
limit, validity window, status) and a `coupon_redemptions` table. Notes for
whoever builds it:

- **No `type` column in v1.** One kind of coupon, percent off. Adding an enum
  before a second kind exists invites half-implemented branches.
- `percent` is the *requested* discount; store the **applied** percent and the
  resulting margin on the redemption row, because they differ whenever the
  ceiling bites. That row is the audit trail for "why did this booking earn less".
- The redemption must be written in the same transaction that prebooks, and the
  per-user limit checked there, or a guest with two tabs redeems twice.
- **A coupon changes the margin, so it changes the price, so it must be inside
  the quote token.** The token currently signs `{t: tier, e: exp}`; it needs the
  coupon code too, or a guest can apply a code in one tab, remove it in another,
  and pay the discounted price without the redemption being recorded.

### 3.2 Refunds and credits

Distinct things, and worth separating:

- **Refund** — money returned on the original charge. LiteAPI is merchant of
  record, so a refund is theirs to issue via cancellation. We need to *record*
  it, not perform it.
- **Goodwill credit** — money we give that is not tied to a charge.
  **DECIDED 2026-08-23: user-scoped coupons only. There is no payout path.**
  Since we never hold the guest's money, a payout would mean originating a
  transfer to a stranger's bank details, which is a money-transmission surface we
  are not equipped for and is the same instinct behind excluding way 2.

  A goodwill credit is therefore a `coupons` row with `user_id` set and
  `usage_limit = 1`. Same table, same apply path, same ceiling. Percentage only,
  same as every other coupon (see 3.1). Consequences to accept up front, and to
  say plainly in the support copy:

  - it is **only redeemable on a future booking**, so it is worth nothing to a
    guest who never returns
  - a user-scoped coupon requires an account, which is already our position:
    codes and credits are for signed-in users only
  - the percentage is capped by our margin on whatever they book next, so the
    admin issuing it cannot promise a dollar figure

  If a genuine make-good ever exceeds what a percentage can carry, that is a
  human decision made outside the product, not a feature.

### 3.3 Admin dashboard

**The brief, in the operator's words: where am I losing money, and where and how
much am I gaining.** That is a reporting product first and a support console
second, which reverses the usual build order — the money view is what makes the
thing worth opening daily, and the booking actions are what you reach for on the
few days something breaks.

#### The money question, answered with the data we already have

Every number below is derivable from `bookings` + `booking_events` today. None of
it needs a new supplier call.

**Where the money comes from.** For each confirmed booking: `amount_total_minor`
is what the guest paid, `amount_supplier_minor` is what it cost, the difference
is ours. Cut that four ways and the picture is complete:

| cut | the question it answers |
|---|---|
| by **tier** (member vs public) | is the 15% member rate buying us bookings, or just giving away 10 points of margin to people who would have booked anyway? |
| by **hotel and by city** | which properties actually pay, and which we are selling for nothing |
| by **realised margin %** | the ledger already spans 4.8% to 16.7%; the thin end is where a coupon would take us below zero |
| by **coupon** | discount given vs commission retained, per code |

**Where the money leaks.** This is the half a bookings list will not show you,
and it is the half that was asked for:

- **Abandoned holds.** 20 of 27 rows sit at `prebooked` and never confirmed.
  Every one of those was a real supplier call. That is the funnel's biggest hole
  and today nothing measures it.
- **Failed books after a successful payment intent** — the expensive failure,
  because the guest is charged-adjacent and has nothing.
- **Cancellations, split into "before any penalty" (costs us only the
  commission) and "after" (the guest loses money and will contact support).**
- **Rows where the margin came out under `MIN_MARGIN_PCT`,** or where
  `price_changed` was true and we absorbed the drift.
- **Legacy and fixture rows excluded** — show the excluded count somewhere
  visible, so a number that looks low is explained rather than mysterious (1.2).

**Cross-check, do not trust ourselves.** `POST /commissions/report` is LiteAPI's
version of the same money. Show ours, show theirs, show the delta. A non-zero
delta is the reconciliation alarm, and it is the only number on the page that
should ever be red for a reason other than business performance.

#### The support console, second

- **Bookings list** with status, guest, hotel, dates, amount, commission; filter
  and free-text search
- **One booking view**: the full `booking_events` timeline, the snapshots, the
  policy ladder, the payment record
- **Actions**: cancel (with penalty preview), issue a user coupon, add a note,
  re-send the confirmation email, force a reconcile
- **Health**: failed prebooks, failed books, webhook failures, unreconciled rows

#### Access model — RECOMMENDED: a `role` on `users`, same app, guarded segment

The question was open; this is the recommendation, and it is reversible.

A `role` column on `users` (`'guest' | 'admin'`), a route segment at
`/admin` with its own layout, and the check enforced in **`middleware.ts` and
again in every server action**. Not the component alone — a component check
protects the page, not the mutation behind it.

Why not a separate app: it would need its own deploy, its own session handling,
and its own copy of every type in `booking-service.ts`, to defend against a threat
model of exactly one operator. If the day comes when non-technical support staff
need access, the segment splits out then, and the `role` column is already the
thing that would gate it.

Non-negotiable regardless of model:

- every mutation writes a `booking_events` row with `actor` set to the admin's id.
  The `actor` column already exists for this.
- **no destructive delete, ever.** The ledger is the reconciliation record.
- the admin session should be short-lived, and admin routes must be `noindex`
  and excluded from any error reporting that captures request bodies.

---

## 4. Security gaps

| gap | current state | why it matters |
|---|---|---|
| **Security headers** | `next.config.ts` sets only `images` | no CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`, or `Permissions-Policy`. Clickjacking and injection have no second line of defence. |
| **No `middleware.ts`** | absent | nowhere to enforce admin auth, add headers, or block abuse centrally |
| **Rate limiting** | in-memory, per instance; only on `find` and `interpret-query` | its own comment says "swap before any real public traffic". **Not applied to booking actions at all.** |
| **`/api/stays-in-area`** | unauthenticated, hits LiteAPI on every call | a paid API behind an open GET. Direct cost-abuse vector. |
| **Input validation** | zod used only in `interpret-query` | `prepareBookingAction` takes a client-supplied snapshot object and passes it into the ledger largely unvalidated |
| **`AUTH_SECRET`** | signs sessions *and now quote tokens* | one secret, two jobs, no rotation story. Rotating it invalidates every live quote. |
| **PII retention** | only `search_history` has a stated life (180d) | guest names, emails, phones and billing addresses have none |
| **Privacy policy** | folded into `/terms` | needs to be its own document if we process EU or California residents' data |
| **Secrets in dev** | `.env.local` read directly by analysis scripts | fine now; needs a real secret manager before a second person has access |

Two more that are less obvious:

- **Error messages leak upstream detail.** Several catch blocks surface
  `(e as Error).message` straight to the client, which can include LiteAPI
  response fragments.
- **No bot defence on the booking path.** Prebook costs a real supplier call and
  holds real inventory. It should require at minimum a rate limit per IP and per
  session, and probably a challenge before too long.

---

## 5. Reliability and operations

- **No CI.** `npm test`, `tsc`, `lint` and `build` all pass locally and nothing
  enforces that. This is the cheapest high-value item on the list.
- **No error tracking.** A failed booking currently surfaces as a console line on
  whatever machine served it.
- **No structured logging.** No request id, so a guest's report cannot be traced
  to a request.
- **No health check** endpoint for uptime monitoring.
- **Email is not production-capable.** Resend returns 403 for any recipient other
  than the account owner until a sending domain is verified. **Every confirmation
  email to a real guest currently fails.**
- **Backups untested.** Neon has PITR; nobody has restored from it.
- **Detail page is ~8.7s.** Acceptable for a demo, not for conversion. The two
  sequential rates calls are the cost, and any caching fix **must key on
  `isMember`** or member pricing leaks to the public.

---

## 6. Suggested order

Sequenced by what unblocks the most, not by size.

**Phase 1 — stop being wrong (days)**
1. Fix the NRFN copy (1.1)
2. CI running the four checks
3. Verify a Resend sending domain so confirmations actually deliver
4. Security headers + `middleware.ts`
5. Rate-limit the booking actions and `/api/stays-in-area`

**Phase 2 — close the booking loop (1-2 weeks)**
6. Webhook receiver, secret-authenticated, idempotent on `external_id`
7. Guest-initiated cancellation with an honest penalty preview
8. The abandoned-hold sweeper
9. Nightly reconciliation writing mismatch events

**Phase 3 — make it operable (1-2 weeks)**
10. Admin role, guarded route segment (`middleware.ts` + per-action check)
11. **Money view first**: margin by tier / hotel / city, the leak list, and the
    `commissions/report` delta. This is the point of the dashboard (3.3).
12. Bookings list and booking detail with the full event timeline
13. Admin actions: cancel, note, resend confirmation, force reconcile

**Phase 4 — commercial tools (1 week)**
14. Own `coupons` + `coupon_redemptions`, percent-only, applied as margin
    reduction, signed-in users only, coupon code folded into the quote token
15. User-scoped goodwill credits — the same table with `user_id` set
16. Zod validation across every server action
17. PII retention policy and a standalone privacy document

**Deferred deliberately:** loyalty points, saved hotels, cars and flights
(`docs/verticals-cars-flights.md`), the Priceline-style checkout restructure.

---

## 7. Decisions — settled 2026-08-23

| # | decision | outcome |
|---|---|---|
| 1 | Coupons | **Margin reduction only.** LiteAPI vouchers never enabled — they need an account card they can charge. **Percentage only** in v1; fixed amounts deferred for the five structural reasons in 3.1. |
| 2 | Goodwill credits | **User-scoped coupons only. No payout path.** A credit is a `coupons` row with `user_id` set. |
| 3 | Who can hold one | **Signed-in users only**, for both codes and credits. No anonymous redemption. |
| 4 | Admin access | **Recommended and adopted unless overridden:** `role` on `users`, `/admin` segment in the same app, checked in `middleware.ts` *and* every action. Reversible (3.3). |
| 5 | Legacy ledger rows | **Exclude in the reporting query, never rewrite the data.** 16 NULL-net rows and 3 `FIX*` rows; the filter lives in one store (1.2). |

Still genuinely open, and none of it blocks Phase 1 or 2:

- Whether the member tier is earning its 10 points of margin. Unanswerable until
  the money view exists and has some weeks behind it.
- Whether to own the basemap tiles (~$2/month) or keep date-walking Protomaps.
- Error tracking vendor.

## Sources

- <https://docs.liteapi.travel/llms.txt>
- <https://docs.liteapi.travel/docs/using-liteapi-webhooks.md>
- <https://docs.liteapi.travel/docs/canceling-a-booking.md>
- <https://docs.liteapi.travel/docs/vouchers-api-guide.md>
