# ADR 0002: Agent team structure

- **Status:** proposed (for review with Segment 2.3)
- **Date:** 2026-09-17
- **Scope:** Segment 2 (team workflow)

## Context

Nostavel is built by one human owner working with AI coding agents. The owner wants the
work to run like a production engineering team: clear ownership, specialist review of
risky changes, and durable records. The project handles guest personal data and payments,
so some mistakes are expensive: money lost, a guest misled, a secret leaked.

Constraints:
- Agents from any provider or tool must be able to play any role (ADR 0001).
- The budget is small. Every extra role adds tokens per ticket.
- There is one human, so human review time is the scarcest resource.

## Decision

1. **Twelve roles in four groups.**
   - Product: product-manager, ux-designer.
   - Lead: tech-lead.
   - Architecture: software-architect, security-architect.
   - Engineering: frontend-engineer, backend-engineer, ai-engineer, devops-sre.
   - Quality: qa-engineer, code-reviewer, ui-reviewer.

   The charters are in `docs/team/roles.md`.
2. **Roles are defined by responsibilities, artifacts and capabilities**, not by a tool or a
   model. Tier (`deep`, `standard`, `fast`) expresses how much reasoning a role needs.
3. **Author ≠ reviewer.** Reviewer roles have no edit capability. A role never reviews its
   own change.
4. **Label-triggered gates** add specialist reviews only where a change carries that risk
   (`money`, `security`, `ui`, `migration`, `ai`, `agent-layer`). Ordinary changes get only
   the code-reviewer, so review cost scales with risk.
5. **The human owner merges and decides.** Agents never merge, change repository settings,
   handle secrets or open the money gate. The guardrails enforce this (`scripts/agent-guards/`).
6. **Handoffs through durable artifacts** (PRDs, design briefs, ADRs, threat models,
   pull requests, tracker comments), so work survives a change of tool, model or session.
7. **One security role** designs controls and reviews security-labelled changes. The
   engineer implements, so author ≠ reviewer still holds.
8. **Tiers:** `deep` for tech-lead, software-architect and security-architect, where
   mistakes are costly and problems ambiguous; `standard` for everyone else.

## Consequences

- Risky changes cost more review, and cheap changes stay cheap.
- The owner reviews less: specialist agents filter first, and the owner's time goes to
  merges, decisions and visual checks.
- More roles means more coordination. The tech lead exists to absorb it, and how it drives
  the others is decided in 2.5.
- Having the security architect design and review a control is weaker than two
  independent people. Accepted at this team size; revisit if real-money bookings go live.

## Alternatives considered

- **One generalist agent plus the owner:** cheapest, but no independent review and no
  specialist depth on money and security.
- **A separate security-reviewer role (13 roles):** stronger separation, but duplicates the
  architect's knowledge at extra cost. Deferred until the money gate opens.
- **Code-reviewer on the `deep` tier:** stronger reviews at a higher cost per pull request.
  Label gates already put deep-tier review on the risky changes.
- **Mechanical roles (ui-reviewer, qa-engineer) on `fast`:** cheaper, but weaker judgment on
  what is worth flagging. Revisit with measured review quality.

## Review

Revisit after the Segment 2.7 dry run, using what one real ticket shows about cost,
handoff friction and review quality.
