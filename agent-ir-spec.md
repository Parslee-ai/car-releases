# Agent IR Specification

The **Agent Intermediate Representation** is the contract between models and the Common Agent Runtime. Models propose IR; the runtime validates and executes. Everything in this document is a stable wire-format guarantee — these shapes round-trip through the FFI bindings (NAPI, PyO3) and the WebSocket protocol unchanged.

> Source of truth: [`car-rs/crates/car-ir/src/`](../car-rs/crates/car-ir/src/). If this document drifts from the Rust types, the Rust types win — file a bug.

---

## ActionProposal

A batch of actions submitted to the runtime in one verify-then-execute round.

```jsonc
{
  "id": "abc123def456",                // optional; auto-generated if absent
  "source": "claude-opus-4-7",         // optional; defaults to "unknown"
  "timestamp": "2026-05-02T12:00:00Z", // optional; defaults to now
  "actions": [ /* see below */ ],
  "context": {                         // optional; freeform
    "rationale": "User asked for a deploy",
    "session_id": "..."
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | no | 12 hex chars from a UUIDv4 if omitted |
| `source` | string | no | who produced this proposal (model id, agent name) |
| `timestamp` | RFC3339 | no | when it was produced |
| `actions` | `Action[]` | **yes** | non-empty for the proposal to be useful |
| `context` | object | no | passed through to event log; not interpreted |

---

## Action

A single unit of agent intent. Actions form a DAG via `state_dependencies`; independent actions execute concurrently.

```jsonc
{
  "id": "a1",                              // optional; auto-generated
  "type": "tool_call",                     // required: see ActionType
  "tool": "deploy",                        // required when type == "tool_call"
  "parameters": { "env": "staging" },      // tool-specific
  "preconditions": [
    { "key": "tests_passed", "operator": "eq", "value": true }
  ],
  "expected_effects": { "deployed": true },
  "state_dependencies": ["build_artifact"],
  "invocation_mode": "one_shot",          // default; "streaming" / "long_running" detach
  "idempotent": true,
  "max_retries": 3,                        // default 3
  "failure_behavior": "retry",             // default "abort"
  "timeout_ms": 30000,
  "metadata": { "rationale": "..." }
}
```

### Field reference

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | string | no | UUID-derived | unique within the proposal |
| `type` | `ActionType` | **yes** | — | see below |
| `tool` | string | conditional | — | required when `type == "tool_call"` |
| `parameters` | object | no | `{}` | passed verbatim to the tool callback |
| `preconditions` | `Precondition[]` | no | `[]` | all must hold; otherwise action skipped per `failure_behavior` |
| `expected_effects` | object | no | `{}` | claimed state changes — used by verify/simulate to model the action without running it |
| `state_dependencies` | string[] | no | `[]` | state keys this action reads; informs DAG ordering |
| `read_set` | string[] | no | `[]` | explicit transactional **read set** (survey §5.2.4). When empty, derived from `state_dependencies` + assumption keys. Used by `transaction_check` to detect read-write hazards and stale reads across concurrent actions/agents |
| `write_set` | string[] | no | `[]` | explicit transactional **write set**. When empty, derived from `expected_effects` (+ a `state_write`'s `key` param). Used to detect write-write races |
| `assumptions` | `StateAssumption[]` | no | `[]` | assumptions about shared state this action did not produce — each `{ key, expected_value?, read_version? }`. A stale `read_version` (state moved past it) or mismatched `expected_value` is flagged by `transaction_check` as belief divergence |
| `invocation_mode` | `ToolInvocationMode` | no | `"one_shot"` | how a `tool_call` runs: `"one_shot"` (dispatch awaits the result inline — unchanged default), or a detached mode (`"streaming"` / `"long_running"`) where dispatch *starts* the tool, returns `{ tool_handle, status: "running" }` as the action's output, and the DAG proceeds without blocking. Chunks/status are consumed via the handle (`tools.poll` / `tools.cancel` / `tools.stream.subscribe` on the WS, `toolPoll`/`tool_poll` + `toolCancel`/`tool_cancel` in the FFI). Detached results bypass the result cache AND the idempotency cache (a handle is a live invocation — deduping would return a stale handle instead of starting the tool) but stay rate-limited; `timeout_ms` bounds only the `execute_stream` startup, not the stream itself; requires a configured tool executor implementing `execute_stream` (the daemon's WS-callback executor does not yet — see the support-status note in `docs/websocket-protocol.md`). Ignored for non-`tool_call` actions |
| `idempotent` | boolean | no | `false` | enables result caching and safe retry |
| `max_retries` | u32 | no | `3` | only consulted when `failure_behavior == "retry"` |
| `failure_behavior` | `FailureBehavior` | no | `"abort"` | see below |
| `timeout_ms` | u64 | no | unbounded | tool-call timeout |
| `metadata` | object | no | `{}` | not interpreted by the runtime |

### `type` — ActionType

Snake-case enum:

| Value | Meaning |
|-------|---------|
| `"tool_call"` | invoke a registered tool with `parameters` |
| `"state_write"` | set state keys directly (no tool dispatch) |
| `"state_read"` | read state keys; populate downstream actions |
| `"assertion"` | check that a state predicate holds — fail the proposal if not |

### `failure_behavior` — FailureBehavior

Snake-case enum. What happens when this action's tool returns an error or a precondition fails:

| Value | Meaning |
|-------|---------|
| `"abort"` (default) | stop the proposal; downstream actions not executed |
| `"retry"` | retry up to `max_retries` times before aborting |
| `"skip"` | mark this action skipped and continue with the rest |

### Action lifecycle (informational)

The runtime tags each action with an `ActionStatus` as it moves through validation and execution:

```
Proposed → Validated → Executing → Succeeded
                    ↘ Rejected
                                  ↘ Failed
                                  ↘ Skipped
