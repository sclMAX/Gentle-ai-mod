#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const cfgPath = join(homedir(), ".config", "opencode", "opencode.json");
const bakPath = cfgPath + ".bak-worker-bridge";
const raw = readFileSync(cfgPath, "utf8");
const j = JSON.parse(raw);

copyFileSync(cfgPath, bakPath);

const BRIDGE_SECTION = `
<!-- gentle-ai:sdd-worker-bridge -->
### Worker Bridge v2 — Universal Worker Selection (HARD GATE)

Before launching ANY sub-agent (SDD phase or delegated task: explore/general/writer for reads, writes, research, commands), follow the worker bridge. Load skill \`sdd-worker-bridge\` (read its SKILL.md and \`references/phase-launch-checklist.md\`) at session start after preflight, and on every launch if not cached.

**Portable files (never hardcode machine-specific paths in repo commits):**
- Config: \`~/.config/gentle-ai/workers.yaml\` (optional override: \`<repo>/.atl/sdd-workers.yaml\`)
- Runner: \`node ~/.config/gentle-ai/bin/run-agy-phase.mjs\`
- Skill: opencode skills \`sdd-worker-bridge\`

**Roles:** OpenCode \`gentle-orchestrator\` = only orchestrator. Workers: \`opencode\` (native \`task\` + subagent) or \`agy\` (Antigravity CLI via runner). Workers never route the pipeline.

**Scope:** ALL sub-agent launches — SDD phases (explore, propose, spec, design, tasks, apply, verify, archive, init, onboard) AND delegated tasks (explore/general/writer). Review lifecycle + commit/PR stay on OpenCode (orchestrator-only).

**Session state after preflight:**
\`\`\`
session.worker_policy
session.workers.agy = { available, exhausted }
session.workers.opencode = { available, exhausted }
session.phase_bindings = { phase → { worker, model, effort, source } }   // SDD
session.task_bindings   = { fingerprint → { worker, model, effort } }    // non-SDD
session.failover_count / retry_same
session.agy_models (cached from \`agy models\` when available)
\`\`\`

**Bootstrap once:** read workers.yaml; detect agy on PATH; cache \`agy models\`; apply degradations (no agy → opencode-only; ask-each-phase+auto → prefer-agy|prefer-opencode).

**Universal pre-launch (every sub-agent):**
1. Ask worker FIRST: use \`question\` tool → Antigravity (agy) vs OpenCode. STOP until answered. Honor explicit user overrides ("use agy" / "use opencode"). Do not re-ask on failover/retry — binding frozen.
2. If worker=agy and \`model_picker=on-agy-ask\` and no model set: list the REAL available models (from \`session.agy_models\` cache) and RECOMMEND model+effort for the task (see heuristic below). The recommended option is FIRST with "(Recomendado)". User accepts the recommendation or picks another from the catalog. STOP until answered.
3. Freeze the binding per (phase | task-fingerprint); never re-ask the same launch.

**Model recommendation heuristic (agy):**
- Read / explore / map / research task → \`gemini-3.6-flash-medium\` (effort medium) — cheap and fast
- Write / apply / implement task → \`gemini-3.1-pro-high\` (effort high) — strongest writer
- Design / reason / verify task → \`claude-sonnet-4-6\` (no effort flag; runner strips it) — strong reasoning
- Heavy / adversarial task → \`claude-opus-4-6-thinking\` (no effort flag) — strongest
- Fallbacks when the recommended model is quota-blocked, in order: \`gemini-3.7-flash-high\` → \`gemini-3.6-flash-high\` → \`gemini-3.1-pro-high\` → \`gemini-3.6-flash-medium\`.

**Run:**
- opencode → \`task(subagent_type: <type>, prompt: ...)\` with skills injected
- agy → write prompt file then:
  \`node ~/.config/gentle-ai/bin/run-agy-phase.mjs --phase <p> --change <c> --project <proj> --cwd <git_root> --artifact-store <mode> --prompt-file <file> [--model] [--effort]\` (SDD) or the runner equivalent for the delegated task (non-SDD)

**Gatekeeper:** Engram/OpenSpec artifact is authority; stdout envelope is a hint only.

**Failover (quota-aware, walk the model chain):**
1. contract → same worker once
2. agy \`quota_exceeded\` → walk the whole \`model_fallback\` chain IN ORDER (every model in the list, not just one): retry same worker with the next model until one succeeds. No re-ask.
3. entire agy chain quota-failed / agy unavailable → other worker once (mark agy exhausted)
4. STOP

**Summary line:** \`phase · worker · model · effort · duration · status · failover?\`

**User overrides:** honor "use agy", "use opencode", model/effort phrases, and "try agy again" (clears exhausted).

**Invariants:** one orchestrator; one worker at a time; store wins; commit/PR + review lifecycle stay on OpenCode; no cross-machine absolute paths; dedup launches; ≤1 worker question and ≤1 model question per launch.
<!-- /gentle-ai:sdd-worker-bridge -->
`;

