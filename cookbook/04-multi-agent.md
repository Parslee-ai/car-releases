{% raw %}
# Multi-agent: swarm, pipeline, and advisor

CAR coordinates multiple agents through built-in patterns: `swarm`, `pipeline`, `supervisor`, `mapReduce`, `vote`, `tournament`, and `advisor`. The runtime owns the coordination; you provide an `agentFn` that runs one agent.

## The agent runner

Every multi-agent function takes (or has previously stored) an `agentFn` callback that knows how to run a single agent. CAR calls it with a spec + task:

```typescript
import { registerAgentRunner } from 'car-runtime';

registerAgentRunner(async (specJson, task) => {
  const spec = JSON.parse(specJson);
  // spec = { name, role, model, system_prompt }

  // Call your LLM however you like — Claude, GPT, local model, doesn't matter.
  const reply = await callYourLlm(spec.model, [
    { role: 'system', content: spec.system_prompt ?? spec.role ?? '' },
    { role: 'user', content: task },
  ]);

  // Return AgentOutput JSON.
  return JSON.stringify({
    name: spec.name,
    response: reply.text,
    tool_calls: reply.tool_calls ?? [],
  });
});
```

After this is registered once, every multi-agent function below reuses it.

## Parallel swarm

Independent agents work on the same task concurrently:

```typescript
import { runSwarm } from 'car-runtime';

const result = await runSwarm(
  'parallel',
  JSON.stringify([
    { name: 'researcher', role: 'gather facts', model: 'gpt-5' },
    { name: 'critic',     role: 'find weaknesses', model: 'claude-opus-4-7' },
    { name: 'writer',     role: 'compose summary', model: 'claude-sonnet-4-6' },
  ]),
  'Should we move the deploy step before the test step?',
  null,                   // no synthesizer
  null,                   // agent_fn: null means use the stored runner
);
```

Modes: `'parallel'`, `'sequential'`, `'hybrid'`. Add a `synthesizer` AgentSpec to combine outputs into one final answer.

## Pipeline (sequential, output-passing)

Each stage's response becomes the next stage's input:

```typescript
import { runPipeline } from 'car-runtime';

const result = await runPipeline(
  JSON.stringify([
    { name: 'gather',  role: 'collect requirements', model: 'gpt-5' },
    { name: 'design',  role: 'propose architecture', model: 'claude-opus-4-7' },
    { name: 'critic',  role: 'find weaknesses',      model: 'claude-sonnet-4-6' },
  ]),
  'Build a deduplication pipeline for our event stream.',
);
```

## Supervisor

A supervisor agent oversees workers across multiple rounds, deciding when to stop:

```typescript
import { runSupervisor } from 'car-runtime';

const result = await runSupervisor(
  JSON.stringify([
    { name: 'coder',   role: 'implement', model: 'claude-opus-4-7' },
    { name: 'tester',  role: 'verify',    model: 'claude-sonnet-4-6' },
  ]),
  JSON.stringify({ name: 'lead', role: 'pm', model: 'gpt-5' }),
  'Implement and verify a binary search.',
  3, // max_rounds
);
```

## Map-reduce

```typescript
import { runMapReduce } from 'car-runtime';

const result = await runMapReduce(
  JSON.stringify({ name: 'classifier', role: 'label', model: 'claude-haiku-4-5' }),
  JSON.stringify({ name: 'aggregator', role: 'summarize labels', model: 'claude-sonnet-4-6' }),
  'Label these support tickets by category.',
  JSON.stringify(['ticket A...', 'ticket B...', 'ticket C...']),
);
```

## Vote

Multiple agents independently answer; an optional synthesizer picks or merges:

```typescript
import { runVote } from 'car-runtime';

const result = await runVote(
  JSON.stringify([
    { name: 'a', model: 'gpt-5' },
    { name: 'b', model: 'claude-opus-4-7' },
    { name: 'c', model: 'claude-sonnet-4-6' },
  ]),
  'Will this migration corrupt existing rows?',
  null,
  JSON.stringify({ name: 'judge', role: 'pick winner', model: 'gpt-5' }),
);
```

## Tournament

Competitors each answer; a judge compares them pairwise in a single-elimination bracket until a winner emerges, yielding a relative ranking:

```typescript
import { runTournament } from 'car-runtime';

const result = await runTournament(
  JSON.stringify([
    { name: 'a', model: 'gpt-5' },
    { name: 'b', model: 'claude-opus-4-7' },
    { name: 'c', model: 'claude-sonnet-4-6' },
  ]),
  JSON.stringify({ name: 'judge', system_prompt: 'pick the better answer', model: 'gpt-5' }),
  'Draft the clearest migration plan.',
);
// result.winner_name, result.ranking (best→worst), result.matches
```

## Advisor

An executor keeps control of the task, but asks a stronger model for bounded
guidance at explicit decision points. Use this when you want escalation without
delegating tools or state mutation to the advisor.

The Rust API lives in `car-multi` today. See the [Advisor Pattern](../advisor-pattern.md)
reference for the full contract.

## When to use which

| Pattern | Use when |
|---------|----------|
| `swarm` parallel | independent perspectives, fan-out |
| `pipeline` | each stage refines the previous output |
| `supervisor` | iterative work with quality gates |
| `mapReduce` | apply same operation to many items |
| `vote` | reduce model variance via consensus |
| `tournament` | rank candidates by comparative judgment (relative ordering) |
| `advisor` | stronger-model guidance while the original executor stays in control |

For declarative, conditional, compensable orchestration, use `car-workflow` instead — see [`crates/car-workflow/`](../../car-rs/crates/car-workflow/).

{% endraw %}
