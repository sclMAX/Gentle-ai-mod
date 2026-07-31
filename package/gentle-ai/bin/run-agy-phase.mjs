#!/usr/bin/env node
/**
 * run-agy-phase — cross-platform SDD phase launcher for Antigravity CLI (agy)
 *
 * v1.2:
 *   - Default --json-schema (sdd-phase-result.schema.json) + --output-format
 *   - Prefer structured_output; strip fences; stream-json NDJSON result event
 *   - Optional --stream-progress (stderr) for stream-json step_update DONE
 *
 * v1.1:
 *   - Normalize model/effort pairing (Gemini suffix vs Claude no-effort)
 *   - Auto-retry once on invalid model/effort selection
 *   - Clearer error_class values for orchestrator failover
 *
 * Usage:
 *   node run-agy-phase.mjs --phase explore --change NAME --project PROJ --cwd REPO [options]
 *
 * Exit codes:
 *   0 success
 *   2 usage / config error
 *   3 agy unavailable
 *   4 agy failed (quota/timeout/unavailable/invalid_model_selection after retry)
 *   5 contract / invalid JSON from agy
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ELIGIBLE = new Set([
  "explore",
  "propose",
  "spec",
  "design",
  "tasks",
  "apply",
  "verify",
  "archive",
  "init",
  "onboard",
]);

const EFFORT_LEVELS = new Set(["low", "medium", "high"]);
const OUTPUT_FORMATS = new Set(["json", "stream-json"]);

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

function printHelp() {
  process.stdout.write(`run-agy-phase — launch one SDD phase via agy (portable)

Usage:
  node run-agy-phase.mjs --phase <phase> --change <name> --project <proj> --cwd <repo> [options]

Required:
  --phase <name>           explore|propose|spec|design|tasks|apply|verify|archive|init|onboard
  --change <name>          SDD change name
  --project <name>         Engram / project id
  --cwd <path>             repo working directory

Options:
  --model <id>             agy model id
  --effort <level>         low|medium|high (normalized; omitted for Claude)
  --timeout <dur>          e.g. 10m
  --artifact-store <mode>  engram|openspec|hybrid|none (default engram)
  --prompt-file <path>     phase prompt file
  --prompt <text>          inline prompt (prefer --prompt-file)
  --config <path>          workers.yaml override
  --output-format <fmt>    json|stream-json (default: json, or workers.yaml)
  --json-schema <spec>     path|default|none (default: default)
  --no-json-schema         alias for --json-schema none
  --stream-progress        stderr progress for stream-json step_update DONE
  --dry-run                print resolved CLI args and exit 0
  --json                   kept for compatibility (always JSON envelope)
  -h, --help               show help

Exit codes: 0 ok | 2 usage | 3 agy missing | 4 agy fail | 5 contract
`);
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
    outputFormat: null, // null = use config default then json
    jsonSchema: null, // null = use config default then default
    streamProgress: false,
    outputFormatExplicit: false,
    jsonSchemaExplicit: false,
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
      case "--output-format": {
        const v = next();
        out.outputFormat = v;
        out.outputFormatExplicit = true;
        break;
      }
      case "--json-schema": {
        const v = next();
        out.jsonSchema = v;
        out.jsonSchemaExplicit = true;
        break;
      }
      case "--no-json-schema":
        out.jsonSchema = "none";
        out.jsonSchemaExplicit = true;
        break;
      case "--stream-progress":
        out.streamProgress = true;
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
        if (a.startsWith("-"))
          die(2, `Unknown flag: ${a}`, { error_class: "unavailable" });
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function homeConfigPath() {
  return join(homedir(), ".config", "gentle-ai", "workers.yaml");
}

function tryLoadYaml(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(raw);
  return parseSimpleYaml(raw);
}

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
  const base = tryLoadYaml(cliConfigPath || home) || {
    version: 1,
    workers: { agy: { enabled: true, command: "agy" } },
    policy: {},
  };
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

/** Models whose id ends with -low|-medium|-high bake effort into the id. */
function effortSuffixFromModel(model) {
  if (!model) return null;
  const m = String(model).toLowerCase().match(/-(low|medium|high)$/);
  return m ? m[1] : null;
}

