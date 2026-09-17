---
name: analysis
description: Measurement scripts against the live supplier API. Read before writing or running anything in analysis/.
globs:
  - "analysis/**"
---

# Analysis rules

Source of truth: `docs/conventions.md` §2, §5 and §8, plus `analysis/README.md`.

## Why this folder exists (§5)
Every non-obvious constant in the app has a measurement behind it. The script that measured it lives here, so the number can be re-checked later.

## Writing a script (§8)
- Put it in `analysis/<YYYY-MM-DD>/`, with a docstring saying the question it answers.
- Keep scripts after they run. They are the provenance for constants, so never delete them.
- Scripts can't import `server-only` modules. Call the HTTP API directly, or alias the module (see `analysis/2026-08-21/_noop.cjs`). **Never remove `server-only` from a module to make a script work** (§2).
- Read credentials from the environment. Never paste a key into a script.
- Use the sandbox key only. The live key is out of scope until the real-money gate opens.

## Outputs are never committed (§8)
- Raw responses, CSV and JSON results, generated dashboards and captured output stay on your machine. Git ignores them, and the pre-commit guard rejects them.
- **Why:** they can carry supplier net pricing and offer IDs, and the repository is public. The script and its date are the provenance; re-run it to regenerate.

## Traps that already produced wrong conclusions (§5)
- **LiteAPI caches responses for identical parameters.** A timing or stability study must vary something real (a unique check-in date), or it measures the cache.
- **Watch the join key.** A key that included a float price to the cent made a stability test look catastrophic; it was rounding noise, not churn.
- Record when a measurement was taken. Supplier behaviour changes, and a reader needs to know whether to re-run it.

## Using a result
When a measurement sets a constant in `src/`, the constant's comment names the value, the date and the script path.
