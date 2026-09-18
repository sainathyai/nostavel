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
import { execFileSync } from "node:child_process";
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
    if (Array.isArray(v)) {
      // Block list, every item quoted: globs start with "*" or contain "{", which
      // YAML would otherwise read as an alias or a flow mapping.
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${JSON.stringify(String(item))}`);
    } else if (v && typeof v === "object") {
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

/**
 * @param {string[]} [skillNames] skills that exist in .agents/skills (omit to skip the check)
 */
export function validateRole(fileName, text, file, errors, tiers, skillNames) {
  const { data } = parseFrontmatter(text);
  if (!data) return errors.push(`${file}: missing frontmatter`);
  for (const k of Object.keys(data)) if (!ROLE_KEYS.has(k)) errors.push(`${file}: unknown role field "${k}"`);
  if (!data.name || !NAME.test(data.name)) errors.push(`${file}: name must be lowercase words joined by hyphens`);
  if (data.name && !fileName.startsWith("_") && `${data.name}.md` !== fileName) errors.push(`${file}: name "${data.name}" must match the file name`);
  if (!data.description) errors.push(`${file}: description is required`);
  if (!tiers[data.tier]) errors.push(`${file}: tier must be one of ${Object.keys(tiers).join(", ")}`);
  if (!Array.isArray(data.capabilities) || data.capabilities.length === 0) errors.push(`${file}: capabilities must be a non-empty list`);
  for (const c of data.capabilities ?? []) if (!CAPABILITIES.test(c)) errors.push(`${file}: unknown capability "${c}"`);
  const canEdit = (data.capabilities ?? []).includes("edit");
  if (canEdit && (!Array.isArray(data.owns) || data.owns.length === 0)) {
    errors.push(`${file}: a role with the edit capability must declare owns (the globs it may edit)`);
  }
  if (!canEdit && Array.isArray(data.owns) && data.owns.length) errors.push(`${file}: owns is set but the role has no edit capability`);
  if (skillNames) {
    for (const s of data.skills ?? []) if (!skillNames.includes(s)) errors.push(`${file}: skill "${s}" does not exist in .agents/skills`);
  }
  checkNeutralText(file, text, errors);
}

/**
 * Glob to RegExp for repo-relative forward-slash paths: `**` (any depth),
 * `*` and `?` (within a segment), `{a,b}` alternation. The subset rule globs use,
 * and the subset every tool's rule loader understands.
 */
export function globToRegExp(glob) {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; braces++; }
    else if (c === "}" && braces > 0) { re += ")"; braces--; }
    else if (c === "," && braces > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]{}\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** @param {string[]} trackedFiles repo-relative paths, to catch globs that match nothing */
export function validateRule(fileName, text, file, errors, trackedFiles) {
  const { data, body } = parseFrontmatter(text);
  if (!data) return errors.push(`${file}: missing frontmatter`);
  for (const k of Object.keys(data)) if (!RULE_KEYS.has(k)) errors.push(`${file}: unknown rule field "${k}"`);
  if (!data.name || !NAME.test(data.name)) errors.push(`${file}: name must be lowercase words joined by hyphens`);
  if (data.name && `${data.name}.md` !== fileName) errors.push(`${file}: name "${data.name}" must match the file name`);
  if (!data.description) errors.push(`${file}: description is required`);
  if (!Array.isArray(data.globs) || data.globs.length === 0) {
    errors.push(`${file}: globs must be a non-empty list`);
  } else if (trackedFiles) {
    for (const g of data.globs) {
      const re = globToRegExp(g);
      if (!trackedFiles.some((f) => re.test(f))) errors.push(`${file}: glob "${g}" matches no tracked file (typo, or the code moved)`);
    }
  }
  // Rules are digests of the conventions, which stay the single source of truth.
  if (!/docs\/conventions\.md/.test(body) || !/§\d/.test(body)) {
    errors.push(`${file}: cite the docs/conventions.md section(s) this rule summarises (e.g. "§3")`);
  }
  checkNeutralText(file, text, errors);
}

export const INDEX_BEGIN = "<!-- BEGIN:agents-rules-index (generated by npm run agents:sync; edit .agents/rules instead) -->";
export const INDEX_END = "<!-- END:agents-rules-index -->";

/** The AGENTS.md rules index: the path-scoping fallback for tools without native rule loading. */
export function renderRulesIndex(rules) {
  const rows = rules.map((r) =>
    `| ${r.data.name} | ${r.data.globs.map((g) => `\`${g}\``).join("<br>")} | [\`.agents/rules/${r.data.name}.md\`](.agents/rules/${r.data.name}.md) |`);
  return [
    INDEX_BEGIN,
    "Before editing a file, read every rule whose globs match its path.",
    "",
    "| Area | Globs | Rule |",
    "|---|---|---|",
    ...rows,
    INDEX_END,
  ].join("\n");
}

