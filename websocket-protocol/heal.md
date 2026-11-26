{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### `heal.*` — the self-healing repair loop

Heal is CAR's one self-repair feature. On a cadence it detects defects in CAR's
own runtime, repairs a repairable one in an isolated worktree, has an
independent model panel review the change, merges an approved fix once every
required CI check passes, and then watches the running daemon to confirm the
failure stopped. It also works issues a person hands in, which get a pull
request and are never merged. See [self-healing](../self-healing.md) for the
feature as a whole.

**Protocol 4 replaced `selfheal.*`.** Before wire protocol 4 the detector and
the repair loop were two features, `selfheal.*` and `heal.*`. They are one now,
and `selfheal.status`, `selfheal.detections`, `selfheal.dismiss`,
`selfheal.fix` and `selfheal.run` are removed with no alias: the daemon answers
any `selfheal.*` method `-32601` `unknown method: selfheal.<name>: method
removed; use heal.*`. `heal.status` changed shape in the same version, so
protocol 3 is out of the daemon's range (`PROTOCOL_VERSION_MIN` is 4). In
place of the removed `selfheal.detections` call `heal.detections`; of the
removed `selfheal.dismiss`, `heal.dismiss`; of the removed `selfheal.status`
and `selfheal.run`, `heal.status` and `heal.run`. The removed `selfheal.fix`
has no replacement: heal repairs on its own.

**On by default, with no configuration.** Every key is optional and lives under
`[heal]` in `<CAR_HOME>/config.toml`. `enabled = false` is the one off switch.
`<CAR_HOME>/heal.toml` and a `[selfheal]` section are no longer read; either
being present is reported in `config_warnings`, as is any `[heal]` key heal
does not understand.

```toml
[heal]
enabled = true              # the one off switch (default true)
daily_budget_usd = 5        # charged to the car:heal spend meter, a Day cap; 0 spends nothing
# source_checkout = "/Users/me/git/car"   # where CAR's source lives
# notification_command = { program = "...", args = ["..."] }

# Optional: issues a PERSON hands in. They pass the provenance-tier gate and
# get a pull request only, never a merge.
# review_models = ["...", "..."]   coder_model = "..."   engine = "foreman"
# human_label = "needs-human"   escalate_to = ["octocat"]   notify = ["human:sam@sams-car"]
[[heal.target]]
repo = "acme/widgets"
path = "/Users/me/git/widgets"
label = "self-heal"         # opt-in label; items without it are invisible

[[heal.org]]
owner = "*"                 # you plus every organization you belong to, or a login
roots = ["~/git"]           # searched two levels deep; nothing is ever cloned
```

**Models and money.** Heal may use any capable model, remote included, under
the daily budget on the `car:heal` meter. An unpriced remote model is refused,
because a budget cannot bound what it cannot price. The coder is the best
measured model that writes code and calls tools; the review panel is at least
two seats, each from a vendor other than the coder's, all distinct. A
detection whose evidence the store-aware redactor would change never leaves
the machine: it is repaired by local models only, or not at all, and
`heal.status` says which.

**What a repair is.** A detection kind is repairable when the repair session
can state a runnable outcome contract for it; a recurring builtin tool failure
uses the runtime-authored replay contract. A kind with no runnable contract is
escalated rather than merged on a model-invented contract: heal files a
redacted issue on the checkout's repository, labelled `needs-human` (or
`[heal] human_label`, created when missing) and assigned to `[heal]
escalate_to` or the `gh` login, and `heal.status` names it. Each round runs on
the branch `car/heal/<dedup_key>-o<occurrence>`, in a slot leased from the
checkout's CAR worktree pool when it has one (released as soon as the round
fails or its pull request merges or closes), otherwise in a worktree under
`<CAR_HOME>/heal/worktrees/`; heal never pushes to `main` and never touches the
operator's working tree. A fix the panel approved is queued with GitHub
auto-merge on its exact reviewed head, and merges only when every required
check is green. Detector-originated work on `Parslee-ai/car` is the only work
heal merges.

**Healed means the failure stopped.** After the merge heal waits for a daemon
build that contains the merge commit, then for three live ticks and 24 hours
with no recurrence. A recurrence reopens the key as the next occurrence, on a
new branch, and counts as a failed round. After three failed rounds on a key
heal hands it to a person.

