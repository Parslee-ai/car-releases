{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### memory

**Scope: which graph do these methods act on?** This is the first thing to settle, because the per-file shape of `memory.load` / `memory.persist` suggests per-file namespacing and that is *not* the default.

| Session bound how | Graph used |
|---|---|
| `session.auth { memory_namespace }` | a daemon-owned graph private to that namespace |
| `session.auth { agent_id }` | that agent's daemon-owned graph |
| neither | **the daemon's single shared graph** |

The shared default is deliberate: facts ingested through the MCP endpoint show up in WS-served queries and vice versa, so external agents and embedded hosts work against one knowledge base.

**Every one of these graphs survives a daemon restart.** `car-server` saves a graph after each memory or skill write that reaches it, over this WebSocket or over the MCP endpoint (`memory_*`, `skill_*`), and loads it again at startup; nobody needs to call `memory.persist`. The shared graph is saved to `~/.car/memory/daemon-shared.json` (under `CAR_HOME` when set), and again on a clean shutdown so writes that reached it some other way (an assistant run) are kept too. A namespace graph goes to `~/.car/memory/memory-namespaces/<encoded-ns>.v2.json` and an agent's to `~/.car/memory/agents/<id>.v2.json`. The flat `<encoded-ns>.json` / `<id>.json` files that daemons before car#3225 wrote are read when no `.v2.json` exists yet, and never written, moved or deleted: an older daemon reading them after a downgrade finds its own older state rather than a format it would treat as empty and overwrite. If that older daemon then writes its flat file, the next upgraded daemon notices: each typed snapshot records the flat file's modification time and length as they stood when it was written (`legacy_seen`), and a flat file that no longer matches has been written since. It then loads the flat file and rewrites the typed snapshot from it, keeping the replaced typed file as `<file>.superseded-<unix ms>`, so a write made while downgraded is not lost. The flat format cannot hold everything: entries the older daemon never saw (written after the upgrade, such as skills and conversations), links between entries, proactive status and domain stats stay only in the superseded file. For a fact present in both with the same subject and body, the typed snapshot's metadata (confidence, tenant, category, tags, provenance) is carried forward. `memory.persist` refuses all of the daemon's files (see below), and `memory.load` refuses its typed snapshots. These snapshots keep the whole typed graph: each fact, knowledge, procedural and skill entry with its id, tags, source, confidence, tenant and category, and the links between them. Identity is not in them: `identity.json` is the identity's only durable copy. Each save is written to a temporary file and renamed into place, and saves of one file land in the order they were taken, so a crash or two writes at once never leave a partial or older graph on disk. A typed snapshot that cannot be decoded at startup is moved aside to `<file>.corrupt-<unix ms>` and that graph starts empty (or from its legacy file, when there is one), so the next save never overwrites the only copy (car#3225).

**What that costs an unbound multi-project host.** Every unbound session on a daemon shares one graph, so:

- `memory.query` returns facts another project's session wrote.
- `memory.persist` writes the **entire** shared graph to whatever `path` it is given — so every per-project file accumulates every project's facts.
- `memory.load` **resets** that shared graph before ingesting (see below), so one session loading its own file discards facts another session had in memory.

If you key memory per project, bind a namespace. `session.auth { memory_namespace: "myapp-<projectID>" }` gives that connection a private graph, persisted under `~/.car/memory/memory-namespaces/<encoded-ns>.v2.json` (see the durability note above) — the filename is a lowercase percent-encoding of the namespace's UTF-8 bytes (`a`-`z`, `0`-`9`, `-`, `_`, `.` pass through; everything else, including `%` and uppercase letters, becomes `%` plus two lowercase hex digits), which keeps the mapping injective so two namespaces can never share a snapshot file (#891) — and every `memory.*` call on that connection acts on it alone. A namespace is a **separate axis from `agent_id`** — one agent may work across several namespaces, and two hosts may share a namespace without sharing an identity. When both are supplied the namespace wins for the memory scope; the agent binding still governs identity and tokens. (Parslee-ai/car-releases#79.)

**A namespace bound by a supervised agent belongs to that agent.** A session authenticated with `session.auth { agent_id, token, memory_namespace }` gets the graph keyed `agent:<agent_id>:namespace:<ns>`, so agent A's `myapp` and agent B's `myapp` are two different graphs: neither can read or change the other's facts, and neither is the graph an operator or host session gets for the bare name `myapp`. The agent's own namespace still persists across reconnects. Operator (daemon-token) and host sessions keep binding the bare name exactly as before, so they can still reach any namespace by name; only an agent-bound session is narrowed. Migration: an agent that stored facts under a bare namespace name before this change starts empty under its own key; its old file (`memory-namespaces/<ns>.json`) is untouched and stays reachable to operator and host sessions. No caller on the Mac was found that depends on the old behavior. The agent's saved file is also fenced off from other agents: see `memory.persist` and `memory.load` below.

#### `memory.add_fact`
- **Params**: `{ subject: string, body: string, kind?: string = "pattern", fact_id?: string, tags?: string[], source?: string = "user", committed_by?: string, verdicts?: VerifierVerdict[] }`
- **Returns**: updated fact count
- `kind: "constraint"` sets the constraint flag. A non-empty caller-supplied `fact_id` is the graph fact id; CAR mints a `ws-<count>` id only when the field is absent (bumping the counter past any id already in the graph, so a caller's literal `ws-7` can never be silently shadowed by a rewritten auto id). A duplicate caller id is rejected rather than silently rewritten — **except** for an identical-content re-add (same id, same subject and body), which resolves to the existing fact instead: that is the normal behavior of an at-least-once client retrying a call whose response it missed, or a caller replaying after a daemon restart re-loaded its snapshot. A duplicate id with **different** content is a genuine collision and errors, so a caller seeing that error knows someone else wrote this id with different content and can resolve it with a `memory.query`.
- `tags` preserve caller order and `source` is stored as the fact's provenance source. All three caller values survive a daemon restart (see the durability note above) and a manual `memory.persist` → `memory.load` for Fact rows — the flat `memory.persist` format stays deliberately lossy for non-Fact kinds (Conversation `outcome` rows reload as plain facts, Skill/Conclusion rows collapse to `pattern`, Identity/Environment rows are not written), so full-graph fidelity is not claimed for that export — and `memory.query` returns them unchanged.
- This is the **externally-authored** memory write path, so it runs through the durable-state admission gate. With no admission table installed the gate is off and `committed_by` / `verdicts` are ignored — existing callers are unaffected. With a table installed, the candidate must satisfy that table's rule for the `memory` surface or the call fails with `memory admission refused for <id>: <refusals>`.
- `produced_by` is fixed to `execution` and is **not** caller-settable: a peer calling this surface *is* the execution path, and letting it name its own producer would let it satisfy any rule by declaring itself whatever the rule expects.
- **Limitation, stated plainly:** `committed_by` is a caller *claim* that this surface does not yet authenticate. With a table installed the gate therefore enforces **evidence** (a caller cannot conjure a passing verifier verdict) and structure, but not committer **identity**. Binding the committer to the authenticated session is follow-up work; until then treat that half as bookkeeping, not a security boundary.

#### `memory.set_admission_table`
- **Params**: `{ table?: OwnershipTable | null }`
- **Returns**: `{ enabled: boolean, ungated_surfaces: string[] }`
- Installs or clears the durable-state admission rules for the session's memgine. A null or absent `table` **clears** them, turning the gate off — the default, and what every deployment has until this is called.
- Off is **not** the same as an empty table. The gate core is fail-closed: a table with no rule for a surface refuses everything on it. So `{}` installs a table that rejects every externally-authored fact, while `null` disengages the gate entirely. That distinction is deliberate — engaging a fail-closed gate implicitly would refuse every memory write on every existing deployment.
- `ungated_surfaces` names surfaces whose rule imposes no real constraint (the producer may self-commit and no evidence is required). Check it after installing a table that only *looks* governed.
- A `SurfaceRule` is `{ surface, produced_by, committed_by, self_commit, requires }` where `surface` ∈ `memory | skills | tools | verification | routing | tasks`, the two authorities ∈ `execution | review | coordination | scheduling | system_config`, `self_commit` ∈ `forbidden | with_passing_evidence`, and `requires` is a list of `{ class, accepts_tiers?, operator_override? }`.
- Only the `memory` surface is enforced today — that is the write path this is wired into. Rules for other surfaces are accepted and stored so a table can be authored ahead of the call sites, but nothing consults them yet.

#### `memory.admission_table`
- **Params**: `{}`
- **Returns**: `{ enabled: boolean, table: OwnershipTable | null, ungated_surfaces: string[] }`
- Reads back the installed rules. `enabled: false` with a null `table` means the gate is off.

#### `memory.update_status`
- **Params**: `{ body: string, tenant_id?: string }`
- **Returns**: `{ id, body, tenant_id? }`
- Updates the proactive memory agent's private progress/risk status. This status is session-local and is not stored as a normal graph fact, so `memory.build_context` and generic retrieval cannot expose it to the action model by accident.

#### `memory.maintain`
- **Params**: `{ max_recent?: number = 32, tenant_id?: string, session_id?: string }`
- **Returns**: `{ trigger, saved, skipped_existing, status? }`
- Runs Phase 1 of proactive memory over the recent session event log. CAR mines high-signal trajectory events such as failed actions, retries, exhausted replans, ungrounded/open goal evaluations, and truncated or stalled turns into compact knowledge/procedural entries with stable ids. Re-running maintenance over the same events is idempotent: existing event-derived memories are counted in `skipped_existing` instead of duplicated. The returned `trigger` can be passed directly into `memory.intervene`.
- `session_id` names the conversation the events came from. Entries derived from them are kept to that conversation: a `memory.intervene` request naming a different `session_id` never selects them. It defaults to this connection's own id, the scope an `infer` on this connection selects from. That id is minted per connection, so entries saved before a reconnect are not selected by an `infer` after it.
- Appends a `ProactiveMemoryMaintained` event with counts and trigger metadata, but not full memory bodies.

#### `memory.save_knowledge`
- **Params**: `{ id?: string, subject: string, body: string, tags?: string[], confidence?: string, tenant_id?: string, is_constraint?: boolean }`
- **Returns**: `{ id, kind: "knowledge", fact_count }`
- Saves durable execution-state knowledge such as task requirements, verified environment facts, paths, policies, and domain constraints. Entries are graph facts stamped with proactive-memory metadata, so they can participate in retrieval and selective intervention.

#### `memory.save_procedural`
- **Params**: `{ id?: string, subject: string, body: string, tags?: string[], confidence?: string, tenant_id?: string, is_constraint?: boolean }`
- **Returns**: `{ id, kind: "procedural", fact_count }`
- Saves durable procedural evidence such as failed attempts, successful fixes, diagnostics, ruled-out hypotheses, and tool/runtime gotchas. The proactive intervention selector gives these entries extra weight under tool-error and repeated-failure triggers.

#### `memory.delete`
- **Params**: `{ id: string }`
- **Returns**: `{ id, deleted, kind, fact_count }`
- Removes a stale proactive memory entry by fact id. Status ids have the form `proactive-status:<tenant-or-global>` and clear the private status slot; durable knowledge/procedural entries are removed from the graph.

#### `memory.query`
- **Params**: `{ query: string, k?: number = 5 }`
- **Returns**: `[ { fact_id: string | null, subject, body, kind, confidence, score, tags, source }, ... ]` (`fact_id` is non-null for facts written through `memory.add_fact`; other graph node kinds may not carry one)
- Personalized PageRank retrieval over the memory graph. FFI parity with NAPI `query_facts` — same algorithm, same result shape, so the choice of transport does not shift ranking.
- Each matched fact enters the PageRank reset in proportion to how well it matches the query (the IDF-weighted share of query terms it contains, the same seed weighting `memory.build_context` ranks with), so a fact matching every query word gets a higher `confidence` than one sharing a single word. `confidence` is the hit's share of PageRank mass in this response: compare hits within one result, not against a fixed threshold, because a lone weak match still holds most of the mass. A per-seed share is capped at 0.4 before propagation, so two matches that each hold more than 0.4 of the reset start level and can tie on `confidence`.
- `score` is the hit's own match strength, `0..1` (1.0 when the fact contains every query term; the same value the MCP `memory_query` tool reports as a direct match's `activation`). A hit that matches no query term scores `0`. Threshold on `score`, not `confidence`.

#### `memory.intervene`
- **Params**: `{ query?: string, recent?: string[], trigger?: { repeated_failures?: number, tool_error?: boolean, explicit_uncertainty?: boolean, high_risk_action?: boolean, context_shift?: boolean }, force?: boolean, max_candidates?: number = 8, tenant_id?: string, session_id?: string, exclude_fact_ids?: string[] }`
- **Returns**: either `{ decision: "inject", reminder, selected, candidates, bank }` or `{ decision: "silent", reason, candidates, bank }`
- Proactive memory hook for long-horizon runs. Unlike `memory.build_context`, this does not expose the full memory bank. It selects at most one grounded reminder from durable memgine state for the next action, or returns an explicit silence decision when no remembered state is strong enough to interrupt. An injected reminder increments the selected fact's usage counter so later outcome credit can update utility-aware retrieval.
- `trigger` carries runtime pressure signals such as repeated tool failures, uncertainty, high-risk actions, or context shifts. These signals bias the selector toward requirements, diagnostics, procedural attempts, and open subgoals without forcing always-on reminders. `force: true` is for harness ablations and debugging; normal callers should leave it false.
- `session_id` names the conversation asking. Entries `memory.maintain` derived from events are candidates only when they were saved for that same `session_id`; one saved without a session, including any restored from a snapshot written before sessions were recorded, is never a candidate for a request that names one. Other entries are unaffected. Without `session_id` every entry is a candidate, as before, including those `memory.maintain` saved for any connection. `exclude_fact_ids` removes facts from the candidates, for example reminders already shown during the current turn.
- Appends a `ProactiveMemoryIntervention` event with the inject/silent decision, selected fact id when present, candidate count, and bank counts.

#### `memory.evaluate`
- **Params**: `{ cases: [{ id: string, request: ProactiveMemoryRequest, relevant_fact_ids?: string[] }] }`
- **Returns**: `{ cases, selective, always_inject, passive_retrieval, no_memory }`; each mode reports `{ interventions, true_positives, false_positives, false_negatives, precision, recall, interruption_rate, avg_candidates_exposed }`.
- Offline calibration hook for proactive memory. It runs labeled next-action cases against the current graph and compares CAR's selective selector to the paper-style baselines: no memory, always inject the best candidate, and passive retrieval that exposes all candidates without an interruption policy. This is deterministic and does not call a model.
- FFI parity: NAPI/Python expose JSON-string wrappers for `memory_update_status`, `memory_maintain`, `memory_save_knowledge`, `memory_save_procedural`, `memory_delete`, `memory_intervene`, and `memory_evaluate`, all proxying to these daemon methods.

#### `memory.build_context`
- **Params**: `{ query: string, model_context_window?: number }`
- **Returns**: assembled context string (Identity → Constraints → Facts → Conversation → Environment → Known Unknowns)
- When `model_context_window` is provided, sizes the assembly budget against the model's window instead of the fixed 8K default. FFI parity with NAPI `build_context(query, model_context_window)`.

#### `memory.build_context_fast`
- **Params**: `{ query: string, model_context_window?: number }`
- **Returns**: assembled context string, same layer order as `memory.build_context`
- `ContextMode::Fast`. Skips embedding flush, skill lookup, PPR-based scoring, inline repairs, and known-unknowns extraction. Keeps identity, constraints, facts, conversation, and environment.
- **Facts come back in creation order, not relevance order.** That is the whole trade: this is for latency-sensitive callers (voice, real-time), and an agent on Fast advertises spreading-activation memory while doing keyword recall over a flat list. Use `memory.build_context` for anything that reasons over the result — `car do`'s assistant `recall` was moved back to it for exactly this reason. Pick Fast deliberately, and say why at the call site.
- Binds to the session's effective memgine, same namespace rules as `memory.build_context`.

#### `memory.persist`
- **Params**: `{ path: string }`
- **Returns**: number of facts written
- Writes the session's memgine to a JSON file at `path` (flat fact format, backward-compatible with `memory.load`). Each row includes `fact_id`, ordered `tags`, and provenance `source`; older snapshots without them still load with a generated `loaded-<count>` id and empty metadata. Fact rows round-trip that metadata verbatim; the flat format remains lossy for non-Fact kinds (they reload as plain facts, and Identity/Environment nodes are not written at all). FFI parity with NAPI `persist_memory`.
- Refuses the daemon's own memory files — `daemon-shared.json` and the copies kept beside it, anything under `agents/` or `memory-namespaces/` (typed or legacy), and any `*.v2.json` — with an error naming the automatic snapshot. Those already save after every write; this flat format would replace a typed graph with a lossy copy, and a flat file at a graph's legacy name would be read over its typed snapshot as if an older daemon had written it. These are decided by file identity, not spelling: an existing target is compared by device and inode with every daemon-owned file (so a hard link, a symlink, or a name the file system folds onto one — APFS opens `daemon-ſhared.json` as `daemon-shared.json` — is refused), and the directory by identity with `agents/` and `memory-namespaces/`. A new file name in the memory base's own directory that is not plain ASCII is refused, because nothing can rule out the file system folding it onto the shared snapshot's name; use a subdirectory such as `exports/` for those. Every other path works as before.
- **Writes the whole graph, not a subset.** `path` names the destination file; it does not select what goes into it. On an unbound session that graph is the daemon-wide shared one, so per-project files each end up holding every project's facts. Bind a `memory_namespace` (see the scope table above) if you want a file to contain only one project's facts.
- **Filesystem caveat**: `path` is interpreted on the daemon's filesystem, not the caller's. Cross-process file access requires shared paths.
- **Agent-bound sessions**: a session authenticated as a supervised agent may `memory.persist` and `memory.load` only the file of the graph it is bound to (its per-agent graph, or its own `agent:<id>:namespace:<ns>` graph). That file may be named by its typed `.v2.json` name or its legacy flat `.json` name; either way the agent's `memory.persist` writes the typed snapshot (nothing is lost, and the legacy file is left alone) and `memory.load` reads the typed snapshot, or the legacy file when there is none yet. `path` is optional for such a session and defaults to that file; any other path (another agent's file, however spelled, including through `..`, a symlink or percent-encoding) is refused with `an agent may only use the memory file of its own bound graph`, and the refusal is logged. A session bound to a work context may not name a file at all (its private memory is saved automatically). Operator and host sessions are unchanged. The `registry.*` and `meeting.*` methods that take a caller-named folder (`registry_path`, `root`) are likewise refused to an agent-bound session when the parameter is present, so those cannot be used to reach another agent's saved file either.
- **Sandbox**: `path` is sandboxed under `~/.car/memory/` on the daemon (same enforcement the FFI bindings have applied since v0.7.1 — see `car_ffi_common::memory_path::resolve`). Relative paths land under that base; `..` segments and symlinks pointing outside are rejected with a `memory.persist rejected path …` error. The audit-driven flip to require auth on the WS made this surface as exposed as the FFI; the sandbox guards both equally.

