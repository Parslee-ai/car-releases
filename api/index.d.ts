/** Common Agent Runtime — native Node.js bindings.
 *
 * Most methods that return structured data return a JSON-encoded string; the
 * caller is expected to `JSON.parse` the result. This keeps the FFI surface
 * small and avoids coupling the native binding to any specific TS shape.
 *
 * ## Daemon-only
 *
 * Every method talks to the singleton car-server daemon over WebSocket
 * JSON-RPC. There is no embedded-engine fallback (the v0.7.x
 * `CAR_FFI_MODE=embedded` knob is retired). Start `car-server` before
 * using the bindings — on macOS the SwiftUI menubar app launches it for
 * you; on Linux start it manually or via systemd.
 *
 * The following methods are **not exposed in the FFI bindings** and throw
 * with a clear message — connect to the daemon's WebSocket directly
 * for the equivalent flow (see `docs/websocket-protocol.md`):
 *
 * - `executeProposal` — use `proposal.submit` JSON-RPC + a `tools.execute`
 *   handler on the WS connection
 * - `inferStream`, `transcribeStream`, `dispatchVoiceTurn` — daemon
 *   streams events over WS notifications
 * - `openSession`, `closeSession`, `registerPolicy(sessionId)` — use
 *   `session.open` / `session.close` JSON-RPC methods
 * - `stateSnapshot`, `stateKeys` — daemon-side endpoints pending
 *
 * (`registerModel` was re-exposed in #39 — it now proxies to the
 *  daemon's `models.register` JSON-RPC. See its docstring for
 *  the visibility caveat.)
 *
 * Daemon URL override: `CAR_DAEMON_URL=ws://...` (default
 * `ws://127.0.0.1:9100`).
 */

/** Persistent runtime instance with state, memory, tools, and policies. */
/**
 * Optional settings for `coderStart`. Every field is independently omittable;
 * each falls back to the daemon's `~/.car/coder.toml`.
 *
 * **Breaking (v0.44.0):** replaced five trailing positional optionals — three
 * of them numbers — which callers could silently mis-order.
 */
export interface CoderStartOptions {
  /** `"auto" | "native" | "external[:agent_id]" | "foreman[:agent_id]"`. */
  engine?: string | undefined | null;
  /** Contract-evaluation rounds before the native loop gives up. */
  maxIterations?: number | undefined | null;
  /** Per-session backbone pin, reaching whichever engine runs. */
  model?: string | undefined | null;
  /**
   * External-engine hypothesis budget: fresh repair invocations after a red
   * pass. Recurrence escalation needs >= 2 to reach the model at all.
   */
  repairInvokes?: number | undefined | null;
  /**
   * External-engine availability budget: re-invocations after the CLI process
   * died mid-run. Separate from `repairInvokes` on purpose — one buys a
   * hypothesis, the other buys a retry.
   */
  transientRetries?: number | undefined | null;
  /**
   * A `coder.discuss` conversation this run was distilled from. Its agreed
   * constraints ride into contract derivation, so a rule stated once in the
   * discussion does not have to be restated in the intent, and the session
   * records the provenance. An unknown id is a clear error — never a silently
   * ungrounded run.
   */
  discussionId?: string | undefined | null;
}

export class CarRuntime {
  constructor();

  // --- Memory persistence ---

  /**
   * Load memory graph from a JSON file. Returns the number of facts loaded.
   *
   * Daemon-side read: `path` is sandboxed under `~/.car/memory/` (the
   * 2026-05 audit boundary). Relative paths land under the base;
   * absolute paths must already be under the base; `..` segments and
   * symlinks pointing out of the sandbox are rejected.
   *
   * **`path` names a file, not a namespace.** This REPLACES the graph the
   * connection is bound to — and by default that is the daemon's SHARED graph,
   * common to every unbound session and to facts ingested over MCP. So on a
   * multi-project host this both discards other projects' in-memory facts and
   * leaves the loaded ones visible to them. Set `CAR_MEMORY_NAMESPACE` in the host process to bind a private graph
   * (car-releases#79/#80); the shared daemon transport puts it on the
   * `session.auth` handshake for you.
   */
  loadMemory(path: string): Promise<number>;

  /**
   * Stream one delta of a chat turn back to the daemon as an
   * `agent.chat.event` notification (the agent-chat surface). Called from an
   * `agent.chat` handler (see `registerChatHandler`) to emit the reply
   * incrementally; the daemon rewrites each event to `agents.chat.event` for
   * the host that issued `agents.chat`, keyed by `sessionId`.
   *
   * `kind` is one of `token` | `tool_call` | `done` | `error`. `delta` carries
   * the text for `token` (and the final text/status for `done`/`error`); omit
   * it for a bare signal.
   */
  chatEvent(sessionId: string, kind: string, delta?: string | undefined | null): Promise<void>;

  /**
   * Persist memory graph to a JSON file (backward-compatible flat format).
   * Returns the number of records written.
   *
   * Daemon-side write: same `~/.car/memory/` sandbox as `loadMemory`.
   *
   * **Writes the whole graph, not a subset.** `path` chooses the destination
   * file; it does not select the contents. On an unbound session that graph is
   * the daemon-wide shared one, so per-project files each end up holding every
   * project's facts. Set `CAR_MEMORY_NAMESPACE` for a file that contains only one project's
   * facts (car-releases#79/#80).
   */
  persistMemory(path: string): Promise<number>;

  // --- Foreman ---

  /**
   * Decompose a coding `goal` into a footprint-annotated, scheduled subtask
   * plan. `repo` defaults to the daemon's cwd. Returns a JSON
   * `ForemanPlanReport` (`schema_version`, `valid`, `prefer_single_session`,
   * `levels`, `subtasks[]` with declared `writes`/`reads`).
   */
  foremanPlan(goal: string, repo?: string, maxAttempts?: number): Promise<string>;

  /**
   * Plan a coding `goal`, then farm the subtasks to an external coding CLI
   * (`adapter`, default `"claude-code"`) in isolated git worktrees, gating each
   * worktree and the integrated union. `verifyCommand` is the per-worktree
   * **regression** check; `unionVerifyCommand` is the integrated-union **goal**
   * check (falls back to `verifyCommand` when omitted). **Spends real agent
   * quota.** Returns JSON `{ plan, ran, run? }`.
   */
  foremanRun(
    goal: string,
    repo?: string,
    adapter?: string,
    verifyCommand?: Array<string>,
    unionVerifyCommand?: Array<string>,
    maxAttempts?: number
  ): Promise<string>;

  // --- Tools & policies ---

  /** Register a tool by name. */
  registerTool(name: string): Promise<void>;

  /**
   * The tools currently registered on this runtime, as a JSON array of full
   * `ToolSchema` objects sorted by name.
   *
   * Counterpart to `registerTool` / `registerToolSchema`, which had none: a
   * caller could add tools but never ask what was actually in effect, so a
   * governed or read-only deployment could not prove "only these tools are
   * callable". Sorted, so two calls with no registration in between are
   * byte-identical and can be diffed.
   */
  listTools(): Promise<string>;

  /**
   * Remove a tool by name. Resolves to how many were removed — `0` means
   * nothing matched, which is not an error, so cleanup can call this
   * unconditionally.
   *
   * Drops the tool from both the runtime's registry and its schema map, so
   * the model stops seeing it and the validator stops accepting it.
   */
  unregisterTool(name: string): Promise<number>;

  /** Register CAR's built-in agent utility tools. */
  registerAgentBasics(): Promise<void>;

  /**
   * Start an agent run on the daemon (agent run tracing). Brackets the
   * beginning of a run: the daemon mints a durable `run_id`, resolves
   * the owning `agent_id`, tags it as the session's current run before
   * replying, and records that the run started. Await this before
   * submitting any proposal so the per-turn recorder reads the right
   * `run_id`.
   *
   * `paramsJson` is a serialized request object:
   * `{ intent, agent_id?, agent_name?, outcome_description?, idempotency_key? }`.
   * When `agent_id` is omitted the daemon resolves it from the session's
   * `agent_id` binding, then `CAR_AGENT_ID`, then a deterministic id
   * synthesized from `agent_name`. An `idempotency_key`, when supplied,
   * becomes the `run_id` and makes the start dedup: if a run with that id
   * already exists the existing run is returned instead of a duplicate.
   * Returns `{ run_id, agent_id }` as a JSON string.
   */
  runsStart(paramsJson: string): Promise<string>;

  /**
   * Complete an agent run on the daemon (agent run tracing). Records
   * the terminal `AgentOutcome` for `run_id` and acks. Await this ack
   * before letting the connection close so a healthy run is never
   * mislabeled `Incomplete`.
   *
   * `paramsJson` is a serialized request object: `{ run_id, outcome }`.
   * Returns `{ run_id, ok }` as a JSON string.
   */
  runsComplete(paramsJson: string): Promise<string>;

  /**
   * Open a policy-scoping session and return its opaque id. Hosts
   * that drive multiple concurrent agent contexts through one
   * CarRuntime (IDE per-project rules, multi-tenant servers) call
   * this once per context, then pass the id to subsequent
   * `registerPolicy` and `executeProposal` calls so per-context rules
   * stack on top of any global ones. Embedded only.
   * See `docs/proposals/per-session-policy-scoping.md`.
   */
  openSession(): Promise<string>;

  /**
   * Close a session and drop every policy scoped to it. Returns true
   * if a session by that id existed, false if it didn't (already
   * closed, never opened).
   */
  closeSession(sessionId: string): Promise<boolean>;

  /**
   * Register a policy enforced in Rust on every action.
   * `rule` is one of: "deny_tool", "deny_tool_param", "require_state",
   * "deny_tool_callback".
   * `sessionId`, when set, scopes the policy to the named session
   * (opened via `openSession`). Without it, the policy is global.
   */
  registerPolicy(
    name: string,
    rule: string,
    target?: string | null,
    key?: string | null,
    pattern?: string | null,
    valueJson?: string | null,
    sessionId?: string | null,
  ): Promise<void>;

  /**
   * Remove a global policy by name. Resolves to how many were removed —
   * `0` means nothing matched, which is not an error, so cleanup can call
   * this unconditionally.
   *
   * Counterpart to `registerPolicy`, which had none: a policy registered
   * over the wire could only be cleared by restarting the daemon
   * (Parslee-ai/car#623). Session-scoped policies stay WS-only, mirroring
   * `registerPolicy`'s own `sessionId` restriction — close the session to
   * drop them.
   */
  unregisterPolicy(name: string): Promise<number>;

  /**
   * Global policies in force, as a JSON array of `{ name, description }`.
   * Without this a caller could register a policy but never ask what was
   * enforced, so an action rejection could not be explained beyond its own
   * message.
   */
  listPolicies(): Promise<string>;

  /**
   * Set replan configuration on this runtime.
   * `maxReplans` = 0 disables replanning (default).
   * `replanOnRejected` (default false): when true, validator/policy/capability
   * rejections (not just runtime failures) also trigger rollback + replan.
   */
  setReplanConfig(
    maxReplans: number,
    delayMs?: number | null,
    replanOnRejected?: boolean | null,
  ): Promise<void>;

  // --- State ---

  /** Set a state key (value must be a JSON string). `tenant` (optional)
   * scopes the write to one tenant's keyspace (E3). */
  stateSet(key: string, valueJson: string, tenant?: string): void;

  /** Get a state key. Returns the value as a JSON string, or `"null"`.
   * `tenant` (optional) scopes the read to one tenant's keyspace (E3). */
  stateGet(key: string, tenant?: string): string;

  /** `tenant` (optional) scopes the check to one tenant's keyspace (E3). */
  stateExists(key: string, tenant?: string): boolean;

  /** Snapshot of all state as a JSON string. `tenant` (optional) scopes
   * the snapshot to one tenant's keyspace (E3). */
  stateSnapshot(tenant?: string): string;

  /** `tenant` (optional) scopes the key list to one tenant's keyspace (E3). */
  stateKeys(tenant?: string): string[];

  // --- Memory / Facts (graph-backed) ---

  /**
   * Add a fact. `kind` is typically "pattern" or "constraint".
   *
   * In Daemon mode, rejects with the daemon-unreachable error
   * instead of silently returning 0 (#146).
   */
  addFact(
    subject: string,
    body: string,
    kind: string,
    confidence?: number | null,
  ): Promise<number>;

  /** Query facts via graph spreading activation. Returns a JSON array. */
  queryFacts(query: string, k?: number | null): string;

  /**
   * Total valid fact count.
   *
   * In Daemon mode, hits the daemon's per-session memgine — the
   * embedded fallback memgine stays empty by design and would
   * silently return 0 (#146). Rejects with the daemon-unreachable
   * error instead.
   */
  factCount(): Promise<number>;

  /**
   * Build the full 4-layer context for a query.
   * When `modelContextWindow` is provided, dynamically sizes the budget.
   *
   * In Daemon mode, rejects with the daemon-unreachable error
   * instead of silently returning "" (#146).
   */
  buildContext(query: string, modelContextWindow?: number | null): Promise<string>;

  /**
   * Build context in Fast mode for latency-sensitive paths.
   * Skips embedding flush, skill lookup, PPR-based scoring, known unknowns.
   */
  buildContextFast(query: string, modelContextWindow?: number | null): string;

  // --- Proactive memory ---

  /**
   * Update proactive memory's private progress/risk status.
   * `paramsJson` is `{ body, tenant_id? }`; returns `ProactiveStatus` JSON.
   */
  memoryUpdateStatus(paramsJson: string): Promise<string>;

  /**
   * Run proactive memory Phase 1 maintenance over recent daemon telemetry.
   * `paramsJson` is `{ max_recent?, tenant_id? }`; returns report JSON.
   */
  memoryMaintain(paramsJson: string): Promise<string>;

  /**
   * Save durable proactive knowledge.
   * `paramsJson` is `ProactiveMemorySave`; returns saved-entry JSON.
   */
  memorySaveKnowledge(paramsJson: string): Promise<string>;

  /**
   * Save durable proactive procedural evidence.
   * `paramsJson` is `ProactiveMemorySave`; returns saved-entry JSON.
   */
  memorySaveProcedural(paramsJson: string): Promise<string>;

  /**
   * Delete a proactive memory entry by id.
   * `paramsJson` is `{ id }`; returns delete report JSON.
   */
  memoryDelete(paramsJson: string): Promise<string>;

  /**
   * Select a targeted proactive memory reminder.
   * `paramsJson` is `ProactiveMemoryRequest`; returns inject/silent JSON.
   */
  memoryIntervene(paramsJson: string): Promise<string>;

  /**
   * Evaluate proactive memory against labeled cases and ablation baselines.
   * `paramsJson` is `ProactiveEvaluationRequest`; returns report JSON.
   */
  memoryEvaluate(paramsJson: string): Promise<string>;

  /** Run memory consolidation ("dream") pass. Returns a JSON report. */
  consolidate(): string;

  /**
   * Get the live engine's utility-aware retrieval blend (U-Mem).
   * Returns JSON `{ utility_weight, utility_exploration }`.
   */
  utilityRetrieval(): string;

  /**
   * Set the live engine's utility-aware retrieval blend (U-Mem).
   * `utilityWeight` 0 = pure relevance (ordering unchanged);
   * `utilityExploration` scales the UCB uncertainty term (only consulted
   * when weight > 0). Omitting `utilityExploration` keeps the engine's
   * current value (read-modify-write), it does NOT reset it to 0. Takes
   * effect on the next context build. Returns the applied JSON
   * `{ utility_weight, utility_exploration }`.
   */
  setUtilityRetrieval(utilityWeight: number, utilityExploration?: number | null): Promise<string>;

  /**
   * Run the U-Mem cost-aware knowledge cascade (Slice 5 live evolve loop) on
   * the daemon. `requestJson` is `{ current_confidence, policy, observed,
   * claim? }`; the daemon runs each tier's mechanic (self_reflect → reflect(),
   * human_expert → ApprovalLedger HITL) + the budget/target walk, escalating
   * cheapest-first on the caller-supplied observed confidence. Returns JSON
   * `{ run, pending_approval? }`.
   */
  cascadeRun(requestJson: string): Promise<string>;

  /**
   * Plan an evolution cycle over the daemon's **live** engine signals — the
   * self-evolution governor's host surface (arXiv 2507.21046). `requestJson` is
   * `{ policy?: { pressure_threshold?, budget? } }`; the daemon folds the session
   * memgine's real per-component pressure/evidence and runs the governor. Returns
   * the `EvolutionPlan` JSON `{ decisions, spent, evolve_now }` — the live
   * counterpart to the stateless `planEvolution` helper. Plans only; the caller
   * dispatches the chosen components.
   */
  planEvolutionLive(requestJson: string): Promise<string>;
  /**
   * `memory.set_admission_table` — install or clear the durable-state
   * admission rules: `{ table?: OwnershipTable | null }` →
   * `{ enabled, ungated_surfaces }`.
   *
   * A null or absent `table` turns the gate OFF, which is the default. Off is
   * not the same as an empty table: an empty table is fail-closed and refuses
   * every externally-authored fact.
   */
  memorySetAdmissionTable(requestJson: string): Promise<string>;
  /**
   * `memory.admission_table` — read back the installed admission rules: `{}` →
   * `{ enabled, table, ungated_surfaces }`.
   *
   * `ungated_surfaces` names surfaces whose rule imposes no real constraint —
   * worth checking after installing a table that only looks governed.
   */
  memoryAdmissionTable(requestJson: string): Promise<string>;
  /**
   * `supervision.subscribe` — register this connection as a supervisor of the
   * admission gate: `{ filter?: { tools?, sessions?, min_reversibility? } }`.
   *
   * Intents arrive as `supervision.intent` NOTIFICATIONS on the same socket.
   * A caller that cannot read notifications should poll `supervisionPending`
   * instead — subscribing without consuming them blocks every supervised
   * proposal until it fails closed.
   */
  supervisionSubscribe(requestJson: string): Promise<string>;
  /**
   * `supervision.unsubscribe` — stop supervising: `{}`. Intents already parked
   * run out their timeout and fail closed rather than being released, so a
   * supervisor cannot turn a pending deny into an allow by disconnecting.
   */
  supervisionUnsubscribe(requestJson: string): Promise<string>;
  /** `supervision.pending` — every intent currently parked on a verdict: `{}`. */
  supervisionPending(requestJson: string): Promise<string>;
  /** `supervision.decide` — `{ intent_id, decision: { kind: "allow" | "deny" | "escalate", reason? } }`. */
  supervisionDecide(requestJson: string): Promise<string>;
  /** `sync.status` — roster, journal frontier, stable frontier, state hash (B6). */
  syncStatus(requestJson: string): Promise<string>;
  /** `sync.append` — record an op on any surface: `{ surface, payload, scope? }` (B6). */
  syncAppend(requestJson: string): Promise<string>;
  /** `agents.peers` — the agents this runtime can message, from the daemon's live connection table. */
  agentsPeers(requestJson: string): Promise<string>;
  /** `agents.message` — send text to one peer: `{ to, body, summary? }`. The sender is derived server-side. */
  agentsMessage(requestJson: string): Promise<string>;
  /** `agents.message.pending` — peer messages awaiting an operator decision. Host-only. */
  agentsMessagePending(requestJson: string): Promise<string>;
  /** `agents.message.approve` — release or drop one held message: `{ id, decision }`. Host-only. */
  agentsMessageApprove(requestJson: string): Promise<string>;
  /** Store/load exact supervised-assistant checkpoints in the durable oplog. */
  syncAssistantCheckpointPut(requestJson: string): Promise<string>;
  syncAssistantCheckpointGet(requestJson: string): Promise<string>;
  /** Append/load monotone supervised-action lifecycle records. */
  syncAssistantActionPut(requestJson: string): Promise<string>;
  syncAssistantActionGet(requestJson: string): Promise<string>;
  /** `sync.record_turn` — route a conversation turn through the oplog so `syncResume` is real (B6). */
  syncRecordTurn(requestJson: string): Promise<string>;
  /** `sync.record_intent` — write the leased-execution intent ledger; feeds the fence oracle (B6). */
  syncRecordIntent(requestJson: string): Promise<string>;
  /** `sync.pump` — one push/pull/ack reconciliation round against the relay (B6). */
  syncPump(requestJson: string): Promise<string>;
  /** `sync.checkpoint` — publish a device-side checkpoint at the stable frontier (B6). */
  syncCheckpoint(requestJson: string): Promise<string>;
  /** `sync.rebase` — cold bootstrap / straggler re-entry onto the latest checkpoint (B6). */
  syncRebase(requestJson: string): Promise<string>;
  /** `sync.transcript` — the ordered role-threaded `Turn[]` projection (B6). */
  syncTranscript(requestJson: string): Promise<string>;
  /** `sync.resume` — the repaired, provider-valid `Message[]` for replay (B6). */
  syncResume(requestJson: string): Promise<string>;
  /** `sync.fence_check` — the dispatch fence at the point of effect; only `may_dispatch` authorizes (B6). */
  syncFenceCheck(requestJson: string): Promise<string>;
  /** `lease.acquire` — CAS-acquire the per-agent execution lease; epoch bumps on grant (B6). */
  leaseAcquire(requestJson: string): Promise<string>;
  /** `lease.renew` — heartbeat the lease (no epoch bump), iff still the holder (B6). */
  leaseRenew(requestJson: string): Promise<string>;
  /** `lease.release` — clean handoff (next acquire skips the TTL wait) (B6). */
  leaseRelease(requestJson: string): Promise<string>;
  /** `lease.status` — the linearizable read of the current lease, or `null` (B6). */
  leaseStatus(requestJson: string): Promise<string>;

