// Credentials for the tracker server.
//
// The secret is read here, by the server process itself, from .env.local — the
// file the app already uses and that agents are blocked from reading (see
// scripts/agent-guards/rules.mjs). It is deliberately not passed through the
// agent tool's MCP config, so the token never enters an agent's environment
// where a shell command could print it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { TrackerError } from "./tracker.ts";

/** Just the variables we read, so tests can pass a plain object. */
export type Env = Record<string, string | undefined>;

export type Config = {
  site: string;
  email: string;
  token: string;
  projectKey: string;
};

const SETUP = "Add JIRA_SITE, JIRA_EMAIL and JIRA_API_TOKEN to .env.local by hand (see .env.example).";

/** Repo root, from this file's location: tools/tracker-mcp/ -> ../.. */
export function repoRoot(fromDir: string): string {
  return join(fromDir, "..", "..");
}

/** Load .env.local into process.env if it exists. Missing file is not an error. */
export function loadEnvFile(root: string): void {
  const file = join(root, ".env.local");
  if (!existsSync(file)) return;
  // Node's own parser: no dependency, and it never overwrites a variable that
  // is already set, so a CI secret wins over a local file.
  process.loadEnvFile(file);
}

export function readConfig(env: Env = process.env): Config {
  const site = (env.JIRA_SITE ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const email = (env.JIRA_EMAIL ?? "").trim();
  const token = (env.JIRA_API_TOKEN ?? "").trim();
  const projectKey = (env.TRACKER_PROJECT ?? "NOS").trim().toUpperCase();

  const missing = [
    ["JIRA_SITE", site],
    ["JIRA_EMAIL", email],
    ["JIRA_API_TOKEN", token],
  ].filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) throw new TrackerError(`tracker is not configured: ${missing.join(", ")} not set. ${SETUP}`);
  if (!/^[a-z0-9.-]+\.atlassian\.net$/i.test(site)) {
    throw new TrackerError(`JIRA_SITE should be a host like example.atlassian.net, got "${site}".`);
  }
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(projectKey)) {
    throw new TrackerError(`TRACKER_PROJECT should be a project key like NOS, got "${projectKey}".`);
  }
  return { site, email, token, projectKey };
}
