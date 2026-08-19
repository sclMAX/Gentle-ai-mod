# Gentle-ai-mod

Portable **OpenCode + Antigravity (agy)** workstation mods for [Gentle AI](https://github.com/) SDD:

- **SDD Worker Bridge v2** — universal worker selector: run SDD phases *or* delegated tasks on OpenCode **or** `agy`, with model recommendation, quota-aware model-chain failover, and a hard data-driven config gate
- **herdr transport** — SDD phases and non-SDD tasks run through the external `herdr` terminal daemon (tabs, panes, agents over a Unix socket). The legacy `direct` transport was removed in v2.0: without herdr there is no agy path
- Cross-platform installer (Windows + Linux) with health check
- No machine-absolute paths in committed config

Repo: https://github.com/sclMAX/Gentle-ai-mod

---

## What gets installed

| Target | Contents |
|--------|----------|
| `~/.config/gentle-ai/` | `workers.yaml`, `bin/run-agy-phase.mjs` (v2 phase wrapper), `bin/run-agy-phase-herdr.mjs` (herdr transport runner), `bin/run-agy-task.mjs` (generic task launcher), `bin/patch-orchestrator-worker-bridge.mjs`, `schemas/sdd-phase-result.schema.json`, generated `README.md` |
| `~/.config/opencode/skills/sdd-worker-bridge/` | Orchestrator skill v2.0 + phase-launch checklist |
| `~/.gemini/antigravity-cli/skills/sdd-worker-bridge/` | Same skill mirrored for agy (if Antigravity present) |
| `~/.config/opencode/skills/sdd-tasks/SKILL.md` | Review Workload Forecast section patched: honest ranges, 11-field forecast table, chain-strategy decision |
| `~/.config/opencode/opencode.json` | Patches `gentle-orchestrator` prompt with the Worker Bridge v2 HARD GATE and upgrades the SDD preflight to **5 groups** (Pace, Artifacts, PRs, Review, **Workers**). **Backup created first.** |

---

## Prerequisites

- **Node.js 18+** on `PATH`
- OpenCode already set up with Gentle AI (existing `~/.config/opencode/opencode.json`)
- **`herdr` daemon on `PATH` and running**, with `HERDR_SOCKET_PATH` set to an absolute socket path (test with `herdr status`). The agy runner exits 6 without it.
- Optional: `agy` and `engram` on `PATH` for the Antigravity worker path

---

## Install

### One-liner (after clone)

**Linux / macOS**

```bash
git clone https://github.com/sclMAX/Gentle-ai-mod.git
cd Gentle-ai-mod
chmod +x install.sh
./install.sh
```

**Windows (PowerShell)**

```powershell
git clone https://github.com/sclMAX/Gentle-ai-mod.git
cd Gentle-ai-mod
.\install.ps1
```

**Any OS (Node directly)**

```bash
node install.mjs
```

### Options

```text
node install.mjs --check           # health check only (exit 0/1, no writes)
node install.mjs --dry-run         # show actions only
node install.mjs --no-patch        # skip opencode.json prompt patch
node install.mjs --no-antigravity  # skip agy skills mirror
node install.mjs --force           # still backs up, then overwrites
node install.mjs -h, --help        # usage
```

`--check` validates Node ≥ 18, the package layout, `workers.yaml`, the phase and herdr runners, the result schema, the skill, `agy` on PATH (+ version), optional `gentle-ai`/`engram` (warn only), the patched orchestrator, and a runner dry-run smoke.

### After install

1. **Restart OpenCode** (required)
2. Start SDD → preflight should show a **Workers** tab (5 groups in one question call)
3. Optional per-repo override: `<repo>/.atl/sdd-workers.yaml` (deep-merged over `~/.config/gentle-ai/workers.yaml`)

---

## Layout

```text
Gentle-ai-mod/
  install.mjs              # main installer (cross-platform, health check)
  install.sh / install.ps1 # thin wrappers
  package/
    gentle-ai/             # → ~/.config/gentle-ai
      bin/
        run-agy-phase.mjs        # v2 phase wrapper (spawns herdr runner)
        run-agy-phase-herdr.mjs  # herdr transport runner (the real runner)
        run-agy-task.mjs         # generic task launcher (explore|general|writer)
        patch-orchestrator-worker-bridge.mjs
      schemas/sdd-phase-result.schema.json
      workers.yaml         # model/effort policy, fallback chain, herdr config
    opencode/skills/       # → ~/.config/opencode/skills
    antigravity/skills/    # → Antigravity skills (optional)
    opencode/skills-patches/sdd-tasks-forecast.md  # forecast section patch
```

---

## Worker bridge v2 (behavior summary)

- **Orchestrator:** only OpenCode `gentle-orchestrator` (or patched SDD orchestrators)
- **Eligible on agy:** all SDD phases (explore, propose, spec, design, tasks, apply, verify, archive, init, onboard) **and** delegated tasks (`explore | general | writer`)
- **Always OpenCode:** review lifecycle and commit/PR
- **Policy (preflight Workers group):** ask-each-phase | prefer-agy | prefer-opencode | opencode-only | agy-only
- **Universal pre-launch:** (1) ask worker first via the `question` tool, STOP until answered; (2) if agy and no model set, list the **real** available models from the cached `agy models` catalog with the recommended one first; (3) freeze the binding per phase / task-fingerprint, never re-ask on failover
- **Data-driven model gate (HARD GATE):** model/effort recommendations never live in prompt or skill memory — the effective `workers.yaml` (+ `.atl/sdd-workers.yaml`) is the only source of truth and must be read each session
- **Failover:** 1× corrective retry on same worker → agy `quota_exceeded` walks the **whole** `model_fallback` chain in order → entire agy chain failed → other worker once (agy marked exhausted) → STOP. Max 2 worker attempts per phase
- **Authority:** the store (Engram/OpenSpec artifact) wins over CLI stdout — PASS requires a readable canonical artifact plus a coherent `next_recommended`
- **Summary line:** `phase · worker · model · effort · duration · status · failover?`

Config defaults live in `package/gentle-ai/workers.yaml`.

---

## herdr transport

SDD phases and agy tasks run through **herdr** — an external terminal daemon that manages tabs, panes, and agy agents over a Unix socket (`HERDR_SOCKET_PATH`). This repo does not ship herdr; it must be installed, running, and reachable.

Flow per run:

1. **Preflight:** `HERDR_SOCKET_PATH` must be absolute and `herdr status` must succeed — otherwise exit 6 `herdr_missing`
2. **Tab:** `herdr tab create --workspace <id> --cwd <repo> --label sdd-<phase>-<change>` (or `agy-task-<kind>`)
3. **Agent:** `herdr agent start <name> --kind agy --pane <paneId> [-- --model X --effort Y --extra-flag ...]` — model/effort/timeout are forwarded so agy does not fall back to its own defaults (`--effort` is omitted for Claude/gpt-oss models that reject it). **Extra args** from `workers.agy.extra_args` (e.g. `--dangerously-skip-permissions`) are injected after model/effort; managed flags (`--output-format`, `--json-schema`, `--no-json-schema` + their values) are stripped to avoid conflicts
4. **Prompt:** `herdr agent prompt <target> <prompt> --wait --timeout <ms>` — the prompt instructs agy to write its structured result JSON to an absolute sentinel file under the OS tmpdir
5. **Capture:** a poll loop watches the sentinel file and the agent status; the sentinel JSON becomes the result envelope. Each run uses **exactly one tab and one prompt**; the tab is closed on every exit path

Runtime safeguards:

- **Stall gates (two-tier):** tier-1 startup timeout (default 60s) before any activity; tier-2 inactivity timeout (`max(prompt timeout, 120s)`) after activity stops → exit 8 `stalled` with `stall_reason: startup_timeout | inactivity_timeout | prompt_delivery_failed`
- **Blocked prompts:** status `blocked` emits a `permission_required` envelope, waits 300s for the human → exit 7 `blocked_timeout`
- **Account verification:** the runner detects `verifying your account / account eligibility` and retries the prompt with backoff (15s, up to 5 attempts) → exit 4 `unavailable` with `stall_reason: account_verification`
- **Stall reconciliation (v2.1):** an inconclusive prompt close never re-submits a duplicate prompt. If the agent is still alive it keeps polling until the sentinel appears. `agent_prompt_stalled` with the agent **still idle and seq/revision unchanged** means the prompt text was never delivered (agy TUI not ready) — the runner **re-sends the prompt** with backoff (8s, up to 3 attempts) → exit 4 `stalled` with `stall_reason: prompt_delivery_failed` when exhausted. If the agent reports `done` without a result file, the runner **keeps polling within the sentinel grace window** (60s) instead of dying at ~1s — Claude (Thinking) models finish their first response turn before writing the sentinel in a later turn → exit 5 `contract` only after the grace expires
- **Worktree behavior:** apply runs in the **main worktree** — herdr worktree isolation was dropped; git itself is the safety net and the RDD correction transaction expects candidate changes in the lineage repo
- On success, the conversation id is saved to engram (`engram save <title> <conversationId> --type architecture`)

Tunable env vars (`run-agy-phase-herdr.mjs`): `HERDR_SOCKET_PATH` (required, absolute), `HERDR_WORKSPACE_ID` (default `default`), `GGA_HERDR_VERIFY_RETRY_MS` (15000), `GGA_HERDR_MAX_VERIFY_ATTEMPTS` (5), `GGA_HERDR_STARTUP_TIMEOUT_MS` (60000), `GGA_HERDR_INACTIVITY_TIMEOUT_MS` (default `max(prompt timeout, 120000)`), `GGA_HERDR_POLL_INTERVAL_MS` (2000), `GGA_HERDR_SENTINEL_GRACE_MS` (60000), `GGA_HERDR_STALL_RETRY_MS` (8000), `GGA_HERDR_MAX_STALL_RETRY_ATTEMPTS` (3).

> Note: the `herdr.stalled_gate` / `allowlist` keys in `workers.yaml` are reference documentation for the transport; the runner's actual gate values come from the env vars above.

---

## Manual launches

### SDD phase (via wrapper)

```bash
node ~/.config/gentle-ai/bin/run-agy-phase.mjs \
  --phase explore \
  --change my-change \
  --project my-project \
  --cwd /path/to/repo \
  --model gemini-3.7-flash-medium \
  --effort medium
```

Flags (defaults from `workers.yaml` when omitted):

```text
Required:  --phase <explore|propose|spec|design|tasks|apply|verify|archive|init|onboard>
           --change <name>  --project <id>  --cwd <repo>
Options:   --model <id>  --effort <low|medium|high>  --timeout <dur>
           --artifact-store <engram|openspec|hybrid|none>  (default engram)
           --prompt-file <path> | --prompt <text>
           --config <path>                 # workers.yaml override
           --output-format <json|stream-json>   (default: config, else json)
           --json-schema <default|none|<path>>  (default: shipped sdd-phase result schema)
           --no-json-schema               # alias for --json-schema none
           --slash-command-skills <auto|on|off>  (default auto)
           --stream-progress | --no-stream-progress
           --stream-progress-detail <summary|tools|full>
           --dry-run  --json  -h, --help
```

The v2 wrapper re-spawns `run-agy-phase-herdr.mjs` with the full original argv. `--transport` is parsed but **ignored** (with a stderr warning) unless `herdr` — v2.0 hard-forced herdr.

### Generic delegated task (non-SDD)

```bash
node ~/.config/gentle-ai/bin/run-agy-task.mjs \
  --task-kind general \
  --project my-project \
  --cwd /path/to/repo \
  --prompt-file /tmp/task-prompt.txt
```

`--task-kind` is strictly `explore | general | writer`; the runner refuses to invent SDD phases. Forwarded: `--prompt`, `--prompt-file`, `--model`, `--effort`, `--timeout`, `--task-label`, `--dry-run`.

### herdr runner (direct)

`run-agy-phase-herdr.mjs` accepts the same core flags plus `--task-kind`/`--task-label`, and requires either `--phase` + `--change` (SDD) or `--task-kind` (task), always with `--project` and a `--cwd` inside the git repo root. `--extra-args <json>` accepts a JSON array of additional agy CLI flags (injected by the wrapper from `workers.agy.extra_args`). `--dry-run` prints the resolved transport, prompt length, model/effort/timeout and agent start args without requiring herdr.

### Exit codes

```text
0  success
2  invalid args / invalid cwd / bad task-kind
4  agy/ herdr operation failed, quota exceeded, timeout, unavailable,
   account verification pending, or terminal dead state
5  contract violation (result sentinel file missing)
6  herdr missing / not running / HERDR_SOCKET_PATH not absolute
7  blocked timeout (permission prompt not answered in 300s)
8  stalled (startup or inactivity timeout)
```

### Slash-command skills

`slash_command_skills: auto` (default) prepends `/sdd-<phase>` to the agy print prompt when agy ≥ 1.1.9, so the phase skill is resolved and applied natively instead of being read as a file. Requires the `sdd-<phase>` skill mirrored to an agy-scanned root (`~/.gemini/antigravity-cli/skills/`, done by the installer). `off` keeps literal prompts and appends `--disable-slash-commands` (also protects prompts starting with `/`). Prompts that already start with `/` are never prepended.

---

## Workers config (`workers.yaml`)

- **model_by_phase:** explore/archive/init `gemini-3.7-flash-medium`, propose/spec/tasks/apply `gemini-3.7-flash-high`, design/verify/onboard `claude-sonnet-4-6`
- **recommend_by_task (universal selector):** read `gemini-3.7-flash-medium/medium`, write `gemini-3.7-flash-high/high`, design `claude-sonnet-4-6`, heavy `claude-opus-4-6-thinking`
- **model_fallback (quota chain, walked in order):** `gemini-3.6-flash-high` → `claude-sonnet-4-6` → `gemini-3.1-pro-high` → `gemini-3.6-flash-medium`
- **Effort:** derived from the model suffix (`-low|-medium|-high`); `effort_by_phase` is left unset and `--effort` is omitted for models that reject it (Claude, gpt-oss)
- **Resolution order:** explicit user override → frozen binding → `model_by_phase[phase]` → `recommend_by_task[task_kind]` → `default_model` → omit. The selected model is validated against the real `agy models` catalog; if unavailable, walk `model_fallback` in order
- **Failover policy:** on `[quota_exceeded, timeout, unavailable, invalid_result_contract, invalid_model_selection]`, walk the whole fallback chain, then other worker; max 2 attempts per phase
- **Per-phase timeouts:** explore 10m, propose 12m, spec 12m, design 15m, tasks 10m, verify 15m, apply 20m, archive 10m, init 10m, onboard 15m
- `profiles` (fast/balanced/strong) are legacy; v2 uses `recommend_by_task`

---

## Review Workload Forecast patch

The installer patches the installed `sdd-tasks` skill with an honesty-first forecast section:

- **Ranges, not false-precise numbers** — estimates are built from a required rubric (new file 40–120 lines, edit 15–60, test 30–100, wiring 10–40; docs usually Low; generated/lockfiles/vendor excluded from budget but noted)
- **11-field forecast table** (changed lines range, method, confidence, files touched, test share, generated excluded?, 400-line budget risk, chained PRs recommended, suggested split, delivery strategy, chain strategy)
- **Risk tiers:** Low ≤ 250, Medium 251–400, High > 400 or ≥ 3 independent work units
- **Chain strategy decision** (team choice): Stacked PRs to main / Feature Branch Chain / `size:exception` — surfaced as `Decision needed before apply`
- The patch is idempotent and backs up the target skill first

Re-apply orchestrator patch after a Gentle/OpenCode upgrade overwrites prompts:

```bash
node ~/.config/gentle-ai/bin/patch-orchestrator-worker-bridge.mjs
# or:
node install.mjs
```

---

## Updating another workstation

```bash
cd Gentle-ai-mod && git pull && node install.mjs
# restart OpenCode
```

---

## Tests

```bash
node --test test/
```

Covers socket validation, prompt-file shell-interpolation security, cwd escape prevention, account-verification retry, stalled-prompt reconciliation (no duplicate tab/prompt), stalled-prompt re-send (delivered on retry and exhausted `prompt_delivery_failed`), sentinel grace (late sentinel within the window and contract violation after it expires), model/effort/timeout forwarding, extra-args forwarding and malformed JSON handling, apply in main worktree, crash cleanup, and the task launcher routing.

---

## Changelog

### v2.2

- **`extra_args` passthrough** — `workers.agy.extra_args` from `workers.yaml` is now injected into agy CLI args via the herdr transport. The wrapper computes the filtered list (strips managed flags `--output-format`, `--json-schema`, `--no-json-schema` and their values), passes it as `--extra-args <json>` to the herdr runner, which appends parsed entries after model/effort. Fixes `declaring permissions: cortex tool write_to_file: invalid tool call error (invalid_args)` when agy's permission engine fails on sentinel file writes outside trusted workspaces. Malformed JSON is silently ignored
- **Test coverage:** +2 tests (extra-args forwarding, malformed JSON handling) — 17 total

### v2.1

- **Sentinel grace (`GGA_HERDR_SENTINEL_GRACE_MS`, default 60s)** — when herdr reports `done` but the sentinel result file is not there yet, the runner keeps polling within the grace window instead of dying at ~1s with `Contract violation: result file not found`. Fixes the deterministic Claude (Thinking) failure: those models finish their first response turn (herdr's `done`) before writing the sentinel in a later turn
- **Stalled-prompt re-send (`GGA_HERDR_STALL_RETRY_MS` 8s, `GGA_HERDR_MAX_STALL_RETRY_ATTEMPTS` 3)** — `agent_prompt_stalled` with the agent still idle and seq/revision unchanged means the prompt text was never delivered (agy TUI not ready); the runner re-sends the prompt with backoff, then exits 4 `stalled` with `stall_reason: prompt_delivery_failed`
- **Test coverage:** +4 regression tests (stalled re-send success, exhausted re-send, late sentinel within grace, grace-exceeded contract violation) — 15 total

### v2.0

- **herdr is the ONLY transport** — legacy `direct` transport removed from `run-agy-phase.mjs`; `--transport`/`transport` are ignored unless `herdr`
- **herdr transport runner** (`run-agy-phase-herdr.mjs`): tabs/panes/agents over the Unix socket, sentinel-file result capture, two-tier stall gates, blocked-prompt policy, exactly one tab + one prompt per run, tab cleanup on every exit
- **Account-verification detection** — regex on prompt output with backoff retry (5 attempts) and `stall_reason: account_verification`
- **Stall reconciliation** — inconclusive prompt closes never re-submit a duplicate prompt
- **Apply runs in the main worktree** — herdr worktree isolation dropped
- **Universal worker selector v2** — model/effort recommendation from the effective `workers.yaml` (radical data-driven gate), real `agy models` catalog validation, whole-chain quota failover, worker policy as the 5th preflight group
- **Task runner** (`run-agy-task.mjs`) — non-SDD delegated tasks over the same herdr transport (`explore|general|writer`)
- **Installer:** validates herdr runner installation in `--check`; patches the `sdd-tasks` Review Workload Forecast (honest ranges + 11-field table + chain strategy)

### v1.7

- **Skill (worker bridge):** `agy models` cache probes `agy models --output-format json` first and falls back to the plain tab-separated list when the flag errors (some 1.1.12 builds predate the models/agents JSON flag — changelog is ahead of the shipped binary). Structured parsing activates automatically once the flag ships.

### v1.6

- **Runner:** `--stream-progress-detail summary|tools|full` — stderr progress verbosity. `tools` shows tool name + key parameters (`running command: ls -la`); `full` adds live streaming of the model's `text_delta` and duration/tokens when each step closes
- **Runner:** envelope meta gains `stream_progress_detail`; tools now render their real name (agy sends `step_type: "tool"` + `tool_name` since 1.1.10)
- **Config:** `workers.agy.stream_progress_detail: full` default (package ships `full`)

### v1.5

- **Runner:** live stderr progress by default on stream-json — `[agy]` lifecycle start line, step RUNNING/DONE ticks with friendly labels, `result received` notice, and a liveness heartbeat (120s) when no step event arrives
- **Runner:** `--no-stream-progress` disables ticks; `workers.agy.stream_progress` (default `true`) sets the default
- **Config:** `workers.agy.output_format` default switched `json` → `stream-json` (stdout envelope contract unchanged)

### v1.4

- **Runner:** native `/sdd-<phase>` skill expansion in print mode (agy ≥ 1.1.9) — phase skill loads via slash command instead of a file read
- **Runner:** `workers.agy.slash_command_skills` / `--slash-command-skills auto|on|off`; `off` appends `--disable-slash-commands` on agy ≥ 1.1.9
- **Runner:** `agy --version` detection; envelope meta gains `slash_command_skills`
- **Config:** `workers.agy.slash_command_skills: auto` default

### v1.2

- **Runner:** default `--json-schema` (`schemas/sdd-phase-result.schema.json`) + `--output-format json`
- **Runner:** prefer `structured_output`; strip markdown fences; parse `stream-json` NDJSON `result` event
- **Runner:** `--stream-progress` (stderr), envelope fields `output_format`, `json_schema_path`, `structured_output_used`
- **Installer:** copies `schemas/`; `node install.mjs --check` health mode
- **Installer:** patches honest Review Workload Forecast rules into installed `sdd-tasks` (range + confidence)
- **Config:** `workers.agy.output_format` / `json_schema` scalar defaults

### v1.1

- **Runner:** normalize Gemini model-suffix ↔ `--effort`; omit `--effort` for Claude
- **Runner:** one automatic retry on `invalid model selection` / effort conflicts
- **Runner:** `error_class: invalid_model_selection` for orchestrator failover
- **Config:** `default_effort: null` (avoid forcing medium onto `*-high` models)
- **Config:** design/verify may use Claude safely (effort stripped)

### v1.0

- Initial worker bridge package + cross-platform installer

---

## License

MIT — see [LICENSE](./LICENSE)
