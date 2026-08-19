#!/usr/bin/env node
import { spawnSync, spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

let finished = false;
let cleanedUp = false;
let pollInterval = null;
let child = null;
let tabId = null;
let paneId = null;

function cleanupAgent() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (tabId) spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
  } catch (e) {}
}

function die(code, msg, extra = {}) {
  if (finished) return;
  finished = true;
  if (pollInterval) clearInterval(pollInterval);
  if (child) {
    try { child.kill(); } catch (e) {}
  }
  cleanupAgent();
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

const socketPath = process.env.HERDR_SOCKET_PATH;
if (!socketPath) {
  die(6, "HERDR_SOCKET_PATH not set. herdr missing.", { error_class: "herdr_missing" });
}
if (!isAbsolute(socketPath)) {
  die(6, "HERDR_SOCKET_PATH must be absolute.", { error_class: "herdr_missing" });
}

// Ensure herdr is reachable (skip in dry-run to allow tests to pass if herdr isn't installed)
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

if (!dryRun) {
  const herdrCheck = spawnSync("herdr", ["status"], { encoding: "utf8" });
  if (herdrCheck.error || herdrCheck.status !== 0) {
    die(6, "herdr is not running or accessible.", { error_class: "herdr_missing" });
  }
}

let phase, taskKind, taskLabel, change, project, cwd = process.cwd(), promptText = "", promptFile = "";
let model = null, effort = null, timeoutArg = null;
let extraArgsRaw = null; // JSON array string from wrapper (--extra-args)

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--phase") phase = next();
  else if (a === "--task-kind") taskKind = next();
  else if (a === "--task-label") taskLabel = next();
  else if (a === "--change") change = next();
  else if (a === "--project") project = next();
  else if (a === "--cwd") cwd = next();
  else if (a === "--prompt") promptText = next();
  else if (a === "--prompt-file") promptFile = next();
  else if (a === "--model") model = next();
  else if (a === "--effort") effort = next();
  else if (a === "--timeout") timeoutArg = next();
  else if (a === "--extra-args") extraArgsRaw = next();
}

/**
 * Parse a duration like "20m", "90s", "1h" or raw milliseconds into ms.
 * Returns null when the value is missing or unparseable.
 */
function parseTimeoutMs(value) {
  if (!value) return null;
  const s = String(value).trim();
  const m = s.match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return n * mult;
}

/** Models that reject --effort entirely (mirror of run-agy-phase.mjs). */
function modelSupportsEffortFlag(modelId) {
  if (!modelId) return true;
  const id = String(modelId).toLowerCase();
  if (id.includes("claude")) return false;
  if (id.includes("opus") && id.includes("thinking")) return false;
  if (id.startsWith("gpt-oss")) return false;
  return true;
}

const isTask = Boolean(taskKind);
if (isTask && !["explore", "general", "writer"].includes(taskKind)) {
  die(2, "Invalid --task-kind. Expected explore, general, or writer", { error_class: "invalid_arguments" });
}
if ((!isTask && (!phase || !change)) || !project) {
  die(2, isTask ? "Missing required arguments: --task-kind, --project" : "Missing required arguments: --phase, --change, --project");
}

cwd = resolve(cwd);

let repoRoot;
try {
  repoRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8", cwd: process.cwd() }).trim();
} catch (e) {
  repoRoot = process.cwd();
}
if (!cwd.startsWith(repoRoot)) {
  die(2, "cwd validation failed: path is not under repo root", { error_class: "invalid_cwd" });
}

if (promptFile && existsSync(promptFile)) {
  promptText = readFileSync(promptFile, "utf8");
} else if (!promptText) {
  promptText = "Follow conventions.";
}

const effectiveLabel = taskLabel || `agy-task-${taskKind}`;

if (dryRun) {
  console.log(`Dry run executing with transport herdr. prompt length: ${promptText.length}`);
  if (isTask) console.log(`Task kind: ${taskKind}  Label: ${effectiveLabel}`);
  console.log(`Model: ${model || "(default)"}  Effort: ${effort || "(none)"}  Timeout: ${timeoutArg || "(default 10m)"}`);
  console.log(`Agent start args: ${JSON.stringify(agentStartArgsForDryRun())}`);
  console.log(`Prompt used: ${promptText}`);
  process.exit(0);
}

