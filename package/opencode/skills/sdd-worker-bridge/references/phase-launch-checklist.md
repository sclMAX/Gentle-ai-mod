# Phase-Launch Checklist (Worker Bridge v2)

Orchestrator decision procedure. Run before EVERY sub-agent launch (SDD phase or delegated task).

## A. Bootstrap (once per session)

- [ ] Preflight complete including `worker_policy`
- [ ] Load `~/.config/gentle-ai/workers.yaml` + optional `.atl/sdd-workers.yaml`
- [ ] `agy.available` via PATH; cache agy model catalog into `session.agy_models` (`agy models`, probe `--output-format json`, fall back to plain tab-separated list)
- [ ] Init exhausted flags false; empty phase_bindings

## B. Pre-launch

- [ ] Identify `phase`, `change`, `project`, `artifact_store`, `execution_mode`, `git_root`
- [ ] If phase ineligible → binding.worker=opencode → launch
- [ ] Resolve worker per policy (ask / prefer / only)
- [ ] Resolve model+effort if worker=agy — universal selector: list catalog, recommend per task kind, accept or pick
- [ ] Applies to ALL sub-agents (SDD phases AND delegated tasks); task bindings keyed by fingerprint
- [ ] Freeze `phase_bindings[phase]` / `task_bindings[fingerprint]`
- [ ] Build phase_prompt (executor role, skills paths, deps refs, allowlist, result contract)

## C. Launch

### OpenCode

- [ ] `task(subagent_type: sdd-<phase>, prompt: ...)`
- [ ] Dedup `(phase, fingerprint)`

### agy

- [ ] Write prompt file
- [ ] Verify `sdd-<phase>` SKILL.md exists in an agy-scanned root (`~/.gemini/antigravity-cli/skills/`) when `slash_command_skills` is `auto`/`on` — runner prepends `/sdd-<phase>` on agy ≥ 1.1.9
- [ ] `node ~/.config/gentle-ai/bin/run-agy-phase.mjs --phase ... --change ... --project ... --cwd ... --prompt-file ... [--model] [--effort]`
- [ ] Parse JSON envelope from stdout (meta includes `slash_command_skills`)

## D. Normalize

```text
status, error_class, worker, model, effort, artifacts, next_recommended, duration_s
```

error_class: null | quota_exceeded | timeout | unavailable | contract | unknown

## E. Gatekeeper

- [ ] Store artifact exists and is non-empty (Engram/OpenSpec)
- [ ] Authority = store, not stdout
- [ ] Pass → post-phase; Fail → retry/failover

## F. Retry / failover

1. contract → same worker once  
2. agy quota_exceeded → walk whole model_fallback chain in order (same worker, next model, no re-ask)  
3. entire agy chain quota-failed / agy unavailable → other worker once (mark exhausted)  
4. STOP

## G. Post-phase success

- [ ] User summary: phase · worker · model · effort · duration · status · failover?
- [ ] Optional receipt: `sdd/{change}/bridge/{phase}`
- [ ] Interactive → proceed question; Automatic → next phase

## H. Invariants

One orchestrator · one worker at a time · store wins · ≤1 worker question + ≤1 model question per launch; walk model chain on quota · review lifecycle + commit/PR stay on OpenCode
