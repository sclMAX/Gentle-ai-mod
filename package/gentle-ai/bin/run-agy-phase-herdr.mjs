#!/usr/bin/env node
import { spawnSync, spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

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

let phase, change, project, cwd = process.cwd(), promptText = "", promptFile = "";
let model = null, effort = null, timeoutArg = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--phase") phase = next();
  else if (a === "--change") change = next();
  else if (a === "--project") project = next();
  else if (a === "--cwd") cwd = next();
  else if (a === "--prompt") promptText = next();
  else if (a === "--prompt-file") promptFile = next();
  else if (a === "--model") model = next();
  else if (a === "--effort") effort = next();
  else if (a === "--timeout") timeoutArg = next();
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

if (!phase || !change || !project) {
  die(2, "Missing required arguments: --phase, --change, --project");
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

if (dryRun) {
  console.log(`Dry run executing with transport herdr. prompt length: ${promptText.length}`);
  console.log(`Model: ${model || "(default)"}  Effort: ${effort || "(none)"}  Timeout: ${timeoutArg || "(default 10m)"}`);
  console.log(`Agent start args: ${JSON.stringify(agentStartArgsForDryRun())}`);
  console.log(`Prompt used: ${promptText}`);
  process.exit(0);
}

function agentStartArgsForDryRun() {
  const args = ["agent", "start", `sdd-agent-<ts>`, "--kind", "agy", "--pane", "<pane>"];
  const cli = [];
  if (model) cli.push("--model", String(model));
  if (effort && modelSupportsEffortFlag(model)) cli.push("--effort", String(effort));
  if (cli.length) args.push("--", ...cli);
  return args;
}

// Apply runs in the main worktree like every other phase. No herdr worktree
// isolation: git itself is the safety net (diff/checkout), and the RDD
// correction transaction expects candidate changes in the lineage repo.
let activeCwd = cwd;

const workspaceId = process.env.HERDR_WORKSPACE_ID || "default";
const label = `sdd-${phase}-${change}`;
const tabRes = spawnSync("herdr", ["tab", "create", "--workspace", workspaceId, "--cwd", activeCwd, "--label", label], { encoding: "utf8" });
if (tabRes.status !== 0) {
  die(4, "Failed to create tab: " + tabRes.stderr);
}
let tabId, paneId;
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

const agentName = `sdd-agent-${Date.now()}`;
const agentStartArgs = ["agent", "start", agentName, "--kind", "agy", "--pane", paneId];
// Pass model/effort through to the agy CLI via the trailing `--` agent args.
// Without this, agy starts with its own default model (e.g. Gemini 3.7 Flash
// medium) no matter what --model the orchestrator requested.
const agentCliArgs = [];
if (model) agentCliArgs.push("--model", String(model));
if (effort && modelSupportsEffortFlag(model)) agentCliArgs.push("--effort", String(effort));
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
let child = null;

// herdr's --wait requires an observed state change within 5s of submission.
// Right after `agent start`, agy is still warming up: the first prompt
// typically returns agent_prompt_stalled/timeout (exit 1). Retrying a few
// times with a short pause lets the agent reach interactive_ready, after
// which the same prompt completes with exit 0 and state done.
//
// agy can also answer with an account-verification notice
// ("Verifying your account... Please try again shortly") while the account
// eligibility check is still finishing. That is transient, not a contract
// failure: we retry with a longer backoff and only report `unavailable`
// (retryable by the orchestrator) once the verification attempts run out.
let promptAttempt = 0;
const MAX_PROMPT_ATTEMPTS = 3;
const VERIFY_PATTERN = /verifying your account|account eligibility|try again shortly/i;
const VERIFY_RETRY_MS = Number(process.env.GGA_HERDR_VERIFY_RETRY_MS || 15000);
const RETRY_MS = Number(process.env.GGA_HERDR_RETRY_MS || 3000);
const MAX_VERIFY_ATTEMPTS = Number(process.env.GGA_HERDR_MAX_VERIFY_ATTEMPTS || 5);

let promptOutput = "";
let verifyMode = false;

function agentState() {
  const res = spawnSync("herdr", ["agent", "get", agentTarget], { encoding: "utf8" });
  if (res.status !== 0) return "";
  try {
    const d = JSON.parse(res.stdout);
    return d.result?.agent?.agent_status || "";
  } catch (e) { return ""; }
}

function launchPrompt() {
  promptAttempt++;
  promptOutput = "";
  child = spawn("herdr", promptArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => { promptOutput += d; process.stdout.write(d); });
  child.stderr.on("data", (d) => { promptOutput += d; process.stderr.write(d); });
  child.on("close", (code) => {
    const state = agentState();
    if (VERIFY_PATTERN.test(promptOutput)) verifyMode = true;
    const maxAttempts = verifyMode ? MAX_VERIFY_ATTEMPTS : MAX_PROMPT_ATTEMPTS;
    const delay = verifyMode ? VERIFY_RETRY_MS : RETRY_MS;
    if ((code !== 0 || state !== "done") && promptAttempt < maxAttempts) {
      setTimeout(launchPrompt, delay);
      return;
    }
    if (verifyMode && promptAttempt >= maxAttempts) {
      cleanupAgent();
      die(4, "Account verification pending: " + (promptOutput.trim().split("\n")[0] || "agy is verifying the account"), { error_class: "unavailable", stall_reason: "account_verification", attempts: promptAttempt });
      return;
    }
    onPromptClose(code);
  });
}

launchPrompt();

let lastSeq = null;
let lastRevision = null;
let noActivityTime = 0;
let tier1Passed = false;
let blocked = false;

// Startup: agy may take a while to become ready (model spin-up, account check).
// Inactivity: never kill before the prompt's own --timeout gets a chance —
// the prompt is the authority; the poll is only a backstop. If the agent is
// genuinely working (state_change_seq advancing or status == "working") we
// never treat it as inactive, even when `revision` stays flat.
const STARTUP_TIMEOUT_MS = 60000;
const INACTIVITY_TIMEOUT_MS = Math.max(promptTimeoutMs, 120000);

// Best-effort cleanup so a timed-out run does not leave the agy agent alive
// in the tab working on the same files (duplicate work / zombie agent).
function cleanupAgent() {
  try {
    if (tabId) spawnSync("herdr", ["tab", "close", tabId], { encoding: "utf8" });
  } catch (e) {}
}

const pollInterval = setInterval(() => {
  const statusRes = spawnSync("herdr", ["agent", "get", agentTarget], { encoding: "utf8" });
  if (statusRes.status === 0) {
    try {
      const data = JSON.parse(statusRes.stdout);
      const agent = data.result?.agent || data.agent || {};
      const seq = agent.state_change_seq;
      const rev = agent.revision;
      const status = agent.agent_status;
      // Real activity: any state-change sequence advance, revision change, or
      // the agent actively working. agy keeps state_change_seq advancing while
      // it works even when `revision` stays flat.
      const active = status === "working" || seq !== lastSeq || rev !== lastRevision;
      if (seq !== lastSeq) lastSeq = seq;
      if (rev !== lastRevision) lastRevision = rev;
      if (active) {
        noActivityTime = 0;
        tier1Passed = true;
      } else {
        noActivityTime += 10000;
        if (!tier1Passed && noActivityTime >= STARTUP_TIMEOUT_MS && !verifyMode) {
          clearInterval(pollInterval);
          if (child) child.kill();
          cleanupAgent();
          die(8, "Startup timeout", { error_class: "stalled", stall_reason: "startup_timeout" });
        }
        if (tier1Passed && noActivityTime >= INACTIVITY_TIMEOUT_MS && !verifyMode) {
          clearInterval(pollInterval);
          if (child) child.kill();
          cleanupAgent();
          die(8, "Inactivity timeout", { error_class: "stalled", stall_reason: "inactivity_timeout" });
        }
      }

      if (agent.agent_status === "blocked" && !blocked) {
        blocked = true;
        const envelope = { status: "blocked", error_class: "permission_required", message: "Agent blocked." };
        process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
        setTimeout(() => {
          clearInterval(pollInterval);
          if (child) child.kill();
          cleanupAgent();
          die(7, "Blocked timeout", { error_class: "blocked_timeout" });
        }, 300000);
      }
    } catch (e) {}
  }
}, 10000);

function onPromptClose(code) {
  clearInterval(pollInterval);
  
  const statusRes = spawnSync("herdr", ["agent", "get", agentTarget], { encoding: "utf8" });
  let conversationId = null;
  if (statusRes.status === 0) {
    try {
      const data = JSON.parse(statusRes.stdout);
      const agent = data.result?.agent || data.agent || {};
      conversationId = agent.agent_session?.value || agent.conversationId || data.conversationId;
    } catch(e){}
  }
  
  if (conversationId) {
    // engram CLI shape: engram save <title> <msg> [--type TYPE] [--project PROJECT] [--scope SCOPE]
    const memArgs = ["save", `conversationId ${phase} ${change}`, conversationId, "--type", "architecture", "--project", project, "--scope", "project"];
    spawnSync("engram", memArgs);
  }

  if (!existsSync(sentinelFile)) {
    cleanupAgent();
    die(5, "Contract violation: result file not found");
  }
  
  const resultData = readFileSync(sentinelFile, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(resultData);
  } catch (e) {
    cleanupAgent();
    die(5, "Contract violation: invalid JSON in result file");
  }
  
  let inner = parsed.response || parsed;
  const ok = inner && inner.status !== "failed" && inner.status !== "ERROR";

  const envelope = {
    ...inner, // Flatten inner fields
    status: ok ? "success" : "failed",
    error_class: ok ? null : "contract",
    exit_code: ok ? 0 : 5,
    result: inner,
    worker: "agy",
    phase,
    change_name: change,
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
  
  spawnSync("herdr", ["tab", "close", tabId]);
  
  exitForEnvelope(envelope);
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
