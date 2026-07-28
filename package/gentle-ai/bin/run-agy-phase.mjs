#!/usr/bin/env node
/**
 * run-agy-phase — cross-platform SDD phase launcher for Antigravity CLI (agy)
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
import { join, resolve, delimiter } from "node:path";

const ELIGIBLE = new Set([
  "explore",
  "propose",
  "spec",
  "design",
  "tasks",
  "verify",
]);

const EFFORT_LEVELS = new Set(["low", "medium", "high"]);

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
        process.stdout.write(
          "run-agy-phase — launch one SDD phase via agy (portable)\n"
        );
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

function buildDefaultPrompt({
  phase,
  change,
  project,
  artifactStore,
  skillPaths,
}) {
  const skillBlock = skillPaths.map((p, i) => `${i + 1}. ${p}`).join("\n");
  const topic =
    phase === "explore"
      ? "explore"
      : phase === "propose"
        ? "proposal"
        : phase === "verify"
          ? "verify-report"
          : phase;
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
3. Persist this phase artifact with canonical topic_key sdd/${change}/${topic}

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

function runAgyOnce({ agyPath, cliArgs, cwd, env }) {
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
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

function parseAgyResult({ code, stdout, stderr, duration_s, meta, timedOut }) {
  let parsed = null;
  try {
    parsed = JSON.parse((stdout || "").trim() || "null");
  } catch {
    const errClass =
      classifyError(stderr + stdout, code, timedOut) || "contract";
    return {
      ok: false,
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

  let inner = parsed;
  if (parsed && typeof parsed.response === "string") {
    try {
      inner = JSON.parse(parsed.response);
    } catch {
      inner = {
        status: parsed.status === "SUCCESS" ? "success" : "failed",
        executive_summary: String(parsed.response).slice(0, 800),
        error_class: null,
        raw_response: true,
      };
    }
  }

  const blob = `${stderr || ""}\n${JSON.stringify(parsed)}`;
  const errClass =
    inner?.error_class || classifyError(blob, code, timedOut);

  // Authority for transport success: agy envelope SUCCESS + exit 0.
  // Inner "partial" with SUCCESS still counts as transport ok; store gate is orchestrator-side.
  const agyOk =
    code === 0 &&
    (parsed?.status === "SUCCESS" ||
      parsed?.status === "success" ||
      inner?.status === "success");

  const failedExplicit =
    parsed?.status === "ERROR" ||
    parsed?.status === "error" ||
    inner?.status === "failed";

  const ok = agyOk && !failedExplicit;

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

const extra = cfg.workers?.agy?.extra_args || [
  "--output-format",
  "json",
  "--dangerously-skip-permissions",
];

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
    expected_topic_key: artifactTopic(args.phase, args.change),
    artifact_store: args.artifactStore,
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
});

let timedOut = /timeout|deadline/i.test(attempt.stderr + attempt.stdout);
let parsedAttempt = parseAgyResult({
  ...attempt,
  timedOut,
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
    });

    timedOut = /timeout|deadline/i.test(attempt2.stderr + attempt2.stdout);
    parsedAttempt = parseAgyResult({
      ...attempt2,
      timedOut,
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
