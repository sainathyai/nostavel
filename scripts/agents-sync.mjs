#!/usr/bin/env node
// Generates each coding-agent tool's config from the provider-neutral sources in
// .agents/ (see .agents/README.md and docs/adr/0001-provider-neutral-agent-layer.md).
//
//   node scripts/agents-sync.mjs          validate sources, write adapters
//   node scripts/agents-sync.mjs --check  validate sources, fail if adapters drifted (CI)
//
// Neutral sources are never tool-specific. Tool-specific output is only ever
// produced here, so moving to (or adding) another tool means adding an adapter
// function, not rewriting skills or roles. No dependencies: plain Node.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Frontmatter: the small YAML subset the neutral files use (scalars, inline
// [a, b] lists, block "- item" lists, one level of nested string maps).
// ---------------------------------------------------------------------------
function scalar(raw) {
  const v = raw.trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (/^\[.*\]$/.test(v)) {
    return v.slice(1, -1).split(",").map((s) => scalar(s)).filter((s) => s !== "");
  }
  return v;
}

export function parseFrontmatter(text) {
  const src = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { data: null, body: src };
  const data = {};
  let key = null;
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (top) {
      key = top[1];
      data[key] = top[2] === "" ? null : scalar(top[2]);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(scalar(item[1]));
      continue;
    }
    const sub = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (sub && key) {
      if (data[key] === null || typeof data[key] !== "object" || Array.isArray(data[key])) data[key] = {};
      data[key][sub[1]] = scalar(sub[2]);
      continue;
    }
    throw new Error(`unsupported frontmatter line: ${line}`);
  }
  return { data, body: m[2] };
}

function yamlValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(", ")}]`;
  const s = String(v);
  return /^[\w./@ -]*$/.test(s) && !/^\s|\s$/.test(s) && s !== "" && !/^(true|false|null|\d+)$/.test(s)
    ? s
    : JSON.stringify(s);
}

export function renderFrontmatter(data) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [sk, sv] of Object.entries(v)) lines.push(`  ${sk}: ${yamlValue(sv)}`);
    } else {
      lines.push(`${k}: ${yamlValue(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Validation of neutral sources.
// ---------------------------------------------------------------------------
// Agent Skills specification (agentskills.io/specification), standard fields only.
const SKILL_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const ROLE_KEYS = new Set(["name", "description", "tier", "capabilities", "skills", "owns"]);
const RULE_KEYS = new Set(["name", "description", "globs"]);
const CAPABILITIES = /^(read|edit|shell|web|mcp:[a-z0-9-]+)$/;
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Things that tie a neutral file to one provider or one tool's runtime.
const NOT_NEUTRAL = [
  [/\bclaude-(opus|sonnet|haiku)[\w.-]*/i, "a provider model id (use a tier)"],
  [/\bgpt-\d[\w.-]*/i, "a provider model id (use a tier)"],
  [/\bgemini-\d[\w.-]*/i, "a provider model id (use a tier)"],
  [/\$ARGUMENTS\b/, "a tool-specific argument placeholder"],
  [/!`[^`]+`/, "tool-specific inline command execution"],
  [/\b(Task|Agent|Bash|TodoWrite|SendMessage) tool\b/, "a tool-specific tool name (describe the capability)"],
  [/\b(run_shell_command|write_file|read_many_files)\b/, "a tool-specific tool name (describe the capability)"],
];

function checkNeutralText(file, text, errors) {
  for (const [re, what] of NOT_NEUTRAL) {
    const m = re.exec(text);
    if (m) errors.push(`${file}: contains ${what}: "${m[0]}"`);
  }
}

export function validateSkill(dirName, text, file, errors) {
  const { data, body } = parseFrontmatter(text);
  if (!data) return errors.push(`${file}: missing frontmatter`);
  for (const k of Object.keys(data)) {
    if (!SKILL_KEYS.has(k)) errors.push(`${file}: "${k}" is not an Agent Skills standard field (put tool-specific extras in adapters/<tool>.json)`);
  }
  if (!data.name || !NAME.test(data.name) || data.name.length > 64) errors.push(`${file}: name must be 1-64 lowercase letters, digits and hyphens`);
  if (data.name !== dirName) errors.push(`${file}: name "${data.name}" must match its folder "${dirName}"`);
  if (!data.description || String(data.description).length > 1024) errors.push(`${file}: description is required, max 1024 characters`);
  if (data.compatibility && String(data.compatibility).length > 500) errors.push(`${file}: compatibility max 500 characters`);
  if (body.split("\n").length > 500) errors.push(`${file}: keep SKILL.md under 500 lines (move detail into references/)`);
  checkNeutralText(file, text, errors);
}

export function validateRole(fileName, text, file, errors, tiers) {
  const { data } = parseFrontmatter(text);
  if (!data) return errors.push(`${file}: missing frontmatter`);
  for (const k of Object.keys(data)) if (!ROLE_KEYS.has(k)) errors.push(`${file}: unknown role field "${k}"`);
  if (!data.name || !NAME.test(data.name)) errors.push(`${file}: name must be lowercase words joined by hyphens`);
  if (!data.description) errors.push(`${file}: description is required`);
  if (!tiers[data.tier]) errors.push(`${file}: tier must be one of ${Object.keys(tiers).join(", ")}`);
  for (const c of data.capabilities ?? []) if (!CAPABILITIES.test(c)) errors.push(`${file}: unknown capability "${c}"`);
  checkNeutralText(file, text, errors);
}

export function validateRule(text, file, errors) {
  const { data } = parseFrontmatter(text);
  if (!data) return errors.push(`${file}: missing frontmatter`);
  for (const k of Object.keys(data)) if (!RULE_KEYS.has(k)) errors.push(`${file}: unknown rule field "${k}"`);
  if (!data.name || !NAME.test(data.name)) errors.push(`${file}: name must be lowercase words joined by hyphens`);
  if (!Array.isArray(data.globs) || data.globs.length === 0) errors.push(`${file}: globs must be a non-empty list`);
  checkNeutralText(file, text, errors);
}

// ---------------------------------------------------------------------------
// Adapters: neutral sources -> each tool's files. Pure: returns a path->content map.
// ---------------------------------------------------------------------------
const json = (value) => JSON.stringify(value, null, 2) + "\n";

function claudePermissions(policy) {
  const files = (verb, globs) => globs.map((g) => `${verb}(./${g})`);
  const shell = (prefixes) => prefixes.map((p) => `Bash(${p}*)`);
  return {
    deny: [...files("Read", policy.deny.read), ...files("Edit", policy.deny.write), ...shell(policy.deny.shell)],
    ask: shell(policy.ask.shell),
    allow: shell(policy.allow.shell),
  };
}

function mcpFor(tool, servers) {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    if (s.url) out[name] = tool === "claude" ? { type: "http", url: s.url, ...(s.headers && { headers: s.headers }) }
      : { httpUrl: s.url, ...(s.headers && { headers: s.headers }) };
    else out[name] = { ...(tool === "claude" && { type: "stdio" }), command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) };
  }
  return out;
}

export function buildAdapters({ policy, mcp, skills }) {
  const files = new Map();

  // Claude Code: skills are copied (it reads .claude/skills only); permissions and
  // the guard hook go in project settings; MCP servers in .mcp.json.
  for (const skill of skills) {
    for (const [rel, content] of skill.files) {
      if (rel.startsWith("adapters/")) continue;
      let out = content;
      if (rel === "SKILL.md") {
        const { data, body } = parseFrontmatter(content);
        const extras = skill.adapters.claude ?? {};
        out = renderFrontmatter({ ...data, ...extras }) +
          `\n<!-- generated by npm run agents:sync from .agents/skills/${skill.name}/SKILL.md; edit the source, not this copy -->\n` +
          body.replace(/^\n+/, "\n");
      }
      files.set(`.claude/skills/${skill.name}/${rel}`, out);
    }
  }
  files.set(".claude/settings.json", json({
    permissions: claudePermissions(policy),
    hooks: {
      PreToolUse: [{
        matcher: "Bash|PowerShell|Read|Write|Edit|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: `node "\${CLAUDE_PROJECT_DIR}/${policy.hook}"`, timeout: 15 }],
      }],
    },
  }));
  files.set(".mcp.json", json({ mcpServers: mcpFor("claude", mcp.servers) }));

  // Gemini CLI: reads AGENTS.md via context.fileName and .agents/skills natively,
  // so only settings are generated.
  files.set(".gemini/settings.json", json({
    context: { fileName: ["AGENTS.md"] },
    hooks: {
      BeforeTool: [{
        matcher: "run_shell_command|write_file|replace|read_file|read_many_files",
        hooks: [{ name: "repository-guard", type: "command", command: `node ${policy.hook}`, timeout: 15000 }],
      }],
    },
    mcpServers: mcpFor("gemini", mcp.servers),
  }));

  return files;
}

// Directories the generator owns completely: anything in them it didn't produce is stale.
export const OWNED_DIRS = [".claude/skills"];

// ---------------------------------------------------------------------------
// Filesystem.
// ---------------------------------------------------------------------------
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full).replace(/\\/g, "/")];
  });
}

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function loadSources(root, errors) {
  const agents = join(root, ".agents");
  const policy = JSON.parse(read(join(agents, "policy.json")));
  const models = JSON.parse(read(join(agents, "models.json")));
  const mcp = JSON.parse(read(join(agents, "mcp.json")));

  const skills = [];
  const skillsDir = join(agents, "skills");
  for (const name of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const dir = join(skillsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const rels = walk(dir);
    if (!rels.includes("SKILL.md")) {
      errors.push(`.agents/skills/${name}: missing SKILL.md`);
      continue;
    }
    const filesMap = new Map(rels.map((r) => [r, read(join(dir, r))]));
    validateSkill(name, filesMap.get("SKILL.md"), `.agents/skills/${name}/SKILL.md`, errors);
    const adapters = {};
    for (const r of rels.filter((r) => /^adapters\/[a-z]+\.json$/.test(r))) {
      adapters[r.slice("adapters/".length, -".json".length)] = JSON.parse(filesMap.get(r));
    }
    skills.push({ name, files: filesMap, adapters });
  }

  // Roles and rules are validated now; their adapters arrive with their content
  // (rules in 2.2, roles in 2.4). "_" files are schema examples.
  for (const kind of ["roles", "rules"]) {
    const dir = join(agents, kind);
    for (const f of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : []) {
      const text = read(join(dir, f));
      const label = `.agents/${kind}/${f}`;
      if (kind === "roles") validateRole(f, text, label, errors, models.tiers);
      else validateRule(text, label, errors);
    }
  }
  return { policy, models, mcp, skills };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  const errors = [];
  const sources = loadSources(root, errors);
  if (errors.length) {
    console.error(`agents-sync: ${errors.length} problem(s) in .agents/\n` + errors.map((e) => `  - ${e}`).join("\n"));
    process.exit(1);
  }

  const expected = buildAdapters(sources);
  const drift = [];
  for (const [rel, content] of expected) {
    const full = join(root, rel);
    const current = existsSync(full) ? read(full) : null;
    if (current === content) continue;
    if (check) drift.push(`${rel}: ${current === null ? "missing" : "differs from its .agents source"}`);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  for (const dir of OWNED_DIRS) {
    for (const rel of walk(join(root, dir)).map((r) => `${dir}/${r}`)) {
      if (expected.has(rel)) continue;
      if (check) drift.push(`${rel}: not generated from any .agents source`);
      else rmSync(join(root, rel));
    }
  }

  if (check && drift.length) {
    console.error("agents-sync: generated agent adapters are out of date\n" + drift.map((d) => `  - ${d}`).join("\n") +
      "\nEdit the source in .agents/ and run `npm run agents:sync`. Never edit generated files directly.");
    process.exit(1);
  }
  console.log(`agents-sync: ${check ? "adapters up to date" : "adapters written"} (${expected.size} files, ${sources.skills.length} skill(s))`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
