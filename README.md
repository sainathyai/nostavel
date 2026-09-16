# Nostavel

Hotel booking on [LiteAPI](https://www.liteapi.travel/), growing into an AI trip
planner. Built in public as a production-style system: honest pricing, an
auditable booking ledger, and a Claude-agent team workflow.

> **Status: prototype.** Runs against LiteAPI's **sandbox** only. It takes no
> real bookings and no real payments.

## What it does today

- Search stays by city, curated destination or map area, with member and public
  prices kept at rate parity
- Hotel detail: room and rate options, cancellation deadlines in property-local
  time, and fees due at the property shown separately
- Guest checkout through LiteAPI's payment SDK. LiteAPI is merchant of record,
  so card details never touch this app.
- Trips: confirmation, guest lookup by email code, and cancellation with a
  penalty preview
- Booking lifecycle (in progress): webhook receiver, abandoned-hold sweeper,
  nightly reconciliation

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, server actions), React 19, Tailwind CSS 4 |
| Supplier and payments | LiteAPI rates, prebook and book; LiteAPI payment SDK |
| Data | Neon Postgres with Drizzle ORM; append-only booking event trail |
| Auth | Auth.js v5 (Google, email magic link); guest checkout without an account |
| Maps | MapLibre GL with Protomaps |
| AI | Anthropic Claude (structured outputs) |
| Tests | Vitest |

## How the code is built

Read [`docs/conventions.md`](docs/conventions.md) before changing anything. In short:

- Pure rules import nothing; queries live in `*-store.ts`, orchestration in `*-service.ts`.
- Money is stored as integer minor units, and never compared across different bases.
- Anything shown to a guest (a saving, a deadline, a fee) must come from the API
  or from a measurement in `analysis/`.
- Verify by running it, not just by rendering it.

More docs:
[production readiness](docs/production-readiness.md) ·
[AI planner research](docs/planner-research.md) ·
[testing strategy](docs/testing-strategy.md) ·
[cars and flights assessment](docs/verticals-cars-flights.md)

## Local development

Requires Node 24, a Neon Postgres database and a LiteAPI sandbox key.

```bash
npm ci                        # also installs the git pre-commit guard
cp .env.example .env.local    # then fill in the values
npm run db:migrate            # applies src/db/migrations
npm run dev
```

The checks CI runs:

```bash
npm run lint && npx tsc --noEmit && npm test && npm run build
```

## Repository rules

- Never commit secrets or `.env*` files. Only `.env.example` is tracked.
- `analysis/` commits scripts, never their outputs (see
  [`analysis/README.md`](analysis/README.md)).
- The pre-commit guard, [`scripts/git-guard.mjs`](scripts/git-guard.mjs), blocks
  both, plus files over 2 MB and anything shaped like a credential. Don't bypass
  it with `--no-verify`.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## License

**All rights reserved.** The source is public to read, not to reuse. See [LICENSE](LICENSE).
