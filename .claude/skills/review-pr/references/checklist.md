# Code review checklist

Only the sections that apply to the diff. Each item cites where the rule lives.

## Scope and clarity
- [ ] The change matches its ticket; no unrelated edits.
- [ ] Comments explain the decision and evidence, not the syntax (conventions §10).
- [ ] Constants that aren't obvious say what was measured, when, and by which script (§5).

## Layering (§1)
- [ ] Pure rule files (`lib/<name>.ts`) import nothing: no database, fetch, `server-only` or React.
- [ ] Queries are in `-store` files; multi-system orchestration in `-service` files.
- [ ] No new logic buried in a page, action or route that belongs in a rule file.

## Server boundary (§2)
- [ ] Modules holding secrets, supplier responses or net pricing import `server-only`.
- [ ] Every new prop crossing to a client component was checked for what it reveals.

## Money and claims (§3, §4)
- [ ] Integer minor units with an explicit currency; no floats stored or compared.
- [ ] No comparison across bases (rate vs total, with fees vs without).
- [ ] Savings only against a sourced value; null means show nothing.
- [ ] Rounding favours the guest.
- [ ] Every new guest-facing claim names its source; estimates are labelled as estimates.

## Correctness
- [ ] Time-dependent behaviour takes `now` as an argument.
- [ ] Multi-row writes that must agree use `db.batch`.
- [ ] Status changes are safe under concurrency (compare-and-swap or single writer).
- [ ] Ledger rows are only appended, never updated or deleted (§8).
- [ ] Failure paths: supplier error, timeout, duplicate delivery, empty result.

## Interfaces
- [ ] Actions return `{ ok, data } | { ok, error }`; no raw supplier or database text reaches a guest.
- [ ] New entry points authorize, validate input and are rate-limited (see the security rule).

## Frontend (§9)
- [ ] No once-only ref guards on effects; no setState in an effect for derivable values.
- [ ] Tokens only, no raw colours; both themes considered.
- [ ] Labels, `alt` text, keyboard reachability, visible focus.

## Tests (§6)
- [ ] One test per acceptance criterion, named for the behaviour.
- [ ] Tests would fail if the change were reverted.
- [ ] Fixtures invent no data; clock injected; both directions covered for money.

## Evidence (§7)
- [ ] The description records the commands run and their results.
- [ ] Behaviour was exercised, not just built.
- [ ] Anything only a human can judge is handed to the owner with a URL and what to look at.
