// The tracker contract, in the project's own words rather than any vendor's.
//
// Roles talk to a tracker through these seven operations (see the tool list in
// index.ts). Jira is one implementation (jira.ts). Moving to GitHub Issues,
// Linear or anything else means writing another adapter against this file;
// the roles, skills and rules never mention a vendor, which is the neutrality
// rule in .agents/README.md.

export type IssueType = "Epic" | "Story" | "Bug" | "Task" | "Subtask";

export type Issue = {
  key: string;
  type: string;
  title: string;
  status: string;
  labels: string[];
  parent?: string;
  /** Markdown, converted from whatever the backend stores. */
  body?: string;
  url: string;
  updated?: string;
};

export type SearchQuery = {
  /** Free text over title and body. */
  text?: string;
  status?: string;
  labels?: string[];
  type?: string;
  /** Children of this issue key. */
  parent?: string;
  limit?: number;
};

export type CreateIssue = {
  type: IssueType;
  title: string;
  /** Markdown; the adapter converts it to the backend's format. */
  body?: string;
  labels?: string[];
  /** Parent key: the epic for a story, or the story for a sub-task. */
  parent?: string;
};

export type UpdateIssue = {
  key: string;
  title?: string;
  body?: string;
  labels?: string[];
  /** Re-parent: the epic for a story, or the story for a sub-task. */
  parent?: string;
};

export interface Tracker {
  search(query: SearchQuery): Promise<Issue[]>;
  get(key: string): Promise<Issue>;
  create(input: CreateIssue): Promise<Issue>;
  update(input: UpdateIssue): Promise<Issue>;
  /** Move an issue to a status by name; lists the legal names when it cannot. */
  transition(key: string, status: string): Promise<Issue>;
  /** Append a comment. Markdown in. */
  comment(key: string, body: string): Promise<{ key: string; url: string }>;
  /** Attach a pull request (or any URL) to the issue as a link. */
  linkUrl(key: string, url: string, title: string): Promise<{ key: string; url: string }>;
}

/** Thrown for anything the caller can fix: bad key, unknown status, missing config. */
export class TrackerError extends Error {}
