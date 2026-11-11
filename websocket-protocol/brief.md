{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### brief

CAR compiles a mind's prompt from its installed agent manifest's `[brief]`
recipe. There is one compiler in `car-server-core`. Inputs extend the bead
index, decision class table, decision ledger and the agent's memory/skill graph;
compiled output is stored in the existing sync oplog registry. Generic
`sync.append` cannot write this compiler-owned registry. Only records stamped
by this body can authorize a spawn, including after sync/checkpoint recovery.

#### `brief.compile`

- **Params:** `{ agent_id: string, bead_id: string }`.
- **Authority:** host management; organization-bound agents are refused.
- **Returns:** `{brief_id, bytes, size, parts_present, parsed}`. `bytes` is the
  canonical UTF-8 JSON prompt; `size` is its byte count. `parsed` is the same
  document, with `schema_version:1`, `agent_id`, `bead_id`, `class_id`, ordered
  `parts:[{part,content}]` and `capabilities:[{handle_id}]`.

The bead must belong to that agent and have `brief:{claim,falsifier}`; its
existing `claim` field remains the ISA citation. The recipe's `class_id`
selects an existing decision class, which must declare `approval_rules` and
`report_format`. Its `skill_ids` selects skill manifests from that agent's
existing graph registry. Neither skill code nor example/history bodies enter.

Recipes contain exactly five ordered parts, each with a positive `max_bytes`:
`bead` from `bead_index`, `class_scope` from `class_table`, `identity` from
`identity_graph`, `precedents` from `decision_ledger`, and `skills` from
`skills_registry`. Identity requires `path`, an `identity/…` graph fact id,
not a filesystem path. Precedents require `count` (1–50); they select this
class only, owner-graded first and newest first, with stable id tie-breaking.
Each selected entry's `graph_fact_ids` names the exact facts included with it.
No ambient graph retrieval is performed.

Identity slices are owner-curated graph nodes with `scope:"brief"`,
`authority:"owner"`, kind `Identity` or `Fact`, and a JSON value containing
exactly nonempty `identity` and `telos` strings. Referenced precedent facts
use the same scope/authority/kind boundary. Conversation nodes and LifeOS or
transcript keys are refused. No recipe source reads transcript or LifeOS files.

Budgets total 8,000–28,976 bytes, leaving envelope space. A part exceeding its
budget, a missing required source, an invalid schema, or a final prompt outside
8,000–30,000 bytes is refused. CAR never pads, silently drops required parts,
or truncates a claim to fit. Recipe edits are reloaded for every compilation.

Secret redaction runs before sizing or persistence using CAR's known resolved
credentials and credential-shape scanner. Compilation never enumerates or
reads secret-store entries. Opaque capability ids bind to allowed, non-denied
tools in CAR's saved registry record; bindings and secret values are outside
the prompt. `proposal.submit` resolves each `action.tool` handle for its bound agent outside
the prompt and checks the current class allow/deny policy. Unknown, foreign
or revoked handles are refused. Existing runtime grants, permissions and
approval gates still apply.

#### `brief.curate_fact`

- **Params:** `{ agent_id: string, fact_id: string, body: string }`.
- **Authority:** host management (the owner); ordinary clients, bound agents
  and workers are refused. Organization-bound targets are refused.
- **Returns:** `{agent_id, fact_id, scope:"brief", authority:"owner"}` after
  saving the target agent's existing durable memory snapshot.

Writes a curated `Fact` node into the same per-agent memory graph used by the
compiler. `fact_id` is a nonempty graph id, never a filesystem path; `body` is
nonempty text. For an identity recipe path such as `identity/coding`, `body`
is a JSON string containing exactly `identity` and `telos`, both nonempty.
For a precedent's `graph_fact_ids`, `body` is the curated evidence text.
LifeOS and transcript ids are refused. The method fixes scope and authority;
callers cannot choose either or promote facts through `memory.add_fact`.
Existing memory admission rules still apply. An identical curated fact can
be retried; a conflicting id is refused. Typed snapshots preserve its scope
and authority when the daemon reloads. The legacy flat memory export retains
its existing peer/global import semantics.

Node/Python expose generated HostClient `briefCurateFact` / `brief_curate_fact`
JSON-params wrappers. Curate the recipe's identity/TELOS and any referenced
precedent facts before calling `brief.compile`.

#### `brief.read`

- **Params:** `{ brief_id: string }`.
- **Authority:** host management.
- **Returns:** the same `{brief_id, bytes, size, parts_present, parsed}` after
  checking schema, canonical bytes, byte count and SHA-256 identity. Unknown
  or foreign-body briefs are refused.

`agents.start`, `agents.restart`, auto-start and crash restarts for agents with
recipes require a compiled brief matching the installed recipe and current
bead ownership. The supervisor injects only compiler-returned `CAR_BRIEF_ID`
and `CAR_COMPILED_BRIEF`; attempts to supply these in an agent environment
are refused. Non-mind service agents without recipes receive no brief.
`agents.session_brief` returns this compiler output for minds with recipes.
Session and service agents without recipes retain their existing directory
instructions, with `compiled:false` and `source:"agent_instructions"`; the
Codex launcher accepts that session response. Missing or stale compiler output
for a mind is still refused before launch. Node/Python use generated HostClient
`briefCompile` / `brief_compile` and `briefRead` / `brief_read` JSON wrappers.

The live two-Mac writer trace and Grace's own recipe remain unproven here.

{% endraw %}
