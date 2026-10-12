{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### foreman

The Foreman pattern decomposes a coding goal into a footprint-annotated,
scheduled subtask plan, then (in a later surface) farms the plan out to external
coding CLIs in isolated git worktrees and verifies the integrated result. The
soundness boundary is the merge-verify gate; the footprint scheduler is advisory.
See `docs/proposals/verified-parallel-coding-orchestrator.md`.

#### `foreman.plan`
- **Params**: `{ goal: string, repo?: string, max_attempts?: number }`
  - `goal` is the natural-language coding objective to decompose.
  - `repo` is the repository root to plan against (used to ground symbol
    footprints). Defaults to the daemon's working directory.
  - `max_attempts` bounds the parse/conflict repair loop (default `3`). The
    planner regenerates on unparseable output, duplicate subtask ids, missing
    footprints, or two subtasks declaring the same write.
- **Returns**: `ForemanPlanReport { schema_version, valid, prefer_single_session, attempts, issues: [string], levels: [[string]], subtasks: [{ id, prompt, files: [string], writes: [{file, symbol}], reads: [{file, symbol}] }] }`.
  - `levels` and `prefer_single_session` are a **scheduling hint**, not a safety
    verdict — execution is still gated per-subtask and at the integrated union.
  - `subtasks[].writes`/`reads` carry only the **declared** footprint, never the
    scheduler's expanded blast radius.
  - `prefer_single_session` is `true` when farming out buys no parallel speedup
    (≤1 subtask, or every level is a single subtask).
- **Cost note**: runs one or more inference calls (the repair loop) against the
  daemon's configured model.
- **FFI**: `foremanPlan(goal, repo?, maxAttempts?)` (Node) / `foreman_plan(goal, repo=None, max_attempts=None)` (Python).

#### `foreman.run`
- **Params**: `{ goal: string, repo?: string, adapter?: string, verify_command?: [string], union_verify_command?: [string], max_attempts?: number, distributed?: boolean, workers?: [string] }`
  - `adapter` selects the external coding CLI (`"claude-code"` default; `"codex"` / `"gemini"` as their adapters land). `"mini-swe-agent"` is not a Foreman adapter — it is the `coder-ab` measurement baseline and is excluded from unnamed engine resolution.
  - `distributed` (default `false`) spreads the subtasks across the **fleet**: every CAR instance that has this repository checked out and is enrolled as a worker (`fleet.worker.set`). This host is always in the pool, so a distributed run whose peers all decline still completes locally. `workers` narrows placement to named instances — the names `fleet.composite` reports.
  - Distribution moves **where the editing happens and nothing else**. A peer reproduces the base commit in its own worktree, runs its own coding CLI, and returns a patch; this host applies it and runs the unchanged merge-verify gate. A peer that fails or declines hands the subtask to the next worker, and the worktree is reset to its base commit first so nobody inherits a half-finished attempt. See `docs/proposals/verified-parallel-coding-orchestrator.md` and the `fleet` namespace below.
  - A decline names one of `not_accepting_work`, `repo_unavailable`, `commit_unavailable`, `adapter_unavailable`, `busy`, `rate_limited`, `policy_denied`. Only `busy` is re-offered to the same peer (once, after 2s): it clears in seconds, whereas a spent budget clears in tens of minutes and the rest are facts about that machine's configuration that a retry would hit identically.
  - `verify_command` is the **per-worktree regression** check — "does this one subtask's change compile / not break existing tests?" (e.g. `["cargo", "check"]`). A subtask implements only PART of the goal, so a goal-level test that needs every subtask must NOT run here, or it rejects each subtask.
  - `union_verify_command` is the **integrated-union goal** check — "does the merged result achieve the goal?" (e.g. `["cargo", "test"]`). **Falls back to `verify_command` when omitted**, so callers wanting one command for both set only `verify_command`. Omit both and the gate is `Inconclusive` (never accepts) unless a subtask is explicitly waived.
  - Each subtask is governed by the operator's silence window (`no_progress` while streaming without worktree changes; `stalled` without output or worktree changes), with no per-subtask time budget.
  - other params as for `foreman.plan`.
- **Returns**: `{ plan: ForemanPlanReport, mode: "parallel"|"single_session"|"regional_replan"|"parallel_then_single_session", ran: true, delivered: boolean, run: ForemanReport }`.
  - The pipeline **always runs**: when the plan decomposes it farms the subtasks out and verifies the integrated union (`mode: "parallel"`); when it does NOT decompose — the plan is invalid, or the planner found no parallelism worth it (coupled work) — it **falls back to a single whole-goal session** (`mode: "single_session"`). And if the plan *did* decompose but the integrated union was rejected, recovery (opt-in) prefers a **regional replan** when `run.integration.blame` localizes the failure to a proper subset of the accepted subtasks: it resumes from the clean (non-implicated) patches and completes the goal in one session, redoing only the failing region while preserving the successful parallel work (`mode: "regional_replan"`). When the failure can't be localized (it implicates everything, e.g. a build failure naming no known file) or the regional attempt doesn't deliver, it **re-runs the whole goal as one session** (`mode: "parallel_then_single_session"`). The failed parallel attempt is retained in `run.integration` either way. It never just gives up, so `ran` is always `true`.
  - `delivered` is `true` when the result is sound: the integrated union was accepted (parallel) or the single session was accepted (fallback).
  - `run` is the execution report: `{ schema_version, subtasks: [{ id, verdict?, error? }], integration?: { applied, apply_conflicts, integrated_cleanly, verdict?, blame? } }` (one subtask, no `integration`, in single-session mode). Each `verdict` is `{ outcome: "accepted"|"rejected"|"inconclusive", ... }` with structured `evidence` (containment violations, semantic conflicts, typed `build_test`, policy). Use `outcome == "accepted"` as the only accepting state (forward-compat `"unknown"` is non-accepting).
  - `integration.blame` is present **only when the union did not integrate cleanly** — structured attribution of *why*, for a UI ("why did this run fail") or a future regional replan: `{ apply_conflicts: [{ subtask_id, files, detail }], duplicate_conflicts: [{ file, symbol, candidate_subtask_ids }], build_test?: { code?, output_tail, candidate_subtask_ids } }`. `apply_conflicts.subtask_id` is the patch that failed to apply (definitive) plus the files involved; `duplicate_conflicts.candidate_subtask_ids` are the subtasks whose patches touched the offending file (candidates, not proven culprits — attribution is file-granular); `build_test` is the union goal-check failure with `candidate_subtask_ids` = the whole integrated set (a build failure isn't localized further — mapping a failing test back to a symbol is not done here — so the retry region is all of them).
  - `pool` (distributed runs only) says what the pool contained and what it left out: `{ remote_workers: [string], excluded: [{ instance, reason }], quarantined: [string], local_only: boolean, degraded_reason?: string }`. `reason` is one of `not_enrolled`, `repository_not_served`, `not_requested`, `unreachable`, `no_address`. **`local_only: true` is the quiet failure this exists to surface**: every peer turned out ineligible, so a run asked to be distributed completed correctly on one machine at local speed, which is otherwise indistinguishable from a distributed run that happened to be slow. `degraded_reason` is a single line naming the counts. `quarantined` is the mid-run counterpart to `excluded` (car#1323): instances that were in the pool and were then dropped for the remainder of the run because a failure was a fact about the machine — unreachable, not enrolled, missing the repo or the base commit, no usable coding CLI, or rate-limited — rather than about the subtask offered. Without it, a peer that dies mid-run is invisible: it stops appearing in `placements` and the run just gets slower. **Every other key in this object describes the pool as it was BUILT**, before any subtask ran, so `local_only` and `degraded_reason` cannot see a quarantine; a reader asking whether a run ended up local subtracts `quarantined` from `remote_workers`. A peer that recovers stays out until the next run — there is no mid-run liveness re-probe, and by the time one would fire the cost this avoids has already been paid.
  - `run_id` correlates this run's subtasks in every participating host's audit log. `distributed` echoes the mode. On a distributed run, `workers` lists the pool and `placements` records where each subtask ran: `[{ subtask_id, worker, remote, failed_attempts: [{ worker, error }] }]` — `worker` is `null` when every worker failed, and `failed_attempts` is how a green run still shows which machine dropped a subtask first. Both are `null` on a local run, where the answer is always "here".
- **Cost note**: farms each subtask to a real external CLI — **burns subscription/API quota** and can run for minutes. Hosts should rate-limit. A distributed run spends **other machines' quota** as well as this one's.
- **FFI**: `foremanRun(goal, repo?, adapter?, verifyCommand?, unionVerifyCommand?, maxAttempts?, distributed?, workers?)` (Node) / `foreman_run(goal, repo=None, adapter=None, verify_command=None, union_verify_command=None, max_attempts=None, distributed=None, workers=None)` (Python).


{% endraw %}
