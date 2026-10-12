{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### events / replan

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

#### `events.clear`
- **Params**: `null`
- **Returns**: `{ removed, stats }`
- **Destructive and unconditional** — drops the entire session event log, including the audit trail `events.query` reads and any hash chain `events.chain.enable` established. There is no undo and no confirmation. Prefer `events.truncate` or `events.retention` when you only need to bound growth.

#### `events.query`
- **Params**: an `EventQuery` object — all fields optional, AND-conjoined:
  - `kinds` (array of `EventKind`) — restrict to these kinds (empty = any).
  - `action_id` / `proposal_id` (string) — exact match.
  - `since` / `until` (RFC3339 timestamp) — inclusive lower / exclusive upper time bound.
  - `data_matches` (`{ key: value }`) — match events whose `data` contains all
    these string pairs (covers `caller`/`tenant`/`tool`/`gate`/`decision`).
  - `limit` (u64) — cap results (most-recent-first). Omit/0 = unlimited.
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
- **Params**: `{ policy?: { max_events?, max_age_secs? } }`
  - With `policy`: installs it and immediately enforces the age bound;
    `max_events` is then also enforced automatically on every append.
  - Without `policy`: returns the current policy.
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
