---
name: prompt-change
description: Change a prompt, an intent schema or a model choice and prove the change with a before-and-after run over recorded cases, including what got worse. Use for anything the model reads or returns, and before claiming an assistant behaviour is fixed.
license: Proprietary. See LICENSE.
compatibility: Works in any agent that can read files, edit them and run shell commands. Running the cases needs the project's model API key in the environment; the agent never reads its value.
metadata:
  owner: nostavel
  role: ai-engineer
  version: "1"
---

# Change a prompt

Prompt changes are the easiest place in this codebase to fool yourself: the new phrasing
looks better on the one example you had in mind, and quietly breaks three others. Nothing
here is done on an impression.

## Steps

1. **Write the failing case first.** The exact guest phrasing, the context it arrives in
   (the current date, any existing search state), what the model returns today, and what it
   should return. Add it to `docs/ai/cases.md` from `assets/cases-template.md`.
2. **Run the cases as they stand,** and keep the output. This is the "before". If there is
   no case file yet, start one with the cases that matter, including ones that currently
   pass — those are what catch a regression.
3. **Read the whole prompt before editing it.** A rule already in the prompt that the model
   is ignoring is a different problem from a rule that isn't there, and it has a different
   fix.
4. **Change one thing.** Prompt wording, schema shape, or model — not several at once, or
   the comparison says nothing about which one worked.
5. **Never bake in time.** "Today" and any deadline are passed in per request, never read
   from the clock inside a rule or fixed when a module loads (the backend area rules).
   A test must be able to fix the date.
6. **Run the cases again.** Report, in the pull request:
   - which cases changed from wrong to right;
   - which changed from right to wrong — state these plainly, never omit them;
   - anything ambiguous, with the actual output quoted.
7. **Check the schema still holds.** Anything the model returns is parsed
   (`src/lib/assistant/`): a prompt that encourages a shape the schema rejects turns into a
   silent failure for the guest, not an error you will see.
8. **Note cost and latency** when either moves materially — tokens added to every request,
   or a slower model.
9. **Hand the permanent cases to qa-engineer** so they become tests, and record the run in
   the pull request.

## What counts as evidence
- A quoted before-and-after for each case, with the input that produced it.
- The count of cases right before and after, including the ones that got worse.
- Not evidence: "the prompt is clearer now", a single happy example, or a passing build.

## Quality bar
- The failing case is recorded and now passes.
- Regressions are stated, not discovered later by a guest.
- Nothing time-dependent reads the clock internally.
- A guest-facing claim the model can produce has a source (conventions §4).
