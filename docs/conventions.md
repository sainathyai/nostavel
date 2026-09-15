# How this codebase is built

Written 2026-08-22, when the app got big enough that "I remember why" stopped
being a strategy. These are the rules the existing code already follows. Where a
file breaks one, that is a bug or a debt, not a precedent.

---

## 1. Layers, and which way dependencies point

```
    app/          pages, server actions, routes      may import anything below
    lib/*-store   database reads and writes          db + rules
    lib/*-service orchestration across systems       api + store + rules
    lib/<rules>   pure domain logic                  imports NOTHING
    db/           schema and connection
```

**Pure rules import nothing.** No `db`, no `fetch`, no `server-only`, no React.
`pricing.ts`, `fees.ts`, `cancellation.ts`, `nearby.ts`, `search-history.ts` are
all in this category, and they are the files with the real logic in them.

This is not tidiness. `search-history.ts` was written as one file with the
dedupe rule sitting next to its Drizzle queries, and its test could not run at
all: importing the module reached `db`, which throws without `DATABASE_URL`. The
rule and the query went into separate files and the test ran. **If a unit test
needs a database to import a rule, the rule is in the wrong file.**

Naming that follows from it:

| suffix | contains | may import |
|---|---|---|
| `foo.ts` | rules, types, pure functions | nothing |
| `foo-store.ts` | the queries for `foo` | `db`, `foo.ts` |
| `foo-service.ts` | multi-system orchestration | api, stores, rules |

## 2. `server-only` is a real boundary

Anything holding a secret, a supplier response, or supplier NET pricing carries
`import "server-only"`. It exists to fail a client bundle at build time rather
than leak at runtime.

Two consequences to remember:

- **A harness cannot import a `server-only` module.** Scripts under `analysis/`
  either call the HTTP API directly or alias the module (see
  `analysis/2026-08-21/_noop.cjs`). Do not remove the guard to make a script work.
- **Anything crossing to the browser is a public statement.** The
  `guestSavingsPct` bug shipped `1 - supplierNet/charge`, which is our own
  margin, to every checkout page labelled as the guest's discount. Before adding
  a field to a props object, ask what it reveals.

## 3. Money

- Stored as **integer minor units** plus an explicit currency. Never floats.
- **Never compare across bases.** A rate is not a total. The checkout page struck
  a public *rate* against our *rate* and printed a trip *total* underneath, and
  it read as one price split between two payees, because that is what it looked
  like. If a fee is on one side of a comparison it belongs on the other.
- **A saving may only be claimed against sourced evidence.** `compareAtPrice`
  returns null when there is none, and null means show nothing. Never derive a
  saving from supplier net, and never let a fixture invent one.
- **Round in the guest's favour.** `displayPrice` ceilings, so the charge is
  never higher than the number displayed.

## 4. Claims made to a guest must be true, and provable

Anything on screen that a guest could act on (a deadline, a saving, a fee, an
inclusion) needs a source in the API response or a measurement in `analysis/`. If
neither exists, do not show it.

Examples currently load-bearing:
- Cancellation deadlines are converted to **property-local** time from lat/lng,
  because LiteAPI states every one in GMT. "Oct 17" was a day late for Austin.
- "Breakfast included" passes a measured price-gap gate, not a guess.
- Walking times say "estimated from straight-line distance", because they are.

## 5. Measure before deciding, and write the number down

Every non-obvious constant in this codebase has a measurement behind it, and the
comment beside it says what was measured, when, and where the script lives:
`timeout: 5`, `MAX_RATES_PER_HOTEL`, the breakfast floor, the SSP fallback
margins. Keep doing this. A constant with no provenance is one nobody can ever
change safely.

Two traps that have already cost a wrong conclusion:

- **LiteAPI caches responses for identical params.** A timing or stability study
  must vary something real (a unique check-in date) or it measures the cache. One
  sweep produced "timeout 30 is faster and cheaper", which was an artifact.
