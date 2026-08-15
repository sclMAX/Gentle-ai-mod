---
name: sdd-worker-bridge
description: "Universal worker bridge v2 — Antigravity (agy) vs OpenCode for ANY delegated sub-agent (SDD phase or task). Trigger: sub-agent launch, worker selection, agy model catalog + recommendation, model/effort selection, quota chain failover, run-agy-phase, worker policy."
license: MIT
metadata:
  author: gentle-ai-local
  version: "2.0"
---

# Worker Bridge v2 — Universal Worker Selection (Orchestrator only)

Bind this to `gentle-orchestrator` only. Executors (`sdd-explore`, etc.) do not load this to re-orchestrate.

## Purpose

Run ANY delegated sub-agent (SDD phase or task) on either:

- **opencode** — native `task` + `sdd-<phase>` subagent
- **agy** — Antigravity CLI via portable runner

Universal selector: ask worker, recommend agy model+effort, walk the model chain on quota.

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
3. If agy available: cache `agy models` once. Try `agy models --output-format json` first (structured); on error fall back to plain `agy models` (tab-separated `id<TAB>Label`). Some 1.1.12 builds predate the `models --output-format` flag despite the changelog. Store parsed model ids in `session.agy_models`.
4. Init session state:

```text
session.worker_policy   # from preflight
session.workers.agy     = { available, exhausted:false }
session.workers.opencode = { available:true, exhausted:false }
session.phase_bindings  = {}
session.task_bindings   = {}   # non-SDD delegated tasks (fingerprint → binding)
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

**Eligible (all SDD phases):** explore, propose, spec, design, tasks, apply, verify, archive, init, onboard  
**Orchestrator-only (not SDD phases):** review lifecycle gates, commit/PR

## Phase launch algorithm (HARD GATE)

Before every phase launch, follow `references/phase-launch-checklist.md`.

### Resolve binding

```text
binding = { worker, model, effort, source }

// SDD phase:
if phase ineligible → worker=opencode
else if phase_bindings[phase] on retry/failover → reuse (no re-ask)
else if policy opencode-only → opencode
else if policy agy-only → agy or STOP
else if policy ask-each-phase and interactive → question tool (worker) then STOP if unanswered
else if prefer-agy → first_available([agy, opencode])
else if prefer-opencode → first_available([opencode, agy])

// Non-SDD delegated task (explore/general/writer):
same rules against task_bindings[task-fingerprint]
```

### Model / effort — universal selector (agy only)

```text
model  = override ?? binding ?? model_by_phase[phase] ?? recommend_by_task[task_kind] ?? default_model ?? omit
effort = override ?? binding ?? effort_by_phase[phase] ?? recommend_by_task[task_kind].effort ?? default_effort ?? omit
```

Universal selector (v2): if `model_picker=on-agy-ask` and worker freshly chosen as agy and no model set and interactive — list the REAL available models from `session.agy_models` in the `question` tool, with the RECOMMENDED one first (label ends '(Recomendado)'). Recommendation source: `workers.agy.recommend_by_task[task_kind]` (read/write/design/heavy) falling back to `model_by_phase[phase]`. User accepts or picks another. STOP until answered. Never dump a fixed 3-profile list.

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
2. **agy + quota_exceeded** + `walk_model_fallback_chain` → walk the WHOLE `model_fallback` list in order: same worker, next model each time, until one succeeds  
3. **entire agy chain quota-failed / agy unavailable** → other worker once (mark agy exhausted)  
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

## Structured output (v1.2)

Runner defaults (overridable via CLI or `workers.agy`):

| Flag / key | Default | Notes |
|------------|---------|--------|
| `--output-format` / `output_format` | `json` | Also `stream-json` (NDJSON; last `event=result`) |
| `--json-schema` / `json_schema` | `default` | Ships `schemas/sdd-phase-result.schema.json` |
| `--no-json-schema` | — | Alias for `--json-schema none` |
| `--stream-progress` | off | With stream-json: brief DONE lines on **stderr** |
| `--stream-progress-detail` | `summary` | Progress verbosity: `summary` label only, `tools` + tool name/params, `full` + live model text + duration/tokens |

Parsing prefers `structured_output` object; else strips markdown fences from `response` and JSON-parses. Envelope includes `output_format`, `json_schema_path`, `structured_output_used`.

## Native skill expansion (v1.4)

The runner prepends the phase skill as a slash command in print mode, so agy resolves and applies it natively instead of the model reading `SKILL.md` as a file:

| Mode (`workers.agy.slash_command_skills` / `--slash-command-skills`) | Behavior |
|------|----------|
| `auto` (default) | Prepend `/sdd-<phase>` when agy ≥ 1.1.9; literal prompts below |
| `on` | Always prepend (sent as literal text on agy < 1.1.9) |
| `off` | Never prepend; appends `--disable-slash-commands` on agy ≥ 1.1.9 |

Requirements / notes:

- The `sdd-<phase>` skill must be installed where agy scans skills (installer mirrors it to `~/.gemini/antigravity-cli/skills/`).
- When the skill is mirrored to an agy-scanned root, the runner drops it from the "read these files" block (native load replaces the file read); `_shared` references are still listed.
- Custom prompts that already start with `/` are left untouched (no command stacking).
- `off` also protects prompts starting with `/` (e.g. absolute paths) from being parsed as commands.
- Envelope meta includes `slash_command_skills: { mode, source, enabled, has_feature, agy_version, note }`.

Health after install:

```bash
node /path/to/Gentle-ai-mod/install.mjs --check
```

## Invariants

1. One orchestrator (OpenCode gentle-orchestrator)
2. One active writer worker per phase
3. ≤1 worker question per launch
4. ≤1 model question per launch (universal selector)
5. Store beats stdout
6. No absolute cross-machine paths in committed config
7. review lifecycle gates and commit/PR run on the orchestrator (OpenCode), never agy
8. Dedup launches by `(phase, fingerprint)`

## Skill resolution note

When launching **either** worker, still inject matching project/skill paths into the phase prompt (Skill Resolver Protocol). The runner also discovers `sdd-<phase>` + `_shared` via portable roots.
