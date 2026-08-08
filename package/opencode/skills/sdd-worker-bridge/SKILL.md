---
name: sdd-worker-bridge
description: "SDD worker bridge for agy vs OpenCode phase runners. Trigger: SDD phase launch, agy worker, model/effort selection, quota failover, run-agy-phase, worker policy."
license: MIT
metadata:
  author: gentle-ai-local
  version: "1.2"
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

**Eligible (all SDD phases):** explore, propose, spec, design, tasks, apply, verify, archive, init, onboard  
**Orchestrator-only (not SDD phases):** review lifecycle gates, commit/PR

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

## Structured output (v1.2)

Runner defaults (overridable via CLI or `workers.agy`):

| Flag / key | Default | Notes |
|------------|---------|--------|
| `--output-format` / `output_format` | `json` | Also `stream-json` (NDJSON; last `event=result`) |
| `--json-schema` / `json_schema` | `default` | Ships `schemas/sdd-phase-result.schema.json` |
| `--no-json-schema` | — | Alias for `--json-schema none` |
| `--stream-progress` | off | With stream-json: brief DONE lines on **stderr** |
| `--stream-progress-detail` | `summary` | Progress verbosity: `summary` label only, `tools` + tool name/params, `full` + live model text + duration/tokens |
| `--stderr-log` / `stderr_log` | off (`null`) | Write verbose progress to a file instead of stderr. Templates: `{config} {home} {cwd} {phase} {change} {project}`. Notice line + envelope `stderr_log_path` still expose the path |

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

## Verbose progress to file (v1.7)

When `--stderr-log` (or `workers.agy.stderr_log`) is active, the runner writes ALL verbose progress to a file and leaves only a notice on stderr. The orchestrator must present the copy-paste ready command **BEFORE** launching the phase — after the run it is too late (the bash tool only sees the notice once the command has finished):

```text
Progreso de la fase: <path>
Seguilo en vivo:  tail -f <path>
```

Pre-launch resolution (single source of truth = runner dry-run, never re-derive from config):

1. Run once with `--dry-run` (plus the same `--stderr-log` / model / effort flags you will use) and read `stderr_log_path` from its JSON envelope. Dry-run spawns no agy process and costs milliseconds.
2. If `stderr_log_path` is non-null, print the two-line block above, then launch the real phase (without `--dry-run`).
3. If it is `null` (stderr_log off), skip the block — stderr progress already stays small.

Rules:

- Do **not** render a `file://` chip or claim it opens anything: OpenCode TUI has no click-to-open yet (#37891 open, PR #39206 in progress).
- Keep it to the two-line block above; do not dump log contents into chat unless the user asks.
- The in-run stderr notice `[agy] progress log: <path>` still exists for manual runs, but the orchestrator must not wait for it to present the path.

## Invariants

1. One orchestrator (OpenCode gentle-orchestrator)
2. One active writer worker per phase
3. ≤1 worker question per phase per run
4. ≤1 profile question when applicable
5. Store beats stdout
6. No absolute cross-machine paths in committed config
7. review lifecycle gates and commit/PR run on the orchestrator (OpenCode), never agy
8. Dedup launches by `(phase, fingerprint)`

## Skill resolution note

When launching **either** worker, still inject matching project/skill paths into the phase prompt (Skill Resolver Protocol). The runner also discovers `sdd-<phase>` + `_shared` via portable roots.