/**
 * Claude / some third-party models reject --effort entirely.
 * Gemini flash/pro with suffix require matching effort (or omit).
 */
function modelSupportsEffortFlag(model) {
  if (!model) return true;
  const id = String(model).toLowerCase();
  if (id.includes("claude")) return false;
  if (id.includes("opus") && id.includes("thinking")) return false;
  if (id.startsWith("gpt-oss")) return false;
  // Gemini-style and unknown: allow effort, but normalize below
  return true;
}

/**
 * Produce a legal { model, effort } pair for agy.
 * effort null means: do NOT pass --effort.
 */
function normalizeModelEffort(model, effort, { source = "resolve" } = {}) {
  const notes = [];
  let m = model || null;
  let e =
    effort === undefined || effort === null || effort === "" || effort === "null"
      ? null
      : String(effort).toLowerCase();

  if (e && !EFFORT_LEVELS.has(e)) {
    notes.push(`invalid_effort_dropped:${e}`);
    e = null;
  }

  if (!m) {
    return { model: null, effort: e, notes, source };
  }

  if (!modelSupportsEffortFlag(m)) {
    if (e) notes.push(`effort_omitted_unsupported_model:${m}`);
    return { model: m, effort: null, notes, source };
  }

  const suffix = effortSuffixFromModel(m);
  if (suffix) {
    // Model id already encodes effort. Prefer matching flag; never mismatch.
    if (e && e !== suffix) {
      notes.push(`effort_aligned_to_model_suffix:${e}->${suffix}`);
    } else if (!e) {
      notes.push(`effort_from_model_suffix:${suffix}`);
    }
    e = suffix;
    return { model: m, effort: e, notes, source };
  }

  // Model without suffix: keep requested effort or omit
  return { model: m, effort: e, notes, source };
}

/**
 * If agy rejected model/effort, propose one corrected pair for retry.
 * Returns null if no automatic correction is available.
 */
function suggestEffortRetry(model, effort, errorText) {
  const t = String(errorText || "");
  if (!/invalid model selection|conflicts with --effort|--effort is not supported/i.test(t)) {
    return null;
  }

  // Case A: effort not supported for this model → drop effort
  if (/--effort is not supported/i.test(t)) {
    return normalizeModelEffort(model, null, { source: "retry_drop_effort" });
  }

  // Case B: conflicts with --effort=X → align to model suffix or drop
  const suffix = effortSuffixFromModel(model);
  if (suffix) {
    return normalizeModelEffort(model, suffix, { source: "retry_align_suffix" });
  }

  // Case C: parse suggested effort from error if present
  const m = t.match(/--effort[= ]+(\w+)/i);
  if (m && EFFORT_LEVELS.has(m[1].toLowerCase())) {
    // conflict: try opposite — drop effort
    return normalizeModelEffort(model, null, { source: "retry_drop_effort" });
  }

  return normalizeModelEffort(model, null, { source: "retry_drop_effort" });
}

function classifyError(text, exitCode, timedOut) {
  if (timedOut) return "timeout";
  const t = (text || "").toLowerCase();
  if (
    /invalid model selection|conflicts with --effort|--effort is not supported/.test(
      t
    )
  ) {
    return "invalid_model_selection";
  }
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
  const rawModel =
    model || agy.model_by_phase?.[phase] || agy.default_model || null;
  const rawEffort =
    effort !== null && effort !== undefined
      ? effort
      : agy.effort_by_phase?.[phase] !== undefined
        ? agy.effort_by_phase[phase]
        : agy.default_effort;

  return normalizeModelEffort(rawModel, rawEffort, { source: "config" });
}

