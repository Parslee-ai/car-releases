{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### multi

Multi-agent coordination. All variants delegate per-agent execution back to the client via `multi.run_agent` callbacks (same pattern as `tools.execute`).

All variants also accept an optional `budget` object — a runtime-enforced coordination budget (see [`BudgetLimits`](#budgetlimits) below).

#### `multi.swarm`
- **Params**: `{ mode: "parallel"|"sequential"|"hybrid", agents: AgentSpec[], task: string, synthesizer?: AgentSpec, budget?: BudgetLimits }`
- **Returns**: swarm result with per-agent outputs

#### `multi.pipeline`
- **Params**: `{ stages: AgentSpec[], task: string, budget?: BudgetLimits }`
- **Returns**: pipeline result with stage outputs

#### `multi.supervisor`
- **Params**: `{ workers: AgentSpec[], supervisor: AgentSpec, task: string, max_rounds?: number = 3, budget?: BudgetLimits }`
- **Returns**: supervision result

#### `multi.map_reduce`
- **Params**: `{ mapper: AgentSpec, reducer: AgentSpec, items: string[], task: string, budget?: BudgetLimits }`
- **Returns**: reduce result

#### `multi.vote`
- **Params**: `{ agents: AgentSpec[], task: string, synthesizer?: AgentSpec, budget?: BudgetLimits }`
- **Returns**: vote result with winning output

#### `multi.tournament`
- **Params**: `{ competitors: AgentSpec[], judge: AgentSpec, task: string, budget?: BudgetLimits }`
- **Returns**: `{ task, candidates: AgentOutput[], matches: MatchResult[], winner_name, winner_answer, ranking: string[] }`
- Each competitor produces one candidate answer to the task, then the `judge` agent compares candidates **pairwise** in a single-elimination bracket (odd one out gets a bye) until one winner remains. The judge is a fresh agent per match. `ranking` orders competitors best→worst by elimination round. Use this over `multi.vote` when you need a relative ordering by comparative judgment rather than single-shot majority.

#### `multi.subtask`
- **Params**: `{ main: AgentSpec, task: string, budget?: BudgetLimits }`
- **Returns**: `{ task, final_answer, subtasks: SubtaskRecord[] }`
- Runs the `main` agent with a `spawn_subtask` tool enabled. The agent can spawn ephemeral sub-agents and grant each a **subset of its own tools**. The subset is a verified precondition: the tool's schema constrains the `tools` parameter to an `enum` of the main agent's tool names, so the runtime validator rejects any out-of-subset call before execution; the executor re-checks it as defense in depth. Multiple `spawn_subtask` calls in one model turn run concurrently via the engine's DAG executor. A `budget` here also caps how many sub-agents the main agent may spawn.

`AgentSpec` (from `car_multi::AgentSpec`, serde — these fields are **required** unless marked optional): `{ name: string, system_prompt: string, tools: string[], max_turns: number, metadata: object, cache_control?: boolean }`. Model/provider selection is conventionally carried in `metadata` and interpreted by the caller's agent runner. For `multi.subtask`, `main.tools` is load-bearing — it is the universe a spawned sub-agent's tools must be a subset of.

<a id="budgetlimits"></a>
**`BudgetLimits`** (from `car_multi::BudgetLimits`, serde — every field optional, omitted means unbounded): `{ max_input_tokens?: number, max_output_tokens?: number, max_total_tokens?: number, max_cost_usd?: number, max_agents?: number }`. The runtime sums the token/cost spend the agent runner reports (via `AgentOutput.tokens`) and **refuses to start a new agent once any limit is crossed** — overshoot is bounded by the work already in flight when the limit trips. For sequential and iterative coordinations (sequential swarm, pipeline, supervisor rounds) this is tight between-agent enforcement; for a single parallel batch it is a pre-flight gate plus the hard `max_agents` cap. Agents the budget refuses to start appear in the result as outputs with an `error` describing the denial; a denied reviewer/synthesizer falls back rather than failing the whole run.


{% endraw %}