function agentStartArgsForDryRun() {
  const args = ["agent", "start", isTask ? `agy-task-${taskKind}-<ts>` : "sdd-agent-<ts>", "--kind", "agy", "--pane", "<pane>"];
  const cli = [];
  if (model) cli.push("--model", String(model));
  if (effort && modelSupportsEffortFlag(model)) cli.push("--effort", String(effort));
  if (extraArgsRaw) {
    try {
      const parsed = JSON.parse(extraArgsRaw);
      if (Array.isArray(parsed)) cli.push(...parsed);
    } catch (_) {}
  }
  if (cli.length) args.push("--", ...cli);
  return args;
}

// Apply runs in the main worktree like every other phase. No herdr worktree
// isolation: git itself is the safety net (diff/checkout), and the RDD
// correction transaction expects candidate changes in the lineage repo.
let activeCwd = cwd;

const workspaceId = process.env.HERDR_WORKSPACE_ID || "default";
const label = isTask ? effectiveLabel : `sdd-${phase}-${change}`;
const tabRes = spawnSync("herdr", ["tab", "create", "--workspace", workspaceId, "--cwd", activeCwd, "--label", label], { encoding: "utf8" });
if (tabRes.status !== 0) {
  die(4, "Failed to create tab: " + tabRes.stderr);
}
try {
  const tabData = JSON.parse(tabRes.stdout);
  tabId = tabData.result?.tab?.tab_id || tabData.result?.root_pane?.tab_id;
  paneId = tabData.result?.root_pane?.pane_id;
} catch (e) {
  die(4, "Failed to parse tab create response: " + tabRes.stdout);
}
if (!tabId || !paneId) {
  die(4, "tab create response missing tab_id/pane_id: " + tabRes.stdout);
}

const agentName = isTask ? `agy-task-${taskKind}-${Date.now()}` : `sdd-agent-${Date.now()}`;
const agentStartArgs = ["agent", "start", agentName, "--kind", "agy", "--pane", paneId];
// Pass model/effort through to the agy CLI via the trailing `--` agent args.
// Without this, agy starts with its own default model (e.g. Gemini 3.7 Flash
// medium) no matter what --model the orchestrator requested.
const agentCliArgs = [];
if (model) agentCliArgs.push("--model", String(model));
if (effort && modelSupportsEffortFlag(model)) agentCliArgs.push("--effort", String(effort));
// v2.2: inject extra_args from workers.yaml (passed by the wrapper via --extra-args).
// These are config-driven agy CLI flags that the runner does not manage directly
// (e.g. --dangerously-skip-permissions). The wrapper strips flags the runner
// already controls (--output-format, --json-schema) before forwarding.
if (extraArgsRaw) {
  try {
    const parsed = JSON.parse(extraArgsRaw);
    if (Array.isArray(parsed)) agentCliArgs.push(...parsed);
  } catch (_) {
    // Malformed extra_args: ignore silently rather than blocking the run.
    // The wrapper is responsible for producing valid JSON.
  }
}
if (agentCliArgs.length) agentStartArgs.push("--", ...agentCliArgs);
const agentRes = spawnSync("herdr", agentStartArgs, { encoding: "utf8" });
if (agentRes.status !== 0) {
  die(4, "Failed to start agent: " + agentRes.stderr);
}
let agentTarget = agentName;
try {
  const agentData = JSON.parse(agentRes.stdout);
  agentTarget = agentData.result?.agent?.name || agentData.result?.agent?.target || agentName;
} catch (e) {
  // plain text target (older CLI)
  agentTarget = agentRes.stdout.trim() || agentName;
}

const sentinelFile = join(tmpdir(), `agy_result_${Date.now()}.json`);
const promptWithSentinel = `${promptText}\n\nIMPORTANT: when finished, write your structured result JSON to exactly this path (overwrite the file, absolute path):\n${sentinelFile}\n`;