function resolveOutputFormat(cfg, cliValue, explicit) {
  if (explicit && cliValue) {
    const v = String(cliValue).toLowerCase();
    if (!OUTPUT_FORMATS.has(v)) {
      die(2, `Invalid --output-format: ${cliValue} (use json|stream-json)`);
    }
    return v;
  }
  const fromCfg = cfg.workers?.agy?.output_format;
  if (fromCfg != null && fromCfg !== "") {
    const v = String(fromCfg).toLowerCase();
    if (!OUTPUT_FORMATS.has(v)) {
      die(2, `Invalid workers.agy.output_format: ${fromCfg}`);
    }
    return v;
  }
  return "json";
}

/**
 * Resolve json-schema path or null (disabled).
 * Spec: default | none | absolute/relative path
 */
function resolveJsonSchemaPath(cfg, cliValue, explicit) {
  let spec = "default";
  if (explicit) {
    spec = cliValue == null || cliValue === "" ? "default" : String(cliValue);
  } else if (cfg.workers?.agy?.json_schema != null) {
    spec = String(cfg.workers.agy.json_schema);
  }

  if (spec === "none" || spec === "false" || spec === "off") return null;
  if (spec === "default" || spec === "true" || spec === "on") {
    return findDefaultSchemaPath();
  }

  const abs = resolve(spec);
  if (!existsSync(abs)) {
    die(2, `json-schema file not found: ${abs}`);
  }
  return abs;
}

function findDefaultSchemaPath() {
  const candidates = [
    // installed next to runner: ~/.config/gentle-ai/bin/../schemas/...
    join(__dirname, "..", "schemas", "sdd-phase-result.schema.json"),
    // package layout if runner invoked from repo package/
    join(__dirname, "..", "..", "schemas", "sdd-phase-result.schema.json"),
    join(homedir(), ".config", "gentle-ai", "schemas", "sdd-phase-result.schema.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return resolve(p);
  }
  die(2, "default json-schema not found (expected schemas/sdd-phase-result.schema.json)", {
    error_class: "unavailable",
    tried: candidates,
  });
}

/**
 * Strip conflicting --output-format / --json-schema from extra_args, then append ours.
 */
function mergeExtraArgs(extraArgs, outputFormat, jsonSchemaPath) {
  const base = Array.isArray(extraArgs) ? [...extraArgs] : [];
  const cleaned = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[i];
    if (a === "--output-format" || a === "--json-schema") {
      i += 1; // skip value
      continue;
    }
    if (
      typeof a === "string" &&
      (a.startsWith("--output-format=") || a.startsWith("--json-schema="))
    ) {
      continue;
    }
    cleaned.push(a);
  }
  cleaned.push("--output-format", outputFormat);
  if (jsonSchemaPath) {
    cleaned.push("--json-schema", jsonSchemaPath);
  }
  return cleaned;
}

