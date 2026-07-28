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
| `~/.config/gentle-ai/` | `workers.yaml`, `bin/run-agy-phase.mjs`, `bin/patch-orchestrator-worker-bridge.mjs` |
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
