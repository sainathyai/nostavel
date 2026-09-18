---
name: security-review
description: Security review of a pull request labelled security or money - authorization, input validation, secrets, error disclosure, rate limiting, webhooks, headers, money integrity and personal data - reporting only verified findings, each with a concrete failure scenario, and a clear approve or request-changes. Does not modify code.
license: Proprietary. See LICENSE.
compatibility: Requires git. Running the test suite is optional supporting evidence.
metadata:
  owner: nostavel
  role: security-architect
  version: "1"
---

# Security review of a pull request

Review the change, not the whole codebase. Read enough surrounding code to know whether
a control really holds.

## Steps

1. **Load the change.** Read the pull request description, its labels and linked
   ticket, and the diff (`git diff main...HEAD`, or the pull request diff). List every
   changed entry point (server action, API route, webhook, cron), and every changed
   place that handles money, secrets or personal data.
2. **Read the context.** Check the security area rule and its known-gaps table, any
   threat model in `docs/security/` covering this area, and `SECURITY.md`.
3. **Work through the checklist** in `references/checklist.md` for each changed entry
   point. Skip items that clearly don't apply, and say so.
4. **Verify each candidate finding before reporting it.**
   - Trace the actual code path. Run the relevant tests if that settles it.
   - Discard anything you cannot turn into a concrete failure scenario (inputs or
     state → wrong outcome).
   - No speculative findings.
5. **Check for regressions of known gaps.** A change must not copy a pattern from the
   known-gaps table, or widen one.
6. **Write the review:**
   - **Verdict:** approve, or request changes.
   - **Findings,** most severe first: severity, `file:line`, what is wrong, failure
     scenario, suggested fix, owning role.
   - **Checked and fine:** the checklist areas that were reviewed and hold.
   - **Not checked:** anything out of reach (e.g. needs live credentials).
7. **Hand off.** Findings go to the authoring engineer through the pull request. Gaps
   outside this change become proposed tickets for tech-lead.

## Public repository care
This repository is public. For a finding in **already-merged** code that is exploitable
now with real impact, don't describe the exploit in the pull request. Mark it
"reported privately", and send the details to the owner through private vulnerability
reporting (`SECURITY.md`).