function buildDefaultPrompt({
  phase,
  change,
  project,
  artifactStore,
  skillPaths,
}) {
  const skillBlock = skillPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const topicKey =
    phase === "init"
      ? `sdd-init/${project}`
      : `sdd/${change}/${
          phase === "explore"
            ? "explore"
            : phase === "propose"
              ? "proposal"
              : phase === "verify"
                ? "verify-report"
                : phase === "apply"
                  ? "apply-progress"
                  : phase === "archive"
                    ? "archive-report"
                    : phase
        }`;
  return `# ROLE
You are the sdd-${phase} EXECUTOR (not orchestrator). Execute this single phase fully. Do NOT delegate. Do NOT orchestrate other SDD phases.

# BRIDGE CONTRACT
- host: antigravity-cli (agy)
- phase: sdd-${phase}
- change_name: ${change}
- project: ${project}
- artifact_store.mode: ${artifactStore}
- You MAY use Engram MCP tools with project: ${project}
- Source code rule: you MUST NOT modify application source code EXCEPT when phase is "apply" (implementation). For "apply" you MAY edit source files and run tests; NEVER run git commit/push in any phase.
- You MUST NOT run git commit/push
- You MUST NOT start other phases

# SKILLS TO LOAD BEFORE WORK
Read these files completely before doing phase work:
${skillBlock || "(none resolved — follow built-in Gentle SDD conventions)"}

# PROJECT / MEMORY
1. Prefer explicit project name: ${project} on every Engram call.
2. Read required dependency artifacts for this phase from Engram/OpenSpec per SDD conventions.
3. Persist this phase artifact with canonical topic_key ${topicKey}

# FINAL RESPONSE FORMAT
Return structured output matching the json-schema when provided. Shape:
{
  "status": "success",
  "executive_summary": "string",
  "artifacts": ["topic or path strings"],
  "next_recommended": "string",
  "risks": ["string"],
  "skill_resolution": "paths-injected",
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

function artifactTopic(phase, change, project) {
  if (phase === "init") return `sdd-init/${project}`;
  const map = {
    explore: "explore",
    propose: "proposal",
    spec: "spec",
    design: "design",
    tasks: "tasks",
    apply: "apply-progress",
    verify: "verify-report",
    archive: "archive-report",
    onboard: "onboard",
  };
  return `sdd/${change}/${map[phase] || phase}`;
}

function buildCliArgs({
  promptText,
  timeout,
  extra,
  model,
  effort,
  planModeExplore,
  phase,
}) {
  const cliArgs = ["--print", promptText, "--print-timeout", String(timeout)];
  cliArgs.push(...extra);
  if (model) cliArgs.push("--model", String(model));
  if (effort) cliArgs.push("--effort", String(effort));
  if (planModeExplore && phase === "explore") {
    cliArgs.push("--mode", "plan");
  }
  return cliArgs;
}

function runAgyOnce({ agyPath, cliArgs, cwd, env, streamProgress }) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(agyPath, cliArgs, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let progressLineBuf = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      const chunk = String(d);
      stdout += chunk;
      if (streamProgress) {
        // agy 1.1.8 NDJSON: {"event":"step_update","step_update":{"state":"DONE","step_type":"..."}}
        // Buffer across chunks so partial lines are not dropped.
        progressLineBuf += chunk;
        const parts = progressLineBuf.split(/\r?\n/);
        progressLineBuf = parts.pop() || "";
        for (const line of parts) {
          const t = line.trim();
          if (!t.startsWith("{")) continue;
          try {
            const ev = JSON.parse(t);
            if (!ev || ev.event !== "step_update") continue;
            const su =
              ev.step_update && typeof ev.step_update === "object"
                ? ev.step_update
                : ev;
            const state = String(su.state || su.status || ev.state || "").toUpperCase();
            if (state !== "DONE") continue;
            const label =
              su.step_type ||
              su.step ||
              su.name ||
              su.title ||
              su.message ||
              ev.step_type ||
              ev.step ||
              (su.step_index != null ? `step_${su.step_index}` : null) ||
              "step";
            process.stderr.write(`[agy] step done: ${label}\n`);
          } catch {
            /* ignore partial / non-json */
          }
        }
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    child.on("error", (err) => {
      resolvePromise({
        code: 127,
        stdout,
        stderr: String(err.message || err),
        duration_s: (Date.now() - started) / 1000,
        spawn_error: true,
      });
    });

    child.on("close", (code) => {
      resolvePromise({
        code,
        stdout,
        stderr,
        duration_s: (Date.now() - started) / 1000,
        spawn_error: false,
      });
    });
  });
}

function stripMarkdownFences(text) {
  let s = String(text || "").trim();
  // ```json ... ``` or ``` ... ```
  const fenced = s.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
  if (fenced) return fenced[1].trim();
  // leading fence without clean end
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json|JSON)?\s*\r?\n?/, "");
    s = s.replace(/\r?\n?```\s*$/, "");
    return s.trim();
  }
  return s;
}