const promptTimeoutMs = parseTimeoutMs(timeoutArg) || 10 * 60 * 1000;
const promptArgs = ["agent", "prompt", agentTarget, promptWithSentinel, "--wait", "--timeout", String(promptTimeoutMs)];

let promptAttempt = 0;
const MAX_PROMPT_ATTEMPTS = 3;
const VERIFY_PATTERN = /verifying your account|account eligibility|try again shortly/i;
const VERIFY_RETRY_MS = Number(process.env.GGA_HERDR_VERIFY_RETRY_MS || 15000);
const RETRY_MS = Number(process.env.GGA_HERDR_RETRY_MS || 3000);
const MAX_VERIFY_ATTEMPTS = Number(process.env.GGA_HERDR_MAX_VERIFY_ATTEMPTS || 5);
// v2.1: sentinel grace — after herdr reports `done`, keep polling for the
// sentinel result file for this long. Claude (Thinking) models finish their
// first response turn before writing the sentinel in a later turn; the old 1s
// grace produced deterministic "Contract violation: result file not found".
const SENTINEL_GRACE_MS = Number(process.env.GGA_HERDR_SENTINEL_GRACE_MS || 60000);
// v2.1: stalled-prompt re-send — on `agent_prompt_stalled` with the agent still
// idle and seq/revision unchanged, the prompt was never delivered (agy TUI not
// ready). Re-send it with backoff up to MAX_STALL_RETRY_ATTEMPTS times.
const STALL_RETRY_MS = Number(process.env.GGA_HERDR_STALL_RETRY_MS || 8000);
const MAX_STALL_RETRY_ATTEMPTS = Number(process.env.GGA_HERDR_MAX_STALL_RETRY_ATTEMPTS || 3);

let promptOutput = "";
let verifyMode = false;

