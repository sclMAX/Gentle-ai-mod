# Phase-Launch Checklist (Worker Bridge v1)

Orchestrator decision procedure. Run before every SDD phase.

## A. Bootstrap (once per session)

- [ ] Preflight complete including `worker_policy`
- [ ] Load `~/.config/gentle-ai/workers.yaml` + optional `.atl/sdd-workers.yaml`
- [ ] `agy.available` via PATH; cache `agy models` if available
- [ ] Init exhausted flags false; empty phase_bindings

## B. Pre-launch

- [ ] Identify `phase`, `change`, `project`, `artifact_store`, `execution_mode`, `git_root`
- [ ] If phase ineligible → binding.worker=opencode → launch
- [ ] Resolve worker per policy (ask / prefer / only)
- [ ] Resolve model+effort if worker=agy
- [ ] Freeze `phase_bindings[phase]`
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
2. agy quota/unavail → model_fallback once  
3. other worker once (mark exhausted on quota when leaving worker)  
4. STOP

## G. Post-phase success

- [ ] User summary: phase · worker · model · effort · duration · status · failover?
- [ ] Optional receipt: `sdd/{change}/bridge/{phase}`
- [ ] Interactive → proceed question; Automatic → next phase

## H. Invariants

One orchestrator · one worker at a time · store wins · ≤1 worker failover · review lifecycle + commit/PR stay on OpenCode