  /**
   * Run one evolution cycle over the daemon's **live** signals — the
   * self-evolution governor's real executor (arXiv 2507.21046). `requestJson`
   * is `{ policy?, dry_run?, harness_baseline_metrics?,
   * harness_candidate_metrics?, harness_measure?, context_measure? }`; the daemon plans over all five live
   * components (Memory/Skills/Context from the engine, Harness from the event
   * log, Tools from connector health) and dispatches each `EvolveNow`
   * component: Memory → consolidate (sized by decide_maintenance), Skills →
   * evolve_skills over event-log failure traces, Harness → the HITL-gated
   * harness_evolution loop (pending approvals resolve via
   * `permission.approve`/`reject` by fingerprint), Context → the
   * `context_evolution` loop, which resolves each mutation either through the
   * opt-in pre-activation grader (`context_measure`) or, for whatever that did
   * not decide, the diagnose→approve→apply→measure→revert human path. Returns
   * the cycle record JSON
   * `{ plan, steps, evolved, out_of_scope, pending_approvals?, measurement? }`,
   * where each step is `{ component, ran, applied, out_of_scope, outcome }`.
   *
   * **Context.** Diagnoses off the engine's own live conversation-layer
   * saturation and lowers `MemgineConfig.conversation_keep_recent` (halved,
   * floored at 2) so compaction summarizes more of the older turns. Every
   * mutation is HITL-gated on the same shared durable `ApprovalLedger` as
   * harness ones, under its own fingerprint namespace
   * `context:<component>:<patch-digest>`, resolved by the same
   * `permission.approve`/`reject`. There **is** a pre-activation regression
   * gate, opt-in via `context_measure` (see below) — this doc comment used to
   * say there was none, because the bench replayed a runtime with no memgine
   * attached and never offered a `recall` tool; bench tasks may now declare a
   * `memory:` fixture and are then replayed with a real memgine and the shipped
   * `recall` tool, so the assembled context moves with the knob. A graded
   * mutation promotes (`applied` with `governance: "promoted"`) or is rejected
   * (`rejected_by_gate`) with no operator in the loop. On the human-approved
   * path — and whenever no grade ran — the daemon measures the MARGIN after the
   * apply: compact under the unchanged value for a baseline
   * (`conversation_tokens_baseline`), apply, compact again, and revert unless
   * the tokens fell below that baseline (`rolled_back`, not counted as
   * applied; `rollback_failed` with `rollback_error` if even the revert did
   * not take). Comparing against the baseline rather than the uncompacted
   * layer is what stops the change being credited with savings compaction
   * would have produced anyway. So context is **not** unattended out of the
   * box; it becomes unattended for a given change only once that fingerprint
   * has been approved — and since the ledger is daemon-wide and the
   * fingerprint names the change, that approval covers the same change on
   * every engine this daemon evolves. On the unattended cadence a falsified
   * mutation then backs off exponentially per fingerprint (`in_backoff`)
   * instead of being re-applied and re-reverted every tick. The step's
   * `outcome` is a JSON string `{ mechanism: "context_evolution", mutations,
   * applied, pending, details }`, each detail carrying `mutation`,
   * `component`, `fingerprint`, `rationale` and one of `pending_approval` |
   * `applied` | `rolled_back` | `rollback_failed` | `apply_failed` |
   * `would_apply` | `in_backoff` | `rejected_by_operator` |
   * `approved_no_patch` | `rejected_by_gate` | `measurement_failed` |
   * `config_moved_during_measurement` (a graded promotion whose measured base
   * was moved by something else while the replays ran — nothing applied, both
   * values reported, no backoff). When `context_measure` was requested the
   * summary also carries `context_measured: { status: "measured" |
   * "skipped_dry_run", grade_attempts, model, split, split_seed }`.
   *
   * **Tools** is recorded as `out_of_scope` — a decision, not a failure.
   * Connector remediation means re-running a connector's OAuth or credential
   * exchange, an access change this loop holds no authority to perform;
   * reconnect/re-auth stay operator actions via `connectors.*`. Such a step is
   * `ran: true, applied: false, out_of_scope: true` with the reason in
   * `outcome`, and the component appears in the top-level `out_of_scope`
   * array (always present, empty when none). `ran: false` therefore means one
   * thing only: the mechanism was invoked and errored.
   *
   * `harness_measure` `{ model, split?, held_in_fraction?, split_seed?,
   * max_turns?, tasks_dir? }` opts into **in-daemon measurement**: the daemon
   * replays the held-out split itself (once for the baseline under the live
   * `HarnessConfig`, once per measurable mutation under that config plus the
   * mutation's patch) and feeds the regression gate, so a cycle can promote or
   * reject unattended. It is mutually exclusive with the two supplied-metrics
   * params (sending both errors, naming both); `dry_run` measures nothing and
   * reports `measurement.status = "skipped_dry_run"`; a build with no
   * in-process evaluator installed errors rather than degrading to HITL;
   * safety-affecting and patchless mutations are never measured; a failed
   * replay reports `measurement_failed` and fabricates no metrics.
   *
   * `context_measure` takes the SAME request shape and opts into the **Context
   * pillar's** pre-activation grader: two replays over the same split, one
   * under the engine's live `MemgineConfig` and one under it plus the
   * mutation's patch, graded on TASK outcomes by the same gate. The two params
   * are not mutually exclusive with each other (different pillars, two
   * independent measurements). `dry_run` performs no replay; a build with no
   * evaluator installed errors; a patchless mutation is never measured; the
   * unattended cadence never requests a grade at all, so an idle timer cannot
   * start spending benchmark replays.
   * `measurement` is TOP-LEVEL on the response (not only inside the harness
   * step) and present whenever `harness_measure` was requested, in every
   * shape it can end in — `measured` / `skipped_dry_run` /
   * `measurement_failed` with the error. A replay is a paid side effect and
   * the plan may legitimately never dispatch Harness, so a side effect
   * reported only from that step is one a caller can be billed for and never
   * see.
   */
  runEvolutionCycleLive(requestJson: string): Promise<string>;

  // --- Skills ---

  /**
   * Gate a skill's deployment capability against its provenance on the daemon,
   * folding the named skill's **live** track record into the decision
   * (arXiv 2602.12430 "Agent Skills"). `requestJson` is `{ skill_name,
   * provenance, requested_tier }` where `requested_tier` is
   * `"read_only" | "sandbox_edit" | "full_access"`. The daemon overrides the
   * provenance's lifecycle counts with the skill's real success/fail record, so
   * a skill failing in the field is denied despite an official signature.
   * Returns the `SkillDeploymentDecision` JSON. Live counterpart to the
   * stateless `gateSkillDeployment` helper.
   */
  gateSkillDeploymentLive(requestJson: string): Promise<string>;

  /**
   * Enforce a skill's deployment at load time against the session's durable
   * approval ledger (arXiv 2602.12430 "Agent Skills" Slice 4 — the HITL bridge).
   * `requestJson` is `{ skill_name, provenance, requested_tier }`; the daemon
   * gates the skill (folding its live track record), then resolves the verdict
   * against standing operator decisions: `Allow`/`Downgrade` deploy
   * autonomously, a `Deny` is overridden/blocked/pending. Returns
   * `{ decision, enforcement, pending_approval? }`; a pending approval is
   * resolved via `permission.approve`/`permission.reject` by the returned
   * `fingerprint`.
   */
  enforceSkillDeploymentLive(requestJson: string): Promise<string>;

  /**
   * Read the standing permission tier granted to this connection's daemon
   * session (`read_only` | `sandbox_edit` | `full_access`) — the tier every
   * {@link submitProposal} on this connection is judged against
   * (Parslee-ai/car#890).
   */
  permissionGetTier(): Promise<string>;

  /**
   * Set this connection's standing permission tier and return the tier as the
   * daemon now holds it. `tier` is `read_only` | `sandbox_edit` |
   * `full_access`.
   *
   * Lets a binding client govern its own session — most usefully by tightening
   * it: dropping to `read_only` makes the runtime escalate any write this
   * client proposes to a human instead of running it. Raising the tier is
   * host-gated whenever the daemon runs under a host token, so an agent
   * connection cannot self-elevate.
   */
  permissionSetTier(tier: string): Promise<string>;

  /**
   * Ingest a skill through the deployment gate on the daemon (arXiv 2602.12430
   * "Agent Skills" — the loader integration). `requestJson` carries the skill
   * fields (`name`, `code`, `platform`, `persona?`, `url_pattern?`,
   * `description?`, `supersedes?`, `task_keywords?`) plus `provenance?` and
   * `requested_tier`. The daemon gates + enforces against the session ledger and
   * **only ingests when deployment is permitted**, stamping the granted ceiling
   * onto the skill. Returns `{ ingested, node?, decision, enforcement,
   * pending_approval? }`; a pending deny is resolved via
   * `permission.approve`/`permission.reject` by the returned `fingerprint`.
   */
  ingestSkillGoverned(requestJson: string): Promise<string>;

  /**
   * Adopt an installed skill pack on the daemon through the skill-trust
   * deployment gate (arXiv 2602.12430 "Agent Skills" — the pack-adoption
   * call-site). `requestJson` carries `pack` (an `ApprovedSkillPack`),
   * `requested_tier?` (default `read_only`), and either `manifest?` — the signed
   * bundle, whose signature trust is derived against the operator's
   * `.car/config.toml` `trusted_skill_signers` keyring — or `provenance?`
   * (caller-assembled), plus optional `scanned?`/`vulnerabilities?`/`source?`.
   * Governance is unconditional: a denied skill never enters the graph. Returns
   * `{ loaded, pending, refused, requested_tier, provenance, trusted_signers }`;
   * a pending deny is resolved via `permission.approve`/`permission.reject` by
   * the returned `fingerprint`, then re-adopted.
   */
  adoptSkillPack(requestJson: string): Promise<string>;

  /**
   * Save a learned skill with trigger context. Returns the node
   * index.
   *
   * In Daemon mode, rejects with the daemon-unreachable error
   * (or a parse error if the response is malformed) instead of
   * silently returning 0 (#146).
   */
  ingestSkill(
    name: string,
    code: string,
    platform: string,
    persona: string,
    urlPattern: string,
    taskKeywords: string[],
    description: string,
    supersedesSkill?: string | null,
  ): Promise<number>;

  /** Find best matching skill for context. Returns JSON or `"null"`. */
  findSkill(
    persona: string,
    url: string,
    task: string,
    maxResults?: number | null,
  ): string;

  /** Report skill execution outcome ("success" or "fail"). Returns updated stats JSON. */
  reportOutcome(skillName: string, outcome: string): string;

  /** Distill skills from execution trace events. Returns JSON array of DistilledSkill. */
  distillSkills(eventsJson: string): Promise<string>;

  /** Ingest distilled skills into the memory graph. Returns the count ingested. */
  ingestDistilledSkills(skillsJson: string): number;

  /** List skills (optionally filtered by domain). Returns JSON array. */
  listSkills(domain?: string | null): string;

  /** Domains with success rate below the given threshold (default 0.6). */
  domainsNeedingEvolution(threshold?: number | null): string[];

  /** Repair a degraded skill using local inference. Returns repaired code or null. */
  repairSkill(skillName: string): Promise<string | null>;

  /** Evolve skills for a domain based on failed events. Returns JSON array. */
  evolveSkills(eventsJson: string, domain: string): Promise<string>;

  /**
   * Ingest distilled/evolved skills as validation-gated PROVISIONAL candidates
   * on trial (vs `ingestDistilledSkills`, which trusts them active). Returns the
   * count ingested. See docs/solutions/gated-skill-optimization.md.
   */
  ingestProvisionalSkills(skillsJson: string, tenant?: string | null): number;

  /**
   * Run the skill promotion gate: provisional candidates with enough trial
   * outcomes are promoted (strictly-better Wilson lower bound) or rejected.
   * Returns JSON `{ promoted: string[], rejected: string[] }`.
   */
  gateSkillCandidates(): Promise<string>;

  /**
   * Fetch a skill's full SkillMeta by key (lifecycle `status`, `incumbent`,
   * `version`, `stats`). Returns JSON SkillMeta, or the string "null" if absent.
   */
  skillMeta(key: string): Promise<string>;

  /**
   * Export a VALIDATED skill as a portable markdown document (the SkillOpt
   * best_skill.md analog). Only Active, healthy skills export. Returns the
   * markdown, or null if the key is absent / not exportable.
   */
  exportSkill(key: string): Promise<string | null>;

  /**
   * Import a skill from a portable markdown document (digest-verified). Returns
   * true on success; rejects malformed or tampered documents.
   */
  importSkill(markdown: string): Promise<boolean>;

  // --- Inference ---

  /**
   * Generate text. Returns JSON: `{"text":"..."}`.
   *
   * `intentJson` is an optional serialized {@link IntentHint} —
   * caller-facing routing hints (task, prefer_local, require). Omit to
   * preserve the existing adaptive vs. pinned-model behavior.
   */
  infer(
    prompt: string,
    model?: string | null,
    maxTokens?: number | null,
    intentJson?: string | null,
  ): Promise<string>;

  /**
   * Generate with full tracking. Returns JSON with `text`, `tool_calls`,
   * `usage`, `model_used`, `latency_ms`, `time_to_first_token_ms`,
   * `trace_id`, `stop_reason`. `time_to_first_token_ms` is wall-clock to
   * the first sampled token (populated by local Candle/MLX paths; `null`
   * for non-streaming remote calls). `stop_reason` is the raw provider
   * termination reason (OpenAI `finish_reason`, Anthropic `stop_reason`,
   * Google `finishReason`); `null` for local backends or providers that
   * don't report one. A value of `"length"`/`"max_tokens"`/`"MAX_TOKENS"`
   * means the output was truncated at the token cap. On local Qwen3
   * hybrid-thinking models it is also set to `"thinking_recovered"` when
   * reasoning consumed the whole token budget and the runtime retried
   * with reasoning suppressed to produce a direct answer, or
   * `"thinking_truncated"` when even that retry was empty (car-releases#60).
   *
   * `auth_fallback_from` is present ONLY when a candidate earlier in the
   * fallback chain was skipped because its credential was **rejected**
   * (not merely absent) and a later model then answered. It names that
   * dead lane, so a caller can tell the user their sign-in lapsed instead
   * of silently serving a different model (Parslee-ai/car#888). Absent on
   * the common path.
   *
   * **Note:** intent is not exposed on the tracked path until the
   * positional argument list is converted to an options object —
   * this method already takes 9 positional parameters and adding
   * intent would push call sites past readability. For new code,
   * use {@link inferTrackedWithRequest} which takes a JSON-
   * stringified `GenerateRequest` and exposes every field
   * including `intent`.
   *
   * `imagesJson` is a JSON-encoded array of `ContentBlock` image
   * variants — either
   * `{ "type": "image_base64", "data": "<b64>", "media_type": "image/png" }`
   * or `{ "type": "image_url", "url": "https://…", "detail": "auto" }`.
   * Vision-capable hosted models (Claude 3.5+/4.x, GPT-4o, Gemini)
   * accept these directly; non-vision providers reject the request
   * via a structured error from the daemon. See #230.
   */
  inferTracked(
    prompt: string,
    model?: string | null,
    maxTokens?: number | null,
    context?: string | null,
    toolsJson?: string | null,
    messagesJson?: string | null,
    toolChoice?: string | null,
    parallelToolCalls?: boolean | null,
    imagesJson?: string | null,
  ): Promise<string>;

  /**
   * Generate with full tracking, options-object form.
   * `requestJson` is a `JSON.stringify`d `GenerateRequest` (every
   * field optional except `prompt`). Exposes every field on the
   * Rust struct including `intent`. Same pattern as
   * {@link verifyProposal}. Closes #107.
   *
   * `client_ref` is an opaque correlation token echoed verbatim in the
   * `inference.runner.invoke` payload and otherwise ignored by CAR. A
   * delegated-inference host with several calls in flight uses it to map an
   * invoke back to its own request state — `call_id` is minted by the daemon
   * only after this call, so it cannot serve that purpose. Hosts previously
   * had to smuggle an id through `prompt`, which worked only because
   * delegated models ignore it (car-releases#78).
   */
  inferTrackedWithRequest(requestJson: string): Promise<string>;

  /**
   * Generate an image from a text prompt via the daemon's installed Flux/MLX
   * models. `requestJson` is a JSON-stringified `GenerateImageRequest`
   * (`{ prompt, model?, width?, height?, steps?, guidance?, seed?,
   * output_path?, ... }`). Returns `GenerateImageResult` JSON
   * (`{ image_path, model_used, latency_ms, ... }`). The FFI analogue of the
   * `image.generate` WS method (car-releases#70).
   */
  generateImage(requestJson: string): Promise<string>;

  /**
   * Generate a video from a text/image prompt via the daemon's installed
   * LTX/MLX models. `requestJson` is a JSON-stringified `GenerateVideoRequest`;
   * returns `GenerateVideoResult` JSON. FFI analogue of the `video.generate` WS
   * method (car-releases#70).
   */
  generateVideo(requestJson: string): Promise<string>;

  /**
   * Build a runnable workflow from a natural-language goal via the daemon's
   * builder. `requestJson` is `{ goal, existing?, max_attempts? }`; on the
   * daemon the catalog (registered tools + models) is authoritative, so the
   * tool cross-check fires. Returns
   * `{ valid, workflow, issues, warnings, attempts }` as JSON.
   */
  buildWorkflow(requestJson: string): Promise<string>;

  /**
   * Generate text grounded with memory context from this runtime's
   * memgine. `intentJson` works the same as on {@link infer}.
   */
  inferWithContext(
    prompt: string,
    model?: string | null,
    maxTokens?: number | null,
    intentJson?: string | null,
  ): Promise<string>;

  /** Embed texts. Returns JSON array of float arrays. */
  embed(texts: string[], model?: string | null): Promise<string>;

  /**
   * Rerank documents against a query using a cross-encoder reranker.
   * Returns JSON: `{ranked: [{index, score, document}, ...], model_used}`.
   */
  rerank(
    query: string,
    documents: string[],
    model?: string | null,
    topN?: number | null,
    instruction?: string | null,
  ): Promise<string>;

  /** Classify text against labels. Returns JSON array of `{label, score}`. */
  classify(text: string, labels: string[], model?: string | null): Promise<string>;

  /**
   * Encode `text` via the named local model's tokenizer. Returns a JSON
   * array of u32 token IDs, raw (no chat-template wrapping, no BOS).
   * Pair with `detokenize` for byte-identical round-trip. Remote models
   * are not supported — call rejects with an error there.
   */
  tokenize(model: string, text: string): Promise<string>;

  /**
   * Decode token IDs back to text via the named local model's tokenizer.
   * Inverse of `tokenize` for the round-trip property.
   */
  detokenize(model: string, tokens: number[]): Promise<string>;

  // --- Web search ---

  /**
   * Web search. The daemon resolves the backend: the signed-in Parslee
   * account's hosted search when available, else a bring-your-own
   * `TAVILY_API_KEY`. Returns JSON `{ query, source, results: [{title, url,
   * snippet, score, published_date}] }`.
   */
  search(query: string, maxResults?: number | null): Promise<string>;

  /**
   * Fetch a URL and extract readable text (keyless; companion to `search`).
   * Returns JSON `{ url, status, content_type, title?, text }`.
   */
  webFetch(url: string): Promise<string>;

  // --- Speech ---

  /**
   * Provision the managed speech runtime and return its root path — the same
   * root `speechHealth()` / `car speech doctor` report. The first call on a
   * fresh machine builds a Python venv and can take minutes; afterwards it is
   * a no-op. The returned path is not a success signal: on Apple Silicon the
   * runtime is a fallback behind the native MLX backends, so a bootstrap that
   * cannot run degrades instead of failing. Read
   * `speechHealth().runtime.installed` for the real state.
   */
  prepareSpeechRuntime(): Promise<string>;

  /** Transcribe a local audio file. Returns JSON `{text, model_used, language, ...}`. */
  transcribe(
    audioPath: string,
    model?: string | null,
    language?: string | null,
    prompt?: string | null,
    timestamps?: boolean | null,
  ): Promise<string>;

  /**
   * Synthesize speech to an output file. Returns JSON `{audio_path, media_type, ...}`.
   * `referenceAudioPath`, `referenceText`, `voiceInstruction` are Qwen3-TTS-specific
   * controls (voice cloning / voice design); other backends ignore them.
   */
  synthesize(
    text: string,
    model?: string | null,
    voice?: string | null,
    language?: string | null,
    speed?: number | null,
    outputPath?: string | null,
    format?: string | null,
    referenceAudioPath?: string | null,
    referenceText?: string | null,
    voiceInstruction?: string | null,
  ): Promise<string>;

  // --- Models ---

  /** Local + built-in models. Returns JSON array. */
  listModels(): string;

  /** Download a model. Returns its local path. */
  pullModel(name: string): Promise<string>;

  /** Remove only a receipt-backed CAR-managed artifact. Returns result JSON. */
  removeModel(modelId: string): Promise<string>;

  /** Adopt an already-usable local artifact into CAR ownership. */
  adoptModel(modelId: string): Promise<string>;

  /** Read the saved local-model resource policy and evaluated budget. */
  modelResourcePolicyGet(): Promise<string>;

  /** Persist an exact resource-policy JSON object. */
  modelResourcePolicySet(policyJson: string): Promise<string>;

  /** Evaluate one local model without downloading or loading it. */
  modelPreflight(modelId: string, contextTokens?: number): Promise<string>;

  /**
   * Unified registry (local + remote). Returns JSON array of
   * `{ id, name, provider, capabilities, param_count, size_mb,
   *   context_length, available, is_local, operator_managed_external_runtime,
   *   weights_ready, downloads_weights,
   *   max_output_tokens, public_benchmarks, cost, car_enabled, can_remove,
   *   in_use, management_evidence }`. `available` means CAR
   * can use the model
   * here — for a local MLX entry with a declared `hf_repo` it is `true`
   * before a byte is fetched, because it lazy-downloads on first use —
   * whereas `weights_ready` means the weights are already on disk (remote
   * models, having none to install, report `true`). Older daemons omit
   * `weights_ready`; it defaults to `false` rather than failing.
   * `downloads_weights` is `true` only for entries whose weights CAR fetches
   * before use (GGUF, MLX, whisper.cpp, and CAR-owned managed vLLM-MLX).
   * When it is `false` — OS-provided models such as
   * `windows/speech-synthesis:os` and `apple/foundation:default`,
   * operator-managed servers such as raw vLLM-MLX and Ollama, and every
   * remote entry — there is nothing to
   * install, so `weights_ready` is meaningless and the CLI renders
   * `INSTALLED` as `-`. Do not substitute `is_local`: OS-provided models are
   * local but download nothing. A raw external vLLM-MLX row instead
   * sets `operator_managed_external_runtime=true` and is not local, even for
   * a loopback endpoint; only CAR-owned managed vLLM-MLX is charged and
   * supervised as local. Older daemons omit
   * `downloads_weights`; it defaults to `false` rather than failing.
   * `max_output_tokens` is the registry-declared
   *   per-model output ceiling (`null` when the entry omits it; callers
   *   then fall back to a fraction of `context_length`).
   * `public_benchmarks` is `[{ name, score, harness?, source_url?,
   * measured_at? }]` with score on a 0.0–1.0 scale; ships empty in
   * the built-in catalog and is populated via curated registry data.
   * `cost` is the model's declared prices — `{ input_per_mtok,
   * output_per_mtok, cache_read_input_per_mtok, cache_write_input_per_mtok,
   * pricing_tiers, size_mb, ram_mb }` — in USD per 1M tokens, with
   * `pricing_tiers` as `[{ min_prompt_tokens, ...prices }]` prompt-size
   * overrides (highest threshold not above the prompt wins). Every price is
   * nullable and `null` means **unpriced, not free**: a local model declares
   * no prices, and a caller that reads that as `0` publishes a fabricated
   * cost. The managed `parslee/…` alias rows carry the same prices as the
   * upstream row they front, and this response carries no upstream
   * identifier for them. That holds for this catalog view; `models.search`
   * additionally exposes a `family` field which does name the upstream
   * model family. Older daemons omit
   * `cost` entirely; it deserializes to all-`null` rather than failing.
   */
  listModelsUnified(): string;

