# RFC: Apply on agy (HITL) — full apply + hybrid slices

| Field | Value |
|-------|--------|
| Status | Draft (revised) |
| Target | Gentle-ai-mod v1.3 (experimental, opt-in per batch) |
| Author | gentle-orchestrator session |
| Depends on | Worker bridge v1.2 (json-schema, stream-json), agy ≥ 1.1.8, `sdd-apply` skill on agy |
| Non-goal | Silent auto-delegation of apply to agy without a human choice |

> **Status note (2026-07-31):** Implemented via the simple route — `apply` was added to
> the runner's eligible phases and `workers.yaml` `policy.eligible` (source edits allowed
> for `apply` only). The `--role apply-batch` / `implement-slice` roles, `apply-batch-result`
> / `implement-slice-result` schemas, always-HITL apply worker question, and allowlist gate
> from §7–§8 are **deferred**. Consequence: `prefer-agy` can now route `apply` to agy without
> a human prompt. Commits/PR and review lifecycle remain orchestrator-only.

## 1. Problem

SDD `apply` is the longest, highest-risk phase. Today it is **always OpenCode** (`sdd-apply`). Planning phases may run on agy. That splits cost/throughput while agy already has `sdd-apply` and strong headless contracts (1.1.8).

Users who already trust agy for propose/design may want **apply on agy too**. The system must not do that silently: **human in the loop**.

## 2. Product decision (locked for this RFC)

1. **Always ask** before any non-OpenCode apply work (full or hybrid). No silent `prefer-agy` for apply.  
2. **Full apply on agy is allowed from v0** (not deferred).  
3. **Hybrid slices** remain a first-class option (OpenCode owns progress/commits; agy does one slice).  
4. **OpenCode remains the orchestrator** and the default **recommendation** in most cases.  
5. SDD **Automatic** mode does **not** skip the apply worker question when agy is a candidate (apply = HITL checkpoint).

## 3. Proposal

```text
OpenCode reaches apply (tasks ready)
  → build recommendation (signals below)
  → ALWAYS ask human (question tool), once per apply batch / work-unit boundary
  → branch:

  [OpenCode]     sdd-apply fully on OpenCode (today’s path)

  [agy full]     one (or batched) agy run(s) executing apply playbook;
                 OpenCode gatekeeps artifacts, tests, delivery, review

  [agy hybrid]   OpenCode sdd-apply owns loop; delegates allowlisted slices to agy;
                 OpenCode progress + commits + gates
```

- **One orchestrator:** OpenCode only.  
- **One active writer at a time** on a given worktree (no parallel OpenCode apply + agy apply).  
- **Human decides** worker mode; system only recommends.

## 4. HITL question (always)

### 4.1 When

- Once at **start of an apply batch** (start of `sdd-apply` or continuation batch).  
- Again only when: new work-unit / chained-PR slice boundary, or user says “change apply worker”, or prior agy apply exhausted/failed over and human must re-choose.  
- **Not** once per checklist row (fatigue).

### 4.2 Shape (question tool)

Present **three** options (labels localized to user language; no internal codes in UI):

| Option | Intent |
|--------|--------|
| OpenCode (recommended when …) | Full apply on OpenCode |
| Antigravity full apply | agy runs apply playbook for this batch |
| Antigravity hybrid slices | OpenCode owns apply; agy implements allowlisted slices |

Always include **one-line recommendation** derived from §5, e.g.:

- “Reco: OpenCode — hot path (auth) + no focused test command.”  
- “Reco: agy full — 2 clear files, tests green path, non-critical.”  
- “Reco: hybrid — medium batch; keep commits on OpenCode.”

Recommended option is listed **first** with “(Recommended)” in the label.

### 4.3 Auto mode

Pipeline auto may run propose→tasks without stops. **Apply worker choice is never auto-answered.** If the human is unavailable, stay on OpenCode or **block** with “apply worker decision required” — do not invent agy full.

## 5. Recommendation rubric (system → human)

Score signals; produce a single reco + short reason. Human may override freely.

| Signal | Favors OpenCode | Favors agy full | Favors hybrid |
|--------|-----------------|-----------------|---------------|
| Files in batch high-end ≤ 2, paths explicit | (either) | strong | weak |
| Files 3–6 or ~150–400 lines | strong default | weak | strong |
| Files / lines large or chained PR | strong | no | only inside current PR slice |
| Hot path (auth/pay/migrate/codegen dump) | strong | no (unless human forces) | no |
| Focused test command known | — | required for “good” reco | required |
| No paths in tasks / vague tasks | strong | no | no |
| Strict TDD + complex harness | strong | weak | medium |
| agy exhausted / offline | only | — | — |
| User said “use agy for apply” this session | honor override | honor | honor |

**Defaults when unsure:** recommend **OpenCode**.

Never recommend agy full if: no test command **and** >1 non-trivial file, or hot path without explicit user history preferring agy.

## 6. Mode A — OpenCode full apply

Unchanged current behavior: `task(sdd-apply)`, progress, TDD, commits, review gates.