function tryReadSentinel() {
  if (!existsSync(sentinelFile)) return null;
  try {
    const raw = readFileSync(sentinelFile, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function getAgentInfo() {
  const res = spawnSync("herdr", ["agent", "get", agentTarget], { encoding: "utf8" });
  if (res.status !== 0) return null;
  try {
    const d = JSON.parse(res.stdout);
    return d.result?.agent || d.agent || null;
  } catch (e) {
    return null;
  }
}

function getAgentRecentText() {
  const res = spawnSync("herdr", [
    "agent", "read", agentTarget,
    "--source", "recent",
    "--lines", "40",
    "--format", "text"
  ], { encoding: "utf8" });
  return res.status === 0 ? `${res.stdout || ""}\n${res.stderr || ""}` : "";
}

function completeWithResult(parsed) {
  if (finished) return;
  finished = true;
  if (pollInterval) clearInterval(pollInterval);
  if (child) {
    try { child.kill(); } catch (e) {}
  }

  const agent = getAgentInfo();
  let conversationId = null;
  if (agent) {
    conversationId = agent.agent_session?.value || agent.conversationId;
  }

  if (conversationId) {
    // engram CLI shape: engram save <title> <msg> [--type TYPE] [--project PROJECT] [--scope SCOPE]
    const memArgs = [
      "save",
      isTask ? `conversationId task ${taskKind}` : `conversationId ${phase} ${change}`,
      conversationId,
      "--type", "architecture",
      "--project", project,
      "--scope", "project"
    ];
    spawnSync("engram", memArgs);
  }

  let inner = parsed.response || parsed;
  const ok = inner && inner.status !== "failed" && inner.status !== "ERROR";

  const envelope = {
    ...inner, // Flatten inner fields
    status: ok ? "success" : "failed",
    error_class: ok ? null : (inner?.error_class || "contract"),
    exit_code: ok ? 0 : 5,
    result: inner,
    worker: "agy",
    ...(isTask ? { task_kind: taskKind, task_label: effectiveLabel } : { phase, change_name: change }),
    project,
    cwd,
    transport: "herdr",
    model: model || null,
    effort: effort || null,
    prompt_timeout_ms: promptTimeoutMs,
    conversation_id: conversationId,
    tab_id: tabId
  };

  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");

  cleanupAgent();

  exitForEnvelope(envelope);
}

function launchPrompt() {
  if (finished) return;
  promptAttempt++;
  promptOutput = "";
  // Capture the agent's observed state before submitting. If the prompt
  // stalls and the agent is still idle with the same seq/revision, the
  // prompt was never delivered (agy TUI not ready) — re-send it.
  const preAgent = getAgentInfo();
  seqAtPrompt = preAgent?.state_change_seq ?? null;
  revAtPrompt = preAgent?.revision ?? null;
  child = spawn("herdr", promptArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { promptOutput += d; process.stdout.write(d); });
  child.stderr.on("data", (d) => { promptOutput += d; process.stderr.write(d); });
  child.on("close", (code) => {
    child = null;
    if (finished) return;

    // A stalled prompt may not include the pane's account-verification notice.
    // Read the pane only for this inconclusive handshake, not on every poll.
    const needsPaneRead = /agent_prompt_stalled/i.test(promptOutput) && !VERIFY_PATTERN.test(promptOutput);
    const paneOutput = needsPaneRead ? getAgentRecentText() : "";
    if (VERIFY_PATTERN.test(`${promptOutput}\n${paneOutput}`)) {
      verifyMode = true;
      if (promptAttempt < MAX_VERIFY_ATTEMPTS) {
        setTimeout(launchPrompt, VERIFY_RETRY_MS);
        return;
      }
      die(4, "Account verification pending: agy is verifying the account", {
        error_class: "unavailable",
        stall_reason: "account_verification",
        attempts: promptAttempt
      });
      return;
    }

    const sentinel = tryReadSentinel();
    if (sentinel) {
      completeWithResult(sentinel);
      return;
    }

    // Prompt closed (code 0, agent_prompt_stalled after 5s, or non-zero).
    // Treat the 5-second wait handshake as inconclusive: check agent status.
    const agent = getAgentInfo();
    if (!agent) {
      return;
    }

    const terminalDeadStates = new Set(["crashed", "failed", "error", "killed", "stopped", "terminated", "exited"]);
    if (terminalDeadStates.has(agent.agent_status)) {
      const lastCheck = tryReadSentinel();
      if (lastCheck) {
        completeWithResult(lastCheck);
        return;
      }
      die(4, `Agent in terminal dead state: ${agent.agent_status}`, { error_class: "unavailable", agent_status: agent.agent_status });
      return;
    }

    if (agent.agent_status === "done") {
      const lastCheck = tryReadSentinel();
      if (lastCheck) {
        completeWithResult(lastCheck);
        return;
      }
      // v2.1: do NOT die at 1s here — the poll observes `done` and enforces
      // SENTINEL_GRACE_MS. Claude (Thinking) writes the sentinel in a later
      // turn, seconds after herdr first reports done.
      return;
    }

    // v2.1: stalled-prompt re-send. `agent_prompt_stalled` means herdr saw no
    // state change within 5s. If the agent is still idle with the SAME
    // seq/revision as before the prompt, the prompt text was never delivered
    // (agy TUI not ready) — re-send it with backoff instead of polling forever.
    const stalled = /agent_prompt_stalled/i.test(promptOutput);
    const seqUnchanged = agent.state_change_seq === undefined || agent.state_change_seq === null || agent.state_change_seq === seqAtPrompt;
    const revUnchanged = agent.revision === undefined || agent.revision === null || agent.revision === revAtPrompt;
    if (stalled && agent.agent_status === "idle" && seqUnchanged && revUnchanged) {
      if (stallRetryCount < MAX_STALL_RETRY_ATTEMPTS) {
        stallRetryCount++;
        setTimeout(launchPrompt, STALL_RETRY_MS);
        return;
      }
      die(4, "Prompt delivery failed: agent stayed idle after repeated stalled prompts", {
        error_class: "stalled",
        stall_reason: "prompt_delivery_failed",
        attempts: stallRetryCount
      });
      return;
    }

    // Agent is alive (working / idle warming up).
    // Do NOT submit duplicate prompt. Polling will reconcile and wait for completion.
  });
}

let lastSeq = null;
let lastRevision = null;
let noActivityTime = 0;
let tier1Passed = false;
let blocked = false;
let seqAtPrompt = null;
let revAtPrompt = null;
let stallRetryCount = 0;
let doneObservedAt = null;

const STARTUP_TIMEOUT_MS = Number(process.env.GGA_HERDR_STARTUP_TIMEOUT_MS || 60000);
const INACTIVITY_TIMEOUT_MS = Number(process.env.GGA_HERDR_INACTIVITY_TIMEOUT_MS || Math.max(promptTimeoutMs, 120000));
const POLL_INTERVAL_MS = Number(process.env.GGA_HERDR_POLL_INTERVAL_MS || 2000);

function checkStatus() {
  if (finished) return;

  const sentinel = tryReadSentinel();
  if (sentinel) {
    completeWithResult(sentinel);
    return;
  }

  const agent = getAgentInfo();
  if (!agent) {
    if (!child && tier1Passed) {
      noActivityTime += POLL_INTERVAL_MS;
      if (noActivityTime >= INACTIVITY_TIMEOUT_MS && !verifyMode) {
        die(8, "Agent unreachable / Inactivity timeout", { error_class: "stalled", stall_reason: "inactivity_timeout" });
      }
    }
    return;
  }

  const seq = agent.state_change_seq;
  const rev = agent.revision;
  const status = agent.agent_status;

  const terminalDeadStates = new Set(["crashed", "failed", "error", "killed", "stopped", "terminated", "exited"]);
  if (terminalDeadStates.has(status)) {
    const lastCheck = tryReadSentinel();
    if (lastCheck) {
      completeWithResult(lastCheck);
      return;
    }
    die(4, `Agent terminated unexpectedly: ${status}`, { error_class: "unavailable", agent_status: status });
    return;
  }

  if (status === "done") {
    const lastCheck = tryReadSentinel();
    if (lastCheck) {
      completeWithResult(lastCheck);
      return;
    }
    // v2.1: herdr reports `done` when the active turn completes, but Claude
    // (Thinking) writes the sentinel result file in a LATER turn. Keep polling
    // within SENTINEL_GRACE_MS instead of dying at ~1s.
    if (doneObservedAt === null) {
      doneObservedAt = Date.now();
    } else if (Date.now() - doneObservedAt >= SENTINEL_GRACE_MS) {
      die(5, "Contract violation: result file not found", {
        error_class: "contract",
        sentinel_grace_ms: SENTINEL_GRACE_MS
      });
      return;
    }
    return;
  }

  const seqChanged = lastSeq !== null && seq !== undefined && seq !== null && seq !== lastSeq;
  const revChanged = lastRevision !== null && rev !== undefined && rev !== null && rev !== lastRevision;
  const active = status === "working" || seqChanged || revChanged;
  if (seq !== undefined && seq !== null) lastSeq = seq;
  if (rev !== undefined && rev !== null) lastRevision = rev;

  if (active) {
    noActivityTime = 0;
    tier1Passed = true;
    doneObservedAt = null; // agent resumed; a later `done` restarts the grace window
  } else {
    noActivityTime += POLL_INTERVAL_MS;
    if (!tier1Passed && noActivityTime >= STARTUP_TIMEOUT_MS && !verifyMode) {
      die(8, "Startup timeout", { error_class: "stalled", stall_reason: "startup_timeout" });
      return;
    }
    if (tier1Passed && noActivityTime >= INACTIVITY_TIMEOUT_MS && !verifyMode) {
      die(8, "Inactivity timeout", { error_class: "stalled", stall_reason: "inactivity_timeout" });
      return;
    }
  }

  if (status === "blocked" && !blocked) {
    blocked = true;
    const envelope = { status: "blocked", error_class: "permission_required", message: "Agent blocked." };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    setTimeout(() => {
      if (!finished) {
        die(7, "Blocked timeout", { error_class: "blocked_timeout" });
      }
    }, 300000);
  }
}

pollInterval = setInterval(checkStatus, POLL_INTERVAL_MS);
launchPrompt();

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
