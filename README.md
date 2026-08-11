# Gentle-ai-mod

Portable **OpenCode + Antigravity (agy)** workstation mods for [Gentle AI](https://github.com/) SDD:

- **SDD Worker Bridge** — run eligible SDD phases on OpenCode *or* `agy`, with model/effort and quota failover
- Cross-platform installer (Windows + Linux)
- No machine-absolute paths in committed config

Repo: https://github.com/sclMAX/Gentle-ai-mod

---

## What gets installed

| Target | Contents |
|--------|----------|
| `~/.config/gentle-ai/` | `workers.yaml`, `bin/run-agy-phase.mjs`, `bin/patch-orchestrator-worker-bridge.mjs`, `schemas/sdd-phase-result.schema.json` |
| `~/.config/opencode/skills/sdd-worker-bridge/` | Orchestrator skill + phase-launch checklist |
| `~/.gemini/antigravity-cli/skills/sdd-worker-bridge/` | Same skill mirrored for agy (if Antigravity present) |
| `~/.config/opencode/opencode.json` | Patches `gentle-orchestrator` prompt (Workers preflight + HARD GATE). **Backup created first.** |

---

## Install

### Prerequisites

- **Node.js 18+** on `PATH`
- OpenCode already set up with Gentle AI (existing `~/.config/opencode/opencode.json`)
- Optional: `agy` and `engram` on `PATH` for the Antigravity worker path

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
```

### After install

1. **Restart OpenCode** (required)
2. Start SDD → preflight should show a **Workers** tab
3. Optional per-repo override: `<repo>/.atl/sdd-workers.yaml`

---

## Layout

```text
Gentle-ai-mod/
  install.mjs              # main installer (cross-platform)
  install.sh / install.ps1 # thin wrappers
  package/
    gentle-ai/             # → ~/.config/gentle-ai
    opencode/skills/       # → ~/.config/opencode/skills
    antigravity/skills/    # → Antigravity skills (optional)
```

---

## Worker bridge (behavior summary)

- **Orchestrator:** only OpenCode `gentle-orchestrator`
- **Eligible phases on agy:** explore, propose, spec, design, tasks, verify
- **Always OpenCode:** apply, archive, init, review/git
- **Policy (preflight):** ask-each-phase | prefer-agy | prefer-opencode | opencode-only | agy-only
- **Failover:** contract retry → model fallback (agy) → other worker once
- **Authority:** Engram/OpenSpec store wins over CLI stdout

Config defaults live in `package/gentle-ai/workers.yaml`.

Manual phase launch:

```bash
node ~/.config/gentle-ai/bin/run-agy-phase.mjs \
  --phase explore \
  --change my-change \
  --project my-project \
  --cwd /path/to/repo \
  --model gemini-3.6-flash-medium \
  --effort medium
```

Runner v1.6 flags (defaults from `workers.yaml` when omitted):

```text
--output-format json|stream-json   # default stream-json
--json-schema default|none|<path>  # default: shipped sdd-phase result schema
--no-json-schema                   # alias for --json-schema none
--slash-command-skills auto|on|off # native /sdd-<phase> skill expansion (default auto)
--stream-progress                  # stderr progress ticks (default: config, then on)
--no-stream-progress               # disable stderr progress ticks even when stream-json
--stream-progress-detail summary|tools|full
                                   # stderr progress verbosity (default: config, then summary)
                                   # summary = label only | tools = + tool name/params
                                   # full = tools + live model text + duration/tokens on close
--dry-run                          # print final CLI args (includes format + schema path)
```

`slash_command_skills: auto` (default) prepends `/sdd-<phase>` to the agy print prompt
when agy ≥ 1.1.9, so the phase skill is resolved and applied natively instead of being
read as a file. Requires the `sdd-<phase>` skill mirrored to an agy-scanned root
(`~/.gemini/antigravity-cli/skills/`, done by the installer). `off` keeps literal
prompts and appends `--disable-slash-commands` on agy ≥ 1.1.9 (also protects prompts
starting with `/`, e.g. absolute paths). Prompts that already start with `/` are never
prepended.

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

## Changelog

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
- **README:** flags block + changelog updated to match

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
