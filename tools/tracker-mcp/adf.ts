// Markdown -> Atlassian Document Format.
//
// Every ticket, comment and handoff block in this repository is written as
// Markdown (the skill templates in .agents/skills are Markdown files). Jira's
// REST v3 API accepts rich text only as ADF, a JSON document tree, so tickets
// would arrive as one unreadable blob without this. It covers what the
// templates actually use: headings, paragraphs, bullet and numbered lists,
// tables, fenced code, rules, blockquotes, and inline bold / italic / code /
// links / checkbox lines. Anything else degrades to plain text rather than
// throwing, because losing formatting is better than losing a ticket.

export type AdfNode = {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  attrs?: Record<string, unknown>;
};

export type AdfDoc = { type: "doc"; version: 1; content: AdfNode[] };

type Mark = { type: string; attrs?: Record<string, unknown> };

const text = (value: string, marks?: Mark[]): AdfNode =>
  marks && marks.length ? { type: "text", text: value, marks } : { type: "text", text: value };

/**
 * Inline markup within one line. Order matters: code spans are taken first so
 * that `**not bold**` inside backticks stays literal.
 */
export function inlineNodes(line: string): AdfNode[] {
  const out: AdfNode[] = [];
  // code | link | bold | italic (underscore form only, so file_name_here is safe)
  const pattern = /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\b_([^_]+)_\b)/g;
  let last = 0;
  for (let m = pattern.exec(line); m; m = pattern.exec(line)) {
    if (m.index > last) out.push(text(line.slice(last, m.index)));
    if (m[1]) out.push(text(m[1].slice(1, -1), [{ type: "code" }]));
    else if (m[2]) out.push(text(m[3], [{ type: "link", attrs: { href: m[4] } }]));
    else if (m[5]) out.push(text(m[6], [{ type: "strong" }]));
    else if (m[7]) out.push(text(m[8], [{ type: "em" }]));
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(text(line.slice(last)));
  return out.length ? out : [text("")];
}

const paragraph = (line: string): AdfNode => ({ type: "paragraph", content: inlineNodes(line) });

const cell = (value: string, header: boolean): AdfNode => ({
  type: header ? "tableHeader" : "tableCell",
  attrs: {},
  content: [{ type: "paragraph", content: inlineNodes(value.trim()) }],
});

const splitRow = (line: string): string[] =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");

const isDivider = (line: string | undefined): boolean =>
  !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

const isTableRow = (line: string | undefined): boolean => !!line && /^\s*\|.*\|\s*$/.test(line);

const listItem = (content: AdfNode[]): AdfNode => ({ type: "listItem", content });