  /**
   * Register a `ModelSchema` via the daemon's `models.register`
   * JSON-RPC method (Parslee-ai/car-releases#39). The schema is
   * persisted to `~/.car/models.json` (replacing any existing
   * entry with the same `id`).
   *
   * **Visibility limitation**: the model becomes visible to
   * `infer` / `models.list` / `models.list_unified` on the **next
   * daemon boot**. Live hot-update inside a running daemon is
   * tracked as a separate follow-up that requires interior
   * mutability on the `UnifiedRegistry`. Register before
   * starting the daemon's inference path, or restart the daemon
   * after a batch of registrations.
   *
   * Returns JSON `{id, registered, path, note}`.
   */
  registerModel(schemaJson: string): Promise<string>;

  /**
   * `assistant.identity.get` — the name the flagship assistant answers to.
   *
   * Returns `{ name, spellings, aliases, user_name, brand, updated_at_unix }`.
   * `aliases` is the derived match set (name and spellings crossed with
   * "hey"/"ok"/…), longest first — hosts match wake phrases against it locally
   * so their matcher works before the daemon answers.
   *
   * `brand` is the fixed product name and never changes; `name` is what this
   * user calls the assistant. Both travel together: store copy uses the brand,
   * addressing copy uses the name.
   *
   * Ungated — a name is not a credential. A malformed `identity.json` rejects
   * rather than silently answering with the default name.
   */
  assistantIdentityGet(): Promise<string>;

  /**
   * `assistant.identity.set` — name the assistant. Host/local-auth gated on the
   * daemon, because a rename repoints the voice wake word.
   *
   * `requestJson` is `{ name?, spellings?, user_name? }`. Every field is
   * optional and unset fields are preserved, so a caller that only knows about
   * the name cannot wipe spellings another surface wrote. Pass
   * `user_name: null` to clear it.
   *
   * Returns the updated identity JSON, in the same shape as
   * `assistantIdentityGet`.
   */
  assistantIdentitySet(requestJson: string): Promise<string>;

  /**
   * `messaging.config.get` — read the multi-channel approval-transport config
   * for one channel (enabled flag, allowlisted handles, whether a pairing is
   * in flight). Host/local-auth gated on the daemon.
   *
   * `requestJson` is an optional `{ channel? }` selector — `channel` is
   * `"imessage"` | `"slack"`, default `"imessage"`. Pass `"{}"` or omit it for
   * the iMessage (back-compat) channel.
   *
   * Returns `MessagingConfigView` JSON. The view always carries a `channel`
   * key naming which channel it describes (`"imessage"` | `"slack"`).
   */
  messagingConfigGet(requestJson?: string): Promise<string>;

  /**
   * `messaging.config.set` — mutate one channel's approval-transport config.
   * The ONLY allowlist/config-mutation path; host/local-auth gated.
   * `requestJson` is a `MessagingConfigSetRequest`
   * (`{ channel?, enabled?, allowlisted_handles?, add_handles?, remove_handles?,
   * bot_token?, app_token? }`).
   * `channel` is `"imessage"` | `"slack"`, default `"imessage"` when absent
   * (back-compat). For `channel: "slack"`, supplying BOTH `bot_token` (`xoxb-`)
   * and `app_token` (`xapp-`) provisions them into the OS keychain (MC-9) and
   * persists only a keychain reference into the config — the bearer values are
   * never stored on disk nor echoed back.
   * Returns the updated `MessagingConfigView` JSON (with its `channel` key).
   */
  messagingConfigSet(requestJson: string): Promise<string>;

  /**
   * `messaging.pairing.start` — mint a fresh high-entropy pairing code for one
   * channel to display ONLY in the local UI; the paired device sends it back
   * to bind its handle. Host/local-auth gated.
   *
   * `requestJson` is an optional `{ channel? }` selector (`"imessage"` |
   * `"slack"`, default `"imessage"`). Returns `MessagingPairingStartResponse`
   * JSON (`{ pairing_code, config }`).
   */
  messagingPairingStart(requestJson?: string): Promise<string>;

  /**
   * `messaging.pairing.status` — whether a pairing is in flight on one channel
   * and (host gated) the active code. `requestJson` is an optional
   * `{ channel? }` selector (`"imessage"` | `"slack"`, default `"imessage"`).
   * Returns `MessagingPairingStatusResponse` JSON.
   */
  messagingPairingStatus(requestJson?: string): Promise<string>;

  /**
   * `messaging.status` — the real runtime liveness of one channel's approval
   * transport, computed daemon-side so a host UI can render a SINGLE readiness
   * state (enabled · watcher running · FDA · paired) plus last-delivered +
   * last-error. Host/local-auth gated. `requestJson` is an optional
   * `{ channel? }` selector (`"imessage"` | `"slack"`, default `"imessage"`).
   * Returns `MessagingStatusView` JSON.
   */
  messagingStatus(requestJson?: string): Promise<string>;

  /**
   * `messaging.test_send` — send a fixed, clearly-labeled self-test message to
   * one channel's paired handle and return `{ ok, error }` synchronously. A
   * pure send probe: it mints NO approval/pairing mapping and resolves nothing.
   * Host/local-auth gated. `requestJson` is an optional `{ channel? }` selector
   * (`"imessage"` | `"slack"`, default `"imessage"`). Returns
   * `MessagingTestSendResponse` JSON.
   */
  messagingTestSend(requestJson?: string): Promise<string>;

  /**
   * Recommend models for this machine + intent. `useCase`/`tier` are
   * snake_case enum values (e.g. "coding", "most_capable"); `cloudOk` lets
   * cloud models compete. Returns the `RecommendationSet` JSON
   * (`{ picks, notEnoughMemory, note }`).
   */
  recommend(useCase: string, tier: string, cloudOk: boolean): Promise<string>;

  /**
   * Coder — built-in coding agent (`coder.*` daemon namespace). Sessions
   * live in the daemon and are visible in CarHost. Live `coder.event`
   * streaming is WebSocket-only: call `coder.subscribe` on the daemon's
   * WS directly (same contract as `infer_stream`).
   *
   * Start a session: provisions an isolated git worktree of `repo` and
   * derives a verifiable outcome contract from `intent`. `engine` is
   * `"auto" | "native" | "external[:agent_id]"` (default auto). Returns
   * `{session_id, state, engine, worktree, contract, model}` JSON, where
   * `model` is the effective native-loop pin (per-session `model`, else
   * `~/.car/coder.toml`, else `null` = adaptive routing).
   */
  coderStart(
    repo: string,
    intent: string,
    options?: CoderStartOptions | undefined | null,
  ): Promise<string>;

  /**
   * Confirm the proposed outcome contract (optionally replacing it with
   * the edited `contractJson`) and start the work loop.
   */
  coderConfirmContract(
    sessionId: string,
    contractJson?: string | undefined | null,
  ): Promise<string>;

  /** List coder sessions (live and persisted), newest first. */
  coderList(): Promise<string>;

  /** Full session detail, including contract and check results. */
  coderGet(sessionId: string): Promise<string>;

  /**
   * Answer a `user_input_requested` event (reserved — neither engine
   * requests mid-session input yet).
   */
  coderRespond(sessionId: string, text: string): Promise<string>;

  /**
   * Approve (publish the `car/coder/<id>` branch in the repo) or deny
   * (abandon) a session awaiting merge approval.
   */
  coderApproveMerge(sessionId: string, approve: boolean): Promise<string>;

  /**
   * Cancel a session: stop the loop, abandon, remove the worktree. Returns
   * `{state, already_terminal, message}`.
   *
   * An already-finished session **succeeds** rather than rejecting: `state`
   * keeps its pre-existing name and type, `already_terminal` is `true`, and
   * `message` names what already happened. Callers that cancel unconditionally
   * on shutdown depend on that — rejecting would turn a quiet exit into a
   * protocol error whenever the session raced to terminal first.
   */
  coderCancel(sessionId: string): Promise<string>;

  /**
   * The current session list AND registration for `coder.session_changed` on
   * this connection, atomically (registered under the same lock the list is
   * snapshotted under, so nothing slips through the gap). Notifications are
   * WebSocket-only, same contract as `coder.subscribe`.
   *
   * Each row carries the full summary: the pre-existing
   * `{session_id, state, intent, repo, engine, iterations, updated_at, live,
   * error}` plus `needs_you` (`"contract" | "question" | "approval" | "auth" |
   * null`), `needs_you_label` (the daemon-owned wording, so every client says
   * the same thing), `question_prompt`, `auth_message`, `auth_wait_secs`,
   * `failure_kind` (`"budget_exhausted" | "auth_required" | "infrastructure" |
   * "error"` when failed), `worktree` (only when it still exists on disk),
   * `project`, `result_branch`, `model`, `discussion_id`, and `next_seq` (live
   * only — the `coder.subscribe` cursor).
   *
   * Pass `renew: true` for the lease-renewal form: it re-registers and answers
   * `{ was_registered }` — `false` means this connection had been shed and
   * should take a full snapshot — and builds NO summaries, so it is cheap
   * enough to call on a timer. The default form is unchanged.
   */
  coderWatch(renew?: boolean | undefined | null): Promise<string>;

  /** Stop receiving `coder.session_changed` on this connection. */
  coderUnwatch(): Promise<string>;

  /**
   * Redraft a PROPOSED outcome contract from a plain-English request (e.g.
   * "also verify the Windows path"). Legal only in `contract_proposed`;
   * nothing executes and the session stays at the gate either way. Unlimited
   * rounds.
   *
   * Returns `{state, revised, contract, baseline, baseline_gates_nothing,
   * message}`. **Check `revised` before trusting `contract`**: on a redraft
   * that does not validate, the previous contract comes back byte-identical
   * with `revised: false` and a `message` explaining why, and the daemon emits
   * a `contract_revision_rejected` event.
   */
  coderReviseContract(sessionId: string, request: string): Promise<string>;

  /**
   * Open a repo-grounded, strictly **read-only** discussion — a thinking
   * surface for working out what a change should be, before a run exists.
   * Bound at `PermissionTier::ReadOnly` with every write/shell escalation
   * auto-denied, so it can never touch the repo. Returns
   * `{discussion_id, repo, repo_summary}`; a non-git path is a clear error.
   */
  coderDiscussStart(repo: string): Promise<string>;

  /**
   * Send one operator message. Returns `{ok, seq}` where `seq` is the first
   * event this turn emits; the reply streams as `coder.discuss.event`
   * (WebSocket-only, same contract as `coder.event`).
   */
  coderDiscussSend(discussionId: string, text: string): Promise<string>;

  /**
   * Distill the discussion into `{discussion_id, proposed_intent,
   * constraints}`. **Starts nothing** — no worktree, no branch, no session.
   * The caller shows `proposed_intent` (never the transcript) for the operator
   * to edit, then passes it to `coderStart` with `discussion_id` so the agreed
   * constraints reach contract derivation. Callable repeatedly.
   */
  coderDiscussPromote(discussionId: string): Promise<string>;

  /** Free an in-memory discussion. Discussions do not survive a daemon restart. */
  coderDiscussClose(discussionId: string): Promise<string>;

  /**
   * Open discussions: `{discussions: [{discussion_id, repo, created_at,
   * turns}]}`. Also the capability probe — a daemon predating this surface
   * answers JSON-RPC `-32601`.
   */
  coderDiscussList(): Promise<string>;

  /**
   * Managed projects + in-daemon declarative agents (the non-developer path).
   *
   * Create (or load) a CAR-managed git-backed project under
   * `~/.car/projects/`. `kind` is `"app"` (code) or `"agent"` (an in-daemon
   * declarative agent). Returns the `CoderProject` JSON.
   */
  projectCreate(name: string, kind?: string | undefined | null): Promise<string>;
  /** List managed projects, newest first. */
  projectList(): Promise<string>;
  /** One project's metadata by slug. */
  projectGet(slug: string): Promise<string>;

  /**
   * Discover what the signed-in Parslee account can do — identity, m365
   * product entitlements, and Studio reachability. Read-only. Returns JSON.
   */
  parsleeCapabilities(): Promise<string>;
  /**
   * Generate a Word document from a natural-language brief, saved to the
   * user's connected drive. Gated on the `aie` entitlement. `documentType`
   * defaults to `Report`. Returns JSON `{ file_id, web_url, ... }`.
   */
  parsleeM365GenerateDocument(contentBrief: string, outputFilePath: string, documentType?: string | undefined | null, title?: string | undefined | null, author?: string | undefined | null): Promise<string>;

  /** List registered in-daemon declarative agents. */
  declagentList(): Promise<string>;
  /** One declarative agent's spec by id. */
  declagentGet(id: string): Promise<string>;
  /** Unregister a declarative agent. */
  declagentRemove(id: string): Promise<string>;
  /** Enable or disable a declarative agent. */
  declagentSetEnabled(id: string, enabled: boolean): Promise<string>;
  /**
   * Run a declarative agent on an input, in-daemon (no external process).
   * Returns `{ output, turns, tool_calls, error? }` JSON.
   */
  declagentInvoke(id: string, input: string): Promise<string>;
  /**
   * Route a need to the best-matching declarative agent by capability
   * similarity. Returns `{ chosen, candidates, next_visited, invoked, result? }`
   * JSON. With `invoke: true`, the top agent is run on `need` and its result is
   * included. Network-entry case only; multi-hop Forward chaining (`from` /
   * `visited`) is WS-only.
   */
  declagentRoute(need: string, invoke: boolean): Promise<string>;
  /**
   * Split a composite need into subtasks and route each to its best-matching
   * agent. Returns `{ subtasks: [{ subtask, chosen, score, result? }], count,
   * invoked }` JSON. `maxSubtasks` caps the split (clamped to [1, 10]; null =
   * default 5). With `invoke: true`, each subtask's chosen agent runs.
   */
  declagentRouteSplit(
    need: string,
    invoke: boolean,
    maxSubtasks?: number | undefined | null,
    decompositionMode?: "vanilla" | "sad" | string | undefined | null,
    sadHints?: number | undefined | null,
    sadIterations?: number | undefined | null,
    sadConvergenceJaccard?: number | undefined | null
  ): Promise<string>;
  /**
   * Read-only view of the learned routing topology: per-agent success stats
   * and directed agent→agent edge weights. Returns `{ agents, edges }` JSON.
   */
  declagentRoutingStats(): Promise<string>;
  /**
   * AgentDNS-style discovery: resolve a natural-language need into ranked
   * CAR-local services, each named under `agentdns://org/category/name`.
   * Providers: declarative agents, observe-only registry services
   * (`~/.car/registry/`, kind `registry`), MCP connector tools, external
   * CLIs, A2A peers, and an opt-in remote root. Returns `{ services: [{
   * identifier, name, kind, protocol, score, similarity }], count }` JSON.
   * `limit` caps results (clamped to [1, 50]; null = default 5).
   */
  discoveryResolve(need: string, limit?: number | undefined | null): Promise<string>;
  /**
   * Record a discovery-routed run's outcome (`"success"` | `"failure"`) into
   * the routing learning store, keyed by the service's `agentdns://`
   * identifier — for EVERY provider kind (connector, registry, external, a2a,
   * declarative). This is the feedback loop `discoveryResolve`'s success
   * prior learns from. Returns `{ identifier, outcome, successes, failures }`
   * JSON.
   */
  discoveryReport(identifier: string, outcome: "success" | "failure" | string): Promise<string>;
  /**
   * Compose a decompose/retrieve/plan route over all discoverable services.
   * Returns `{ plan, decomposition, candidates, metadata }` JSON. Planning only;
   * callers invoke returned targets through existing governed surfaces.
   */
  discoveryRouteCompose(
    need: string,
    maxSubtasks?: number | undefined | null,
    decompositionMode?: "vanilla" | "sad" | string | undefined | null,
    sadHints?: number | undefined | null,
    sadIterations?: number | undefined | null,
    sadConvergenceJaccard?: number | undefined | null,
    candidatesPerStep?: number | undefined | null,
    rerank?: boolean
  ): Promise<string>;

  /**
   * Build a concrete onboarding plan (machine summary, top pick, alternatives,
   * needs-more-memory, note) as JSON.
   */
  setupPlan(useCase: string, tier: string, cloudOk: boolean): Promise<string>;

  /** Detect upgrades (curated + upstream, channel-gated). Returns JSON. */
  detectUpgrades(): Promise<string>;

  /** Current proactive-upgrade decision (poll form). Returns JSON. */
  checkUpgradeNudge(inferenceActive: boolean): Promise<string>;

  /** Dismiss an upgrade nudge by its `dismissKey` so it never re-fires. */
  dismissUpgrade(dismissKey: string): Promise<string>;

  /** Get update preferences as JSON. */
  updatePrefsGet(): Promise<string>;

  /** Set update preferences (JSON `UpdatePreferences` shape). Returns stored prefs JSON. */
  updatePrefsSet(prefsJson: string): Promise<string>;

  /**
   * Route a prompt. Returns the routing decision as JSON, including
   * `candidates`: the advisory ranking of every scored model
   * (`{ model_id, reliability, score, selected, in_band }`) so callers can see
   * why a model won and what the alternatives cost in reliability terms. Empty
   * on explicit-model and cold-start paths where no ranking occurred.
   */
  routeModel(prompt: string, intentJson?: string | null): Promise<string>;

  /** Per-model performance profiles. Returns JSON. */
  modelStats(): Promise<string>;

  /**
   * Persistent outcome scoreboard, folded from the durable outcome ledger.
   * Returns JSON `{ rows: [{ model_id, success_count, fail_count,
   * inconclusive_count, total_input_tokens, total_output_tokens, avg_quality,
   * avg_latency_ms, success_rate, tokens_per_success, usd_per_success }],
   * total_successes, total_failures, total_inconclusive, total_usd,
   * overall_usd_per_success, model_count, receipts }`. Rows are sorted
   * cheapest-correct-outcome first. The cross-session, outcome-denominated view
   * (unlike `modelStats`, the live in-memory profiles).
   */
  outcomeScoreboard(): Promise<string>;

  // --- Execution ---

  /** Count of events in this runtime's execution log. */
  eventCount(): Promise<number>;

  /** Drain buffered chunks + current status for a detached
   * (streaming/long-running) tool invocation (C2). `handle` is the
   * `tool_handle` a detached ToolCall action (`invocation_mode: "streaming"
   * | "long_running"`) returned as its output. Returns the ToolPollResult
   * JSON string `{handle, tool, action_id, status, chunks, result?,
   * error?}`, or `null` for an unknown / already fully-consumed handle. */
  toolPoll(handle: string): Promise<string | null>;

  /** Request cooperative cancellation of a detached (streaming/long-running)
   * tool invocation (C2). Resolves `true` when the handle was known (the
   * invocation is sealed `cancelled` unless already terminal), `false` for
   * an unknown handle. */
  toolCancel(handle: string): Promise<boolean>;

  /** Structured audit query over the event log (G2). `queryJson` is an
   * EventQuery object (kinds/actionId/proposalId/since/until/dataMatches/limit);
   * returns `{count, events}` as a JSON string, most-recent-first. */
  eventQuery(queryJson: string): Promise<string>;

  /** Get/set the event-log retention policy (G2). Pass a
   * `{maxEvents, maxAgeSecs}` JSON string to install it, or omit to read the
   * current policy. Returns a JSON string. */
  eventRetention(policyJson?: string): Promise<string>;

  /** Per-agent token/cost report (G3), folded from metered inference events.
   * Returns a JSON array of `{agent, calls, tokensIn, tokensOut, costUsd}`. */
  eventCostByAgent(): Promise<string>;

  /** Turn on tamper-evident hash chaining for the session event log (A9).
   * Every event appended from now on links to its predecessor by a content
   * hash. Idempotent. */
  enableEventLogHashChaining(): Promise<void>;

  /** Verify the session event log's tamper-evidence chain (A9). Returns
   * `{"verified": n}` (chained events verified) or `{"tampered_at": i}`
   * (index of the first interior edit/deletion/reorder) as a JSON string.
   * Head/tail truncation is not detectable (no anchored head hash). */
  verifyEventLogChain(): Promise<string>;

  /** Live operational metrics rollup (G1) — success/error rate, cost, latency,
   * approvals, gate rejections, per-agent cost. `cost_usd` is the fold over the
   * retained window; `cumulative_cost_usd` is the monotonic lifetime spend
   * (survives retention trims). Returns JSON. */
  metricsSummary(): Promise<string>;

  /** Evaluate live metrics against thresholds (G1). `thresholdsJson` is an
   * AlertThresholds object (omit for defaults); returns `{summary, alerts}` as
   * JSON. The `max_cost_usd` budget is checked against the monotonic
   * `cumulative_cost_usd` counter, so a retention trim never un-fires the
   * `cost_overage` alert. */
  metricsAlerts(thresholdsJson?: string): Promise<string>;

  /** Execution log counts and approximate retained native bytes. Returns JSON. */
  eventLogStats(): Promise<string>;

  /** Keep only the newest events/spans in this runtime's execution log. Returns JSON. */
  truncateEventLog(maxEvents?: number | null, maxSpans?: number | null): Promise<string>;

  /** Clear this runtime's execution log. Returns JSON. */
  clearEventLog(): Promise<string>;

  /** Verify a proposal against this runtime's state + tools. Returns JSON. */
  verifyProposal(proposalJson: string): Promise<string>;

  /**
   * Submit a proposal for daemon-side execution using the
   * persistent `tools.execute` handler set by
   * `registerToolHandler` (Parslee-ai/car-releases#38).
   *
   * Symmetric to `executeProposal` but without the per-call
   * handler argument — the handler is process-wide. Fails up
   * front if no handler is registered.
   *
   * `sessionId`, when provided, scopes per-action policy
   * validation to a session opened via the daemon's
   * `session.policy.open` JSON-RPC method.
   *
   * Returns the JSON-encoded execution result.
   */
  submitProposal(
    proposalJson: string,
    sessionId?: string | null,
  ): Promise<string>;

  // --- Browser automation ---

