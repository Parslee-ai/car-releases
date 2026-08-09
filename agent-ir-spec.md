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

No proposal-level `reversibility` field exists, and that is deliberate — the
rollback contract belongs to an action, not to a batch. What a caller usually
wants is the batch's *derived* contract, `ActionProposal::rollback_contract()`:
the **worst** `reversibility` any of its actions declares, since a plan is only
as recoverable as its least recoverable step and partial execution is a real
outcome. An empty batch is `"reversible"` rather than the `"irreversible"`
default, because "there is nothing to undo" is a different statement from "the
author did not say". It surfaces on the wire as `permission.classify`'s
`declared_rollback_contract` (see `docs/websocket-protocol.md`); note that it
reads the **declared** IR fields, not `car-policy`'s classifier, so a proposal
written before this axis existed reports `"irreversible"` for every action.

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
  "reversibility": "compensable",          // default "irreversible"; can this be undone?
  "compensation": {                        // required in spirit when "compensable"
    "type": "tool", "tool": "rollback_deploy", "parameters": { "env": "staging" }
  },
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
| `reversibility` | `Reversibility` | no | `"irreversible"` | the **rollback contract** for this action's effects — orthogonal to the permission tier, which answers *who may authorize this*. See below; note the conservative default |
| `compensation` | `Compensation` | no | absent | how to undo the action once it has run. Meaningful only when `reversibility == "compensable"`; omitted from the serialized form when absent. See below |
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

### `reversibility` — Reversibility

Snake-case enum. Answers **can this be undone?** — a separate axis from the
permission tier (`read_only` / `sandbox_edit` / `full_access`), which answers
*who may authorize this*. The two were conflated until this field existed:
`full_access` is documented as "externally-consequential **or** irreversible",
which puts a `git push` (recoverable by force-pushing the prior ref) and a
charged card (not recoverable at all) on the same rung.

| Value | Meaning |
|-------|---------|
| `"reversible"` | undone by restoring the scope the action ran in — state writes, sandboxed filesystem writes. No compensating work needed |
| `"compensable"` | undone only by running a compensating action — a DB `INSERT` needs its `DELETE`, a `git push` needs a force-push of the prior ref, a deploy needs a rollback deploy. Should carry a `compensation` |
| `"irreversible"` (default) | cannot be undone once it reaches the world — a sent email, a charged card, `rm -rf` outside a snapshotted tree. Only the gate *before* it runs is a lever |

Two things to know about the default:

- **It is `"irreversible"`, deliberately.** The default is what the runtime
  believes about an *unclassified* action, and the two directions fail
  asymmetrically. Defaulting to `"reversible"` and being wrong means silently
  believing a sent email can be unsent — a safety property failing quietly.
  Defaulting to `"irreversible"` and being wrong means over-asking for approval
  on something recoverable — annoying, visible, and locally fixable by
  annotating the action.
- **Nothing enforces on it yet.** This field is typed, classified, and audited;
  it is not a gate. Deferring the materialization of an irreversible effect
  needs machinery CAR does not have (a checkpoint coupled to the filesystem —
  today rollback restores the state map and leaves what a tool wrote to disk
  where it is). Do not read `"reversible"` as a promise that the runtime will
  undo anything for you.

### `compensation` — Compensation

Tagged by `type`. The action-level analogue of the saga-pattern
`CompensationHandler` `car-workflow` applies per *stage*, restated natively in
the IR (which depends only on serde, uuid, and chrono).

| Variant | Shape | Meaning |
|---------|-------|---------|
| `"tool"` | `{ "type": "tool", "tool": "db.delete", "parameters": { … } }` | invoke a tool that reverses the effect. `parameters` defaults to `{}` |
| `"action_ref"` | `{ "type": "action_ref", "action_id": "undo-a1" }` | run another action from the same proposal, identified by its `id` — use this when one tool call is not enough |

