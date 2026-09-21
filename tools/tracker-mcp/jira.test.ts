import { beforeEach, describe, expect, it } from "vitest";
import { buildJql, JiraTracker, jqlString } from "./jira.ts";
import { TrackerError } from "./tracker.ts";

type Call = { url: string; method: string; body: unknown };

/** A fake Jira: records calls, answers from a route table. */
function fakeJira(routes: Record<string, unknown | ((call: Call) => unknown)> = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.endsWith("/_edge/tenant_info")) {
      return new Response(JSON.stringify({ cloudId: "cloud-1" }), { status: 200 });
    }
    const path = url.replace("https://api.atlassian.com/ex/jira/cloud-1", "");
    const key = Object.keys(routes).find((r) => path.startsWith(r.split(" ").slice(1).join(" ")) && r.startsWith(method));
    const route = key ? routes[key] : undefined;
    if (route === undefined) return new Response(JSON.stringify({ key: "NOS-1", fields: {} }), { status: 200 });
    const value = typeof route === "function" ? (route as (c: Call) => unknown)({ url: path, method, body }) : route;
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200 });
  }) as typeof globalThis.fetch;

  return { fetch, calls };
}

const issue = (over: Record<string, unknown> = {}) => ({
  key: "NOS-1",
  fields: {
    summary: "Fix the prompt date",
    status: { name: "Ready" },
    labels: ["ai"],
    issuetype: { name: "Bug" },
    ...over,
  },
});

let jira: ReturnType<typeof fakeJira>;
const tracker = (routes?: Record<string, unknown | ((call: Call) => unknown)>) => {
  jira = fakeJira(routes);
  return new JiraTracker({
    site: "syrav.atlassian.net",
    email: "owner@example.com",
    token: "secret-token",
    projectKey: "NOS",
    fetch: jira.fetch,
  });
};

beforeEach(() => {
  jira = fakeJira();
});

describe("query building", () => {
  it("escapes quotes so a title cannot break out of the query", () => {
    expect(jqlString('a "quoted" value')).toBe('"a \\"quoted\\" value"');
  });

  it("always scopes to the project and ANDs the filters", () => {
    expect(buildJql({ status: "Ready", labels: ["money", "security"], text: "refund" }, "NOS")).toBe(
      'project = NOS AND status = "Ready" AND labels = "money" AND labels = "security" AND text ~ "refund" ORDER BY created ASC',
    );
  });
});

describe("safety", () => {
  it("refuses an issue key from another project", async () => {
    await expect(tracker().get("ABC-4")).rejects.toThrow(/only works in the NOS project/);
  });

  it("refuses something that is not an issue key at all", async () => {
    await expect(tracker().get("../../admin")).rejects.toBeInstanceOf(TrackerError);
  });

  it("forces every new issue into the allowed project", async () => {
    const t = tracker({ "POST /rest/api/3/issue": { key: "NOS-7" }, "GET /rest/api/3/issue/NOS-7": issue({ summary: "x" }) });
    await t.create({ type: "Story", title: "Something", labels: ["ui"] });
    const post = jira.calls.find((c) => c.method === "POST")!;
    expect((post.body as { fields: { project: { key: string } } }).fields.project.key).toBe("NOS");
  });

  it("rejects a link that is not an http URL", async () => {
    await expect(tracker().linkUrl("NOS-1", "file:///etc/passwd", "x")).rejects.toThrow(/not an http/);
  });

  it("never echoes the credential in an error", async () => {
    const t = tracker({
      "GET /rest/api/3/issue/NOS-1": new Response("bad token secret-token rejected", { status: 500 }),
    });
    await expect(t.get("NOS-1")).rejects.toThrow(/\*\*\*/);
    await expect(t.get("NOS-1")).rejects.not.toThrow(/secret-token/);
  });

  it("explains an expired token instead of the raw status", async () => {
    const t = tracker({ "GET /rest/api/3/issue/NOS-1": new Response("Unauthorized", { status: 401 }) });
    await expect(t.get("NOS-1")).rejects.toThrow(/may have expired/);
  });
});

