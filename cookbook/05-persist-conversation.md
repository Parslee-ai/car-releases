{% raw %}
# Persist and resume conversation

CAR persists memory — including conversation turns — as a memory-graph
**snapshot**. (A separate disk-backed `ConversationStore` with verbatim
turn-by-turn resume existed in ≤0.24 but was **removed in 0.25**; see "Conversation
turns across restarts" below and `docs/solutions/conversation-persistence-removed-in-0.25.md`.)

## Memory persistence (the simple case)

If you only need facts/skills across runs, `persistMemory` and `loadMemory` are enough:

```typescript
import { CarRuntime } from 'car-runtime';

const rt = new CarRuntime();

// ... use the runtime; add facts, ingest skills ...

rt.persistMemory('/path/to/state.json');

// Later, on a fresh process:
const rt2 = new CarRuntime();
const factCount = rt2.loadMemory('/path/to/state.json');
console.log(`restored ${factCount} facts`);
```

The on-disk format is JSON, backward-compatible, and includes facts, skills, identity, and constraints.

## Conversation turns across restarts

The `persistMemory` snapshot above **does** include conversation turns. Each turn
ingested via `ingest_conversation` is a `Conversation` node in the memory graph,
and the snapshot exports it as an `outcome` entry (`subject` = speaker, `body` =
`"speaker: text"`). So a `loadMemory` on a fresh process carries the conversation's
**content** forward.

What it does **not** do is replay the transcript. Turns come back as flat facts —
there is no ordered, role-threaded `Message` (User/Assistant/ToolResult)
reconstruction, and no separate compaction state. Use this to ground the next
session in what was said; don't expect a turn-by-turn rehydration of the chat.

> **Removed in 0.25.** Earlier versions had a `ConversationStore` /
> `with_conversation_store` / `load_persisted_conversations` API for verbatim
> JSONL turn resume. It was removed (commit `d7568282`) — it had no callers and a
> compaction-vs-store incoherence bug. If you need true ordered transcript resume,
> keep the raw transcript in your own app (you already hold the turns you feed to
> `ingest_conversation`) and use `persistMemory`/`loadMemory` for the derived
> memory. The forward path for first-class resume is the oplog design in
> `docs/proposals/multi-device-sync.md`. Full background:
> `docs/solutions/conversation-persistence-removed-in-0.25.md`.

Meeting transcripts are persisted separately by the `meeting.*` API
(`car-meeting`), which writes `.car/meetings/<id>/transcript.jsonl` directly —
that path is unaffected by the memgine store removal.

## What gets compacted vs. dropped

The compaction layer is not dumb truncation:

| Turn type | Compaction behavior |
|-----------|---------------------|
| Decisions, commitments, agreements | summarized but kept (high importance) |
| Highly graph-connected turns (referenced often) | summarized but kept |
| Already-captured-as-fact turns | **dropped** (the fact carries the same info) |
| Greeting / acknowledgment turns | dropped |
| Generic Q&A | summarized at high compression |

Each compaction emits structured telemetry — tokens before/after, layer triggered, compression ratio — so you can verify it's working as intended.

## Triggering compaction manually

```python
from car_runtime import CarRuntime
rt = CarRuntime()
# ... long-running session ...
report = rt.consolidate()  # JSON ConsolidationReport
print(report)
```

This runs the full dream pass (compaction + skill distillation + memory pruning + embedding flush). For the conversation layer alone, prefer letting write-through handle compaction amortized — calling `consolidate()` synchronously holds the memgine mutex for the duration of the pass.

## Routing-aware compaction signal

When CAR's adaptive router estimates a request will exceed the model's context, it sets `needs_compaction=true` on the routing decision so the caller can preemptively call `consolidate()` (or compact a specific layer) before retrying. Hook this if you're building an agent shell that owns its own model calls.

{% endraw %}
