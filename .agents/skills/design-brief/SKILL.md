---
name: design-brief
description: Write a design brief for a ticket that changes what a guest sees or does. Covers the user goal, flow, every UI state, phone-first layout, design tokens, accessibility checks and the data source for every guest-facing claim, saved as docs/design/NOS-<n>.md. Use before any non-trivial UI work.
license: Proprietary. See LICENSE.
compatibility: Works in any agent that can read files and write Markdown. Capturing the current UI needs a browser automation tool; without one, ask the owner for screenshots.
metadata:
  owner: nostavel
  role: ux-designer
  version: "1"
---

# Design brief

A brief is the contract between design, engineering and review. The frontend engineer
builds from it and the UI reviewer checks against it, so anything left out of it gets
guessed.

## Steps

1. **Understand the ask.** Read the ticket (and PRD, if any) and its acceptance criteria.
   Write the user goal in one sentence from the guest's point of view.
2. **See what exists.** Open every affected page. With a browser tool, capture it at
   375 px and 1280 px wide, in light and dark themes. Without one, list the URLs and ask
   the owner for screenshots. Read the relevant components before proposing changes.
3. **Read the constraints.**
   - Tokens and utilities in `src/app/globals.css`.
   - The frontend area rule (`.agents/rules/frontend.md`).
   - The money-and-claims rule, if prices, savings, fees or deadlines appear.
4. **Design the flow.** Numbered steps from entry to success. Note where the guest can
   leave, go back, or hit an error.
5. **Specify every state** for each screen or component: empty, loading, error (which
   errors, and what the guest can do next), success, partial or slow data. A state not
   written down gets improvised.
6. **Lay it out phone-first.** Describe the 375 px layout first, then what changes at
   wider widths. Name existing components and utilities to reuse.
7. **Use tokens only.** Colours from `parchment`, `parchment2`, `surface`, `line`, `ink`,
   `soft`, `brass`, `brassglow`, `sage`; type from `font-display`, `font-sans`,
   `font-mono`. If a new token is truly needed, propose it with a reason. Don't
   introduce it silently.
8. **Write accessibility as checks.** Labels, focus order, keyboard path, contrast in
   both themes, reduced motion, what a screen reader announces for state changes.
9. **Source every claim** (conventions §4). For each price, saving, deadline or inclusion
   on screen, name the field in the API response or the `analysis/` measurement. If
   there is no source, the design doesn't show the claim.
10. **Write the brief** with `assets/brief-template.md`, save it as
    `docs/design/NOS-<n>.md`, and link it from the ticket.

## Quality bar
- An engineer could build it without asking a question.
- A reviewer could fail it on a specific, written requirement.
- Nothing in it depends on colour alone, hover alone, or a mouse.
