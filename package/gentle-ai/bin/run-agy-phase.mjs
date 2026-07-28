#!/usr/bin/env node
/**
 * run-agy-phase — cross-platform SDD phase launcher for Antigravity CLI (agy)
 *
 * Usage:
 *   node run-agy-phase.mjs --phase explore --change NAME --project PROJ --cwd REPO [options]
 *
 * Options:
 *   --phase <explore|propose|spec|design|tasks|verify>
 *   --change <change-name>
 *   --project <engram-project>
 *   --cwd <repo-root>
 *   --model <agy-model-id>
 *   --effort <low|medium|high>
 *   --timeout <duration>          e.g. 10m (default from config/phase)
 *   --artifact-store <engram|openspec|hybrid|none>
 *   --prompt-file <path>          full phase prompt (recommended)
 *   --prompt <text>               inline prompt (avoid for large prompts)
 *   --config <path>               workers.yaml override
 *   --dry-run                     print resolved command only
 *   --json                        print machine-readable envelope to stdout
 *
 * Exit codes:
 *   0 success envelope (gate of store is still orchestrator responsibility)
 *   2 usage / config error
 *   3 agy unavailable
 *   4 agy failed (quota/timeout/unknown) — see envelope.error_class
 *   5 contract / invalid JSON from agy
 */

import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, delimiter, sep } from "node:path";

const ELIGIBLE = new Set([
  "explore",
  "propose",
  "spec",
  "design",
  "tasks",
  "verify",
]);

function die(code, msg, extra = {}) {
  const envelope = {
    status: "failed",
    error_class: extra.error_class || "unavailable",
    message: msg,
    ...extra,
  };
  process.stderr.write(String(msg).endsWith("\n") ? msg : msg + "\n");
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    phase: null,
    change: null,
    project: null,
    cwd: process.cwd(),
    model: null,
    effort: null,
    timeout: null,
    artifactStore: "engram",
    promptFile: null,
    prompt: null,
    config: null,
    dryRun: false,
    json: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--phase":
        out.phase = next();
        break;
      case "--change":
        out.change = next();
        break;
      case "--project":
        out.project = next();
        break;
      case "--cwd":
        out.cwd = resolve(next());
        break;
      case "--model":
        out.model = next();
        break;
      case "--effort":
        out.effort = next();
        break;
      case "--timeout":
        out.timeout = next();
        break;
      case "--artifact-store":
        out.artifactStore = next();
        break;
      case "--prompt-file":
        out.promptFile = resolve(next());
        break;
      case "--prompt":
        out.prompt = next();
        break;
      case "--config":
        out.config = resolve(next());
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("-")) die(2, `Unknown flag: ${a}`, { error_class: "unavailable" });
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`run-agy-phase — launch one SDD phase via agy (portable)\n`);
}

const args = parseArgs(process.argv.slice(2));

function homeConfigPath() {
  // Windows: %USERPROFILE%\.config\gentle-ai  (we standardize on .config even on Win)
  return join(homedir(), ".config", "gentle-ai", "workers.yaml");
}

function tryLoadYaml(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  // Minimal YAML subset parser for our flat-ish config (no deps).
  // Prefer JSON if file is JSON. For YAML we use a tiny safe subset via JSON-like
  // conversion is fragile — ship a JSON twin fallback.
  if (path.endsWith(".json")) return JSON.parse(raw);
  return parseSimpleYaml(raw);
}

