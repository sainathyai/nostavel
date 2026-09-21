import { describe, expect, it } from "vitest";
import { callTool, TOOLS } from "./index.ts";
import { readConfig } from "./config.ts";
import type { Issue, Tracker } from "./tracker.ts";

const issue: Issue = { key: "NOS-1", type: "Bug", title: "t", status: "Ready", labels: [], url: "u" };

/** Records what the tool layer asked the tracker to do. */
function recorder() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const note = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
    return Promise.resolve(issue);
  };
  const tracker = {
    search: note("search"),
    get: note("get"),
    create: note("create"),
    update: note("update"),
    transition: note("transition"),
    comment: note("comment"),
    linkUrl: note("linkUrl"),
  } as unknown as Tracker;
  return { tracker, calls };
}

describe("tool surface", () => {
  it("names tools after the job, not the vendor", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "tracker_search",
      "tracker_get",
      "tracker_create",
      "tracker_update",
      "tracker_transition",
      "tracker_comment",
      "tracker_link_pr",
    ]);
    const text = JSON.stringify(TOOLS).toLowerCase();
    expect(text).not.toContain("jira");
    expect(text).not.toContain("atlassian");
  });

  it("offers no way to delete anything", () => {
    expect(TOOLS.some((t) => /delete|remove|archive/.test(t.name))).toBe(false);
  });

  it("describes every tool and marks its required arguments", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("argument handling", () => {
  it("passes only the filters that were given", async () => {
    const { tracker, calls } = recorder();
    await callTool(tracker, "tracker_search", { status: "Ready", limit: 5 });
    expect(calls[0]).toEqual({ op: "search", args: [{ status: "Ready", limit: 5 }] });
  });

  it("rejects a work type the project does not have", async () => {
    const { tracker } = recorder();
    await expect(callTool(tracker, "tracker_create", { type: "Incident", title: "x" })).rejects.toThrow(/type must be one of/);
  });

  it("rejects labels that are not strings", async () => {
    const { tracker } = recorder();
    await expect(callTool(tracker, "tracker_create", { type: "Bug", title: "x", labels: [1] })).rejects.toThrow(/array of strings/);
  });

  it("requires a key", async () => {
    const { tracker } = recorder();
    await expect(callTool(tracker, "tracker_get", {})).rejects.toThrow(/key is required/);
  });

  it("refuses an unknown tool name", async () => {
    const { tracker } = recorder();
    await expect(callTool(tracker, "tracker_delete", { key: "NOS-1" })).rejects.toThrow(/unknown tool/);
  });
});

describe("configuration", () => {
  const base = { JIRA_SITE: "syrav.atlassian.net", JIRA_EMAIL: "o@example.com", JIRA_API_TOKEN: "t" };

  it("names the variable that is missing", () => {
    expect(() => readConfig({ ...base, JIRA_API_TOKEN: "" })).toThrow(/JIRA_API_TOKEN not set/);
  });

  it("accepts a site pasted as a URL", () => {
    expect(readConfig({ ...base, JIRA_SITE: "https://syrav.atlassian.net/" }).site).toBe("syrav.atlassian.net");
  });

  it("rejects a site that is not an Atlassian host", () => {
    expect(() => readConfig({ ...base, JIRA_SITE: "evil.example.com" })).toThrow(/should be a host like/);
  });

  it("defaults the project to NOS", () => {
    expect(readConfig(base).projectKey).toBe("NOS");
  });
});
