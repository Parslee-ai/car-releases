{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### events / replan

**Scope.** `events.query`, `events.cost_by_agent`, `events.stats` and
`events.chain.verify` read only the calling connection's session event log,
not another connection's. One exception: before answering `events.query`, the
daemon copies `worker_started` and `worker_starts_omitted` events for workers
the session may see into a host or orchestrator session's log (see
[workers](workers.md)). Those copies are then part of that session's log, so
`events.stats` and `events.chain.verify` count them too; `events.cost_by_agent`
does not, because it folds only `InferenceMetered` rows. The journals on disk are
kept separately: at startup the daemon deletes each finished per-client
journal that is older than 30 days or falls beyond the 1,024 newest. That
limit is fixed; it is not a setting, and `events.retention` does not change
it.

#### `events.count`
- **Params**: `null`
- **Returns**: `u64` — per-session event log size

#### `events.stats`
- **Params**: `null`
- **Returns**: the event log's `stats()` object — current event and span counts for the session log.

#### `events.truncate`
- **Params**: `{ maxEvents?: number, maxSpans?: number }` (camelCase; both optional)
- **Returns**: `{ removedEvents, removedSpans, stats }`
- Keeps the **last** N of each and drops the rest. An omitted bound leaves that series untouched — omitting both is a no-op that just reports `stats`. Malformed params degrade to that no-op rather than erroring.
- Retention trimming for a long-lived session. For age-based policy use `events.retention` instead.
- **Refused to a session bound to a supervised agent**, with `events.truncate is not available to a supervised agent: it erases the session event log, which records what the agent did`. Host and operator sessions, and the CLI, keep it.

#### `events.clear`
- **Params**: `null`
- **Returns**: `{ removed, stats }`
- **Destructive and unconditional** — drops the entire session event log, including the audit trail `events.query` reads and any hash chain `events.chain.enable` established. There is no undo and no confirmation. Prefer `events.truncate` or `events.retention` when you only need to bound growth.
- **Refused to a session bound to a supervised agent**, with `events.clear is not available to a supervised agent: it erases the session event log, which records what the agent did`. Host and operator sessions, and the CLI, keep it.
- A bound agent may read `events.retention` but not set it, so no call from a supervised agent erases or trims its own session log.