/** Tiny YAML subset: maps, nested maps, arrays of scalars, comments, null/bool/numbers/strings */
function parseSimpleYaml(src) {
  const lines = src.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, container: root, key: null, type: "map" }];

  const assign = (map, key, value) => {
    map[key] = value;
  };

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)[0].length;
    line = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      const val = parseScalar(line.slice(2).trim());
      if (!Array.isArray(top.container)) {
        // array under last key
        die(2, `YAML parse error at line ${li + 1}: array without parent key`);
      }
      top.container.push(val);
      continue;
    }

    const m = line.match(/^([^:#]+):\s*(.*)$/);
    if (!m) die(2, `YAML parse error at line ${li + 1}: ${line}`);
    const key = m[1].trim();
    const rest = m[2].trim();

    if (rest === "" || rest === "|" || rest === ">") {
      // Lookahead: array or map
      let nextIndent = null;
      for (let j = li + 1; j < lines.length; j++) {
        const l2 = lines[j];
        if (!l2.trim() || l2.trim().startsWith("#")) continue;
        nextIndent = l2.match(/^\s*/)[0].length;
        const isArr = l2.trim().startsWith("- ");
        if (isArr) {
          const arr = [];
          assign(top.container, key, arr);
          stack.push({ indent, container: arr, key, type: "array" });
        } else {
          const obj = {};
          assign(top.container, key, obj);
          stack.push({ indent, container: obj, key, type: "map" });
        }
        break;
      }
      if (nextIndent === null) assign(top.container, key, null);
      continue;
    }

    assign(top.container, key, parseScalar(rest));
  }
  return root;
}

function parseScalar(s) {
  if (s === "null" || s === "~" || s === "") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  // inline array [a, b]
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => parseScalar(x.trim()));
  }
  return s;
}

function loadConfig(cliConfigPath, cwd) {
  const home = homeConfigPath();
  const project = join(cwd, ".atl", "sdd-workers.yaml");
  const base = tryLoadYaml(cliConfigPath || home) || { version: 1, workers: { agy: { enabled: true, command: "agy" } }, policy: {} };
  const over = tryLoadYaml(project);
  return over ? deepMerge(base, over) : base;
}

function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (typeof a !== "object" || a === null) return b ?? a;
  if (typeof b !== "object" || b === null) return b ?? a;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

function which(cmd) {
  const pathEnv = process.env.PATH || "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        try {
          accessSync(candidate, constants.F_OK);
          return candidate;
        } catch {
          /* continue */
        }
      }
    }
  }
  return null;
}

function classifyError(text, exitCode, timedOut) {
  if (timedOut) return "timeout";
  const t = (text || "").toLowerCase();
  if (
    /quota|rate.?limit|resource.?exhausted|too many requests|billing|insufficient/.test(
      t
    )
  ) {
    return "quota_exceeded";
  }
  if (/not found|enoent|command not found|spawn/.test(t)) return "unavailable";
  if (exitCode && exitCode !== 0) return "unknown";
  return null;
}

function resolveTimeout(cfg, phase, override) {
  if (override) return override;
  return (
    cfg.timeouts?.[phase] ||
    cfg.workers?.agy?.default_timeout ||
    "10m"
  );
}

function resolveModelEffort(cfg, phase, model, effort) {
  const agy = cfg.workers?.agy || {};
  const m =
    model ||
    agy.model_by_phase?.[phase] ||
    agy.default_model ||
    null;
  const e =
    effort ||
    agy.effort_by_phase?.[phase] ||
    agy.default_effort ||
    null;
  return { model: m, effort: e };
}

function buildDefaultPrompt({ phase, change, project, artifactStore, skillPaths }) {
  const skillBlock = skillPaths
    .map((p, i) => `${i + 1}. ${p}`)
    .join("\n");
  return `# ROLE
You are the sdd-${phase} EXECUTOR (not orchestrator). Execute this single phase fully. Do NOT delegate. Do NOT orchestrate other SDD phases.

# BRIDGE CONTRACT
- host: antigravity-cli (agy)
- phase: sdd-${phase}
- change_name: ${change}
- project: ${project}
- artifact_store.mode: ${artifactStore}
- You MAY use Engram MCP tools with project: ${project}
- You MUST NOT modify application source code unless phase is explicitly implementation (this runner forbids apply)
- You MUST NOT run git commit/push
- You MUST NOT start other phases

# SKILLS TO LOAD BEFORE WORK
Read these files completely before doing phase work:
${skillBlock || "(none resolved — follow built-in Gentle SDD conventions)"}

# PROJECT / MEMORY
1. Prefer explicit project name: ${project} on every Engram call.
2. Read required dependency artifacts for this phase from Engram/OpenSpec per SDD conventions.
3. Persist this phase artifact with canonical topic_key sdd/${change}/${phase === "explore" ? "explore" : phase === "propose" ? "proposal" : phase}

# FINAL RESPONSE FORMAT
Return ONLY valid JSON (no markdown fences) with this shape:
{
  "status": "success" | "failed" | "partial",
  "executive_summary": "string",
  "artifacts": { "topic_keys": [], "paths": [], "observation_ids": [] },
  "next_recommended": "string",
  "risks": ["string"],
  "skill_resolution": "paths-injected" | "fallback-path" | "none",
  "worker": "agy",
  "phase": "sdd-${phase}",
  "project": "${project}",
  "change_name": "${change}",
  "error_class": null
}
`;
}

