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

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--phase") phase = next();
  else if (a === "--change") change = next();
  else if (a === "--project") project = next();
  else if (a === "--cwd") cwd = next();
  else if (a === "--prompt") promptText = next();
  else if (a === "--prompt-file") promptFile = next();
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
  console.log(`Prompt used: ${promptText}`);
  process.exit(0);
}

let activeCwd = cwd;
let worktreePath = null;
if (phase === "apply") {
  const wtRes = spawnSync("herdr", ["worktree", "create", "--cwd", cwd], { encoding: "utf8" });
  if (wtRes.status !== 0) {
    die(4, "Failed to create worktree: " + wtRes.stderr);
  }
  worktreePath = wtRes.stdout.trim();
  activeCwd = worktreePath;
}

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
const agentRes = spawnSync("herdr", ["agent", "start", agentName, "--kind", "agy", "--pane", paneId], { encoding: "utf8" });
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

const promptArgs = ["agent", "prompt", agentTarget, promptWithSentinel, "--wait", "--timeout", String(10 * 60 * 1000)];
let child = null;

// herdr's --wait requires an observed state change within 5s of submission.
// Right after `agent start`, agy is still warming up: the first prompt
// typically returns agent_prompt_stalled/timeout (exit 1). Retrying a few
// times with a short pause lets the agent reach interactive_ready, after
// which the same prompt completes with exit 0 and state done.
let promptAttempt = 0;
const MAX_PROMPT_ATTEMPTS = 3;

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
  child = spawn("herdr", promptArgs, { encoding: "utf8", stdio: "inherit" });
  child.on("close", (code) => {
    const state = agentState();
    if ((code !== 0 || state !== "done") && promptAttempt < MAX_PROMPT_ATTEMPTS) {
      setTimeout(launchPrompt, 3000);
      return;
    }
    onPromptClose(code);
  });
}

launchPrompt();

let lastRevision = null;
let noActivityTime = 0;
let tier1Passed = false;
let blocked = false;

const pollInterval = setInterval(() => {
  const statusRes = spawnSync("herdr", ["agent", "get", agentTarget], { encoding: "utf8" });
  if (statusRes.status === 0) {
    try {
      const data = JSON.parse(statusRes.stdout);
      const agent = data.result?.agent || data.agent || {};
      const rev = agent.revision;
      if (rev !== lastRevision) {
        lastRevision = rev;
        noActivityTime = 0;
        tier1Passed = true;
      } else {
        noActivityTime += 10000;
        if (!tier1Passed && noActivityTime >= 10000) {
          clearInterval(pollInterval);
          child.kill();
          die(8, "Startup timeout", { error_class: "stalled", stall_reason: "startup_timeout" });
        }
        if (tier1Passed && noActivityTime >= 120000) {
          clearInterval(pollInterval);
          child.kill();
          die(8, "Inactivity timeout", { error_class: "stalled", stall_reason: "inactivity_timeout" });
        }
      }
      
      if (agent.agent_status === "blocked" && !blocked) {
        blocked = true;
        const envelope = { status: "blocked", error_class: "permission_required", message: "Agent blocked." };
        process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
        setTimeout(() => {
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
    die(5, "Contract violation: result file not found");
  }
  
  const resultData = readFileSync(sentinelFile, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(resultData);
  } catch (e) {
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
    conversation_id: conversationId,
    tab_id: tabId
  };
  
  process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  
  spawnSync("herdr", ["tab", "close", tabId]);
  
  if (phase === "apply" && worktreePath && envelope.status === "success") {
    spawnSync("herdr", ["worktree", "remove", worktreePath]);
  }
  
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