function tryParseJsonObject(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Parse first or last valid JSON object from concatenated JSON (stream quirk).
 * Prefer object that has a `status` field; else last successful parse.
 */
function parseJsonLoose(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const direct = tryParseJsonObject(s);
  if (direct && typeof direct === "object") return direct;

  const stripped = stripMarkdownFences(s);
  const afterFence = tryParseJsonObject(stripped);
  if (afterFence && typeof afterFence === "object") return afterFence;

  // Scan for balanced {...} objects
  const objects = [];
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < stripped.length; j++) {
      const c = stripped[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const slice = stripped.slice(i, j + 1);
          const obj = tryParseJsonObject(slice);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            objects.push(obj);
          }
          i = j;
          break;
        }
      }
    }
  }

  if (!objects.length) return null;
  const withStatus = objects.filter(
    (o) => o && typeof o.status === "string"
  );
  if (withStatus.length) return withStatus[withStatus.length - 1];
  return objects[objects.length - 1];
}

/**
 * For stream-json: NDJSON lines; last event==="result" object's .result is envelope.
 */
function extractFromStreamJson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  let lastResult = null;
  let lastResultEvent = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev && ev.event === "result") {
      lastResultEvent = ev;
      if (ev.result != null && typeof ev.result === "object") {
        lastResult = ev.result;
      } else if (typeof ev.result === "string") {
        lastResult = parseJsonLoose(ev.result) || { response: ev.result };
      }
    }
  }
  if (!lastResult && !lastResultEvent) {
    return { ok: false, reason: "no_result_event" };
  }
  // Some emitters put fields on the event itself
  if (!lastResult && lastResultEvent) {
    const { event: _e, ...rest } = lastResultEvent;
    lastResult = rest;
  }
  return { ok: true, parsed: lastResult, event: lastResultEvent };
}

function coerceInner(parsed) {
  let structuredUsed = false;
  let inner = null;

  if (
    parsed &&
    parsed.structured_output != null &&
    typeof parsed.structured_output === "object" &&
    !Array.isArray(parsed.structured_output)
  ) {
    inner = parsed.structured_output;
    structuredUsed = true;
    return { inner, structuredUsed };
  }

  if (parsed && typeof parsed.response === "string") {
    const cleaned = stripMarkdownFences(parsed.response);
    const fromResp = parseJsonLoose(cleaned);
    if (fromResp && typeof fromResp === "object") {
      // nested structured_output inside response JSON
      if (
        fromResp.structured_output != null &&
        typeof fromResp.structured_output === "object" &&
        !Array.isArray(fromResp.structured_output)
      ) {
        return {
          inner: fromResp.structured_output,
          structuredUsed: true,
        };
      }
      return { inner: fromResp, structuredUsed: false };
    }
    return {
      inner: {
        status: parsed.status === "SUCCESS" || parsed.status === "success"
          ? "success"
          : "failed",
        executive_summary: String(parsed.response).slice(0, 800),
        error_class: null,
        raw_response: true,
      },
      structuredUsed: false,
    };
  }

  // parsed itself may already be the phase contract
  if (parsed && typeof parsed === "object") {
    inner = parsed;
  }
  return { inner, structuredUsed };
}

