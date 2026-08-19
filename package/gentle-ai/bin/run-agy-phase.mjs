#!/usr/bin/env node
/**
 * run-agy-phase — SDD phase launcher for Antigravity CLI (agy) via herdr
 *
 * v2.0 (2026-08-15):
 *   - herdr is now the ONLY transport. The legacy `direct` transport was
 *     removed: without herdr there is no way to watch what agy is doing
 *     (tabs, panes, live model output). Any `--transport direct` or
 *     `workers.agy.transport: direct` config is ignored with a warning and
 *     execution always delegates to run-agy-phase-herdr.mjs.
 *
 * v1.6:
 *   - --stream-progress-detail summary|tools|full; workers.agy.stream_progress_detail
 *     config (default summary)
 *     summary: friendly label only (previous behavior)
 *     tools:   + tool name and key parameters (run_command -> CommandLine, etc.)
 *     full:    tools + live text_delta streaming of the model response +
 *              duration/tokens when each step closes
 *   - Envelope meta includes stream_progress_detail
 *
 * v1.5:
 *   - Live stderr progress by default on stream-json: lifecycle start line,
 *     step RUNNING/DONE ticks with friendly labels, result event notice,
 *     liveness heartbeat (120s) when no step event arrives
 *   - --no-stream-progress disables ticks; workers.agy.stream_progress config
 *     (default true) sets the default
 *   - workers.yaml default output_format switched to stream-json
 *
 * v1.4:
 *   - Native /sdd-<phase> skill expansion in print mode (agy >= 1.1.9)
 *   - workers.agy.slash_command_skills / --slash-command-skills: auto|on|off
 *   - off mode appends --disable-slash-commands on agy >= 1.1.9 (literal prompts)
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
 *   6 herdr transport unavailable
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  process.stdout.write(`run-agy-phase — launch one SDD phase via agy inside herdr (portable)

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
  --slash-command-skills <mode>
                           auto|on|off native /sdd-<phase> skill expansion
                           (default: auto — enabled when agy >= 1.1.9)
  --stream-progress        stderr progress for stream-json step events (default: config, then on)
  --no-stream-progress     disable stderr progress ticks even when stream-json
  --stream-progress-detail <level>
                           summary|tools|full (default: config, then summary)
                           summary = friendly label only
                           tools   = + tool name and key parameters
                           full    = tools + live model text_delta + duration/tokens
  --dry-run                print resolved CLI args and exit 0
  --json                   kept for compatibility (always JSON envelope)
  -h, --help               show help

Transport:
  herdr is the ONLY transport (v2.0). --transport and workers.agy.transport
  are ignored with a warning; the legacy direct transport is removed.

Exit codes: 0 ok | 2 usage | 3 agy missing | 4 agy fail | 5 contract | 6 herdr missing
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
    transport: null,
    dryRun: false,
    json: true,
    outputFormat: null, // null = use config default then json
    jsonSchema: null, // null = use config default then default
    slashCommandSkills: null, // null = use config default then auto
    slashCommandSkillsExplicit: false,
    streamProgress: false,
    streamProgressExplicit: false,
    streamProgressDetail: null, // null = use config default then summary
    streamProgressDetailExplicit: false,
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
      case "--transport":
        out.transport = next();
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
      case "--slash-command-skills": {
        const v = next();
        out.slashCommandSkills = v;
        out.slashCommandSkillsExplicit = true;
        break;
      }
      case "--stream-progress":
        out.streamProgress = true;
        out.streamProgressExplicit = true;
        break;
      case "--no-stream-progress":
        out.streamProgress = false;
        out.streamProgressExplicit = false;
        break;
      case "--stream-progress-detail": {
        const v = next();
        out.streamProgressDetail = v;
        out.streamProgressDetailExplicit = true;
        break;
      }
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

// --- main ---
if (!args.phase || !ELIGIBLE.has(args.phase)) {
  die(2, `Invalid or missing --phase. Eligible: ${[...ELIGIBLE].join(", ")}`);
}
if (!args.change) die(2, "Missing --change");
if (!args.project) die(2, "Missing --project");
if (!existsSync(args.cwd)) die(2, `cwd does not exist: ${args.cwd}`);

const cfg = loadConfig(args.config, args.cwd);

// herdr is the ONLY transport (v2.0). The legacy `direct` transport was
// removed: without herdr there is no way to watch what agy is doing.
const requestedTransport = args.transport || cfg.workers?.agy?.transport || "herdr";
if (requestedTransport !== "herdr") {
  process.stderr.write(
    `[agy] warning: transport "${requestedTransport}" is no longer supported — forcing herdr. ` +
      `Remove --transport / workers.agy.transport from config.\n`
  );
}

const herdrRunner = join(__dirname, "run-agy-phase-herdr.mjs");

// v2.2: Compute filtered extra_args from workers.yaml config.
// The runner manages --output-format, --json-schema, and --no-json-schema
// directly — strip them (and their values) from extra_args to avoid conflicts.
const MANAGED_FLAGS = new Set(["--output-format", "--json-schema", "--no-json-schema"]);
const rawExtraArgs = cfg.workers?.agy?.extra_args;
const filteredExtraArgs = [];
if (Array.isArray(rawExtraArgs)) {
  let skipNext = false;
  for (const a of rawExtraArgs) {
    if (skipNext) { skipNext = false; continue; }
    if (MANAGED_FLAGS.has(a)) { skipNext = true; continue; }
    filteredExtraArgs.push(a);
  }
}

// Build herdr args: forward all original CLI args, then inject extra_args.
const herdrArgs = [...process.argv.slice(2)];
if (filteredExtraArgs.length > 0) {
  herdrArgs.push("--extra-args", JSON.stringify(filteredExtraArgs));
}

const res = spawnSync(process.execPath, [herdrRunner, ...herdrArgs], {
  stdio: "inherit",
  env: process.env,
});
if (res.error && res.error.code === 'ENOENT') {
  die(6, "run-agy-phase-herdr.mjs not found next to runner.", { error_class: "herdr_missing" });
}
process.exit(res.status ?? 1);