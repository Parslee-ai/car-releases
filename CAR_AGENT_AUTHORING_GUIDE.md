{% raw %}
# CAR Agent Authoring & Capability Guide

> **Common Agent Runtime (CAR)** — a deterministic execution layer for AI agents.
> *Models propose; the runtime validates and executes.*
> Rust core (56 crates) with bindings for **Node.js (NAPI)**, **Python (PyO3)**, **Swift/Kotlin (UniFFI)**, and a **WebSocket/JSON-RPC server**. Current shipped version: **v0.20.0**.

This guide was assembled by a 49-agent research workflow that read the `car` and `car-releases`
repositories end to end. It is written for two goals:

1. **Create a single agent that runs on CAR** — from hello-world to a closed autonomous loop, packaged and supervised.
2. **Understand everything CAR offers** — every feature, tool, command, protocol method, and runtime capability.

Every API name, CLI flag, and code example below is extracted from the actual source/docs. Where the
source is the only authority (under-documented subsystems), see **Appendix A**.

---

## Table of Contents

1. [CAR in One Page: Mental Model & Architecture](#car-in-one-page-mental-model--architecture)
2. [Installing & Setting Up CAR](#installing--setting-up-car)
3. [Your First Single Agent (Node & Python)](#your-first-single-agent-node--python)
4. [The Agent Loop: Tools & the Callback Pattern](#the-agent-loop-tools--the-callback-pattern)
5. [Building the Autonomous Agent Loop](#building-the-autonomous-agent-loop)
6. [Agent IR, Proposals & Static Verification](#agent-ir-proposals--static-verification)
7. [Policies, Validation, Capabilities & Sandboxing](#policies-validation-capabilities--sandboxing)
8. [Memory, Context Assembly & Skills](#memory-context-assembly--skills)
9. [Inference & Models (Local + Cloud)](#inference--models-local--cloud)
10. [Multi-Agent Coordination, Workflows & Scheduling](#multi-agent-coordination-workflows--scheduling)
11. [WebSocket Server & JSON-RPC Protocol](#websocket-server--json-rpc-protocol)
12. [MCP Integration (CAR as Server + Consuming MCP Tools)](#mcp-integration-car-as-server--consuming-mcp-tools)
13. [Contributed & Portable Agents: Bundles, Registry, Lifecycle & Daemon](#contributed--portable-agents-bundles-registry-lifecycle--daemon)
14. [Agent-to-Agent (A2A) & Agent UI (A2UI)](#agent-to-agent-a2a--agent-ui-a2ui)
15. [Native Capabilities: Voice, Browser, Vision & Apple Frameworks](#native-capabilities-voice-browser-vision--apple-frameworks)
16. [CLI Command Reference](#cli-command-reference)
17. [FFI Bindings API Reference (Node / Python / Swift)](#ffi-bindings-api-reference-node--python--swift)
18. [Cross-Host & Mobile Deployment](#cross-host--mobile-deployment)
19. [Capability Catalog, Cheat Sheet & Next Steps](#capability-catalog-cheat-sheet--next-steps)

A. [Known Documentation Gaps & Author Notes](#appendix-a--known-documentation-gaps--author-notes)

---

## CAR in One Page: Mental Model & Architecture

The Common Agent Runtime (CAR) is a **deterministic execution layer for AI agents**, written in Rust. Its entire thesis fits in one sentence: **models propose; the runtime validates and executes.** CAR is explicitly *not* a framework for building agents — it is the runtime that agents execute *on*. It sits between a model and the tools/state the model wants to touch, turning probabilistic model output into validated, state-aware, auditable execution.

```
model → Agent IR → Common Agent Runtime → tools and state transitions
```

Most agent systems make the model both the source of reasoning *and* the controller of execution — fine for demos, fragile for durable systems. CAR splits those concerns: the model emits intent as **Agent IR**; the runtime decides and executes. That separation is what buys you pre-execution verification, declarative policy enforcement, graph-based memory, first-class skills, concurrent DAG execution, and built-in idempotency/retry/timeout/rollback — none of which the model has to reason about.

### The seven mental-model anchors

Before any code, internalize these seven cross-cutting truths. Everything else in this guide is an elaboration of one of them.

| # | Anchor | Why it changes how you author |
|---|--------|-------------------------------|
| 1 | **Daemon-first is mandatory (v0.8+).** Supported FFI operations are thin WebSocket clients to a singleton `car-server` that must be running first. | Changes install, auth, error handling, *and which methods even exist*. Callback-bearing inference streaming is WebSocket-only; the legacy NAPI/Python streaming symbols always error. |
| 2 | **Three kinds of agent, one runtime.** (1) in-process proposal-driven agents you author against the FFI/IR; (2) lifecycle/supervised contributed agents (`manifest.toml` + `car install` + `agents.*`); (3) external agentic CLIs (Claude Code/Codex/Gemini) discovered and invoked by the daemon. | Authoring surface, packaging, and lifecycle differ completely. Docs treat #1 as the default. |
| 3 | **Four safety layers, not one.** capabilities (allow-list what an agent *can* touch) vs policies (deny rules per action) vs inspectors (hot-path dispatch-time guardrails) vs the high-risk approval gate (AppleScript/Shortcuts/Mail/Messages/Vision OCR park for host approval). | A single secured agent needs all four. **Deny wins; first-Deny short-circuits.** |
| 4 | **Memory is the runtime, not a bolt-on.** Facts (spreading activation), skills (first-class graph nodes with a distill/evolve/repair loop), four-layer context assembly with dynamic budget sizing, and the auto-discovered `.car/` project dir. | The skills loop is what turns a stateless agent into a learning one — and enables skill-first execution (skip the LLM when a learned workflow matches), which FlyX's design note *projects* would cut ~75% of its token cost (a target, not a measurement). |
| 5 | **The IR is the contract that unifies every surface.** `ActionProposal`/`Action` round-trip *identically* across NAPI (camelCase), PyO3 (snake_case), and WebSocket JSON-RPC because of serde `snake_case` enums + `serde(default)`. | Understanding the IR is the prerequisite for verification, execution, planning, workflow stages, and the agent loop. It is the single concept everything builds on. |
| 6 | **verify→execute is only half.** The other half is propose→observe→re-propose. CAR ships the autonomous machinery (active-planner candidate generation, planner scoring, `ReplanCallback`, `AgentOutcome` terminal states, replan config) — but the docs stop at deterministic execution. | A model-driven loop drives the verify/execute primitive *repeatedly* until an `AgentOutcome` is terminal. |
| 7 | **Naming differs by surface.** Rust source is `snake_case`; NAPI auto-converts to `camelCase` at runtime (`state_get` → `stateGet`); Python keeps `snake_case`. | Adjust every identifier in this guide to your language. |

### The thesis pipeline, expanded

The Rust core is a **46-crate workspace** (older prose says 42 — treat 46 as current). It exposes four binding surfaces:

| Surface | Package / entry | Naming | Notes |
|---------|-----------------|--------|-------|
| Node.js (NAPI) | `car-runtime` (npm) | camelCase at runtime | Thin daemon client; bundles `car-server`. |
| Python (PyO3) | `car-runtime` (PyPI, import `car_runtime`) | snake_case | Thin daemon client; **proposal execution NOT exposed in v0.8** — use the WS directly. |
| WebSocket JSON-RPC | `car-server` | — | **73+ methods across 23 namespaces.** The canonical surface. |
| MCP (stdio + HTTP-streamable) | `car-mcp-server` (stdio), the daemon (HTTP) | — | **stdio: stateless** — memory, skill lookup, verify, policy check; no proposal execution. **The daemon endpoint adds `assistant_start`/`assistant_poll`/`assistant_cancel`**, which run the full agent behind a run handle. |

Rust consumers add `car-*` crates from crates.io (35 library crates ship per release). The common starter set:

```toml
# Cargo.toml
[dependencies]
car-engine = "0.8"
car-memgine = "0.8"
car-inference = "0.8"
# common starter set also adds car-ir
```

### Anchor 1 — Daemon-first architecture (the through-line)

As of **v0.8** every FFI binding stopped hosting an in-process engine. Each non-callback method now proxies to the singleton `car-server` daemon over WebSocket via the `car-ffi-common` proxy. **You must start `car-server` once per host before using the Node/Python bindings, or calls fail.**

```bash
car-server --port 9100              # default port, auth on
npx --package=car-runtime car-server
python -m car_runtime.server
# README quickstart elsewhere shows an alternate:
car-server --port 8080
```

The binding **lazy-connects to `ws://127.0.0.1:9100/` on the first call**. The default port is **9100 with auth on**; the README quickstart elsewhere shows **8080** — the port is not fixed, so match the binding's connect URL. Default ports for the full daemon: **WS 9100, UI HTTP 9101, MCP 9102** (A2A is opt-in).

**Auth tokens.** On macOS, `CAR Host.app` (an `LSUIElement` menu-bar app) supervises `car-server` and mints a **per-launch auth token** passed via `--auth-token`. FFI clients read the token file at:

- macOS: `~/.car/auth-token`
- Windows: `%LOCALAPPDATA%\ai.parslee.car\auth-token`

Configuration via `CAR_DAEMON_URL` / `CAR_AUTH_TOKEN` (and the token file above) is what ties install, troubleshooting, cross-host, and the FFI-vs-WS method divergence together. Operational NAPI callbacks use `executeProposal` and `registerAgentRunner`; `inferStream` retains its legacy `ThreadsafeFunction` parameter only as an ABI-compatibility stub and always rejects. All operational inference streaming uses the daemon WebSocket.

> **Gotcha:** Proposal execution with a tool callback is **NOT exposed on the Python FFI** in v0.8. Python consumers must connect to the daemon's WebSocket directly and use `proposal.submit` + a `tools.execute` handler.

### Anchor 5 — The Agent IR (the contract)

The Agent IR is the wire-format contract between models and the runtime, defined in `car-rs/crates/car-ir/`. A model emits an **`ActionProposal`** (a batch of `Action`s); the runtime verifies and executes it and returns a **`ProposalResult`**. All types use `#[serde(rename_all = "snake_case")]` on enums and `#[serde(default)]` on optional fields, so JSON round-trips unchanged across NAPI, PyO3, and the WebSocket protocol. The Rust types are the source of truth; `docs/agent-ir-spec.md` mirrors them.

**`ActionProposal`** (`actions.rs` lines 114–129): `{ id (default short_id), source (default "unknown"), actions: Vec<Action>, timestamp (default now), context }`. **`actions` is the ONLY required field** — it has no `serde(default)`; an empty/absent `actions` array fails deserialization.

**`Action`** (`actions.rs` lines 70–107) — the core unit of agent intent:

| Field | Type / default | Meaning |
|-------|----------------|---------|
| `id` | default short_id (12 hex) | auto-generated if absent |
| `type` → `action_type` | `ActionType` (required) | JSON key is `type` (`#[serde(rename = "type")]`) |
| `tool` | `Option<String>` (skipped if None) | required when `type == tool_call` (enforced by runtime, not serde) |
| `parameters` | `HashMap` (default `{}`) | passed verbatim to the tool callback |
| `preconditions` | `Vec<Precondition>` (default `[]`) | state predicates that must hold first |
| `expected_effects` | `HashMap` (default `{}`) | claimed state changes; feeds verify/simulate **and the DAG** |
| `state_dependencies` | `Vec<String>` (default `[]`) | state keys read; informs the DAG |
| `idempotent` | `bool` (default false) | enables result caching + safe retry |
| `max_retries` | `u32` (default 3) | only consulted when `failure_behavior == retry` |
| `failure_behavior` | `FailureBehavior` (default `abort`) | abort / retry / skip |
| `timeout_ms` | `Option<u64>` (skipped if None → unbounded) | per-attempt timeout |
| `metadata` | `HashMap` (default `{}`) | not interpreted |

**`ActionType`** (snake_case, complete catalog): `tool_call` (invoke a registered tool), `state_write` (set state directly via `parameters.key`/`parameters.value`, no tool dispatch), `state_read`, `assertion` (check a predicate; fail the proposal if false).

**`FailureBehavior`** (default `abort`): `abort` (stop proposal, downstream not executed, **triggers rollback**), `retry` (up to `max_retries` then abort), `skip` (mark skipped, continue). **When a policy denies an action, `retry` is downgraded to `abort`** to avoid looping.

**`Precondition`** `{ key, operator: String (default "eq"), value (default null), description }` — `operator` is a plain string, not an enum. Operators enforced in `precondition.rs::check_precondition`: `eq`, `neq`, `gt`, `lt`, `gte`, `lte` (numeric, both sides coerced via `as_f64`; "cannot compare" on failure — never throws), `exists`, `not_exists`, `contains`. **Unknown operators are treated as a FAILED check** (forward-compat, intentional).

**Minimal valid proposal** — `actions` array, each action with at least `type`; a `tool_call` also needs `tool` + `parameters`:

```jsonc
{
  "id": "abc123def456",                // optional; auto-generated if absent
  "source": "claude-opus-4-7",         // optional; defaults to "unknown"
  "actions": [
    {
      "id": "a1",                          // optional; auto-generated
      "type": "tool_call",                 // required: see ActionType
      "tool": "deploy",                    // required when type == "tool_call"
      "parameters": { "env": "staging" },
      "preconditions": [
        { "key": "tests_passed", "operator": "eq", "value": true }
      ],
      "expected_effects": { "deployed": true },
      "state_dependencies": ["build_artifact"],
      "idempotent": true,
      "max_retries": 3,                    // default 3
      "failure_behavior": "retry",         // default "abort"
      "timeout_ms": 30000
    }
  ],
  "context": { "rationale": "User asked for a deploy" }
}
```

**`ProposalResult`** `{ proposal_id, results: Vec<ActionResult> (default []), cost: CostSummary }` with helpers `all_succeeded() -> bool` and `summary() -> HashMap<ActionStatus, usize>`. `cost` has `serde(default)` for backward compat. Each **`ActionResult`** is `{ action_id, status: ActionStatus, output, error, state_changes, duration_ms, timestamp }`. **`ActionStatus`** lifecycle (snake_case, observable via event log, not part of the input contract): `proposed → validated → executing → succeeded`, with branches to `rejected`, `failed`, `skipped`. **`CostSummary`** `{ tool_calls, actions_executed, actions_skipped, total_duration_ms, retries }` (all default 0).

**Cost: soft vs hard.** `CostTarget` (in `car-ir`: `target_tool_calls: 5`, `target_duration_ms: 5000.0`, `target_actions: 10`, `cost_weight: 0.2`) is the **soft** scoring target used by the planner. `CostBudget` (in `car-engine`, *not* `car-ir`: `max_tool_calls`/`max_duration_ms`/`max_actions`) is the **hard** counterpart — proposals exceeding it are rejected.

**Built-in tool schemas.** `car_ir::builtins` provides 11 `ToolSchema` definitions (schemas *only* — the runtime does not implement them; you still supply the executor): `shell`, `read_file`, `edit_file`, `write_file`, `find_files`, `grep_files`, `list_dir`, `http_request`, `calculate`, `search`, `browser`. `builtins::all()` returns all 11. A twelfth schema, `builtins::messaging_send()`, is deliberately **not** in `all()`: unlike the eleven, the runtime *does* execute it — but only when a `MessageSink` is attached, so `Runtime::with_message_sink` registers the schema and the sink together and a tool the runtime cannot execute is never advertised to a model.

### Anchor 6 — verify → execute → re-propose (the loop)

CAR's defining move is **checking a plan is satisfiable before calling any tool.** The deterministic half (`car-engine`) and the autonomous half (replan) compose into one loop.

**Static verification (`car-verify`)** — four standalones:

```typescript
const result = verify(proposalJson, '{"env": "staging"}');  // { valid: bool, errors: [...] }
const finalState = simulate(proposalJson, '{"x": 1}');        // computes final state
const isEquiv = equivalent(planA, planB);                     // are two plans equivalent
const optimized = optimize(proposalJson);                     // returns an optimized proposal
```

`verify()` detects: impossible plans (unsatisfiable preconditions), missing dependencies (state keys no prior action provides), write conflicts (two actions writing one key without ordering), infinite loops (duplicate identical tool calls), resource exhaustion, and missing tools. **`verify(...names...)` is existence-only;** since v0.18, `verify_with_schemas(...)` (and `verifyProposal` with an optional `toolSchemasJson`) validates `tool_call` parameters against the registered `ToolSchema` map — property types (incl. union/integer) and required presence.

**The runtime loop** (`car-engine`'s `Runtime`, documented in `lib.rs`): (1) receive a proposal; (2) build a DAG from `state_dependencies`; (3) execute each level (concurrent if no ABORT actions, sequential otherwise); (4) validate, execute with idempotency + timeout + retry, commit; (5) **on abort, roll state back to the pre-proposal snapshot.**

**DAG execution.** `build_dag(&actions) -> Vec<Vec<usize>>` (Kahn's algorithm) returns topological levels of action indices. Within a level, actions run **concurrently** via `futures::future::join_all` — *unless* the level has length 1 or contains any `FailureBehavior::Abort` action, in which case it runs sequentially. Levels always run sequentially.

```rust
let levels = build_dag(&proposal.actions);
for level in &levels {
    let has_abort = level.iter()
        .any(|&i| proposal.actions[i].failure_behavior == FailureBehavior::Abort);
    if level.len() == 1 || has_abort {
        for &idx in level { /* sequential */ }
    } else {
        let futs: Vec<_> = level.iter().map(|&idx| self.process_action(...)).collect();
        let level_results = futures::future::join_all(futs).await;  // concurrent
    }
}
```

> **DAG ordering gotcha:** a dependency edge only forms when the **writer of a key appears EARLIER in the `actions` array** (`writer_idx < consumer_idx`). A consumer listing a `state_dependency` on a key written by a *later* action gets no edge and may run before its writer. `expected_effects` uses **last-writer-wins**.

**Per-action pipeline** (`process_action_inner`), in fixed order: idempotency cache check (hit short-circuits) → **capability check** → `validate_action` → **policy check** (global `PolicyEngine` + optional session `PolicyEngine`; both must pass) → `execute_with_retry` → cache idempotent successes.

**Retry + timeout.** Retries fire only for `FailureBehavior::Retry` (`max_attempts = max_retries + 1`). Backoff = `RETRY_BASE_DELAY_MS(100) * RETRY_BACKOFF_FACTOR(2)^(attempt-1)` ms. Each attempt may be wrapped in `tokio::time::timeout(action.timeout_ms)`.

**ToolCall dispatch precedence** (fixed) — result cache → rate limiter → built-in inference tools (`infer`/`infer.grounded`/`embed`/`classify`/`transcribe`/`synthesize`, auto-grounded from memgine) → built-in `memory.consolidate` → built-in `messaging.send` (only when a `MessageSink` is attached; with no sink it is an error, never a fall-through) → the configured `tool_executor` → `agent_basics` → `Err("no handler for tool '...'")`. The configured executor falls through to `agent_basics` **only** when it returns an error whose message starts with exactly `"unknown tool"`.

**Abort & rollback.** When an `Abort` action returns `Failed`, downstream actions become `Skipped` and `state.restore(snapshot, transition_count)` rolls state back to the pre-proposal snapshot, logging `StateSnapshot` + `StateRollback` and **clearing idempotency-cache entries** for rolled-back idempotent successes so they re-run next time. Rollback fires **only on abort** — not on Skip/Retry failures.

**Replan (the autonomous half).** If a `ReplanCallback` is registered and `ReplanConfig.max_replans > 0`, `execute` catches an abort, rolls back, builds a `ReplanContext` (failed actions, completed ids, state snapshot, attempt, remaining), optionally sleeps `delay_ms`, calls `callback.replan(&ctx)` for a *new* `ActionProposal`, optionally verifies it (`verify_before_execute`), and re-executes. **Default `ReplanConfig` = `{ max_replans: 0 (disabled), delay_ms: 0, verify_before_execute: true }`.** Replanning only triggers on abort.

**Terminal outcomes (`AgentOutcome`, `car-ir/outcome.rs`).** A model-driven loop drives verify/execute repeatedly until an `AgentOutcome` is terminal: `{ status: OutcomeStatus, summary, evidence: Vec<Evidence>, metrics: OutcomeMetrics, timestamp }`. `OutcomeStatus` (snake_case): `success`, `partial_success`, `give_up`, `timeout`, `failure`, `done`. **All statuses are `is_terminal()`;** `is_completed()` is true for success/partial_success/done. `EvidenceKind`: `self_assessment`, `tool_result`, `state_change`, `external_verification`, `stop_reason`, `evaluator`. Constructors: `success()`, `failure()`, `timeout(summary, turns, max_turns)`, `give_up(reason)`.

**Run-trace lifecycle (the harness brackets every run).** The canonical Node harness (`car-loop.mjs`, shipped by the create-car-agent skill) wraps each `runAgent` invocation in a **run** so CarHost can trace it end-to-end — the intent it was given, every turn's prompt/CLI-outcome/verifier-verdict, and the final `AgentOutcome`. Capture is daemon-side and generic (no per-agent code); the harness only marks the run's boundaries:

- **Open.** Before the first proposal, the harness calls `rt.runsStart(JSON.stringify({ intent, agent_id, agent_name, outcome_description }))` and **awaits** the ack to obtain `{ run_id }`. The daemon mints a durable `run_id` and tags it as the session's current run *before replying*, so the per-turn recorder reads the right id. `intent` is the goal the agent was given; `agent_id` resolves from `CAR_AGENT_ID` (injected by the supervisor) when supervised, else falls back to `config.agentName` for the unsupervised one-shot / `run_scenarios.py` path; `outcome_description` comes from `config.targetOutcome` when present, else `''`.
- **Close.** After the terminal `AgentOutcome` is assembled and **before `runAgent` returns**, the harness calls `rt.runsComplete(JSON.stringify({ run_id, outcome }))` and awaits the ack (the connection may close right after), so a healthy run is never raced into `Incomplete`.
- **Graceful degradation.** Both calls are wrapped in `try/catch` exactly like `registerAgentBasics` — a daemon **without** the `runs.*` methods (an older build) makes them throw, the harness swallows it, and the run proceeds unchanged. Neither call ever writes to stdout, so the **last** stdout line in `--json` mode stays the `AgentOutcome` JSON (`run_scenarios.py` depends on this contract).
- **One run per `runAgent`.** In `--serve` mode each iteration is its own run on its own fresh `CarRuntime`/connection — its own `runsStart`/`runsComplete` bracket. Two sequential standing-goal runs produce two distinct `run_id`s.

This is a deliberate evolution of the canonical template, not a per-agent fork: edit it in the skill (`.claude/skills/create-car-agent/assets/templates/node/car-loop.mjs`), never in a generated `agent.mjs` — generated agents inherit it on their next harness sync. See `runsStart` / `runsComplete` in `car-ffi-napi/npm/index.d.ts` for the exact request/response shapes.

### Anchor 3 — The four safety layers (deny wins, first-Deny short-circuits)

| Layer | What it does | Surface |
|-------|--------------|---------|
| **Capabilities** | Allow-list what an agent *can* touch — `CapabilitySet` gates tools, state keys, max action count; `set_capabilities(...)`. | `AuthzPipeline` |
| **Policies** | Deny rules evaluated per action — `register_policy(name, type, tool, param, value)`. | `PolicyEngine` (`car-policy`) |
| **Inspectors** | Hot-path dispatch-time guardrails — egress / repetition / adversary. | `InspectorChain` |
| **High-risk approval gate** | AppleScript/Shortcuts/Mail/Messages/Vision OCR park until host approval. | host approval |

Policy rule types (named inconsistently across docs): README lists `deny_tool`, `deny_tool_param`, `require_state`, `max_calls_per_tool`; `llms.txt` lists `deny_tool`, `deny_tool_param`, `require_state`, `deny_tool_callback`.

```typescript
await rt.registerPolicy('no_rm', 'deny_tool_param', 'shell', 'command', 'rm -rf');
```

**`registerPolicy` is global per `CarRuntime` instance** — there is no per-session policy scoping on the FFI yet. For multi-tenant/IDE hosts, spin up **one `CarRuntime` per tenant/session** (per-runtime isolation is the supported pattern). The engine *does* support per-session scoping internally (`open_session()` → `register_policy_in_session(...)` → `execute_with_session(...)`); session policies are **conjunctive (additive deny only)** — a session can deny what global allows but cannot allow what global denies, and an unknown session id rejects every action.

Tool identity itself is governed by `ToolPermission` = `Allow | AskUser (default) | Deny` in the canonical `ToolRegistry`. `ToolEntry::new` defaults `source = UserDefined`, `side_effects = true`; `ToolEntry::builtin` sets `permission = Allow`, `source = Builtin`, `side_effects = false`. The Agent Basics stdlib registers read-only tools (`read_file`, `list_dir`, `find_files`, `grep_files`, `calculate`) as built-ins; mutating file tools remain approval-worthy.

### Anchor 4 — Memory is the runtime (`car-memgine`)

Memory is **not** a vector DB bolted on. Facts live in a `petgraph::StableGraph` of `MemKind` nodes (Identity, Fact, Skill, Conversation, Environment), with `EdgeKind` edges: `Supersedes`, `DependsOn`, `RelatedTo`, `Triggers`, `TemporalNext`. Retrieval uses **spreading activation** with configurable edge multipliers. Memory APIs: `add_fact`, `query_facts`, `fact_count`, `build_context`, `build_context_fast`, `persist_memory`, `load_memory`, `consolidate`.

**Four-layer context assembly** follows the Liotta 2026 model (labeled "four-layer," listed as six numbered stages), **relevance-ascending** (most relevant last):

1. **Identity** — who the agent is, authority level
2. **Constraints** — hard rules
3. **Facts** — durable knowledge with supersession chains, authority ranking, scope filtering
4. **Conversation** — current session turns, token-capped
5. **Environment** — runtime context: deadlines, system state
6. **Known unknowns** — gaps to be aware of

CAR's Rust engine scores **93.8% ± 0.5% on StateBench's held-out test split** (GPT-5.2, 251 queries/run, 3-run mean), with the Python reference implementation of the same design at 94.16% ± 1.05% in the same session. See README.md for the canonical statement and its limits. `build_context_for_model(query, Some(context_window))` sizes the budget dynamically; `build_context_fast()` / `ContextMode::Fast` skips embedding flush / skill lookup / PPR scoring for latency-sensitive paths (voice).

**Skills are first-class** — learned procedures stored as graph nodes with trigger edges. The loop:

```typescript
rt.ingestSkill('deploy', ['deploy', 'release', 'ship'], steps);
const skill = rt.findSkill('how do I deploy?');  // spreading-activation match
rt.reportOutcome('deploy', true, 1200);           // track success/failure
// Auto-degradation: skills with fail_count > success_count + 2 are marked deprecated
```

Full skill APIs: `ingest_skill`, `find_skill`, `report_outcome`, `distill_skills`, `list_skills`, `repair_skill`, `evolve_skills`. This loop is what enables **skill-first execution** — skipping the LLM when a learned workflow matches — which FlyX's design note *projects* would cut ~75% of its token cost (a target, not a measurement). The **`.car/` project directory** is team-shareable identity/constraints/facts/skills/policies/config checked into git, **auto-discovered by walking up from cwd like `.git`**.

### Anchor 2 — The three kinds of agent (and which you are building)

**(1) In-process proposal-driven agent (the default).** You author against the FFI/IR. The end-to-end Node flow:

```typescript
import { CarRuntime, executeProposal } from 'car-runtime';

const rt = new CarRuntime();   // lazy-connects to ws://127.0.0.1:9100/
await rt.registerAgentBasics();
await rt.registerTool('shell');
await rt.registerPolicy('no_rm', 'deny_tool_param', 'shell', 'command', 'rm -rf');
await rt.addFact('project_language', 'TypeScript', 'decision');

const proposal = JSON.stringify({
  actions: [{ id: 'a1', type: 'tool_call', tool: 'shell',
              parameters: { command: 'ls' }, idempotent: true }],
});

const check = JSON.parse(await rt.verifyProposal(proposal));
if (!check.valid) throw new Error(JSON.stringify(check.issues));

const result = await executeProposal(rt, proposal, async (callJson) => {
  const { tool, params } = JSON.parse(callJson);   // runtime never owns tools
  return JSON.stringify(await myTools[tool](params));
});
```

Python is identical *except proposal execution is not exposed* (anchor 1):

```python
from car_runtime import CarRuntime   # thin daemon client, lazy-connects

rt = CarRuntime()
rt.register_agent_basics()
rt.register_tool("search")
rt.register_policy("no_rm", "deny_tool_param", "shell", "command", "rm -rf")
rt.add_fact("project_language", "Python", "decision")
facts   = rt.query_facts("language")
context = rt.build_context("What language is this project?")
# proposal execution: connect to the WS directly, use proposal.submit + tools.execute
```

For any non-Node/Python host, drive the WS directly. Tool execution is **bidirectional**: the server sends `tools.execute` requests to the client, which executes locally and responds.

```jsonc
{"jsonrpc":"2.0","method":"proposal.submit","params":{"proposal":"..."},"id":1}
{"jsonrpc":"2.0","method":"memory.add_fact","params":{"key":"x","value":"y","source_type":"user"},"id":2}
{"jsonrpc":"2.0","method":"memory.build_context","params":{"query":"..."},"id":3}
{"jsonrpc":"2.0","method":"skill.ingest","params":{"name":"deploy","triggers":["deploy"],"steps":[]},"id":4}
```

**(2) Lifecycle / supervised contributed agents.** A declarative manifest at `~/.car/agents.json` drives spawn/restart/stop of long-lived child processes (restart policies `never|on_failure|always` with exponential backoff + `max_restarts`; logs at `~/.car/logs/<id>.{stdout,stderr}.log`). Managed via WS `agents.{list,upsert,remove,start,stop,restart,tail_log,health,install}` and `car start|stop|restart`; `auto_start` entries spawn on `car-server` boot. Packaging uses **`manifest.toml` + ed25519 sign/verify** (`car-bundle`), installed with `car install / ls / inspect / uninstall`. A supervised agent must be **running AND attached** (`session.auth { role: "agent" }`) to be chat-capable.

**(3) External agentic CLIs.** The daemon detects and invokes installed CLIs (Claude Code, Codex, Gemini) as a third kind of agent. Route into a swarm by prefixing `AgentSpec.name` with `external:` (`external:claude-code|codex|gemini`):

```rust
let host_runner: Arc<dyn AgentRunner> = Arc::new(MyChatRunner);
let runner: Arc<dyn AgentRunner> =
    Arc::new(car_external_agents::ExternalAwareRunner::new(host_runner));
// run_swarm(&swarm, task, &runner, &infra).await — mixed dispatch
```

`agents.invoke_external` takes `InvokeOptions { cwd, allowed_tools, max_turns, timeout_secs, mcp_endpoint }`; `agents.list_external` takes `include_health`. Multi-agent coordination patterns (`car-multi`): `run_swarm`, `run_pipeline`, `run_supervisor`, `run_map_reduce`, `run_vote` — each takes `Arc<dyn AgentRunner>`.

### Daemon API surface map (where to find each capability)

The WS daemon exposes **73+ JSON-RPC methods across 23 namespaces**. The ones a single-agent author touches most:

| Namespace | Representative methods |
|-----------|------------------------|
| `proposal.*` | `submit` |
| `memory.*` | `add_fact`, `query`, `build_context` |
| `skill.*` | `ingest` |
| `tools.*` | `execute` (bidirectional, **server→client**) |
| `session.*` | `auth { role: "agent" }`, `policy.open/close` |
| `agents.*` | lifecycle + `invoke_external`, `list_external`, `chat.event` |
| `auth.*` | `start`, `complete`, `completion_status`, `snapshot`, `status`, `switch_org`, `accounts`, `switch_account`, `remove_account`, `logout` (host-only Parslee OAuth2 PKCE and account management) |
| `models.*` | `recommend`, `setup_plan`, `pull` (streams `pull_progress`) |
| `a2ui.*` | daemon-shared surface store |
| `voice.*` | `dispatch_turn`, `tts_stream.start` (WS-only) |

Full reference: `docs/websocket-protocol.md`.

### Install matrix and the gotchas that bite first

| Platform | Install | Notes |
|----------|---------|-------|
| Node | `npm install car-runtime` | downloads prebuilt native binary; bundles `car-server` |
| Python | `pip install car-runtime` (import `car_runtime`) | bundles `car-server`; **Linux arm64 has no wheel** — use the tarball; **Intel Macs have no wheel at all** |
| Rust | add `car-*` crates | starter set above |
| macOS GUI | `CAR-darwin-arm64.pkg` | installs `CAR Host.app` to `/Applications` + `car` CLI to `/usr/local/bin`; **Homebrew path removed in v0.16.0** |
| CLI archives | `car-darwin-arm64.tar.gz` / `car-linux-x64-gnu.tar.gz` / `car-win32-x64-msvc.zip` | each contains `car-server`, `car`, `car-memgine-eval`, the NAPI `.node` module |

Distribution platforms: **darwin-arm64, linux-x64-gnu, linux-arm64-gnu, win32-x64-msvc**. macOS is **Apple Silicon only** (Intel/x86_64 dropped in v0.12).

Highest-frequency authoring gotchas:

- **Daemon required (v0.8+).** Start `car-server` once per host before any Node/Python call, or it fails.
- **Direct `.tar.gz` downloads get quarantined** by Gatekeeper; npm/pip strip it automatically. Clear with `xattr -d com.apple.quarantine ./car-server ./car ./car-host ./car-memgine-eval`.
- **API-key resolution priority:** process env var **wins** over `~/.car/env` over the OS keychain. An already-exported shell var silences `~/.car/env`. `car-server` auto-loads `~/.car/env` (dotenv: `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY`). Keychain via `car secrets put OPENAI_API_KEY` / `car secrets list` / `car secrets migrate-from-env --dry-run`.
- **Headless Linux has no Secret Service** — `car secrets available` returns false and the keychain is silently skipped; use `~/.car/env`.
- **MLX from a code-signed Python** needs the `com.apple.security.cs.allow-jit` entitlement or `mlx-rs` panics on first inference — use unsigned Python, add the entitlement, or run inference through the daemon (its release binary ships the entitlement).
- **No cargo feature flags in `car-*` crates** — downstream manifests with `features = [...]` now fail.
- **Get a local model without knowing model ids:** `car setup` (interactive) or `car setup --use-case coding --tier balanced --yes` (CI); preview with `car models recommend --for assistant`; add `--cloud-ok` to let cloud models compete.

---

## Installing & Setting Up CAR

CAR (Common Agent Runtime) ships as a **sealed public binary distribution** from the [`Parslee-ai/car-releases`](https://github.com/Parslee-ai/car-releases) repo — the source is private. The binaries are free to use (including commercially) and free to redistribute **unmodified**; modification, reverse-engineering, and derivatives are not permitted. The runtime ships sealed so agents can't patch their own guardrails. Only the repo contents (README, examples, `install.sh`) are Apache-2.0.

Before you write a single line of agent code, internalize the one fact that reframes everything below.

### The daemon-first model (read this first)

Since **v0.8**, CAR is **daemon-first**, and this is mandatory rather than optional. Every FFI binding — Python, Node.js, and the WebSocket clients — is a thin client to a **singleton `car-server`** that **must already be running**. The server is the only thing that actually holds runtime state, executes the DAG, talks to models, and enforces policy. The bindings just marshal calls over a WebSocket JSON-RPC connection.

Practically, this changes four things for an author:

| Concern | Consequence of daemon-first |
|---------|-----------------------------|
| **Install** | You install both a *binding* (or the host app) **and** a *server* — or you let CAR Host.app embed and supervise the server for you. |
| **Connection** | The binding finds the daemon via `CAR_DAEMON_URL` and authenticates with `CAR_AUTH_TOKEN`. |
| **Auth flow** | Parslee auth/status/inference paths read the authoritative V2 credentials at request time. Restart only for daemon consumers that intentionally use the boot-cached `ServerState.parslee_session`, such as `daemon_identity`/`handle_session_auth` metadata and Parslee sync initialization. |
| **Which methods exist** | Some methods are **WebSocket-only**. The direct `infer_stream` PyO3 method is an unsupported compatibility stub that always raises, even when a daemon is running. |

So the FFI surface and the WebSocket surface are not identical: the binding exposes the in-process methods plus daemon-routed ones, and the daemon-only ones fail loudly when the server isn't up. The first thing any setup must guarantee is **"is car-server running and am I authenticated to it?"** — every troubleshooting path, cross-host scenario, and FFI-vs-WS divergence traces back to this.

> On macOS the easiest answer is "yes, always": **CAR Host.app embeds and supervises `car-server`**, mints a per-launch auth token (passed to the server via `--auth-token`), and you never start a daemon by hand.

### Choosing an install route

Pick exactly one route based on what you intend to do. The README ships an install table keyed to intent.

| You want to… | Route | Command |
|--------------|-------|---------|
| Run agents on a Mac, **no terminal**, no code | CAR Host.app menu-bar app | Double-click `CAR-darwin-arm64.pkg` |
| **Build** agents in Python | PyPI binding | `pip install car-runtime` (import name `car_runtime`) |
| **Build** agents in Node/TS | npm binding | `npm install car-runtime` |
| Run the **CLI + server** on Linux/Windows or in scripts | Homebrew / Scoop / Winget / `install.sh` | see below |
| Pin exact assets / air-gapped | Direct GitHub release assets | `.whl`, `.node`, `.tar.gz`, `.zip` |

Across **every** binding the programming model is identical: instantiate `CarRuntime()`, `register_tool`, `register_policy`, build a JSON proposal (a DAG of actions), `verify_proposal` it, then `execute_proposal` with a tool-dispatch callback you own. (Rust source is `snake_case`; NAPI auto-converts to `camelCase` for JS/TS — `state_get` → `stateGet`; Python keeps `snake_case`.)

### Route 1 — macOS Host.app (no-code path)

This is the zero-terminal way to run agents, and it solves the daemon-first requirement for you because the app embeds and supervises `car-server` and self-updates via Sparkle (so there is **no** `brew upgrade` for the app).

1. Download `CAR-darwin-arm64.pkg` from `https://github.com/Parslee-ai/car-releases/releases/latest`.
2. Double-click it. This installs **both** `CAR Host.app` to `/Applications` **and** the `car` CLI to `/usr/local/bin`.
3. Click the new **CAR icon in the menu bar** (no Dock icon, no window until opened).
4. Complete the **Parslee sign-in** window in the browser.
5. Open **CAR Dashboard → Chat**, pick an agent from the agent picker, and type a request in plain English.
6. Sensitive actions pause in the **Approvals** tab for **Approve / Deny**.


**Requirements:** Apple Silicon, macOS 26+. Intel Macs (`x86_64-apple-darwin`) are **not supported at all** — macOS is Apple Silicon only.

> Gotcha: if sign-in says *"Your CAR background service is out of date,"* the installer didn't finish replacing an older copy — reinstall the `.pkg` from the latest release.

### Route 2 — Python binding

```bash
pip install car-runtime          # PyPI auto-resolves the platform wheel (Python 3.9+, abi3)
```

```python
import json
import car_runtime                 # NOTE: package is car-runtime, import is car_runtime

rt = car_runtime.CarRuntime()
rt.register_tool("shell")
rt.register_policy("no_rm", "deny_tool_param",
                   target="shell", key="command", pattern="rm -rf")
```

See `examples/python/hello_car.py` and `examples/python/agent_with_tools.py`.

Air-gapped / no-PyPI wheel install — wheel filenames carry the version, so there is **no** version-independent "latest" wheel URL. Substitute the release version:

```bash
VERSION=0.15.0
pip install "https://github.com/Parslee-ai/car-releases/releases/download/v${VERSION}/car_runtime-${VERSION}-cp39-abi3-macosx_15_0_arm64.whl"
```

Available wheels: `…macosx_15_0_arm64.whl` (Apple Silicon 15+), `…manylinux_2_28_x86_64.whl` (Linux x64), `…win_amd64.whl` (Windows x64). **Linux aarch64 has no wheel** — use the platform tarball instead.

### Route 3 — Node.js binding

```bash
npm install car-runtime
```

The post-install hook downloads the platform `.node` module from the latest GitHub release. For air-gapped machines, skip the download and drop the file in by hand:

```bash
CAR_RUNTIME_SKIP_DOWNLOAD=1 npm install car-runtime
curl -OL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-runtime.darwin-arm64.node
```

Or load the native module directly:

```javascript
const native = require('./car-runtime.darwin-arm64.node');
const rt = new native.CarRuntime();
```

In JS/TS, `executeProposal` and `registerAgentRunner` are **standalone functions**, not `CarRuntime` methods: `await executeProposal(rt, json, fn)`. See `examples/node/hello-car.js`.

### Route 4 — CLI + server (Linux / Windows / scripted)

The `car` CLI and `car-server` binary are what you run on non-macOS hosts (and what you start by hand to satisfy the daemon-first requirement when you're not on the Host.app).

```bash
# macOS + Linux — install script (Homebrew was removed in bec680d90)
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh

# Windows (Scoop)
scoop bucket add car https://github.com/Parslee-ai/scoop-car
scoop install car

# Windows (Winget — pending PR to microsoft/winget-pkgs)
winget install Parslee.Car

# No-Homebrew script (Darwin + Linux arm64/x86_64 only)
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh
```

The `install.sh` script downloads `car`, `car-server`, `car-memgine-eval`, and the `.node` module, installs to `~/.car/bin`, and **prints a PATH snippet you must add yourself**. Environment overrides:

| Variable | Effect |
|----------|--------|
| `CAR_VERSION=v0.15.0` | Pin a specific release |
| `CAR_INSTALL=/custom/dir` | Override the install directory |
| `CAR_NO_PATH=1` | Skip the PATH-setup reminder |

Raw tarball/zip alternatives:

```bash
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-linux-x64-gnu.tar.gz | tar -xz
# Windows PowerShell:
Invoke-WebRequest -Uri https://github.com/Parslee-ai/car-releases/releases/latest/download/car-win32-x64-msvc.zip -OutFile car.zip; Expand-Archive car.zip -DestinationPath .
```

> Tarball filenames are **stable** across versions (`/releases/latest/download/…` always resolves to newest); wheel filenames are not. `install.sh` supports **only** Darwin and Linux (arm64/x86_64); other OS/CPU combos exit with an error.

Verify the binary, then you're ready to run the daemon:

```bash
./car --help
```

### Connecting a binding to the daemon

Because the binding is a WebSocket client, it must know where the daemon is and how to authenticate. Two environment variables carry this:

| Variable | Purpose |
|----------|---------|
| `CAR_DAEMON_URL` | WebSocket URL of the running `car-server` |
| `CAR_AUTH_TOKEN` | Per-server auth token the client presents on connect |

On macOS, CAR Host.app supervises `car-server` and mints a per-launch token internally (passed to the server with `--auth-token`), so a binding running under the app's umbrella connects without you wiring these manually. When you run `car-server` yourself (Route 4), you set these so the binding can reach it.

Remember the FFI-vs-daemon divergence: callback-bearing streams are WebSocket-only. In particular, the direct Python `infer_stream` method always raises; use the daemon's `infer_stream` JSON-RPC method. Connection and authentication checks apply to that WebSocket flow, not to the compatibility stub.

### Your first working agent (verify → execute)

The canonical minimal loop is the same everywhere: register a tool, enforce a policy in Rust *before* any side effect, build a DAG proposal, **verify, then execute** with your own tool-dispatch callback.

```python
import json
import car_runtime

rt = car_runtime.CarRuntime()

# Tools are callbacks — you own the implementation.
rt.register_tool("shell")

# Policies are enforced in Rust before any tool fires.
rt.register_policy("no_rm", "deny_tool_param",
                   target="shell", key="command", pattern="rm -rf")

# A proposal is a DAG of actions with dependencies.
proposal = json.dumps({"actions": [
    {"id": "a1", "type": "tool_call", "tool": "shell",
     "parameters": {"command": "ls"}, "dependencies": []},
]})

# Verify first — catches bad plans before any side effect.
check = json.loads(rt.verify_proposal(proposal))
if not check["valid"]:
    raise RuntimeError(check["issues"])

# Execute with your tool dispatch.
# ONE argument: a JSON string of the whole call,
# {"tool", "params", "action_id", "request_id", "timeout_ms", ...}.
def tool_fn(call_json):
    return json.dumps({"stdout": "..."})

result = json.loads(rt.execute_proposal(proposal, tool_fn))
```

The proposal is a JSON DAG. Each action has `id`, `type` (one of `tool_call`, `state_write`, `state_read`, `assertion`), `tool`, `parameters`, and `dependencies`. Parameters can reference prior outputs (`"$a1.output"`); actions with resolved deps run concurrently.

```json
{
  "actions": [
    { "id": "a1", "type": "tool_call", "tool": "read_file",
      "parameters": {"path": "/tmp/foo.txt"}, "dependencies": [] },
    { "id": "a2", "type": "tool_call", "tool": "summarize",
      "parameters": {"text_ref": "$a1.output"}, "dependencies": ["a1"] }
  ]
}
```

The **tool callback is your contract** — the runtime owns the DAG, state, policies, and verification, but **not** the tools. Your callback takes `(tool: str, params_json: str)` and returns a JSON string; surface failures as `{"error": "..."}` so the runtime can retry/replan if configured:

```python
def tool_fn(call_json: str) -> str:
    call = json.loads(call_json)
    if call["tool"] == "read_file":
        return json.dumps({"content": open(call["params"]["path"]).read()})
    return json.dumps({"error": f"unknown tool: {call['tool']}"})
```

> Rule: **`verify_proposal` must run before `execute_proposal`.** `verify_proposal` returns `{valid, issues}`; show the check before executing.

To scaffold a real agent fast, the README ships a copy-paste **"Build your first agent"** prompt block: paste it into Claude/ChatGPT/Cursor, replace the `TASK:` line, and it emits a single-file runnable `car_runtime` agent (a second block does the same for multi-agent pipeline/swarm/supervisor/map-reduce/vote systems). To port the generated Python to TypeScript: `car_runtime` → `car-runtime`, `rt.register_tool` → `await rt.registerTool`, `rt.execute_proposal(json, fn)` → `await executeProposal(rt, json, fn)`, `rt.infer_tracked` → `await rt.inferTracked`.

### Authenticating to Parslee (cloud models / managed agents)

The `car-auth` crate implements Parslee **OAuth2 with PKCE (S256)** via a browser/loopback login. The CLI drives it; the daemon consumes the result.

```bash
car auth login                       # browser OAuth2 PKCE loopback login
car auth login --provider microsoft  # provider hint (microsoft|google)
car auth login --api-base https://api.parslee.ai --client-id parslee-car --callback-port 53682
car auth status                      # is there a usable Parslee token?
car auth logout                      # remove stored tokens from the keychain
```

| Flag | Default |
|------|---------|
| `--api-base` | `https://api.parslee.ai` |
| `--client-id` | `parslee-car` |
| `--callback-port` | `53682` |
| `--provider` | `microsoft` \| `google` |

`car auth login` binds a local TCP listener on the callback port, opens the authorize URL, waits for the redirect to `http://127.0.0.1:{port}/auth/callback`, **verifies the returned OAuth `state` matches** (a mismatch aborts the exchange as a CSRF guard), and exchanges the code at `{api_base}/connect/token`. Before publishing anything, `fetch_status_with_access` validates the uncommitted access token and resolves its account identity; `commit_login` then atomically publishes that identity and token set in the authoritative `PARSLEE_AUTH_STATE_V2` record under keychain service `"car"`.

> **Daemon-first consequence:** request-time readers such as `auth.status`, `parslee.auth`, and Parslee inference pick up the new V2 credentials on their next call; `access_token_refreshing` applies the shared `REFRESH_SKEW_SECS` refresh window. Restart `car-server` only when a consumer needs the boot-cached `ServerState.parslee_session` identity refreshed, including `daemon_identity`/`handle_session_auth` metadata or Parslee sync initialization.

CAR is a pure OAuth client — there is intentionally no consent/org handling. Org membership is carried in the token via Parslee's hosted consent page during the `/connect/authorize` browser hand-off.

The **GUI/daemon** path uses parallel JSON-RPC methods. The trusted in-process GUI holds the PKCE verifier/state; the daemon serializes process-global auth operations and persists an attempt-bound completion proof with the monotonic credential generation:

| JSON-RPC method | Shape |
|-----------------|-------|
| `auth.start` | `{redirect_uri, api_base?, client_id?='parslee-car', provider?}` → `{authorize_url, state, verifier, attempt_id}` after durable reservation. Its response waiter is explicitly bounded at 95 seconds. A typed pre-reservation coordination `-32004` is safe to retry serially; a 95-second waiter timeout is ambiguous and must not overlap another start. |
| `auth.complete` | `{redirect_uri, code, verifier, attempt_id, api_base?, client_id?}` → `{state:"accepted", attempt_id}` only after the exact attempt is durably claimed and its daemon-owned redemption task is spawned. Accepted confirms a redeeming fence, not successful sign-in. Duplicate, stale, and expired attempts fail before exchange and never return accepted. A stable pre-redemption coordination `-32004` explicitly permits one bounded same-request retry because no claim/code exchange began; every other timeout or transport ambiguity is proof-only and must never replay the code. After a successful exchange, CAR makes at most one additional bounded session check; if both checks fail, proof states that the code was consumed and no credentials were saved. |
| `auth.completion_status` | `{attempt_id}` → one already-published V2 authoritative `pending`, `complete`, `failed`, or `stale` snapshot. Pending includes `phase` + `expires_at_unix_ms`; failed includes a stable `error_code`, actionable `message`, and `retryable:true` (start a fresh attempt, never replay the code). No legacy migration, refresh, publication barrier, or network call. The daemon-owned operation survives socket loss and may make one terminal publication for an orphaned/expired lease. Bounded coordination/waiter failures are retryable `-32004`; genuine state/store failures remain terminal `-32603`. |
| `auth.snapshot` | → `{authenticated, active_account_id?}`. No refresh or network call; the first local read may migrate an attributable legacy login into V2. An ambiguous legacy marker degrades to a signed-out snapshot (`authenticated: false`) and the orphan fixed-slot credential is discarded, so a fresh sign-in can proceed. The ID is omitted when the active credential slots cannot be attributed exactly; registry rows never substitute as proof. |
| `auth.status` | → `{authenticated, session?}` |
| `auth.logout` | → `{ok:true}` |
| `parslee.auth` | → `{authenticated:true, token_type:"Bearer", access_token, authorization_header:"Bearer …", identity}` (auto-refreshes if expiring within 60s; errors with *"run `car auth login`"* if unauthenticated) |

#### Credential authority is demand-driven

Treat presentation and authority as different layers. Passive startup, Home,
Models, setup, health, and catalog paths use `auth.authority_hint` plus
environment presence; they do not read the secret store. **Configured means
only that a non-secret credential hint exists.** It is not an authenticated
session, must not hydrate an account identity, and must not authorize a
credential-backed request.

An explicit **Verify** action calls `auth.status` without retry parameters and
joins or starts the coordinator's ordinary authoritative read. If that read is
denied, cancelled, timed out, unreadable, or in cooldown, keep the terminal
recovery state stable across rerenders and reconnects. Do not poll
`auth.status`, call it from an appearance hook, or turn a passive hint into an
automatic verification attempt.

An explicit **Retry** sends the literal
`{"retry_keychain_access": true}`. That is the only UI recovery action that
clears the cooldown and starts one new credential-read generation; repeated
clicks coalesce with the in-flight generation. Credential-dependent inference
and other actions that genuinely need authority may also resolve credentials
at request time.

For release proof, an authorized, capability-negotiated protocol-v3 host may read
`diagnostics.secret_store_activity`. It returns only process-lifetime aggregate
get, status, availability, write, and delete attempt counts. It never returns a
service, key, filesystem location, secret value, or account identity, and it
must not be exposed to ordinary clients.

Credential-backed `auth.*` operations are daemon-owned, so a socket close or
response timeout cannot cancel a coordinator/keychain mutation midway.
`auth.start`, durable completion claim, and proof reads all expose the same
95-second composed state-response bound; clients use more than 95 seconds.
Except for the explicit pre-redemption-safe message, a missing completion
receipt remains ambiguous: reconnect as the host and query
`auth.completion_status` instead of exchanging the code again. `auth.start`
owns the durable reservation; accepted completion proves the worker already
claimed that exact attempt before `/connect/token`. Awaiting-callback
reservations survive a daemon restart; worker-owned
redeeming attempts fail terminally on worker exit, expiry, or owner change.
Keep proof reads non-overlapping and use a client timeout longer than the
composed 95-second response bound. A proof `-32004` means daemon reconciliation
continues, so wait before the next serial proof read. The 480-second host
horizon includes one explicit pre-redemption retry, the 210-second worker
lease, terminal proof, and hydration. Any later start,
account/org switch, or logout advances the credential generation and
supersedes the older proof. The multi-login registry
is display state, not completion proof: `complete_auth_completion` fetches the
fresh session and `commit_login` validates `session_identity` before
publication; if either step fails, CAR fails closed and saves no credentials.

All Parslee-owned keychain slots under service `"car"` are daemon-private, not
generic user-secret keys. The reserved set is
`PARSLEE_ACCESS_TOKEN`, `PARSLEE_REFRESH_TOKEN`,
`PARSLEE_ACCESS_TOKEN_EXPIRES_AT`, `PARSLEE_API_BASE`,
`PARSLEE_AUTH_STATE_V2`, `PARSLEE_ACCOUNTS`, every key with the
`PARSLEE_TOKENS_` prefix,
`PARSLEE_ACTIVE_ACCOUNT_ID`, `PARSLEE_AUTH_GENERATION`, and
`PARSLEE_AUTH_COMPLETION`. Generic CLI, FFI, and `secret.put`/`get`/`delete`
operations fail closed with `reserved_private_secret`; use `auth.*` instead.

### Storing model API keys (the keychain)

Remote-model API keys live in the **OS keychain** via the `car-secrets` crate (`SecretStore` shells to `/usr/bin/security` on macOS, Credential Manager on Windows, Secret Service on Linux), under the default service **`"car"`**.

```bash
car secrets put OPENAI_API_KEY                      # stdin prompt if --value omitted
echo sk-... | car secrets put OPENAI_API_KEY
car secrets put OPENAI_API_KEY --value 'sk-a,sk-b,sk-c'   # comma list = load-balanced multi-key pool
car secrets get OPENAI_API_KEY                      # exit 1 if missing
car secrets status OPENAI_API_KEY                   # {"service":"car","key":...,"exists":true}
car secrets delete OPENAI_API_KEY                   # idempotent
car secrets available                               # {"available": true}
car secrets migrate-from-env [--dry-run] [--service NAME] [--include EXTRA_VAR]

# Friendly provider-key surface (values never appear in `list`):
car keys set openrouter                 # paste or pipe the value
car keys list                           # openrouter / OPENROUTER_API_KEY / keychain
car keys remove openrouter
```

`car secrets migrate-from-env` walks `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, copies non-empty process-env values into the `"car"` keychain (skipping writes that already match), and returns JSON:

```json
{
  "dry_run": false,
  "service": "car",
  "migrated": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  "already_current": [],
  "empty_in_env": ["GOOGLE_API_KEY"]
}
```

**Key resolution priority** (single source of truth, `resolve_env_or_keychain`):

1. **Process env var** — non-empty wins (covers containers/CI/K8s/systemd; `~/.car/env` is loaded into process env at server startup so it flows through here).
2. **OS keychain** under service `"car"`, account = env-var name (silently skipped if the store is unavailable).
3. **None.**

OpenRouter adds one lower-priority, separately removable slot: environment
`OPENROUTER_API_KEY` → pasted keychain `OPENROUTER_API_KEY` → OAuth keychain
credential from **Connections → OpenRouter** → none. Only the absent/default
service (`"car"`) `secret.put`/`secret.delete` slot participates in that
authority chain; the same key name under another service is an ordinary generic
secret and cannot supersede OAuth or publish OpenRouter presence changes.

CAR resolves credentials and refreshes availability without a restart. The ten
reviewed personal entries are always visible under exact IDs such as
`openrouter/anthropic/claude-sonnet-4.6`; they are unavailable without an
OpenRouter credential and the same rows become available with one. A typo or
unregistered model ID fails with the normal model-not-found error.
Parslee-managed entries are a separate curated set of opaque product aliases,
`parslee/openrouter/<alias>`; the alias does not expose or promise a particular
upstream model ID.

The daemon exposes parallel secret methods: `secret.put {key, service?, value}`, `secret.get {key, service?}`, `secret.delete {key, service?}`, `secret.status {key, service?}`, `secret.available → {available}`.
The daemon-owned OpenRouter OAuth account is deliberately not a generic secret:
put/get/delete of the exact `car` / `OPENROUTER_OAUTH_API_KEY` slot fail closed.
Only `openrouter.auth_start`, request-time credential leasing, and
`openrouter.disconnect` can access it; list/status return metadata, never the
credential value. The CLI enforces the same boundary even when a caller spells
the raw slot name (`car keys set/remove OPENROUTER_OAUTH_API_KEY`); use
`car keys set/remove openrouter` for a normal pasted key.

The same service-`"car"` boundary reserves every Parslee credential, registry,
stash, marker, generation, and proof slot:
`PARSLEE_ACCESS_TOKEN`, `PARSLEE_REFRESH_TOKEN`,
`PARSLEE_ACCESS_TOKEN_EXPIRES_AT`, `PARSLEE_API_BASE`,
`PARSLEE_AUTH_STATE_V2`, `PARSLEE_ACCOUNTS`, the `PARSLEE_TOKENS_` prefix,
`PARSLEE_ACTIVE_ACCOUNT_ID`, `PARSLEE_AUTH_GENERATION`, and
`PARSLEE_AUTH_COMPLETION`. Generic put/get/delete through the CLI, FFI, or
WebSocket returns `reserved_private_secret`; only the dedicated `auth.*`
surface and daemon-owned auth code may access them.

Parslee-managed model schemas and inference requests resolve the Parslee API
base through the same `PARSLEE_API_BASE` environment/keychain connection used
by sign-in. This keeps staging sign-in, identity lookups, and managed inference
on one authority; switching that connection takes effect on the next request
without rebuilding the registry or restarting CAR.

**Keychain gotchas:**

- Default service is **`"car"`**. Pre-v0.5.2 it was `"car-runtime"`; older entries must be re-`put` or migrated — readers only look at `"car"`.
- **Env var always wins over the keychain.** A stale-but-set (non-empty) env var masks a keychain value entirely.
- **No silent plaintext fallback.** On headless Linux with no Secret Service daemon, `put/get/delete` return `SecretError::Unavailable`, and `migrate-from-env` refuses entirely rather than no-op'ing.
- macOS writes go through `/usr/bin/security` with a best-effort pre-delete then `add-generic-password -U -A` to get a fresh any-app ACL — this fixes the repeated-keychain-prompt bug where a legacy ACL was bound to the caller binary's CDHash (which changes on every rebuild). The secret value transits `argv` briefly (acceptable single-user-dev threat model only).
- To drop the keychain dependency for a container build: `cargo build --no-default-features --features ast -p car-inference` removes `car-secrets` from the dependency graph; use env vars / mounted secrets instead.

### Scaffolding the `.car/` project directory

`.car/` is CAR's **team-shareable, git-checked-in knowledge layer** (identity, knowledge/facts, rubrics, policies, skills, config). It is auto-discovered by **walking up from cwd like `.git/`** (`discover_project`); the first existing `.car/` wins, and CAR falls back to `~/.car/` when none is found.

```bash
car init            # scaffold .car/ in cwd (or `car init <dir>`); errors if .car/ already exists
```

`car init` (backed by `car_memgine::project::scaffold_project`) creates exactly:

```text
.car/
  identity.md          # project context (Identity context layer 1)
  knowledge/
    facts.jsonl        # each seeded with a `# Schema:` comment line
    gotchas.jsonl
    anti-patterns.jsonl
    decisions.jsonl
  rubrics/             # quality standards (JSON)
  skills/              # learned procedures (JSON), loaded on boot
  policies.json        # tool restrictions, defaults to []
  config.toml          # memgine/routing/speech overrides (all commented out)
  .gitignore           # *.local, embeddings/, profiles/
```

On the next runtime boot, `identity.md` becomes the agent's **Identity** context layer, `knowledge/*.jsonl` entries become facts, and `skills/*.json` are loaded — so committing `.car/` to git is how a team shares an agent's grounding. Edit `identity.md`, then commit.

> Doc-vs-code drift: the cookbook doc (`docs/cookbook/10-car-project-directory.md`) describes `constraints.md`, a `facts/` directory, and `meetings/` — the **current `scaffold_project` code creates none of those**. Treat the code (`car-rs/crates/car-memgine/src/project.rs`) as ground truth for what `car init` produces today.

**Restrict tools per project** — edit `.car/policies.json` to a JSON array of `PolicyRule` objects (`rule` ∈ `deny_tool` | `deny_tool_param` | `rate_limit`):

```json
[
  {"rule": "deny_tool", "tool": "shell", "reason": "no shell in this repo"},
  {"rule": "deny_tool_param", "tool": "http", "param": "url",
   "denied_values": ["prod"], "reason": "no prod calls"}
]
```

**Share a learned skill** — drop a JSON file into `.car/skills/` and commit it; teammates get it on next runtime instantiation:

```json
{
  "name": "deploy-staging",
  "code": "pnpm build && pnpm deploy --env staging",
  "platform": "node",
  "trigger": {"persona": "engineer", "url_pattern": "", "task_keywords": ["deploy", "staging"]},
  "description": "Deploy current branch to staging"
}
```

**Override memgine/routing/speech config** — uncomment keys in `.car/config.toml` (parsed into `ConfigOverrides`). Note: only `token_budget`, `conversation_keep_recent`, `compaction_batch_size`, `environment_max`, and `max_skills_in_context` are merged into `MemgineConfig` by `ConfigOverrides::apply`; the `routing_*` / `preferred_*_model` / `speech_*` fields are parsed and stored but consumed elsewhere.

### Setup pitfalls checklist

- **Direct FFI streaming attempted** → `inferStream` / `infer_stream` always rejects. Use the daemon WebSocket `infer_stream` method; then confirm `car-server`, `CAR_DAEMON_URL`, and `CAR_AUTH_TOKEN`.
- **`pip install car-runtime` but `import car_runtime`** — package name uses a hyphen, import name an underscore.
- **No "latest" wheel URL** — wheel filenames carry the version; substitute it. Tarballs are stable.
- **Linux aarch64 has no wheel** — use the platform tarball, not pip's direct-wheel route.
- **Auth/keys not taking effect** — Parslee auth/status/inference and OpenRouter
  environment, pasted-keychain, and OAuth credentials are resolved at request
  time. Restart `car-server` only for a genuinely boot-cached consumer: Parslee
  `daemon_identity`/`handle_session_auth` identity metadata, Parslee sync
  initialization, or a provider client that explicitly documents boot-time
  credential caching.
- **`verify_proposal` before `execute_proposal`**, every time. `verify` returns `{valid, issues}`.
- **AgentOutput shape is strict** for multi-agent runs: `{name, answer, turns, tool_calls (INTEGER count, not an array), duration_ms, error}` — missing fields break deserialization silently.
- **`distill_skills` / `evolve_skills` require configured inference** — without a model they hang; bootstrap with hand-coded skills + `ingest_distilled_skills`.
- **macOS is Apple Silicon + macOS 26+ only** for the Host.app no-code path; Intel is unsupported entirely.
- **CAR is pre-1.0** — breaking changes are possible between minor versions; pin exact versions until the API stabilizes.

---

## Your First Single Agent (Node & Python)

This section takes you from zero to a running, tool-using, policy-guarded, memory-backed CAR agent in both Node.js and Python. It is a reference: every method name, parameter shape, JSON-RPC method, CLI flag, and ordering constraint below comes directly from the shipped examples and binding declarations (`car-rs/crates/car-ffi-napi/npm/index.d.ts`, `car-rs/crates/car-ffi-pyo3/car_runtime.pyi`, and the `car-releases/examples/{node,python}/` programs).

### The single most important fact: the daemon comes first

Since **v0.8**, supported operations in the Node (`car-runtime`, NAPI) and
Python (`car_runtime`, PyO3) bindings are **thin WebSocket clients to a
singleton `car-server` daemon**. There is no embedded engine and no
`CAR_FFI_MODE=embedded` fallback — that v0.7.x escape hatch is retired. The
legacy callback-bearing inference streaming symbols are explicit
always-error compatibility stubs; they do not proxy. **Start `car-server`
before you construct a runtime**, or memory/fact/skill/context/event methods
will reject with a "daemon-unreachable" error (`#146`) rather than silently
returning `0`/`""`.

| Concern | Value |
|---|---|
| Default daemon URL | `ws://127.0.0.1:9100` |
| Override env var | `CAR_DAEMON_URL` (e.g. `CAR_DAEMON_URL=ws://127.0.0.1:9100`) |
| Daemon binary | `bin/car-server`, shipped inside the npm and PyPI packages |
| Start (Node) | `npx --package=car-runtime car-server &` |
| Start (macOS) | The SwiftUI menubar app / `CarHost.app` auto-launches it |
| Start (Linux) | Run `bin/car-server` manually or via systemd |

This one fact reframes install, auth, error handling, and *which methods even exist*. A handful of operations are **daemon-only and cannot run through the FFI binding directly** — in the current PyO3 source they are stubs that raise:

```
RuntimeError("... not exposed in the FFI bindings — the daemon owns the executor/inference engine ...")
```

The affected per-instance methods include `execute_proposal`, `infer_stream`, and `dispatch_voice_turn`/`prewarm_voice_turn`. Use the **process-wide tool handler + `submit_proposal`** path for proposals and the daemon WebSocket `infer_stream` method for inference streaming. Direct-call examples from the older embedded contract are obsolete, not operational shape references.

> Naming caveat: Rust is `snake_case`. napi-rs auto-converts to `camelCase` at runtime for JS/TS (`state_get` → `stateGet`, `build_context_fast` → `buildContextFast`). Python keeps `snake_case` exactly. The same capability therefore has two spellings across surfaces.

### The core loop: model proposes, runtime validates and executes

CAR's contract is the same in every language and over the wire:

1. **Register** tools and policies on a persistent `CarRuntime`.
2. **Seed** graph memory (`addFact`) and optionally assemble context (`buildContext`).
3. **Propose** — the model emits an `ActionProposal` (a JSON object with an `actions` array). In offline examples this is hardcoded; in production it comes from `infer(...)`.
4. **Verify** the proposal statically (`verifyProposal`) *before* any tool runs.
5. **Execute** — the executor dispatches each action's tool call to a **caller-provided callback**. The runtime does not own tools.

Most structured-data methods return a **JSON-encoded string** you must parse (`JSON.parse` / `json.loads`), and proposals are passed *in* as JSON strings too. This keeps the FFI surface narrow and stable across protocol changes.

#### The ActionProposal / Action shape

```json
{
  "source": "demo-model",
  "actions": [
    {
      "id": "a1",
      "type": "tool_call",
      "tool": "echo",
      "parameters": { "msg": "hello" },
      "dependencies": [],
      "idempotent": true,
      "timeout_ms": 1000
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `actions[]` | The batch of actions to run (top-level `source` is optional) |
| `id` | Action identifier, referenced by dependencies |
| `type` | `tool_call` (also `state_write`/`state_read`/`assertion` in the engine) |
| `tool` | Must match a registered tool name |
| `parameters` | Object passed to the tool |
| `dependencies` / `state_dependencies` | Array of action IDs / state keys forming the execution DAG |
| `idempotent` | Successful results are cached and short-circuit re-runs |
| `timeout_ms` | Per-action timeout |

Verification resolves the dependency DAG into **`execution_levels`**: actions whose dependencies are satisfied run concurrently within a level; levels run sequentially. You declare dependencies — you do **not** sequence calls by hand.

#### The verify report

`verifyProposal` returns `{ valid, issues, execution_levels }`. Check `valid` before executing. Note that `issues.length` can be non-zero even when `valid` is `true` (non-fatal issues), so inspect both.

### Node.js: your first agent

#### Install + start the daemon

```bash
npm install car-runtime                                   # published npm package (resolves the right native binary)
npx --package=car-runtime car-server &                    # start the singleton daemon (port 9100, auth on) — REQUIRED since v0.8
```

Or grab a platform tarball directly:

```bash
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
```

> Two import names appear across examples. Released examples import the published package **`car-runtime`**; the in-repo `basic-agent-loop` example imports **`@parslee-ai/car-runtime-native`** (ESM, `node>=20`). Use whichever matches your dependency.

#### Complete minimal hello-world (`hello-car.js`, verbatim)

```javascript
const path = require('node:path');

// Pick the binary for your platform (darwin-arm64, darwin-x64, linux-x64-gnu,
// linux-arm64-gnu). Defaults to resolving from the current dir.
function loadNative() {
  const byPlatform = {
    'darwin-arm64': 'car-runtime.darwin-arm64.node',
    'darwin-x64':   'car-runtime.darwin-x64.node',
    'linux-x64':    'car-runtime.linux-x64-gnu.node',
    'linux-arm64':  'car-runtime.linux-arm64-gnu.node',
  };
  const key = `${process.platform}-${process.arch}`;
  const file = byPlatform[key];
  if (!file) throw new Error(`no CAR native binary for ${key}`);
  return require(path.resolve(process.cwd(), file));
}

async function main() {
  const native = loadNative();
  const rt = new native.CarRuntime();

  // 1. Register a tool + a policy.
  await rt.registerTool('echo');
  await rt.registerPolicy('no_rm', 'deny_tool_param', 'echo', 'msg', 'rm -rf');

  // 2. Seed a fact.
  rt.addFact('greeting', 'hello from CAR', 'pattern');
  console.log('facts:', rt.factCount());

  // 3. Verify.
  const proposal = JSON.stringify({
    actions: [
      { id: 'a1', type: 'tool_call', tool: 'echo', parameters: { msg: 'hello' }, dependencies: [] },
    ],
  });
  const report = JSON.parse(await rt.verifyProposal(proposal));
  console.log('verify:', report.valid);

  // 4. Execute with a JS tool callback.
  const result = await native.executeProposal(rt, proposal, async (callJson) => {
    const { tool, params } = JSON.parse(callJson);
    console.log(`  [${tool}] echoed: ${params.msg}`);
    return JSON.stringify({ ok: true, echoed: params.msg });
  });

  console.log('result:', JSON.parse(result));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

```bash
node hello-car.js
```

The native-loading dance maps `${process.platform}-${process.arch}` to a `.node` filename and `require`s it by absolute path. `npm install car-runtime` handles this automatically, so prefer it. (`x86_64-apple-darwin` is dropped — macOS is Apple Silicon `darwin-arm64` only; the `darwin-x64` entry is legacy/best-effort.)

#### Verify-then-execute with policy + memory (ESM, `basic-agent-loop/index.mjs`)

`car-rs/examples/basic-agent-loop/` is the in-repo reference. Run it with:

```bash
cd car-rs/examples/basic-agent-loop
npx --package=car-runtime car-server &
npm install && node index.mjs
```

Its `package.json` is minimal — `"type": "module"`, `engines.node >= 20`, depends on `@parslee-ai/car-runtime-native`. Key excerpts:

```javascript
import { CarRuntime, executeProposal } from '@parslee-ai/car-runtime-native';

const rt = new CarRuntime();
await rt.registerTool('note_taker');

// Block obvious bad inputs declaratively rather than in prompts.
await rt.registerPolicy(
  'no_secrets_in_notes', 'deny_tool_param', 'note_taker', 'body', 'BEGIN PRIVATE KEY',
);

rt.addFact('project_name', 'CAR demo', 'pattern');
rt.addFact('forbidden_topics', 'never log payment-card numbers', 'constraint');
const context = rt.buildContext('what should the agent know about this session?');

const proposal = JSON.stringify({
  source: 'demo-model',
  actions: [
    { id: 'a1', type: 'tool_call', tool: 'note_taker',
      parameters: { title: 'standup', body: 'shipping CAR docs' }, idempotent: true, timeout_ms: 1000 },
    { id: 'a2', type: 'tool_call', tool: 'note_taker',
      parameters: { title: 'followup', body: 'review the agent IR spec' },
      state_dependencies: [], idempotent: true, timeout_ms: 1000 },
  ],
});

const check = JSON.parse(await rt.verifyProposal(proposal));
if (!check.valid) { console.error('proposal failed verification:', check.issues); process.exit(1); }
console.log(`OK — ${check.issues.length} non-fatal issues, levels: ${JSON.stringify(check.execution_levels)}`);

const notes = [];
const result = await executeProposal(rt, proposal, async (callJson) => {
  const { tool, params } = JSON.parse(callJson);
  switch (tool) {
    case 'note_taker': {
      notes.push({ ts: new Date().toISOString(), ...params });
      return JSON.stringify({ saved: true, id: notes.length });
    }
    default: throw new Error(`unknown tool: ${tool}`);
  }
});
console.log(JSON.parse(result));
```

#### The Node tool callback contract

`executeProposal(rt, proposalJson, toolFn, sessionId?, scopeJson?)` is a **standalone function, not a method** on `CarRuntime` — a hard NAPI constraint. `executeProposal` and `registerAgentRunner` are the operational callback surfaces; `inferStream` keeps a legacy callback parameter only for ABI compatibility and always rejects. The callback:

- receives a JSON string that parses to `{ tool, params, action_id }` — note the key is **`params`**, not `parameters`;
- must **return a JSON string** (e.g. `JSON.stringify({ ok: true })`);
- throwing for an unknown tool surfaces as an execution error.

#### Daemon-side execution: `registerToolHandler` + `submitProposal`

For execution where the **daemon** drives tool dispatch (the preferred path against a live `car-server`), register a **process-wide** handler once, then submit:

```typescript
import { registerToolHandler } from 'car-runtime';

registerToolHandler(async (callJson) => {
  const { tool, params, action_id } = JSON.parse(callJson);
  return JSON.stringify(await runTool(tool, params));
});
// ...later:
const result = await rt.submitProposal(proposalJson, sessionId /* optional */);
```

`submitProposal` **fails up front if no handler is registered** (the daemon otherwise rejects each host-tool action mid-proposal with a `-32000` error). Only one handler is active at a time; `unregisterToolHandler()` clears it. The handler signature `handler(callJson) -> Promise<string>` (single JSON arg) is **distinct** from the per-call `executeProposal` `toolFn` — don't conflate the two.

### Python: your first agent

#### Install + start the daemon

```bash
pip install car-runtime         # PyPI package "car-runtime"; import name is "car_runtime"
```

Then start `car-server` (e.g. via the `bin/car-server` shipped in the package). Python keeps `snake_case` everywhere.

#### Minimal hello-world (`hello_car.py`, verbatim)

```python
"""Minimal CAR example: state, facts, verify + execute a proposal."""

import json
import car_runtime


def main() -> None:
    rt = car_runtime.CarRuntime()

    # 1. Register a tool (you provide the implementation via callback).
    rt.register_tool("echo")

    # 2. Register a policy enforced by the runtime.
    rt.register_policy(
        "no_dangerous_shell", "deny_tool_param",
        target="echo", key="msg", pattern="rm -rf",
    )

    # 3. Seed a fact.
    rt.add_fact("greeting", "hello from CAR", "pattern")
    print("facts:", rt.fact_count())

    # 4. Verify a proposal before executing it.
    proposal = json.dumps({
        "actions": [
            {"id": "a1", "type": "tool_call", "tool": "echo",
             "parameters": {"msg": "hello"}, "dependencies": []}
        ]
    })
    report = json.loads(rt.verify_proposal(proposal))
    print("verify:", report["valid"])

    # 5. Execute with a Python tool callback.
    def tool_fn(call_json: str) -> str:
        call = json.loads(call_json)
        params = call["params"]
        print(f"  [{call['tool']}] echoed: {params['msg']}")
        return json.dumps({"ok": True, "echoed": params["msg"]})

    result = json.loads(rt.execute_proposal(proposal, tool_fn))
    print("result:", result)


if __name__ == "__main__":
    main()
```

```bash
python hello_car.py
```

> Reality check: `rt.execute_proposal(...)` shown here is the **older in-process contract**. In the current `car-ffi-pyo3/src/lib.rs` it is a stub that raises `RuntimeError` because the daemon owns the executor. Against a live daemon, use `register_tool_handler` + `submit_proposal` instead (below). The example remains the clearest illustration of the JSON shapes.

#### The Python execution contract

The per-call executor and the daemon handler have **different signatures** — this is a common source of bugs:

| Path | Callback signature | Notes |
|---|---|---|
| Embedded `execute_proposal(proposal_json, tool_fn, session_id?, scope_json?)` | `tool_fn(tool_name, params_json) -> json_str` | **Two** positional args; stub in current PyO3 |
| Daemon `submit_proposal(proposal_json, session_id?, scope_json?)` | `register_tool_handler(handler)` where `handler(call_json) -> json_str` | **One** JSON arg `{tool, params, action_id}` |

`tool_fn` is a **single dispatcher**, not one callback per tool — you route to the right implementation yourself. A typical body parses params and returns JSON; an unknown tool returns `json.dumps({"error": ...})`:

```python
def tool_fn(call_json: str) -> str:
    call = json.loads(call_json)
    name = call["tool"]
    fn = TOOLS.get(name)
    if fn is None:
        return json.dumps({"error": f"unknown tool: {name}"})
    return json.dumps(fn(call["params"]))
```

The daemon path:

```python
from car_runtime import CarRuntime, register_tool_handler
import json

register_tool_handler(lambda call_json: json.dumps(run_tool(json.loads(call_json))))
rt = CarRuntime()
result = rt.submit_proposal(proposal_json)  # raises RuntimeError if no handler
```

#### A real multi-action DAG (`agent_with_tools.py`)

Register each tool, attach `deny_tool_param` policies, then chain actions with `dependencies`:

```python
rt = car_runtime.CarRuntime()
for name in TOOLS:  # {"list_dir":.., "read_file":.., "write_file":..}
    rt.register_tool(name)

rt.register_policy("writes_only_in_tmp", "deny_tool_param",
                   target="write_file", key="path", pattern="/etc")
rt.register_policy("no_read_ssh_keys", "deny_tool_param",
                   target="read_file", key="path", pattern=".ssh")

proposal = {"actions": [
  {"id": "ls",          "type": "tool_call", "tool": "list_dir",  "parameters": {"path": target}, "dependencies": []},
  {"id": "read_readme", "type": "tool_call", "tool": "read_file", "parameters": {"path": f"{target}/README.md"}, "dependencies": ["ls"]},
  {"id": "write_report","type": "tool_call", "tool": "write_file","parameters": {"path": "/tmp/car_report.md", "content": "..."}, "dependencies": ["read_readme"]},
]}
check = json.loads(rt.verify_proposal(json.dumps(proposal)))
if not check["valid"]:
    raise SystemExit("proposal failed verification")
result = json.loads(rt.execute_proposal(json.dumps(proposal), tool_fn))
print(f"events logged: {rt.event_count()}")
```

Policy enforcement runs in **Rust, before the tool callback fires** — a denied parameter is caught at verify/execute time with **no side-effect**. Design tests around that ordering.

### Built-in tools: `register_agent_basics()`

Instead of registering tools one at a time, `rt.register_agent_basics()` (Node: `await rt.registerAgentBasics()`) registers CAR's built-in utility tools in one call:

```
read_file, write_file, edit_file, list_dir, find_files, grep_files, calculate
```

Read-only tools run in-process; mutating tools go through the normal approval flow. The hello-world examples register tools individually instead; `register_agent_basics` is an optional convenience.

### Policies: declarative guardrails in the runtime

`registerPolicy(name, rule, target?, key?, pattern?, valueJson?, sessionId?)` (Node) / `register_policy(name, rule, target=, key=, pattern=, value_json=, session_id=)` (Python) installs a guardrail enforced in Rust on **every** action — replacing prompt-based guarding.

| `rule` | Meaning |
|---|---|
| `deny_tool` | Block a tool entirely |
| `deny_tool_param` | Block a tool when a `key` param matches `pattern` (substring) |
| `require_state` | Require a state precondition |
| `deny_tool_callback` | Callback-driven denial (NAPI) |

Example — `register_policy("no_dangerous_shell", "deny_tool_param", target="echo", key="msg", pattern="rm -rf")` blocks the `echo` tool whenever its `msg` contains `rm -rf`. The `session_id` argument and `open_session`/`close_session` are **embedded-mode only**; in daemon mode use the WS JSON-RPC methods `policy.register` and `session.open`.

### Memory: the runtime, not a bolt-on

Graph memory is available immediately on a `CarRuntime`. Facts seed the four-layer context assembly; skills make the agent *learn*.

#### Facts and context

| Call (Python / Node) | Returns |
|---|---|
| `add_fact(subject, body, kind, confidence=None)` / `addFact(...)` | new fact count (`int`); `kind="constraint"` is a hard rule, `kind="pattern"` is soft |
| `query_facts(query, k=None)` / `queryFacts(...)` | JSON array of `{subject, body, confidence}` via spreading activation |
| `fact_count()` / `factCount()` | total valid facts |
| `build_context(query, model_context_window=None)` / `buildContext(...)` | the full four-layer context string (Identity → Constraints → Facts → Conversation → Environment → Known Unknowns) |
| `build_context_fast(query, ...)` / `buildContextFast(...)` | latency path; skips embedding flush, skill lookup, PPR scoring, known-unknowns |

> The `confidence` field returned by `query_facts` is the **spreading-activation score**, which the memory example labels `activation` — not a stored confidence.

#### Skills: first-class learned procedures

Skills are graph nodes with trigger edges and an outcome loop:

```python
rt.ingest_skill(
    name="add_component",
    code="mkdir -p src/components/$Name && touch src/components/$Name/index.tsx ...",
    platform="bash",
    persona="frontend-engineer",
    url_pattern="file://*/components/",
    task_keywords=["component", "scaffold", "new"],
    description="Scaffold a new React component with test file",
)

found = rt.find_skill(persona="frontend-engineer",
                      url="file:///src/components/Button/",
                      task="add a new component called Button", max_results=1)
if found != "null":                 # find_skill returns the literal string "null", not None
    skill = json.loads(found)[0]     # has a "match_score"

stats = json.loads(rt.report_outcome("add_component", "success"))  # outcome ∈ {"success","fail"}
# stats -> {success_count, fail_count, degraded}
```

Skills **auto-degrade** when `fail_count > success_count + 2` (watch the `degraded` flag). The broader loop is `distill_skills(events_json)` → `ingest_distilled_skills(skills_json)`, with `list_skills(domain=None)`, `domains_needing_evolution(threshold=None)` (default `0.6`), `repair_skill(name)`, and `evolve_skills(events_json, domain)`. This skills loop is what lets an agent skip the LLM when a learned workflow matches — the mechanism behind the ~75% token-cost reduction FlyX's design note projects (projected, never measured).

#### Persisting memory

`persist_memory(path) -> int` (records written) and `load_memory(path) -> int` (facts loaded) round-trip the graph as flat JSON. Paths are **sandboxed under `~/.car/memory/`**: relative paths land under that base; absolute paths must already be under it; `..` segments and out-of-sandbox symlinks are rejected.

### Inference: when the model actually proposes

The examples hardcode proposals for offline reproducibility (no model keys needed). In production the proposal text comes from inference:

| Call | Shape |
|---|---|
| `infer(prompt, model=None, max_tokens=None, intent_json=None)` | plain text |
| `infer_tracked(prompt, ...)` | JSON `{text, tool_calls, usage:{input_tokens,output_tokens}, model_used, trace_id, latency_ms, time_to_first_token_ms}` |
| `infer_stream` / `inferStream` direct FFI symbols | unsupported ABI stubs; always raise/reject and never invoke the callback; use daemon WebSocket `infer_stream` |

Route by intent, not model ID, with an **IntentHint**:

```typescript
await rt.infer(prompt, null, null,
  JSON.stringify({ task: 'chat', prefer_local: true }));  // IntentHint
```

`task` is a closed set: `chat | classify | summarize | reasoning | code | extract`. `prefer_fast` takes precedence over `prefer_local`; an empty IntentHint equals omitting it (adaptive routing). The **first** inference call downloads model weights via CAR's managed local registry — expect a slow, networked first run. Direct FFI `infer_stream` is an always-error compatibility stub; streaming intent belongs in the WebSocket request.

### Gotchas to internalize before you ship

- **Daemon required (v0.8+).** No `car-server` running → `factCount`/`addFact`/`buildContext`/`ingest_skill`/`event_count` reject with a daemon-unreachable error (`#146`). Code that swallowed silent `0`/`""` returns will start throwing.
- **Everything crosses as JSON strings.** `verifyProposal`/`executeProposal`/`submitProposal`/`queryFacts`/`listSkills` take JSON strings and return JSON strings. `json.dumps`/`JSON.stringify` going in, `json.loads`/`JSON.parse` coming out.
- **`executeProposal` is standalone, not a method** (Node). Call `executeProposal(rt, proposalJson, toolFn)`.
- **Callback key is `params`, not `parameters`.** The `callJson` parses to `{ tool, params, action_id }`.
- **Two callback signatures.** Per-call `tool_fn(tool_name, params_json)` vs daemon `handler(call_json)`. Don't mix them.
- **`find_skill` returns the string `"null"`** (not `None`/`null`) on no match — guard with `if found != "null":` before parsing.
- **`report_outcome` argument must be exactly `"success"` or `"fail"`.** Skills degrade at `fail > success + 2`.
- **`verifyProposal` can report `valid: true` with non-empty `issues`.** Inspect both `valid` and `issues`.
- **Policy denial has no side-effect** because it runs in Rust before the tool callback fires.
- **`submitProposal` needs a handler first**, or the daemon rejects host-tool actions with `-32000`.
- **camelCase vs snake_case across surfaces.** The same capability is `buildContextFast` in Node, `build_context_fast` in Python.
- **Two import names in Node examples**: `car-runtime` (released) vs `@parslee-ai/car-runtime-native` (in-repo `basic-agent-loop`).
- **No-npm native loading** must map `${process.platform}-${process.arch}` to the `.node` file (`darwin-arm64`/`darwin-x64`/`linux-x64-gnu`/`linux-arm64-gnu`) and `require` by absolute path. `npm install car-runtime` avoids this; macOS is `darwin-arm64` only.

### Quick reference: the authoring loop in one place

| Step | Node (camelCase) | Python (snake_case) |
|---|---|---|
| Construct | `new CarRuntime()` | `car_runtime.CarRuntime()` |
| Register tool | `rt.registerTool(name)` / `rt.registerAgentBasics()` | `rt.register_tool(name)` / `rt.register_agent_basics()` |
| Register policy | `rt.registerPolicy(name, rule, target?, key?, pattern?)` | `rt.register_policy(name, rule, target=, key=, pattern=)` |
| Seed memory | `rt.addFact(subject, body, kind)` | `rt.add_fact(subject, body, kind)` |
| Build context | `rt.buildContext(query, window?)` | `rt.build_context(query, model_context_window=None)` |
| Verify | `rt.verifyProposal(json)` → `{valid, issues, execution_levels}` | `rt.verify_proposal(json)` → `{valid, issues}` |
| Execute (per-call) | `executeProposal(rt, json, toolFn)` | `rt.execute_proposal(json, tool_fn)` *(stub in current PyO3)* |
| Execute (daemon) | `registerToolHandler(fn)` → `rt.submitProposal(json, sessionId?)` | `register_tool_handler(fn)` → `rt.submit_proposal(json, session_id?, scope_json?)` |
| Inspect | `rt.eventCount()` / `rt.factCount()` | `rt.event_count()` / `rt.fact_count()` |

---

## The Agent Loop: Tools & the Callback Pattern

CAR is built on a single, blunt inversion of control: **the runtime does not own tools.** The model proposes actions; the runtime validates, schedules, and gates them; but when an action actually needs to *do* something — read a file, call an HTTP endpoint, send a message — it hands the work back to a callback you supply. Everything in this section follows from that one fact. The loop is `propose -> validate -> execute -> commit`, and the only part you author directly is the executor callback at the bottom and (optionally) the replan callback that closes the autonomous loop at the top.

Two daemon-era constraints frame everything below. First, **since v0.8 the Node and Python bindings are thin WebSocket clients** to a singleton `car-server` that must already be running — there is no embedded engine, and the v0.7.x `CAR_FFI_MODE=embedded` fallback is retired. Point the bindings at a non-default daemon with `CAR_DAEMON_URL=ws://...` (default `ws://127.0.0.1:9100`). Second, because of that, the tool callback you register is no longer a per-call closure passed into an in-process engine — it is a **process-wide handler registered once** and invoked by the daemon over bidirectional JSON-RPC.

### The ToolExecutor contract (Rust core)

At the Rust layer, every tool callback implements one async trait. This is the contract the entire engine is built around (`car-rs/crates/car-engine/src/executor.rs`):

```rust
#[async_trait::async_trait]
pub trait ToolExecutor: Send + Sync {
    async fn execute(&self, tool: &str, params: &Value) -> Result<Value, String>;

    /// Variant that also carries the originating proposal `Action.id`.
    async fn execute_with_action(
        &self,
        tool: &str,
        params: &Value,
        _action_id: &str,
    ) -> Result<Value, String> {
        self.execute(tool, params).await
    }
}
```

`execute_with_action` carries the originating `Action.id` so that a WebSocket executor can disambiguate **concurrent callbacks for the same tool** (car-releases#43) — independent actions in one DAG level fire simultaneously, so without the action id you cannot tell two in-flight `read_file` calls apart. In-process, the executor is a direct function call; in daemon mode, it is `car-server-core`'s `WsToolExecutor` issuing a JSON-RPC request back to your client. In NAPI, the bridge is a `ThreadsafeFunction`.

You attach an executor to the runtime via a builder chain, then run proposals:

```rust
let rt = Runtime::new().with_executor(Arc::new(MyExecutor));
// register schemas so verification can type-check params
rt.register_tool_schema(schema).await;
let result = rt.execute(&proposal).await; // ProposalResult { proposal_id, results, cost }
```

`Runtime::new()` is the default constructor; `set_executor(&self, executor)` is the async per-call form used by the NAPI binding.

### How a tool call actually dispatches

When an `ActionType::ToolCall` reaches the engine, dispatch follows a **fixed precedence order** (`executor.rs`). Knowing this order matters because it determines which handler wins when names collide and where your executor sits in the chain:

| Step | Handler | Notes |
|------|---------|-------|
| 1 | Cross-proposal `result_cache` | Returns cached result if the tool was opted in and entry is fresh |
| 2 | `rate_limiter.acquire(tool)` | Token-bucket backpressure (blocks until a token frees) |
| 3 | Built-in inference tools | `infer`, `infer.grounded`, `embed`, `classify`, `transcribe`, `synthesize` — only if an inference engine is attached. `infer`/`infer.grounded` auto-ground from memgine context |
| 4 | Built-in `memory.consolidate` | Only if memgine is attached |
| 5 | Built-in `messaging.send` | Only if a `MessageSink` is attached (`Runtime::with_message_sink`). With no sink the call is an **error**, not a fall-through to your executor — falling through would re-open the ungoverned transport this built-in exists to close. The daemon attaches one per session (iMessage, plus a host-backed fallback for any other channel — see `messaging.channel_send` in `docs/websocket-protocol.md`). Note that *executable* is not *offered*: `car do`'s assistant attaches a sink, so the tool is registered and governed there, but it is not in the model-visible tool list that executor advertises |
| 6 | **Your configured `tool_executor`** | Via `execute_with_action`. Falls through **only** if it returns an error whose message starts with exactly `"unknown tool"` |
| 7 | `agent_basics::execute` | The in-tree filesystem/utility executor |
| 8 | Error | `Err("no handler for tool '<name>'")` |

Successful results are written back into `result_cache`. The critical gotcha: **a bare `ToolCall` with no handler returns `Err("no handler for tool '<name>'")`** — there is no implicit default. And the fall-through from your executor to `agent_basics` only triggers on an error string beginning with the literal `"unknown tool"`; any other error is treated as a real failure, not a "not mine."

### The in-tree executor: `agent_basics`

CAR ships exactly **one** in-tree `ToolExecutor`, in `car-rs/crates/car-engine/src/agent_basics.rs`. It implements seven filesystem/utility tools. The runtime owns the *schemas* (`car_ir::builtins`) but not the implementations — `agent_basics` is the implementation for these seven, and it is opt-in via `rt.register_agent_basics().await`.

| Tool | Permission | Side effects | Category |
|------|-----------|--------------|----------|
| `read_file` | Allow | no | filesystem |
| `list_dir` | Allow | no | filesystem |
| `find_files` | Allow | no | filesystem |
| `grep_files` | Allow | no | filesystem |
| `calculate` | Allow | no | utility |
| `write_file` | **AskUser** | **yes** | filesystem |
| `edit_file` | **AskUser** | **yes** | filesystem |

```rust
pub fn entries() -> Vec<ToolEntry> {
    vec![
        ToolEntry::builtin(car_ir::builtins::read_file()).with_category("filesystem"),
        ToolEntry::builtin(car_ir::builtins::list_dir()).with_category("filesystem"),
        ToolEntry::builtin(car_ir::builtins::find_files()).with_category("filesystem"),
        ToolEntry::builtin(car_ir::builtins::grep_files()).with_category("filesystem"),
        ToolEntry::builtin(car_ir::builtins::calculate()).with_category("utility"),
        ToolEntry::builtin(car_ir::builtins::write_file())
            .with_permission(ToolPermission::AskUser)
            .with_side_effects(true)
            .with_category("filesystem"),
        ToolEntry::builtin(car_ir::builtins::edit_file())
            .with_permission(ToolPermission::AskUser)
            .with_side_effects(true)
            .with_category("filesystem"),
    ]
}
```

Implementation facts to internalize: `agent_basics::execute(substrate, tool, params)` returns `Option<Result<Value, String>>` where **`None` means "not my tool"** — chain a fallback executor for anything else. Paths resolve relative to cwd, reads support `offset`/`limit` lines, `MAX_FILE_BYTES` is 512 KB, and `walk_files` skips dotfiles, `node_modules`, `__pycache__`, and `target`. It is re-exported as `car_engine::agent_basic_entries`.

Read/edit semantics (H1/F4-remainder, audit 2026-07-06):

- **Guarded `read_file` returns line-numbered content** — `agent_basics::execute_with_ledger` produces `cat -n` style output, each line prefixed `%6d\t` (1-based; when `offset` is set, numbering starts at `offset + 1`). `size_bytes`/`total_lines` still describe the full file. Those prefixes are display-only; a model must strip them before reusing a line in `edit_file`/`write_file`. The plain `agent_basics::execute` keeps its historic raw `read_file` result for direct callers. Guarded reads are intentionally **not** result-cached, so a re-read after an edit never serves stale content.
- **Read-before-edit + staleness guard** — use `agent_basics::execute_with_ledger(substrate, &ReadLedger, tool, params)` (the opt-in sibling of `execute`) to enforce it: `edit_file`, and `write_file` over an *existing* file, require the session to have read that path first and its content to still match; a successful read/write/edit records the current content (so write→edit needs no intervening read). A paged read can license one unique targeted edit, but replace-all edits and writes or appends to an existing file require a fresh unpaged read. Creating a new file is ungated; an existing file that cannot be read as UTF-8 is rejected rather than treated as a new file. The plain `execute` runs ungated (unchanged stable API). Every in-repo executor (coder, assistant, bench, raw Runtime) threads session-isolated `ReadLedger` observations with same-path mutation serialization.
- **`edit_file`** replaces `old_text` with `new_text`; by default `old_text` must match **exactly once** (else it errors and names `replace_all`), or pass `replace_all: true` to replace every occurrence (`replacements` count returned).

### Tool identity: ToolEntry, permission, source

Every tool has a canonical identity in the `ToolRegistry` (`car-rs/crates/car-engine/src/registry.rs`) — the single source of truth for name, permission, source, side-effects, and category:

```rust
ToolEntry { schema, permission, source, side_effects: bool, category: Option<String> }
```

- **`ToolPermission`** = `Allow` | `AskUser` (**default**) | `Deny`.
- **`ToolSource`** = `Builtin` | `UserDefined` | `Subprocess` | `Mcp { server_name }`.

The default matters and bites people: `ToolPermission::default()` is `AskUser`, and `ToolEntry::new(schema)` (a `UserDefined` tool) defaults to `AskUser` **and** `side_effects = true`. Only `ToolEntry::builtin(schema)` defaults to `Allow` / `Builtin` / no side effects. **Caller-registered tools are gated by default** — you must opt them down to `Allow` if you want unattended execution. `ToolRegistry::allowed_schemas()` excludes only `Deny`.

### Registering a typed tool (schema-validated)

Registering a *schema* gives you static parameter type-checking at verify time plus automatic wiring of idempotency, caching, and rate-limit hints. Over NAPI this is `registerToolSchema(schemaJson)` (NAPI-only — `register_tool_schema` is referenced in Python docstrings but is **not** declared in `car_runtime.pyi`):

```json
{
  "name": "read_file",
  "description": "...",
  "parameters": {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},
  "returns": null,
  "idempotent": true,
  "cache_ttl_secs": 60,
  "rate_limit": {"max_calls": 100, "interval_secs": 60}
}
```

`verifyProposal` then type-checks each `Action.parameters` against this schema, and the engine auto-configures the cache and rate limiter from the hints. Schemaless `registerTool(name)` skips type validation entirely. The built-in `car_ir::builtins` module provides 11 schemas (`shell`, `read_file`, `edit_file`, `write_file`, `find_files`, `grep_files`, `list_dir`, `http_request`, `calculate`, `search`, `browser`); `builtins::all()` returns all 11. **These are schemas only** — registering them does not implement the tool.

### The daemon callback: register once, then submit

In daemon mode you do not pass a closure per execution. You register a **process-wide** tool handler once, then submit proposals against it. This is the standard single-agent authoring path.

The handler receives a single JSON string `{tool, params, action_id}` and returns a result string — note this signature differs from the embedded per-call `tool_fn`, which takes two positional args `(tool_name, params_json)`. Do not conflate them.

**NAPI (Node):**

```typescript
export function registerToolHandler(
  handlerFn: (callJson: string) => Promise<string>,
): void;
// then: const result = await rt.submitProposal(proposalJson, sessionId);
```

**PyO3 (Python):**

```python
from car_runtime import CarRuntime, register_tool_handler
import json

register_tool_handler(lambda call_json: json.dumps(run_tool(json.loads(call_json))))
rt = CarRuntime()
result = rt.submit_proposal(proposal_json)  # raises RuntimeError if no handler
```

Hard rules:
- **`submitProposal` fails up front if no handler is registered** — register before submitting any proposal that carries host tools, or the daemon rejects each host-tool action mid-proposal with a `-32000` error.
- **Only one handler is active at a time.** `unregisterToolHandler()` / `unregister_tool_handler()` clears it.
- This is the **stored-callback pattern**, not a `ThreadsafeFunction`. NAPI's legacy `inferStream` ABI still occupies a callback-bearing export but is not operational; all new tool/voice/multi-agent callbacks use stored-callback setters.

If you genuinely need per-call execution with a callback (rather than the process-wide handler), the NAPI standalone exists:

```typescript
export function executeProposal(
  rt: CarRuntime,
  proposalJson: string,
  toolFn: (callJson: string) => Promise<string>,
  sessionId?: string | null,
  scopeJson?: string | null,
): Promise<string>;
// toolFn receives {"tool":"name","params":{...},"action_id":"<id>"}
```

But note the daemon divergence: **`executeProposal` / `execute_proposal` are not the daemon path.** The PyO3 `execute_proposal` is a signature-parity stub (the daemon owns the executor); the canonical daemon flow is `registerToolHandler` + `submitProposal`.

### The DAG: where concurrency and the callback meet

The callback is invoked according to the execution DAG, so authoring tools well means understanding how the runtime schedules them. `build_dag(actions) -> Vec<Vec<usize>>` (`car-rs/crates/car-ir/src/dag.rs`) returns topological **levels** of action indices via Kahn's algorithm. Levels run sequentially; within a level, independent actions run **concurrently** via `futures::future::join_all` — *unless* the level has exactly one action or contains any `FailureBehavior::Abort` action, in which case it runs sequentially:

```rust
let levels = build_dag(&proposal.actions);
for level in &levels {
    let has_abort = level.iter()
        .any(|&i| proposal.actions[i].failure_behavior == FailureBehavior::Abort);
    if level.len() == 1 || has_abort {
        // Sequential execution
        for &idx in level { /* process_action ... */ }
    } else {
        // Concurrent execution via futures::join_all
        let futs: Vec<_> = level.iter()
            .map(|&idx| self.process_action(&proposal.actions[idx], ...))
            .collect();
        let level_results = futures::future::join_all(futs).await;
    }
}
```

Edges come from each action's `state_dependencies` matched against the keys other actions write (`expected_effects` or a `state_write`'s `parameters.key`), plus an implicit write-barrier chaining same-key writes. **The edge only forms when the writer appears earlier in the actions array** (`writer_idx < consumer index`) — a consumer listing a dependency on a key written by a *later* action gets no edge and may run before its producer. This is the single most common DAG authoring mistake. (See the IR section for the full proposal shape.)

### The per-action pipeline

Each action runs through a fixed pipeline before your callback ever sees it (`process_action_inner` in `executor.rs`), so a callback that's never called is usually a gate failing earlier:

1. **Idempotency check** — cache hit short-circuits.
2. **Capability check** — `tool_allowed` / `state_key_allowed`.
3. **Validation** — `validate_action` against registered tools + state.
4. **Policy check** — global `PolicyEngine` plus optional session `PolicyEngine`; both must pass (sessions can only *add* deny).
5. **`execute_with_retry`** — dispatch (this is where your callback fires).
6. **Cache** — idempotent successes are cached.

Retry semantics: retries happen **only** for `FailureBehavior::Retry` actions, with `max_attempts = max_retries + 1`. Backoff is `RETRY_BASE_DELAY_MS(100) * RETRY_BACKOFF_FACTOR(2)^(attempt-1)` ms. Each attempt is optionally wrapped in `tokio::time::timeout(action.timeout_ms)`:

```rust
const RETRY_BASE_DELAY_MS: u64 = 100;
const RETRY_BACKOFF_FACTOR: u64 = 2;
let max_attempts = if action.failure_behavior == FailureBehavior::Retry {
    action.max_retries + 1
} else { 1 };
```

On abort (a `Failed` action whose `failure_behavior == Abort`), subsequent actions become `Skipped`, and state is rolled back to the pre-proposal snapshot via `state.restore(snapshot, transition_count)`. The rollback also clears idempotency-cache entries for rolled-back idempotent successes so they re-run next time. **Rollback fires only on abort** — `Skip`/`Retry` failures do not roll back.

### Out-of-process tools: subprocess and MCP

Your callback does not have to be in-language. Two additional executor kinds let any program become a CAR tool.

**Subprocess tools** map a tool to an external process speaking JSON-RPC 2.0 over stdin/stdout. Any program that reads a JSON request from stdin and writes a JSON response to stdout works:

```rust
let request = JsonRpcRequest { jsonrpc: "2.0", method: tool_name.to_string(), params: params.clone(), id };
// write request_json + "\n" to child stdin, then drop stdin to signal EOF
// read stdout with tokio::time::timeout(tool.timeout, child.wait_with_output())
let response: JsonRpcResponse = serde_json::from_str(&output)?;
```

`SubprocessTool { command, args, cwd, env, timeout }` defaults to a 30 s timeout; on timeout the child is dropped (SIGKILL on Unix). Register with `rt.register_subprocess_tool(name, tool).await`, which chains the existing executor as a fallback:

```rust
pub async fn register_subprocess_tool(&self, name: &str, tool: SubprocessTool) {
    self.register_tool_schema(/* schema with name */).await;
    let mut guard = self.tool_executor.lock().await;
    let mut executor = match guard.take() {
        Some(existing) => SubprocessToolExecutor::new().with_fallback(existing),
        None => SubprocessToolExecutor::new(),
    };
    executor.register(name, tool);
    *guard = Some(std::sync::Arc::new(executor));
}
```

**MCP servers** (`car-rs/crates/car-engine/src/mcp.rs`) are discovered over stdio JSON-RPC (`protocolVersion 2024-11-05`, `initialize` → `notifications/initialized` → `tools/list` → `tools/call`) and registered under a canonical name `mcp_{server}_{tool}` (plus the bare name for routing convenience):

```rust
let tool_names: Vec<String> = tools.iter()
    .map(|t| format!("mcp_{}_{}", server_name, t.name))
    .collect();
```

```rust
let server = McpServer::start(McpServerConfig { name, command, args, env, cwd }).await?;
let exec = McpToolExecutor::new().with_fallback(my_executor);
let names = exec.add_server(server).await?; // mcp_{server}_{tool}
```

Crucially, **subprocess and MCP tools flow through the exact same capability / permission / policy checks** as any other tool — they are not a side door.

### Securing the callback: four composable layers

An author conflating these will leave gaps. There are four distinct mechanisms and they compose with **deny-wins, first-Deny-short-circuits** semantics. The order is enforced by the 6-stage `AuthzPipeline` (`car-rs/crates/car-engine/src/authz.rs`):

```rust
/// Stages (in order):
/// 1. Tool exists
/// 2. Capability allows it
/// 3. Permission mode / approval
/// 4. Permanent restrictions
/// 5. Policy engine
/// 6. Executor-level validation
pub async fn authorize(&self, action: &Action,
    tools: &HashMap<String, ToolSchema>,
    capabilities: Option<&crate::capabilities::CapabilitySet>,
    policies: &PolicyEngine, state: &StateStore) -> AuthzResult { /* ... */ }
```

1. **Capabilities** — *what an agent CAN touch* (allow-listing). A `CapabilitySet` carries `allowed_tools`, `denied_tools`, `allowed_state_keys`, `max_actions`. **Deny always wins, and an empty `allowed_tools` means ALL tools allowed, not none** — this is the easiest misread in the whole system; it is not deny-by-default.

   ```rust
   pub fn tool_allowed(&self, tool: &str) -> bool {
       if self.denied_tools.contains(tool) { return false; }
       if self.allowed_tools.is_empty() { return true; }
       self.allowed_tools.contains(tool)
   }
   ```

   Builder: `CapabilitySet::new().allow_tool("read_file").deny_tool("write_file").allow_state_key("plan").with_max_actions(5)`.

2. **Policies** — *deny rules evaluated per action* via the `PolicyEngine`. Over FFI, `registerPolicy(name, rule, ...)` rules are `deny_tool` | `deny_tool_param` | `require_state` | `deny_tool_callback`. Session policies (stage 5) are **conjunctive / additive-deny**: a session can deny what global allows but cannot allow what global denies.

3. **Permission mode + approval gate** (stage 3) — `Allow` / `AskUser` / `Deny`. The high-risk surfaces (AppleScript, Shortcuts, Mail, Messages, Vision OCR) park at `AskUser` until host approval. Hook your approval UX via the `PermissionHandler` trait (`async check -> AuthzDecision`; default `AllowAllPermissions`).

4. **Restrictions** (stage 4) — **permanent, never-bypassable** closures: `Restriction::new(name, description, |action| Option<reason>)`. No other stage can override a restriction.

The result tells you exactly where you were stopped:

```
AuthzResult { decision: Allow|AskUser|Deny, stage, reason_code, explanation, stage_results[] }
```

with `reason_code` values like `tool_not_found`, `capability_denied`, `permission_denied`, `approval_required`, `policy_violation`, `restriction_<name>`. Note that **stage 6 (Validation) is always marked `Allow` inside `authorize()`** — actual parameter validation is deferred to the caller after authorization.

### Closing the loop: propose → observe → re-propose

The pipeline above is the *deterministic half* (`verify -> execute`). The *autonomous half* is `propose -> observe -> re-propose`, and CAR ships the machinery for it: a `ReplanCallback` that the runtime calls when a proposal aborts.

```rust
rt.with_replan(Arc::new(cb), ReplanConfig {
    max_replans: 3,
    delay_ms: 0,
    verify_before_execute: true,
});
```

```rust
#[async_trait]
impl ReplanCallback for MyCb {
    async fn replan(&self, ctx: &ReplanContext) -> Result<ActionProposal, String> { /* ... */ }
}
```

On abort, the runtime rolls back, builds a `ReplanContext { failed_actions, completed_action_ids, state_snapshot, attempt, replans_remaining, ... }`, optionally sleeps `delay_ms`, calls `callback.replan(&ctx)` for a fresh `ActionProposal`, optionally verifies it via `car_verify::verify_with_schemas` when `verify_before_execute` (rejecting broken replans **without executing them**), and re-executes. This is the bridge a single-agent author most needs: a model-driven loop drives the `verify/execute` primitive repeatedly, re-proposing from observed failures, until the run reaches a terminal `AgentOutcome` (the IR's typed completion — `success`, `partial_success`, `give_up`, `timeout`, `failure`, `done`, all `is_terminal()`).

Two defaults to remember: **replanning is OFF by default** (`ReplanConfig.max_replans == 0`, zero overhead), and it fires **only on abort** — never on `Skip` or `Retry` failures.

### Authoring checklist for the loop

| You want to... | Do this |
|----------------|---------|
| Give an agent stdlib tools | `registerAgentBasics()` / `register_agent_basics()` — 7 fs/utility tools |
| Run host tools in daemon mode | `registerToolHandler(fn)` once, then `rt.submitProposal(json)` |
| Type-check tool params | `registerToolSchema(json)` (NAPI), set `parameters` JSON-Schema |
| Make a tool a non-language process | `register_subprocess_tool(name, tool)` (JSON-RPC over stdio) |
| Add an MCP server's tools | `McpToolExecutor::new().add_server(server)` → `mcp_{server}_{tool}` |
| Restrict what a tool can touch | `CapabilitySet` (deny-wins; empty allowlist = all allowed) |
| Add per-action deny rules | `registerPolicy(name, "deny_tool"/"deny_tool_param"/"require_state"/...)` |
| Hard-block a class of action forever | `Restriction::new(...)` (stage 4, never bypassable) |
| Recover from failures autonomously | `with_replan(cb, ReplanConfig{ max_replans: N, ... })` |
| Cache idempotent results | `enable_tool_cache(tool, ttl)` or `cache_ttl_secs` in the schema |
| Throttle a tool with backpressure | `set_rate_limit(tool, max_calls, interval_secs)` |

The through-line: you author the **edges** of the loop — the executor callback that does the work and the replan callback that recovers from failure — and CAR owns the deterministic middle (DAG scheduling, validation, the four authorization layers, retry/abort/rollback, caching, and rate limiting).

---

## Building the Autonomous Agent Loop

Every example in the rest of this guide stops after one round: build one
`ActionProposal`, verify it, execute it once, print the result. That is the
*unit* of CAR execution, not an agent. A real agent **closes the loop**: it
reads what came back, decides whether it is done, and — if not — asks the
model for the next proposal. This section documents that closed loop.

### The cycle

```
            ┌───────────────────────────────────────────────┐
            │                                               │
   prompt + │   1. PROPOSE   model → ActionProposal          │
  messages  │      infer_tracked / generate_candidates       │
            │                  │                            │
            │                  ▼                            │
            │   2. VERIFY    verifyProposal (static gate)    │
            │                  │  valid? ─ no ─► repair/replan│
            │                  ▼ yes                         │
            │   3. EXECUTE   executeProposal / submitProposal │
            │                  │  → ProposalResult            │
            │                  ▼                            │
            │   4. OBSERVE   read ActionResult[], state,      │
            │                  derive AgentOutcome            │
            │                  │                            │
            │                  ▼                            │
            │   5. terminal? ──no──► append ToolResults ─────┘
            │        │ yes
            │        ▼
            │   stop, return AgentOutcome
            └────────────────────────────────────────────────┘
```

The model **proposes**; the runtime **validates and executes**; the caller
**observes and decides**. CAR owns steps 2–4 (verification, the DAG executor,
the event log, state); the *loop control* in steps 1 and 5 is yours to write.
There is no single `run_agent()` FFI call — the loop is glue you assemble from
the primitives below.

### What makes it terminate

The loop ends when the observed `AgentOutcome` reaches a terminal status. The
outcome type is defined in
`car-rs/crates/car-ir/src/outcome.rs`:

```rust
pub struct AgentOutcome {
    pub status: OutcomeStatus,
    pub summary: String,
    pub evidence: Vec<Evidence>,
    pub metrics: OutcomeMetrics,
    pub timestamp: DateTime<Utc>,
}
```

`OutcomeStatus` (`car-rs/crates/car-ir/src/outcome.rs`, snake_case on the wire)
has exactly **six** variants — these are the real ones, do not invent others:

| Variant | Wire value | Meaning | `is_completed()` |
|---|---|---|---|
| `Success` | `"success"` | All goals met. | `true` |
| `PartialSuccess` | `"partial_success"` | Some goals met. | `true` |
| `GiveUp` | `"give_up"` | Agent decided it cannot finish. | `false` |
| `Timeout` | `"timeout"` | Exceeded a step/time limit. | `false` |
| `Failure` | `"failure"` | Errored out. | `false` |
| `Done` | `"done"` | Agent signaled done (neutral). | `true` |

Two helpers live on `OutcomeStatus`:

- **`is_terminal()` always returns `true`** — *every* `OutcomeStatus` is
  terminal (`outcome.rs` line 50, and `test_all_statuses_are_terminal`). The
  meaningful question at the bottom of the loop is therefore **"do I yet have
  an `AgentOutcome` at all?"**, not "is this outcome's status terminal?". Your
  loop runs while no terminal outcome has been derived, and you derive an
  `AgentOutcome` only when you decide to stop (the model emitted no more tool
  calls, an assertion failed, you hit a turn cap, etc.).
- **`is_completed()`** distinguishes *good* endings (`Success`,
  `PartialSuccess`, `Done`) from *bad* ones (`GiveUp`, `Timeout`, `Failure`).

`AgentOutcome` is a *caller-derived* summary type, not a value the executor
returns for you. `executeProposal` / `submitProposal` return a
`ProposalResult`; you inspect that (plus model signals like "no more tool
calls") and **construct** the `AgentOutcome` yourself. The Rust constructors
(`AgentOutcome::success`, `::failure`, `::timeout`, `::give_up`,
`.with_evidence`, `.with_metrics`) are not exposed across the FFI bindings —
in JS/Python you build the equivalent plain object.

`Evidence` (kind ∈ `self_assessment`, `tool_result`, `state_change`,
`external_verification`, `stop_reason`, `evaluator`) and `OutcomeMetrics`
(`turns`, `tool_calls`, `duration_ms`, `retries`, `actions_succeeded`,
`actions_failed`) round out the outcome so the stop decision is auditable.

---

### Front half — turning a model into a valid proposal

There are two supported routes from "a model and a prompt" to "a verified
`ActionProposal`".

#### Route A — manual: `inferTracked` → tool_calls → ActionProposal

`inferTracked` (NAPI `inferTracked`, PyO3 `infer_tracked`) is the multi-turn,
tool-aware inference call. Unlike plain `infer` (which returns a string), it
returns a JSON object exposing the model's `tool_calls`. Its signature
(`car-rs/crates/car-ffi-napi/npm/index.d.ts` ~L259,
`car-rs/crates/car-ffi-pyo3/car_runtime.pyi` ~L354):

```ts
inferTracked(
  prompt, model?, maxTokens?, context?,
  toolsJson?,        // JSON array of tool schemas the model may call
  messagesJson?,     // JSON array of Message — the running transcript
  toolChoice?,       // "auto" | "required" | "none" | a tool name
  parallelToolCalls?,
  imagesJson?,
): Promise<string>
```

The returned JSON shape (`car-rs/crates/car-inference/src/lib.rs`,
`InferenceResult`):

```jsonc
{
  "text": "...",                  // empty when the model chose to call tools
  "tool_calls": [                 // car-inference ToolCall (generate.rs L207)
    { "id": "call_abc", "name": "read_file", "arguments": { "path": "..." } }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "model_used": "...", "trace_id": "...",
  "latency_ms": 0, "time_to_first_token_ms": null
}
```

The conversation transcript is `messagesJson`, a JSON array of `Message`
(`car-rs/crates/car-inference/src/tasks/generate.rs` L343, tagged by `role`,
snake_case):

```jsonc
{ "role": "system", "content": "..." }
{ "role": "user", "content": "..." }
{ "role": "assistant", "content": "", "tool_calls": [ { "id", "name", "arguments" } ] }
{ "role": "tool_result", "tool_use_id": "call_abc", "content": "<result json>" }
```

You convert each model `tool_call` (`{ name, arguments }`) into an
`ActionProposal` action (`{ tool: name, parameters: arguments }`) — that is the
small piece of glue between the inference IR and the action IR. The
`ActionProposal` / `Action` shapes are in
`car-rs/crates/car-ir/src/actions.rs` (the only required field on a proposal is
`actions`; `Action.type` defaults to making `tool` required).

#### Route B — planner: `rankProposals` / `setReplanConfig`

When you want the model to *try several plans* and keep the best, use the
planner stack instead of hand-rolling selection:

- **`car-active-planner`** `generate_candidates(engine, goal, config, failure_context?)`
  (`car-rs/crates/car-active-planner/src/generate.rs` L140) fires N
  strategy-diverse inference calls and `parse_proposal()`
  (`.../parse.rs` L25) turns each completion into an `ActionProposal`.
- **`car-planner`** `Planner::rank()` / `Planner::pick_best()`
  (`car-rs/crates/car-planner/src/lib.rs` L347/L383) statically score the
  candidates — pure Rust, **zero inference** — using verification validity,
  cost/token efficiency, parallelism, and optional historical tool feedback.

The piece of that stack exposed across the FFI is **`rankProposals`** (NAPI
`rankProposals`, PyO3 `rank_proposals`,
`index.d.ts` L1349 / `car_runtime.pyi` L944):

```ts
rankProposals(candidatesJson, tools?, costWeight?): string  // JSON array of ScoredProposal
```

Each `ScoredProposal` (`car-planner/src/lib.rs` L159) carries `index`, `score`,
`validity`, `cost_efficiency`, `valid`, `error_count`, `action_count`,
`parallelism_levels`, `token_estimate`, `quality_per_token`, etc. Pick the
entry with the highest `score` where `valid === true`, then execute the
candidate at that `index`.

For *runtime* replanning — the model's chosen proposal failed mid-execution and
you want CAR to substitute a better alternative automatically — set
**`setReplanConfig(maxReplans, delayMs?)`** (NAPI `setReplanConfig`
`index.d.ts` L107, PyO3 `set_replan_config` `car_runtime.pyi` L240). `0`
(the default) disables it; a positive value lets the engine's
`ActiveReplanAdapter` (`car-active-planner`) produce and run an alternative up
to `maxReplans` times before surfacing the failure to you.

> Route B is what to reach for in production loops. Route A is the most
> transparent — you see every model decision — and is the right starting point.

---

### Back half — execute, then observe

#### Execute

You run the verified proposal with one of two standalone calls:

- **`executeProposal(rt, proposalJson, toolFn, sessionId?, scopeJson?)`** — NAPI
  only (`index.d.ts` L704). `toolFn(callJson)` receives `{ tool, params }` as a
  JSON string per action and returns a JSON result string.
- **`submitProposal(proposalJson, sessionId?)`** + **`registerToolHandler(handler)`**
  — the daemon-side path, present in **both** NAPI (`index.d.ts` L461/L909) and
  PyO3 (`car_runtime.pyi` L295/L964). Register the host-tool handler once, then
  submit. On PyO3 this is the **only** working execution path:
  `execute_proposal` is a documented stub that raises
  `RuntimeError("… not exposed in the FFI bindings — the daemon owns the
  executor …")` (`car_runtime.pyi` L286).

Both return a JSON-encoded **`ProposalResult`**
(`car-rs/crates/car-ir/src/actions.rs` L235):

```jsonc
{
  "proposal_id": "…",
  "results": [ /* ActionResult[] */ ],
  "cost": { "tool_calls": 0, "actions_executed": 0, "actions_skipped": 0,
            "total_duration_ms": 0, "retries": 0 }   // CostSummary
}
```

#### Observe

Each `ActionResult` (`actions.rs` L137) is your per-action observation:

```jsonc
{
  "action_id": "a1",
  "status": "succeeded",            // ActionStatus: proposed|validated|rejected|
                                    //   executing|succeeded|failed|skipped
  "output": { /* whatever toolFn returned */ },
  "error": null,                    // string when status == "failed"|"rejected"
  "state_changes": { "key": "value" },
  "duration_ms": 12.3
}
```

`ProposalResult` has two convenience predicates mirrored from the Rust helpers:
`all_succeeded()` (true iff every `ActionResult.status === "succeeded"`) and
`summary()` (counts per status). The loop's observation step is: read
`results`, feed each action's `output`/`error` back into the transcript as a
`tool_result` message, and decide the outcome — `Success`/`Done` when the model
stops requesting tools, `Failure` when a result errored and you can't recover,
`Timeout` when you hit your own turn cap, `GiveUp` when the model says so.

---

### Complete example — Node (NAPI, camelCase)

This is a single autonomous agent that loops until terminal. It uses Route A
(transparent) and the standalone `executeProposal`. Glue that has no dedicated
helper (transcript management, tool_call→action mapping, outcome derivation) is
plain JS and marked as such.

```js
// Daemon required since v0.8: start it once before running.
//   npx --package=car-runtime car-server &
const { CarRuntime, executeProposal } = require('car-runtime');

// --- tool implementations live in YOUR process; CAR does not own them ---
const TOOLS = {
  read_file: ({ path }) => ({ contents: require('fs').readFileSync(path, 'utf8') }),
  finish:    ({ answer }) => ({ answer }),   // sentinel tool the model calls when done
};

// Tool schemas the model may call (passed to inferTracked as toolsJson).
const TOOL_SCHEMAS = [
  { name: 'read_file', description: 'Read a UTF-8 file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'finish', description: 'Return the final answer and stop',
    parameters: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } },
];

async function runAgent(goal, { maxTurns = 8 } = {}) {
  const rt = new CarRuntime();
  await rt.registerAgentBasics();          // CAR's built-in utility tools
  for (const t of TOOL_SCHEMAS) await rt.registerTool(t.name);
  // Declarative guardrail enforced in Rust on every action (not a prompt rule):
  await rt.registerPolicy('no_etc', 'deny_tool_param', 'read_file', 'path', '/etc');

  // messages is the running transcript (plain JS — there's no FFI helper for it).
  const messages = [
    { role: 'system', content: 'You are a file-reading agent. Call finish when done.' },
    { role: 'user', content: goal },
  ];

  let outcome = null;                      // null === "no terminal outcome yet"
  let turns = 0;
  const metrics = { turns: 0, tool_calls: 0, actions_succeeded: 0, actions_failed: 0 };

  // is_terminal() is always true once an AgentOutcome exists, so loop on its existence.
  while (outcome === null) {
    if (++turns > maxTurns) {              // our own step cap -> Timeout
      outcome = { status: 'timeout', summary: `hit ${maxTurns}-turn cap`,
                  evidence: [{ kind: 'stop_reason', description: 'max turns', data: { maxTurns } }],
                  metrics };
      break;
    }
    metrics.turns = turns;

    // 1. PROPOSE — multi-turn, tool-aware inference.
    const tracked = JSON.parse(await rt.inferTracked(
      /* prompt */ '',                     // empty: the transcript carries the task
      /* model */ null, /* maxTokens */ 1024,
      /* context */ null,
      /* toolsJson */ JSON.stringify(TOOL_SCHEMAS),
      /* messagesJson */ JSON.stringify(messages),
      /* toolChoice */ 'auto',
    ));

    // No tool calls => the model is answering in prose; treat as Done.
    if (!tracked.tool_calls || tracked.tool_calls.length === 0) {
      outcome = { status: 'done', summary: tracked.text || 'no further actions',
                  evidence: [{ kind: 'self_assessment', description: tracked.text, data: null }],
                  metrics };
      break;
    }

    // Record the assistant turn verbatim so the next call has full history.
    messages.push({ role: 'assistant', content: tracked.text || '', tool_calls: tracked.tool_calls });

    // Glue (no FFI helper): model tool_calls -> ActionProposal actions.
    const proposal = JSON.stringify({
      source: tracked.model_used,
      actions: tracked.tool_calls.map((tc, i) => ({
        id: tc.id || `a${i}`,
        type: 'tool_call',
        tool: tc.name,
        parameters: tc.arguments || {},
        dependencies: [],
      })),
    });

    // 2. VERIFY — static gate. Never execute an unverified proposal.
    const check = JSON.parse(await rt.verifyProposal(proposal));
    if (!check.valid) {
      // Feed the failure back so the model can repair on the next turn.
      messages.push({ role: 'user',
        content: `Proposal rejected by the runtime: ${JSON.stringify(check.issues)}. Try again.` });
      continue;
    }

    // 3. EXECUTE — runtime owns the DAG, idempotency, retries, rollback.
    let answer = null;
    const result = JSON.parse(await executeProposal(rt, proposal, async (callJson) => {
      const { tool, params } = JSON.parse(callJson);   // note: key is `params`
      const fn = TOOLS[tool];
      if (!fn) throw new Error(`unknown tool: ${tool}`);
      const out = fn(params);
      if (tool === 'finish') answer = out.answer;
      return JSON.stringify(out);
    }));

    // 4. OBSERVE — read ActionResult[], append tool_result turns, update metrics.
    for (const r of result.results) {            // ActionResult
      const tc = tracked.tool_calls.find((c, i) => (c.id || `a${i}`) === r.action_id);
      messages.push({
        role: 'tool_result',
        tool_use_id: r.action_id,
        content: JSON.stringify(r.status === 'succeeded' ? (r.output ?? {}) : { error: r.error }),
      });
      metrics.tool_calls += 1;
      if (r.status === 'succeeded') metrics.actions_succeeded += 1;
      else metrics.actions_failed += 1;
    }

    // 5. Terminal? The `finish` sentinel ran successfully -> Success.
    if (answer !== null) {
      outcome = { status: 'success', summary: answer,
                  evidence: [{ kind: 'tool_result', description: 'finish called', data: { answer } }],
                  metrics };
    }
    // otherwise outcome stays null and we loop for the next proposal.
  }

  return outcome;   // AgentOutcome-shaped object; outcome.status is the terminal state
}

runAgent('Summarize ./README.md, then call finish.')
  .then((o) => console.log(o.status, '—', o.summary))
  .catch((e) => { console.error(e); process.exit(1); });
```

### Complete example — Python (snake_case)

Same loop, mirrored. PyO3's `execute_proposal` is a daemon-only stub, so this
uses the supported path: `register_tool_handler(handler)` once, then
`submit_proposal(...)` inside the loop.

```python
# Daemon required (v0.8+). Build the binding with `maturin develop` or pip install.
import json
import car_runtime

TOOLS = {
    "read_file": lambda p: {"contents": open(p["path"], encoding="utf-8").read()},
    "finish":    lambda p: {"answer": p["answer"]},
}
TOOL_SCHEMAS = [
    {"name": "read_file", "description": "Read a UTF-8 file",
     "parameters": {"type": "object",
                    "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "finish", "description": "Return the final answer and stop",
     "parameters": {"type": "object",
                    "properties": {"answer": {"type": "string"}}, "required": ["answer"]}},
]


# Single dispatcher handler — daemon calls it as handler(call_json) -> json_str.
def tool_handler(call_json: str) -> str:
    call = json.loads(call_json)                 # {"tool": "...", "params": {...}}
    fn = TOOLS.get(call["tool"])
    if fn is None:
        return json.dumps({"error": f"unknown tool: {call['tool']}"})
    return json.dumps(fn(call["params"]))


def run_agent(goal: str, max_turns: int = 8) -> dict:
    rt = car_runtime.CarRuntime()
    rt.register_agent_basics()
    for t in TOOL_SCHEMAS:
        rt.register_tool(t["name"])
    rt.register_policy("no_etc", "deny_tool_param",
                       target="read_file", key="path", pattern="/etc")
    car_runtime.register_tool_handler(tool_handler)   # required before submit_proposal

    messages = [
        {"role": "system", "content": "You are a file-reading agent. Call finish when done."},
        {"role": "user", "content": goal},
    ]
    metrics = {"turns": 0, "tool_calls": 0, "actions_succeeded": 0, "actions_failed": 0}
    outcome = None            # None == no terminal AgentOutcome yet
    turns = 0

    # is_terminal() is always True once an outcome exists -> loop on its existence.
    while outcome is None:
        turns += 1
        metrics["turns"] = turns
        if turns > max_turns:                         # our own cap -> Timeout
            outcome = {"status": "timeout", "summary": f"hit {max_turns}-turn cap",
                       "evidence": [{"kind": "stop_reason", "description": "max turns",
                                     "data": {"max_turns": max_turns}}],
                       "metrics": metrics}
            break

        # 1. PROPOSE
        tracked = json.loads(rt.infer_tracked(
            "",                                       # transcript carries the task
            None, 1024, None,
            json.dumps(TOOL_SCHEMAS),                 # tools_json
            json.dumps(messages),                     # messages_json
            "auto",                                   # tool_choice
        ))

        if not tracked.get("tool_calls"):
            outcome = {"status": "done", "summary": tracked.get("text", ""),
                       "evidence": [{"kind": "self_assessment",
                                     "description": tracked.get("text", ""), "data": None}],
                       "metrics": metrics}
            break

        messages.append({"role": "assistant", "content": tracked.get("text", ""),
                         "tool_calls": tracked["tool_calls"]})

        # Glue: model tool_calls -> ActionProposal actions.
        proposal = json.dumps({
            "source": tracked.get("model_used", "model"),
            "actions": [
                {"id": tc.get("id") or f"a{i}", "type": "tool_call",
                 "tool": tc["name"], "parameters": tc.get("arguments", {}),
                 "dependencies": []}
                for i, tc in enumerate(tracked["tool_calls"])
            ],
        })

        # 2. VERIFY
        check = json.loads(rt.verify_proposal(proposal))
        if not check["valid"]:
            messages.append({"role": "user",
                             "content": f"Proposal rejected: {check['issues']}. Try again."})
            continue

        # 3. EXECUTE (daemon-side; handler registered above)
        result = json.loads(rt.submit_proposal(proposal))   # -> ProposalResult JSON

        # 4. OBSERVE
        answer = None
        for r in result["results"]:                  # ActionResult
            ok = r["status"] == "succeeded"
            messages.append({"role": "tool_result", "tool_use_id": r["action_id"],
                             "content": json.dumps(r.get("output") if ok
                                                   else {"error": r.get("error")})})
            metrics["tool_calls"] += 1
            metrics["actions_succeeded" if ok else "actions_failed"] += 1
            if ok and r.get("output", {}).get("answer") is not None:
                answer = r["output"]["answer"]

        # 5. Terminal?
        if answer is not None:
            outcome = {"status": "success", "summary": answer,
                       "evidence": [{"kind": "tool_result",
                                     "description": "finish called", "data": {"answer": answer}}],
                       "metrics": metrics}

    return outcome


if __name__ == "__main__":
    o = run_agent("Summarize ./README.md, then call finish.")
    print(o["status"], "—", o["summary"])
```

> **Note on `submit_proposal`'s ProposalResult shape.** The daemon's
> `proposal.submit` response wraps the same `results` / `cost` data; read the
> `results` array exactly as above. If your daemon build nests it under a
> `result` key, unwrap once before iterating — `submit_proposal` returns the raw
> daemon JSON-RPC response string.

---

### Where the runtime stops you

The loop is not "model says jump, runtime jumps." Three gates fire **before any
side effect**, inside step 2–3:

1. **Verification** — `verifyProposal` (`index.d.ts` L444 / `car_runtime.pyi`
   L256) statically checks the proposal: unknown tools, parameter-schema
   mismatches, unsatisfiable preconditions, dependency cycles. It returns
   `{ valid, issues, execution_levels }`. **Call it every turn and bail/replan
   on `valid === false`** — that is the cheapest place to catch a bad plan.
2. **Policy** — declarative policies registered with `registerPolicy`
   (`deny_tool`, `deny_tool_param`, `require_state`, `deny_tool_callback`) run
   in **Rust on every action before the tool callback fires**. A denied action
   never reaches your `toolFn`; it surfaces as a `rejected`/`failed`
   `ActionResult`. This replaces prompt-based "please don't do X" guarding.
3. **Validation + execution semantics** — the engine
   (`car-rs/crates/car-engine`, `Runtime`) builds the DAG, enforces idempotency,
   `timeout_ms`, `max_retries`, `failure_behavior` (`abort` stops downstream
   actions; `skip` continues; `retry` re-runs), rate limits, and **rolls state
   back to a pre-proposal snapshot on abort**. You observe the consequences in
   `ActionResult.status` / `error`, never a half-applied state.

**Daemon reality (v0.8+).** The NAPI and PyO3 bindings are **thin WebSocket
clients to a singleton `car-server` daemon** — there is no embedded executor in
the binding anymore. Start the daemon first
(`npx --package=car-runtime car-server &`, default `ws://127.0.0.1:9100`,
override with `CAR_DAEMON_URL`). Memory and execution calls (`add_fact`,
`build_context`, `submit_proposal`, `event_count`) **reject with a
daemon-unreachable error** if it is down rather than silently no-op'ing (car
#146). Your whole loop runs against that one daemon process; `executeProposal`
(NAPI) and `submit_proposal` (PyO3, via `register_tool_handler`) both round-trip
the tool callback back to your process over the same connection.

---

### Gotchas

- **`is_terminal()` is always `true`.** `OutcomeStatus::is_terminal()` returns
  `true` for *every* variant (`outcome.rs` L50). Do **not** write
  `while (!status.is_terminal())` against a real status — it would never loop.
  Loop on *"have I derived an `AgentOutcome` yet?"* and call `is_completed()` to
  tell good endings from bad ones.
- **`infer_tracked`, not `infer`.** Plain `infer` returns a bare string with no
  `tool_calls` — useless for a tool-using loop. Use `infer_tracked` /
  `inferTracked` (or `inferTrackedWithRequest` for the full options object) and
  read its `tool_calls` array.
- **Two `tool_call` shapes — convert deliberately.** The model emits
  `car-inference` `ToolCall` `{ id, name, arguments }` (`generate.rs` L207). The
  executor consumes `car-ir` `Action` `{ id, type:"tool_call", tool, parameters }`
  (`actions.rs`). Mapping `name→tool` and `arguments→parameters` is **your**
  glue; there is no FFI helper for it.
- **Callback receives `params`, not `parameters`.** Inside `executeProposal`'s
  `toolFn`, the parsed call JSON is `{ tool, params }` (and PyO3
  `register_tool_handler` receives `{ tool, params }` too). Don't reach for
  `parameters` there.
- **`tool_choice` controls forward progress.** `"auto"` lets the model decide
  when to stop calling tools (your natural `Done`/`Success` signal). `"required"`
  forces a tool call every turn — only use it when you have an explicit `finish`
  sentinel tool, or the loop can't terminate via "no more tool calls."
- **Message ordering is load-bearing.** Append in strict order:
  `assistant` (with its `tool_calls`) → one `tool_result` per call (matched by
  `tool_use_id` / `action_id`) → then the next `inferTracked`. Skipping the
  `assistant` turn or mismatching ids corrupts multi-turn tool flows.
- **`executeProposal` is standalone; PyO3 can't use it.** In NAPI it's a
  top-level function `executeProposal(rt, …)`, not a method (a ThreadsafeFunction
  constraint). In PyO3 `execute_proposal` is a **stub that raises** — use
  `register_tool_handler` + `submit_proposal`.
- **Everything crosses the FFI as JSON strings.** `JSON.stringify` /
  `json.dumps` proposals and message arrays going in; `JSON.parse` /
  `json.loads` the `verifyProposal`, `inferTracked`, and execution results
  coming out.
- **`AgentOutcome` is yours to build.** The Rust constructors and
  `with_evidence` / `with_metrics` builders are not exposed in the bindings —
  assemble the equivalent plain object (`{ status, summary, evidence, metrics }`)
  in JS/Python, as the examples do.
- **Daemon must be up first.** A loop that calls `inferTracked` /
  `submit_proposal` against a dead daemon rejects immediately (car #146) — start
  `car-server` before the first turn.

---

## Agent IR, Proposals & Static Verification

The **Agent IR** is the single contract every other CAR surface builds on. A model proposes; the runtime validates and executes. Concretely, a model emits an `ActionProposal` (a batch of `Action`s), the runtime *verifies* it statically, executes the survivors as a DAG, and returns a `ProposalResult`. Because the IR encodes richer semantics than raw function-call JSON — preconditions, expected effects, state dependencies, idempotency, and failure behavior — the same wire shape drives verification, execution, planning, workflow stages, and the autonomous propose→observe→re-propose loop.

The IR types live in the `car-ir` crate. The Rust types in `car-rs/crates/car-ir/src/` are the source of truth; `docs/agent-ir-spec.md` mirrors them. Every enum uses `#[serde(rename_all = "snake_case")]` and every optional field uses `#[serde(default)]`, so the JSON round-trips **unchanged** across NAPI (camelCase method names, snake_case JSON keys), PyO3 (snake_case), and the WebSocket JSON-RPC protocol. Internalize one wire shape and you have all three.

> **Daemon-first reminder.** Since v0.8 every FFI binding is a thin WebSocket client to a singleton `car-server`. The proposal you build is identical, but *where it executes* is the daemon. `executeProposal` (NAPI) / `execute_proposal` (PyO3) / `proposal.submit` (WS) all funnel into the same daemon dispatcher — and `execute_proposal` is **daemon-only** (it raises in PyO3 if the daemon isn't reachable). Start the daemon first, then submit. Static analysis (`verify_proposal` / `verify`) likewise runs server-side under the daemon-first model.

### The `ActionProposal`: a verify-then-execute batch

`ActionProposal` (`car-ir/src/actions.rs:114-129`) is the unit you submit. It carries a batch of actions plus metadata that is logged but not interpreted.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `id` | `String` | `short_id()` (12 hex chars from UUIDv4) | Auto-generated if absent |
| `source` | `String` | `"unknown"` | Free-form, e.g. the model name |
| `actions` | `Vec<Action>` | **none — required** | The *only* field with no `#[serde(default)]` |
| `timestamp` | `DateTime<Utc>` | `Utc::now()` | |
| `context` | `HashMap<String, Value>` | `{}` | Passed to the event log, not interpreted |

> **Gotcha:** `actions` is the only required field. An empty/absent `actions` array fails deserialization, while everything else silently defaults.

The minimal valid proposal is therefore just an actions array:

```jsonc
{
  "id": "abc123def456",                // optional; auto-generated if absent
  "source": "claude-opus-4-7",         // optional; defaults to "unknown"
  "timestamp": "2026-05-02T12:00:00Z", // optional; defaults to now
  "actions": [ /* see below */ ],
  "context": { "rationale": "User asked for a deploy", "session_id": "..." }
}
```

Submit it via `proposal.submit` (WebSocket), `executeProposal` (NAPI), or `execute_proposal` (PyO3).

### The `Action`: the core unit of intent

`Action` (`car-ir/src/actions.rs:70-107`) is what a model actually proposes. Note the JSON key is `type`, but the Rust field is `action_type` (`#[serde(rename = "type")]`).

| Field (JSON) | Type | Default | Purpose |
|--------------|------|---------|---------|
| `id` | `String` | `short_id()` | |
| `type` | `ActionType` | **required** | The action kind (Rust: `action_type`) |
| `tool` | `Option<String>` | `None` (skipped if null) | Required *by the runtime* when `type == "tool_call"` |
| `parameters` | `HashMap<String, Value>` | `{}` | Passed verbatim to the tool callback |
| `preconditions` | `Vec<Precondition>` | `[]` | State predicates checked before running |
| `expected_effects` | `HashMap<String, Value>` | `{}` | Claimed state changes (drives verify/simulate + DAG) |
| `state_dependencies` | `Vec<String>` | `[]` | State keys read; informs DAG edges |
| `idempotent` | `bool` | `false` | Enables result caching + safe retry |
| `max_retries` | `u32` | `3` | Only consulted when `failure_behavior == "retry"` |
| `failure_behavior` | `FailureBehavior` | `Abort` | What to do on failure |
| `timeout_ms` | `Option<u64>` | `None` (unbounded) | |
| `metadata` | `HashMap<String, Value>` | `{}` | Not interpreted |

A complete `tool_call` action with a gate and a dependency:

```jsonc
{
  "id": "a1",                              // optional; auto-generated
  "type": "tool_call",                     // required: see ActionType
  "tool": "deploy",                        // required when type == "tool_call"
  "parameters": { "env": "staging" },
  "preconditions": [
    { "key": "tests_passed", "operator": "eq", "value": true }
  ],
  "expected_effects": { "deployed": true },
  "state_dependencies": ["build_artifact"],
  "idempotent": true,
  "max_retries": 3,                        // default 3
  "failure_behavior": "retry",             // default "abort"
  "timeout_ms": 30000,
  "metadata": { "rationale": "..." }
}
```

#### `ActionType` — the complete action-kind catalog

These four (`actions.rs:10-17`) are the whole catalog:

| Variant (JSON) | Behavior |
|----------------|----------|
| `tool_call` | Invoke a registered tool with `parameters` |
| `state_write` | Set state keys directly, no tool dispatch — uses `parameters.key` + `parameters.value` |
| `state_read` | Read state keys |
| `assertion` | Check a state predicate holds; fail the proposal if not |

#### `FailureBehavior` — what happens on failure

`FailureBehavior` (`actions.rs:20-27`, default `Abort`):

| Variant (JSON) | Behavior |
|----------------|----------|
| `abort` | Stop the proposal; downstream actions not executed |
| `retry` | Retry up to `max_retries`, then abort |
| `skip` | Mark skipped, continue with the rest |

> **Gotcha:** When a *policy* denies an action, `retry` is downgraded to `abort` (retrying a denied action would loop). Only `abort` and `skip` behave as written under policy denial.

### Preconditions: gating an action on state

A `Precondition` (`car-ir/src/precondition.rs`, struct at `actions.rs:45-55`) is a plain struct, not an enum — `operator` is a string, defaulting to `"eq"`.

| Field | Default |
|-------|---------|
| `key: String` | required |
| `operator: String` | `"eq"` |
| `value: Value` | `null` |
| `description: String` | `""` |

The full operator catalog (enforced in `precondition.rs::check_precondition`, which returns `Some(error_message)` on failure / `None` on pass):

| Operator | Semantics |
|----------|-----------|
| `eq`, `neq` | Equality / inequality on `Value` |
| `gt`, `lt`, `gte`, `lte` | Numeric; both sides coerced via `as_f64` |
| `exists`, `not_exists` | Key presence (`value` ignored) |
| `contains` | Substring on string-coerced value, or membership |

> **Gotchas:** (1) Numeric operators silently coerce via `as_f64` and return a "cannot compare" failure if either side isn't a number — they never throw. (2) An **unknown** operator is treated as a **failed** check (`"unknown operator '...'"`), not ignored — this is intentional forward-compat so older runtimes fail on operators they don't understand. (3) Precondition logic runs identically in static verify and runtime validate because both `car_verify::StaticState` and `car_state::StateStore` implement the `StateView` trait (`get_value`, `key_exists`, `is_unknown`). Symbolic `is_unknown` keys cannot be disproven, so value comparisons against them pass during static verify.

### State dependencies form the DAG

`build_dag(actions: &[Action]) -> Vec<Vec<usize>>` (`car-ir/src/dag.rs`) returns **topological execution levels**: actions in one level run concurrently (`futures::future::join_all`), levels run sequentially via Kahn's algorithm.

Edges are built from two sources:

1. **Producer/consumer:** each action's `state_dependencies` is matched against a *writers map* of keys written by `state_write` (`parameters.key`) or any `expected_effects` key, last-writer-wins. **An edge forms only when the writer appears earlier in the actions array (`writer_idx < consumer_idx`).**
2. **Write barrier:** a `state_write` to a key implicitly depends on all earlier `state_write`s to the same key.

To order two actions: have the producer declare the key in `expected_effects` (e.g. `{"deployed": true}`) or be a `state_write` whose `parameters.key` is that key; have the consumer list that key in `state_dependencies`. Independent actions land in the same level and run concurrently.

> **Gotchas:** (1) A consumer that lists a `state_dependency` on a key written by a *later* action gets **no edge** and may run before the writer. Order matters in the array. (2) `expected_effects` uses last-writer-wins; if several actions write the same key, only the last is tracked for dependency resolution (the `state_write` barrier only chains same-key `state_write`s). (3) Two unordered actions writing the same key produce a write **conflict** in verify output. (4) On a cycle/unsatisfiable graph the builder takes the smallest remaining index to make progress rather than deadlocking.

### Tool schemas: registering capability shapes

A `ToolSchema` (`actions.rs:168-188`) is registered when a tool is added. The runtime **never owns tools** — the schema supplies validation/caching/throttling metadata, but the caller still provides the execution callback.

| Field | Default | Purpose |
|-------|---------|---------|
| `name: String` | required, unique | |
| `description: String` | `""` | |
| `parameters: Value` | `{}` (JSON Schema) | An empty `{}` means *schemaless* (accepts anything) |
| `returns: Option<Value>` | `None` | JSON Schema, validated when set |
| `idempotent: bool` | `false` | Enables cache + retry safety |
| `cache_ttl_secs: Option<u64>` | `None` | Caches results for this duration when set |
| `rate_limit: Option<ToolRateLimit>` | `None` | `{ max_calls: u32, interval_secs: f64 }` |

`car_ir::builtins` ships **11 schemas** (schemas only — the runtime does not implement them): `shell`, `read_file`, `edit_file`, `write_file`, `find_files`, `grep_files`, `list_dir`, `http_request`, `calculate`, `search`, `browser`. `builtins::all()` returns all 11; `builtins::shell()` returns one. (`shell` has a required `command` param plus optional `cwd`, `timeout_ms`, and `idempotent=false`.)

```rust
use car_ir::builtins;

// Register all common schemas
for schema in builtins::all() {
    runtime.register_tool_schema(schema).await;
}

// Or pick specific ones
runtime.register_tool_schema(builtins::shell()).await;
runtime.register_tool_schema(builtins::read_file()).await;
```

> **Gotcha:** Registering a `builtins::` schema does **not** implement the tool. You must still supply the tool callback. To make a tool cacheable and retry-safe, set `idempotent: true` (and optionally `cache_ttl_secs`) on the schema *and* `idempotent: true` on the action.

### Results: `ProposalResult`, `ActionResult`, `CostSummary`

`ProposalResult` (`actions.rs:235-260`) is what `proposal.submit` / `executeProposal` / `execute_proposal` return:

```jsonc
{
  "proposal_id": "abc123def456",
  "results": [
    { "action_id": "a1", "status": "succeeded", "output": { "deployed": true },
      "error": null, "state_changes": { "deployed": true },
      "duration_ms": 1230.0, "timestamp": "2026-05-02T12:00:01Z" }
  ],
  "cost": { "tool_calls": 1, "actions_executed": 1, "actions_skipped": 0, "total_duration_ms": 1230.0, "retries": 0 }
}
```

- `ProposalResult { proposal_id, results: Vec<ActionResult>, cost: CostSummary }` with helpers `all_succeeded() -> bool` and `summary() -> HashMap<ActionStatus, usize>`.
- `ActionResult { action_id, status: ActionStatus, output, error, state_changes, duration_ms, timestamp }`.
- `CostSummary { tool_calls, actions_executed, actions_skipped, total_duration_ms, retries }` — all `Default` to zero. `ProposalResult.cost` is `#[serde(default)]`, so old JSON without a `cost` field still deserializes (backward compat).

**`ActionStatus`** (`actions.rs:30-40`, snake_case) is observable via the event log and `ActionResult.status`, but is **not** part of the input contract. Lifecycle: `proposed → validated → executing → succeeded`, with branches to `rejected`, `failed`, `skipped`.

### Cost: soft target vs hard budget

Two distinct mechanisms, in two different crates:

| Type | Crate | Role |
|------|-------|------|
| `CostTarget` (`actions.rs:211-232`) | `car-ir` | **SOFT** scoring target for `car-planner`. Defaults: `target_tool_calls=5`, `target_duration_ms=5000.0`, `target_actions=10`, `cost_weight=0.2` (in `[0,1]`). Score = `success_likelihood*(1-cost_weight) + cost_efficiency*cost_weight` |
| `CostBudget` | `car-engine` | **HARD** counterpart — proposals exceeding it are **rejected at verification time** (see verify's `max_actions`) |

> **Gotcha:** Don't conflate them. `car-ir` only defines the soft `CostTarget`; the hard limit that rejects proposals lives in `car-engine`.

### Static verification: check properties before executing

The `car-verify` crate does pure static analysis on an `ActionProposal` — **no tool execution**. There are four entry points.

#### `verify()` / `verify_with_schemas()`

```rust
pub fn verify_with_schemas(
    proposal: &ActionProposal,
    initial_state: Option<&HashMap<String, Value>>,
    tool_schemas: Option<&HashMap<String, ToolSchema>>,
    max_actions: usize,
) -> VerifyResult
```

`verify(proposal, initial_state, registered_tools: Option<&HashSet<String>>, max_actions)` performs:

- **Resource bounds:** `> max_actions` → warning `"excessive actions"`.
- **Loop detection:** identical `tool:params` seen 2× → warning `"duplicate"` (still valid); ≥3× → **error** `"likely loop"` (invalid).
- **DAG walk in topological order:** checks each action's preconditions (error `"precondition will fail"`), `state_dependencies` (error `"not available at this point"` unless known/unknown), and tool existence (error `"tool '<t>' is not registered"`; missing `tool` field → `"tool_call action has no tool specified"`).
- **Write-conflict detection:** two unordered `state_write`s / `expected_effects` to the same key with no declared dependency → **warning**.

`verify_with_schemas` additionally validates **parameters** against each tool's JSON Schema (type + required). **This is the path the runtime `verify_proposal` and the daemon `verify` JSON-RPC use.** Plain `verify()` with a name-only `HashSet` checks existence only and **skips parameter validation**.

#### `VerifyResult` shape

```
VerifyResult {
  valid: bool,                                  // false if any 'error'-severity issue
  issues: Vec<VerifyIssue{ action_id, severity: 'error'|'warning'|'info', message,
                           tier: 'decision_procedure'|'heuristic'|'sampled' }>,
  checks: Vec<CheckRecord{ name, ran, verifies, cannot_verify, findings, tier }>,
  simulated_state: HashMap<String, Value>,
  execution_levels: Vec<Vec<String>>,           // action ids per DAG level
  conflicts: Vec<(String, String, String)>,     // (action1, action2, key)
}
```
Helpers `errors()` and `warnings()` filter by severity; `issues_with_tier(tier)` filters by how the finding was derived — a `heuristic` finding (the repeated-call loop rule) is a rule of thumb and reads differently from a `decision_procedure` one (an exact registry or schema check). `"sampled"` is defined but is not currently emitted on an issue.

#### `simulate()` / `equivalent()` / `optimize()`

| Function | Signature | What it proves |
|----------|-----------|----------------|
| `simulate` | `simulate(proposal, initial_state) -> HashMap<String, Value>` | Computes the symbolic final state by applying `state_write` key/value params and `expected_effects` — without running tools (uses `verify` with `max_actions = usize::MAX`) |
| `equivalent` | `equivalent(p1, p2, test_states: Option<&[HashMap]>) -> bool` | True iff both proposals produce identical state across each test state (default states: empty map and `{x:1, y:2}`) — a spot check over those states, not a proof of equivalence |
| `optimize` | `optimize(proposal) -> ActionProposal` | Prunes **phantom** `state_dependencies` (deps on keys no action writes) to enable more parallelism; real deps are preserved |

```typescript
const result = JSON.parse(await rt.verifyProposal(proposalJson));
if (!result.valid) {
  console.log('blocked by policies/verify:', result.issues);
}
// issue shape:
// { "policy_name": "no_rm_rf", "action_id": "a3", "reason": "param 'command' matches denied pattern 'rm -rf'" }
```

> **Why verify before execute:** because verify also runs policies as part of static checking, a denied action surfaces in `result.issues` **without ever calling a tool**.

### Single-action validation: `car-validator`

`validate_action(action: &Action, state: &StateStore, registered_tools: &HashMap<String, ToolSchema>) -> ValidationResult` validates **one** action, in order:

1. Tool exists in `registered_tools` (else `"tool '<t>' is not registered"`).
2. Parameter validation via `validate_parameters` (below).
3. Each precondition via `check_precondition`.
4. Each `state_dependency` must exist in state (else `"state dependency '<d>' not found"`).

`ValidationResult { action_id, errors: Vec<ValidationError{action_id, reason}> }` with `.valid() == errors.is_empty()`.

`validate_parameters` has two paths: (1) a cheap required-key check from `schema.parameters['required']`; (2) full JSON Schema validation via the `jsonschema` crate — **only when the schema is not an empty `{}` object**.

> **Gotchas:** (1) An empty `{}` schema is the legacy *schemaless* registration: it imposes **no** constraints (accepts any params). There is a defense-in-depth test guarding against "improving" `schema_is_empty_object` into a hard rejection. (2) Extra/unknown parameters are **intentionally not rejected** (LLMs send extras); only missing required keys and declared-type mismatches fail.

### Policies: deny rules evaluated per action

CAR's safety layer has multiple cooperating mechanisms. **Policies** (`car-policy::PolicyEngine`) are *deny rules evaluated per action* against `(Action, StateStore)` for pre-execution batch validation. `PolicyEngine` collects **ALL** violations — it does **not** short-circuit.

```
PolicyEngine::new()
PolicyEngine::register(name, check: PolicyCheck, description)
PolicyEngine::check(&Action, &StateStore) -> Vec<PolicyViolation>   // all violations
PolicyCheck = Box<dyn Fn(&Action, &StateStore) -> Option<String>>   // Some(reason)=deny
PolicyViolation { policy_name, action_id, reason }
```

A panicking check is caught via `catch_unwind` and converted into a violation (`"policy <name> panicked during check"`) rather than crashing.

#### Registering policies over the FFI

Authors register policies through **rule strings** with `registerPolicy(name, rule, target?, key?, pattern?, valueJson?, sessionId?)`. The daemon builds the actual closures in `car-server-core` `build_policy_check`.

| Rule | Semantics |
|------|-----------|
| `deny_tool` | Deny if `action.tool == target` → `"tool '<t>' denied"` |
| `deny_tool_param` | For a matching `target` tool, stringify `params[key]`; if it contains `pattern`, deny → `"param '<k>' matches '<pattern>'"` |
| `require_state` | Deny unless `state[key] == value` → `"state['<k>'] must be <v>"` |
| `deny_tool_callback` | **NAPI-only** custom JS gate; **rejected** by the daemon FFI `register_policy` because the callback can't ride the JSON-RPC wire |

```typescript
rt.registerPolicy('no_shell', 'deny_tool', 'shell');
rt.registerPolicy('no_rm_rf', 'deny_tool_param', 'shell', 'command', 'rm -rf');
rt.registerPolicy('no_drop_table', 'deny_tool_param', 'sql', 'query', 'DROP TABLE');
rt.registerPolicy(
  'tests_must_pass',
  'require_state',
  null,         // target: not used
  'tests_passed',
  null,         // pattern: not used
  'true',       // value_json: required value, JSON-encoded
);
rt.stateSet('tests_passed', JSON.stringify(true));
```

A custom Rust policy can read state directly:

```rust
let mut engine = PolicyEngine::new();
engine.register(
    "require_auth",
    Box::new(|_action, state| {
        if state.get("auth") != Some(Value::Bool(true)) {
            Some("auth required".to_string())
        } else { None }
    }),
    "",
);
let violations = engine.check(&action, &state); // Vec<PolicyViolation>
```

> **Gotchas:** (1) `deny_tool_callback` only works on the NAPI surface with a pre-registered JS callback; use `deny_tool` / `deny_tool_param` / `require_state` for the daemon. (2) `require_state` via FFI passes the required value as `value_json` — a JSON-encoded string (e.g. `'true'` / `JSON.stringify(true)`), **not** a raw boolean. The daemon decodes it and compares `state[key]` for exact equality. (3) After a policy denial the proposal proceeds per the action's `failure_behavior`: `abort` (default) halts the proposal, `skip` skips just that action, and `retry` is treated as `abort`.

### Inspectors: dispatch-time hot-path guardrails

Distinct from policies, **inspectors** (`car-policy::inspectors::InspectorChain`) are a short-circuiting chain evaluated against `(tool_name, params)` at **dispatch time**. **First `Deny` wins.** This is the hot-path guard; policies are the pre-execution batch.

```
InspectorChain::new() / default_chain() / default()
InspectorChain::with(self, Box<dyn Inspector>) -> Self
InspectorChain::inspect(tool, params) -> Vec<(String, InspectionResult)>
InspectorChain::check(tool, params) -> Option<String>   // first deny reason
InspectorChain::reset_session(&self)
InspectionResult { Allow, Warn(String), Deny(String) }  // is_deny()
```

`default_chain()` = `EgressInspector` + `RepetitionInspector` (adversary is opt-in — it needs a classifier callback). The three built-ins:

| Inspector | Behavior |
|-----------|----------|
| `EgressInspector` | Flags exfiltration on `shell`/`http`/`webfetch` only (reads `params['command']` or `params['url']`). Hard-deny patterns `['nc ', 'netcat ', '/dev/tcp/']` → Deny; suspicious patterns `['\| bash', '\| sh', 'curl -X POST', 'wget --post', 'base64 -d']` → Warn; host allowlist (default includes github.com, api.github.com, raw.githubusercontent.com, crates.io, static.crates.io, registry.npmjs.org, pypi.org, files.pythonhosted.org, docs.rs). Unlisted host → Warn (Deny if `strict=true`). Suspicious pattern + unlisted host → Deny. Other tools → Allow |
| `RepetitionInspector` | Blocks identical `(tool, params)` after `max_repeats` (default 5; `with_max(n)`) consecutive repeats. Keyed on `params.to_string()`; a different params value resets the count. Session-scoped (capped at 200, drains 100) |
| `AdversaryInspector` | Opt-in LLM review. Fields `rules: String` + `classifier: Arc<dyn Fn(&str, &Value, &str) -> Option<String>>` (`Some(reason)`=Deny). `car-policy` has no inference dependency — the caller wires the classifier at session boot. Empty rules → Allow. `load_adversary_rules_from(path)` reads rules from a file (e.g. `~/.tokhn/adversary.md`) |

```rust
let chain = InspectorChain::default_chain(); // egress + repetition
chain.reset_session(); // at start of every session
if let Some(reason) = chain.check("shell", &json!({"command": "nc evil.com 80"})) {
    // denied: reason = "egress inspector blocked: suspicious pattern 'nc '"
}
```

> **Critical ordering constraint:** call `chain.reset_session()` at **every** session boundary. Stateful inspectors (`RepetitionInspector`) leak counters across runs otherwise — the default `Inspector::reset_session` is a no-op, so each stateful inspector must override it and you must invoke it.

### Policies vs Inspectors vs Validation vs Verify — how they compose

These are easy to conflate. They are **complementary, not interchangeable**:

| Layer | Crate | Evaluates against | Timing | Short-circuit? |
|-------|-------|-------------------|--------|----------------|
| `PolicyEngine` | `car-policy` | `(Action, StateStore)` | Pre-execution batch | No — collects **all** violations |
| `InspectorChain` | `car-policy::inspectors` | `(tool, params)` | Dispatch hot-path | **Yes** — first `Deny` wins |
| `validate_action` | `car-validator` | one `Action` + state + schemas | Per-action | Errors accumulate |
| `verify` / `verify_with_schemas` | `car-verify` | whole `ActionProposal` | Static, pre-execution | Errors → `valid: false` |

> **Not-yet-shipped surfaces:** per-session policy scoping (`open_session` / `close_session` / `register_policy_in_session`) exists on `car_engine::Runtime` and via the daemon's session-scoped `policy.register`, but `registerPolicy(sessionId)` / `openSession` are **not** exposed on the NAPI/PyO3 FFI surface (still a proposal — `per-session-policy-scoping.md`). `IntentHint` routing (`policy-intent-surface.md`) is also a proposal, not shipped.

### `AgentOutcome`: the autonomous loop's terminal contract

The verify→execute pipeline is only half the story. The other half is **propose→observe→re-propose**, and `AgentOutcome` (`car-ir/src/outcome.rs`) is its typed completion record — the signal an agent loop uses to decide when to stop driving the verify/execute primitive.

```
AgentOutcome { status: OutcomeStatus, summary, evidence: Vec<Evidence>, metrics: OutcomeMetrics, timestamp }
```

**`OutcomeStatus`** (snake_case): `success`, `partial_success`, `give_up`, `timeout`, `failure`, `done`.
- `is_completed()` → true for `success` / `partial_success` / `done`.
- `is_terminal()` → **true for all statuses** (every status ends the loop).

**`EvidenceKind`** (snake_case): `self_assessment`, `tool_result`, `state_change`, `external_verification`, `stop_reason`, `evaluator`.

**`OutcomeMetrics`**: `turns`, `tool_calls`, `duration_ms`, `retries`, `actions_succeeded`, `actions_failed`.

**Constructors:** `success(s)`, `failure(s)`, `timeout(s, turns, max_turns)`, `give_up(reason)`; **builders:** `with_evidence(e)`, `with_metrics(m)`.

The conceptual bridge a single-agent author needs: a model-driven loop repeatedly (a) emits an `ActionProposal`, (b) `verify`s it (rejecting on `valid == false`), (c) executes it for a `ProposalResult`, (d) observes `results` + `state_changes`, and (e) re-proposes — until it can construct an `AgentOutcome` whose `status.is_terminal()` holds (which is always, once produced). CAR ships the autonomous machinery (active-planner candidate generation, planner scoring, `ReplanCallback` / `ActiveReplanAdapter` for failure recovery, replan config), with `AgentOutcome` as the terminal contract that closes the loop.

### Commands & verification

```bash
# Start the singleton daemon BEFORE any FFI call (v0.8+)
npx --package=car-runtime car-server &     # Node
python -m car_runtime.server &             # Python equivalent

# Run the IR / policy / validation / verify unit tests
cd car-rs && cargo test -p car-ir
cd car-rs && cargo test -p car-policy -p car-validator -p car-verify
```

### Key file references

| Concern | Path |
|---------|------|
| IR spec (mirrors Rust) | `docs/agent-ir-spec.md` |
| IR types (Action, Proposal, Result, Cost) | `car-rs/crates/car-ir/src/actions.rs` |
| Precondition operators + `StateView` | `car-rs/crates/car-ir/src/precondition.rs` |
| DAG builder | `car-rs/crates/car-ir/src/dag.rs` |
| `AgentOutcome` | `car-rs/crates/car-ir/src/outcome.rs` |
| Built-in tool schemas | `car-rs/crates/car-ir/src/builtins.rs` |
| `PolicyEngine` + inspectors | `car-rs/crates/car-policy/src/lib.rs`, `inspectors.rs` |
| Single-action validation | `car-rs/crates/car-validator/src/lib.rs` |
| Static verify / simulate / equivalent / optimize | `car-rs/crates/car-verify/src/lib.rs` |
| Server-side rule→closure mapping | `car-rs/crates/car-server-core/src/handler.rs` |

---

## Policies, Validation, Capabilities & Sandboxing

CAR's safety story is not one mechanism — it is **four cooperating layers** that authors routinely conflate. Understanding how they compose (who wins, when each runs, what it sees) is the difference between an agent that is "locked down" in name only and one that is actually contained. This section maps all four, plus the static-verification pipeline that catches unsafe plans *before* any tool fires.

> **Daemon-first reframe.** Since v0.8 every FFI binding is a thin WebSocket client to a singleton `car-server` that **must already be running** (`CAR_DAEMON_URL` / `CAR_AUTH_TOKEN`). `rt.registerPolicy(...)` and `rt.verifyProposal(...)` do not build closures in-process — they ship a `PolicyDefinition` / proposal over JSON-RPC, and the daemon builds the actual closure in `car-server-core`'s `build_policy_check`. This is why `deny_tool_callback` (a JS closure) cannot ride the FFI wire, and why the Rust-only surfaces below (`InspectorChain`, per-session scoping) are not yet reachable from NAPI/PyO3.

### The four safety layers at a glance

| Layer | Crate / module | Evaluated against | Timing | Short-circuit? | FFI-reachable? |
|---|---|---|---|---|---|
| **Capabilities** (allow-list what an agent *CAN* touch) | `car-engine` `CapabilitySet`, `AuthzPipeline` | `(Action, tools, state)` | pre-execution gate | yes — first `Deny` | partial (Rust today) |
| **Policies** (deny rules per action) | `car-policy` `PolicyEngine` | `(Action, StateStore)` | pre-execution batch | **no — collects ALL violations** | yes (`registerPolicy`) |
| **Inspectors** (hot-path dispatch guardrails) | `car-policy::inspectors` `InspectorChain` | `(tool_name, params)` | dispatch time | yes — first `Deny` | Rust today (FFI in flight) |
| **Static verification** | `car-verify` `verify`/`simulate`/`equivalent`/`optimize` | `ActionProposal` | before execution | n/a (collects issues) | yes (`verifyProposal`) |

Plus the **high-risk approval gate** baked into tool permissions (`ToolPermission::AskUser` — write/edit/AppleScript/Shortcuts/Mail/Messages/Vision OCR park until host approval).

**Composition rule of thumb:** *deny wins, and the first Deny short-circuits — except `PolicyEngine`, which is deliberately exhaustive so you get the full list of what's wrong in one pass.*

---

### Layer 1 — Capabilities: allow-listing what an agent CAN touch

`CapabilitySet` (`car-rs/crates/car-engine/src/capabilities.rs`) is the per-agent permission object. It answers "is this agent *allowed* to touch this tool/state key at all?".

| Field | Meaning | Empty means |
|---|---|---|
| `allowed_tools` | tool allow-list | **all tools allowed** (not none!) |
| `denied_tools` | tool deny-list | — (always wins over allow) |
| `allowed_state_keys` | state-key allow-list | all keys allowed |
| `max_actions: Option<u32>` | per-proposal action budget | `None` = unlimited |

Builder + checks:

```rust
let caps = CapabilitySet::new()
    .allow_tool("read_file")
    .deny_tool("write_file")
    .allow_state_key("plan")
    .with_max_actions(5);

// gating logic (capabilities.rs):
pub fn tool_allowed(&self, tool: &str) -> bool {
    if self.denied_tools.contains(tool) { return false; } // deny wins
    if self.allowed_tools.is_empty() { return true; }     // empty = all
    self.allowed_tools.contains(tool)
}
```

Other checks: `state_key_allowed(key) -> bool`, `actions_within_budget(count) -> bool` (you enforce the budget against the proposal's action count yourself). Default `CapabilitySet` is fully unrestricted.

> **Gotcha — empty allow-list is allow-*all*, not deny-all.** It is easy to misread `CapabilitySet::new()` as deny-by-default. It is not: an empty `allowed_tools` (and empty `allowed_state_keys`) permits everything. You must explicitly `allow_tool(...)` *or* `deny_tool(...)` to constrain. `denied_tools` always overrides `allowed_tools`.

**The inverse registry.** `CapabilitySet` restricts what an agent may touch; `AgentCapabilityRegistry` (`agent_capability.rs`) answers the opposite question — *which agent implements a capability id* like `"summarize"`. `select(capability, hint)` resolves in order: (1) the `hint` if it names a registered agent, (2) the most-recently-used agent (`note_used` updates MRU), (3) the first-registered. It is in-memory only (v1) — MRU does **not** survive restart, so only the explicit `hint` is a durable selection signal, and built-ins must be re-seeded via `register_builtins(&registry)` on every start.

### The 6-stage AuthzPipeline

`AuthzPipeline` (`car-engine/src/authz.rs`) is the single pre-execution gate that runs all capability/permission/restriction/policy checks in a fixed order and **short-circuits on the first `Deny`**:

```rust
/// Stages (in order):
/// 1. Tool exists
/// 2. Capability allows it
/// 3. Permission mode / approval
/// 4. Permanent restrictions
/// 5. Policy engine
/// 6. Executor-level validation
pub async fn authorize(&self, action: &Action,
    tools: &HashMap<String, ToolSchema>,
    capabilities: Option<&CapabilitySet>,
    policies: &PolicyEngine, state: &StateStore) -> AuthzResult { /* ... */ }
```

`AuthzResult { decision, stage, reason_code, explanation, stage_results }` where `decision` is `Allow | AskUser | Deny`. Branch on `result.decision`; on a block inspect `result.stage` and `result.reason_code` (e.g. `tool_not_found`, `capability_denied`, `permission_denied`, `approval_required`, `policy_violation`, `restriction_<name>`).

Two integration hooks:

- **`set_permission_handler(Box<dyn PermissionHandler>)`** — `PermissionHandler::check(tool_name, action) -> AuthzDecision` (async) is where your product's approval UX plugs into stage 3. Default is `AllowAllPermissions`.
- **`add_restriction(Restriction::new(name, desc, |action| Option<reason>))`** — stage-4 restrictions are **permanent and never bypassable** by any other stage.

> **Gotcha — stage 6 always returns Allow.** Inside `authorize()`, Validation (stage 6) is marked `Allow` and deferred to the caller — actual parameter validation happens after authorization via `car-validator` / `verify_with_schemas`. Don't assume authorization validated your params.

### Tool permissions & the high-risk approval gate

Every tool carries a `ToolPermission` (`car-engine/src/registry.rs`): `Allow | AskUser (default) | Deny`, plus a `ToolSource` (`Builtin | UserDefined | Subprocess | Mcp{server_name}`) and a `side_effects: bool`.

| Constructor | Permission | Source | side_effects |
|---|---|---|---|
| `ToolEntry::builtin(schema)` | `Allow` | `Builtin` | `false` |
| `ToolEntry::new(schema)` | `AskUser` | `UserDefined` | `true` |

> **Gotcha — caller-registered tools are gated by default.** `ToolPermission::default()` is `AskUser`, and `ToolEntry::new()` defaults to `AskUser + side_effects=true`. Only `ToolEntry::builtin()` is auto-`Allow`. Side-effecting and host-sensitive tools (`write_file`, `edit_file`, and the macOS automation surfaces — AppleScript/Shortcuts/Mail/Messages/Vision OCR) are `AskUser`, parking until the host approves.

---

### Layer 2 — Policies: deny rules evaluated per action

`PolicyEngine` (`car-rs/crates/car-policy/src/lib.rs`) is the **batch, pre-execution** policy evaluator. Unlike everything else, it does **not** short-circuit — `check(&Action, &StateStore) -> Vec<PolicyViolation>` runs *every* registered policy and collects *all* violations.

```rust
let mut engine = PolicyEngine::new();
engine.register(
    "require_auth",
    Box::new(|_action, state| {
        if state.get("auth") != Some(Value::Bool(true)) {
            Some("auth required".to_string())  // Some(reason) = deny, None = allow
        } else { None }
    }),
    "", // description
);
let violations = engine.check(&action, &state); // ALL violations, not short-circuited
```

`PolicyCheck = Box<dyn Fn(&Action, &StateStore) -> Option<String> + Send + Sync>`. `PolicyViolation { policy_name, action_id, reason }`. Diagnostics: `policy_names()`, `is_empty()`.

> A policy check that **panics** is caught via `catch_unwind` and converted into a violation with reason `"policy <name> panicked during check"` — the runtime does not crash.

#### The four FFI-registerable rule types

From a binding, you don't pass closures — you register one of four declarative rule strings via `registerPolicy(name, rule, target?, key?, pattern?, valueJson?, sessionId?)`. The daemon's `build_policy_check` turns each into the closure:

| Rule | Semantics | Deny reason |
|---|---|---|
| `deny_tool` | deny if `action.tool == target` | `tool '<t>' denied` |
| `deny_tool_param` | for matching `target` tool, stringify `params[key]`; deny if it contains `pattern` | `param '<k>' matches '<pattern>'` |
| `require_state` | deny unless `state[key] == value` (decoded from `valueJson`) | `state['<k>'] must be <v>` |
| `deny_tool_callback` | **NAPI-only** custom JS gate | — (rejected by daemon FFI) |

```typescript
rt.registerPolicy('no_shell', 'deny_tool', 'shell');
rt.registerPolicy('no_rm_rf', 'deny_tool_param', 'shell', 'command', 'rm -rf');
rt.registerPolicy('no_drop_table', 'deny_tool_param', 'sql', 'query', 'DROP TABLE');
rt.registerPolicy(
  'tests_must_pass',
  'require_state',
  null,         // target: unused for require_state
  'tests_passed',
  null,         // pattern: unused
  'true',       // value_json: required value, JSON-encoded
);
rt.stateSet('tests_passed', JSON.stringify(true));
```

> **Gotchas.**
> - `require_state` takes its value as **`value_json` — a JSON-encoded string** (`'true'` / `JSON.stringify(true)`), not a raw boolean. The daemon compares `state[key]` for *exact equality* with the decoded value.
> - `deny_tool_callback` only works on the **NAPI** surface with a pre-registered JS callback (`registerAgentRunner` flow). The daemon-backed FFI `register_policy` **rejects** it — the closure can't ride the JSON-RPC wire. Use `deny_tool` / `deny_tool_param` / `require_state` instead.
> - **After a policy denial, the proposal proceeds per the action's `failure_behavior`:** `abort` (default) halts the proposal, `skip` skips just that action, `retry` is treated as `abort` (no point retrying a denied action).

JSON-RPC equivalent: `policy.register` (params mirror `PolicyDefinition`, optional `session_id`).

#### Per-session policy scoping — proposal, not shipped on FFI

`car_engine::Runtime` exposes `open_session() -> String`, `close_session(id) -> bool`, `register_policy_in_session(session_id, name, check, description)`, `session_exists(id)`. The daemon's `policy.register` also accepts a `session_id`. **But `registerPolicy(sessionId)` / `openSession` are NOT exposed on the NAPI/PyO3 FFI surface** — it's still a proposal (`docs/proposals/per-session-policy-scoping.md`). Likewise `IntentHint` routing (`policy-intent-surface.md`) is a proposal.

---

### Layer 3 — Inspectors: hot-path dispatch-time guardrails

`InspectorChain` (`car-rs/crates/car-policy/src/inspectors.rs`) is the **dispatch hot-path** guard. Where `PolicyEngine` is a pre-execution batch over `Action`s, `InspectorChain` runs against `(tool: &str, params: &Value)` at the moment of dispatch and **short-circuits on the first `Deny`**.

```rust
let chain = InspectorChain::default_chain(); // egress + repetition
chain.reset_session(); // at the START of every session — non-negotiable
if let Some(reason) = chain.check("shell", &json!({"command": "nc evil.com 80"})) {
    // denied: e.g. "egress inspector blocked: suspicious pattern 'nc '"
}
```

API: `new()` / `default_chain()` (egress + repetition; adversary is opt-in), `.with(Box<dyn Inspector>)`, `inspect(tool, params) -> Vec<(String, InspectionResult)>`, `check(tool, params) -> Option<String>` (first deny reason), `reset_session()`. `InspectionResult` = `Allow | Warn(String) | Deny(String)` with `is_deny()`.

The `Inspector` trait:

```rust
trait Inspector: Send + Sync {
    fn name(&self) -> &'static str;
    fn inspect(&self, tool: &str, params: &Value) -> InspectionResult;
    fn reset_session(&self) {} // default no-op; stateful inspectors override
}
```

#### Built-in inspectors

| Inspector | What it does | Key fields |
|---|---|---|
| **EgressInspector** | Flags exfiltration on `shell`/`http`/`webfetch` (reads `params['command']` or `params['url']`). Layered: hard-deny patterns (`nc `, `netcat `, `/dev/tcp/`) → always `Deny`; suspicious patterns (`\| bash`, `\| sh`, `curl -X POST`, `wget --post`, `base64 -d`) → `Warn`; host allow-list check; suspicious + unlisted host → `Deny`. | `allowed_hosts: Vec<String>` (defaults include github.com, api.github.com, raw.githubusercontent.com, crates.io, static.crates.io, registry.npmjs.org, pypi.org, files.pythonhosted.org, docs.rs), `strict: bool` (default false → unlisted host = `Warn`; `strict=true` → `Deny`) |
| **RepetitionInspector** | Blocks identical tool calls after N consecutive repeats. Keys on `params.to_string()`; counts trailing consecutive identical `(tool, params)`; denies when count `>= max_repeats`. Session-scoped (`Mutex<Vec<...>>`, capped 200 with drain of 100). A different `params` resets the count. | `max_repeats` default 5; `RepetitionInspector::with_max(n)`; `reset()`/`reset_session()` |
| **AdversaryInspector** | Opt-in LLM-backed review. Empty rules → `Allow`. car-policy has **no inference dependency** — you wire the classifier callback at session boot. | `rules: String`, `classifier: Arc<dyn Fn(&str tool, &Value params, &str rules) -> Option<String> + Send + Sync>` (`Some(reason)` = Deny). `load_adversary_rules_from(path) -> Option<String>` reads rules from a file (e.g. `~/.tokhn/adversary.md`) |

> **Gotchas.**
> - **You MUST call `chain.reset_session()` at every session boundary.** Stateful inspectors (`RepetitionInspector`) otherwise leak counters across independent runs — the default `Inspector::reset_session` is a no-op, so only the stateful ones reset.
> - `EgressInspector` only inspects `shell`, `http`, and `webfetch`. **All other tools return `Allow`** regardless of content.
> - FFI exposure of `InspectorChain` is in flight; today it is wired via Rust.

---

### Layer 4 — Static verification: catch unsafe plans before execution

`car-verify` (`car-rs/crates/car-verify/src/lib.rs`) does **pure static analysis on an `ActionProposal` — no tool runs.** This is the static-verification half of CAR: check plan properties before executing anything. It is the cheapest place to catch unregistered tools, unsatisfiable preconditions, write conflicts, and loops.

#### `verify` vs `verify_with_schemas` — the load-bearing distinction

```rust
pub fn verify(
    proposal: &ActionProposal,
    initial_state: Option<&HashMap<String, Value>>,
    registered_tools: Option<&HashSet<String>>,  // NAME-ONLY: existence check only
    max_actions: usize,
) -> VerifyResult

pub fn verify_with_schemas(
    proposal: &ActionProposal,
    initial_state: Option<&HashMap<String, Value>>,
    tool_schemas: Option<&HashMap<String, ToolSchema>>, // FULL schema: type + required
    max_actions: usize,
) -> VerifyResult
```

`verify()` (name-only `HashSet`) checks tool **existence only** and **skips parameter validation**. To catch type mismatches and missing required fields you must use `verify_with_schemas` — which is exactly the path the runtime `verify_proposal` method and the daemon `verify` JSON-RPC method use (they pass full `ToolSchema`s). **Don't reach for plain `verify()` when you care about params.**

What `verify` checks, in order: resource bounds (`> max_actions` → warning `excessive actions`), loop detection, DAG construction, topological walk checking each action's preconditions (`error: precondition will fail`) and `state_dependencies` (`error: not available at this point` unless known/unknown), tool existence (`error: tool '<t>' is not registered`; missing tool field → `tool_call action has no tool specified`), then write-conflict detection.

```typescript
const result = JSON.parse(await rt.verifyProposal(proposalJson));
if (!result.valid) {
  console.log('blocked by policies/verify:', result.issues);
}
// violation shape:
// { "policy_name": "no_rm_rf", "action_id": "a3",
//   "reason": "param 'command' matches denied pattern 'rm -rf'" }
```

Because `verifyProposal` also runs policies as part of static checking, a *denied* action surfaces in `result.issues` **without ever calling a tool**. Python: `json.loads(rt.verify_proposal(proposal))`.

#### `VerifyResult` shape

```
VerifyResult {
  valid: bool,                            // false if ANY 'error'-severity issue
  issues: Vec<VerifyIssue {action_id, severity: "error"|"warning"|"info", message,
                           tier: "decision_procedure"|"heuristic"|"sampled"}>,
  checks: Vec<CheckRecord {name, ran, verifies, cannot_verify, findings, tier}>,
  simulated_state: HashMap<String, Value>,
  execution_levels: Vec<Vec<String>>,     // action ids per DAG level (parallelism map)
  conflicts: Vec<(String, String, String)>, // (action1, action2, key)
}
```

Helpers `errors()` / `warnings()` filter by severity; `issues_with_tier(tier)` filters by how the finding was derived — a `heuristic` finding (the repeated-call loop rule) is a rule of thumb and reads differently from a `decision_procedure` one (an exact registry or schema check). `"sampled"` is defined but is not currently emitted on an issue.

> **Loop & conflict thresholds.** Loop detection: **2** identical `tool:params` calls → `duplicate` **WARNING** (still `valid`); **3+** → `likely loop` **ERROR** (invalid). Write conflicts are only **WARNINGS** (`valid` stays true).

#### `simulate` / `equivalent` / `optimize`

| Function | Signature | Purpose |
|---|---|---|
| `simulate` | `simulate(proposal, initial_state) -> HashMap<String, Value>` | Compute the symbolic final state by applying `StateWrite` key/value params and `expected_effects` — **without running any tools** (uses `verify` with `max_actions = usize::MAX`). |
| `equivalent` | `equivalent(p1, p2, test_states: Option<&[HashMap]>) -> bool` | Simulate both proposals over each test state (defaults: empty map and `{x:1, y:2}`); `true` iff all resulting states match. A spot check over the supplied states, not a proof of equivalence. |
| `optimize` | `optimize(proposal) -> ActionProposal` | Prune **phantom** `state_dependencies` (deps on keys *no* action writes) to enable more parallelism; real deps (keys some action writes) are preserved. |

Symbolic effects model: a `StateWrite` action writes `parameters['key'] = parameters['value']` (or `Null`); every `(key, value)` in `action.expected_effects` is also applied. A write conflict = any key written by ≥2 actions where neither writer declares the key in its `state_dependencies`.

---

### Single-action validation (`car-validator`)

Where `car-verify` analyzes a whole proposal statically, `car-validator` (`car-rs/crates/car-validator/src/lib.rs`) validates **one** `Action` against live state and registered tool schemas:

```rust
let result = car_validator::validate_action(&action, &state, &registered_tools);
if !result.valid() { for e in &result.errors { /* e.reason */ } }
```

`validate_action(action, state, registered_tools: &HashMap<String, ToolSchema>) -> ValidationResult`. Checks in order: (1) tool exists (`tool '<t>' is not registered`); (2) parameter validation; (3) each precondition; (4) each `state_dependency` exists (`state dependency '<d>' not found`). `ValidationResult { action_id, errors }`, `.valid() == errors.is_empty()`.

**Two-path parameter validation:**
- **Path 1 (cheap):** for each name in the schema's `required` array, error `missing required parameter '<n>' for tool '<t>'` if absent.
- **Path 2 (full):** JSON-Schema validation via the `jsonschema` crate — **but only when the schema is not an empty `{}` object.** An empty `{}` parameters schema is the **legacy schemaless registration** and trivially validates everything.

> **Gotchas.**
> - **An empty `{}` schema imposes NO constraints** (accepts any params). There is a defense-in-depth test guarding against anyone "improving" `schema_is_empty_object` into a hard-reject. Don't.
> - **Extra/unknown parameters are intentionally NOT rejected** — LLMs send unexpected extras. Only *missing required keys* and *declared-type mismatches* fail (`tool '<t>' parameter validation: <err> (at <instance_path>)`).
> - An invalid registered schema yields `tool '<t>' has an invalid registered JSON Schema: <e>`.

#### Precondition operators

Preconditions are checked by `car_ir::precondition::check_precondition(pre, state: &dyn StateView) -> Option<String>` (`Some` = fail reason, `None` = pass). `Precondition { key, operator: String, value: Value, description }`.

| Operators | Notes |
|---|---|
| `exists`, `not_exists` | key presence |
| `eq`, `neq` | value equality |
| `gt`, `lt`, `gte`, `lte` | numeric — both sides coerced via `as_f64`; non-numeric → fail `cannot compare` |
| `contains` | substring match (stringifies non-string values) |

Unknown operator → `unknown operator '<op>'`. The `StateView` trait (`get_value(key)`, `key_exists(key)`, `is_unknown(key)`) is implemented by both `car_verify::StaticState` (symbolic, with `unknown_keys`) and `car_state::StateStore` (runtime, always "known") — the same precondition logic runs in static verify and runtime validate. **Symbolic-only `is_unknown` keys cannot be disproven, so value comparisons against them pass — but note nothing in the workspace ever populates `unknown_keys`, so `is_unknown()` is always false in practice and this branch is currently dead.**

---

### Runtime guardrails beyond the four layers

`car-engine` also ships execution-layer controls an author wires per-tool:

**ResultCache** (`cache.rs`) — cross-proposal result cache, **opt-in per tool**:

```rust
let cache = ResultCache::new();
cache.enable_caching("read_file", 10).await; // 10s TTL; un-enabled tools NEVER cached
let cached = cache.get("read_file", &params).await; // Some on fresh hit
cache.put("read_file", &params, result).await;       // no-op unless enabled
let stats = cache.stats().await; // CacheStats { hits, misses, entries }
```

Keyed on `hash(tool, params JSON)` (`'{tool}:{hash:x}'`). Expired entries are removed lazily on access and counted as a miss. `invalidate(tool)` after mutations. Built-in schemas carry `cache_ttl_secs` hints (`read_file`=10; `find_files`/`grep_files`/`list_dir`=5).

**RateLimiter** (`rate_limit.rs`) — per-tool token bucket:

```rust
limiter.set_limit("http_request", RateLimit { max_calls: 30, interval_secs: 60.0 }).await;
limiter.acquire("http_request").await;        // BLOCKS until a token frees (backpressure)
let ok = limiter.try_acquire("http_request").await; // non-blocking; true if no limit set
```

`refill_rate = max_calls / interval_secs` tokens/sec; bucket starts full. **A tool with no configured limit always passes immediately** — absence of a limit is not a deny.

**Checkpoint** (`checkpoint.rs`) — serializable full-runtime snapshot (`checkpoint_id`, `created_at`, `state`, `events`, `tools`, `metadata`). On restore, `state`/`tools`/`metadata` round-trip — **but `events` are for audit/export ONLY and are deliberately NOT replayed** into the `EventLog` (it is append-only; replay would corrupt ordering/span state).

**RuntimeScope** (`scope.rs`, car#187 phase 3) — per-execution caller identity (`caller_id`, `tenant_id`, `claims`) threaded through `Runtime::execute_scoped` / `execute_scoped_with_cancel`, recorded on `ActionInvoked` events.

> **RuntimeScope is foundation-only today.** memgine queries are **NOT** scoped by `tenant_id`, state keys are **NOT** namespaced, and the **NAPI/PyO3 `execute_proposal` standalone functions do not accept a scope yet**. Tool handlers needing per-tenant behavior must still read `proposal.context['a2a_caller_verified']` directly.

---

### MCP tools flow through the same gates

MCP servers (`car-engine/src/mcp.rs`) are discovered over stdio JSON-RPC (`initialize` → `notifications/initialized` → `tools/list` → `tools/call`, `protocolVersion 2024-11-05`) and registered under the canonical name **`mcp_{server}_{tool}`** (plus the bare name). Crucially, **MCP tools participate in the exact same capability/permission/policy/inspector flow as any other tool** — there is no separate, weaker path for them. A `deny_tool` policy, an `EgressInspector`, and a `CapabilitySet` allow-list all apply to `mcp_*` tools identically.

---

### Practical layering recipe for a single agent

To actually contain one agent, compose all four layers — they are complementary, not interchangeable:

1. **Capabilities** — `CapabilitySet::new().allow_tool(...).deny_tool(...).with_max_actions(n)`, fed into `AuthzPipeline::authorize`. Sets the outer boundary of what's reachable.
2. **Policies** — `registerPolicy('no_rm_rf', 'deny_tool_param', 'shell', 'command', 'rm -rf')` etc., for declarative deny rules surfaced (exhaustively) at `verifyProposal` time.
3. **Inspectors** — `InspectorChain::default_chain()` with `reset_session()` per run, for egress/repetition guardrails at dispatch.
4. **Verify** — `await rt.verifyProposal(proposalJson)`; reject if `!result.valid` *before* executing — catches unregistered tools, unsatisfiable preconditions, write conflicts, and (3+) loops without firing a single tool.

Remember the asymmetry when reading results: `PolicyEngine.check` gives you **all** violations at once (batch); `InspectorChain.check` and `AuthzPipeline.authorize` stop at the **first Deny** (hot-path). Deny always wins.

```bash
# Run the policy/validation/verify unit tests
cd car-rs && cargo test -p car-policy -p car-validator -p car-verify
```

---

## Memory, Context Assembly & Skills

Memory in CAR is not a bolt-on store you query when you remember to — it is the runtime. An agent's identity, hard rules, learned facts, conversation history, environment, and learned procedures (skills) all live in one graph (`car-memgine`), and the same graph drives the system prompt the model sees on every turn. This is what turns a single agent from stateless to learning: the skills loop in particular enables "skill-first execution" — skip the LLM entirely when a learned workflow already matches — which is what FlyX's design note projects would cut roughly 75% of token cost — a projection, not a measured result.

Everything in this section is exposed across all three binding surfaces with the usual naming conventions: NAPI/Node uses `camelCase`, PyO3/Python uses `snake_case`, and the WebSocket daemon exposes `memory.*` / `skills.*` JSON-RPC methods. Daemon-first applies here as everywhere: in daemon mode `addFact` / `buildContext` / `factCount` hit the daemon's **per-session** memgine, and the embedded fallback memgine stays empty by design. Post-#146, a daemon that is unreachable surfaces an error instead of silently returning `0` / `""`.

Core implementation lives in `car-rs/crates/car-memgine/` — `graph.rs` (node/edge/skill types), `engine.rs` (ingest, retrieval, skills loop), `config.rs` (budgets), `compaction.rs`, `conversation_store.rs`.

### 1. Memory is a graph

`MemoryGraph` wraps `petgraph::StableGraph<MemNode, MemEdge>` plus side indexes (`by_fact_id`, `by_key`, `by_layer: [Vec<NodeIndex>; 4]`, `last_conversation`, `partitions`). Every piece of agent knowledge is a typed node; every relationship is a typed edge with a fixed activation multiplier.

**Node kinds (`MemKind`)**

| Kind | Notes |
|------|-------|
| `Identity` | Layer-1 node — who the agent is, authority |
| `Fact` / `FactSuperseded` | Knowledge; superseded variant skipped in retrieval |
| `Conclusion` / `ConclusionInvalidated` | Derived inferences, with provenance |
| `Skill` / `SkillDeprecated` | Learned procedure (see §6); deprecated variant skipped |
| `Conversation` / `ConversationSummary` | Turn history (layer 3) |
| `Environment` | Runtime context (layer 4) |
| `Model`, `CodeSymbol` | Model registry / code-aware nodes |

`MemNode::is_valid()` returns `false` for `FactSuperseded` / `SkillDeprecated` / `ConclusionInvalidated`, so those are skipped during retrieval. `MemNode::token_estimate()` is a crude `value.len()/4` heuristic — budget accounting is therefore approximate; code facts get a 1.5x budget weight, structured-data facts 0.8x.

**Edge kinds (`EdgeKind`)** and their outgoing activation multipliers used by spreading activation:

| Edge | Meaning | Multiplier |
|------|---------|-----------|
| `Triggers` | skill → trigger context ("I fire when this matches") | 0.9 |
| `DefinedIn` | CodeSymbol relation | 0.9 |
| `Calls` | CodeSymbol relation | 0.85 |
| `CitesPremise` | Conclusion → Fact | 0.85 |
| `DependsOn` | dependent → dependency | 0.8 |
| `RelatedTo` | semantic, bidirectional by convention | 0.6 |
| `TemporalNext` | conversation ordering | 0.5 |
| `Imports` | CodeSymbol relation | 0.4 |
| `Supersedes` | new → old | 0.3 |

Retrieval also traverses select **incoming** edges (`RelatedTo`/`DependsOn`/`Triggers`/`Calls`/`DefinedIn`/`Imports`).

**FactMetadata (quality signals)** — every fact carries `confidence` (high/medium/low/derived), `provenance`, `affected_files` (glob-able, drives file-affinity scoring), `tags`, `category` (fact/gotcha/anti_pattern/decision/pattern), `usage_count`, `helpful_count`, `outdated_reports`, and `tenant_id`. `staleness_ratio()` and `helpfulness_ratio()` feed fact scoring — stale facts get a 0.7x penalty, helpful facts a small boost.

### 2. Retrieval — spreading activation and Personalized PageRank

Two retrieval algorithms run over the graph:

- **Legacy BFS — `retrieve(seeds, max_hops, max_results, decay, min_activation)`** — BFS from seed nodes where `activation = activation * decay * edge.weight * edge_mult`, pruned below `min_activation`, superseded nodes filtered out, sorted activation-descending.
- **Personalized PageRank — `retrieve_ppr(seeds, seed_weights, damping, max_results)`** — HippoRAG-inspired PPR that propagates relevance from seeds, converging in ~10–20 iterations. The reset (teleport) vector is built from seed weights, any single entry capped at 0.4 then renormalized. This is what `score_facts` uses (damping `0.5`, `50` results) to rank facts for the Facts layer.

Both have opt-in cross-partition variants (`retrieve_cross_partition`, `retrieve_ppr_cross_partition`). Seeds come from `find_seeds_weighted(query, max_seeds)` / `find_seeds(query, max_seeds)`.

### 3. Four-layer context assembly

`build_context` emits the canonical four-layer scaffold (Liotta 2026 model) in **relevance-ascending** order so the most relevant content lands last (recency attention). The actual emitted sections:

```text
## Identity        <- who the agent is, authority level
## Active Constraints  <- hard rules, marked with ⚠️
## Task Skills     <- skills matching the current task
## Current Facts   <- PPR-ranked facts (+ ## Outdated orphans)
## Recent Context  <- ### Earlier summarized, ### Recent verbatim
## Environment     <- runtime context (deadlines, system state)
## Known Unknowns  <- gaps the agent should be aware of
```

Facts are scored via PPR + keyword overlap + file-affinity + helpfulness, sorted **ascending**, then budget-truncated dropping the least-relevant first.

> **Surfaced nodes — de-duplication is opt-in.** `build_context` records which fact nodes it emitted, but the default retrieval path **does not** suppress them: every call returns the complete relevant fact set, so repeated `buildContext` calls with the same query return the same facts. This is the correct default for a stateless caller (daemon RPC, an FFI binding, a fresh voice turn), which cannot know that facts were withheld.
>
> Until v0.39.1 suppression was on by default, which meant a fact surfaced exactly once and every later call returned an empty context — daemon-wide, since the daemon shares one engine across all sessions, and unrecoverable, since no binding exposed a reset (Parslee-ai/car#617).
>
> A caller driving **one continuous conversation** that keeps earlier context in the prompt can still opt in with the Rust-level `build_context_split_deduped(...)`, calling `clear_surfaced()` at each conversation boundary. Only do this on a dedicated engine — on a shared one the suppression set is process-wide, so unrelated clients suppress each other's facts.

Rust core signatures:

```rust
build_context(query) -> String                                   // = build_context_for_model(query, None)
build_context_for_model(query, model_context_window: Option<usize>) -> String
build_context_fast(query) -> String                              // ContextMode::Fast
build_context_with_options(query, window: Option<usize>, mode: ContextMode, tenant_filter: Option<&str>) -> String
build_context_checked(query) -> (String, bool, f64, String)      // includes needs-compaction signal
build_context_split_deduped(query, window, mode, tenant_filter) -> ContextSplit  // opt-in: skips already-emitted facts
```

### 4. Dynamic context budget and layer splits

`MemgineConfig::effective_budget(Some(window))` sizes the assembly to the model you are about to call:

```rust
// budget = (context_window - response_reservation) * context_budget_fraction
// clamped to >= 2000, <= remaining.  Defaults: reservation=4096, fraction=0.40.
let config = MemgineConfig::default();
assert_eq!(config.effective_budget(None), 8000);             // fixed fallback (token_budget)
assert_eq!(config.effective_budget(Some(272_000)), 107_161); // (272000-4096)*0.40
assert_eq!(config.effective_budget(Some(128_000)),  49_561);
assert_eq!(config.effective_budget(Some(8_000)),     2000);  // clamped up to floor
```

The total budget is then split across four layers whose fractions **must sum to 1.0**:

| Layer | Content | Fraction |
|-------|---------|----------|
| layer1 | Identity | 0.05 |
| layer2 | Facts | 0.50 |
| layer3 | Conversation | 0.30 |
| layer4 | Environment | 0.15 |

Other tunables on `MemgineConfig`: `token_budget` (8000 fallback when no window), `response_reservation` (4096), `context_budget_fraction` (0.40), `max_skills_in_context` (6), `conversation_keep_recent` (6), `environment_max` (5), `compaction_batch_size` (8), `speculative_compaction_interval` (10, `0` disables). Call `validate()` to enforce invariants (layer fractions sum to 1.0; soft threshold `0.70` < hard threshold `0.95`).

> **Gotcha — dynamic budget over the daemon.** NAPI `buildContext` accepts `modelContextWindow` but it is **not yet wired through** the daemon's `memory.build_context` JSON-RPC (the arg is dropped with `let _ = model_context_window`). Dynamic budget sizing currently only takes effect when calling the in-process Rust engine directly via `build_context_for_model`.

### 5. Working with facts and context (author surface)

```typescript
import { CarRuntime } from 'car-runtime';
const rt = new CarRuntime();

// "pattern" facts are normal knowledge.
rt.addFact('project_language', 'TypeScript', 'pattern');
rt.addFact('deploy_target', 'Cloudflare Workers', 'pattern');

// "constraint" facts are hard rules — they go into the Constraints layer (⚠️).
rt.addFact('no_eval', 'Never use eval() or new Function()', 'constraint');

// confidence is the 4th positional arg (0..1; defaults to 1.0)
rt.addFact('user_prefers_short_responses', 'true', 'pattern', 0.8);

// Query via spreading activation -> JSON string array of top-k.
const hits = JSON.parse(rt.queryFacts('what runtime do we deploy to?', 5));
// [{subject: 'deploy_target', body: 'Cloudflare Workers', confidence: 0.78}, ...]

// Build the 4-layer context (default 8K budget, or adaptive to the model).
const ctx        = rt.buildContext('how should I deploy this PR?');
const ctxForOpus = rt.buildContext('how should I deploy this PR?', 200_000);

// Fast mode for voice/real-time.
const fastCtx = rt.buildContextFast('user just said: deploy now', 32_000);
```

**Method reference**

| NAPI (camelCase) | PyO3 (snake_case) | JSON-RPC | Notes |
|------------------|-------------------|----------|-------|
| `addFact(subject, body, kind, confidence?)` → `Promise<number>` | `add_fact(subject, body, kind, confidence=None)` | `memory.add_fact` | `kind` = `'pattern'` or `'constraint'`; returns fact count |
| `queryFacts(query, k?)` → `string` (JSON) | `query_facts(query, k=None)` | `memory.query` | top-k via PPR; parse with `JSON.parse` |
| `factCount()` → `Promise<number>` | `fact_count()` | `memory.fact_count` | |
| `buildContext(query, modelContextWindow?)` → `Promise<string>` | `build_context(query, model_context_window=None)` | `memory.build_context` | window dropped over daemon (see gotcha) |
| `buildContextFast(query, modelContextWindow?)` → `string` | `build_context_fast(query, model_context_window=None)` | `memory.build_context_fast` | sync in NAPI |
| `consolidate()` → `string` | `consolidate()` | — | dream pass: GC, embedding, distillation |
| `persistMemory(path)` / `loadMemory(path)` → `number` | same | — | JSON snapshot of whole graph |

Grounding can be applied for you: pass the `buildContext` string as the system prompt, or call `rt.inferWithContext(prompt, model)` to have the engine assemble and inject context automatically.

**Fast mode is a different algorithm.** `ContextMode::Fast` skips embedding flush, skill lookup, PPR-based fact scoring, inline repairs, orphan invalidations, and Known-Unknowns extraction. It keeps Identity, Constraints, Facts (in **creation-order, newest last** — not relevance), Conversation, Environment. Do not use it where relevance ranking matters.

### Persistence

- **Whole-graph JSON snapshot** — `persistMemory('/path/memory.json')` then `const n = loadMemory('/path/memory.json')` (returns fact count). The format is backward-compatible and safe to commit alongside `.car/` when facts are team knowledge. Conversation turns are included in the snapshot (each `Conversation` node exports as an `outcome` entry: `subject` = speaker, `body` = `"speaker: text"`), so the conversation's *content* carries across restarts — but as flat facts, **not** a replayable ordered transcript.

> **Removed in 0.25.** A bounded JSONL `ConversationStore` (`with_conversation_store` / `load_persisted_conversations`) once offered verbatim turn-by-turn resume. It was removed (commit `d7568282`) — no callers, plus a compaction-vs-store incoherence bug. For true ordered transcript resume, keep the raw transcript in your own app and use `persistMemory`/`loadMemory` for the derived memory; the forward path is the oplog design in `docs/proposals/multi-device-sync.md`. Background: `docs/solutions/conversation-persistence-removed-in-0.25.md`.

### Semantic conversation compaction

Compaction (`compaction.rs`) never blindly truncates. It clusters turns by embedding similarity (`cluster_by_topic`), importance-scores them via decision keywords + graph connectivity (`content_importance`, `graph_importance`), **drops turns already captured as facts** (`is_redundant` via cosine similarity), and summarizes the rest (LLM via `summarize_conversation_prompt`, falling back to `heuristic_summarize`). It emits a `ConversationCompactionReport { turns_summarized, summaries_created, facts_extracted, summaries_promoted, redundant_dropped, tokens_before, tokens_after }` with structured telemetry per pass.

### Partitions and multi-tenancy

- **Partitions** — `Partition::Project` (default) vs `Partition::Foreign { source_repo, commit }`. Default context assembly is **project-only**; Foreign-partition nodes are filtered out unless a caller explicitly opts into cross-partition retrieval / GATHER with `include_foreign`.
- **Multi-tenant scoping** — facts/skills carry an optional `tenant_id`. Use the scoped view to stamp on write and filter on read:

```rust
let mut memgine = MemgineEngine::new(None);
memgine.scoped(Some("acme")).ingest_fact(
    "f-greeting", "greeting", "hello, acme!",
    "user", "high", Utc::now(), "global", None, vec![], false,
);
let ctx = memgine.scoped(Some("acme")).build_context("greeting");
assert!(ctx.contains("hello, acme!"));
// globex and the legacy unscoped path do NOT see acme's fact
assert!(!memgine.scoped(Some("globex")).build_context("greeting").contains("hello, acme!"));
assert!(!memgine.build_context("greeting").contains("hello, acme!"));
```

> **Gotcha — strict isolation, no fallthrough.** A scoped tenant view never sees unscoped facts and the unscoped path never sees scoped facts. There is no global-facts fallthrough by design. **Bootstrap each tenant's foundational facts at startup** or they will see nothing.

Run the memgine unit tests (budget math, conversation store, spreading activation) with:

```bash
cargo test -p car-memgine
```

### 6. Skills — learned procedures as first-class graph nodes

A skill is the unit of learning. It is stored as a `MemKind::Skill` node (layer 2, `key=<name>`, `fact_id="skill:<name>"`, `value` = JSON-encoded `SkillMeta`). On ingest, a **second** node is created — a `MemKind::Fact` with key `skill_trigger:<name>` and value `"<persona> <url_pattern> <task_keywords joined>"` — and wired skill → trigger via an `EdgeKind::Triggers` edge so that a matching context activates its skill through spreading activation. When a skill is superseded its node kind flips to `MemKind::SkillDeprecated`.

```rust
// engine.rs — trigger edge wired on ingest:
let trigger_text = format!("{} {} {}", trigger.persona, trigger.url_pattern, trigger.task_keywords.join(" "));
let trigger_nix = self.graph.insert(MemNode { kind: MemKind::Fact, key: format!("skill_trigger:{}", name), value: trigger_text, /* ... */ });
self.graph.link(skill_nix, trigger_nix, EdgeKind::Triggers, 1.0);
```

**`SkillMeta`** = `{ name, code, platform, description, trigger: SkillTrigger, scope: SkillScope, when_to_apply: String, stats: SkillStats, version: u64, tenant_id: Option<String> }`. The `code` field is an opaque string — a Playwright body, shell script, function name, or JSON spec. `platform` is `"playwright" | "node" | "shell" | "python"` (distilled skills are tagged `"distilled"`).

**`SkillTrigger`** = `{ persona: String, url_pattern: String, task_keywords: Vec<String>, structured: Option<StructuredTrigger> }`. The keyword-shaped fields are the only ones `find_skill` matches today; a `Some(structured)` trigger (`{ kind, signature: Value }`) is **not** matched yet.

**`SkillScope`** = `Global` (default) | `Domain(String)`, following SkillRL's SkillBank = S_g ∪ ∪S_k. `find_skill` **always** includes all Global skills, then fills the remaining `max_results` slots with the top-scoring Domain skills.

**`SkillStats`** = `{ success_count, fail_count, degraded, broken_for_repair, completion_rate: Option<f64>, complaint_count: Option<u64>, last_used_at: Option<DateTime> }`. `success_ratio()` returns `0.5` when there is no data.

### The skills loop — ingest, find, report, repair, evolve

```typescript
import { CarRuntime } from 'car-runtime';
const rt = new CarRuntime();

// 1. Ingest a skill the first time it works.
rt.ingestSkill(
  'deploy-staging',
  'pnpm build && pnpm deploy --env staging', // code: shell cmd / fn name / JSON spec
  'node',        // platform
  'engineer',    // persona
  '',            // url_pattern ("" for n/a)
  ['deploy', 'release', 'staging', 'ship'],  // task_keywords that trigger it
  'Deploy the current branch to staging',    // description
);

// 2. Find the right skill for the current context.
const found  = rt.findSkill('engineer', '', 'ship this branch to staging', 3);
const skills = found === 'null' ? [] : JSON.parse(found);
// [{ name, code, platform, description, stats, match_score }, ...]

// 3. Use it, then record the outcome — this is what makes skills learn.
const skillUsed = skills[0];
let success = true;
try { /* ... actually run the skill ... */ } catch (e) { success = false; }
rt.reportOutcome(skillUsed.name, success ? 'success' : 'fail');
```

**`find_skill` scoring** blends trigger match, past success, and graph activation:

```
score = (persona_match*0.4 + url_match*0.3 + kw_match*0.3) * 0.4
      + stats.success_ratio() * 0.4
      + activation.min(1.0)  * 0.2
```

`persona_match` is `1.0` on case-insensitive equality; `url_match` is `1.0` if the url contains the `url_pattern` (with `*` stripped); `kw_match` is the fraction of `task_keywords` (lowercased) found in the task. Degraded/broken skills are filtered **out** of `find_skill` candidates (they still surface via `list_skills`). `findSkill` returns the literal string `'null'` when nothing matches — guard with `found === 'null' ? [] : JSON.parse(found)`.

**Auto-degradation.** `SkillStats::should_degrade(threshold)` is `fail_count > success_count + threshold`. The engine calls it with `SKILL_DEGRADE_THRESHOLD = 2`:

```rust
impl SkillStats {
    pub fn should_degrade(&self, threshold: u64) -> bool {
        self.fail_count > self.success_count + threshold
    }
}
// report_outcome: meta.stats.degraded         = should_degrade(2);
//                 meta.stats.broken_for_repair = meta.stats.degraded;
```

So a skill degrades once `fail_count > success_count + 2`; `report_outcome` sets both `degraded` and `broken_for_repair`, bumps `last_used_at`, updates per-domain stats, and inserts the skill into `needs_review` (Known Unknowns).

**Repair — not auto-committed:**

```typescript
const repaired = await rt.repairSkill('deploy-staging');
// Returns the new code as a string, or null if the skill isn't degraded
// or repair fails. The repaired version is NOT auto-ingested — call
// ingestSkill again with supersedes: 'deploy-staging' to commit it.
```

**Evolution, listing, distillation:**

```typescript
const events    = await readTraceEventsFromDisk();
const newSkills = await rt.evolveSkills(JSON.stringify(events), 'engineer');

const all          = JSON.parse(rt.listSkills());
const engineerOnly = JSON.parse(rt.listSkills('engineer'));
const needWork     = rt.domainsNeedingEvolution(0.6); // ["browser-automation", "deploy"]

const distilled      = JSON.parse(await rt.distillSkills(JSON.stringify(events)));
const ingestedCount  = rt.ingestDistilledSkills(JSON.stringify(distilled));
```

- **`distill_skills(events)`** partitions a trace (`partition_trace`: `"action_succeeded"` → success; `"action_failed" | "action_rejected" | "policy_violation"` → failure), runs success/failure distillation prompts through local inference (temp `0.3`, `max_tokens 1024`), and parses the response into `DistilledSkill[]`. `ingest_distilled_skills` then ingests each with `platform="distilled"`. `consolidate()` (the dream pass) runs distillation as idle work.
- **`evolve_skills(failed_events, domain)`** follows SkillRL Algorithm 1 lines 26–30 — gathers current domain skills, feeds them + failed traces into inference, and merges fresh/refined skills into the graph.
- **`domains_needing_evolution(threshold)`** / `should_evolve(domain, threshold)` flag a domain where `success_rate() < threshold` (default `0.6`) **and** it has at least 3 recorded outcomes. `DomainStats::success_rate()` returns `1.0` (assumed healthy) with no data — note this differs from `SkillStats::success_ratio()`'s `0.5` no-data default.

**Skills method reference**

| NAPI | PyO3 | JSON-RPC (daemon) |
|------|------|-------------------|
| `ingestSkill(name, code, platform, persona, urlPattern, taskKeywords[], description, supersedesSkill?)` → `Promise<number>` | `ingest_skill(..., supersedes=None)` → `int` | — |
| `findSkill(persona, url, task, maxResults?)` → `string` (JSON or `'null'`) | `find_skill(...)` | — |
| `reportOutcome(skillName, outcome)` → `string` (stats JSON) | `report_outcome(...)` | — |
| `distillSkills(eventsJson)` → `Promise<string>` | `distill_skills(...)` | `skills.distill` |
| `ingestDistilledSkills(skillsJson)` → `number` | `ingest_distilled_skills(...)` | `skills.ingest_distilled` |
| `evolveSkills(eventsJson, domain)` → `Promise<string>` | `evolve_skills(...)` | `skills.evolve` |
| `repairSkill(skillName)` → `Promise<string\|null>` | `repair_skill(...)` | — |
| `listSkills(domain?)` → `string` | `list_skills(domain=None)` | `skills.list` |
| `domainsNeedingEvolution(threshold?)` → `string[]` | `domains_needing_evolution(...)` | `skills.domains_needing_evolution` |

JSON-RPC skills methods are proxied via `car-ffi-common/src/proxy.rs`.

### Skills gotchas

- **Degraded skills are not deleted.** They still surface in `list_skills` (so the model knows they exist) but are filtered out of `find_skill` candidates. `report_outcome` sets both `degraded` and `broken_for_repair` when `fail_count > success_count + 2`.
- **`repair_skill` does not auto-ingest.** It returns the new code only; call `ingestSkill` again with `supersedes` set to the old name to commit it (which flips the old node to `SkillDeprecated`).
- **`find_skill` only matches keyword-shaped trigger fields.** A `SkillTrigger.structured` (Some) trigger with empty web-task fields will **not** be returned by `find_skill` — enumerate via `list_skills` and run your own matcher (structured dispatch deferred, car#181).
- **Distill / evolve / repair all require a configured inference engine** (`self.inference`). With none configured they return an empty `Vec` / `None` **silently**.
- **The binding `ingest_skill` signature is lossy.** It flattens `SkillTrigger` into positional `persona`/`url_pattern`/`task_keywords` and only exposes `supersedes`. `depends_on`, `related_facts`, `scope`, and `when_to_apply` are reachable only via the Rust `ingest_skill` / `ingest_skill_full` methods.
- **In daemon mode, `ingestSkill` rejects (NAPI) / raises `RuntimeError` (PyO3)** on an unreachable or malformed daemon response instead of silently returning `0` (#146).
- **Skills are tenant-isolated when `tenant_id` is set** (strict, car#187) — scoped retrievals do not see unscoped skills and vice-versa; `domain_stats` are keyed by `(tenant_id, domain)`.
- **`report_outcome` only matches `MemKind::Skill` nodes** by `node.key` (the name) — a deprecated/superseded skill (`MemKind::SkillDeprecated`) won't receive outcome updates.

---

## Inference & Models (Local + Cloud)

CAR ships a unified inference layer (`car-rs/crates/car-inference/`) that puts local GGUF models, Apple on-device backends, and every major cloud provider behind one engine. An agent author never talks to OpenAI or Candle directly — they talk to the runtime, and the runtime routes. This section is the reference for that layer: the engine, the model registry, routing, the intent/recommendation vocabulary, streaming, and the CLI/FFI/JSON-RPC surfaces that expose it.

### Daemon-first: where inference actually runs

Since v0.8 the FFI bindings (`car-ffi-napi`, `car-ffi-pyo3`) are thin WebSocket clients to a singleton `car-server`. For inference this is load-bearing:

- The **daemon owns** the models directory (`~/.car/models/`, machine-shared) and `models.json` under its state root (`~/.car/models.json`, or `$CAR_HOME/models.json`). When you call `rt.infer(...)` from Node or Python, generation happens **in the daemon process**, not in your process.
- The CLI inference commands (`car infer`, `car image`, `car video`, `car embed`, and several `models.*` subcommands) try the daemon **first** over WebSocket JSON-RPC, then fall back to an **embedded in-process engine** if the daemon is unreachable. `car infer` goes further: it **auto-spawns** `car-server` (`car_proto::daemon::try_spawn_daemon()`) and retries the JSON-RPC call up to **20 times at 250 ms intervals** before falling back. If `car-server` is not on PATH it prints a singleton-daemon warning — suppress with `CAR_NO_DAEMON_WARNING=1`.
- The default daemon WebSocket URL is `ws://127.0.0.1:9100/` (`car_proto::daemon::daemon_ws_url()`), overridable via `CAR_DAEMON_URL`.

```rust
// CLI infer: daemon-first with auto-spawn + retry (car-cli/src/main.rs)
match infer_via_daemon_once(&url, req).await {
    Ok(result) => Some(Ok(result)),
    Err(err) if is_daemon_unreachable(&err) => {
        if start_daemon_background(daemon_port()).is_ok() {
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                // retry infer_via_daemon_once ...
            }
        }
        None
    }
    Err(err) => Some(Err(err)),
}
```

> **Gotcha — model registration is not hot.** `registerModel` / `register_model` via the daemon only makes the new model visible on the **next** daemon boot. Register your custom models before starting inference, or restart the daemon after a batch.

### The InferenceEngine

`InferenceEngine` (`car-inference/src/lib.rs:456`) is the core entry point. Construct it from an `InferenceConfig`; it holds a `UnifiedRegistry`, an `AdaptiveRouter`, an `OutcomeTracker`, and lazily-loaded backends. All inference and model management are methods on it.

```rust
let engine = InferenceEngine::new(InferenceConfig::default());
let req = GenerateRequest { prompt: "Explain CAR in one sentence.".into(), ..Default::default() };
let result: InferenceResult = engine.generate_tracked(req).await?;
println!("{} (model={}, {}ms)", result.text, result.model_used, result.latency_ms);
```

`InferenceConfig::default()` auto-detects hardware (via `HardwareInfo::detect()`), picks `generation_model = hw.recommended_model`, sets embedding to `Qwen3-Embedding-0.6B`, classification to `Qwen3-0.6B`, and uses `~/.car/models/` as the models dir. On first use of a local model, the registry **auto-pulls** it via `ensure_local`.

#### Core engine methods

| Method | Returns | Purpose |
|--------|---------|---------|
| `generate_tracked(req: GenerateRequest)` | `InferenceResult` | Generate text with `trace_id`/`usage` tracking |
| `generate(req)` | `String` | Bare-string generate |
| `generate_tracked_stream(req)` | `mpsc::Receiver<StreamEvent>` | Streaming generation |
| `embed(req: EmbedRequest)` | `Vec<Vec<f32>>` | Qwen3-Embedding vectors |
| `classify(req: ClassifyRequest)` | `Vec<ClassifyResult>` | Label scoring |
| `rerank(req: RerankRequest)` | `RerankResult` | Qwen3-Reranker yes/no scoring |
| `transcribe` / `synthesize` / `generate_image` / `generate_video` | — | Speech/vision/media tasks |
| `route(prompt)` / `route_adaptive(prompt)` | `RoutingDecision` / `AdaptiveRoutingDecision` (async) | Legacy vs adaptive routing |
| `estimated_tokens(req, model_id)` | `(input_tokens, context_window, fits)` | Pre-flight token budget check |
| `tokenize(model, text)` / `detokenize(model, tokens)` | `Vec<u32>` / `String` | Tokenizer access |
| `list_models()` / `list_models_unified()` / `list_schemas()` | — / `Vec<ModelInfo>` / `Vec<ModelSchema>` | Catalog inspection |
| `pull_model(name)` / `pull_model_with_progress(name, &ProgressSink)` | `PathBuf` | Download a model (local path) |
| `remove_model(name)` / `register_model(schema)` / `discover_vllm_mlx_models()` | — / — / `usize` | Lifecycle |
| `available_model_upgrades()` / `detect_upgrades()` | `Vec<ModelUpgrade>` / `Vec<UpgradeFinding>` | Curated + upstream upgrade discovery |
| `check_upgrade_nudge(inference_active)` / `dismiss_upgrade_nudge(key)` | `(NudgeDecision, NudgeState)` / — | Throttled upgrade prompts |
| `update_prefs()` / `set_update_prefs(&prefs)` | `UpdatePreferences` / — | Update channel/policy/budget |
| `model_health()` / `speech_health()` | `ModelHealthReport` / `SpeechHealthReport` | Diagnostics |

### Local backends: Candle, MLX, FoundationModels

Local generation runs GGUF **Qwen3 / Qwen3-MoE** models. Backend selection is **compile-time via cfg-target gating** (the repo has a hard rule: no cargo feature flags — platform variance is `cfg`, never a runtime feature).

- **Non-Apple targets — Candle.** `CandleBackend::load(model_dir, device)` reads `model.gguf` + `tokenizer.json`, auto-detects `general.architecture` from GGUF metadata, and loads either standard Qwen3 (`quantized_qwen3::ModelWeights`) or `qwen3moe` (`Qwen3MoeModel`). Runs on `Device::{Cpu, Metal, Cuda(ordinal)}` via `Device::auto()`.
- **Apple Silicon (`target_os=macos`, `target_arch=aarch64`, not `car_skip_mlx`) — MLX.** The Candle path (`candle.rs`) is **cfg'd out entirely**; `generate`/`classify`/`embed` route through the `MlxBackend` instead.
- **Apple FoundationModels** is an additional on-device source (`ModelSource::AppleFoundationModels`).

> **Gotcha — TTFT.** `time_to_first_token_ms` on `InferenceResult` is populated **only** by local Candle/MLX generate paths. It is `null` for non-streaming remote calls. To time first-token on remote models, use `generate_tracked_stream` and time the first `text` event yourself.

### Remote providers: the ProtocolHandler trait

Remote providers are unified behind the `ProtocolHandler` trait (`protocol.rs:44`), selected by `handler_for(ApiProtocol)` (`protocol.rs:1200`). Adding a provider means implementing one trait.

Required methods: `endpoint_path`, `auth_headers(api_key)`, `build_request_body(&ApiRequest)`, `parse_response(body) -> ApiResponse`, `parse_stream_event(event_type, data) -> Vec<StreamEvent>`, `build_messages(messages, prompt, context, images) -> (Vec<Value>, Option<String>)`, `build_tools(tools)`. Default-provided capability flags: `supports_streaming` / `supports_thinking` / `supports_video` / `supports_audio` / `supports_response_format` / `protocol_name`. A false `supports_response_format` result becomes an `UnsupportedMode` at both remote seams rather than weakening the request.

| `ApiProtocol` (`schema.rs:234`) | Handler | Notes |
|--------------------------------|---------|-------|
| `OpenAiCompat` | `OpenAiHandler` | Standard chat-completions shape |
| `OpenAiResponses` | `OpenAiHandler` | `/v1/responses`; opaque `provider_output_items` round-trip |
| `Anthropic` | `AnthropicHandler` | — |
| `Google` | `GoogleHandler` | Gemini |
| `AzureOpenAi` | `AzureOpenAiHandler` | — |

```rust
let handler = handler_for(ApiProtocol::Anthropic); // Box<dyn ProtocolHandler>
let (messages, system) = handler.build_messages(&msgs, prompt, context, images);
let body = handler.build_request_body(&ApiRequest { model, messages, system, /* ... */ });
let resp = handler.parse_response(&body_str)?; // ApiResponse { text, tool_calls, usage }
```

`ApiRequest` (`protocol.rs:15`) carries: model, messages, system, temperature, max_tokens, tools, tool_choice, parallel_tool_calls, stream, budget_tokens, cache_control, response_format. `ApiResponse` (`protocol.rs:36`) carries: text, tool_calls, usage.

> **Gotcha — Anthropic JSON output.** Anthropic has no provider-enforced `response_format` field under CAR's pinned API version. Both `json_object` and `json_schema` are **rejected with `UnsupportedMode`** rather than silently weakened. For structured output on Claude, use `tools` + `tool_choice="required"` coercion.
>
> **Gotcha — local multimodal.** Video/audio `ContentBlock`s on local backends return `InferenceError::UnsupportedMode` (only `ImageBase64`/`ImageUrl` are wired on native Qwen2.5-VL). Remote multimodal providers accept them via the protocol handlers.
>
> **Gotcha — account errors are not model errors.** A remote 401/403 (key absent or rejected) or 402 (out of credits/quota) returns `InferenceError::ProviderAccount { provider, status, message }`, not `InferenceFailed`. The condition is account-wide, so it is deliberately excluded from the model's health EMA and its circuit breaker — otherwise a billing lapse benches healthy models and the penalty outlives the top-up that fixes it. The attempt still lands on the outcome ledger, with no success/quality verdict. The dispatch loop also drops that provider's remaining fallback candidates, since they share the account and would fail identically (Parslee-ai/car#650).

### Request and message shapes

**`GenerateRequest`** (`tasks/generate.rs:428`) — derives `Default`:

| Field | Type | Meaning |
|-------|------|---------|
| `prompt` | `String` | The prompt |
| `model` | `Option<String>` | Pin a model (short-circuits routing) |
| `params` | `GenerateParams` | Decoding params (below) |
| `context` | `Option<String>` | Memory injection (use `build_context*` output) |
| `tools` | `Option<Vec<Value>>` | JSON-Schema tool definitions |
| `images` | `Option<Vec<ContentBlock>>` | Vision inputs |
| `messages` | `Option<Vec<Message>>` | Multi-turn history |
| `cache_control` | — | Anthropic prompt caching |
| `response_format` | `JsonSchema{schema,strict,name}` / `JsonObject` | Structured output |
| `intent` | `Option<IntentHint>` | Routing hint |

**`GenerateParams`** (`tasks/generate.rs:137`): `temperature=0.7`, `top_p=0.9`, `top_k=0`, `max_tokens=4096`, `stop`, `budget_tokens` (extended thinking), `workload`, `tool_choice` (`auto`/`required`/`none`), `parallel_tool_calls`, `thinking` (Qwen3 `/think` | `/no_think` `ThinkingMode`), `cache_ttl`, and the routing-only `estimated_cache_read_input_tokens=0` / `estimated_cache_write_input_tokens=0`. The cache estimates let adaptive routing price a caller's expected cache read/write against each model's rates; they are clamped to the estimated input footprint, do not modify the provider request, and never become nonzero merely because `cache_control` is enabled.

**`Message`** enum (`tasks/generate.rs:345`, serde `tag="role"`): `System{content}`, `User{content}`, `UserMultimodal{content: Vec<ContentBlock>}`, `Assistant{content, tool_calls}`, `ToolResult{tool_use_id, content}`, `ProviderOutputItems{protocol, items}` (OpenAI Responses state round-trip). Use `InferenceResult::append_assistant_history` when maintaining your own multi-turn history: it keeps opaque Responses items in provider order before the assistant message, while leaving personal Chat Completions history unchanged. CAR's built-in agent, coder, bench, and CLI loops use the same helper automatically. `ContentBlock` supports `Text`, `ImageBase64`/`ImageUrl` (wired on native Qwen2.5-VL + remote), and `Video*`/`Audio*` (remote-only).

### The model registry and schemas

`UnifiedRegistry` is a capability-typed catalog of `ModelSchema`s (`schema.rs:351`):

```
id ("provider/model:variant"), name, provider, family,
capabilities (Vec<ModelCapability>), context_length, param_count, quantization,
performance, cost (CostModel { size_mb, ram_mb, input_per_mtok, output_per_mtok,
cache_read_input_per_mtok, cache_write_input_per_mtok, pricing_tiers }),
source (ModelSource), public_benchmarks, supported_params,
trust_tier (Curated | Community), deprecated
```

Registry helpers: `list()`, `get(id)`, `find_by_name(name)`, `ensure_local(id)` (auto-pull on first use), `ensure_local_with_progress`, `resolve_mlx_equivalent`, `available_upgrades`, `models_dir`.

**`ModelSource`**: `Local` (GGUF via Candle), `RemoteApi`, `Ollama`, `Mlx`, external/operator-owned `VllmMlx`, CAR-owned `ManagedVllmMlx`, and `AppleFoundationModels` (plus the speech/proprietary/delegated variants). Schema helpers: `is_mlx`, `is_vllm_mlx`, `is_car_managed_vllm_mlx`, `is_foundation_models`, `requires_apple_silicon`, `size_mb`, `ram_mb`. A loopback endpoint does not turn `VllmMlx` into the managed variant.

**`ModelCapability`** (the capability vocabulary the router and intent layer filter on):

```
Generate, Embed, Rerank, Classify, Code, Reasoning, Summarize,
ToolUse, MultiToolCall, Vision, VideoUnderstanding, AudioUnderstanding,
Grounding, SpeechToText, TextToSpeech, ImageGeneration, VideoGeneration
```

#### Registering a custom remote model

Build a `ModelSchema` JSON with a `remote_api` source, then register it:

```jsonc
{
  "id": "myco/gpt-x:latest",
  "name": "GPT-X",
  "provider": "myco",
  "capabilities": ["generate", "tool_use"],
  "context_length": 128000,
  "source": {
    "type": "remote_api",
    "endpoint": "https://api.myco.com",
    "api_key_env": "MYCO_API_KEY",
    "protocol": "openai_compat"   // or anthropic | google | azure_open_ai | open_ai_responses
  }
}
```

```bash
car models register schema.json   # single object OR a JSON array; persists to the state root's models.json (default ~/.car/models.json)
```

Equivalently `registerModel(schemaJson)` (NAPI) / `register_model` (PyO3) / `engine.register_model(schema)` (Rust). Remember: via the daemon the model appears on the **next** daemon boot.

> **Custom registration never grants Curated trust.** Every public custom-model
> boundary — including Rust `UnifiedRegistry::register`,
> `InferenceEngine::register_model`, `register_user_model`, the FFI bindings,
> CLI, and daemon `models.register` — normalizes the schema to
> `trust_tier=Community`. This also applies when a legacy JSON document omits
> `trust_tier` (whose serde compatibility default is `Curated`) or explicitly
> claims `Curated`. Only CAR's compiled builtin catalog and a catalog whose
> detached signature verifies against the configured project key retain
> Curated provenance. Community models remain available for explicit selection
> and participate in ordinary adaptive scoring and outcome learning, but they
> are excluded from latency-sensitive quality-first cold-start candidates and
> fallbacks whenever an eligible Curated remote peer exists.

### Adaptive, hardware-aware routing

`AdaptiveRouter` (`adaptive_router.rs`) does three-phase, hardware-aware model selection over the registry + `OutcomeTracker`. Entry points: `route(prompt, ...)`, `route_with_tools`, `route_with_vision`, `route_with(RouteRequest)`. It returns:

```
AdaptiveRoutingDecision {
    model_id, model_name, task, complexity, reason, strategy,
    predicted_quality, fallbacks, context_length, needs_compaction
}
```

`needs_compaction` signals the caller (car-memgine) to compress when estimated input exceeds the model's context window. A pinned `req.model` (or `preferred_generation_model`) short-circuits routing with strategy `Explicit`. The legacy static `router()` returns a plain `RoutingDecision`.

### Intent vocabulary — selecting models without IDs

`intent.rs` lets callers describe *what they want* instead of naming a model.

- **`UseCase`**: `Assistant` (default), `Coding`, `Summarize`, `Vision`, `Transcription`, `Search`. Each maps to a `UseCaseRole` (`Generative` / `Retrieval` / `Audio`) plus `required_capabilities()` (hard filter) and `preferred_capabilities()` (soft bonus).
- **`QualityTier`**: `Fastest`, `Balanced` (default), `MostCapable` — fixed `TierWeights { quality, latency, memory_pressure }`.
- **`Privacy`**: `OnDevice` / `CloudOk`.
- **`IntentHint`** threads through `infer`/router: `{ task: Option<TaskHint>, require: Vec<ModelCapability>, prefer_local, prefer_fast }`, where `TaskHint` is `Chat | Classify | Reasoning | Code`.

### The pure recommender

`recommend_with_policy()` is a **pure** function over its explicit inputs — no disk, no network:

```rust
recommend_with_policy(
    models: &[&ModelSchema],   // typically UnifiedRegistry::list()
    hardware: &HardwareInfo,
    policy: &ResourcePolicy,
    use_case: UseCase,
    tier: QualityTier,
    privacy: Privacy,
) -> RecommendationSet   // { picks, not_enough_memory, note }
```

Pipeline: **hard filter** (role lane + required caps + privacy + apple-silicon eligibility + deprecated) → **soft score** (tier-weighted quality / latency / memory) → **policy-aware deterministic order**. Each `Recommendation` carries `{ model_id, display_name, role, rationale, download_mb, already_installed, fit: FitStatus, acceleration, is_local, requires_cloud_consent, trust_tier, score, within_recommendation_target }`. `already_installed` means CAR-downloadable weights are physically ready, not merely routable. The memory estimate = weights + context overhead (8192-token working window) + backend runtime overhead + a distinct transient margin. Everyday automatic choices must also fit the policy's smaller recommendation target; heavier and unknown-memory entries remain visible only as explicit alternatives.

> **Recommender gotchas:**
> - External `VllmMlx`/`RemoteApi` models are **never** given the local-memory fit budget — they get `FitStatus::ServerProvided`. `ManagedVllmMlx` is local and charged. Endpoint spelling, including loopback, never changes ownership. A model with unknown `ram_mb` is `FitStatus::Unknown`, never silently treated as "fits".
> - CUDA weights are checked against measured VRAM while context/runtime/transient memory is checked against the host policy; Apple Silicon and CPU use the host/unified-memory policy for the full estimate.
> - Choosing cloud is **never silent**: `CloudOk` only makes remote models eligible; a remote pick carries `requires_cloud_consent: true` and the caller must obtain one-time consent before the first cloud inference. `OnDevice` never triggers this.
> - **Community** `trust_tier` upgrades **never** auto-apply (even with `policy=auto`) — they always notify only. **Deprecated** models are excluded from fresh recommendations but still listed if installed.

### Resource policy, ownership, and lifecycle

The persisted `ResourcePolicy` is an admission policy, not an operating-system
RSS limit:

| Profile | New-local-load ceiling | Automatic recommendation target |
|---|---:|---:|
| Everyday | 40% of host memory | 20% of host memory |
| Local-focused | 80% | 80% |
| Custom | exact `custom_max_model_mb` | same exact value |

Custom values are nonnegative 512 MB steps and may be zero. CAR saves the exact
MB value. `effective_budget()` clamps only the evaluated ceiling when necessary
to preserve `max(10% of total memory, 2048 MB)` as emergency reserve and emits a
normalization notice; it never rewrites the preference. Admission combines the
configured ceiling with current resident allocations, active reservations,
accelerator placement, and live free-memory evidence. Lowering a policy blocks
new loads but does not kill active inference; idle cache entries are reclaimed
on the cache's next enforcement, access, or sweep.

Ownership is source-declared. `ManagedVllmMlx` means CAR downloads the artifact,
holds admission through startup, supervises the child process group, accounts
its measured residency, and reaps it. `VllmMlx` means an external operator owns
the endpoint and weights; CAR never pulls, reaps, or locally memory-charges it.
External is an ownership classification, not a claim that the runtime is
off-device: it may run on the same Mac. Do not infer ownership from a URL, PID,
catalog prefix, or successful health probe. Unified rows expose the additive
`operator_managed_external_runtime` evidence bit only for the external source;
missing legacy evidence stays Unknown rather than being inferred.

For every CAR-owned allocation, the reservation spans the request or startup
transaction. Publishing resident weights atomically transfers the cold-weight
charge into residency while retaining request overhead, so concurrent startups
cannot double-discount the same allocation. Cancellation never turns a live
process into free capacity. Process teardown moves the exact allocation into
pending-teardown quarantine; only a confirmed whole-process-group exit clears
the charge and permits replacement. Model removal uses the same maintenance
gate and refuses active requests, residency, teardown, or cross-process leases.

Managed vLLM-MLX startup keeps its runtime improvements inside that transaction:
the daemon passes only a known family-specific reasoning parser, treats target
log/cache growth as progress, stalls after three target-silent minutes, and
still enforces a finite thirty-minute deadline per attempt. Unrelated global
Xet cache traffic is not progress. One stalled attempt may retry with Xet
disabled, but only after the exact failed process group is reaped; a failed or
cancelled reap remains quarantined and prevents the retry.

Catalog consumers must project lifecycle from complete evidence. For a
downloadable source, Installed requires `downloads_weights`, `weights_ready`,
and `car_enabled`; Use additionally requires an allowed `models.preflight`.
`downloads_weights=false` plus `available=true` is runtime-available, not
Installed. Treat absent required lifecycle fields as unknown and fail closed
for Use. Missing management evidence fails closed for ownership-sensitive
Adopt and Remove without hiding otherwise complete runtime/download evidence.
A `models.pull_progress` `completed` event is
only transfer completion: fetch a fresh same-id unified row and preflight before
selection. Adoption is explicit and daemon-resolved (no caller path), while
receipt-backed Remove from CAR is unavailable in use and preserves shared
Hugging Face data.

`models.preflight` is a read-only point-in-time decision. Treat `allowed` as the
UI gate, but do not cache it as authority: the real launch atomically rechecks
current reservations, residency, teardown, and live free memory before it
acquires the allocation. A download may therefore succeed while the later
launch is correctly blocked.

### Hardware detection

`HardwareInfo::detect()` (`hardware.rs`) populates `os, arch, cpu_cores, total_ram_mb, gpu_backend (Metal/Cuda/Cpu), gpu_devices, recommended_model, recommended_context, max_model_mb`. `supported_acceleration()` returns:

```
SupportedAcceleration::{
    Apple { unified_memory_mb },
    Cuda { device_memory_mb },
    UnsupportedDiscreteGpu { vendor, name, memory_mb },
    Cpu,
}
```

### Streaming inference

`StreamEvent` (`car-rs/crates/car-inference/src/stream.rs`): `TextDelta(String)`, `ToolCallStart{name, index, id}`, `ToolCallDelta{index, arguments_delta}`, `Usage{input_tokens, output_tokens}`, `StopReason(String)`, `ProviderOutputItem(Value)`, `Error(String)`, `Done{text, tool_calls}`. Managed OpenAI Responses reasoning items are opaque and retain `id`, `status`, `summary`, and `encrypted_content` for verbatim replay. `Error` is terminal and is accounted as a failed outcome, never as a successful completion. Rust: `engine.generate_tracked_stream(req) -> mpsc::Receiver<StreamEvent>`.

The daemon WebSocket `infer_stream` event taxonomy is keyed by a `type` field —
`text` / `tool_start` / `tool_delta` / `usage` / `stop_reason` /
`provider_output_item` / `error`. Deltas arrive in
`inference.stream.event` notifications; the final accumulated result is the
JSON-RPC response. An `error` notification is terminal and the request returns a
JSON-RPC error, never partial success.

```json
{
  "jsonrpc": "2.0",
  "id": "turn-1",
  "method": "infer_stream",
  "params": {
    "prompt": "Explain CAR in one sentence.",
    "model": "openrouter/openai/gpt-5.4",
    "max_tokens": 1024
  }
}
```

Direct NAPI `inferStream` and Python `CarRuntime.infer_stream` remain only as
ABI-compatibility stubs: they always reject/raise and never invoke their
callbacks. See `docs/cookbook/09-streaming-inference.md` for operational
WebSocket examples.

### InferenceResult

`generate_tracked` returns `InferenceResult` (`lib.rs:241`):

```
text, tool_calls (Vec<ToolCall>), bounding_boxes (Qwen2.5-VL grounding),
trace_id (for outcome reporting), model_used, latency_ms,
time_to_first_token_ms (local Candle/MLX only; null for non-streaming remote),
usage (Option<TokenUsage>: prompt/completion/total + context_window),
provider_output_items (OpenAI Responses opaque items)
```

### Embed / classify / rerank

```rust
// Embeddings (Qwen3-Embedding); is_query adds the Instruct/Query prefix
engine.embed(EmbedRequest { texts, model: None, instruction: None, is_query: true }).await?; // -> Vec<Vec<f32>>

// Classification; on Apple Silicon routes through generate with temperature 0 / ThinkingMode::Off
engine.classify(ClassifyRequest { text, labels, model: None }).await?; // -> Vec<ClassifyResult { label, score }>

// Reranking with a Qwen3-Reranker (yes/no scoring)
engine.rerank(RerankRequest { query, documents, model: None, instruction: None }).await?;
```

JS equivalents: `rt.embed(texts, model?)`, `rt.classify(text, labels, model?)`, `rt.rerank(query, documents, model?, topN?, instruction?)`.

### Model upgrades and the nudge system

- `available_model_upgrades()` returns curated `ModelUpgrade`s from `model-upgrades.json`.
- `detect_upgrades()` combines curated rules with HuggingFace Hub upstream discovery (Latest channel only, offline-safe, TTL-cached) into `UpgradeFinding`s.
- `check_upgrade_nudge(inference_active)` yields a throttled (≤ 1/day) `NudgeDecision`; `dismiss_upgrade_nudge(key)` persists dismissals to `~/.car/nudge-state.json`.
- Update prefs live at `~/.car/update-prefs.json` (project `.car/` overrides): `channel` `stable|latest`, `policy` `auto|notify|off`, `disk_budget_mb`, `keep_old_until_verified`.

### CLI: inference and model commands

There is **no** top-level `car serve`, `car recommend`, or `car generate`. The text-generation command is `car infer`; `serve`/`recommend` are `models` subcommands; the CAR daemon launcher is `car daemon`.

#### Generation

```bash
car infer "<prompt>" --model NAME --image img.png \
  --workload interactive --max-tokens 512 --temperature 0.7 --thinking off
car image "<prompt>" -m MODEL -o out.png --width 1024 --height 1024 --steps 30 --guidance 7.5 --seed 42
car video "<prompt>" -m MODEL -o out.mp4 --frames 96 --fps 24 --image ref.png --audio-video
car embed "<text>" -m Qwen3-0.6B
```

`car infer` flag defaults: `--workload interactive` (`Interactive|Batch|Background`), `--max-tokens 512`, `--temperature 0.7`, `--thinking off` (`off|on|auto`). Multiple `--image` paths are base64-loaded for vision. On success it prints the text to stdout and a `[model via trace in Nms]` line to stderr.

> **Gotcha — `--thinking off` by default (issue #168).** Qwen3's trained default is reasoning-on, which can burn the whole `--max-tokens` budget inside an unclosed `<think>` block and produce empty output. Use `on`/`auto` only with a larger budget (`--max-tokens >= 1024`).
>
> **Gotcha — `car video` audio flags are mutually exclusive** (exit code 2 if more than one is set): `--audio-video` = joint synthesis, `--audio` = audio-ref conditioning, `--audio-mux` = record path for downstream muxing **only** (does NOT condition the video).

#### Model management

```bash
car models list --capability generate --provider openai --local-only
car models discover --json            # refresh e.g. a vLLM-MLX server catalog
car models pull Qwen3-1.7B
car models remove Qwen3-1.7B
car models stats [id]
car models route "<prompt>"           # show the routing decision
car models doctor --json --mlx
car models smoke --json --dry-run
car models register schema.json       # single object or JSON array
car models unregister anthropic/claude-sonnet-4-6:latest
car models benchmark --json --models a,b --cases x,y --judge-model M
car models upgrades --json
car models upgrade --apply --remove-old --json
```

`--capability` accepts: `generate, embed, classify, code, reasoning, summarize, tool_use, vision, speech_to_text|stt, text_to_speech|tts, image_generation|image, video_generation|video`.

#### Recommend vs setup

```bash
car models recommend --for coding --tier balanced --cloud-ok      # read-only; ranks picks, never installs
car setup --use-case assistant --tier balanced --cloud-ok --yes   # interactive: detect → recommend → pull
```

> **Gotcha — flag name divergence.** `car models recommend` uses `--for` for the use case; `car setup` uses `--use-case`. Both default `--tier` to `balanced`. `use_case` accepts `assistant/coding/search/vision/transcription/summarize` (+ aliases); `tier` accepts `fastest/balanced/most-capable`.

#### Daemon vs `models serve` — two different servers

```bash
car daemon --port 9100             # execs the car-server CAR daemon (JSON-RPC over WS)
car models serve <model> --port 8000 --dry-run --json   # execs EXTERNAL `vllm-mlx serve` (OpenAI-compatible MLX)
```

`car models serve` resolves a cataloged model to a vllm-mlx runtime model (aliases like `qwen3.6 → vllm-mlx/qwen3.6-35b-a3b:4bit`), runs `vllm-mlx serve <runtime_model> --port <port>`, and suggests `export VLLM_MLX_ENDPOINT=http://127.0.0.1:<port>` + `car models discover`. `--dry-run` prints the command without launching. This is **unrelated** to the CAR daemon.

If `car daemon` can't find the `car-server` binary it prints the build hint `cd car-rs && cargo build -p car-server --release` and exits 1.

### FFI and JSON-RPC surfaces

The same engine is exposed three ways. Rust source is `snake_case`; NAPI auto-converts to `camelCase`; PyO3 keeps `snake_case`.

**NAPI (camelCase):** `infer`, `inferTracked`, `inferTrackedWithRequest`, `inferWithContext`, `embed`, `rerank`, `classify`, `tokenize`, `detokenize`, `routeModel`, `modelStats`, `listModels`, `listModelsUnified`, `pullModel`, `removeModel`, `registerModel`, `recommend`, `setupPlan`, `detectUpgrades`, `checkUpgradeNudge`, `dismissUpgrade`, `updatePrefsGet`, `updatePrefsSet`. Use `inferTrackedWithRequest(JSON.stringify(generateRequest))` to set every `GenerateRequest` field (including `params.strict_model`, intent, tools, messages, and response format). Python mirrors this as `infer_tracked_with_request(request_json)` and mirrors the other methods in snake_case. `inferWithContext(prompt, model?, maxTokens?, intentJson?)` grounds generation with memory. `inferStream` exists only as an always-reject compatibility export; use WebSocket `infer_stream`.

```javascript
const rt = new CarRuntime();
const { text } = JSON.parse(await rt.infer(prompt, model, maxTokens, intentJson)); // -> { "text": "..." }
```

**JSON-RPC (`car-server-core/src/handler.rs`):**

| Group | Methods |
|-------|---------|
| Inference | `infer`, `infer_stream` |
| Routing/stats | `models.route`, `models.stats` |
| Catalog | `models.list`, `models.list_unified`, `models.search`, `models.register`, `models.unregister` |
| Recommend/setup | `models.recommend`, `models.setup_plan` |
| Resource/admission | `models.resource_policy.get`, `models.resource_policy.set`, `models.preflight`, `models.storage_roots` |
| Upgrades | `models.upgrades`, `models.detect_upgrades`, `models.check_upgrade_nudge`, `models.dismiss_upgrade` |
| Prefs | `models.update_prefs_get`, `models.update_prefs_set` |
| Download/install/ownership | `models.pull`, `models.install`, `models.adopt`, `models.remove` |
| Delegated inference | `inference.register_runner`, `inference.runner.invoke`, `inference.runner.event`, `inference.runner.complete`, `inference.runner.fail` |

**JSON-RPC notifications:** `models.pull_progress`, `models.upgrade_available`, `inference.stream.event`.

The CLI calls these daemon methods for its daemon-first path: `infer`, `image.generate`, `video.generate`, `embed`, `models.list_unified`, `models.stats`, `models.register`, `models.unregister`.

> **FFI parity is mandatory in the same change.** A new `infer`/model method or enum variant must land in `car-ffi-napi/src/lib.rs` + `npm/index.d.ts`, `car-ffi-pyo3/src/lib.rs` + `car_runtime.pyi`, and `car-server-core` (`handler.rs`/`session.rs`/`host.rs`). Avoid `match _ =>` wildcards on FFI-exposed enums — they silently swallow new variants.

### Quick workflows

| Goal | Do this |
|------|---------|
| One-shot local generation (Rust) | `InferenceEngine::new(InferenceConfig::default())` → `generate_tracked(GenerateRequest { prompt, ..Default::default() })` |
| Generation from JS/Python | Start `car-server`, then `rt.infer(...)` / request-shaped `rt.inferTrackedWithRequest(json)` (NAPI) or `rt.infer_tracked_with_request(json)` (PyO3) |
| Low-latency streaming UI | daemon WebSocket `infer_stream`; consume `inference.stream.event` |
| Pick + install a model for this machine | `car setup`; hosts call `models.setup_plan`, `models.pull`, refresh `models.list_unified`, then `models.preflight` before Use |
| Add a cloud model | Build a `remote_api` `ModelSchema` → `car models register schema.json` → restart daemon |
| Embed / classify / rerank | `engine.embed/classify/rerank(...)` or `rt.embed/classify/rerank(...)` |

When iterating on this crate, the dev profile sets `incremental = false`; override per-call with `CARGO_INCREMENTAL=1 cargo build -p car-inference`.

Key navigation: `car-inference/src/lib.rs` (engine), `protocol.rs` (providers), `schema.rs` (registry types), `intent.rs` (UseCase/QualityTier/Privacy), `recommend.rs` (recommender), `hardware.rs` (detection), `stream.rs` (streaming), `adaptive_router.rs` (routing); `car-cli/src/main.rs` (CLI); `car-server-core/src/handler.rs` (JSON-RPC).

---

## Multi-Agent Coordination, Workflows & Scheduling

CAR ships three composable layers for running more than one model loop: **multi-agent coordination patterns** (`car-multi` — *when and how* agents run), **declarative workflows** (`car-workflow` — a stage graph wiring patterns, proposals, and sub-workflows together with conditional edges and saga rollback), and **persistent scheduling** (`car-scheduler` — triggered, looped, and background tasks plus the memory "dream" loop). All three sit on top of the same primitive — your **`AgentRunner`** — and all three are reachable from Rust, Node (NAPI, camelCase), Python (PyO3, snake_case), and the WebSocket JSON-RPC daemon.

### Prerequisite: the runtime does not own the model, and the daemon must be running

Two cross-cutting truths govern everything below.

1. **You supply the model loop.** CAR orchestrates *when/how* agents fire; **you** decide *what* each agent does. In Rust you implement the `AgentRunner` trait; in Node/Python you register **one** callback via `registerAgentRunner` / `register_agent_runner`. Nothing in this section runs without it — `spec.metadata['model']` / `spec.model` is read by *your* runner to pick the model. CAR will not pick one for you.
2. **Daemon-first (v0.8+).** `car-runtime` (npm) is a thin client to the singleton `car-server` daemon. The `multi.*`, `workflow.*`, and `scheduler.*` calls all delegate each per-agent run back to your client via a **server-initiated** JSON-RPC request (`multi.run_agent`, same oneshot-channel callback pattern as `tools.execute`). **If the daemon is not running, there is no one to dispatch those callbacks to** — start `car-server` first.

```bash
npx --package=car-runtime car-server &   # start the singleton daemon (required before any run_* call)
```

> **Critical ordering:** register your agent runner **before** any `run_*` / `workflow.*` / `scheduler.*` call. NAPI `runTask`/`runTaskLoop` and the scheduler JSON-RPC methods reuse the same `StoredAgentRunner`/`WsAgentRunner`; with no registered runner, agent stages and tasks have no model loop. (NAPI constraint: only 3 standalone functions may take a `ThreadsafeFunction` — `register_agent_runner` is one of them, which is why every `run_*` reuses the one stored callback rather than taking a fresh one.)

---

### The agent contract: `AgentRunner`, `AgentSpec`, `AgentOutput`

`car-multi` (`car-rs/crates/car-multi/`) is built around three types.

**`AgentRunner` (you implement this — Rust):**

```rust
#[async_trait::async_trait]
impl AgentRunner for MyRunner {
    async fn run(
        &self,
        spec: &AgentSpec,
        task: &str,
        runtime: &Runtime,
        mailbox: &Mailbox,
    ) -> Result<AgentOutput, MultiError> {
        // 1. Call your LLM with spec.system_prompt + task
        // 2. Parse response into an ActionProposal
        // 3. runtime.execute(&proposal).await
        // 4. Return AgentOutput
        todo!()
    }
}
```

**`AgentSpec` (the agent blueprint):**

| Field | Type | Notes |
|-------|------|-------|
| `name` | `String` | identifier |
| `system_prompt` | `String` | |
| `tools` | `Vec<String>` | allowed tool names |
| `max_turns` | `u32` | default `10` |
| `metadata` | `HashMap<String,Value>` | opaque provider/model/temperature — **the runtime does NOT read this to pick a model; your runner does** |
| `cache_control` | `bool` | Anthropic prompt-cache reuse, default `false` |

Builder: `AgentSpec::new(name, system_prompt).with_tools(..).with_max_turns(..).with_metadata(k, v).with_cache_control()`. Over JS/WS an `AgentSpec` is the looser shape `{ name, role?, model?, system_prompt? }`.

**`AgentOutput` (the result of one run):** `name`, `answer: String`, `turns: u32`, `tool_calls: u32`, `duration_ms: f64`, `error: Option<String>`, `outcome: Option<car_ir::AgentOutcome>`, `tokens: Option<TokenAccounting>`. `.succeeded()` is `error.is_none() && !answer.is_empty()`.

> **Gotcha — JS return shape differs from the Rust struct.** The JS runner callback returns JSON keyed `response` (the text) and a `tool_calls` array, while the Rust `AgentOutput` field is `answer`. Match the JSON your daemon expects.

> **`TokenAccounting{input_tokens, output_tokens, cost_usd}` is self-reported by the runner and explicitly NOT a trust boundary** — observability/benchmarking only. Do not use it for billing or security decisions.

#### Registering the runner from Node (reused by every `run_*`)

```typescript
import { registerAgentRunner } from 'car-runtime';

registerAgentRunner(async (specJson, task) => {
  const spec = JSON.parse(specJson);          // { name, role, model, system_prompt }
  const reply = await callYourLlm(spec.model, [
    { role: 'system', content: spec.system_prompt ?? spec.role ?? '' },
    { role: 'user',   content: task },
  ]);
  return JSON.stringify({
    name: spec.name,
    response: reply.text,
    tool_calls: reply.tool_calls ?? [],
  });
});
```

---

### How agents share data

Three mechanisms, all under `SharedInfra`:

- **Shared state & event log** — `SharedInfra { state: Arc<StateStore>, log: Arc<TokioMutex<EventLog>>, policies: Arc<TokioRwLock<PolicyEngine>> }`. `SharedInfra::new()` seeds all three. `make_runtime()` builds a `Runtime` sharing them (each runtime still gets its own tool set, executor, idempotency cache) via `Runtime::with_shared(...)`. All agents in a coordination group see the same state writes.
- **Per-agent isolation** — `make_isolated_runtime(agent_name) -> (Runtime, AgentContext)`. Writes hit a per-agent overlay; reads fall through to shared state. `AgentContext.get()` checks local then parent; `.set()` always writes local; **`.merge_to_parent()` must be called after the agent finishes** to propagate local writes (last merge wins for shared keys). A failed isolated agent's local writes are discarded. Backed by a `tokio::task_local` `AGENT_CTX` and `TaskScope::run(ctx, fut)` / `TaskScope::agent_name()`.
- **Mailbox (async inter-agent messaging)** — `Mailbox::new(buffer_size)` (default 64). `register(name) -> Receiver<Message>`, `send(msg)` routes by `msg.to` (errors `MailboxSend` if unknown), `broadcast(msg)` to all except `msg.from`, `unregister(name)`. `Message { from, to, kind: MessageKind, payload: Value, timestamp }`; `MessageKind = TaskAssignment | Result | Feedback | DelegateRequest | DelegateResponse | Custom`.

---

### The eight coordination patterns

Each pattern decides *when/how* agents run and calls your `AgentRunner` per agent. Rust builders take `Vec<AgentSpec>` plus `&Arc<dyn AgentRunner>` and `&SharedInfra`; the daemon delegates each per-agent run back via `multi.run_agent`.

| Pattern | Shape | Returns |
|---------|-------|---------|
| **Swarm** | N agents on the **same** problem; `Parallel` / `Sequential` / `Debate` | `SwarmResult { task, outputs, final_summary }` |
| **Pipeline** | Output-passing chain (a Sequential Swarm) | `PipelineResult { task, stages, final_answer }` |
| **Supervisor** | Worker swarm + review loop until `APPROVED` | `SupervisorResult { task, rounds, supervisor_feedback, final_answer, approved }` |
| **MapReduce** | Fan-out mapper per item, then reduce | `MapReduceResult { task, map_outputs, reduced_answer }` |
| **Vote** | All answer; synthesizer or majority picks winner | `VoteResult { task, votes, winner, agreement_ratio }` |
| **Delegator** | Main agent spawns specialists mid-run via a `delegate` tool | `DelegatorResult { task, final_answer, delegations }` |
| **Fleet** | Independent agents on **different** problems, shared knowledge | `FleetResult { outputs, duration_ms, succeeded, failed }` |
| **AdversarialReview** | Fresh, context-free reviewer scores work vs criteria | `AdversarialReviewResult { spec, passed, findings, reviewer_output, blocker_count }` |

#### Swarm

`Swarm::new(agents, mode).with_synthesizer(spec).with_isolation()`. `SwarmMode = Parallel | Sequential | Debate`.

- **Parallel** — all agents run concurrently (`tokio::spawn` + `join_all`); each output is written to shared state at key **`agent.<name>.answer`**, then an optional synthesizer combines them.
- **Sequential** — agents run in order; each subsequent prompt is enriched with prior succeeded outputs (`"Prior agents' findings:"`).
- **Debate** — round 1 = parallel answers; round 2 = each agent critiques the others (spec renamed `<name>_critique`); all outputs combined then synthesized.

```rust
let runner: Arc<dyn AgentRunner> = Arc::new(MyRunner { /* ... */ });
let infra = SharedInfra::new();
let result = Swarm::new(agents, SwarmMode::Parallel)
    .with_synthesizer(AgentSpec::new("synth", "Combine the answers"))
    .with_isolation()
    .run("the task", &runner, &infra)
    .await?;
// each parallel agent wrote shared state at key  agent.<name>.answer
```

```typescript
import { runSwarm } from 'car-runtime';

const result = await runSwarm(
  'parallel',
  JSON.stringify([
    { name: 'researcher', role: 'gather facts',     model: 'gpt-5' },
    { name: 'critic',     role: 'find weaknesses',  model: 'claude-opus-4-7' },
    { name: 'writer',     role: 'compose summary',  model: 'claude-sonnet-4-6' },
  ]),
  'Should we move the deploy step before the test step?',
  null,   // synthesizer
);
```

> **Mode strings differ across surfaces.** Rust enum is `Parallel | Sequential | Debate`; JS/WS accept `'parallel' | 'sequential' | 'hybrid'`, where **`'hybrid'` maps to the Debate semantics**.

#### Pipeline

`Pipeline::new(stages: Vec<AgentSpec>).run(task, runner, infra)` — implemented as a Sequential Swarm; `final_answer` is the last stage's answer if it succeeded. Helper `all_succeeded()`.

```typescript
await runPipeline(
  JSON.stringify([
    { name: 'gather', role: 'collect requirements', model: 'gpt-5' },
    { name: 'design', role: 'propose architecture', model: 'claude-opus-4-7' },
  ]),
  'Build a deduplication pipeline for our event stream.',
);
```

#### Supervisor

`Supervisor::new(workers, supervisor_spec).with_max_rounds(n)` (default 3). Each round: workers run as a Parallel Swarm; the supervisor reviews a summary. If the reply (uppercased) contains `APPROVED`, it stops and strips the `APPROVED` prefix into `final_answer` (`approved = true`). Otherwise the supervisor's feedback is appended to the task for the next round. On max rounds: `final_answer = "[max supervision rounds reached] <last feedback>"`. Helper `total_rounds()`.

```typescript
await runSupervisor(
  JSON.stringify([{ name: 'coder', role: 'implement', model: 'claude-opus-4-7' }]),
  JSON.stringify({ name: 'lead', role: 'pm', model: 'gpt-5' }),
  'Implement and verify a binary search.',
  3, // max_rounds
);
```

> **Approval detection is an uppercased substring match for `APPROVED` anywhere in the reply**, then the prefix (`APPROVED:`/`.`/newline/space) is stripped. Phrase supervisor prompts so the literal word `APPROVED` only appears when it truly approves.

#### MapReduce

`MapReduce::new(mapper, reducer).with_max_concurrent(n)` (default 5). `run(task, items: &[String], runner, infra)` clones the mapper per item (renamed `<mapper>_<i>`), bounds concurrency with a `tokio::Semaphore` via a `JoinSet`, and **re-sorts results by original item index** (preserved even when a mapper panics). The reduce phase passes succeeded summaries to the reducer. Dropping the run future aborts in-flight mapper tasks. Helper `all_succeeded()`.

```typescript
await runMapReduce(
  JSON.stringify({ name: 'classifier', role: 'label',           model: 'claude-haiku-4-5' }),
  JSON.stringify({ name: 'aggregator', role: 'summarize labels', model: 'claude-sonnet-4-6' }),
  'Label these support tickets by category.',
  JSON.stringify(['ticket A...', 'ticket B...', 'ticket C...']),
);
```

#### Vote

`Vote::new(agents).with_synthesizer(spec)`. All agents answer via a Parallel Swarm. With a synthesizer it picks/merges (`agreement_ratio = 1.0`). Without one, simple majority: answers are normalized (trim + lowercase), the most common wins, and `agreement_ratio = count / total`.

```typescript
await runVote(
  JSON.stringify([{ name: 'a', model: 'gpt-5' }, { name: 'b', model: 'claude-opus-4-7' }]),
  'Will this migration corrupt existing rows?',
  JSON.stringify({ name: 'judge', role: 'pick winner', model: 'gpt-5' }), // or null for majority
);
```

> **Majority voting is exact normalized-string match (trim + lowercase) — no semantic clustering.** Paraphrased-but-equivalent answers split the vote. Provide a synthesizer for open-ended questions.

#### Delegator

`Delegator::new(main, specialists: HashMap<String,AgentSpec>)`. Registers a `delegate` tool on the main agent's runtime backed by a `DelegatingExecutor`. When the main agent calls `delegate({ specialist, subtask })`, that specialist is spawned (sharing infra state/log/policies), its answer becomes the tool result, and a `DelegationRecord { specialist, subtask, result, success }` is recorded. **An unknown specialist does NOT error** — it returns an "available specialists" message as the tool result with `success = false`.

#### Fleet

`Fleet::new(agents).with_timeout(secs)`. Agents work on **different** problems concurrently (each reads its task from `metadata['task']`), with no ordering and no review loop, sharing state/event-log/policies and registered on the Mailbox. A per-agent timeout produces a synthetic `'timeout'` `AgentOutput`. (Maps to Hydra's "heads" concept.)

#### AdversarialReview

`AdversarialReview::new(reviewer, criteria: Vec<String>)` with `fail_on_blockers = true`. The reviewer is **always a fresh agent given only the work output + acceptance criteria (no author context)**. It is prompted for strict JSON `{ passed, findings:[{ criterion, passed, evidence, severity }] }`, where `severity = blocker | major | minor | info`. `passed` (when `fail_on_blockers`) = zero blockers AND no failing `major`. JSON is parsed via `car_ir::json_extract::extract_json_object` with a single-finding fallback whose pass depends on the word `pass` appearing.

#### NAPI / Rust / WebSocket signatures

```
// NAPI (JS) — register once, then call any of these (they reuse the stored runner):
registerAgentRunner(agentFn: (specJson, taskJson) => Promise<string>): Promise<void>
runSwarm(mode: string, agents: string, task: string, synthesizerSpec?: string|null): Promise<string>
runPipeline(stages: string, task: string): Promise<string>
runSupervisor(workers: string, supervisor: string, task: string, maxRounds: number): Promise<string>
runMapReduce(mapper: string, reducer: string, task: string, items: string): Promise<string>
runVote(agents: string, task: string, synthesizerSpec?: string|null): Promise<string>
```

```
// WebSocket JSON-RPC
multi.swarm       { mode:'parallel'|'sequential'|'hybrid', agents:AgentSpec[], task, synthesizer? }
multi.pipeline    { stages:AgentSpec[], task }
multi.supervisor  { workers:AgentSpec[], supervisor:AgentSpec, task, max_rounds?=3 }
multi.map_reduce  { mapper:AgentSpec, reducer:AgentSpec, items:string[], task }
multi.vote        { agents:AgentSpec[], task, synthesizer? }
// server -> client callback (you run the model loop, reply with AgentOutput JSON keyed by request id):
multi.run_agent   { params: { spec, task } }
```

`MultiError = AgentFailed(name,msg) | MailboxSend | MailboxTimeout | UnknownSpecialist | NoOutput | MaxRoundsExceeded`.

> **`.d.ts` vs. cookbook arity mismatch.** The official `index.d.ts` declares `runSwarm(mode, agents, task, synthesizerSpec?)` (4 params) and `runVote(agents, task, synthesizerSpec?)` (3 params), but the cookbook/example pass an extra trailing `null` agent_fn (meaning "use the stored runner"). **Trust the `.d.ts` arity** — the trailing `null` is tolerated/legacy.

For Rust consumers, `car-multi` re-exports the built-in commodity agents and coordinator from `car-agents` (car#205): `Coordinator`, `PlannerAgent`, `Researcher`, `Summarizer`, `Verifier`, and `coordinator::{CoordinationPlan, Pattern}`.

---

### Declarative workflows (`car-workflow`)

Where `car-multi` runs one pattern, `car-workflow` (`car-rs/crates/car-workflow/`) wires **many** stages into a named graph with conditional edges and saga compensation. A `Workflow` is serde-serializable JSON, so it round-trips identically across NAPI, PyO3, and JSON-RPC.

#### Workflow / Stage / Edge shape

```
Workflow {
  id, name,
  start: <entry stage id>,
  stages: Vec<Stage>,
  edges: Vec<Edge>,
  max_iterations: u32 = 100,   // hard loop guard
  metadata
}
```

A **`Stage`** has `id`, `name`, `step: StageStep`, optional `compensation: CompensationHandler`, optional `timeout_ms`, and `metadata`. `StageStep` is an internally-tagged enum (`tag="type"`, snake_case) with three variants:

- **`pattern`** (`PatternStep`) — runs a `car-multi` coordination pattern.
- **`proposal`** (`ProposalStep`) — runs a single `car_ir::ActionProposal` through `car-engine`.
- **`sub_workflow`** (`SubWorkflowStep`) — runs a nested `Box<Workflow>`.

**`PatternStep` = `{ pattern: PatternKind, task, agents: Vec<AgentSpec>, config: HashMap }`.** `PatternKind` (snake_case): `swarm_parallel`, `swarm_sequential`, `swarm_debate`, `pipeline`, `supervisor`, `delegator`, `map_reduce`, `vote`, `fleet`. Config keys per pattern:

| Pattern | Config keys |
|---------|-------------|
| `supervisor` | `max_rounds` (default 3), `supervisor_index` (default = last agent) |
| `map_reduce` | `max_concurrent` (default 5), `items: [..]`; **requires ≥2 agents** (`agent[0]`=mapper, `agent[1]`=reducer) |
| `fleet` | `timeout_secs` |
| `swarm`/`vote` | `synthesizer_index` |
| `delegator` | `agent[0]`=main, rest=specialists keyed by name |

```json
{
  "id": "review-deploy",
  "name": "Review and Deploy",
  "start": "review",
  "stages": [
    { "id": "review", "name": "Code Review", "step": { "type": "pattern", "...": "..." } },
    { "id": "deploy", "name": "Deploy",      "step": { "type": "proposal", "...": "..." } }
  ],
  "edges": [
    { "from": "review", "to": "deploy",
      "conditions": [{ "key": "stage.review.succeeded", "operator": "eq", "value": true }] }
  ]
}
```

#### State keys and conditional edges

After each stage the engine writes:

```rust
wf_state.insert(format!("stage.{}.succeeded", stage.id), Value::Bool(true));
wf_state.insert(format!("stage.{}.answer",    stage.id), Value::String(answer));
// on failure:
wf_state.insert(format!("stage.{}.succeeded", stage.id), Value::Bool(false));
wf_state.insert(format!("stage.{}.error",     stage.id), Value::String(error_msg));
```

Proposal stages additionally merge each `ActionResult.state_changes` into top-level state keys, so later edges can branch on what the proposal did.

An **`Edge`** is `{ from, to, conditions: Vec<car_ir::Precondition>, label }`. **ALL conditions must pass (AND)**; an empty `conditions` array is unconditional (always-true). Conditions are evaluated against accumulated workflow state after the `from` stage completes; the engine takes the **first** outgoing edge whose conditions pass. A stage with **no matching outgoing edge is terminal** and the workflow returns `Completed`.

`Precondition` shape is `{ key, operator, value, description }`. Operators: `exists`, `not_exists`, `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains` (numeric via `as_f64`, else string compare; `contains` is substring). A **missing key fails every operator except `exists`/`not_exists`**.

> **Edge ordering gotchas.** (1) Order matters — put a catch-all (empty conditions) edge **last**; an early empty-conditions edge shadows later conditional ones. (2) A typo in an edge `from`/`to` silently ends the run early (the orphaned stage becomes terminal) — `verify_workflow` flags this, so verify first. (3) Referencing `stage.X.answer` before stage X runs just fails the edge silently (missing-key rule).

#### Saga compensation (rollback)

On a stage failure, the engine runs compensation for **already-completed stages in REVERSE order**. `CompensationHandler` (tag=`type`, snake_case) is either `proposal` (runs a `ProposalStep` to undo) or `stage_ref { stage_id }` (re-executes another stage's step). Terminal `WorkflowStatus`:

| Status | Meaning |
|--------|---------|
| `Completed` | reached a terminal stage successfully |
| `Failed` | a stage failed and **no** compensation ran |
| `Compensated` | all compensations succeeded |
| `PartiallyCompensated` | some compensations failed |

`WorkflowResult { workflow_id, workflow_name, status, stages: Vec<StageResult>, compensations: Vec<CompensationResult>, duration_ms, timestamp, final_state }`; `.succeeded()` is `status == Completed`. `StageStatus = Succeeded | Failed | Skipped | Compensated`. `WorkflowError = StageFailed | EdgeConditionFailed | CompensationFailed | VerificationFailed | StageNotFound | NoStartStage | Agent(MultiError) | CycleLimitReached(u32) | Timeout(String,u64)`.

> **`max_iterations` (default 100) is a hard loop guard.** Exceeding it returns `WorkflowError::CycleLimitReached`, not a successful result. Cyclic workflows MUST set/respect it.

#### Static verification before running

`verify_workflow(&Workflow) -> WorkflowVerifyResult { valid, issues: Vec<WorkflowIssue{severity, stage_id, message}>, reachable_stages, unreachable_stages, has_cycles }`. Checks, in order: (1) start exists *[error]*, (2) every edge `from`/`to` references a valid stage *[error]*, (3) compensation `StageRef` valid *[error]*, (4) BFS reachability from start *[unreachable = warning]*, (5) DFS cycle detection *[warning]*, (6) recurse into sub-workflows, (7) `car_verify::verify` each proposal stage *[errors only]*. **`valid` = no error-severity issues**; cycles and unreachable stages are warnings (still `valid`). Treat `valid = false` as a hard stop.

> **`WorkflowVerifyResult` is intentionally NOT serde-derived.** The FFI/WS layer serializes issues with `Debug` formatting (`format!("{:?}", i)`), so the `issues` array in the JSON report is **debug strings, not structured objects**:

```rust
serde_json::json!({
    "valid": report.valid,
    "has_cycles": report.has_cycles,
    "reachable_stages": report.reachable_stages,
    "unreachable_stages": report.unreachable_stages,
    "issues": report.issues.iter().map(|i| format!("{:?}", i)).collect::<Vec<_>>(),
})
```

#### Running a workflow

```rust
let workflow: Workflow = serde_json::from_str(workflow_json)?;
let infra = SharedInfra::new();
let engine = WorkflowEngine::new(runner, infra);   // WorkflowEngine::new(Arc<dyn AgentRunner>, SharedInfra)
let result = engine.run(&workflow).await?;
serde_json::to_string(&result)
```

| Surface | Run | Verify |
|---------|-----|--------|
| NAPI (Node) | `runWorkflow(workflowJson): Promise<string>` | `verifyWorkflow(workflowJson): string` |
| PyO3 (Python) | `run_workflow(workflow_json: str) -> str` | `verify_workflow(workflow_json: str) -> str` |
| JSON-RPC | `workflow.run { workflow: {...} }` | `workflow.verify { workflow: {...} }` |

To branch only when a stage succeeded:

```json
{ "from": "review", "to": "deploy",
  "conditions": [{ "key": "stage.review.succeeded", "operator": "eq", "value": true }],
  "label": "on success" }
```

> **`map_reduce` pattern stages require ≥2 agents** (`agent[0]`=mapper, `agent[1]`=reducer) or the stage fails with `StageFailed`; `supervisor` defaults to the **last** agent as supervisor unless `config.supervisor_index` is set.

---

### Scheduling & background tasks (`car-scheduler`)

`car-scheduler` (`car-rs/crates/car-scheduler/`) manages persistent `Task` definitions (prompt + trigger + schedule) and an `Executor` that runs them once, in a loop, or in the background.

#### Task definition

`Task { id (uuid first 10 chars), name, prompt, trigger: TaskTrigger, schedule, watch_path, agent_metadata, max_turns (default 10), system_prompt, status, created_at, last_run_at, run_count, executions: Vec<TaskExecution>, enabled }`. Builder: `Task::new(name, prompt).with_trigger(trigger, schedule).with_file_watch(path).with_system_prompt(p).with_metadata(k, v)`.

**`TaskTrigger`** (snake_case): `once` (run immediately once), `cron`, `interval` (every N seconds), `file_watch` (polls file hash every 2s, runs on change), `manual` (only explicit run). **A new Task defaults to `Manual`.**

> **`TaskTrigger::Cron` is NOT actually cron-parsed.** `Executor::run_loop` treats `Cron` identically to `Interval` (full cron parsing is explicitly out of scope). Use the schedule string as an interval (`'5m'`, `'1h'`).

`parse_interval(schedule: &str) -> f64` (seconds) is suffix-based: `'m'`=minutes×60, `'h'`=hours×3600, `'s'`/bare number=seconds; defaults to `60.0` on parse failure. Examples: `'30'`→30, `'5m'`→300, `'1h'`→3600, `'10s'`→10.

`TaskExecution { execution_id, started_at, finished_at, status, answer, error, duration_ms }`. `TaskStatus = Pending | Running | Completed | Failed | Scheduled | Disabled`.

#### Executor and persistence

`Executor::new(runner)` or `Executor::with_shared_infra(runner, infra)`:

- `run_once(&mut task) -> TaskExecution` — sets status `Running`, builds an `AgentSpec` from the task, runs via the `AgentRunner`, records the execution, increments `run_count`, sets `last_run_at`.
- `run_loop(&mut task, max_iterations: Option<u32>, cancel: watch::Receiver<bool>) -> Vec<TaskExecution>` — dispatches by trigger; interval and file-watch loops check `cancel` in a `tokio::select!` between runs.

**`TaskStore`** (one JSON file per task): `TaskStore::new(dir)`, `TaskStore::default_path()` = `~/.car/tasks` (HOME, then USERPROFILE, then `/tmp` fallback), `.save(&Task) -> Result<PathBuf>`, `.load(task_id) -> Option<Task>`, `.list() -> Vec<Task>` (sorted by `created_at`), `.delete(task_id) -> bool`.

```rust
let task = Task::new("deploy_check", "Check if deployment is healthy")
    .with_trigger(TaskTrigger::Interval, "5m")
    .with_system_prompt("You are a deployment monitor.");
let store = TaskStore::new(Path::new("/tmp/tasks"));
store.save(&task)?;
let handle = spawn_task(task, runner, None);
handle.cancel();
```

`spawn_task(task, runner, max_iterations)` and `spawn_task_shared(task, runner, infra, max_iterations)` spawn a background tokio task and return `TaskHandle { task_id, cancel_tx: watch::Sender<bool>, join: JoinHandle<Vec<TaskExecution>> }`; `TaskHandle::cancel()` sends `true` on the watch channel to stop the loop.

| Surface | Create | Run once | Run loop |
|---------|--------|----------|----------|
| NAPI | `createTask(name, prompt, trigger?, schedule?, systemPrompt?) -> string` | `runTask(taskJson): Promise<string>` | `runTaskLoop(taskJson, maxIterations?): Promise<string>` |
| PyO3 | `create_task(name, prompt, trigger=None, schedule=None, system_prompt=None) -> str` | `run_task(task_json, agent_fn=None) -> str` | `run_task_loop(task_json, agent_fn=None, max_iterations=None) -> str` |
| JSON-RPC | `scheduler.create { name, prompt, trigger?, schedule?, system_prompt? }` | `scheduler.run { task }` | `scheduler.run_loop { task, max_iterations? }` |

> **`run_loop` with `Interval` and schedule `'0'` runs back-to-back with zero delay** (used in tests, but hot-loops in production). Always set a real interval and/or `max_iterations`.

> **`TaskStore::default_path` falls back to `/tmp`** when neither HOME nor USERPROFILE is set (some systemd units, Windows without HOME), silently losing state across runs (the #231 fix addressed this).

#### The "dream" loop — periodic memory consolidation

The dream loop runs `MemgineEngine` consolidation on a timer. It is **purely algorithmic — no LLM** — and so does not need a registered runner.

`spawn_dream_loop(memgine: Arc<Mutex<MemgineEngine>>, config: DreamConfig, max_iterations: Option<u32>) -> DreamHandle`. `DreamConfig { interval_secs (default 3600), embeddings_path, trajectory_dir, outcome_profiles_path }`. Each pass calls `engine.consolidate_with_data(trajectories, model_profiles)`. `DreamHandle::cancel()` stops it; `join` yields `Vec<ConsolidationReport>`.

To register the consolidation work as a persistent scheduled task instead, use `ensure_dream_task(store: &TaskStore) -> bool` — idempotently creates a Task named **`car-dream`** (`DREAM_TASK_NAME`) with prompt `"memory.consolidate"` on an `Interval` trigger of `'1h'`. Returns `true` if newly created, `false` if one already exists. Exposed as NAPI `ensureDreamTask() -> boolean` / PyO3 `ensure_dream_task() -> bool`.

```rust
pub const DREAM_TASK_NAME: &str = "car-dream";
let task = Task::new(DREAM_TASK_NAME, "memory.consolidate")
    .with_trigger(TaskTrigger::Interval, "1h");
```

> **The dream loop coalesces concurrent runners via a lock file** (`.dream.lock` in `trajectory_dir`, else `/tmp/.tokhn-dream.lock`): if another loop touched it within `interval_secs/2` the current cycle is skipped. It also performs a "trailing" extra pass after `max_iterations` if the last pass did real work.

---

### Cross-cutting gotchas checklist

- **Runner first, always.** No `AgentRunner` (Rust) / `registerAgentRunner` (Node/Python) means no model loop for any pattern, workflow agent stage, or scheduled agent task. The runner reads `spec.model` / `metadata['model']` — CAR never picks the model.
- **Daemon first (v0.8+).** Start `car-server`; `multi.*` / `workflow.*` / `scheduler.*` dispatch agent runs back to your client via `multi.run_agent`. No daemon, no callback target.
- **One stored runner.** `registerAgentRunner` stores exactly one callback globally; every `run_*` reuses it (NAPI: only 3 standalone fns may take a `ThreadsafeFunction`).
- **Mode/return-shape drift:** JS swarm modes are `parallel`/`sequential`/`hybrid` (`hybrid`→Debate); JS runner returns `response` not `answer`.
- **Trust the `.d.ts` arity** over the cookbook's trailing `null` agent_fn.
- **Workflow edges:** first-passing edge wins, empty conditions = always-true (place catch-alls last), missing keys fail all operators except `exists`/`not_exists`, unmatched outgoing edge = terminal `Completed`. `verify_workflow` first — and remember its `issues` come out as Debug strings over FFI/WS.
- **`max_iterations`** is a hard guard on workflows (default 100, `CycleLimitReached` on overflow) and a sanity bound on `run_loop`.
- **Scheduler quirks:** `Cron` == `Interval`; `FileWatch` is 2s polling on a content hash (not inotify); `default_path` can fall back to `/tmp`.

#### File map

| Concern | Path |
|---------|------|
| Patterns, runner, shared infra, mailbox | `car-rs/crates/car-multi/src/` (`patterns/`, `runner.rs`, `shared.rs`, `mailbox.rs`, `task_context.rs`) |
| Workflow engine, types, verify | `car-rs/crates/car-workflow/src/` (`engine.rs`, `types.rs`, `verify.rs`, `result.rs`) |
| Scheduler, tasks, dream | `car-rs/crates/car-scheduler/src/` (`task.rs`, `executor.rs`, `dream.rs`) |
| FFI bridges | `car-rs/crates/car-ffi-common/src/{workflow,scheduler}.rs`, `car-ffi-napi/src/lib.rs` + `npm/index.d.ts`, `car-ffi-pyo3/car_runtime.pyi` |
| JSON-RPC dispatch | `car-rs/crates/car-server-core/src/handler.rs` |
| Docs / examples | `docs/cookbook/04-multi-agent.md`, `docs/websocket-protocol.md`, `car-rs/examples/multi-agent-swarm/` |

---

## WebSocket Server & JSON-RPC Protocol

Since v0.8.0, the WebSocket server **is** CAR. There is no longer an "embedded" mode you can quietly fall back to from a single process — the Node.js (NAPI) and Python (PyO3) bindings are thin clients. The singleton `car-server` daemon owns the runtime: per-connection state, tools, policies, memory, inference, and OS integrations. An agent author's first and non-negotiable obligation is to **start the daemon, then point a client at it**. Everything downstream — install, auth, error handling, even *which methods exist at all* — flows from that one fact. Inference streaming is a direct WebSocket method; the legacy NAPI/Python streaming exports always error rather than proxying callbacks.

The protocol is **JSON-RPC 2.0 over a WebSocket** (or a Unix domain socket — the default FFI transport on `cfg(unix)`; Windows binds loopback TCP only). The standalone binary listens on `ws://127.0.0.1:9100/` by default. The core dispatcher lives in `car-rs/crates/car-server-core/src/handler.rs` (`run_dispatch`), with companion modules `session.rs` (sessions, tool callbacks, approval gate) and `host.rs` (host event surface). The hand-maintained reference is `docs/websocket-protocol.md`; when the doc and the Rust dispatcher disagree, **the dispatcher wins**.

### Sibling endpoints on the same daemon

| Surface | Default | Purpose |
|---|---|---|
| WebSocket JSON-RPC | `ws://127.0.0.1:9100/` | The runtime entry point (this section) |
| HTTP dashboard | `:9101` | Browser UI |
| MCP HTTP-streamable | `127.0.0.1:9102/mcp` | Model Context Protocol endpoint (`--mcp-bind`, `CAR_MCP_BIND`; `disabled` to skip) |
| A2A HTTP+SSE | (opt-in) | Agent2Agent streaming peers (`--a2a-bind`) |
| Unix domain socket | per-platform | Default FFI thin-client transport (`handle_connection_unix`, `cfg(unix)` only) |

### Wire shape

Every frame is JSON. A request carries a `method`, `params`, and an `id`; responses are matched **by `id`, not by arrival order** (id-keyed demuxing). Notifications have no `id`.

```json
// request
{"jsonrpc": "2.0", "method": "memory.add_fact", "params": {"subject": "x", "body": "y", "kind": "pattern"}, "id": 1}
// success response
{"jsonrpc": "2.0", "result": 1, "id": 1}
// error response
{"jsonrpc": "2.0", "error": {"code": -32603, "message": "..."}, "id": 1}
```

The dispatcher routes ~188 method literals across 50+ namespaces (`session.*`, `state.*`, `memory.*`, `proposal.*`, `multi.*`, `workflow.*`, `models.*`, `voice.*`, `agents.*`, `host.*`, `a2a.*`, `a2ui.*`, `registry.*`, plus bare `verify`/`infer`/`embed`, and the macOS OS-integration namespaces).

#### Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error |
| `-32600` | Invalid Request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32004` | Handler deadline exceeded; the operation may have committed, so consult the method's authoritative read before retrying |
| `-32000` | Tool error (used when a client rejects a `tools.execute` callback) |
| `-32001` | Auth required (also closes the connection) |
| `-32003` | Approval denied / timeout |

> **Gotcha:** Unknown methods do **not** return the standard `-32601`. They hit a `_ =>` fallback arm and return the string message `"unknown method: <name>"`. Parse errors return `-32700`.

### Connection lifecycle & the per-connection session model

Each WebSocket connection is its own session. The runtime, registered tools, policies, and memgine are **per-connection and do not survive disconnect** — there is no implicit shared global state between two connections (except where you explicitly opt in: tenant scoping, lifecycle-agent identity, or a shared embedder). `run_dispatch` builds, per connection: a 12-char `client_id`, a `WsChannel` (a write `Mutex`, a pending-oneshot map, and a `next_id` `AtomicU64`), and a `ClientSession` via `state.create_session`. That session gets its own `Runtime` with an event log at `<journal_dir>/<client_id>.jsonl` and a `WsToolExecutor`. The first method that needs runtime state lazily creates an empty session if `session.init` was never called.

On disconnect, `remove_session` runs a single cleanup path: it drops the session, **drains all pending tool callback oneshots** (so any in-flight `WsToolExecutor::execute` returns immediately as "callback channel closed"), drops `agent_id` bindings and in-flight `agents.chat` sessions, removes a2ui subscribers, and reaps session-scoped host approvals. Abrupt client drops therefore cancel running proposals fast — by design.

> **Ordering constraint:** per-method dispatch is **spawned into a per-connection `JoinSet`** so the read loop keeps consuming frames during a callback. This is the fix for the `tools.execute` deadlock (car#173) — without it, a server-initiated callback would block the very read loop that must deliver the client's reply.

### Authentication: the mandatory first frame

Auth is **ON by default since 2026-05**. When a token is installed, the **first frame on every connection must be `session.auth`**. Any other method on an unauthenticated session returns `-32001` and **closes the connection**.

```json
// First frame on every WS connection:
{"jsonrpc":"2.0","id":0,"method":"session.auth","params":{"token":"<43 chars>"}}
// Server responds:
{"jsonrpc":"2.0","id":0,"result":{"ok": true, "auth_enabled": true}}
// Await auth success, then negotiate this connection's exact protocol:
{"jsonrpc":"2.0","id":1,"method":"server.handshake","params":{"protocol_version":3,"required_capabilities":["infer.model-identity.v1","models.catalog-identity.v1"],"optional_capabilities":[]}}
// Subsequent calls work normally:
{"jsonrpc":"2.0","id":2,"method":"infer","params":{...}}
```

Protocol v3 is fail-closed and negotiates immutable model identity. `host.subscribe` and every
`auth.*` method return `-32005` until this WebSocket has completed an exact
`server.handshake`; a missing, malformed, or different version returns
`-32006`; an unsupported mandatory capability returns `-32008`. The negotiation is per connection, so reconnects repeat it. Because
request dispatch is concurrent, never pipeline the protocol request behind
`session.auth`: await auth success first, then await handshake success, then
subscribe or start a browser sign-in.

The daemon mints a fresh 32-byte token (43-char base64url) at startup, writes it `0600` to a per-platform well-known path, and removes it on graceful shutdown. Comparison is **constant-time** (`constant_time_eq`). CarHost.app mints the token and passes `--auth-token` to the daemon.

| Platform | Token path |
|---|---|
| macOS | `~/Library/Application Support/ai.parslee.car/auth-token` |
| Linux | `$XDG_RUNTIME_DIR/ai.parslee.car/auth-token` |
| Windows | `%LOCALAPPDATA%\ai.parslee.car\auth-token` |

**Precedence:** `$CAR_AUTH_TOKEN` (env) > file > none. Set `CAR_AUTH_TOKEN` (alongside `CAR_DAEMON_URL`) for cross-host clients. When no token is installed (`--no-auth` / `CAR_NO_AUTH=1`), `session.auth` is a polite no-op success and returns `{ok: true, auth_enabled: false}`, reverting to the legacy "any local caller" posture.

```json
{"jsonrpc":"2.0","id":0,"method":"session.auth","params":{"token":"<43 chars>"}} → {"ok": true, "auth_enabled": true}
```

**Lifecycle-agent identity binding.** Passing `agent_id` to `session.auth` validates against the **per-agent token the supervisor minted at `agents.upsert`** (not the daemon-wide token), binds the connection to that agent identity (a second connection with the same `agent_id` is rejected — single-claim), and attaches a **daemon-owned persistent memgine** keyed on the id, lazy-loaded from `~/.car/memory/agents/<id>.json` and retained across restarts. SDKs read `CAR_AGENT_ID` / `CAR_AGENT_TOKEN` from env. Memory ops then route through `effective_memgine()`: a bound connection uses the persistent per-agent engine; unbound (browser/host/CLI) connections use an ephemeral per-WS memgine lost on disconnect.

There is also a Parslee-backend OAuth2 PKCE flow (shared with the `car auth login parslee` CLI): `auth.start {redirect_uri, ...}` returns a random `attempt_id`; `auth.complete {code, verifier, attempt_id, ...}` stores tokens and returns an attempt-bound credential-generation proof; `auth.completion_status {attempt_id}` reconciles a lost reply without replaying the one-time code; `auth.snapshot` gives a local, non-refreshing baseline; and `auth.status` / `auth.logout` manage the live session. `parslee.auth` bridges local daemon auth to a Parslee bearer token (`{authenticated, token_type:Bearer, access_token, authorization_header, identity}`). OpenRouter uses a separate daemon-owned flow: `openrouter.auth_start {}` returns `{authority_generation, authorize_url, flow_id, deadline_unix_ms}`, `openrouter.status` returns the same non-secret authority generation, `openrouter.auth_cancel` cancels, and `openrouter.disconnect` removes only OAuth. Every authenticated WebSocket connection receives daemon-wide `openrouter.auth.event` status snapshots. Hosts retain the highest `authority_generation`, reject delayed lower-generation replies/events before flow correlation, and keep exact-flow plus terminal-monotonic checks within one generation. Local contract tests may launch the daemon with `CAR_OPENROUTER_TEST_MODE=1` and set `OPENROUTER_AUTHORIZATION_BASE_URL` plus `OPENROUTER_EXCHANGE_URL`, allowing the unchanged native `openrouter.auth_start {}` action to drive a local OAuth double. Those endpoint environment values are ignored outside explicit test mode.

### The high-risk approval gate

Independent of auth, a second gate wraps a **fixed set of high-risk methods** in a per-call approval handshake (`ApprovalGate`, `session.rs`):

```
automation.run_applescript
automation.shortcuts.run
messages.send
mail.send
vision.ocr
```

Before dispatch, `gate_high_risk_method` creates an approval (via `host.create_approval`), broadcasts an `approval.requested` host event, and **parks up to 60s** for the user to call `host.resolve_approval`. On deny or timeout the caller receives `-32003` and the loop continues (no connection close). This gate is **WS-only** — in-process FFI consumers skip it entirely. Disable with `--no-approvals` / `CAR_NO_APPROVALS=1` (`ApprovalGate::disabled()`).

> This is one of four distinct safety layers an author composes: **capabilities** (allow-list what an agent CAN touch), **policies** (deny rules per action, registered via `policy.register`), **inspectors** (hot-path dispatch-time guardrails), and **this approval gate** (high-risk OS actions park until a human approves). Deny wins; the first deny short-circuits.

### Registering tools and policies

`session.init` is an **optional second frame** for declaring tools and policies in a batch. It registers onto this connection's runtime and returns `{session_id, tools_registered, policies_registered}`.

```json
{"jsonrpc":"2.0","id":1,"method":"session.init","params":{
  "tools":   [{"name":"shell","description":"run a shell command","parameters":{...}}],
  "policies":[{"name":"no_rm","rule":"deny_tool_param","target":"shell","key":"command","pattern":"rm -rf"}]
}}
```

`tools.register` does the same for tools alone — but it takes an **ARRAY of `ToolDefinition` directly**, not an object. (`session.init` wraps the array as `{tools:[...]}`; `tools.register` is the bare `[...]`.)

A `ToolDefinition` carries `{name, description?, parameters?, returns?, idempotent?, cache_ttl_secs?, rate_limit?:{max_calls, interval_secs}}` and is translated into a `car_ir::ToolSchema` on the session runtime.

`policy.register` accepts a `PolicyDefinition {name, rule, target?, key?, pattern?, value?, session_id?}`. **Supported rules on the daemon:** `deny_tool`, `deny_tool_param`, `require_state`.

> **Gotcha:** **Callback policy rules (`deny_tool_callback`) are NOT supported on the daemon** — only the three above. The FFI binding must route callback rules through Embedded mode. `session.policy.open` / `session.policy.close {session_id}` scope policies to a sub-context.

### Bidirectional tool callbacks — the inversion you must handle

**CAR does not own tools.** When a `proposal.submit`, `workflow.run`, or `multi.*` execution reaches a `tool_call` action, the server sends a **server-initiated `tools.execute` request back to the client** and blocks on a oneshot until the client replies on the matching `id`.

Mechanically (`WsToolExecutor::execute_with_action`, `session.rs`): the executor mints a `request_id` of the form `cb-<n>`, inserts a oneshot sender keyed by it, sends the callback, and awaits with a **hard 60s timeout**.

```json
// server → client (request)
{"jsonrpc":"2.0","method":"tools.execute","params":{"action_id":"cb-1","tool":"search","parameters":{...},"attempt":1},"id":"cb-1"}
// client → server (response) — MUST reuse the server's id
{"jsonrpc":"2.0","id":"cb-1","result":{"hits":[...]}}
// or signal tool failure with an error object
{"jsonrpc":"2.0","id":"cb-1","error":{"code":-32000,"message":"tool unavailable"}}
```

The `ToolExecuteRequest` params are `{action_id, tool, parameters, timeout_ms, attempt}`. **Two distinct ids are in play and they are intentionally different:**

| Identifier | Where | Role |
|---|---|---|
| JSON-RPC `id` (`cb-<n>`) | top-level frame | daemon-side callback routing key — **reply on this** |
| `action_id` (params field) | inside `params` | host-side proposal `Action.id` |

> **Critical client-loop rule:** After `proposal.submit`, **do not assume the next frame is your answer.** Loop on receive; if `msg.method == "tools.execute"`, run the tool and reply on `msg.id`; when a frame's `id` equals your proposal request id, that is the final result. Miss the 60s window and the server reports `tool '<name>' callback timed out (60s)`.

`multi.run_agent` is the same inversion for delegating per-agent inference during `multi.*` and `workflow.run`. Rust clients register handlers via `car_ffi_common::proxy::DaemonClient::register_handler(method, handler)` (`car-ffi-common/src/proxy.rs`).

### Server-pushed notifications

Notifications have no `id`. A naive call-and-wait client that ignores frames lacking its id will **silently drop these**. Rust clients subscribe via `register_notification_handler(method, handler)` — **single-subscriber-per-method by design**.

| Notification | Emitted | Requires |
|---|---|---|
| `host.event` | agent lifecycle, status changes, approvals | `host.subscribe` first |
| `voice.event` | transcript / TTS during meeting/voice sessions | active voice session |
| `inference.stream.event` | token deltas during `infer_stream` | active stream |
| `inference.runner.invoke` | delegated-inference dispatch to the runner host | `inference.register_runner` |
| `a2ui.event` | surface updated/deleted | `a2ui/subscribe` |
| `models.pull_progress` | model download lifecycle | subscribed UI client |
| `models.upgrade_available` | upgrade finding | subscribed UI client |
| `tools.execute` | (a request, but server-initiated) | active proposal |

```json
// host.event shape
{"jsonrpc":"2.0","method":"host.event","params":{
  "id":"event-...","timestamp":"2026-04-25T13:00:00Z","kind":"agent.status_changed",
  "agent_id":"researcher-1","message":"Researcher completed","payload":{}}}
// kind values: agent.registered, agent.unregistered, agent.status_changed,
//              approval.requested, approval.resolved, host.notification
```

### Inference admission control

All inference RPCs (`infer`, `infer_stream`, `embed`, `classify`, `voice.transcribe_stream.*`, `image.generate`, `video.generate`) pass through a **process-wide tokio semaphore** (`admission.rs::InferenceAdmission`). Permits are auto-sized from host RAM (~1 per 8GB, floor 1, ceiling 8) unless `CAR_INFERENCE_MAX_CONCURRENT` overrides (set `1` for full serialization). A permit is held for the **whole call** — streaming RPCs hold it for the entire stream. Inspect capacity with `admission.status` → `{permits_total, permits_available, permits_in_use, env_override}`.

### Method surface (selected, by namespace)

The dispatcher exposes 73+ documented methods. The author-relevant core:

**Session / auth** — `session.auth {token, agent_id?}`, `session.init {tools, policies?}`, `session.policy.open` / `session.policy.close`, `tools.register [ToolDefinition]`, `auth.start`/`auth.complete`/`auth.completion_status`/`auth.snapshot`/`auth.status`/`auth.logout`, `parslee.auth`.

**Execution & verification** — `proposal.submit {proposal, session_id?, scope?}` → `ExecutionResult {final_state, outputs, errors}`; `verify {proposal, initial_state?}` → `{valid, issues:VerifyIssue[], simulated_state}` (pure static analysis — **no `tools.execute` callbacks fire**, 30s timeout); plus the verify family `simulate` / `optimize` / `equivalent`; `replan.set_config {max_replans, delay_ms, verify_before_execute}`; `outcomes.resolve_pending {actionResults:[[traceId,success,confidence,output]]}` → `{recorded}`; `events.count` / `events.stats` / `events.truncate` / `events.clear`.

> `proposal.submit` accepts `scope: RuntimeScope {callerId?, tenantId?, claims?}` for per-execution caller/tenant identity, routing state R/W through the tenant view.

**State** (all accept optional `tenant_id` for strict isolation via `StateStore::scoped`) — `state.get`/`state.set`/`state.exists`/`state.keys`/`state.snapshot`. Scoped tenants don't see unscoped keys and vice versa.

**Memory** — `memory.add_fact {subject, body, kind?=pattern}` (`kind:constraint` sets the constraint flag; WS facts auto-prefixed `ws-`); `memory.query {query, k?=5}` → `[{subject,body,kind,confidence}]` (Personalized PageRank / spreading activation); `memory.build_context {query, model_context_window?}` → assembled context string; `memory.build_context_fast`; `memory.persist {path}` / `memory.load {path}`; `memory.consolidate`; `memory.fact_count`.

> **Gotcha:** `memory.persist`/`load` paths are interpreted on the **daemon's** filesystem (not the caller's), **sandboxed under `~/.car/memory/`**; `..` segments and outside-pointing symlinks are rejected. The same sandbox applies to `transcribe` `audio_path` and `synthesize` `output_path` — use `audio_b64` / `return_b64` to cross it.

**Skills** — `skill.ingest {name, code, platform?, persona?, url_pattern?, description?, task_keywords?, supersedes?}` → node id; `skill.find {persona?, url?, task?, max_results?=1}`; `skill.report {skill_name, outcome}` (auto-degrades when `fail > success + 2`); `skill.repair {skill_name}`; `skills.distill {events}`, `skills.evolve {events, domain}`, `skills.ingest_distilled`, `skills.list {domain?}`, `skills.domains_needing_evolution {threshold?=0.6}`.

**Inference & models** — `infer GenerateRequest{model, messages, system?, max_tokens?, temperature?, tools?, context_query?, response_format?, intent?}` → `{text, tool_calls, usage:{input_tokens,output_tokens}, model_used, trace_id, latency_ms, time_to_first_token_ms}`. Set `context_query` to auto-inject memory context. `infer_stream` (same request) pushes `inference.stream.event {request_id, event:{type:text|tool_start|tool_delta|usage|stop_reason|provider_output_item|error}}`; `error` is terminal. It returns the accumulated result in the **final JSON-RPC response**; there is no `done` notification. Also `embed`, `classify`, `rerank`, `tokenize`/`detokenize` (**local Qwen3 GGUF/MLX only** — remote returns `UnsupportedMode`), `transcribe`, `synthesize`, `image.generate`, `video.generate`, `speech.prepare`. Model management: `models.list`, `models.list_unified`, `models.search`, `models.recommend`, `models.setup_plan`, `models.resource_policy.get`/`set`, `models.preflight`, `models.storage_roots`, `models.adopt`, `models.remove`, `models.upgrades`/`detect_upgrades`/`check_upgrade_nudge`/`dismiss_upgrade`, `models.update_prefs_get`/`set`, `models.register`/`unregister`, `models.pull`/`install`, `models.route`, `models.stats`, `admission.status`.

> **Gotchas:** `infer_stream` honors `response_format` on remote providers; an unsupported combination — including either response-format variant on Anthropic — returns an explicit `UnsupportedMode` error instead of being silently weakened. For structured output on Claude, use tools + `tool_choice=required`. `models.register`/`unregister` are phase-1: the daemon's live `UnifiedRegistry` is **not** updated in-process — changes are visible to `models.list*`/`infer` only on the **next daemon boot**, so register models before issuing `infer` or restart.

**Multi-agent & workflows** — `multi.swarm {mode:parallel|sequential|hybrid, agents:AgentSpec[], task, synthesizer?}`, `multi.pipeline {stages, task}`, `multi.supervisor {workers, supervisor, task, max_rounds?=3}`, `multi.map_reduce {mapper, reducer, items, task}`, `multi.vote {agents, task, synthesizer?}`. `AgentSpec = {name, role?, model?, system_prompt?}`. `workflow.run {workflow}` (uses `multi.run_agent` callbacks); `workflow.verify {workflow}` → `{valid, issues}`.

**Delegated inference runner** — when a model schema declares `source:{type:delegated}`, CAR routes through the registered WS runner. `inference.register_runner {}` → `{registered:true}` (one per process); CAR pushes `inference.runner.invoke {call_id, request:GenerateRequest}`; the host streams via `inference.runner.event {call_id, event}` and finishes with `inference.runner.complete {call_id, result}` or `inference.runner.fail {call_id, error}`, correlated by `call_id`.

```json
{"jsonrpc":"2.0","method":"inference.runner.invoke","params":{"call_id":"uuid-string","request":{ /* GenerateRequest */ }}}
```

**Lifecycle agents** (manifest `~/.car/agents.json`) — `agents.upsert AgentSpec{id, name, command, args?, cwd?, env?, restart:never|on_failure|always, max_restarts?, backoff_secs?, auto_start?, interpreter?}` (persists but **does NOT auto-start**), `agents.install AgentManifest`, `agents.start`/`stop {id, signal?:term|kill}`/`restart`/`remove`/`tail_log {id, n?=100}`/`list`/`health`/`register_basics`. The child binds identity by calling `session.auth {token:<per-agent token>, agent_id}`.

**External agentic CLIs** (Claude Code / Codex / Gemini) — `agents.list_external {include_health?}`, `agents.detect_external` (force-refresh), `agents.health_external {id?, force?}`, `agents.invoke_external {id, task, stream?, session_id?, cwd?, allowed_tools?, max_turns?, timeout_secs?=300, mcp_endpoint?}` → `InvokeResult {answer, session_id?, turns, tool_calls, duration_ms, total_cost_usd?, is_error, error?}`. `mcp_endpoint` auto-fills from the daemon's `/mcp` URL (pass `''` to opt out); streaming fans `agents.chat.event` notifications.

**Host control surface** — `host.subscribe` → `HostSnapshot {subscribed, agents, approvals, events, identity{version, pid, manifest_path, manifest_role:owner|observer|none}}`; `host.agents`/`events {limit?=100}`/`approvals`; `host.register_agent {id?, name, kind, capabilities?, project?, pid?, display?, metadata?}`; `host.set_status {agent_id, status:idle|running|waiting_for_approval|paused|completed|errored|stopped, ...}`; `host.notify`; `host.request_approval`/`resolve_approval {approval_id, approved, notes?}`.

> **Per-session ACL on `host.*`:** only the owning session (set at `host.register_agent`) may call `host.set_status` / `host.unregister_agent`; cross-session mutation returns "owned by another session". Reads are unrestricted.

**Other namespaces** — `scheduler.create`/`run`/`run_loop` (triggers `once`|`cron`|`interval`|`file_watch`); `registry.register`/`heartbeat` (~20s)/`unregister`/`list`/`reap {max_age_secs?=60}` (~30s); `secret.put`/`get`/`delete`/`status`/`available` (OS keychain); `a2a.start`/`stop`/`status`/`send`; `a2ui.apply`/`ingest`/`surfaces`/`get`/`action`/`subscribe`; voice/meeting; and the macOS OS-integration surfaces (`automation.*`, `vision.ocr`, `mail.*`, `messages.*`, `calendar.*`, `contacts.*`, `health.*`, `notes.*`, `reminders.*`, etc.).

> **Observe-only agents mode:** if a second `car-server` hits the manifest lock (`<manifest>.lock`, an exclusive OS lock that prevents double-spawn), only `agents.list` and `agents.health` keep working (read manifest directly); every other `agents.*` method errors with "observe-only" plus the lock-holder's manifest path.

### Voice & binary frames

High-rate audio rides as **WebSocket binary frames**, not JSON. Streaming transcription: `voice.transcribe_stream.start {session_id, audio_source, options:{provider:local|elevenlabs}}` → push PCM via `voice.transcribe_stream.push {session_id, pcm_b64}` or binary `0x01` frames → `voice.transcribe_stream.stop`. TTS: `voice.tts_stream.start {stream_id, text, options:{provider:elevenlabs|local|kokoro|apple_speech, voice_id, binary_frames}}`, cancel (barge-in, idempotent) via `voice.tts_stream.cancel {stream_id}`. The two-track sidecar turn API is `voice.dispatch_turn {utterance, ...}` → emits `voice.turn.*` events (`fast_delta`, `fast_done`, `bridge`, `sidecar`, `error`, `cancelled`).

```text
CAR binary frame header — 26-byte little-endian
offset  size  field
0       1     type tag (0x01 inbound PCM, 0x02 TTS chunk, 0x03 TTS final, 0x04 TTS error)
1       16    session/stream UUID (raw bytes; JSON id = 32-char lowercase hex, no dashes)
17      8     seq (u64 LE) monotonic
25      1     format byte (0x00 PCM / 0x01 MP3 / 0x02 WAV; type 0x02 only)
26+     N     payload bytes
```

Reference impl: `car-ffi-common/src/voice.rs::binary` (`parse_frame`/`build_frame`).

> **Gotcha:** `binary_frames:true` on `voice.tts_stream.start` **requires a 32-char lowercase-hex no-dash `stream_id`** (the binary header needs raw UUID bytes); JSON `tts_chunk` events are suppressed in that mode. Voice/binary streaming is also **not bridged into the FFI surface in v0.8** — use the WS directly.

### Worked example: a plain client running a single agent

The full client loop — connect, authenticate, register tools+policies, store memory, verify, submit, and handle inverted tool callbacks — looks like this. No FFI wheel required.

```python
import asyncio, json, websockets

async def call(ws, method, params, request_id):
    await ws.send(json.dumps({"jsonrpc":"2.0","method":method,"params":params,"id":request_id}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == request_id:
            return msg
        # else a server-pushed event (host.event, voice.event, tools.execute) — ignore for this demo

async def main():
    async with websockets.connect("ws://127.0.0.1:9100") as ws:
        # If auth is on, send session.auth FIRST: await call(ws, "session.auth", {"token": TOKEN}, 0)
        await call(ws, "server.handshake", {
            "protocol_version": 3,
            "required_capabilities": ["infer.model-identity.v1", "models.catalog-identity.v1"],
            "optional_capabilities": [],
        }, 1)
        init = await call(ws, "session.init", {
            "tools": [{"name":"shell","description":"run a shell command"}],
            "policies": [{"name":"no_rm","rule":"deny_tool_param","target":"shell","key":"command","pattern":"rm -rf"}],
        }, 2)
        await call(ws, "memory.add_fact", {"subject":"language","body":"Python","kind":"pattern"}, 3)
        ctx = await call(ws, "memory.build_context", {"query":"what is this app?"}, 4)
        verify = await call(ws, "verify", {"proposal":{"actions":[{"id":"a1","type":"tool_call","tool":"shell","parameters":{"command":"echo hi"},"idempotent":True}]}}, 5)
        hits = await call(ws, "memory.query", {"query":"language","k":5}, 6)

asyncio.run(main())
```

When you actually **execute** (not just `verify`), you must run the callback loop, because the next frame after `proposal.submit` is usually a `tools.execute` request, not your result:

```python
await ws.send(json.dumps({"jsonrpc":"2.0","method":"proposal.submit",
    "params":{"proposal":{"actions":[{"id":"a1","type":"tool_call","tool":"shell","parameters":{"command":"echo hi"}}]}}, "id":4}))

while True:
    msg = json.loads(await ws.recv())
    if msg.get("method") == "tools.execute":
        tool = msg["params"]["tool"]; params = msg["params"]["parameters"]
        result = {"stdout":"hi\n","stderr":"","code":0} if tool=="shell" else {"error":f"unknown tool: {tool}"}
        # MUST reply on the same id the server sent — server is blocked on it (60s timeout)
        await ws.send(json.dumps({"jsonrpc":"2.0","result":result,"id":msg["id"]}))
    elif msg.get("id") == 4:
        print("proposal result:", msg); break
```

### Starting and tuning the daemon

```bash
car-server --port 9100                         # start WS daemon (default 127.0.0.1:9100, auth ON)
car-server --port 9100 --journal-dir ~/.car/journals   # event-journal dir (default ~/.car/journals)
car-server --no-auth                           # disable auth handshake (also CAR_NO_AUTH=1)
car-server --auth-token <token>                # install a pre-minted token (also CAR_AUTH_TOKEN; used by CarHost.app)
car-server --no-approvals                      # disable high-risk approval gate (also CAR_NO_APPROVALS=1)
car-server --agents-manifest <path>            # lifecycle-agent manifest (also CAR_AGENTS_MANIFEST; default ~/.car/agents.json)
car-server --mcp-bind <host:port>              # override/disable MCP endpoint (also CAR_MCP_BIND; default 127.0.0.1:9102, 'disabled' to skip)
car-server --a2a-bind <host:port>              # HTTP+SSE A2A listener for streaming peers (also CAR_A2A_BIND)
CAR_HOME=/abs/path car-server --port 9200 --mcp-bind disabled   # isolated 2nd daemon: own state root, own port (default root ~/.car)
CAR_INFERENCE_MAX_CONCURRENT=<n> car-server    # override inference admission permits (1 = full serialization)

export CAR_DAEMON_URL=ws://<host>:9100/        # point a thin client / SDK at a (remote) daemon
export CAR_AUTH_TOKEN=<token>                  # cross-host auth (overrides the local token file)
car auth login parslee                         # Parslee OAuth2 PKCE sign-in (shares impl with auth.* methods)
```

### Gotcha checklist for authors

- **Auth first, always.** When auth is on (the default), `session.auth` must be frame #1 or you get `-32001` and a closed socket. Local dev: `--no-auth`, or read the token from the well-known path.
- **Negotiate before host/auth calls.** Await auth success, then exact
  `server.handshake {"protocol_version":3,"required_capabilities":["infer.model-identity.v1","models.catalog-identity.v1"],"optional_capabilities":[]}` success before `host.subscribe` or
  any `auth.*` method. Reconnects repeat both barriers.
- **Sessions are ephemeral.** Memgine, state, tools, and policies die on disconnect. Persist explicitly (`memory.persist`) or bind an `agent_id` for a durable per-agent memgine.
- **`tools.register` takes a bare array;** `session.init` wraps it in `{tools:[...]}`.
- **Demux by `id`, not arrival order.** Interleaved `tools.execute` requests can precede your final result.
- **Reply to `tools.execute` on the server's id within 60s,** or the proposal aborts with a callback timeout. Send an `error` object to signal tool failure.
- **`verify` fires no callbacks** — it's pure static analysis, safe to call without a callback loop.
- **Notifications have no `id`;** a naive call-and-wait client silently drops `host.event`, `voice.event`, streaming deltas, etc. `host.event` requires `host.subscribe` first.
- **A2A streaming** (`message/stream`, `tasks/resubscribe`) returns `MethodNotFound` from the in-core dispatcher — use `--a2a-bind` HTTP+SSE for streaming peers.
- **The doc is hand-maintained from `handler.rs`, `host.rs`, `session.rs`.** On any drift, the Rust dispatcher is the source of truth.

---

## MCP Integration (CAR as Server + Consuming MCP Tools)

CAR speaks the **Model Context Protocol (MCP)** in *both* directions, and a single-agent author needs to know which direction they are reaching for:

| Direction | What it means | Where it lives |
|-----------|---------------|----------------|
| **CAR as MCP server** | An MCP-aware model (Claude Desktop, Cursor, Claude Code, a custom GPT) calls CAR's stateless capabilities — graph-memory facts, skills, proposal verification, four-layer context — as MCP tools/resources/prompts. | `car-mcp` (dispatcher) + `car-mcp-server` (stdio binary) + `car-server-core/src/mcp.rs` (HTTP-streamable on the daemon) |
| **CAR as MCP client** | Your CAR agent consumes an *external* MCP server's tools, registered as native `mcp_{server}_{tool}` tools that route through CAR's capability/policy flow. | `car-engine/src/mcp.rs` (`McpServer` + `McpToolExecutor`) |

The protocol version CAR speaks is **`2024-11-05`** in both directions (`car-mcp` `PROTOCOL_VERSION`). As a server, CAR *negotiates* rather than announcing: `initialize` answers with the `protocolVersion` the client requested when it appears in `car-mcp` `SUPPORTED_VERSIONS`, and with `PROTOCOL_VERSION` otherwise — including when the client sends no version at all. `SUPPORTED_VERSIONS` holds exactly `["2024-11-05"]` today, so every client sees the same answer it always did; the list is what makes a later revision safe to append.

> **Daemon-first framing.** The HTTP-streamable MCP endpoint is a feature of the singleton `car-server` daemon — it shares the daemon's `Arc<Mutex<MemgineEngine>>`, so a fact you ingest over MCP shows up in WebSocket queries and vice versa. The standalone `car-mcp-server` stdio binary is the exception: it runs its own fresh, in-memory engine per process and is stateless across requests. Keep that engine-ownership distinction in mind whenever you reason about where memory persists.

### What is — and isn't — exposed over MCP

The **stdio** binary exposes only CAR's stateless capabilities. Anything needing bidirectional tool callbacks is not on that surface, because MCP has none — for those you use the WebSocket transport (`car-server`):

- **Exposed over stdio MCP:** graph-memory facts, skills, proposal verification (no execution), policy checks, four-layer context assembly.
- **NOT exposed over MCP at all (use WebSocket):** proposal execution (tool callbacks), multi-agent (swarm/pipeline/supervisor), streaming inference, voice, browser, meeting capture.

**The daemon's HTTP endpoint is the exception, and it is deliberate.** It adds `assistant_start` / `assistant_poll` / `assistant_cancel` (car#972 §6) — the flagship agent behind `car do`, driven through a **run handle** rather than a blocking call. That does not make the transport stateful: the `run_id` is application state the *client* carries between calls, like the opaque `resources/list` cursor, and `POST /mcp` still reads no session header. What it does mean is that "MCP is the stateless half of CAR" is now true of the stdio binary specifically, not of MCP as such.

The split is one of *capability ownership*, not protocol taste: the daemon holds a live `Runtime`, an inference engine, and daemon state; `car-mcp-server` is `car-mcp` + `car-telemetry` and holds none of them. The tool list is per-`Server`, so the stdio binary never advertises a tool it could not run. Full contract in `docs/websocket-protocol.md`; the envelope is `docs/car-do-json.md`.

---

### CAR as an MCP Server

#### The exposed surface: 16 tools, 2 resource families, 1 prompt

`tools/list` returns the **16 built-in tools** below, defined in `car-mcp/src/schemas.rs` and cached via `OnceLock`, **plus whatever the embedding transport registered** through `Server::register_tool`. The advertised set is per-`Server`, not per-process: the daemon holds a live `Runtime` and can therefore carry tools the stdio binary has no way to run and must not advertise, so the two transports legitimately differ. The stdio binary advertises exactly these 16; **the daemon advertises 19** — these plus `assistant_start`, `assistant_poll`, and `assistant_cancel`. The wire names are **underscored** (`memory_add_fact`, not `memory.add_fact`):

| Tool | Hints | Required args | Optional args | Returns |
|------|-------|---------------|---------------|---------|
| `memory_add_fact` | write · additive | `subject`, `body` | `kind` (enum `["pattern","constraint"]`, default `pattern`) | text: `fact remembered id=assistant-note-… total=… durable=…` |
| `memory_query` | read-only · idempotent | `query` | `k` (1–50, default 5) | top-k `[{subject, body, activation}]` via spreading activation |
| `memory_update_status` | write · destructive · idempotent | `body` | `tenant_id` | proactive private status JSON |
| `memory_save_knowledge` | write · additive | `subject`, `body` | `id`, `tags[]`, `confidence`, `tenant_id`, `is_constraint` | proactive saved-entry JSON |
| `memory_save_procedural` | write · additive | `subject`, `body` | `id`, `tags[]`, `confidence`, `tenant_id`, `is_constraint` | proactive saved-entry JSON |
| `memory_delete` | write · destructive · idempotent | `id` | — | proactive delete report JSON |
| `memory_intervene` | write · additive | — | `query`, `recent[]`, `trigger`, `force`, `max_candidates`, `tenant_id` | proactive inject/silent decision JSON |
| `memory_evaluate` | read-only · idempotent | `cases[]` | — | proactive ablation report JSON |
| `verify` | read-only · idempotent | `proposal` (a `car_ir::ActionProposal` JSON object) | `max_actions` (1–1000, default 30) | `{valid, issues, simulated_state}` |
| `simulate` | read-only · idempotent | `proposal` | `initial_state` (object, default empty) | `{final_state}` — the state the *declared* `expected_effects` imply; a blocked action contributes nothing and takes its dependents with it |
| `equivalent` | read-only · idempotent | `proposal_a`, `proposal_b` | `test_states[]` (1–256; omitted or `[]` → two trivial defaults) | `{equivalent, tier:"sampled", states_tested, used_default_states}` — a `false` is a witness; a `true` covers only the sampled states |
| `optimize` | read-only · idempotent | `proposal` | — | `{proposal, pruned[]}` — the proposal with phantom `state_dependencies` removed, plus `[{action_id, removed[]}]` naming what went |
| `skill_ingest` | write · destructive | `name`, `code` | `platform`, `persona`, `url_pattern`, `description`, `task_keywords[]`, `supersedes` | ingest confirmation |
| `skill_list` | read-only · idempotent | — | `domain` (filters to `Global` or `Domain(domain)`) | enumerated skills |
| `skill_find` | read-only · idempotent | `task` | `persona`, `url`, `k` (1–20, default 3) | `[{skill, score}]` ranked by activation |
| `policy_check` | read-only · idempotent | `tool` | `params` | `{decision, basis, findings[]}` — allow/deny for a tool call the caller has **not yet run** |

The daemon endpoint adds three more, which the stdio binary does **not** advertise:

| Tool (daemon only) | Hints | Required args | Optional args | Returns |
|------|-------|---------------|---------------|---------|
| `assistant_start` | write · destructive · open-world | `task` | `cwd`, `until`, `max_turns` (1–200, default 50), `local`, `model`, `invoked_by` | `{run_id, status:"running", poll_after_ms, sandbox, ancestry}` |
| `assistant_poll` | read-only · idempotent | `run_id` | `since_seq` (default 0) | `{status, events, next_seq, events_skipped, …}` plus the `car.do/1` document in `result` once terminal |
| `assistant_cancel` | write · idempotent | `run_id` | — | `{run_id, status:"cancelled"\|"already_terminal"\|"unknown"}` |

`assistant_start` is `destructiveHint: true` and `openWorldHint: true` because it runs an autonomous agent with a real shell and host-side web tools — a host deciding whether to prompt should assume the worse case, since what a given run touches is not knowable up front.

**What the Hints column is.** Every entry carries an `annotations` object on the wire with all four MCP hints — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. The column above is their shorthand: *read-only* is `readOnlyHint: true`, *destructive* is `destructiveHint: true` (an existing entry is overwritten or retired, not merely that the call writes), *additive* is a write that only appends, and *idempotent* marks `idempotentHint: true`. No built-in CAR tool sets `openWorldHint` — all sixteen touch only the local memory graph, the local policy files, or a pure in-process check.

Hosts use these for approval UX: a host can auto-approve `memory_query` while still prompting for `memory_delete`, instead of prompting equally hard for both. **They are hints, not guarantees, and not a security boundary.** The MCP spec requires a client to treat annotations from an untrusted server that way, and CAR follows the same rule internally — nothing in CAR's governance keys off them. The gate is still the policy layer (`policy_check` / `.car/policies/`).

Two classifications are the opposite of what the name suggests, and are worth reading before you wire up auto-approval:

- **`memory_intervene` is a write.** It reads like a query — "select at most one reminder" — but selecting one bumps the chosen fact's `proactive_injections` counter, so it is neither read-only nor repeatable without effect.
- **`skill_ingest` is destructive.** Passing `supersedes` flips the named older skill's node to `SkillDeprecated`, which stops it matching `skill_find`. Ingesting without `supersedes` is purely additive, but the hint has to describe the tool's worst case.

**The four verification tools, and what each one does not establish.** `verify`, `simulate`, `equivalent`, and `optimize` are the same `car-verify` entry points the FFI exposes, so the vocabulary carries over: these are *checks*, never proofs, and none of them is sound. `verify` reports findings and tags each with its `tier`. `simulate` returns the state the proposal's **declared** `expected_effects` imply — an action whose preconditions or state dependencies are unsatisfied contributes nothing and its dependents drop with it, but a declared effect is *assumed* to land and `failure_behavior` is not modelled. `equivalent` **samples**: a `false` is a witness that some probed state separates the two proposals, while a `true` says only that none of the probed states did — which is why the result carries `tier: "sampled"`, `states_tested`, and `used_default_states` rather than a bare bool. `optimize` **rewrites** instead of checking, and a dependency it prunes is exactly one `verify` would have reported as unavailable, so run `verify` on the returned proposal rather than reading the rewrite as a repair.

> **Gotcha — trust the source, not the cookbook.** `docs/cookbook/07-mcp-server.md` lists dotted namespaces (`memory.add_fact`, `memory.build_context`, `skill.find`, `skill.report`). The actual wire names in `schemas.rs` are underscored, and `memory.build_context` / `skill.report` **do not exist as tools**. Context assembly is exposed as the `car_context` *prompt*, not a tool.

**Resources** (`resources/list` → `resources/read`) expose graph nodes as URIs; invalidated/superseded nodes are skipped:

- `car://memory/fact/{id}` — `text/plain`
- `car://memory/skill/{name}` — `application/json`

`resources/list` is paginated: it returns at most **100 resources** per page,
ordered by URI, plus an opaque `nextCursor` string. Pass that string back as
`{"cursor": "…"}` to get the next page; the final page **omits `nextCursor`
entirely**, and that absence is how a client knows it is done. A cursor that
does not decode is rejected with `-32602` rather than silently restarting from
the top. The cursor is **stateless** — it carries its own resume key rather than
naming a row in a server-side session table — so any process can serve the next
page, which matters because the daemon's HTTP endpoint does not pin a client to
one server instance. It also means a cursor still resumes correctly after a
restart, or after the resource it names has been deleted. Pagination bounds the
*response*, not the graph walk: each page still scans every node.

**Prompt** (`prompts/list` → `prompts/get`) — exactly one:

- `car_context(query!, mode?)` — assembles CAR's four-layer context (identity → constraints → facts → conversation → environment → known-unknowns) for `query` and returns it as a single `role: user` message. `mode` is `"full"` (default) or `"fast"` (fast skips embedding flush, skill lookup, PPR scoring).

#### JSON-RPC method reference

Every transport routes through one pure, transport-agnostic entry point — `car_mcp::Server::handle(req: Request) -> Option<Response>` (returns `None` for notifications, which have no `id`):

| Method | Params | Result |
|--------|--------|--------|
| `initialize` | `{protocolVersion?, capabilities?, clientInfo?}` — only `protocolVersion` is read | `protocolVersion` (negotiated), `capabilities`, `serverInfo` |
| `ping` | — | `{}` |
| `tools/list` | — | `{tools: […]}` — 16 built-ins on stdio, 19 on the daemon; every entry carries an `annotations` object |
| `tools/call` | `{name, arguments}` | `{content:[{type:text,text}], isError:bool}` — `isError:true` when the tool ran and failed (see below) |
| `resources/list` | `{cursor?}` | `{resources:[{uri,name,description,mimeType}], nextCursor?}` |
| `resources/read` | `{uri}` | `{contents:[{uri,mimeType,text}]}` |
| `prompts/list` | — | `{prompts:[car_context]}` |
| `prompts/get` | `{name:"car_context", arguments:{query, mode}}` | `{description, messages:[{role:user, content:{type:text,text}}]}` |
| `completion/complete` | `{ref:{type,…}, argument:{name, value?}}` | `{completion:{values:[…], total, hasMore}}` — `values` capped at 100 |

`handle` recognizes `notifications/initialized`, `notifications/cancelled`, `notifications/progress`, and `notifications/roots/list_changed`, and logs each by name — a cancellation logs the `requestId` and `reason` it carried. Every one of them, **and any notification method it does not recognize**, is answered with silence: JSON-RPC 2.0 forbids replying to a message with no `id`, so an unrecognized notification must not come back as `-32601` either.

Cancellation specifically is acknowledged and then dropped by design. This server runs each `tools/call` synchronously inside `handle` and keeps no registry of in-flight requests, so by the time a `notifications/cancelled` can be read off the transport, the request it names has already completed and its response has already been written — there is nothing left to stop. That changes the day a long-running or streaming tool lands, and the reasoning is recorded at the call site so it gets revisited then.

The `initialize` response shape (`SERVER_NAME = "car-mcp"`):

```rust
json!({
    // the client's version when supported, else "2024-11-05"
    "protocolVersion": negotiate_version(&req.params),
    "capabilities": {
        "tools": {},
        "resources": { "subscribe": false, "listChanged": false },
        "prompts": { "listChanged": false },
        "completions": {},          // 2025-03-26 field, advertised anyway
    },
    "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
})
```

`completions` was introduced in the 2025-03-26 revision while `PROTOCOL_VERSION` is still `2024-11-05`. It is advertised regardless: capabilities are an unordered bag, a 2024-11-05 client ignores a key it does not recognize, and hosts probe `completion/complete` off this flag. Withholding it would make a method CAR actually serves undiscoverable.

**`completion/complete`** (car#972 §4) answers argument autocompletion, and it is the one §4 item that needs no server-to-client push — a plain request/response, identical on stdio and on the daemon's stateless HTTP endpoint. Two `ref` shapes:

- `{"type":"ref/prompt","name":"car_context"}` with `argument.name = "mode"` completes `["full","fast"]` filtered by `argument.value` as a prefix. `argument.name = "query"` completes to nothing — it is arbitrary task text and there is no corpus to suggest from.
- `{"type":"ref/resource","uri":"car://memory/fact/"}` prefix-matches `ref.uri` against the URIs `resources/list` would page over (both read the same enumeration, so a completed URI is always a readable one). CAR exposes no URI *templates* — `resources/templates/list` is not implemented — so "which existing URIs start with this" is the only meaningful reading.

The empty-vs-error split is deliberate. A **malformed** request — no `ref`, no `argument`, an `argument` with no `name`, a non-object in either slot — never named anything to complete and is `-32602`. A **well-formed** request naming something the server does not know — an unknown prompt, an unknown argument, an unfamiliar or absent `ref.type` — gets an empty completion, not an error: a host's argument picker should not raise an error dialog because the user tabbed into an unfamiliar field. `values` is capped at 100 per the spec; `total` is the honest pre-truncation match count and `hasMore` is `total > values.len()`, so a client that sees 100 values can tell whether that is all of them.

**Error codes** (mirrored across both transports): `PARSE -32700`, `INVALID_REQUEST -32600`, `METHOD_NOT_FOUND -32601`, `INVALID_PARAMS -32602`, `INTERNAL -32603`. The `ToolError` enum maps `InvalidParams → -32602`, `Internal → -32603`, `UnknownTool → -32601`.

#### Transport 1 — stdio (`car-mcp-server`)

One client per process; in-memory engine; newline-delimited JSON-RPC over stdin/stdout via `transport::stdio_loop(server: Arc<Server>)`. The binary's `main.rs`:

```rust
#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    car_telemetry::init_tracing("car-mcp");
    let server = Arc::new(Server::new());   // fresh in-memory MemgineEngine
    stdio_loop(server).await
}
```

> **stdout is reserved for the protocol stream.** All logs MUST go to stderr (`init_tracing("car-mcp")` ensures this). Writing to stdout corrupts the JSON-RPC stream.

**Wire CAR into Claude Desktop** — extract `car-mcp-server` from the release tarball, then edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "car": {
      "command": "/usr/local/bin/car-mcp-server"
    }
  }
}
```

Restart Claude Desktop; CAR's 16 tools appear automatically. Logs land at `~/Library/Logs/Claude/mcp-server-car.log`:

```bash
tail -f ~/Library/Logs/Claude/mcp-server-car.log
```

**Cursor** — edit `~/.cursor/mcp.json` with `{"mcpServers":{"car":{"command":"car-mcp-server"}}}` (the bare name works if `car-mcp-server` is on `$PATH`).

**Persisting stdio memory** — the cookbook documents a `CAR_MEMORY_PATH` env block:

```json
{
  "mcpServers": {
    "car": {
      "command": "car-mcp-server",
      "env": { "CAR_MEMORY_PATH": "~/.car/mcp-memory.json" }
    }
  }
}
```

> **Verify before relying on it.** `CAR_MEMORY_PATH` is documented in the cookbook, but the library `Server` itself does not load or write a path — `car-mcp-server`'s `main.rs` uses `Server::new()` (fresh in-memory engine, stateless across requests). Persistence is the binary's responsibility; confirm your build honors it. To get *shared, persistent* memory, prefer the HTTP-streamable transport on the daemon.

#### Transport 2 — HTTP-streamable (on the daemon)

`car-server-core/src/mcp.rs` wraps the same `car_mcp::Server` in an axum `Router`, backed by the daemon's shared `MemgineEngine` via `Server::with_memgine(Arc<Mutex<MemgineEngine>>)`. Routes:

| Route | Behavior |
|-------|----------|
| `POST /mcp` | One JSON-RPC request → reply. A notification (no `id`) has no reply, so it returns `202 Accepted` with an empty body — don't parse it. The HTTP layer never invents protocol semantics — everything routes through `Server::handle`. |
| `GET /mcp` | SSE stream for server-initiated events; keyed by the `mcp-session-id` header (generated if absent; `SESSION_HEADER = "mcp-session-id"`, `SSE_KEEPALIVE_SECS = 30`). First event is a `notifications/initialized` payload carrying the `session_id`. Sessions auto-removed on stream `Drop`. |
| `GET /mcp/health` | Liveness: `{"status":"ok","protocol_version":"2024-11-05", server_name}`. Not `Origin`-guarded and not `MCP-Protocol-Version`-guarded — no side effect, no secrets, the uptime `curl` below has to keep working, and it is how a client whose version was rejected finds out what the server speaks. |

**`Origin` validation** guards `POST /mcp` and `GET /mcp` (DNS-rebinding protection). Absent `Origin` → allowed, which is what every real MCP client sends; an `Origin` naming loopback (`localhost`, `127.0.0.0/8`, `::1`, any port, `http` or `https`) → allowed; anything else, including the literal `null`, → `403 {"error":"origin not allowed"}`. The rule does **not** widen for a non-loopback `--mcp-bind` — a wildcard bind's host is `0.0.0.0`, which never appears as an `Origin`, and wider exposure makes the guard matter more. Put a reverse proxy with its own CORS policy in front if you need browser traffic from another origin.

**`MCP-Protocol-Version` validation** guards the same two routes, with the same absent-permissive, present-strict shape. Absent → allowed, which is what every shipped client sends today; a value in `car_mcp::SUPPORTED_VERSIONS` (`2024-11-05` today) → allowed; anything else, including an empty or non-UTF-8 value, → `400 {"error":"unsupported MCP-Protocol-Version","requested":"…","supported":["2024-11-05"]}`. The `400` carries the supported list because a client that guessed wrong has no other way to learn what to send. A foreign value is rejected rather than silently downshifted: the header states which dialect the client will read the reply in, so answering in a revision it never agreed to would mean something different than intended. Rejection happens before the JSON-RPC parse on `POST` and before the SSE session insert on `GET`, so no tool runs and no session is registered.

It binds **`127.0.0.1:9102` by default** (CLI flag `--mcp-bind host:port`, env `CAR_MCP_BIND`; literal `disabled` opts out):

```bash
car-server --mcp-bind 127.0.0.1:9102      # bind MCP HTTP endpoint (default)
CAR_MCP_BIND=0.0.0.0:9102 car-server      # env equivalent
car-server --mcp-bind disabled            # opt out

curl http://127.0.0.1:9102/mcp/health     # -> {status:ok, protocol_version:2024-11-05, ...}

# Origin rule on /mcp itself (health is exempt):
curl -X POST http://127.0.0.1:9102/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                      # 200 — no Origin
curl -X POST http://127.0.0.1:9102/mcp -H 'content-type: application/json' \
  -H 'Origin: http://localhost:3000' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 200 — loopback
curl -X POST http://127.0.0.1:9102/mcp -H 'content-type: application/json' \
  -H 'Origin: https://evil.example' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'    # 403

# MCP-Protocol-Version rule on /mcp (health is exempt here too):
curl -X POST http://127.0.0.1:9102/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                      # 200 — no header
curl -X POST http://127.0.0.1:9102/mcp -H 'content-type: application/json' \
  -H 'MCP-Protocol-Version: 2024-11-05' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                      # 200 — supported
curl -X POST http://127.0.0.1:9102/mcp -H 'content-type: application/json' \
  -H 'MCP-Protocol-Version: 1999-01-01' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'                      # 400 + supported list
curl http://127.0.0.1:9102/mcp/health -H 'MCP-Protocol-Version: 1999-01-01' # 200 — exempt
```

**Call a tool over HTTP** — POST a JSON-RPC request to `/mcp`:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"memory_add_fact","arguments":{"subject":"daemon","body":"shared engine works"}}}
```

```json
{"content":[{"type":"text","text":"fact remembered id=assistant-note-0 total=1 durable=true"}],"isError":false}
```

**Tool failures vs protocol failures.** MCP reports these two differently, and the
difference is who finds out. A *protocol* error — an unknown tool, or arguments that do
not typecheck — is a JSON-RPC `error`; the tool never ran, the client handles it, and the
model is typically never told. A *tool execution* error — the tool ran and failed — comes
back as a normal result with `isError: true`, so the failure text lands in the
conversation where the model can read it and correct itself.

```json
{"content":[{"type":"text","text":"fact not remembered — could not write the memory store: …"}],"isError":true}
```

So `memory_add_fact` failing to reach disk is an `isError:true` result, while
`memory_add_fact` called without `body` is `-32602`. Do not treat a non-null `result` as
success: check `isError`.

Then query: `{"name":"memory_query","arguments":{"query":"color","k":5}}`.

**Daemon wiring** — at startup the daemon binds the listener, then installs the URL and SSE registry onto `ServerState` so the rest of the daemon (e.g. external-CLI injection) can reach it:

```rust
let mcp_server = Arc::new(car_mcp::Server::with_memgine(shared_memgine.clone()));
match car_server_core::mcp::start_mcp(mcp_server, mcp_addr).await {
    Ok((bound, handle, sessions)) => {
        let mcp_url = format!("http://{}/mcp", bound);
        let _ = server_state.install_mcp_url(mcp_url.clone());
        let _ = server_state.install_mcp_sessions(sessions);
    }
    Err(e) => { /* warn, continue without MCP */ }
}
```

`start_mcp(server, addr) -> Result<(SocketAddr, JoinHandle<()>, Arc<SessionMap>), String>` returns the *bound* address (may differ from requested when port `0` is supplied), the axum task handle, and the SSE session registry. Bind failure is reported synchronously so startup can log and continue without MCP.

> **Behavioral notes.** Malformed JSON returns `-32700` with **HTTP 200** (not 4xx), mirroring stdio. Notifications return **HTTP 200 with body `{}`**. `push_to_session(sessions, session_id, payload) -> bool` exists and delivers server-initiated JSON-RPC to a specific SSE client — but the full bidirectional host-owned tool-routing loop on top of it is foundation-only (MCP-3b, pending). Also note: the `car-mcp` `lib.rs` doc comments still call the HTTP transport "Phase 2 stage 4b — pending"; that comment is **stale** — the transport is implemented in `car-server-core/src/mcp.rs` and wired into `car-server` `main.rs`.

---

### CAR as an MCP Client (Consuming External MCP Tools)

`car-engine/src/mcp.rs` lets your CAR agent treat an external MCP server's tools as native CAR tools. They are namespaced `mcp_{server}_{tool}` and **participate in CAR's full capability/permission/policy flow** — the same allow-list, deny rules, and dispatch-time inspectors that gate native tools.

**Launch config and routing executor:**

```rust
let server = McpServer::start(McpServerConfig {
    name: "fs".into(),
    command: "npx".into(),
    args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()],
    env: Default::default(),
    cwd: None,
}).await?;
let exec = McpToolExecutor::new();
let tool_names = exec.add_server(server).await?; // e.g. ["mcp_fs_read_file", ...]
// exec implements ToolExecutor: call_tool routes by mcp_{server}_{tool}
```

Client-side API surface (re-exported from `car-engine/src/lib.rs`):

| Item | Signature / behavior |
|------|----------------------|
| `McpServerConfig` | `{ name, command, args: Vec<String>, env: HashMap, cwd: Option<String> }` |
| `McpServer::start(config)` | `-> Result<Self, String>`; spawns the process, sends `initialize` + `notifications/initialized` (clientInfo name `"car-runtime"`) |
| `McpServer::list_tools()` | `-> Result<Vec<McpToolInfo>, String>`; calls `tools/list` |
| `McpServer::call_tool(name, arguments: Value)` | `-> Result<Value, String>`; calls `tools/call`, extracts text content blocks |
| `McpServer::shutdown()` / `name()` | kill the child / display name |
| `McpToolInfo` | `{ name, description: Option, input_schema: Option }` (`#[serde(rename="inputSchema")]`) |
| `McpToolExecutor::new()` / `.with_fallback(Arc<dyn ToolExecutor>)` | construct, optionally chaining a non-MCP executor |
| `McpToolExecutor::add_server(McpServer)` | `-> Vec<String>` of `mcp_{server}_{tool}` names |
| `McpToolExecutor::tool_schemas()` | `-> Vec<(String, car_ir::ToolSchema)>` for the planner |
| `McpToolExecutor::shutdown_all()` | tear down all registered servers |

> **Client-side gotchas.**
> - `add_server` registers **both** the canonical `mcp_{server}_{tool}` name **and** the bare tool name in `tool_routes`. Bare names from two servers can collide (last writer wins) — prefer the namespaced name.
> - The client reads exactly **one response line per request** (`read_line`), assuming one-JSON-RPC-message-per-line framing. It is a synchronous request/response client and does not handle interleaved server notifications on the same stream.
> - Tools surfaced to the planner via `tool_schemas()` default to `idempotent=false`, `cache_ttl_secs=None`, `rate_limit=None`, and a missing `inputSchema` defaults to `{"type":"object"}`. Set these deliberately if your planner relies on them.
> - Don't confuse identities: as an MCP *client* CAR sends clientInfo name `"car-runtime"`; as an MCP *server* CAR reports serverInfo name `"car-mcp"`.

---

### CAR's MCP URL Injected into External Agentic CLIs

When the daemon spawns an external agentic CLI (the *third kind of agent*), it injects its own HTTP MCP endpoint (`http://<bound>/mcp`, installed earlier via `install_mcp_url`) so that the external agent's tool calls route back through CAR's policy pipeline and shared memgine. The two CLIs get it differently (`car-external-agents/src/runner.rs`):

```rust
// Claude Code (--mcp-config JSON):
// {"mcpServers":{"car":{"type":"http","url":endpoint}}}
// Codex (-c override):
let value = format!(r#"{{type="http",url="{}"}}"#, endpoint);
args.push("-c".to_string());
args.push(format!("mcp_servers.car={}", value));
```

- **Claude Code** — `build_mcp_config_json(endpoint)` produces `{mcpServers:{car:{type:http,url}}}`, passed via `--mcp-config`.
- **Codex** — `build_codex_args` injects `-c mcp_servers.car={type="http",url="..."}`.

This is what closes the loop: an external CLI's tool call hits CAR's MCP endpoint → routes through `Server::handle` → shares the daemon's engine → is governed by the same capability/policy layers as a native CAR agent.

---

### Quick reference — commands

```bash
car-mcp-server                            # stdio MCP server binary (one client/process, in-memory engine)
car-server --mcp-bind 127.0.0.1:9102      # daemon HTTP-streamable MCP endpoint (default bind)
car-server --mcp-bind disabled            # opt out of MCP HTTP endpoint
CAR_MCP_BIND=0.0.0.0:9102 car-server      # env equivalent of --mcp-bind
curl http://127.0.0.1:9102/mcp/health     # MCP HTTP liveness probe
tail -f ~/Library/Logs/Claude/mcp-server-car.log   # Claude Desktop MCP server logs (stderr)
```

**Navigation:** server dispatcher `car-rs/crates/car-mcp/src/server.rs`; static schemas `car-rs/crates/car-mcp/src/schemas.rs`; stdio transport `car-rs/crates/car-mcp/src/transport.rs`; stdio binary `car-rs/crates/car-mcp-server/src/main.rs`; HTTP transport `car-rs/crates/car-server-core/src/mcp.rs`; external-MCP client `car-rs/crates/car-engine/src/mcp.rs`; external-CLI injection `car-rs/crates/car-external-agents/src/runner.rs`; daemon wiring `car-rs/crates/car-server/src/main.rs`.

---

## Contributed & Portable Agents: Bundles, Registry, Lifecycle & Daemon

Everything in this section describes CAR's **second and third kinds of agent**. The first kind — an in-process, proposal-driven agent you author against the FFI/IR — runs *inside* the daemon and is covered elsewhere in this guide. This section is about agents that are *packaged and supervised as separate processes*, or *discovered already-installed on the host*:

| Kind | What it is | Packaging | Lifecycle owner | Authoring surface |
|------|-----------|-----------|-----------------|-------------------|
| **(2) Contributed / lifecycle agent** | A portable single agent a third party ships as a `manifest.toml` + a binary, supervised as a long-running child process | `manifest.toml` (+ binary, or `binary_url`) | CAR's `Supervisor` (`~/.car/agents.json` / `~/.car/agents/<id>/manifest.toml`) | `car-bundle` manifest schema + `agents.*` JSON-RPC |
| **(3) External agentic CLI** | A caller-installed agentic CLI (Claude Code `claude`, Codex `codex`, Gemini `gemini`) the daemon discovers on `$PATH` and spawns **per task** | nothing — already installed | the CLI's own subscription/auth; CAR does **not** own its lifecycle | `agents.*_external` JSON-RPC; never auto-routed |

> **Daemon-first is mandatory.** Since v0.8 every FFI binding is a thin WebSocket client to a singleton `car-server`, which must be running first (reached via `CAR_DAEMON_URL` / `CAR_AUTH_TOKEN`). All install, lifecycle, and detection operations in this section are surfaced over the WebSocket `agents.*` namespace; the NAPI/PyO3 functions (`agents_install`, `agents_start`, `agents_list_external`, …) are thin proxies into the same daemon-shared state. **Start the daemon before you install or invoke anything.**

---

### 1. Contributed agents: `manifest.toml` is the entire integration surface

A contributed agent is a portable single agent that third parties ship to CAR. The runtime **adopts the agent without recompiling `car-server`** — the manifest is the whole integration. The schema lives in `car-rs/crates/car-bundle/src/lib.rs` (the `AgentManifest` struct); `car-bundle` is a pure-data, no-runtime crate that owns the manifest schema, single-file canonicalization, and ed25519 sign/verify.

The manifest is one TOML file with these blocks:

| Block | Struct | Purpose |
|-------|--------|---------|
| `[agent]` | `AgentIdentity` | identity: `id`, `name`, `namespace`, `version`, `description`, `license`, `homepage` |
| `[publisher]` | `PublisherInfo` | `key_id` (base64 ed25519 pubkey), `signature` (base64 ed25519 over canonicalized manifest) |
| `[runtime]` | `RuntimeRequirements` | `car_min_version` (bare semver = `>=`), `bundle_format_version` (default `1`) |
| `[lifecycle]` | `LifecyclePolicy` | `stateful`, `persistence`, `default_inference_complexity` |
| `[transport]` | `TransportSpec` | how to run it — `kind = "external_process"` or `"pure_data"` |
| `[capabilities]` | `CapabilityDeclarations` | `required` / `optional` / `denied` namespaced lists |

#### `[agent]` and `[runtime]` field reference

| Field | Type | Notes |
|-------|------|-------|
| `agent.id` | `String` (required) | supervisor-local handle; **filename-safe** |
| `agent.name` | `String` (required) | display name |
| `agent.namespace` | `Option<String>` | |
| `agent.version` | `Option<String>` | semver |
| `agent.description` / `agent.license` / `agent.homepage` | `Option<String>` | |
| `runtime.car_min_version` | `Option<String>` | bare semver interpreted as `>=` (cargo-style req also accepted) |
| `runtime.bundle_format_version` | `u32` | defaults to `1` |

---

### 2. Transports: `external_process` (shipped) vs `pure_data` (draft)

`TransportSpec` is a tagged enum (`#[serde(tag = "kind", rename_all = "snake_case")]`) with two variants: `external_process` and `pure_data`.

> **Use `external_process` today.** `pure_data` manifests are written to disk by the phase-1 supervisor but are **NOT yet loaded into the runtime/memgine** — that integration is a later phase.

`ExternalProcessTransport` (the `[transport]` block when `kind = "external_process"`):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `command` | `Option<String>` | — | **absolute path** to the executable |
| `sha256` | `Option<String>` | — | hex digest of the binary |
| `binary_url` | `Option<String>` | — | `https://` URL; **mutually exclusive with `health_url`** |
| `health_url` | `Option<String>` | — | remote service; supervisor pings, does not spawn |
| `args` | `Vec<String>` | `[]` | |
| `cwd` | `Option<PathBuf>` | — | |
| `env` | `BTreeMap<String,String>` | — | |
| `restart` | `RestartPolicy` | `on_failure` | `never` \| `on_failure` \| `always` |
| `max_restarts` | `u32` | `10` | |
| `backoff_secs` | `u64` | `5` | floor for exponential backoff |
| `auto_start` | `bool` | `false` | spawn on install **and** on every `car-server` boot |
| `token` | `String` | `""` | minted at install |

#### Three `external_process` sub-shapes

1. **Local binary + sha256** — `command` points at an absolute path; install verifies the file in place.
2. **`binary_url` + sha256** — publisher hosts an `https://` binary; install fetches via reqwest, verifies the digest, writes to `~/.car/agents/<id>/bin/<basename>`, `chmod +x` on POSIX, and rewrites `command` to the local path.
3. **Remote service** — set `health_url` instead of `command`; the supervisor doesn't spawn anything, just tracks the manifest and pings the URL (the operator owns lifecycle). `is_remote_service()` is true when `health_url` is set and `command` is unset.

> `http_service` is **not** a distinct transport kind — it's folded into `external_process` with `health_url` for v1. `binary_url` and `health_url` are mutually exclusive.

#### Capability negotiation (`required` / `optional` / `denied`)

Authors write against host-advertised capabilities, **not platforms**. Each list is a `BTreeMap<String, Vec<String>>` (namespace → feature list):

- `[capabilities.required]` — install **fails closed** if the host doesn't advertise *all* of them.
- `[capabilities.optional]` — used when available; misses are reported in the install output (`missing_optional`) and the agent degrades gracefully.
- `[capabilities.denied]` — CAR's policy engine blocks the call **even if a tool slipped into the agent's code**.

Capability namespaces (v1, additive within `bundle_format_version = 1`): `inference.*` (text-generation, embedding, classification, tool-use, extended-thinking, vision), `storage.*` (persistent-kv, persistent-graph, persistent-journal, temporary), `tools.*` (email-send/read, calendar-read/write, contacts-read/write, location, notifications, clipboard, filesystem-read/write, shell-exec, browser, voice-tts/voice-stt, nlp.\*, vision.\*, audio.classify, translate.text), `a2ui.*`, `a2a.*`, `network.*` (arbitrary-http, host-api, none), `sensors.*`.

#### Lifecycle statefulness (`lifecycle.persistence`)

Three phases; bundles may declare any value from day one:

| Value | Meaning | Status |
|-------|---------|--------|
| `session` | memory exists only for the run, wiped on exit | Phase 1 — ships first |
| `host` | memory persists on the device that ran it (phone and laptop have separate graphs) | Phase 2 |
| `synced` | one logical memory graph CRDT-merged across devices | Phase 3 — not built |

A `synced` bundle on a phase-2 runtime falls back to `host` with a warning. The undeclared default leans to `session`.

#### Full shipped manifest example (`car-rs/examples/contrib-template/manifest.toml`)

```toml
[agent]
id = "contrib-template"          # supervisor-local handle, filename-safe
name = "Contributed Agent Template"
namespace = "examples"
version = "0.1.0"
description = "Minimal example showing the contributed-agent manifest shape."
license = "Apache-2.0"

# [publisher] is added by `car publish` (phase 5+). Local-install
# manifests can leave it unset; the supervisor warns about an
# unsigned install but proceeds.

[runtime]
car_min_version = "0.8.0"
bundle_format_version = 1

[lifecycle]
stateful = false
persistence = "session"            # session | host | synced
default_inference_complexity = "low"

[transport]
kind = "external_process"
# command = "/usr/local/bin/contrib-template"
# sha256 = "abc123…"
# binary_url = "https://github.com/parslee/contrib-template/releases/download/v0.1.0/contrib-template-darwin-arm64"
command = "/absolute/path/to/contrib-template/agent.sh"
args = []
env = { CONTRIB_TEMPLATE_MODE = "demo" }
restart = "never"                  # never | on_failure | always
max_restarts = 1
backoff_secs = 1
auto_start = false                 # flip to true to spawn on car-server boot

[capabilities.required]
storage = ["persistent-kv"]

[capabilities.optional]
a2ui = ["render_report.subscribe"]
a2a = ["message_send"]

[capabilities.denied]
tools = ["shell-exec", "filesystem-write"]
network = ["arbitrary-http"]
```

The "binary" the supervisor spawns can be anything executable — the template ships a trivial shell script (`car-rs/examples/contrib-template/agent.sh`):

```bash
#!/bin/sh
# Trivial demo agent — prints a startup line and exits.
# Real agents would loop, hit the daemon over WS, etc.
echo "[contrib-template] hello from ${CONTRIB_TEMPLATE_MODE:-default}"
```

> **`command` must be an absolute path.** The sandbox rejects `$PATH`-style lookups and relative paths. The template ships `/absolute/path/to/contrib-template/agent.sh` as a placeholder you must edit — and you must `chmod +x agent.sh` first.

---

### 3. Installing and running a contributed agent

Compute the sha256 with `shasum -a 256 path/to/binary` (macOS/Linux), then:

```bash
car daemon --port 9100          # start the supervisor daemon in a separate shell first
cd my-agent/                    # directory containing manifest.toml
car install .                   # parse, verify binary, run install_check, adopt
car ls                          # list installed agents (id / status / pid / command)
car inspect <id>                # manifest + runtime status
car start <id>                  # spawn now (or set auto_start = true to spawn on install + boot)
car tail-log <id>               # last N stdout/stderr lines (-n, default 100)
car uninstall <id>              # stop, remove from supervisor, reap ~/.car/agents/<id>/, idempotent
```

CLI command reference:

| Command | Aliases | Behavior |
|---------|---------|----------|
| `car install .` | — | parses via `AgentManifest::from_toml_str`, verifies binary (fetch + sha256 if `binary_url`, else verify the file at `command` in place; warns if neither), sends `agents.install`, daemon runs `install_check`, adopts on success, returns `{report, agent}` |
| `car ls` | `car agents` | list every installed agent; `--json` for tooling |
| `car inspect <id>` | — | one agent's manifest + runtime status; `--json` |
| `car start <id>` | — | start an installed spawnable agent |
| `car stop <id>` | — | stop a running installed agent |
| `car restart <id>` | — | stop then start |
| `car tail-log <id>` | `car logs` | last N stdout/stderr lines; `--json` emits `{"lines":[...]}` |
| `car uninstall <id>` | — | stop, remove, reap manifest dir + legacy `agents.json` entry; idempotent |
| `car agent-start <id>` | — | README variant that invokes `agents.start` over WS |

**What adoption does (the daemon side).** On install the daemon writes `~/.car/agents/<id>/manifest.toml`, mirrors it into the legacy `agents.json` (dual-write during the phase-1 migration), and **mints a per-agent token**. The spawned child gets two env vars injected — `CAR_DAEMON_URL` (daemon WS URL) and `CAR_AGENT_TOKEN` — plus `CAR_AGENT_ID`. The child calls `session.auth { agent_id, token }` to bind its WS connection (#169). Once it does, `agents.list` shows `attached: true`. stdout/stderr are captured to `~/.car/logs/<id>.{stdout,stderr}.log`.

> **`install_check` is fail-closed on required capabilities and `car_min_version`.** `HostCapabilities::daemon_default(car_version)` advertises inference/storage/a2ui/a2a features. The check: `car_min_version` must be satisfied by the host `car_version`; every `capabilities.required[ns][feat]` must be advertised (else error); optional misses are returned as `report.missingOptional` (non-blocking). Signed manifests are verified via `car_bundle::verify_signature` — but verification is currently **warn-but-not-reject** (phase 2/3): a tampered/unverifiable signed manifest still loads and installs, logging only a warning.

---

### 4. Signing a manifest with ed25519

The signature in `[publisher]` covers the **canonicalized single `manifest.toml` file**, not a multi-file bundle (that's a later phase). Canonicalization clears `publisher.signature`, serializes to **JSON** (not TOML — TOML has no spec-mandated canonical form; sorted keys via `BTreeMap` give a deterministic shape), strips whitespace, UTF-8 + LF.

```rust
use car_bundle::{AgentManifest, sign_manifest, verify_signature};
use ed25519_dalek::SigningKey;
use rand_core::OsRng;

// Generate a publisher key (do this once, keep the secret).
let key = SigningKey::generate(&mut OsRng);

// Sign your manifest in place.
let text = std::fs::read_to_string("manifest.toml")?;
let mut manifest = AgentManifest::from_toml_str(&text)?;
sign_manifest(&mut manifest, &key)?;

// Write the signed manifest back.
std::fs::write("manifest.toml", manifest.to_toml_string()?)?;

// Anyone can verify with the publisher's public key (carried in
// `manifest.publisher.key_id`):
verify_signature(&manifest)?;
```

Key facts:

- `sign_manifest` sets `publisher.key_id` (base64 32-byte ed25519 pubkey, ~44 chars) **BEFORE** computing the canonical bytes — `key_id` is part of the signed payload, while `signature` is cleared from it. A previous draft set it after and the signature failed to verify (caught by the `sign_then_verify_round_trip` test). Signing is idempotent with the same key (ed25519 is deterministic).
- `verify_signature` re-canonicalizes and checks against the embedded `key_id`. A manifest with no `[publisher]` block is treated as unsigned → `BundleError::PublisherMissing`.
- **Unsigned manifests are accepted for local install with a warning**; signing is required for registry distribution.
- The signature covers `[agent]`, `[runtime]`, `[lifecycle]`, `[transport]` (including `command` + `sha256` + `binary_url`), and `[capabilities]`. It does **NOT** cover the bytes behind a `health_url` (operator trust, not publisher trust), nor the behavior of verified executable code — capability + policy enforcement, not the signature, bounds the blast radius. A malicious bundle from a trusted publisher is bounded only by the capability model.

There is **no `car publish` CLI yet** — use `cargo run --example sign-manifest` or a hand-rolled script.

#### `car-bundle` API surface

| Function | Signature / behavior |
|----------|---------------------|
| `AgentManifest::from_toml_str(&str)` | `-> Result<Self, BundleError>`; parses, does **not** verify signature |
| `AgentManifest::to_toml_string(&self)` | `-> Result<String, BundleError>` via `toml::to_string_pretty` |
| `AgentManifest::is_pure_data(&self)` | `-> bool` |
| `AgentManifest::is_remote_service(&self)` | `-> bool`; true when `external_process` has `health_url` set and `command` unset |
| `canonical_manifest_bytes(&AgentManifest)` | `-> Result<Vec<u8>, BundleError>`; the bytes that get signed |
| `manifest_digest_hex(&AgentManifest)` | `-> Result<String, BundleError>`; SHA-256 hex of canonical bytes (64 chars) |
| `sha256_hex(&[u8])` | `-> String`; used to verify `binary_url` fetches against `transport.sha256` |
| `verify_sha256(&[u8], expected_hex)` | `-> Result<(), BundleError>`; case-insensitive, errors (not bool) so it can name expected/actual |
| `sign_manifest(&mut, &SigningKey)` | `-> Result<(), BundleError>` |
| `verify_signature(&AgentManifest)` | `-> Result<(), BundleError>` |

`BundleError` variants: `InvalidToml(String)`, `InvalidJson(String)`, `Validation(String)`, `SignatureInvalid(String)`, `KeyMalformed(String)`, `PublisherMissing`, `Io(std::io::Error)`.

---

### 5. The supervisor: declarative lifecycle in `car-registry`

The `car-registry` crate (`car-rs/crates/car-registry/`) provides two sibling concerns: an observe-only file registry and a process supervisor.

#### `Supervisor` (declarative lifecycle, car-releases#27)

Reads `~/.car/agents.json` (plus the newer per-agent `~/.car/agents/<id>/manifest.toml` layout), spawns each entry as a child process, and keeps it running per its `RestartPolicy`. The manifest is the source of truth, written through atomically. State transitions are idempotent (`start` on a running agent is a no-op, `stop` on a stopped one too). The supervisor is cheap to clone (state behind `Arc<RwLock>`).

Core methods:

| Method | Behavior |
|--------|----------|
| `Supervisor::user_default()` | `~/.car/agents.json` + `~/.car/agents/` + `~/.car/logs/`; **acquires the singleton lock** |
| `Supervisor::with_paths(manifest_path, log_dir)` | explicit paths; dual-read + mirror migration; acquires lock |
| `Supervisor::list_from_manifest(path)` / `health_from_manifest(path)` | read-only, **no lock** |
| `upsert(spec: AgentSpec)` | validates id + command, mints/retains token, persists; **does NOT start** |
| `install_manifest(manifest, &HostCapabilities)` | `-> Result<(InstallCheckReport, Option<ManagedAgent>)>`; **DOES auto-start** when the manifest's `auto_start` is true |
| `start(id)` | spawn if not Running/Starting; resets `restart_count` |
| `stop(id, signal: StopSignal)` | `Term` (grace then SIGKILL) or `Kill`; `NotFound` on unknown id |
| `restart(id)` | stop then start |
| `remove(id)` | stops first; `Ok(false)` if nothing matched |
| `start_all()` | spawn all `auto_start` agents; skips an id with a live pid in `~/.car/run/<id>.supervisor.pid` (CAR's record) or `~/.car/run/<id>.pid` (the agent's own); returns spawned ids |
| `tail_log(id, n)` | last `n` lines of combined stdout + stderr |
| `set_default_child_env(entries)` | replace the default child-env table |
| `agent_token(id)` / `validate_agent_token(id, token)` | the latter is a constant-time compare |

`AgentSpec` fields: `id`, `name`, `command`, `args` (default `[]`), `cwd?`, `env` (`BTreeMap`), `restart` (`RestartPolicy`, default `OnFailure`), `max_restarts` (default `10`), `backoff_secs` (default `5`), `auto_start` (default `false`), `token`.

`ManagedAgent` fields: `spec` (flattened), `status`, `pid?`, `last_exit_code?`, `restart_count`, `started_at?`.

```rust
use car_registry::supervisor::{AgentSpec, RestartPolicy, Supervisor};
let supervisor = Supervisor::user_default()?;
supervisor.upsert(AgentSpec {
    id: "trader".into(),
    name: "Trader".into(),
    command: "/usr/local/bin/node".into(), // absolute path; $PATH lookup + /tmp rejected
    args: vec!["/Users/me/git/trader/index.js".into()],
    cwd: Some("/Users/me/git/trader".into()),
    env: Default::default(),
    restart: RestartPolicy::OnFailure,
    max_restarts: 10,
    backoff_secs: 5,
    auto_start: true,   // default is false; opt in to boot-time start
    token: String::new(), // empty => mint a fresh per-agent token
}).await?;
supervisor.start_all().await;
```

#### Restart policy & backoff

`RestartPolicy`: `Never` (run once), `OnFailure` (default — restart only on non-zero/killed exit; a clean exit stops), `Always` (restart even on clean exit). After `max_restarts` (default `10`) consecutive failures the agent is marked `Errored`. `backoff_secs` (default `5`) is the floor for an exponential, jittered delay (`1 << (attempt-1)`, capped, plus up to ⅛ jitter). A manual `start` resets `restart_count`.

#### Two distinct `AgentStatus` enums — do not conflate

| Enum | Variants | Meaning |
|------|----------|---------|
| `car_registry::AgentStatus` (registry, self-reported) | `Running` \| `Idle` (default) \| `Errored` \| `Stopping` | what the agent reports about itself |
| `supervisor::AgentStatus` (process view) | `Stopped` (default) \| `Starting` \| `Running` \| `Backoff` \| `Errored` | the supervisor's process-level view |

---

### 6. Supervisor safety: lock, command validation, tokens, boot

- **Single-owner cross-process lock (#44).** `with_paths` acquires an OS-level exclusive advisory lock on `<manifest_path>.lock` **before any state mutation**, held for the supervisor's lifetime. A second `car-server` that can't take it fails fast with `SupervisorError::AlreadyRunning(lock_path)` and falls back to **observe-only mode** — it answers `agents.list` / `agents.health` by reading the manifest directly via `list_from_manifest` / `health_from_manifest` (runtime fields at defaults, entries decorated `attached: false`), and rejects mutations. This prevents two daemons double-spawning every declared agent against shared external state (broker accounts, state dirs). Lock files are intentionally **not** unlinked on drop (that would race a new acquirer).

  To run a second daemon without contention, point it at a different manifest: `car-server --agents-manifest <path>` (or the `CAR_AGENTS_MANIFEST` env var).

- **Strict command validation (`validate_command`, 2026-05 security audit).** Enforced at **upsert time** (not spawn): `command` must be a non-empty **absolute path**, no `..` segments, **not** under world-writable scratch dirs (`/tmp`, `/private/tmp`, `/var/tmp`, `/dev/shm`), and must exist as a regular file with an execute bit set (unix). `$PATH` lookup is rejected outright. This was the load-bearing capability in a drive-by-RCE chain.

- **`interpreter` sugar (#171).** `resolve_interpreter("node" | "python" | "deno" | …)` walks `$PATH` once at upsert, validates the resolved path with `validate_command`, and **freezes the absolute path** into `command`. Bare program name only (rejects path-shaped names and `..`). Surfaced on the wire as the optional `interpreter` field on `agents.upsert`.

- **Per-agent auth token (#169).** On first upsert the supervisor mints a 43-char base64url-no-pad (32 random bytes) token (`mint_agent_token`). **Token policy:** an empty token on upsert retains the existing one (or mints one if none); rotation requires explicitly passing a new non-empty value. Injected into the child env as `CAR_AGENT_TOKEN` (`CAR_AGENT_ID` always set). `validate_agent_token` does a constant-time compare against the `session.auth { token, agent_id }` the child sends.

- **`auto_start` on boot (defaults to FALSE since 2026-05).** Operators must opt in per-agent — the prior default-on combined with unauthenticated WS + unvalidated command to land an attacker's binary at every login. `Supervisor::start_all()` spawns every `auto_start` agent not already Running/Starting; `car-server` main calls it once at boot. It **skips** any agent with a live pid in either of two records (a double-spawn guard; this prevented real production damage of two traders on one account): `~/.car/run/<id>.supervisor.pid`, which the supervisor writes at spawn and removes when the child exits under its watch (car#732, so the guard covers every agent rather than only those that opted in by writing a file themselves — 1 of 5 did, and an orphan from the other four kept its port while every respawn died on bind with no diagnostic), and `~/.car/run/<id>.pid`, which an agent may write for itself and which catches an instance started entirely outside CAR.

> **`~/.car/run/<id>.pid` is yours; `~/.car/run/<id>.supervisor.pid` is CAR's.** Use the plain path for your own exclusive lock if you want one — CAR reads it and will refuse to double-spawn on it, but never writes, truncates or removes it. Through 0.48 CAR wrote its own record there, and a singleton agent that read the file as its lock found a live pid that was *itself* (put there by the supervisor that had just spawned it), concluded another instance owned the lock, and exited — making it unstartable under supervision (car#931). Do not write `<id>.supervisor.pid`; treat the `.supervisor` infix as reserved.
>
> Because CAR will not unlink your file, **remove it yourself on clean shutdown**. One left behind by a killed agent stays forever, and if the OS later recycles that pid to an unrelated process the guard reads it as a live instance and parks your agent in `Backoff` until someone deletes the file by hand.

- **Child env injection (#172).** `set_default_child_env` replaces a table exported into every child **before** per-spec `spec.env` is merged on top (per-spec wins). At boot `car-server` injects `CAR_DAEMON_URL` (`ws://host:port`) and `CAR_AUTH_TOKEN` (per-launch token when auth is enabled), so each language SDK reads two env vars and connects — no platform path lookup:

  ```rust
  // default_env (CAR_DAEMON_URL / CAR_AUTH_TOKEN) first so spec.env wins on conflict
  for (k, v) in default_env { cmd.env(k, v); }
  cmd.env("CAR_AGENT_ID", &spec.id);
  if !spec.token.is_empty() { cmd.env("CAR_AGENT_TOKEN", &spec.token); }
  for (k, v) in &spec.env { cmd.env(k, v); }
  cmd.kill_on_drop(true);
  ```

- **Dual-read manifest migration (#182).** `with_paths` loads from **both** legacy `~/.car/agents.json` and the new `~/.car/agents/<id>/manifest.toml` directory; the new layout overrides legacy on conflict, legacy-only entries are mirrored at boot (idempotent), and a single `tracing::warn!` fires when the legacy file has entries. The legacy file stays the read-source-of-truth for one more minor release before removal. `pure_data` and `health_url`-only manifests are tracked on disk but **NOT spawned** (`to_agent_spec` errors); `agents.install` returns `agent: null` for them.

`SupervisorError` variants: `InvalidId`, `InvalidCommand{command,reason}`, `NotFound`, `NoHomeDir`, `Io`, `Json`, `Other(String)`, `AlreadyRunning(PathBuf)`.

---

### 7. The observe-only file registry (`AgentRegistry`, #111)

A separate, daemon-free, file-based discovery mechanism: each running agent writes `~/.car/registry/<name>.json` (atomically, temp + rename) so UI surfaces (menubar/tray) can list agents and link to their dashboards. **No process management** — every op is a synchronous filesystem call.

```rust
use car_registry::{AgentEntry, AgentRegistry, AgentStatus};
let registry = AgentRegistry::user_default()?;
registry.register(&AgentEntry::new("trader-paper", "http://127.0.0.1:8731"))?;
for entry in registry.list()? {
    println!("{} → {}", entry.name, entry.dashboard_url);
}
registry.heartbeat("trader-paper")?;
registry.reap_stale(60)?;
```

| Method | Behavior |
|--------|----------|
| `user_default()` / `open(dir)` | open `~/.car/registry/` (creating it) or a specific dir |
| `register(&AgentEntry)` | atomic write of `<name>.json` |
| `heartbeat(name)` | `-> Result<bool>`; bump `last_heartbeat_at`; `Ok(false)` if not registered |
| `unregister(name)` | remove entry, no-op if absent |
| `list()` | sorted by name; **silently skips corrupt files** |
| `reap_stale(max_age_secs)` | delete entries older than the threshold, return reaped names |

`AgentEntry::new(name, dashboard_url)` + builder `with_display_name` / `with_port` / `with_pid` / `with_status`. Liveness is heartbeat-based: agents heartbeat every ~20s; the menubar reaps entries older than the threshold (default 60s = two missed heartbeats). Names must be filename-safe (alphanumeric + `-_.`); `.`, `..`, and path separators are rejected. `RegistryError`: `InvalidName(String)` \| `NoHomeDir` \| `Io` \| `Json`.

---

### 8. Lifecycle over WebSocket JSON-RPC (`agents.*`)

All lifecycle ops are surfaced over WS under the `agents.*` namespace (dispatcher in `car-rs/crates/car-server-core/src/handler.rs`) and mirrored in NAPI/PyO3 as in-process functions that share the daemon's state.

| Method | Params | Returns |
|--------|--------|---------|
| `agents.list` | `{}` | `[ManagedAgent + attached + session_id?]` — **lifecycle agents only** |
| `agents.upsert` | `AgentSpec` + optional `interpreter` | `ManagedAgent` |
| `agents.install` | `AgentManifest` | `{report:{missingOptional:[{namespace,feature}]}, agent: ManagedAgent\|null}` |
| `agents.health` | `{}` | `[{id, command, ok, reason?}]` |
| `agents.start` | `{id}` | `ManagedAgent` |
| `agents.stop` | `{id, signal?: "term"\|"kill"}` | `ManagedAgent` |
| `agents.restart` | `{id}` | `ManagedAgent` |
| `agents.remove` | `{id}` | `{removed: bool}` |
| `agents.tail_log` | `{id, n?: number (default 100)}` | `{lines:[string]}` |

```json
{
  "jsonrpc": "2.0",
  "method": "agents.upsert",
  "params": {
    "id": "trader",
    "name": "Trader",
    "interpreter": "node",
    "args": ["/Users/me/git/trader/index.js"],
    "restart": "on_failure",
    "auto_start": true
  },
  "id": 1
}
```

`agents.list` result shape:

```json
[{
  "id": "trader", "name": "Trader", "command": "/usr/local/bin/node",
  "args": ["..."], "restart": "on_failure", "max_restarts": 10, "backoff_secs": 5,
  "auto_start": true,
  "status": "running", "pid": 4821, "last_exit_code": null,
  "restart_count": 0, "started_at": 1748000000,
  "attached": true, "session_id": "client-abc"
}]
```

NAPI/PyO3 standalone equivalents (in-process, daemon-shared via WS): `agents_list`, `agents_health`, `agents_upsert(spec_json)`, `agents_install(manifest_json)`, `agents_remove(id)`, `agents_start(id)`, `agents_stop(id, signal?)`, `agents_restart(id)`, `agents_tail_log(id, n?)`.

> **`upsert` does NOT start the agent** — call `start`, or set `auto_start: true` and wait for the next boot. `install_manifest` *does* auto-start when the manifest's `auto_start` is true. `stop` on an unknown id returns `SupervisorError::NotFound` (an error, not a silent no-op); `start`/`restart`/`tail_log` also validate the id first. `tail_log` interleaves stdout and stderr by **file order, not timestamp** — relative stderr/stdout ordering is not preserved across the two files.

---

### 9. Daemon-as-default-runtime & host control protocol

**Direction (v1.0 proposal, `docs/proposals/daemon-as-default-runtime.md`):** stop shipping CAR as ~37 embeddable crates; make consumers attach to one always-on `car-server` daemon over WS. Discovery via a per-user Unix socket `${XDG_RUNTIME_DIR:-$HOME/.car/run}/car-server.sock` (`CAR_SERVER_SOCKET` overrides), with an auto-spawn fallback unless `CAR_AUTOSTART = 0`. NAPI/PyO3 collapse to thin WS clients; the published Rust surface drops to 0-1 crates (every workspace member becomes `publish = false`). **Lifecycle agents are cited as the already-established "always-on services sharing the daemon" pattern** that motivates this direction.

**Host control protocol (`host.*` + `agents.chat`, `docs/host-protocol.md`).** `car-server` exposes a host-facing JSON-RPC surface over the same WS so OS integrations provide one shared control UI:

| Method | Purpose |
|--------|---------|
| `host.subscribe` | returns agents/approvals/events and streams `host.event` notifications |
| `host.agents` / `host.events {limit}` / `host.approvals` | snapshot queries |
| `host.register_agent` / `host.unregister_agent {agent_id}` / `host.set_status` / `host.notify` | mutate host state |
| `host.request_approval` / `host.resolve_approval` | the approval gate |
| `agents.chat {agent_id, prompt, session_id?, stream?, voice_input?, model?}` | issue a chat turn to a named lifecycle agent; a non-empty `model` is a strict per-turn CAR model selection, while omission preserves the agent/adaptive default; returns `{accepted, session_id}` |
| `agents.chat.event {kind: token\|done\|error\|tool_call\|approval_pending}` | streamed tokens |
| `agents.chat.cancel {session_id}` | cancel a streaming turn |

First-party host clients: the SwiftUI **CarHost.app** (macOS menu-bar) and the **`car-host`** terminal CLI:

```bash
car-host list                       # list registered agents over the host protocol
car-host watch                      # stream host events
car-host approve <approval-id>      # / car-host deny <approval-id>
car-host --start-server ...         # start car-server when the WS endpoint is unreachable
```

Both await transport auth (when enabled), exact protocol-v3 negotiation with
the mandatory model-catalog and inference-identity capabilities, then
`host.subscribe`/other host calls on each new WebSocket connection.

> **`DaemonClient` does NOT auto-reconnect** — it is lazy/per-call. On a daemon restart the recv loop ends, in-flight calls return `closed before response`, and the next call lazy-reconnects with no automatic retry. Notification handlers persist across reconnects.

---

### 10. External agentic CLIs (the third kind, `car-external-agents`)

`car-external-agents` discovers caller-installed agentic CLIs on `$PATH` and spawns them **per task**, without owning their lifecycle. The motivation is subscription economics: most users already have these CLIs authenticated against a flat-rate subscription, so CAR runs them through their existing auth instead of forcing an API key. The crate is **daemon-side only**; NAPI/PyO3 reach it through thin proxies, and the canonical surface is the WS `agents.*` namespace.

> **No auto-routing.** CAR **never** silently picks an external agent for a prompt. They run only when explicitly selected (a swarm spec with the `external:` prefix, a host UI selection, or an explicit `agents.invoke_external`). This is a non-goal by design.

#### Three supported adapters

`AdapterId` enum — each adapter is a ~50-line static descriptor in `src/adapters/<tool>.rs`:

| `AdapterId` | `id` (`as_str()`) | binary | `Capabilities` (tool_use / mcp / hooks / sessions / streaming) |
|-------------|-------------------|--------|-----------------------------------------|
| `ClaudeCode` | `claude-code` | `claude` | all five `true` |
| `Codex` | `codex` | `codex` | tool_use + sessions + streaming `true`; mcp + hooks `false` |
| `Gemini` | `gemini` | `gemini` | tool_use + sessions + streaming `true`; mcp + hooks `false` |

#### Detection (Phase 1)

`detect() -> Vec<ExternalAgentSpec>` resolves each adapter binary against `$PATH` (`:`-sep POSIX, `;` Windows), **rejecting world-writable scratch dirs** (`/tmp/`, `/private/tmp/`, `/var/tmp/`, `/dev/shm/` — same denylist as `validate_command`) and non-executable files. It probes `<bin> --version` (2s timeout), parses the first digit-leading token, and **stores the resolved absolute path** so invocation never re-consults `$PATH` (closes a PATH-injection variant). Results are sorted by `id` for deterministic UI ordering; a failed sub-probe degrades a field rather than dropping the entry.

```rust
let specs = car_external_agents::detect().await;
for spec in &specs {
    println!(
        "{} at {} (auth: {:?})",
        spec.display_name,
        spec.binary_path.display(),
        spec.auth_kind
    );
}
```

`ExternalAgentSpec`: `{ id, display_name, binary_path, version: Option<String>, auth_kind, capabilities, detected_at: u64, health: Option<ExternalAgentHealth> }`.

#### Health (Phase 2 ground truth) — and the deprecated `auth_kind`

`auth_kind` (`AuthKind`: `Subscription` \| `ApiKey` \| `Unknown` (default) \| `Unauthenticated`) is **deprecated and advisory only** — inferred from credential-file **shape** (top-level JSON keys, never values). Most modern installs use OS keystores (Keychain/Secret Service/Credential Manager), leaving no file, so it falls through to `Unknown`. **Never make trust decisions on it.**

Prefer the `health` field. `HealthStatus`: `Ready` (the only state that justifies invoking) \| `NotConfigured` \| `Expired` \| `NetworkError` \| `Unknown` (default). 30s in-memory TTL cache, 5s probe timeout. Each tool uses its own status command:

| Tool | Health command | Signal |
|------|---------------|--------|
| Claude Code | `claude auth status` | JSON `{loggedIn, authMethod, subscriptionType, …}` |
| Codex | `codex login status` | text on stderr ("Logged in using ChatGPT" / "Not logged in"); exits 0 either way |
| Gemini | *(none safe)* | running a status command triggers a browser OAuth flow, so it falls back to credential-file shape — the **weakest** of the three |

`detect_with_health(force: bool)` runs `detect()` plus ground-truth health; `health_one(id, force)` / `health_all(specs, force)` query directly. `ExternalAgentHealth`: `{ id, status, details: Value, reason: Option<String>, checked_at: u64 }`.

#### Per-task invocation (Phase 2)

`invoke(id, task, opts: InvokeOptions) -> Result<InvokeResult, InvokeError>` dispatches by adapter id. Argv per tool:

| Tool | argv |
|------|------|
| Claude Code | `claude -p --output-format stream-json --input-format stream-json --verbose` (+ `--allowed-tools <list>`, `--max-turns N`, `--mcp-config <path>` when set); task written as a stream-json user message on stdin, then stdin closed (EOF) |
| Codex | `codex exec --json --skip-git-repo-check --ephemeral -` (prompt on stdin; + `--cd <dir>`, `-c mcp_servers.car=...`) |
| Gemini | `gemini -p "<task>" --yolo` (text-only, no event stream, auto-accepts) |

`InvokeOptions`: `{ cwd: Option<PathBuf>, allowed_tools: Option<Vec<String>>, max_turns: Option<u32>, timeout_secs: Option<u64>, mcp_endpoint: Option<String> }`.

`InvokeResult`: `{ answer, session_id: Option<String>, turns: u32, tool_calls: u32, tool_uses: Vec<ToolUseRequest>, duration_ms: u64, total_cost_usd: Option<f64>, is_error: bool, error: Option<String> }`.

WS surface:

| Method | Params | Returns |
|--------|--------|---------|
| `agents.list_external` | `{ include_health?: bool }` (default false) | `[ExternalAgentSpec]` — cached snapshot; first call triggers detection |
| `agents.detect_external` | `{ include_health?: bool }` | `[ExternalAgentSpec]` — forces re-detection, updates cache |
| `agents.health_external` | `{ id?: string, force?: bool }` (force default false) | `ExternalAgentHealth` (one id) or `[ExternalAgentHealth]` (all) |
| `agents.invoke_external` | `{ id, task, cwd?, allowed_tools?, max_turns?, timeout_secs?, mcp_endpoint?, stream?, session_id? }` | `InvokeResult` (or an ack + `agents.chat.event` notifications when `stream: true`) |

NAPI (camelCase): `agentsListExternal`, `agentsDetectExternal`, `agentsHealthExternal`, `agentsInvokeExternal`. PyO3 (snake_case): `agents_list_external`, `agents_detect_external`, `agents_health_external`, `agents_invoke_external`. All return JSON strings matching the WS shapes.

> **`agents.list` (lifecycle agents) and `agents.list_external` (external agents) are deliberately separate surfaces** — a host wanting a unified view must call both.

#### The `stream-json` protocol (Claude Code)

Claude Code emits one JSON object per stdout line, discriminated by `type`: `system` (subtype `init`: session_id, model, tools, permission_mode), `assistant` (Anthropic Messages-shaped: text + tool_use blocks + usage), `user` (echo, only with `--replay-user-messages`), `result` (final answer, duration, num_turns, total_cost_usd, is_error), `rate_limit_event`. `StreamEvent::Other` (serde `other` catch-all) and `#[serde(flatten)]` extra maps preserve unrecognized types/fields so upstream additions don't break the parser. `tool_use`/`tool_result` arrive nested inside `assistant.message.content[]`.

```json
{"type":"system","subtype":"init","session_id":"s1","model":"opus","tools":[]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x"}}]},"session_id":"s1","uuid":"u1"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":1500,"num_turns":1,"result":"ok","session_id":"s1","total_cost_usd":0.05}
```

#### Tool execution is observe-only (Phase 2 stage 4a)

The external agent runs its **own** built-in tools (Read/Edit/Bash/…) internally — CAR captures every `tool_use` block into `InvokeResult.tool_uses` + the `tool_calls` count for an audit trail, but does **NOT yet** round-trip them through CAR's policy/validator/eventlog. Full policy gating (stage 4b) requires the **MCP-server route**: when `InvokeOptions.mcp_endpoint` is set, the runner writes a temp `mcp-config.json` pointing the agent at the daemon's `/mcp` endpoint (server name `car`), so CAR-namespace tool calls (`memory_*`, `verify`, `skill_*`) flow through the daemon's policy + shared memgine. MCP injection works for `claude-code` (`--mcp-config`) and `codex` (`-c mcp_servers.car=...`); Gemini 0.1.x has no MCP support.

```json
{
  "mcpServers": {
    "car": {
      "type": "http",
      "url": "http://127.0.0.1:9102/mcp"
    }
  }
}
```

> `mcp_endpoint` is **auto-filled** from the daemon's bound MCP URL when omitted; pass `mcp_endpoint: ""` (empty string) to **opt out** — the empty string is meaningful, not a no-op.

#### Multi-agent bridge (Phase 3): mix external CLIs into a swarm

`ExternalAwareRunner::new(inner: Arc<dyn AgentRunner>)` wraps any in-process runner; any `car_multi::AgentSpec` whose `name` starts with `external:` (`EXTERNAL_PREFIX`) is dispatched to `crate::invoke`, everything else passes through. So `run_swarm` / `run_pipeline` / `run_supervisor` mix external CLIs and in-process runners with no special-case orchestration code.

```rust
use std::sync::Arc;
use car_external_agents::ExternalAwareRunner;

let host_runner: Arc<dyn car_multi::AgentRunner> = Arc::new(MyChatRunner);
let runner: Arc<dyn car_multi::AgentRunner> =
    Arc::new(ExternalAwareRunner::new(host_runner));
// run_swarm now accepts both in-process and external specs (name "external:claude-code").
```

Per-invocation options ride on `AgentSpec.metadata` (read by `extract_invoke_options`):

| metadata key | type | → `InvokeOptions` field |
|--------------|------|------------------------|
| `cwd` | string | `cwd` |
| `allowed_tools` | string array | `allowed_tools` |
| `max_turns` | uint | `max_turns` (falls back to `spec.max_turns` when unset) |
| `timeout_secs` | uint | `timeout_secs` |
| `mcp_endpoint` | string | `mcp_endpoint` (`""` opts out) |

#### External-agent gotchas

- **`allowed_tools = Some(vec![])` (empty list) DENIES every tool** (passes an empty `--allowed-tools` arg); `allowed_tools = None` uses the binary's default policy. These are **not** the same.
- `timeout_secs` defaults to **300s** (`DEFAULT_TIMEOUT_SECS`), clamped to a **3600s** max (`MAX_TIMEOUT_SECS`) and a 1s min.
- **Cost discipline:** every live `claude-code` invocation burns subscription quota (~30K cache-creation tokens per cold call). `total_cost_usd` is the **would-be** API cost for transparency only — subscription users don't actually pay it. Do **not** regenerate the `protocol.rs` fixtures against live `claude`; real-CLI integration tests are env-gated behind `--ignored`.
- **Gemini is the weakest adapter:** 0.1.x has no JSON-stream output (text-only), ignores `mcp_endpoint` with a tracing warning, and has no safe headless auth-status command, so its health falls back to credential-file shape.
- On macOS, `TMPDIR` resolves to `/var/folders/...` (outside the scratch denylist by design), so the scratch-rejection test self-skips there.

---

### 11. Two documentation scopes — do not conflate

`docs/agent-bundle-spec.md` describes a **DRAFT, not-yet-implemented** multi-file bundle: `manifest.toml` + `identity.md` + `skills.jsonl` + `policies.json` + `facts-seed.jsonl` + `capabilities.toml` + signature, packed as a deterministic `<name>-<ver>.car.tar.gz`. In that vision a (pure-data) bundle declares only *tool capabilities* (hosts wire concrete tools), never tool implementations; inference is host-mediated (no model weights); no runtime code; no secrets (hosts inject via native key store). Draft surfaces include verbs (`summarize`, `transcribe-audio`, `research`, `search-knowledge`, `verify-claim`, `create-note`) dispatched via `invoke_capability(verb, …)` with tie-break `agent_hint > MRU > first-registered`, and draft CLI like `car publish ./my-agent` and `car install parslee/note-taker`.

What **actually shipped** (`car-bundle` phases 1-5, `docs/contributed-agents.md`) is a **single `manifest.toml` driving an `external_process` binary** — the path documented in §1-§4. Do not assume the draft surface exists:

| Don't assume | Reality |
|--------------|---------|
| Multi-file `.car.tar.gz` bundle | DRAFT; `canonical_manifest_bytes` covers only the single `manifest.toml` today |
| `pure_data` loading into the memgine | NOT wired — phase-1 supervisor writes the manifest to disk but doesn't load it |
| `car publish` (sign + upload in one step) | **cut from v1**; use `cargo run --example sign-manifest` |
| `car install <namespace>/<name>` registry refs | NOT shipped — point `command` at a local file or put the URL in `binary_url` directly |
| `translate-text` / `.system.translate` verb | **cut from v1** |
| MRU agent-verb pinning across restarts | in-memory only; resets to "first-registered wins" on restart — hosts must persist and re-supply `agent_hint` |

**Project rule reminder:** no cargo feature flags anywhere in `car-*` crates; FFI bindings and docs must be updated in the **same change** as any cross-boundary signature/enum/JSON-RPC change; avoid `match _ =>` wildcards on FFI-exposed enums (e.g. `TransportSpec`, `RestartPolicy`).

---

## Agent-to-Agent (A2A) & Agent UI (A2UI)

CAR exposes two interop surfaces for talking to *other* agents and to *humans*: **A2A** (`car-a2a`) makes a CAR `Runtime` discoverable and drivable as an [Agent2Agent v1.0](https://a2ui.org) remote agent over HTTP+JSON-RPC 2.0+SSE, and **A2UI** (`car-a2ui`) lets your agent emit declarative UI surfaces that external renderers draw. They are distinct protocols that connect at one seam: A2A advertises A2UI as an output mode, and the daemon routes A2UI envelopes embedded in A2A artifacts into the surface store.

Both are first-class daemon citizens. Like every other capability since v0.8, you drive them either over the native WebSocket (`a2a.*` and `a2ui.*` JSON-RPC namespaces) or through the FFI bindings — which are themselves thin WS clients to the singleton `car-server`. The standalone A2A HTTP listener is an *additional* surface, not the only one; the daemon must already be running before any FFI call (`CAR_DAEMON_URL` / `CAR_AUTH_TOKEN`) works.

> **Which kind of agent is this?** A2A is how your *in-process, proposal-driven* agent (kind #1) becomes reachable by peers, and how it reaches out to them. The Agent Card is auto-generated by reflecting the tools you registered via the IR/FFI; an inbound A2A message compiles straight into an `ActionProposal`. If you understand the IR, you already understand A2A's payload model.

---

### 1. A2A: exposing a CAR Runtime as a remote agent

`car-a2a` is a **bridge, not a full SDK**. It implements JSON-RPC 2.0 dispatch, SSE streaming, push webhooks, and cooperative cancel — enough to be a well-behaved A2A *server*, plus a minimal outbound client for CAR-to-CAR calls.

#### The CAR ↔ A2A mapping

Everything maps onto the IR you already author against:

| A2A concept | CAR concept |
|---|---|
| **Agent Card** | tool manifest + host metadata |
| **Skill** (one per card) | one per registered `ToolEntry` (skill id = tool name) |
| **Task** | one-shot wrapper around an `ActionProposal` |
| **data part** `{tool, parameters}` | one `ToolCall` action |
| **text part** | stashed into `proposal.context['a2a_text']` |
| **Artifact** (one per result) | one per `ActionResult` |
| `TaskState` SUBMITTED→WORKING→COMPLETED/FAILED | the `execute()` lifecycle |
| `tasks/cancel` | `JoinHandle::abort()` |

Task-state derivation (`a2a_state_for`): empty result → `Completed`; `Skipped` with the canceled prefix → `Canceled`; `Rejected` → `Rejected`; `Failed` → `Failed`; otherwise → `Completed`.

#### Agent Card auto-generation

`build_default_agent_card(runtime, AgentCardConfig)` reflects the runtime's registered tools into `AgentSkill`s. The skill id is the tool name, the description comes from the schema, and tags carry the `idempotent` / `cacheable` / `rate-limited` flags. The card advertises:

- `protocolVersion` `"1.0"`, `preferredTransport` `"JSONRPC"`
- default input modes `[text, data]`
- default output modes `[text, data, application/vnd.a2ui+json]` — A2UI is advertised here
- an A2UI extension

It is served at `/.well-known/agent-card.json` (canonical) and `/.well-known/agent.json` (pre-1.0 alias).

```rust
AgentCardConfig::minimal(name, description, url, provider)
// defaults output modes to [text, data, application/vnd.a2ui+json]
```

#### Running the standalone HTTP+SSE listener (CLI)

```bash
car-server --a2a-bind 127.0.0.1:9101    # start the standalone A2A HTTP+SSE listener
CAR_A2A_BIND=127.0.0.1:9101 car-server  # same, via env var
curl http://127.0.0.1:9101/.well-known/agent-card.json   # fetch the Agent Card
```

Peers discover via `GET /.well-known/agent-card.json` and POST JSON-RPC to `/` or `/a2a`. Every CAR-registered tool becomes one A2A skill; a peer's `message/send` with a data part `{tool, parameters}` is compiled into a single-action `ActionProposal` and executed.

> **GOTCHA — the default listener has NO auth.** It is fine only for local dev or behind an authenticating reverse proxy. Direct internet exposure is unsafe. The API-key / basic / OAuth2 / OIDC / mTLS schemes are the embedder's responsibility to declare and enforce.

#### HTTP endpoints

| Method + path | Purpose |
|---|---|
| `GET /.well-known/agent-card.json` | canonical Agent Card |
| `GET /.well-known/agent.json` | pre-1.0 alias |
| `POST /` and `POST /a2a` | JSON-RPC dispatch |
| `GET /a2a/stream/:task_id` | SSE streaming |

#### JSON-RPC methods (dual naming: v1.0 PascalCase + v0.3 slash)

The dispatcher accepts **both** forms for the same handlers:

| v1.0 (PascalCase) | v0.3 (slash) |
|---|---|
| `SendMessage` | `message/send` |
| `SendStreamingMessage` | `message/stream` |
| `GetTask` | `tasks/get` |
| `ListTasks` | `tasks/list` |
| `CancelTask` | `tasks/cancel` |
| `SubscribeToTask` | `tasks/resubscribe` |
| `CreateTaskPushNotificationConfig` / `Get` / `List` / `Delete` | `tasks/pushNotificationConfig/{set,get,list,delete}` |
| `GetExtendedAgentCard` | `agent/getAuthenticatedExtendedCard` |

A structured inbound message — the data part compiles to exactly one `ToolCall`:

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "m-1",
      "role": "user",
      "parts": [{
        "kind": "data",
        "data": { "tool": "fs.read", "parameters": { "path": "/tmp/x" } }
      }]
    },
    "configuration": { "blocking": true }
  },
  "id": 1
}
```

> **GOTCHA — streaming is HTTP/SSE-only.** The in-core dispatcher returns `MethodNotFound` for `message/stream` and `tasks/resubscribe` (and their PascalCase aliases); they are handled by the HTTP/SSE layer. Streaming peers must hit `car-server --a2a-bind`'s listener, not the WS A2A dispatcher.
>
> **GOTCHA — A2A WebSocket binding is NOT implemented** (HTTP+JSON only). gRPC binding is deferred to a separate workstream.

#### Starting the A2A listener over WS / FFI (daemon-backed)

JSON-RPC and FFI share **process-global** listener state — one server per process, one Agent Card.

WS namespace:

| Method | Params → Result |
|---|---|
| `a2a.start` | `{bind, public_url?, agent_name?, agent_description?, organization?, organization_url?}` → `{bound}` |
| `a2a.status` | → `{running, bound, uptime_secs}` |
| `a2a.stop` | → `{stopped: true}` |
| `a2a.send` | `{endpoint, message, blocking?, ingestA2ui?=true, routeAuth?, allowUntrustedEndpoint?}` → `{result, a2ui:{applied}}` |

FFI functions: NAPI `startA2AServer` / `a2AServerStatus` / `stopA2AServer` (all take `rt` first); PyO3 `start_a2a_server` / `a2a_server_status` / `stop_a2a_server` (both via `car-ffi-common::a2a`).

```python
import car_runtime as cr
import json
rt = cr.CarRuntime()  # connects to daemon at ws://127.0.0.1:9100
cr.start_a2a_server(rt, json.dumps({"bind": "127.0.0.1:9101"}))
print(cr.a2a_server_status(rt))  # bound address, served card name, task count
cr.stop_a2a_server(rt)
```

#### Hosting a custom agent over A2A (today's pattern)

1. Declare each skill with `register_tool_schema(name, description, <JSON schema>)`.
2. **Node:** `registerToolHandler(handlerFn)` installs one callback the daemon invokes for **all** dispatched tools — multiplex on the tool name; the daemon emits a server-initiated `tools.execute` over WS.
3. **Python:** `register_tool_handler` raises `NotImplementedError` today (parity gap, car-releases#38). Instead call `execute_proposal(proposal_json, handler_fn)` per call, or service `tools.execute` over the WS directly. There is no decorate-a-`def` path yet.

Customize card identity (name/description/provider) via `car-server` host config, read through the `AgentCardSource` closure.

#### Caller identity: `a2a_caller` vs `a2a_caller_verified`

Two distinct surfaces land in proposal context, and the distinction is security-load-bearing:

- **`proposal.context['a2a_caller']`** — peer-*claimed*, allow-listed metadata keys (`caller_id`, `org_id`, `project_id`, `tenant_id`). Untrusted.
- **`proposal.context['a2a_caller_verified']`** — server-*verified* `{subject, claims}`, populated only when an `AuthValidator` returns `Ok(Some(Identity{subject, claims}))`. **Absent** (not present-but-empty) when no identity is verified — so a default-deny policy can check `!context.contains_key('a2a_caller_verified')`.

> **GOTCHA — built-in auth validators do not populate the verified surface.** `BearerKeyAuth` and `ApiKeyHeaderAuth` are *allow-list only* and return `Ok(None)`: they identify the credential, not the caller. Only a **custom `AuthValidator` returning `Ok(Some(Identity{...}))`** populates `a2a_caller_verified`.

#### Multi-tenant default-deny

`A2aDispatcher::with_require_identity(true)` rejects inbound messages lacking a verified `Identity` with JSON-RPC `-32600 InvalidRequest` **before any proposal runs**. It defaults to `false` (single-tenant / `NoAuth` / `BearerKeyAuth` run unscoped). `car_engine::RuntimeScope` carries `caller_id` / `tenant_id` / `claims`, and the bridge always routes through `Runtime::execute_scoped*`.

> **GOTCHA — flip `require_identity` on ONLY with an Identity-returning validator.** Otherwise every request is rejected with `-32600`.
>
> **GOTCHA — no automatic per-caller partition.** One `Arc<Runtime>` per listener; there is no per-`contextId` memgine/state partition. State-key / memgine fact-skill / `state.*` tenant scoping landed in phases 3-B..3-G, but snapshot/restore still operate on the full state `HashMap` (can clobber under concurrent multi-tenant rollback). **Hard multi-tenancy = one daemon per tenant on its own port + a front-end router.**
>
> **GOTCHA — one server = one Agent Card.** The dispatcher is single-card by design. Multiple agents on one host = multiple A2A listeners on distinct ports backed by distinct daemons. There is no multiplexed router card and no CAR-provided registry yet.

#### Embedding the dispatcher / running standalone (Rust)

```rust
use car_a2a::{build_router, A2aDispatcher, InMemoryTaskStore};
let dispatcher = A2aDispatcher::new(runtime, Arc::new(InMemoryTaskStore::new()), card);
let app = your_app.merge(build_router(dispatcher));
// or:
let (addr, handle) = car_a2a::serve(dispatcher, "0.0.0.0:9101".parse()?).await?;
```

For multi-tenant default-deny, chain `.with_require_identity(true)` and supply a custom `AuthValidator`, then use `build_router_with_auth(dispatcher, Arc<dyn AuthValidator>)` / `serve_with_auth(...)`.

#### Calling another A2A peer (outbound)

```rust
use car_a2a::{A2aClient, ClientAuth};
let client = A2aClient::new("http://peer-agent.local")
    .with_auth(ClientAuth::Bearer("…".into()));
let card = client.agent_card().await?;
let task = client.send_message(my_message, /* blocking = */ true).await?;
```

Other methods: `get_task`, `list_tasks(ListTasksParams)`, `cancel_task`, `set_push_config(task_id, PushNotificationConfig)`, and the generic escape hatch `call::<P, R>(method, params)`. `ClientAuth` is `None | Bearer(String) | Header{name, value}`. `car_a2a::A2aClient` is **intentionally minimal** — for retries, OAuth2 refresh, or multi-transport, use the upstream `a2a-protocol-client` / `a2a-client` crates. From the WS, use `a2a.send {endpoint, message, blocking?, ingestA2ui?, routeAuth?, allowUntrustedEndpoint?}`.

#### Push notifications

Register a webhook for a task:

```json
{
  "jsonrpc": "2.0",
  "method": "tasks/pushNotificationConfig/set",
  "params": {
    "taskId": "task-abc",
    "config": { "url": "https://your-server/hooks/a2a", "token": "Bearer-token" }
  },
  "id": 1
}
```

> **GOTCHA — push is fire-and-forget:** no retries, no signed payloads, no replay protection. Production embedders must replace `PushDispatcher`. SSE subscribers that fall behind get `RecvError::Lagged` and silently drop events — resync via `tasks/get`.

#### A2A error codes (`A2aRpcError`)

| Variant | Code |
|---|---|
| `MethodNotFound` | `-32601` |
| `InvalidParams` / `BadProposal` | `-32602` |
| `InvalidRequest` | `-32600` |
| `TaskNotFound` | `-32001` |
| `PushConfigNotFound` | `-32002` |
| `Internal` | `-32603` |

---

### 2. A2UI: declarative agent-driven UI

`car-a2ui` is the **A2UI v0.9 protocol model + in-memory surface store**. Your agent emits declarative UI envelopes; the store validates and applies them; renderers (HTML reference, SwiftUI native) subscribe and draw. The agent stays the authoritative state owner — renderers only consume and emit actions.

#### Envelope types — exactly one per message

An `A2uiEnvelope` has `version` (default `"v0.9"`) plus **exactly one** of:

| Envelope | Shape |
|---|---|
| `createSurface` | `{surfaceId, catalogId=basic, theme, sendDataModel}` |
| `updateComponents` | `{surfaceId, components: [...]}` — replaces/inserts whole component objects by id |
| `patchComponents` | `{surfaceId, patch=<RFC 6902 JSON-Patch over the id-keyed component map>, inResponseTo?}` |
| `updateDataModel` | `{surfaceId, path?=<JSON-pointer>, value?}` |
| `deleteSurface` | `{surfaceId}` |

`validate()` enforces **count == 1** and **version == "v0.9"**.

> **GOTCHA — count != 1 → `InvalidEnvelope`; version != `"v0.9"` → `UnsupportedVersion`.**

#### The 19-component `BASIC_CATALOG_V0_9`

The only supported catalog id is `https://a2ui.org/specification/v0_9/basic_catalog.json`.

- **Layout:** Column, Row, Card, Divider, Spacer, Tabs, Modal, List
- **Content:** Text (variant `title`/`subtitle`/`body`/`caption`), Image, Icon, Video, AudioPlayer, Chart, File, Badge
- **Forms (two-way bound):** Button, TextField, CheckBox, ChoicePicker, Select, Slider, DateTimeInput, FilePicker

> **GOTCHA — emitting any component outside the 24 returns `UnsupportedComponent`.** Custom catalogs are a planned follow-up. The authority is `car-a2ui::supported_components()` (24 entries); the conformance corpus (`car-a2ui/tests/conformance-corpus.json`) carries one case per component, and a test asserts the two stay in lockstep.

#### Data binding (JSON-pointer references)

Component props are literal values **or** references against `surface.data_model` (RFC 6901: `/foo`, `/items/0/title`, `/` = whole model, `~0`/`~1` escapes). `updateDataModel` re-resolves bindings and re-renders **without re-emitting components**. Form components write user input back into `data_model` at the bound path (two-way binding).

> **Bound-reference key: use `{ "path": "/ptr" }`.** Verified against the
> renderers (a headless `@a2ui/lit` test plus CAR's SwiftUI renderer): the
> binding key is `path`. `{ "path": "/ptr" }` does **not** resolve — it
> renders the literal object — so the old example's `path` was a bug (now
> fixed). `docs/a2ui-for-agents.md` and the renderer contract were already
> correct.

#### Emitting a surface and reacting to actions

Send `a2ui.apply {envelope}` over WS. Typical sequence: `createSurface` (stable `surfaceId`) → `updateComponents` (Card/Column root + leaves) → `updateDataModel` (initial values) → `updateDataModel` with a JSON-pointer path for live patches. Multi-step flows reuse the same `surfaceId`.

A `createSurface` lifecycle (renderer-contract doc, `{path}` binding):

```json
{
  "createSurface": {
    "surfaceId": "feedback-form",
    "components": [
      { "id": "root", "component": "Card", "children": ["title", "input", "submit"] },
      { "id": "title", "component": "Text", "text": "How was the answer?" },
      { "id": "input", "component": "TextField", "value": { "path": "/answer" } },
      { "id": "submit", "component": "Button", "label": "Send", "action": "submit" }
    ],
    "dataModel": { "answer": "" }
  }
}
```

Driving it over the WS in the bundled example (note the `path` binding key the example actually uses):

```javascript
async function apply(rpc, envelope) { return rpc('a2ui.apply', { envelope }); }
await apply(rpc, {
  version: 'v0.9',
  updateComponents: { surfaceId, components: [
    { id: 'root', component: 'Card', children: ['name','notify','save'] },
    { id: 'name', component: 'TextField', label: 'Display name',
      value: { path: '/profile/name' }, action: 'profile.name' },
    { id: 'notify', component: 'CheckBox', label: 'Email me',
      checked: { path: '/profile/notify' }, action: 'profile.notify' },
    { id: 'save', component: 'Button', label: 'Save', action: 'profile.save' },
  ]},
});
// live patch via JSON-pointer path:
await apply(rpc, { version: 'v0.9', updateDataModel: { surfaceId, path: '/profile/notify', value: false } });
```

A Modal driven by a visible data binding (open/close by flipping the bound boolean):

```javascript
{ id: 'modal', component: 'Modal', title: 'Confirm action',
  visible: { path: '/wizard/open' }, dismissAction: 'wizard.dismiss',
  children: ['modal-body', 'modal-confirm'] }
// then:
await apply(rpc, { version: 'v0.9', updateDataModel: { surfaceId, path: '/wizard/open', value: true } });
```

Form components and Button clicks come back as `a2ui.action {name, surfaceId, sourceComponentId, timestamp, context}`. React by emitting `updateComponents` (new state) or `deleteSurface` (dismiss).

#### Surgical updates — `patchComponents` (RFC 6902)

```json
{
  "version": "v0.9",
  "patchComponents": {
    "surfaceId": "main",
    "patch": [
      { "op": "replace", "path": "/title/text", "value": "Goodbye" },
      { "op": "add", "path": "/footer", "value": { "id": "footer", "component": "Text", "text": "..." } },
      { "op": "remove", "path": "/old_button" }
    ]
  }
}
```

> **GOTCHA — `updateComponents` replaces listed component objects whole**, nuking focus/scroll/in-flight input on the affected sub-tree. Use `patchComponents` for surgical, focus-preserving refinement. `patchComponents` is all-or-nothing too.
>
> **GOTCHA — a rejected envelope broadcasts nothing.** `UnsupportedCatalog` / `UnsupportedComponent` / `LimitExceeded` / duplicate id / invalid pointer → returns an error and applies **no** state. There is never half-applied state.

#### Limits (`A2uiLimits`)

| Limit | Default |
|---|---|
| max surfaces | 32 |
| max components/surface | 256 |
| max bytes/component | 16 KiB |
| max data-model bytes | 256 KiB |
| max payload bytes | 512 KiB |
| max surface age | 3600 s |

Surfaces reap via `reap_expired(now)` / `a2ui.reap`.

#### WS `a2ui.*` methods

| Method | Notes |
|---|---|
| `a2ui.capabilities` | confirm catalog / capabilities |
| `a2ui.apply` | `{envelope}` — apply one envelope |
| `a2ui.ingest` | `{payload, owner?, endpoint?, routeAuth?, allowUntrustedEndpoint?}` → `{applied:[]}` |
| `a2ui.surfaces` | backfill current state |
| `a2ui.get` | `{surface_id\|surfaceId}` |
| `a2ui.reap` | → `{removed:[]}` |
| `a2ui.action` | `{name, surfaceId, sourceComponentId, timestamp, context}` → `{event, route}` |
| `a2ui/subscribe` / `a2ui/unsubscribe` | renderer subscription |
| `a2ui/replay` | `{surface_id}` — late-joiner backfill |

Server→client notification: `a2ui.event {kind: a2ui.surface_updated | a2ui.surface_deleted, result: A2uiApplyResult}` (emitted after `a2ui.apply` / `a2ui.ingest`). Renderer→agent telemetry: `a2ui.render_report`.

FFI in-process functions: `a2ui_capabilities`, `a2ui_apply`, `a2ui_ingest`, `a2ui_surfaces`, `a2ui_get`, `a2ui_reap`, `a2ui_validate_payload`.

`A2uiError` variants: `UnsupportedVersion`, `InvalidEnvelope`, `UnknownSurface`, `MissingComponentId`, `UnsupportedCatalog`, `UnsupportedComponent`, `LimitExceeded`, `Validation`, `InvalidPath`, `Parse`.

---

### 3. The A2UI renderer contract

Renderers are **consumers, not core**. They draw surfaces and emit actions — they never own state.

**Transports.** Out-of-process: after `session.auth` + `session.init`, call `a2ui/subscribe`, receive `a2ui.event` notifications, emit `a2ui.action`. In-process (UniFFI): call `A2uiSurfaceStore` directly, register an `A2uiObserver`, call `a2ui_action`.

**Bring-up sequence (out-of-process renderer):**

1. Pick transport (WS or in-process FFI).
2. After connect: `a2ui.capabilities` (confirm catalog) → `a2ui.surfaces` (backfill state) → `a2ui/subscribe` (WS) or register an `A2uiObserver` (in-process).
3. Render all 19 basic-catalog components (placeholder for any you can't natively represent).
4. Resolve `{path}` bindings against `surface.data_model` on each render; re-render on `data_model` change.
5. On interaction, emit `a2ui.action` (forms write the new value back via the action).
6. On reconnect, fetch state via `a2ui/replay` or `a2ui.surfaces` and rebuild.

**Renderers MUST:** render all 19 components, resolve bindings, two-way bind forms, route actions, support late-joiners. **Renderers MUST NOT:** execute embedded code, emit envelopes themselves, or diverge silently.

> **GOTCHA — FilePicker `context.files[].path` is a hint, not authority to access the filesystem.** Remote/web renderers MUST substitute an opaque `a2ui-upload://` URI. Agents MUST handle the `<action>_failed` name on cancel / over-budget.

#### Running the bundled end-to-end example

```bash
# Terminal 1 — start the native WS + UI (UI at --port+1, default http://localhost:9101/)
cd car-rs && cargo run -p car-server

# Terminal 2 — drive surfaces over WS (connects to ws://localhost:9100/, override with CAR_WS_URL)
cd car-rs/examples/a2ui-end-to-end && npm install && node index.mjs   # default 'settings' scene
node index.mjs wizard            # modal wizard scene
node index.mjs both              # both scenes with cleanup
node index.mjs delete-settings   # tear down a leftover surface
CAR_WS_URL=ws://example.internal:9100/ node index.mjs both   # target a non-default WS server
```

Open `http://localhost:9101/` for the reference HTML renderer (the UI port = `--port + 1`), or launch a SwiftUI host. Each scene issues `a2ui.apply` per envelope.

---

### 4. The A2UI ↔ A2A ingest bridge

The two protocols connect when an A2A peer returns A2UI inside its artifacts. `a2ui_envelopes_from_artifact()` / `car_a2ui::envelopes_from_value()` extract envelopes from A2A carriers: a direct envelope, `{ a2ui: envelope }`, data parts, and artifact/task objects with `parts`/`artifacts`. `owner_from_value()` pulls `taskId` / `contextId` to set the `A2uiSurfaceOwner` (kind `"a2a"`).

An A2UI payload wrapped in an A2A data part:

```json
{
  "kind": "data",
  "data": {
    "a2ui": {
      "version": "v0.9",
      "createSurface": { "surfaceId": "approval" }
    }
  }
}
```

On the WS host, `a2ui.ingest` scans these and applies them. If a **trusted loopback endpoint** is supplied, a user `a2ui.action` continues the originating A2A task as a `SendMessage` with a data part `{ a2uiAction: action }`.

> **GOTCHA — non-loopback continuation requires opt-in.** Non-loopback endpoints require `allowUntrustedEndpoint: true`. `routeAuth` credentials are kept server-side and never returned to the renderer.

---

### 5. Authoring checklist

| Goal | Surface |
|---|---|
| Make my CAR agent reachable by peers | `car-server --a2a-bind`, or `a2a.start` over WS, or `start_a2a_server` FFI |
| Define my A2A skills | `register_tool_schema(...)` — one A2A skill per tool |
| Handle inbound A2A tool calls (Node) | `registerToolHandler(fn)` — multiplex on tool name |
| Handle inbound A2A tool calls (Python) | `execute_proposal(proposal_json, handler_fn)` (no decorator path; `register_tool_handler` raises) |
| Enforce verified callers | custom `AuthValidator` → `Ok(Some(Identity))`, then `with_require_identity(true)`; check `a2a_caller_verified` in policies |
| Call a peer | `A2aClient` (Rust) or `a2a.send` (WS) |
| Show a human a UI | `a2ui.apply` (`createSurface` → `updateComponents` → `updateDataModel`) |
| React to clicks/input | listen for `a2ui.action`; emit `updateComponents` / `patchComponents` / `deleteSurface` |
| Surgical, focus-safe update | `patchComponents` (RFC 6902), never `updateComponents` |
| Pipe a peer's A2UI into my renderer | `a2ui.ingest` with a trusted loopback endpoint |

**Key file refs:** `car-rs/crates/car-a2a/src/{lib,server,card,client,auth,bridge,http}.rs`, `car-rs/crates/car-a2ui/src/lib.rs`, `car-rs/examples/a2ui-end-to-end/index.mjs`, and the docs `docs/a2a.md`, `docs/a2ui-for-agents.md`, `docs/a2ui-renderer-contract.md`, `docs/websocket-protocol.md`.

---

## Native Capabilities: Voice, Browser, Vision & Apple Frameworks

Beyond text inference, CAR ships four families of native capability an agent author can wire in: a real-time **voice** turn loop, a backend-agnostic **browser** automation + perception layer, on-device **Apple Vision/NLP/Translation/SoundAnalysis** frameworks, and a macOS **automation** bridge (AppleScript/JXA + Shortcuts). They differ sharply in *where they live* and *how you reach them*, and getting that wrong is the most common authoring mistake — so before any API, internalize the two cross-cutting rules that govern this whole section.

### The two rules that govern everything below

**1. Daemon-first reframes which methods even exist.** Since v0.8, every FFI binding (NAPI, PyO3) is a thin WebSocket client to a singleton `car-server` that MUST already be running (`CAR_DAEMON_URL` / `CAR_AUTH_TOKEN`). Voice-turn dispatch is the clearest casualty: `dispatchVoiceTurn` / `cancelVoiceTurn` / `prewarmVoiceTurn` were exposed on NAPI/PyO3 in v0.7.0 but **retired from the FFI bindings in v0.8** — they now live daemon-side over JSON-RPC. From Node/Python you drive voice through `voice.dispatch_turn` + a `voice.event` handler + `voice.cancel_turn`, not through a binding call. (The `car-releases` Python example file still calls the old `rt.dispatch_voice_turn()` surface — treat it as stale.)

**2. Not every Rust capability crosses the FFI/JSON-RPC boundary.** Some of these capabilities are Rust-library-only. Today, only **Vision OCR** and **car-automation** (AppleScript + Shortcuts) are wired across NAPI/PyO3/WebSocket. **car-nlp, car-translate, car-soundanalysis, and Vision faces/barcodes/classify have no binding yet** — an agent driven through bindings cannot call them. Voice and browser have their own divergence (below). The table at the end of this section is the authoritative reach map.

---

### Voice

CAR's voice stack lives in the `car-voice` crate (`car-rs/crates/car-voice/`) plus a platform-agnostic engine-side dispatch core in `car-engine::voice_turn` (`car-rs/crates/car-engine/src/voice_turn.rs`). The turn loop is **STT → agent (LLM) → TTS**, but the agent stage is split into two parallel tracks for latency.

#### Two-track turn: fast + sidecar

On each utterance:

- **FAST track** — a streaming LLM tuned for voice (`prefer_fast=true`, voice context) produces a sub-500ms first reply. Sentences are drained into TTS as they land.
- **SIDECAR track** — a full LLM (with tools, 2–8s) runs to completion in parallel and resolves a `oneshot` with the substantive answer.

The caller drains the fast `mpsc` stream into TTS, awaits the sidecar with a timeout, and plays it if it arrives in time.

#### Utterance classification + the "structural hallucination fix"

`classify_utterance(&str) -> UtteranceClass` is a ~30-LoC keyword classifier. Tool-likely utterances **intentionally skip the fast LLM** (it would hallucinate tool data it doesn't have), play a hardcoded bridge phrase, and run sidecar-only. **Do not "fix" this by running the fast track on tool utterances** — that defeats the design.

```rust
pub fn classify_utterance(utterance: &str) -> UtteranceClass {
    let lower = utterance.to_lowercase();
    let kind = if lower.contains("email") || lower.contains("inbox") || lower.contains("mail") {
        Some(ToolKind::Email)
    } else if lower.contains("calendar") || lower.contains("schedule")
        || lower.contains("meeting") || lower.contains("appointment") {
        Some(ToolKind::Calendar)
    } else if lower.contains("search") || lower.contains("find") || lower.contains("look up") {
        Some(ToolKind::Search)
    } else { None };
    match kind { Some(k) => UtteranceClass::ToolLikely(k), None => UtteranceClass::Conversational }
}
// bridge_phrase: Email="One moment, checking your inbox." Calendar="Let me look at your calendar."
//                Search="One moment, looking that up." Unknown="One moment, let me check on that."
```

`UtteranceClass { ToolLikely(ToolKind), Conversational }`, `ToolKind { Email, Calendar, Search, Unknown }`.

#### Barge-in and stale-result gating (mandatory)

`VoiceTurnControl { turn_id: u64, cancel: CancellationToken }` is a cheap clonable handle. A new utterance or `VoiceEvent::BargeIn` calls `cancel_current_turn()`: stops mixer TTS, increments the current `turn_id`, and cancels the stored control. **`SidecarResult { turn_id, text, data }` carries its `turn_id`, and callers MUST gate playback on `result.turn_id == current_turn_id`** — otherwise a result from a turn superseded by a barge-in plays over the new turn. The orchestrator and the FFI wrapper both enforce this; custom callers must too.

#### Where CAR owns audio — and where it doesn't

- **In-process Rust (macOS):** `car_voice::VoiceOrchestrator` owns TTS playback (via a `VoiceMixerHandle`). It is `#[cfg(target_os = "macos")]`-only because the mixer feeds the VPIO bus 0. Cross-platform consumers use the platform-agnostic `car_engine::voice_turn` dispatch functions + utterance helpers instead.
- **FFI/daemon path:** **CAR does NOT own the speaker.** The engine wrapper emits `voice.turn.*` events through an `Arc<dyn VoiceEventSink>`; the **host plays audio** (and synthesizes bridge phrases) from those events.

#### `voice.turn.*` event types (host renders these)

| Event type | Payload |
|---|---|
| `voice.turn.fast_delta` | `{ turn_id, text }` |
| `voice.turn.fast_done` | `{ turn_id }` |
| `voice.turn.bridge` | `{ turn_id, kind, phrase }` |
| `voice.turn.sidecar` | `{ turn_id, text }` |
| `voice.turn.error` | `{ turn_id, error }` |
| `voice.turn.cancelled` | `{ turn_id }` |

These ride on the `voice.event` notification, which also carries transcript segments/partials/finals and `tts_chunk` payloads.

#### JSON-RPC voice methods (daemon path)

| Method | Params | Returns |
|---|---|---|
| `voice.dispatch_turn` | `{ utterance, session_id?, config_overlay?, sidecar_timeout_ms? }` | `{ turn_id }` |
| `voice.cancel_turn` | `{}` | `{ cancelled: true }` |
| `voice.prewarm_turn` | `{}` | `{ prewarmed: true }` |
| `voice.transcribe_stream.start` / `.push` / `.stop` | streaming STT | — |
| `voice.tts_stream.start` / `.cancel` / `.list` | streaming TTS | — |
| `voice.providers.list` | — | provider availability (build-time presence only) |
| `voice.sessions.list` | — | — |
| `voice.enroll_speaker` / `.list_enrollments` / `.remove_enrollment` | speaker enrollment | — |
| `voice.prepare_parakeet` / `.prepare_diarizer` | model prep | — |

```json
{
  "jsonrpc": "2.0",
  "method": "voice.dispatch_turn",
  "params": {
    "utterance": "What's on my calendar tomorrow?",
    "session_id": "abc-123",
    "config_overlay": null,
    "sidecar_timeout_ms": 30000
  },
  "id": 1
}
```

#### Engine-side dispatch (in-process Rust)

```
dispatch_voice_turn(engine, utterance, fast_request, sidecar_request) -> VoiceTurnHandle
dispatch_voice_turn_with_telemetry(engine, utterance, fast_req, sidecar_req, telemetry) -> VoiceTurnHandle
dispatch_voice_turn_sidecar_only(engine, utterance, sidecar_request) -> VoiceTurnHandle   // fast channel pre-closed
dispatch_voice_turn_sidecar_only_with_classifier(engine, utterance, sidecar_request, fetcher, telemetry) -> VoiceTurnHandle
```

`VoiceTurnHandle { control: VoiceTurnControl, fast: mpsc::Receiver<StreamEvent>, sidecar: oneshot::Receiver<Result<SidecarResult, VoiceTurnError>> }`; `VoiceTurnError { Inference(String), Cancelled }`. Sidecar-only handles have a **pre-closed fast `mpsc` channel** (capacity 1, sender dropped) so callers can call `fast.recv()` uniformly and get `None` immediately — don't special-case it.

#### VoiceOrchestrator (in-process, macOS)

```rust
use std::sync::Arc;
use car_inference::{InferenceConfig, InferenceEngine};
use car_voice::{
    apple_speech_tts::AppleSpeechSpeaker, cpal_listener::CpalListener,
    events::VoiceEvent, listener::Listener,
    Speaker, VoiceConfig, VoiceOrchestrator,
};

let engine = Arc::new(InferenceEngine::new(InferenceConfig::default()));
let speaker: Arc<dyn Speaker> = Arc::new(AppleSpeechSpeaker::from_config(&VoiceConfig::default()));
let orchestrator = Arc::new(VoiceOrchestrator::new(engine, speaker, VoiceConfig::default()));

orchestrator.prewarm().await; // load the fast model once at startup

let mut listener = CpalListener::new();
let mut events = listener.start(VoiceConfig::default()).await?;

while let Some(evt) = events.recv().await {
    match evt {
        VoiceEvent::Transcript { text, .. } => {
            let orch = orchestrator.clone();
            tokio::spawn(async move { let _ = orch.handle_utterance(text).await; });
        }
        VoiceEvent::BargeIn => { orchestrator.cancel_current_turn().await; }
        _ => {}
    }
}
```

Builder methods: `with_mixer`, `with_telemetry`, `with_direct_fetcher`, `with_sidecar_timeout(Duration)`, `with_models(fast: Option<String>, sidecar: Option<String>)`, `with_skip_fast_track(bool)`. `prewarm()` warms the fast model (best-effort: a 1-token `prefer_fast` probe; errors are logged and swallowed). With a mixer attached, TTS routes through `queue_tts`/`stop_tts` (cancellable barge-in mid-clip); without one it falls back to `Speaker::speak` — barge-in still bumps `turn_id` to drop stale results, but the active clip plays to its end.

#### Voice-context prompt overlay

`compose_voice_context(&VoiceConfig, caller_context: Option<&str>) -> Option<String>` folds `DEFAULT_VOICE_PROMPT_OVERLAY` (a `[VOICE CONTEXT...]` prefix telling the model: replies <500 chars, no markdown, no clarifying questions, fetch broadly on email/calendar) into `GenerateRequest.context`. Configure via `VoiceConfig.voice_prompt_overlay`: `None` → use default; `Some("")` → disable; `Some(custom)` → substitute. The overlay precedes any caller prompt with a blank line. Over WebSocket, pass `config_overlay` on `voice.dispatch_turn` (empty string disables).

```rust
let cfg = VoiceConfig::default();
let context = compose_voice_context(&cfg, None);
let req = GenerateRequest { prompt: utterance, context, ..Default::default() };
let answer = engine.generate(req).await?;
```

#### DirectDataFetcher — bypass the LLM entirely

`Some(Ok(text))` becomes the sidecar's answer (`source=direct_fetch`, LLM skipped); `Some(Err)`/`None` fall through to the LLM. Format output for narration first with `car_voice::format_for_voice(text, max_chars)` to strip markdown.

```rust
#[async_trait::async_trait]
pub trait DirectDataFetcher: Send + Sync {
    /// Some(Ok(text)) -> use as sidecar answer (LLM skipped);
    /// Some(Err(msg)) -> match but fetch failed, fall through to LLM;
    /// None -> not a candidate, fall through to LLM.
    async fn try_fetch(&self, utterance: &str) -> Option<Result<String, String>>;
}
```

Attach with `VoiceOrchestrator::with_direct_fetcher(Arc::new(MyFetcher))` or call `dispatch_voice_turn_sidecar_only_with_classifier` directly.

#### STT / TTS providers

`SttProvider::transcribe(&[f32], sample_rate) -> String` and `Speaker { synth, synth_stream, speak }` are the trait objects; `build_stt_provider(&VoiceConfig)` / `build_tts_speaker(&VoiceConfig)` pick the backend.

| | Backends |
|---|---|
| **STT** | `AppleSpeech` (macOS default), `WhisperCpp` (cross-platform default), `Elevenlabs` (Scribe), `Parakeet` (feature-gated) |
| **TTS** | `AppleSpeech` (macOS default), `Elevenlabs`, `Local` (OpenAI-compatible HTTP), `Kokoro` (Apple-Silicon MLX) |

`ListenerMode { Auto, PushToTalk, WakeWord }`. The `Listener` trait owns the mic, runs VAD, and emits `VoiceEvent { SpeechStart, SpeechEnd, Transcript{text,duration_ms,role}, Partial, AudioChunk, BargeIn, EnrollmentCaptured, EnrollmentFailed }`. Provider availability is platform/feature-gated; `build_stt_provider`/`build_tts_speaker` return `VoiceError::Config` on unsupported platforms, and `voice.providers.list` "available" reflects **build-time presence only**, not runtime readiness (API key / permission / model download).

#### Python (daemon path)

```python
import json, sys, time, car_runtime

def on_voice_event(session_id: str, event_json: str) -> None:
    event = json.loads(event_json)
    kind = event.get("type")
    if kind == "voice.turn.fast_delta":
        sys.stdout.write(event["text"]); sys.stdout.flush()
    elif kind == "voice.turn.bridge":
        print(f'\n[bridge: {event["kind"]}] "{event["phrase"]}"')
    elif kind == "voice.turn.sidecar":
        print(f'\n[sidecar] {event["text"]}')
    elif kind == "voice.turn.cancelled":
        print(f'\n[cancelled] turn {event["turn_id"]}')

rt = car_runtime.CarRuntime()
car_runtime.register_voice_event_handler(on_voice_event)
rt.prewarm_voice_turn()
rt.dispatch_voice_turn(json.dumps({"utterance": "Tell me a one-line joke."}))
time.sleep(8)
rt.cancel_voice_turn()
```

#### Voice gotchas

- **Default sidecar timeout = 30,000 ms** (`DEFAULT_SIDECAR_TIMEOUT_MS`). The orchestrator caps the wait at `min(sidecar_timeout, progress_interval × max_progress_attempts)` — defaults 8s × 4 = 32s — playing "Still working on that." progress phrases. After the cap the continuation is dropped even if the sidecar is still running.
- **Replies are hard-capped at `DEFAULT_VOICE_MAX_TOKENS = 200` tokens** (~30s TTS) regardless of what the overlay asks — a guard against a chatty model.
- **prewarm is best-effort** — call it at session/orchestrator construction to hit the <500ms first-audio target.

Runnable demos: `cargo run --release --manifest-path car-rs/examples/voice-loop/Cargo.toml` (in-process macOS) and `python voice_turn.py` (Python; `pip install car-runtime`).

---

### Browser automation & perception

`car-browser` (`car-rs/crates/car-browser/`) is a backend-agnostic automation + perception layer. The agent loop is **observe → reason → act**: the agent calls `browse_observe` to get a `UiMap` of stable `el_N` element IDs, then references those IDs in `browse_click`/`browse_type`. The executor transparently resolves `el_N` back to the backend's AX node ID.

#### The perception boundary (`BrowserBackend`)

The `BrowserBackend` async trait (`backend.rs`) restricts perception/action to **human-equivalent channels only**: screenshots + accessibility tree for perception; click/type/scroll/keypress + navigation for action. **DOM traversal, JS-based data extraction, hidden attributes, and network/cookie/storage introspection are explicitly disallowed** (1:1 human-equivalent mapping). Concrete impls: `ChromiumBackend` (headless Chrome over CDP via chromiumoxide), Hydra's `TauriBackend`, and `MockBackend` for tests. Errors are `BrowserError { ScreenshotFailed, AccessibilityFailed, NavigationFailed, InputFailed, ElementNotFound, PlatformInternal, Timeout, NotAvailable, Unsupported }`.

#### The seven `browse_*` tools

| Tool | Params | Notes |
|---|---|---|
| `browse_navigate` | `{ url }` | not idempotent |
| `browse_click` | `{ element_id }` (e.g. `"el_5"`) | resolves `el_N` → AX node ID; not idempotent |
| `browse_type` | `{ element_id, text }` | types into a field |
| `browse_scroll` | `{ delta_y }` (positive = down) | scrolls |
| `browse_keypress` | `{ key, modifiers? }` | modifiers: `shift`/`control`/`alt`/`meta` |
| `browse_wait` | `{ condition, timeout_ms? }` (default 5000) | idempotent; returns `{ condition, met }` |
| `browse_observe` | `{ include_screenshot? }` (default false) | idempotent; returns `{ url, title, ui_map, screenshot_path, element_count, viewport }` |

`browse_wait` conditions are **string-encoded, not JSON objects**: `"page_loaded"`, `"url_changed"`, `"a11y_contains_text:<text>"`, `"element_with_name:<name>"`, or `"element_with_name:<name>@<role>"`. Unknown strings return an error.

#### `el_N` ↔ `ax_ref` addressing (and the observe prerequisite)

`AxConverter` assigns stable positional IDs `el_0, el_1, …` after sorting elements interactable-first, then top-left (y, then x). Each `UiElement` keeps `ax_ref: Option<String>` holding the backend's original AX node ID. The agent uses `el_N` in tool calls; `BrowserToolExecutor` resolves `el_N` → `ax_ref` via the **last observed `UiMap`** before calling the backend.

> **You MUST call `browse_observe` before `browse_click`/`browse_type`.** The executor caches the last `UiMap` to resolve `el_N`. Click/type without a prior observe passes the raw `el_N` to the backend, which rejects it (`ElementNotFound`, "Expected AX node ID"). Also: **`el_N` IDs are positional and re-flow** when elements are added/removed — do not treat them as stable across observations. Stable identity is `ax_ref` (which is exactly why `UiMapDiff` keys on `ax_ref`).

#### Token-efficient `UiMap`

`UiMap::format_summary()` (used by `browse_observe`) emits a Visible Text section plus an Interactive Elements list (**capped at 50** with an "… and N more" note), targeting ~4KB vs ~86KB raw a11y tree. `format_compact()` emits rows and switches to interactive-only above 40 elements:

```text
[el_0] button "Submit" (120,340) focused
```

`UiMapFormatter { max_elements, include_bounds, include_states, interactive_only, max_name_length }` (with `compact()` preset) is configurable. `estimate_tokens()` ≈ `element_count * 20 + 30`. `UiMap` carries a `content_hash` (SHA-256 over element id/role/name/states + text + signals) for change detection.

#### PageSignals and UiMapDiff

`SignalDetector` produces `PageSignals { modal_present, cookie_banner, error_banner, loading_indicator, scroll_position, page_type_hint }` (`page_type_hint` ∈ login/checkout/search_results). `has_blocking_element()` is true if a modal or cookie banner is present — summaries surface these with warning glyphs so the agent knows the page is blocked.

`UiMapDiff::compute(before, after)` reports `added_elements`, `removed_elements`, `changed_elements`, `url_changed`, `scroll_changed` (threshold 0.05), `signals_changed`. Identity is keyed on `ax_ref`, so re-ordered/re-flowed elements aren't spurious changes. `ChangeField { Name, Value, Focused, Enabled, Checked }`.

#### Wiring a browser agent (Rust)

```rust
let backend = Arc::new(MockBackend::new());
let pipeline: Arc<dyn PerceptionPipeline> = Arc::new(BasicPerceptionPipeline::new());
let executor = Arc::new(BrowserToolExecutor::new(
    backend.clone() as Arc<dyn BrowserBackend>,
    pipeline,
));
let rt = Runtime::new().with_executor(executor as Arc<dyn ToolExecutor>);
for schema in BrowserToolExecutor::tool_schemas() {
    rt.register_tool_schema(schema).await;
}
```

> **Register every tool from `tool_schemas()`.** Unregistered tools (e.g. a typo'd `browse_*` name) are **Rejected at validation time, not Failed** — `register_tool_schema` is mandatory.

#### Observe → read `el_N` → type → click

```rust
// 2. Observe
let r = rt.execute(&make_proposal(vec![make_action("browse_observe", json!({}))])).await;
let ui_map = r.results[0].output.as_ref().unwrap()["ui_map"].as_str().unwrap().to_string();
// 3. Find and type into search field
let search_el = ui_map.lines()
    .find(|l| l.starts_with("[el_") && l.contains("Search"))
    .and_then(|l| l.split(']').next())
    .map(|s| s.trim_start_matches('[').trim().to_string()).unwrap();
rt.execute(&make_proposal(vec![make_action("browse_type",
    json!({"element_id": search_el, "text": "rust programming"}))])).await;
// 4. Find and click submit (executor resolves el_N -> ax_submit)
let submit_el = ui_map.lines()
    .find(|l| l.starts_with("[el_") && l.contains("Submit"))
    .and_then(|l| l.split(']').next())
    .map(|s| s.trim_start_matches('[').trim().to_string()).unwrap();
rt.execute(&make_proposal(vec![make_action("browse_click",
    json!({"element_id": submit_el}))])).await;
```

`browse_observe` output shape:

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "ui_map": "## Visible Text\n  (heading) Welcome to Example\n## Interactive Elements\n[el_0] text_input \"Search\"\n[el_1] button \"Submit\"",
  "screenshot_path": "/tmp/car-browser-screenshots/<uuid>.png",
  "element_count": 3,
  "viewport": { "width": 1280, "height": 720 }
}
```

#### ChromiumBackend

The always-available concrete backend (chromiumoxide, compiled **unconditionally — no feature flags**):

```rust
ChromiumBackend::launch() -> Result<Self, BrowserError>
ChromiumBackend::launch_with_viewport(width: u32, height: u32)
ChromiumBackend::launch_with_options(LaunchOptions { width, height, headless, extra_args })
ChromiumBackend::chrome_pid() -> Option<u32>
// LaunchOptions default: 1280x720, headless=true, no extra_args
```

```rust
let backend = ChromiumBackend::launch_with_options(LaunchOptions {
    width: 1280, height: 720,
    headless: false, // visible window for sign-in / 2FA / captcha
    extra_args: vec![],
}).await?;
```

It uses a **per-instance tempfile profile dir** so parallel workers don't contend on Chromium's `SingletonLock`, and **SIGKILLs the captured Chrome PID in `Drop`** to avoid leaking the subprocess to launchd.

#### Custom backends

Implement `#[async_trait] impl BrowserBackend` providing: `capture_screenshot()->Vec<u8>`, `get_accessibility_tree()->Vec<A11yNode>`, `get_viewport()`, `get_current_url()`, `get_page_title()`, `navigate(url)`; human input `inject_click(x,y)`/`inject_text`/`inject_keypress(key,&[Modifier])`/`inject_scroll(delta_y:i32)`; AX actions `click_element`/`type_into_element`/`focus_element` (by AX node ID); waits `is_page_loaded()`/`wait_until(&WaitCondition, timeout_ms)`/`element_exists_a11y(name_contains, role)`. `set_cookies`/`set_local_storage`/`set_extra_headers`/`shutdown` have default impls.

> **`set_cookies` / `set_local_storage` / `set_extra_headers` default to `BrowserError::Unsupported`.** `ChromiumBackend` implements cookie/header injection via CDP, but a Tauri/custom backend may not — and these must be called **before navigation** for first-request cookies to apply.

A11yNodes flow straight into the perception pipeline: `A11yNode { node_id, role, name, value, bounds, children, focusable, focused, disabled }`. `Bounds { x, y, width, height: f64 }` with `center()`/`contains()`/`overlaps()`/`iou()`. `Modifier { Shift, Control, Alt, Meta }` (serde lowercase). `WaitCondition { UrlChanged, A11yContainsText, ElementWithName, PageLoaded }` (serde `tag=type`, snake_case).

#### Screenshots are always on disk

> Screenshots are **always written to `std::env::temp_dir()/car-browser-screenshots/<uuid>.png`** and returned as `screenshot_path` — never inlined as base64 (saves ~80KB–5MB per observe). The `include_screenshot` param exists in the schema but `handle_observe` always writes to disk; **vision models must read the file path.**

#### FlyX: skill-first execution

The FlyX design note (`docs/case-study-flyx.md`) describes 7 autonomous Playwright agents on CAR, with a *projected* ~75% token-cost cut from skill-first execution: the decision loop first calls `findSkill(persona, currentUrl, taskHint)`; on a match (score > 0.3) it executes saved Playwright code directly (cost $0, ~200ms); otherwise it queries CAR memory (top ~15 facts via spreading activation), calls the LLM (cap ~6 turns), compiles `tool_use` → `ActionProposal`, verifies it, executes via the tool callback, and optionally learns a new skill. Skills auto-degrade when `fail_count > success_count + 2`.

```text
Agent receives task
  -> CAR searches for matching skill (persona + URL + task keywords)
  -> Match found (score > 0.3)?
      YES -> Execute saved Playwright code directly. Cost: $0. Time: 200ms.
      NO  -> Fall back to LLM. Query CAR memory for relevant context.
            Call Claude. Compile response to CAR proposal. Verify. Execute.
            Cost: ~$0.15. Time: 3-5 minutes.
            -> Optionally learn a new skill from the successful workflow.
```

> The FlyX figures ($0.15/call, ~75% savings, 0.3 threshold, top-15 facts, ~4KB UiMap, 20 seeded skills) come from a case-study doc, not source — illustrative targets, not contractual constants. The skill threshold and fail-degradation (`fail_count > success_count + 2`) are CAR memory/skill behavior, not part of `car-browser` itself. Enforce per-agent access via `deny_tool_param` policies in Rust, not in the prompt.

Test/build: `cargo test -p car-browser`; `cargo build --workspace` (chromiumoxide compiles unconditionally).

---

### Apple frameworks (macOS-native, on-device)

Five macOS-native crates expose Apple frameworks as on-device capabilities:

| Crate | Framework | Provides |
|---|---|---|
| `car-vision` | Vision.framework | OCR, face rectangles, barcodes/QR, whole-image classification |
| `car-nlp` | NaturalLanguage | language ID, word tokenization, named-entity recognition |
| `car-translate` | Translation.framework | on-device text translation (macOS 15.4+) |
| `car-soundanalysis` | SoundAnalysis | audio-event classification (~300-class taxonomy) |
| `car-automation` | osascript / shortcuts(1) | AppleScript/JXA + Shortcuts.app (the practical App Intents bridge) |

#### cfg-target gating, no feature flags

Every crate compiles unconditionally but gates the real implementation behind `#[cfg(target_os = "macos")]`. Off-platform, the same public signatures exist but return a typed error variant (`VisionError::PlatformUnsupported`, `NlpError::Unsupported`, `TranslateError::Unsupported`, `SoundAnalysisError::Unsupported`, `AutomationError::PlatformUnsupported`) — callers can branch on the error without their own cfg.

**Swift shim vs pure objc2:** `car-vision`, `car-translate`, `car-soundanalysis` each ship a Swift file (`swift/CarVision.swift`, etc.) compiled by `build.rs` into a static lib. `build.rs` sets a `car_*_swift_built` cfg **only when `swiftc` was reachable** — if not, it prints a `cargo:warning`, the cfg is unset, and `is_available()` returns false (functions return `PlatformUnsupported`/`Unsupported`). `car-nlp` is **pure objc2** (no Swift/Xcode needed, builds with Command Line Tools). `car-automation` is subprocess wrappers around `/usr/bin/osascript` and `/usr/bin/shortcuts` — no shim, no objc2.

#### Runtime probe: `is_available()`

`car-vision`, `car-translate`, and `car-soundanalysis` expose `is_available() -> bool`, true only when the framework is reachable **and** the Swift shim compiled into this binary. The FFI wrapper `ffi-common::vision::ocr` returns `{ "available": bool, "observations": [...] }` so callers distinguish "OCR unavailable here" from "ran and found no text" — **you must check the `available` flag.**

#### Vision

```rust
car_vision::ocr::recognize(image_path: &Path, config: &OcrConfig) -> Result<Vec<Observation>>
// OcrConfig { fast_path: bool, languages: Vec<String> (BCP-47, empty=auto),
//             language_correction: bool (default true), minimum_text_height: f32 }
car_vision::faces::detect(path) -> Result<Vec<FaceObservation>>      // rectangles only (no identity/landmarks)
car_vision::barcodes::detect(path) -> Result<Vec<BarcodeObservation>>
car_vision::classify::classify(path, top_k: usize) -> Result<Vec<Classification>>  // top_k=0 = all non-zero
```

`Observation { text, confidence: f32, x/y/w/h: f64 }`. **All Vision observations are normalized to `[0,1]` in BOTTOM-LEFT origin space (y grows up) — flip y for top-left UI conventions.** Images load via `CGImageSourceCreateWithURL` (PNG/JPEG/HEIC/TIFF). `BarcodeObservation` carries the Apple symbology raw value (e.g. `VNBarcodeSymbologyQR`). Face detection deliberately exposes **rectangles only, not identity/landmarks** — a per-bundle capability decision (`vision-detect-faces` ≠ `vision-recognize-faces`).

```rust
use car_vision::ocr::{recognize, OcrConfig};
use std::path::Path;

if car_vision::is_available() {
    let obs = recognize(Path::new("/tmp/shot.png"), &OcrConfig::default())?;
    for o in obs { println!("{} ({:.2})", o.text, o.confidence); }
}
```

#### NaturalLanguage (Rust-library-only)

```rust
car_nlp::identify_language(text: &str) -> Result<Option<String>, NlpError>  // BCP-47, None on undecidable
car_nlp::tokenize_words(text: &str) -> Result<Vec<String>, NlpError>        // locale-aware
car_nlp::extract_named_entities(text: &str) -> Result<Vec<NamedEntity>, NlpError>
// NamedEntity { text, kind: personal_name|place_name|organization_name, byte_range: (usize,usize) }
```

```rust
let lang = car_nlp::identify_language("Bonjour le monde")?; // Some("fr")
let ents = car_nlp::extract_named_entities("Tim Cook visited Paris for Apple.")?;
// ents: [{text:"Tim Cook", kind:"personal_name", byte_range:(0,8)}, ...]
```

`extract_named_entities` surfaces only PersonalName/PlaceName/OrganizationName tags and **converts Apple's UTF-16 NSRange to UTF-8 `byte_range`** so `text[a..b]` works in Rust.

#### Translation (Rust-library-only; signed host required)

```rust
car_translate::translate(text: &str, source_lang: Option<&str>, target_lang: &str)
    -> Result<TranslationResult, TranslateError>
// TranslationResult { text, source_lang, target_lang }
// TranslateError { Unsupported, InvalidInput, LanguagePackMissing(String), FrameworkError(String) }
```

```rust
if car_translate::is_available() {
    let r = car_translate::translate("Hello", None, "fr")?;
    println!("{} ({} -> {})", r.text, r.source_lang, r.target_lang);
}
```

Requires macOS 15.4+, ~17 English-anchored pairs, and a **pre-installed language pack** (System Settings → Language & Region → Translation Languages; first call for an uninstalled pair returns `LanguagePackMissing`/`FrameworkError`).

#### SoundAnalysis (Rust-library-only)

```rust
car_soundanalysis::classify_audio_file(path, top_k: usize)
    -> Result<Vec<AudioClassification>, SoundAnalysisError>  // SNClassifierIdentifier.version1, ~300 classes
// AudioClassification { identifier, confidence: f64 [0,1], start_sec, end_sec }
```

Returns one classification per ~975ms window (~487ms hop), keeping `top_k` per window (`0` = all).

```rust
let hits = car_soundanalysis::classify_audio_file("/tmp/clip.wav", 3)?;
for h in hits { println!("{} {:.2} @ {:.1}-{:.1}s", h.identifier, h.confidence, h.start_sec, h.end_sec); }
```

#### macOS automation (AppleScript/JXA + Shortcuts)

```rust
car_automation::is_sandboxed() -> bool   // checks APP_SANDBOX_CONTAINER_ID
car_automation::applescript::run(script: &str, lang: Language, timeout: Option<Duration>) -> Result<AutomationOutput>
car_automation::applescript::run_with_args(script, lang, args: &[&str], timeout) -> Result<AutomationOutput>
// Language { AppleScript, JavaScript }   (JXA — LLMs generate cleaner JS)
// AutomationOutput { stdout, stderr, exit_code: Option<i32> }
```

```rust
use car_automation::applescript::{run, Language};
use std::time::Duration;
let out = run("return 1 + 2", Language::AppleScript, Some(Duration::from_secs(5))).await?;
assert_eq!(out.stdout, "3");
```

**Shortcuts is the practical App Intents bridge** — the `shortcuts(1)` listing contains both user-authored workflows AND AppShortcuts donated via App Intents (indistinguishable from the CLI). No separate App Intents binding exists.

```rust
car_automation::shortcuts::list(folder: Option<&str>, with_identifiers: bool) -> Result<Vec<Shortcut>>
car_automation::shortcuts::list_folders() -> Result<Vec<String>>
car_automation::shortcuts::run(name_or_id: &str, input: Option<&[u8]>, output_type: Option<&str>, timeout) -> Result<AutomationOutput>
// Shortcut { name, identifier: Option<String> } + tool_slug() / tool_description() / parameters_schema()
```

```rust
let list = shortcuts::list(None, true).await?; // with UUIDs
for s in &list { println!("{} -> {}", s.tool_slug(), s.tool_description()); }
let out = shortcuts::run("43E9-...-UUID", Some(b"hello"), Some("public.plain-text"), None).await?;
```

`Shortcut::tool_slug()`/`tool_description()`/`parameters_schema()` turn a shortcut into a registerable agent tool (single optional `input` string param). **Prefer the UUID identifier over the name** — names collide and change. Underlying CLI calls: `/usr/bin/osascript -l <AppleScript|JavaScript> -`, `/usr/bin/shortcuts list [--folder-name <f>] [--folders] [--show-identifiers]`, `/usr/bin/shortcuts run <name_or_id> [--input-path <file>] --output-path - [--output-type <UTI>]`.

#### FFI / JSON-RPC reach for Apple frameworks

Only **Vision OCR** and **car-automation** cross the boundary:

| NAPI (camelCase) | PyO3 (snake_case) | JSON-RPC method | Args object |
|---|---|---|---|
| `visionOcr(argsJson)` | `vision_ocr(args_json)` | `vision.ocr` | `{ image_path, fast_path?, languages?, language_correction?, minimum_text_height? }` |
| `runApplescript(argsJson)` | `run_applescript(args_json)` | `automation.run_applescript` | `{ script, language?('applescript'|'javascript'|'jxa'), args?, timeout_ms? }` |
| `listShortcuts(argsJson)` | `list_shortcuts(args_json)` | `automation.shortcuts.list` | `{ folder?, with_identifiers? }` |
| `runShortcut(argsJson)` | `run_shortcut(args_json)` | `automation.shortcuts.run` | `{ name_or_id, input?, output_type?, timeout_ms? }` |

```typescript
import { visionOcr } from '@parslee-ai/car-runtime-native';
const res = JSON.parse(await visionOcr(JSON.stringify({
  image_path: '/tmp/shot.png', fast_path: false, languages: ['en-US']
})));
// res = { available: true, observations: [{ text, confidence, x, y, w, h }, ...] }
```

```jsonc
{ "method": "vision.ocr", "params": { "image_path": "/tmp/shot.png", "fast_path": false } }
// -> { "available": true, "observations": [ { "text": "...", "confidence": 0.99, "x":0.1,"y":0.2,"w":0.3,"h":0.04 } ] }

{ "method": "automation.run_applescript", "params": { "script": "tell application \"Finder\" to get name of home", "language": "applescript", "timeout_ms": 5000 } }
// -> { "stdout": "...", "stderr": "", "exit_code": 0 }
```

#### Apple-framework gotchas

- **Translation and Apple Speech require a real Developer-ID-signed `.app` bundle.** From an ad-hoc-signed `cargo run` binary, AMFI/XPC silently drops the callback and the call **HANGS** (a 30s/60s shim timeout is the only thing that catches it). Use `apps/host-macos/`.
- **Sandboxed processes can't drive automation** — TCC silently denies AppleEvents/shortcuts. `applescript::run`/`shortcuts::run_*` preflight via `is_sandboxed()` (`APP_SANDBOX_CONTAINER_ID`) and return `PlatformUnsupported` with a reason instead of an opaque failure.
- **AppleScript's first control of another app triggers a one-time TCC Automation consent prompt** for the parent process embedding CAR. Preflight via `car-permissions::Permission::Automation` to warn before the prompt fires.
- **No cargo feature flags anywhere in these five crates** — capability presence is purely `cfg(target_os = "macos")` + build-time shim availability. Opt back into incremental for a single crate with `CARGO_INCREMENTAL=1 cargo build -p car-vision`.

---

### Capability reach summary (FFI / JSON-RPC vs Rust-library-only)

| Capability | NAPI / PyO3 | JSON-RPC | Rust in-process |
|---|---|---|---|
| Voice turn dispatch | **retired in v0.8** (use daemon) | `voice.dispatch_turn` / `cancel_turn` / `prewarm_turn`, `voice.event` | `car_engine::voice_turn::*`, `VoiceOrchestrator` (macOS) |
| Voice STT/TTS streaming, enrollment, providers | — | `voice.transcribe_stream.*`, `voice.tts_stream.*`, `voice.enroll_speaker`, `voice.providers.list` | trait objects via `build_stt_provider`/`build_tts_speaker` |
| Browser `browse_*` tools | via tool schemas | via tool schemas | `BrowserToolExecutor::tool_schemas()` |
| Vision OCR | `visionOcr`/`vision_ocr` | `vision.ocr` | `car_vision::ocr::recognize` |
| Vision faces / barcodes / classify | **none** | **none** | `car_vision::{faces,barcodes,classify}` |
| NLP (lang ID / tokenize / NER) | **none** | **none** | `car_nlp::*` |
| Translation | **none** | **none** | `car_translate::translate` (signed host) |
| SoundAnalysis | **none** | **none** | `car_soundanalysis::classify_audio_file` |
| AppleScript / JXA | `runApplescript`/`run_applescript` | `automation.run_applescript` | `car_automation::applescript::*` |
| Shortcuts (App Intents bridge) | `listShortcuts`/`runShortcut` | `automation.shortcuts.list` / `.run` | `car_automation::shortcuts::*` |

When you add or change any of these surfaces, keep all binding surfaces in sync in the same change and verify with `cargo check -p car-ffi-napi -p car-ffi-pyo3 -p car-server -p car-server-core && bash scripts/check-ffi-parity.sh`.

---

## CLI Command Reference

The `car` binary (defined in `car-rs/crates/car-cli/src/main.rs`) is the native command-line entrypoint for the Common Agent Runtime. Every subcommand lives in one flat `clap` `Commands` enum — there is no `agents`, `mcp`, `a2a`, `registry`, or `bundle` command group. `main()` parses `Cli::parse()` and matches `cli.command`. Many commands accept `--json` for machine-readable output.

### The daemon-first model (read this first)

Since v0.8, CAR is daemon-first, and the CLI reflects it. Inference and agent-lifecycle commands are **thin WebSocket clients** to a singleton `car-server` daemon (default `ws://127.0.0.1:9100/`, resolved by `car_proto::daemon::daemon_ws_url()`, overridable via `$CAR_DAEMON_URL`). Two consequences shape everyday use:

1. **The connection handshake is mandatory.** Since the 2026-05 security audit (`car-releases#32`) `car-server` is auth-on by default. Every daemon-bound command sends `session.auth` as its **first WS frame** and awaits success, then sends exact-version `server.handshake`, before any application RPC (`auth_handshake.rs`). The token is read by `car_ffi_common::auth_token::read_for_client()`, which honors `$CAR_AUTH_TOKEN` first, then the well-known token file. No token present → the auth step is skipped (assumes `--no-auth`), but protocol negotiation still runs. A broken token file, auth rejection, legacy/malformed/mismatched protocol response, close, or timeout fails loudly before the application call. The response wait is bounded by `$CAR_DAEMON_TIMEOUT` seconds (default 30).
2. **Graceful embedded fallback.** `infer`/`image`/`video`/`embed` and several `models.*` commands try the daemon first via a `try_*_via_daemon` helper, then fall back to an in-process engine (`default_inference_engine_dynamic()`) when `is_daemon_unreachable`. `car infer` goes further: it **auto-spawns** `car-server` (`try_spawn_daemon()`) and retries up to **20 times at 250 ms intervals**. If car-server is not on `PATH`, it prints a singleton-daemon warning (suppress with `CAR_NO_DAEMON_WARNING=1`).

```rust
// infer: daemon-first with auto-spawn + retry
match infer_via_daemon_once(&url, req).await {
    Ok(result) => Some(Ok(result)),
    Err(err) if is_daemon_unreachable(&err) => {
        if start_daemon_background(daemon_port()).is_ok() {
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                // retry infer_via_daemon_once ...
            }
        }
        None
    }
    Err(err) => Some(Err(err)),
}
```

> **`car daemon` ≠ `car models serve`.** `car daemon` execs the **CAR `car-server` daemon** (default port 9100). `car models serve` execs an **external `vllm-mlx serve`** OpenAI-compatible MLX runtime (default port 8000). They are unrelated. Also note: there is no top-level `car serve`, `car recommend`, or `car generate` — `serve`/`recommend` are `models` subcommands, and generation is `car infer` / `car image` / `car video`.

### Starting the daemon

```bash
car daemon              # -p/--port defaults to 9100
car daemon --port 9100
```

`cmd_daemon` (`main.rs:5342`) does **not** run a server itself — it execs the separate `car-server` binary with `--port`. If that binary is missing it prints the build hint and exits 1:

```rust
fn cmd_daemon(port: u16) {
    let status = std::process::Command::new("car-server")
        .args(["--port", &port.to_string()]).status();
    // on Err: "car-server binary not found. Build it: cd car-rs && cargo build -p car-server --release"
}
```

### Authentication (Parslee OAuth2 + PKCE)

`car auth login` (the `parslee_login` command handler) runs a browser-based OAuth2 + PKCE flow against the Parslee backend using a loopback listener. The PKCE/token/keychain logic lives in the shared `car-auth` crate; the CLI only supplies the loopback `TcpListener` and browser-open.

| Command | Flags (defaults) | Effect |
|---|---|---|
| `car auth login` | `--api-base https://api.parslee.ai`, `--client-id parslee-car`, `--callback-port 53682`, `--provider <microsoft\|google>` | OAuth2+PKCE; validates the fresh session, then atomically publishes the V2 credential state |
| `car auth status` | `--api-base <url>`, `--json` | Summary of the signed-in account: identity, active org + role, expiry, entitled products. `--json` prints the raw upstream session object (the Parslee API's shape, not a CAR contract) |
| `car auth logout` | — | Clears keychain tokens |

```rust
// parslee_login: loopback OAuth+PKCE
let redirect_uri = format!("http://127.0.0.1:{callback_port}/auth/callback");
let state = car_auth::new_state();
let verifier = car_auth::pkce_verifier();
let challenge = car_auth::pkce_challenge(&verifier);
let listener = tokio::net::TcpListener::bind(("127.0.0.1", callback_port)).await?;
let authorize = car_auth::authorize_url(
    api_base,
    client_id,
    &redirect_uri,
    &state,
    &challenge,
    provider,
    prompt,
)?;
open_url(&authorize)?;
let (code, returned_state) = wait_for_oauth_callback(listener).await?;
if returned_state.as_deref() != Some(state.as_str()) { return Err("OAuth state mismatch; refusing token exchange".into()); }
let token = car_auth::exchange_code(api_base, client_id, &redirect_uri, &code, &verifier).await?;
let session = car_auth::fetch_status_with_access(api_base, &token.access_token).await?;
car_auth::commit_login(api_base, &token, &session, None).await?;
```

Gotchas: the Parslee backend must allow the **exact** redirect URI `http://127.0.0.1:<callback-port>/auth/callback`. Request-time auth/status/inference readers observe the newly published V2 record without a daemon restart. Restart only when `daemon_identity`/`handle_session_auth` metadata or Parslee sync initialization must reload the boot-cached `ServerState.parslee_session`.

### Scaffolding a project: `car init`

```bash
car init               # default cwd
car init --dir <path>  # -d/--dir
```

`car init` (`main.rs:1088`) calls `car_memgine::project::scaffold_project(target)` to create the `.car/` project directory — team-shareable agent config that the engine auto-discovers by walking up from cwd like `.git`. Commit it to git.

```text
Created <dir>/.car with:
  identity.md       — project context for the agent
  knowledge/        — facts, gotchas, anti-patterns, decisions (JSONL)
  rubrics/          — quality standards (JSON)
  skills/           — learned procedures
  policies.json     — tool restrictions
  config.toml       — memgine/routing overrides
```

### Agent IR verification commands

These operate purely on Agent IR proposal JSON + state JSON files via the `car_verify` crate — no daemon, no model. `load_proposal` accepts either a **bare `ActionProposal`** or a `{"proposal": ...}` **wrapper**.

| Command | Positional | Flags | Backend |
|---|---|---|---|
| `car verify <proposal.json>` | proposal: PathBuf | `--state <state.json>`, `--tools a,b,c` | `car_verify::verify(&proposal, state, tools, 30)` |
| `car simulate <proposal.json>` | proposal: PathBuf | `--state <state.json>` | `car_verify::simulate(&proposal, state)` |
| `car optimize <proposal.json>` | proposal: PathBuf | — | `car_verify::optimize(&proposal)` |
| `car replay <journal.jsonl>` | journal: PathBuf | — | `car_eventlog::EventLog::load` + state fold |

**Exit codes.** These commands are meant to be scriptable, so the verdict is in the status, not just the output:

| Code | Meaning |
|---|---|
| `0` | success — and for `car verify`, the proposal **is valid** |
| `1` | `car verify` only: the proposal loaded but **failed verification** |
| `2` | bad input — unreadable file, malformed JSON, or JSON that isn't a proposal/state object |

So `car verify plan.json && deploy` is a real gate. Before v0.39.1 `car verify` exited `0` even when it printed `INVALID`, making every scripted use a silent no-op (Parslee-ai/car#619), and bad input exited `101` via a Rust panic rather than reporting a clean error (Parslee-ai/car#621). A `101` from any of these now means a genuine internal error worth reporting.

```rust
#[derive(Subcommand)]
enum Commands {
    Info,
    Verify {
        proposal: PathBuf,
        #[arg(long)] state: Option<PathBuf>,
        #[arg(long)] tools: Option<String>,
    },
    Simulate { proposal: PathBuf, #[arg(long)] state: Option<PathBuf> },
    Optimize { proposal: PathBuf },
    Replay { journal: PathBuf },
    Daemon { #[arg(short, long, default_value = "9100")] port: u16 },
```

- **`verify`** prints `VALID`/`INVALID`, per-issue lines `[icon] action_id: message` (`X`=error, `!`=warning), conflicts (`a1 <-> a2 on key 'k'`), execution levels, and simulated-state key count. `--tools` is a comma-separated allowed-tool set parsed into a `HashSet`.
- **`simulate`** prints the simulated final state as `key: value` lines.
- **`optimize`** strips phantom dependencies and prints the optimized proposal as pretty JSON to stdout.
- **`replay`** loads the JSONL event log, prints `Replayed N events`, then folds `StateChanged`/`StateSnapshot` events into a state map (`No state changes found.` if none).

> Gotcha: invalid JSON or a missing proposal file **panics** — these are not graceful errors.

### Runtime info: `car info`

`car info` (`cmd_info`, `main.rs:1825`) prints the runtime version, a static feature list, and detected hardware via `car_inference::HardwareInfo::detect()` (OS, arch, RAM MB, GPU backend, GPU memory, max model MB, recommended model, recommended context tokens). It also lists built-in tools: `infer`, `embed`, `classify`, `transcribe`, `synthesize`, `generate_image`, `generate_video`.

### Inference commands

All four try the daemon over JSON-RPC first, then fall back to the embedded engine.

#### `car infer` — text generation

```bash
car infer "<prompt>" --model NAME --image img.png \
  --workload interactive --max-tokens 512 --temperature 0.7 --thinking off
```

```rust
Infer {
    prompt: String,
    #[arg(short, long)] model: Option<String>,
    #[arg(long)] image: Vec<PathBuf>,
    #[arg(long, default_value = "interactive")] workload: String,  // interactive|batch|background
    #[arg(long, default_value = "512")] max_tokens: usize,
    #[arg(long, default_value = "0.7")] temperature: f64,
    #[arg(long, default_value = "off")] thinking: String,          // off|on|auto
}
```

Builds a `GenerateRequest`, tries the `infer` JSON-RPC method (auto-spawning car-server if down), else embedded `generate_tracked`. Prints generated text to stdout and a `[model via trace in Nms]` line to stderr. Multiple `--image` paths are base64-loaded for vision.

> **`--thinking` defaults to `off` deliberately (issue #168).** Qwen3's trained default is reasoning-on, which can burn the entire `--max-tokens` budget inside an unclosed `<think>` block and yield empty output. Use `on`/`auto` only with a larger `--max-tokens` (≥1024).

#### `car image` — image generation (local MLX)

```bash
car image "<prompt>" -m MODEL -o out.png \
  --width 1024 --height 1024 --steps 30 --guidance 7.5 --seed 42
```

Builds `GenerateImageRequest`, tries daemon `image.generate` then embedded `generate_image`, prints the image path.

#### `car video` — video generation (local MLX)

```bash
car video "<prompt>" -m MODEL -o out.mp4 \
  --frames 96 --fps 24 --image ref.png --audio-video
```

Full flag set: `-m/--model`, `-o/--output`, `--width`, `--height`, `--frames`, `--steps`, `--guidance`, `--fps`, `--seed`, `--image ref.png`, plus three **mutually exclusive** audio flags (exit code 2 if more than one is set):

| Flag | Meaning |
|---|---|
| `--audio-video` | joint audio+video synthesis |
| `--audio a.wav` | audio-reference conditioning |
| `--audio-mux a.wav` | records the path for downstream muxing only — does **not** condition the video |

```rust
let audio_flags_set = [audio_video, audio.is_some(), audio_mux.is_some()]
    .iter().filter(|&&x| x).count();
if audio_flags_set > 1 {
    eprintln!("Error: --audio-video, --audio, and --audio-mux are mutually exclusive.");
    std::process::exit(2);
}
```

Tries daemon `video.generate` then embedded `generate_video`, prints the video path.

#### `car embed` — embeddings

```bash
car embed "<text>" -m Qwen3-0.6B
```

Tries daemon `embed` then embedded `embed`.

### Model management: `car models`

| Command | Notable flags | Notes |
|---|---|---|
| `car models list` | `-c/--capability CAP`, `--provider P`, `--local-only` | CAP ∈ generate, embed, classify, code, reasoning, summarize, tool_use, vision, speech_to_text\|stt, text_to_speech\|tts, image_generation\|image, video_generation\|video |
| `car models discover` | `--json` | |
| `car models pull <name>` | — | |
| `car models remove <name>` | — | |
| `car models recommend` | `--for assistant`, `--tier balanced`, `--cloud-ok` | read-only; **flag is `--for`, not `--use-case`** |
| `car models stats [id]` | — | daemon `models.stats` |
| `car models register <schema.json>` | — | single `ModelSchema` object **or** a JSON array; persists to the state root's `models.json` (default `~/.car/models.json`) |
| `car models unregister <id>` | — | daemon `models.unregister` |
| `car models route <prompt>` | — | adaptive router pick |
| `car models doctor` | `--json`, `--mlx` | |
| `car models smoke` | `--json`, `--dry-run` | |
| `car models upgrades` | `--json` | |
| `car models upgrade` | `--apply`, `--remove-old`, `--json` | |
| `car models benchmark` | `--json`, `--models a,b`, `--cases x,y`, `--judge-model M` | |
| `car models serve <model>` | `--port 8000`, `--dry-run`, `--json` | external `vllm-mlx serve` — **not** the CAR daemon |

`car models serve` resolves the model to a vllm-mlx runtime model (aliases like `qwen3.6` → `vllm-mlx/qwen3.6-35b-a3b:4bit`) and runs an OpenAI-compatible endpoint:

```rust
let args = vec!["serve".to_string(), runtime_model.clone(),
                "--port".to_string(), port.to_string()];
let status = std::process::Command::new("vllm-mlx").args(&args).status();
// prints: export VLLM_MLX_ENDPOINT=http://127.0.0.1:{port}  /  car models discover
```

`--dry-run` prints the command without launching.

JSON-RPC methods the CLI calls on the daemon for inference/models: `infer`, `image.generate`, `video.generate`, `embed`, `models.list_unified`, `models.stats`, `models.register`, `models.unregister`.

The eleven reviewed personal OpenRouter rows carry reviewed capabilities,
USD-per-million-token input/output prices, and tier tags. Cheap/open-weight
entries participate in cost-aware routing but never carry `frontier`;
quality-heavy reasoning can escalate to a frontier-tagged entry, while observed
outcomes and the normal circuit breaker can demote a failing OpenRouter model
exactly like any other provider. Without credentials, those ten rows remain
discoverable but unavailable and stay out of adaptive selection/fallbacks;
explicit selection returns the plain `car keys set openrouter` guidance. With a
credential, the same exact ten rows become available; no other personal
OpenRouter IDs are registered. Callers that know an expected prompt-cache split
can set
`GenerateParams.estimated_cache_read_input_tokens` and
`estimated_cache_write_input_tokens`; both tracked generate and tracked stream
price those explicit estimates. Omitted fields stay zero, so CAR does not claim
cache economics it cannot know before provider usage arrives.

### Setup & recommendation

`car setup` (`cmd_setup`, `main.rs:3669`) is the interactive first-run installer; `car models recommend` is the read-only sibling that prints ranked picks without installing. **Note the flag divergence:** `setup` uses `--use-case`, `models recommend` uses `--for`.

```bash
car setup --use-case assistant --tier balanced --cloud-ok --yes
car models recommend --for coding --tier balanced --cloud-ok
```

- `use_case` accepts: `assistant`, `coding`, `search`, `vision`, `transcription`, `summarize` (+ aliases) → `UseCase::{Assistant,Coding,Summarize,Vision,Transcription,Search}`.
- `tier` accepts: `fastest`, `balanced`, `most-capable` → `QualityTier::{Fastest,Balanced,MostCapable}`. Both default the tier to `balanced`.
- `--cloud-ok` toggles `Privacy::CloudOk` (default `OnDevice`).

Both use the persisted `ResourcePolicy`; missing state defaults to Everyday and
corrupt/unreadable state is surfaced while recommendation safely falls back.
`setup` then calls `pull_model_with_progress` for the chosen pick. Host UIs can
pass a strict, non-persisting `resource_policy` object to `models.setup_plan` to
preview ranking and `evaluated_budget` immediately; only
`models.resource_policy.set` saves and applies the policy.

For the default 32 GB Apple Assistant/Balanced flow, Everyday recommends the
tool-capable 4B-class model and keeps the 8B-class candidate visible as a
heavier explicit alternative.

Acquisition and selection are separate actions. **Download for later** pulls
without choosing a chat model. **Add to CAR** re-establishes CAR management for
a removed local model. Neither a pull response nor a `models.pull_progress`
`completed` notification proves Use is safe: re-read the exact unified row and
require `models.preflight.verdict == "allowed"` before selecting it.

### Speech runtime: `car speech`

```bash
car speech install --json
car speech doctor --json
car speech smoke --local-only --json   # --local-only and --remote-only are mutually exclusive
```

- `install` installs the managed speech runtime + curated local speech models.
- `doctor` reports runtime, local cache, and remote-provider health.
- `smoke` runs end-to-end STT/TTS smoke tests. `--local-only` and `--remote-only` are mutually exclusive (exit 1 if both). With neither flag the remote path runs only if ElevenLabs is configured.

**Which engine actually runs.** On Apple Silicon CAR prefers its native MLX speech backends and falls back to the managed `mlx-audio` Python runtime whenever a native backend can't load a model — currently the case for both curated Kokoro builds and for Parakeet, so in practice local speech runs through the managed runtime there today (Parslee-ai/car#640). On every other platform the managed runtime is the only path. `install` is therefore required on all platforms, not just non-Apple ones, and `doctor`'s `Installed:` line reports whether the runtime is genuinely present rather than assuming it.

The runtime is a `uv`-managed virtualenv holding `mlx-audio` + `misaki[en]` + a spaCy model. It needs a Python `mlx-audio` supports: CAR uses `python3.11`–`3.13` from `PATH` when available, else asks `uv` for a pinned 3.12 and lets uv download it — so a machine whose only interpreter is newer than the supported range still installs cleanly. Pins are overridable via `CAR_SPEECH_RUNTIME_MLX_AUDIO_SPEC`, `CAR_SPEECH_RUNTIME_SPACY_MODEL_SPEC`, and `CAR_SPEECH_PYTHON`.

### Contributed-agent lifecycle

The "agents lifecycle" is a set of **top-level** verbs (not under an `agents` parent) that talk to a running `car-server` over WS JSON-RPC. The CLI owns no agent state — the car-server supervisor does (`~/.car/agents/<id>/`, manifest auto-started on boot). Every verb accepts `--url ws://127.0.0.1:9100/`.

| Command (alias) | JSON-RPC method | Params |
|---|---|---|
| `car install <dir-or-manifest.toml>` | `agents.install` | serialized `AgentManifest` |
| `car ls` (`car agents`) | `agents.list` | `{}` |
| `car inspect <id>` | `agents.list` (filtered) | — |
| `car start <id>` | `agents.start` | `{id}` |
| `car stop <id>` | `agents.stop` | `{id}` |
| `car restart <id>` | `agents.restart` | `{id}` |
| `car tail-log <id>` (`car logs`) | `agents.tail_log` | `{id, n}` |
| `car uninstall <id>` | `agents.remove` | `{id}` |

`daemon_rpc(url, method, params)` opens a socket, runs the `session.auth` then
`server.handshake` connect sequence, sends one JSON-RPC request, and returns the
bare `result`.

```rust
// First WS frame on every daemon-bound command
let token = match car_ffi_common::auth_token::read_for_client() {
    Ok(None) => return Ok(()),                 // no token => daemon is --no-auth; skip
    Ok(Some(t)) => t,
    Err(e) => return Err(format!("read auth token: {e}")),
};
let handshake = serde_json::json!({
    "jsonrpc": "2.0", "id": 0, "method": "session.auth",
    "params": { "token": token },
});
socket.send(Message::Text(serde_json::to_string(&handshake)?.into())).await?;
```

The helper then sends protocol-v3 `server.handshake` with both mandatory model
identity capabilities and validates the numeric version plus negotiated capabilities before returning; the excerpt above shows only its
transport-auth half.

**Installing an agent** (`cmd_install`, `main.rs:5896`) resolves `<path>/manifest.toml` (or the file directly), parses it with `car_bundle::AgentManifest::from_toml_str`, and for an `ExternalProcess` transport either (1) fetches `binary_url` over **https** + verifies `sha256` + writes to `~/.car/agents/<id>/bin/<basename>` (chmod 0755 on unix) and rewrites `transport.command`, (2) verifies an on-disk binary's sha256 in place, or (3) warns **unsigned** if no sha256 is present. Then it serializes the manifest and calls `agents.install`.

```rust
let manifest_path = if path.is_dir() { path.join("manifest.toml") } else { path.clone() };
let text = std::fs::read_to_string(&manifest_path)?;
let mut manifest = car_bundle::AgentManifest::from_toml_str(&text)?;
if let car_bundle::TransportSpec::ExternalProcess(transport) = &mut manifest.transport {
    if transport.binary_url.is_some() {
        fetch_and_verify_binary(transport, &manifest.agent.id).await?;
    } else if let (Some(command), Some(expected)) = (transport.command.clone(), transport.sha256.clone()) {
        verify_local_binary(&command, &expected)?;
    } else if transport.command.is_some() && transport.sha256.is_none() {
        eprintln!("warning: manifest has no sha256 — binary integrity is unverified.");
    }
}
let manifest_json = serde_json::to_value(&manifest)?;
let result = daemon_rpc(url, "agents.install", manifest_json).await?;
```

End-to-end single-agent flow:

```bash
car daemon                       # 1. exec car-server
car auth login                   # 2. (optional) authenticate
# 3. author my-agent/manifest.toml (car-bundle AgentManifest schema)
car install ./my-agent           # 4. fetch/verify binary, agents.install
car ls                           # 5. confirm (alias: car agents)
car start acme/scraper           # 6. unqualified name -> highest installed semver
car tail-log acme/scraper -n 100 # 7. watch output (alias: car logs)
car inspect acme/scraper@1.2.0   # 8. id or <ns>/<name>[@<version>]
car stop acme/scraper            # 9. lifecycle control
car restart acme/scraper
car uninstall acme/scraper       # 10. agents.remove
```

> Gotchas: `binary_url` **must be `https://`** (http rejected). A manifest with no `sha256` installs **unsigned** (warning only). `car ls`/`car logs` are *aliases*, not nested subcommands. `car install` requires `manifest.toml`.

### Memory & evaluation commands

| Command | Flags | Effect |
|---|---|---|
| `car dream` | `-m/--memory <file>`, `-e/--embeddings <bin>`, `--json` | memory consolidation |
| `car eval` | `-t/--trajectories <dir>`, `--json` | default store `~/.car/trajectories/` |

`cmd_dream`/`cmd_reason`/`cmd_distill` route through `DaemonInferenceHandle` (`daemon_handle.rs`), which implements both `InferenceHandle` (`generate`→`infer`, `embed`→`embed`) and `ReasoningInferenceHandle` (`generate_tracked`→`infer`, `find_model_by_name`→cached `models.list_unified`, `record_inferred_outcomes`→`outcomes.resolve_pending`). This reuses the daemon's hot model cache instead of building a second in-process engine. The auth + protocol connect sequence runs **exactly once** inside the lazy-connect `if guard.is_none()` branch — moving it out would repeat per-connection handshakes on every call.

> Gotchas: `record_inferred_outcomes` treats JSON-RPC `-32601` (method not found) as a soft no-op so a CLI↔daemon version skew during rolling upgrade doesn't crash reasoning (set `CAR_REASON_DEBUG` to see the skip log). `car eval`'s `~/.car/trajectories/` is only populated when `auto_distill` is enabled on the runtime; otherwise it reports "No trajectories found".

### Browser automation: `car browse`

```bash
car browse run "<script | ->" --width 1280 --height 720 --headed --pretty
car browse schema     # prints browse_schema.md
```

`run` accepts a script string or `-` for stdin; `schema` prints the documented browse script schema.

### Secrets: `car secrets` (alias `car secret`)

| Command | Flags | Effect |
|---|---|---|
| `car secrets put <key>` | `--service <s>`, `--value <v>` (else stdin) | store a secret |
| `car secrets get <key>` | `--service <s>` | prints value **verbatim** on stdout (pipeable) |
| `car secrets delete <key>` | `--service <s>` | idempotent |
| `car secrets status <key>` | `--service <s>` | status JSON |
| `car secrets available` | — | probes OS secret store |
| `car secrets migrate-from-env` | `--dry-run`, `--service car`, `--include ENV_VAR ...` | migrate API keys into keychain |

`migrate-from-env` migrates built-in vars `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY` (plus any `--include`d extras) into the OS keychain; it refuses if the OS secret store is unavailable. After migration you can `unset` the env vars — car-inference reads from the keychain at runtime.

> Gotcha: `car secrets get` prints the raw value to stdout; all other secret subcommands print status JSON. `put` reads the value from stdin if `--value` is omitted and stdin is not a TTY; on a TTY with no `--value` it errors and tells you to pipe.

### OS permissions: `car permissions`

```bash
car permissions status  <domain> [--target <bundle-id>]
car permissions request <domain> [--target <bundle-id>]
car permissions explain <domain> [--target <bundle-id>]
car permissions domains
```

`status`/`request`/`explain` take a `domain` and an optional `--target` (a macOS Automation bundle id); `domains` lists the available permission domains.

### Cross-host / remote daemon

To drive a remote daemon, pass `--url ws://<host>:9100/` to the lifecycle commands and set `$CAR_AUTH_TOKEN` (honored by `read_for_client()` over the local token file). Tune `$CAR_DAEMON_TIMEOUT` (seconds, default 30) for the connect-time auth/protocol response waits. Inference commands resolve their URL from `$CAR_DAEMON_URL`.

### Environment variables summary

| Variable | Purpose |
|---|---|
| `CAR_HOME` | State root — relocates every CAR state path together (default `~/.car`); absolute paths only |
| `CAR_DAEMON_URL` | Override the daemon WebSocket URL for inference commands |
| `CAR_AUTH_TOKEN` | Override the on-disk auth token (use for cross-host CLI↔daemon) |
| `CAR_DAEMON_TIMEOUT` | Connect-time auth/protocol response timeout in seconds (default 30) |
| `CAR_NO_DAEMON_WARNING=1` | Suppress the singleton-daemon warning when `car-server` isn't on `PATH` |
| `CAR_REASON_DEBUG` | Log the soft no-op skip when the daemon lacks `outcomes.resolve_pending` |
| `VLLM_MLX_ENDPOINT` | Suggested export after `car models serve` (e.g. `http://127.0.0.1:8000`) |

### What is NOT a CLI command

There are **no** `car bundle`, `car mcp`, `car a2a`, or `car registry` subcommands. Those capabilities live in sibling crates (`car-bundle`, `car-mcp`, `car-a2a`, `car-registry`); `car-bundle` is only used internally by `car install` to parse and verify `manifest.toml`. Do not look for CLI verbs for them — they do not exist.

---

## FFI Bindings API Reference (Node / Python / Swift)

CAR exposes the *same* Rust runtime through three host-language FFI surfaces over distinct binding crates:

| Surface | Crate | Stub / IDL file | Naming | Maturity |
|---------|-------|-----------------|--------|----------|
| Node.js (napi-rs) | `car-ffi-napi` | `car-rs/crates/car-ffi-napi/npm/index.d.ts` (hand-maintained) | `camelCase` (auto-converted by napi-rs from Rust `snake_case`) | full surface |
| Python (PyO3) | `car-ffi-pyo3` | `car-rs/crates/car-ffi-pyo3/car_runtime.pyi` (hand-maintained) | `snake_case` (identical to Rust) | full surface |
| Swift / Kotlin (UniFFI) | `car-ffi-uniffi` | `car-rs/crates/car-ffi-uniffi/src/runtime.udl` | UDL-declared | **minimal v1 (preview)** — does *not* mirror NAPI/PyO3 |

The same capability has two spellings across surfaces: `state_get` (Rust/Python) ↔ `stateGet` (NAPI); `build_context_fast` ↔ `buildContextFast`; the `a2ui_*` Rust names deliberately became `a2Ui*` in NAPI (car#177). Below, Rust/Python names are given first; the NAPI camelCase form is mechanically derivable unless noted.

---

### 1. Daemon-first: the through-line for everything below

**Since v0.8, the NAPI and PyO3 bindings are daemon-only.** There is no embedded engine inside the binding any more — every method is a thin WebSocket JSON-RPC client to a singleton `car-server`. The v0.7.x `CAR_FFI_MODE=embedded` fallback is **retired**.

```
CAR_DAEMON_URL=ws://127.0.0.1:9100   # default; override to point at a non-default daemon
```

`car-server` ships as a binary inside the `car-runtime` npm and PyPI packages (`bin/car-server`) and **MUST be running before any binding call**. On macOS the SwiftUI menubar app (`CarHost.app`) auto-launches it and mints a per-launch auth token passed via `--auth-token`; on Linux you start it manually or via systemd.

What this changes for an author:

- **Error handling.** With no `car-server` running, memory / fact / skill / context / event methods now **reject with a daemon-unreachable error** (`#146`) instead of silently returning `0` / `""`. Code that swallowed those zeros will start throwing.
- **Method availability.** A set of methods are documented as **daemon-streamed stubs** in the FFI and only valid against the WebSocket directly (`docs/websocket-protocol.md`): `transcribeStream` / `dispatchVoiceTurn` (in daemon mode) / `ttsStreamStart`. `execute_proposal` is a signature-parity stub in PyO3 — the daemon owns the executor; prefer `submit_proposal` + `register_tool_handler`. `openSession` / `closeSession` / `registerPolicy(sessionId)` are embedded-only; in daemon mode use the `session.open` / `session.close` JSON-RPC methods.
- **JSON-string return convention.** Most methods returning structured data return a **JSON-encoded string** — the caller does `JSON.parse` (Node) / `json.loads` (Python). Scalars (numbers, bools, `string[]`) are typed natively. This keeps the FFI surface stable across protocol changes.

Build / verify commands:

```bash
# Build the Node .node module
cd crates/car-ffi-napi && cargo build --release

# Build + install the Python extension (PyO3 link step only succeeds under maturin)
cd crates/car-ffi-pyo3 && maturin develop

# Verify FFI parity across all surfaces
cargo check -p car-ffi-napi -p car-ffi-pyo3 -p car-server -p car-server-core
bash scripts/check-ffi-parity.sh
```

---

### 2. The `CarRuntime` object

Both NAPI and PyO3 expose a single `CarRuntime` class, constructed with **no args**, carrying state, memory (memgine), tools, policies, and inference. It is the entry point for nearly every in-process capability.

```typescript
const rt = new CarRuntime();          // Node
```
```python
from car_runtime import CarRuntime
rt = CarRuntime()                     # Python
```

#### 2.1 State

| Method (Rust/Python · NAPI) | Signature | Notes |
|---|---|---|
| `state_set` · `stateSet` | `(key, value_json) -> void` | value MUST be a JSON string |
| `state_get` · `stateGet` | `(key) -> str` | returns JSON or `'null'` |
| `state_exists` · `stateExists` | `(key) -> bool` | |
| `state_snapshot` · `stateSnapshot` | `() -> str` | all state as JSON (daemon-side pending) |
| `state_keys` · `stateKeys` | `() -> string[]` | (daemon-side pending) |

#### 2.2 Memory (facts + context)

| Method | Signature | Notes |
|---|---|---|
| `add_fact` · `addFact` | `(subject, body, kind, confidence?) -> int` | `kind` is `'pattern'` (normal) or `'constraint'` (hard rule → Constraints layer with ⚠️ markers); `confidence` 0..1, default 1.0; returns fact count |
| `query_facts` · `queryFacts` | `(query, k?) -> str` | JSON array via PPR spreading activation |
| `fact_count` · `factCount` | `() -> int` | |
| `build_context` · `buildContext` | `(query, model_context_window?) -> str` | 4-layer context (Identity → Constraints → Skills → Facts → Conversation → Environment → Known Unknowns) |
| `build_context_fast` · `buildContextFast` | `(query, model_context_window?) -> str` | skips embeddings/skills/PPR/known-unknowns (voice/real-time); synchronous in NAPI |
| `consolidate` · `consolidate` | `() -> str` | dream/consolidation pass, JSON report |
| `persist_memory` · `persistMemory` | `(path) -> int` | write graph (sandboxed `~/.car/memory/`) |
| `load_memory` · `loadMemory` | `(path) -> int` | load graph; returns fact count |

> **Daemon proxying:** in daemon mode these hit the daemon's per-session memgine via `memory.add_fact` / `memory.query` / `memory.fact_count` / `memory.build_context` / `memory.build_context_fast`. The embedded fallback memgine stays empty by design.
> **Gotcha — `modelContextWindow` not wired:** NAPI `buildContext` accepts `modelContextWindow` but it is **not yet wired through** the daemon's `memory.build_context` JSON-RPC (the arg is dropped). Dynamic budget sizing currently only takes effect when calling the in-process Rust engine directly.
> **Memory path sandbox:** `loadMemory`/`persistMemory` paths are confined to `~/.car/memory/`; `..` segments and out-of-sandbox symlinks are rejected; absolute paths must already be under the base (2026-05 audit boundary).

#### 2.3 Skills (the learning loop)

| Method | Signature |
|---|---|
| `ingest_skill` · `ingestSkill` | `(name, code, platform, persona, url_pattern, task_keywords, description, supersedes_skill?) -> int` |
| `find_skill` · `findSkill` | `(persona, url, task, max_results?) -> str` (JSON or `'null'`) |
| `report_outcome` · `reportOutcome` | `(skill_name, outcome) -> str` — outcome `'success'`\|`'fail'`; **auto-degrades when fail > success + 2** |
| `distill_skills` · `distillSkills` | `(events_json) -> str` |
| `ingest_distilled_skills` · `ingestDistilledSkills` | `(skills_json) -> int` |
| `list_skills` · `listSkills` | `(domain?) -> str` |
| `domains_needing_evolution` · `domainsNeedingEvolution` | `(threshold?) -> string[]` (default 0.6) |
| `repair_skill` · `repairSkill` | `(skill_name) -> Optional[str]` |
| `evolve_skills` · `evolveSkills` | `(events_json, domain) -> str` |

> **Gotcha:** `find_skill` only keys on keyword-shaped trigger fields (persona/url_pattern/task_keywords). A skill whose `structured` is `Some` with empty web fields will **not** be returned — enumerate via `list_skills` and apply your own matcher until structured dispatch lands.

#### 2.4 Inference

| Method | Signature | Notes |
|---|---|---|
| `infer` · `infer` | `(prompt, model?, max_tokens?, intent_json?) -> str` | `intent_json` = serialized `IntentHint` |
| `infer_tracked` · `inferTracked` | **Python:** `(prompt, model?, max_tokens?, context?, tools_json?, messages_json?, tool_choice?, parallel_tool_calls?, intent_json?, images_json?)`<br>**NAPI:** `(..., imagesJson)` — **no `intent_json`** | param order differs; see gotcha below |
| `infer_tracked_with_request` · `inferTrackedWithRequest` | `(request_json) -> str` | JSON-serialized `GenerateRequest`; exposes every field, including `params.strict_model` and intent |
| `infer_with_context` · `inferWithContext` | `(prompt, model?, max_tokens?, intent_json?) -> str` | grounds against assembled context |
| `infer_with_context_tracked` | `(prompt, model?, max_tokens?, intent_json?) -> str` | **PYTHON ONLY** |
| `infer_stream` / `inferStream` | compatibility signatures only; always raise/reject | **UNSUPPORTED FFI STUBS** — use daemon WebSocket `infer_stream` |
| `embed` · `embed` | `(texts, model?) -> str` | JSON float arrays / `{embeddings:[[...]]}` |
| `rerank` · `rerank` | `(query, documents, model?, top_n?, instruction?) -> str` | |
| `classify` · `classify` | `(text, labels, model?) -> str` | JSON `[{label,score}]` |
| `tokenize` · `tokenize` / `detokenize` · `detokenize` | `(model, text)` / `(model, tokens)` | local models only, raw u32 IDs |
| `route_model` · `routeModel` | `(prompt) -> str` | |
| `model_stats` · `modelStats` | `() -> str` | |

**`IntentHint` (route by requirement, not model ID).** `infer` and `inferWithContext` accept an optional serialized `IntentHint`; WebSocket `infer_stream` accepts `intent` inside its request params:

```typescript
// NAPI
await rt.infer(
  prompt, null, null,
  JSON.stringify({ task: 'chat', prefer_local: true } satisfies IntentHint),
);
```

| Type | Values |
|---|---|
| `TaskHint` | `chat \| classify \| summarize \| reasoning \| code \| extract` (closed set) |
| `ModelCapabilityRequirement` | `generate \| embed \| rerank \| classify \| code \| reasoning \| summarize \| tool_use \| multi_tool_call \| vision \| video_understanding \| audio_understanding \| grounding \| speech_to_text \| text_to_speech \| image_generation \| video_generation` |
| `IntentHint` | `{ task?, require?: ModelCapabilityRequirement[], prefer_local?, prefer_fast? }` |

`prefer_fast` takes precedence over `prefer_local`. An empty `IntentHint` is equivalent to omitting it (adaptive routing).

> **Gotcha — `infer_tracked` param order:** Python has `intent_json` (9th) then `images_json` (10th). NAPI's positional `inferTracked` has **neither** — its last param is `imagesJson` and intent is unavailable on that positional path. Use request-shaped `inferTrackedWithRequest(requestJson)` / `infer_tracked_with_request(request_json)` when the caller needs every `GenerateRequest` field.

#### 2.5 Models, recommendations, upgrades

`list_models`, `pull_model(name)->local path`, `remove_model` (daemon owns `models.json`), `list_models_unified` (fields `id,name,provider,capabilities,param_count,size_mb,context_length,available,is_local,max_output_tokens,public_benchmarks,cost`; `cost` is the declared USD/MTok price object — `null` rates mean unpriced, not free), `register_model(schema_json)` (proxies `models.register`), `recommend(use_case, tier, cloud_ok)`, `setup_plan(...)`, `detect_upgrades`, `check_upgrade_nudge(inference_active)`, `dismiss_upgrade(dismiss_key)`, `update_prefs_get` / `update_prefs_set(prefs_json)`.

> **Gotcha:** a newly `register_model`'d model only becomes visible to `infer`/`models.list` on the **next daemon boot** (no live hot-update). Register before starting inference, or restart the daemon.

#### 2.6 Tools, verification, and proposal execution

| Method | Signature | Notes |
|---|---|---|
| `register_tool` · `registerTool` | `(name) -> void` | bare name, no schema validation |
| `registerToolSchema` | `(schemaJson) -> void` | **NAPI ONLY** — typed `ToolSchema`; `register_tool_schema` appears in Python docstrings but is **not** in `car_runtime.pyi` |
| `register_agent_basics` · `registerAgentBasics` | `() -> void` | adds `read_file, write_file, edit_file, list_dir, find_files, grep_files, calculate` |
| `verify_proposal` · `verifyProposal` | `(proposal_json) -> str` | **instance** form — validates against the runtime's own registered tools + state |
| `submit_proposal` · `submitProposal` | **Py:** `(proposal_json, session_id?, scope_json?)`<br>**NAPI:** `(proposalJson, sessionId?)` | uses the **process-wide** registered `tools.execute` handler |
| `execute_proposal` (Py method) | `(proposal_json, tool_fn, session_id?, scope_json?) -> str` | signature-parity stub; daemon owns the executor; `tool_fn(tool_name, params_json) -> str` |

**Typed `ToolSchema` (NAPI):**

```json
{
  "name": "read_file",
  "description": "...",
  "parameters": {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},
  "returns": null,
  "idempotent": true,
  "cache_ttl_secs": 60,
  "rate_limit": {"max_calls": 100, "interval_secs": 60}
}
```

`verifyProposal` type-checks `Action.parameters` against the schema, and the engine auto-wires idempotency / cache / rate-limit hints. Schemaless `registerTool(name)` bypasses type validation.

#### 2.7 Other CarRuntime capabilities

- **Browser:** `browser_run(script_json, width?, height?, headed?, extra_args?)` (ops: `navigate, observe, click, type, scroll, keypress, wait`), `browser_close`.
- **Secrets / permissions:** `secret_available`/`secret_put`/`secret_get`/`secret_delete`/`secret_status`; `permission_domains`/`permission_status`/`permission_request`/`permission_explain` (each optionally targeting `target_bundle_id`).
- **OS-native data:** `accounts_list`/`accounts_open`, `calendar_list`/`calendar_events`, `contacts_containers`/`contacts_find`, `mail_accounts`/`mail_inbox`/`mail_mailboxes`/`mail_messages`/`mail_message_body`/`mail_send`, `messages_services`/`messages_chats`/`messages_send`, `notes_*`, `reminders_*`, `photos_albums`, `bookmarks_list`, `files_locations`, `keychain_status`. Each returns an availability envelope (`{ available, backend, reason?, ... }`). Some are cross-platform: `files_locations` (Known Folder / XDG), `keychain_status` (Keychain / Credential Manager / Secret Service), `bookmarks_list` (Safari on macOS, Chromium — Chrome/Edge/Brave — elsewhere), and `accounts_*`/`calendar_*`/`contacts_*`/`mail_*` (EventKit/Contacts on macOS, Microsoft Graph or WinRT elsewhere). `notes_*`, `reminders_*`, and `photos_albums` are macOS-only and report `available: false` off macOS.
- **Health:** `health_status`, `health_sleep(start_rfc3339, end_rfc3339)`, `health_workouts(...)`, `health_activity(start_ymd, end_ymd)`.

> **Mail reads are not INBOX-only.** `mail_inbox` returns per-account unread/total **counts**, not message rows. For rows use `mail_messages(queryJson)` — the query is `{account_ids?, mailbox?, limit?, since?, include_body?}` with `mailbox: null` meaning INBOX and `limit` 50, so `"{}"` is the plain inbox read. Discover a non-INBOX mailbox with `mail_mailboxes` and pass its `full_name` back as `mailbox`; any user with mail rules has their most useful mail already filed out of INBOX, and an INBOX-only scan reports "no results" rather than "cannot see there". Each row's `id` goes to `mail_message_body(id)`.

> **Gotchas — date formats and param order:** `health_activity` uses **`YYYY-MM-DD`** while `health_sleep`/`health_workouts` use **RFC3339** — different formats on adjacent methods. `contacts_find` param order also differs across surfaces (`(query, limit?, container_ids_csv?)` NAPI vs `(query, container_ids?, limit?)` Python).
> **Event log — NAPI only:** `eventLogStats`, `truncateEventLog(maxEvents?, maxSpans?)`, `clearEventLog`. Both surfaces have `event_count`.

---

### 3. Standalone functions (NAPI / Python module-level)

Not methods on `CarRuntime`. Many take `rt` as the first argument in NAPI but **not** in Python — watch the asymmetry.

#### 3.1 Tool execution: per-call vs process-wide handler

There are **two distinct tool-execution shapes** — do not conflate them:

| Pattern | Registration | Handler signature | When |
|---|---|---|---|
| Per-call callback | `executeProposal(rt, proposalJson, toolFn, sessionId?, scopeJson?)` (NAPI) | `toolFn(callJson) -> Promise<str>`, receives `{tool, params, action_id}` | one-shot proposal execution |
| Process-wide handler | `register_tool_handler(handlerFn)` once, then `submitProposal` | `handlerFn(callJson) -> str`, single JSON arg `{tool, params, action_id}` | daemon-side execution |
| Embedded executor (Python module `execute(...)`) | per-call | `tool_fn(tool_name, params_json) -> str` — **two positional args** | fresh runtime per call |

```typescript
// NAPI: per-call
export function executeProposal(
  rt: CarRuntime,
  proposalJson: string,
  toolFn: (callJson: string) => Promise<string>,
  sessionId?: string | null,
  scopeJson?: string | null,
): Promise<string>;
// toolFn receives {"tool":"name","params":{...},"action_id":"<id>"}

// NAPI: process-wide handler + submitProposal
export function registerToolHandler(
  handlerFn: (callJson: string) => Promise<string>,
): void;
// then: const result = await rt.submitProposal(proposalJson, sessionId);
```

```python
# Python: register the process-wide handler, then submit
from car_runtime import CarRuntime, register_tool_handler
import json
register_tool_handler(lambda call_json: json.dumps(run_tool(json.loads(call_json))))
rt = CarRuntime()
result = rt.submit_proposal(proposal_json)   # raises RuntimeError if no handler
```

> **Gotcha — `submitProposal` fails fast:** it fails **up front** if no `tools.execute` handler is registered. Register before submitting any proposal carrying host tools; otherwise the daemon rejects each host-tool action mid-proposal with a `-32000` error. `unregisterToolHandler()` / `unregister_tool_handler()` clears it. Only one handler is active at a time; re-registering swaps it atomically.

#### 3.2 Verification (stateless module functions)

```python
verify(proposal_json, initial_state_json?, tool_names?, max_actions?, tool_schemas_json?)  # -> JSON {valid, issues}
simulate(proposal_json, initial_state_json?)
optimize(proposal_json)
equivalent(p1_json, p2_json)  # -> bool
```

Pass `tool_names` for existence-only checks, or `tool_schemas_json` (JSON array of `{name, parameters:{type,properties,required}}`) to also type-check each tool call's params. **`tool_schemas_json` takes precedence.** Python also has a module-level `execute(proposal_json, tool_names, tool_fn) -> str` (PYTHON ONLY, fresh runtime per call).

#### 3.3 Multi-agent (stored runner pattern)

```typescript
// NAPI: register ONCE, then call any pattern
await registerAgentRunner(async (specJson, taskJson) => JSON.stringify(agentOutput));
await runSwarm('parallel', agentsJson, taskJson);   // mode: parallel | sequential | debate
```

| Function | NAPI | Python |
|---|---|---|
| `registerAgentRunner` / `register_agent_runner` | `(agentFn) -> void`; `agentFn(specJson, taskJson) -> Promise<str>` | `(agent_fn) -> None`, or pass `agent_fn=` per call |
| `runSwarm` / `run_swarm` | `(mode, agents, task, synthesizerSpec?)` | `(mode, agents_json, task, agent_fn?, synthesizer_json?)` |
| `runPipeline` / `run_pipeline` | `(stages, task)` | `(stages_json, task, agent_fn?)` |
| `runSupervisor` / `run_supervisor` | `(workers, supervisor, task, maxRounds)` | `(workers_json, supervisor_json, task, max_rounds, agent_fn?)` |
| `runMapReduce` / `run_map_reduce` | `(mapper, reducer, task, items)` | `(mapper_json, reducer_json, task, items_json, agent_fn?)` |
| `runVote` / `run_vote` | `(agents, task, synthesizerSpec?)` | `(agents_json, task, agent_fn?, synthesizer_json?)` |

> **Gotcha — `run_swarm` mode value differs:** NAPI documents `parallel | sequential | debate`; Python documents `parallel | sequential | hybrid`. They do **not** share the third mode name.
> **NAPI ThreadsafeFunction cap:** `executeProposal` and `registerAgentRunner` are operational TSF surfaces. `inferStream` retains a legacy TSF parameter only for ABI compatibility and always rejects. All new multi-agent / scheduler / voice / tool callbacks **must** use the stored-callback registration pattern.

#### 3.4 Scheduler, planning, workflows

`createTask(name, prompt, trigger?, schedule?, systemPrompt?)` (trigger `once|cron|interval|file_watch`, default manual), `runTask`, `runTaskLoop(taskJson, maxIterations?)`, `ensureDreamTask() -> bool`; `rankProposals(candidatesJson, tools?, costWeight?)`; `runWorkflow(workflowJson)` / `verifyWorkflow(workflowJson)`; `setReplanConfig(maxReplans, delayMs?)` / `set_replan_config(max_replans, delay_ms?)` (0 disables).

#### 3.5 Streaming / voice (daemon-streamed)

Inference streaming is daemon WebSocket-only: call `infer_stream`, consume
`inference.stream.event`, and read the accumulated final JSON-RPC response.
Direct NAPI/Python streaming symbols are always-error compatibility stubs.
Voice family (NAPI takes `rt`, Python does not): `registerVoiceEventHandler(onEvent)` (`onEvent(sessionId, eventJson)`), `transcribeStream`/`transcribeStreamStop`/`transcribeStreamPush`, `listVoiceSessions`/`listVoiceProviders`, `ttsStreamStart`/`ttsStreamCancel`/`listTtsStreams`, `dispatchVoiceTurn` (standalone in NAPI, `CarRuntime.dispatch_voice_turn` method in Python; returns `{turn_id}`), `cancelVoiceTurn`/`prewarmVoiceTurn`. Speaker/meeting: `prepareParakeet` (~600MB), `prepareDiarizer` (~28MB), `enrollSpeaker`/`listEnrollments`/`removeEnrollment`, `startMeeting`/`stopMeeting(meetingId, summarize?)`/`listMeetings`/`getMeeting`.

> Methods marked `stub: not exposed in FFI` (`ttsStreamStart`, `transcribeStream`, `dispatchVoiceTurn` in daemon mode) require connecting to the daemon WebSocket directly (`docs/websocket-protocol.md`); calling the binding either throws or is only valid in non-daemon contexts.

Relevant event/type shapes: `VoiceStreamEvent` = `speech_start|speech_end|transcript|partial|audio_chunk|barge_in|enrollment_captured|enrollment_failed|done|error`; `VoiceTurnEvent` = `voice.turn.fast_delta|fast_done|bridge(kind email|calendar|search|unknown)|sidecar|error|cancelled`; `AudioSourceSpec` = `{kind:'mic'}|{kind:'system'}|{kind:'file',path}|{kind:'fifo',path}|{kind:'pcm_push',sample_rate,channels?}`.

#### 3.6 Lifecycle-managed (supervised) agents

These manage **contributed agents** declared in `~/.car/agents.json` (a different kind of agent than an in-process proposal-driven one). Wire shapes mirror the daemon `agents.*` JSON-RPC.

```json
{
  "id": "trader", "name": "Trader",
  "command": "/opt/homebrew/bin/node", "args": ["server.js"],
  "cwd": "/path/to/project", "env": { "K": "V" },
  "restart": "on_failure", "max_restarts": 10, "backoff_secs": 5,
  "auto_start": true
}
```

`agentsUpsert(specJson)` writes the manifest (spec needs `id`/`name` and either an absolute `command` or interpreter sugar `node`|`python` resolved against `$PATH` at upsert — **not auto-started**), `agentsInstall(manifestJson)`, `agentsStart(id)`, `agentsStop(id, signal? term|kill)`, `agentsRestart(id)`, `agentsRemove(id)`, `agentsList`, `agentsHealth`, `agentsTailLog(id, n?=100)`.

#### 3.7 External agentic CLIs (Claude Code / Codex / Gemini)

The daemon discovers and invokes installed CLIs — the third kind of agent. `agentsListExternal(includeHealth?)` / `agentsDetectExternal(includeHealth?)` discover `claude-code`, `codex`, `gemini`; `agentsHealthExternal(id?, force?)` runs ground-truth auth-status checks (`claude auth status`, `codex login status`) with a 30s TTL cache; `agentsInvokeExternal(id, task, optionsJson?)` runs a per-task invocation.

- `InvokeOptions`: `cwd`, `allowed_tools` (`[]` denies all), `max_turns`, `timeout_secs` (default 300), `mcp_endpoint`.
- `InvokeResult`: `{answer, session_id?, turns, tool_calls, duration_ms, total_cost_usd?, is_error, error?}`.

#### 3.8 A2A and A2UI

A2A server (**both** NAPI and Python take the runtime first; napi-rs camelCases `a2a` → `A2A`): `startA2AServer(rt, paramsJson)` / `start_a2a_server(rt, params_json)`, `stopA2AServer(rt)`, `a2AServerStatus(rt)`, `sendA2AMessage(rt, paramsJson)`.

```typescript
await startA2AServer(rt, JSON.stringify({
  bind: '127.0.0.1:8731', share_session_runtime: true,
  agent_name, agent_description,
}));   // -> {bound}
```

With `share_session_runtime: true`, tools registered via `registerToolSchema` appear on the Agent Card skills list, and a peer `message/send` that carries an explicit tool invocation (a `data` part `{ tool, parameters }`) routes back to the handler from `registerToolHandler`. A purely conversational `message/send` (free text, no tool `data` part) routes to the host's `agent.chat` handler — the daemon reverse-calls `agent.chat` on this session, aggregates the streamed reply, and returns it as the A2A agent message (car-releases#65). So register an `agent.chat` handler to serve conversational turns. For in-process dispatch without a listener: `a2ADispatch(rt, method, paramsJson)`.

The bundled `car do` / `car do --serve` assistant runs proactive memory before each model turn: it maintains compact execution-state memory from the runtime event log and injects at most one `## Proactive Memory` reminder from the same bank as `remember` / `recall`. Native coder loops also run the proactive pass over the shared repair memgine when learning is enabled, mining the coder session journal into procedural reminders before the next coding turn. External agents that want the same paper-style control loop should call the proactive memory tools (`memory_intervene`, `memory_evaluate`, and save/delete helpers) or implement the same hidden maintenance/intervention pass in their own `agent.chat` handler.

A2UI (`a2ui_*` Rust → `a2Ui*` NAPI): `a2UiCapabilities`, `a2UiApply(envelopeJson)`, `a2UiIngest(payloadJson)`, `a2UiSurfaces`, `a2UiGet(surfaceId)`, `a2UiReap`, `a2UiAction(actionJson)`, `a2UiValidatePayload(valueJson)`.

File-based registry (observe-only, `~/.car/registry/`): `registerAgent(entryJson, registryPath?)`, `agentHeartbeat`, `unregisterAgent`, `listAgents`, `reapStaleAgents(maxAgeSecs, registryPath?)`.

> **Gotchas — A2A:** streaming methods (`message/stream`, `tasks/resubscribe`) return `MethodNotFound` from the transport-neutral `a2ADispatch` surface — HTTP+SSE is the only supported streaming transport. The daemon's WS A2A surface and the in-process `a2ADispatch` singleton keep **separate task stores** (task ids are unique per dispatcher; they will not cross-resolve if you mix both).

#### 3.9 macOS automation + high-risk gate

`runApplescript(argsJson)`, `listShortcuts`/`runShortcut`, `localNotification`, `visionOcr(argsJson)`. These are high-risk operations (AppleScript / Shortcuts / Mail / Messages / Vision OCR) that **park until host approval** at the approval gate.

---

### 4. Per-session scoping and multi-tenant `RuntimeScope`

In **embedded** mode: `openSession() -> id`, then pass `sessionId` to `registerPolicy` / `executeProposal` / `submitProposal` so per-context rules stack on global ones; `closeSession(sessionId) -> bool`. **In daemon mode use `session.open` / `session.close` JSON-RPC instead.** `registerPolicy(name, rule, target?, key?, pattern?, valueJson?, sessionId?)` where `rule` ∈ `deny_tool | deny_tool_param | require_state | deny_tool_callback`.

`executeProposal` / `submitProposal` also take `scopeJson` = serialized `RuntimeScope { caller_id?, tenant_id?, claims? }`. Setting `tenant_id` routes per-action state R/W through a tenant-scoped view (car#187 phase 3), matching the **strict** multi-tenant memory isolation (a scoped view never sees unscoped facts and vice-versa).

---

### 5. UniFFI (Swift / Kotlin) — minimal v1 surface

The UniFFI surface (`car-rs/crates/car-ffi-uniffi/src/runtime.udl`) is a **deliberately minimal v1** and does **not** mirror the NAPI/PyO3 method set. There is **no** state / memory / skills / inference-text method, **no** tool registration, and **no** standalone functions — everything goes through `CarRuntime`. Capability changes are not yet required to land here until it goes from preview to production.

```webidl
interface CarRuntime {
  constructor();
  HealthStatus health();
  [Throws=CarError] sequence<AgentInfo> list_agents(string? capability);
  [Throws=CarError, Async] InvocationResult run_agent(string name, string task);
  [Throws=CarError, Async] InvocationResult invoke_capability(string capability, string? agent_hint, string payload_json);
  [Throws=CarError, Async] DispatchVoiceTurnResponse dispatch_voice_turn(DispatchVoiceTurnRequest request, VoiceTurnObserver observer);
  void register_inference_runner(InferenceRunner runner);
  [Throws=CarError, Async] string send_a2a_message(string message_json);
};
```

Full method set: `health()`, `list_agents(capability?)`, async `run_agent(name, task)`, async `invoke_capability(capability, agent_hint?, payload_json)`, async voice (`dispatch_voice_turn`, `cancel_voice_turn`, `prewarm_voice_turn`), delegated inference (`register_inference_runner` + `inference_runner_emit_event(call_id, event_json)` / `inference_runner_complete(call_id, result_json)` / `inference_runner_fail(call_id, error_message)`), A2UI (`set_a2ui_observer`, `a2ui_capabilities`, `a2ui_apply`, `a2ui_surfaces`, `a2ui_get`, `a2ui_action`, `a2ui_reap`, `a2ui_render_report`), and A2A (`set_a2a_observer`, `send_a2a_message`).

**Foreign-implemented callback traits** (you implement these in Swift/Kotlin):

```webidl
[Trait, WithForeign] interface VoiceTurnObserver { void on_event(string event_json); };
[Trait, WithForeign] interface InferenceRunner   { void start(string request_json, string call_id); };
[Trait, WithForeign] interface A2aObserver       { void on_message(string event_json); };
[Trait, WithForeign] interface A2uiObserver      { void on_event(string event_json); };
```

**Types:**

| Type | Shape |
|---|---|
| `HealthStatus` | `{ is_ready, reason?, available_capabilities: [string] }` |
| `AgentInfo` | `{ id, display_name, description, capabilities: [string] }` |
| `InvocationResult` | `{ agent, result }` |
| `DispatchVoiceTurnRequest` | `{ utterance, session_id?, config_overlay?, sidecar_timeout_ms? }` |
| `DispatchVoiceTurnResponse` | `{ turn_id }` |
| `CarError` | `NotFound \| InvalidArgument \| NoAgentsForCapability \| RuntimeError` |

Typical macOS flow: construct `CarRuntime()`, check `health() -> HealthStatus` and **disable App Intents when `is_ready` is false**, list with `list_agents(capability)`, then `run_agent(name, task)` or `invoke_capability(...)`. For voice, implement `VoiceTurnObserver.on_event` and call `dispatch_voice_turn(request, observer)`. For delegated inference, implement `InferenceRunner.start` and call back `inference_runner_emit_event/complete/fail`.

---

### 6. Surface asymmetry cheat-sheet

| Concern | NAPI | Python | UniFFI |
|---|---|---|---|
| Naming | `camelCase` (`a2Ui*`) | `snake_case` (`a2ui_*`) | UDL-declared |
| `registerToolSchema` | ✅ | ❌ (docstring only, not in `.pyi`) | ❌ |
| request-shaped tracked inference (`inferTrackedWithRequest` / `infer_tracked_with_request`) | ✅ | ✅ | ❌ |
| `infer_with_context_tracked` | ❌ | ✅ | ❌ |
| Direct FFI inference streaming | ❌ (`inferStream` stub rejects) | ❌ (`infer_stream` stub raises) | ❌ |
| module-level `execute(...)` | ❌ | ✅ | ❌ |
| `eventLogStats`/`truncateEventLog`/`clearEventLog` | ✅ | ❌ | ❌ |
| Standalone fn `rt` arg (A2A, transcribe_stream) | takes `rt` | no `rt` | n/a |
| `run_swarm` third mode | `debate` | `hybrid` | n/a |
| `infer_tracked` intent param | absent | present (9th) | n/a |
| Full method set | ✅ | ✅ | ❌ (minimal v1) |

Source-of-truth stubs to navigate: `car-rs/crates/car-ffi-napi/npm/index.d.ts`, `car-rs/crates/car-ffi-pyo3/car_runtime.pyi`, `car-rs/crates/car-ffi-uniffi/src/runtime.udl` and `.../src/lib.rs`. Per repo rule #2, any FFI-boundary change must update all of these plus `car-server-core/src/handler.rs` in the same change — verify with `bash scripts/check-ffi-parity.sh`.

---

## Cross-Host & Mobile Deployment

A finished agent is *data*: a declarative bundle that knows nothing about where it runs. The same bundle executes in four runtime locations, and choosing a location is a **deployment decision, not an agent change**. This section covers how that works, how to point a client at a daemon on another host, and how the agent runtime embeds into native iOS/macOS/Android host apps.

The through-line is the daemon model (CAR §"Daemon-first"). Since every FFI binding is a thin WebSocket client to a singleton `car-server`, "deploying somewhere else" reduces to "point the client at a different daemon URL and present that daemon's token." There is no second deployment API to learn — just two client-side environment variables and the `session.auth` handshake.

### The four runtime locations

The same agent bundle runs in any of these, picked by the job rather than the agent (`docs/mobile-platform.md`, "Distribution model" / "What about hybrid"):

| Location | What runs where | Typical use |
|----------|-----------------|-------------|
| **In-process on a phone** | Runtime embedded as a UniFFI library in the host app; no `car-server` on device | Personal / voice agents, on-device privacy |
| **In-process on a laptop** | Embedded runtime or local daemon on `127.0.0.1` | Local dev, single-user desktop agents |
| **Hybrid** | Thin mobile/desktop client + remote `car-server` (home machine or cloud) | Long jobs, large memory graphs, multi-agent coordination |
| **Pure cloud** | `car-server` backend, scheduled agents, no interactive client | Headless / scheduled automation |

The key consequence: an agent you authored against the FFI/IR (kind #1) needs *no edits* to move from a laptop to a cloud daemon. The hybrid and cloud locations are the only ones where `car-server` is involved on the mobile side — on a pure on-device deployment, **`car-server` and `car-cli` are excluded from the mobile build entirely** (see "Mobile host architecture" below).

### Cross-host: pointing a client at a remote daemon

By default every FFI/CLI/mcp-proxy client connects to a loopback daemon at `ws://127.0.0.1:9100` and reads the local per-launch token file. To talk to a daemon on another host, set two **client-side** environment variables — no code change at the call site (`docs/cookbook/14-cross-host-deployment.md`):

| Env var | Meaning | Default |
|---------|---------|---------|
| `CAR_DAEMON_URL` | WebSocket URL of the daemon | `ws://127.0.0.1:9100` |
| `CAR_AUTH_TOKEN` | The remote daemon's per-launch token (fetched out-of-band) | local token file |

Both follow "env var wins when set" precedence. Crucially, this precedence is **client-side only**: server-side code (the daemon installing its own token, the UI server's `GET /auth-token`) uses `auth_token::read()`, which is *not* env-overridable, so the daemon always advertises the token it actually minted.

```bash
# Daemon host (Linux) — bind to a network interface
car-server --host 0.0.0.0 --port 9100
cat "$XDG_RUNTIME_DIR/ai.parslee.car/auth-token"   # or ~/.config/ai.parslee.car/auth-token

# Client host (Windows pwsh) — fetch token out-of-band, then connect
$env:CAR_AUTH_TOKEN = ssh user@daemon.example.invalid "cat `$XDG_RUNTIME_DIR/ai.parslee.car/auth-token"
$env:CAR_DAEMON_URL = "ws://daemon.example.invalid:9100"
node -e "const {CarRuntime} = require('car-runtime'); new CarRuntime().queryFacts('test').then(console.log)"
```

The token-precedence logic is defensive — a shell-quoting bug must not silently disable auth. Empty, whitespace-only, or non-UTF-8 `CAR_AUTH_TOKEN` values are treated as **unset** (fall through to the local file), and a trailing newline from `ssh ... cat token` is trimmed automatically (`car-rs/crates/car-ffi-common/src/auth_token.rs`):

```rust
pub fn read_for_client() -> io::Result<Option<String>> {
    if let Some(env_value) = std::env::var_os(TOKEN_ENV_VAR) {   // CAR_AUTH_TOKEN
        if let Some(s) = env_value.to_str() {
            let trimmed = s.trim();
            if !trimmed.is_empty() { return Ok(Some(trimmed.to_string())); }
        }
    }
    read()   // local per-platform file
}
```

### The per-launch auth token and protocol handshake

`car-server` mints a fresh **32-byte token (43-char base64url-no-pad)** on every launch, writes it `0600` to a per-platform well-known path, and deletes it on graceful shutdown. The token is distinct per launch and **never persisted across restarts**.

Every WebSocket connection MUST call `session.auth` as its **first** JSON-RPC frame, presenting the token. Any non-`session.auth` method on an unauthenticated session returns `-32001 "auth required: ..."` and the connection is closed. The token comparison is constant-time / length-checked.

```jsonc
// First frame on every WS connection:
{"jsonrpc":"2.0","id":0,"method":"session.auth","params":{"token":"<43 chars>"}}
// Server responds:
{"jsonrpc":"2.0","id":0,"result":{"ok": true, "auth_enabled": true}}
// Await auth success, then prove exact wire compatibility:
{"jsonrpc":"2.0","id":1,"method":"server.handshake","params":{"protocol_version":3,"required_capabilities":["infer.model-identity.v1","models.catalog-identity.v1"],"optional_capabilities":[]}}
{"jsonrpc":"2.0","id":1,"result":{"protocol_version":3,"server_version":"0.51.0","client_protocol_version":3,"negotiated_capabilities":["infer.model-identity.v1","models.catalog-identity.v1"]}}
// Subsequent calls work normally:
{"jsonrpc":"2.0","id":2,"method":"infer","params":{...}}
```

Protocol negotiation is mandatory even when `--no-auth` omits
`session.auth`. `host.subscribe` and `auth.*` reject unnegotiated sockets with
`-32005`; invalid or mismatched handshake requests return `-32006`, and an
unsupported mandatory capability returns `-32008`.

| `session.auth` params | Type | Notes |
|----------------------|------|-------|
| `token` | `string` (required) | The daemon's per-launch token |
| `agent_id` | `string` (optional) | Lifecycle-agent identity binding (#169): a supervised child attaches by sending its `agent_id` with its per-agent token |

`session.auth` returns `{ ok: true, auth_enabled: bool, agent_id?: string, parslee?: ParsleeIdentity }`. When auth is disabled on the daemon, `session.auth` accepts any token and returns `auth_enabled: false`.

| Error code | Condition |
|-----------|-----------|
| `-32001` | "auth required" — a non-auth method was called on an unauthenticated session (connection then closes) |
| `-32603` | "auth failed: token mismatch" — wrong token in `session.auth`; session stays unauthenticated |

### `car-server` flags relevant to deployment

| Flag (env) | Default | Purpose |
|-----------|---------|---------|
| `--port <u16>` | `9100` | Listen port |
| `--host <string>` | `127.0.0.1` | Bind address — use `0.0.0.0` for cross-host |
| `--auth-token <string>` (`CAR_AUTH_TOKEN`) | minted | Pre-minted token to install instead of generating; ignored when `--no-auth` set |
| `--no-auth` (`CAR_NO_AUTH`) | off | Disable the per-launch WS auth handshake ("any local caller wins" legacy mode) |
| `--require-auth` (`CAR_REQUIRE_AUTH`) | — | Deprecated no-op; auth is on by default |
| `--journal-dir <string>` | `~/.car/journals` | Event journal directory |
| `--agents-manifest <string>` (`CAR_AGENTS_MANIFEST`) | `~/.car/agents.json` | Lifecycle-agent manifest |
| (`CAR_HOME`) | `~/.car` | **State root.** Absolute path; relocates every daemon state path at once — journals, manifest, `models.json`, the signed-catalog and discovery caches, routing outcomes, `run/` socket + lock, and the per-platform auth-token directory. The one knob for an isolated second daemon; see `docs/websocket-protocol.md` → *The state root*. Model weights and Python runtimes stay machine-shared (read-only for a relocated daemon) |
| `--mcp-bind <host:port>` (`CAR_MCP_BIND`) | `127.0.0.1:9102` | MCP HTTP-streamable endpoint (`disabled` to opt out) |
| `--a2a-bind <host:port>` (`CAR_A2A_BIND`) | — | A2A HTTP+SSE bind |
| `--no-approvals` (`CAR_NO_APPROVALS`) | off | Disable the high-risk-method approval gate |

A separate client-side env var, `CAR_DAEMON_TIMEOUT`, is consumed by the NAPI/PyO3 FFI clients as a per-call read timeout (the macOS host sets it from `UserDefaults.daemonReadTimeoutSecs`), default 30s. It is a *floor override*: the GPU-bound and blocking methods derive their own generous deadlines and only adopt `CAR_DAEMON_TIMEOUT` when it is *larger* — `proposal.submit` from the proposal's action budgets, `image.generate`/`video.generate` from fixed media floors, and `infer` from a cold-model-load floor (180s) plus a term that scales with the request's text size (~1s per KB).

For `infer` specifically, the deadline is also **idle rather than absolute** (car#476): while an inference is in flight the daemon emits an `infer.progress` heartbeat every ~10s, and the client resets its read window on each one, so a call is only reaped after the timeout elapses with *no daemon activity at all* (a genuine hang). This covers both a cold local-MLX weight load and a slow remote — model-agnostically, since the client can't know which the router picked — so a caller no longer has to set `CAR_DAEMON_TIMEOUT` by hand for large-context or cold-start inference. See `docs/solutions/infer-reaped-by-30s-ffi-read-timeout.md`.

When a token is supplied, the daemon adopts it; otherwise it generates one (`car-rs/crates/car-server/src/main.rs`):

```rust
let auth_enabled = !cli.no_auth;
if auth_enabled {
    let (token, supplied) = match cli.auth_token.as_deref() {
        Some(t) if !t.is_empty() => (t.to_string(), true),
        _ => (car_ffi_common::auth_token::generate(), false),
    };
    match car_ffi_common::auth_token::write(&token) {
        Ok(path) => { let _ = server_state.install_auth_token(token); }
        Err(e) => { /* refuse to start unless --no-auth */ std::process::exit(1); }
    }
}
```

### Auth-token API surface (`car_ffi_common::auth_token`)

| Function | Returns | Notes |
|----------|---------|-------|
| `default_path()` | `io::Result<PathBuf>` | Resolve the per-platform token path |
| `read()` | `io::Result<Option<String>>` | **Server-side** read of the local token — NOT env-overridable |
| `read_for_client()` | `io::Result<Option<String>>` | **Client-side** read — `CAR_AUTH_TOKEN` first (trimmed; empty/whitespace/non-UTF-8 = unset), then local file |
| `write(token)` / `write_at(path, token)` | — | Atomic `0600` write (Windows ACL-hardened) |
| `remove()` | — | Idempotent removal on daemon shutdown |
| `generate()` | `String` | 32-byte base64url-no-pad (43-char) token |

The colocated HTML UI also exposes the token over `GET /auth-token` (`cache-control: no-store`) for the local renderer; this path likewise uses `read()`, not the env override.

### Cross-host gotchas

- **Stale token after restart.** The daemon mints a fresh token each launch and deletes the file on graceful shutdown. After a restart, a previously-fetched `CAR_AUTH_TOKEN` is stale and the next `session.auth` returns `-32001`. Re-fetch the token (same `cat` one-liner) and update the env var. For long-running clients, **re-fetch on each connect** rather than once per shell session.
- **`--host 0.0.0.0` exposes the daemon to any routable peer.** Restrict with a firewall/tunnel or bind to a specific interface IP. CAR has **no token-distribution mechanism** — only client-side consumption; transfer the token out-of-band (ssh/scp/vault).
- **Client-side overrides only.** `CAR_AUTH_TOKEN` and `CAR_DAEMON_URL` never affect what the daemon itself does — the daemon advertises the token it minted via `read()`.
- **The Windows ACL hardening is best-effort.** `write()` uses `icacls` (SYSTEM + owner only, dropping inherited `BUILTIN\Administrators`) but does not defend against a malicious *elevated* admin — that needs DPAPI-class secret storage, tracked separately.

### Mobile host architecture (UniFFI)

On mobile, CAR runs as an **embedded library** via a fourth FFI crate, `car-ffi-uniffi`, parallel to `car-ffi-napi` and `car-ffi-pyo3`. It uses Mozilla UniFFI to generate Swift + Kotlin bindings from a single `runtime.udl` over the same Rust workspace/engine/memgine — only the shim differs. It is subject to the project's hard binding-parity rule.

| Artifact | Platform | Contents |
|----------|----------|----------|
| `CarFfi.xcframework` | Apple (iOS + macOS) | 3 slices |
| `.aar` | Android | 3 ABIs (`arm64-v8a`, `armeabi-v7a`, `x86_64`) |

**`car-server` (WebSocket) and `car-cli` are explicitly excluded from the mobile build.** The host app is responsible for the integration surface: it advertises capabilities, wires tool callbacks to platform APIs (`email` → `MFMailComposeViewController` / `Intent`, `voice-tts` → `AVSpeechSynthesizer` / `TextToSpeech`), manages secrets in Keychain/Keystore, and provides the UX (`docs/mobile-platform.md`, "What's excluded" / "Host application").

**App Review sidestep.** One first-party signed host app per platform carries the runtime; agent bundles ship via the **CAR registry, not the App/Play Store**, so agent changes don't require App Review. Apple and Google permit this because bundles are pure data, not arbitrary executable code (the Pythonista/Scriptable/emoji-keyboard pattern).

**OS-provided on-device inference routing.** Two new `ProtocolHandler` impls extend the adaptive router:
- `AppleFoundationModelsHandler` — macOS 15+ / iOS 26+, A17+, Swift bridge to FoundationModels; route id `apple/foundation:default`.
- `AICoreHandler` — Android 14+, Gemini Nano via ML Kit GenAI.

The adaptive router gains a `low_latency + private` tag bonus to prefer OS-provided local providers for cheap steps and remote Parslee models for larger reasoning. iOS selects `apple/foundation:default` once a runtime probe (Apple Intelligence enabled, A17+) returns true.

### Invoking an agent from a host app via `CarBridge`

iOS (`apps/host-ios`) and macOS (`apps/host-macos`) share one Swift glue layer — `CarBridge` / `CarFfiUniffi` (in `apps/car-a2ui-renderer/Sources/CarBridge`). Use the `CarBridge.shared` singleton, which wraps the UniFFI `CarRuntime`:

| Method | Returns | Fields |
|--------|---------|--------|
| `health()` | `HealthStatus` | `isReady`, `availableCapabilities`, `reason` |
| `listAgents(capability: String? = nil) throws` | `[AgentInfo]` | `id`, `displayName`, `description`, `capabilities` |
| `runAgent(name: String, task: String) async throws` | `InvocationResult` | `.result` |
| `invokeCapability(capability:, agentHint:, payloadJson:) async throws` | `InvocationResult` | — |
| `a2uiApply` / `a2uiSurfaces` / `a2uiGet` / `a2uiAction` / `setA2uiObserver` | — | In-process A2UI surface, same shapes as WS `a2ui.*` |

```swift
status = CarBridge.shared.health()                 // HealthStatus
let agents = try CarBridge.shared.listAgents()     // [AgentInfo]
let result = try await CarBridge.shared.runAgent(name: selectedAgentId, task: prompt)
response = result.result
speech.speak(result.result)
```

`PushToTalkView` (in `apps/host-ios`) feeds the `SFSpeechRecognizer` transcript as the `task` and speaks `result.result` via `AVSpeechSynthesizer`. The iOS speech wrapper is `SpeechManager` (`requestPermissions()` / `startRecording()` / `stopRecording()` / `speak()`) over `SFSpeechRecognizer` + `AVAudioEngine` + `AVSpeechSynthesizer`.

### The macOS host: `CarHost.app` supervises a `car-server` child

`CarHost.app` uses an **in-process** runtime (`CarBridge`) for App Intents, *and* spawns a real `car-server` child on port `9100` so the dashboard, FFI consumers, and MCP clients have a WebSocket endpoint. `BundledDaemon.shared` (`apps/host-macos/Sources/CarHost/BundledDaemon.swift`) mints the token in-process, passes it via `--auth-token` (no disk-roundtrip race), and terminates the daemon on exit:

```swift
let token = Self.mintAuthToken()   // 32 random bytes, base64url-no-pad, 43 chars
currentAuthToken = token
let p = Process()
p.executableURL = binary
p.arguments = [
    "--port", String(defaultPort),   // 9100
    "--auth-token", token,
]
p.environment = augmentedEnvironment()
try p.run()
// stop(): p.terminate() (SIGTERM), 2s grace, then kill(pid, SIGKILL)
```

| `BundledDaemon` member | Purpose |
|------------------------|---------|
| `start()` / `stop()` | Spawn / terminate the supervised `car-server` |
| `currentAuthToken: String?` | The in-memory token (nil if spawn was skipped) |

**Token handoff vs in-process reuse.** The daemon still writes the token to the per-user well-known path so npm/pip FFI consumers, the colocated HTML UI (`GET /auth-token`), and MCP clients read it from disk as before; the supervising host reuses the same in-memory token for its own `session.auth` without a disk roundtrip.

**macOS host gotchas:**
- **Port already in use → no supervision.** If `9100` is occupied (e.g. a manual `cargo run -p car-server`), `BundledDaemon` skips the spawn; `currentAuthToken` is `nil` and clients fall back to the on-disk token of that external daemon.
- **Force-kill leaks an orphan.** `applicationWillTerminate` (Cmd+Q) fires `stop()`, but a force-kill of `CarHost.app` does not — an orphan `car-server` can survive. The next launch's port-in-use guard then skips re-spawning against the orphan.
- **Legacy launchd flow conflicts.** The old `car-server install` launchd path (writing `~/Library/LaunchAgents/ai.parslee.car-server.plist`) is incompatible with host supervision — two supervisors fighting over `9100` mint mismatched tokens. The host logs a remediation message when the plist is detected and still spawns its own daemon if the port is free.
- **Finder/Dock/Spotlight launch blinds CLI detection.** A `.app` launched from Finder inherits launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), hiding Homebrew/NVM/`~/.local/bin` CLIs from `car-external-agents` detection. `BundledDaemon.augmentedEnvironment()` prepends existing user-install dirs to restore detection.

### Building the host apps

**macOS host (`CarHost.app`):**

```bash
# 1. Build the XCFramework (output car-rs/target/uniffi/CarFfi.xcframework)
bash car-rs/crates/car-ffi-uniffi/apple/build-xcframework.sh

# 2. Build the host binary + bundle
cd apps/host-macos && mkdir -p build \
  && swift build -c release \
  && bash scripts/make-app-bundle.sh \
  && bash scripts/validate-host.sh

# For an App-Intents-discoverable bundle (Xcode required for appintentsmetadataprocessor):
cd apps/host-macos && mkdir -p build \
  && bash scripts/make-app-bundle-xcode.sh

# 3. Run (spawns the supervised car-server on 9100)
open apps/host-macos/build/CarHost.app
```

**iOS host (M3 push-to-talk, for TestFlight):**

```bash
# Rust targets (one-time)
rustup target add aarch64-apple-ios aarch64-apple-ios-sim

# Build XCFramework (mobile-only slices) and populate the UniFFI Swift glue
CAR_XCFRAMEWORK_IOS_ONLY=1 bash car-rs/crates/car-ffi-uniffi/apple/build-xcframework.sh
bash apps/host-ios/scripts/prepare.sh

# Compile-only check
cd apps/host-ios && swift build --triple arm64-apple-ios26.0

# Build an .ipa
DEVELOPMENT_TEAM=ABCD123456 XCODE_PROJECT=apps/host-ios/CarHostIOS.xcodeproj \
  bash apps/host-ios/scripts/build-ipa.sh
# Upload via Transporter.app or `xcrun altool --upload-app`
```

One-time iOS prerequisites: Apple Developer Program membership, Xcode 16+ with the iOS 26 SDK, and bundle ID `ai.parslee.car.host.ios` registered.

**Android AAR (foundation for the M6 host):**

```bash
# Rust targets (one-time)
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android

# Build per-ABI libcar_ffi_uniffi.so + Kotlin bindings (.aar)
bash car-rs/crates/car-ffi-uniffi/android/build-aar.sh
# Copy outputs into app/src/main/jniLibs/, then `./gradlew assembleDebug`
```

Android requires an Apple Silicon Mac with Android Studio, NDK r26+, `ANDROID_NDK_ROOT` exported, `cargo install cargo-ndk`, and the three Android Rust targets above.

### Mobile rollout status (mid-rollout)

| Milestone | Status |
|-----------|--------|
| M1 — macOS Apple frameworks | Shipped |
| M2 — `car-ffi-uniffi` XCFramework + AAR | Shipped |
| M3 — iOS push-to-talk host | Scaffolded |
| M6 — Android host | Scaffolded |

**Mobile gotchas:**
- **No headless iOS CI for discoverability.** App Intents / Siri / Spotlight discovery requires Apple's `appintentsmetadataprocessor`, which only runs in the Xcode build pipeline. A plain `swift build` + `make-app-bundle.sh` produces a runnable engine that is **not** discoverable; there is no fully-headless CI path until SwiftPM gains App Intents metadata support.
- **Android is scaffolded.** `apps/host-android` now has a Kotlin + Compose host with Parslee sign-in, automatic Parslee Core discovery, streamed chat, approvals, remote A2UI, OS capability disclosure, emulator fixture validation, and a Play upload bundle helper. AICore / Gemini Nano routing is still pending.
- **Mobile model policy.** Phone-local inference is limited to OS-provided providers such as Apple Foundation Models or Android AICore when device gates pass. Parslee Core is the default flagship assistant; larger reasoning and non-OS model runtimes execute remotely through Parslee or connected computers.

---

## Capability Catalog, Cheat Sheet & Next Steps

This section is the reference back-half of the guide: a flat, scannable inventory of everything CAR ships, the exact method/command/flag names you'll reach for, and a guided "what to read next" map. It assumes the through-line established earlier: **as of v0.8 every FFI binding is a thin WebSocket client to a singleton `car-server` daemon that must be running first.** Nothing below works until the daemon is up.

---

### The one thing that gates everything: the daemon

Since v0.8 (the daemon-only FFI pivot), `CarRuntime()` in Node and Python no longer hosts an in-process engine — it lazy-connects to a singleton `car-server` over WebSocket on first call. Start the daemon once per host before any binding call:

```bash
car-server --port 9100          # default port, auth ON
# or via the language packages (they bundle the binary):
npx --package=car-runtime car-server
python -m car_runtime.server
# or, on macOS, just launch CAR Host.app — it supervises car-server for you
```

| Surface | Default | Notes |
|---------|---------|-------|
| WebSocket (JSON-RPC) | `ws://127.0.0.1:9100/` | Auth on by default. `car-server --port 8080` shown in README too — the port is not fixed, so match your client's connect URL. |
| UI HTTP | `9101` | CarHost dashboard / static renderers. |
| MCP HTTP-streamable | `9102` | `--mcp-bind 127.0.0.1:9102` (env `CAR_MCP_BIND`); `disabled` to skip. |
| A2A | opt-in | `--a2a-bind <ADDR>` (env `CAR_A2A_BIND`); off unless set. |

**Auth token resolution.** CarHost mints a per-launch token and passes it via `--auth-token`. FFI clients read the token file at `~/.car/auth-token` (macOS) or `%LOCALAPPDATA%\ai.parslee.car\auth-token` (Windows). The relevant env vars are `CAR_DAEMON_URL` and `CAR_AUTH_TOKEN`.

**FFI-vs-WS method divergence (memorize this).** Three capabilities are daemon-only and do *not* exist on the Python FFI in v0.8 — you must connect to the WebSocket directly and use `proposal.submit` + a `tools.execute` handler:

- `execute_proposal` (proposal execution with a tool callback) — exposed on **Node** as the standalone `executeProposal(rt, json, fn)`, **not** on Python FFI.
- `infer_stream` — streaming inference.
- `dispatch_voice_turn` / streaming TTS (`voice.tts_stream.start`) — WS-only; NAPI/PyO3 expose TTS streaming as a stub returning a "use WebSocket" error (only `tts_stream_cancel`/`list` are live across FFI).

---

### Three kinds of agent, one runtime

A single-agent author must first decide *which kind* they're building — the authoring surface, packaging, and lifecycle differ completely. The docs treat kind #1 as the default and barely surface #2/#3.

| Kind | What it is | How you author it | Lifecycle / packaging |
|------|-----------|-------------------|------------------------|
| **1. In-process, proposal-driven** | You drive the IR yourself against the FFI/WS. The default. | `CarRuntime()` → `register_tool` → `register_policy` → build proposal JSON → `verify_proposal` → `execute_proposal(rt, json, fn)` | Your process; no packaging. |
| **2. Lifecycle/supervised contributed agent** | A long-lived child process the daemon supervises. | `manifest.toml` (schema + canonicalization + ed25519 sign/verify), `car install` | `~/.car/agents.json` manifest; `agents.*` WS lifecycle; auto-started on car-server boot. |
| **3. External agentic CLI** | Claude Code / Codex / Gemini, detected and invoked by the daemon. | `agents.invoke_external` with `InvokeOptions`; or in a swarm via `AgentSpec.name` prefix `external:` | Discovered by `car-external-agents`; no packaging. |

---

### Capability catalog (by crate / subsystem)

| Subsystem | Crate | Headline capability | Primary entry points |
|-----------|-------|---------------------|----------------------|
| Agent IR | `car-ir` | The contract: `Action`, `ActionProposal`, `Precondition`, `FailureBehavior` | proposal JSON (`actions[]`) |
| Verification | `car-verify` | Statically check plans before execution | `verify`, `simulate`, `equivalent`, `optimize`, `verify_with_schemas` |
| Execution | `car-engine` | DAG concurrent execution + idempotency/retry/timeout/rollback | `execute_proposal` |
| Memory | `car-memgine` | Petgraph graph memory + spreading activation + 4-layer context | `add_fact`, `query_facts`, `build_context`, `build_context_fast`, `build_context_for_model`, `consolidate`, `persist_memory`, `load_memory` |
| Skills | `car-memgine` | First-class graph nodes, auto-degradation, distill/evolve/repair loop | `ingest_skill`, `find_skill`, `report_outcome`, `distill_skills`, `ingest_distilled_skills`, `list_skills`, `domains_needing_evolution`, `evolve_skills`, `repair_skill` |
| Policies | `car-policy` | Per-action deny rules (+ `InspectorChain`) | `register_policy`, `register_tool`, `register_tool_schema`, `register_agent_basics` |
| Inference | `car-inference` | OpenAI/Anthropic/Google via `ProtocolHandler`; context-aware routing | `infer`, `infer_tracked`, `infer_with_context`, `infer_with_context_tracked`, `infer_stream`, `embed`, `classify`, `route_model`, `model_stats` |
| Model UX (v0.20) | `car-inference` | Intent-driven recommendation | `recommend(models, hardware, use_case, tier, privacy) -> RecommendationSet` |
| Multi-agent | `car-multi` | swarm / pipeline / supervisor / map-reduce / vote | `run_swarm`, `run_pipeline`, `run_supervisor`, `run_map_reduce`, `run_vote`, `register_agent_runner` |
| External CLIs | `car-external-agents` | Invoke Claude Code/Codex/Gemini | `agents.invoke_external`, `agents.list_external`, `ExternalAwareRunner` |
| Supervised agents | `car-registry` | Declarative lifecycle of child processes | `agents.{list,upsert,remove,start,stop,restart,tail_log,health,install}` |
| Bundles | `car-bundle` | `manifest.toml` + ed25519 sign/verify | `car install/ls/inspect/uninstall` |
| MCP server | `car-mcp` | stdio + HTTP-streamable; shared memgine | `tools/list`, `tools/call`, `POST /mcp`, `GET /mcp/health` |
| A2A bridge | `car-a2a` | Agent2Agent v1.0 | `message/send`, `tasks/*`, SSE streaming |
| A2UI surface store | `car-a2ui` | Surface store + envelope validator | `a2ui_capabilities/apply/ingest/surfaces/get/reap/validate_payload`; WS `a2ui.*` |
| Voice + meeting | `car-voice`, `car-meeting` | Streaming STT/TTS, VAD, meeting capture | `transcribeStream*`, `startMeeting`/`stopMeeting`, `dispatchVoiceTurn` |
| Browser | `car-browser` | Chromium automation (unconditional since v0.14) | `car browse run` |
| Apple frameworks | `car-vision`, `car-nlp`, `car-translate`, `car-soundanalysis`, `car-automation` | OCR/NER/translate/audio-events/AppleScript | each has `is_available()` |
| Auth | `car-auth` | Parslee OAuth2 PKCE | `auth.start/complete/status/logout`; `car auth login parslee` |

---

### The Agent IR — the contract everything builds on

The IR round-trips identically across NAPI (camelCase), PyO3 (snake_case), and WebSocket JSON-RPC because of serde `snake_case` enums + `serde(default)`. A proposal is a JSON object with an `actions` array; each action carries the DAG and execution semantics.

```json
{
  "actions": [
    {
      "id": "a1",
      "type": "tool_call",
      "tool": "deploy",
      "parameters": {"env": "staging"},
      "preconditions": [{"key": "tests_passed", "operator": "eq", "value": true}],
      "expected_effects": {"deployed": true},
      "state_dependencies": ["build_artifact"],
      "idempotent": true,
      "failure_behavior": "retry",
      "max_retries": 3,
      "timeout_ms": 30000
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `type` | One of `tool_call`, `state_write`, `state_read`, `assertion` |
| `tool` / `parameters` | Tool name + args; params may reference prior outputs as `"$a1.output"` |
| `preconditions` | `{key, operator, value}` — checked before execution |
| `expected_effects` | Declared post-state |
| `state_dependencies` / `dependencies` | Form the DAG; actions with resolved deps run concurrently via `futures::future::join_all` |
| `idempotent` | Safe to retry |
| `failure_behavior` | e.g. `retry`; paired with `max_retries`, `timeout_ms` |

---

### Verify → execute (the deterministic half)

```typescript
const check = JSON.parse(await rt.verifyProposal(proposal));
if (!check.valid) throw new Error(JSON.stringify(check.issues));
const result = await executeProposal(rt, proposal, async (callJson) => {
  const { tool, params } = JSON.parse(callJson);
  return JSON.stringify(await myTools[tool](params));
});
```

Standalone verification functions: `verify(proposalJson, stateJson)` → `{valid, errors}`, `simulate(proposalJson, stateJson)` → final state, `equivalent(planA, planB)`, `optimize(proposalJson)`. Verification detects impossible plans (unsatisfiable preconditions), missing dependencies, write conflicts, infinite loops (duplicate identical tool calls), resource exhaustion, and missing/unregistered tools.

**Gotcha (v0.18):** `verify(...names...)` is *existence-only*. Only `verify_with_schemas(...)` / `verify_proposal` with a registered `ToolSchema` map (passed as `toolSchemasJson` / `tool_schemas_json`) validates tool-call parameter *types* (incl. union/integer) and required-presence.

**The tool callback contract** — the runtime never owns tools. You register a name, then supply `tool_fn(tool, params_json) -> str` returning a JSON string. Errors come back as `{"error": "..."}`; the runtime handles retries/replans. In NAPI: `ThreadsafeFunction` with `ErrorStrategy::Fatal` and `call_async::<Promise<String>>`.

---

### Propose → observe → re-propose (the autonomous half)

The deterministic verify/execute primitive is only half the loop. CAR ships the autonomous-half machinery the docs stop short of: active-planner candidate generation, planner scoring, `ReplanCallback`/`ActiveReplanAdapter` for failure recovery, `AgentOutcome` terminal states, and replan config. The bridge a single-agent author needs: a model proposes an IR (`infer_tracked` → parse `text` as `{actions:[...]}`), you `verify_proposal` then `execute_proposal`, observe the result, and re-propose until `AgentOutcome` reaches a terminal state.

```python
out = json.loads(rt.infer_tracked(
    f"Propose a JSON action plan for: {task}. Return ONLY a JSON object with an `actions` array.",
    max_tokens=2048,
))
proposal = json.loads(out["text"])
```

---

### Four safety layers (don't conflate them)

Authors routinely confuse these. They compose, and **deny wins / first-Deny short-circuits.**

| Layer | What it does | Mechanism | API |
|-------|--------------|-----------|-----|
| **Capabilities** | Allow-list what an agent *can* touch | `CapabilitySet`, `AuthzPipeline` | bundle capability vocab (`nlp.*`, `vision.*`, `audio.classify`, `translate.text`) |
| **Policies** | Deny rules evaluated *per action* | `PolicyEngine` | `register_policy(name, kind, tool, param, value)` — `deny_tool`, `deny_tool_param`, `require_state`, `max_calls_per_tool` (llms.txt also lists `deny_tool_callback`) |
| **Inspectors** | Hot-path, dispatch-time guardrails | `InspectorChain` | egress / repetition / adversary inspectors |
| **High-risk approval gate** | Parks sensitive actions until host approval | host UI | AppleScript / Shortcuts / Mail / Messages / Vision OCR park in the Approvals tab |

```python
rt.register_policy("no_rm", "deny_tool_param",
                   target="shell", key="command", pattern="rm -rf")
```

**Scoping gotcha:** `register_policy` is **global per `CarRuntime` instance**. There is no per-session policy scoping on the FFI (deferred). For multi-tenant/IDE hosts, spin up one `CarRuntime` per tenant/session. (The WS surface does add per-session scoping via `session.policy.open|close` / `policy.register`, v0.7.0.)

---

### Memory is the runtime, not a bolt-on

Facts live in a `petgraph::StableGraph`; edges are `Supersedes`, `DependsOn`, `RelatedTo`, `Triggers`, `TemporalNext`. Retrieval is spreading activation, not vector lookup. Context assembly follows the Liotta 2026 four-layer (six-stage) model, relevance-ascending: **Identity → Constraints → Facts → Conversation → Environment → Known Unknowns** (the Rust engine described here scores 93.8% ± 0.5% on StateBench's official test split with GPT-5.2; the Python reference implementation of the same design is at 94.16% ± 1.05%. See README.md).

```typescript
await rt.addFact('project_language', 'TypeScript', 'decision');
const facts   = await rt.queryFacts('language');
const context = await rt.buildContext('What language is this project?');
```

- `build_context_for_model(query, Some(context_window))` — dynamic budget sizing from the model's window.
- `build_context_fast()` / `ContextMode::Fast` — skips embedding flush, skill lookup, PPR scoring; for voice/real-time.
- `consolidate()` merges; `persist_memory`/`load_memory` for durability.

**Skills loop (what turns a single agent from stateless to learning).** Skills are first-class graph nodes with trigger edges. The distill/evolve/repair loop plus skill-first execution (skip the LLM when a learned workflow matches) is what FlyX's design note projects would cut ~75% of token cost.

```typescript
rt.ingestSkill('deploy', ['deploy', 'release', 'ship'], steps);
const skill = rt.findSkill('how do I deploy?');   // spreading-activation match
rt.reportOutcome('deploy', true, 1200);            // tracks success/failure
// Auto-degradation: fail_count > success_count + 2 → marked deprecated
```

**Gotcha:** `distill_skills` / `evolve_skills` require configured inference — without a model they hang waiting. Bootstrap with hand-coded skills + `ingest_distilled_skills`.

**The `.car/` project dir** — team-shareable identity/constraints/facts/skills/policies/config checked into git, auto-discovered by walking up from cwd like `.git`. `car init` scaffolds it.

---

### Agent Basics stdlib

`register_agent_basics()` opt-in registers a built-in tool stdlib once per runtime: `read_file`, `write_file`, `edit_file`, `list_dir`, `find_files`, `grep_files`, `calculate`. Read-only tools register as built-ins; mutating file tools remain approval-worthy.

---

### Multi-agent cheat sheet

All patterns take an `Arc<dyn AgentRunner>` (Rust) or a stored runner via `register_agent_runner` (FFI — required because only 3 NAPI standalones may carry a `ThreadsafeFunction`).

| Fn | Shape |
|----|-------|
| `run_pipeline(stages_json, task, agent_fn)` | linear chain, each stage feeds the next |
| `run_swarm(mode, agents_json, task, agent_fn, synthesizer_json?)` | mode `parallel\|sequential\|debate` |
| `run_supervisor(workers_json, supervisor_json, task, max_rounds, agent_fn)` | supervisor routes subtasks |
| `run_map_reduce(mapper_json, reducer_json, task, items_json, agent_fn)` | parallel map then reduce |
| `run_vote(agents_json, task, agent_fn, synthesizer_json?)` | parallel + voted/synthesized |

`agent_fn(spec_json, task)` must return JSON with **exactly**: `name`, `answer`, `turns`, `tool_calls` (an **integer count, not an array**), `duration_ms`, `error`. Missing fields break deserialization silently.

Mix in external CLIs by wrapping the runner and prefixing the spec name:

```rust
let host_runner: Arc<dyn AgentRunner> = Arc::new(MyChatRunner);
let runner: Arc<dyn AgentRunner> =
    Arc::new(car_external_agents::ExternalAwareRunner::new(host_runner));
// AgentSpec.name = "external:claude-code" | "external:codex" | "external:gemini"
// metadata keys cwd, allowed_tools, max_turns, timeout_secs, mcp_endpoint → InvokeOptions
```

---

### CLI cheat sheet

```bash
# Models (v0.20 first-class UX)
car setup --use-case coding --tier balanced --yes   # detect HW, recommend, install
car models recommend --for assistant                # read-only preview
car models doctor                                   # nudges car setup if no local model
car models pull qwen/qwen3-1.7b:q8_0                 # CPU-only local model
car models upgrades / car models upgrade --apply
car info                                            # RAM / max model size / recommended

# Secrets (resolution priority: process env > ~/.car/env > OS keychain > hard error)
car secrets put OPENAI_API_KEY
car secrets list
car secrets migrate-from-env --dry-run

# Auth (Parslee managed inference)
car auth login parslee     # loopback OAuth2 PKCE, token in OS keychain
car auth status / car auth logout

# Contributed bundles + supervised lifecycle
car install / car ls / car inspect / car uninstall
car start | stop | restart
car tail-log <id> -n 100 --json   # alias: car logs

# Server lifecycle
car-server --port 9100
car-server --mcp-bind 127.0.0.1:9102      # disabled to skip
car-server --a2a-bind <ADDR>
```

`car setup` use cases: `assistant`, `coding`, `search`, `vision`, `transcription`, `summarize`. Tiers: `fastest`, `balanced`, `most-capable`. Add `--cloud-ok` to let cloud models compete.

---

### WebSocket JSON-RPC cheat sheet (73+ methods / 23 namespaces)

```json
{"jsonrpc":"2.0","method":"proposal.submit","params":{"proposal":"..."},"id":1}
{"jsonrpc":"2.0","method":"memory.add_fact","params":{"key":"x","value":"y","source_type":"user"},"id":2}
{"jsonrpc":"2.0","method":"memory.build_context","params":{"query":"..."},"id":3}
{"jsonrpc":"2.0","method":"skill.ingest","params":{"name":"deploy","triggers":["deploy"],"steps":[]},"id":4}
```

| Namespace | Representative methods |
|-----------|------------------------|
| proposal / tools | `proposal.submit`; `tools.execute` (bidirectional, server→client) |
| memory / skill | `memory.add_fact`, `memory.build_context`, `memory.query`, `skill.ingest` |
| agents (lifecycle) | `agents.{list,upsert,remove,start,stop,restart,tail_log,health,install}` |
| agents (external) | `agents.invoke_external`, `agents.list_external`, `agents.chat.event` (streaming, v0.11) |
| auth | `auth.start`, `auth.complete`, `auth.completion_status`, `auth.snapshot`, `auth.status`, `auth.logout` |
| voice | `voice.dispatch_turn`, `voice.cancel_turn`, `voice.prewarm_turn`, `voice.tts_stream.start/cancel/list` |
| inference | `inference.register_runner`, `inference.runner.invoke/event/complete/fail` |
| a2ui | `a2ui.*` (daemon-shared) |
| session/policy | `session.auth`, `session.policy.open/close`, `policy.register` |
| models | `models.recommend`, `models.setup_plan`, `models.resource_policy.get/set`, `models.preflight`, `models.storage_roots`, `models.adopt`, `models.remove`, upgrade/preferences methods, and `models.pull` (streams `models.pull_progress`); notification `models.upgrade_available` |

**Chat-capable supervised agents** must be running **and** attached via `session.auth { role: "agent" }`; helpers that only register an A2UI surface show as `— not chat-capable`. The daemon emits `token` + `done` frames — **the `done` frame carries the authoritative full reply in `text`** (host bug fixed in v0.18; clients must read it).

---

### Inference & model sourcing

`ProtocolHandler` unifies OpenAI/Anthropic/Google. `ModelSource` variants: `native`, `Ollama`, `RemoteApi`, `Delegated{hint}` (host owns the wire format via the `InferenceRunner` trait), `Proprietary` (Parslee-managed). Routing supports `IntentHint` (`prefer_fast`/`prefer_local`) and `RoutingWorkload::Fastest`. v0.17 added an `images_json` param to `infer_tracked`:

```json
{ "type": "image_base64", "data": "<b64>", "media_type": "image/png" }
```

**Parslee managed inference:** after `car auth login parslee`, `parslee/fast|reasoning|advisor` run zero-config. By design these are **single-message turns, non-streaming only** — `generate_stream` returns a clear error.

---

### Apple frameworks, MCP, A2A, A2UI (cfg-target gated, each with `is_available()`)

- **MCP:** `POST /mcp` (JSON-RPC 2.0), `GET /mcp/health` (`{"status":"ok","protocol_version":"2024-11-05","server_name":"car-mcp"}`). stdio variant is stateless (memory/skill/verification tools only, no proposal execution). Sixteen tools exposed incl. `memory_add_fact` plus proactive `memory_intervene` / `memory_evaluate` and the four verification tools `verify` / `simulate` / `equivalent` / `optimize`; facts land in the shared memgine and appear in WS `memory.query`.
- **A2A v1.0:** `message/send`, `tasks/get|list|cancel`, `tasks/pushNotificationConfig/{set,get,list,delete}`, `agent/getAuthenticatedExtendedCard`; `message/stream` + `tasks/resubscribe` via SSE. HTTP: `GET /.well-known/agent.json`, `POST /` (JSON-RPC), `GET /a2a/stream/:task_id`. Mount via `car_a2a::serve(dispatcher, addr)` / `build_router(dispatcher)`.
- **A2UI:** `a2ui_*` in-process (FFI parity added v0.15.x) + WS `a2ui.*`. Renderers: HTML (`car-server/static`), SwiftUI (`apps/host-macos`).

---

### Top gotchas to carry forward

- **Daemon-first:** every FFI call fails if `car-server` isn't running. The port is not fixed — match the connect URL (`ws://127.0.0.1:9100/` by default).
- **Python FFI cannot execute proposals** in v0.8 — use the WS `proposal.submit` + `tools.execute` path. Same for `infer_stream` and streaming TTS.
- **Naming:** Rust `snake_case`; NAPI auto-converts to `camelCase` at runtime (`state_get` → `stateGet`); Python keeps `snake_case`. `executeProposal`/`registerAgentRunner` are **standalone functions** in JS, not methods.
- **macOS is Apple Silicon only** (Intel/x86_64-apple-darwin dropped). Linux aarch64 has a tarball but **no pip wheel**. Direct `.tar.gz` downloads get Gatekeeper quarantine — clear with `xattr -d com.apple.quarantine ...`; npm/pip strip it automatically.
- **No cargo feature flags** in `car-*` crates — downstream manifests with `features=[...]` (e.g. browser `chromium`, desktop `macos`) now fail; chromium is unconditional, macOS desktop is cfg-target.
- **`verify` is existence-only**; only `verify_with_schemas` validates parameter types/presence.
- Python package is `car-runtime` but the import is `import car_runtime` (underscore).
- MLX GPU paths (v0.16.1+) need `mlx.metallib` colocated with the binary; otherwise a clean `DeviceError` (set `MLX_METAL_PATH` or `CAR_MLX_DEVICE=cpu`). Pre-1.0: breaking changes possible between minor versions — pin exact versions.

---

### Next steps — where to read deeper

| If you want to… | Go to |
|-----------------|-------|
| Understand the IR field-by-field | `docs/agent-ir-spec.md` |
| Build the call/verify path | `docs/cookbook/01-tool-call-and-verify.md` |
| Wire memory + 4-layer context | `docs/cookbook/02-memory-and-context.md` |
| Expose CAR to Claude Desktop/Cursor | `docs/cookbook/07-mcp-server.md` |
| Bridge to other A2A agents | `docs/a2a.md` |
| Build A2UI renderers | `docs/a2ui-renderer-contract.md` |
| Map every WS method | `docs/websocket-protocol.md` (73+ methods, 23 namespaces) |
| Package a contributed agent | `car-bundle` crate + `manifest.toml` schema |
| Generate a first single-file agent | README "Build your first agent (copy/paste into an LLM)" block |
| Trace capability history | `CHANGELOG.md` (v0.5.0 → v0.20.0) and `docs/SUMMARY.md` |
| Study a consumer's architecture | `docs/case-study-flyx.md` (7 autonomous Playwright agents; ~75% saving is projected, not measured) |

Rust starter dependency set: `car-engine`, `car-memgine`, `car-inference`, `car-ir`.

---

## Appendix A — Known Documentation Gaps & Author Notes

These are gaps the multi-agent survey flagged between CAR's *shipped* capability and its *documented* surface. They are recorded here so an author knows where the source is the only ground truth.

**Coverage assessment:** The CAR docs cover the static "verify-then-execute one proposal" primitive well (cookbook 01-11, agent-ir-spec, websocket-protocol with ~188 methods), plus memory/context, skills, policies, multi-agent, MCP, .car/ dir, keychain, and cross-host. But for someone whose goal is to AUTHOR A SINGLE WORKING AGENT (not just execute a pre-built proposal), there are large gaps. The most serious: nowhere is the closed agentic loop documented — the iterate cycle where the model proposes a batch, the runtime executes, the agent observes ActionResults/AgentOutcome, and the model proposes again until the goal is met. Every cookbook hardcodes one proposal and executes it once. Whole shipped subsystems (workflow, scheduler, reason-engine, active-planner, contributed-agent CLI lifecycle, external agents, voice two-track, browser tools) have either zero cookbook coverage or only proposal/spec/roadmap docs that a consumer "has no access to source" for. There is also no single map of CLI commands, no troubleshooting/"daemon not running" guide, and no doc on how to actually generate proposals from a model (the front half of "models propose"). Coverage is roughly 60% of the surface a single-agent author needs; the deterministic-execution half is documented, the autonomous-loop and orchestration halves are not.

### Cross-cutting truths every author should internalize

- Daemon-first is now mandatory and reframes everything: since v0.8 every supported FFI operation targets a singleton car-server that MUST be running first (`CAR_DAEMON_URL` / `CAR_AUTH_TOKEN`). Callback-bearing inference streaming is not supported by the FFI at all; its compatibility stubs always error and callers use the WebSocket directly.
- Three kinds of agent, one runtime: (1) in-process proposal-driven agents you author against the FFI/IR, (2) lifecycle/supervised contributed agents (manifest.toml + car install + agents.* lifecycle), and (3) external agentic CLIs (Claude Code/Codex/Gemini) discovered and invoked by the daemon. A single-agent author must understand which kind they are building, because the authoring surface, packaging, and lifecycle differ completely. Docs treat #1 as default and barely surface #2/#3.
- Two distinct safety mechanisms that authors conflate: capabilities (allow-listing what an agent CAN touch — CapabilitySet, AuthzPipeline) vs policies (deny rules evaluated per action — PolicyEngine deny_tool/deny_tool_param/require_state) vs inspectors (hot-path dispatch-time guardrails — egress/repetition/adversary). Plus the high-risk approval gate (AppleScript/Shortcuts/Mail/Messages/Vision OCR park until host approval). An author securing a single agent needs all four layers and how they compose (deny wins, first-Deny short-circuits).
- Memory is the runtime, not a bolt-on: facts (add_fact/query_facts spreading activation), skills (first-class graph nodes with auto-degradation and the distill/evolve/repair loop), four-layer context assembly with dynamic budget sizing, and the .car/ project dir (team-shareable identity/constraints/facts/skills/policies/config, auto-discovered by walking up like .git). The skills loop especially is what turns a single agent from stateless to learning — and it directly enables the token-saving 'skill-first execution' (skip the LLM when a learned workflow matches) that FlyX's design note projects would cut ~75% of token cost.
- The IR is the contract that unifies every surface: ActionProposal/Action round-trip identically across NAPI (camelCase), PyO3 (snake_case), and WebSocket JSON-RPC because of serde snake_case enums + serde(default). Understanding the IR (preconditions, expected_effects, state_dependencies forming the DAG, idempotent, failure_behavior, AgentOutcome) is the prerequisite for verification, execution, planning, workflow stages, and the agent loop — it is the single concept everything else builds on.
- The verify->execute pipeline is only half the story; the other half is propose->observe->re-propose. CAR ships the full machinery for the autonomous half (active-planner candidate generation, planner scoring, ReplanCallback/ActiveReplanAdapter for failure recovery, AgentOutcome terminal states, replan config), but the docs stop at the deterministic execution half. Bridging these — showing how a model-driven loop drives the verify/execute primitive repeatedly until an outcome is terminal — is the conceptual bridge a single-agent author most needs and the docs most lack.

### Specific gaps (capability exists in source; docs thin)

#### The closed agentic loop (the single most important missing piece)
- **Why it matters:** CAR's thesis is 'models propose; the runtime validates and executes,' but every cookbook and README example hardcodes ONE proposal and runs it once. A real single agent is a LOOP: infer a proposal -> verify -> execute -> read ActionResults/AgentOutcome -> feed results back -> infer the next proposal, until OutcomeStatus is success/give_up/timeout. car-ir ships AgentOutcome, OutcomeStatus (success/partial_success/give_up/timeout/failure/done), Evidence, OutcomeMetrics specifically for this loop, yet no doc shows the loop. An author following the docs literally builds a one-shot executor, not an agent. This is the #1 gap.
- **Where to look:** `car-ir/src/outcome.rs (AgentOutcome, OutcomeStatus, is_terminal/is_completed); car-engine execute() -> ProposalResult and how results feed the next turn; infer_tracked tool_calls + the Message enum (User/Assistant-with-tool_calls/ToolResult) in car-inference; needs a new cookbook 'Build an autonomous agent loop' tying infer_tracked -> proposal -> execute -> outcome -> repeat.`

#### Generating proposals from a model (the front half of 'models propose')
- **Why it matters:** Docs explain the IR wire shape and how to execute a proposal, but never how to get a model to EMIT one. Examples say 'model proposes — hardcoded in examples for offline runs.' car-active-planner (generate_candidates, parse_proposal, strategy-biased prompts) and car-planner (rank/pick_best scoring) are the supported way to turn an LLM into a proposal source, plus infer_tracked's tool_calls path. An author has no documented bridge from a prompt to a valid ActionProposal.
- **Where to look:** `car-active-planner (generate_candidates, ActiveReplanAdapter, parse_proposal/ParseError); car-planner (Planner::rank/pick_best, ScoredProposal); FFI rank_proposals/set_replan_config; infer_tracked tool_calls + tool_choice + messages_json params in car-ffi-pyo3/napi and websocket-protocol infer.`

#### Contributed-agent authoring + CLI lifecycle as a first-class path
- **Why it matters:** Packaging a single agent as a portable manifest.toml + binary, installing with 'car install', and managing it with car start/stop/restart/ls/inspect/tail-log/uninstall is arguably THE supported way to ship a single agent, but it lives only in docs/contributed-agents.md and docs/agent-bundle-spec.md (the latter is DRAFT/not-implemented) and the proposals/ folder. It is absent from the cookbook, SUMMARY 'Cookbook' section, and the README quick-start. The full manifest schema ([agent]/[publisher]/[runtime]/[lifecycle]/[transport]/[capabilities]), ed25519 signing, capability negotiation (required/optional/denied, fail-closed), and the agents.* JSON-RPC lifecycle are not presented as a runnable recipe.
- **Where to look:** `car-bundle (AgentManifest, sign_manifest/verify_signature, canonical_manifest_bytes); car-cli Commands::Install/Start/Stop/Ls/Inspect/TailLog/Uninstall; car-registry Supervisor (install_manifest, per-agent token, RestartPolicy, auto_start); docs/contributed-agents.md + examples/contrib-template/. Needs a cookbook recipe and a note that agent-bundle-spec multi-file format is still DRAFT vs single-manifest shipped.`

#### Complete CLI command reference / map
- **Why it matters:** The 'car' CLI is a primary surface for a single-agent author (info, verify, simulate, optimize, replay, infer, image, video, embed, models *, setup, speech *, daemon, init, auth *, install/start/stop/restart/ls/inspect/tail-log/uninstall, dream, eval, browse, secrets *). README scatters a handful across many sections; there is no single 'CLI reference' page. Notably the non-obvious facts — 'serve' and 'recommend' are under 'models' not top-level, text-gen is 'car infer' not 'car generate', 'car daemon' delegates to car-server, and there is NO bundle/mcp/a2a/registry top-level subcommand — are undocumented and easy to get wrong.
- **Where to look:** `car-cli/src/main.rs Commands enum (line 35) + ModelCommands/AuthCommands/SpeechCommands/BrowseCommands/SecretCommands; cross-check against README scattered mentions. Needs a docs/cli-reference.md.`

#### Workflow and scheduler subsystems
- **Why it matters:** car-workflow (declarative multi-stage stage graphs, conditional edges, saga compensation, verify_workflow) and car-scheduler (persistent Task definitions under ~/.car/tasks/, triggers once/interval/file-watch/cron/manual, the dream consolidation loop, ensure_dream_task) are shipped, FFI-exposed (NAPI/PyO3), and have WS methods (workflow.run/verify, scheduler.create/run/run_loop), but have ZERO cookbook or guide coverage. An author wanting a scheduled/triggered or multi-stage single agent has only the websocket-protocol method list and source.
- **Where to look:** `car-workflow (Workflow/Stage/Edge/StageStep, WorkflowEngine, verify_workflow, CompensationHandler); car-scheduler (Task, TaskTrigger, Executor, ensure_dream_task, parse_interval, TaskStore); FFI createTask/runTask/runTaskLoop/ensureDreamTask; websocket-protocol workflow.* / scheduler.* sections.`

#### External agents (Claude Code / Codex / Gemini as the 'third kind of agent')
- **Why it matters:** car-external-agents lets the daemon discover and invoke installed agentic CLIs through their own subscription auth and mix them into car-multi swarms via the 'external:' prefix — a distinct and economically motivated way to build agents. It is documented only in docs/proposals/external-agent-detection.md (a proposal, not user-facing) and the WS agents.* surface. No consumer-facing guide explains detect/health/invoke or the external: prefix.
- **Where to look:** `car-external-agents (detect/detect_with_health, invoke, ExternalAwareRunner, EXTERNAL_PREFIX, AdapterId, HealthStatus, InvokeOptions/InvokeResult); WS agents.health_external / agents.invoke_external; promote from proposal to a real guide.`

#### Reasoning engine and built-in commodity agents
- **Why it matters:** car-reason (ReasoningSession.reason/reason_streaming/reason_with_context — classify, locate via grep+tree-sitter, diagnose, generate/verify fix) and car-agents (off-the-shelf Researcher/Planner/Verifier/Summarizer + Coordinator) are ready-made building blocks for a single agent, but neither appears in the cookbook, intro, or patterns docs. An author re-implements what CAR already ships.
- **Where to look:** `car-reason (ReasoningSession, ReasoningResult, ReasonError); car-agents (BUILTIN_AGENTS roster, builtin_agents.rs, agent_metadata); car-engine AgentCapabilityRegistry (select capability by id like 'summarize'). Cross-check BUILTIN_AGENTS roster discrepancy: car-engine digest lists 5 (researcher/summarizer/verifier/transcriber/note-taker) while car-agents lists 4 + Coordinator — reconcile and document the canonical set.`

#### Browser automation tools (browse_* lifecycle)
- **Why it matters:** The seven browse_* tools (navigate/click/type/scroll/keypress/wait/observe) and the observe->reason->act el_N addressing model are how you build a web-automation single agent (the FlyX flagship use case), but they're only in docs/case-study-flyx.md as a narrative. The tool params, the el_N<->ax_ref resolution, and 'screenshots+a11y only, no DOM' constraint have no how-to recipe.
- **Where to look:** `car-browser (BrowserToolExecutor.tool_schemas, the 7 browse_* params); 'car browse run/schema' CLI; case-study-flyx.md for the skill-first pattern. Needs a browser-agent cookbook recipe.`

#### Troubleshooting / operational failure modes
- **Why it matters:** The v0.8 daemon-only pivot means the #1 new-user failure is 'daemon not running' / connection refused, plus auth-handshake errors (-32001 auth required, -32603 token mismatch), the retired `CAR_FFI_MODE=embedded` fallback, and compatibility stubs such as direct FFI `infer_stream` that always raise. Examples that call those stubs directly are invalid.
- **Where to look:** `car_ffi_common::auth_token paths/errors; session.auth error codes in websocket-protocol; docs/solutions/cli-session-auth-handshake.md (exists but buried); the PyO3 stub RuntimeError messages in car-ffi-pyo3/src/lib.rs. Needs a docs/troubleshooting.md.`

#### ToolSchema (typed tools) vs bare register_tool
- **Why it matters:** Docs almost exclusively show register_tool(name) (bare name, no validation). The richer path — typed ToolSchema with parameters JSON-Schema, idempotent, cache_ttl_secs, rate_limit, and verify_with_schemas (v0.18) which validates tool_call params against registered schemas — is how an author gets real parameter validation, caching, and rate limiting. registerToolSchema is NAPI-only and undocumented; an author doesn't know typed tools exist.
- **Where to look:** `car-ir ToolSchema/ToolRateLimit; car-engine register_tool_schema (auto-configures cache+rate limit), enable_tool_cache, set_rate_limit; FFI registerToolSchema (NAPI only) + verify_proposal tool_schemas_json param; agent-ir-spec ToolSchema section.`

#### Per-runtime/tenant isolation and capability gating for a single agent
- **Why it matters:** An author building a constrained single agent needs CapabilitySet (allowed/denied tools, allowed_state_keys, max_actions, deny-wins) and the 6-stage AuthzPipeline, plus the supported 'one CarRuntime per tenant/session' isolation pattern. README mentions per-runtime isolation briefly but CapabilitySet, AuthzPipeline stages, and RuntimeScope multi-tenancy are not in any author-facing doc — so authors conflate policies (deny rules) with capabilities (allow-listing).
- **Where to look:** `car-engine capabilities.rs (CapabilitySet builders, tool_allowed deny-wins), authz.rs (AuthzPipeline: ToolExists->Capability->Permission->Restriction->Policy->Validation), scope.rs (RuntimeScope); contrast with car-policy. Needs a section distinguishing capability gating from policy guardrails.`

#### Streaming/multi-turn inference parameters for chat agents
- **Why it matters:** For a conversational single agent, the full infer_tracked surface (tools_json, tool_choice, parallel_tool_calls, messages_json, context_query, images_json for vision, response_format, intent_json) and the StreamEvent types (text/tool_start/tool_delta/usage/done) are essential, but cookbook 09 covers only basic per-token streaming. The multi-turn Message enum (User/Assistant-with-tool_calls/ToolResult) that enables proper tool_use conversation flow is mentioned in CLAUDE.md but not in user docs.
- **Where to look:** `car-inference` `Message`, `GenerateRequest`, and `GenerateParams`; FFI `infer_tracked` signatures; and the WebSocket protocol's `infer` / `infer_stream` contract. The FFI streaming declarations document only always-error compatibility stubs.

{% endraw %}
