"""Common Agent Runtime — Python type stubs.

Most methods that return structured data return a JSON-encoded string;
the caller is expected to ``json.loads`` the result. This keeps the FFI
surface stable across binding and protocol changes.

Daemon-only
====================

Every method talks to the singleton car-server daemon over WebSocket
JSON-RPC. There is no embedded-engine fallback (the v0.7.x
``CAR_FFI_MODE=embedded`` knob is retired). Start ``car-server`` before
using the bindings.

The following methods are **not exposed in the FFI bindings** and raise
``RuntimeError`` / ``NotImplementedError`` — connect to the daemon's
WebSocket directly for the equivalent flow (see
``docs/websocket-protocol.md``):

- ``execute_proposal`` — superseded by ``CarRuntime.submit_proposal``
  + ``register_tool_handler`` (Parslee-ai/car-releases#38). The
  per-call handler shape is daemon-only; the persistent handler
  shape is now wired in PyO3 and matches NAPI's ``submitProposal``.
- ``infer_stream``, ``dispatch_voice_turn`` — daemon streams events over
  WS notifications
- ``open_session``, ``close_session``, ``register_policy(session_id=...)``
  — use ``session.open`` / ``session.close`` JSON-RPC methods
- ``state_snapshot``, ``state_keys`` — daemon-side endpoints pending

  (``register_model`` was re-exposed in Parslee-ai/car-releases#39
  — now proxies to the daemon's ``models.register`` JSON-RPC.
  See its docstring for the visibility caveat.)

  Stale entry kept for back-compat reference:
- ``register_model_legacy_stub`` — daemon owns models_dir /
  models.json

Many methods accept a ``model_context_window`` parameter to size the
context-assembly budget — pass the model's full context window (e.g.
``200_000`` for Claude Opus) and the daemon will reserve room for the
response and use a calibrated fraction for the input context.

Daemon URL override: ``CAR_DAEMON_URL=ws://...`` (default
``ws://127.0.0.1:9100``).
"""

from typing import Callable, List, NoReturn, Optional


# ---------------------------------------------------------------------------
# CarRuntime — persistent runtime instance with state, memory, tools, and
# policies. Each instance carries its own memgine + inference engine.
# ---------------------------------------------------------------------------

