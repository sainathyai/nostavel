# analysis/

Dated scripts that measured how LiteAPI actually behaves. They are the evidence
behind the non-obvious constants in `src/`: each constant's comment names the
script and the date it was measured (see `docs/conventions.md` §5 and §8).

## What is committed

- Scripts: `*.py`, `*.mts`, `*.mjs`, `*.cjs`
- Written notes and hand-made templates (for example `2026-08-19/premise.md`,
  `dashboard.template.html`)

## What is never committed

Script **outputs**: raw API responses, CSV and JSON results, generated
dashboards, captured console output.

- They can contain supplier net pricing and offer ids, and this repository is public.
- They are regenerable: re-run the script.
- `.gitignore` excludes them, and the pre-commit guard (`scripts/git-guard.mjs`)
  rejects them if they are force-added.

Keep outputs next to the script on your machine (they are ignored), or in private
storage if they must be shared.

## Running a script

- Use **sandbox** keys only (`sand_…`). Scripts read `.env.local`.
- Scripts that analyse earlier output need the pull script re-run first, since
  that output is no longer in the repository.
- LiteAPI caches responses for identical requests. When measuring timing or
  stability, vary something real, such as the check-in date (conventions §5).
- Scripts that import a `server-only` module need the alias shim in
  `2026-08-21/_noop.cjs`. Do not remove the guard from the module.
- Fixtures that write to the booking ledger must label their rows (`FIX*`
  references) so reports can exclude them (conventions §8).

## Layout

`analysis/YYYY-MM-DD/<question>.{py,mts}`: one folder per measurement session.
Top-level scripts predate the dated layout.