  /**
   * Run a JSON script of browser operations against a persistent Chromium
   * session attached to this runtime instance. First call lazily launches
   * Chromium (requires a local Chrome/Chromium binary); subsequent calls
   * reuse the same session so element IDs from `observe` resolve across
   * invocations.
   *
   * Script shape: `{operations: [{op:"navigate",url:"..."}, {op:"observe"}, ...]}`
   * Supported ops: navigate, observe, click, type, scroll, keypress, wait.
   * Returns JSON: `{steps:[{op,status,data,error,duration_ms}]}`. Execution
   * short-circuits on first error.
   *
   * `headed`: when `true`, launches a visible Chromium window
   * instead of headless mode — for interactive flows like
   * first-time auth (LinkedIn / OAuth / SSO / 2FA / captcha).
   * Honoured only on the *first* call that launches the session;
   * subsequent calls reuse the existing browser regardless. To
   * switch modes, call `browserClose()` first.
   *
   * `extraArgs`: extra Chromium command-line flags appended
   * verbatim to argv at launch (#112). Use cases: the Google
   * Meet bot needing `--use-fake-ui-for-media-stream`,
   * `--autoplay-policy=no-user-gesture-required`, and the
   * container-friendly `--no-sandbox` /
   * `--disable-dev-shm-usage` / `--disable-setuid-sandbox`. Like
   * `headed`, honoured only on the launch call.
   */
  browserRun(
    scriptJson: string,
    width?: number | null,
    height?: number | null,
    headed?: boolean | null,
    extraArgs?: string[] | null,
  ): Promise<string>;

  /** Close any persistent browser session attached to this runtime. */
  browserClose(): Promise<void>;

  // `browserRun`/`browserClose` above are this runtime's OWN
  // per-connection scripted browser. Separate from that: the browser
  // DRAWER surface (`browser.view.*` / `browser.producer.*` /
  // `agent.browser.*`), which watches and drives the ASSISTANT's
  // browser (or the shared standing session) for a human at the
  // Command Deck. It is WS-only — no method here — the same decision
  // as `runs.subscribe` / `coder.subscribe`: `browser.view.*` requires
  // the host-management client (`session.auth { host_token }`, stricter
  // than `runs.subscribe`), so CarHost speaks it directly over the
  // daemon's WS. `browser.producer.*` / `agent.browser.*` is the agent
  // side of the same relay; today its only producer is the Rust
  // `car-cli` binary, so it likewise has no binding here. Full wire
  // contract: `docs/websocket-protocol.md` (`### browser`) and
  // `docs/host-protocol.md` (`Live browser view`).

  /**
   * Register a tool with a full JSON-serialized `ToolSchema`.
   * `verifyProposal` validates `Action.parameters` against the schema's
   * `parameters` field — catching type mismatches like `{path: 42}` for a
   * tool wanting `{path: string}` before dispatch. The schema also carries
   * idempotency, cache TTL, and rate-limit hints that the engine wires up
   * automatically.
   *
   * Tools registered via the schemaless `registerTool(name)` bypass type
   * validation; this is the opt-in upgrade path.
   *
   * `schemaJson` matches:
   * ```json
   * {
   *   "name": "read_file",
   *   "description": "...",
   *   "parameters": {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},
   *   "returns": null,
   *   "idempotent": true,
   *   "cache_ttl_secs": 60,
   *   "rate_limit": {"max_calls": 100, "interval_secs": 60}
   * }
   * ```
   */
  registerToolSchema(schemaJson: string): Promise<void>;

  // -------------------------------------------------------------------------
  // OS-native secret store (Keychain / Credential Manager / Secret Service)
  // -------------------------------------------------------------------------

  /** Returns JSON `{available: boolean, reason?: string}`. */
  secretAvailable(): string;

  /**
   * Store a secret. Returns JSON `{ok: true}` on success. Throws if the
   * backend is unavailable. `service` defaults to the runtime-wide bundle id.
   */
  secretPut(key: string, value: string, service?: string | null): string;

  /**
   * Retrieve a secret. Returns JSON `{value: string}`. Throws `not_found`
   * if the secret does not exist.
   */
  secretGet(key: string, service?: string | null): string;

  /** Delete a secret (idempotent). Returns JSON `{ok: true}`. */
  secretDelete(key: string, service?: string | null): string;

  /** Returns JSON `{exists: boolean, key, service}` without exposing the value. */
  secretStatus(key: string, service?: string | null): string;

  /**
   * List the NAMES of secrets stored through this surface. Returns JSON
   * `{secrets: [{service, key, exists}]}` — never the values. Backed by the
   * `~/.car/secret_index.json` name index, joined with a live existence check
   * (`exists` is `null` if the backend couldn't be probed).
   */
  secretList(): string;

  // -------------------------------------------------------------------------
  // OS permission preflight
  // -------------------------------------------------------------------------

  /** Returns JSON `{domains: [...]}` listing every permission domain CAR knows. */
  permissionDomains(): string;

  /**
   * Returns JSON `{ domain, status, target_bundle_id }`. `status` is one of
   * `granted` | `denied` | `not_determined` | `restricted` | `not_applicable` |
   * `restart_required` | `signature_changed` | `unknown`. The `calendar` domain
   * additionally reports a real, non-prompting EventKit query and can return
   * `write_only` (macOS-14 write-only calendar grant).
   */
  permissionStatus(domain: string, targetBundleId?: string | null): string;

  /** Triggers the OS permission prompt; returns the resulting status. */
  permissionRequest(domain: string, targetBundleId?: string | null): string;

  /** Returns JSON describing what the permission unlocks and how to revoke it. */
  permissionExplain(domain: string, targetBundleId?: string | null): string;

  // -------------------------------------------------------------------------
  // Native account discovery (system Settings → Internet Accounts on macOS)
  // -------------------------------------------------------------------------

  /** Returns JSON array of accounts known to the OS. */
  accountsList(): string;

  /** Open the OS's native account-management UI for an account or the root pane. */
  accountsOpen(accountId?: string | null): string;

  // -------------------------------------------------------------------------
  // Calendar / Contacts / Mail / Messages integrations (delegated to OS providers)
  // -------------------------------------------------------------------------

  /** Returns JSON array of calendars discovered through the OS provider. */
  calendarList(): string;

  /**
   * Returns JSON for events in the [start, end] window. Times are RFC3339;
   * `calendarIdsCsv` is an optional comma-separated filter.
   *
   * Each event carries `status` (`confirmed`|`tentative`|`canceled`|`none`,
   * from `EKEvent.status`) and `attendees` as objects (not bare names):
   * `{ name?, email?, status?, role?, is_current_user }` where `status` is
   * `accepted`|`declined`|`tentative`|`pending`|… (`EKParticipant.participantStatus`)
   * and `role` is `required`|`optional`|`chair`|`non_participant`|`unknown` — so a
   * consumer can tell a firm commitment from a tentative RSVP.
   */
  calendarEvents(
    startRfc3339: string,
    endRfc3339: string,
    calendarIdsCsv?: string | null,
  ): string;

  /**
   * Create a calendar event. `inputJson` is JSON-encoded
   * `{ calendar_id, title, start, end, all_day?, notes?, location?, url? }`
   * with RFC3339 timestamps. Returns JSON-encoded EventMutationResult; its
   * embedded `event` carries the same enriched shape as `calendarEvents`
   * (attendee objects with RSVP status + event `status`).
   */
  calendarCreateEvent(inputJson: string): string;

  /**
   * Update an existing event. `inputJson` is JSON-encoded
   * `{ event_id, title?, start?, end?, all_day?, notes?, location?, url? }`.
   * Absent fields leave existing values; empty string for
   * notes/location/url clears that field. Returns JSON-encoded
   * EventMutationResult.
   */
  calendarUpdateEvent(inputJson: string): string;

  /** Delete an event by host-assigned id. Returns JSON-encoded EventMutationResult. */
  calendarDeleteEvent(eventId: string): string;

  /** Returns JSON array of contact containers (sources). */
  contactsContainers(): string;

  /** Returns JSON array of contacts matching `query`. */
  contactsFind(
    query: string,
    limit?: number | null,
    containerIdsCsv?: string | null,
  ): string;

  /** Returns JSON array of mail accounts known to the OS provider. */
  mailAccounts(): string;

  /**
   * Returns JSON inbox snapshot
   * `{ available, backend, reason?, summaries: InboxSummary[] }` — per-account
   * unread/total counts, not message rows. Use `mailMessages` for rows.
   * `accountIdsCsv` is an optional comma-separated filter; omit to query all
   * known accounts.
   */
  mailInbox(accountIdsCsv?: string | null): string;

  /**
   * Enumerate every mailbox (folder) of the given accounts, nested ones
   * included on BOTH backends. Returns
   * `{ available, backend, reason?, mailboxes: Mailbox[] }` where `Mailbox`
   * is `{ account_id, name, full_name, unread, total }`.
   *
   * `full_name` is the selector to pass back as `MessageQuery.mailbox` — the
   * slash-joined path on macOS, the folder id on Microsoft Graph. Graph's
   * `/me/mailFolders` is root-only, so nested folders come from a bounded
   * `childFolders` walk (depth 8, at most 64 requests); a tree deeper or
   * wider than that is truncated.
   *
   * An `accountIdsCsv` that matches no account returns `available: false`
   * with a reason, not an empty list.
   */
  mailMailboxes(accountIdsCsv?: string | null): string;

  /**
   * Read message rows, newest first. `queryJson` is a `MessageQuery`:
   * `{account_ids?: string[], mailbox?: string | null, limit?: number,
   * since?: string, include_body?: boolean}`. Every field defaults, and
   * `mailbox: null` means INBOX — so `"{}"` reproduces the pre-existing
   * INBOX-only read.
   *
   * "Newest first" is GLOBAL, not per account: rows from every matched
   * account are merged into one date-ordered list before `limit` applies, so
   * `limit: 1` across two accounts returns the newer message rather than
   * whichever account the backend listed first.
   *
   * Returns `{ available, backend, reason?, messages: MessageSummary[] }`;
   * each row carries a stable opaque `id` accepted by `mailMessageBody`, and
   * a `mailbox` holding the mailbox as the backend RESOLVED it (a query for
   * `"travel"` comes back stamped `"Travel/2026"`), so rows match
   * `mailMailboxes` output. An unresolvable mailbox or an unmatched
   * `account_ids` returns `available: false` with a reason, never an empty
   * list.
   */
  mailMessages(queryJson: string): string;

  /**
   * Fetch one message body by the `id` from a `mailMessages` row. Returns
   * `{ available, backend, reason?, id, content_type, body, truncated }`;
   * bodies are cut at 100,000 characters with `truncated: true`.
   */
  mailMessageBody(messageId: string): string;

  /**
   * Send mail. `sendRequestJson` is `{to, subject, body, ...}` per the
   * provider contract. Returns JSON `{ok, message_id?}`.
   */
  mailSend(sendRequestJson: string): string;

  /** Returns JSON array of Messages.app services/accounts. */
  messagesServices(): string;

  /** Returns JSON array of recent Messages.app chats. */
  messagesChats(limit?: number | null): string;

  /**
   * Send a message through Messages.app. `sendRequestJson` is
   * `{recipient, body, service_id?}`.
   */
  messagesSend(sendRequestJson: string): string;

  /** Returns JSON array of Notes.app accounts. */
  notesAccounts(): string;

  /** Search Notes.app notes. */
  notesFind(query: string, limit?: number | null): string;

  /** Returns JSON array of Reminders.app lists. */
  remindersLists(): string;

  /** Returns JSON array of incomplete reminders. */
  remindersItems(limit?: number | null): string;

  /** Returns JSON array of Photos.app albums. */
  photosAlbums(): string;

  /** Returns JSON array of Safari bookmarks. */
  bookmarksList(limit?: number | null): string;

  /** Returns JSON standard account-backed file locations. */
  filesLocations(): string;

  /** Returns JSON OS keychain availability. */
  keychainStatus(): string;

  // -------------------------------------------------------------------------
  // Wearable / activity (HealthKit + Fitbit/Garmin/Oura/etc.)
  // -------------------------------------------------------------------------

  /** Returns JSON `{available, reason?, providers?}`. */
  healthStatus(): string;

  /** Times are RFC3339. Returns JSON array of sleep sessions. */
  healthSleep(startRfc3339: string, endRfc3339: string): string;

  /** Times are RFC3339. Returns JSON array of workouts. */
  healthWorkouts(startRfc3339: string, endRfc3339: string): string;

  /** Dates are YYYY-MM-DD. Returns JSON array of daily activity summaries. */
  healthActivity(startYmd: string, endYmd: string): string;
}

// ---------------------------------------------------------------------------
// Standalone functions
// ---------------------------------------------------------------------------

/**
 * Execute a proposal through a CarRuntime with a JS tool callback.
 * The callback receives
 * `{"tool":"name","params":{...},"action_id":"<id>","request_id":"<id>","timeout_ms":<ms|null>,"session_id":"<id>|null","attempt":<n>}`
 *
 * `attempt` is the engine's retry counter, 1-based — which retry you are
 * serving. (Correlate a specific in-flight call by `request_id` instead.) It
 * was hardcoded to 1 on the wire and dropped here before car#928.
 *
 * `session_id` is the daemon-stamped execution session (car#904) — the
 * attribution key for which mission a callback belongs to. Null when the
 * caller has no session. Prefer it over reconstructing attribution from
 * `action_id`, which is client-authored and not unique across concurrent or
 * retried attempts.
 * as a JSON string and must return a JSON string. `action_id` is the
 * originating `Action.id` from the proposal — useful for routing
 * when the same callback closes over multiple in-flight calls.
 * `request_id` is the daemon's callback-routing id, which a
 * `tools.cancel` notification repeats so the host can abort the right
 * in-flight call. `timeout_ms` is the action's declared budget in
 * milliseconds when the action declared one (`null` otherwise); the
 * host's tool runner may use it to bound its own work.
 *
 * `sessionId`, when provided, scopes per-action policy validation to
 * the named session opened via `CarRuntime.openSession()`. Global
 * policies still apply, plus the session's. Without a session id the
 * behavior matches the no-scope path bit-for-bit. See
 * `docs/proposals/per-session-policy-scoping.md`.
 *
 * `scopeJson`, when provided, is a serialized `RuntimeScope` —
 * `{ callerId?: string, tenantId?: string, claims?: Record<string, any> }`
 * — attaching per-execution caller / tenant identity. When `tenantId`
 * is set, the runtime routes per-action state R/W through the
 * tenant-scoped view so distinct tenants can't observe each other's
 * keys (Parslee-ai/car#187 phase 3). Single-tenant in-process callers
 * pass `null` / omit and see no behaviour change.
 */
export function executeProposal(
  rt: CarRuntime,
  proposalJson: string,
  toolFn: (callJson: string) => Promise<string>,
  sessionId?: string | null,
  scopeJson?: string | null,
): Promise<string>;

/**
 * @deprecated Unsupported ABI-compatibility stub. This function always
 * rejects and never calls `onEvent`. Connect to `car-server` directly and use
 * the `infer_stream` JSON-RPC method plus `inference.stream.event`
 * notifications. See `docs/websocket-protocol.md`.
 */
export function inferStream(
  rt: CarRuntime,
  requestJson: string,
  onEvent: (eventJson: string) => void,
): Promise<never>;

// --- Caller-facing routing intent (parslee-ai/car-releases#18) ---

/**
 * Coarse-grained task hint the adaptive router maps to its internal
 * `InferenceTask`. A closed set so adding a new task type is a
 * deliberate, FFI-visible change rather than a silent fallback.
 */
export type TaskHint =
  | 'chat'
  | 'classify'
  | 'summarize'
  | 'reasoning'
  | 'code'
  | 'extract';

/**
 * Hard model-capability filters the router enforces in addition to
 * any prompt-derived requirements. Mirrors `ModelCapability` in the
 * registry; values must be one of these snake_case strings.
 */
export type ModelCapabilityRequirement =
  | 'generate'
  | 'embed'
  | 'rerank'
  | 'classify'
  | 'code'
  | 'reasoning'
  | 'summarize'
  | 'tool_use'
  | 'multi_tool_call'
  | 'vision'
  | 'video_understanding'
  | 'audio_understanding'
  | 'grounding'
  | 'speech_to_text'
  | 'text_to_speech'
  | 'image_generation'
  | 'video_generation';

/**
 * Caller-facing routing intent — express requirements, not model IDs.
 *
 * All fields are optional. An IntentHint with no fields set is
 * equivalent to omitting the hint entirely (adaptive routing as today).
 *
 * @example
 *   await rt.infer(
 *     prompt,
 *     null,
 *     null,
 *     JSON.stringify({ task: 'chat', prefer_local: true } satisfies IntentHint),
 *   );
 */
export interface IntentHint {
  /** What the caller is doing. Maps to `InferenceTask` server-side. */
  task?: TaskHint;
  /**
   * Hard filter — every required capability must be present on the
   * candidate before scoring runs.
   */
  require?: ModelCapabilityRequirement[];
  /**
   * Bias the score profile toward local on-device models. Maps to a
   * dedicated `RoutingWorkload::LocalPreferred` weight profile —
   * quality-aware with a strong local_bonus so the hint wins ties.
   */
  prefer_local?: boolean;
  /**
   * Bias the score profile aggressively toward time-to-first-token.
   * Maps to `RoutingWorkload::Fastest` — heavy latency weight, near-zero
   * quality and cost weight. Designed for the fast track in voice-turn
   * dispatch (sub-500ms first-audio target). Takes precedence over
   * `prefer_local` if both are set.
   */
  prefer_fast?: boolean;
  /**
   * Bias the score profile toward the most capable model — quality
   * dominates, latency and cost near-floor (maps to
   * `RoutingWorkload::Quality`). For quality-critical, infrequent work
   * (building/verifying an agent, deriving a contract, structured
   * extraction) where a weak model fails. Precedence: `prefer_fast` wins,
   * then `prefer_quality`, then `prefer_local`.
   */
  prefer_quality?: boolean;
  /**
   * The operation is high-stakes — consequential or irreversible (e.g. the
   * session is authorized for FullAccess actions). Forces the strongest
   * quality posture regardless of task or any cost/latency preference: never
   * economize on what you can't take back. Highest precedence — wins over
   * `prefer_fast`, `prefer_quality`, and `prefer_local`. The daemon sets this
   * automatically for FullAccess-granted sessions.
   */
  high_stakes?: boolean;
}

// --- Voice streaming (stored-callback pattern) ---

export type AudioSourceSpec =
  | { kind: 'mic' }
  | { kind: 'system' }
  | { kind: 'file'; path: string }
  | { kind: 'fifo'; path: string }
  | { kind: 'pcm_push'; sample_rate: number; channels?: 1 | 2 };

export interface TranscribeStreamOptions {
  model?: string;
  language?: string;
  prompt?: string;
  emit_audio_meta?: boolean;
  /**
   * Enable native streaming partials. Today only takes effect for
   * `mic` sources when the runtime was compiled with the `parakeet`
   * feature; the listener uses Parakeet TDT for transcription and
   * emits `partial` events per non-blank token before each canonical
   * `transcript` event. Without the feature or for non-Mic sources
   * this flag is silently ignored.
   */
  streaming?: boolean;
  /**
   * Attach the prepared speaker diarizer to this session so
   * `transcript` events carry `role: "other:speaker_N"` rather than
   * `"unknown"`. Caller must `prepareDiarizer()` first. Silently
   * ignored if no diarizer has been prepared, or if the source isn't
   * `mic`.
   */
  diarizer?: boolean;
  /**
   * Attach the enrollment-based speaker pipeline so segments matching
   * an enrolled voiceprint get `role: "enrolled_user"`. Pipeline is
   * built lazily from `~/.car/voiceprints/`.
   */
  enrolled?: boolean;
  /**
   * Voice-context prompt overlay prepended to system prompts on the
   * voice-invoked inference path. Omit (or pass `null`) to use the
   * built-in default. An empty string disables the overlay (e.g. for
   * callers who already supply their own voice-tuned system prompt).
   */
  voice_prompt_overlay?: string | null;
  /**
   * Streaming STT provider override. Currently only meaningful with
   * `pcm_push` sources. `'elevenlabs'` opens an ElevenLabs Realtime
   * websocket and forwards pushed PCM frames to it instead of running
   * the in-process VAD + batch STT pipeline. Requires
   * `ELEVENLABS_API_KEY` in env, config, or keychain. `'local'` is the
   * explicit form of the default behavior. Unrecognised values fail at
   * `transcribeStreamStart` time with a clear error.
   */
  provider?: 'elevenlabs' | 'local';
}