```

`ActionStatus` is observable through the event log, not part of the input contract.

---

## Precondition

A state predicate that must hold before the action runs.

```jsonc
{ "key": "tests_passed", "operator": "eq", "value": true, "description": "" }
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `key` | string | **yes** | — | state key to evaluate |
| `operator` | string | no | `"eq"` | see operator table |
| `value` | any JSON | depends | `null` | compared per the operator |
| `description` | string | no | `""` | human-readable; surfaced in errors |

### Operator reference

| Operator | Semantics | `value` required? |
|----------|-----------|------------------|
| `eq` | `state[key] == value` | yes |
| `neq` | `state[key] != value` | yes |
| `gt`, `lt`, `gte`, `lte` | numeric ordered comparison; both must be numbers | yes |
| `exists` | `key` is present in state | no |
| `not_exists` | `key` is absent from state | no |
| `contains` | substring match (string) or membership (array) | yes |

Numeric operators silently return `false` if either side fails to coerce to `f64`.

---

## ToolSchema

Registered when a tool is added to the runtime. Carries everything the runtime needs to validate, cache, and rate-limit calls.

```jsonc
{
  "name": "deploy",
  "description": "Deploys an artifact to a target environment.",
  "parameters": {
    "type": "object",
    "properties": {
      "env": { "type": "string", "enum": ["staging", "prod"] }
    },
    "required": ["env"]
  },
  "returns": { "type": "object" },
  "idempotent": true,
  "cache_ttl_secs": 60,
  "rate_limit": { "max_calls": 5, "interval_secs": 60.0 }
}
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `name` | string | **yes** | — | unique within a runtime |
| `description` | string | no | `""` | human-readable; included in tool catalog |
| `parameters` | JSON Schema | no | `{}` | validated by the runtime before dispatch |
| `returns` | JSON Schema | no | none | validated against tool return value when set |
| `idempotent` | boolean | no | `false` | enables cache + retry safety at the runtime level |
| `cache_ttl_secs` | u64 | no | none | when set, results are cached for this duration |
| `rate_limit` | `ToolRateLimit` | no | none | `{ max_calls, interval_secs }` |

---

## CostSummary, CostTarget, CostBudget

`CostSummary` is the post-execution accounting attached to every `ProposalResult`:

```jsonc
{
  "tool_calls": 3,
  "actions_executed": 5,
  "actions_rejected": 2,
  "actions_skipped": 1,
  "total_duration_ms": 1240.0,
  "retries": 0
}
```

| Field | Counts |
|-------|--------|
| `actions_executed` | actions that actually ran — `succeeded` **plus** `failed`. A failed action invoked its tool and the tool errored, so it consumed real work. |
| `actions_rejected` | actions blocked **before** execution, by the validator (unknown tool, unsatisfied dependency) or by policy. Nothing ran. |
| `actions_skipped` | actions never attempted because an earlier action aborted the run or a cost budget was exhausted. |

`actions_rejected` is new (Parslee-ai/car#624). Before it, rejections were counted in
`actions_executed`, so a proposal where every action was blocked still reported
"N actions executed" with `tool_calls: 0`. Readers should treat the field as
optional (`serde(default)`) — a summary produced by an older CAR omits it.

`CostTarget` is the **soft** scoring target used by `car-planner` to rank candidate proposals. Default values:

```jsonc
{
  "target_tool_calls": 5,
  "target_duration_ms": 5000.0,
  "target_actions": 10,
  "cost_weight": 0.2
}
```

`cost_weight` is in `[0.0, 1.0]`. Score is computed as
`success_likelihood * (1 - cost_weight) + cost_efficiency * cost_weight`.

`CostBudget` (in `car-engine`) is the **hard** counterpart — proposals that exceed it are rejected at verification time. See `verify`'s `max_actions` parameter for the canonical entry point.

---

## ProposalResult

Returned by `proposal.submit` (WebSocket), `executeProposal` (NAPI), `execute_proposal` (PyO3).

```jsonc
{
  "proposal_id": "abc123def456",
  "results": [
    {
      "action_id": "a1",
      "status": "succeeded",
      "output": { "deployed": true },
      "error": null,
      "state_changes": { "deployed": true },
      "duration_ms": 1230.0,
      "timestamp": "2026-05-02T12:00:01Z"
    }
  ],
  "cost": { "tool_calls": 1, "actions_executed": 1, "actions_rejected": 0, "actions_skipped": 0, "total_duration_ms": 1230.0, "retries": 0 }
}
```

`status` is one of: `"proposed"`, `"validated"`, `"rejected"`, `"executing"`, `"succeeded"`, `"failed"`, `"skipped"`.

---

## Verification result

Returned by `verify` (FFI standalone, WebSocket `verify`).

```jsonc
{
  "valid": true,
  "issues": [
    { "action_id": "a1", "severity": "warning", "message": "expected_effects mentions key not in any tool's schema" }
  ],
  "simulated_state": { "deployed": true },
  "execution_levels": [["a1"], ["a2", "a3"]],
  "conflicts": [["a2", "a3", "deployed"]]
}
```

| Field | Notes |
|-------|-------|
| `valid` | `false` if any issue has severity `"error"` |
| `issues` | flat list; severity ∈ `"error"` / `"warning"` / `"info"` |
| `simulated_state` | post-execution state if the proposal ran with no failures |
| `execution_levels` | DAG layered topological order — actions in the same layer are independent |
| `conflicts` | triples `(action_a, action_b, state_key)` where two actions write the same key without ordering |

### What `verify` detects

| Category | Detection |
|----------|-----------|
| Impossible plans | preconditions that no action provides |
| Missing dependencies | state keys read but never written |
| Write conflicts | unordered actions writing the same key |
| Infinite loops | duplicate identical tool calls |
| Resource exhaustion | proposals exceeding `max_actions` |
| Missing tools | `tool_call` referencing a tool not registered |

`simulate` (also in `car-verify`) returns just the post-state. `equivalent(p1, p2, test_states)` returns `true` if both proposals produce the same final state across every *supplied* test state — two trivial defaults (`{}` and `{x:1,y:2}`) when you pass none. It samples; it does not decide equivalence over all starting states, and two proposals writing different values to a key no probe state reaches will compare equal. `optimize` prunes phantom `state_dependencies` so independent actions can land in the same DAG level; it does not reorder actions.

### `verify` and `simulate` treat blocked actions differently — on purpose

Both walk the DAG applying `expected_effects`, but they diverge on an action that **cannot run** — one whose preconditions fail, or whose state dependencies aren't available:

| | Blocked action's effects | Why |
|---|---|---|
| `verify` | **applied anyway** | It reports every problem in one pass. Withholding effects would bury the real findings under a cascade of knock-on "dependency not available" issues that are artifacts of the first failure, not independent defects. |
| `simulate` | **skipped** | It predicts what the executor leaves behind, and the executor rejects such an action *before* dispatch (`ActionStatus::Rejected`), so its effects never land. |

Under `simulate`, downstream actions then find their own dependencies missing and drop out in turn, so the cascade follows the data dependencies exactly as it does at runtime.

`simulate` models per-action gating, not `failure_behavior`. An *independent* action alongside a blocked one still contributes its effects, whereas the executor's default `FailureBehavior::Abort` may stop the run before reaching it. Read the result as "the state assuming execution proceeds as far as the dependency graph allows" — never as a claim that a provably-blocked action ran.

`simulate` used to share `verify`'s optimism, so it reported `deployed: true` for a deploy gated on a `tests_passed` precondition that provably could not hold (Parslee-ai/car#622). `equivalent` compares `simulate` output and inherited the same flaw — two proposals differing only in a gate gating one of them read as equivalent.

---

## Policies

Policies are runtime guardrails registered via `register_policy` (FFI) or `session.init` (WebSocket). Every action passes through every policy before execution; any non-empty return blocks the action with that string as the reason.

### Built-in policy rules

CAR ships four rule types that cover the common cases without needing a custom callback:

#### `deny_tool`
Reject any action whose `tool` matches `target`.

```typescript
rt.registerPolicy('no_shell', 'deny_tool', 'shell');
```

| Param | Required | Notes |
|-------|----------|-------|
| `target` | yes | tool name to deny |

#### `deny_tool_param`
Reject any action where `tool == target` AND parameter `key` contains `pattern` (substring match on the string-coerced value).

```typescript
rt.registerPolicy('no_rm_rf', 'deny_tool_param', 'shell', 'command', 'rm -rf');
```

| Param | Required | Notes |
|-------|----------|-------|
| `target` | yes | tool name to gate |
| `key` | yes | parameter name |
| `pattern` | yes | substring that triggers denial |

#### `require_state`
Reject any action unless `state[key] == value`. Use to enforce ordering or feature flags.

```typescript
rt.registerPolicy('require_tests', 'require_state', null, 'tests_passed', null, 'true');
```

| Param | Required | Notes |
|-------|----------|-------|
| `key` | yes | state key |
| `value_json` | yes | required JSON value, encoded as a string |

#### `deny_tool_callback` (NAPI only)
Reject when a JS callback returns truthy. Requires `registerAgentRunner` to have stored the callback first. Use sparingly — synchronous policy callbacks are a hot-path cost.

| Param | Required | Notes |
|-------|----------|-------|
| `target` | yes | tool name to gate |

### Policy violations

When a policy denies an action, the runtime emits a `PolicyViolation`:

```jsonc
{ "policy_name": "no_rm_rf", "action_id": "a3", "reason": "param 'command' matches denied pattern 'rm -rf'" }
```

The proposal then proceeds per the action's `failure_behavior` — `"abort"` halts everything, `"skip"` continues, `"retry"` is treated as `"abort"` (retrying a denied action would loop).

### Inspector chain (advanced)

For dispatch-time guardrails — egress filtering, repetition detection, adversary review — `car-policy::inspectors` provides a short-circuiting `InspectorChain`. Inspectors evaluate `(tool_name, params)` and return `Allow` / `Deny(reason)`. Stops on first deny. This is a separate mechanism from the action-level policies above and runs at tool dispatch, not action validation.

---

## Stability guarantees

- **Field additions are non-breaking** — clients ignore unknown fields. CAR will add fields as capabilities grow.
- **Operator additions are non-breaking** — new precondition operators may appear; older runtimes treat unknown operators as failed checks.
- **Field removals are breaking** — any deprecation will go through CHANGELOG and a major version bump.
- **Default value changes are breaking.** Defaults appearing in this document are stable.

---

## Streaming / long-running tool contract (`car-ir/src/tool_stream.rs`)

Classic tool dispatch is one-shot: the executor awaits a single
`Result<Value, String>`. The streaming contract (EPIC C) describes tools
that produce output incrementally or run longer than a single request. All
types are `snake_case` on the wire and round-trip across every binding.

- **`ToolInvocationMode`** — capability marker: `one_shot` (default,
  unchanged behavior), `streaming`, `long_running`.
- **`ToolHandle { id }`** — opaque handle returned when a detached tool is
  started; passed back to poll / observe / cancel.
- **`ToolStreamChunk`** (tagged by `kind`): `text { text }`,
  `data { data }`, `progress { fraction, message? }`, `done { result? }`
  (terminal), `error { message }` (terminal).
- **`ToolControl`** — `poll` or `cancel` (cooperative).
- **`ToolStatus`** — `running` / `succeeded` / `failed` / `cancelled`.
- **`ToolStreamEvent { handle, chunk }`** — handle-tagged envelope streamed
  to a client.

Shape: **start → handle → (poll | stream chunks) → cancel**. C2 wires it
end-to-end: `Action.invocation_mode` selects a detached mode, the executor
starts the tool and returns `{ tool_handle, status: "running" }` as the
action's output (the DAG proceeds), and the handle is driven via the daemon's
`tools.poll` / `tools.cancel` methods and the `tools.stream.subscribe` →
`tools.stream.event` notification stream (see `docs/websocket-protocol.md`),
or the FFI `toolPoll`/`tool_poll` + `toolCancel`/`tool_cancel` proxies.
`tools.poll` returns a `ToolPollResult` `{ handle, tool, action_id, status,
chunks, result?, error? }` — chunks drain per poll; the terminal status is
observable at least once, after which the handle is consumed (`null`).

## Where to look in the source

| Concern | File |
|---------|------|
| `Action`, `ActionProposal`, `ActionResult` | `car-rs/crates/car-ir/src/actions.rs` |
| Streaming / long-running tool contract | `car-rs/crates/car-ir/src/tool_stream.rs` |
| `Precondition` operators | `car-rs/crates/car-ir/src/precondition.rs` |
| DAG ordering / `state_dependencies` resolution | `car-rs/crates/car-ir/src/dag.rs` |
| `verify`, `simulate`, `equivalent`, `optimize` | `car-rs/crates/car-verify/src/lib.rs` |
| `PolicyEngine`, built-in rules | `car-rs/crates/car-policy/src/lib.rs`, `car-rs/crates/car-ffi-napi/src/lib.rs` (rule dispatch) |
| Tool dispatch / DAG executor | `car-rs/crates/car-engine/src/lib.rs` |