#### `memory.load`
- **Params**: `{ path: string, replace?: boolean }`
- **Returns**: number of facts loaded
- Replaces the session's memgine with the snapshot at `path`. Internally calls `engine.reset()` before ingest, so this is a full replace, not a merge. FFI parity with NAPI `load_memory`. Same filesystem caveat **and same `~/.car/memory/` sandbox** as `memory.persist`.
- Reads both snapshot shapes: the flat fact array `memory.persist` writes (returns the number of facts), and the typed `{ "version": 2, "memory": … }` shape (returns the number of graph entries restored). Anything else fails with an error and changes nothing.
- Refuses the daemon's own snapshots: `daemon-shared.json` and any `*.v2.json`, for every caller; the daemon loads those itself. A session bound to a supervised agent is also refused anything under `agents/` or `memory-namespaces/` and the copies kept beside `daemon-shared.json`, since those are other graphs' memory (the shared graph holds every unbound caller's). The same identity rules as `memory.persist` decide what counts as one of these files.
- The loaded graph is saved like any other write, so it is still there after a daemon restart.
- **The reset is scoped to the graph, not the connection.** On an unbound session (no `agent_id`, `memory_namespace` or work context) that graph is the daemon-wide shared one, so a load would discard facts every other unbound session and the MCP endpoint currently hold. **The daemon therefore refuses to replace the shared graph unless the call passes `replace: true`** (car-releases#91) — for every caller, including the operator token and host (`host_token`) sessions. The refusal comes before the file is read, leaves the shared graph and its snapshot untouched, and names the remedies: authenticate with your `agent_id`, or bind a `memory_namespace` (`session.auth { memory_namespace }`, `CAR_MEMORY_NAMESPACE`, or `setMemoryNamespace` / `set_memory_namespace` in the bindings) so load/persist affect only your own graph. On the shared graph a `replace` that is not a boolean is an error. On a graph that is not the shared one (agent, namespace, or a per-connection graph on an embedder with no shared graph) `replace` is ignored and a load always replaces that graph.
- **A deliberate replacement is announced.** When `replace: true` replaces the shared graph the daemon logs a warning and records a `memory.shared_graph.replaced` host event (`agent_id: null`) with payload `{ path, records, client_id, host, operator }`, delivered to `host.subscribe` clients and listed by `host.events`, so a replaced graph is distinguishable from a healthy one.

### memory (additional)

#### `memory.consolidate`
- **Params**: `null`
- **Returns**: `ConsolidationReport` JSON — operates on this client's per-session memgine.

#### `memory.fact_count`
- **Params**: `null`
- **Returns**: `number` — `valid_fact_count()` of the session's memgine. Mirrors the FFI `fact_count` accessor.

#### `memory.utility_get`
- **Params**: `null`
- **Returns**: `{ utility_weight, utility_exploration }` — the live engine's
  utility-aware retrieval blend (U-Mem, arXiv 2602.22406). Reads the same engine
  `memory.build_context` retrieves from.

#### `memory.utility_set`
- **Params**: `{ utility_weight?: number, utility_exploration?: number }`
- **Returns**: the applied (post-clamp) `{ utility_weight, utility_exploration }`
- Runtime override of utility-aware fact retrieval on the live engine.
  `utility_weight` 0 = pure relevance (ordering unchanged); when `> 0`, fact
  scoring blends each fact's learned utility posterior (an upper-confidence
  bound) on top of semantic relevance. `utility_exploration` scales the UCB
  uncertainty term (surfaces untried facts more aggressively; only consulted
  when weight `> 0`). `utility_weight` is clamped to `[0,1]`,
  `utility_exploration` to `[0,4]`; non-finite inputs become 0.
- **Read-modify-write**: an omitted field keeps the engine's current value (it
  does NOT reset to 0), so you can tune one knob without clearing the other.
- **Scope**: in the standalone daemon the engine is **global** (one
  `shared_memgine` across all WS sessions + MCP), so this shifts retrieval
  ranking for every client — last-writer-wins — and does **not** persist across
  daemon restarts. For persistent, team-shareable tuning, set
  `utility_weight` / `utility_exploration` in `.car/config.toml` instead (the
  daemon seeds its shared and per-agent engines from those at boot). Takes effect
  on the next `memory.build_context`. Mirrors the FFI `setUtilityRetrieval` /
  `set_utility_retrieval` accessor.


{% endraw %}