function parseAgyResult({
  code,
  stdout,
  stderr,
  duration_s,
  meta,
  timedOut,
  outputFormat,
}) {
  let parsed = null;
  let parseNote = null;

  if (outputFormat === "stream-json") {
    const extracted = extractFromStreamJson(stdout);
    if (!extracted.ok) {
      const errClass =
        classifyError(stderr + stdout, code, timedOut) || "contract";
      return {
        ok: false,
        errClass,
        parsed: null,
        inner: null,
        envelope: {
          status: "failed",
          error_class: errClass,
          message: "stream-json: no event===\"result\" in stdout",
          exit_code: code,
          duration_s,
          stderr_tail: (stderr || "").slice(-2000),
          stdout_tail: (stdout || "").slice(-2000),
          ...meta,
        },
      };
    }
    parsed = extracted.parsed;
    parseNote = "stream-json-result-event";
  } else {
    parsed = parseJsonLoose((stdout || "").trim());
    if (!parsed) {
      const errClass =
        classifyError(stderr + stdout, code, timedOut) || "contract";
      return {
        ok: false,
        errClass,
        parsed: null,
        inner: null,
        envelope: {
          status: "failed",
          error_class: errClass,
          message: "agy stdout was not valid JSON",
          exit_code: code,
          duration_s,
          stderr_tail: (stderr || "").slice(-2000),
          stdout_tail: (stdout || "").slice(-2000),
          ...meta,
        },
      };
    }
  }

  const { inner, structuredUsed } = coerceInner(parsed);

  const blob = `${stderr || ""}\n${JSON.stringify(parsed)}`;
  const errClass =
    inner?.error_class || classifyError(blob, code, timedOut);

  // Authority for transport success: agy envelope SUCCESS + exit 0.
  // Inner "partial" with SUCCESS still counts as transport ok; store gate is orchestrator-side.
  const agyOk =
    code === 0 &&
    (parsed?.status === "SUCCESS" ||
      parsed?.status === "success" ||
      inner?.status === "success" ||
      inner?.status === "SUCCESS" ||
      inner?.status === "partial");

  const failedExplicit =
    parsed?.status === "ERROR" ||
    parsed?.status === "error" ||
    inner?.status === "failed" ||
    inner?.status === "FAILED";

  const ok = agyOk && !failedExplicit && inner != null;

  return {
    ok,
    errClass: ok ? null : errClass || "unknown",
    parsed,
    inner,
    envelope: {
      status: ok ? "success" : "failed",
      error_class: ok ? null : errClass || "unknown",
      exit_code: code,
      duration_s,
      agy_status: parsed?.status ?? null,
      conversation_id: parsed?.conversation_id ?? null,
      result: inner,
      structured_output_used: !!structuredUsed,
      parse_note: parseNote,
      expected_topic_key: meta.expected_topic_key,
      gate_note:
        "Orchestrator MUST validate artifact in Engram/OpenSpec; stdout is not authority.",
      ...meta,
      usage: parsed?.usage ?? null,
      stderr_tail: stderr ? stderr.slice(-1000) : "",
      error_text: !ok
        ? String(parsed?.error || parsed?.response || stderr || "").slice(0, 500)
        : undefined,
    },
  };
}

function exitForEnvelope(envelope) {
  if (envelope.status === "success") process.exit(0);
  if (
    envelope.error_class === "quota_exceeded" ||
    envelope.error_class === "timeout" ||
    envelope.error_class === "unavailable" ||
    envelope.error_class === "invalid_model_selection"
  ) {
    process.exit(4);
  }
  process.exit(5);
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
  die(3, `agy not found on PATH (command=${agyCmd})`, {
    error_class: "unavailable",
  });
}

let resolved = resolveModelEffort(cfg, args.phase, args.model, args.effort);
const timeout = resolveTimeout(cfg, args.phase, args.timeout);
const outputFormat = resolveOutputFormat(
  cfg,
  args.outputFormat,
  args.outputFormatExplicit
);
const jsonSchemaPath = resolveJsonSchemaPath(
  cfg,
  args.jsonSchema,
  args.jsonSchemaExplicit
);

const skillName = phaseSkillName(args.phase);
const mainSkill = discoverSkill(cfg, args.cwd, skillName);
const shared = discoverSkill(cfg, args.cwd, "_shared");
const skillPaths = [];
if (mainSkill) skillPaths.push(mainSkill);
if (shared) {
  const sharedParent = resolve(String(shared).replace(/SKILL\.md$/, ""));
  for (const f of [
    join(sharedParent, "sdd-phase-common.md"),
    join(sharedParent, "engram-convention.md"),
  ]) {
    if (existsSync(f) && !skillPaths.includes(f)) skillPaths.push(f);
  }
}