## 7. Mode B — agy full apply

### 7.1 Meaning

agy executes the **apply playbook** for the agreed batch scope (remaining open tasks or current work-unit), using installed `sdd-apply` + injected skills. OpenCode does **not** micro-edit in parallel.

### 7.2 Input (OpenCode → runner → agy)

| Input | Required | Notes |
|-------|----------|--------|
| `change`, `project`, `cwd` | yes | |
| Scope: task ids / work-unit | yes | Frozen at ask time |
| `path_allowlist[]` or `path_scope` | yes for v0 safety | From tasks; if empty → refuse agy full, fall back ask OpenCode |
| `commits_policy` | yes | v0 default: **`opencode-only`** (agy must not commit) unless human explicitly allows `agy-commits` in a later revision |
| `test_command` / strict_tdd | yes if known | Forward `sdd-init` |
| `apply_progress_ref` | yes | agy may **merge** progress; OpenCode re-reads and is authority after run |
| Result schema | yes | `apply-batch-result` (below) |

Runner entry: **`--role apply-batch`** (not adding `apply` to eligible SDD phases used for silent routing). Orchestrator only sets this role after HITL.

### 7.3 Output schema (`apply-batch-result`)

Enforced with `--json-schema`:

```json
{
  "status": "success | partial | failed | blocked",
  "executive_summary": "string",
  "tasks_completed": ["ids"],
  "tasks_remaining": ["ids"],
  "paths_touched": ["repo/relative"],
  "paths_outside_allowlist": [],
  "tests_run": [{ "command": "string", "exit_code": 0, "summary": "string" }],
  "tdd_followed": true,
  "commits_made": false,
  "commit_shas": [],
  "blockers": [],
  "progress_notes": "string",
  "skill_resolution": "string"
}
```

### 7.4 OpenCode gatekeeper after agy full

Mandatory before any commit/PR/review start:

1. **Allowlist / scope gate** on `git status` + diff. Escape → incident; do not commit.  
2. **Test gate** — re-run focused tests (do not trust worker alone).  
3. **Progress authority** — OpenCode reads Engram/OpenSpec progress; reconcile with worker claim.  
4. **Commits** — v0: OpenCode creates work-unit commits from the diff after gates pass.  
5. **Delivery / review** — unchanged, orchestrator-owned.  
6. On failure → report; offer HITL: retry agy once / switch OpenCode / stop.

### 7.5 Permissions

- Document v0 profile: headless permissions sufficient to edit allowlisted paths + run tests.  
- Prefer project allow rules over blind skip when feasible.  
- If `--dangerously-skip-permissions` remains required for agy reliability, **post-diff OpenCode gate is mandatory** (non-negotiable).

## 8. Mode C — agy hybrid slices

Same as prior hybrid design:

```text
OpenCode sdd-apply owns loop
  → pick next task
  → if slice eligible, may call agy --role implement-slice
  → diff + test gates → progress → commits on OpenCode
```

### 8.1 Slice eligibility (for hybrid only; automatic inside batch after human chose hybrid)

1. ≤ **3** files and high-end ≤ **150** lines for that slice.  
2. Explicit path allowlist (paths mentioned in task / backticks; if none → OpenCode implements that task).  
3. Focused test command known.  
4. Not hot path unless human overrode reco at batch ask.  
5. One writer at a time.

### 8.2 Slice schema (`implement-slice-result`)

```json
{
  "status": "success | partial | failed | blocked",
  "executive_summary": "string",
  "task_id": "string",
  "paths_touched": ["repo/relative"],
  "paths_outside_allowlist": [],
  "tests_run": [{ "command": "string", "exit_code": 0, "summary": "string" }],
  "tdd_followed": true,
  "commits_made": false,
  "blockers": [],
  "notes_for_progress": "string",
  "skill_resolution": "string"
}
```

v0: `commits_made: true` → fail policy for hybrid slices.

### 8.3 Triviality rule

Single-file mechanical edit → OpenCode inline inside hybrid batch (do not pay agy round-trip).

## 9. Failover matrix

| Failure | agy full | hybrid slice |
|---------|----------|--------------|
| quota / unavailable | model_fallback once → HITL re-choose or OpenCode | same → OpenCode slice |
| invalid_model_selection | runner retry → OpenCode / HITL | same |
| contract / schema | one corrective retry or OpenCode | prefer OpenCode if tree dirty |
| allowlist escape | no commit; incident; HITL | revert if safe; OpenCode redo |
| tests red after owner re-run | HITL: OpenCode fix vs stop | OpenCode fix slice |

Max agy attempts per batch/slice unit: **2**, then human.

## 10. Pre-flight snapshot (both agy modes)

Before agy starts writing:

1. Record `git status --porcelain` and optional `git stash create` / ref tip.  
2. On catastrophic escape: restore policy = refuse commit + surface dirty paths; automated hard-reset only if user pre-authorized (default: **no** hard reset).

## 11. Config sketch (`workers.yaml`)

