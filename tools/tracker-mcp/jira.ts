// Jira Cloud adapter for the Tracker contract.
//
// Two details that are easy to get wrong and cost an afternoon each:
//  - Scoped API tokens are rejected on https://<site>.atlassian.net/rest/...
//    They work only against https://api.atlassian.com/ex/jira/<cloudId>/rest/...
//    so the cloud id is resolved once from the site's public tenant_info.
//  - /rest/api/3/search was removed (HTTP 410). Searching is
//    /rest/api/3/search/jql, paged with nextPageToken, not startAt.
//
// Safety, because agents call this: the project key is an allowlist, every
// issue key is checked against it, there is no delete of anything, and error
// text is scrubbed of the credential before it can reach a transcript.

import { fromAdf, toAdf } from "./adf.ts";
import type { CreateIssue, Issue, SearchQuery, Tracker, UpdateIssue } from "./tracker.ts";
import { TrackerError } from "./tracker.ts";

type Fetch = typeof globalThis.fetch;

export type JiraOptions = {
  site: string;
  email: string;
  token: string;
  projectKey: string;
  fetch?: Fetch;
};

const FIELDS = "summary,status,labels,issuetype,parent,description,updated";

type JiraIssue = {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    labels?: string[];
    issuetype?: { name?: string };
    parent?: { key?: string };
    description?: unknown;
    updated?: string;
  };
};