let promptText = args.prompt;
if (args.promptFile) {
  if (!existsSync(args.promptFile))
    die(2, `prompt file missing: ${args.promptFile}`);
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

const rawExtra = cfg.workers?.agy?.extra_args || [
  "--dangerously-skip-permissions",
];
const extra = mergeExtraArgs(rawExtra, outputFormat, jsonSchemaPath);

const env = {
  ...process.env,
  ENGRAM_PROJECT: args.project,
};

function metaFor(resolvedPair, extraFields = {}) {
  return {
    worker: "agy",
    phase: args.phase,
    change: args.change,
    project: args.project,
    cwd: args.cwd,
    model: resolvedPair.model,
    effort: resolvedPair.effort,
    effort_notes: resolvedPair.notes || [],
    timeout,
    agy_path: agyPath,
    skill_paths: skillPaths,
    expected_topic_key: artifactTopic(args.phase, args.change, args.project),
    artifact_store: args.artifactStore,
    output_format: outputFormat,
    json_schema_path: jsonSchemaPath,
    ...extraFields,
  };
}

const cliArgs = buildCliArgs({
  promptText,
  timeout,
  extra,
  model: resolved.model,
  effort: resolved.effort,
  planModeExplore: !!cfg.workers?.agy?.plan_mode_explore,
  phase: args.phase,
});

if (args.dryRun) {
  process.stdout.write(
    JSON.stringify(
      {
        status: "dry_run",
        command: agyPath,
        args: cliArgs.map((a, i) =>
          i === 1 ? `<prompt ${promptText.length} chars>` : a
        ),
        normalization: resolved,
        output_format: outputFormat,
        json_schema_path: jsonSchemaPath,
        ...metaFor(resolved),
      },
      null,
      2
    ) + "\n"
  );
  process.exit(0);
}

const t0 = Date.now();
let attempt = await runAgyOnce({
  agyPath,
  cliArgs,
  cwd: args.cwd,
  env,
  streamProgress: args.streamProgress && outputFormat === "stream-json",
});

let timedOut = /timeout|deadline/i.test(attempt.stderr + attempt.stdout);
let parsedAttempt = parseAgyResult({
  ...attempt,
  timedOut,
  outputFormat,
  meta: metaFor(resolved, { attempt: 1 }),
});

// Auto-retry once on invalid model/effort selection
if (
  !parsedAttempt.ok &&
  parsedAttempt.errClass === "invalid_model_selection"
) {
  const errText =
    parsedAttempt.envelope.error_text ||
    attempt.stderr +
      attempt.stdout +
      JSON.stringify(parsedAttempt.parsed || {});
  const retryPair = suggestEffortRetry(
    resolved.model,
    resolved.effort,
    errText
  );

  const same =
    retryPair &&
    retryPair.model === resolved.model &&
    retryPair.effort === resolved.effort;

  if (retryPair && !same) {
    const retryArgs = buildCliArgs({
      promptText,
      timeout,
      extra,
      model: retryPair.model,
      effort: retryPair.effort,
      planModeExplore: !!cfg.workers?.agy?.plan_mode_explore,
      phase: args.phase,
    });

    const attempt2 = await runAgyOnce({
      agyPath,
      cliArgs: retryArgs,
      cwd: args.cwd,
      env,
      streamProgress: args.streamProgress && outputFormat === "stream-json",
    });

    timedOut = /timeout|deadline/i.test(attempt2.stderr + attempt2.stdout);
    parsedAttempt = parseAgyResult({
      ...attempt2,
      timedOut,
      outputFormat,
      meta: metaFor(retryPair, {
        attempt: 2,
        retried_from: {
          model: resolved.model,
          effort: resolved.effort,
          error_class: "invalid_model_selection",
        },
        first_attempt_duration_s: attempt.duration_s,
      }),
    });
    resolved = retryPair;
  }
}

const totalDuration = (Date.now() - t0) / 1000;
parsedAttempt.envelope.duration_s_total = totalDuration;

process.stdout.write(JSON.stringify(parsedAttempt.envelope, null, 2) + "\n");
exitForEnvelope(parsedAttempt.envelope);
