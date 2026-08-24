<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Conventions

Read `docs/conventions.md` before writing code in this repo. It is short, and
every rule in it exists because breaking it already caused a bug here.

The three that catch people most often:

1. **Pure rules import nothing.** If a unit test needs a database to import a
   rule, the rule is in the wrong file. Rules live in `lib/<name>.ts`, queries in
   `lib/<name>-store.ts`.
2. **Never compare money across bases.** A rate is not a total. A saving may only
   be claimed against sourced evidence, never against supplier net.
3. **Verify by running it, not by rendering it.** `npm test`, `npx tsc --noEmit`,
   `npm run lint`, `npm run build`, and then actually exercise the page. Several
   bugs here returned a clean 200 and were still broken.