class CarRuntime:
    """Persistent CAR runtime instance.

    Each instance holds its own state store, memory engine (memgine),
    tool registry, policy set, and lazily initialized inference engine.
    Most methods are thread-safe but ``execute_proposal`` serializes
    against itself on a per-instance lock.
    """

    def __init__(self) -> None: ...

    # --- Agent basics --------------------------------------------------

    def register_agent_basics(self) -> None:
        """Register CAR's built-in agent utility tools.

        Adds: read_file, write_file, edit_file, list_dir, find_files,
        grep_files, calculate. Read-only tools run in-process; mutating
        tools go through the normal approval flow.
        """

    # --- Agent run tracing (U1) ---------------------------------------

    def runs_start(self, params_json: str) -> str:
        """Start an agent run on the daemon (agent run tracing).

        Brackets the beginning of a run: the daemon mints a durable
        ``run_id``, resolves the owning ``agent_id``, tags it as the
        session's current run before replying, and records that the run
        started. Await/return before submitting any proposal so the
        per-turn recorder reads the right ``run_id``. REAL binding.

        ``params_json`` is a serialized request object::

            {"intent": str, "agent_id"?: str, "agent_name"?: str,
             "outcome_description"?: str}

        When ``agent_id`` is omitted the daemon resolves it from the
        session's ``agent_id`` binding, then ``CAR_AGENT_ID``, then a
        deterministic id synthesized from ``agent_name``. Returns
        ``{"run_id", "agent_id"}`` as a JSON string.
        """

    def runs_complete(self, params_json: str) -> str:
        """Complete an agent run on the daemon (agent run tracing).

        Records the terminal ``AgentOutcome`` for ``run_id`` and acks.
        Await this ack before letting the connection close so a healthy
        run is never mislabeled ``Incomplete``. REAL binding.

        ``params_json`` is a serialized request object::

            {"run_id": str, "outcome": AgentOutcome}

        Returns ``{"run_id", "ok"}`` as a JSON string.
        """

    # --- Voice prep ----------------------------------------------------

    def prepare_parakeet(self) -> str:
        """Eagerly download + load the Parakeet TDT model (~600 MB).

        Idempotent. Routes through this runtime's daemon client so the
        model lands in the daemon's per-session OnceLock, where the
        daemon-side listener constructed by ``transcribe_stream``
        picks it up.
        """

    def prepare_diarizer(self) -> str:
        """Eagerly download + load the speaker diarizer (~28 MB).

        Idempotent. Routes through this runtime's daemon client so the
        diarizer lands in the daemon's OnceLock — pre-v0.8.3 this ran
        in-process, the daemon's slot stayed empty, and every transcript
        fell through to ``role: "unknown"``.
        """

    # --- State ---------------------------------------------------------

    def state_set(self, key: str, value_json: str, tenant: Optional[str] = None) -> None:
        """Set ``key`` to ``value_json`` (must be a JSON string).

        ``tenant`` (optional) scopes the write to one tenant's keyspace (E3).
        """

    def state_get(self, key: str, tenant: Optional[str] = None) -> str:
        """Return the value at ``key`` as JSON, or the string ``"null"``.

        ``tenant`` (optional) scopes the read to one tenant's keyspace (E3).
        """

    def state_exists(self, key: str, tenant: Optional[str] = None) -> bool: ...

    def state_snapshot(self, tenant: Optional[str] = None) -> str:
        """Return a JSON snapshot of the entire state store (optionally
        scoped to ``tenant``)."""

    def state_keys(self, tenant: Optional[str] = None) -> List[str]: ...

    # --- Memory / facts -----------------------------------------------

    def add_fact(
        self,
        subject: str,
        body: str,
        kind: str,
        confidence: Optional[float] = None,
    ) -> int:
        """Ingest a fact. ``kind="constraint"`` flags it as a hard rule.

        Returns the new fact count. Confidence is reserved for future use.

        In Daemon mode, raises ``RuntimeError`` when the daemon is
        unreachable instead of silently returning 0 (#146).
        """

    def query_facts(self, query: str, k: Optional[int] = None) -> str:
        """Query facts via spreading activation. Returns JSON array.

        Each result has the shape
        ``{"subject": str, "body": str, "confidence": float}``.
        """

    def fact_count(self) -> int:
        """Total valid fact count.

        In Daemon mode, hits the daemon's per-session memgine —
        the embedded fallback memgine stays empty by design and
        would silently return 0 (#146). Raises ``RuntimeError`` if
        the daemon is unreachable.
        """

    def build_context(
        self,
        query: str,
        model_context_window: Optional[int] = None,
    ) -> str:
        """Build the full 4-layer context for ``query``.

        Layers: Identity → Constraints → Facts → Conversation →
        Environment → Known Unknowns. When ``model_context_window`` is
        provided, sizes the budget dynamically.

        In Daemon mode, raises ``RuntimeError`` when the daemon is
        unreachable instead of silently returning ``""`` (#146).
        """

    def build_context_fast(
        self,
        query: str,
        model_context_window: Optional[int] = None,
    ) -> str:
        """Fast context-assembly path for latency-sensitive callers.

        Skips embedding flush, skill lookup, PPR-based scoring, and
        known-unknowns extraction.
        """

    def memory_update_status(self, params_json: str) -> str:
        """Update proactive memory private status. Returns ProactiveStatus JSON."""

    def memory_maintain(self, params_json: str) -> str:
        """Run proactive memory Phase 1 maintenance. Returns report JSON."""

    def memory_save_knowledge(self, params_json: str) -> str:
        """Save durable proactive knowledge. Returns saved-entry JSON."""

    def memory_save_procedural(self, params_json: str) -> str:
        """Save durable proactive procedural evidence. Returns saved-entry JSON."""

    def memory_delete(self, params_json: str) -> str:
        """Delete a proactive memory entry by id. Returns delete report JSON."""

    def memory_intervene(self, params_json: str) -> str:
        """Select a targeted proactive memory reminder. Returns decision JSON."""

    def memory_evaluate(self, params_json: str) -> str:
        """Evaluate proactive memory against labeled cases. Returns report JSON."""

    def consolidate(self) -> str:
        """Run the dream/consolidation pass. Returns JSON ConsolidationReport.

        Holds the memgine mutex for the duration of the async pass —
        concurrent Python threads will block.
        """

    def utility_retrieval(self) -> str:
        """Get the live engine's utility-aware retrieval blend (U-Mem).

        Returns JSON ``{ utility_weight, utility_exploration }``.
        """

    def set_utility_retrieval(
        self, utility_weight: float, utility_exploration: Optional[float] = None
    ) -> str:
        """Set the live engine's utility-aware retrieval blend (U-Mem).

        ``utility_weight`` 0 = pure relevance; ``utility_exploration`` scales
        the UCB uncertainty term (only consulted when weight > 0). Omitting
        ``utility_exploration`` keeps the engine's current value
        (read-modify-write), it does NOT reset it to 0. Takes effect on the
        next context build. Returns the applied JSON
        ``{ utility_weight, utility_exploration }``.
        """

    def cascade_run(self, request_json: str) -> str:
        """Run the U-Mem cost-aware knowledge cascade (Slice 5 live evolve loop).

        ``request_json`` is ``{ current_confidence, policy, observed, claim? }``;
        the daemon runs each tier's mechanic (self_reflect -> reflect(),
        human_expert -> ApprovalLedger HITL) + the budget/target walk, escalating
        cheapest-first on the caller-supplied observed confidence. Returns JSON
        ``{ run, pending_approval? }``.
        """

    def plan_evolution_live(self, request_json: str) -> str:
        """Plan an evolution cycle over the daemon's **live** engine signals.

        The self-evolution governor's host surface (arXiv 2507.21046).
        ``request_json`` is ``{ policy?: { pressure_threshold?, budget? } }``; the
        daemon folds the session memgine's real per-component pressure/evidence and
        runs the governor. Returns the ``EvolutionPlan`` JSON ``{ decisions, spent,
        evolve_now }`` — the live counterpart to the stateless ``plan_evolution``
        helper.
        """

    def memory_set_admission_table(self, request_json: str) -> str:
        """``memory.set_admission_table`` — install or clear the durable-state
        admission rules: ``{ table?: OwnershipTable | null }`` →
        ``{ enabled, ungated_surfaces }``.

        A null or absent ``table`` turns the gate OFF, which is the default.
        Off is not the same as an empty table: an empty table is fail-closed
        and refuses every externally-authored fact.
        """

    def memory_admission_table(self, request_json: str) -> str:
        """``memory.admission_table`` — read back the installed admission
        rules: ``{}`` → ``{ enabled, table, ungated_surfaces }``.

        ``ungated_surfaces`` names surfaces whose rule imposes no real
        constraint — worth checking after installing a table that only looks
        governed.
        """

    def supervision_subscribe(self, request_json: str) -> str:
        """``supervision.subscribe`` — register this connection as a supervisor
        of the admission gate: ``{ filter?: { tools?, sessions?,
        min_reversibility? } }`` → ``{ subscribed, decision_timeout_ms,
        supervisors }``.

        Intents arrive as ``supervision.intent`` NOTIFICATIONS on the same
        socket. A caller that cannot read notifications should poll
        ``supervision_pending`` instead — subscribing without consuming them
        blocks every supervised proposal until it fails closed."""

    def supervision_unsubscribe(self, request_json: str) -> str:
        """``supervision.unsubscribe`` — stop supervising: ``{}`` →
        ``{ subscribed: False, was_subscribed }``. Intents already parked run
        out their timeout and fail closed rather than being released."""

    def supervision_pending(self, request_json: str) -> str:
        """``supervision.pending`` — every intent currently parked on a verdict:
        ``{}`` → ``{ intents: [...] }``. One model call can cover all of them."""

    def supervision_decide(self, request_json: str) -> str:
        """``supervision.decide`` — answer one intent: ``{ intent_id, decision:
        { kind: "allow" | "deny" | "escalate", reason? } }`` →
        ``{ decided: True }``. Errors when the intent is unknown, which includes
        "already timed out"."""

    def sync_status(self, request_json: str) -> str:
        """``sync.status`` (B6) — roster, this device's journal frontier, the
        relay's stable frontier, and the divergence-invariant state hash."""

    def sync_append(self, request_json: str) -> str:
        """``sync.append`` (B6) — record an op on any surface:
        ``{ surface, payload, scope? }`` → ``{ op_id, seq, hlc }``."""

    def agents_peers(self, request_json: str) -> str:
        """``agents.peers`` — agents this runtime can message. Sourced from the
        daemon's live connection table, not the on-disk registry."""

    def agents_message_pending(self, request_json: str) -> str:
        """``agents.message.pending`` — peer messages awaiting an operator
        decision. Host-only."""

    def agents_message_approve(self, request_json: str) -> str:
        """``agents.message.approve`` — release or drop one held message:
        ``{id, decision}``. Host-only."""

    def agents_message(self, request_json: str) -> str:
        """``agents.message`` — send text to one peer: ``{to, body, summary?}``.
        The sender is derived server-side; passing ``from`` has no effect."""

    def sync_assistant_checkpoint_put(self, request_json: str) -> str:
        """Store an exact supervised-assistant checkpoint in the durable oplog."""

    def sync_assistant_checkpoint_get(self, request_json: str) -> str:
        """Load the newest checkpoint for a supervised session."""

    def sync_assistant_action_put(self, request_json: str) -> str:
        """Append one monotone supervised-action lifecycle record."""

    def sync_assistant_action_get(self, request_json: str) -> str:
        """Load a supervised action by its canonical digest."""

    def sync_record_turn(self, request_json: str) -> str:
        """``sync.record_turn`` (B6) — route a conversation turn through the oplog
        so ``sync_resume`` is a real, provider-valid transcript replay."""

    def sync_record_intent(self, request_json: str) -> str:
        """``sync.record_intent`` (B6) — write the leased-execution intent ledger
        (terminal-guarded); populates the committed-run oracle the fence reads."""

    def sync_pump(self, request_json: str) -> str:
        """``sync.pump`` (B6) — one push/pull/ack reconciliation round against the
        relay. Returns ``{ pushed, push_deduped, folded, acked, state_hash }``."""

    def sync_checkpoint(self, request_json: str) -> str:
        """``sync.checkpoint`` (B6) — publish a device-side checkpoint at the
        relay's stable frontier."""

    def sync_rebase(self, request_json: str) -> str:
        """``sync.rebase`` (B6) — cold bootstrap / straggler re-entry onto the
        relay's latest checkpoint."""

    def sync_transcript(self, request_json: str) -> str:
        """``sync.transcript`` (B6) — the ordered role-threaded ``Turn[]``
        projection for a conversation."""

    def sync_resume(self, request_json: str) -> str:
        """``sync.resume`` (B6) — the repaired, provider-valid ``Message[]`` a host
        replays to continue the conversation."""

    def sync_fence_check(self, request_json: str) -> str:
        """``sync.fence_check`` (B6) — the executor dispatch fence at the point of
        effect: the durable committed-run oracle read + the linearizable "am I
        still epoch N?" read. Only ``may_dispatch == true`` authorizes the effect."""

    def lease_acquire(self, request_json: str) -> str:
        """``lease.acquire`` (B6) — CAS-acquire the per-agent execution lease; the
        monotone fencing ``epoch`` bumps on grant."""

    def lease_renew(self, request_json: str) -> str:
        """``lease.renew`` (B6) — heartbeat the lease (no epoch bump), iff still the
        holder."""

    def lease_release(self, request_json: str) -> str:
        """``lease.release`` (B6) — clean handoff (next acquire skips the TTL wait)."""

    def lease_status(self, request_json: str) -> str:
        """``lease.status`` (B6) — the linearizable read of the current lease,
        or ``null``."""

    def run_evolution_cycle_live(self, request_json: str) -> str:
        """Run one evolution cycle over the daemon's **live** signals.

        The self-evolution governor's real executor (arXiv 2507.21046).
        ``request_json`` is ``{ policy?, dry_run?, harness_baseline_metrics?,
        harness_candidate_metrics?, harness_measure?, context_measure? }``; the daemon plans over all five live
        components (Memory/Skills/Context from the engine, Harness from the
        event log, Tools from connector health) and dispatches each
        ``EvolveNow`` component: Memory -> consolidate (sized by
        decide_maintenance), Skills -> evolve_skills over event-log failure
        traces, Harness -> the HITL-gated harness_evolution loop (pending
        approvals resolve via ``permission.approve``/``reject`` by
        fingerprint), Context -> the ``context_evolution`` loop, which resolves
        each mutation either through the opt-in pre-activation grader
        (``context_measure``) or, for whatever that did not decide, the
        diagnose->approve->apply->measure->revert human path. Returns the cycle
        record JSON ``{ plan, steps, evolved, out_of_scope,
        pending_approvals?, measurement? }``, where each step is
        ``{ component, ran, applied, out_of_scope, outcome }``.

        **Context.** Diagnoses off the engine's own live conversation-layer
        saturation and lowers ``MemgineConfig.conversation_keep_recent``
        (halved, floored at 2) so compaction summarizes more of the older
        turns. Every mutation is HITL-gated on the same shared durable
        ``ApprovalLedger`` as harness ones, under its own fingerprint
        namespace ``context:<component>:<patch-digest>``, resolved by the same
        ``permission.approve``/``reject``. There **is** a pre-activation
        regression gate, opt-in via ``context_measure`` (see below) -- this
        docstring used to say there was none, because the bench replayed a
        runtime with no memgine attached and never offered a ``recall`` tool.
        Bench tasks may now declare a ``memory:`` fixture and are then replayed
        with a real memgine and the shipped ``recall`` tool, so the assembled
        context moves with the knob. A graded mutation promotes (``applied``
        with ``governance: "promoted"``) or is rejected (``rejected_by_gate``)
        with no operator in the loop. On the human-approved path -- and whenever
        no grade ran -- the daemon
        measures the MARGIN after the apply: compact under the unchanged value
        for a baseline (``conversation_tokens_baseline``), apply, compact
        again, and revert unless the tokens fell below that baseline
        (``rolled_back``, not counted as applied; ``rollback_failed`` with
        ``rollback_error`` if even the revert did not take). Comparing against
        that baseline rather than the uncompacted layer is what stops the
        change being credited with savings compaction would have produced
        anyway. Context is therefore **not** unattended out of the box; it
        becomes unattended for a given change only once that fingerprint has
        been approved -- and since the ledger is daemon-wide and the
        fingerprint names the change, that approval covers the same change on
        every engine this daemon evolves. On the unattended cadence a
        falsified mutation then backs off exponentially per fingerprint
        (``in_backoff``) instead of being re-applied and re-reverted every
        tick. The step's ``outcome`` is a JSON string ``{ mechanism:
        "context_evolution", mutations, applied, pending, details }``, each
        detail carrying ``mutation``, ``component``, ``fingerprint``,
        ``rationale`` and one of ``pending_approval`` | ``applied`` |
        ``rolled_back`` | ``rollback_failed`` | ``apply_failed`` |
        ``would_apply`` | ``in_backoff`` | ``rejected_by_operator`` |
        ``approved_no_patch`` | ``rejected_by_gate`` |
        ``measurement_failed`` | ``config_moved_during_measurement`` (a graded
        promotion whose measured base was moved by something else while the
        replays ran -- nothing applied, both values reported, no backoff).
        When ``context_measure`` was requested the summary also carries
        ``context_measured: { status: "measured" | "skipped_dry_run",
        grade_attempts, model, split, split_seed }``.

        **Tools** is recorded as ``out_of_scope`` -- a decision, not a
        failure. Connector remediation means re-running a connector's OAuth or
        credential exchange, an access change this loop holds no authority to
        perform; reconnect/re-auth stay operator actions via ``connectors.*``.
        Such a step is ``ran: true, applied: false, out_of_scope: true`` with
        the reason in ``outcome``, and the component appears in the top-level
        ``out_of_scope`` array (always present, empty when none). ``ran:
        false`` therefore means one thing only: the mechanism was invoked and
        errored.

        ``harness_measure`` ``{ model, split?, held_in_fraction?, split_seed?,
        max_turns?, tasks_dir? }`` opts into **in-daemon measurement**: the
        daemon replays the held-out split itself (once for the baseline under
        the live ``HarnessConfig``, once per measurable mutation under that
        config plus the mutation's patch) and feeds the regression gate, so a
        cycle can promote or reject unattended. Mutually exclusive with the two
        supplied-metrics params (sending both errors, naming both); ``dry_run``
        measures nothing and reports ``measurement.status =
        "skipped_dry_run"``; a build with no in-process evaluator installed
        errors rather than degrading to HITL; safety-affecting and patchless
        mutations are never measured; a failed replay reports
        ``measurement_failed`` and fabricates no metrics. ``measurement`` is
        TOP-LEVEL on the response (not only inside the harness step) and
        present whenever ``harness_measure`` was requested, in every shape it
        can end in -- ``measured`` / ``skipped_dry_run`` /
        ``measurement_failed`` with the error. A replay is a paid side effect
        and the plan may legitimately never dispatch Harness, so a side effect
        reported only from that step is one a caller can be billed for and
        never see.

        ``context_measure`` takes the SAME request shape and opts into the
        **Context pillar's** pre-activation grader: two replays over the same
        split, one under the engine's live ``MemgineConfig`` and one under it
        plus the mutation's patch, graded on TASK outcomes by the same gate.
        The two params are not mutually exclusive with each other (different
        pillars, two independent measurements). ``dry_run`` performs no replay;
        a build with no evaluator installed errors; a patchless mutation is
        never measured; and the unattended cadence never requests a grade at
        all, so an idle timer cannot start spending benchmark replays.
        """

    def gate_skill_deployment_live(self, request_json: str) -> str:
        """Gate a skill's deployment capability against its provenance on the daemon.

        Folds the named skill's **live** track record into the decision
        (arXiv 2602.12430 "Agent Skills"). ``request_json`` is ``{ skill_name,
        provenance, requested_tier }`` where ``requested_tier`` is
        ``"read_only" | "sandbox_edit" | "full_access"``. The daemon overrides
        the provenance's lifecycle counts with the skill's real success/fail
        record, so a skill failing in the field is denied despite an official
        signature. Returns the ``SkillDeploymentDecision`` JSON. Live counterpart
        to the stateless ``gate_skill_deployment`` helper.
        """

    def enforce_skill_deployment_live(self, request_json: str) -> str:
        """Enforce a skill's deployment at load time against the session ledger.

        arXiv 2602.12430 "Agent Skills" Slice 4 — the HITL bridge. ``request_json``
        is ``{ skill_name, provenance, requested_tier }``; the daemon gates the
        skill (folding its live track record), then resolves the verdict against
        standing operator decisions: ``Allow``/``Downgrade`` deploy autonomously,
        a ``Deny`` is overridden/blocked/pending. Returns ``{ decision,
        enforcement, pending_approval? }``; a pending approval is resolved via
        ``permission.approve``/``permission.reject`` by the returned
        ``fingerprint``.
        """

    def permission_get_tier(self) -> str:
        """The standing permission tier granted to this connection's session.

        One of ``"read_only" | "sandbox_edit" | "full_access"`` — the tier every
        ``submit_proposal`` on this connection is judged against
        (Parslee-ai/car#890).
        """

    def permission_set_tier(self, tier: str) -> str:
        """Set this connection's standing permission tier; returns the granted tier.

        ``tier`` is ``"read_only" | "sandbox_edit" | "full_access"``. Lets a
        binding client govern its own session — most usefully by tightening it:
        dropping to ``read_only`` makes the runtime escalate any write this
        client proposes to a human instead of running it. Raising the tier is
        host-gated whenever the daemon runs under a host token, so an agent
        connection cannot self-elevate.
        """

    def ingest_skill_governed(self, request_json: str) -> str:
        """Ingest a skill through the deployment gate on the daemon.

        arXiv 2602.12430 "Agent Skills" — the loader integration. ``request_json``
        carries the skill fields (``name``, ``code``, ``platform``, ``persona?``,
        ``url_pattern?``, ``description?``, ``supersedes?``, ``task_keywords?``)
        plus ``provenance?`` and ``requested_tier``. The daemon gates + enforces
        against the session ledger and **only ingests when deployment is
        permitted**, stamping the granted ceiling onto the skill. Returns ``{
        ingested, node?, decision, enforcement, pending_approval? }``; a pending
        deny is resolved via ``permission.approve``/``permission.reject`` by the
        returned ``fingerprint``.
        """

    def adopt_skill_pack(self, request_json: str) -> str:
        """Adopt an installed skill pack on the daemon through the gate.

        arXiv 2602.12430 "Agent Skills" — the daemon call-site for governed pack
        adoption. ``request_json`` carries ``pack`` (an ``ApprovedSkillPack``),
        ``requested_tier?`` (default ``read_only``), and either ``manifest?`` —
        the signed bundle, whose signature trust is derived against the
        operator's ``.car/config.toml`` ``trusted_skill_signers`` keyring — or
        ``provenance?`` (caller-assembled), plus optional
        ``scanned?``/``vulnerabilities?``/``source?``. Governance is
        unconditional: a denied skill never enters the graph. Returns ``{ loaded,
        pending, refused, requested_tier, provenance, trusted_signers }``; a
        pending deny is resolved via ``permission.approve``/``permission.reject``
        by the returned ``fingerprint``, then re-adopted.
        """

    def persist_memory(self, path: str) -> int:
        """Persist the memory graph to ``path`` (JSON, flat format).

        Daemon-side write. Returns the number of records written.
        ``path`` is sandboxed under ``~/.car/memory/``: relative paths
        land under the base; absolute paths must already be under the
        base; ``..`` segments and symlinks pointing out of the sandbox
        are rejected.

        **Writes the whole graph, not a subset.** ``path`` chooses the
        destination file; it does not select the contents. On an unbound session
        that graph is the daemon-wide shared one, so per-project files each end
        up holding every project's facts. Set ``CAR_MEMORY_NAMESPACE`` for a file containing only one project's
        facts (car-releases#79/#80).
        """

    def load_memory(self, path: str) -> int:
        """Load memory from ``path``. Returns the number of facts loaded.

        Daemon-side read with the same ``~/.car/memory/`` sandboxing as
        :func:`persist_memory`.

        **``path`` names a file, not a namespace.** This REPLACES the graph the
        connection is bound to — by default the daemon's SHARED graph, common to
        every unbound session and to facts ingested over MCP. On a multi-project
        host that both discards other projects' in-memory facts and leaves the
        loaded ones visible to them. Set ``CAR_MEMORY_NAMESPACE`` in the host process to bind a private graph
        (car-releases#79/#80); the shared daemon transport puts it on the
        ``session.auth`` handshake for you.
        """

    def chat_event(
        self, session_id: str, kind: str, delta: Optional[str] = None
    ) -> None:
        """Stream one delta of a chat turn back to the daemon as an
        ``agent.chat.event`` notification (the agent-chat surface).

        Called from an ``agent.chat`` handler (see
        :func:`register_chat_handler`); the daemon rewrites each event to
        ``agents.chat.event`` for the host that issued ``agents.chat``, keyed
        by ``session_id``. ``kind`` is one of ``token`` | ``tool_call`` |
        ``done`` | ``error``; ``delta`` carries the text (omit for a bare
        signal).
        """

    # --- Foreman ------------------------------------------------------

    def foreman_plan(
        self, goal: str, repo: str | None = ..., max_attempts: int | None = ...
    ) -> str:
        """Decompose a coding ``goal`` into a footprint-annotated, scheduled
        subtask plan. ``repo`` defaults to the daemon's cwd. Returns a JSON
        ``ForemanPlanReport`` string."""
        ...

    def foreman_run(
        self,
        goal: str,
        repo: str | None = ...,
        adapter: str | None = ...,
        verify_command: list[str] | None = ...,
        union_verify_command: list[str] | None = ...,
        max_attempts: int | None = ...,
    ) -> str:
        """Plan a coding ``goal``, then farm the subtasks to an external coding
        CLI (``adapter``, default ``claude-code``) in isolated worktrees, gating
        each worktree and the integrated union. ``verify_command`` is the
        per-worktree regression check; ``union_verify_command`` is the
        integrated-union goal check (falls back to ``verify_command``).
        **Spends real agent quota.** Returns JSON ``{ plan, ran, run? }``."""
        ...

    # --- Tools & policies ---------------------------------------------

    def register_tool(self, name: str) -> None: ...

    def list_tools(self) -> str:
        """Tools registered on this runtime, as a JSON array of ``ToolSchema``.

        Sorted by name, so two calls with no registration in between are
        byte-identical and can be diffed. Counterpart to
        :meth:`register_tool` / :meth:`register_tool_schema`, which had none:
        a caller could add tools but never ask what was actually in effect, so
        a governed or read-only deployment could not prove "only these tools
        are callable" (Parslee-ai/car#892).
        """

    def unregister_tool(self, name: str) -> int:
        """Remove a tool by name; returns how many were removed.

        ``0`` means nothing matched — not an error, so cleanup code can call
        this unconditionally. Drops the tool from both the runtime's registry
        and its schema map, so the model stops seeing it and the validator
        stops accepting it (Parslee-ai/car#892).
        """

    def register_policy(
        self,
        name: str,
        rule: str,
        target: Optional[str] = None,
        key: Optional[str] = None,
        pattern: Optional[str] = None,
        value_json: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> None:
        """Register a policy enforced on every action.

        ``rule`` is one of: ``"deny_tool"``, ``"deny_tool_param"``,
        ``"require_state"``. See ``docs/agent-ir-spec.md`` for the
        semantics of each.

        ``session_id`` — when set, scopes the policy to a session
        opened via :meth:`open_session`. Without it, the policy is
        global. Embedded only — daemon mode session-scoped policies
        go through the WS ``policy.register`` JSON-RPC method. See
        ``docs/proposals/per-session-policy-scoping.md``.
        """

    def unregister_policy(self, name: str) -> int:
        """Remove a global policy by name; returns how many were removed.

        ``0`` means nothing matched — not an error, so cleanup code can
        call this unconditionally. Counterpart to :meth:`register_policy`,
        which had none: a policy registered over the wire could only be
        cleared by restarting the daemon (Parslee-ai/car#623).

        Session-scoped policies are WS-only, mirroring
        :meth:`register_policy`'s own ``session_id`` restriction — close
        the session to drop them.
        """

    def list_policies(self) -> str:
        """Global policies in force, as a JSON array of ``{name, description}``.

        Without this a caller could register a policy but never ask what
        was enforced, so an action rejection could not be explained
        beyond its own message.
        """

    def open_session(self) -> str:
        """Open a policy-scoping session and return its opaque id.

        Hosts that drive multiple concurrent agent contexts through
        one CarRuntime call this once per context, then pass the id
        to subsequent :meth:`register_policy` and
        :meth:`execute_proposal` calls so per-context rules stack on
        top of any global ones. Embedded only; daemon mode uses the
        ``session.open`` WS JSON-RPC method.
        """

    def close_session(self, session_id: str) -> bool:
        """Close a session and drop every policy scoped to it.

        Returns ``True`` if a session by that id existed; ``False``
        if it didn't (already closed, never opened). Embedded only.
        """

    def set_replan_config(
        self,
        max_replans: int,
        delay_ms: Optional[int] = None,
        replan_on_rejected: Optional[bool] = None,
    ) -> None:
        """Configure auto-replan on action failure. ``0`` disables (default).

        ``replan_on_rejected`` (default ``False``): when ``True``,
        validator/policy/capability rejections (not just runtime failures) also
        trigger rollback + replan.
        """

    def event_count(self) -> int:
        """Return the number of events in the eventlog.

        In Daemon mode, raises ``RuntimeError`` when the daemon is
        unreachable instead of silently returning 0 (#146).
        """

    def tool_poll(self, handle: str) -> Optional[str]:
        """Drain buffered chunks + status for a detached tool invocation (C2).

        ``handle`` is the ``tool_handle`` a detached ToolCall action
        (``invocation_mode: "streaming" | "long_running"``) returned as its
        output. Returns the ``ToolPollResult`` JSON string
        ``{handle, tool, action_id, status, chunks, result?, error?}``, or
        ``None`` for an unknown / already fully-consumed handle.
        """

    def tool_cancel(self, handle: str) -> bool:
        """Request cooperative cancellation of a detached tool invocation (C2).

        Returns ``True`` when the handle was known (the invocation is sealed
        ``cancelled`` unless already terminal), ``False`` for an unknown
        handle.
        """

    def event_query(self, query_json: str) -> str:
        """Structured audit query over the event log (G2).

        ``query_json`` is an ``EventQuery`` object
        (kinds/action_id/proposal_id/since/until/data_matches/limit); returns
        ``{count, events}`` as a JSON string, most-recent-first.
        """

    def event_retention(self, policy_json: Optional[str] = None) -> str:
        """Get/set the event-log retention policy (G2).

        Pass a ``{max_events, max_age_secs}`` JSON string to install it, or
        ``None`` to read the current policy. Returns a JSON string.
        """

    def enable_event_log_hash_chaining(self) -> None:
        """Turn on tamper-evident hash chaining for the session event log (A9).

        Every event appended from now on links to its predecessor by a
        content hash. Idempotent.
        """

    def verify_event_log_chain(self) -> str:
        """Verify the session event log's tamper-evidence chain (A9).

        Returns ``{"verified": n}`` (chained events verified) or
        ``{"tampered_at": i}`` (index of the first interior
        edit/deletion/reorder) as a JSON string. Head/tail truncation is not
        detectable (no anchored head hash).
        """

    def event_cost_by_agent(self) -> str:
        """Per-agent token/cost report (G3), folded from metered inference
        events. Returns a JSON array of
        ``{agent, calls, tokens_in, tokens_out, cost_usd}``.
        """

    def metrics_summary(self) -> str:
        """Live operational metrics rollup (G1) as a JSON string —
        success/error rate, cost, latency, approvals, gate rejections, and the
        per-agent cost breakdown. ``cost_usd`` is the fold over the retained
        window; ``cumulative_cost_usd`` is the monotonic lifetime spend
        (survives retention trims).
        """

    def metrics_alerts(self, thresholds_json: Optional[str] = None) -> str:
        """Evaluate live metrics against thresholds (G1).

        ``thresholds_json`` is an ``AlertThresholds`` object (or ``None`` for
        defaults); returns ``{summary, alerts}`` as a JSON string. The
        ``max_cost_usd`` budget is checked against the monotonic
        ``cumulative_cost_usd`` counter, so a retention trim never un-fires
        the ``cost_overage`` alert.
        """

    # --- Execution ----------------------------------------------------

    def verify_proposal(self, proposal_json: str) -> str:
        """Statically verify ``proposal_json``. Returns JSON.

        Result shape: ``{"valid": bool, "issues": [...]}``.
        """

    def execute_proposal(
        self,
        proposal_json: str,
        tool_fn: Callable[[str], str],
        session_id: Optional[str] = None,
        scope_json: Optional[str] = None,
    ) -> str:
        """Execute a proposal against the daemon's executor (F3 parity).

        One-call convenience matching NAPI's ``executeProposal``: installs
        ``tool_fn`` as the ``tools.execute`` handler for this runtime and
        submits ``proposal_json`` in a single call. Equivalent to
        :func:`register_tool_handler` followed by :meth:`submit_proposal`.

        ``tool_fn`` is called as ``tool_fn(call_json)`` for each host-tool
        action — ``call_json`` is
        ``{"tool","params","action_id","request_id","timeout_ms"}``
        — and must return a JSON-encoded result string (same contract as
        :func:`register_tool_handler`). ``timeout_ms`` is the action's
        declared budget in milliseconds when the action declared one
        (``None`` otherwise); the host tool runner may use it to bound
        its own work.

        ``session_id`` — when set, scopes per-action policy validation
        to the named session opened via :meth:`open_session`. Global
        policies still apply, plus the session's. See
        ``docs/proposals/per-session-policy-scoping.md``.

        ``scope_json`` — optional serialized ``RuntimeScope``
        (``{"callerId": "...", "tenantId": "...", "claims": {...}}``)
        for multi-tenant deployments. When ``tenantId`` is set, the
        runtime routes per-action state R/W through the tenant-scoped
        view so distinct tenants can't observe each other's keys
        (Parslee-ai/car#187 phase 3). Single-tenant callers omit.

        **Not exposed in the FFI bindings** — the daemon owns the executor.
        Prefer :meth:`submit_proposal` with a handler registered via
        :func:`register_tool_handler` (Parslee-ai/car-releases#38);
        the underlying daemon ``proposal.submit`` accepts the same
        ``scope`` shape. Signature is kept here for parity with NAPI
        so a future in-process PyO3 implementation lands with the
        same shape.
        """

    def submit_proposal(
        self,
        proposal_json: str,
        session_id: Optional[str] = None,
        scope_json: Optional[str] = None,
    ) -> str:
        """Submit a proposal for daemon-side execution using the
        persistent ``tools.execute`` handler registered via
        :func:`register_tool_handler` (Parslee-ai/car-releases#38).

        Symmetric to NAPI's ``submitProposal``. The first call on this
        ``CarRuntime`` installs the daemon-side bridge that dispatches
        ``tools.execute`` requests to the process-wide stored Python
        handler; subsequent calls reuse the bridge. Re-calling
        :func:`register_tool_handler` swaps the handler atomically
        without re-installing the bridge — proposals already in flight
        pick up the new callable on their next ``tools.execute``
        round-trip.

        Fails fast with ``RuntimeError`` when no handler is registered.
        Otherwise the daemon would reject every host-tool action with
        a -32000 error mid-proposal.

        Returns the daemon's ``proposal.submit`` response JSON
        (execution result, artifacts, final status) as a string.

        ``session_id`` — when set, scopes per-action policy validation
        to a session opened via the daemon's ``session.policy.open``
        JSON-RPC method.

        ``scope_json`` — optional serialized ``RuntimeScope``
        (``{"callerId": "...", "tenantId": "...", "claims": {...}}``)
        for multi-tenant deployments. Forwarded under ``scope`` to
        ``proposal.submit``; the daemon routes through
        ``Runtime::execute_scoped`` when ``tenantId`` is set so
        tenant-scoped state writes (car#187 phase 3) apply. Single-
        tenant callers omit.
        """

    # --- Inference ----------------------------------------------------

    def infer(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        intent_json: Optional[str] = None,
    ) -> str:
        """Generate text. Returns the model's plain-text completion.

        ``intent_json`` is an optional serialized ``IntentHint``
        (``{"task": ..., "prefer_local": ..., "prefer_fast": ...,
        "prefer_quality": ..., "high_stakes": ..., "require": ...}``) — see
        ``docs/proposals/policy-intent-surface.md``. ``high_stakes`` forces the
        strongest quality posture for consequential/irreversible work. When
        provided, the
        adaptive router uses it to filter candidates and bias the score
        profile. Mutually compatible with ``model``: if ``model`` is
        set, the intent is recorded for telemetry but does not change
        the routing decision.
        """

    def build_workflow(self, request_json: str) -> str:
        """Build a runnable workflow from a natural-language goal via the
        daemon's builder. ``request_json`` is ``{goal, existing?,
        max_attempts?}``; the daemon catalog (registered tools + models) is
        authoritative, so the tool cross-check fires. Returns
        ``{valid, workflow, issues, warnings, attempts}`` as JSON.
        """

    def generate_image(self, request_json: str) -> str:
        """Generate an image from a text prompt via the daemon's installed
        Flux/MLX models. ``request_json`` is a ``GenerateImageRequest``
        (``{prompt, model?, width?, height?, steps?, guidance?, seed?,
        output_path?, ...}``); returns ``GenerateImageResult`` JSON. FFI
        analogue of the ``image.generate`` WS method (car-releases#70)."""

    def generate_video(self, request_json: str) -> str:
        """Generate a video from a text/image prompt via the daemon's installed
        LTX/MLX models. ``request_json`` is a ``GenerateVideoRequest``; returns
        ``GenerateVideoResult`` JSON. FFI analogue of the ``video.generate`` WS
        method (car-releases#70)."""

    def infer_tracked_with_request(self, request_json: str) -> str:
        """Generate with full tracking from a JSON-serialized
        ``GenerateRequest``.

        This request-shaped form exposes every generation field, including
        ``params.strict_model``. It mirrors NAPI
        ``inferTrackedWithRequest(requestJson)`` and returns the daemon's full
        inference-result JSON unchanged.

        ``client_ref`` is an opaque correlation token echoed verbatim in the
        ``inference.runner.invoke`` payload and otherwise ignored by CAR. A
        delegated-inference host with several calls in flight uses it to map an
        invoke back to its own request state — ``call_id`` is minted by the
        daemon only after this call, so it cannot serve that purpose. Hosts
        previously had to smuggle an id through ``prompt``, which worked only
        because delegated models ignore it (car-releases#78).
        """

    def infer_tracked(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        context: Optional[str] = None,
        tools_json: Optional[str] = None,
        messages_json: Optional[str] = None,
        tool_choice: Optional[str] = None,
        parallel_tool_calls: Optional[bool] = None,
        intent_json: Optional[str] = None,
        images_json: Optional[str] = None,
    ) -> str:
        """Generate with full tracking. Returns JSON.

        Result shape:
        ``{"text", "tool_calls", "usage": {input_tokens, output_tokens},
        "model_used", "trace_id", "latency_ms",
        "time_to_first_token_ms", "stop_reason"}``.

        ``auth_fallback_from`` is present ONLY when a candidate earlier in
        the fallback chain was skipped because its credential was
        **rejected** (not merely absent) and a later model then answered.
        It names that dead lane, so a caller can tell the user their
        sign-in lapsed instead of silently serving a different model
        (Parslee-ai/car#888). Absent on the common path.

        ``time_to_first_token_ms`` is wall-clock from request start to
        the first sampled token. Populated by the local Candle/MLX
        paths; ``null`` for non-streaming remote calls.

        ``stop_reason`` is the raw provider termination reason (OpenAI
        ``finish_reason``, Anthropic ``stop_reason``, Google
        ``finishReason``); ``null`` for local backends or providers that
        don't report one. ``"length"``/``"max_tokens"``/``"MAX_TOKENS"``
        means the output was truncated at the token cap. On local Qwen3
        hybrid-thinking models it is also set to ``"thinking_recovered"``
        when reasoning consumed the whole token budget and the runtime
        retried with reasoning suppressed to produce a direct answer, or
        ``"thinking_truncated"`` when even that retry was empty
        (car-releases#60).

        ``intent_json`` — see :meth:`infer`.

        ``images_json`` — JSON-encoded list of ``ContentBlock`` image
        variants:
        ``[{"type": "image_base64", "data": "<b64>", "media_type": "image/png"}]``
        or ``[{"type": "image_url", "url": "https://…", "detail": "auto"}]``.
        Vision-capable hosted models (Claude 3.5+/4.x, GPT-4o, Gemini)
        accept these directly; non-vision providers raise a structured
        error from the daemon. See #230.
        """

    def infer_with_context(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        intent_json: Optional[str] = None,
    ) -> str:
        """Generate text grounded with memory context built from ``prompt``.

        ``intent_json`` — see :meth:`infer`.
        """

    def infer_with_context_tracked(
        self,
        prompt: str,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        intent_json: Optional[str] = None,
    ) -> str:
        """Like ``infer_with_context`` but returns the full tracked JSON result.

        ``intent_json`` — see :meth:`infer`.
        """

    def infer_stream(
        self,
        prompt: str,
        on_event: Callable[[str], None],
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        context: Optional[str] = None,
        tools_json: Optional[str] = None,
        tool_choice: Optional[str] = None,
        parallel_tool_calls: Optional[bool] = None,
        intent_json: Optional[str] = None,
    ) -> NoReturn:
        """Unsupported ABI-compatibility stub that always raises ``RuntimeError``.

        Connect to ``car-server`` directly and use the ``infer_stream``
        JSON-RPC method plus ``inference.stream.event`` notifications. The
        callback is never invoked by this stub.
        """

    def embed(self, texts: List[str], model: Optional[str] = None) -> str:
        """Generate embeddings. Returns JSON ``{"embeddings": [[float, ...], ...]}``."""

    def rerank(
        self,
        query: str,
        documents: List[str],
        model: Optional[str] = None,
        top_n: Optional[int] = None,
        instruction: Optional[str] = None,
    ) -> str:
        """Rerank ``documents`` against ``query`` via a cross-encoder."""

    def classify(
        self,
        text: str,
        labels: List[str],
        model: Optional[str] = None,
    ) -> str:
        """Classify ``text`` against candidate ``labels``. Returns JSON."""

    def tokenize(self, model: str, text: str) -> str:
        """Encode ``text`` via the named local model's tokenizer.

        Returns a JSON-encoded list of u32 token IDs, raw — no
        chat-template wrapping, no BOS prepending. Pair with
        :meth:`detokenize` for byte-identical round-trip. Remote
        models are not supported and the call raises.
        """

    def detokenize(self, model: str, tokens: List[int]) -> str:
        """Decode token IDs back to text. Inverse of :meth:`tokenize`."""

    # --- Speech runtime -----------------------------------------------

    def prepare_speech_runtime(self) -> str:
        """Provision the managed speech runtime. Returns its root path.

        The returned root is the one :meth:`speech_health` / ``car speech
        doctor`` report. The first call on a fresh machine builds a Python
        venv and can take minutes; afterwards it is a no-op. The path is not a
        success signal: on Apple Silicon the runtime is a fallback behind the
        native MLX backends, so a bootstrap that cannot run degrades instead of
        failing. Read ``speech_health().runtime.installed`` for the real state.
        """

    def search(self, query: str, max_results: Optional[int] = None) -> str:
        """Web search. The daemon resolves the backend: the signed-in Parslee
        account's hosted search when available, else a bring-your-own
        ``TAVILY_API_KEY``, else a keyless DuckDuckGo fallback. Returns JSON
        ``{query, source, results[]}``."""

    def web_fetch(self, url: str) -> str:
        """Fetch a URL and extract readable text (keyless; companion to
        ``search``). Returns JSON ``{url, status, content_type, title?, text}``."""

    def transcribe(
        self,
        audio_path: str,
        model: Optional[str] = None,
        language: Optional[str] = None,
        prompt: Optional[str] = None,
        timestamps: Optional[bool] = None,
    ) -> str:
        """Transcribe a local audio file. Returns JSON."""

    def synthesize(
        self,
        text: str,
        model: Optional[str] = None,
        voice: Optional[str] = None,
        language: Optional[str] = None,
        speed: Optional[float] = None,
        output_path: Optional[str] = None,
        format: Optional[str] = None,
        reference_audio_path: Optional[str] = None,
        reference_text: Optional[str] = None,
        voice_instruction: Optional[str] = None,
    ) -> str:
        """Synthesize speech from ``text``. Returns JSON describing the output."""

    # --- Models -------------------------------------------------------

    def list_models(self) -> str:
        """List local models. Returns JSON."""

    def pull_model(self, name: str) -> str:
        """Download a model by name. Returns its filesystem path."""

    def remove_model(self, model_id: str) -> str:
        """Remove a receipt-backed CAR-managed artifact. Returns result JSON."""

    def adopt_model(self, model_id: str) -> str:
        """Adopt an already-usable local artifact into CAR ownership."""

    def model_resource_policy_get(self) -> str:
        """Return saved policy, evaluated budget, and hardware total as JSON."""

    def model_resource_policy_set(self, policy_json: str) -> str:
        """Persist an exact resource-policy JSON object."""

    def model_preflight(self, model_id: str, context_tokens: int = 0) -> str:
        """Evaluate a local model without downloading or loading it."""

    def list_models_unified(self) -> str:
        """List local + remote models from the unified registry.

        Returns a JSON array of objects with fields ``id``, ``name``,
        ``provider``, ``capabilities``, ``param_count``, ``size_mb``,
        ``context_length``, ``available``, ``is_local``,
        ``operator_managed_external_runtime``, ``weights_ready``,
        ``downloads_weights``, ``max_output_tokens``,
        ``public_benchmarks``, ``cost``, ``car_enabled``, ``can_remove``,
        ``in_use``, and ``management_evidence``.
        ``available`` means CAR can use the model here — for a local MLX
        entry with a declared ``hf_repo`` that is ``True`` before a byte is
        fetched, because it lazy-downloads on first use — whereas
        ``weights_ready`` means the weights are already on disk (remote
        models, having none to install, report ``True``). Older daemons omit
        ``weights_ready``; it defaults to ``False`` rather than failing.
        ``downloads_weights`` is ``True`` only for entries whose weights CAR
        fetches before use (GGUF, MLX, whisper.cpp, and CAR-owned managed
        vLLM-MLX). When it is ``False`` — OS-provided models such as
        ``windows/speech-synthesis:os`` and ``apple/foundation:default``,
        operator-managed servers such as raw vLLM-MLX and Ollama, and every
        remote entry — there
        is nothing to install, so ``weights_ready`` is meaningless and the CLI renders
        ``INSTALLED`` as ``-``. Do not substitute ``is_local``: OS-provided
        models are local but download nothing. A raw external vLLM-MLX
        row instead sets ``operator_managed_external_runtime=True`` and is not
        local, even for a loopback endpoint; only CAR-owned managed vLLM-MLX
        is charged and supervised as local. Older daemons omit
        ``downloads_weights``; it defaults to ``False`` rather than failing.
        ``max_output_tokens`` is the registry-declared per-model output
        ceiling (``null`` when the entry omits it; callers then fall back
        to a fraction of ``context_length``). ``public_benchmarks`` is a list of
        ``{name, score, harness?, source_url?, measured_at?}`` with
        ``score`` on a 0.0–1.0 scale; the built-in catalog ships this
        empty and it is populated via curated registry data.

        ``cost`` is the model's declared prices —
        ``{input_per_mtok, output_per_mtok, cache_read_input_per_mtok,
        cache_write_input_per_mtok, pricing_tiers, size_mb, ram_mb}`` — in
        USD per 1M tokens, with ``pricing_tiers`` a list of
        ``{min_prompt_tokens, ...prices}`` prompt-size overrides (the
        highest threshold not above the prompt size wins). Every price is
        nullable and ``null`` means **unpriced, not free**: a local model
        declares no prices, and a caller that reads that as ``0`` publishes
        a fabricated cost. The managed ``parslee/…`` alias rows carry the
        same prices as the upstream row they front, and this response
        carries no upstream identifier for them. That holds for this
        catalog view; ``models.search`` additionally exposes a ``family``
        field which does name the upstream model family. Daemons older
        than this field omit ``cost`` entirely; it deserializes to
        all-``null`` rather than failing the response.
        """

    def register_model(self, schema_json: str) -> str:
        """Register a ``ModelSchema`` via the daemon's
        ``models.register`` JSON-RPC method
        (Parslee-ai/car-releases#39). Persisted to
        ``~/.car/models.json``; live hot-update inside a running
        daemon is tracked as a separate follow-up. Register
        before the daemon's inference path starts using the model,
        or restart the daemon after registration.

        Returns JSON ``{"id", "registered", "path", "note"}``.
        """

    def assistant_identity_get(self) -> str:
        """``assistant.identity.get`` — the name the flagship assistant answers
        to.

        Returns JSON ``{"name", "spellings", "aliases", "user_name", "brand",
        "updated_at_unix"}``. ``aliases`` is the derived match set (name and
        spellings crossed with "hey"/"ok"/…), longest first — hosts match wake
        phrases against it locally so their matcher works before the daemon
        answers. ``brand`` is the fixed product name and never changes;
        ``name`` is what this user calls the assistant.

        Ungated — a name is not a credential. A malformed ``identity.json``
        raises rather than silently answering with the default name.
        """

    def assistant_identity_set(self, request_json: str) -> str:
        """``assistant.identity.set`` — name the assistant. Host/local-auth
        gated on the daemon, because a rename repoints the voice wake word.

        ``request_json`` is ``{"name"?, "spellings"?, "user_name"?}``. Every
        field is optional and unset fields are preserved, so a caller that only
        knows about the name cannot wipe spellings another surface wrote. Pass
        ``user_name: None`` to clear it. Returns the updated identity JSON.
        """

    def messaging_config_get(self, request_json: str | None = None) -> str:
        """``messaging.config.get`` — read one channel's approval-transport
        config (enabled flag, allowlisted handles, whether a pairing is in
        flight). Host/local-auth gated on the daemon. ``request_json`` is an
        optional ``{"channel"?}`` selector — ``channel`` is ``"imessage"`` |
        ``"slack"``, default ``"imessage"``. Returns ``MessagingConfigView``
        JSON (which carries a ``channel`` key naming the channel it describes).
        """

    def messaging_config_set(self, request_json: str) -> str:
        """``messaging.config.set`` — mutate one channel's approval-transport
        config. The ONLY allowlist/config-mutation path; host/local-auth
        gated. ``request_json`` is a ``MessagingConfigSetRequest``
        (``{"channel"?, "enabled"?, "allowlisted_handles"?, "add_handles"?,
        "remove_handles"?, "bot_token"?, "app_token"?}``). ``channel`` is
        ``"imessage"`` | ``"slack"``, default ``"imessage"`` when absent
        (back-compat). For ``channel: "slack"``, supplying BOTH ``bot_token``
        (``xoxb-``) and ``app_token`` (``xapp-``) provisions them into the OS
        keychain (MC-9); only a keychain reference is persisted to the config —
        the bearer values never land on disk nor echo back. Returns the updated
        ``MessagingConfigView`` JSON.
        """

    def messaging_pairing_start(self, request_json: str | None = None) -> str:
        """``messaging.pairing.start`` — mint a fresh high-entropy pairing
        code for one channel to display ONLY in the local UI; the paired device
        sends it back to bind its handle. Host/local-auth gated.
        ``request_json`` is an optional ``{"channel"?}`` selector
        (``"imessage"`` | ``"slack"``, default ``"imessage"``). Returns
        ``MessagingPairingStartResponse`` JSON (``{"pairing_code", "config"}``).
        """

    def messaging_pairing_status(self, request_json: str | None = None) -> str:
        """``messaging.pairing.status`` — whether a pairing is in flight on one
        channel and (host gated) the active code. ``request_json`` is an
        optional ``{"channel"?}`` selector (``"imessage"`` | ``"slack"``,
        default ``"imessage"``). Returns ``MessagingPairingStatusResponse``
        JSON.
        """

    def messaging_status(self, request_json: str | None = None) -> str:
        """``messaging.status`` — the real runtime liveness of one channel's
        approval transport, computed daemon-side so a host UI can render a
        SINGLE readiness state (enabled · watcher running · FDA · paired) plus
        last-delivered + last-error. Host/local-auth gated. ``request_json`` is
        an optional ``{"channel"?}`` selector (``"imessage"`` | ``"slack"``,
        default ``"imessage"``). Returns ``MessagingStatusView`` JSON.
        """

    def messaging_test_send(self, request_json: str | None = None) -> str:
        """``messaging.test_send`` — send a fixed, clearly-labeled self-test
        message to one channel's paired handle and return ``{"ok", "error"}``
        synchronously. A pure send probe: it mints NO approval/pairing mapping
        and resolves nothing. Host/local-auth gated. ``request_json`` is an
        optional ``{"channel"?}`` selector (``"imessage"`` | ``"slack"``,
        default ``"imessage"``). Returns ``MessagingTestSendResponse`` JSON.
        """

    def recommend(self, use_case: str, tier: str, cloud_ok: bool) -> str:
        """Recommend models for this machine + intent. ``use_case``/``tier``
        are snake_case enum values (e.g. ``"coding"``, ``"most_capable"``);
        ``cloud_ok`` lets cloud models compete. Returns the
        ``RecommendationSet`` JSON (``{"picks", "not_enough_memory", "note"}``).
        """

    def coder_start(
        self,
        repo: str,
        intent: str,
        *,
        engine: str | None = None,
        max_iterations: int | None = None,
        model: str | None = None,
        repair_invokes: int | None = None,
        transient_retries: int | None = None,
        discussion_id: str | None = None,
    ) -> str:
        """Start a coder session (built-in coding agent): provisions an
        isolated git worktree of ``repo`` and derives a verifiable outcome
        contract from ``intent``. ``engine`` is ``"auto" | "native" |
        "external[:agent_id]"`` (default auto). ``model`` pins the native
        loop's inference model for this session (e.g. ``"parslee/reasoning"``),
        overriding ``~/.car/coder.toml``; blank/omitted = the config default,
        then adaptive routing. Returns ``{"session_id", "state", "engine",
        "worktree", "contract", "model"}`` JSON, where ``model`` is the
        effective pin (``null`` = adaptive). ``repair_invokes`` is the external
        engine's hypothesis budget (fresh repair invocations after a red pass;
        recurrence escalation needs >= 2 to reach the model) and
        ``transient_retries`` its availability budget (re-invocations after the
        CLI process died mid-run) — deliberately separate, since one buys a
        hypothesis and the other buys a retry. ``discussion_id`` names a
        ``coder.discuss`` conversation this run was distilled from: its agreed
        constraints ride into contract derivation, so a rule stated once in the
        discussion need not be restated in the intent, and the session records
        the provenance. An unknown id is an error, never a silently ungrounded
        run. Sessions live in the daemon; live ``coder.event`` streaming is
        WebSocket-only (``coder.subscribe``).

        .. versionchanged:: 0.44.0
           The options are keyword-only. They were five consecutive positional
           optionals a caller could silently mis-order; passing them
           positionally now raises ``TypeError``."""

    def coder_confirm_contract(
        self, session_id: str, contract_json: str | None = None
    ) -> str:
        """Confirm the proposed outcome contract (optionally replacing it
        with the edited ``contract_json``) and start the work loop."""

    def coder_list(self) -> str:
        """List coder sessions (live and persisted), newest first."""

    def coder_get(self, session_id: str) -> str:
        """Full coder session detail, including contract and check results."""

    def coder_respond(self, session_id: str, text: str) -> str:
        """Answer a ``user_input_requested`` coder event (reserved)."""

    def coder_approve_merge(self, session_id: str, approve: bool) -> str:
        """Approve (publish the ``car/coder/<id>`` branch in the repo) or
        deny (abandon) a coder session awaiting merge approval."""

    def coder_cancel(self, session_id: str) -> str:
        """Cancel a coder session: stop the loop, abandon, remove the
        worktree. Returns ``{"state", "already_terminal", "message"}``.

        An already-finished session **succeeds** rather than raising: ``state``
        keeps its pre-existing name and type, ``already_terminal`` is ``True``,
        and ``message`` names what already happened. Callers that cancel
        unconditionally on shutdown depend on that."""

    def coder_watch(self, renew: bool | None = None) -> str:
        """The current session list AND registration for
        ``coder.session_changed`` on this connection, atomically (registered
        under the same lock the list is snapshotted under, so no session slips
        through the gap). Notifications are WebSocket-only, same contract as
        ``coder.subscribe``.

        Each row carries the pre-existing ``{"session_id", "state", "intent",
        "repo", "engine", "iterations", "updated_at", "live", "error"}`` plus
        ``needs_you`` (``"contract" | "question" | "approval" | "auth" |
        None``), ``needs_you_label`` (daemon-owned wording so every client says
        the same thing), ``question_prompt``, ``auth_message``,
        ``auth_wait_secs``, ``failure_kind`` (``"budget_exhausted" |
        "auth_required" | "infrastructure" | "error"`` when failed),
        ``worktree`` (only when it still exists on disk), ``project``,
        ``result_branch``, ``model``, ``discussion_id`` and ``next_seq`` (live
        only — the ``coder.subscribe`` cursor).

        ``renew=True`` sends the lease-renewal form instead: it re-registers
        idempotently and answers ``{"was_registered": bool}`` — ``False`` means
        this connection had been shed and should take a full snapshot — and
        builds NO summaries, so it is cheap enough to call on a timer. The
        default form is unchanged."""

    def coder_unwatch(self) -> str:
        """Stop receiving ``coder.session_changed`` on this connection."""

    def coder_revise_contract(self, session_id: str, request: str) -> str:
        """Redraft a PROPOSED outcome contract from a plain-English request
        (e.g. "also verify the Windows path"). Legal only in
        ``contract_proposed``; nothing executes and the session stays at the
        gate either way. Unlimited rounds.

        Returns ``{"state", "revised", "contract", "baseline",
        "baseline_gates_nothing", "message"}``. **Check ``revised`` before
        trusting ``contract``**: on a redraft that does not validate, the
        previous contract comes back byte-identical with ``revised: False`` and
        a ``message`` explaining why, and the daemon emits a
        ``contract_revision_rejected`` event."""

    def coder_discuss_start(self, repo: str) -> str:
        """Open a repo-grounded, strictly **read-only** discussion — a thinking
        surface for working out what a change should be, before a run exists.
        Bound at ``PermissionTier::ReadOnly`` with every write/shell escalation
        auto-denied, so it can never touch the repo. Returns
        ``{"discussion_id", "repo", "repo_summary"}``; a non-git path is a
        clear error."""

    def coder_discuss_send(self, discussion_id: str, text: str) -> str:
        """Send one operator message. Returns ``{"ok", "seq"}`` where ``seq``
        is the first event this turn emits; the reply streams as
        ``coder.discuss.event`` (WebSocket-only, same contract as
        ``coder.event``)."""

    def coder_discuss_promote(self, discussion_id: str) -> str:
        """Distill the discussion into ``{"discussion_id",
        "proposed_intent", "constraints"}``. **Starts nothing** — no worktree,
        no branch, no session. Show ``proposed_intent`` (never the transcript)
        for the operator to edit, then pass it to ``coder_start`` with
        ``discussion_id`` so the agreed constraints reach contract derivation.
        Callable repeatedly."""

    def coder_discuss_close(self, discussion_id: str) -> str:
        """Free an in-memory discussion. Discussions do not survive a daemon
        restart."""

    def coder_discuss_list(self) -> str:
        """Open discussions: ``{"discussions": [{"discussion_id", "repo",
        "created_at", "turns"}]}``. Also the capability probe — a daemon
        predating this surface answers JSON-RPC ``-32601``."""

    def project_create(self, name: str, kind: str | None = None) -> str:
        """Create (or load) a CAR-managed git-backed project under
        ``~/.car/projects/``. ``kind`` is ``"app"`` (code) or ``"agent"``
        (an in-daemon declarative agent). Returns CoderProject JSON."""

    def project_list(self) -> str:
        """List managed projects, newest first."""

    def project_get(self, slug: str) -> str:
        """One project's metadata by slug."""

    def parslee_capabilities(self) -> str:
        """Discover what the signed-in Parslee account can do — identity, m365
        product entitlements, and Studio reachability. Read-only. Returns JSON."""

    def parslee_m365_generate_document(
        self,
        content_brief: str,
        output_file_path: str,
        document_type: str | None = None,
        title: str | None = None,
        author: str | None = None,
    ) -> str:
        """Generate a Word document from a natural-language brief, saved to the
        user's connected drive. Gated on the `aie` entitlement. document_type
        defaults to `Report`. Returns JSON `{ file_id, web_url, ... }`."""

    def declagent_list(self) -> str:
        """List registered in-daemon declarative agents."""

    def declagent_get(self, id: str) -> str:
        """One declarative agent's spec by id."""

    def declagent_remove(self, id: str) -> str:
        """Unregister a declarative agent."""

    def declagent_set_enabled(self, id: str, enabled: bool) -> str:
        """Enable or disable a declarative agent."""

    def declagent_invoke(self, id: str, input: str) -> str:
        """Run a declarative agent on an input, in-daemon (no external
        process). Returns ``{output, turns, tool_calls, error?}`` JSON."""

    def declagent_route(self, need: str, invoke: bool) -> str:
        """Route a need to the best-matching declarative agent by capability
        similarity. Returns ``{chosen, candidates, next_visited, invoked,
        result?}`` JSON. With ``invoke=True`` the top agent is run on ``need``
        and its result is included. Network-entry case only; multi-hop Forward
        chaining (``from`` / ``visited``) is WS-only."""

    def declagent_route_split(
        self,
        need: str,
        invoke: bool,
        max_subtasks: int | None = None,
        decomposition_mode: str | None = None,
        sad_hints: int | None = None,
        sad_iterations: int | None = None,
        sad_convergence_jaccard: float | None = None,
    ) -> str:
        """Split a composite need into subtasks and route each to its
        best-matching agent. Returns ``{subtasks, count, invoked}`` JSON.
        ``max_subtasks`` caps the split (clamped to [1, 10]; None = default 5).
        With ``invoke=True`` each subtask's chosen agent runs."""

    def declagent_routing_stats(self) -> str:
        """Read-only view of the learned routing topology: per-agent success
        stats and directed agent->agent edge weights. Returns ``{agents,
        edges}`` JSON."""

    def discovery_resolve(self, need: str, limit: int | None = None) -> str:
        """AgentDNS-style discovery: resolve a need into ranked CAR-local
        services, each named under ``agentdns://org/category/name``. Providers:
        declarative agents, observe-only registry services
        (``~/.car/registry/``, kind ``registry``), MCP connector tools,
        external CLIs, A2A peers, and an opt-in remote root. Returns
        ``{services, count}`` JSON. ``limit`` caps results (clamped to [1, 50];
        None = default 5)."""

    def discovery_report(self, identifier: str, outcome: str) -> str:
        """Record a discovery-routed run's outcome (``"success"`` |
        ``"failure"``) into the routing learning store, keyed by the service's
        ``agentdns://`` identifier — for EVERY provider kind (connector,
        registry, external, a2a, declarative). This is the feedback loop
        ``discovery_resolve``'s success prior learns from. Returns
        ``{identifier, outcome, successes, failures}`` JSON."""

    def discovery_route_compose(
        self,
        need: str,
        max_subtasks: int | None = None,
        decomposition_mode: str | None = None,
        sad_hints: int | None = None,
        sad_iterations: int | None = None,
        sad_convergence_jaccard: float | None = None,
        candidates_per_step: int | None = None,
        rerank: bool = False,
    ) -> str:
        """Compose a decompose/retrieve/plan route over all discoverable
        services. Returns ``{plan, decomposition, candidates, metadata}`` JSON.
        Planning only; callers invoke returned targets through existing
        governed surfaces."""

    def setup_plan(self, use_case: str, tier: str, cloud_ok: bool) -> str:
        """Build a concrete onboarding plan (machine summary, top pick,
        alternatives, needs-more-memory, note) as JSON."""

    def detect_upgrades(self) -> str:
        """Detect upgrades (curated + upstream, channel-gated). Returns JSON."""

    def check_upgrade_nudge(self, inference_active: bool) -> str:
        """The current proactive-upgrade decision (poll form) as JSON."""

    def dismiss_upgrade(self, dismiss_key: str) -> str:
        """Dismiss an upgrade nudge by its ``dismiss_key`` so it never re-fires."""

    def update_prefs_get(self) -> str:
        """Get update preferences as JSON."""

    def update_prefs_set(self, prefs_json: str) -> str:
        """Set update preferences (JSON ``UpdatePreferences`` shape). Returns
        the stored preferences JSON."""

    def route_model(self, prompt: str, intent_json: Optional[str] = None) -> str:
        """Pick a model for ``prompt``. Returns the routing decision as JSON,
        including ``candidates``: the advisory ranking of every scored model
        (``{model_id, reliability, score, selected, in_band}``) so callers can
        see why a model won and what the alternatives cost in reliability terms.
        Empty on explicit-model and cold-start paths where no ranking occurred.

        ``intent_json`` — optional JSON-serialized ``IntentHint``; notably
        ``exclude_models`` ("any capable model that is NOT this one") for
        adversarial-reviewer separation (car#358). Each entry may be a catalog
        model id **or** a model name — the two differ for most models, and the
        name is what a result reports as the model it used, so the identifier
        you have in hand always works (car#889)."""

    def model_stats(self) -> str:
        """Return per-model performance profiles as JSON."""

    def outcome_scoreboard(self) -> str:
        """Return the persistent outcome scoreboard as JSON, folded from the
        durable outcome ledger: ``{rows: [{model_id, success_count, fail_count,
        inconclusive_count, total_input_tokens, total_output_tokens, avg_quality,
        avg_latency_ms, success_rate, tokens_per_success, usd_per_success}],
        total_successes, total_failures, total_inconclusive, total_usd,
        overall_usd_per_success, model_count, receipts}``. Rows are sorted
        cheapest-correct-outcome first. Cross-session and outcome-denominated
        (unlike ``model_stats``, the live in-memory profiles)."""

    # --- Skills -------------------------------------------------------

    def ingest_skill(
        self,
        name: str,
        code: str,
        platform: str,
        persona: str,
        url_pattern: str,
        task_keywords: List[str],
        description: str,
        supersedes: Optional[str] = None,
    ) -> int:
        """Save a learned skill with trigger context. Returns the node index.

        In Daemon mode, raises ``RuntimeError`` when the daemon is
        unreachable or returns a malformed response, instead of
        silently returning 0 (#146).
        """

    def find_skill(
        self,
        persona: str,
        url: str,
        task: str,
        max_results: Optional[int] = None,
    ) -> str:
        """Find skills matching the context. Returns JSON or the string ``"null"``."""

    def report_outcome(self, skill_name: str, outcome: str) -> str:
        """Record skill outcome. ``outcome`` must be ``"success"`` or ``"fail"``.

        Returns updated stats JSON. Skills auto-degrade when
        ``fail_count > success_count + 2``.
        """

    def distill_skills(self, events_json: str) -> str:
        """Distill skills from execution trace events. Returns JSON array."""

    def ingest_distilled_skills(self, skills_json: str) -> int:
        """Ingest distilled skills into the memory graph. Returns count."""

    def list_skills(self, domain: Optional[str] = None) -> str:
        """List skills (optionally filtered by domain). Returns JSON array."""

    def domains_needing_evolution(
        self,
        threshold: Optional[float] = None,
    ) -> List[str]:
        """Return domain names where skill quality has dropped below ``threshold``."""

    def repair_skill(self, skill_name: str) -> Optional[str]:
        """Repair a degraded skill via inference. Returns repaired code or ``None``."""

    def evolve_skills(self, events_json: str, domain: str) -> str:
        """Evolve skills for ``domain`` based on failed traces. Ingests + returns JSON."""

    def ingest_provisional_skills(
        self,
        skills_json: str,
        tenant: Optional[str] = None,
    ) -> int:
        """Ingest skills as validation-gated PROVISIONAL candidates on trial.

        Unlike :meth:`ingest_distilled_skills` (which trusts skills active),
        these must prove themselves before the promotion gate makes them Active.
        Returns the count ingested. See docs/solutions/gated-skill-optimization.md.
        """

    def gate_skill_candidates(self) -> str:
        """Run the skill promotion gate.

        Provisional candidates with enough trial outcomes are promoted
        (strictly-better Wilson lower bound) or rejected. Returns JSON
        ``{"promoted": [...], "rejected": [...]}`` of resolved candidate keys.
        """

    def skill_meta(self, key: str) -> str:
        """Fetch a skill's full ``SkillMeta`` by key.

        Includes lifecycle ``status`` (active/provisional), ``incumbent``,
        ``version``, and ``stats``. Returns JSON ``SkillMeta`` or the string
        ``"null"`` if no active skill node holds the key.
        """

    def export_skill(self, key: str) -> Optional[str]:
        """Export a VALIDATED skill as a portable markdown document.

        The SkillOpt ``best_skill.md`` analog. Only Active, healthy skills
        export. Returns the markdown, or ``None`` if the key is absent or not
        exportable (provisional or degraded).
        """

    def import_skill(self, markdown: str) -> bool:
        """Import a skill from a portable markdown document (digest-verified).

        Ingests as a fresh Active skill. Returns ``True`` on success; raises if
        the document is malformed or its content digest doesn't verify.
        """

    # --- Secrets ------------------------------------------------------

    def secret_put(
        self,
        key: str,
        value: str,
        service: Optional[str] = None,
    ) -> str: ...

    def secret_get(self, key: str, service: Optional[str] = None) -> str: ...

    def secret_delete(self, key: str, service: Optional[str] = None) -> str: ...

    def secret_status(self, key: str, service: Optional[str] = None) -> str: ...

    def secret_available(self) -> str: ...

    def secret_list(self) -> str: ...

    # --- Permissions --------------------------------------------------

    def permission_status(
        self,
        domain: str,
        target_bundle_id: Optional[str] = None,
    ) -> str:
        """JSON `{domain, status, target_bundle_id}`. `status` is granted |
        denied | not_determined | restricted | not_applicable | restart_required
        | signature_changed | unknown. The `calendar` domain uses a real,
        non-prompting EventKit query and can additionally return `write_only`
        (macOS-14 write-only grant). (car-releases#71)"""
        ...

    def permission_request(
        self,
        domain: str,
        target_bundle_id: Optional[str] = None,
    ) -> str: ...

    def permission_explain(
        self,
        domain: str,
        target_bundle_id: Optional[str] = None,
    ) -> str: ...

    def permission_domains(self) -> str: ...

    # --- Accounts / Calendar / Contacts / Mail / Messages / Health ----

    def accounts_list(self) -> str: ...

    def accounts_open(self, account_id: Optional[str] = None) -> str: ...

    def calendar_list(self) -> str: ...

    def calendar_events(
        self,
        start_rfc3339: str,
        end_rfc3339: str,
        calendar_ids: Optional[List[str]] = None,
    ) -> str:
        """JSON for events in [start, end]. Each event carries `status`
        (confirmed|tentative|canceled|none) and `attendees` as objects —
        {name?, email?, status?, role?, is_current_user} — from EventKit, so a
        consumer can distinguish a firm commitment from a tentative RSVP (#68)."""
        ...

    def calendar_create_event(self, input_json: str) -> str: ...

    def calendar_update_event(self, input_json: str) -> str: ...

    def calendar_delete_event(self, event_id: str) -> str: ...

    def contacts_containers(self) -> str: ...

    def contacts_find(
        self,
        query: str,
        container_ids: Optional[List[str]] = None,
        limit: Optional[int] = None,
    ) -> str: ...

    def mail_accounts(self) -> str: ...

    def mail_inbox(self, account_ids: Optional[List[str]] = None) -> str: ...

    def mail_mailboxes(self, account_ids: Optional[List[str]] = None) -> str:
        """Every mailbox (folder) of the given accounts, nested ones included
        on BOTH backends.

        JSON ``{available, backend, reason?, mailboxes: [...]}`` where a row is
        ``{account_id, name, full_name, unread, total}``. ``full_name`` is the
        selector to pass back as ``MessageQuery.mailbox`` — the slash-joined
        path on macOS, the folder id on Microsoft Graph. Graph's
        ``/me/mailFolders`` is root-only, so nested folders come from a bounded
        ``childFolders`` walk (depth 8, at most 64 requests); a tree deeper or
        wider than that is truncated.

        An ``account_ids`` filter that matches no account returns
        ``available: false`` with a reason, not an empty list.
        """
        ...

    def mail_messages(self, query_json: str) -> str:
        """Message rows, newest first.

        ``query_json`` is a ``MessageQuery``: ``{account_ids?, mailbox?,
        limit?, since?, include_body?}``. Every field defaults and
        ``mailbox: null`` means INBOX, so ``"{}"`` reproduces the pre-existing
        INBOX-only read.

        "Newest first" is GLOBAL, not per account: rows from every matched
        account are merged into one date-ordered list before ``limit`` applies,
        so ``limit: 1`` across two accounts returns the newer message rather
        than whichever account the backend listed first.

        Each row carries a stable opaque ``id`` accepted by
        :meth:`mail_message_body`, and a ``mailbox`` holding the mailbox as the
        backend RESOLVED it (a query for ``"travel"`` comes back stamped
        ``"Travel/2026"``), so rows match :meth:`mail_mailboxes` output. An
        unresolvable mailbox or an unmatched ``account_ids`` returns
        ``available: false`` with a reason, never an empty list.
        """
        ...

    def mail_message_body(self, message_id: str) -> str:
        """One message body, by the ``id`` from a :meth:`mail_messages` row.

        JSON ``{available, backend, reason?, id, content_type, body,
        truncated}``; bodies are cut at 100,000 characters.
        """
        ...

    def mail_send(self, send_request_json: str) -> str: ...

    def messages_services(self) -> str: ...

    def messages_chats(self, limit: Optional[int] = None) -> str: ...

    def messages_send(self, send_request_json: str) -> str: ...

    def notes_accounts(self) -> str: ...

    def notes_find(self, query: str, limit: int = 50) -> str: ...

    def reminders_lists(self) -> str: ...

    def reminders_items(self, limit: int = 50) -> str: ...

    def photos_albums(self) -> str: ...

    def bookmarks_list(self, limit: int = 100) -> str: ...

    def files_locations(self) -> str: ...

    def keychain_status(self) -> str: ...

    def health_status(self) -> str: ...

    def health_sleep(self, start_rfc3339: str, end_rfc3339: str) -> str: ...

    def health_workouts(self, start_rfc3339: str, end_rfc3339: str) -> str: ...

    def health_activity(self, start_ymd: str, end_ymd: str) -> str:
        """Date format here is ``YYYY-MM-DD`` — different from sleep/workouts."""

    # --- Browser ------------------------------------------------------

    def browser_run(
        self,
        script_json: str,
        width: Optional[int] = None,
        height: Optional[int] = None,
        headed: Optional[bool] = None,
        extra_args: Optional[List[str]] = None,
    ) -> str:
        """Run a JSON script of browser operations.

        ``extra_args`` (#112): extra Chromium CLI flags appended
        verbatim at launch. Used by the Google Meet bot to pass
        ``--use-fake-ui-for-media-stream``,
        ``--autoplay-policy=no-user-gesture-required``, and the
        container-friendly ``--no-sandbox`` /
        ``--disable-dev-shm-usage`` /
        ``--disable-setuid-sandbox``. Honoured only on the call
        that first launches the session; subsequent calls reuse
        the existing browser regardless.
        """

    def browser_close(self) -> None: ...

    # `browser_run`/`browser_close` above are this runtime's OWN
    # per-connection scripted browser. Separate from that: the browser
    # DRAWER surface (`browser.view.*` / `browser.producer.*` /
    # `agent.browser.*`), which watches and drives the ASSISTANT's
    # browser (or the shared standing session) for a human at the
    # Command Deck. It is WS-only — no method here — the same decision
    # as `runs.subscribe` / `coder.subscribe`: `browser.view.*` requires
    # the host-management client (`session.auth { host_token }`,
    # stricter than `runs.subscribe`), so CarHost speaks it directly
    # over the daemon's WS. `browser.producer.*` / `agent.browser.*` is
    # the agent side of the same relay; today its only producer is the
    # Rust `car-cli` binary, so it likewise has no binding here. Full
    # wire contract: docs/websocket-protocol.md (`### browser`) and
    # docs/host-protocol.md (`Live browser view`).

    # --- Meeting ------------------------------------------------------

    def start_meeting(self, request_json: str) -> str:
        """Start a meeting capture on the daemon. Voice events stream back as
        ``voice.event`` JSON-RPC notifications and dispatch to the handler
        registered via :func:`register_voice_event_handler`."""

    def stop_meeting(self, meeting_id: str, summarize: bool = True) -> str: ...

    def list_meetings(self, root_override: Optional[str] = None) -> str:
        """List meetings persisted on the daemon under ``root_override`` (defaults
        to the daemon's ``cwd/.car/meetings``)."""

    def get_meeting(
        self, meeting_id: str, root_override: Optional[str] = None
    ) -> str:
        """Fetch one meeting by id from the daemon."""

    # --- Voice turn dispatch (two-track sidecar pattern) -------------

    def dispatch_voice_turn(self, request_json: str) -> str:
        """Dispatch a voice-turn utterance through the two-track sidecar pattern.

        ``request_json`` is JSON-encoded ``DispatchVoiceTurnRequest``:
        ``{"utterance": str, "session_id"?: str, "config_overlay"?: str,
        "sidecar_timeout_ms"?: int}``.

        Returns ``{"turn_id": N}`` JSON synchronously. Fast deltas, bridge
        phrases, sidecar results, errors, and cancellations are pushed
        through the Python callback registered via
        ``register_voice_event_handler`` as JSON ``voice.turn.*`` events.
        The host plays audio from those events — CAR does not own the
        speaker on this path.

        Not available in Daemon mode.
        """

    def cancel_voice_turn(self) -> None:
        """Cancel the in-flight voice turn (if any). Idempotent."""

    def prewarm_voice_turn(self) -> None:
        """Prewarm the fast model with a 1-token probe.

        Best-effort and idempotent. Call at app startup so the first
        user turn meets the <500ms first-audio target.

        Not available in Daemon mode.
        """


# ---------------------------------------------------------------------------
# Verification (module-level, stateless)
# ---------------------------------------------------------------------------

def verify(
    proposal_json: str,
    initial_state_json: Optional[str] = None,
    tool_names: Optional[List[str]] = None,
    max_actions: Optional[int] = None,
    tool_schemas_json: Optional[str] = None,
) -> str:
    """Statically verify a proposal. Returns JSON ``{valid, issues,
    simulated_state, execution_levels, conflicts, evidence}``.

    ``tool_names`` checks tool existence only. To also validate each
    ``tool_call``'s parameters against the tool's JSON Schema — catching
    type mismatches (``{"path": 42}`` for a ``string``) and missing
    required fields — pass ``tool_schemas_json``: a JSON array of tool
    schemas, e.g. ``json.dumps([{ "name": "echo", "parameters": {
    "type": "object", "properties": {"msg": {"type": "string"}},
    "required": ["msg"] } }])``. ``tool_schemas_json`` takes precedence
    when both are supplied.

    ``evidence`` is the verifier's declared scope (survey "Code as Agent
    Harness" §5.2.2): ``{checks: [{name, ran, verifies, cannot_verify,
    findings, tier}], assumptions, untested_regions, residual_risks,
    confidence}`` — so a ``valid: true`` verdict carries what was
    checked, what could not be, and a 0–1 coverage confidence, rather
    than reading as a blanket guarantee.

    Each issue is ``{action_id, severity, message, tier}``. ``tier`` is
    the **evidence tier** — ``"decision_procedure" | "heuristic" |
    "sampled"`` — naming which kind of check produced the finding, so
    callers need not pattern-match the message to tell them apart. All of
    ``verify``'s findings are ``decision_procedure`` (set membership, the
    STRIPS-style forward walk, write-conflict detection) except the
    repeated-identical-call rule, which is ``heuristic``: the count is
    exact, "runaway loop" is a proxy, and a legitimate 3× poll trips it.
    The tier is orthogonal to ``severity`` (how bad, not how derived),
    and ``decision_procedure`` is not a proof or a soundness claim — it
    means the check decides the property it reports over the inputs it
    was given, which for the state-dependent checks is a forward model
    built only from *declared* effects. Each check record carries the
    same ``tier`` as the findings it contributed.
    """


def simulate(
    proposal_json: str,
    initial_state_json: Optional[str] = None,
) -> str:
    """Simulate proposal effects without calling tools. Returns final state JSON."""


def simulate_monte_carlo(
    proposal_json: str,
    initial_state_json: Optional[str] = None,
    tool_success_rates_json: Optional[str] = None,
    goal_json: Optional[str] = None,
    config_json: Optional[str] = None,
) -> str:
    """Sample N rollouts of a proposal with tools allowed to fail.

    :func:`simulate` answers "what state does this plan leave behind,
    assuming every dispatched tool succeeds?" This answers "how often
    does it actually work, and when it doesn't, what breaks first?"
    Each ``tool_call`` succeeds with the probability given in
    ``tool_success_rates_json`` (a JSON object mapping tool name to a
    rate in ``0.0..=1.0`` — the shape produced by the planner's
    per-tool trajectory feedback). Failures cascade through the
    dependency graph exactly as they would at runtime: an action whose
    dependency never landed is rejected before dispatch, not retried.

    ``goal_json`` is an optional ``GoalCondition`` evaluated against
    each trial's final state. Conditions a simulation cannot decide —
    tool receipts, command exits, model judges — fail closed and are
    named in ``goal_underivable_conditions``, so a ``p_goal_reached``
    of 0 is never silently mistaken for "this plan cannot work".

    ``config_json`` is an optional ``{trials, seed,
    default_success_rate, retry_attempts}``; every field is
    individually optional. Defaults are 1000 trials, a fixed seed, 0.5
    for tools with no recorded history, and no retries. The seed is
    fixed rather than time-derived so runs are reproducible, and it is
    echoed back in the result.

    Returns JSON: ``{trials, seed, p_goal_reached,
    goal_underivable_conditions, p_all_effects_landed,
    tool_calls: {mean, min, p50, p95, max}, actions_executed: {...},
    state_distribution: [{key, p_present, values: [{value,
    probability}]}], action_outcomes: [{action_id, p_rejected,
    p_failed, p_effects_landed, mean_blast_radius}]}``.

    Independence caveat: draws are uncorrelated, so a plan that calls
    one flaky tool repeatedly reads more optimistically here than it
    will behave when that tool's backing service is down.
    """


def optimize(proposal_json: str) -> str:
    """Return an optimized version of the proposal as JSON."""


def equivalent(p1_json: str, p2_json: str) -> bool:
    """Return True if two proposals are semantically equivalent."""


def protocol_version() -> int:
    """Wire protocol version this binding speaks to the car-server daemon.

    Exchanged via the ``server.handshake`` RPC; bumped only on a
    backward-incompatible JSON-RPC change, independent of the package semver.
    """


__version__: str
"""Version of THIS ``car-runtime`` PyPI package. Same value as
:func:`client_version`."""


def client_version() -> str:
    """Version of THIS ``car-runtime`` PyPI package.

    The client library that talks to the daemon, and the number the
    version-skew notice compares against ``car-server``. Not the same thing as
    ``car --version``: on macOS ``/usr/local/bin/car`` is a symlink into
    ``CarHost.app``, so that reports the bundled CLI. When the stale component
    is this package — a ``car-runtime`` in a consumer's virtualenv — the CLI's
    version is the wrong one to check (Parslee-ai/car#1050).
    """


def transaction_check(
    proposal_json: str,
    versions_json: Optional[str] = None,
    state_json: Optional[str] = None,
) -> str:
    """Check a proposal for transactional conflicts against shared state.

    Survey "Code as Agent Harness" §4.3/§5.2.4. ``versions_json`` maps state
    key → current version; ``state_json`` (optional) maps key → current
    value for value-level assumption checks. Returns the ``TransactionReport``
    JSON ``{consistent, conflicts: [{kind, key, actions, explanation,
    resolution}]}`` where ``kind`` is ``"write_write" | "read_write" |
    "stale_assumption"`` — write-write races, read-write hazards, and stale
    assumptions (belief divergence) across concurrent actions/agents.
    """


def crdt_merge(replicas_json: str) -> str:
    """Merge replicas of a CRDT shared state (strong eventual consistency).

    Applies arXiv 2510.18893 ("CodeCRDT"); see
    ``docs/proposals/convergent-shared-state.md``. ``replicas_json`` is a JSON
    array of last-writer-wins maps, each ``{"<key>": {"value": any, "version":
    int, "replica": str}}``. Per shared key the dominating ``(version, replica)``
    wins. Returns ``{"registers": <merged LWW map>, "state": <key→value>}`` —
    the merged CRDT (tags retained for further merging) and a materialized plain
    state. Order-independent and idempotent (zero merge failures). The
    deterministic resolution complementing ``transaction_check``'s detection.
    """


def crdt_export(snapshot_json: str, versions_json: str, replica: str) -> str:
    """Export a device/agent's state as a CRDT LWW map for replication.

    The export half of multi-device sync (arXiv 2510.18893). ``snapshot_json`` is
    the plain state ``{key: value}``; ``versions_json`` is ``{key: version}``;
    ``replica`` is this device/agent id. Returns the LWW map JSON ``{"<key>":
    {"value": any, "version": int, "replica": str}}``, ready to exchange between
    replicas and feed to ``crdt_merge``. Keys absent from ``versions_json``
    default to version 0.
    """


def utility_rank(candidates_json: str, exploration: float, utility_weight: float) -> str:
    """Rank memory-retrieval candidates by utility-aware UCB (U-Mem SA-CTS).

    Deterministic variant of arXiv 2602.22406; see
    ``docs/proposals/autonomous-memory-agents.md``. Blends each candidate's
    semantic ``relevance`` with a learned utility posterior
    ``Beta(success+1, fail+1)``: proven memories rise, untried ones get an
    exploration bonus, reproducibly (no RNG). ``candidates_json`` is a JSON array
    of ``{id, relevance, success?, fail?}``; ``exploration`` weights the
    cold-start uncertainty bonus; ``utility_weight`` (0..1) blends utility vs.
    raw relevance (0 = pure relevance, unchanged). Returns the ranked JSON array
    ``[{id, score, relevance, utility}]``, highest first.
    """


def cascade_decide(current_confidence: float, policy_json: str) -> str:
    """Decide U-Mem's cost-aware knowledge cascade (the *Evolve* escalation).

    Applies arXiv 2602.22406; see
    ``docs/proposals/autonomous-memory-agents.md``. Given the current confidence
    in a piece of knowledge and an escalation policy, returns the cheapest tier
    (self-reflect -> tool-verify -> human-expert) that reaches the confidence
    target within a cost budget. ``policy_json`` is ``{confidence_target, budget,
    tiers: [{tier, cost, expected_confidence}]}`` where ``tier`` is
    ``"self_reflect" | "tool_verify" | "human_expert"`` (cheapest-first). Returns
    the outcome JSON: ``{decision: "already_confident", confidence}``,
    ``{decision: "accept", tier, confidence, cost_spent}``, or ``{decision:
    "exhausted", best_tier, confidence, cost_spent}``. Pure decision core; the
    caller runs the chosen tier.
    """


def memory_system_diagnose(stats_json: str) -> str:
    """Diagnose a memory system along four data-management dimensions.

    Applies arXiv 2606.24775 (*Are We Ready For An Agent-Native Memory
    System?*); see ``docs/proposals/agent-native-memory-diagnostic.md``. Scores
    the memory store as a system — representation fidelity, retrieval precision,
    update correctness, long-horizon stability — and names the bottleneck module
    to invest in next. ``stats_json`` is aggregate counters ``{total_facts,
    structured_facts, total_edges, total_retrievals,
    total_proactive_injections, helpful_retrievals, conflicts_resolved,
    outstanding_outdated, facts_created, facts_superseded}`` (omitted fields
    default to 0). ``total_retrievals`` counts *deliberate* recalls only;
    harness-initiated proactive injections are reported separately as
    ``total_proactive_injections`` and never feed ranking (car#816).
    ``helpful_retrievals`` is always 0 today — ``record_fact_helpful`` has no
    production caller — so read a 0 there as "not wired", not "nothing
    helped". Returns the report JSON: the four 0..1
    dimension scores, an ``overall`` mean, ``bottleneck`` (``"representation" |
    "retrieval" | "update_correctness" | "long_horizon_stability" | "none"``),
    ``recommendation``, and ``evaluated``.
    """


def maintenance_decide(input_json: str) -> str:
    """Decide localized-vs-global memory maintenance (arXiv 2606.24775).

    Applies the paper's finding that localized maintenance is more cost-efficient
    than global reorganization; see
    ``docs/proposals/agent-native-memory-diagnostic.md``. Both strategies resolve
    the dirty regions; global only wins when its store-wide structural gain
    (valued) clears the extra cost of touching the whole store. ``input_json`` is
    ``{dirty_regions, total_regions, localized_cost_per_region,
    global_cost_per_region, global_structural_gain, gain_value}`` (omitted fields
    default to 0). Returns the decision JSON ``{strategy: "no_op" | "localized" |
    "global", localized_cost, global_cost, global_extra_value,
    global_net_advantage, rationale}``.
    """


def plan_evolution(request_json: str) -> str:
    """Plan an evolution cycle — the survey's *when + what to evolve*.

    arXiv 2507.21046 (*A Survey of Self-Evolving Agents*); see
    ``docs/proposals/self-evolution-governor.md``. ``request_json`` is ``{
    components: [{ component: "memory" | "skills" | "harness" | "context" |
    "tools", pressure?, evidence?, min_evidence?, cost? }], policy?: {
    pressure_threshold?, budget? } }``. Returns the ``EvolutionPlan`` JSON ``{
    decisions: [{ component, action: "evolve_now" | "defer" | "skip", priority,
    defer_reason?, reason }], spent, evolve_now }``. Evolves only under pressure,
    only with enough evidence, prioritized by ``pressure / cost`` within budget.
    """


def crdt_merge_claims(registries_json: str) -> str:
    """Merge first-claim-wins claim registries for multi-agent coordination.

    Observation-driven task coordination (arXiv 2510.18893, Slice 3).
    ``registries_json`` is a JSON array of registries ``{"<task>": {"claimant":
    str, "version": int, "replica": str}}``; per shared task the earliest
    ``(version, replica)`` claim wins. Returns ``{"registry": <merged>, "owners":
    {task: claimant}}`` — the merged CRDT plus the resolved one-owner-per-task
    view agents read to self-partition work. Order-independent and idempotent.
    """


def check_information_flow(
    proposal_json: str,
    labels_json: str,
    policy_json: Optional[str] = None,
) -> str:
    """Static information-flow + tool-sequence safety check over a plan.

    Applies arXiv 2601.08012 ("Towards Verifiably Safe Tool Use for LLM
    Agents"); see ``docs/proposals/verifiable-tool-safety.md``. ``labels_json``
    maps ``tool_name`` → capability-enhanced-MCP labels ``{capability?,
    confidentiality, trust, sink, declassifier}`` (defaulting to
    public/trusted/non-sink); ``policy_json`` (optional) is ``{min_confidential,
    forbidden_sequences: [[before, after]]}``. Returns the ``FlowReport`` JSON
    ``{safe, violations: [{kind, actions, key?, explanation, mitigation}]}``
    where ``kind`` is ``"sensitive_to_sink" | "forbidden_sequence"`` — catching
    sensitive data reaching an exfiltration/untrusted sink and forbidden tool
    orderings statically, before execution. Reasons over declared
    ``state_dependencies``/``expected_effects``; undeclared channels are out of
    scope. Tools absent from ``labels_json`` are unconstrained.
    """


def gate_information_flow(report_json: str, gate_policy_json: Optional[str] = None) -> str:
    """Map an information-flow report to an enforcement decision (Slice 2).

    See ``docs/proposals/verifiable-tool-safety.md``. ``report_json`` is the
    output of ``check_information_flow``; ``gate_policy_json`` (optional) is
    ``{on_sensitive_to_sink, on_forbidden_sequence}`` (each ``"allow" |
    "require_approval" | "block"``; defaults block data exfiltration and escalate
    forbidden orderings). Returns the ``FlowGateDecision`` JSON ``{action,
    blocked, needs_approval, reason}`` where ``action`` is the most severe across
    violations — turning the advisory check into a gate that blocks clear hazards
    and escalates ambiguous ones to HITL.
    """


def transaction_check_with_predictions(
    proposal_json: str,
    predictions_json: str,
    versions_json: Optional[str] = None,
    state_json: Optional[str] = None,
) -> str:
    """Pre-flight conflict detection with predicted writes (CWM Slice 3b).

    Like ``transaction_check``, but unions each action's write set with the keys
    a verified Code World Model predicts it writes (see
    ``docs/proposals/code-world-models.md``). ``predictions_json`` maps
    ``action_id`` → array of predicted write keys (the caller produced them by
    running the generated model). Catches a tool that writes a key it didn't
    declare *before* execution. Returns the same ``TransactionReport`` JSON
    ``{consistent, conflicts}`` as ``transaction_check``.
    """


def enforce_information_flow(decision_json: str, approvals_json: Optional[str] = None) -> str:
    """Enforce a flow-gate decision against the durable approval ledger (Slice 3).

    The HITL bridge (see ``docs/proposals/verifiable-tool-safety.md``).
    ``decision_json`` is the output of ``gate_information_flow``;
    ``approvals_json`` (optional) is a JSON array of prior ``ApprovalRecord``s. A
    ``require_approval`` hazard a human previously approved (by its stable flow
    fingerprint) is allowed, one rejected is blocked, an unseen one becomes
    pending. Returns the ``FlowEnforcement`` JSON ``{allow, blocked, pending:
    [{fingerprint, violation}], reason}``. Stateless — the ledger is rebuilt from
    ``approvals_json`` each call.
    """


def analyze_concurrency(ops_json: str) -> str:
    """Analyze a multi-agent schedule for concurrency anomalies (arXiv 2606.17182).

    Detects the four LLM-specific concurrency anomalies and classifies the
    achieved consistency level; see ``docs/proposals/concurrency-anomalies.md``.
    The time-extended, inter-agent complement to ``transaction_check``.
    ``ops_json`` is a JSON array of ``AgentOp`` ``{id, agent?, read_set?,
    write_set?, tools_read?, tools_written?, depends_on?, read_at?, commit_at?}``
    (omitted fields default). Returns the ``ConcurrencyReport`` JSON ``{level:
    "l0".."l4", serializable, anomalies: [{anomaly: "stale_generation" |
    "phantom_tool" | "causal_cascade" | "tool_effect_reorder", key, ops,
    explanation}]}`` — ``level`` set by the most severe *named* anomaly present.

    ``serializable`` is a separate, real conflict-serializability decision: the
    schedule's serialization graph (write-write, write-read, anti-dependency and
    declared ``depends_on`` edges) is tested for a cycle. It is NOT
    ``level == "l4"``. The two deliberately disagree on write skew — concurrent
    ops reading overlapping state and writing disjoint keys match no named
    anomaly, so such a schedule reports ``level: "l4"`` with
    ``serializable: False``.
    """


def gate_concurrency(report_json: str, policy_json: Optional[str] = None) -> str:
    """Gate a concurrency report into remediations (arXiv 2606.17182 Slice 2).

    The analogue of ``gate_information_flow`` for concurrency; see
    ``docs/proposals/concurrency-anomalies.md``. ``report_json`` is the output of
    ``analyze_concurrency``; ``policy_json`` (optional) is a
    ``ConcurrencyGatePolicy`` ``{abort_at_or_below, require_approval_at_or_below}``
    (levels ``"l0".."l4"``; defaults abort on l0, approval on l1). Returns the
    ``ConcurrencyGate`` JSON ``{safe, level, abort, remediations: [{anomaly,
    remediation: {kind: "reread_and_regenerate" | "pin_tool_registry" |
    "enforce_causal_order" | "serialize_writers", ...}, disposition:
    "auto_remediate" | "require_approval" | "abort"}]}``.
    """


def verify_workflow_graph(graph_json: str) -> str:
    """Statically verify a workflow graph for structural defects (arXiv 2603.20356).

    "Agentproof"-style topology verification; see
    ``docs/proposals/workflow-graph-verification.md``. Catches dead-end stages,
    unreachable exits, and trap loops a schema check misses, each with a witness
    path. ``graph_json`` is a ``WorkflowGraph`` ``{entry, terminals, stages,
    edges: [{from, to, condition?}]}``. Returns the ``WorkflowVerifyReport`` JSON
    ``{sound, defects: [{kind: "missing_entry" | "dangling_edge" |
    "unreachable_stage" | "dead_end" | "no_exit_reachable" |
    "unreachable_terminal", subject, witness, explanation}]}``.
    """


def check_workflow_policies(graph_json: str, policies_json: str) -> str:
    """Check temporal safety policies over a workflow graph (arXiv 2603.20356).

    "Agentproof" Slice 2, the static half of the policy layer; see
    ``docs/proposals/workflow-graph-verification.md``. The headline policy is the
    human-gate: a guard stage must precede a sensitive stage on every path.
    ``graph_json`` is a ``WorkflowGraph``; ``policies_json`` is a JSON array of
    ``TemporalPolicy`` ``{kind: "precedes", earlier, later, name?}``. Returns the
    ``PolicyReport`` JSON ``{compliant, violations: [{policy, stage, witness,
    explanation}]}`` — each witness reaches the guarded stage without the
    required predecessor.
    """


def check_plan(request_json: str) -> str:
    """Verify a plan's sequential feasibility by symbolic forward simulation.

    Applies arXiv 2603.14730 "GNNVerifier" as a deterministic, training-free
    check; see ``docs/proposals/plan-precondition-verification.md``. Catches a
    step whose preconditions the earlier steps never establish, and an unreached
    goal, before anything runs (the STRIPS applicability check). ``request_json``
    is a ``PlanCheckRequest`` ``{initial, steps: [{id, preconditions?,
    add_effects?, del_effects?}], goal}``. Returns the ``PlanCheckReport`` JSON
    ``{valid, defects: [{kind: "unmet_precondition" | "goal_not_achieved", step?,
    fact, explanation}], final_state}``.
    """


def evaluate_goal(request_json: str) -> str:
    """Deterministic goal-condition evaluation — the Evaluator half of CAR's goal loop.

    CAR's answer to ``/goal`` (see ``docs/proposals/goal-loop.md``): decide "am I
    done?" over runtime ground truth rather than a model reading its own
    transcript. ``request_json`` is ``{condition, inputs}``. ``condition`` is a
    composable ``GoalCondition``: ``{kind: "all_of" | "any_of", conditions}`` or a
    leaf ``{kind: "tool_receipts_grounded" | "plan_achieved" | "state_consistent"}``
    / ``{kind: "state_predicate", key, equals}`` / ``{kind: "command", id,
    expect_exit}`` / ``{kind: "model_judge", id}``. ``inputs`` is the gathered
    ``GoalInputs`` ``{receipts_grounded?, plan_achieved?, state_consistent?,
    state?, command_exits?, model_verdicts?}``. Returns the ``GoalVerdict`` JSON
    ``{met, grounded, reason}`` — ``grounded`` is false iff a met verdict relied
    on a ``model_judge``. A leaf whose input wasn't gathered fails closed. Pure.
    """


def check_intent(request_json: str) -> str:
    """Intent-grounded verify-before-commit (arXiv 2601.05755 "VIGIL").

    Defends against tool stream injection: flags actions that drift outside the
    user's declared intent, blocking commit when the drifting action is
    influenced by an untrusted tool result (the injection signature). See
    ``docs/proposals/intent-grounded-verification.md``. ``request_json`` is ``{
    intent: { allowed_tools?, allowed_resources?, forbidden_capabilities? },
    actions: [{ id, tool?, targets?, capabilities?, depends_on?, untrusted? }] }``.
    Returns the ``IntentReport`` JSON ``{ safe, commit_blocked, violations: [{
    action, kind: "tool_out_of_intent" | "target_out_of_intent" |
    "forbidden_capability", detail, tool_influenced, explanation }] }``.
    """


def check_intent_plan(request_json: str) -> str:
    """Intent-grounded verify-before-commit straight from a plan's IR actions.

    VIGIL Slice 4 — the IR populater + check in one call. ``request_json`` is ``{
    intent, actions: [Action], untrusted_tools?, untrusted_ids? }``. The runtime
    derives the ``IntentAction``s from its own IR (tool, ``expected_effects`` →
    targets, dependency edges → ``depends_on``, ``metadata.capabilities`` →
    capabilities, ``untrusted`` from the supplied provenance) then runs the intent
    check. Returns the same ``IntentReport`` JSON.
    """


def gate_intent(report_json: str, gate_policy_json: str | None = ...) -> str:
    """Map an intent report to an enforcement disposition (VIGIL Slice 2 — gate).

    ``report_json`` is a ``check_intent`` report; ``gate_policy_json`` is an
    optional ``IntentGatePolicy`` ``{ on_untainted_drift: "allow" |
    "require_approval" | "block" }`` (default ``require_approval``). Injections
    and forbidden capabilities always block. Returns the ``IntentGateDecision``
    JSON ``{ action, blocked, needs_approval, reason }``.
    """


def enforce_intent(decision_json: str, approvals_json: str | None = ...) -> str:
    """Enforce an ``IntentGateDecision`` against the approval ledger (VIGIL Slice 3).

    The HITL bridge. ``decision_json`` is a ``gate_intent`` decision;
    ``approvals_json`` is an optional ``ApprovalRecord[]`` seeding the ledger.
    Drift a human approved commits; rejected is blocked; novel is pending. Hard
    blocks are never committable. Returns the ``IntentEnforcement`` JSON ``{
    commit, blocked, pending, reason }``.
    """


def plan_context_eviction(episodes_json: str, budget: int) -> str:
    """Plan a deterministic, budget-bounded context eviction (arXiv 2606.11213).

    "CWL"-style structured eviction with the Governance-Decay guard (arXiv
    2606.22528); see ``docs/proposals/context-eviction.md``. The cheaper-than-
    summarization first move when the window fills: shed action results whose
    effects are already persisted, preserve user turns and the active reasoning
    frontier, never evict a pinned constraint. ``episodes_json`` is a JSON array
    of ``ContextEpisode`` ``{id, kind: "constraint" | "user_turn" |
    "agent_reasoning" | "action_result" | "observation", tokens?, persisted?,
    pinned?, recency?}``; ``budget`` is the token ceiling. Returns the
    ``EvictionPlan`` JSON ``{evicted, retained_tokens, pinned_tokens,
    within_budget}`` — ``within_budget = false`` means the caller must fall back
    to summarization.
    """


def cwm_score(transitions_json: str, predictions_json: str) -> str:
    """Score a Code World Model against recorded trajectories.

    Slice 1 of ``docs/proposals/code-world-models.md`` (applying arXiv
    2510.04542 "Code World Models for General Game Playing"): validate an
    LLM-generated ``apply(state, action)`` model by unit-testing it against
    recorded transitions. ``transitions_json`` is a JSON array of
    ``{state_before, action, state_after}`` records (e.g. from
    ``cwm_transitions_from_events``); ``predictions_json`` is an index-aligned
    array, each element the model's predicted post-state object or
    ``{"error": "<stack trace>"}`` when running the generated code threw (code
    execution is the caller's job, e.g. a sandbox).

    Returns the ``ScoreReport`` JSON ``{total, correct, errored, accuracy,
    failures: [{index, action, expected, predicted?, error?}]}`` — the paper's
    transition-accuracy metric plus per-case mismatches for the repair loop. A
    length mismatch is an error, not a silent truncation.
    """


def gate_skill_deployment(provenance_json: str, requested_tier: str) -> str:
    """Gate a skill's deployment capability against its provenance (arXiv 2602.12430).

    "Agent Skills" skill-trust governance; see
    ``docs/proposals/skill-trust-governance.md``. Maps a skill's provenance to a
    trust tier and caps the capability that tier permits — the supply-chain lens
    motivated by the paper's 26.1%-vulnerable finding. ``provenance_json`` is a
    ``SkillProvenance`` ``{signed?, signer_trusted?, scanned?, vulnerabilities?,
    source?, success_count?, fail_count?}``; ``requested_tier`` is ``"read_only" |
    "sandbox_edit" | "full_access"``. Returns the ``SkillDeploymentDecision`` JSON
    ``{trust, ceiling, granted, outcome: "allow" | "downgrade" | "deny", reason}``
    — a vulnerable, unsigned, or degraded skill is denied regardless of tier.
    """


def cwm_transitions_from_events(
    events_jsonl: str,
    initial_state_json: Optional[str] = None,
    actions_json: Optional[str] = None,
) -> str:
    """Rebuild ``(state_before, action, state_after)`` transitions from a log.

    Turns a JSONL tail of a session's event log — the trajectories CAR already
    records — into the unit-test records ``cwm_score`` consumes, by folding the
    recorded ``StateChanged`` deltas (``data.changes``) over
    ``initial_state_json`` in log order. ``actions_json`` (optional) maps an
    action id → the action JSON to attach (pass a proposal's actions so a
    transition carries ``tool``/``parameters``); absent a match the action is
    ``{"id": ...}``. Lines that don't parse as events are skipped. Returns a
    JSON array of transitions.
    """


def simulate_with_predictions(
    proposal_json: str,
    predictions_json: str,
    min_accuracy: float,
    initial_state_json: Optional[str] = None,
) -> str:
    """Predictive simulation (Code World Models Slice 2).

    Like the static simulator, but applies per-action effect predictions from a
    verified Code World Model, gated by accuracy. ``proposal_json`` is an
    ``ActionProposal``; ``predictions_json`` maps ``action_id`` →
    ``{"effects": {key: value, ...}, "accuracy": <0..1>}`` (effects the caller
    computed by running the generated model); ``initial_state_json`` (optional)
    seeds state. A prediction is applied only when ``accuracy >= min_accuracy``;
    otherwise — and for any action with no prediction — the simulator falls back
    to that action's declared ``expected_effects`` (the static ``simulate``
    behavior), so an under-accurate model can never worsen the result. Returns
    the final state JSON.
    """


def harness_metrics(events_jsonl: str) -> str:
    """Compute harness-level evaluation metrics (survey §5.2.1).

    From a JSONL tail of a session's event log (one event per line),
    returns the ``HarnessMetrics`` JSON with six operational-substrate
    dimensions: ``trajectory_efficiency``, ``verification_strength``,
    ``recovery``, ``state_consistency``, ``safety``, ``replayability`` —
    complementing task-success accuracy when comparing harness variants.

    The optional ``task_pass_rate`` field — and its two companions,
    ``task_pass_denominator`` (how many tasks that rate is over) and
    ``tasks_unrunnable`` (how many the runner could not measure) — are
    **always absent** from this result: end-task success is not in the event
    stream (the log records what ran, not whether the task was satisfied), and
    inventing any of the three here would hand the regression gate a
    fabricated number. Only a runner holding the task suite and its grading
    criteria can supply them — ``car-bench-harness --metrics-out`` does.
    Absent means *not measured*, never zero.
    """


def verify_tool_receipts(
    claims_json: str, receipts_json: str, window_complete: bool = True
) -> str:
    """Detect tool-result hallucinations via runtime receipts (arXiv 2603.10060).

    Cross-checks the model's claims about tool use against the runtime's receipts
    of what actually executed; see ``docs/proposals/tool-receipt-verification.md``.
    Deterministic and zero-inference. ``claims_json`` is a JSON array of
    ``ToolClaim`` ``{kind: "invoked" | "count" | "absence", tool, call_id?,
    count?, text?}``; ``receipts_json`` is a JSON array of ``ToolReceipt``
    ``{tool, call_id?, ok?, result_count?}``. ``window_complete`` (default
    ``True``) declares whether the receipts cover the full window the claims
    are about — pass ``False`` when they were projected from a
    retention-trimmed log, so a receiptless claim is reported in
    ``ungroundable`` ("window evicted") instead of accused as fabricated.
    Returns the ``ReceiptReport`` JSON
    ``{grounded, hallucinations: [{kind: "fabricated_tool_reference" |
    "count_misstatement" | "false_absence", tool, claim_text?, explanation}],
    ungroundable?: [{tool, claim_text?, explanation}]}``.
    """


def diagnose_harness_interventions(events_jsonl: str, min_occurrences: int) -> str:
    """Diagnose runtime-harness interventions from a JSONL event-log tail.

    Applies arXiv 2605.22166 ("Adapting the Interface, Not the Model" /
    Life-Harness); see ``docs/proposals/runtime-harness-adaptation.md``. Converts
    *recurring* interaction failures into typed, reusable fixes across four
    lifecycle layers — ``environment_contract``, ``action_realization``,
    ``trajectory_regulation``, ``procedural_skill`` — i.e. "fix the harness, not
    the model". ``min_occurrences`` is the recurrence threshold (pass 2 for
    "recurring"). Returns the ``AdaptationReport`` JSON ``{interventions: [{layer,
    target, trigger, intervention, evidence_count}], parse_errors}`` sorted by
    evidence descending. Complements ``evolution_diagnose`` (which gates/applies
    mutations); this is the diagnosis pass over trajectories.
    """


# ---------------------------------------------------------------------------
# Agentic Harness Engineering: Evolution Agent (survey §3.5, §5.2.3)


def evolution_diagnose(metrics_json: str, config_json: Optional[str] = None) -> str:
    """Diagnose harness telemetry into governed mutation proposals.

    ``metrics_json`` is a ``HarnessMetrics``; ``config_json`` optionally
    overrides thresholds. Returns a JSON array of ``HarnessMutation``, each
    carrying a change contract (component, target_failure,
    predicted_improvement, invariants, falsifying_eval, rollback). Nothing
    is applied — proposals must pass :func:`evolution_evaluate` and, when
    safety-affecting, human approval.
    """


def evolution_evaluate(
    mutation_json: str,
    baseline_json: str,
    candidate_json: str,
    config_json: Optional[str] = None,
) -> str:
    """Regression-gate a candidate harness mutation.

    ``baseline_json``/``candidate_json`` are ``HarnessMetrics`` before/after
    applying the mutation on held-out telemetry. Returns the
    ``PromotionDecision`` JSON (``promote`` / ``needs_approval`` / ``reject``
    / ``incomparable``); safety-affecting mutations route to
    ``needs_approval`` even when they pass the gate.

    Reliability is guarded twice, because the two available measures are
    different quantities. ``task_pass_rate`` is end-task success and is checked
    first, but only when BOTH documents carry it (absent on either side = not
    measured, so the guard does not fire rather than defaulting to 0.0 or 1.0).
    ``trajectory_efficiency.success_rate`` is tool-attempt success and is
    always checked. A candidate that cuts tokens by abandoning hard tasks
    earlier holds a perfect attempt-level rate while solving fewer tasks — only
    the first guard sees that.

    Before either guard, the two pass rates must be over the SAME task set.
    ``HarnessMetrics`` carries two optional companions to ``task_pass_rate``:
    ``task_pass_denominator`` (how many tasks the rate is over) and
    ``tasks_unrunnable`` (how many the runner could not measure). When both
    documents carry a denominator and they differ, the result is
    ``incomparable`` — no verdict, nothing applied. A harness that loses a
    capability also loses the ability to *measure* the tasks needing it, so
    those tasks leave the denominator and the surviving rate rises. Both
    fields are optional and absent from older documents, in which case the
    check is skipped rather than failing.
    """


def evolution_apply(
    config_json: str,
    mutation_json: str,
    decision_json: Optional[str] = None,
    human_approved: bool = False,
) -> str:
    """Apply a mutation's patch to a ``HarnessConfig`` under governance.

    Survey §3.5/§5.2.3. ``human_approved=True`` applies under the HITL path
    (the only path that may land a safety-affecting mutation); otherwise
    ``decision_json`` (a ``PromotionDecision``) must be ``promote`` and the
    mutation non-safety. Returns ``{config, rollback}`` (the updated config
    and the inverse patch that restores it), or raises when refused.
    """


# ---------------------------------------------------------------------------
# Permission-tier gate (survey "Code as Agent Harness" §3.4.3, §5.2.5)
#
# The harness as safety governor: classify each action's risk tier
# (read_only | sandbox_edit | full_access), gate it against the session's
# granted standing tier, and record human-in-the-loop approvals as durable,
# auditable state (a JSONL ledger keyed by a stable action fingerprint).
#
# Two axes, not one. The tier answers "who may authorize this?" and says
# nothing about whether the effect can be undone — a ``git push``, a
# production INSERT, and a charged card are all ``full_access`` with three
# different rollback contracts. Every row below therefore carries a
# ``reversibility`` alongside its ``required_tier``.
#
# The matching Action IR fields (any ``proposal_json`` this package accepts,
# and the full spec in docs/agent-ir-spec.md):
#
#   "reversibility": "reversible" | "compensable" | "irreversible"
#       Optional. The rollback contract for this action's effects.
#       ``reversible`` is undone by restoring the scope it ran in;
#       ``compensable`` needs a compensating action run against it;
#       ``irreversible`` cannot be undone once it reaches the world.
#       **Defaults to "irreversible"** when omitted — deliberately, because
#       the default decides what the runtime believes about an unclassified
#       action and the two directions fail asymmetrically. Guessing
#       "reversible" wrongly means silently believing a sent email can be
#       unsent; guessing "irreversible" wrongly means over-asking for an
#       approval on something recoverable, which is annoying, visible, and
#       fixed locally by annotating the action.
#
#   "compensation": {"type": "tool", "tool": str, "parameters"?: dict}
#                 | {"type": "action_ref", "action_id": str}
#       Optional. How to undo the action once it has run — the action-level
#       analogue of car-workflow's saga CompensationHandler. Meaningful only
#       with ``"reversibility": "compensable"``; omitted from the serialized
#       form when absent, so older consumers see the payload they saw before.
#       Declaring one is a *claim*: nothing checks that the named tool is a
#       true inverse, exactly as nothing checks ``expected_effects``.
#
# Nothing in the runtime enforces on either field yet — they are typed,
# classified, and audited. Do not read "reversible" as a promise that the
# runtime will undo anything for you: rollback restores the state map and
# leaves whatever a tool wrote to disk where it is. See
# docs/proposals/shepherd-substrate-adoption.md.


def permission_classify(proposal_json: str) -> str:
    """Classify each action on both authorization-adjacent axes.

    Returns a JSON array of ``{action_id, tool, required_tier,
    reversibility, missing_compensation}``.

    - ``required_tier`` — **who may authorize this**: ``"read_only" |
      "sandbox_edit" | "full_access"``.
    - ``reversibility`` — **can this be undone**: ``"reversible" |
      "compensable" | "irreversible"``. Independent of the tier and not
      derived from it: ``read_secret`` is ``full_access`` and perfectly
      reversible (a read leaves nothing to undo), while ``send_email`` and
      ``deploy_service`` are both ``full_access`` and differ completely.
      This is the classifier's answer from the tool name and flattened
      parameters — **not** an echo of the action's declared
      ``reversibility`` field, which defaults to ``"irreversible"`` and so
      would tell you only what you sent. It is a keyword heuristic: an
      unrecognized tool comes back ``"irreversible"``, deliberately.
    - ``missing_compensation`` — the action **declared** ``"compensable"``
      and supplied no ``compensation``, the one incoherent combination the
      IR cannot exclude by construction. Keyed off the declared field, so it
      stays ``False`` for proposals that never opted into the axis.

    Severity ascends ``"reversible" < "compensable" < "irreversible"``, so
    the rollback contract of a whole batch is the worst row — a plan is only
    as recoverable as its least recoverable step. (The daemon's
    ``permission.classify`` returns that roll-up precomputed as
    ``declared_rollback_contract``, over the *declared* fields; this
    function returns a bare array with nowhere to hang it, so compute it
    from the column you care about.)

    Nothing in the runtime gates on the second axis yet — it is typed,
    classified, and audited, not enforced.
    """


def permission_evaluate(
    proposal_json: str,
    granted_tier: str,
    ledger_path: Optional[str] = None,
) -> str:
    """Evaluate each action against a granted standing tier.

    Consults the durable approval ledger JSONL at ``ledger_path`` when
    given. Returns a JSON array of per-action decisions, each
    ``{decision, required, granted, action_id, fingerprint,
    reversibility, ...}`` where ``decision`` is ``"allow" |
    "needs_approval" | "deny"``. A ``needs_approval`` decision means
    autonomy is suspended pending a human decision; resolve it with
    :func:`permission_record_for_fingerprint`.

    ``reversibility`` is orthogonal to ``decision`` and rides on **every**
    row, the ``allow``\\ s included: the gate's verdict says whether the
    action may run, not whether it could be taken back afterwards, and a
    caller that only learns the rollback contract of the actions it was
    stopped on is missing exactly the rows an incident review reads first.
    Same field, labels, and classifier as the ``PermissionDecision`` event
    the engine writes to its audit log.
    """


def permission_record_decision(
    action_json: str,
    approve: bool,
    reviewer: str,
    reason: str,
    ledger_path: str,
    evidence: Optional[str] = None,
) -> str:
    """Record a durable human-in-the-loop decision for an action.

    ``approve=True`` approves, ``False`` rejects. Appends to the JSONL
    ledger at ``ledger_path``; the decision persists and overrides future
    evaluations of the same operation. Returns the stored record JSON.
    """


def permission_record_for_fingerprint(
    fingerprint: str,
    required_tier: str,
    approve: bool,
    reviewer: str,
    reason: str,
    ledger_path: str,
    evidence: Optional[str] = None,
) -> str:
    """Like :func:`permission_record_decision` but keyed by an explicit
    ``fingerprint`` (from a prior ``needs_approval`` decision) with an
    annotating ``required_tier``. Returns the stored record JSON."""


# ---------------------------------------------------------------------------
# Stateless execute (creates a fresh runtime per call)
# ---------------------------------------------------------------------------

def execute(
    proposal_json: str,
    tool_names: List[str],
    tool_fn: Callable[[str, str], str],
) -> str:
    """Execute a proposal against a fresh runtime. For long-lived use,
    prefer ``CarRuntime.execute_proposal``.
    """


# ---------------------------------------------------------------------------
# Multi-agent coordination
#
# Two registration modes:
#
#   1. Pass ``agent_fn`` per call.
#   2. Call ``register_agent_runner(agent_fn)`` once, then call ``run_*``
#      with ``agent_fn=None``.
#
# ``agent_fn`` is invoked as ``agent_fn(spec_json, task)`` and must return
# an ``AgentOutput`` JSON string.
# ---------------------------------------------------------------------------

def register_agent_runner(agent_fn: Callable[[str, str], str]) -> None: ...


# Coordination budget — a runtime-enforced spend ceiling for one multi-agent
# run. Passed to the ``run_*`` functions as a JSON string of a ``BudgetLimits``
# object; every field is optional and an omitted field is unbounded:
#
#     {"max_input_tokens": int, "max_output_tokens": int, "max_total_tokens": int,
#      "max_cost_usd": float, "max_agents": int}
#
# The runtime sums the token/cost spend reported by the agent runner and refuses
# to START further agents once a limit is crossed; ``max_agents`` is a hard cap
# on agents started. Example:
#
#     run_swarm("parallel", agents, task,
#               budget_json='{"max_total_tokens": 200000, "max_agents": 12}')

def run_swarm(
    mode: str,
    agents_json: str,
    task: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    synthesizer_json: Optional[str] = None,
    budget_json: Optional[str] = None,
) -> str:
    """``mode`` ∈ ``{"parallel", "sequential", "hybrid"}``.

    ``budget_json`` is an optional JSON-encoded ``BudgetLimits`` (see above).
    """


def run_pipeline(
    stages_json: str,
    task: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    budget_json: Optional[str] = None,
) -> str: ...


def run_supervisor(
    workers_json: str,
    supervisor_json: str,
    task: str,
    max_rounds: int,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    budget_json: Optional[str] = None,
) -> str: ...


def run_map_reduce(
    mapper_json: str,
    reducer_json: str,
    task: str,
    items_json: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    budget_json: Optional[str] = None,
) -> str: ...


def run_vote(
    agents_json: str,
    task: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    synthesizer_json: Optional[str] = None,
    budget_json: Optional[str] = None,
) -> str: ...


def run_tournament(
    competitors_json: str,
    judge_json: str,
    task: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    budget_json: Optional[str] = None,
) -> str:
    """Rank ``competitors_json`` (AgentSpec[]) by single-elimination pairwise
    judging with a ``judge_json`` (AgentSpec). Returns TournamentResult JSON.
    ``budget_json`` is an optional ``BudgetLimits`` (see above).
    """


def run_subtask(
    main_json: str,
    task: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    budget_json: Optional[str] = None,
) -> str:
    """Run an agent that can spawn isolated, tool-constrained sub-agents.

    The main agent (``main_json``) may call the ``spawn_subtask`` tool to hand a
    *subset* of its own tools to an ephemeral sub-agent. ``budget_json`` is an
    optional JSON-encoded ``BudgetLimits`` that also caps the sub-agents this
    agent may spawn. Returns SpawnSubtaskResult JSON.
    """


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------

def create_task(
    name: str,
    prompt: str,
    trigger: Optional[str] = None,
    schedule: Optional[str] = None,
    system_prompt: Optional[str] = None,
) -> str:
    """``trigger`` ∈ ``{"once", "cron", "interval", "file_watch"}``; default ``"manual"``."""


def render_os_schedule(task_json: str, program: str, args_json: str) -> str:
    """Preview the durable OS-level schedule (launchd plist + crontab line) a task
    would install, without installing it. ``program`` + ``args_json`` (a JSON
    string array) are the command the OS runs to execute the task once. Returns
    ``{ label, launchd_plist, launchd_error, crontab_line, crontab_error }``."""


def analyze_schedule(graph_json: str) -> str:
    """Analyze a static execution DAG as a scheduler (arXiv 2604.11378).

    "From Agent Loops to Structured Graphs"; see
    ``docs/proposals/scheduler-graph-analysis.md``. Makes a plan's schedule
    inspectable before running it. ``graph_json`` is a ``ScheduleGraph``
    ``{units: [{id, duration?, depends_on?}]}``. Returns the ``ScheduleAnalysis``
    JSON ``{has_cycle, critical_path, makespan, max_parallelism, levels,
    serial}`` — ``serial`` flags the single-ready-unit Agent-Loop pathology,
    ``has_cycle`` flags a never-terminating (cyclic) plan."""


def install_os_schedule(task_json: str, program: str, args_json: str) -> str:
    """Install a durable OS-level schedule (launchd on macOS, crontab on Linux) so
    the task fires even when the CAR daemon is down. Idempotent. Returns the
    installed-schedule JSON."""


def uninstall_os_schedule(label_or_id: str) -> str:
    """Remove a task's OS-level schedule (full label or bare task id). Returns
    ``{ label, removed }``."""


def list_os_schedules() -> str:
    """List labels of all CAR-managed OS-level schedules on this host (JSON string
    array)."""


def reconcile_os_schedules() -> str:
    """Reap orphaned OS-level schedules — uninstall every CAR-managed launchd/cron
    entry whose task is gone from ``~/.car/tasks/`` or whose trigger is no longer
    schedulable. Returns the reconcile report ``{ removed, kept, errors }``."""


def schedule_task(spec_json: str) -> str:
    """Schedule a deterministic command on a cadence, hiding the OS backend (#72).
    ``spec_json`` = ``{ name, program, args?, cadence: { interval_secs? | cron? },
    durable?, working_dir?, env?, permission_tier? }``. Returns
    ``{ id, durable, backend, task }``."""


def list_scheduled_tasks() -> str:
    """List deterministic (command) scheduled tasks with their resolved backend."""


def unschedule_task(id_or_label: str) -> str:
    """Unschedule a deterministic task — remove any OS schedule and delete it from
    the store. Returns ``{ id, os_removed, deleted }``."""


def run_task(
    task_json: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
) -> str: ...


def run_task_loop(
    task_json: str,
    agent_fn: Optional[Callable[[str, str], str]] = None,
    max_iterations: Optional[int] = None,
) -> str: ...


def ensure_dream_task() -> bool:
    """Idempotently create the dream/consolidation task. Returns True if created."""


# ---------------------------------------------------------------------------
# Planner
# ---------------------------------------------------------------------------

def rank_proposals(
    candidates_json: str,
    tools: Optional[List[str]] = None,
    cost_weight: Optional[float] = None,
) -> str:
    """Score and rank candidate proposals. Returns JSON array of ScoredProposal."""


# ---------------------------------------------------------------------------
# Voice streaming + diarization
#
# Voice events flow through a single registered handler, called as
# ``handler(session_id: str, event_json: str)``.
# ---------------------------------------------------------------------------

def register_voice_event_handler(
    handler: Callable[[str, str], None],
) -> None:
    """Register the callable fired for each daemon ``voice.event``
    notification, as ``handler(session_id, event_json)``.

    Like every other registered callback in this module, it runs on a
    dedicated CAR-owned OS thread and **may call any**
    :class:`CarRuntime` **method** — see the *Callback threading
    contract* note on :func:`register_chat_handler`."""


def register_tool_handler(handler: Callable[[str], str]) -> None:
    """Register the Python callable that runs every daemon-initiated
    ``tools.execute`` request (Parslee-ai/car-releases#38).

    Symmetric to NAPI's ``registerToolHandler``. The process-wide
    slot is set here; the per-``CarRuntime`` bridge installed on
    the first :meth:`CarRuntime.submit_proposal` call reads the
    stored value on each daemon callback through a GIL-aware drain
    task. Re-calling overwrites the previous handler atomically —
    proposals already in flight pick up the new callable on their
    next ``tools.execute`` round-trip.

    ``handler(call_json)`` receives ``{"tool": "name", "params":
    {...}, "action_id": "<id>", "request_id": "<id>", "timeout_ms":
    <ms|None>, "session_id": "<id>|None", "attempt": <n>}`` as a JSON
    string and MUST
    return a JSON-encoded result string. Raising rejects the
    daemon-side action with a -32000 JSON-RPC error.

    ``request_id`` is the daemon's callback-routing id, repeated by
    the ``tools.cancel`` notification so the host can abort the right
    in-flight call. ``timeout_ms`` is the action's declared budget in
    milliseconds when the action declared one (``None`` otherwise);
    the host tool runner may use it to bound its own work.

    ``attempt`` is the engine's retry counter for this action, 1-based
    (``1`` on the first try, ``2`` on the first retry). Use it to tell
    which retry you are serving; use ``request_id`` to correlate a
    specific in-flight call. It was hardcoded to ``1`` on the wire and
    dropped by the binding before Parslee-ai/car#928, so a join built
    on it never varied.

    ``session_id`` is the daemon-stamped execution session
    (Parslee-ai/car#904) — the attribution key for *which mission this
    callback belongs to*. ``None`` when the caller has no session.
    Prefer it over reconstructing attribution yourself: ``action_id``
    is client-authored and not unique across concurrent or retried
    attempts, so a submit-time map keyed on it inherits that. Bracket
    a mission with :meth:`CarRuntime.runs_start` /
    :meth:`CarRuntime.runs_complete` and join on this — an agent that
    threads its own identity instead (a process-global run id being
    the naive choice) can let a later mission's artifact inherit an
    earlier mission's receipts.

    Stored-callback rationale: the daemon's recv loop dispatches
    ``tools.execute`` on a tokio task. Acquiring the GIL inline on
    that task would risk starving concurrent JSON-RPC responses on
    the same client (same hazard the voice-event handler avoids).
    A dedicated drain thread takes the GIL one request at a time.

    The handler **may call any** :class:`CarRuntime` **method** —
    ``state_set`` inside a tool callback used to panic the worker
    (Parslee-ai/car#905). See the *Callback threading contract* note
    on :func:`register_chat_handler`. Requests are served one at a
    time on that thread, so a slow callback delays the next
    ``tools.execute``; offload to your own thread if you need
    concurrency.
    """


def unregister_tool_handler() -> None:
    """Clear the registered ``tools.execute`` handler. Subsequent
    :meth:`CarRuntime.submit_proposal` calls fail fast with
    ``RuntimeError`` until a new handler is registered. Pairs with
    :func:`register_tool_handler`."""


def register_tool_cancel_handler(handler: Callable[[str], None]) -> None:
    """Register the callable fired when a tool callback is reaped
    (Parslee-ai/car#264).

    When a ``tools.execute`` callback exceeds its budget the daemon emits a
    ``tools.cancel`` notification; the bridge installed in
    :class:`CarRuntime`'s constructor routes the reaped call's ``request_id``
    to this callable (through a GIL-aware drain task) so the harness can abort
    the in-flight child it registered under that id.

    ``handler(request_id)`` receives the routing id (the same ``request_id``
    the host saw on the originating ``tools.execute`` call_json). Fire-and-
    forget — no return value is consumed. Re-calling overwrites; pair with
    :func:`unregister_tool_cancel_handler` to clear.

    Runs on a dedicated CAR-owned OS thread and **may call any**
    :class:`CarRuntime` **method** — see the *Callback threading contract*
    note on :func:`register_chat_handler`."""


def unregister_tool_cancel_handler() -> None:
    """Clear the registered ``tools.cancel`` handler. Subsequent reaps are no
    longer routed to the host (the daemon has already abandoned the call
    regardless). Pairs with :func:`register_tool_cancel_handler`."""


def register_chat_handler(handler: Callable[[str], None]) -> None:
    """Register the callable that serves daemon-initiated ``agent.chat``
    reverse-calls — the agent-chat surface.

    A supervised agent (in ``--serve`` mode, attached via ``session.auth`` with
    its ``agent_id``) calls this once. The daemon reverse-calls ``agent.chat``
    for every host ``agents.chat``; the bridge in :class:`CarRuntime`'s
    constructor acks ``{accepted: true}`` and routes the params to this callable
    through a GIL-aware drain thread.

    ``handler(params_json)`` receives ``{"session_id","prompt","attachments"?,
    "context"?}`` as a JSON string. Run one conversational turn — keep a
    per-``session_id`` thread, run the agent loop, and stream the reply via
    :meth:`CarRuntime.chat_event` — then return. Fire-and-forget (the ack
    already went back). Re-calling overwrites; pair with
    :func:`unregister_chat_handler` to clear.

    **Callback threading contract.** Every callback registered through this
    module — chat, tools, tool-cancel, voice — is invoked on a dedicated
    CAR-owned OS thread, never on a tokio runtime worker. That means the
    handler **may call any** :class:`CarRuntime` **method**, including
    :meth:`CarRuntime.infer_tracked`, :meth:`CarRuntime.submit_proposal`,
    :meth:`CarRuntime.state_set`, and :meth:`CarRuntime.chat_event`. Run the
    turn inline; no ``threading.Thread`` offload is required.

    Before Parslee-ai/car#905 these ran on runtime workers, and every
    daemon-backed method (they all block on the shared runtime internally)
    raised ``PanicException: Cannot start a runtime from within a runtime`` —
    a ``BaseException`` that ``except Exception`` does not catch, and one that
    ``chat_event`` could not report because reporting hit the same wall. The
    turn was stranded with the host, already acked, receiving nothing. If you
    wrote a thread-offload workaround for that, it is now unnecessary (and
    still harmless).

    One turn is served at a time on that thread. If a handler raises, the
    bridge emits a terminal ``kind: "error"`` ``agent.chat.event`` on the
    turn's ``session_id`` so the host is not left waiting — the direct
    host-chat path has no post-ack deadline of its own."""


def unregister_chat_handler() -> None:
    """Clear the registered ``agent.chat`` handler. Subsequent reverse-calls are
    refused so the daemon learns this agent is no longer conversational. Pairs
    with :func:`register_chat_handler`."""


def transcribe_stream(
    session_id: str,
    audio_source_json: str,
    options_json: Optional[str] = None,
) -> str:
    """Open a streaming transcription session.

    ``options_json`` is a JSON object matching ``TranscribeStreamOptions``:
        ``{"model": str?, "language": str?, "prompt": str?,``
        `` "emit_audio_meta": bool?, "streaming": bool?,``
        `` "diarizer": bool?, "enrolled": bool?,``
        `` "voice_prompt_overlay": str?, "provider": "elevenlabs" | "local"?}``

    ``provider`` selects the streaming STT backend. Default is the
    in-process pipeline. ``"elevenlabs"`` routes pushed PCM through
    ElevenLabs' Realtime STT websocket — only meaningful with
    ``audio_source = {"kind": "pcm_push", "sample_rate": ..., "channels": 1}``;
    requires ``ELEVENLABS_API_KEY``.
    """


# --- Inference runner (delegated inference, closes car-releases#24) ---
#
# In-process registration is not exposed in the FFI bindings
# (car-releases#55). The v0.8+ daemon-only architecture moves delegated
# inference to the WebSocket protocol: a runner client connects to
# car-server and calls ``inference.register_runner``; the daemon then
# sends ``inference.runner.invoke`` notifications for every delegated
# call. See docs/websocket-protocol.md §"Inference runner" for the wire
# shape. ``car-server`` is shipped as a binary in the car-runtime
# distributions.


def transcribe_stream_stop(session_id: str) -> str: ...


def transcribe_stream_push(session_id: str, pcm_frame: bytes) -> str:
    """``pcm_frame`` is a 16-bit signed little-endian PCM byte buffer."""


def list_voice_sessions() -> str: ...


def tts_stream_start(
    stream_id: str,
    text: str,
    options_json: Optional[str] = None,
) -> str:
    """Start a streaming TTS synthesis.

    Stub: not exposed in the PyO3 bindings. Connect to the daemon's
    WebSocket and use ``voice.tts_stream.start``; chunks arrive as
    ``voice.event`` notifications with ``type = "tts_chunk"``.
    """


def tts_stream_cancel(stream_id: str) -> str:
    """Cancel an in-flight TTS stream. Idempotent."""


def list_tts_streams() -> str:
    """JSON: ``{"streams": [stream_id, ...]}``."""


def list_voice_providers() -> str:
    """Voice providers (STT + TTS) compiled into this build.

    Returns a JSON-encoded array of objects with keys
    ``id`` (str), ``kind`` (``"stt"`` or ``"tts"``), ``available`` (bool),
    and ``description`` (str).

    ``available`` reflects build-time presence (cfg-target, build features).
    Runtime readiness — API key set, permission granted, model downloaded —
    surfaces via per-provider error paths when actually used.

    Stateless; safe to call without a ``CarRuntime``.
    """


def enroll_speaker(label: str, audio_json: str) -> str: ...


def list_enrollments() -> str: ...


def remove_enrollment(label: str) -> str: ...


# ---------------------------------------------------------------------------
# Workflow
# ---------------------------------------------------------------------------

def run_workflow(workflow_json: str, initial_state_json: Optional[str] = None) -> str:
    """Run a workflow definition. Reuses the agent runner from ``register_agent_runner``.

    ``initial_state_json``, when given, is a JSON object seeded into workflow
    state before the run starts — the inter-workflow chaining hook (hand a
    prior result's ``final_state`` to the next workflow). Omitted = prior
    behavior. The reserved ``goal`` drift anchor cannot be injected this way.
    """


def workflow_chain(workflows_json: str, initial_state_json: Optional[str] = None) -> str:
    """Run a JSON array of workflow definitions sequentially as a chain.

    Each next workflow's initial state is the previous result's
    ``final_state``, merged over ``initial_state_json`` (the previous result
    wins). Every workflow is statically pre-validated before any executes —
    structural garbage rejects the chain up front. Stops at the first
    non-``completed`` result. Returns ``{results: [WorkflowResult, ...],
    status, paused_at_index?, error?, failed_at_index?}`` JSON; a paused
    intermediate carries its ``paused`` checkpoint inside its result
    (checkpoint persistence stays caller-owned, like ``run_workflow``), and a
    mid-chain runtime engine error preserves the results so far (with
    top-level ``error`` + ``failed_at_index``) instead of raising. Reuses the
    agent runner from ``register_agent_runner``.
    """


def resume_workflow(paused_json: str, input_json: str) -> str:
    """Resume a workflow paused at an approval gate.

    ``paused_json`` is the ``paused`` checkpoint from a prior ``run_workflow``
    (or ``resume_workflow``) result; ``input_json`` is a JSON object of the
    human's response fields. Returns the next workflow result JSON.
    """


def list_paused_workflows(runs_dir: str) -> str:
    """List resumable workflow checkpoints under ``runs_dir`` (H1).

    Returns a JSON array of ``{run_id, paused_stage_id, prompt, created_at}`` —
    rediscover resumable runs after a restart.
    """


def set_memory_namespace(namespace: str | None = None) -> str | None:
    """Bind (or clear) the memory namespace for subsequent daemon connections.

    Returns the namespace now in effect, or ``None`` for the daemon's shared
    graph. Blank or ``None`` clears the override, falling back to
    ``CAR_MEMORY_NAMESPACE`` and then the shared graph.

    Prefer this over setting ``CAR_MEMORY_NAMESPACE`` when the namespace is
    per-project: a host learns which project it is *after* the process starts,
    and some runtimes do not propagate runtime environment writes to the C
    ``environ`` this library reads (car-releases#81).

    **Takes effect on the next connection** — the namespace is negotiated
    during ``session.auth``, so an already-established connection keeps the
    graph it bound. Call this before your first CAR call, or disconnect
    afterwards to force a rebind.
    """


def get_memory_namespace() -> str | None:
    """The memory namespace currently in effect.

    The explicit override if set, otherwise ``CAR_MEMORY_NAMESPACE``, otherwise
    ``None`` (the daemon's shared graph).
    """


def nlp_identify_language(text: str) -> str:
    """NLP (F4): identify the dominant language of ``text``.

    Returns ``{language, backend}`` JSON — Apple NaturalLanguage on macOS, a
    pure-Rust fallback elsewhere.
    """


def nlp_tokenize(text: str) -> str:
    """NLP (F4): word-tokenize ``text``. Returns ``{tokens, backend}`` JSON."""


def nlp_extract_entities(text: str) -> str:
    """NLP (F4): extract named entities from ``text``.

    Returns ``{entities, backend}`` JSON; entities are
    ``{text, kind, byte_range}``.
    """


def verify_workflow(workflow_json: str) -> str:
    """Static analysis of a workflow definition. Returns JSON ``{valid, issues}``."""


def build_automation_workflow(spec_json: str) -> str:
    """Build the external-item automation recipe (poll -> dedup -> per-item agent
    -> deliver) from an ``AutomationSpec`` JSON into a runnable workflow JSON.
    Hand the result to ``run_workflow``, typically on a schedule. Stateless."""


# ---------------------------------------------------------------------------
# Agent registry (file-based, no daemon) — issue #111.
#
# Each agent owns one JSON file under ``~/.car/registry/<name>.json``;
# tray UIs, monitors, or other agents read the directory to discover
# what's running. Pass ``registry_path`` to override the default
# ``~/.car/registry/`` location (mainly for tests).
# ---------------------------------------------------------------------------

def register_agent(entry_json: str, registry_path: Optional[str] = None) -> str:
    """Register or replace an agent's entry. ``entry_json`` is an
    ``AgentEntry`` serialised as JSON with fields ``name``,
    ``dashboard_url`` (required), and optional ``status``,
    ``display_name``, ``capability``, ``port``, ``pid``. ``capability`` is a
    natural-language description that lets ``discovery_resolve`` rank this
    service against a need (without it the service still resolves but ranks on
    its label alone). Returns ``"null"`` on success.
    """


def agent_heartbeat(name: str, registry_path: Optional[str] = None) -> str:
    """Bump ``last_heartbeat_at`` for the named agent. Returns
    ``'{"refreshed": true}'`` when the agent was registered, or
    ``'{"refreshed": false}'`` when the caller should re-register.
    """


def unregister_agent(name: str, registry_path: Optional[str] = None) -> str:
    """Remove an agent's entry. Idempotent."""


def list_agents(registry_path: Optional[str] = None) -> str:
    """All currently-registered agents as a JSON array of
    ``AgentEntry`` objects, sorted by ``name``.
    """


def reap_stale_agents(max_age_secs: int, registry_path: Optional[str] = None) -> str:
    """Delete entries whose last heartbeat is older than
    ``max_age_secs`` seconds. Returns a JSON array of reaped names.
    """


# ---------------------------------------------------------------------------
# car-a2a server lifecycle. Expose CAR as an Agent2Agent (A2A) v1.0
# peer programmatically — no need to shell out to
# ``car-server --a2a-bind``. Process-global state tracks the bound
# listener so ``stop_a2a_server`` and ``a2a_server_status`` reach the
# right server.
# ---------------------------------------------------------------------------


def start_a2a_server(rt: "CarRuntime", params_json: str) -> str:
    """Start an A2A listener. ``params_json`` is a JSON object with
    a required ``bind`` field (``"host:port"``) and optional
    ``public_url``, ``agent_name``, ``agent_description``,
    ``organization``, ``organization_url``, ``share_session_runtime``.

    ``share_session_runtime`` (bool, default ``False``): when ``True``,
    the A2A dispatcher uses this ``CarRuntime``'s session runtime
    instead of spawning a fresh one. Tools registered on the session
    via :meth:`CarRuntime.register_tool_schema` then appear on the
    Agent Card's ``skills`` list, and A2A peer ``message/send`` calls
    for those tools route back to the handler installed via
    :func:`register_tool_handler`. This is the canonical path for
    host-language agents (e.g. a Python reasoning helper) to project
    themselves over A2A without bespoke wiring. Default ``False``
    preserves the legacy fresh-Runtime behaviour: only
    ``register_agent_basics`` tools are exposed and tool dispatch
    runs entirely in the daemon's Rust path.

    Returns ``'{"bound":"host:port"}'`` on success. Raises
    ``RuntimeError`` if a server is already running, the bind fails,
    ``share_session_runtime`` is set but no session runtime is
    available (e.g. invoked from a non-WS path), or ``params_json``
    is malformed.
    """


def stop_a2a_server(rt: "CarRuntime") -> str:
    """Stop the running A2A listener. Returns
    ``'{"stopped":true}'`` on success. Raises ``RuntimeError`` if
    no server is running.
    """


def a2a_server_status(rt: "CarRuntime") -> str:
    """Report whether the A2A listener is up. Always returns a JSON
    object — ``{"running":true,"bound":"...","uptime_secs":N}`` when
    running, ``{"running":false}`` otherwise.
    """


# ---------------------------------------------------------------------------
# macOS automation — AppleScript + Shortcuts (car-automation).
#
# Subprocess-backed bridges around `osascript(1)` and `shortcuts(1)`.
# On non-macOS hosts each call raises ``RuntimeError`` with a
# PlatformUnsupported message.
# ---------------------------------------------------------------------------


def run_applescript(args_json: str) -> str:
    """Run an AppleScript or JXA snippet.

    ``args_json`` is a JSON object: ``{"script": "...", "language":
    "applescript" | "javascript", "args": [...], "timeout_ms": 5000}``.
    All fields except ``script`` are optional. Returns JSON
    ``{"stdout", "stderr", "exit_code"}``. Raises ``RuntimeError`` when
    the subprocess exits non-zero — the stderr is included in the
    error message so the script's own diagnostic survives.
    """


def run_powershell(args_json: str) -> str:
    """Run a Windows PowerShell script via ``powershell.exe`` — the
    Windows analog of ``run_applescript``. Drives the host desktop and
    its apps (toast, clipboard, COM, UI Automation).

    ``args_json`` is a JSON object: ``{"script": "...", "timeout_ms":
    5000}``; ``timeout_ms`` is optional. Returns JSON ``{"stdout",
    "stderr", "exit_code"}``. Raises ``RuntimeError`` off Windows
    (PlatformUnsupported) or when the script exits non-zero.
    """


def list_shortcuts(args_json: str) -> str:
    """Enumerate macOS Shortcuts (user-authored + AppShortcuts donated
    by apps). Returns a JSON array of ``{"name", "identifier",
    "tool_slug", "tool_description", "parameters_schema"}``. The
    ``tool_*`` fields are pre-shaped for registering each shortcut as
    a runtime tool via ``CarRuntime.register_tool_schema``.

    ``args_json`` shape: ``{"folder": "...", "with_identifiers": bool}``.
    """


def run_shortcut(args_json: str) -> str:
    """Invoke a Shortcut by name or UUID.

    ``args_json`` shape: ``{"name_or_id": "...", "input": "...",
    "output_type": "public.plain-text", "timeout_ms": 30000}``. All
    fields except ``name_or_id`` are optional. Returns JSON
    ``{"stdout", "stderr", "exit_code"}``.
    """


def local_notification(args_json: str) -> str:
    """Deliver a user-visible local notification.

    ``args_json`` shape: ``{"title": "...", "body": "...",
    "subtitle": "...", "sound": "..."}``. ``title`` and ``body`` are
    required. Returns JSON ``{"delivered", "platform", "backend"}``.
    iOS delivery is owned by the signed host app via UserNotifications.
    """


# ---------------------------------------------------------------------------
# Apple Vision OCR (car-vision)
# ---------------------------------------------------------------------------


def vision_ocr(args_json: str) -> str:
    """Run on-device text recognition via Apple's Vision framework.

    ``args_json`` shape::

        {
            "image_path": "/path/to/image.png",
            "fast_path": false,             # optional, .fast vs .accurate
            "languages": ["en-US"],         # optional BCP-47
            "language_correction": true,    # optional
            "minimum_text_height": 0.0      # optional, normalized
        }

    Returns JSON ``{"available", "observations"}``. ``available`` is
    ``false`` when the Vision shim isn't built into this binary
    (non-macOS host or skipped Swift compile); ``observations`` is
    then an empty list rather than an error.
    """


# ---------------------------------------------------------------------------
# In-process A2A dispatcher (car_a2a)
#
# See car_ffi_common::a2a_dispatch for design notes — singleton
# dispatcher distinct from car-server-core's; both are valid but
# carry separate task stores.
# ---------------------------------------------------------------------------


def a2a_dispatch(method: str, params_json: str) -> str:
    """Dispatch one A2A v1.0 method against the in-process singleton
    dispatcher.

    ``method`` is the spec method name (``"message/send"``,
    ``"tasks/get"``, etc., or PascalCase aliases like
    ``"SendMessage"``); ``params_json`` is the per-method ``params``
    payload. Returns the JSON-stringified result.

    Streaming methods (``message/stream``, ``tasks/resubscribe``)
    raise ``RuntimeError`` (``MethodNotFound``) from the dispatcher's
    transport-neutral surface. HTTP+SSE is the supported transport
    for streaming and lives outside this FFI wrapper.
    """


# ---------------------------------------------------------------------------
# Lifecycle-managed agents (car_registry::supervisor)
#
# Process-singleton supervisor backed by ``~/.car/agents.json``.
# Wire shapes match the daemon's WS ``agents.*`` methods so a host
# can swap transports without reshaping payloads. Daemon-shared
# lifecycle (across processes) flows over WebSocket.
# ---------------------------------------------------------------------------


def agents_list() -> str:
    """List managed agents from ``~/.car/agents.json`` with their
    runtime status. Returns JSON ``[ManagedAgent]``."""


def agents_health() -> str:
    """Re-validate every managed agent's ``command`` against the
    supervisor's ``validate_command`` rules. Useful after a system
    upgrade (Node moved versions, Homebrew pruned a symlink) to
    surface broken specs before the next :func:`agents_start` does.
    Returns JSON ``[{id, command, ok, reason?}]``."""


def agents_upsert(spec_json: str) -> str:
    """Add or replace an agent's spec. Persists the manifest. The
    agent is NOT auto-started — call :func:`agents_start` (or rely
    on ``auto_start: true`` for the next boot).

    ``spec_json`` shape::

        {
            "id": "trader",                 # filename-safe
            "name": "Trader",
            "command": "/opt/homebrew/bin/node",  # absolute path required
            # OR: omit `command` and pass `interpreter: "node"|"python"|...`
            #     and the supervisor resolves the interpreter against $PATH
            #     once at upsert and stores the absolute path in `command`.
            "args": ["server.js"],
            "cwd": "/path/to/project",       # optional
            "env": {"K": "V"},               # merged on top of parent
            "restart": "on_failure",         # never|on_failure|always
            "max_restarts": 10,
            "backoff_secs": 5,
            "auto_start": True
        }

    Returns JSON ``ManagedAgent``.
    """


def agents_install(manifest_json: str) -> str:
    """Install a contributed-agent ``AgentManifest``
    (Parslee-ai/car#182 phase 3). Runs install-time validation
    against the daemon's default host capability advertisement:

    - ``runtime.car_min_version`` must be satisfied by the
      runtime's own semver.
    - Every ``capabilities.required[namespace][feature]`` must
      be advertised by the host. Fail-closed on any miss.
    - ``capabilities.optional`` is reported back as
      ``missingOptional`` when the host can't satisfy it —
      informational, not blocking.

    For ``external_process`` manifests with a ``command``, the
    supervisor adopts the agent and returns it. For ``pure_data``
    and ``health_url``-only manifests, the manifest is written
    to ``~/.car/agents/<id>/manifest.toml`` but no spec is
    adopted (the supervisor only spawns command-shaped externals
    in this phase).

    Returns JSON
    ``{"report": {"missingOptional": [{"namespace", "feature"}]},
    "agent": ManagedAgent | None}``.
    """


def agents_remove(id: str) -> str:
    """Remove an agent's spec. Stops the running child first if
    it's up. Idempotent. Returns JSON ``{"removed": bool}``."""


def agents_start(id: str) -> str:
    """Spawn the agent's child if it isn't running. Resets
    ``restart_count``. Returns JSON ``ManagedAgent``."""


def agents_stop(id: str, signal: Optional[str] = None) -> str:
    """Stop the agent. ``signal`` is ``"term"`` (SIGTERM with grace,
    default) or ``"kill"`` (SIGKILL immediately). Returns JSON
    ``ManagedAgent``."""


def agents_restart(id: str) -> str:
    """Stop then start. Returns JSON ``ManagedAgent``."""


def agents_wait(
    id: str,
    targets_json: Optional[str] = None,
    timeout_secs: Optional[float] = None,
    poll_ms: Optional[float] = None,
) -> str:
    """Block until the agent reaches one of ``targets_json`` (a JSON string array
    like ``["running"]`` or ``["stopped","errored"]``; default ``["running"]``)
    or ``timeout_secs`` (default 30) elapses, polling every ``poll_ms`` (default
    200). Returns the matching JSON ``ManagedAgent``; raises on timeout or
    unknown id."""


def agents_tail_log(
    id: str,
    n: Optional[int] = None,
    stream: Optional[str] = None,
    offset: Optional[int] = None,
) -> str:
    """Read a window of an agent's logs under
    ``~/.car/logs/<id>.{stdout,stderr}.log``.

    - ``n`` caps lines per included stream (default 100; ``0`` => whole
      file, still bounded by the tail byte ceiling below).
    - ``stream`` selects ``"stdout"``, ``"stderr"``, or ``"combined"``
      (default). Each stream is tailed independently, so a long stale
      stderr can no longer bury live stdout (Parslee-ai/car#273).
    - ``offset`` pages back: skip this many lines from the end of each
      stream before taking the window (``offset == n`` => previous
      page). Combined-view paging is not order-preserving — page within
      a single stream to scroll back.

    Each stream is read via a bounded backward seek (at most an 8 MiB
    tail), not a whole-file slurp, since agent logs are append-only and
    never rotated. A log larger than the ceiling is truncated to its
    last 8 MiB and ``more`` is forced ``True``.

    Returns JSON ``{"lines": [str], "stdout": [str], "stderr": [str],
    "stdout_total": int, "stderr_total": int, "stdout_path": str,
    "stderr_path": str, "more": bool}``. ``lines`` keeps the legacy
    stdout-then-stderr combined view for back-compat. ``stdout_total`` /
    ``stderr_total`` count lines in the scanned tail (exact within the
    ceiling)."""


# ---------------------------------------------------------------------------
# External-agent detection (car-external-agents)
#
# Phase 1 of ``docs/proposals/external-agent-detection.md`` — discover
# installed agentic CLIs (Claude Code, Codex, Gemini) and report
# version + auth-kind heuristic. Per-task invocation lands in Phase 2
# alongside ``agents.invoke_external``. Wire shape::
#
#   {
#     "id": "claude-code" | "codex" | "gemini",
#     "display_name": "Claude Code" | ...,
#     "binary_path": "/usr/local/bin/claude",
#     "version": "1.0.51" | null,
#     "auth_kind": "subscription" | "api_key" | "unknown" | "unauthenticated",
#     "capabilities": {tool_use, mcp, hooks, sessions, streaming},
#     "detected_at": <unix-secs>
#   }
# ---------------------------------------------------------------------------


def agents_list_external(include_health: bool = False) -> str:
    """Cached snapshot of installed external agents. First call
    triggers a detection pass; subsequent calls return the cache.
    Pass ``include_health=True`` to also populate each spec's
    ``health`` field via the tool's auth-status command — slower
    (one subprocess spawn per detected adapter) but gives a
    one-stop "what's installed AND ready to use" answer. Returns
    JSON ``[ExternalAgentSpec]`` (empty list when nothing installed).

    ``ExternalAgentSpec.execution`` (car#746) is the authoritative answer to
    "can this binary run at all"::

        {"state": "runnable"}
        {"state": "unusable", "reason": str, "checked_at": int}

    Written by detection and never revised by a health refresh; ``health``
    answers a different question (is it authenticated) and is owned by
    refreshers that may rewrite it. Prefer ``execution`` over
    ``health.status == "not_executable"``, still emitted for one
    compatibility window. Absent ``execution`` reads as ``runnable``.

    ``ExternalAgentSpec.health`` shape (when populated)::

      {
        "id": str,
        "status": "ready" | "not_configured" | "expired" |
                  "network_error" | "not_executable" | "unknown",
        "details": dict,
        "reason": str | None,
        "checked_at": int
      }

    ``health`` is also populated **without** ``include_health`` in one
    case: when detection finds the binary but proves it cannot be
    executed, the spec comes back with ``status="not_executable"`` and
    a ``reason`` naming the path. Do not invoke a spec in that state —
    it will be killed at exec. Typical cause on macOS is Gatekeeper
    quarantine on a binary installed outside the App Store.

    The ``auth_kind`` field is **deprecated** (Phase 2 stage 1) —
    modern builds keep credentials in OS keystores so the heuristic
    falls through to ``"unknown"`` for the most common installs.
    Prefer ``health``."""


def agents_detect_external(include_health: bool = False) -> str:
    """Force re-detection of installed external agents. Updates the
    presence cache and returns the new snapshot. Pass
    ``include_health=True`` to also run ground-truth health checks
    (force-refreshing the per-tool 30s TTL cache). Returns JSON
    ``[ExternalAgentSpec]``."""


def agents_invoke_external(
    id: str,
    task: str,
    options_json: Optional[str] = None,
) -> str:
    """Per-task invocation of an external CLI agent (Phase 2 stage 3).

    ``id`` selects the adapter (``"claude-code"`` today; ``codex``
    and ``gemini`` ship in follow-up PRs). ``task`` is the prompt.
    ``options_json`` is a JSON-encoded ``InvokeOptions``; pass ``None``
    or ``"{}"`` to accept defaults.

    ``InvokeOptions`` shape::

      {
        "cwd": str | None,
        "allowed_tools": list[str] | None,  # [] denies all
        "max_turns": int | None,
        "timeout_secs": int | None,  # default 300s
        "mcp_endpoint": str | None,  # MCP server URL passed via
                                     # --mcp-config; daemon callers
                                     # auto-fill from car-server's
                                     # bound /mcp URL. "" opts out.
        "attachments": [             # images attached to the prompt
          {"path": str,             # abs path on the daemon's fs
           "media_type": str | None}  # advisory; runner derives from content
        ] | None,
      }

    ``attachments`` are image files the runner hands to the CLI in its
    native form: Claude Code reads + inlines a base64 image block on
    stdin, Codex passes each via ``--image``, Gemini references it with
    ``@path``. Paths must be readable by the daemon process. The runner
    caps reads at 32 MB and (on the read/stage paths) verifies the bytes
    are a real image by magic signature, deriving ``media_type`` from
    content — non-image / oversized / unreadable paths are skipped, so a
    file that isn't an image is never inlined. Adapters whose CLI lacks
    image input ignore them.

    Returns JSON ``InvokeResult``::

      {
        "answer": str,
        "session_id": str | None,
        "turns": int,
        "tool_calls": int,
        "duration_ms": int,
        "total_cost_usd": float | None,
        "dropped_attachments": int,  # images dropped (unreadable/oversized/not an image); omitted when 0
        "is_error": bool,
        "error": str | None
      }

    Each invocation burns subscription quota. Callers are responsible
    for rate limiting.
    """


def agents_health_external(id: Optional[str] = None, force: bool = False) -> str:
    """Ground-truth health check via each tool's own auth-status
    command (``claude auth status``, ``codex login status``). Replaces
    the Phase 1 credential-file shape heuristic as the primary signal
    for "is this tool ready to invoke."

    Pass ``id`` to check one adapter; omit it to check every detected
    adapter. ``force=True`` bypasses the 30s per-tool TTL cache.

    Returns JSON ``[ExternalAgentHealth]`` (when ``id`` omitted) or
    ``ExternalAgentHealth`` (when ``id`` supplied), with shape::

      {
        "id": "claude-code" | "codex" | "gemini",
        "status": "ready" | "not_configured" | "expired" |
                  "network_error" | "not_executable" | "unknown",
        "details": <tool-specific JSON object>,
        "reason": <human-readable string when not Ready>,
        "checked_at": <unix-secs>
      }

    ``not_executable`` is set by *detection*, not by an auth-status
    command — a binary the OS won't run can't report its own auth
    state. It means the install is broken, not that the user is signed
    out, so don't prompt for a login flow.
    """


# ---------------------------------------------------------------------------
# A2UI surface store (car-a2ui)
#
# Process-singleton in-process A2UI v0.9 store. Wire shapes match the
# daemon's WebSocket ``a2ui.*`` methods so a host can swap transports
# without reshaping payloads. Daemon-shared state across processes
# still flows over WebSocket — these helpers do NOT proxy to it.
# ---------------------------------------------------------------------------


def a2ui_capabilities() -> str:
    """Return JSON ``A2uiCapabilities`` ``{"version", "mimeType",
    "catalogs", "components", "limits"}`` for the in-process store."""


def a2ui_apply(envelope_json: str) -> str:
    """Apply a single A2UI envelope (``createSurface`` |
    ``updateComponents`` | ``updateDataModel`` | ``deleteSurface``).

    ``envelope_json`` is the direct envelope shape — exactly one
    message field set. Returns JSON ``A2uiApplyResult``
    ``{"surfaceId", "deleted", "surface"?}``.
    """


def a2ui_ingest(payload_json: str) -> str:
    """Extract A2UI envelopes from a carrier payload (``{"a2ui":
    {...}}``, A2A ``DataPart``, artifact ``parts``, etc.) and apply
    each in order. Owner is auto-extracted from A2A ``taskId`` /
    ``contextId`` shapes when present. Returns JSON ``{"applied":
    [A2uiApplyResult]}``.
    """


def a2ui_surfaces() -> str:
    """List all live A2UI surfaces in the in-process store. Returns
    JSON ``[A2uiSurface]``."""


def a2ui_get(surface_id: str) -> str:
    """Fetch a surface by id. Returns JSON ``A2uiSurface`` or
    ``null`` if the surface doesn't exist."""


def a2ui_reap() -> str:
    """Reap surfaces older than ``limits.maxSurfaceAgeSecs``.
    Returns JSON ``{"removed": [surfaceId]}`` — empty array when
    nothing was due."""


def a2ui_validate_payload(value_json: str) -> str:
    """Validate a JSON payload against the store's size limits.
    Returns JSON ``null`` on success; raises ``RuntimeError`` with
    a limit-exceeded message otherwise."""
