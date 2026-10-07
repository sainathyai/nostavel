#!/usr/bin/env node
// May this deploy proceed, given what the jobs before it did?
//
// WHY A SCRIPT AND NOT AN `if:` EXPRESSION. The deploy job has to run after a
// migration job that is SKIPPED on most merges, by design (D-5.4: only ask for
// approval when there is something to apply). GitHub's `needs:` does not help
// here - it blocks a dependent job when a dependency fails, but a skipped or
// cancelled dependency silently lets the dependent job through or silently
// skips it, depending on the `if:`. So the distinction this pipeline depends on
// most, "the migration was skipped because there was nothing to do" versus "the
// migration was skipped because nobody approved it", would live in an untested
// workflow expression.
//
// That is the same reasoning as scripts/ci-checks-result.mjs, and the same
// failure it was written for. This is an ALLOW-LIST: any job result this script
// has not been taught about stops the deploy.
//
//   node scripts/deploy-gate.mjs   reads NEEDS_JSON (${{ toJSON(needs) }})
import { pathToFileURL } from "node:url";

/** Results that mean a job did its work. */
const SUCCEEDED = "success";

/**
 * Results the migration job may legitimately have without blocking a deploy.
 *
 * Only `skipped`, and only together with a plan that said nothing was pending.
 * `success` is handled separately. Everything else - `failure`, `cancelled`,
 * `neutral`, a result GitHub adds later - stops the deploy.
 */
const MIGRATE_MAY_BE = new Set([SUCCEEDED, "skipped"]);

function describe(result) {
  if (result === undefined) return "<missing>";
  if (result === null) return "null";
  if (typeof result !== "string") return `<non-string: ${JSON.stringify(result)}>`;
  return result;
}

/**
 * @param {Record<string, {result?: unknown, outputs?: Record<string, string>}>} needs
 * @returns {{ok: boolean, message: string}}
 */
export function evaluateDeployGate(needs) {
  if (!needs || typeof needs !== "object") {
    return { ok: false, message: "deploy-gate: the needs context is missing or not an object." };
  }

  const plan = needs.plan;
  const migrate = needs.migrate;

  if (!plan || typeof plan !== "object") {
    return {
      ok: false,
      message:
        "deploy-gate: no `plan` job in the needs context. The deploy job must `needs: [plan, migrate]`, " +
        "because the plan is the only thing that knows whether a skipped migration was legitimate.",
    };
  }

  const planResult = describe(plan.result);
  if (planResult !== SUCCEEDED) {
    return {
      ok: false,
      message:
        `deploy-gate: refusing to deploy because the database plan did not succeed (plan: ${planResult}). ` +
        "Without a plan, nobody knows whether this deploy contains a migration.",
    };
  }

  // The plan's own answer, as a string, because that is how a workflow output
  // arrives. Anything that is not a non-negative integer is treated as unknown,
  // which stops the deploy rather than guessing that it meant zero.
  const raw = plan.outputs?.pending;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return {
      ok: false,
      message:
        `deploy-gate: the plan did not report how many migrations are pending (got ${JSON.stringify(raw)}). ` +
        "Refusing to deploy: an unreadable plan must not be read as an empty one.",
    };
  }
  const pending = Number(raw);

  if (!migrate || typeof migrate !== "object") {
    return {
      ok: false,
      message: "deploy-gate: no `migrate` job in the needs context, so its result cannot be checked.",
    };
  }

  const migrateResult = describe(migrate.result);
  if (!MIGRATE_MAY_BE.has(migrateResult)) {
    return {
      ok: false,
      message:
        `deploy-gate: refusing to deploy because the migration job's result was ${migrateResult}. ` +
        "A deploy whose migration failed, was cancelled, or was never approved must not take traffic: " +
        "the new code would be running against a database it does not match.",
    };
  }

  if (migrateResult === "skipped" && pending > 0) {
    // THE CASE THIS WHOLE SCRIPT EXISTS FOR. A skipped migration job looks
    // identical whether it was skipped because there was nothing to apply or
    // because the owner never approved it. The plan is what tells them apart.
    return {
      ok: false,
      message:
        `deploy-gate: refusing to deploy. ${pending} migration(s) are pending and the migration job was ` +
        "skipped, which means the approval was never given (or was cancelled). Approve the migration, or " +
        "the deployed code will be running against a database it does not match.",
    };
  }

  if (migrateResult === SUCCEEDED && pending === 0) {
    return {
      ok: false,
      message:
        "deploy-gate: refusing to deploy. The plan reported nothing pending, yet the migration job ran. " +
        "Those two disagree about what this deploy contains, and a database change nobody planned is " +
        "exactly what the approval gate exists to prevent.",
    };
  }

  const applied = pending === 0 ? "no database changes" : `${pending} approved database change(s)`;
  return { ok: true, message: `deploy-gate: proceeding with ${applied}.` };
}

function main() {
  const raw = process.env.NEEDS_JSON;
  if (!raw) {
    console.error(
      "deploy-gate: NEEDS_JSON is not set. The deploy job must set env: NEEDS_JSON: ${{ toJSON(needs) }}.",
    );
    process.exit(1);
  }

  let needs;
  try {
    needs = JSON.parse(raw);
  } catch (err) {
    console.error(`deploy-gate: NEEDS_JSON is not valid JSON (${err.message}).`);
    process.exit(1);
  }

  const result = evaluateDeployGate(needs);
  console.log(result.message);
  if (!result.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