export function replaceIndexBlock(agentsMd, block) {
  const start = agentsMd.indexOf("<!-- BEGIN:agents-rules-index");
  const end = agentsMd.indexOf(INDEX_END);
  if (start === -1 || end === -1 || end < start) return null;
  return agentsMd.slice(0, start) + block + agentsMd.slice(end + INDEX_END.length);
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
  // `description` documents the server in the neutral file only; tools don't accept it.
  for (const [name, s] of Object.entries(servers)) {
    if (s.url) out[name] = tool === "claude" ? { type: "http", url: s.url, ...(s.headers && { headers: s.headers }) }
      : { httpUrl: s.url, ...(s.headers && { headers: s.headers }) };
    else out[name] = { ...(tool === "claude" && { type: "stdio" }), command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) };
  }
  return out;
}

// Capability -> each tool's tool names. A role never names tools itself.
export const TOOL_MAP = {
  claude: {
    read: ["Read", "Grep", "Glob"],
    edit: ["Edit", "Write"],
    shell: ["Bash", "PowerShell"],
    web: ["WebFetch", "WebSearch"],
    mcp: (server) => [`mcp__${server}`],
  },
  gemini: {
    read: ["read_file", "read_many_files", "glob", "grep_search", "list_directory"],
    edit: ["write_file", "replace"],
    shell: ["run_shell_command"],
    web: ["web_fetch", "google_web_search"],
    mcp: (server) => [`mcp_${server}_*`],
  },
};

export function toolsFor(tool, capabilities) {
  const map = TOOL_MAP[tool];
  return capabilities.flatMap((c) => (c.startsWith("mcp:") ? map.mcp(c.slice(4)) : map[c]));
}

/** Claude Code subagent. Its own PreToolUse hook passes --role so the guard enforces `owns`. */
function claudeAgent(role, models, policy) {
  const { data } = role;
  const q = JSON.stringify;
  const lines = [
    "---",
    `name: ${data.name}`,
    `description: ${q(data.description)}`,
    `tools: ${toolsFor("claude", data.capabilities).join(", ")}`,
    `model: ${models.tiers[data.tier].claude ?? "inherit"}`,
  ];
  if (data.skills?.length) lines.push("skills:", ...data.skills.map((s) => `  - ${s}`));
  lines.push(
    "hooks:",
    "  PreToolUse:",
    `    - matcher: ${q("Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit")}`,
    "      hooks:",
    "        - type: command",
    `          command: ${q(`node "\${CLAUDE_PROJECT_DIR}/${policy.hook}" --role ${data.name}`)}`,
    "          timeout: 15",
    "---",
  );
  return lines.join("\n") + "\n" + roleBody(role, "claude");
}

/** Gemini CLI subagent. Subagent files have no hooks, so `owns` is advisory here (see .agents/README.md). */
function geminiAgent(role, models) {
  const { data } = role;
  const configured = models.tiers[data.tier].gemini;
  // Gemini subagents need an exact model id; tier aliases fall back to the session model.
  const model = typeof configured === "string" && /^gemini-/.test(configured) ? configured : "inherit";
  return [
    "---",
    `name: ${data.name}`,
    `description: ${JSON.stringify(data.description)}`,
    "kind: local",
    "tools:",
    ...toolsFor("gemini", data.capabilities).map((t) => `  - ${JSON.stringify(t)}`),
    `model: ${model}`,
    "---",
  ].join("\n") + "\n" + roleBody(role, "gemini");
}

