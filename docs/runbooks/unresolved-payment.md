# Runbook: a guest may have been charged with no booking

You got an email titled **"nostavel-uat: a guest may have been charged with no
booking"**. This is the only alert in this system that is about a guest's money.

**Stop the bleeding: nothing to do, and that is a measured statement, not a
guess.** The charge is an authorization and not a capture, and LiteAPI's own
words are: *"In the case of a lost booking, the payment hold will stay for 1-2
business days before being released when the booking is not finalized"*
(captured in [docs/spikes/payment-timing.md](../spikes/payment-timing.md) §4).
So the guest's money comes back by itself even if nobody does anything.

What is NOT automatic is the guest knowing that. Their statement shows a pending
charge for a stay they do not have, and this row is the only thing that can
explain it to them.

## Symptoms

| What you see | What it means |
|---|---|
| The alert email, with a log entry attached | One booking reached `payment.unresolved` on this sweep |
| A guest writes in about a charge with no confirmation | The same thing, arriving the other way round |
| `alerts` above zero in a `cron.sweep.completed` log line | How many the pass flagged, including ones already known |

The email is **rate limited to one per five minutes**, so treat it as a doorbell
and not as a list. Step 1 is the list.

## Steps

1. **List every unresolved booking.** This is the authoritative answer, not the
   email:

   ```bash
   export PROJECT=nostavel SERVICE=nostavel-uat
   U=$(gcloud secrets versions access latest --secret="${SERVICE}-DATABASE_URL" --project="$PROJECT")
   DATABASE_URL="$U" node -e "
   import('@neondatabase/serverless').then(async ({ neon }) => {
     const sql = neon(process.env.DATABASE_URL);
     console.log(JSON.stringify(await sql.query(\`
       select b.human_ref, b.status, b.currency, b.amount_total_minor,
              b.transaction_id, b.prebook_id, b.contact_email,
              e.created_at as flagged_at, e.payload->>'reason' as reason
       from booking_events e
       join bookings b on b.id = e.booking_id
       where e.type = 'payment.unresolved'
         and not exists (
           select 1 from booking_events c
           where c.booking_id = e.booking_id
             and c.type = 'payment.unresolved.closed'
             and c.created_at > e.created_at
         )
       order by e.created_at\`), null, 2));
   });"
   ```

   - **Healthy: `[]`.** The alert fired on something that has since been closed
     out (step 5), or you are reading this out of curiosity. Nothing to do.
   - **One or more rows:** continue. `contact_email` is in this query and
     deliberately NOT in the alert email, because a guest's address does not
     belong in a log line or a forwarded notification.

2. **Read what was already tried.** The `reason` column is the sweeper's own
   words. The three that matter:

   | `reason` says | What the sweeper established |
   |---|---|
   | the hold lapsed while a payment was in flight | It could not ask the supplier, because the hold is gone |
   | the supplier could not be reached | A transport failure, not an answer |
   | anything mentioning `payment not completed` | The supplier says this transaction was never paid - this row should not be here; note it on the ticket |

   `status` should be `payment_pending`. **If it is `expired` or `cancelled`,
   somebody tidied the row up**, which is the one thing this runbook says not to
   do, and the ledger is now the only account of what happened.

3. **Ask the supplier about the transaction.** Take `transaction_id` (or
   `prebook_id` when there is no transaction) into the LiteAPI dashboard for the
   sandbox account and look for that payment.

   - **Charge present and not captured:** expected. It releases itself; go to
     step 4.
   - **Charge captured, or a booking exists on their side that we do not have:**
     stop and record it on the ticket. That is a real divergence, it is what the
     nightly reconciler exists for, and it needs a decision rather than a step
     in a runbook.
   - **No such transaction:** the guest was never charged. Say so in step 4 and
     close it in step 5.

   **Not rehearsed.** Nobody has walked this with a real unresolved booking,
   because none has occurred. The two steps either side of it have been run.

4. **Tell the guest, in these terms.** They have a pending charge and no
   booking, and the true statement is short:

   > We could not complete your booking, and the payment your bank is showing is
   > an authorization that was never taken. It will drop off your statement
   > within one to two business days. Nothing has been charged, and we have not
   > held a room. If you still want the stay, book again - you will not be
   > charged twice.

   Do not promise a refund: there is nothing to refund, and a refund that never
   appears because it never existed is worse than the truth.

