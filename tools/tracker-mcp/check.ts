#!/usr/bin/env node
// npm run tracker:check - is the tracker reachable, and is the project set up
// the way the roles expect? Prints no secret values, only whether they are set.
//
// Not part of `npm run verify`: it needs the network and real credentials, and
// verify must pass in CI and in a fresh clone with no .env.local.

import { loadEnvFile, readConfig, repoRoot } from "./config.ts";
import { JiraTracker } from "./jira.ts";
import { TrackerError } from "./tracker.ts";

const WANTED_STATUSES = ["To Do", "Ready", "In Progress", "In Review", "Done"];

async function main(): Promise<void> {
  loadEnvFile(repoRoot(import.meta.dirname));
  const config = readConfig();
  console.log(`site:    ${config.site}`);
  console.log(`account: ${config.email.replace(/^(.).*@/, "$1***@")}`);
  console.log(`token:   set (${process.env.JIRA_API_TOKEN?.length ?? 0} chars)`);
  console.log(`project: ${config.projectKey}`);

  const tracker = new JiraTracker(config);
  const issues = await tracker.search({ limit: 5 });
  console.log(`\nreachable: yes - ${issues.length} issue(s) read back`);
  for (const issue of issues) console.log(`  ${issue.key} [${issue.status}] ${issue.title}`);

  if (issues.length) {
    const statuses = new Set(issues.map((i) => i.status));
    const unexpected = [...statuses].filter((s) => !WANTED_STATUSES.includes(s));
    if (unexpected.length) console.log(`\nnote: statuses not in the agreed set: ${unexpected.join(", ")}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${error instanceof TrackerError ? "" : "unexpected error: "}${message}\n`);
  process.exit(1);
});
