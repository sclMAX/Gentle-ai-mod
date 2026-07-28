### Review Workload Forecast Rules

Before finalizing tasks, estimate whether implementation is likely to exceed the **400 changed-line review budget** (`additions + deletions`). This is a planning guard, not an exact diff count.

**Honesty first:** prefer a slight **over-estimate** over an optimistic under-estimate. Protect reviewers. Never invent a single false-precise number when a range is more honest.

#### Estimate method (required rubric)

Build a range from concrete signals in proposal/spec/design/tasks:

1. Count planned **production** files × typical lines per touch:
   - new file: **40–120** lines each
   - edit existing: **15–60** lines each
2. Add **test** files × **30–100** lines each
3. Add **wiring/config** touches × **10–40** lines each
4. **Docs-only** work is usually **Low** risk (still list files)
5. **Generated / lockfiles / vendor**: exclude from the 400-line budget, but note them separately and set `Generated/vendor lines excluded from budget?` accordingly
6. **Cross-cutting** changes (auth, API+UI, migrations, multi-package): bump risk **one tier** after computing the range

Sum into a **range**, not a point: `Estimated changed lines: low-high` (example: `180-320`).

#### Table fields (required)

| Field | Value |
|-------|-------|
| Estimated changed lines | low-high range (e.g. 180-320) |
| Estimate method | short note of signals used (file counts, new vs edit, tests, wiring) |
| Confidence | Low / Medium / High |
| Files touched (approx) | N production + M test + K config/docs |
| Test lines share | approx % or lines of the range |
| Generated/vendor lines excluded from budget? | Yes/No + brief note |
| 400-line budget risk | Low / Medium / High |
| Chained PRs recommended | Yes / No |
| Suggested split | single PR or PR 1 → PR 2 → … |
| Delivery strategy | ask-on-risk / auto-chain / single-pr / exception-ok |
| Chain strategy | stacked-to-main / feature-branch-chain / size-exception / pending |

#### Risk tiers (use high end of range)

- **Low**: high end of range ≤ **250**
- **Medium**: high end **251–400**
- **High**: high end **>400** OR **≥3 independent work units**

Cross-cutting bump applies after the numeric tier (Low→Medium, Medium→High).

If the estimate is **High** or high end > 400:

1. Mark `Chained PRs recommended` as `Yes`.
2. Split tasks into **work units** that can become chained or stacked PRs.
3. Each suggested PR must have a clear start, clear finish, verification, autonomous scope, focused test command, runtime harness, and rollback boundary.
4. **Ask the user which chain strategy to use** (this is a team decision):
   - **Stacked PRs to main** — each PR merges to main in order. Fast iteration, fix on the go. Best for speed-first teams and independent slices.
   - **Feature Branch Chain** — the feature/tracker branch accumulates the final integration; PR #1 targets the tracker branch, later PRs target the immediate previous PR branch so each child diff stays focused. Only the tracker merges to main. Best for rollback control and coordinated releases.
   - **size:exception** — keep it as a single PR with maintainer approval. Best for generated code, migrations, or vendor diffs.
5. Cache the user's choice and set `Decision needed before apply` from delivery strategy:
   - `ask-on-risk`: `Yes` — orchestrator asks before apply.
   - `auto-chain`: `No` — orchestrator proceeds with the first slice using the chosen chain strategy.
   - `single-pr`: `Yes` — orchestrator must require `size:exception` before apply.
   - `exception-ok`: `No` — maintainer has accepted `size:exception`.

Do not bury this in prose. Put the forecast near the top of the tasks artifact so the user sees it before implementation starts.

The forecast MUST include these exact plain-text lines so downstream guards can match them literally:

```text
Decision needed before apply: Yes|No
Chained PRs recommended: Yes|No
Chain strategy: stacked-to-main|feature-branch-chain|size-exception|pending
400-line budget risk: Low|Medium|High
```

You may keep the table for readability, but the plain-text lines are the guard contract.

Also emit the range line near the table (not a guard contract, but required for honesty):

```text
Estimated changed lines: <low>-<high>
```

Keep the **Suggested Work Units** table whenever chaining is recommended (and prefer it whenever Medium/High).

For `feature-branch-chain`, suggested work units SHOULD name the intended base boundary: PR #1 base = feature/tracker branch; PR #2 base = PR #1 branch; PR #3 base = PR #2 branch. If a child PR would show previous PR changes, the base is wrong and must be retargeted/rebased before review.