describe("calls", () => {
  it("talks to api.atlassian.com, because scoped tokens are rejected on the site host", async () => {
    const t = tracker({ "GET /rest/api/3/issue/NOS-1": issue() });
    await t.get("NOS-1");
    expect(jira.calls[0].url).toBe("https://syrav.atlassian.net/_edge/tenant_info");
    expect(jira.calls[1].url).toContain("https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/NOS-1");
  });

  it("resolves the cloud id once and reuses it", async () => {
    const t = tracker({ "GET /rest/api/3/issue/NOS-1": issue() });
    await t.get("NOS-1");
    await t.get("NOS-1");
    expect(jira.calls.filter((c) => c.url.includes("tenant_info"))).toHaveLength(1);
  });

  it("uses the replacement search endpoint, not the removed one", async () => {
    const t = tracker({ "GET /rest/api/3/search/jql": { issues: [issue()] } });
    const found = await t.search({ status: "Ready" });
    expect(jira.calls[1].url).toContain("/rest/api/3/search/jql?");
    expect(found[0]).toMatchObject({ key: "NOS-1", status: "Ready", labels: ["ai"], url: "https://syrav.atlassian.net/browse/NOS-1" });
  });

  it("sends the body as rich text, not a string", async () => {
    const t = tracker({ "POST /rest/api/3/issue": { key: "NOS-7" }, "GET /rest/api/3/issue/NOS-7": issue() });
    await t.create({ type: "Bug", title: "t", body: "## Problem\n\nIt breaks." });
    const fields = (jira.calls.find((c) => c.method === "POST")!.body as { fields: { description: { type: string } } }).fields;
    expect(fields.description).toMatchObject({ type: "doc", version: 1 });
  });

  it("reads a description back as markdown", async () => {
    const t = tracker({
      "GET /rest/api/3/issue/NOS-1": issue({
        description: { type: "doc", version: 1, content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Problem" }] }] },
      }),
    });
    expect((await t.get("NOS-1")).body).toBe("## Problem");
  });

  it("moves an issue by status name", async () => {
    const t = tracker({
      "GET /rest/api/3/issue/NOS-1/transitions": { transitions: [{ id: "31", name: "Start", to: { name: "In Progress" } }] },
      "GET /rest/api/3/issue/NOS-1": issue({ status: { name: "In Progress" } }),
    });
    const moved = await t.transition("NOS-1", "in progress");
    expect(jira.calls.find((c) => c.method === "POST")!.body).toEqual({ transition: { id: "31" } });
    expect(moved.status).toBe("In Progress");
  });

  it("lists the legal statuses when the move is not allowed", async () => {
    const t = tracker({
      "GET /rest/api/3/issue/NOS-1/transitions": { transitions: [{ id: "11", name: "Back", to: { name: "Ready" } }] },
    });
    await expect(t.transition("NOS-1", "Done")).rejects.toThrow(/Available now: Ready/);
  });

  it("refuses an update with nothing to change", async () => {
    await expect(tracker().update({ key: "NOS-1" })).rejects.toThrow(/at least one of/);
  });

  it("files an existing issue under an epic", async () => {
    const t = tracker({ "PUT /rest/api/3/issue/NOS-1": {}, "GET /rest/api/3/issue/NOS-1": issue({ parent: { key: "NOS-4" } }) });
    const updated = await t.update({ key: "NOS-1", parent: "NOS-4" });
    expect(jira.calls.find((c) => c.method === "PUT")!.body).toEqual({ fields: { parent: { key: "NOS-4" } } });
    expect(updated.parent).toBe("NOS-4");
  });

  it("refuses a parent in another project", async () => {
    await expect(tracker().update({ key: "NOS-1", parent: "ABC-1" })).rejects.toThrow(/only works in the NOS project/);
  });
});