function discoverSkill(cfg, cwd, name) {
  const home = homedir();
  const configRoot = join(home, ".config");
  const roots = cfg.skill_discovery || [
    "{config}/opencode/skills",
    "{home}/.gemini/antigravity-cli/skills",
    "{repo}/.agents/skills",
  ];
  for (const r of roots) {
    const root = r
      .replaceAll("{home}", home)
      .replaceAll("{config}", configRoot)
      .replaceAll("{repo}", cwd);
    const candidate = join(root, name, "SKILL.md");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function phaseSkillName(phase) {
  return `sdd-${phase}`;
}

function artifactTopic(phase, change) {
  const map = {
    explore: "explore",
    propose: "proposal",
    spec: "spec",
    design: "design",
    tasks: "tasks",
    verify: "verify-report",
  };
  return `sdd/${change}/${map[phase] || phase}`;
}

// --- main ---
if (!args.phase || !ELIGIBLE.has(args.phase)) {
  die(2, `Invalid or missing --phase. Eligible: ${[...ELIGIBLE].join(", ")}`);
}
if (!args.change) die(2, "Missing --change");
if (!args.project) die(2, "Missing --project");
if (!existsSync(args.cwd)) die(2, `cwd does not exist: ${args.cwd}`);

const cfg = loadConfig(args.config, args.cwd);
if (cfg.workers?.agy?.enabled === false) {
  die(3, "agy worker disabled in workers.yaml", { error_class: "unavailable" });
}

const agyCmd = cfg.workers?.agy?.command || "agy";
const agyPath = which(agyCmd);
if (!agyPath) {
  die(3, `agy not found on PATH (command=${agyCmd})`, { error_class: "unavailable" });
}

const { model, effort } = resolveModelEffort(
  cfg,
  args.phase,
  args.model,
  args.effort
);
const timeout = resolveTimeout(cfg, args.phase, args.timeout);

const skillName = phaseSkillName(args.phase);
const mainSkill = discoverSkill(cfg, args.cwd, skillName);
const shared = discoverSkill(cfg, args.cwd, "_shared");
const skillPaths = [];
if (mainSkill) skillPaths.push(mainSkill);
if (shared) {
  const common = join(shared, "..", "sdd-phase-common.md");
  // shared is .../_shared/SKILL.md — siblings
  const sharedDir = resolve(mainSkill || shared, "..", "..", "_shared");
  const candidates = [
    join(sharedDir, "sdd-phase-common.md"),
    join(sharedDir, "engram-convention.md"),
    join(resolve(shared, ".."), "sdd-phase-common.md"),
    join(resolve(shared, ".."), "engram-convention.md"),
  ];
  // Fix shared dir resolution
  const sharedParent = resolve(String(shared).replace(/SKILL\.md$/, ""));
  for (const f of [
    join(sharedParent, "sdd-phase-common.md"),
    join(sharedParent, "engram-convention.md"),
  ]) {
    if (existsSync(f) && !skillPaths.includes(f)) skillPaths.push(f);
  }
  for (const f of candidates) {
    if (existsSync(f) && !skillPaths.includes(f)) skillPaths.push(f);
  }
}

let promptText = args.prompt;
if (args.promptFile) {
  if (!existsSync(args.promptFile)) die(2, `prompt file missing: ${args.promptFile}`);
  promptText = readFileSync(args.promptFile, "utf8");
}
if (!promptText) {
  promptText = buildDefaultPrompt({
    phase: args.phase,
    change: args.change,
    project: args.project,
    artifactStore: args.artifactStore,
    skillPaths,
  });
}

const cliArgs = ["--print", promptText, "--print-timeout", String(timeout)];
const extra = cfg.workers?.agy?.extra_args || [
  "--output-format",
  "json",
  "--dangerously-skip-permissions",
];
cliArgs.push(...extra);
if (model) cliArgs.push("--model", String(model));
if (effort) cliArgs.push("--effort", String(effort));
if (cfg.workers?.agy?.plan_mode_explore && args.phase === "explore") {
  cliArgs.push("--mode", "plan");
}

const env = {
  ...process.env,
  ENGRAM_PROJECT: args.project,
};

const meta = {
  worker: "agy",
  phase: args.phase,
  change: args.change,
  project: args.project,
  cwd: args.cwd,
  model,
  effort,
  timeout,
  agy_path: agyPath,
  skill_paths: skillPaths,
  expected_topic_key: artifactTopic(args.phase, args.change),
  artifact_store: args.artifactStore,
};

if (args.dryRun) {
  process.stdout.write(
    JSON.stringify({ status: "dry_run", command: agyPath, args: cliArgs.map((a,i)=> i===1 ? `<prompt ${promptText.length} chars>` : a), ...meta }, null, 2) + "\n"
  );
  process.exit(0);
}

const started = Date.now();
const child = spawn(agyPath, cliArgs, {
  cwd: args.cwd,
  env,
  shell: false,
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (d) => {
  stdout += d;
});
child.stderr.on("data", (d) => {
  stderr += d;
});

child.on("error", (err) => {
  die(3, `Failed to spawn agy: ${err.message}`, {
    error_class: "unavailable",
    ...meta,
  });
});

child.on("close", (code) => {
  const duration_s = (Date.now() - started) / 1000;
  const timedOut = /timeout|deadline/i.test(stderr + stdout);
  let parsed = null;
  let responseObj = null;
  try {
    parsed = JSON.parse(stdout.trim() || "null");
  } catch {
    const errClass = classifyError(stderr + stdout, code, timedOut) || "contract";
    const envelope = {
      status: "failed",
      error_class: errClass,
      message: "agy stdout was not valid JSON",
      exit_code: code,
      duration_s,
      stderr_tail: stderr.slice(-2000),
      stdout_tail: stdout.slice(-2000),
      ...meta,
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    process.exit(errClass === "quota_exceeded" ? 4 : 5);
    return;
  }

  // agy envelope: { status, response, ... } where response may be JSON string
  let inner = parsed;
  if (parsed && typeof parsed.response === "string") {
    try {
      responseObj = JSON.parse(parsed.response);
      inner = responseObj;
    } catch {
      responseObj = { raw_response: parsed.response };
      inner = {
        status: parsed.status === "SUCCESS" ? "partial" : "failed",
        executive_summary: String(parsed.response).slice(0, 500),
        error_class: null,
      };
    }
  }

  const errClass =
    inner?.error_class ||
    classifyError(stderr + JSON.stringify(parsed), code, timedOut);

  const ok =
    code === 0 &&
    (inner?.status === "success" ||
      parsed?.status === "SUCCESS" ||
      parsed?.status === "success");

  const envelope = {
    status: ok ? "success" : inner?.status || "failed",
    error_class: ok ? null : errClass || "unknown",
    exit_code: code,
    duration_s,
    agy_status: parsed?.status ?? null,
    conversation_id: parsed?.conversation_id ?? null,
    result: inner,
    expected_topic_key: meta.expected_topic_key,
    gate_note:
      "Orchestrator MUST validate artifact in Engram/OpenSpec; stdout is not authority.",
    ...meta,
    usage: parsed?.usage ?? null,
    stderr_tail: stderr ? stderr.slice(-1000) : "",
  };

  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  if (ok) process.exit(0);
  if (envelope.error_class === "quota_exceeded") process.exit(4);
  if (envelope.error_class === "timeout" || envelope.error_class === "unavailable")
    process.exit(4);
  process.exit(5);
});