**State.** Everything lives under `<CAR_HOME>/heal/`: the private append-only
`ledger.jsonl` (copied once from `<CAR_HOME>/selfheal/detections.jsonl` on the
first boot after the upgrade), `notifications.jsonl`, `issues/`, `attempts/`
and `worktrees/`. Directories and files are 0700/0600 on Unix.
`CAR_HEAL_INTERVAL_SECS` changes the cadence only (900 seconds by default);
`CAR_SELFHEAL_INTERVAL_SECS` is no longer read.

#### `heal.status`
- **Params**: `null`
- **Returns**: `{ state, reason, cadence_secs, daily_budget_usd,
  source_checkout?, coder_model?, review_models[], work[{ dedup_key, phase,
  round, occurrence, branch, pr_number?, pr_url?, head_sha?, merge_sha?,
  issue?, slot?, note? }], last_tick_at?, detectors[], detection_count, warning_count,
  critical_count, dismissed_count, notification_refusal_reason?,
  config_warnings[], targets[], orgs[], rejected[{ repo, reason }],
  discovered[{ repo, checkout?, reason? }], spend_meter }`.
- `state` is one of `off`, `blocked`, `idle`, `working`, `awaiting_merge`,
  `verifying` or `escalated`, and `reason` is exactly one sentence saying why.
  A disabled heal and an idle one must not look alike, so the reason is always
  present. While heal cannot work, `reason` is the FIRST broken precondition,
  evaluated on every tick in this order: heal is off; no `Parslee-ai/car` source
  checkout (naming where it looked; a daemon on a `CAR_HOME` other than
  `~/.car` discovers none unless `[heal] source_checkout` names one); `git`,
  `cargo` or `gh` missing from the login shell's `PATH`; no OS secret sandbox
  for heal's builds and tests (always the reason on Windows); forge
  authentication; the day's budget spent (with the
  reset time); no coder model (naming each model's exclusion); no independent
  panel; the checkout's fetch failing. Otherwise `reason` describes the current
  work.
- `source_checkout`, `coder_model` and `review_models` are what the last tick
  resolved. `work` lists each defect in hand: `phase` is `working`, `retry`,
  `awaiting_merge`, `verifying`, `healed`, `escalated` or `already_passing`
  (its own checks already pass on unmodified main and no commit names it as
  fixed: not repaired and not healed); `round` counts rounds started on that
  defect across occurrences; `branch` is `car/heal/<dedup_key>-o<occurrence>`,
  with `-r<round>` for a retry after a failed round closed its pull request;
  `note` explains a phase that is not obvious.
- `last_tick_at`, `detectors` and the counts describe the detector half. The
  eight detector IDs are `metrics_alerts.v1`, `agent_protocol_skew.v1`,
  `agent_gave_up.v1`, `agent_log_errors.v1`, `recurring_tool_failure.v1`,
  `capability_miss.v1`, `scheduler.v1` and `flaky_test.v1` (which runs when
  the merge queue drops a heal pull request on a test that also failed on
  another queue entry). Each `work` entry carries `issue` once an escalation
  issue was filed, and `slot` while a worktree-pool slot is leased for it. `notification_refusal_reason` says
  why `[heal] notification_command` was refused (an empty program or argument,
  a control character, a stored secret in an argument, or an unexpected field),
  in which case no agent notification runs.
- `config_warnings` names each problem with the configuration that heal works
  around rather than refuses: a `heal.toml` that is present but no longer read,
  a `[selfheal]` section that is no longer read, an unknown `[heal]` key. `targets`, `orgs`, `rejected` and `discovered` describe
  the optional hand-in issues: the `[[heal.target]]` repositories, the
  `[[heal.org]]` owners, targets that were named but unusable with the reason,
  and what the last sweep found under the owners (each repository with its
  checkout, or why an owner produced nothing). `heal.status` itself makes no
  network call.
- `spend_meter` is the spend meter's health, the same object `spend.status`
  and `spend.costs` report: `{ healthy, last_error, clock, zone, zone_source }`,
  or `{ healthy: true, last_error: null, note }` when no supervisor is
  installed. `healthy` is `false` with the error in `last_error` when the
  meter could not write its ledger; while it stays so, a capped agent's model
  calls made through CAR are refused `-32018` `spend_unrecordable` (see
  [spend](spend.md#spend)).
- The configuration is re-read on every call and every tick, so an edit takes
  effect without a daemon restart. Answerable whether or not heal is enabled.
- FFI: `healStatus()` (NAPI) / `heal_status()` (PyO3), returning JSON.

#### `heal.run`
- **Params**: `null` or `{ item?: string, chat_session_id?: string }`
- **Returns**: without `item`, the `heal.status` object after the tick. With
  `item`, the sweep report `{ outcomes: [[repo, outcome]], skipped_overlap }`,
  where each `outcome` is tagged: `{"outcome":"opened", repo, number, pr_url,
  gate, ci, delivery}`, `{"outcome":"rejected", repo, number, gate}`,
  `{"outcome":"idle", skipped[]}` or `{"outcome":"failed", detail}`. `ci` is
  `{head_sha, state, checks:[{name,state}], observation_error?}` with every
  state `"green"`, `"pending"` or `"red"` for that exact delivered SHA, and
  `delivery` is its plain summary.
- Without `item`: one heal tick now instead of waiting for the cadence:
  detect, repair, merge, verify, and the hand-in issues. It goes through the
  same path the cadence uses, so a tick already running is not overlapped.
- `item` (`owner/repo#number`) runs that one handed-in issue with the attended
  configuration, setting aside its backoff and its `human_label`, because a
  person asked for it; the opt-in label and provenance rules still apply, and
  the repository must be a configured target. A malformed `item` is refused
  rather than read as absent. A handed-in issue gets a pull request and is
  never merged.
- **Who may call it (car#2445):** a run's coder sessions may run an outside
  coding CLI, so a connection bound to a supervised agent passes the
  `session_id` of the `agents.chat` turn a host started with that agent as
  `chat_session_id`, the rule `foreman.run` uses. The turn is checked once,
  when the call arrives. Hosts and connections not bound to an agent omit it.
- Exempt from the handler's request deadline, and the run is its own task, so
  a caller that drops the request never leaves a detached coder session: the
  caller may miss the answer, the daemon never loses the work.
- FFI: `healRun(chatSessionId?, item?)` (NAPI) / `heal_run(*,
  chat_session_id=None, item=None)` (PyO3), returning JSON.

#### `heal.detections`
- **Params**: `{ kind?, severity?, since?, offset?, limit? }`, every field
  optional. `kind` is one of `metrics_alert` / `agent_gave_up` /
  `agent_log_error` / `agent_silently_idle` / `recurring_tool_failure` /
  `capability_miss` / `agent_protocol_skew` / `scheduled_task_problem` /
  `flaky_test`;
  `severity` is `warning` / `critical`; `since` is RFC 3339. The default limit
  is 100 and the server clamps it to 1..500.
- **Returns**: `{ detections, total, offset, limit, next_offset? }`, latest
  first. Dismissed keys are omitted. Each detection carries `detector_id`,
  `kind`, `severity`, `locator`, its SHA-256 `dedup_key`, `car_version`,
  `first_observed_at` / `last_observed_at`, `provenance`, redacted
  `evidence`, the tick's `route`, `local_issue_path` when routed locally, and
  `occurrence` (1-based): a key whose problem cleared and came back is a new
  occurrence.
- A `recurring_tool_failure` also has `eligible: boolean`. It is true only when
  the matching `ActionFailed` names `tool_source: "builtin"`, its
  `proposal_id` + `action_id` resolve against a
  `ProposalReceived.data.proposal` in the same journal, and serializing the
  recovered params through the redactor changes no bytes. A safe recovered
  call appears as `reconstructed_call: { tool, params }`; any redaction omits
  it rather than copying raw parameters. Local routing also supplies
  `reconstructed_call_path` for the owner-private 0600 `<dedup-key>.call.json`
  sidecar beside the issue document.
- The repair state of a detection is in `heal.status`'s `work`, not here.
- FFI: `healDetections(queryJson?)` (NAPI) / `heal_detections(query_json=None)`
  (PyO3), returning JSON.

#### `heal.dismiss`
- **Params**: `{ dedup_key }`, required: the 64-character SHA-256 hex key from
  a detection.
- **Returns**: `{ dedup_key, dismissed, already_dismissed, dismissed_at }`.
- Appends a dismissal marker to the ledger; it never rewrites or deletes
  history. Later ticks suppress that key and heal never repairs it. An unknown
  key is refused. A `scheduled_task_problem` dismissal covers the current
  occurrence only: once a tick finds the problem gone the key is resolved,
  dismissing it is refused (`is resolved; nothing to dismiss`), and a
  recurrence is reported again.
- FFI: `healDismiss(dedupKey)` (NAPI) / `heal_dismiss(dedup_key)` (PyO3),
  returning JSON.

#### `events.cost_by_agent`
- **Params**: `null`, or `{ agent }` — optional; a bare agent id or a full
  spend-meter key (`agent:<id>`, `operator`, `car:<purpose>`, …). With it, the
  method reads that principal's call ledger, every model call it made through
  CAR, daemon-wide, and returns that principal's one row over it, instead of
  folding this connection's in-memory log. A host or operator session may name
  any principal; a session bound to a supervised agent, or an outside
  credential's session, only itself (another is refused `-32003`,
  `data.reason: "not_your_agent"`, and recorded). Without it, the method
  behaves exactly as before.
- **Returns**: array of `{ agent, calls, tokens_in, tokens_out, cost_usd,
  priced_calls, subscription_calls, unpriced_calls, ambiguous_reports,
  ambiguous_reported_cost_usd }` — the per-agent
  token/cost report, folded from `InferenceMetered` events by their `agent`
  field (EPIC G / G3). `cost_usd` sums only the `priced_calls` (a provider's
  figure, a list price, or a local model's $0). A subscription call adds no
  dollars, and an `unpriced_calls` call's cost is unknown, not $0, so a row
  with any is a lower bound. Calls that name no agent are their own
  `"unattributed"` row, never merged into an agent's. `ambiguous_reports`
  counts `multi.*` sub-agent self-reports the daemon could not tie to one
  run (rows marked `summary_of: "ambiguous"`, see [events](events.md)), and
  `ambiguous_reported_cost_usd` is what those runners reported: listed apart,
  never part of `calls` or `cost_usd`, whose measured rows already count the
  calls once (car#3492). Over a principal's ledger (`{ agent }`) every call
  names its payer, and a call from a connection bound to no agent is the
  `operator`'s, so the daemon-wide rows are the agents' and `operator`. The
  daemon keeps each payer's ambiguous self-reports beside its ledger (a
  separate file, never a ledger row, never counted against a cap, never
  dropped: rotated by size and read whole), so `{ agent }` reports them too,
  under the same authorization; `events.query { agent }` returns them as
  `inference_metered` rows marked `summary_of: "ambiguous"`. It reads only the calling connection's
  session log (see [events](events.md) for scope and journal retention). A
  multi-agent run reports cost per agent;
  provenance (which tool/workflow) is queryable via
  `events.query {data_matches:{agent}}`.
- A `multi.*` run writes one row per sub-agent, and in the daemon that row
  is a **summary** of the sub-agent's run: `agent` is the paying principal's
  meter key (`agent:<id>`, `operator`), `sub_agent` the sub-agent's name,
  `cause` the request's, and `reported_cost_usd` the figure the runner
  reported. The sub-agent's model calls are the client's own `infer`
  requests, each recorded on its own `infer` row with its own `call_id`, so
  the summary row carries no `call_id` or `cost_source` of its own and adds no
  cost on top of those rows (see [events](events.md) for the exact fields and
  the fold rule). Rows written by earlier versions (`agent` = the sub-agent's
  name, `cost_usd` self-reported) fold exactly as they always did. The
  daemon's own `infer`, `infer_stream` and assistant-loop records carry
  `agent` as the paying principal's meter key (see `events.query`), so an
  `infer` from an agent-bound session is reported under `agent:<id>` and one
  from the daemon token under `operator`, never `unknown`.

#### `replan.set_config`
- **Params**: `{ max_replans, delay_ms, verify_before_execute, replan_on_rejected }` flat shape
- **Returns**: `null`
- Configures the per-session replan loop. `replan_on_rejected` (default `false`): when `true`, validator/policy/capability rejections (`ActionStatus::Rejected`) — not just runtime failures — also trigger rollback + replan, feeding the offending tool/error/parameters back to the replan callback. Conservative default preserves abort-only-on-failure behavior for all existing consumers.


{% endraw %}
