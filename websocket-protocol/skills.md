{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### skills

#### `skills.distill`
- **Params**: `{ events: TraceEvent[] }`
- **Returns**: `DistilledSkill[]` — extracted from execution traces via inference

#### `skills.list`
- **Params**: `{ domain?: string }`
- **Returns**: `SkillMeta[]`

### skills (additional)

#### `skill.repair`
- **Params**: `{ skill_name }`
- **Returns**: `{ code }` on success, `null` if skill isn't broken or repair fails

#### `skills.ingest_distilled`
- **Params**: `{ skills: [DistilledSkill...] }`
- **Returns**: `{ ingested: N }`

#### `skills.evolve`
- **Params**: `{ events: [TraceEvent...], domain: string }`
- **Returns**: `[DistilledSkill...]` JSON

#### `skills.domains_needing_evolution`
- **Params**: `{ threshold?: number }` (default 0.6)
- **Returns**: `[string]` array of domain names

#### `skills.ingest_provisional`
- **Params**: `{ skills: [DistilledSkill...], tenant?: string }`
- **Returns**: `{ ingested: N }`
- Validation-gated ingest (SkillOpt-inspired). Skills enter as **provisional
  candidates** on trial keyed `<base>@cand` — they must beat their incumbent on
  real outcomes before the promotion gate makes them Active, vs
  `skills.ingest_distilled` which trusts skills active immediately. Drops
  already-rejected or already-trialing candidates from the count. See
  `docs/solutions/gated-skill-optimization.md`.

#### `skills.gate`
- **Params**: `null`
- **Returns**: `{ promoted: [string], rejected: [string] }` — resolved candidate keys
- Runs the promotion gate manually (it also runs automatically in
  `memory.consolidate`). Provisional candidates with ≥ `min_trial_samples` trial
  outcomes are promoted (candidate Wilson lower bound strictly beats the
  incumbent's) or rejected into the rejected-edit buffer.

#### `skill.meta`
- **Params**: `{ key }`
- **Returns**: `SkillMeta` JSON, or `null` if no active skill node holds the key
- Includes the lifecycle `status` (`active` / `provisional`), `incumbent` (base
  name a candidate trials to replace), `version`, and `stats`.

#### `skill.export`
- **Params**: `{ key }`
- **Returns**: portable markdown document (string), or `null` if the key is
  absent or not exportable
- Exports a **validated** skill (the SkillOpt `best_skill.md` analog) — only
  `Active`, healthy (non-degraded) skills export; provisional candidates and
  degraded skills don't. The document is TOML frontmatter (machine
  source-of-truth, including a SHA-256 content digest) plus a human-rendered
  body. See `docs/solutions/gated-skill-optimization.md`.

#### `skill.import`
- **Params**: `{ markdown }`
- **Returns**: `{ imported: true }`, or a JSON-RPC error if the document is
  malformed or its content digest doesn't verify
- Imports a skill from a `skill.export` document as a fresh `Active` skill with
  zeroed stats (it earns its own track record on this instance).

> **`memory.consolidate`** additionally returns `candidates_promoted` and
> `candidates_rejected` (`[string]`) on its `ConsolidationReport`, and emits one
> `CandidatePromoted` / `CandidateRejected` event per resolution to the event log.


{% endraw %}