5. **Close it out, so the list stays usable.** Append a closing event. Do not
   update or delete the original - `booking_events` is append-only
   ([.agents/rules/database.md](../../.agents/rules/database.md)), and the
   original is the evidence:

   ```bash
   DATABASE_URL="$U" node -e "
   import('@neondatabase/serverless').then(async ({ neon }) => {
     const sql = neon(process.env.DATABASE_URL);
     await sql.query(
       \"insert into booking_events (booking_id, type, actor, payload) select id, 'payment.unresolved.closed', 'owner', \$2::jsonb from bookings where human_ref = \$1\",
       ['LNTRN-XXXX', JSON.stringify({ note: 'told the guest, hold releases itself', ticket: 'NOS-XX' })]);
     console.log('closed');
   });"
   ```

   - **Healthy:** step 1 now returns one fewer row.
   - `payment.unresolved.closed` is written and read by **nothing in the
     application**. It exists for this procedure and for step 1's query, which
     is what keeps that query a list of things still to do rather than a history.

## Prove the alarm, before you need it

An unfired alert is an untested alert, and this one cannot be tested by waiting:
no booking has gone unresolved yet. You can write the log entry yourself, with
the monitored resource the policy filters on:

```bash
gcloud logging write nostavel-alarm-test   --project=nostavel   --severity=ERROR   --monitored-resource-type=cloud_run_revision   --monitored-resource-labels=service_name=nostavel-uat,location=us-central1,revision_name=alarm-test,configuration_name=nostavel-uat   --payload-type=json   '{"event":"payment.unresolved","message":"TEST - deliberate alarm test. No guest is affected."}'
```

- **Healthy:** one email within a few minutes, titled "a guest may have been
  charged with no booking", with that payload attached.
- **Nothing arrives:** check `alert_email` in `infra/envs/uat/terraform.tfvars`
  and that `terraform apply` has been run since this policy was added. A Google
  Group drops alerting mail unless it accepts it from
  `alerting-noreply@google.com` ([cron-jobs.md](cron-jobs.md) §0).

Two things about doing this: it **sends you a real email**, and it writes a log
entry that step 1's query will not show, because step 1 reads the database and
this wrote only a log line. That is the point of the test - it exercises the
path from a line to your inbox and nothing else.

**This has not been run.** Writing to the project's log and sending the owner an
alarm email is the owner's call, not an agent's.

## Do not

- **Do not mark the booking `expired` or `cancelled` to tidy it up.** That
  closes the only record saying a person has not finished with it, and the guest
  still has a charge on their statement. The sweeper deliberately leaves the
  status alone for exactly this reason (decision D-4.2).
- **Do not `UPDATE` or `DELETE` a `booking_events` row**, including the
  `payment.unresolved` one you are working through. Append.
- **Do not refund by hand** without finding a captured charge first. We have no
  refund path to the supplier for an unfinalized booking, and there is normally
  nothing captured to refund.
- **Do not mute the alert.** It fires at most once per booking (the sweeper only
  logs it on the pass that first recorded it), so a flood means several real
  bookings, which is a different and worse problem.

## Afterwards

- Note on the ticket: the `human_ref`, what the supplier's dashboard showed,
  what you told the guest, and when. That is the whole audit trail for a charge
  somebody may ask about later.
- If the same `reason` appears more than once, raise it as a bug rather than
  working through them one at a time. Two of these from the same cause means the
  recovery path has a hole in it, and the sweeper is supposed to be the thing
  that prevents this.

**Rehearsed**, and precisely:

- **Step 1 was run** against the development database on 2026-10-30 and returns
  `[]` there, which is this runbook's healthy answer.
- **Step 5's statement was run** the same day in a form that cannot write: with
  a `human_ref` no booking has, so the `select` feeding the `insert` matched
  nothing. The count of `payment.unresolved.closed` rows was 0 before and 0
  after. That proves the SQL parses and both parameters bind. It proves nothing
  about what it writes when the reference does match.
- **Step 3 has never been walked**, because no booking has gone unresolved yet.
  It is the supplier's dashboard, and it is marked unrehearsed in place.
- The alert itself is proven by the test suite and by `terraform plan`, not by a
  real occurrence.
