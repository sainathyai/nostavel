# 0008. Refunds are recorded separately from cancellations

- **Status:** accepted
- **Date:** 2026-10-15
- **Ticket:** NOS-8, with consequences for NOS-7 and NOS-16
- **Decided by:** the software-architect role, under the `migration` review gate
- **Number:** 0008 rather than 0007, which is reserved by the unmerged
  `segment-7-plan` branch. Taking 0007 here would collide when that lands.

## Context

Three tickets in epic NOS-2 were Ready at the same time, each individually
correct, and together they would have been wrong in a way that fails silently.

- **NOS-7**: both cancellation paths write the booking status, the `cancellations`
  row and the audit event as three unwrapped awaits, so a crash between them
  leaves a booking marked `cancelled` with no cancellation record. Wrap each in one
  `db.batch`. Gap G1.
- **NOS-16**: `cancellations` has no unique constraint on `bookingId`, so a guest
  cancel racing a supplier webhook cancel can insert two rows with different refund
  amounts. Add the constraint and `onConflictDoNothing`. Gap G5.
- **NOS-8**: the dispatcher routes both `booking.cancel` and `booking.refund` to
  `recordSupplierCancellation`, which sets `status: "cancelled"` unconditionally,
  so a partial or goodwill refund on a stay that is still going ahead marks the
  booking cancelled. Its acceptance criteria require that such a refund leaves the
  booking `confirmed` while **the refund amount is still recorded**. Gap G6.

NOS-7 and NOS-16 each name the other as out of scope. Neither mentions NOS-8.

### The conflict between them

`cancellations` was the only table with a `refundAmountMinor` column. So recording
a non-cancelling refund there would mean:

1. the refund-only row occupies the booking's single `cancellations` slot;
2. NOS-16's unique constraint on `bookingId` now binds;
3. a later genuine cancellation of that booking hits the constraint;
4. `onConflictDoNothing`, which NOS-16 recommends, silently drops it;
5. the booking ends up `cancelled`, with an audit event, and **no cancellation
   record** - exactly the harm NOS-7 exists to prevent.

`docs/production-readiness.md` §3.2 settled what a refund *is* ("LiteAPI is
merchant of record, so a refund is theirs to issue via cancellation. We need to
record it, not perform it") but never said in which table, so there was no prior
decision to follow.

## Decision

**Refunds get their own table.** `refunds`: `id`, `bookingId` (FK, cascade),
`supplierRefId` (nullable), `amountMinor`, `currency`, `supplierStatus`,
`occurredAt`, `createdAt`, with an index on `bookingId` and a unique index on
`(bookingId, supplierRefId)`.

`cancellations.refundAmountMinor` keeps its narrower meaning: money returned as
part of **that cancellation**. Anything returned outside a cancellation is a
`refunds` row.

**NOS-16's unique constraint on `cancellations.bookingId` stays the right shape**,
but only because refunds leave the table.

### Why the alternatives lose money, not tidiness

**A discriminator column on `cancellations` plus a partial unique index.** Every
reader of that table would then have to filter. `cancelBooking`'s idempotent
branch reads a single `cancellations` row with `.limit(1)` and returns its
`refundAmountMinor` **to the guest** as what they got back. A refund-only row there
returns a refund amount for a booking nobody cancelled, or picks the wrong row of
two. One forgotten filter is a wrong money figure on a guest's trip page.

**An upsert, where a real cancellation overwrites a refund-only row.** It deletes a
record of money that actually moved, and it makes one column mean two different
bases over time: a refund on a live stay versus a refund settled inside a
cancellation. That is the cross-basis prohibition in the money rule.

**Both** cap refunds at one per booking. Two partial refunds on one stay is a
normal supplier event; the second would be silently dropped, and the weekly payout
reconciliation would show a shortfall charged to the wrong booking.

### Routing is a rule, not a condition on the event name

The obvious reading of NOS-8 is "cancel means cancel, refund means refund", and it
is wrong. The supplier sends `booking.refund` with status `CANCELLED_WITH_CHARGES`
for a cancellation that kept some money, and there is an existing integration test
asserting that exact payload and expecting a cancellation.

So `webhookIntent({ eventName, supplierStatus })` in `src/lib/webhook-dispatch.ts`
returns `cancellation | refund | ignore`. **The supplier's reported status wins;
the event name is the fallback** for a payload that carries no status. A
`booking.cancel` whose payload says `CONFIRMED` is treated as a refund, because the
status is the field describing the booking and the event name only describes the
message.

The `booking_events` type is derived from that intent rather than hardcoded. The
old code wrote `webhook.booking.cancel` whichever event triggered it, so a refund
was mislabelled in the audit trail too, and the audit trail is what the reconciler
and a human both read.

## Consequences

**The cost, stated because it is real:** two tables now hold "money came back"
facts. Reconciliation against the supplier's payout must sum both, and any future
refund report that reads only `cancellations` undercounts. This is the thing most
likely to be got wrong later.

**The three tickets ship as three pull requests, in this order**, rather than as
one change. One change would carry two migrations behind a single owner approval,
and a rollback could not separate them.

1. **NOS-8** first: adds `refunds` (create table only), routes refund events away
   from `cancellations`. Must not add any constraint and must not touch
   `cancelBooking`. Until this ships, NOS-16's constraint is the bug above.
2. **NOS-7** second: `db.batch` in both paths. Must not add constraints or
   `onConflict`, because there is nothing to conflict on yet, and must not change
   dispatcher routing.
3. **NOS-16** last: the unique index plus `onConflictDoNothing` at both insert
   sites. Must not touch `refunds` or the dispatcher.

**NOS-7's invariant is restated as a database-level fact** rather than "exactly one
row written by this call", because `onConflictDoNothing` makes the latter false for
a race loser: *a booking with status `cancelled` has at least one `cancellations`
row and at least one cancel event.* The race loser satisfies it through the
winner's row.

**NOS-16 must append a `booking.cancel.conflict` event carrying the dropped
amount** when its `onConflictDoNothing` absorbs a write. The loser's refund amount
differs from the winner's, and without that event the difference simply vanishes.

**The migration for NOS-16 needs a precondition this one does not.** Creating a
unique index fails if duplicates exist, which is the safe direction: the migrate
step fails, the deploy fails, and traffic never moves because revisions start with
no traffic. The owner checks for duplicates in **every** environment sharing the
schema immediately before approving, not when the pull request opens, because a
cancellation can land in between. A Neon branch inherits its parent's rows, so the
test environment alone is not proof. The remedy for a duplicate is not `DELETE`: it
is a migration that keeps the earliest row per booking and records the others as
events, designed only if a duplicate is actually found.

## Revisit when

- A refund needs to be **performed** rather than recorded. Everything here assumes
  the supplier is merchant of record (§3.2). If that changes, `refunds` becomes a
  ledger of our own obligations and this decision is too small.
- The money view is built. It is the first reader that must sum both tables, and
  it is where the stated cost above will either be handled or discovered.
