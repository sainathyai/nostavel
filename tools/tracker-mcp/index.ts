#!/usr/bin/env node
// nostavel-tracker: the team's ticket tracker, exposed to any agent tool over MCP.
//
// Tool names and arguments are deliberately vendor-neutral (tracker_create, not
// jira_create_issue), so roles and skills never learn a vendor's vocabulary and
// a different tracker is one adapter away. Jira is today's backend (jira.ts).
//
// Run: node tools/tracker-mcp/index.ts        (Node 24 runs TypeScript directly)
// Config: JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN in .env.local, read by this
// process, never handed to the agent tool.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvFile, readConfig, repoRoot } from "./config.ts";
import { JiraTracker } from "./jira.ts";
import type { CreateIssue, IssueType, Tracker } from "./tracker.ts";
import { TrackerError } from "./tracker.ts";

const ISSUE_TYPES: IssueType[] = ["Epic", "Story", "Bug", "Task", "Subtask"];

const string = (description: string) => ({ type: "string" as const, description });
const stringArray = (description: string) => ({
  type: "array" as const,
  items: { type: "string" as const },
  description,
});

export const TOOLS = [
  {
    name: "tracker_search",
    description:
      "Find issues in the team's tracker. Filters combine with AND; omit all of them to list the project. " +
      "Use this before creating anything, so duplicates are not filed.",
    inputSchema: {
      type: "object",
      properties: {
        text: string("free text matched against title and description"),
        status: string("exact status name, e.g. Ready, In Progress, In Review, Done"),
        type: string("work type, e.g. Story, Bug, Task, Epic"),
        labels: stringArray("issues carrying all of these labels"),
        parent: string("issue key whose children to list, e.g. NOS-4"),
        limit: { type: "number", description: "maximum issues to return (default 25, max 100)" },
      },
    },
  },
  {
    name: "tracker_get",
    description: "Read one issue in full, including its description as Markdown.",
    inputSchema: {
      type: "object",
      properties: { key: string("issue key, e.g. NOS-12") },
      required: ["key"],
    },
  },
  {
    name: "tracker_create",
    description:
      "File a new issue. The body is Markdown and may use headings, tables, lists and checkboxes; it is converted " +
      "to the tracker's own format. Give labels that match the review gates (money, security, ui, migration, ai).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ISSUE_TYPES, description: "work type" },
        title: string("one imperative line, no key prefix"),
        body: string("the ticket, in Markdown (see the write-ticket skill's template)"),
        labels: stringArray("labels, lower case"),
        parent: string("parent key: the epic for a story, or the story for a Subtask"),
      },
      required: ["type", "title"],
    },
  },
  {
    name: "tracker_update",
    description:
      "Change an existing issue's title, body, labels or parent. Only the fields given are touched; use it to " +
      "file an issue under an epic after the fact.",
    inputSchema: {
      type: "object",
      properties: {
        key: string("issue key"),
        title: string("new title"),
        body: string("new body, in Markdown; replaces the old one"),
        labels: stringArray("the complete new label set; replaces the old one"),
        parent: string("new parent key: the epic for a story, or the story for a Subtask"),
      },
      required: ["key"],
    },
  },
  {
    name: "tracker_transition",
    description:
      "Move an issue to another status by name (To Do, Ready, In Progress, In Review, Done). " +
      "If the move is not allowed from where the issue is, the error lists what is.",
    inputSchema: {
      type: "object",
      properties: { key: string("issue key"), status: string("target status name") },
      required: ["key", "status"],
    },
  },
  {
    name: "tracker_comment",
    description:
      "Append a comment, in Markdown. This is where handoff blocks go, so the next role and the owner can follow " +
      "the work without reading a chat transcript.",
    inputSchema: {
      type: "object",
      properties: { key: string("issue key"), body: string("comment text, in Markdown") },
      required: ["key", "body"],
    },
  },
  {
    name: "tracker_link_pr",
    description: "Attach a pull request (or any URL) to an issue, so the ticket shows where the change lives.",
    inputSchema: {
      type: "object",
      properties: {
        key: string("issue key"),
        url: string("the pull request URL"),
        title: string("short link label, e.g. 'PR #17: fix prompt date'"),
      },
      required: ["key", "url"],
    },
  },
] as const;

type Args = Record<string, unknown>;

const str = (args: Args, name: string): string => {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new TrackerError(`${name} is required.`);
  return value;
};

const optionalStr = (args: Args, name: string): string | undefined => {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TrackerError(`${name} must be a string.`);
  return value;
};

const optionalLabels = (args: Args): string[] | undefined => {
  const value = args.labels;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new TrackerError("labels must be an array of strings.");
  }
  return value as string[];
};

/** Run one tool call. Exported so the tests exercise the same path the agent does. */
export async function callTool(tracker: Tracker, name: string, args: Args = {}): Promise<unknown> {
  switch (name) {
    case "tracker_search":
      return tracker.search({
        ...(optionalStr(args, "text") ? { text: optionalStr(args, "text")! } : {}),
        ...(optionalStr(args, "status") ? { status: optionalStr(args, "status")! } : {}),
        ...(optionalStr(args, "type") ? { type: optionalStr(args, "type")! } : {}),
        ...(optionalStr(args, "parent") ? { parent: optionalStr(args, "parent")! } : {}),
        ...(optionalLabels(args) ? { labels: optionalLabels(args)! } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
    case "tracker_get":
      return tracker.get(str(args, "key"));
    case "tracker_create": {
      const type = str(args, "type") as IssueType;
      if (!ISSUE_TYPES.includes(type)) {
        throw new TrackerError(`type must be one of ${ISSUE_TYPES.join(", ")}, got "${type}".`);
      }
      const input: CreateIssue = { type, title: str(args, "title") };
      const body = optionalStr(args, "body");
      const parent = optionalStr(args, "parent");
      const labels = optionalLabels(args);
      if (body) input.body = body;
      if (parent) input.parent = parent;
      if (labels) input.labels = labels;
      return tracker.create(input);
    }
    case "tracker_update":
      return tracker.update({
        key: str(args, "key"),
        ...(optionalStr(args, "title") !== undefined ? { title: optionalStr(args, "title")! } : {}),
        ...(optionalStr(args, "body") !== undefined ? { body: optionalStr(args, "body")! } : {}),
        ...(optionalLabels(args) !== undefined ? { labels: optionalLabels(args)! } : {}),
        ...(optionalStr(args, "parent") !== undefined ? { parent: optionalStr(args, "parent")! } : {}),
      });
    case "tracker_transition":
      return tracker.transition(str(args, "key"), str(args, "status"));
    case "tracker_comment":
      return tracker.comment(str(args, "key"), str(args, "body"));
    case "tracker_link_pr":
      return tracker.linkUrl(str(args, "key"), str(args, "url"), optionalStr(args, "title") ?? "");
    default:
      throw new TrackerError(`unknown tool "${name}".`);
  }
}

async function main(): Promise<void> {
  loadEnvFile(repoRoot(import.meta.dirname));
  const server = new Server(
    { name: "nostavel-tracker", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Built on first use, so the server starts (and lists its tools) even when
  // the credentials are missing; the error then names the missing variable.
  let tracker: Tracker | undefined;
  const get = (): Tracker => (tracker ??= new JiraTracker(readConfig()));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callTool(get(), request.params.name, (request.params.arguments ?? {}) as Args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`nostavel-tracker failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