`reversibility == "compensable"` with no `compensation` is representable but
incoherent; `Action::missing_required_compensation()` is the check that flags
it. The pairing is not enforced by the type because `Reversibility` is
deliberately a plain string enum that every binding surface mirrors.

Declaring a compensation is a *claim*, not a proof: nothing in the runtime
checks that the named tool is a true inverse of the action, exactly as nothing
checks `expected_effects`.

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
    {
      "action_id": "a1",
      "severity": "warning",
      "message": "expected_effects mentions key not in any tool's schema",
      "tier": "decision_procedure"          // how the finding was derived
    }
  ],
  "simulated_state": { "deployed": true },
  "execution_levels": [["a1"], ["a2", "a3"]],
  "conflicts": [["a2", "a3", "deployed"]]
}
```

| Field | Notes |
|-------|-------|
| `valid` | `false` if any issue has severity `"error"` |
| `issues` | flat list; severity ∈ `"error"` / `"warning"` / `"info"`, plus `tier` (below) |
| `simulated_state` | post-execution state if the proposal ran with no failures |
| `execution_levels` | DAG layered topological order — actions in the same layer are independent |
| `conflicts` | triples `(action_a, action_b, state_key)` where two actions write the same key without ordering |

### `tier` — EvidenceTier

Snake-case enum on every issue. Names which **kind** of check produced the
finding, so a consumer no longer has to recognise the message string to tell
them apart:

| Value | Meaning |
|-------|---------|
| `"decision_procedure"` | the check *decides* the property it reports over the inputs it was handed — set membership, graph reachability, the STRIPS-style forward walk |
| `"heuristic"` | a proxy signal over complete inputs. In `verify` this is exactly one rule: repeated-identical-call loop detection, where the repeat count is exact but the step from "three identical calls" to "runaway loop" is a guess, so a legitimate 3× poll trips it |
| `"sampled"` | an exact measurement over incomplete inputs — `equivalent`'s probe states, Monte Carlo rollouts. **Does not currently appear on a verification `issue`:** neither of those checks produces one, and their reports (`MonteCarloResult`, `equivalent`) carry no `tier` on the wire. The variant is defined and reachable in Rust; a client should not write a `"sampled"` branch expecting `verify` to emit it. |

Three things it is **not**, all easy to get backwards:

- **Not `severity`.** Severity is how bad the finding would be; the tier is how
  it was derived. They vary independently.
- **Not "does this block".** `car-engine`'s admission gate treats the
  precondition and state-dependency findings as advisory *even though both are
  `decision_procedure`*, because they are decided over a forward model that sees
  only **declared** `expected_effects`. Whether the inputs match runtime is a
  separate axis, carried by the `evidence` bundle's `assumptions` /
  `untested_regions` / per-check `cannot_verify`.
- **Not a ranking.** The Rust `EvidenceTier` derives no `Ord` on purpose — a
  proxy over complete inputs and an exact measurement over incomplete inputs
  fail in different directions, so neither is categorically stronger. Match on
  the value; do not filter down to `decision_procedure`.

`decision_procedure` is not a proof, not a soundness claim, and not a prediction
that the plan will run — there is no solver in this workspace. Older daemons
omit the field.

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
| `Reversibility` / `Compensation` | `car-rs/crates/car-ir/src/reversibility.rs` |
| `Precondition` operators | `car-rs/crates/car-ir/src/precondition.rs` |
| DAG ordering / `state_dependencies` resolution | `car-rs/crates/car-ir/src/dag.rs` |
| `verify`, `simulate`, `equivalent`, `optimize` | `car-rs/crates/car-verify/src/lib.rs` |
| `PolicyEngine`, built-in rules | `car-rs/crates/car-policy/src/lib.rs`, `car-rs/crates/car-ffi-napi/src/lib.rs` (rule dispatch) |
| Tool dispatch / DAG executor | `car-rs/crates/car-engine/src/lib.rs` |
