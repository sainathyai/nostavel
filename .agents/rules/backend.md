---
name: backend
description: Domain rules, stores, services, server actions and API routes. Read before editing src/lib, src/app/actions or src/app/api.
globs:
  - "src/lib/**"
  - "src/app/actions/**"
  - "src/app/api/**"
---

# Backend rules

Source of truth: `docs/conventions.md` §1, §2, §5 and §10. This file is a digest; when they differ, the conventions win.

## Layers (§1)

| File | Contains | May import |
|---|---|---|
| `lib/foo.ts` | rules, types, pure functions | **nothing**: no `db`, fetch, `server-only` or React |
| `lib/foo-store.ts` | database reads and writes for `foo` | `db`, `foo.ts` |
| `lib/foo-service.ts` | orchestration across systems | supplier API, stores, rules |
| `app/actions`, `app/api` | entry points | anything below |

- If a unit test needs a database to import a rule, the rule is in the wrong file. Split it.
- `src/lib/bookings.ts` is an older store without the `-store` suffix. Don't copy the naming.

## Server boundary (§2)
- Anything holding a secret, a supplier response or supplier net pricing starts with `import "server-only"`.
- Never remove that import to make a script or test work. Tests alias it (`vitest.config.ts`); analysis scripts alias it or call the HTTP API.

## Time
- Time-dependent logic takes `now` as a parameter (`signQuote`, `buildCancelPolicy`, `shouldRecord`). Never read the clock inside a rule.

## Server actions and API routes
- **Action results:** return `{ ok: true, data } | { ok: false, error }`. Never throw across the action boundary.
- **Error messages:** `error` is a message safe to show a guest. Raw supplier or database messages never reach the browser; log the detail on the server instead. Existing code still leaks some; see the security rule.
- **Rate limits:** every action and route that calls the supplier or sends email is rate-limited (`lib/rate-limit.ts`).
- **Validation:** check input shape at the boundary; zod v4 is available.
- **Atomic writes:** writes that must succeed or fail together go through `db.batch` (the Neon HTTP driver runs a batch as one transaction).

## Logging (NOS-69)
- **Never `console.*` in `src`.** Lint refuses it. Use `logInfo`, `logWarning`, `logError` or `logCritical` from `lib/log.ts`, which write one line of JSON with `severity`, `event`, `message` and whatever fields were passed.
- **`event` is a dotted, stable identifier** (`cron.sweep.completed`, `email.send.failed`). It is what a filter, a log-based metric and therefore an alert key on, so renaming one is a breaking change to whatever watches it. `log-contract.test.ts` reads the Terraform filters and fails if an event a policy depends on disappears.
- **`message` is a sentence for a person**, because the Logs Explorer summary shows `jsonPayload.message` and nothing else until a line is expanded. Put the numbers in fields as well, not only in prose.
- **Fields are top-level.** They are the thing a metric can count. Do not wrap them in a `data` object; the existing filters would stop matching and no test but the contract test would notice.
- **Severity means what it says:** `WARNING` is still-serving, `ERROR` is this request or job failed, `CRITICAL` is the process up and deliberately not serving. The stream follows the severity; the payload is what Cloud Logging honours.
- **Personal data:** the logger redacts email-shaped text in every string it writes, including nested fields. That is a floor, not a licence - do not pass a guest's name, phone number or address in the first place, and never a secret, a token or a password attempt.

## Supplier (LiteAPI)
- All supplier calls go through `lib/liteapi.ts`. Don't call `fetch` against the supplier anywhere else.
- Prices from the supplier are floats. Convert to integer minor units at the edge (see the money-and-claims rule).
- **A supplier call driven by TYPING needs all of this, and the rate limit above is not
  optional for it.** The typeahead's hotel tier (`/api/hotels` -> `listHotelsByName`) is the
  only place in the app where a keystroke can reach the supplier. It is allowed to because
  it has: its **own route**, so no other tier waits on it and the rate limit has somewhere
  to live; the **rate limit** every supplier route here has; a **gate** deciding the query
  is worth a call (`lib/search-suggestions.ts` + `exactPlaceMatchCount`, pure and tested);
  a **cache** so retyping is free; and a **silent failure** that leaves the local rows
  alone. Any second one of these copies all of it, or explains in its PR why not.
  See ADR 0006.
- **A rule is not a description of what was built.** The first version of the bullet above
  listed four properties the implementation happened to have and omitted the rate limit it
  did not - while `/api/stays-in-area`, one directory away, had one. The architecture review
  of NOS-66 caught it: a rule edited to fit the code stops being a constraint. If a change
  cannot meet a rule, the PR says so and the ADR records the exception; it does not reword
  the rule.

## Constants and comments (§5, §10)
- Every non-obvious constant has a comment saying what was measured, when, and which `analysis/<date>/` script measured it.
- Comments explain the decision and the evidence, not the syntax.

## Done
- A rule change comes with a test of that rule (see the tests rule).
- Run `npm run verify`.
- API and CLI checks are the agent's to run: call the route or action and report the actual result (§7).