#### `events.query`
- **Params**: an `EventQuery` object — all fields optional, AND-conjoined:
  - `kinds` (array of `EventKind`) — restrict to these kinds (empty = any).
  - `action_id` / `proposal_id` (string) — exact match. `actionId` /
    `proposalId` are accepted as aliases.
  - `since` / `until` (RFC3339 timestamp) — inclusive lower / exclusive upper time bound.
  - `data_matches` (`{ key: value }`) — match events whose `data` contains all
    these string pairs (covers `caller`/`tenant`/`tool`/`gate`/`decision`).
    `dataMatches` is accepted as an alias.
  - `limit` (u64) — cap results (most-recent-first). Omit/0 = unlimited.
  - `agent` (string) — a bare agent id (`invoice-bot`) or a full spend-meter
    key (`agent:<id>`, `operator`, `car:<purpose>`, `worker:<handle>`,
    `declarative:<id>`, `credential:<id>`). With it, the query reads that
    principal's call ledger (every model call it made through CAR, daemon-wide)
    instead of this connection's in-memory log: its `inference_metered` rows
    (data: `agent`, `cause`, `call_id`, `model_used`, `model_id`, `tokens_in`,
    `tokens_out`, `cost_usd`, `cost_source`) and its `model_call_refused` rows
    (see [spend](spend.md#spend)), with the other filters applied as usual. A
    host or operator session may name any principal; a session bound to a
    supervised agent, or an outside credential's session, may name only itself,
    and naming another is refused `-32003` with `data.reason: "not_your_agent"`
    and recorded in its refusal rows. Without `agent` the method behaves exactly
    as before.
  - Unknown keys are ignored, not refused. Sending both spellings of one
    field is an error.
- **Returns**: `{ count, events }` — the matching events, most-recent-first.
- Runtime proposal-executor tool provenance is self-contained: each
  tool-bearing `ActionExecuting`, `ActionSucceeded`, and `ActionFailed` event
  emitted by that executor carries `data.tool` and `data.tool_source`, where
  `tool_source` is `builtin`, `user_defined`, `subprocess`, or `mcp`. MCP server
  names remain registry-private; the event category is deliberately stable
  across connectors.
- Every per-action `ActionFailed` emitted by that executor also carries
  `data.params_digest` (lowercase SHA-256 over the RFC 8785/JCS-canonical
  `parameters` object), the declared `data.expected_effects`, and
  `data.error_class`. Raw parameters remain only in `ProposalReceived`; join on
  `proposal_id` + `action_id` and use the digest to detect mismatches.
  `ActionSucceeded` carries `params_digest` and `expected_effects` too. Error
  classes map as follows: `timeout` is an engine deadline or host-callback
  timeout; `rejected_by_policy` is a dispatch guard's stable
  `denied by policy:` / `rejected by policy:` error; `validation` is a
  post-dispatch output or callback-state JCS/I-JSON, state-key-set, or
  serialization failure; `tool_error` is any other tool-dispatch error; and
  `unknown` is a post-dispatch failure for an action with no tool. Pre-dispatch
  admission failures remain `ActionRejected`.
- The audit/compliance query (EPIC G / G2): "who ran what tool when, and which
  approvals applied" over the `SessionScope` / `PermissionDecision` /
  `ApprovalRecorded` / `GoalEvaluated` / action trail. Pairs with A9
  hash-chaining. Goal-loop evidence can be inspected with
  `events.query { "kinds": ["goal_evaluated"] }`; each `GoalEvaluated`
  event carries `data.goal`, serialized `data.condition`, `iteration`, `met`,
  `grounded`, and `reason`. Proactive memory calibration can be inspected with
  `proactive_memory_maintained` and `proactive_memory_intervention` events.
- Every successful model call made through the daemon appends an
  `InferenceMetered` event: `infer` (one per call), `infer_stream` (one per
  stream, from the reconciled usage), and each turn of the built-in assistant
  loop; a `multi.*` run appends one summary row per sub-agent, described
  below, which is not a call. Beside the token metrics the
  record carries, all optional (`docs/proposals/spend-caps.md`, "The
  records"): `agent`, the meter key of the principal the call was charged to
  (`agent:<id>` for a session bound by `session.auth`, `worker:<handle>`,
  `credential:<id>`, `operator` for the daemon token or a host,
  `car:<purpose>` for CAR's own background work, `declarative:<id>` for a
  declarative agent run in the daemon); `cause`, why CAR made the call
  (`direct`, `chat`, `memory_embedding`, `compaction`, `summary`,
  `reflection`, `helper_agent`, `goal_verification`, `fallback`,
  `evolution`); `call_id`, the call's id on that principal's spend ledger;
  `cost_usd` (also in the metric key) and `cost_source` (`provider`,
  `list_price`, `local`, `subscription`, `unknown`); `model_used`; and
  `fallback_from`, the candidates the chain moved past, when any. A record
  written outside a spend scope, or by an older CAR, simply lacks these
  fields: none is ever `"unknown"`. `events.query { data_matches: { agent:
  "agent:invoice-bot" } }` reads one agent's calls from the session log.
  A daemon `multi.*` run writes one row per sub-agent run: `agent` is the
  payer and `sub_agent` the sub-agent's name, with the run's `cause`, the
  runner's self-reported figures as the `tokens_in`, `tokens_out` and
  `cost_usd` metrics and again as `reported_tokens_in`,
  `reported_tokens_out` and `reported_cost_usd`, the run's `duration_ms`,
  `tools` when any, and no `call_id` or `cost_source`, because the daemon
  makes no model call for a sub-agent. It hands the spec to the client over
  `multi.run_agent`, and the client's model calls either go through the
  daemon's `infer`, each its own row above with its own `call_id`, or go to
  a provider directly and are only self-reported. The daemon tells the two
  apart per sub-agent run by whether any `call_id`-bearing
  `inference_metered` row was written to the session log while that
  callback was open. If one was, the row is marked `summary_of: "infer"`
  and `events.cost_by_agent` and `metrics_totals` skip it, so the calls are
  counted once, on the `infer` rows; the self-report CAR never verifies is
  kept on the row but not counted. If none was, the row is the only record
  of those calls: it is not marked and folds under the payer, as the
  figures folded before the mark existed. The rule and its limit, for a
  client that mixes the two: a run with ANY `infer` row is marked, so the
  self-reported cost of the direct calls it made beside them is not folded;
  and with parallel sub-agents an `infer` row written while two callbacks
  are open marks both. The log the daemon watches is the whole session's,
  so the same holds for an unrelated `infer` on the same session during a
  callback (a chat call mid-swarm): it marks a self-reporting run's row as a
  summary and that run's self-reported cost drops from `cost_by_agent` and
  `metrics_totals`. That error only ever loses cost from the view, never
  counts a dollar twice, and never touches the spend meter, which counts
  every call the daemon made. A client that mixes the two styles in one swarm
  is decided per run, each run by its own callback's window, and a run is
  matched to its decision by the callback that produced it, not by its
  `sub_agent` name, so same-name sub-agents running together do not swap
  decisions. `events.query { data_matches: { sub_agent:
  "Researcher" } }` finds one sub-agent's rows either way. A multi row
  without `summary_of` — this CAR's row for a run that made no `infer`
  call, one an older CAR wrote (`agent` the sub-agent's name), or one
  written by an embedder running car-multi with no daemon meter — folds
  under its `agent`.

#### `events.chain.enable`
- **Params**: `null`
- **Returns**: `{ ok: true }`
- Turns on tamper-evident hash chaining for the session event log
  (EPIC A / A9). Every event appended from now on is linked to its
  predecessor by a SHA-256 content hash. Opt-in and idempotent; events
  appended before enabling stay byte-identical (and are skipped by verify).

#### `events.chain.verify`
- **Params**: `null`
- **Returns**: `{ verified: n }` — the number of chained events verified — or
  `{ tampered_at: i }` — the index of the first event whose hash/linkage
  doesn't match.
- Detects **interior** edits, deletions, and reorderings of chained events.
  It cannot detect truncation at either end of the log (there is no anchored
  head hash, and the first chained event's `prev_hash` is taken on trust);
  head/tail truncation detection is out of scope until the chain head is
  anchored.

#### `events.retention`
- **Params**: `{ policy?: { max_events?, max_age_secs? } }` (`maxEvents` /
  `maxAgeSecs` are accepted as aliases; sending both spellings of one field
  is an error naming the duplicate field)
  - With `policy`: installs it and immediately enforces the age bound;
    `max_events` is then also enforced automatically on every append.
  - Without `policy`: returns the current policy.
- **Setting is refused to a session bound to a supervised agent**, with "events.retention does not accept `policy` from a supervised agent: a retention policy trims the session event log, which records what the agent did. Call it without `policy` to read the current policy". Agents may read the policy; only host and operator sessions, and the CLI, may set it.
- **Returns**: `{ policy, removed }` on set (events reaped by the age sweep), or
  `{ policy }` on get.
- Bounds the log by size and age so it can't grow unbounded (EPIC G / G2).
- **Journal compaction**: when the session log has a JSONL journal, a
  retention trim also compacts the journal — the file is atomically rewritten
  to exactly the retained events, throttled to fire only when it holds
  ≥ 1024 more lines than the retained set and would shrink by ≥ 25% (so the
  journal tracks retention instead of growing forever, without rewriting on
  every trim). A9 hash chaining still verifies over the retained tail.

#### `nlp.identify_language` / `nlp.tokenize` / `nlp.extract_entities`
- **Params**: `{ text: string }`
- **Returns**:
  - `identify_language` → `{ language: string | null, backend }` — BCP-47/ISO code of the dominant language (`null` if undetermined).
  - `tokenize` → `{ tokens: string[], backend }` — word-level tokens.
  - `extract_entities` → `{ entities: [{ text, kind, byte_range }], backend }`.
- `backend` is `"apple"` (macOS NaturalLanguage) or `"fallback"` (pure-Rust: `whatlang` + UAX #29 + a proper-noun heuristic). The fallback reports `kind: "entity"` (no person/place/org classification); Apple reports the typed category. Stateless (EPIC F / F4).
- FFI: also exposed as free functions `nlpIdentifyLanguage`/`nlpTokenize`/`nlpExtractEntities` (NAPI) and `nlp_identify_language`/`nlp_tokenize`/`nlp_extract_entities` (PyO3), which run the backend in-process.

#### `metrics.summary`
- **Params**: `null`
- **Returns**: a `MetricsSummary` — `total_events`, `actions_succeeded` /
  `actions_failed` / `actions_rejected`, `success_rate` / `error_rate`,
  `cost_usd` (fold over the retained window), `cumulative_cost_usd`
  (monotonic lifetime spend — survives retention trims), `tokens_in` /
  `tokens_out`, `avg_latency_ms`, `approvals_recorded` (every durable human
  decision) / `approvals_rejected` (the subset that were rejections — so a
  consumer can compute the disagreement rate rather than seeing approvals and
  rejections folded into one number), `permission_decisions`,
  `gate_rejections`, `policy_violations`,
  `goal_evaluations`, `goals_met`, `goals_ungrounded`, and `cost_by_agent`
  (G3). The live operational rollup for a host dashboard (EPIC G / G1).

#### `metrics.alerts`
- **Params**: `AlertThresholds` (all optional): `max_cost_usd`,
  `max_error_rate` (0..1), `max_avg_latency_ms`, `max_goals_ungrounded`,
  `min_actions` (default 5 — the error-rate alert is suppressed below this many
  actions).
- **Returns**: `{ summary, alerts }` where each alert is
  `{ kind, message, observed, threshold }` (`kind` ∈ `cost_overage` /
  `error_rate` / `latency` / `goal_ungrounded`). Fired alerts are also written
  to the operational log (`tracing::warn target=car::alerts`). A synthetic cost
  overage fires the `cost_overage` alert (EPIC G / G1).
- The `max_cost_usd` budget is checked against the summary's **monotonic**
  `cumulative_cost_usd` counter (maintained at append time), not the
  windowed `cost_usd` fold — a retention trim can never slide the counter
  backward and un-fire an already-tripped budget alert.
- `max_goals_ungrounded` is checked against `summary.goals_ungrounded`, so a
  monitor can fail loud when a goal condition was met through ungrounded
  evidence instead of CAR's deterministic runtime receipts.


{% endraw %}
