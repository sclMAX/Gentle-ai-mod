#!/usr/bin/env node
/** Launch one non-SDD delegated task through the herdr transport. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASK_KINDS = new Set(["explore", "general", "writer"]);

function die(message, extra = {}) {
  const envelope = { status: "failed", error_class: "unavailable", message, ...extra };
  process.stderr.write(`${message}\n`);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.exit(2);
}

function help() {
  process.stdout.write(`run-agy-task — launch one non-SDD delegated task via agy inside herdr

Usage:
  node run-agy-task.mjs --task-kind <kind> --project <id> --cwd <repo> [options]

Required: --task-kind explore|general|writer, --project, --cwd
Prompt:   --prompt-file <path> (preferred) or --prompt <text>
Options:  --model <id> --effort <low|medium|high> --timeout <duration>
          --task-label <label> --dry-run
`);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  help();
  process.exit(0);
}

const forwarded = [];
let taskKind = null;
let project = null;
let cwd = process.cwd();
let prompt = false;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) die(`Missing value for ${flag}`, { error_class: "invalid_arguments" });
    return argv[++i];
  };
  if (flag === "--task-kind") taskKind = next();
  else if (flag === "--project") project = next();
  else if (flag === "--cwd") cwd = resolve(next());
  else if (flag === "--prompt" || flag === "--prompt-file") { prompt = true; forwarded.push(flag, next()); }
  else if (["--model", "--effort", "--timeout", "--task-label"].includes(flag)) forwarded.push(flag, next());
  else if (flag === "--dry-run") forwarded.push(flag);
  else die(`Unknown flag: ${flag}`, { error_class: "invalid_arguments" });
}

if (!taskKind || !TASK_KINDS.has(taskKind)) die("Invalid or missing --task-kind. Expected explore, general, or writer", { error_class: "invalid_arguments" });
if (!project) die("Missing --project", { error_class: "invalid_arguments" });
if (!existsSync(cwd)) die(`cwd does not exist: ${cwd}`, { error_class: "invalid_cwd" });
if (!prompt) die("Missing --prompt-file or --prompt", { error_class: "invalid_arguments" });

const herdrRunner = join(__dirname, "run-agy-phase-herdr.mjs");
if (!existsSync(herdrRunner)) die("run-agy-phase-herdr.mjs not found next to runner.", { error_class: "herdr_missing" });

const result = spawnSync(process.execPath, [herdrRunner, "--task-kind", taskKind, "--project", project, "--cwd", cwd, ...forwarded], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) die(`Failed to launch herdr runner: ${result.error.message}`, { error_class: "herdr_missing" });
process.exit(result.status ?? 1);
