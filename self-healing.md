{% raw %}
# Self-healing

`heal` is CAR's self-repair feature. It finds defects in CAR's own runtime,
repairs them with a coder session, has an independent review panel judge the
fix, merges an approved fix through the merge queue, and then confirms that the
failure stopped. It is on by default and needs no configuration.

Heal is held back: it is built and shipped, but not marketed until it confirms
its first healed detection (owner decision, 2026-11-19).

## What a tick does

The daemon runs one heal tick every 900 seconds (`CAR_HEAL_INTERVAL_SECS`
changes the cadence), and `car heal run` runs one immediately. A tick that
finds another tick still running stands down instead of queueing. Each tick:

1. reads `[heal]` from `<CAR_HOME>/config.toml` (`<CAR_HOME>` defaults to
   `~/.car`). No section means the defaults: on, with a 5 USD daily budget;
2. runs the deterministic detectors over the evidence CAR already owns
   (below);
3. checks the precondition chain and records the first failure as the one
   reason heal is blocked;
4. moves work already in flight forward: a queued pull request that merged, a
   merge waiting for a daemon build that contains it, and a build that has run
   long enough to call a defect healed or has seen it come back;
5. starts at most one repair round, on the oldest active, undismissed
   detection of a repairable kind;
6. sweeps any issues a person handed in through `[[heal.target]]` or
   `[[heal.org]]`. Those get a pull request only.

Every model call a tick makes is charged to the `car:heal` spend meter.

## Status: one state, one reason

`car heal status` (and `heal.status` over JSON-RPC) reports one `state` and
exactly one `reason`. The states are `off`, `blocked`, `idle`, `working`,
`awaiting_merge`, `verifying` and `escalated`.

Every tick evaluates this chain in order. The first link that fails is the
reason:

1. **Off.** `[heal] enabled = false`. The state is `off`, and the tick does
   nothing else: no detection, no notifications, no repair. Turning heal off
   turns detection off too, deliberately: there is one switch, and the
   reason says so (`heal is off: ... Detection is off too`).
2. **No source checkout.** Heal repairs CAR from a Git checkout whose `origin`
   is `github.com/Parslee-ai/car`. It considers `[heal] source_checkout` first,
   then the ancestors of the running binary, the `.car` project, the
   repositories the daemon's coder knows, and the checkouts under any
   `[[heal.org]]` roots. It prefers a main checkout to a linked worktree. The
   reason names every place it looked and why each was refused. A fork whose
   origin is `github.com/<owner>/car` does not qualify. Detection still runs
   when no checkout qualifies; nothing is repaired. A daemon on its own state
   root (any `CAR_HOME` other than `~/.car`, such as an isolated verification
   daemon) discovers no checkout at all: it heals one only when
   `[heal] source_checkout` names it, so it never works the operator's
   checkout by accident. *Test:*
   `heal::live::tests::only_the_default_state_root_discovers_the_operators_checkout`.
