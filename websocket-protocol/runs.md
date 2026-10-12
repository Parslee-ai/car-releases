{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### runs

Agent run tracing (U1). A *run* is one `runs.start` / `runs.complete`
bracket around an agent loop, identified by a durable `run_id` (a uuid)
that is **independent of the ephemeral, server-assigned WS `client_id`**.
The `run_id` is the connection-independent, restart-surviving key the
`client_id` cannot be: it groups a run's records and maps an agent to its
runs. The per-turn capture (`RunModelTurn`, plus action
`RunTurn`/`CliOutcome`/`VerifierVerdict` records), the disk store, the live
`runs.trace.event` notification (`runs.subscribe`
/ `runs.unsubscribe`), and the replay read RPCs (`runs.list` /
`runs.get_trace`) are documented below.

**Authorization (R16 + #254).** Every read/subscribe method —
`runs.subscribe`, `runs.list`, `runs.get_trace` — verifies the calling
connection is entitled to the run's owning `agent_id`. A supervised agent
owns its runs after authenticating with its own credentials:
`session.auth { token: CAR_AGENT_TOKEN, agent_id: CAR_AGENT_ID }`. That
agent-bound session can list and replay only that same `agent_id`; it does
**not** need the host token for its own history, and its token never grants
access to another agent's runs. The wider alternative is the
**host-management role** (authenticated via `session.auth { host_token }`
with the per-launch host token). Merely having called `host.subscribe` is
**not** sufficient — that check let any authenticated local connection
self-elevate and read every agent's run traces (Parslee-ai/car#254); the
host token, readable only from the `0600` `host-token` file and never
served over HTTP, is now required. A caller-supplied `agent_id` / `run_id`
is **not** a transparent key — an unentitled request is rejected, not
served (an `agent_id` can't be used to enumerate another agent's runs).

**Write authorization is stricter — owner-binding only.** The write methods,
`runs.record_turns` and `runs.record_model_turn`, accept the run's **owning
agent** alone: the calling connection's `session.auth {agent_id}` binding must equal the run's
owning `agent_id`. The host token is **not** accepted for writes — it would
let a CarHost (or any host-token holder) forge turns into another agent's
trace. A host-token-only session and an unbound session are both rejected,
and the rejection is the same uniform not-found an unknown run yields (no
existence/owner oracle on the write path either).

#### `runs.start`
- **Params**: `{ intent, agent_id?, agent_name?, outcome_description?, idempotency_key? }`
  - `intent` (required) — what the agent was asked to do.
  - `agent_id` (optional) — the owning agent. When omitted, the daemon
    resolves it in order: the connection's `session.auth {agent_id}`
    binding → the `CAR_AGENT_ID` env (supervised one-shot) → a
    deterministic id synthesized from `agent_name` (unsupervised
    one-shot, e.g. `run_scenarios.py`). With none of these resolvable
    the call is **rejected** — a run with no identity has no durable key.
  - `agent_name` (optional) — display name; the source for the
    synthesized fallback id (a `name:<slug>` form).
  - `outcome_description` (optional) — the outcome the agent steers toward.
  - `idempotency_key` (optional) — a caller-supplied run id for an
    **idempotent start**. When present and a run with this id already
    exists — in-flight (active in memory) or persisted (a completed run on
    disk) — the daemon returns that existing run instead of opening a
    duplicate, re-pointing the session's current run at it. Absent ⇒ the
    daemon mints a fresh random `run_id` (the prior behavior). This lets a
    retried or replayed occurrence record exactly once; it pairs with the
    scheduler's deterministic occurrence ids
    (`docs/proposals/deterministic-run-id.md`). Best-effort: two truly
    concurrent starts with the same key can still both miss — the
    execution lease, not this, is the exactly-once guard.
- **Returns**: `{ run_id, agent_id }` — `run_id` is the supplied
  `idempotency_key` when one was given (whether newly created or the
  deduped existing run), otherwise the freshly minted id.
- The daemon mints the `run_id` (or adopts the `idempotency_key`), sets it
  as the session's **current run before this handler responds** (so a
  proposal submitted immediately after the ack is recorded under the
  correct `run_id` — the U2 race guard), and records a `RunStarted` record.
  The harness MUST await this ack before submitting any proposal.
- Exposed as a **real** FFI binding (`runsStart` / `runs_start`) — the JS
  harness drives the capture pipeline through it.

#### `runs.resume` (`runs.resume.v1`)
- **Params**: exactly `{ run_id }`. Unknown fields are rejected; there is no
  caller-supplied `client_id`, owner token, or idempotency key credential.
- **Returns**:
  `{ run_id, agent_id, client_id, resumed_from_client_id }`, where both client
  ids were minted by this daemon. The immutable `RunStarted`/proposal/
  `RunEnded` provenance remains bound to the original client; `client_id` is
  the replacement socket now fenced as the one live producer.
- The connection must negotiate `runs.resume.v1` and authenticate through
  `session.auth { token, agent_id }` as the run's owning supervised agent.
  Host-token and unbound authenticated sessions cannot resume a run. The old
  owner must already be absent from the daemon's live session registry.
- Reclaim is atomic: concurrent authenticated replacements have one winner,
  and all stale/later owners are rejected. Outcome, failed, cancelled, and
  `Incomplete` terminals are never reopened; neither are uncommitted,
  cancellation-pending, terminal-pending, or corrupt runs.
- A resumed run is recovery-only. `proposal.submit` may return the exact
  completed response stored under the original durable client identity, or
  finish that proposal's durable finalization. It never dispatches a new
  proposal and never redispatches an outcome-unknown execution marker. Safe
  per-action retries remain the existing proposal engine's explicit
  `failure_behavior: "retry"` / `max_retries` semantics; recovery adds no new
  permission to repeat a non-idempotent action.
- If that completed proposal used a policy session, the replacement submits
  through a newly minted policy session that is live on its own connection.
  CAR validates the retained response's original authenticated policy
  provenance; it does not reuse the closed session for new work.
- When a producer that negotiated `runs.resume.v1` is removed from the live
  session registry, the daemon starts a 10-second in-process resume lease.
  Each resumed producer disconnect renews a fresh 10-second lease. Producer
  sessions without this capability retain the legacy 250ms disconnect grace.
  The lease is ephemeral and is not restored after a daemon restart; a
  replacement must claim before its lease expires and the orphan is committed
  as `Incomplete`.
- This is a WebSocket newsroom recovery surface only. It has no NAPI, PyO3,
  UniFFI, native, or mobile binding.

#### `runs.complete`
- **Params**: `{ run_id, outcome }` where `outcome` is an `AgentOutcome`
  (`{ status, summary, evidence, metrics, timestamp }`).
- **Returns**: `{ run_id, ok }`.
- Records a terminal `RunEnded` record carrying the reported outcome and
  acks. Unknown or already-terminal `run_id`s return an error (a stale or
  double-complete is surfaced, not swallowed). The harness MUST await this
  ack before letting its connection close.
- On a mid-run disconnect with **no** prior `runs.complete`, the daemon
  writes an `Incomplete` terminal marker after a short grace window — a
  healthy run whose `runs.complete` is still in flight is therefore not
  raced into `Incomplete`.
- Exposed as a **real** FFI binding (`runsComplete` / `runs_complete`).

#### `runs.cancel` (`runs.cancel.v1`)
- **Params**: exactly `{ run_id, idempotency_key, reason }`; all strings are
  required and non-empty. Unknown fields are rejected. The key is limited to
  128 bytes and the reason to 1024 bytes.
- The connection must negotiate `runs.cancel.v1` and authenticate either as
  the run's owning agent or as the host-management client. Unknown and
  unauthorized run ids return the same error.
- CAR first persists a body-free `cancellation_requested` row containing the
  SHA-256 of the exact UTF-8 reason, then cancels the exact active callback
  (`tools.cancel` with its `action_id` and `request_id`) and/or inference. A
  confirmed stop commits `RunTermination::Cancelled` through the same
  first-terminal-wins transaction as `runs.complete`; `runs.complete` cannot
  overwrite it.
- **Returns** a deterministic body-free receipt:
  `{ receipt_version, run_id, idempotency_key, reason_digest, principal,
  status, terminal_digest, action_id, request_id, receipt_digest }`.
  `status` is one of `cancelled_confirmed`, `already_terminal`, or
  `termination_unconfirmed`. `terminal_digest` is present for the first two
  and null for an unconfirmed stop. `receipt_digest` is lowercase SHA-256 of
  the RFC 8785/JCS serialization of every preceding receipt field.
- Same-key retries with the same reason/principal return the same receipt and
  digest. A different key after a terminal returns `already_terminal` bound to
  the immutable terminal digest and appends nothing after `ended`.
- If the durable run has no live metadata, or its live owner session is gone,
  and no cancellation row already exists, only a host-management caller may
  close the orphan. CAR durably records the body-free request and an
  `Incomplete` terminal, then returns `already_terminal` with that terminal's
  digest. It deliberately does not claim `cancelled_confirmed`: without the
  owner session CAR cannot prove an external child stopped. An owning agent or
  ordinary operator still receives `run cancellation control is unavailable`.
  Same-key host retries return the same receipt.
- Lost/ambiguous control after a cancellation request was already recorded
  persists `cancellation_result` with `termination_unconfirmed`; this is a
  quarantined nonterminal state that blocks proposals, completion, orphan
  adoption, and retention eviction.
- This is a WebSocket newsroom/operator surface only; no NAPI, PyO3, UniFFI,
  or mobile binding is part of this contract.

#### `runs.record_model_turn`
- **Params**: `{ run_id, turn_index, assistant_text, requested_tool_calls, model_id, token_usage, duration_ms }`.
  - `turn_index` is the packaged loop's one-based inference turn number.
  - `assistant_text` is the returned assistant text, including an empty string
    when the response only requested tools.
  - `requested_tool_calls` is an ordered array of
    `{ id, name, arguments }`. The packaged loops normalize absent call ids
    before recording, so these ids are the ones later action/tool-result
    records use.
  - `model_id` is the exact `model_used` identifier returned by inference.
  - `token_usage` is either `null` (provider reported no accounting) or
    `{ prompt_tokens, completion_tokens, total_tokens, context_window,
    cache_read_input_tokens, cache_creation_input_tokens }`.
  - `duration_ms` is the inference result's wall-clock latency.
- **Returns** the same append acknowledgement as `runs.record_turns`:
  `{ run_id, base_index, count: 1, ok: true }`, or its non-fatal drop shape.
- The daemon stamps the model turn's zero-based `index` from the shared live
  append position and adds `recorded_at`. The record is persisted and fanned
  out through the same path as action turns. A loop records the model turn
  after inference and before submitting its requested actions, so
  `runs.get_trace` returns model/action/model records in execution order.
- Assistant text and nested tool-argument strings are redacted for literal
  environment secrets and known credential shapes before persistence, then
  receive the same per-field and 256 KiB aggregate limits as action turns. The
  same owner-only authorization,
  terminal checks, 2000-record run ceiling, and durable fanout apply.
- Exposed through NAPI/PyO3 as `runsRecordModelTurn` /
  `runs_record_model_turn`. The packaged Node/Python loops call it
  best-effort: a missing method or rejected call on an older daemon does not
  abort inference or tool execution.
- This is an additive method and tagged `RunRecord` variant. Protocol version
  remains **3**: existing request semantics are unchanged, dynamic JSON
  clients can ignore an unknown `record` tag, and old packaged loops never
  call the new method.

#### `runs.record_turns`
- **Params**: `{ run_id, turns: [RunTurn] }`.
  - `turns` (required, non-empty) — a batch of turns to append, in order.
    Each `RunTurn` is `{ index?, prompt?, tool?, parameters?, output?,
    cli_outcome?, verifier_verdict?, policy_rejected? }`. On the wire a turn
    may **omit `index`** (the daemon owns the index — see below — and any
    sent value is ignored) and may **omit `verifier_verdict`** (it defaults
    to `not_run`). The other fields are optional pass-through.
- **Returns** (healthy append): `{ run_id, base_index, count, ok: true }`
  where `base_index` is the daemon-stamped 0-based position of the **first**
  turn in the batch and `count` is the number appended — the stamped
  indices are `base_index .. base_index + count`.
- **Returns** (non-fatal drop): `{ run_id, base_index: 0, count: 0,
  ok: false, dropped }` — nothing was appended and `dropped` is a
  machine-readable reason the caller treats as **stop sending for this
  run**:
  - `run_not_found` — no such run, **or** the caller isn't the owning agent
    (the two are uniform — no existence/owner oracle).
  - `run_terminal` — the run already reported an outcome / was swept
    terminal.
  - `run_turn_limit` — accepting the batch would take the run past the
    per-run turn ceiling (a runaway-loop backstop, well above any healthy
    cycle); the whole batch is refused. Enforced **under the runs lock** at
    append time, so pipelined batches cannot race past the ceiling.
  - `turn_too_large` — a turn could not be bounded under the per-turn byte
    cap even after its free-form fields were replaced (a misbehaving client);
    the whole batch is dropped, never partially admitted.
- **Validation errors** (a JSON-RPC error frame, not a `dropped` result):
  a missing/empty `run_id`, an empty/non-array `turns`, a batch larger than
  the per-call cap, or a malformed turn → the standard
  `runs.record_turns requires { run_id, turns: [RunTurn] }` error.
- **The daemon owns the turn index.** Every appended turn's `index` is
  re-stamped from its live append position under the `runs` lock, so a
  client's `index` is decorative — the response's `base_index` is the
  authoritative start. A present-but-invalid `index` (`-1`, a string, a
  float) is **ignored**, not an error — it is overwritten before decode.
- **Appends are immutable — there is no update/enrich by index.** A recorded
  turn is never revised; sending a turn with the same `index` does not
  overwrite an earlier one (the daemon re-stamps it to a fresh appended
  position). A client should therefore narrate a turn **only once its output
  exists**: a turn pushed before it produces output renders a permanently
  "running" phantom row in the live view (the live trace has no later signal
  to settle it), since a client-narrated turn carries no `cli_outcome` to
  close it out.
- **Daemon-owned size invariants.** The daemon never trusts client
  truncation for data that lands on disk: each turn's `prompt` / `output` /
  oversized `parameters` strings are truncated to ~16 KB with a
  `…[truncated]` marker before persisting; a whole turn whose encoded form
  exceeds 256 KiB (e.g. many sub-cap strings) has its `parameters` /
  `output` / `prompt` replaced with a `…[truncated: turn exceeded 256 KiB]`
  marker, so every persisted JSONL line is bounded regardless of how bytes
  are spread across fields (the cap is measured with a small reserve for the
  daemon's index re-stamp, so the persisted line stays within 256 KiB even at
  a high index); a turn that still exceeds the cap after replacement is
  dropped (`turn_too_large`); a batch is capped at 256 turns (larger →
  error); the run ceiling is a hard cap — no batch is accepted that would
  take a run past 2000 turns (`run_turn_limit`).
- **Append path is shared with the proposal recorder.** Turns are appended
  through the same internal path proposal-recorded turns use — identical
  index re-stamp, JSONL persistence (`~/.car/runs/{agent_id}/`), and live
  `runs.trace.event` fanout to subscribers. A subscriber sees one
  `runs.trace.event` per turn with contiguous cursors; the trace survives a
  daemon restart and replays via `runs.get_trace`.
- **Turn content is pass-through.** This is the turn channel for
  out-of-pipeline agents whose work happens **outside** `proposal.submit`
  (e.g. an agent that drives a `claude -p` subprocess and narrates its own
  turns). The daemon validates **size and ownership only**, never turn
  semantics — a client-narrated turn carries no Bulldozer classifier fields
  (`verifier_verdict: not_run`, no `cli_outcome`).
- **Authorization** — owner-binding only; the host token is **not** accepted
  for writes. See the **Write authorization** note in the section intro
  above.
- **WS-only** — no FFI binding (the consumer speaks raw WS, like
  `runs.subscribe` / `runs.list` / `runs.get_trace`). The FFI parity table
  is unchanged.

#### `runs.subscribe`
- **Params**: `{ run_id }` — or, with `runs.pagination.v1` negotiated,
  `RunSubscribeRequest` `{ run_id, cursor, limit }` (all required).
> **Paginated variant.** A session that negotiates the
> `runs.pagination.v1` capability in `server.handshake` sends a **different,
> stricter** params shape to `runs.subscribe`, `runs.list` and
> `runs.get_trace`: `cursor` and `limit` become **required** (`limit` must be
> between 1 and 500). Sessions that do not negotiate it keep the legacy shapes
> documented below, where `cursor` is optional and `limit` does not exist. The
> handler picks the shape from the negotiated capability, not from the payload,
> so sending `limit` without negotiating is ignored and omitting it after
> negotiating is an error.

- **Returns** (the snapshot at cursor): `{ run_id, agent_id, turns_so_far,
  cursor, status }`. On the non-paginated lane, this also recovers pre-v3
  durable traces that have no summary sidecar.
  - `turns_so_far` — the run's ordered `RunRecord::ModelTurn` and
    `RunRecord::Turn` records captured at subscribe time.
    `cursor == turns_so_far.length`.
  - `cursor` — the turn boundary the daemon streams strictly after. Every
    model or action turn recorded **after** this index arrives as a `runs.trace.event`
    with a contiguous `cursor` (the previous event's `cursor + 1`); a
    subscriber that sees a non-contiguous cursor knows a gap occurred and
    re-subscribes to backfill.
  - `status` — the run's live status: `in_progress` | `completed` |
    `incomplete`.
- **Atomicity (R7).** The snapshot read and the subscriber registration
  happen under the **same lock** the recorder holds when it appends a
  turn, so no turn in the snapshot/register window is dropped (gap) or
  double-delivered (dup). Subscribe mid-run at turn 7 → the snapshot
  carries turns ≤7 with `cursor = 7`, and turn 8 arrives via the stream
  with no duplicate of turn 7.
- **Fanout.** Each `(connection, run_id)` is an independent subscriber via
  a bounded channel + a dedicated drain task — two CarHost windows on the
  same run both receive every event. (The single-subscriber-per-method
  notification registry can't express this; the daemon runs an explicit
  fanout.)
- **Backpressure (never stalls the daemon).** The recorder only pushes
  onto the bounded channel and returns; the drain task owns the WS write.
  A slow/wedged CarHost socket therefore never blocks the recv loop, the
  runs lock, or any other in-flight RPC. When a subscriber's channel
  fills, the event is **dropped** (best-effort) — the client detects the
  cursor gap and re-subscribes (R8).
- **Reconnect-durable (R8).** Trace subscriptions are exempt from the
  chat-style drain-and-synthesize-error path. On a CarHost WS reconnect,
  the client re-issues `runs.subscribe {run_id}` on the new connection; the
  fresh snapshot covers any turns emitted during the outage with no dup,
  and the underlying run is never marked failed because a subscriber
  dropped. On disconnect the daemon drops only that connection's
  subscriptions (and ends their drain tasks).
- **Authorization (R16)** — see the section intro above.
- **WS-only** — no FFI binding (CarHost consumes the notification). The
  FFI parity table is unchanged.

#### `runs.unsubscribe`
- **Params**: `{ run_id }`.
- **Returns**: `{ run_id, removed }` — `removed` is `true` when a
  subscription for this `(connection, run_id)` existed and was dropped,
  `false` otherwise (idempotent). No authorization gate: removing your own
  subscription leaks nothing.

#### `runs.trace.event` (server → client notification)
Pushed to every `(connection, run_id)` subscriber for each record the
daemon appends. Shape: `{ run_id, agent_id, record, cursor, status }`.
- `record` is a `RunRecord`:
  - `{ record: "started", ... }` — a lifecycle marker emitted on
    `runs.start`. `cursor` is the run's current turn count (0 at start)
    and does not advance the turn stream. In practice a subscriber (which
    can only subscribe after the run exists) won't observe it.
  - `{ record: "model_turn", ... }` — one model decision
    (`RunModelTurn`) containing assistant text, requested tool calls/ids,
    model id, token usage, and duration. `cursor` advances by one.
  - `{ record: "turn", ... }` — one captured action turn (`RunTurn`).
    `cursor` is the run's model/action turn count immediately **after** this
    record was appended (1-based); the next turn event's cursor is this `+ 1`.
  - `{ record: "ended", ... }` — the terminal record (a reported
    `Outcome` or an `Incomplete` marker). `cursor` carries the final turn
    count; `status` flips to `completed` / `incomplete`.
- `status` is the run's live status after this record.

#### `runs.list`
- **Params**: `{ agent_id }` — or, with `runs.pagination.v1` negotiated,
  `RunListRequest` `{ agent_id, cursor, limit }` (all required).
- **Returns**: `{ agent_id, runs }` where `runs` is an array of
  `RunSummary`, **newest first** (by `started_at`):
  - `RunSummary`: `{ run_id, agent_id, intent, started_at, ended_at?,
    status, turn_count }` where `status` is `in_progress` | `completed` |
    `incomplete` and `turn_count` is the number of persisted model and action
    turn records. `ended_at` is present once the run reached a terminal state.
- Reads the **disk store** (`~/.car/runs/{agent_id}/`), not live session
  state, so it works across daemon restart and `client_id` churn —
  `agent_id` is the durable key.
- An agent with no runs returns `{ agent_id, runs: [] }` (the empty state,
  not an error).
- **Authorization (R16)** — see the section intro. An agent-bound session
  may pass its own bound `agent_id` and receives its own durable runs. Passing
  any other agent id is rejected before any directory is read; the param is
  an authorization subject, not a lookup key. A host-management session may
  list any agent.
- **WS-only** — no FFI binding (CarHost consumes it over the socket, like
  `runs.subscribe`). The FFI parity table is unchanged.

#### `runs.get_trace`
- **Params**: `{ run_id, cursor? }` — or, with `runs.pagination.v1` negotiated,
  `RunGetTraceRequest` `{ run_id, cursor, limit }`, where `cursor` becomes
  required too (send `0` for the beginning).
  - `cursor` (optional) — a start index into the run's ordered `RunRecord`
    stream; the first record returned. Omitted / `0` returns the whole
    trace; a non-zero cursor pages a large run from that offset.
- **Returns** (run found): `{ run_id, agent_id, records, cursor }` where
  - `records` — the run's persisted `RunRecord`s in order, bracketed
    `{ record: "started" } … (interleaved `RunModelTurn` and action `RunTurn`
    records) … { record: "ended" }`. Model turns expose why the next actions
    were requested; action turns expose what ran. Both record kinds are
    **identical to what the live `runs.trace.event` stream delivered** — replay
    and live render through one buffer (R9).
    When `cursor > 0`, `records` begins at that offset (records before it
    are omitted).
  - `cursor` — the applied start offset (echoes the request; `0` for a
    full fetch).
- **Returns** (run unknown): `{ run_id, not_found: true }` — a clear
  not-found **marker**, not an error frame, so a UI distinguishes "no such
  run" from a transport failure.
- A `timeout` / `Incomplete` run is **not** an error: its partial trail
  (the turns recorded so far plus the terminal `{ record: "ended" }`
  `Incomplete` marker) is returned, so the dashboard renders the partial
  run.
- Reads the **disk store** by resolving `run_id → agent_id` from the tree,
  then loading the JSONL — works on a freshly-restarted daemon with empty
  memory (R4).
- **Authorization (R16)** — the owning `agent_id` is resolved from disk and
  the caller is authorized against it before any record is served. An
  agent-bound session can replay a run only when that owner equals its bound
  `agent_id`; a host-management session may replay any agent's run. An
  unauthorized rejection never leaks the run's prompts/outputs. (An
  unknown `run_id` returns the not-found marker without revealing whether
  the id exists, since there is no owner to authorize against.)
- **WS-only** — no FFI binding. The FFI parity table is unchanged.


{% endraw %}
