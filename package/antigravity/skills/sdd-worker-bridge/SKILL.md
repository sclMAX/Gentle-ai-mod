---
name: sdd-worker-bridge
description: "SDD worker bridge for agy vs OpenCode phase runners. Trigger: SDD phase launch, agy worker, model/effort selection, quota failover, run-agy-phase, worker policy."
license: MIT
metadata:
  author: gentle-ai-local
  version: "1.1"
---

# SDD Worker Bridge (Orchestrator only)

Bind this to `gentle-orchestrator` only. Executors (`sdd-explore`, etc.) do not load this to re-orchestrate.

## Purpose

Run eligible SDD phases on either:

- **opencode** — native `task` + `sdd-<phase>` subagent
- **agy** — Antigravity CLI via portable runner

Same artifact contract. One orchestrator. Failover on quota.

## Portable paths

| Item | Location |
|------|----------|
| User config | `~/.config/gentle-ai/workers.yaml` |
| Project override | `<repo>/.atl/sdd-workers.yaml` |
| Runner | `~/.config/gentle-ai/bin/run-agy-phase.mjs` |
| This skill | `~/.config/opencode/skills/sdd-worker-bridge/SKILL.md` |
| Full checklist | `references/phase-launch-checklist.md` |

On Windows and Linux, `~` is the user home. Never hardcode `C:\Users\...` in prompts or config committed to repos.

## Session bootstrap (once per SDD session)

After SDD Session Preflight (includes **Workers** group):

1. Read `~/.config/gentle-ai/workers.yaml` (and project override if present).
2. Discover `agy`: `agy` on PATH (or `command` from config).
3. If agy available: cache `agy models` list once.
4. Init session state:

```text
session.worker_policy   # from preflight
session.workers.agy     = { available, exhausted:false }
session.workers.opencode = { available:true, exhausted:false }
session.phase_bindings  = {}
session.failover_count  = {}
session.retry_same      = {}
session.agy_models      = []
```

Degradations:

- `!agy.available` + policy needs agy → `opencode-only` (warn once)
- `ask-each-phase` + `auto` mode → `prefer-agy` if agy else `prefer-opencode`
- `agy-only` + `!agy.available` → STOP

## Preflight mapping (Workers group)

| UI label | Canonical `worker_policy` |
|---------|---------------------------|
| Ask each phase | `ask-each-phase` |
| Prefer Antigravity | `prefer-agy` |
| Prefer OpenCode | `prefer-opencode` |
| OpenCode only | `opencode-only` |
| Antigravity only | `agy-only` |

Include in `SDD Session Preflight` decision block as `worker_policy: ...`.

## Eligible phases

**Eligible:** explore, propose, spec, design, tasks, verify  
**Ineligible (always OpenCode):** apply, archive, init, onboard, review gates, commit/PR

## Phase launch algorithm (HARD GATE)

Before every phase launch, follow `references/phase-launch-checklist.md`.

### Resolve binding

```text
binding = { worker, model, effort, source }

if phase ineligible → worker=opencode
else if phase_bindings[phase] on retry/failover → reuse (no re-ask)
else if policy opencode-only → opencode
else if policy agy-only → agy or STOP
else if policy ask-each-phase and interactive → question tool (worker) then STOP if unanswered
else if prefer-agy → first_available([agy, opencode])
else if prefer-opencode → first_available([opencode, agy])
```

### Model / effort (agy only)

```text
model  = override ?? binding ?? model_by_phase[phase] ?? default_model ?? omit
effort = override ?? binding ?? effort_by_phase[phase] ?? default_effort ?? omit
```

If `model_picker=on-agy-ask` and worker freshly chosen as agy and no model set and interactive:

- Ask **profile** once: Fast / Balanced / Strong (from config `workers.agy.profiles`)
- Do not dump full model catalog

OpenCode models stay on `opencode.json` `agent.sdd-<phase>.model`.

### Run

**OpenCode:**

```text
task(subagent_type: "sdd-<phase>", prompt: phase_prompt_with_skills)
```

**agy:**

```text
node ~/.config/gentle-ai/bin/run-agy-phase.mjs \
  --phase <phase> \
  --change <change> \
  --project <project> \
  --cwd <git_root> \
  --artifact-store <mode> \
  --prompt-file <path> \
  [--model ...] [--effort ...] [--timeout ...]
```

Write the full phase prompt to a temp file under the OS temp dir (or repo-safe temp), pass `--prompt-file`. Do not inline huge prompts on Windows command limits when avoidable.

Always set explicit Engram `project` (runner sets `ENGRAM_PROJECT`).

### Gatekeeper

Stdout envelope is a hint. **Store is authority.**

PASS only if:

1. runner/task status success
2. canonical artifact readable (Engram topic or OpenSpec path)
3. non-empty content
4. `next_recommended` coherent
5. no allowlist violations

### Failover

1. **contract/gate fail** → 1× same worker with corrective prompt  
2. **agy + quota/unavailable** + `try_model_fallback_once` → 1× next `model_fallback`  
3. **other worker** once if allowed and available  
4. else STOP and report

On `quota_exceeded` for a worker after model fallback exhausted (or no fallback): mark `workers[w].exhausted=true` for the session when switching away.

Never re-ask worker on failover. Max 2 worker attempts per phase.

## User overrides

Honor phrases like:

- "explore with agy"
- "propose on opencode"
- "design with sonnet effort high"
- "try agy again" → clear `agy.exhausted` and light re-probe

## Result summary (user-facing)

Always include:

```text
phase · worker · model · effort · duration · status · failover?
```

## agy model / effort (v1.1)

The runner (`run-agy-phase.mjs`) normalizes flags before spawn:

| Model kind | `--effort` behavior |
|------------|---------------------|
| id ends with `-low\|-medium\|-high` (Gemini) | Force matching effort; never pass medium with `*-high` |
| `claude-*`, some `gpt-oss*` | **Omit** `--effort` entirely |
| other | Use configured effort if set |

On `invalid model selection` / `conflicts with --effort` / `effort is not supported`, the runner **auto-retries once** with a corrected pair and sets `error_class: invalid_model_selection` only if still failing.

Orchestrator should **not** manually debug agy flags for this class — trust the runner, then apply worker failover if needed.

Prefer not passing mismatched `--effort` from the orchestrator; let config + runner normalize. If you pass both, runner still fixes them.

## Invariants

1. One orchestrator (OpenCode gentle-orchestrator)
2. One active writer worker per phase
3. ≤1 worker question per phase per run
4. ≤1 profile question when applicable
5. Store beats stdout
6. No absolute cross-machine paths in committed config
7. apply/archive never use agy in v1
8. Dedup launches by `(phase, fingerprint)`

## Skill resolution note

When launching **either** worker, still inject matching project/skill paths into the phase prompt (Skill Resolver Protocol). The runner also discovers `sdd-<phase>` + `_shared` via portable roots.
