# Memory: facts and 4-layer context

CAR's memgine is a graph-based memory engine — facts are nodes, relationships are edges, retrieval uses spreading activation. The four-layer context assembly puts the right things in front of the model in the right order.

## Add facts

```typescript
import { CarRuntime } from 'car-runtime';
const rt = new CarRuntime();

// "pattern" facts are normal knowledge.
rt.addFact('project_language', 'TypeScript', 'pattern');
rt.addFact('deploy_target', 'Cloudflare Workers', 'pattern');

// "constraint" facts are hard rules — they go into the Constraints layer.
rt.addFact('no_eval', 'Never use eval() or new Function()', 'constraint');

// confidence is the 4th positional arg (0..1; defaults to 1.0)
rt.addFact('user_prefers_short_responses', 'true', 'pattern', 0.8);
```

## Query facts

`queryFacts` runs spreading activation over the graph and returns the top-k matches:

```typescript
const hits = JSON.parse(rt.queryFacts('what runtime do we deploy to?', 5));
// [{subject: 'deploy_target', body: 'Cloudflare Workers', confidence: 0.78}, ...]
```

## Build the full context

`buildContext` assembles the canonical four-layer prompt scaffold:

```
## Identity      <- who the agent is, authority level
## Constraints   <- hard rules (no_eval, etc.)
## Facts         <- relevant pattern facts, supersession-resolved, authority-ranked
## Conversation  <- recent session turns
## Environment   <- runtime context (deadlines, system state)
## Known Unknowns <- gaps the agent should be aware of
```

Order is intentional — most-relevant content lands last, where recency attention is strongest.

```typescript
// Default 8K budget:
const ctx = rt.buildContext('how should I deploy this PR?');

// Adaptive budget for the model you're calling:
const ctxForOpus = rt.buildContext('how should I deploy this PR?', 200_000);
```

Pass it as the system prompt or as part of the conversation context to your model:

```typescript
const reply = await rt.infer(
  'How should I deploy this PR?',
  'claude-opus-4-7',
  4096,
);
// or, with explicit grounding:
const groundedReply = await rt.inferWithContext(
  'How should I deploy this PR?',
  'claude-opus-4-7',
);
```

## Fast mode for latency-sensitive paths

Voice agents and real-time UIs can't afford spreading activation + embedding flush + skill lookup on every turn:

```typescript
const fastCtx = rt.buildContextFast('user just said: deploy now', 32_000);
```

Skips: embedding flush, skill lookup, PPR-based scoring, inline repairs, known-unknowns extraction. Keeps: identity, constraints, facts (creation-order), conversation, environment.

## Persisting memory

```typescript
rt.persistMemory('/path/to/memory.json');
// later:
const factCount = rt.loadMemory('/path/to/memory.json');
```

The on-disk format is backward-compatible JSON — safe to commit alongside a project's `.car/` directory if the facts are team knowledge rather than per-user.
