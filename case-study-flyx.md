{% raw %}
# Design Note: Skill-First Execution on CAR (FlyX)

> **This is a design note with projected numbers, not a measured case study.**
> It was written on 2026-03-18, two days after this repository's first commit,
> to describe the architecture FlyX was built against. The cost table below is
> headed "Monthly cost projection" for a reason: the ~75% figure is a model of
> what skill-first execution should save at a given skill hit rate, not a
> measurement taken from a running deployment. No token counts, invoices, or
> telemetry back it.
>
> **Do not cite it as evidence of production results** — externally, or in
> CAR's own docs. The architecture description is accurate and worth reading;
> the savings figure is a target. If you want a defensible number here, instrument
> the deployment and replace this note with the measurement.

## The problem

FlyX runs 7 autonomous AI agents on a flight management system. Each agent has a role — sales, dispatch, crew scheduling, pilot operations, safety compliance, billing, and an owner/explorer. They operate concurrently on a live web application using Playwright, making decisions through Claude Sonnet.

Without optimization, each agent burns ~5,000 tokens per decision cycle. With 7 agents cycling every 2-5 minutes across a 12-hour operational day, that's roughly 80,000 tokens/day — about $1,200/month in API costs for a simulation.

The agents also suffered from a classic problem: they kept rediscovering the same workflows. Sally Sales would figure out how to create a quote, then forget it next cycle and spend 6 LLM turns re-learning the same button clicks.

## What CAR provides

FlyX agents run on the Common Agent Runtime. Each agent gets:

- A **native Rust runtime** (via NAPI bindings) that validates, executes, and logs every action
- **Graph-based memory** that persists facts across sessions with relevance-ranked retrieval
- **Native skills** — learned Playwright procedures stored in a graph, matched by persona + URL + task
- **Per-agent policies** restricting which pages and tools each persona can access
- **Static plan verification** that catches infeasible plans before execution

## The skill-first architecture

The key insight: most agent work is repetitive. Once Sally learns to create a quote, that workflow doesn't change. CAR's skill system captures this:

```
Agent receives task
  → CAR searches for matching skill (persona + URL + task keywords)
  → Match found (score > 0.3)?
      YES → Execute saved Playwright code directly. Cost: $0. Time: 200ms.
      NO  → Fall back to LLM. Query CAR memory for relevant context.
            Call Claude. Compile response to CAR proposal. Verify. Execute.
            Cost: ~$0.15. Time: 3-5 minutes.
            → Optionally learn a new skill from the successful workflow.
```

Skills are first-class objects in CAR's graph memory. They have trigger edges (persona, URL pattern, task keywords), execution stats (success/fail counts), and auto-degrade when `fail_count > success_count + 2`. The runtime handles all of this — the agent code just calls `findSkill` and `reportOutcome`.

## Token savings breakdown

| Path | Input tokens | Output tokens | Cost | Latency |
|------|-------------|---------------|------|---------|
| Skill match | 0 | 0 | $0.00 | ~200ms |
| LLM with CAR memory | ~2,500 | ~2,500 | ~$0.15 | ~3-5 min |
| LLM without CAR (baseline) | ~5,000 | ~2,000 | ~$0.30 | ~3-5 min |

### Where the savings come from

**1. Skills eliminate LLM calls entirely.**

FlyX seeds ~20 common workflows (navigate to prospects, create a reservation, assign crew, etc.). As agents run, they learn more. After a few hours, the majority of routine tasks hit a skill match and skip the LLM entirely.

**2. Memory context assembly reduces input tokens.**

Without CAR, agents would need the entire fact history in every prompt. CAR's spreading-activation retrieval queries only the top 15 relevant facts for the current persona + page context. This cuts input tokens by 15-20% on every LLM call.

**3. Verification prevents wasted cycles.**

CAR's `verify()` catches impossible proposals before execution. An agent trying to dispatch a flight without assigned crew gets rejected immediately instead of executing 3 tool calls that fail sequentially — saving the tokens for the retry prompt.

**4. Policies prevent wandering.**

Per-agent policies (enforced in Rust, not in the prompt) prevent Sally Sales from navigating to dispatch pages. Without this, agents waste tokens exploring areas outside their role, then getting confused by unfamiliar UI.

## Monthly cost projection

| Metric | Without CAR | With CAR |
|--------|------------|----------|
| Tokens/day (7 agents, 12hrs) | ~80,000 | ~20,000 |
| Monthly API cost | ~$1,200 | ~$300 |
| Reduction | — | **75%** |

The savings compound over time as the skill library grows. Early in a deployment, most tasks go through the LLM. After a week, the hit rate on skills is high enough that the LLM is only called for genuinely novel situations.

## Architecture

```
run-continuous.ts (orchestrator)
  │
  ├── 7 Playwright browser contexts (one per agent)
  │
  ├── Shared CAR memory runtime
  │   ├── Graph-based fact store (loaded from disk)
  │   ├── Skill library (seeded + learned)
  │   └── Persisted every 2 cycles
  │
  └── Per-agent CAR execution runtime
      ├── Registered tools (navigate, click, fill, read_page, ...)
      ├── Access policies (deny_tool_param per persona)
      └── Proposal verification + execution
```

Each agent's decision loop:

1. **Check skills** — `findSkill(persona, currentUrl, taskHint)`. If match score > 0.3, execute the saved Playwright code and report outcome. Done.
2. **Query memory** — `queryFacts(persona + pagePath, 15)` returns ranked context.
3. **Build prompt** — System prompt + role description + memory context + world state summary (~200 chars per domain).
4. **Call LLM** — Claude Sonnet with tool definitions. Max 6 turns per cycle.
5. **Compile to IR** — LLM tool_use blocks become an `ActionProposal`.
6. **Verify** — CAR statically checks preconditions and tool existence. (Policy is enforced separately by `car-policy` during execution, not by `verify`.)
7. **Execute** — CAR dispatches to Playwright via tool callback.
8. **Learn** — Successful novel workflows become new skills.

## What the runtime handles so agents don't have to

- **Memory persistence** — agents don't manage files; CAR loads/saves the graph
- **Skill matching** — spreading activation over a graph, not string matching
- **Skill degradation** — broken skills auto-degrade without agent logic
- **Policy enforcement** — access control in Rust, not in prompts that can be ignored
- **Proposal verification** — catch bad plans before they waste tool calls
- **Execution safety** — retry, timeout, rollback on every action
- **Token efficiency** — only relevant facts in context, skills skip the LLM entirely

## Results

FlyX has been running 7 agents continuously on a production-grade flight management system. The agents create quotes, book flights, assign crew, dispatch aircraft, file flight logs, manage compliance, and process invoices — all autonomously.

The runtime doesn't make the agents smarter. It makes them cheaper to run, harder to break, and able to learn from their own experience without the model having to remember anything.

{% endraw %}
