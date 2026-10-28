// The link between a log line and the alarm that reads it (NOS-69, AC 3).
//
// A log-based metric is a filter over fields: `jsonPayload.event="..."`. That
// makes a field name and an event string part of the deployed contract, and
// nothing else in this repository knows it. Rename `cron.sweep.completed`, or
// teach the logger to nest its fields under a `data` key, and:
//
//   - every unit test still passes,
//   - `terraform plan` still shows no change,
//   - the metric silently matches nothing,
//   - and `sweep_absent` - the alarm watching the only automatic rescue for a
//     guest who was charged and never came back - never fires again.
//
// So this test reads the Terraform files themselves rather than a hand-written
// list, because a hand-written list is exactly what went stale in NOS-11.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logLine } from "./log";

const INFRA = join(process.cwd(), "infra");
const SRC = join(process.cwd(), "src");

/** Every `jsonPayload.<field>="<value>"` a Terraform filter depends on. */
type Dependency = { field: string; value: string; file: string };

function filesUnder(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, extension));
    else if (entry.name.endsWith(extension)) out.push(path);
  }
  return out;
}

function logDependencies(): Dependency[] {
  const pattern = /jsonPayload\.([A-Za-z0-9_.]+)\s*=\s*"([^"]*)"/g;
  const found: Dependency[] = [];
  for (const file of filesUnder(INFRA, ".tf")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(pattern)) {
      found.push({ field: match[1], value: match[2], file });
    }
  }
  return found;
}

/**
 * The app's own source, minus the logger and minus the tests.
 *
 * The logger is excluded deliberately: its comments quote these very event
 * names to explain why they matter, and a guard that can be satisfied by a
 * comment inside the thing it is guarding is not a guard.
 */
function appSource(): string {
  return filesUnder(SRC, ".ts")
    .filter((file) => !file.endsWith(".test.ts") && !file.endsWith("log.ts"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
}

/**
 * Every literal event name a filter stands for, with `${each.key}` expanded.
 *
 * The metric is written once with `for_each = local.cron_jobs`, so the filter
 * literally reads `cron.${each.key}.completed` and stands for one event name
 * per job.
 *
 * A WILDCARD WOULD NOT DO, and that is not a theoretical point. The first
 * version of this test turned the interpolation into `cron\..+\.completed` and
 * passed happily while `cron.sweep.completed` was renamed in the route, because
 * `cron.reconcile.completed` still matched the pattern. A guard that either of
 * two jobs can satisfy on behalf of both is not a guard.
 */
function expansionsOf(value: string, tf: string): string[] {
  if (!value.includes("${")) return [value];

  const forEach = /for_each\s*=\s*local\.([A-Za-z_][\w-]*)/.exec(tf);
  const keys = forEach ? topLevelKeys(blockOf(tf, `${forEach[1]} = {`)) : [];
  // Loud rather than lenient: an interpolation this cannot expand means the
  // guard does not know what it is guarding, and the caller asserts on that.
  return keys.map((key) => value.replace("${each.key}", key));
}

/** The text between the braces that follow `opening`. */
function blockOf(source: string, opening: string): string {
  const start = source.indexOf(opening);
  if (start === -1) return "";
  const begin = source.indexOf("{", start);
  let depth = 0;
  for (let i = begin; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(begin + 1, i);
    }
  }
  return "";
}

/**
 * The `name = {` keys at a block's own level.
 *
 * Brace counting rather than indentation, so reformatting the file does not
 * change the answer. A brace inside a comment would confuse it; there is none
 * in the block it reads, and the failure direction is a test that fails rather
 * than one that quietly stops checking.
 */
function topLevelKeys(block: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] === "{") {
      depth += 1;
      continue;
    }
    if (block[i] === "}") {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const ahead = /^([A-Za-z_][\w-]*)\s*=\s*\{/.exec(block.slice(i));
    if (ahead) {
      keys.push(ahead[1]);
      i += ahead[0].length - 1;
      depth += 1;
    }
  }
  return keys;
}

describe("the log fields Terraform depends on (AC 3)", () => {
  const dependencies = logDependencies();

  it("found the filters at all, so this file cannot pass by matching nothing", () => {
    // The failure mode of every scanning test: the parser stops matching, the
    // suite goes green, and the guard is gone. Two is what exists today - one
    // `event` and one `via`, both inside the metric that `for_each` writes once
    // per cron job, so two lines of Terraform become four filters at apply time.
    expect(dependencies.length).toBeGreaterThanOrEqual(2);
    expect(dependencies.map((d) => d.field)).toContain("event");
    expect(dependencies.map((d) => d.field)).toContain("via");
  });

  it("depends only on fields the logger writes at the top level", () => {
    for (const { field, value, file } of dependencies) {
      expect(field, `${file} filters jsonPayload.${field}, which is nested`).not.toContain(".");

      // `event` and `message` are the logger's own arguments, not caller
      // fields: it writes them last precisely so a stray field cannot displace
      // them. Probing them through the fields bag would assert the opposite of
      // the guarantee.
      const line =
        field === "event"
          ? logLine("INFO", value, "probe")
          : field === "message"
            ? logLine("INFO", "probe.event", value)
            : logLine("INFO", "probe.event", "probe", { [field]: value });
      const entry = JSON.parse(line);
      expect(entry[field], `the logger must write ${field} at the top level`).toBe(value);
    }
  });

  it("depends only on event names the application still logs", () => {
    // Catches the other half: not the mechanism moving, but the string being
    // renamed. Fails until whoever renamed it updates the Terraform too.
    const source = appSource();
    for (const { field, value, file } of dependencies) {
      if (field !== "event") continue;
      const events = expansionsOf(value, readFileSync(file, "utf8"));
      expect(events, `${file} filters on "${value}" and this test cannot expand it`).not.toHaveLength(0);
      for (const event of events) {
        expect(
          source.includes(`"${event}"`),
          `${file} filters on event "${event}", which no longer appears in src`,
        ).toBe(true);
      }
    }
  });

  it("writes `via` on the completed lines, which is what keeps a manual run from feeding the metric", () => {
    // NOS-65's reason for the field: a GitHub `workflow_dispatch` run must not
    // keep the Scheduler alarm quiet.
    const entry = JSON.parse(logLine("INFO", "cron.sweep.completed", "done", { via: "oidc", recovered: 0 }));
    expect(entry).toMatchObject({ event: "cron.sweep.completed", via: "oidc" });
  });
});