export type VoiceStreamEvent =
  | { type: 'speech_start' }
  | { type: 'speech_end' }
  | { type: 'transcript'; text: string; duration_ms: number; role: string }
  | { type: 'partial'; text: string; duration_ms: number }
  | { type: 'audio_chunk'; sample_rate: number; frame_count: number }
  | { type: 'barge_in' }
  | { type: 'enrollment_captured'; label: string; save_path: string }
  | { type: 'enrollment_failed'; reason: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export function registerVoiceEventHandler(
  onEvent: (sessionId: string, eventJson: string) => void,
): void;

/**
 * Register the JS handler that serves daemon-initiated `agent.chat`
 * reverse-calls — the agent-chat surface. A supervised agent (running in
 * `--serve` mode, attached via `session.auth`) calls this once; the daemon
 * reverse-calls `agent.chat` for every host `agents.chat`, the bridge acks
 * `{accepted:true}` immediately, and fires this handler.
 *
 * `handlerFn(paramsJson)` receives `{"session_id":"...","prompt":"...",
 * "attachments":[...]?,"context":{...}?}` as a JSON string. Run one
 * conversational turn — keep a per-`session_id` message thread, run the
 * agent loop, and stream the reply back via `CarRuntime.chatEvent` — then
 * return. It is fire-and-forget (the ack already went back), so a rejected
 * Promise is logged, not surfaced to the host. Process-wide setter,
 * symmetric to `registerVoiceEventHandler`; pair with
 * `unregisterChatHandler` to clear.
 *
 * The handler may call any runtime method and should run the turn inline.
 * NAPI dispatches through a non-blocking `ThreadsafeFunction` and `chatEvent`
 * is async, so this side never had the reentrancy hazard that made the same
 * surface unusable from Python before Parslee-ai/car#905 — noted here because
 * the two bindings' handlers now carry the same contract for the same reason,
 * arrived at differently.
 */
export function registerChatHandler(
  handlerFn: (paramsJson: string) => void,
): void;

/**
 * Clear the registered `agent.chat` handler. Subsequent reverse-calls are
 * refused so the daemon learns this agent is no longer conversational.
 */
export function unregisterChatHandler(): void;

/**
 * Register the JS `tools.execute` handler for `submitProposal`
 * (Parslee-ai/car-releases#38). When the daemon dispatches a
 * proposal carrying host-owned tools, every tool routes through
 * this handler.
 *
 * `handlerFn(callJson)` receives
 * `{"tool":"name","params":{...},"action_id":"<id>","request_id":"<id>","timeout_ms":<ms|null>,"session_id":"<id>|null","attempt":<n>}`
 *
 * `attempt` is the engine's retry counter, 1-based — which retry you are
 * serving. (Correlate a specific in-flight call by `request_id` instead.) It
 * was hardcoded to 1 on the wire and dropped here before car#928.
 *
 * `session_id` is the daemon-stamped execution session (car#904) — the
 * attribution key for which mission a callback belongs to. Null when the
 * caller has no session. Prefer it over reconstructing attribution from
 * `action_id`, which is client-authored and not unique across concurrent or
 * retried attempts.
 * as a JSON string and MUST return a Promise resolving to the tool's
 * JSON-encoded result. Throwing rejects the daemon-side action
 * with a -32000 JSON-RPC error.
 *
 * `request_id` is the daemon's callback-routing id, repeated by the
 * `tools.cancel` notification so the host can abort the right
 * in-flight call. `timeout_ms` is the action's declared budget in
 * milliseconds when the action declared one (`null` otherwise); the
 * host's tool runner may use it to bound its own work.
 *
 * `action_id` carries the originating `Action.id` from the
 * proposal so process-wide handlers can route concurrent
 * callbacks back to the right per-call closure. Empty string when
 * the daemon's `tools.execute` payload omits it (legacy daemons;
 * not expected on >=0.9.x).
 *
 * Process-wide setter — re-calling overwrites the previous
 * handler. Pair with `unregisterToolHandler` to clear. Symmetric
 * to `registerInferenceRunner` / `registerAgentRunner`: only one
 * handler can be active at a time.
 *
 * Required before `submitProposal`. `executeProposal` continues
 * to accept a per-call handler and does not use this registration.
 */
export function registerToolHandler(
  handlerFn: (callJson: string) => Promise<string>,
): void;

/**
 * Clear the registered `tools.execute` handler. `submitProposal`
 * calls after this will fail if the proposal carries any
 * host-tool actions.
 */
export function unregisterToolHandler(): void;

/**
 * Register the callback fired when a tool callback is reaped
 * (Parslee-ai/car#264). When a `tools.execute` callback exceeds its budget the
 * daemon emits a `tools.cancel` notification; this callback receives the
 * reaped call's `requestId` (the same `request_id` surfaced on the originating
 * `tools.execute` call_json) so the host can abort the in-flight child it
 * registered under that id (e.g. `AbortController.abort()` / `child.kill()`).
 *
 * Fire-and-forget — no return value. Process-wide setter; re-calling
 * overwrites. Pair with `unregisterToolCancelHandler` to clear.
 */
export function registerToolCancelHandler(
  handlerFn: (requestId: string) => void,
): void;

/**
 * Clear the registered `tools.cancel` handler. Subsequent reaps are no longer
 * routed to the host (the daemon has already abandoned the call regardless).
 */
export function unregisterToolCancelHandler(): void;

export function transcribeStream(
  rt: CarRuntime,
  sessionId: string,
  audioSourceJson: string,
  optionsJson?: string | null,
): Promise<string>;

export function transcribeStreamStop(rt: CarRuntime, sessionId: string): Promise<string>;

export function transcribeStreamPush(
  rt: CarRuntime,
  sessionId: string,
  pcmFrame: Buffer,
): Promise<string>;

export function listVoiceSessions(rt: CarRuntime): string;

/**
 * Start a streaming TTS synthesis.
 *
 * Stub: not exposed in the FFI bindings. Connect to the daemon's
 * WebSocket and use `voice.tts_stream.start`; chunks arrive as
 * `voice.event` notifications with `type = "tts_chunk"`.
 */
export function ttsStreamStart(
  rt: CarRuntime,
  streamId: string,
  text: string,
  optionsJson?: string | null,
): Promise<string>;

/** Cancel an in-flight TTS stream. Idempotent. */
export function ttsStreamCancel(rt: CarRuntime, streamId: string): Promise<string>;

/** List the ids of all in-flight TTS streams. */
export function listTtsStreams(rt: CarRuntime): string;

// --- Voice turn dispatch (two-track sidecar pattern) ---

export interface DispatchVoiceTurnRequest {
  /** Finalized utterance text (typically from STT). */
  utterance: string;
  /** Optional voice session id this turn belongs to. */
  session_id?: string | null;
  /**
   * Optional override for the voice-context overlay.
   * `null`/omitted uses the default; an empty string disables.
   */
  config_overlay?: string | null;
  /** Optional sidecar wait timeout in milliseconds. Default 30000. */
  sidecar_timeout_ms?: number | null;
}

export interface DispatchVoiceTurnResponse {
  turn_id: number;
}

export type VoiceTurnEvent =
  | { type: 'voice.turn.fast_delta'; turn_id: number; text: string }
  | { type: 'voice.turn.fast_done'; turn_id: number }
  | {
      type: 'voice.turn.bridge';
      turn_id: number;
      kind: 'email' | 'calendar' | 'search' | 'unknown';
      phrase: string;
    }
  | { type: 'voice.turn.sidecar'; turn_id: number; text: string }
  | { type: 'voice.turn.error'; turn_id: number; error: string }
  | { type: 'voice.turn.cancelled'; turn_id: number };

/**
 * Dispatch a voice-turn utterance through the two-track sidecar pattern.
 *
 * Returns `{"turn_id": N}` (JSON-encoded) synchronously. Subsequent
 * fast deltas, bridge phrases, sidecar results, errors, and
 * cancellations flow through the JS callback registered via
 * `registerVoiceEventHandler` as JSON-encoded `VoiceTurnEvent` objects.
 * The host plays audio (or otherwise renders) from those events —
 * CAR does NOT own the speaker on this path.
 *
 * Not available in Daemon mode (no in-process inference engine);
 * connect to `ws://127.0.0.1:9100/` for the WebSocket flow there.
 */
export function dispatchVoiceTurn(rt: CarRuntime, requestJson: string): Promise<string>;

/** Cancel the in-flight voice turn (if any). Idempotent. */
export function cancelVoiceTurn(rt: CarRuntime): Promise<void>;

/**
 * Issue a 1-token probe with `prefer_fast: true` so the fast model is
 * loaded into memory before the first user turn. Best-effort and
 * idempotent — call at app startup.
 *
 * Not available in Daemon mode.
 */
export function prewarmVoiceTurn(rt: CarRuntime): Promise<void>;

/**
 * Voice providers (STT + TTS) compiled into this build.
 *
 * Returns a JSON-encoded array of objects with shape:
 * `{ id: string, kind: "stt" | "tts", available: boolean, description: string }`.
 *
 * `available` reflects build-time presence (cfg-target, build features) —
 * runtime readiness (API key set, permission granted, model downloaded)
 * surfaces via per-provider error paths when you actually use them.
 *
 * Stateless; safe to call before constructing a `CarRuntime`.
 */
export function listVoiceProviders(): string;

// --- Meeting capture ---

export interface StartMeetingRequest {
  id?: string;
  sources: Array<'mic' | 'system'>;
  title?: string;
  model?: string;
  language?: string;
  persist_audio?: boolean;
  root?: string;
  /**
   * Enable native streaming partials on the mic source. Effective
   * only when the runtime was built with `--features parakeet`;
   * silently ignored otherwise. `transcript` events still arrive at
   * segment end — `partial` events are emitted incrementally per
   * non-blank token in between.
   */
  streaming?: boolean;
  /**
   * Attach the prepared diarizer to the mic source so transcripts
   * carry per-speaker roles. Call `prepareDiarizer()` first.
   */
  diarizer?: boolean;
  /**
   * Attach the enrollment-based pipeline so segments matching an
   * enrolled voiceprint get `role: "enrolled_user"`.
   */
  enrolled?: boolean;
}

/** Eagerly download + load the Parakeet TDT model (~600 MB). Idempotent. */
export function prepareParakeet(rt: CarRuntime): Promise<string>;

/** Eagerly download + load the speaker diarizer (~28 MB). Idempotent. */
export function prepareDiarizer(rt: CarRuntime): Promise<string>;

/**
 * Enroll a speaker. `audioJson` shape:
 * - `{"kind":"wav","path":"/abs/path.wav"}` — decoded via hound
 * - `{"kind":"pcm","sample_rate":48000,"channels":1,"data_b64":"<base64>"}`
 *
 * Saves to `~/.car/voiceprints/<label>.toml`. Returns
 * `{"label":...,"path":...,"model_id":...}`.
 */
export function enrollSpeaker(
  rt: CarRuntime,
  label: string,
  audioJson: string,
): Promise<string>;

/** List saved enrollments. Returns `{"enrollments":[{label,path,model_id},...]}`. */
export function listEnrollments(rt: CarRuntime): string;

/** Delete a saved enrollment by label. Idempotent. */
export function removeEnrollment(rt: CarRuntime, label: string): string;

// --- Workflow ---

/**
 * Run a multi-stage workflow definition. Reuses the agent runner
 * registered via `registerAgentRunner` for any agent stages in the
 * workflow.
 *
 * `initialStateJson`, when given, is a JSON object seeded into workflow state
 * before the run starts — the inter-workflow chaining hook (hand a prior
 * result's `final_state` to the next workflow). Omitted = prior behavior.
 * The reserved `goal` drift anchor cannot be injected this way.
 */
export function runWorkflow(
  workflowJson: string,
  initialStateJson?: string | undefined | null,
): Promise<string>;

/**
 * Run a JSON array of workflow definitions sequentially as a chain: each next
 * workflow's initial state is the previous result's `final_state`, merged
 * over `initialStateJson` (the previous result wins). Every workflow is
 * statically pre-validated before any executes — structural garbage rejects
 * the chain up front. Stops at the first non-`completed` result. Returns
 * `{ results: [WorkflowResult, ...], status, paused_at_index?, error?,
 * failed_at_index? }` JSON; a paused intermediate carries its `paused`
 * checkpoint inside its result (checkpoint persistence stays caller-owned,
 * like `runWorkflow`), and a mid-chain runtime engine error preserves the
 * results so far (with top-level `error` + `failed_at_index`) instead of
 * throwing. Reuses the agent runner registered via `registerAgentRunner`.
 */
export function workflowChain(
  workflowsJson: string,
  initialStateJson?: string | undefined | null,
): Promise<string>;

/**
 * Resume a workflow that paused at a human-in-the-loop approval gate.
 * `pausedJson` is the `paused` checkpoint object from a prior `runWorkflow`
 * (or `resumeWorkflow`) result; `inputJson` is a JSON object of the human's
 * response fields. Returns the next workflow result JSON, which may itself be
 * paused again at another gate.
 */
export function resumeWorkflow(pausedJson: string, inputJson: string): Promise<string>;

/** List resumable workflow checkpoints under `runsDir` (H1). Returns a JSON
 * array of `{run_id, paused_stage_id, prompt, created_at}` — rediscover
 * resumable runs after a restart. */
export function listPausedWorkflows(runsDir: string): string;

/** Bind (or clear) the memory namespace for subsequent daemon connections
 * (car-releases#81). Returns the namespace now in effect, or `null` for the
 * daemon's shared graph.
 *
 * Prefer this over setting `CAR_MEMORY_NAMESPACE` when the namespace is
 * per-project. An env var cannot carry a per-project value: the host learns
 * which project it is *after* the process starts, and on **bun** a JS-side
 * `process.env` write never reaches the C `environ` this library reads — the
 * write is silently ignored and the session falls back to the shared graph.
 *
 * Blank or `null` clears the override, falling back to `CAR_MEMORY_NAMESPACE`
 * and then the shared graph.
 *
 * **Takes effect on the next connection.** The namespace is negotiated during
 * `session.auth`, so an already-established connection keeps the graph it
 * bound. Call this before your first CAR call, or disconnect afterwards to
 * force a rebind — otherwise you keep writing to the previous project's
 * graph. */
export function setMemoryNamespace(namespace?: string | null): string | null;

/** The memory namespace currently in effect — the explicit override if set,
 * otherwise `CAR_MEMORY_NAMESPACE`, otherwise `null` (shared graph). */
export function getMemoryNamespace(): string | null;

/** NLP (F4): identify the dominant language of `text`. Returns
 * `{language, backend}` JSON (Apple NaturalLanguage on macOS, pure-Rust
 * fallback elsewhere). */
export function nlpIdentifyLanguage(text: string): string;

/** NLP (F4): word-tokenize `text`. Returns `{tokens, backend}` JSON. */
export function nlpTokenize(text: string): string;

/** NLP (F4): extract named entities from `text`. Returns `{entities, backend}`
 * JSON; entities are `{text, kind, byte_range}`. */
export function nlpExtractEntities(text: string): string;

/** Static analysis on a workflow definition. Returns verification report JSON. */
export function verifyWorkflow(workflowJson: string): string;

/**
 * Build the external-item automation recipe (poll → dedup → per-item agent →
 * deliver) from an `AutomationSpec` JSON into a runnable workflow JSON. Hand the
 * result to `runWorkflow`, typically on a schedule. Stateless.
 */
export function buildAutomationWorkflow(specJson: string): string;

export interface StartMeetingResponse {
  id: string;
  title: string;
  started_at: string;
  voice_session_ids: string[];
}

export function startMeeting(rt: CarRuntime, requestJson: string): Promise<string>;

export function stopMeeting(
  rt: CarRuntime,
  meetingId: string,
  summarize?: boolean | null,
): Promise<string>;

export function listMeetings(
  rt: CarRuntime,
  rootOverride?: string | null,
): Promise<string>;

export function getMeeting(
  rt: CarRuntime,
  meetingId: string,
  rootOverride?: string | null,
): Promise<string>;

// --- Agent registry (file-based, no daemon) ---

/**
 * Register or replace an agent's entry in the user-default registry
 * (`~/.car/registry/`) or at the path supplied as `registryPath`.
 *
 * `entryJson` is a JSON-serialised `AgentEntry`:
 * ```json
 * {
 *   "name": "trader-paper",
 *   "dashboard_url": "http://127.0.0.1:8731",
 *   "status": "running",
 *   "display_name": "Trader (paper)",
 *   "capability": "places stock trades through Alpaca",
 *   "port": 8731,
 *   "pid": 12345
 * }
 * ```
 * `name` and `dashboard_url` are required; the rest are optional.
 * `capability` is a natural-language description that lets
 * `discoveryResolve` rank this service against a need — without it the
 * service still resolves but ranks on its label alone.
 * Returns `"null"` on success.
 */
export function registerAgent(
  entryJson: string,
  registryPath?: string | null,
): string;

/**
 * Bump `last_heartbeat_at` for the named agent. Returns
 * `'{"refreshed": true}'` if the agent was registered, or
 * `'{"refreshed": false}'` if the caller should re-register.
 */
export function agentHeartbeat(
  name: string,
  registryPath?: string | null,
): string;

/** Remove an agent's entry. Idempotent. */
export function unregisterAgent(
  name: string,
  registryPath?: string | null,
): string;

/**
 * List all currently-registered agents. Returns a JSON array of
 * `AgentEntry` objects, sorted by name.
 */
export function listAgents(registryPath?: string | null): string;

/**
 * Reap entries whose last heartbeat is older than `maxAgeSecs`.
 * Returns a JSON array of names that were reaped.
 */
export function reapStaleAgents(
  maxAgeSecs: number,
  registryPath?: string | null,
): string;

// --- car-a2a server lifecycle ---
//
// Expose CAR as an Agent2Agent (A2A) v1.0 peer programmatically,
// without shelling out to `car-server --a2a-bind`. These proxy to the
// daemon the `CarRuntime` is connected to, so each takes the runtime as
// its first argument.
//
// NOTE ON NAMING: napi-rs (heck) splits at digit→letter boundaries, so
// the Rust `start_a2a_server` camelCases to `startA2AServer` (the `a2a`
// segment becomes `A2A`), NOT `startA2aServer`. The exported names are
// `startA2AServer` / `stopA2AServer` / `a2AServerStatus` /
// `sendA2AMessage` / `a2ADispatch`. (Earlier versions of this file
// declared `…A2a…`, which did not exist at runtime — car-releases#65.)

/**
 * Start an A2A listener on the daemon `rt` is connected to.
 *
 * `paramsJson` shape:
 * ```jsonc
 * {
 *   "bind": "127.0.0.1:8731",        // required
 *   "public_url": "https://...",     // optional; defaults to http://<bound>
 *   "agent_name": "...",             // optional
 *   "agent_description": "...",      // optional
 *   "organization": "...",           // optional
 *   "organization_url": "...",       // optional
 *   "share_session_runtime": false   // optional, default false
 * }
 * ```
 *
 * `share_session_runtime` — when `true`, the A2A dispatcher uses
 * the calling `CarRuntime`'s session runtime instead of spawning a
 * fresh one. Tools registered on the session via
 * `registerToolSchema` then appear on the Agent Card's `skills`
 * list, and A2A peer `message/send` calls that carry an explicit
 * tool invocation (a `data` part `{ "tool": "...", "parameters": {...} }`)
 * route back to the handler installed via `registerToolHandler`. This is
 * the canonical path for host-language agents to project themselves
 * over A2A. Default `false` preserves the legacy fresh-Runtime
 * behaviour (only `register_agent_basics` tools, dispatch in Rust).
 *
 * A purely *conversational* `message/send` (free text, no tool `data`
 * part) is routed to the host's `agent.chat` handler — the daemon
 * reverse-calls `agent.chat` on this session, aggregates the streamed
 * reply, and returns it as the A2A agent message (car-releases#65). So
 * register an `agent.chat` handler to serve conversational turns, and/or
 * a `registerToolHandler` for explicit tool `data` parts.
 *
 * Returns `'{"bound":"127.0.0.1:8731"}'` on success. Errors if a
 * server is already running, the bind fails, `share_session_runtime`
 * is set but no session runtime is available (e.g. invoked from a
 * non-WS path), or `paramsJson` is malformed.
 */
export function startA2AServer(rt: CarRuntime, paramsJson: string): Promise<string>;

/**
 * Stop the running A2A listener. Returns `'{"stopped":true}'` on
 * success. Errors if no server is running.
 */
export function stopA2AServer(rt: CarRuntime): Promise<string>;

/**
 * Report whether the A2A listener is up. Always returns a JSON
 * object — `{"running":true,"bound":"...","uptime_secs":N}` when
 * running, `{"running":false}` otherwise.
 */
export function a2AServerStatus(rt: CarRuntime): Promise<string>;

/**
 * Send a message to a remote A2A peer at `endpoint`.
 *
 * `paramsJson` shape: `{ endpoint, message, blocking?, ingest_a2ui?,
 * route_auth?, allow_untrusted_endpoint? }`. The daemon enforces a
 * loopback-or-explicit-allow rule on `endpoint` — non-loopback URLs
 * require `allow_untrusted_endpoint: true`.
 */
export function sendA2AMessage(rt: CarRuntime, paramsJson: string): Promise<string>;

// --- Verification (stateless) ---

/**
 * Statically verify a proposal.
 *
 * `toolNames` checks tool existence only. To also validate each
 * `tool_call`'s parameters against the tool's JSON Schema — catching
 * type mismatches (`{path: 42}` for a `string`) and missing required
 * fields — pass `toolSchemasJson`: a JSON array of tool schemas, e.g.
 * `JSON.stringify([{ name: "echo", parameters: { type: "object",
 * properties: { msg: { type: "string" } }, required: ["msg"] } }])`.
 * When both are given, `toolSchemasJson` takes precedence.
 *
 * Returns a JSON string:
 * `{ valid, issues, simulated_state, execution_levels, conflicts,
 * evidence }`. `evidence` is the verifier's declared scope (survey
 * "Code as Agent Harness" §5.2.2): `{ checks: [{ name, ran, verifies,
 * cannot_verify, findings, tier }], assumptions, untested_regions,
 * residual_risks, confidence }` — so a `valid: true` verdict can be read
 * with its scope (what was checked, what was not, coverage confidence)
 * rather than as a blanket guarantee.
 *
 * Each issue is `{ action_id, severity, message, tier }`. `tier` is the
 * **evidence tier** — `"decision_procedure" | "heuristic" | "sampled"` —
 * naming which kind of check produced the finding, so you don't have to
 * pattern-match the message to tell them apart. All of `verify`'s
 * findings are `decision_procedure` (set membership, the STRIPS-style
 * forward walk, write-conflict detection) except the
 * repeated-identical-call rule, which is `heuristic`: the count is
 * exact, "runaway loop" is a proxy, and a legitimate 3× poll trips it.
 * The tier is orthogonal to `severity` (how bad, not how derived), and
 * `decision_procedure` is not a proof or a soundness claim — it means
 * the check decides the property it reports over the inputs it was
 * given, which for the state-dependent checks is a forward model built
 * only from *declared* effects. Each `CheckRecord` carries the same
 * `tier` as the findings it contributed.
 */
export function verify(
  proposalJson: string,
  initialStateJson?: string | null,
  toolNames?: string[] | null,
  maxActions?: number | null,
  toolSchemasJson?: string | null,
): string;

export function simulate(
  proposalJson: string,
  initialStateJson?: string | null,
): string;

/**
 * Sample N rollouts of a proposal with tools allowed to fail.
 *
 * `simulate` answers "what state does this plan leave behind, assuming every
 * dispatched tool succeeds?" This answers "how often does it actually work,
 * and when it doesn't, what breaks first?" Each `tool_call` succeeds with the
 * probability given in `toolSuccessRatesJson` (a JSON object mapping tool name
 * to a rate in `0.0..=1.0` — the shape produced by the planner's per-tool
 * trajectory feedback). Failures cascade through the dependency graph exactly
 * as they would at runtime: an action whose dependency never landed is
 * rejected before dispatch, not retried.
 *
 * `goalJson` is an optional `GoalCondition` evaluated against each trial's
 * final state. Conditions a simulation cannot decide — tool receipts, command
 * exits, model judges — fail closed and are named in
 * `goal_underivable_conditions`, so a `p_goal_reached` of 0 is never silently
 * mistaken for "this plan cannot work".
 *
 * `configJson` is an optional `{ trials?, seed?, defaultSuccessRate?,
 * retryAttempts? }` — note these are **snake_case** on the wire
 * (`default_success_rate`, `retry_attempts`), since the payload is serde JSON
 * rather than a napi-converted object. Defaults: 1000 trials, a fixed seed,
 * 0.5 for tools with no recorded history, no retries. The seed is fixed rather
 * than time-derived so runs are reproducible, and is echoed back in the result.
 *
 * Returns JSON:
 * `{ trials, seed, p_goal_reached, goal_underivable_conditions,
 * p_all_effects_landed, tool_calls: {mean, min, p50, p95, max},
 * actions_executed: {...}, state_distribution: [{key, p_present,
 * values: [{value, probability}]}], action_outcomes: [{action_id, p_rejected,
 * p_failed, p_effects_landed, mean_blast_radius}] }`.
 *
 * Independence caveat: draws are uncorrelated, so a plan that calls one flaky
 * tool repeatedly reads more optimistically here than it will behave when that
 * tool's backing service is down.
 */
export function simulateMonteCarlo(
  proposalJson: string,
  initialStateJson?: string | null,
  toolSuccessRatesJson?: string | null,
  goalJson?: string | null,
  configJson?: string | null,
): string;

export function optimize(proposalJson: string): string;

export function equivalent(proposal1Json: string, proposal2Json: string): boolean;

/**
 * Wire protocol version this binding speaks to the `car-server` daemon,
 * exchanged via the `server.handshake` RPC. Bumped only on a
 * backward-incompatible JSON-RPC change — independent of the package semver.
 */
export function protocolVersion(): number;

/**
 * Version of THIS `car-runtime` npm package — the client library that talks to
 * the daemon, and the number the version-skew notice compares against
 * `car-server`.
 *
 * Not the same thing as `car --version`: on macOS `/usr/local/bin/car` is a
 * symlink into `CarHost.app`, so that reports the bundled CLI. When the stale
 * component is this package the CLI's version is the wrong one to check
 * (Parslee-ai/car#1050).
 */
export function clientVersion(): string;

/**
 * Check a proposal for transactional conflicts against the current shared
 * state (survey "Code as Agent Harness" §4.3/§5.2.4 — the shared
 * code-centric harness substrate). `versionsJson` is a JSON object mapping
 * state key → current version (from the runtime's versioned state store);
 * `stateJson` (optional) maps key → current value for value-level
 * assumption checks.
 *
 * Returns the `TransactionReport` JSON: `{ consistent: boolean, conflicts:
 * [{ kind, key, actions, explanation, resolution }] }` where `kind` is
 * `"write_write" | "read_write" | "stale_assumption"`. Detects write-write
 * races and read-write hazards between unordered actions, and stale
 * assumptions (an action planned against a key at a version/value the
 * shared state has since moved past — belief divergence). Each conflict
 * carries a human-actionable explanation and a suggested resolution.
 */
export function transactionCheck(
  proposalJson: string,
  versionsJson?: string | null,
  stateJson?: string | null,
): string;

/**
 * Like `transactionCheck`, but unions each action's write set with the keys a
 * verified Code World Model predicts it writes (Code World Models Slice 3b —
 * pre-flight conflict detection; `docs/proposals/code-world-models.md`).
 * `transactionCheck` reasons over *declared* effects; a tool that writes a key
 * it didn't declare produces a hazard that only surfaces at runtime. Once a
 * model is verified you can predict those writes and fold them in here.
 *
 * `predictionsJson` is a JSON object mapping `actionId` → array of predicted
 * write keys (the caller produced them by running the generated model). Returns
 * the same `TransactionReport` JSON as `transactionCheck` `{ consistent,
 * conflicts }`.
 */
export function transactionCheckWithPredictions(
  proposalJson: string,
  versionsJson: string | null | undefined,
  stateJson: string | null | undefined,
  predictionsJson: string,
): string;

/**
 * Score a Code World Model against recorded trajectories (Slice 1 of
 * `docs/proposals/code-world-models.md`, applying arXiv 2510.04542 "Code
 * World Models for General Game Playing"). The paper validates an
 * LLM-generated world model by unit-testing its `apply(state, action)`
 * against recorded transitions; this is that transition-accuracy metric.
 *
 * `transitionsJson` is a JSON array of `{ stateBefore, action, stateAfter }`
 * records (e.g. from `cwmTransitionsFromEvents`). `predictionsJson` is an
 * index-aligned JSON array; each element is the model's predicted post-state
 * object, or `{ "error": "<stack trace>" }` when running the generated code
 * threw. Code execution is the caller's responsibility (e.g. a sandbox), so
 * this stays a pure scoring function.
 *
 * Returns the `ScoreReport` JSON `{ total, correct, errored, accuracy,
 * failures: [{ index, action, expected, predicted?, error? }] }`. A
 * length mismatch between transitions and predictions is an error, not a
 * silent truncation.
 */
export function cwmScore(
  transitionsJson: string,
  predictionsJson: string,
): string;

/**
 * Gate a skill's deployment capability against its provenance
 * (`docs/proposals/skill-trust-governance.md`, applying arXiv 2602.12430 "Agent
 * Skills"). Maps a skill's provenance to a trust tier and caps the
 * `PermissionTier` capability that tier permits — the supply-chain governance
 * lens motivated by the paper's finding that 26.1% of community skills are
 * vulnerable.
 *
 * `provenanceJson` is a `SkillProvenance` `{ signed?, signer_trusted?, scanned?,
 * vulnerabilities?, source?: "official" | "first_party" | "community" |
 * "unknown", success_count?, fail_count? }`; `requestedTier` is `"read_only" |
 * "sandbox_edit" | "full_access"`. Returns the `SkillDeploymentDecision` JSON
 * `{ trust: "untrusted" | "community" | "verified" | "official", ceiling,
 * granted, outcome: "allow" | "downgrade" | "deny", reason }`. A vulnerable,
 * unsigned, or degraded skill is denied regardless of the requested tier.
 */
export function gateSkillDeployment(
  provenanceJson: string,
  requestedTier: string,
): string;

/**
 * Static information-flow + tool-sequence safety check over a plan
 * (`docs/proposals/verifiable-tool-safety.md`, applying arXiv 2601.08012
 * "Towards Verifiably Safe Tool Use for LLM Agents"). Catches hazards no
 * per-action check covers: sensitive data reaching an exfiltration/untrusted
 * sink, and forbidden tool orderings — statically, before execution.
 *
 * `labelsJson` is a JSON object mapping `toolName` → capability-enhanced-MCP
 * labels `{ capability?: string, confidentiality?: "public" | "internal" |
 * "secret", trust?: "trusted" | "untrusted", sink?: boolean, declassifier?:
 * boolean }` (all fields default to public/trusted/non-sink). `policyJson`
 * (optional) is `{ minConfidential?: "public" | "internal" | "secret",
 * forbiddenSequences?: [string, string][] }` — the minimum confidentiality
 * guarded at sinks and forbidden ordered `(before, after)` capability pairs.
 *
 * Returns the `FlowReport` JSON `{ safe: boolean, violations: [{ kind:
 * "sensitive_to_sink" | "forbidden_sequence", actions: string[], key?: string,
 * explanation: string, mitigation: string }] }`. Tools absent from `labelsJson`
 * are unconstrained, so an empty map is trivially safe. Reasons over declared
 * `state_dependencies`/`expected_effects` (the edges the executor sequences on);
 * flows through undeclared channels are out of scope.
 */
export function checkInformationFlow(
  proposalJson: string,
  labelsJson: string,
  policyJson?: string | null,
): string;

/**
 * Map an information-flow `FlowReport` (from `checkInformationFlow`) to an
 * enforcement decision (Slice 2 of `docs/proposals/verifiable-tool-safety.md`).
 * Turns the advisory check into a gate: clear data exfiltration is blocked,
 * ambiguous forbidden orderings are escalated to a human, the rest proceed.
 *
 * `gatePolicyJson` (optional) is `{ onSensitiveToSink?: "allow" |
 * "require_approval" | "block", onForbiddenSequence?: "allow" |
 * "require_approval" | "block" }` (defaults: block exfiltration, escalate
 * orderings). Returns the `FlowGateDecision` JSON `{ action: "allow" |
 * "require_approval" | "block", blocked: FlowViolation[], needs_approval:
 * FlowViolation[], reason: string }`, where `action` is the most severe across
 * violations. Wiring `require_approval` to the permission-tier HITL ledger is
 * the engine step.
 */
export function gateInformationFlow(
  reportJson: string,
  gatePolicyJson?: string | null,
): string;

/**
 * Enforce a `FlowGateDecision` (from `gateInformationFlow`) against the durable
 * human-in-the-loop approval ledger (Slice 3 of
 * `docs/proposals/verifiable-tool-safety.md`). A `require_approval` hazard a
 * human previously **approved** (by its stable flow fingerprint) is allowed
 * through, one **rejected** is blocked, and an unseen one becomes pending — so
 * the runtime confirms only the hazardous flows, and only once.
 *
 * `approvalsJson` (optional) is a JSON array of prior `ApprovalRecord`s
 * (`{ fingerprint, required_tier, decision: "approved" | "rejected", reviewer,
 * reason, evidence?, decided_at }`). Returns the `FlowEnforcement` JSON `{ allow:
 * boolean, blocked: FlowViolation[], pending: [{ fingerprint, violation }],
 * reason }`. Stateless — the ledger is rebuilt from `approvalsJson` each call.
 */
export function enforceInformationFlow(
  decisionJson: string,
  approvalsJson?: string | null,
): string;

/**
 * Analyze a schedule of multi-agent read-generate-write operations for the four
 * concurrency anomalies of *Verified Detection and Prevention of Concurrency
 * Anomalies in Multi-Agent LLM Systems* (`docs/proposals/concurrency-anomalies.md`,
 * applying arXiv 2606.17182) and classify the achieved consistency level. The
 * time-extended, inter-agent complement to `transactionCheck`.
 *
 * `opsJson` is a JSON array of `AgentOp` (serde snake_case keys): `{ id, agent?,
 * read_set?, write_set?, tools_read?, tools_written?, depends_on?, read_at?,
 * commit_at? }` (omitted fields default). Returns the `ConcurrencyReport` JSON:
 * `{ level: "l0" | "l1" | "l2" | "l3" | "l4", serializable, anomalies: [{
 * anomaly: "stale_generation" | "phantom_tool" | "causal_cascade" |
 * "tool_effect_reorder", key, ops, explanation }] }` — `level` is set by the
 * most severe *named* anomaly present (causal-cascade → l0 … none → l4).
 *
 * `serializable` is a separate, real conflict-serializability decision: the
 * schedule's serialization graph (write-write, write-read, anti-dependency, and
 * declared `depends_on` edges) is tested for a cycle. It is NOT `level === "l4"`.
 * The two deliberately disagree on write skew — concurrent ops reading
 * overlapping state and writing disjoint keys match no named anomaly, so such a
 * schedule reports `level: "l4"` with `serializable: false`. Read `level` for
 * which anomaly to remediate, `serializable` for whether an equivalent serial
 * order exists.
 */
export function analyzeConcurrency(opsJson: string): string;

/**
 * Gate a concurrency report (from `analyzeConcurrency`) into remediations under a
 * policy (`docs/proposals/concurrency-anomalies.md`, arXiv 2606.17182 Slice 2 —
 * the analogue of `gateInformationFlow` for concurrency). Maps each anomaly to a
 * structural fix and a dispatch disposition by severity.
 *
 * `reportJson` is the `ConcurrencyReport`; `policyJson` (optional) is a
 * `ConcurrencyGatePolicy` `{ abort_at_or_below, require_approval_at_or_below }`
 * (levels `"l0".."l4"`; defaults abort on `l0`, approval on `l1`). Returns the
 * `ConcurrencyGate` JSON: `{ safe, level, abort, remediations: [{ anomaly,
 * remediation: { kind: "reread_and_regenerate" | "pin_tool_registry" |
 * "enforce_causal_order" | "serialize_writers", ... }, disposition:
 * "auto_remediate" | "require_approval" | "abort" }] }`.
 */
export function gateConcurrency(
  reportJson: string,
  policyJson?: string | null,
): string;

/**
 * Statically verify a workflow graph for structural defects
 * (`docs/proposals/workflow-graph-verification.md`, applying arXiv 2603.20356
 * "Agentproof"). Catches topology-level defects a schema check misses — a
 * dead-end stage, an unreachable exit, a trap loop — before execution, each with
 * a witness path (the counter-example for a repair loop).
 *
 * `graphJson` is a `WorkflowGraph` `{ entry: string, terminals: string[],
 * stages: string[], edges: [{ from, to, condition? }] }`. Returns the
 * `WorkflowVerifyReport` JSON `{ sound: boolean, defects: [{ kind:
 * "missing_entry" | "dangling_edge" | "unreachable_stage" | "dead_end" |
 * "no_exit_reachable" | "unreachable_terminal", subject, witness: string[],
 * explanation }] }`.
 */
export function verifyWorkflowGraph(graphJson: string): string;

/**
 * Check temporal safety policies over a workflow graph
 * (`docs/proposals/workflow-graph-verification.md`, arXiv 2603.20356 "Agentproof"
 * Slice 2 — the static half of the policy layer). The headline policy is the
 * human-gate: a guard stage must precede a sensitive stage on *every* path.
 *
 * `graphJson` is a `WorkflowGraph`; `policiesJson` is a JSON array of
 * `TemporalPolicy` (`{ kind: "precedes", earlier: string, later: string, name?:
 * string }`). Returns the `PolicyReport` JSON `{ compliant: boolean, violations:
 * [{ policy, stage, witness: string[], explanation }] }` — each violation's
 * witness is a path that reaches the guarded stage without the required
 * predecessor.
 */
export function checkWorkflowPolicies(
  graphJson: string,
  policiesJson: string,
): string;

/**
 * Verify a plan's sequential feasibility by symbolic forward simulation
 * (`docs/proposals/plan-precondition-verification.md`, applying arXiv 2603.14730
 * "GNNVerifier" — the deterministic, training-free counterpart). Catches a step
 * whose preconditions the earlier steps never establish, and an unreached goal,
 * before anything runs (the STRIPS applicability check).
 *
 * `requestJson` is a `PlanCheckRequest` `{ initial: string[], steps: [{ id:
 * string, preconditions?: string[], add_effects?: string[], del_effects?:
 * string[] }], goal: string[] }`. Returns the `PlanCheckReport` JSON `{ valid:
 * boolean, defects: [{ kind: "unmet_precondition" | "goal_not_achieved", step?,
 * fact, explanation }], final_state: string[] }`. Effects apply even when a
 * precondition fails, so one pass surfaces every defect.
 */
export function checkPlan(requestJson: string): string;

/**
 * Deterministic goal-condition evaluation — the Evaluator half of CAR's goal
 * loop (`docs/proposals/goal-loop.md`), CAR's answer to `/goal`. Decides "am I
 * done?" over runtime ground truth instead of a model reading its own
 * transcript.
 *
 * `requestJson` is `{ condition, inputs }`. `condition` is a composable
 * `GoalCondition`: `{ kind: "all_of" | "any_of", conditions: GoalCondition[] }`
 * or a leaf `{ kind: "tool_receipts_grounded" | "plan_achieved" |
 * "state_consistent" }` / `{ kind: "state_predicate", key: string, equals: any }`
 * / `{ kind: "command", id: string, expect_exit: number }` / `{ kind:
 * "model_judge", id: string }`. `inputs` is the gathered `GoalInputs` `{
 * receipts_grounded?: boolean, plan_achieved?: boolean, state_consistent?:
 * boolean, state?: Record<string, any>, command_exits?: Record<string, number>,
 * model_verdicts?: Record<string, boolean> }`. Returns the `GoalVerdict` JSON
 * `{ met: boolean, grounded: boolean, reason: string }` — `grounded` is false
 * iff a met verdict relied on a `model_judge`. A leaf whose input wasn't
 * gathered fails closed (unmet). Pure.
 */
export function evaluateGoal(requestJson: string): string;

/**
 * Intent-grounded verify-before-commit (arXiv 2601.05755 "VIGIL" — defending
 * against tool stream injection). Flags actions that drift outside the user's
 * declared intent, blocking commit when the drifting action is influenced by an
 * untrusted tool result (the injection signature). `requestJson` is `{ intent: {
 * allowed_tools?: string[], allowed_resources?: string[], forbidden_capabilities?:
 * string[] }, actions: [{ id: string, tool?: string, targets?: string[],
 * capabilities?: string[], depends_on?: string[], untrusted?: boolean }] }`.
 * Returns the `IntentReport` JSON `{ safe: boolean, commit_blocked: string[],
 * violations: [{ action, kind: "tool_out_of_intent" | "target_out_of_intent" |
 * "forbidden_capability", detail, tool_influenced: boolean, explanation }] }`.
 * Pure, zero-inference.
 */
export function checkIntent(requestJson: string): string;

/**
 * Intent-grounded verify-before-commit straight from a plan's IR actions (VIGIL
 * Slice 4 — the IR populater + check in one call). `requestJson` is `{ intent,
 * actions: Action[], untrusted_tools?: string[], untrusted_ids?: string[] }`. The
 * runtime derives the `IntentAction`s from its own IR (tool, `expected_effects` →
 * targets, dependency edges → `depends_on`, `metadata.capabilities` →
 * capabilities, `untrusted` from the supplied provenance) then runs the intent
 * check. Returns the same `IntentReport` JSON.
 */
export function checkIntentPlan(requestJson: string): string;

/**
 * Map an intent report to an enforcement disposition (VIGIL Slice 2 — the gate).
 * `reportJson` is a `checkIntent` report; `gatePolicyJson` is an optional
 * `IntentGatePolicy` `{ on_untainted_drift: "allow" | "require_approval" | "block"
 * }` (default `require_approval`). Injections (tool-stream-influenced drift) and
 * forbidden capabilities always block regardless of policy. Returns the
 * `IntentGateDecision` JSON `{ action, blocked, needs_approval, reason }`.
 */
export function gateIntent(reportJson: string, gatePolicyJson?: string): string;

/**
 * Enforce an `IntentGateDecision` against the durable approval ledger (VIGIL
 * Slice 3 — the HITL bridge). `decisionJson` is a `gateIntent` decision;
 * `approvalsJson` is an optional `ApprovalRecord[]` seeding the ledger. An
 * out-of-intent action a human approved commits; one they rejected is blocked; a
 * novel one is pending. Hard blocks (injections / forbidden capabilities) are
 * never committable. Returns the `IntentEnforcement` JSON `{ commit, blocked,
 * pending: [{ fingerprint, violation }], reason }`.
 */
export function enforceIntent(decisionJson: string, approvalsJson?: string): string;

/**
 * Plan a deterministic, budget-bounded context eviction over typed trajectory
 * episodes (`docs/proposals/context-eviction.md`, applying arXiv 2606.11213
 * "CWL" + the Governance-Decay guard, arXiv 2606.22528). The cheaper-than-
 * summarization first move when the context window fills: shed action results
 * whose effects are already persisted, preserve user turns and the active
 * reasoning frontier, and never evict a pinned constraint.
 *
 * `episodesJson` is a JSON array of `ContextEpisode` `{ id, kind: "constraint" |
 * "user_turn" | "agent_reasoning" | "action_result" | "observation", tokens?,
 * persisted?, pinned?, recency? }`; `budget` is the token ceiling. Returns the
 * `EvictionPlan` JSON `{ evicted: string[], retained_tokens, pinned_tokens,
 * within_budget }`. `within_budget = false` means even the pinned/retained floor
 * exceeds budget — the caller must fall back to summarizing compaction.
 */
export function planContextEviction(
  episodesJson: string,
  budget: number,
): string;

/**
 * Merge divergent replicas of a CRDT shared state into the single state they
 * all converge to, with strong eventual consistency
 * (`docs/proposals/convergent-shared-state.md`, applying arXiv 2510.18893
 * "CodeCRDT"). Supplies the deterministic *resolution* that complements
 * `transactionCheck`'s conflict *detection*, and the merge layer the
 * multi-device-sync design defers to.
 *
 * `replicasJson` is a JSON array of last-writer-wins maps, each `{ "<key>": {
 * value: any, version: number, replica: string } }` (per-key version, e.g. from
 * the versioned state store, plus the writing replica/agent id). Per shared key
 * the dominating `(version, replica)` wins. Returns `{ registers, state }`: the
 * merged LWW map (tags retained, so it can be merged again) and a materialized
 * `key → value` state for feeding `verify`/`simulate`. Order-independent and
 * idempotent (zero merge failures by construction).
 */
export function crdtMerge(replicasJson: string): string;

/**
 * Export a device/agent's state as a CRDT LWW map for replication — the *export*
 * half of multi-device sync (`docs/proposals/convergent-shared-state.md`).
 * `snapshotJson` is the plain state `{ key: value }` (e.g. from the state
 * store's snapshot); `versionsJson` is `{ key: version }` (per-key versions);
 * `replica` is this device/agent id. Returns the LWW map JSON `{ "<key>": {
 * value, version, replica } }`, ready to exchange between replicas and feed to
 * `crdtMerge`. Keys absent from `versionsJson` default to version 0.
 */
export function crdtExport(
  snapshotJson: string,
  versionsJson: string,
  replica: string,
): string;

/**
 * Merge replicas of a first-claim-wins claim registry for observation-driven
 * multi-agent task coordination (Slice 3 of
 * `docs/proposals/convergent-shared-state.md`). `registriesJson` is a JSON array
 * of registries `{ "<task>": { claimant, version, replica } }`; per shared task
 * the earliest `(version, replica)` claim wins. Returns `{ registry, owners: {
 * [task]: claimant } }` — the merged CRDT plus the resolved one-owner-per-task
 * view agents read to self-partition work without a coordinator. Order-independent
 * and idempotent.
 */
export function crdtMergeClaims(registriesJson: string): string;

/**
 * Rank memory-retrieval candidates by utility-aware UCB — the deterministic
 * variant of U-Mem's Semantic-Aware Thompson Sampling
 * (`docs/proposals/autonomous-memory-agents.md`, applying arXiv 2602.22406).
 * Blends each candidate's semantic `relevance` with a learned utility posterior
 * (`Beta(success+1, fail+1)`): proven-useful memories rise, untried ones get an
 * exploration bonus from their uncertainty, and it's reproducible (no RNG).
 *
 * `candidatesJson` is a JSON array of `{ id: string, relevance: number,
 * success?: number, fail?: number }`. `exploration` weights the cold-start
 * uncertainty bonus; `utilityWeight` (0..1) blends utility vs. raw relevance
 * (`0` = pure relevance, so enabling this never changes ranking unless opted
 * in). Returns the ranked JSON array `[{ id, score, relevance, utility }]`,
 * highest score first.
 */
export function utilityRank(
  candidatesJson: string,
  exploration: number,
  utilityWeight: number,
): string;

/**
 * Decide U-Mem's cost-aware knowledge cascade — the *Evolve* escalation
 * (`docs/proposals/autonomous-memory-agents.md`, applying arXiv 2602.22406).
 * Given the current confidence in a piece of knowledge and an escalation policy,
 * returns the cheapest tier (self-reflect → tool-verify → human-expert) that
 * reaches the confidence target within a cost budget — or that the answer is
 * already confident enough, or that the budget is exhausted.
 *
 * `policyJson` is `{ confidence_target: number, budget: number, tiers: [{ tier:
 * "self_reflect" | "tool_verify" | "human_expert", cost: number,
 * expected_confidence: number }] }` (tiers cheapest-first). Returns the outcome
 * JSON — one of `{ decision: "already_confident", confidence }`, `{ decision:
 * "accept", tier, confidence, cost_spent }`, or `{ decision: "exhausted",
 * best_tier, confidence, cost_spent }`. Pure decision core; the caller runs the
 * chosen tier (`reflect()`, tools, or the HITL approval ledger).
 */
export function cascadeDecide(
  currentConfidence: number,
  policyJson: string,
): string;

/**
 * Diagnose a memory system along the four system-level dimensions of *Are We
 * Ready For An Agent-Native Memory System?*
 * (`docs/proposals/agent-native-memory-diagnostic.md`, applying arXiv
 * 2606.24775): representation fidelity, retrieval precision, update correctness,
 * long-horizon stability. Scores the memory store as a data system rather than
 * by end-to-end task success, and names the bottleneck module to invest in next.
 *
 * `statsJson` is aggregate counters (parsed by serde — keys are snake_case):
 * `{ total_facts, structured_facts, total_edges, total_retrievals,
 * total_proactive_injections, helpful_retrievals, conflicts_resolved,
 * outstanding_outdated, facts_created, facts_superseded }` (omitted fields
 * default to 0). `total_retrievals` counts DELIBERATE recalls only;
 * harness-initiated proactive injections are reported separately as
 * `total_proactive_injections` and never feed ranking (car#816).
 * `helpful_retrievals` is always 0 today — `record_fact_helpful` has no
 * production caller — so read a 0 there as "not wired", not "nothing helped". Returns the report JSON:
 * `{ representation_fidelity, retrieval_precision, update_correctness,
 * long_horizon_stability, overall }` (each 0..1), `bottleneck` (one of
 * `"representation" | "retrieval" | "update_correctness" |
 * "long_horizon_stability" | "none"`), `recommendation`, and `evaluated`.
 */
export function memorySystemDiagnose(statsJson: string): string;

/**
 * Decide localized-vs-global memory maintenance
 * (`docs/proposals/agent-native-memory-diagnostic.md`, applying arXiv
 * 2606.24775's finding that localized maintenance is more cost-efficient than
 * global reorganization). Both strategies resolve the dirty regions; global only
 * wins when its store-wide structural gain (valued) clears the extra cost of
 * touching the whole store.
 *
 * `inputJson` is (serde snake_case keys) `{ dirty_regions, total_regions,
 * localized_cost_per_region, global_cost_per_region, global_structural_gain,
 * gain_value }` (omitted fields default to 0). Returns the decision JSON:
 * `{ strategy: "no_op" | "localized" | "global", localized_cost, global_cost,
 * global_extra_value, global_net_advantage, rationale }`.
 */
export function maintenanceDecide(inputJson: string): string;

/**
 * Plan an evolution cycle — the survey's *when + what to evolve* (arXiv
 * 2507.21046, *A Survey of Self-Evolving Agents*). `requestJson` is `{ components:
 * [{ component: "memory" | "skills" | "harness" | "context" | "tools", pressure?,
 * evidence?, min_evidence?, cost? }], policy?: { pressure_threshold?, budget? } }`.
 * Returns the `EvolutionPlan` JSON `{ decisions: [{ component, action:
 * "evolve_now" | "defer" | "skip", priority, defer_reason?, reason }], spent,
 * evolve_now }`. Evolves only under pressure, only with enough evidence,
 * prioritized by `pressure / cost` within the budget.
 */
export function planEvolution(requestJson: string): string;

/**
 * Rebuild `(stateBefore, action, stateAfter)` transitions from a JSONL tail
 * of a session's event log — the trajectories CAR already records, turned
 * into the unit-test records `cwmScore` consumes. Folds the recorded
 * `StateChanged` deltas (`data.changes`) over `initialStateJson` in log
 * order.
 *
 * `actionsJson` (optional) is a JSON object mapping an action id → the action
 * JSON to attach (pass a proposal's actions so a transition carries
 * `tool`/`parameters`); absent a match the action is `{ id }`. Lines that
 * don't parse as events are skipped. Returns a JSON array of transitions.
 */
export function cwmTransitionsFromEvents(
  eventsJsonl: string,
  initialStateJson?: string | null,
  actionsJson?: string | null,
): string;

/**
 * Predictive simulation (Code World Models Slice 2 of
 * `docs/proposals/code-world-models.md`). Like the static simulator, but
 * applies per-action effect predictions from a verified Code World Model,
 * gated by accuracy — turning `simulate`'s placeholder-propagation into a
 * predicted final state.
 *
 * `proposalJson` is an `ActionProposal`; `initialStateJson` (optional) seeds
 * state; `predictionsJson` maps `actionId` → `{ effects: { key: value, ... },
 * accuracy: number }`, where `effects` are what the caller's run of the
 * generated model predicts the action writes. A prediction is applied only
 * when `accuracy >= minAccuracy`; otherwise — and for any action with no
 * prediction — the simulator falls back to that action's declared
 * `expectedEffects` (i.e. the static `simulate` behavior). An under-accurate
 * model therefore can never worsen the result; at worst it is ignored.
 *
 * Returns the final state as a JSON object.
 */
export function simulateWithPredictions(
  proposalJson: string,
  initialStateJson: string | null | undefined,
  predictionsJson: string,
  minAccuracy: number,
): string;

/**
 * Compute harness-level evaluation metrics (survey "Code as Agent Harness"
 * §5.2.1) from a JSONL tail of a session's event log (one event per line).
 * Returns the `HarnessMetrics` JSON with six operational-substrate
 * dimensions — `trajectory_efficiency` (actions, tokens, cost, wall-clock,
 * success_rate), `verification_strength` (validated/rejected, rejection_rate),
 * `recovery` (replans, branch decisions, rejected alternatives),
 * `state_consistency` (changes, snapshots, rollbacks), `safety`
 * (permission escalations/denials/approvals), and `replayability` — to
 * complement task-success accuracy when comparing harness variants.
 *
 * The optional `task_pass_rate` field — and its two companions,
 * `task_pass_denominator` (how many tasks that rate is over) and
 * `tasks_unrunnable` (how many the runner could not measure) — are **always
 * absent** from this result: end-task success is not in the event stream (the
 * log records what ran, not whether the task was satisfied), and inventing any
 * of the three here would hand the regression gate a fabricated number. Only a
 * runner holding the task suite and its grading criteria can supply them —
 * `car-bench-harness --metrics-out` does. Absent means *not measured*, never
 * zero.
 */
export function harnessMetrics(eventsJsonl: string): string;

/**
 * Detect tool-result hallucinations by cross-checking the model's claims about
 * tool use against the runtime's receipts of what actually executed
 * (`docs/proposals/tool-receipt-verification.md`, applying arXiv 2603.10060
 * "Tool Receipts"). Deterministic and zero-inference — the runtime owns the
 * ground truth, so the model can't fake a receipt.
 *
 * `claimsJson` is a JSON array of `ToolClaim` `{ kind: "invoked" | "count" |
 * "absence", tool: string, call_id?, count?, text? }`; `receiptsJson` is a JSON
 * array of `ToolReceipt` `{ tool: string, call_id?, ok?, result_count? }`.
 * `windowComplete` (default `true`) declares whether the receipts cover the
 * full window the claims are about — pass `false` when they were projected
 * from a retention-trimmed log, so a receiptless claim is reported in
 * `ungroundable` ("window evicted") instead of accused as fabricated.
 * Returns the `ReceiptReport` JSON `{ grounded: boolean, hallucinations: [{
 * kind: "fabricated_tool_reference" | "count_misstatement" | "false_absence",
 * tool, claim_text?, explanation }], ungroundable?: [{ tool, claim_text?,
 * explanation }] }`.
 */
export function verifyToolReceipts(
  claimsJson: string,
  receiptsJson: string,
  windowComplete?: boolean | undefined | null,
): string;

/**
 * Diagnose runtime-harness interventions from a JSONL event-log tail
 * (`docs/proposals/runtime-harness-adaptation.md`, applying arXiv 2605.22166
 * "Adapting the Interface, Not the Model"). Converts *recurring* interaction
 * failures into typed, reusable fixes across Life-Harness's four lifecycle
 * layers — `environment_contract` (calibrate a tool's description/constraints),
 * `action_realization` (normalize malformed calls), `trajectory_regulation`
 * (circuit-break runtime-failure / retry / replan thrash), and
 * `procedural_skill` — i.e. "fix the harness, not the model". Complements
 * `evolutionDiagnose` (which gates/applies mutations); this is the diagnosis
 * pass over trajectories.
 *
 * `minOccurrences` is the recurrence threshold (one-offs are noise; pass 2 for
 * "recurring"). Returns the `AdaptationReport` JSON `{ interventions: [{ layer,
 * target, trigger, intervention, evidence_count }], parse_errors }`, sorted by
 * evidence descending.
 */
export function diagnoseHarnessInterventions(
  eventsJsonl: string,
  minOccurrences: number,
): string;

// --- Agentic Harness Engineering: Evolution Agent (survey §3.5, §5.2.3) ---
//
// A governed meta-agent that proposes harness mutations from telemetry and
// gates their adoption. Every mutation carries a change contract; promotion
// is regression-gated; safety-affecting changes require human approval.

/**
 * Diagnose harness telemetry into governed mutation proposals. `metricsJson`
 * is a `HarnessMetrics` (from {@link harnessMetrics}); `configJson`
 * optionally overrides the diagnosis thresholds. Returns a JSON array of
 * `HarnessMutation`, each `{ id, rationale, contract: { component,
 * target_failure, predicted_improvement, invariants, falsifying_eval,
 * rollback } }`. Nothing is applied — proposals must pass
 * {@link evolutionEvaluate} and, when safety-affecting, human approval.
 */
export function evolutionDiagnose(
  metricsJson: string,
  configJson?: string | null,
): string;

/**
 * Regression-gate a candidate harness mutation. `mutationJson` is a
 * `HarnessMutation`; `baselineJson`/`candidateJson` are `HarnessMetrics`
 * measured before/after applying it on held-out telemetry. Returns the
 * `PromotionDecision` JSON `{ decision: "promote" | "needs_approval" |
 * "reject" | "incomparable", reason }` — a mutation is promoted only if its
 * target improved without regressing guarded metrics; safety-affecting
 * mutations route to `needs_approval` even when they pass.
 *
 * Reliability is guarded twice, because the two available measures are
 * different quantities. `task_pass_rate` is end-task success and is checked
 * first, but only when BOTH documents carry it (absent on either side = not
 * measured, so the guard does not fire rather than defaulting to 0.0 or 1.0).
 * `trajectory_efficiency.success_rate` is tool-attempt success and is always
 * checked. A candidate that cuts tokens by abandoning hard tasks earlier holds
 * a perfect attempt-level rate while solving fewer tasks — only the first guard
 * sees that.
 *
 * Before either guard, the two pass rates must be over the SAME task set.
 * `HarnessMetrics` carries two optional companions to `task_pass_rate`:
 * `task_pass_denominator` (how many tasks the rate is over) and
 * `tasks_unrunnable` (how many the runner could not measure). When both
 * documents carry a denominator and they differ, the result is
 * `incomparable` — no verdict, nothing applied. That is not pedantry: a
 * harness that loses a capability also loses the ability to *measure* the
 * tasks needing it, so those tasks leave the denominator and the surviving
 * rate goes up. Both fields are optional and absent from documents written
 * before they existed, in which case the check is skipped rather than
 * failing.
 */
export function evolutionEvaluate(
  mutationJson: string,
  baselineJson: string,
  candidateJson: string,
  configJson?: string | null,
): string;

/**
 * Apply a mutation's concrete patch to a `HarnessConfig` under governed
 * authorization (survey §3.5/§5.2.3). `humanApproved=true` applies under the
 * HITL path — the only path that may land a safety-affecting mutation;
 * otherwise `decisionJson` (a `PromotionDecision`) must be `promote` and the
 * mutation must be non-safety. Returns `{ config, rollback }` (the updated
 * config and the inverse patch that restores it), or throws when refused.
 */
export function evolutionApply(
  configJson: string,
  mutationJson: string,
  decisionJson?: string | null,
  humanApproved?: boolean,
): string;

// --- Permission-tier gate (survey "Code as Agent Harness" §3.4.3, §5.2.5) ---
//
// The harness as safety governor: classify each action's risk tier
// (read_only | sandbox_edit | full_access), gate it against the session's
// granted standing tier, and record human-in-the-loop approvals as durable,
// auditable state (a JSONL ledger keyed by a stable action fingerprint).
//
// Two axes, not one. The tier answers "who may authorize this?" and says
// nothing about whether the effect can be undone — a `git push`, a production
// INSERT, and a charged card are all `full_access` with three different
// rollback contracts. Every row below therefore carries a `reversibility`
// alongside its `required_tier`.
//
// The matching Action IR fields (any `proposalJson` this package accepts, and
// the full spec in docs/agent-ir-spec.md):
//
//   "reversibility": "reversible" | "compensable" | "irreversible"
//       Optional. The rollback contract for this action's effects.
//       `reversible` is undone by restoring the scope it ran in;
//       `compensable` needs a compensating action run against it;
//       `irreversible` cannot be undone once it reaches the world.
//       **Defaults to "irreversible"** when omitted — deliberately, because
//       the default decides what the runtime believes about an unclassified
//       action and the two directions fail asymmetrically. Guessing
//       "reversible" wrongly means silently believing a sent email can be
//       unsent; guessing "irreversible" wrongly means over-asking for an
//       approval on something recoverable, which is annoying, visible, and
//       fixed locally by annotating the action.
//
//   "compensation": { "type": "tool", "tool": string, "parameters"?: object }
//                 | { "type": "action_ref", "action_id": string }
//       Optional. How to undo the action once it has run — the action-level
//       analogue of car-workflow's saga CompensationHandler. Meaningful only
//       with `"reversibility": "compensable"`; omitted from the serialized
//       form when absent, so older consumers see the payload they saw before.
//       Declaring one is a *claim*: nothing checks that the named tool is a
//       true inverse, exactly as nothing checks `expected_effects`.
//
// Nothing in the runtime enforces on either field yet — they are typed,
// classified, and audited. Do not read `"reversible"` as a promise that the
// runtime will undo anything for you: rollback restores the state map and
// leaves whatever a tool wrote to disk where it is. See
// docs/proposals/shepherd-substrate-adoption.md.

/**
 * Classify each action in a proposal on both authorization-adjacent axes.
 * Returns a JSON array of `{ action_id, tool, required_tier, reversibility,
 * missing_compensation }`. The keys live inside a JSON string, so they stay
 * snake_case — napi-rs camelCases function and parameter names, not payload
 * contents.
 *
 * - `required_tier` — **who may authorize this**: `"read_only" |
 *   "sandbox_edit" | "full_access"`.
 * - `reversibility` — **can this be undone**: `"reversible" | "compensable" |
 *   "irreversible"`. Independent of the tier and not derived from it:
 *   `read_secret` is `full_access` and perfectly reversible (a read leaves
 *   nothing to undo), while `send_email` and `deploy_service` are both
 *   `full_access` and differ completely. This is the classifier's answer from
 *   the tool name and flattened parameters — **not** an echo of the action's
 *   declared `reversibility` field, which defaults to `"irreversible"` and so
 *   would tell you only what you sent. It is a keyword heuristic: an
 *   unrecognized tool comes back `"irreversible"`, deliberately.
 * - `missing_compensation` — the action **declared** `"compensable"` and
 *   supplied no `compensation`, the one incoherent combination the IR cannot
 *   exclude by construction. Keyed off the declared field, so it stays `false`
 *   for proposals that never opted into the axis.
 *
 * Severity ascends `"reversible" < "compensable" < "irreversible"`, so the
 * rollback contract of a whole batch is the worst row — a plan is only as
 * recoverable as its least recoverable step. (The daemon's `permission.classify`
 * returns that roll-up precomputed as `declared_rollback_contract`, over the
 * *declared* fields; this function returns a bare array with nowhere to hang
 * it, so compute it from the column you care about.)
 *
 * Nothing in the runtime gates on the second axis yet — it is typed,
 * classified, and audited, not enforced.
 */
export function permissionClassify(proposalJson: string): string;

/**
 * Evaluate each action against a granted standing tier, consulting the
 * durable approval ledger JSONL at `ledgerPath` when supplied. Returns a
 * JSON array of per-action decisions, each `{ decision, required, granted,
 * action_id, fingerprint, reversibility, ... }` where `decision` is `"allow" |
 * "needs_approval" | "deny"`. A `needs_approval` decision means autonomy is
 * suspended pending a human decision; resolve it with
 * {@link permissionRecordForFingerprint}.
 *
 * `reversibility` is orthogonal to `decision` and rides on **every** row, the
 * `allow`s included: the gate's verdict says whether the action may run, not
 * whether it could be taken back afterwards, and a caller that only learns the
 * rollback contract of the actions it was stopped on is missing exactly the
 * rows an incident review reads first. Same field, labels, and classifier as
 * the `PermissionDecision` event the engine writes to its audit log.
 */
export function permissionEvaluate(
  proposalJson: string,
  grantedTier: string,
  ledgerPath?: string | null,
): string;

/**
 * Record a durable human-in-the-loop approval (`approve=true`) or rejection
 * for the operation an action represents, appending it to the JSONL ledger
 * at `ledgerPath`. The decision persists and overrides future evaluations
 * of the same operation. Returns the stored approval record JSON.
 */
export function permissionRecordDecision(
  actionJson: string,
  approve: boolean,
  reviewer: string,
  reason: string,
  evidence: string | undefined | null,
  ledgerPath: string,
): string;

/**
 * Like {@link permissionRecordDecision} but keyed by an explicit
 * `fingerprint` (from a prior `needs_approval` decision) with an annotating
 * `requiredTier`. Returns the stored approval record JSON.
 */
export function permissionRecordForFingerprint(
  fingerprint: string,
  requiredTier: string,
  approve: boolean,
  reviewer: string,
  reason: string,
  evidence: string | undefined | null,
  ledgerPath: string,
): string;

// --- Multi-agent coordination ---

/**
 * Register the agent runner callback for multi-agent and scheduler functions.
 * Call once before using `runSwarm`, `runPipeline`, `runSupervisor`, etc.
 *
 * `agentFn(specJson, taskJson) => Promise<AgentOutput JSON>`
 */
export function registerAgentRunner(
  agentFn: (specJson: string, taskJson: string) => Promise<string>,
): Promise<void>;

// --- Inference runner (delegated inference, closes car-releases#24) ---
//
// In-process registration is not exposed in the FFI bindings (car-releases#55).
// The v0.8+ daemon-only architecture moves delegated inference to the
// WebSocket protocol: a runner client connects to car-server and calls
// `inference.register_runner`; the daemon then sends
// `inference.runner.invoke` notifications for every delegated call.
// See docs/websocket-protocol.md §"Inference runner" for the wire shape.
// `car-server` is shipped as a binary in this npm package (`bin/car-server`).

/**
 * Coordination budget — a runtime-enforced spend ceiling for one multi-agent
 * run. Passed to the `run*` functions as a JSON string (`JSON.stringify`).
 * Every field is optional; an omitted field is unbounded.
 *
 * The runtime sums the token/cost spend reported by the agent runner and
 * refuses to START further agents once a limit is crossed (overshoot is bounded
 * by the in-flight work already launched). `maxAgents` is a hard cap on agents
 * started. Note: these are snake_case JSON keys, matching the Rust `BudgetLimits`.
 *
 * ```ts
 * const budget = JSON.stringify({ max_total_tokens: 200000, max_agents: 12 });
 * await runSwarm("parallel", agents, task, null, budget);
 * ```
 */
export interface BudgetLimits {
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  max_total_tokens?: number | null;
  max_cost_usd?: number | null;
  max_agents?: number | null;
}

/**
 * Run a Swarm pattern. `mode` is "parallel", "sequential", or "debate".
 * `budgetSpec` is an optional JSON-encoded {@link BudgetLimits}.
 */
export function runSwarm(
  mode: string,
  agents: string,
  task: string,
  synthesizerSpec?: string | null,
  budgetSpec?: string | null,
): Promise<string>;

export function runPipeline(
  stages: string,
  task: string,
  budgetSpec?: string | null,
): Promise<string>;

export function runSupervisor(
  workers: string,
  supervisor: string,
  task: string,
  maxRounds: number,
  budgetSpec?: string | null,
): Promise<string>;

export function runMapReduce(
  mapper: string,
  reducer: string,
  task: string,
  items: string,
  budgetSpec?: string | null,
): Promise<string>;

export function runVote(
  agents: string,
  task: string,
  synthesizerSpec?: string | null,
  budgetSpec?: string | null,
): Promise<string>;

/**
 * Run a Tournament pattern: rank `competitors` (AgentSpec[] JSON) by
 * single-elimination pairwise judging with a `judge` (AgentSpec JSON). Returns
 * TournamentResult JSON ({ winner_name, winner_answer, ranking, matches, ... }).
 * `budgetSpec` is an optional JSON-encoded {@link BudgetLimits}.
 */
export function runTournament(
  competitors: string,
  judge: string,
  task: string,
  budgetSpec?: string | null,
): Promise<string>;

/**
 * Run an agent that can spawn isolated, tool-constrained sub-agents via the
 * `spawn_subtask` tool. `mainAgent` is the main AgentSpec JSON; a spawned
 * sub-agent may only use a subset of its tools (enforced by the tool schema's
 * `enum` and re-checked at execution). `budgetSpec` is an optional JSON-encoded
 * {@link BudgetLimits} that also caps the sub-agents this agent may spawn.
 * Returns SpawnSubtaskResult JSON.
 */
export function runSubtask(
  mainAgent: string,
  task: string,
  budgetSpec?: string | null,
): Promise<string>;

// --- Scheduler ---

/** Create a task definition. Returns task JSON. */
export function createTask(
  name: string,
  prompt: string,
  trigger?: string | null,
  schedule?: string | null,
  systemPrompt?: string | null,
): string;

/**
 * Preview the durable OS-level schedule (launchd plist + crontab line) a task
 * would install, without installing it. `program` + `argsJson` (a JSON string
 * array) are the command the OS runs to execute the task once. Returns
 * `{ label, launchdPlist, launchdError, crontabLine, crontabError }`.
 */
export function renderOsSchedule(taskJson: string, program: string, argsJson: string): string;

/**
 * Analyze a static execution DAG as a scheduler
 * (`docs/proposals/scheduler-graph-analysis.md`, applying arXiv 2604.11378 "From
 * Agent Loops to Structured Graphs"). Makes a plan's schedule inspectable before
 * running it: critical path, makespan, available parallelism, topological waves,
 * cycle detection, and the serial "Agent-Loop pathology" flag.
 *
 * `graphJson` is a `ScheduleGraph` `{ units: [{ id: string, duration?: number,
 * depends_on?: string[] }] }`. Returns the `ScheduleAnalysis` JSON `{ has_cycle:
 * boolean, critical_path: string[], makespan: number, max_parallelism: number,
 * levels: string[][], serial: boolean }`. `serial` is true when the plan
 * collapses to one-unit-at-a-time; `has_cycle` flags a never-terminating plan.
 */
export function analyzeSchedule(graphJson: string): string;

/**
 * Install a durable OS-level schedule (launchd on macOS, crontab on Linux) so
 * the task fires even when the CAR daemon is down. Idempotent. Returns the
 * installed-schedule JSON.
 */
export function installOsSchedule(taskJson: string, program: string, argsJson: string): string;

/** Remove a task's OS-level schedule (full label or bare task id). Returns `{ label, removed }`. */
export function uninstallOsSchedule(labelOrId: string): string;

/** List labels of all CAR-managed OS-level schedules on this host (JSON string array). */
export function listOsSchedules(): string;

/**
 * Reap orphaned OS-level schedules — uninstall every CAR-managed launchd/cron
 * entry whose task is gone from `~/.car/tasks/` or whose trigger is no longer
 * schedulable. Returns the reconcile report `{ removed, kept, errors }`.
 */
export function reconcileOsSchedules(): string;
/** Schedule a deterministic command on a cadence, hiding the OS backend (#72).
 *  specJson = { name, program, args?, cadence: { intervalSecs? | cron? },
 *  durable?, workingDir?, env?, permissionTier? }.
 *  Returns { id, durable, backend: "launchd"|"cron"|"schtasks"|"daemon", task }. */
export function scheduleTask(specJson: string): string;
/** List deterministic (command) scheduled tasks with their resolved backend. */
export function listScheduledTasks(): string;
/** Unschedule a deterministic task — remove any OS schedule + delete from the store. */
export function unscheduleTask(idOrLabel: string): string;

/** Run a task once using the registered agent runner. */
export function runTask(taskJson: string): Promise<string>;

/** Run a task loop using the registered agent runner. */
export function runTaskLoop(
  taskJson: string,
  maxIterations?: number | null,
): Promise<string>;

/**
 * Ensure a dream (memory consolidation) task exists in `~/.car/tasks/`.
 * Returns true if a new task was created, false if one already existed.
 */
export function ensureDreamTask(): boolean;

// --- Planner ---

/**
 * Score and rank candidate proposals. Returns JSON array of ScoredProposal.
 * `candidatesJson` is a JSON array of ActionProposal objects.
 * `tools` is an optional array of registered tool names.
 */
export function rankProposals(
  candidatesJson: string,
  tools?: string[] | null,
  costWeight?: number | null,
): string;

// --- macOS automation (car-automation) ---
//
// AppleScript / JXA / Shortcuts bridges. Subprocess-backed so the
// surface is uniform across binding layers. On non-macOS hosts each
// call rejects with a PlatformUnsupported error.

/**
 * Run an AppleScript or JXA snippet via `osascript`.
 *
 * `argsJson` shape:
 * ```jsonc
 * {
 *   "script": "return 1 + 2",
 *   "language": "applescript" | "javascript",  // optional, default applescript
 *   "args": ["positional", "args"],             // optional
 *   "timeout_ms": 5000                          // optional
 * }
 * ```
 *
 * Returns JSON `{stdout, stderr, exit_code}`. Rejects with the
 * subprocess stderr on non-zero exit.
 */
export function runApplescript(argsJson: string): Promise<string>;

/**
 * Run a Windows PowerShell script via `powershell.exe` — the Windows analog
 * of `runApplescript`. Drives the host desktop and its apps (toast, clipboard,
 * COM, UI Automation).
 *
 * `argsJson` shape:
 * ```jsonc
 * {
 *   "script": "Get-Date",
 *   "timeout_ms": 5000   // optional
 * }
 * ```
 *
 * Returns JSON `{stdout, stderr, exit_code}`. Rejects with a
 * PlatformUnsupported error on non-Windows hosts.
 */
export function runPowershell(argsJson: string): Promise<string>;

/**
 * Enumerate Shortcuts (user-authored *and* AppShortcuts donated by
 * apps via the App Intents framework). Returns an array of
 * `{name, identifier?, tool_slug, tool_description, parameters_schema}`,
 * suitable for registering each as a runtime tool.
 *
 * `argsJson` shape: `{ folder?: string, with_identifiers?: boolean }`.
 */
export function listShortcuts(argsJson: string): Promise<string>;

/**
 * Invoke a Shortcut by name or UUID. `argsJson` shape:
 * ```jsonc
 * {
 *   "name_or_id": "Shazam shortcut" | "43E9-...",
 *   "input": "optional text input",            // optional
 *   "output_type": "public.plain-text",         // optional UTI
 *   "timeout_ms": 30000                         // optional
 * }
 * ```
 * Returns JSON `{stdout, stderr, exit_code}`.
 */
export function runShortcut(argsJson: string): Promise<string>;

// --- Local notifications ---

/**
 * Deliver a user-visible local notification.
 *
 * `argsJson` shape: `{ title: string, body: string, subtitle?: string, sound?: string }`.
 * Returns JSON `{delivered, platform, backend}`. iOS delivery is owned
 * by the signed host app via UserNotifications.
 */
export function localNotification(argsJson: string): Promise<string>;

// --- Vision OCR (car-vision) ---

/**
 * Apple Vision-framework on-device text recognition.
 *
 * `argsJson` shape:
 * ```jsonc
 * {
 *   "image_path": "/path/to/screen.png",
 *   "fast_path": false,                  // optional; true = .fast vs .accurate
 *   "languages": ["en-US"],              // optional BCP-47 hints
 *   "language_correction": true,         // optional, default true
 *   "minimum_text_height": 0.0           // optional, normalized; floors tiny noise
 * }
 * ```
 *
 * Returns JSON `{available, observations}`. `available` is `false`
 * when the Vision shim wasn't built into this binary (non-macOS or
 * skipped Swift compile); in that case `observations` is an empty
 * array rather than an error.
 */
export function visionOcr(argsJson: string): Promise<string>;

// --- In-process A2A dispatcher (car_a2a) ---

/**
 * Dispatch one A2A v1.0 method against the in-process singleton
 * dispatcher. `method` is the spec method name (`"message/send"`,
 * `"tasks/get"`, etc., or PascalCase aliases like `"SendMessage"`);
 * `paramsJson` is the per-method `params` payload. Returns the
 * JSON-stringified result.
 *
 * Streaming methods (`message/stream`, `tasks/resubscribe`) return
 * a `MethodNotFound` error from the dispatcher's transport-neutral
 * surface. HTTP+SSE is the supported transport for streaming and
 * lives outside this FFI wrapper.
 *
 * Distinct from the daemon's WS A2A surface — both are valid; using
 * both in one process gives you two task stores (task ids are
 * unique per dispatcher).
 */
export function a2ADispatch(rt: CarRuntime, method: string, paramsJson: string): Promise<string>;

// --- Lifecycle-managed agents (car_registry::supervisor) ---

/**
 * List every managed agent in `~/.car/agents.json` along with its
 * runtime status. Returns JSON `[ManagedAgent]`.
 *
 * Wire shape matches the daemon's `agents.list` JSON-RPC method
 * exactly so a host can swap between in-process and WS transports
 * without reshaping payloads.
 */
export function agentsList(): Promise<string>;

/**
 * Re-validate every managed agent's `command` against the
 * supervisor's `validate_command` rules — used to surface specs that
 * broke after a system upgrade (Node moved versions, Homebrew pruned
 * a symlink). Returns JSON `[{ id, command, ok, reason? }]`.
 *
 * Pairs with the `interpreter` sugar on `agentsUpsert`: hosts that
 * resolve at upsert can re-resolve when health fires `ok: false`.
 */
export function agentsHealth(): Promise<string>;

/**
 * Add or replace an agent's spec. Persists `~/.car/agents.json`.
 * The agent is NOT auto-started — call `agentsStart` (or
 * `auto_start: true` will pick it up on the next boot via the
 * supervisor's `start_all`).
 *
 * `specJson`:
 * ```jsonc
 * {
 *   "id": "trader",                 // filename-safe
 *   "name": "Trader",
 *   "command": "/opt/homebrew/bin/node", // absolute path required
 *   // OR: omit `command` and pass `interpreter: "node" | "python" | ...`
 *   //     and the supervisor resolves the interpreter against $PATH
 *   //     once at upsert and stores the absolute path in `command`.
 *   "args": ["server.js"],
 *   "cwd": "/path/to/project",       // optional
 *   "env": { "K": "V" },             // merged on top of parent's env
 *   "restart": "on_failure",         // never | on_failure | always
 *   "max_restarts": 10,
 *   "backoff_secs": 5,
 *   "auto_start": true               // included by start_all on boot
 * }
 * ```
 *
 * Returns JSON `ManagedAgent`.
 */
export function agentsUpsert(specJson: string): Promise<string>;

/**
 * Install a contributed-agent `AgentManifest` (Parslee-ai/car#182
 * phase 3). Runs install-time validation against the daemon's
 * default host capability advertisement:
 *
 * - `runtime.car_min_version` must be satisfied by the runtime's
 *   own semver.
 * - Every `capabilities.required[namespace][feature]` must be
 *   advertised by the host. Fail-closed on any miss.
 * - `capabilities.optional` is reported back as `missingOptional`
 *   when the host can't satisfy it — informational, not blocking.
 *
 * For `external_process` manifests with a `command`, the
 * supervisor adopts the agent and returns it. For `pure_data`
 * and `health_url`-only manifests, the manifest is written to
 * `~/.car/agents/<id>/manifest.toml` but no `AgentSpec` is
 * adopted (the supervisor only spawns command-shaped externals
 * in this phase).
 *
 * Returns JSON
 * `{report: {missingOptional: [{namespace, feature}]}, agent: ManagedAgent|null}`.
 */
export function agentsInstall(manifestJson: string): Promise<string>;

/**
 * Remove an agent's spec. Stops the running child first if it's up.
 * Idempotent — `{removed: false}` when nothing matched.
 * Returns JSON `{removed: boolean}`.
 */
export function agentsRemove(id: string): Promise<string>;

/**
 * Spawn the agent's child if not already running. No-op when
 * already `Running` or `Starting`. Resets `restart_count`.
 * Returns JSON `ManagedAgent`.
 */
export function agentsStart(id: string): Promise<string>;

/**
 * Stop the agent and prevent the supervisor from respawning it.
 * `signal` is `"term"` (SIGTERM with grace, default) or `"kill"`
 * (SIGKILL immediately). Returns JSON `ManagedAgent`.
 */
export function agentsStop(id: string, signal?: string | null): Promise<string>;

/**
 * Stop then start. Equivalent to `agentsStop` followed by
 * `agentsStart`. Returns JSON `ManagedAgent`.
 */
export function agentsRestart(id: string): Promise<string>;

/**
 * Block until a managed agent reaches one of `targetsJson` (a JSON string array
 * of statuses like `["running"]` or `["stopped","errored"]`; default
 * `["running"]`) or `timeoutSecs` (default 30) elapses, polling every `pollMs`
 * (default 200). Returns the matching `ManagedAgent` JSON; rejects on timeout or
 * unknown id.
 */
export function agentsWait(
  id: string,
  targetsJson?: string | null,
  timeoutSecs?: number | null,
  pollMs?: number | null,
): Promise<string>;

/**
 * Read a window of an agent's logs under
 * `~/.car/logs/<id>.{stdout,stderr}.log`.
 *
 * - `n` caps lines per included stream (default 100; `0` ⇒ whole file,
 *   still bounded by the tail byte ceiling below).
 * - `stream` selects `"stdout"`, `"stderr"`, or `"combined"` (default).
 *   Each stream is tailed independently, so a long stale stderr can no
 *   longer bury live stdout (Parslee-ai/car#273).
 * - `offset` pages back: skip this many lines from the end of each
 *   stream before taking the window (`offset = n` ⇒ previous page).
 *   Combined-view paging is not order-preserving — page within a single
 *   stream to scroll back.
 *
 * Each stream is read via a bounded backward seek (at most an 8 MiB
 * tail), not a whole-file slurp, since agent logs are append-only and
 * never rotated. A log larger than the ceiling is truncated to its last
 * 8 MiB and `more` is forced `true`.
 *
 * Returns JSON `{ lines: string[], stdout: string[], stderr: string[],
 * stdoutTotal: number, stderrTotal: number, stdoutPath: string,
 * stderrPath: string, more: boolean }`. `lines` keeps the legacy
 * stdout-then-stderr combined view for back-compat. `stdoutTotal` /
 * `stderrTotal` count lines in the scanned tail (exact within the
 * ceiling).
 */
export function agentsTailLog(id: string, n?: number | null, stream?: string | null, offset?: number | null): Promise<string>;

// --- External-agent detection (car-external-agents) ---
//
// Phase 1 of docs/proposals/external-agent-detection.md — discover
// installed agentic CLIs (Claude Code, Codex, Gemini) and report
// version + auth-kind heuristic. Per-task invocation lands in Phase 2
// alongside `agents.invoke_external`. Wire shape:
//
//   {
//     "id": "claude-code" | "codex" | "gemini",
//     "displayName": "Claude Code" | ...,
//     "binaryPath": "/usr/local/bin/claude",
//     "version": "1.0.51" | null,
//     "authKind": "subscription" | "api_key" | "unknown" | "unauthenticated",
//     "capabilities": { toolUse, mcp, hooks, sessions, streaming },
//     "detectedAt": <unix-secs>
//   }

/**
 * Cached snapshot of installed external agents. First call triggers
 * a detection pass; subsequent calls return the cached list. Pass
 * `includeHealth: true` to also populate each spec's `health` field
 * via the tool's auth-status command — slower (one subprocess
 * spawn per detected adapter) but gives a one-stop "what's
 * installed AND ready to use" answer. Returns JSON
 * `[ExternalAgentSpec]` (empty array when nothing installed).
 *
 * `ExternalAgentSpec.execution` (car#746) is the authoritative answer to
 * "can this binary run at all":
 *     { state: "runnable" }
 *   | { state: "unusable", reason: string, checked_at: number }
 * Written by detection, never revised by a health refresh. `health`
 * answers a different question (is it authenticated) and is owned by
 * refreshers that may rewrite it. Prefer `execution` over
 * `health.status === "not_executable"`, which is still emitted for one
 * compatibility window. An absent `execution` reads as "runnable".
 *
 * `ExternalAgentSpec.health` shape (when populated):
 *   { id, status, details, reason?, checked_at }
 *   status: "ready" | "not_configured" | "expired" | "network_error"
 *         | "not_executable" | "unknown"
 *
 * `health` is also populated **without** `includeHealth` in one case:
 * when detection finds the binary but proves it cannot be executed,
 * the spec comes back with `status: "not_executable"` and a `reason`
 * naming the path. Do not invoke a spec in that state — it will be
 * killed at exec. Typical cause on macOS is Gatekeeper quarantine on
 * a binary installed outside the App Store.
 *
 * The `auth_kind` field is **deprecated** (Phase 2 stage 1) — modern
 * builds keep credentials in OS keystores so the heuristic falls
 * through to "unknown" for the most common installs. Prefer `health`.
 */
export function agentsListExternal(
  includeHealth?: boolean | null,
): Promise<string>;

/**
 * Force re-detection of installed external agents. Updates the
 * presence cache and returns the new snapshot. Pass
 * `includeHealth: true` to also run ground-truth health checks
 * (force-refreshing the per-tool 30s TTL cache). Returns JSON
 * `[ExternalAgentSpec]`.
 */
export function agentsDetectExternal(
  includeHealth?: boolean | null,
): Promise<string>;

/**
 * Ground-truth health check via each tool's own auth-status command
 * (`claude auth status`, `codex login status`). Replaces the Phase 1
 * credential-file shape heuristic as the primary signal for "is this
 * tool ready to invoke." Pass an `id` to check one adapter; omit it
 * to check every detected adapter. `force: true` bypasses the 30s
 * per-tool TTL cache.
 *
 * Wire shape: `[ExternalAgentHealth]` (when `id` omitted) or
 * `ExternalAgentHealth` (when `id` supplied), where:
 *
 *   {
 *     "id": "claude-code" | "codex" | "gemini",
 *     "status": "ready" | "not_configured" | "expired" |
 *               "network_error" | "not_executable" | "unknown",
 *     "details": <tool-specific JSON object>,
 *     "reason": <human-readable string when not Ready>,
 *     "checked_at": <unix-secs>
 *   }
 *
 * `not_executable` is set by *detection*, not by an auth-status
 * command — a binary the OS won't run can't report its own auth
 * state. It means the install is broken, not that the user is signed
 * out, so don't prompt for a login flow.
 */
export function agentsHealthExternal(
  id?: string | null,
  force?: boolean | null,
): Promise<string>;

/**
 * Per-task invocation of an external CLI agent (Phase 2 stage 3).
 * `id` selects the adapter (`"claude-code"` today; `codex` and
 * `gemini` ship in follow-up PRs). `task` is the prompt. `optionsJson`
 * is a JSON-encoded `InvokeOptions` — pass `"{}"` or `null` to accept
 * defaults.
 *
 * `InvokeOptions` shape:
 *
 *   {
 *     "cwd"?: string,                  // working directory
 *     "allowed_tools"?: string[],      // tool allowlist; [] denies all
 *     "max_turns"?: number,            // turn cap
 *     "timeout_secs"?: number,         // hard deadline (default 300s)
 *     "mcp_endpoint"?: string,         // MCP server URL passed via
 *                                      // --mcp-config; daemon callers
 *                                      // auto-fill from car-server's
 *                                      // bound /mcp URL. "" opts out.
 *     "attachments"?: [               // images attached to the prompt
 *       { "path": string,             // abs path on the daemon's fs
 *         "media_type"?: string }     // advisory; the runner derives
 *     ]                               // the real type from content
 *   }
 *
 * `attachments` are image files the runner hands to the CLI in its
 * native form: Claude Code reads + inlines a base64 image block on
 * stdin, Codex passes each via `--image`, Gemini references it with
 * `@path`. Paths must be readable by the daemon process. The runner
 * caps reads at 32 MB and (on the read/stage paths) verifies the bytes
 * are a real image by magic signature, deriving `media_type` from
 * content — non-image / oversized / unreadable paths are skipped, so a
 * file that isn't an image is never inlined. Adapters whose CLI lacks
 * image input ignore them.
 *
 * Returns JSON `InvokeResult`:
 *
 *   {
 *     "answer": string,                // final agent response
 *     "session_id"?: string,
 *     "turns": number,
 *     "tool_calls": number,            // tool_use blocks observed
 *     "duration_ms": number,
 *     "total_cost_usd"?: number,       // would-be API cost (subscription users don't pay)
 *     "dropped_attachments"?: number,  // images dropped (unreadable/oversized/not an image); omitted when 0
 *     "is_error": boolean,
 *     "error"?: string
 *   }
 *
 * Cost note: each invocation burns subscription quota. The runner
 * doesn't gate cost; callers are responsible for rate limiting.
 */
export function agentsInvokeExternal(
  id: string,
  task: string,
  optionsJson?: string | null,
): Promise<string>;

// --- A2UI surface store (car-a2ui) ---
//
// NOTE: Rust source names these `a2_ui_*` (extra underscore before
// `ui`) so napi-rs's heck casing converter produces `a2Ui*` *by
// construction* — matching the declarations below. Earlier
// `a2ui_*` Rust names also happened to camelCase to `a2Ui*` because
// heck split at the digit→letter boundary, but that was accidental
// drift; Parslee-ai/car#177 made it deliberate.

/**
 * Process-singleton in-process A2UI v0.9 surface store. Wire shapes
 * match the daemon's WebSocket `a2ui.*` methods exactly, so a host
 * can move between transports without reshaping payloads.
 *
 * Embedded callers share one store across all calls in the process.
 * Daemon-shared state (across processes) flows over the WebSocket
 * surface — these functions do NOT proxy to the daemon.
 *
 * Returns JSON `A2uiCapabilities` (version, mimeType, catalogs,
 * components, limits).
 */
export function a2UiCapabilities(): string;

/**
 * Apply a single A2UI envelope (`createSurface` | `updateComponents`
 * | `updateDataModel` | `deleteSurface`). `envelopeJson` is the
 * direct envelope shape (one message field set). Returns JSON
 * `A2uiApplyResult` `{surfaceId, deleted, surface?}`.
 */
export function a2UiApply(envelopeJson: string): Promise<string>;

/**
 * Extract A2UI envelopes from a carrier payload (`{a2ui: {...}}`,
 * A2A `DataPart`, artifact `parts`, etc.) and apply each in order.
 * Owner is auto-extracted from A2A `taskId`/`contextId` shapes.
 * Returns JSON `{applied: [A2uiApplyResult]}`.
 */
export function a2UiIngest(payloadJson: string): Promise<string>;

/**
 * List all live A2UI surfaces in the in-process store. Returns
 * JSON `[A2uiSurface]`.
 */
export function a2UiSurfaces(): Promise<string>;

/**
 * Fetch a surface by id. Returns JSON `A2uiSurface` or `null` if
 * the surface doesn't exist.
 */
export function a2UiGet(surfaceId: string): Promise<string>;

/**
 * Reap surfaces older than `limits.maxSurfaceAgeSecs`. Returns JSON
 * `{removed: [surfaceId]}` — empty array when nothing was due.
 */
export function a2UiReap(): Promise<string>;

/**
 * Submit an A2UI user action (e.g. button click) back to the action
 * handler. `actionJson` is the action payload. Returns JSON
 * `{accepted: boolean, result?: any}`.
 */
export function a2UiAction(actionJson: string): Promise<string>;

/**
 * Validate a JSON payload against the store's size limits. Returns
 * JSON `null` on success; rejects with a limit-exceeded error
 * message otherwise.
 */
export function a2UiValidatePayload(valueJson: string): string;