/** Markdown (as written in our skill templates) to an ADF document. */
export function toAdf(markdown: string): AdfDoc {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Fenced code. An unclosed fence runs to the end rather than failing.
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      content.push({
        type: "codeBlock",
        attrs: fence[1] ? { language: fence[1] } : {},
        content: body.length ? [text(body.join("\n"))] : [],
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inlineNodes(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      content.push({ type: "rule" });
      i += 1;
      continue;
    }

    // Table: a header row, a divider, then body rows.
    if (isTableRow(line) && isDivider(lines[i + 1])) {
      const rows: AdfNode[] = [
        { type: "tableRow", content: splitRow(line).map((c) => cell(c, true)) },
      ];
      i += 2;
      while (isTableRow(lines[i])) {
        rows.push({ type: "tableRow", content: splitRow(lines[i]).map((c) => cell(c, false)) });
        i += 1;
      }
      content.push({ type: "table", attrs: { isNumberColumnEnabled: false, layout: "default" }, content: rows });
      continue;
    }

    // Lists. A "- [ ] item" line becomes a task list, which Jira renders with
    // real checkboxes, so a Definition of Ready stays tickable in the ticket.
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isTask = !!bullet && /^\[[ xX]\]\s*/.test(bullet[1]);
      const items: AdfNode[] = [];
      const localId = () => `t${content.length}-${items.length}`;
      while (i < lines.length) {
        const b = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        const o = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i]);
        if (bullet && !b) break;
        if (ordered && !o) break;
        const raw = b ? b[1] : o![2];
        const task = /^\[([ xX])\]\s*(.*)$/.exec(raw);
        if (isTask !== !!task) break;
        if (task) {
          items.push({
            type: "taskItem",
            attrs: { localId: localId(), state: task[1].toLowerCase() === "x" ? "DONE" : "TODO" },
            content: inlineNodes(task[2]),
          });
        } else {
          items.push(listItem([paragraph(raw)]));
        }
        i += 1;
      }
      const type = isTask ? "taskList" : bullet ? "bulletList" : "orderedList";
      const attrs = isTask ? { localId: `tl${content.length}` } : ordered ? { order: Number(ordered[1]) } : undefined;
      content.push(attrs ? { type, attrs, content: items } : { type, content: items });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      const body: string[] = [quote[1]];
      i += 1;
      for (let q = /^\s*>\s?(.*)$/.exec(lines[i] ?? ""); q; q = /^\s*>\s?(.*)$/.exec(lines[i] ?? "")) {
        body.push(q[1]);
        i += 1;
      }
      content.push({ type: "blockquote", content: [paragraph(body.join(" ").trim())] });
      continue;
    }

    // Plain paragraph: consecutive non-blank lines that start no other block.
    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|[-*]\s|\d+[.)]\s|\|)/.test(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    content.push(paragraph(para.join(" ")));
  }

  return { type: "doc", version: 1, content: content.length ? content : [paragraph("")] };
}

/** ADF back to Markdown-ish plain text, for showing an existing issue to an agent. */
export function fromAdf(node: unknown): string {
  const walk = (n: AdfNode, depth = 0): string => {
    switch (n.type) {
      case "doc":
        return (n.content ?? []).map((c) => walk(c, depth)).join("\n\n");
      case "heading":
        return `${"#".repeat(Number(n.attrs?.level ?? 1))} ${(n.content ?? []).map((c) => walk(c, depth)).join("")}`;
      case "paragraph":
        return (n.content ?? []).map((c) => walk(c, depth)).join("");
      case "text": {
        const value = n.text ?? "";
        const marks = (n.marks ?? []).map((m) => m.type);
        if (marks.includes("code")) return `\`${value}\``;
        if (marks.includes("link")) return `[${value}](${String(n.marks?.find((m) => m.type === "link")?.attrs?.href ?? "")})`;
        if (marks.includes("strong")) return `**${value}**`;
        if (marks.includes("em")) return `_${value}_`;
        return value;
      }
      case "bulletList":
      case "taskList":
        return (n.content ?? []).map((c) => `- ${walk(c, depth + 1)}`).join("\n");
      case "orderedList":
        return (n.content ?? []).map((c, idx) => `${idx + 1}. ${walk(c, depth + 1)}`).join("\n");
      case "listItem":
      case "taskItem":
        return (n.content ?? []).map((c) => walk(c, depth)).join(" ").trim();
      case "codeBlock":
        return "```\n" + (n.content ?? []).map((c) => c.text ?? "").join("") + "\n```";
      case "blockquote":
        return `> ${(n.content ?? []).map((c) => walk(c, depth)).join(" ")}`;
      case "rule":
        return "---";
      case "table":
        return (n.content ?? [])
          .map((row) => `| ${(row.content ?? []).map((c) => walk(c, depth).replace(/\n+/g, " ")).join(" | ")} |`)
          .join("\n");
      case "tableRow":
        return (n.content ?? []).map((c) => walk(c, depth)).join(" | ");
      case "tableHeader":
      case "tableCell":
        return (n.content ?? []).map((c) => walk(c, depth)).join(" ");
      case "hardBreak":
        return "\n";
      default:
        return (n.content ?? []).map((c) => walk(c, depth)).join("");
    }
  };
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  return walk(node as AdfNode).trim();
}
