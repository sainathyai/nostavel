---
name: database
description: Schema, migrations, the database connection and the booking ledger. Read before editing src/db or anything that writes booking rows.
globs:
  - "src/db/**"
  - "drizzle.config.ts"
---

# Database rules

Source of truth: `docs/conventions.md` §1 and §8. Stack: Neon Postgres over HTTP with Drizzle ORM.

## Migrations
- Change `src/db/schema.ts`, then run `npm run db:generate` and commit the generated migration in `src/db/migrations/`.
- **Never `db:push`.** It changes a database with no migration record. The agent guard blocks it.
- **Additive first (expand, then contract).**
  - Add new columns as nullable or with a default, and backfill.
  - Remove or rename only in a later change, after no code reads the old shape.
  - Environments share the schema over time, so a destructive migration can break a running deploy.
- Never edit a migration that has already been merged. Write a new one.
- Applying migrations (`db:migrate`) is a deliberate step that needs approval, never a side effect of other work.

## The booking ledger (§8)
- `booking_events` is **append-only**. It's the reconciliation record against supplier payouts.
- Never `UPDATE` or `DELETE` its rows, even to tidy up. To correct something, append a correcting event with an actor. The agent guard blocks ledger updates and deletes run from the shell.
- A booking status change and its event are written together in one `db.batch`, so they succeed or fail as one.
- Fixtures that write ledger rows are labelled as fixtures, and their rows are disposable. Never leave a fixture writing rows a report could be run over.

## Connection
- `src/db/index.ts` connects on the **first query, not on import**. That is why lint, types, tests and build run in CI with no secrets. Keep it lazy, and keep the Drizzle prototype so the Auth.js adapter still recognises the client (covered by `src/db/index.test.ts`).
- Stores import `db`. Rules never do (backend rule, §1).

## Data safety
- Never connect an agent session to a production database. Development uses a Neon branch.
- Guest personal data (names, emails, phone numbers) never goes into logs, fixtures committed to the repo, or analysis outputs.

## Done
- The migration is generated and committed; state in the pull request that it's additive.
- `npm run verify` passes.