3. **Missing tools.** `git`, `cargo` or `gh` is not on `PATH`. `PATH` is the
   one the coder's shell and the contract checks run with: the daemon's own
   with the login shell's entries merged in
   (`coder::effective_check_path_for_checks`), so a daemon started by launchd
   sees the same tools as your terminal, and heal's tool check, its scripts,
   its `gh` calls, the coder's shell and the contract checks never disagree
   about what is installed. *Test:*
   `heal::live::tests::heal_resolves_its_tools_on_the_path_the_coder_shell_and_checks_use`;
   a live run (car#4981) found `gh` calls still on the daemon's own PATH.
4. **No OS secret sandbox.** Every repository script and every test heal
   runs goes under the OS secret sandbox, in both network postures. Where it
   cannot be applied, heal does nothing; on Windows, which has none, this is
   always the reason. *Test:*
   `heal::e2e::each_broken_precondition_blocks_with_exactly_its_own_reason`.
5. **Forge authentication.** `gh` is not signed in, or its credential does not
   work.
6. **Budget spent.** `car:heal` has been charged `[heal] daily_budget_usd` or
   more today. The reason says when the budget resets.
7. **No coder model.** No usable model can write code and call tools. The
   reason names each model and why it was excluded.
8. **No independent panel.** Fewer than two usable reviewers come from
   vendors other than the coder's.
9. **Fetch failing.** `git fetch` from the checkout's origin failed.

When the chain passes, the reason describes the current work, for example
`repairing <key> on car/heal/<key>-o1`, `pull request #123 is queued to merge
once every required check passes`, or `nothing to repair`.

Work already in flight (a queued merge, a build to wait for, a recurrence to
notice) moves forward once links 1 to 5 pass, even when the budget is spent or
no model fits, because it needs neither.

## Models and budget

Any capable model may do the work, local or remote. Local models count when
they fit the local-model allocation once idle resident models are evicted.
Remote models count only when CAR knows their price, because a daily budget
cannot bound a model it cannot price. An unpriced remote model is refused.

- **Coder.** The best measured model that writes code and calls tools. A coder
  whose vendor would leave fewer than two other vendors for the panel is passed
  over for the next one.
- **Panel.** The best reviewer from each vendor other than the coder's: at
  least two seats and at most three, every seat from a different vendor.

`[heal] daily_budget_usd` (default 5) is the daily cap on the `car:heal` meter.
`car spend` shows what heal has been charged.

## Redaction

Anything heal sends off the machine must pass through CAR's store-aware
redactor byte-unchanged. That covers a prompt to a remote model, the diff a
remote review panel reads, a pull request body and an escalation issue. When
the redactor would change the text that describes a defect (for example a
secret stored after the defect was detected), that defect is repaired by local
models only, for the coder, the panel and the coder session's independent
auditor (a local panel seat, since the `auto` auditor never picks a local
model). When no local coder and panel
fit, the round fails and the status reason says the evidence may not leave the
machine. A diff the redactor would change is never shown to a remote panel,
and never pushed: before every push heal checks exactly the diff delivery
stages. The pull request title and commit messages name the dedup keys, never
the detection's record. A pull request body the redactor would change (a
test's output, say) is not opened. An escalation issue whose detail the redactor would change is filed
with only the dedup key, and the detail stays on the machine. *Tests:*
`heal::e2e::an_unclean_detection_is_repaired_by_local_models_only`, the main end-to-end test (the title and every pushed commit message name the key only),
`heal::e2e::an_unclean_detection_with_no_local_models_is_held_with_its_reason`,
`heal::e2e::a_diff_carrying_a_secret_is_never_shown_to_a_remote_panel` and
`heal::e2e::a_pull_request_body_that_would_carry_a_secret_is_not_opened`.

## Repair, review and merge

A repair round runs one coder session against the runtime-authored outcome
contract for the detection, on branch `car/heal/<dedup-key>-o<occurrence>`
with base `main`. When the source checkout has a CAR worktree pool (`car
worktree status` there shows one), the session works in a slot heal leases for
the round and gives back as soon as the round fails or its pull request merges
or closes. Without a pool, the session works in its own worktree under
`<CAR_HOME>/heal/worktrees/`.

Heal works on `recurring_tool_failure`, `capability_miss` and `flaky_test`
detections. Only a recurring builtin tool failure has a runtime contract, the
replay contract; it is the contract's one local cargo invocation:

```text
cd car-rs && cargo run -q -p car-cli -- tools call <tool> --params-file <private-params-path>
```

The replay check needs exit 0 and the compact JSON success marker `"ok":true`.
A detection with no runnable contract is escalated, not repaired: heal does not
merge a fix judged against a contract a model wrote. That covers every
`capability_miss`, every `flaky_test`, and a recurring tool failure whose call
could not be recovered from the same journal, was not a builtin tool, was
`delegate_gui`, or carries a secret-shaped value. An escalation is visible in
two places: `heal.status` reports `escalated` with the issue number (when
nothing more urgent is in flight; the `work` list always shows it), and heal
files a redacted issue on the checkout's own repository, labelled
`needs-human` (or `[heal] human_label`; the label is created when the
repository lacks it) and assigned to `[heal] escalate_to`, or to the `gh`
login heal acts as. *Test:*
`heal::e2e::a_defect_with_no_runtime_contract_escalates_to_a_person_visibly`.

The fix is merged only when all of these hold:

- the work started from the detector, on `Parslee-ai/car`;
- the runtime authored the outcome contract, the session ended with that
  exact contract, and the fix passes it (a person's handed-in item never
  gets auto-merge: `coder::heal_e2e::a_tick_takes_an_issue_through_a_real_session_to_a_pull_request`);
- the review panel approves. The panel must have at least two seats, every
  seat from a different vendor, and no seat from a vendor that wrote the
  change. The authoring vendors are read from the session journal, not from
  configuration;
- every required CI check passes;
- no person has stopped the pull request (see "Stopping a heal pull request"
  below).

Heal opens the pull request and runs `gh pr merge <n> --auto
--match-head-commit <sha>`. The merge queue then waits for the required checks
and merges; heal passes no merge method because the queue owns it. On a
repository with no merge queue, `gh` refuses `--auto` without a method, so
heal arms plain auto-merge (`--squash`, still pinned to the reviewed head) only
when main requires status checks, and otherwise refuses (see rule 5). If
auto-merge cannot be armed, the pull request stays open and the status note
says a person must merge it.

### Stopping a heal pull request

`Parslee-ai/car`'s ruleset requires checks, not a review, so nothing on
GitHub's side keeps the merge queue from merging over a person's objection.
Heal provides that stop itself. Before every arm, and on every tick while one
of its pull requests is armed, it reads the pull request's labels and latest
reviews (`gh pr view --json labels,reviews`). Either of these is a stop:

- a `needs-human`, `do-not-merge` or `hold` label (any case);
- a request for changes that the reviewer has not since replaced with an approval or had dismissed. A later comment-only review does not lift it. A pull request's author
  cannot request changes on it, and heal opens its pull requests as the `gh`
  login, so the operator uses a label instead.

A stopped pull request is not armed. If it is already armed, heal takes it out
of the merge queue (`dequeuePullRequest`), turns auto-merge off and escalates
to a person. After that heal never re-arms it, even once the stop is lifted.
If heal cannot read the labels and reviews, it waits and arms nothing.
Closing the pull request still declines the fix outright.

Limits:

- Heal checks once per tick (15 minutes by default). A stop added after an
  entry starts its merge-group run can lose that race.
- Comments are not read as a stop. Use a label or a review.
- `[heal] enabled = false` stops new work, but it does not disarm a pull
  request already in the queue. Label it to stop it.

*Test:*
`heal::e2e::a_person_who_stops_a_heal_pull_request_is_never_overridden`.

Heal never pushes to `main` directly and never edits the operator's working
tree or index: its worktrees are pool slots it leases, or live under
`<CAR_HOME>/heal/worktrees/`.

## How a repair round behaves

These rules come from an issue burndown on 2026-11-19 (owner decision). Each
rule names the test that covers it, or why it has none. All tests named here
are in `car-server-core`.

1. **Related defects ship together.** Heal groups repairable defects by the
   crate their contract builds and replays through. A builtin tool failure
   groups by the crate that owns the tool. One coder session fixes up to five
   of them on one branch, which means one build, one panel review, one pull
   request and one merge-queue run. The pull request body lists every key it
   closes. Each member's own checks are named after its key, and a check two
   members share runs once. If a member's own checks fail, that member goes to
   a person on its own, and the others retry without counting a failed round
   and ship on the next tick. A failure that cannot be attributed to one
   member, such as a shared check or a panel rejection, counts against every
   member. *Tests:*
   `heal::e2e::two_defects_in_the_same_crate_are_fixed_in_one_pull_request`,
   `heal::e2e::one_member_failing_its_own_checks_escalates_alone_and_the_others_still_ship`
   and
   `heal::pipeline::tests::a_batch_runs_a_shared_check_once_and_names_each_members_own_checks`.
2. **The repository's cheap required checks run before anything is
   pushed.** After the panel approves, heal runs
   `scripts/ci-local.sh --preflight` in the fixed worktree. That script runs
   no build. If the change touches an RPC, wire, FFI or capability surface,
   heal first runs `build-capabilities.sh`, `build-daemon-wrappers.sh` and
   `build-wire-schema.sh`, in that order. A failing preflight is a failed
   round, and nothing is pushed. Which paths changed, and so whether to
   regenerate and which crates' tests run on CI, is read from the whole change
   since the round's start commit, never from `git status` or the index alone.
   Heal's coder session is headless, and the permission policy's
   non-interactive default denies `git commit` there, so today the change is
   the worktree against the start commit; reading from the start commit (and
   checking every commit message before a push) keeps that true if the policy
   ever changes. *Test:*
   `heal::e2e::a_headless_heal_coder_cannot_commit_and_only_heals_own_commit_is_pushed`. *Tests:* the main end-to-end test
   (`heal::e2e::a_detected_defect_is_fixed_reviewed_merged_and_confirmed_healed`)
   asserts that the preflight ran on the fixed worktree, without
   regeneration, before the push.
   `heal::pipeline::tests::only_an_rpc_wire_ffi_or_capability_change_regenerates`
   covers the regeneration trigger.
3. **Tests run on CI, not on this machine.** Locally, the contract runs one
   cargo invocation, the replay's `cargo run` (which builds the CLI it
   replays through), and only while the 1-minute load is at most three times
   the core count. After the push and before it arms auto-merge, heal runs
   the touched crates' tests on CI with the **round's base commit's** copy of
   `scripts/ci-scoped-test.sh` (the commit the session started from, or the
   main commit a refresh merged in; never a working tree's, and never a
   `origin/main` that moved since). Only the run's own conclusion, as the
   script prints it, decides: `failure` is a failed round (heal closes the pull
   request and deletes its branch, and auto-merge is never armed). A run that
   never happened (the script's exit 2, "no run appeared", a `gh` or GitHub
   error, a cancelled run) is a wait: the pull request stays open and unarmed,
   nothing fails, and the next tick runs CI again on the same pull request.
   When the tests cannot run at all (no such script, or no touched crate can
   be named), auto-merge is refused with that reason and a person merges. The
   run's result goes in the pull request body. The merge queue's required
   checks stay the final gate. *Tests:*
   `heal::e2e::the_touched_crates_tests_run_on_ci_before_auto_merge_and_a_failure_closes_the_pull_request`,
   `heal::e2e::a_ci_run_that_never_happened_waits_and_the_next_tick_resumes_the_same_pull_request`,
   `heal::e2e::without_scoped_ci_auto_merge_is_refused_with_its_reason`, the
   live `heal::live::tests::ci_tests_runs_mains_scoped_script_and_reports_pass_and_fail`
   (pass, fail, the base's copy, and three kinds of infrastructure failure),
   `heal::pipeline::tests::a_local_build_waits_while_the_load_is_above_three_per_core`,
   and `heal::templates::tests::recurring_template_contract_commands_are_registry_owned_and_exact`,
   which asserts one cargo invocation, no `cargo test`, and that `scripts` and
   `.github` are protected paths.
4. **Watch it fail.** The runtime evaluates its contract on unmodified main
   before the coder starts, and refuses a contract that already passes there.
   It evaluates the contract again after the fix, and the pull request body
   records both results, check by check. Every test the fix adds or changes
   is also run twice before the push: with the whole fix, where it must pass,
   and with the source half of the fix reverted, where it must compile and
   fail. The test half is the hunks in test files (under `tests/`, or named
   `tests.rs`, `*_test.rs`, `*_tests.rs`) and the hunks at or below a file's
   `#[cfg(test)]`; everything else is the source half. Both runs happen
   locally, in throwaway worktrees heal makes and removes, with `cargo test
   --offline` under the same secret sandbox as a contract check (a test's
   crate may carry the model's `build.rs`), after a `cargo fetch`, and only on
   a quiet machine: the load is asked again before every test, and a machine
   that stays busy is a wait, never a failed round. Nothing from the
   watch is pushed. A test that passes with the source reverted fails the
   round with "test does not catch the defect", and nothing is pushed. A test
   that does not compile with the source reverted is not shown failing: the
   body says so ("Not shown failing", "DOES NOT COMPILE"), and the runtime's
   contract, shown failing before the fix, is the evidence for it. *Tests:*
   `heal::e2e::a_fix_whose_new_test_passes_without_the_fix_is_not_pushed`,
   `heal::e2e::a_new_test_that_fails_without_the_fix_ships_with_both_runs_in_the_body`
   (which also asserts no `-watch-` ref reached origin),
   `heal::e2e::a_new_test_that_does_not_compile_without_the_fix_is_reported_as_not_shown`,
   `heal::live::tests::a_compile_error_is_not_a_test_failing`, the live
   `heal::live::tests::run_tests_runs_each_test_in_the_sandbox_and_tells_pass_from_fail`, the
   `heal::watch::tests`, and the main end-to-end test.
5. **Merge-queue reality.**
   - *Conflicts:* when siblings merge first and an approved pull request
     becomes `DIRTY`, heal first turns its auto-merge off (`gh pr merge
     --disable-auto`), so nothing can merge on a head no check has seen, then
     merges one main commit (read once, and the base for everything after)
     into the branch in a heal worktree. Wholly generated files that conflict
     are taken from main. A conflict in a hand-maintained stub (`index.d.ts`,
     the `.pyi` files) leaves the pull request open, auto-merge off, and goes
     to a person; a conflict in any other file fails the round. The generators
     then run when the merge brought in a generated surface (sandboxed, the
     base's copies), and the preflight runs. The refreshed change and every
     commit message it carries pass the redactor before the push. The push is
     recorded; then heal repeats the watch and the scoped CI run on the new
     head and re-arms auto-merge only after both pass. A check that could not
     run waits with auto-merge off and resumes at the re-arm next tick,
     without pushing again. The panel's review stands, because heal's own
     change is unchanged by the merge. A fetch or push that fails is a wait.
     This is not a failed round. The refresh's pool slot, and its local
     `heal/refresh/<key>-o<n>` branch, go back when it ends. *Tests:*
     `heal::e2e::a_pull_request_main_overtook_is_refreshed_and_requeued_without_a_failed_round`
     (disable before the push, re-arm after the CI run, the branch removed),
     `heal::e2e::a_refresh_whose_recheck_could_not_run_stays_disarmed_and_resumes_at_the_rearm`,
     `heal::e2e::a_refresh_conflict_in_a_hand_maintained_stub_leaves_the_pull_request_open_for_a_person`,
     `heal::live::tests::a_conflict_in_a_hand_maintained_stub_goes_to_a_person`,
     the live
     `heal::live::tests::refresh_branch_merges_main_and_regenerates_only_when_the_merge_needs_it`
     (also: a refused push and an unreachable remote are waits), and the live
     `heal::live::tests::the_pool_is_leased_and_released_through_car_worktree_and_never_another_agents_slot`
     (a detached refresh slot's branch is still deleted).
   - *Drop-outs:* when the queue drops a pull request on failing checks, heal
     reads the failed tests of the merge-group run that dropped it, and of the
     other queue entries' failed merge-group runs within a day, through `gh
     run list --event merge_group` and `gh run view --log-failed`. A sibling
     counts only when its merge group does not contain heal's change (GitHub's
     compare of the two heads is `behind` or `diverged`), so a test heal broke
     is never called a flake. When every failed test is outside the change's
     diff and also failed on such a sibling, the drop-out is a flake: heal
     re-queues the pull request once, on the same head, and it is not a failed
     round. Each flaky test is recorded as its own item, a `flaky_test`
     detection keyed by the test's name; it has no runtime contract yet, so
     today it goes to a person. Any other drop-out, and a second one, is a
     failed round. *Tests:*
     `heal::e2e::a_queue_drop_out_caused_by_a_sibling_flake_requeues_without_a_failed_round_and_records_the_flake`,
     `heal::e2e::a_drop_out_on_a_test_the_diff_touched_is_a_failed_round_not_a_flake`,
     `heal::pipeline::tests::a_drop_out_is_a_flake_only_when_every_failure_also_failed_elsewhere_and_only_once`,
     `heal::live::tests::only_a_sibling_without_heals_commit_speaks_for_a_flake`
     and `heal::live::tests::failed_tests_are_read_from_a_cargo_log`.
   - *After delivery:* the moment a pull request opens, heal records it,
     before the CI run and before arming, so a round stopped from there on
     resumes that pull request and never opens a second. Every failure of the
     change after that (a real drop-out, a red CI run, a refresh that fails
     its checks or conflicts in a source file) closes the pull request and
     deletes its branch, so it cannot sit open with auto-merge off; a close
     that does not go through is recorded and tried again every tick, and the
     next round never attaches to it. A retry works on a fresh branch,
     `car/heal/<key>-o<n>-r<round>`, because delivery never pushes to a branch
     whose pull request a close parked. A forge, `gh` or network error while
     reading the pull request is transient: heal waits and reads again next
     tick. A pull request **a person** closed without merging is declined:
     heal escalates the defect and opens no other pull request for it. Heal's
     own closes are recorded first and leave the waiting phase, so a close
     heal sees there is always a person's. *Tests:*
     `heal::e2e::a_failure_after_delivery_closes_the_pull_request_and_a_transient_error_waits`,
     `heal::e2e::a_failed_close_is_tried_again_and_the_failed_pull_request_is_never_attached`
     and
     `heal::e2e::a_pull_request_a_person_closed_is_declined_and_never_reopened_as_another`.
   - *Confirming auto-merge:* `autoMergeRequest` stays null under a merge
     queue, so heal reads the `mergeQueue` GraphQL query and reports what it
     shows. On a repository with no merge queue, heal arms plain auto-merge
     (`--squash`) only when main requires status checks (branch protection or
     a ruleset); otherwise it refuses, because plain auto-merge would merge
     before any check ran. There, `mergeQueue` is `null`, which reads as "no
     queue", not as an error, and the pull request's own checks decide: a red
     one fails its round instead of waiting on queue evidence that does not
     exist. *Tests:* the main end-to-end test asserts "confirmed in the merge
     queue"; `the_merge_queue_listing_is_read_by_number_not_by_substring`;
     `a_repository_without_a_merge_queue_reads_as_no_queue_not_as_an_error`;
     `heal::e2e::without_a_merge_queue_a_red_pull_request_fails_its_round`;
     and
     `heal_auto_merge_arms_the_queue_on_one_head_and_names_a_method_only_without_a_queue`.
6. **Waiting is bounded, and nothing waits silently.**
   - *Every process is bounded.* Every external process heal starts (git,
     `gh`, `car worktree`, a repository script, cargo) goes through one
     helper, `heal::proc::run`: asynchronous, waited on as its own child, in
     its own process group, and stopped with that group at a wall (5 minutes
     for local git, 10 for anything that crosses the network, 2 hours for a
     script or build). The synchronous forge client is reached only through a
     bounded adapter. Nothing else in `heal/` spawns, waits on or blocks on a
     process; a source-level test enforces it. It never polls by process
     name. *Tests:* `heal::proc::tests::nothing_else_in_heal_starts_a_process`,
     `heal::proc::tests::a_process_past_its_wall_is_stopped`,
     `heal::e2e::a_fetch_that_never_answers_is_stopped_and_the_tick_ends`
     (a server that accepts and never answers) and
     `heal::live::tests::run_capture_returns_only_after_its_own_child_has_exited`.
   - *Every non-terminal state has an age.* A change approved and not yet
     delivered, a pull request waiting on its CI run, queued to merge, waiting
     for a person, disarmed after a refresh, or merged and waiting for a
     daemon build: past 24 hours in that state, a person is told with an
     issue and the reason, once per state, and heal keeps working it. So is a
     delivery deferred three times in a row. A deferred delivery resumes from
     the approved change; the coder and the panel are not paid again. An
     infrastructure error never becomes the change's failure: each step says
     which it is, and a preflight the base commit itself fails is a wait.
     *Tests:*
     `heal::e2e::every_non_terminal_state_held_past_its_bound_goes_to_a_person_once`
     and
     `heal::e2e::a_waiting_delivery_resumes_without_paying_the_coder_again_and_three_go_to_a_person`.
7. **Duplicates and defects already fixed.** An open pull request already on
   any of the occurrence's branches (`car/heal/<key>-o<n>`, or a retry's
   `-r<round>`) is attached to, not duplicated, and heal does not arm
   auto-merge on a pull request it did not review. A defect counts as fixed
   by another route only when its own checks already pass on unmodified main
   (the session's baseline) **and** a commit on `origin/main` carries its
   `Heal-Key: <key>` trailer and is not a revert; a mere mention of the key
   is not enough. Heal writes that trailer on its own commits. Such a commit
   is verified like heal's own merge. A batch member whose own checks already
   pass on main without such a commit is dropped from the fix and recorded as
   `already_passing`: it is not closed by the pull request and is never
   counted healed; it is worked again only if the detector sees it again.
   *Tests:*
   `heal::e2e::an_open_pull_request_for_the_key_is_attached_to_and_no_new_one_is_opened`,
   `heal::e2e::a_round_cut_off_after_delivering_on_a_retry_branch_is_attached_not_duplicated`,
   `heal::e2e::a_defect_already_fixed_on_main_is_verified_not_coded_again`
   (also: a mention is not a fix),
   `heal::e2e::a_member_already_passing_on_main_is_dropped_from_the_fix_and_not_healed`,
   `heal::pipeline::tests::only_a_heal_key_trailer_on_a_non_revert_marks_a_defect_fixed`
   and `heal::pipeline::tests::a_member_is_already_passing_only_when_all_its_own_checks_passed_at_baseline`.
   Issues a person hands in keep the issue loop's own coverage rule. Their
   claims moved from the coder state directory to `<CAR_HOME>/heal/` and are
   copied there once (`heal::pipeline::tests::hand_in_claims_are_migrated_once_and_never_over_a_newer_file`).
8. **Machine budget.** One tick runs per state root: ticks never overlap in a
   process, and a lock (`<CAR_HOME>/heal/tick.lock`) makes a second daemon on
   the same state root stand down. The lock is per `CAR_HOME`, not host-wide;
   a daemon on another state root discovers no checkout unless one is named
   (precondition 2), so two state roots never heal the same checkout by
   default. The lock file holds the ticking process's pid and its kernel start
   time, written to a temporary file and hard-linked into place, so it appears
   whole or not at all; a lock whose process is gone, or whose pid now belongs
   to a process that started later, is taken over. A daemon that starts
   observe-only (another car-server owns the supervisor) never starts heal's
   cadence, and its `heal.status` says where heal runs. A daemon that does not
   own the spend meter is blocked with that reason instead of reporting 0
   spent. With a worktree pool, the session works in a leased slot (`car
   worktree acquire`, owner `car-heal/<slot-branch>`, held by the daemon's
   pid) only while it is actively coding or refreshing. Heal releases it as
   soon as the round is delivered (a pull request waiting on the merge queue
   or on a person holds no slot) or fails, and a refresh leases a slot of its
   own for its duration. It checks first that it still holds the lease (after a
   restart and a reclaim the slot may be another agent's) and only then
   discards what the round left. A round still marked working at the start
   of a tick was cut off (the daemon stopped, or the tick ended early); it is
   retried, not counted as a failed round, and its slot is released. Cut off
   three times in a row without a round reaching an outcome, the defect goes
   to a person with the reason "interrupted 3 times", so a crash loop does not
   retry forever. A full
   pool is a wait, not a failed round. The session only borrows the slot:
   nothing in the coder session removes it, after a daemon restart either.
   Without a pool, the session's own worktree under
   `<CAR_HOME>/heal/worktrees` is removed when the session ends. *Tests:*
   `heal::e2e::a_round_works_in_a_leased_pool_slot_and_a_finished_round_leaves_no_lease`,
   `heal::e2e::a_round_cut_off_mid_way_is_retried_and_its_slot_freed`,
   `heal::e2e::a_defect_interrupted_three_times_goes_to_a_person`, the live
   `heal::live::tests::the_pool_is_leased_and_released_through_car_worktree_and_never_another_agents_slot`
   (a stand-in `car` with the real CLI's output),
   `heal::e2e::heal_runs_once_per_host_and_never_without_its_spend_meter`
   (also: a reused pid is taken over), and
   `heal::live::tests::a_slot_is_touched_only_while_heal_holds_its_lease`.
9. **Nothing runs with the network on a tree with the model's code in it.**
   Every repository step (the preflight, the generators, `cargo test`) runs
   under the same secret sandbox as a contract check (the daemon's state,
   credential stores and keychain hidden; writes to CAR's state roots denied
   except the tree), with the contract checks' environment scrub
   (`CHECK_ENVIRONMENT_ALLOWLIST`: no provider key, no `GH_TOKEN`), a Cargo
   home of its own for that one call (seeded from the shared caches, never
   its credentials, and removed after), and the network denied. The only
   step with the network is `cargo fetch`, and it runs on a pristine
   checkout of the round's base commit, never on the fix. One type
   (`heal::live::OfflineSandbox`) is the only way to a sandbox for a tree with
   the model's code in it: it refuses a change that touches anything a step
   runs or configures (`.cargo/`, `rust-toolchain*`, `scripts/`, `.github/`,
   any `build.rs`, and the npm, dashboard and Python tests the preflight
   runs) or any `Cargo.toml` or `Cargo.lock`, fetches on the base, and can
   only run offline after that. A change to dependencies goes to a person.
   The preflight runs offline with `CAR_CI_LOCAL_OFFLINE=1`, which skips the
   one step that reads the network (cargo-deny's advisory fetch) with that
   reason. The base is the commit the round started from (or the main commit
   a refresh merged in), never a moving `origin/main`. Every request a remote
   model would be sent passes the outward redactor first (one wrapper around
   the coder's inference); one that would carry what it removes is refused
   and the defect goes to local models. `ci-scoped-test.sh`, which needs the
   operator's `gh` credential, runs from the base commit's copy only. A heal
   commit renders its contract with `$CAR_HOME` in place of the operator's
   state root path. Every seed field comes from the detection record
   restricted to `[A-Za-z0-9._:-]`. *Tests:*
   `heal::live::tests::a_change_to_what_a_step_runs_or_to_a_dependency_runs_nothing`,
   `heal::live::tests::a_rustc_wrapper_in_the_fix_tree_runs_nothing_with_network`,
   `heal::live::tests::a_repository_script_runs_without_the_daemons_secrets`,
   `heal::live::tests::each_call_gets_a_cargo_home_of_its_own`,
   `heal::live::tests::a_busy_machine_is_a_wait_and_is_checked_at_every_step`,
   `heal::e2e::replay_output_a_remote_coder_would_see_keeps_the_round_local`,
   `heal::e2e::main_landing_a_script_change_mid_round_does_not_refuse_the_round`,
   `coder::heal_runner::tests::a_public_commit_names_no_state_root_path` and
   `coder::provenance::tests::a_seed_carries_no_character_outside_the_token_charset`.
10. **Only the reviewed change is ever armed.** At approval heal records the
   reviewed change as a commit on the start commit, kept by a local ref, and
   delivers from that record in a tree of its own. Auto-merge is armed in one
   place, and only on a head that `origin/<branch>` still holds and whose
   change equals the reviewed change merged with main (`git merge-tree`)
   except in generated files. Anyone else's push to a heal branch is never
   armed or refreshed: auto-merge goes off, and a person decides. A pull
   request heal finds already open after a stop goes through the same path,
   so its CI run and arming resume; without a reviewed change on record,
   a person merges it. *Tests:*
   `heal::e2e::someone_elses_push_to_a_heal_branch_is_never_armed` (before
   arming and before a refresh) and the live refresh test (another's push is
   refused for a person).
11. **The lock on a filesystem without hard links.** The tick lock is taken
   by hard-linking; where that fails, heal is blocked with that reason, never
   taking the lock some weaker way. *Test:*
   `heal::pipeline::tests::a_filesystem_without_hard_links_refuses_the_lock_with_its_reason`.

## Healed, recurrence and escalation

A merged fix is not yet healed. After the merge, heal waits for the daemon to
run a build whose commit contains the merge commit (`git merge-base
--is-ancestor <merge_sha> <build_sha>`). From then on the defect is healed
when it has not come back for three live ticks and 24 hours.

If the defect comes back on a build that contains its fix, heal reopens it as
the next occurrence on branch `car/heal/<dedup-key>-o<n+1>` and counts a failed
round. A round also fails when the session does not pass its contract, the
panel does not approve, or the pull request cannot be opened. After three
failed rounds on one key, heal escalates it: it files an issue titled `heal
needs a person: <locator>` on `Parslee-ai/car`, and the state becomes
`escalated`.

## Issues a person hands in

`[[heal.target]]` and `[[heal.org]]` are optional. They name repositories whose
labelled issues a person wants heal to work. Those issues go through the
provenance-tier gate (an issue body is data, never the source of an outcome
contract) and get a pull request only; a person merges it.
`car heal run --item owner/repo#number` runs one such issue now.

## Configuration

Everything is optional. All keys live under `[heal]` in
`<CAR_HOME>/config.toml`:

```toml
[heal]
enabled = true                 # the one off switch
daily_budget_usd = 5           # daily cap on the car:heal meter
# source_checkout = "/absolute/path/to/Parslee-ai/car"
# notification_command = { program = "/absolute/path/notify-agent", args = [] }

# Optional: issues a person hands in. These get a pull request only.
# review_models = ["model-a", "model-b"]
# coder_model = "model-c"
# engine = "native"
# human_label = "needs-human"
# escalate_to = ["github-login"]
# notify = ["lattice-address"]
# [[heal.target]]
# repo = "owner/name"
# label = "heal"
# [[heal.org]]
# owner = "owner"
# roots = ["/absolute/path/to/checkouts"]
```

An unknown key under `[heal]` is ignored with a config warning. A malformed
`[heal]` section is reported and its keys are ignored, but heal stays on: only
an explicit `enabled = false` turns it off. `heal.status` lists every warning
in `config_warnings`.

Earlier releases configured this feature in other places. `<CAR_HOME>/heal.toml`
is no longer read, and a present file produces a config warning; move its
targets to `[[heal.target]]` / `[[heal.org]]`. The `[selfheal]` section is no
longer read either, and also produces a warning; its `auto_fix`,
`max_concurrent`, `max_per_day` and `max_rounds_per_key` keys have no
replacement (the daily budget and the three-failed-round escalation bound heal
instead), and `notification_command` moved to `[heal]`. The `[unattended]`
section was removed. `CAR_SELFHEAL_INTERVAL_SECS` was removed;
`CAR_HEAL_INTERVAL_SECS` sets the one cadence.

## State

Heal keeps its state under `<CAR_HOME>/heal/`. Every file is owner-private
(0600 on Unix):

| Path | Contents |
|---|---|
| `ledger.jsonl` | Append-only detections, dismissals and repair steps |
| `notifications.jsonl` | Give-up notification incidents and attempts |
| `issues/<dedup-key>.md` | The local issue document for each active detection |
| `issues/<dedup-key>.call.json` | The recovered call and eligibility for a recurring tool failure |
| `attempts/<dedup-key>/` | Each repair round's private contract inputs |
| `worktrees/` | Repair worktrees |

On first start, a daemon from this release copies the older detector's ledger
and notification journal into `<CAR_HOME>/heal/` once, when heal's ledger does
not exist yet; the old directory is not read again.

## Commands

The CLI is a thin client over the daemon's `heal.*` methods, so a running
`car-server` (or CAR Host) is required.

```bash
car heal status
car heal run [--item owner/repo#number]
car heal list [--kind <kind>] [--severity <severity>] [--since <RFC 3339>]
car heal show <dedup-key>
car heal dismiss <dedup-key>
```

- `status` prints the state, the one reason, the cadence, the budget, the
  checkout, the picked coder and panel, and the work on each key.
- `run` runs one tick now. With `--item`, it runs that one handed-in issue
  instead.
- `list` prints active detections with their route and, for a recurring tool
  failure, its eligibility and recovered call.
- `show` prints one detection's local issue document.
- `dismiss` stops heal from listing or repairing a key without deleting its
  history.

`car info --json` carries the same summary under `heal`, or
`heal_unavailable_reason` when the daemon cannot answer. The JSON-RPC methods
are `heal.status`, `heal.run`, `heal.detections` and `heal.dismiss`
([protocol reference](websocket-protocol/heal.md)).

## Deterministic detectors

The daemon runs seven pure detectors over its own evidence every tick:
`metrics_alerts.v1`, `agent_gave_up.v1`, `agent_log_errors.v1`,
`agent_protocol_skew.v1`, `recurring_tool_failure.v1`, `capability_miss.v1`,
and `scheduler.v1`. An eighth, `flaky_test.v1`, runs when the merge queue drops
a heal pull request (see "How a repair round behaves"): one `flaky_test`
detection per test name. There is no model in the detection path.

`scheduler.v1` watches the scheduled-task health check `car doctor` prints, on
every tick: one `scheduled_task_problem` detection per task and problem
(`failing`, `overdue`, `orphaned`, `not_recorded`, `no_backend`,
`dream_detached`, `unreadable`). A task whose last three or more finished runs
all failed is `failing` and critical (a task that runs on time and fails is not
overdue); the rest are warnings. A dream loop detached from the user's memory
records every pass failed by design (car#3495), so it is reported as
`dream_detached` only, never also as `failing`. When a later tick no longer
finds the problem, the detection is recorded resolved, and if it comes back it
is a new `occurrence` under the same key, reported again even if the last one
was dismissed. A tick that cannot read the task store records nothing for the
scheduler, so a read error never looks like a recovery (car#4414).

`agent_protocol_skew.v1` reads the handshake the daemon recorded for each
supervised agent: a refused handshake (the agent's client shares no
wire-protocol version with the daemon) is critical, and an agent that connected
on an older protocol version or a different package build is a warning
(car-releases#104).

`agent_log_errors.v1` closes two supervisor blind spots:

- **Healthy-but-erroring:** the process remains `running`, but its bounded
  activity-log tail repeats the same genuine error signature. A line is an error
  only when it carries an `ERROR`, `FATAL`, or `CRITICAL` level token or is a
  traceback header. INFO/WARN/unlevelled lines remain routine even when they say
  "failed". Signatures normalize timestamps, UUIDs, long hex ids, numbers, and
  whitespace before counting.
- **Silently idle:** the process remains `running`, but its newest write to
  either stdout or stderr is older than the configured threshold. Both streams
  count: Python's `logging` and `car do --serve` write only to stderr.
  Deduplication uses only the monotone `hour` / `day` / `week` / `month` age
  bucket, never a raw minute count or tick time. A measured zero bytes on both
  stdout and stderr is listed by the supervisor but produces no detection
  because no activity was observed.

The detector core (the `car-selfheal` crate) reads none of this itself. The
daemon supplies bounded tails, stream sizes, and activity metadata explicitly
on each supervisor snapshot.

Detection is ledger-first. A detection is appended to `ledger.jsonl` when it is
first seen and again only when something other than its observation timestamps
changes, so an unchanged signal adds no row however long it stays active;
`heal.detections` still reports its `last_observed_at` as the latest tick that
saw it. A metric alert's evidence is its message, which carries the measured
value, so a cost or error-rate alert whose value moves between ticks is a
changed signal and is appended each time it moves. Dismissals and repair steps
are append-only records too; history is not deleted.

Agent-health, metric and scheduler kinds are detected and reported but not
repaired: they describe other programs, spend or load, which a change to CAR's
source cannot fix.

## Reconstructed calls

For each active `recurring_tool_failure`, the daemon matches the detection's
failure provenance to an `ActionFailed`, then joins that event's `proposal_id`
and `action_id` to `ProposalReceived.data.proposal` in the same journal. This
recovers the accepted tool name and exact parameter object without putting raw
parameters on outcome events.

The recovered params are serialized as JSON and passed through
`car_selfheal::Redactor`. The detection's `eligible` field is true only when
the failed event says `tool_source: "builtin"`, the tool is not the
side-effecting `delegate_gui`, the call was recovered, and redaction changed no
bytes. A secret-shaped value makes the key ineligible and `reconstructed_call`
is omitted, so the ledger and derived files never gain another raw-secret copy.
Safe recovered calls are exposed as `{ tool, params }` and written to the
`issues/<dedup-key>.call.json` sidecar, whose path `heal.detections` returns as
`reconstructed_call_path`. Other detector kinds omit all three
reconstructed-call fields.

## Consuming local issues

Each active detection on a machine with a valid source checkout gets one
owner-private local issue document, `<CAR_HOME>/heal/issues/<dedup-key>.md`.
Recurrence updates the same document. The document is evidence: it is never
committed or uploaded. Heal acts on detections itself, so a consumer is
optional; one that wants to track detections in its own backlog can read these
documents or poll `heal.detections`.

The labels and section headings below are exact and case-sensitive; text in
angle brackets represents the rendered value. A change to these names or their
meaning is a consumer-contract change and must update this document in the same
release.

```text
# CAR self-heal detection: <locator>

Trust-Tier: trusted
Dedup-Key: <SHA-256 dedup key>
Detector-ID: <detector id>
Severity: <severity>
Route: local
Repair-Eligible: <true, false, or not-applicable>
Repair-Ineligible-Reason: <reason, or (none)>
Occurrence-Count: <count>
First-Observed: <RFC 3339 timestamp>
Last-Observed: <RFC 3339 timestamp>

## Provenance

- CAR-Version: <version>
- Platform: <operating system>/<architecture>
- Event-IDs: <comma-separated values or (none)>
- Run-IDs: <comma-separated values or (none)>
- Evidence-Paths: <comma-separated values or (none)>

## REDACTED Evidence Excerpt

- <redacted excerpt, or (none)>

## Repro Hints

- Re-run `heal.run` and correlate the detector identity and provenance above.
- Inspect the named local CAR evidence source; do not send it off-machine.
```

A consumer should key on `Dedup-Key`, follow `next_offset` when paging
`heal.detections`, and remember processed keys: `car heal dismiss <key>` (or
`heal.dismiss` with `{ "dedup_key": "<key>" }`) suppresses a key from active
results and later ticks but deletes neither its ledger history nor its
document.

## Relationship to car-tank

The external `car-tank` agent's daemon-adjacent signal sources are covered by
CAR's in-daemon deterministic detection. Its repository-side sources (open
issues, CI, parity checks, and benchmark artifacts) remain the responsibility of
whoever runs the repository backlog. Tank's LLM judge is not part of this path:
its calibration record at `../car-tank/docs/calibration-probe-2026-08-11.md`
reports a failed probe, and CAR's design requires deterministic detection.
Stopping the external Tank process is an operator decision (`car stop
car-tank`); CAR does not change its configuration or stop it.

## Notify an operator when a supervised agent gives up

Add this optional setting to `<CAR_HOME>/config.toml` and restart the daemon:

```toml
[heal]
notification_command = { program = "/absolute/path/notify-agent", args = [] }
```

Leaving `notification_command` unset is always correct: notifications are
optional, and with no setting, no notification process starts. A malformed
setting is reported and refuses delivery while detection continues. The setting
permits only a program and arguments; it has no credential or environment
field. The sender owns its credentials independently of CAR. Notifications are
sent from the heal tick, so `[heal] enabled = false` stops them too.

Notification warnings go to the daemon's stderr, subject to its `RUST_LOG`
filter. For a foreground daemon, read that terminal; for a service, read its
stderr capture. When macOS CarHost launches the daemon, it also saves stderr to
`<CAR_HOME>/logs/car-server.stderr.log` (with one rotated `.1` file).

When an agent gives up, the next tick sends one JSON object on stdin, then
closes stdin (EOF). Its only `kind` is `agent_gave_up` and its only `severity`
is `critical`:

```json
{
  "agent_id": "nightly-agent",
  "kind": "agent_gave_up",
  "severity": "critical",
  "first_observed_at": "2026-11-03T12:00:00Z",
  "last_observed_at": "2026-11-03T12:00:00Z",
  "car_version": "0.60.0",
  "exit_code": 17,
  "restart_count": 2
}
```

Exit code may be null when unavailable. Evidence text has been removed: no
stderr, stdout or other agent-written text is sent, regardless of secret length
or shape. Only allowlisted structured facts are sent, including when reading a
legacy pending incident. CAR does not need to read `<CAR_HOME>/env` or resolve
a credential for this payload. The command starts with a cleared environment
and minimal platform baseline.

A 30-second limit bounds a command that has not exited. The direct child's exit
code 0 marks delivery successful, even if a descendant holds stdout/stderr
open. After exit CAR allows a brief final drain, closes the pipes and cleans up
remaining owned descendants. It drains concurrently while retaining at most
16 KiB per stream. All sends in one tick share a 60-second total budget. A
sender still has its own 30-second limit, shortened when less tick budget
remains. CAR rotates the next starting agent after the last attempted sender,
so deferred agents get a fair turn on the next tick. Skipped sends are recorded
as `tick_budget_deferred` with `sent: false`; no sender was started for those
rows. The tick then continues with repair. The sender should exit 0 only after
its destination accepts the event.

Notification state is in `<CAR_HOME>/heal/notifications.jsonl`, separate from
`ledger.jsonl`. Observation, recovery, retirement and attempt rows are private.
Attempts include only the sender's own output tail (at most 4096 bytes), exit
result and failure class. Each failure class adds at most one attempt row per
incident, even if exit codes alternate or the sender prints a different tail
each time. A new incident always records its first failure; every failed
attempt still logs a warning. Failed deliveries retry on later ticks. An unsent
give-up survives a restart only if `notifications.jsonl` can be written. With a
writable journal, retries continue after restart even when the original agent
is stopped and `auto_start` is false. If that path is unusable (a directory, a
symlink, or a read-only file), the daemon warns and keeps ticking, but it
cannot remember across a restart what it failed to send. A notification journal
append failure logs a warning and does not fail the tick or skip other agents.
CAR retains the row in memory, including a successful delivery, so a lost sent
row does not cause a resend every tick in that daemon life. Success stops
retries. A crash after delivery but before persisting the sent mark may cause a
duplicate; senders can deduplicate downstream.

Within one daemon life, after that daemon observed the give-up, a tick seeing
Running, Backoff or Stopped rearms the next give-up. Immediately after daemon
boot, Stopped alone is not recovery; CAR needs proof of execution, such as
Running or a newly observed exit code. Recovery and give-up entirely between
ticks remain one incident. A never-Errored agent merely climbing restarts does
not notify. Removed agents retire pending incidents, so re-adding the id does
not deliver an obsolete event.

Torn, garbage and unknown-kind notification rows are skipped with a warning
naming `notifications.jsonl` and their line number. Such rows never establish
successful sending; valid retained incident rows remain eligible for retry. A
torn final row is separated before the next append.

### Webhook sender with sender-owned credentials

Install this executable as `/absolute/path/notify-agent`:

```sh
#!/bin/sh
exec /usr/bin/curl --fail --silent --show-error \
  --config /absolute/private/webhook.curl \
  --header 'Content-Type: application/json' --data-binary @-
```

The sender-owned `/absolute/private/webhook.curl` has mode 600 and curl's
syntax:

```text
url = "https://example.invalid/agent-notifications"
header = "Authorization: Bearer REPLACE_WITH_SENDER_OWNED_TOKEN"
```

Provision that file independently. CAR receives only its path in the sender
script; CAR neither reads nor supplies that credential. The default cadence is
900 seconds; `CAR_HEAL_INTERVAL_SECS` shortens it for isolated development
proofs.

{% endraw %}
