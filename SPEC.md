# CAR specification

The data shapes and semantics CAR guarantees across every binding (Python, Node,
Swift/Kotlin, the `car` CLI, and the `car-server` JSON-RPC protocol). These are
the contracts you code against; they're stable within a minor version (CAR is
pre-1.0 — see *Versioning*).

## The model: propose → verify → execute

CAR treats a plan as first-class data. A **proposal** is a DAG of **actions**;
the runtime validates it, optionally verifies properties over it, enforces
policies, and then executes — dispatching each tool through *your* callback while
owning ordering, state, retries, and the audit trail.

## Action / proposal shape

```json
{
  "actions": [
    {
      "id": "a1",
      "type": "tool_call",
      "tool": "read_file",
      "parameters": { "path": "/tmp/foo.txt" },
      "dependencies": []
    },
    {
      "id": "a2",
      "type": "tool_call",
      "tool": "summarize",
      "parameters": { "text_ref": "$a1.output" },
      "dependencies": ["a1"]
    }
  ]
}
```

- `id` — unique within the proposal; referenced by `dependencies` and by
  `$<id>.output` interpolation.
- `type` — one of `tool_call`, `state_write`, `state_read`, `assertion`.
- `dependencies` — ids that must complete first. Actions with satisfied
  dependencies run concurrently; the runtime owns the DAG scheduling.

The full IR (effect sets, read/write sets, cost metadata, invocation modes) is
documented in the source repo's `docs/agent-ir-spec.md`; the shape above is the
minimum every binding accepts.

## Tool callback contract

You register a tool name and provide a dispatch callback; CAR never owns tool
implementations.

```python
def tool_fn(tool: str, params_json: str) -> str:
    params = json.loads(params_json)
    if tool == "read_file":
        return json.dumps({"content": open(params["path"]).read()})
    return json.dumps({"error": f"unknown tool: {tool}"})
```

- Input: the tool name and a JSON string of parameters.
- Output: a JSON string. An error is just a `{"error": "..."}` payload — the
  runtime handles retries / replans if configured.
- In Node the callback is async and returns a `Promise<string>`; in
  `car-server` it's a bidirectional JSON-RPC callback.

## Policies

Policies are enforced in **Rust, before any tool fires** — they can't be skipped
by the model or the tool code. Register them by kind:

| Kind | Effect |
|------|--------|
| `deny_tool` | Block a tool entirely. |
| `deny_tool_param` | Block a tool when a parameter matches a pattern (e.g. `shell` where `command` contains `rm -rf`). |
| `require_state` | Require a state key/precondition before an action runs. |

```python
rt.register_policy("no_rm", "deny_tool_param",
                   target="shell", key="command", pattern="rm -rf")
```

Beyond static policies, CAR classifies each action into a **risk tier**
(`read_only` / `sandbox_edit` / `full_access`) and gates it against a granted
standing tier with human-in-the-loop approval; per-agent postures
(always-allow / require-approval / deny) refine this per agent. Approvals are
recorded to a durable ledger.

## Verification guarantees

Before executing, you can prove properties over a proposal — these are pure,
side-effect-free, and run in milliseconds:

- **`verify`** — structural + semantic validity: dependencies resolve, no
  cycles, preconditions are establishable, tools exist, policies would permit it.
  Returns `{ valid, issues }`.
- **`simulate`** — forward-simulate the state transitions the plan would produce,
  without running any tool.
- **`equivalent`** — prove two proposals produce the same effects.
- **`optimize`** — return a cheaper proposal with the same effects.

"Deterministic" means: given the same proposal, policies, and tool outputs, the
runtime's ordering, validation, and state transitions are reproducible — the
non-determinism is confined to your tool implementations and the model.

## Multi-agent shapes

Five coordination patterns are exposed as standalone functions:
`run_pipeline`, `run_swarm` (`parallel` / `sequential` / `debate`),
`run_supervisor`, `run_map_reduce`, `run_vote`. Each takes your agent callback.

**AgentSpec** (what you pass in):

```python
{
  "name": "reviewer",
  "system_prompt": "You review code for the 3 biggest risks.",
  "tools": ["grep", "read_file"],
  "max_turns": 5,
  "metadata": { "model": "claude-opus-4-8", "temperature": 0.3 }
}
```

**AgentOutput** (what your `agent_fn(spec_json, task)` MUST return, as a JSON
string — the shape is strict; missing fields fail deserialization):

```python
{
  "name": "reviewer",
  "answer": "...final answer text...",
  "turns": 1,
  "tool_calls": 0,          # integer count, NOT an array
  "duration_ms": 100.0,
  "error": None             # or a string if the agent failed
}
```

The runtime doesn't care how you produce `answer` (Anthropic, OpenAI, local
Qwen3 via `infer_tracked`, a deterministic tool chain — anything).

## Skills / learning loop

`TraceEvent` records (`action_succeeded` / `action_failed` with `tool`, `data`,
`reward`) feed `distill_skills` → `ingest_distilled_skills`; per-skill outcomes
(`report_outcome`) drive `domains_needing_evolution`, `evolve_skills`, and
`repair_skill`. A skill auto-degrades when `fail_count > success_count + 2`. Full
worked example: [GUIDE.md](./GUIDE.md) and `examples/python/multi_agent.py`.

## Conformance

Execution semantics are portable: the **RuntimeBench** suite (`car-conformance`)
verifies every runtime capability against this spec, so an implementation either
passes the conformance tests or it isn't CAR-compatible.

## Versioning

CAR is pre-1.0. Breaking changes between minor versions are possible — **pin to
exact versions** until the API stabilizes. Each release lists breaking changes in
its GitHub release notes and in `CHANGELOG.md`.