```yaml
policy:
  # Apply is always HITL when agy is offered — no silent apply worker.
  apply_worker_prompt: always   # always (v0 locked)
  apply_modes_enabled:
    - opencode
    - agy-full
    - agy-hybrid
  apply_commits: opencode-only  # v0
  apply_slice:
    max_files: 3
    max_lines_high: 150
    forbid_worker_commits: true
    revalidate_tests_on_opencode: true
  apply_full:
    require_path_scope: true
    revalidate_tests_on_opencode: true
    forbid_worker_commits: true   # v0
```

## 12. Explicit non-goals (v0)

- Answering apply worker choice without the human  
- Parallel writers on one worktree  
- agy push / PR / review lifecycle ownership  
- Dropping OpenCode test re-validation  
- Removing OpenCode apply path  

## 13. Implementation plan (later)

1. Schemas: `apply-batch-result`, `implement-slice-result`  
2. Runner: `--role apply-batch` | `implement-slice` + schema + stream-json optional  
3. Prompt templates: full-batch vs slice (forbid commit, honor allowlist, single scope)  
4. Orchestrator: HITL question + reco rubric at apply entry  
5. Gatekeeper shared module: allowlist diff, tests, progress reconcile  
6. Default install: modes enabled, commits opencode-only  
7. Pilot: one small feature **agy full**, one **hybrid**; compare to OpenCode  

## 14. Success metrics (pilot)

- 100% agy apply runs preceded by recorded human choice  
- 0 allowlist escapes reaching commit  
- Owner test gate: worker green ∩ owner red &lt; 10%  
- Human override rate of reco tracked (inform calibration)  
- No dual-writer incidents  

## 15. Decision summary

| Choice | v0 |
|--------|----|
| HITL ask | **Always** for non-OpenCode apply |
| agy full apply | **Allowed** |
| agy hybrid | **Allowed** |
| OpenCode apply | **Always available**; default reco when unsure |
| Worker commits | **OpenCode only** |
| Silent auto agy apply | **Forbidden** |
| Allowlist (agy full) | Tasks-cited union; else HITL paste / OpenCode / hybrid |
| Broad globs only | Human-pasted confirmation required |
| Choice reuse | Until work-unit/PR boundary, failure, or user override |
| Session restart | Show prior choice once; confirm (no silent Engram restore) |
| Reco language | User/persona language; technical artifacts English |

## 16. Closed decisions (was open questions)

### 16.1 Allowlist source for agy full — **tasks-cited union + escalation**

Order of resolution (stop at first success):

1. **Union of paths** explicitly cited in the scoped task texts (backticks, markdown path links, clear repo-relative paths).  
2. If the tasks artifact has a **Declared paths** / work-unit path table, use that union.  
3. If still empty → **do not start agy full**. HITL follow-up with exactly one of:  
   - switch to **OpenCode**, or  
   - human pastes / confirms an allowlist (multi-line paths), or  
   - switch to **hybrid** only for tasks that already cite paths.

**Forbidden in v0:** broad globs as sole scope (`src/**`, `**/*`) without human-pasted confirmation of that glob in the follow-up ask.

After the run, OpenCode gate uses the **same frozen allowlist** from ask time (immutable for that batch).

### 16.2 Continuation batches — **reuse until boundary**

Record on the apply batch:

```text
session.apply_worker_choice = opencode | agy-full | agy-hybrid
session.apply_worker_scope_id = <work-unit or PR-slice id or "batch-1">
session.apply_allowlist = [...]
```

**Reuse** the choice for subsequent `sdd-apply` launches in the same session while **all** hold:

- same `change` name  
- same `apply_worker_scope_id` (work-unit / chained-PR slice)  
- no agy exhausted / hard failure that cleared the choice  
- user has not said “change apply worker” / “use OpenCode” / “use agy…”

**Re-ask** when any:

- new work-unit or chained-PR slice boundary  
- apply after verify-fail remediation with expanded scope  
- prior agy batch failed gatekeeper (allowlist escape or owner tests red) and human must re-choose  
- session restart (no silent restore from Engram without showing the prior choice and confirming once)

### 16.3 agy commits — **out of v0; explicit later flag**

v0: **`apply_commits: opencode-only`** always (agy reports `commits_made: false` or gate fails).

Later (v1.x+), only if **all** hold:

- human enables a separate preflight/config flag e.g. `apply_commits: agy-allowed`  
- HITL confirms again at apply ask (“agy may create work-unit commits”)  
- conventional commits only, no push/PR  
- OpenCode still runs test gate **before** accepting SHAs into delivery  

Until that ships, any agy commit is a **policy fail**.

### 16.4 Recommendation language — **user conversation language**

Reco + question labels follow the active persona / user language (orchestrator UI).  
Schemas, prompts to agy, path strings, and commit messages stay **English** per Language Domain Contract unless the repo already uses another language for commits.

---

*End of revised RFC draft. Open questions closed. No runtime behavior change until implementation is explicitly approved.*
