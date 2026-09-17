---
name: tests
description: Unit tests and test fixtures. Read before writing or changing any test.
globs:
  - "src/**/*.test.ts"
  - "scripts/**/*.test.mjs"
---

# Test rules

Source of truth: `docs/conventions.md` §6 and §7.

## What to test (§6)
- **Test the rule, not the wiring.** Prefer a pure function tested at its edges over an integration test of the page that calls it. If a rule can't be tested without a database, split the rule out first (backend rule, §1).
- **Test the direction that loses money and the direction that harms the guest.** Example: `quoteMatchesSession` rejects a member token from a signed-out visitor *and* a public token from a member, and both are asserted.
- **Test boundaries:** exact expiry instants, rounding edges, empty and null inputs.
- For guards and validators, test each block **and** its allowed look-alike, so a check can't pass by blocking everything.

## How to write them
- **Inject the clock.** Pass `now`; never depend on the real time or on timers.
- **Fixtures must not invent data.** Use real figures from `analysis/` measurements. If the real value would be null, the fixture uses null.
- **Name the behaviour, not the function.** "rejects a member page used by a signed-out visitor" survives a refactor; "returns false" doesn't.
- **Fake credentials are assembled at runtime** (for example `"sk-" + "ant-" + "x".repeat(30)`), so the test file itself never trips the secret guards.
- **No network or real database in unit tests.** `server-only` is aliased in `vitest.config.ts`, so unit tests can import server modules that don't touch the network.

## Layout and commands
- Unit tests sit next to the code as `src/**/<name>.test.ts` and run with Vitest (`npm test`).
- Script and agent-layer tests are `scripts/**/*.test.mjs` and run with the Node test runner (`npm run test:agents`).
- `npm run verify` runs both, plus lint, types and build.

## Not yet in place
There are no component, integration or end-to-end tests yet; Segment 3 adds them. Until then, a UI or flow change is verified by running the app (§7), not by a test that only renders.
