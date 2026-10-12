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

**What that costs an unbound multi-project host.** Every unbound session on a daemon shares one graph, so:

- `memory.query` returns facts another project's session wrote.
- `memory.persist` writes the **entire** shared graph to whatever `path` it is given — so every per-project file accumulates every project's facts.
- `memory.load` **resets** that shared graph before ingesting (see below), so one session loading its own file discards facts another session had in memory.

If you key memory per project, bind a namespace. `session.auth { memory_namespace: "myapp-<projectID>" }` gives that connection a private graph, persisted under `~/.car/memory/memory-namespaces/<encoded-ns>.json` — the filename is a lowercase percent-encoding of the namespace's UTF-8 bytes (`a`-`z`, `0`-`9`, `-`, `_`, `.` pass through; everything else, including `%` and uppercase letters, becomes `%` plus two lowercase hex digits), which keeps the mapping injective so two namespaces can never share a snapshot file (#891) — and every `memory.*` call on that connection acts on it alone. A namespace is a **separate axis from `agent_id`** — one agent may work across several namespaces, and two hosts may share a namespace without sharing an identity. When both are supplied the namespace wins for the memory scope; the agent binding still governs identity and tokens. (Parslee-ai/car-releases#79.)

#### `memory.add_fact`
- **Params**: `{ subject: string, body: string, kind?: string = "pattern", fact_id?: string, tags?: string[], source?: string = "user", committed_by?: string, verdicts?: VerifierVerdict[] }`
- **Returns**: updated fact count
- `kind: "constraint"` sets the constraint flag. A non-empty caller-supplied `fact_id` is the graph fact id; CAR mints a `ws-<count>` id only when the field is absent (bumping the counter past any id already in the graph, so a caller's literal `ws-7` can never be silently shadowed by a rewritten auto id). A duplicate caller id is rejected rather than silently rewritten — **except** for an identical-content re-add (same id, same subject and body), which resolves to the existing fact instead: that is the normal behavior of an at-least-once client retrying a call whose response it missed, or a caller replaying after a daemon restart re-loaded its snapshot. A duplicate id with **different** content is a genuine collision and errors, so a caller seeing that error knows someone else wrote this id with different content and can resolve it with a `memory.query`.
- `tags` preserve caller order and `source` is stored as the fact's provenance source. All three caller values survive namespace/agent snapshots and manual `memory.persist` → `memory.load` for Fact rows — the flat snapshot format stays deliberately lossy for non-Fact kinds (Conversation `outcome` rows reload as plain facts, Skill/Conclusion rows collapse to `pattern`, Identity/Environment rows are not written), so full-graph fidelity is not claimed — and `memory.query` returns them unchanged.
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
- **Params**: `{ max_recent?: number = 32, tenant_id?: string }`
- **Returns**: `{ trigger, saved, skipped_existing, status? }`
- Runs Phase 1 of proactive memory over the recent session event log. CAR mines high-signal trajectory events such as failed actions, retries, exhausted replans, ungrounded/open goal evaluations, and truncated or stalled turns into compact knowledge/procedural entries with stable ids. Re-running maintenance over the same events is idempotent: existing event-derived memories are counted in `skipped_existing` instead of duplicated. The returned `trigger` can be passed directly into `memory.intervene`.
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
- **Returns**: `[ { fact_id: string | null, subject, body, kind, confidence, tags, source }, ... ]` (`fact_id` is non-null for facts written through `memory.add_fact`; other graph node kinds may not carry one)
- Personalized PageRank retrieval over the memory graph. FFI parity with NAPI `query_facts` — same algorithm, same result shape, so the choice of transport does not shift ranking.

#### `memory.intervene`
- **Params**: `{ query?: string, recent?: string[], trigger?: { repeated_failures?: number, tool_error?: boolean, explicit_uncertainty?: boolean, high_risk_action?: boolean, context_shift?: boolean }, force?: boolean, max_candidates?: number = 8, tenant_id?: string }`
- **Returns**: either `{ decision: "inject", reminder, selected, candidates, bank }` or `{ decision: "silent", reason, candidates, bank }`
- Proactive memory hook for long-horizon runs. Unlike `memory.build_context`, this does not expose the full memory bank. It selects at most one grounded reminder from durable memgine state for the next action, or returns an explicit silence decision when no remembered state is strong enough to interrupt. An injected reminder increments the selected fact's usage counter so later outcome credit can update utility-aware retrieval.
- `trigger` carries runtime pressure signals such as repeated tool failures, uncertainty, high-risk actions, or context shifts. These signals bias the selector toward requirements, diagnostics, procedural attempts, and open subgoals without forcing always-on reminders. `force: true` is for harness ablations and debugging; normal callers should leave it false.
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
- **Writes the whole graph, not a subset.** `path` names the destination file; it does not select what goes into it. On an unbound session that graph is the daemon-wide shared one, so per-project files each end up holding every project's facts. Bind a `memory_namespace` (see the scope table above) if you want a file to contain only one project's facts.
- **Filesystem caveat**: `path` is interpreted on the daemon's filesystem, not the caller's. Cross-process file access requires shared paths.
- **Sandbox**: `path` is sandboxed under `~/.car/memory/` on the daemon (same enforcement the FFI bindings have applied since v0.7.1 — see `car_ffi_common::memory_path::resolve`). Relative paths land under that base; `..` segments and symlinks pointing outside are rejected with a `memory.persist rejected path …` error. The audit-driven flip to require auth on the WS made this surface as exposed as the FFI; the sandbox guards both equally.

#### `memory.load`
- **Params**: `{ path: string }`
- **Returns**: number of facts loaded
- Replaces the session's memgine with the facts at `path`. Internally calls `engine.reset()` before ingest, so this is a full replace, not a merge. FFI parity with NAPI `load_memory`. Same filesystem caveat **and same `~/.car/memory/` sandbox** as `memory.persist`.
- **The reset is scoped to the graph, not the connection.** On an unbound session that graph is the daemon-wide shared one, so this discards facts other sessions currently hold in memory — including facts ingested over MCP. It is easy to miss when the file does not exist yet, because the call fails and no reset happens; the destructive path only appears once the file is there. Bind a `memory_namespace` to make load/persist affect only your own graph.

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