/** JQL string literal: backslashes and quotes escaped, per Jira's own rules. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildJql(query: SearchQuery, projectKey: string): string {
  const clauses = [`project = ${projectKey}`];
  if (query.type) clauses.push(`issuetype = ${jqlString(query.type)}`);
  if (query.status) clauses.push(`status = ${jqlString(query.status)}`);
  if (query.parent) clauses.push(`parent = ${jqlString(query.parent)}`);
  for (const label of query.labels ?? []) clauses.push(`labels = ${jqlString(label)}`);
  if (query.text) clauses.push(`text ~ ${jqlString(query.text)}`);
  return `${clauses.join(" AND ")} ORDER BY created ASC`;
}

export class JiraTracker implements Tracker {
  readonly projectKey: string;
  #site: string;
  #auth: string;
  #token: string;
  #fetch: Fetch;
  #base?: string;

  constructor(options: JiraOptions) {
    this.#site = options.site;
    this.projectKey = options.projectKey;
    this.#token = options.token;
    this.#auth = "Basic " + Buffer.from(`${options.email}:${options.token}`).toString("base64");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** Never let the credential out, whatever an upstream error body contains. */
  #scrub(text: string): string {
    return text.split(this.#token).join("***").split(this.#auth).join("***");
  }

  async #baseUrl(): Promise<string> {
    if (this.#base) return this.#base;
    const res = await this.#fetch(`https://${this.#site}/_edge/tenant_info`);
    if (!res.ok) {
      throw new TrackerError(`could not reach ${this.#site} (HTTP ${res.status}). Check JIRA_SITE in .env.local.`);
    }
    const { cloudId } = (await res.json()) as { cloudId?: string };
    if (!cloudId) throw new TrackerError(`${this.#site} did not return a cloud id; is the site name right?`);
    this.#base = `https://api.atlassian.com/ex/jira/${cloudId}`;
    return this.#base;
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch((await this.#baseUrl()) + path, {
      method,
      headers: {
        authorization: this.#auth,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await res.text();
    if (!res.ok) {
      const detail = this.#scrub(raw).slice(0, 600);
      if (res.status === 401 || res.status === 403) {
        throw new TrackerError(
          `tracker rejected the credentials (HTTP ${res.status}). The API token may have expired or lack the ` +
            `read:jira-work / write:jira-work scopes. Ask the owner to renew it in .env.local. ${detail}`,
        );
      }
      if (res.status === 404) throw new TrackerError(`not found: ${method} ${path}. ${detail}`);
      throw new TrackerError(`tracker call failed: ${method} ${path} (HTTP ${res.status}). ${detail}`);
    }
    return raw ? JSON.parse(raw) : {};
  }

  /** An agent may only touch this project, whatever key it passes. */
  #assertKey(key: string): string {
    const normalized = (key ?? "").trim().toUpperCase();
    if (!new RegExp(`^${this.projectKey}-\\d+$`).test(normalized)) {
      throw new TrackerError(
        `"${key}" is not an issue in ${this.projectKey}. This server only works in the ${this.projectKey} project.`,
      );
    }
    return normalized;
  }

  #toIssue(raw: JiraIssue): Issue {
    return {
      key: raw.key,
      type: raw.fields?.issuetype?.name ?? "",
      title: raw.fields?.summary ?? "",
      status: raw.fields?.status?.name ?? "",
      labels: raw.fields?.labels ?? [],
      ...(raw.fields?.parent?.key ? { parent: raw.fields.parent.key } : {}),
      ...(raw.fields?.description ? { body: fromAdf(raw.fields.description) } : {}),
      url: `https://${this.#site}/browse/${raw.key}`,
      ...(raw.fields?.updated ? { updated: raw.fields.updated } : {}),
    };
  }

  async search(query: SearchQuery): Promise<Issue[]> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const params = new URLSearchParams({
      jql: buildJql(query, this.projectKey),
      maxResults: String(limit),
      fields: FIELDS,
    });
    const page = (await this.#call("GET", `/rest/api/3/search/jql?${params}`)) as { issues?: JiraIssue[] };
    return (page.issues ?? []).map((i) => this.#toIssue(i));
  }

  async get(key: string): Promise<Issue> {
    const id = this.#assertKey(key);
    const raw = (await this.#call("GET", `/rest/api/3/issue/${id}?fields=${FIELDS}`)) as JiraIssue;
    return this.#toIssue(raw);
  }

  async create(input: CreateIssue): Promise<Issue> {
    const fields: Record<string, unknown> = {
      project: { key: this.projectKey },
      issuetype: { name: input.type },
      summary: input.title,
      labels: input.labels ?? [],
    };
    if (input.body) fields.description = toAdf(input.body);
    if (input.parent) fields.parent = { key: this.#assertKey(input.parent) };
    const created = (await this.#call("POST", "/rest/api/3/issue", { fields })) as { key?: string };
    if (!created.key) throw new TrackerError("the tracker accepted the issue but returned no key.");
    return this.get(created.key);
  }

  async update(input: UpdateIssue): Promise<Issue> {
    const id = this.#assertKey(input.key);
    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) fields.summary = input.title;
    if (input.body !== undefined) fields.description = toAdf(input.body);
    if (input.labels !== undefined) fields.labels = input.labels;
    if (input.parent !== undefined) fields.parent = { key: this.#assertKey(input.parent) };
    if (!Object.keys(fields).length) {
      throw new TrackerError("update needs at least one of title, body, labels or parent.");
    }
    await this.#call("PUT", `/rest/api/3/issue/${id}`, { fields });
    return this.get(id);
  }

  async transition(key: string, status: string): Promise<Issue> {
    const id = this.#assertKey(key);
    const { transitions = [] } = (await this.#call("GET", `/rest/api/3/issue/${id}/transitions`)) as {
      transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
    };
    const wanted = (status ?? "").trim().toLowerCase();
    const match = transitions.find(
      (t) => (t.to?.name ?? "").toLowerCase() === wanted || t.name.toLowerCase() === wanted,
    );
    if (!match) {
      const available = transitions.map((t) => t.to?.name ?? t.name).join(", ") || "none";
      throw new TrackerError(`${id} cannot move to "${status}" from here. Available now: ${available}.`);
    }
    await this.#call("POST", `/rest/api/3/issue/${id}/transitions`, { transition: { id: match.id } });
    return this.get(id);
  }

  async comment(key: string, body: string): Promise<{ key: string; url: string }> {
    const id = this.#assertKey(key);
    if (!body?.trim()) throw new TrackerError("a comment needs a body.");
    await this.#call("POST", `/rest/api/3/issue/${id}/comment`, { body: toAdf(body) });
    return { key: id, url: `https://${this.#site}/browse/${id}` };
  }

  async linkUrl(key: string, url: string, title: string): Promise<{ key: string; url: string }> {
    const id = this.#assertKey(key);
    if (!/^https?:\/\//.test(url ?? "")) throw new TrackerError(`"${url}" is not an http(s) URL.`);
    await this.#call("POST", `/rest/api/3/issue/${id}/remotelink`, {
      object: { url, title: title || url },
    });
    return { key: id, url: `https://${this.#site}/browse/${id}` };
  }
}
