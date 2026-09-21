import { describe, expect, it } from "vitest";
import { fromAdf, inlineNodes, toAdf } from "./adf.ts";

const first = (markdown: string) => toAdf(markdown).content[0];

describe("markdown to ADF", () => {
  it("makes a heading with its level", () => {
    expect(first("### Acceptance criteria")).toMatchObject({
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Acceptance criteria" }],
    });
  });

  it("keeps a ticket table as a real table with a header row", () => {
    const table = first("| # | Given | Then |\n|---|---|---|\n| 1 | a guest books | the price is held |");
    expect(table.type).toBe("table");
    expect(table.content).toHaveLength(2);
    expect(table.content?.[0].content?.[0].type).toBe("tableHeader");
    expect(table.content?.[1].content?.[2]).toMatchObject({
      type: "tableCell",
      content: [{ content: [{ text: "the price is held" }] }],
    });
  });

  it("turns a Definition of Ready into tickable checkboxes", () => {
    const list = first("- [ ] Problem stated\n- [x] Risk field set");
    expect(list.type).toBe("taskList");
    expect(list.content?.[0].attrs?.state).toBe("TODO");
    expect(list.content?.[1].attrs?.state).toBe("DONE");
    expect(list.content?.[1].content?.[0].text).toBe("Risk field set");
  });

  it("keeps plain bullets separate from checkboxes", () => {
    const doc = toAdf("- plain item\n- [ ] task item");
    expect(doc.content.map((n) => n.type)).toEqual(["bulletList", "taskList"]);
  });

  it("keeps a fenced code block verbatim, with its language", () => {
    expect(first("```ts\nconst a = 1;\nconst b = 2;\n```")).toMatchObject({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ text: "const a = 1;\nconst b = 2;" }],
    });
  });

  it("does not read markup inside code spans", () => {
    expect(inlineNodes("call `**not bold**` here")).toMatchObject([
      { text: "call " },
      { text: "**not bold**", marks: [{ type: "code" }] },
      { text: " here" },
    ]);
  });

  it("marks bold text and links", () => {
    expect(inlineNodes("**Risk:** see [the rule](docs/conventions.md)")).toMatchObject([
      { text: "Risk:", marks: [{ type: "strong" }] },
      { text: " see " },
      { text: "the rule", marks: [{ type: "link", attrs: { href: "docs/conventions.md" } }] },
    ]);
  });

  it("leaves snake_case identifiers alone", () => {
    expect(inlineNodes("the booking_events table")).toEqual([{ type: "text", text: "the booking_events table" }]);
  });

  it("joins wrapped lines into one paragraph", () => {
    const doc = toAdf("A problem statement\nthat wrapped.\n\nA second one.");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0].content?.[0].text).toBe("A problem statement that wrapped.");
  });

  it("never produces an empty document", () => {
    expect(toAdf("").content).toHaveLength(1);
  });
});

describe("ADF back to markdown", () => {
  it("round-trips the parts of a ticket a role needs to read", () => {
    const markdown = [
      "## Problem",
      "",
      "The prompt freezes **today's date** at server start.",
      "",
      "- first",
      "- second",
      "",
      "| # | Then |",
      "|---|---|",
      "| 1 | it uses the request time |",
    ].join("\n");
    const text = fromAdf(toAdf(markdown));
    expect(text).toContain("## Problem");
    expect(text).toContain("**today's date**");
    expect(text).toContain("- first");
    expect(text).toContain("| 1 | it uses the request time |");
  });

  it("survives a shape it does not know", () => {
    expect(fromAdf({ type: "doc", version: 1, content: [{ type: "panel", content: [{ type: "text", text: "hi" }] }] })).toBe("hi");
    expect(fromAdf(undefined)).toBe("");
  });
});