function roleBody({ data, body }, tool) {
  const owns = data.owns?.length
    ? `You may edit only: ${data.owns.map((g) => `\`${g}\``).join(", ")}. Anything else belongs to another role; hand it off through the ticket or pull request.`
    : "You do not edit files. Report findings and hand off through the ticket or pull request.";
  const enforcement = tool === "claude" ? " The repository guard enforces this." : "";
  return `\n<!-- generated by npm run agents:sync from .agents/roles/${data.name}.md; edit the source, not this copy -->\n` +
    body.replace(/^\n+/, "\n").replace(/\n*$/, "\n") +
    `\n## Boundaries (generated)\n\n${owns}${enforcement}\n\n` +
    "Follow `AGENTS.md`, `docs/conventions.md` and the area rules for every file you touch " +
    "(see the Rules index in `AGENTS.md`). Your full charter is in `docs/team/roles.md`.\n";
}

export function buildAdapters({ policy, mcp, skills, rules = [], roles = [], models = null, agentsMd = null }) {
  const files = new Map();

  for (const role of roles) {
    files.set(`.claude/agents/${role.data.name}.md`, claudeAgent(role, models, policy));
    files.set(`.gemini/agents/${role.data.name}.md`, geminiAgent(role, models));
  }

  // Every tool: the rules index inside AGENTS.md (the only file all tools read).
  if (agentsMd !== null) {
    const updated = replaceIndexBlock(agentsMd, renderRulesIndex(rules));
    if (updated === null) throw new Error("AGENTS.md is missing the agents-rules-index BEGIN/END markers");
    files.set("AGENTS.md", updated);
  }

  // Claude Code: path-scoped rules load when a matching file is read.
  for (const rule of rules) {
    files.set(`.claude/rules/${rule.data.name}.md`,
      renderFrontmatter({ paths: rule.data.globs }) +
      `\n<!-- generated by npm run agents:sync from .agents/rules/${rule.data.name}.md; edit the source, not this copy -->\n` +
      rule.body.replace(/^\n+/, "\n"));
  }

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
    // Project servers are not loaded until approved, which a headless run can't do,
    // so roles with mcp:<server> silently had no tools (found in the 2.5 live check).
    // Claude Code still applies this only once the folder is trusted.
    enabledMcpjsonServers: Object.keys(mcp.servers),
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
export const OWNED_DIRS = [".claude/skills", ".claude/rules", ".claude/agents", ".gemini/agents"];

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

  // "_" files are format examples: validated for shape, never generated.
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root }).toString("utf8").split("\0").filter(Boolean);
  const rules = [];
  const rulesDir = join(agents, "rules");
  for (const f of existsSync(rulesDir) ? readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort() : []) {
    const text = read(join(rulesDir, f));
    const example = f.startsWith("_");
    // Example globs are illustrative, so they aren't matched against tracked files.
    validateRule(example ? `${parseFrontmatter(text).data?.name}.md` : f, text, `.agents/rules/${f}`, errors, example ? null : tracked);
    if (!example) rules.push(parseFrontmatter(text));
  }

  const roles = loadRoles(root, errors, models.tiers, skills.map((s) => s.name));
  for (const role of roles) {
    for (const c of role.data.capabilities ?? []) {
      if (c.startsWith("mcp:") && !mcp.servers[c.slice(4)]) {
        errors.push(`.agents/roles/${role.data.name}.md: capability "${c}" names a server missing from .agents/mcp.json`);
      }
    }
  }
  const agentsMd = read(join(root, "AGENTS.md"));
  return { policy, models, mcp, skills, rules, roles, agentsMd };
}

/** Neutral roles (non-example), validated. Shared with the role-aware guard. */
export function loadRoles(root, errors = [], tiers = null, skillNames = undefined) {
  const rolesDir = join(root, ".agents", "roles");
  const modelTiers = tiers ?? JSON.parse(read(join(root, ".agents", "models.json"))).tiers;
  const roles = [];
  for (const f of existsSync(rolesDir) ? readdirSync(rolesDir).filter((f) => f.endsWith(".md")).sort() : []) {
    const text = read(join(rolesDir, f));
    validateRole(f, text, `.agents/roles/${f}`, errors, modelTiers, skillNames);
    if (!f.startsWith("_")) roles.push(parseFrontmatter(text));
  }
  return roles;
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
