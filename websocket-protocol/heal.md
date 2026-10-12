{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### `heal.*` — the self-healing repair loop

`selfheal.*` above **detects and never writes**. `heal.*` is the other half: it
reads a configured issue tracker, runs a real coder session, gates the result on
a multi-model review panel, and opens a pull request. It **never merges** —
`coder.approve_merge` is where a human belongs, and a pull request is undone by
closing it.

**Default off, by absence rather than a flag.** There are no compiled-in
targets: a daemon with no `<CAR_HOME>/heal.toml` starts nothing. A repository
must also carry an explicit opt-in label on an issue (`self-heal` by default)
before the loop can see it — silence is not consent.

```toml
# <CAR_HOME>/heal.toml
review_models = ["claude-opus-5", "gpt-5.5", "gemini-3-pro"]
engine = "foreman"            # optional; foreman by default

[[target]]
repo  = "acme/widgets"        # where the work QUEUE lives
path  = "/Users/me/git/widgets"  # or `project = "<slug>"`; omit both for watch-only
label = "self-heal"           # optional
base  = "main"                # optional
fix_repo = "acme/widgets-src" # optional; when fixes land in a different repo
```

`review_models` is not optional and must resolve to seats served by at least two
attributable model vendors. The gate refuses a panel of zero, and a one-vendor
panel is correlated by construction, so either configuration declines to start
before spending a coder session and says which models resolved to which vendors.

#### `heal.status`
- **Params**: `null`
- **Returns**: `{ config_path, enabled, cadence_secs, disabled_reason?,
  targets[], rejected[{ repo, reason }], review_models[],
  panel[{ model, vendor? }], panel_warning?, coder_pin?{ model, source },
  run_refusal?, engine }`.
- `heal.toml` is re-read on every call and on every sweep, so an edit takes
  effect without a daemon restart and `heal.status` always reports what the next
  sweep will use. `config_path` names the file it was read from — an operator
  editing the wrong one otherwise learns nothing from a status that reports
  exactly what they did not change.
- `disabled_reason` distinguishes "no usable targets are configured" from
  "targets are configured but there is no review panel", and also carries a
  boot-time ASSEMBLY failure — an unknown model name, fewer than two attributable
  serving vendors, or a `coder_model` that is also a review seat. Those are
  validated when the loop is assembled rather than when the config is parsed,
  so without this a rejected configuration would
  leave `enabled: true` with no reason and a loop that never runs, which is the
  state this field exists to make impossible. `rejected` carries
  targets that were named but unusable (a malformed `owner/name`, both `path`
  and `project` set) — a typo that silently dropped a target would present as a
  loop that never does anything, which is the hardest failure to notice in a
  subsystem whose normal state is idle.
- `panel` is `review_models` after the deduplication the live panel applies,
  with each seat resolved to the organization that actually serves it. That is
  not the model's `provider`, which names the AGGREGATOR — everything routed
  through OpenRouter reports `openrouter` and everything through the Parslee
  gateway reports `parslee` — so three vendors behind one gateway would look
  like one, and one vendor reached two ways like two. A `vendor` of `null` means
  unknowable, not absent: a Parslee capability endpoint (`parslee/reasoning`) is
  routed by the gateway to whatever it prefers, so no vendor can honestly be
  attributed. Never count `null` as a distinct vendor.
- Assembly REFUSES a panel with fewer than two attributable serving vendors.
  The error names every configured model and its resolved vendor; an
  unattributable seat is `unresolved` and does not invent a second provider.
  Refusing rather than silently dropping seats matters because a smaller panel
  has a different majority threshold and is a configuration the operator must
  choose explicitly.
- `panel_warning` covers the stronger condition that remains after that floor:
  a panel can span two vendors while one vendor still holds the voting majority,
  or include an unattributable seat alongside two attributable providers. The
  warning reaches the pull request because that accepted panel is not fully
  demonstrably independent even though it meets the minimum construction rule.
- Every model that AUTHORED part of a change is recorded on the session
  (`authored_by`, also on the `coder.list` row) and checked against the panel
  when the gate runs. That is the case the assembly-time check below cannot
  reach: it checks a resolved pin, but adaptive routing can choose a different
  model on each request. A set rather than one name, because a turn terminal is
  journaled per iteration and an unpinned session may route each iteration
  differently; a reviewer judges the accumulated diff, not the last iteration.
  Models that served turns INSIDE an iteration another model finished are
  counted too (car#1333) — the terminal names only whoever reached it, so a
  model could otherwise write most of a change and still sit on the panel
  judging it.

  When neither pin source below supplies a coder model, self-heal also prevents
  the collision before inference: every turn carries the canonical review-seat
  names in `IntentHint.exclude_models` with `strict_exclusions: true`. If no
  independent model remains, generation stops before provider dispatch with
  `failure_kind: "configuration"`; the cadence releases the item claim without
  item backoff or a public failure comment, because the remedy is in
  `heal.toml`, not the backlog item. The durable `authored_by` check remains the
  delivery backstop for routing changes and already-running cadence state.

  Both sides are canonicalized to registry ids before comparison. An unpinned
  turn reports the model's display NAME while a seat is configured however the
  operator spelled it, and `review_models` accepts an id or a name — so for
  every model whose id and name differ these are two spellings of one model,
  and comparing the strings would let it sit on both sides of the gate.

  **Native-rung enforcement.** `authored_by` is empty for a foreman or external
  session, whose CLI backbone CAR never resolved — that is most runs, since
  `foreman` is the default engine, and it is permitted rather than refused: read
  it as "CAR's own loop did not write this", not "nobody did". An empty set on a
  session that RAN native IS refused — the engine the session RESOLVED to, not
  the one `heal.toml` asked for. `engine = "auto"` is a legal setting and
  resolves to native for any simple task and on any machine with no CLI
  installed, so comparing the request let exactly this case through (car#1357), because every exit from that loop
  journals a terminal — including the two that return early, an auth lapse and a
  dead backbone after the edit landed (car#1333) — so an empty set means the
  attribution was lost rather than that there was none to take.
- A pinned coder that resolves to the same model as a review seat is REFUSED at
  assembly: a model cannot review its own output, and counting it as a seat
  reports an independence the gate does not have. Compared by resolved model
  id, so two spellings of one model are recognized as one. `heal.toml`'s
  `coder_model` is validated against the catalog alongside `review_models`.

  **Two pin sources.** `coder.start` resolves a session's model as the request
  pin, then `~/.car/coder.toml`'s `[coder] model` — and heal passes `heal.toml`'s
  `coder_model` as the request pin. So an unset `coder_model` does NOT mean the
  coder is unpinned; it means the coder runs on whatever `coder.toml` says, and
  that value is checked against the panel too, with the error naming which file
  the pin came from. Whichever source wins is also what heal pins the session
  to, so the value checked is the value that runs. Only when NEITHER file pins
  is the coder chosen by the router; in that case every review seat is a strict
  routing exclusion, with the `authored_by` gate above retained as a delivery
  backstop.

  A `coder.toml` pin the daemon's catalog does not know is NOT refused, unlike
  an unknown `coder_model`. That file is shared with `coder.start` and
  `car code-task`, neither of which validates it, and on the `external` rung
  the value is forwarded verbatim to a CLI's own namespace (`codex -m`,
  `claude --model`) — so a name `car models list` has never heard of can be
  exactly right for the rung that runs, and refusing would take the loop
  offline over a working configuration.

  **When it fires.** `heal.run` assembles per call, so it re-reads both files
  and re-runs the check; a refusal there lands in `run_refusal`, so
  `heal.status` cannot describe a configuration `heal.run` will not run on.
  The cadence assembles ONCE at boot — an assembly
  error there is reported through `disabled_reason` and the loop does not start
  until the daemon restarts. Editing `coder.toml` after boot therefore does not
  re-run this check for the cadence; the runtime `authored_by` gate is what
  covers that window, and `coder_pin` makes the staleness visible by showing
  what the next `heal.run` would use.
- `coder_pin` is the model the coder will run on and which file pinned it —
  `source` names the setting (`` `coder_model` in `heal.toml` `` or
  `` `[coder] model` in `coder.toml` ``), so an operator goes straight to the
  line in force rather than opening both files and re-deriving the precedence
  by hand. That re-derivation is not hypothetical: doing it from one source
  only is what let a coder sit on its own review panel (car#1360).

  **Absent means unpinned, which is a third state.** Neither file names a
  model, so adaptive routing picks per request while strictly excluding every
  review seat. Nothing before the run can say which remaining model it will
  pick. That is different from "pinned to something the panel rejects", and
  the two need different fixes.

  `source` is a MACHINE value — `heal_toml` or `coder_toml` — not prose; `car
  heal status` renders the operator-facing wording. The model is reported
  verbatim rather than canonicalized, for the same reason an unknown
  `coder.toml` pin is not refused (below): on the `external` rung it is
  forwarded to a third-party CLI's own namespace, so what the file says is the
  useful answer.

  **What a RUNNING cadence uses may differ.** `coder.toml` is consulted only
  when `heal.toml` does not pin, resolved through the one helper the sweep's
  own check calls — so this cannot disagree with what the next `heal.run`
  assembles. It is not a claim about a cadence already running: that assembles
  once at boot and bakes the pin in, the same freeze this document notes for
  the panel. A session started by `coder.start` can also differ, since it
  re-reads `coder.toml` itself at start. Read `coder_pin` as what the next
  `heal.run` would use.
- `run_refusal` is why the most recent manual `heal.run` refused to ASSEMBLE,
  cleared as soon as one gets past assembly. Deliberately not folded into
  `disabled_reason`: a cadence that came up cleanly at boot keeps sweeping on
  its boot-time setup, so a manual refusal is a warning that the config as it
  stands now would not assemble — reporting it as "disabled" would describe a
  dead loop that is in fact running.
- `panel_warning` reports vendor CAPTURE of the majority beyond the enforced
  two-vendor floor: approval needs a strict majority, so two OpenAI seats decide
  a three-seat panel whatever the third says. That framing also catches one model
  seated twice under different ids — a direct id, an OpenRouter id and a Parslee
  alias can all be the same model — without having to prove they are the same
  model, which is not reliably decidable.
- The resolved panel and this caveat are also written into the PULL REQUEST
  BODY, beside the gate verdict. "approved by 3/3 reviewers" is the number a
  human uses to decide how closely to read the change, and a correction that
  lives only here corrects the claim everywhere except where it is made.
- Answerable whether or not the loop is enabled.
- FFI: `healStatus()` (NAPI) / `heal_status()` (PyO3), returning JSON.

#### `heal.run`
- **Params**: `null`
- **Returns**: `{ outcomes: [[repo, outcome]], skipped_overlap }`, where each
  `outcome` is tagged. An opened result is
  `{"outcome":"opened", repo, number, pr_url, gate, ci, delivery}`. `ci` is
  `{head_sha, state, checks:[{name,state}], observation_error?}`; every state is `"green"`,
  `"pending"`, or `"red"`, and it combines GitHub check runs with legacy
  commit-status contexts for that exact delivered SHA. An empty rollup is
  pending rather than green. A failed CI lookup preserves the opened result,
  with pending state, no checks, and an `observation_error` diagnostic; it does
  not retry publication or release its held claim. `delivery` is the matching plain summary, such as
  `delivered with green checks and ready for review at <sha>` or
  `delivered red on windows at <sha>`. The other variants remain
  `{"outcome":"rejected", repo, number, gate}`, `{"outcome":"idle", skipped[]}`,
  or `{"outcome":"failed", detail}`.
- One sweep now instead of waiting for the cadence: **at most one item per
  configured target**, so a busy repository cannot starve the entries after it.
- `skipped_overlap` is `true` when a sweep was already running and this one
  stood down. Ticks are expected to collide — the claim TTL is 90 minutes and
  the cadence is shorter — and queueing them would only do the same work twice.
- This can run a real coder session and open a real pull request. After
  reconciliation, the host reads CI for the delivered head and includes it in
  the report; a head race is refused rather than reporting another commit's
  checks. It goes through the same service the cadence uses, so it shares the
  single-sweep lock and the claim ledger. It does not merge the pull request.
- Errors rather than running when the loop is disabled or cannot be assembled:
  no review panel, fewer than two attributable serving vendors, a coder that is
  also a review seat, an unparseable engine name, or a `review_models` entry that
  names no model this daemon knows. The error for insufficient diversity names
  the models and providers. An unknown id is refused rather than dropped — a
  panel silently shrunk from three seats to two lowers the approval threshold
  without saying so.
- Exempt from the handler's request deadline, and the sweep runs as its own
  task. A sweep that was cut in half would leave a detached coder session
  editing the repository with `coder.cancel` unable to reach it, so the sweep
  outlives the request: the caller may miss the answer, the daemon never loses
  the work.
- The claim for an item reaches disk **before** its coder session starts, so a
  daemon that dies mid-session does not re-pick work that is already in flight.
- FFI: `healRun()` (NAPI) / `heal_run()` (PyO3), returning JSON.
- `CAR_HEAL_INTERVAL_SECS` changes the cadence only (900 seconds by default).
  The first tick is skipped on boot, so a daemon restart does not start a coder
  session before the operator has seen it come up.

#### `selfheal.status`
- **Params**: `null`
- **Returns**: `{ cadence_secs, auto_fix_enabled, max_concurrent, max_per_day,
  max_rounds_per_key, auto_fix_refusal_reason?, last_tick_at, route,
  source_checkout?, refusal_reason?, detectors, detection_count, warning_count,
  critical_count, dismissed_count, filing_mode }`.
- `route` is `"local"` only when the tick validates a filesystem candidate as
  the CAR source checkout; `source_checkout` then gives the canonical path.
  Otherwise it fails closed to `"ledger-only"` and `refusal_reason` explains
  why, including the actual origin remote when one was refused. `"feedback"`
  is reserved for the separately gated feedback sink and is never selected by
  this implementation.
- Source candidates are bounded and deterministic: `[selfheal]
  source_checkout = "/path/to/car"` in `<CAR_HOME>/config.toml` is authoritative,
  followed (only when it is absent) by running-binary ancestors and the root of
  the `.car/` project discovered from `CAR_PROJECT_DIR` or cwd. A candidate must
  contain a `.git` directory or worktree file whose config names a GitHub
  `Parslee-ai/car` origin. Detection performs file checks/reads only: no `git`
  subprocess, network, or filesystem-wide scan.
- `auto_fix_enabled` reflects `[selfheal] auto_fix` (default true) after
  fail-closed config validation. The three limits default to 1 concurrent, 3
  starts per UTC day, and 3 rounds per key and cannot be raised. A malformed or
  raised-limit config disables auto-fix and sets `auto_fix_refusal_reason`.
  `filing_mode` is `"pr-only"` after a local route is validated with auto-fix
  enabled; otherwise it is `"watch-only"`. The daemon runs one non-overlapping
  tick immediately at boot and then every 900 seconds by default.
  `CAR_SELFHEAL_INTERVAL_SECS` changes cadence only.
- The five detector IDs are `metrics_alerts.v1`, `agent_gave_up.v1`,
  `agent_log_errors.v1`, `recurring_tool_failure.v1`, and
  `capability_miss.v1` (the unversioned detection `kind` values are listed
  below).
- FFI: `selfhealStatus()` (NAPI) / `selfheal_status()` (PyO3), returning JSON.

#### `selfheal.detections`
- **Params**: optional `{ kind, severity, since, offset, limit }`. `kind` is one
  of `metrics_alert` / `agent_gave_up` / `agent_log_error` /
  `agent_silently_idle` / `recurring_tool_failure` / `capability_miss`;
  severity is `warning` / `critical`; `since` is RFC 3339.
  Default limit is 100 and the server clamps it to 1..500.
- **Returns**: `{ detections, total, offset, limit, next_offset }`, latest first.
  Dismissed stable keys are omitted. Each detection carries its SHA-256
  `dedup_key`, evidence/provenance, observation times, affected component,
  detector/version identity, redacted summary/detail, the tick's `route`, and
  `local_issue_path` when routed locally. A `recurring_tool_failure` also has
  `eligible: boolean`. It is true only when the matching `ActionFailed` names
  `tool_source: "builtin"`, its `proposal_id` + `action_id` resolve against a
  `ProposalReceived.data.proposal` in the same journal, and serializing the
  recovered params through the self-heal redactor changes no bytes. A safe
  recovered call appears as `reconstructed_call: { tool, params }`; any
  redaction omits it rather than copying raw parameters. Local routing also
  supplies `reconstructed_call_path` for the owner-private 0600
  `<dedup-key>.call.json` sidecar beside the issue document. Durable coder state
  adds `auto_fix_attempts`, `auto_fix_exhausted`, `auto_fix_in_progress`, and
  `last_auto_fix_attempt` (round/trigger/timestamps/branch/workspace,
  `spawned`, `exit_code`, and `failure_class`). Remote deduplication adds
  `auto_fix_awaiting_review`, `auto_fix_parked`, `remote_pr_number`, and
  `remote_pr_url`; an open stable-key PR is awaiting review, while a
  closed-unmerged PR is parked and never reopened.
- FFI: `selfhealDetections(queryJson?)` / `selfheal_detections(query_json=None)`.

#### `selfheal.dismiss`
- **Params**: `{ dedup_key }`, the 64-character SHA-256 hex key from a
  detection.
- **Returns**: `{ dedup_key, dismissed, already_dismissed, dismissed_at }`.
- Appends a dismissal marker; it never rewrites/deletes history. Later ticks
  suppress that key. FFI: `selfhealDismiss(dedupKey)` /
  `selfheal_dismiss(dedup_key)`.

#### `selfheal.fix`
- **Params**: `{ dedup_key }`, an active eligible recurring-tool key.
- **Returns**: `{ dedup_key, round, trigger, started_at, completed_at,
  target_branch, workspace_dir, spawned, exit_code, failure_class }`.
- Starts one explicit bounded round even when unattended `auto_fix` is off.
  It requires a validated `Parslee-ai/car` checkout, a safe reconstructed
  builtin call, an available daily/key budget, and no concurrent self-heal
  operation. The daemon writes private intent/params/contract files, requires
  `git fetch origin main` to succeed, and spawns `car code-task` with PR-only
  delivery, the stable `car/selfheal/<dedup-key>` branch/worktree, isolated
  `<CAR_HOME>/selfheal/target`, a 15-minute child wall limit, a private flushed
  `code-task-round-<n>.jsonl` transcript, and the stable PR body marker. The
  detector registry, not a model, owns the three contract checks. An exited
  child whose stream has no terminal `run_end` records `failure_class` as
  `missing_run_end`.
- FFI: `selfhealFix(dedupKey)` / `selfheal_fix(dedup_key)`.

#### `selfheal.run`
- **Params**: `null`
- **Returns**: a tick summary with `route`, `source_checkout?` or
  `refusal_reason?`, evidence counts, and new/changed/suppressed detection
  counts. A concurrent tick fails instead of overlapping.
- Runs the same path as the cadence. It reads active session event slices since
  the prior tick, current supervised-agent state, bounded activity/stderr tails
  and activity-log metadata, and the observe-only registry, then invokes all
  five deterministic detectors. After the detector ledger commit, an enabled
  local route may start the first round for one eligible recurring-tool key.
  Later ticks never start that key's initial round again. Other detectors remain
  watch-only and CAR never executes a proposed repair or merges a PR itself.
- FFI: `selfhealRun()` / `selfheal_run()`.

All five methods share the daemon-wide private append-only ledger at
`<CAR_HOME>/selfheal/detections.jsonl`. JSONL records are tagged `detection`,
`dismissal`, `tick`, `fix_started`, or `fix_attempt`; new ticks append only
new/changed detections plus their summary, while every accepted coder round has
one durable start and terminal exit/failure-class record. A `local` route
additionally renders one owner-private
`<CAR_HOME>/selfheal/issues/<dedup-key>.md` per active key, stamped
`Trust-Tier: trusted`, and updates its occurrence count in place. A recurring
key also gets the `<dedup-key>.call.json` eligibility sidecar described above.
Directories and files are 0700/0600 on Unix. Auto-fix creates only its isolated
`<checkout>/.worktrees/selfheal-<dedup-key>` worktree and Git refs; it never
edits the maintainer's working tree or index.

#### `events.cost_by_agent`
- **Params**: `null`
- **Returns**: array of `{ agent, calls, tokens_in, tokens_out, cost_usd }` —
  the per-agent token/cost report, folded from `InferenceMetered` events by
  their `agent` field (EPIC G / G3). A multi-agent run reports cost per agent;
  provenance (which tool/workflow) is queryable via
  `events.query {data_matches:{agent}}`.

#### `replan.set_config`
- **Params**: `{ max_replans, delay_ms, verify_before_execute, replan_on_rejected }` flat shape
- **Returns**: `null`
- Configures the per-session replan loop. `replan_on_rejected` (default `false`): when `true`, validator/policy/capability rejections (`ActionStatus::Rejected`) — not just runtime failures — also trigger rollback + replan, feeding the offending tool/error/parameters back to the replan callback. Conservative default preserves abort-only-on-failure behavior for all existing consumers.


{% endraw %}