- **Watch the join key.** A plan-identity key that included net *to the cent*
  made a stability test look catastrophic (21% vs 93%); the difference was float
  from dividing out a margin, not churn.

## 6. Tests

- **The rule gets the test, not the wiring.** Prefer a pure function that can be
  exercised at its edges over an integration test of the page that calls it.
- **Inject the clock.** `buildCancelPolicy`, `shouldRecord` and `signQuote` all
  take `now` as an argument. Time-dependent behaviour is otherwise untestable.
- **Test the direction that loses money and the direction that harms the guest.**
  `quoteMatchesSession` rejects a member token from a signed-out visitor *and* a
  public token from a member, and both are asserted.
- **Fixtures must not invent data.** A fixture wrote `themMinor = amt * 1.18` and
  the checkout page struck it through as a public rate that no API ever returned.
  If the real value would be null, the fixture uses null.
- **Name the behaviour, not the function.** "rejects a member page used by a
  signed-out visitor" survives a refactor; "returns false" does not.

## 7. Verification before saying it is done

```
npm test          # unit
npx tsc --noEmit  # types
npm run lint      # eslint (note: `next lint` no longer exists in Next 16)
npm run build     # the one that catches server/client boundary mistakes
```

Then **run it**. Several bugs in this codebase rendered clean HTML and were still
broken: the Stripe element that reported `ready` into a zero-height host, the
basemap whose pinned URL had expired, the map whose worker 404'd silently. A page
that returns 200 is not a page that works.

Visual and interaction checks are Sainatha's, not Claude's: hand over a URL and
say what to look for. API and CLI checks are Claude's to run.

## 8. Live data, fixtures, and the ledger

- Scripts that touch the live API live in `analysis/<date>/` with a docstring
  saying what question they answer. They are kept, not deleted; they are the
  provenance for the constants.
- **Script outputs are never committed.** Raw responses, CSV and JSON results,
  and generated dashboards stay on your machine: git ignores them and the
  pre-commit guard rejects them. They can carry supplier net pricing, and the
  repository is public. The script and its date are the provenance; re-run it
  to regenerate the output. See `analysis/README.md`.
- Fixtures that write to the ledger are labelled as such and their rows are
  disposable. Never leave a fixture writing something a report might be run over.
- **Never delete or rewrite ledger rows to tidy up.** The booking ledger is the
  reconciliation record against LiteAPI payouts.

## 9. React and Next specifics that have already bitten

- **This is Next 16.** Read `node_modules/next/dist/docs/` before assuming an
  API. `next lint` is gone.
- **Do not guard an effect with a once-only ref.** React remounts effects, and a
  guard that skips the second run leaves the work attached to a DOM node React
  has discarded. Build on mount, tear down in cleanup. This is exactly how the
  payment form came to render nothing.
- **Do not call setState from an effect body** to compute something derivable at
  render. `shownError` is derived; it used to be an effect.
- **A sticky panel taller than the viewport pins its top** and puts its bottom out
  of reach. Cap the height and let it scroll internally, or move content out.
- **`min-width: auto` is the default on flex items,** so one long unbreakable
  label sets a floor on its whole container. Every row that pairs a label with a
  number needs `min-w-0` on the label and `shrink-0` on the number.

## 10. Comments

Explain the decision and the evidence, not the syntax. The useful comment says
what was tried, what was measured, or what will break if this changes. Comments
that carry a measurement should say when it was taken, so a future reader knows
whether to re-run it.

---

## Related documents

- `docs/production-readiness.md` — what is missing before real guests and real
  money, with the order to close it in. Read section 0 before designing anything:
  several tables and several LiteAPI endpoints already exist unused.
- `docs/verticals-cars-flights.md` — parked assessment of cars and flights. Not
  a commitment; revisit only after production readiness is closed out.
- `docs/testing-strategy.md` — manual functional testing checklist for the
  live app, complementary to the unit tests in section 6 above.