function patchPrompt(prompt, agentKey) {
  let p = prompt;
  if (p.includes("gentle-ai:sdd-worker-bridge")) {
    p = p.replace(
      /\n<!-- gentle-ai:sdd-worker-bridge -->[\s\S]*?<!-- \/gentle-ai:sdd-worker-bridge -->\n?/g,
      "\n"
    );
  }

  p = p.replace(
    "1. **Execution mode**: `interactive` or `auto`.\n2. **Artifact store**: `openspec`, `engram`, or `both` when Engram is callable. If Engram is unavailable, offer only file/inline-safe choices.\n3. **Chained PR strategy**: `auto-forecast`, `ask-always`, `single-pr-default`, or `force-chained`.\n4. **Review budget**: maximum changed lines before stopping for reviewer-burden approval.",
    "1. **Execution mode**: `interactive` or `auto`.\n2. **Artifact store**: `openspec`, `engram`, or `both` when Engram is callable. If Engram is unavailable, offer only file/inline-safe choices.\n3. **Chained PR strategy**: `auto-forecast`, `ask-always`, `single-pr-default`, or `force-chained`.\n4. **Review budget**: maximum changed lines before stopping for reviewer-burden approval.\n5. **Worker policy**: `ask-each-phase`, `prefer-agy`, `prefer-opencode`, `opencode-only`, or `agy-only` (SDD Worker Bridge)."
  );

  p = p.replace(
    "Ask all four preflight groups in one single `question` tool call so OpenCode can render the groups as tabs. Do NOT run this as a sequential wizard. Do NOT issue four separate `question` tool calls.",
    "Ask all five preflight groups in one single `question` tool call so OpenCode can render the groups as tabs. Do NOT run this as a sequential wizard. Do NOT issue five separate `question` tool calls."
  );

  p = p.replace(
    "The single `question` tool call must contain these four localized groups in this order:\n\n1. Pace: Interactive, Automatic.\n2. Artifacts: OpenSpec, Engram, Both.\n3. PRs: Ask me, Single PR, Chained, Auto.\n4. Review: 400 lines, 800 lines, Other.",
    "The single `question` tool call must contain these five localized groups in this order:\n\n1. Pace: Interactive, Automatic.\n2. Artifacts: OpenSpec, Engram, Both.\n3. PRs: Ask me, Single PR, Chained, Auto.\n4. Review: 400 lines, 800 lines, Other.\n5. Workers: Ask each phase, Prefer Antigravity, Prefer OpenCode, OpenCode only, Antigravity only."
  );

  p = p.replace(
    "Only after all four preflight choices are collected, summarize them as the `SDD Session Preflight` decision block and continue with the SDD init guard/requested phase.",
    "Only after all five preflight choices are collected, summarize them as the `SDD Session Preflight` decision block and continue with the SDD init guard/requested phase."
  );

  p = p.replace(
    "- Review: 400 lines -> `review_budget_lines: 400`; 800 lines -> `review_budget_lines: 800`; Other -> ask one follow-up for the number.",
    "- Review: 400 lines -> `review_budget_lines: 400`; 800 lines -> `review_budget_lines: 800`; Other -> ask one follow-up for the number.\n- Workers: Ask each phase -> `ask-each-phase`; Prefer Antigravity -> `prefer-agy`; Prefer OpenCode -> `prefer-opencode`; OpenCode only -> `opencode-only`; Antigravity only -> `agy-only`."
  );

  p = p.replace(
    "If the user explicitly provided all four choices in the current conversation, summarize them as the session preflight block and continue.",
    "If the user explicitly provided all five choices in the current conversation, summarize them as the session preflight block and continue."
  );

  const anchor = "### Execution Mode";
  if (!p.includes(anchor)) {
    throw new Error("anchor ### Execution Mode not found in " + agentKey);
  }
  p = p.replace(anchor, BRIDGE_SECTION.trim() + "\n\n" + anchor);

  if (!p.includes("Pass it as `worker_policy`")) {
    p = p.replace(
      "Cache the artifact store choice for the session. Pass it as `artifact_store.mode` to every sub-agent launch.",
      "Cache the artifact store choice for the session. Pass it as `artifact_store.mode` to every sub-agent launch.\n\nCache the worker policy for the session. Pass it as `worker_policy` into phase launch binding resolution (SDD Worker Bridge)."
    );
  }

  return p;
}

const targets = [
  "gentle-orchestrator",
  "sdd-orchestrator-flashlite",
  "sdd-orchestrator-flashpuro",
];
const report = [];
for (const key of targets) {
  if (!j.agent[key]?.prompt) {
    report.push("SKIP " + key);
    continue;
  }
  const before = j.agent[key].prompt.length;
  j.agent[key].prompt = patchPrompt(j.agent[key].prompt, key);
  const after = j.agent[key].prompt.length;
  const hasBridge = j.agent[key].prompt.includes("gentle-ai:sdd-worker-bridge");
  const hasWorkers = j.agent[key].prompt.includes("Worker policy");
  report.push(
    `${key}: ${before} -> ${after} bridge=${hasBridge} workersPreflight=${hasWorkers}`
  );
}

writeFileSync(cfgPath, JSON.stringify(j, null, 2) + "\n", "utf8");
JSON.parse(readFileSync(cfgPath, "utf8"));
console.log(report.join("\n"));
console.log("backup:", bakPath);
console.log("OK");
