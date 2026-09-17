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

## Supplier (LiteAPI)
- All supplier calls go through `lib/liteapi.ts`. Don't call `fetch` against the supplier anywhere else.
- Prices from the supplier are floats. Convert to integer minor units at the edge (see the money-and-claims rule).

## Constants and comments (§5, §10)
- Every non-obvious constant has a comment saying what was measured, when, and which `analysis/<date>/` script measured it.
- Comments explain the decision and the evidence, not the syntax.

## Done
- A rule change comes with a test of that rule (see the tests rule).
- Run `npm run verify`.
- API and CLI checks are the agent's to run: call the route or action and report the actual result (§7).
