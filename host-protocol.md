# CAR Host Protocol

CAR exposes a host-facing JSON-RPC surface over the existing `car-server`
WebSocket. OS integrations can use this protocol to provide one shared control
surface for agents instead of requiring each agent to build its own UI.

## Host Clients

There are two first-party host clients:

- **SwiftUI `CarHost.app`** (`apps/host-macos/`) — the macOS menu-bar shell.
  Uses `MenuBarExtra` + `Settings` + a SwiftUI `Window` for the dashboard, and
  hosts App Intents/Siri shortcuts. This is the only macOS UX surface; see
  [`docs/proposals/macos-ux-consolidation.md`](./proposals/macos-ux-consolidation.md).
- **`car-host` terminal CLI** (`car-rs/crates/car-host/`) — a portable terminal
  client over the host protocol. Useful for headless deployments, remote SSH
  sessions, CI smoke tests, and Linux/Windows where no native shell exists yet.

```bash
car-host list
car-host watch
car-host approve approval-abc123
car-host deny approval-abc123
```

`car-host --start-server ...` starts `car-server` when the configured WebSocket
endpoint is not reachable.

Protocol smoke coverage lives in:

```bash
cd car-rs
./scripts/smoke_car_host.sh
```

A future Linux/Windows native tray (if there is demand) should be a separate
binary or a cfg-target gated branch — not a feature flag, per CLAUDE.md hard
rule #1.

## Subscribe

```json
{
  "jsonrpc": "2.0",
  "method": "host.subscribe",
  "params": {},
  "id": 1
}
```

The response includes the current `agents`, `approvals`, and recent `events`.
After subscribing, clients receive notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "host.event",
  "params": {
    "id": "event-...",
    "sequence": 1042,
    "timestamp": "2026-04-25T13:00:00Z",
    "kind": "agent.status_changed",
    "agent_id": "agent-id",
    "message": "Researcher completed",
    "payload": {}
  }
}
```

## Methods

- `host.agents`: list registered agents.
- `host.events`: list recent host events. Params: `{ "limit": 100 }`.
- `host.approvals`: list approval requests.
- `host.register_agent`: register an agent visible to host UI.
- `host.unregister_agent`: remove an agent. Params: `{ "agent_id": "..." }`.
- `host.set_status`: update agent status and task text.
- `host.notify`: append and broadcast a host event.
- `host.request_approval`: create an approval request for the host UI.
- `host.resolve_approval`: resolve a pending approval request.
- `agents.chat`: issue a chat turn to a named lifecycle agent. See
  `agents.chat` below.
- `agents.chat.cancel`: abort an in-flight chat. Params:
  `{ "session_id": "chat-..." }`.
- `agents.chat.approve`: resolve an inline chat approval an agent raised
  via an `approval_pending` event, so the parked turn resumes. Params:
  `{ "session_id": "chat-...", "approval_id": "...", "decision": true }`.
  Reverse-requests the agent's `agent.chat.approve`; returns
  `{ "resolved": bool }`. Distinct from `host.resolve_approval` (that
  resolves permission-tier / ApprovalLedger requests, not the agent's
  ephemeral chat-turn gate).
- `runs.subscribe`: subscribe to a run's live trace. Returns a snapshot +
  cursor, then streams `runs.trace.event` notifications. Params:
  `{ "run_id": "..." }`. See `runs.trace.event` below.
- `runs.unsubscribe`: drop this connection's subscription for a run.
  Params: `{ "run_id": "..." }`.

## `agents.chat`

Unified chat surface — see
[`docs/proposals/agent-chat-surface.md`](./proposals/agent-chat-surface.md)
for the full design.

Request:

```json
{
  "jsonrpc": "2.0",
  "method": "agents.chat",
  "params": {
    "agent_id": "milo",
    "prompt": "what's on my calendar today?",
    "session_id": "chat-abc123",
    "stream": true,
    "voice_input": false,
    "model": "openrouter/deepseek/deepseek-v3.2"
  },
  "id": 42
}
```

`session_id` is host-generated (recommended) so a CarHost window
managing multiple concurrent chats per agent can demux. When omitted,
the daemon generates `chat-<uuid>`. `stream: false` is accepted on the
wire but agents may still emit incremental events — the host should
not rely on a single response frame. `model` is optional. A non-empty CAR model
ID is a strict per-turn selection forwarded to the attached agent (or the
in-daemon declarative runner); omitting it preserves that agent's configured
model and adaptive fallback policy.

Response (after the agent acks, capped at 5s):

```json
{
  "jsonrpc": "2.0",
  "result": { "accepted": true, "session_id": "chat-abc123" },
  "id": 42
}
```

Streaming tokens then arrive on the host's connection as
notifications:

```json
{
  "jsonrpc": "2.0",
  "method": "agents.chat.event",
  "params": {
    "session_id": "chat-abc123",
    "agent_id": "milo",
    "kind": "token",
    "delta": "On your calendar"
  }
}
```

`kind` is a discriminated enum:

- `token` — incremental text delta. `delta: string`.
- `done` — final frame for the turn. `finish_reason: string`,
  `text?: string` (the full accumulated text). The daemon drops the
  routing entry on `done`; further events for this `session_id` are
  silently discarded.
- `error` — agent-side error. `error: string`. Also terminal.
- `tool_call` — agent invoking a tool that the host may want to
  render. `tool: string`, `params?: object`. Non-terminal. The macOS
  host renders a structured tool-call row (name + collapsible args).
  For back-compat the host also accepts `tool_name`/`name`/`detail`
  as aliases for the name and `tool_args`/`input` as aliases for the
  args; object args are shown as compact sorted-key JSON. The
  external-CLI projection (`agents.invoke_external` with `stream`)
  emits `tool` + `params` (plus a legacy `detail` = name).
- `approval_pending` — agent has parked the turn on a user approval
  (e.g. Milo's calendar-write gate, or `car do`'s write/shell gate).
  `approval_id: string`, `action`/`tool: string`, `details?`/`params?:
  object`. Hosts should render an inline Approve/Deny and resolve via
  **`agents.chat.approve`** `{ session_id, approval_id, decision }`,
  which reverse-requests the agent's `agent.chat.approve` handler.
  (`host.resolve_approval` is a separate flow — permission-tier /
  ApprovalLedger requests — and does **not** resolve this chat-turn
  gate.) Non-terminal — the agent resumes the stream after resolution.

### Agent-side contract (`agent.chat`)

To opt into the surface, an agent must implement two reverse-callback
methods on its server-bound WS connection:

- `agent.chat { session_id, prompt, stream, context, model?, attachments? }` —
  request. Agent acks with `{ accepted: true, session_id }` (or rejects
  with a JSON-RPC error). `context.host_client_id` and
  `context.voice_input` are advisory.
  - `model?` — optional CAR model ID forwarded from the host's
    `agents.chat.model` selection. A non-empty value is a strict per-turn
    selection: bundled agents send it to inference unchanged and report that
    model's failure instead of silently substituting another model. When the
    field is omitted, the agent keeps its configured model and adaptive
    fallback policy. The generated Node/Python harnesses use request-shaped
    `inferTrackedWithRequest` / `infer_tracked_with_request` only for the
    explicit branch; omitted, null, and blank values retain the existing
    positional request.
  - `attachments?` — optional array of image `ContentBlock`s the user
    attached, e.g.
    `[{ "type": "image_base64", "data": "<b64>", "media_type": "image/png" }]`
    (or `{ "type": "image_url", "url": "…", "detail": "auto" }`). The
    daemon validates the shape and forwards it verbatim. A
    vision-capable agent passes it straight through to inference as
    `imagesJson` — `inferTracked(prompt, …, JSON.stringify(attachments))`
    (NAPI) / `infer_tracked(prompt, …, images_json=…)` (PyO3). Agents
    that don't read the field simply ignore it (the request is
    otherwise unchanged). The daemon validates the attachment shape but
    not provider capability — a non-vision provider rejects the images
    downstream at inference. See the FFI `imagesJson` / `images_json`
    param.
- `agent.chat.cancel { session_id }` — notification (no id). Best-
  effort fire-and-forget; agent should short-circuit its inference
  stream and `inference.stream.cancel` upstream.

Streamed tokens go up the same WS as `agent.chat.event`
notifications keyed by `session_id`. The daemon's interceptor
rewrites the method to `agents.chat.event` before forwarding to the
originating host (see `try_forward_agent_chat_event` in
`car-server-core/src/handler.rs`).

The streaming-through-lifecycle-agent contract (below) applies:
agents MUST drain their internal inference stream into a bounded
channel + dedicated forwarding task. A slow downstream host must not
take an agent's recv loop down with it.

## Agent Shape

```json
{
  "id": "researcher-1",
  "name": "Researcher",
  "kind": "builtin",
  "capabilities": ["web_research", "summarize"],
  "project": "/Users/example/project",
  "status": "idle",
  "current_task": null,
  "pid": null,
  "metadata": {}
}
```

Status values are `idle`, `running`, `waiting_for_approval`, `paused`,
`completed`, `errored`, and `stopped`.

## Approval Shape

```json
{
  "id": "approval-...",
  "agent_id": "researcher-1",
  "action": "Run cargo test",
  "details": { "command": "cargo test --workspace" },
  "options": ["approve", "deny"],
  "status": "pending",
  "created_at": "2026-04-25T13:00:00Z"
}
```

## Browser sign-in attention (`browser.signin_needed` / `browser.signin_resolved`)

Two `host.event` kinds that say **an agent's browser is blocked waiting for a
human to sign in**, and then that the wait ended.

They ride the always-on `host.event` channel rather than the drawer's
`browser.view.event`, and that is the entire point. `browser_await_signin`
blocks the agent for up to 1800 s; `browser.view.*` requires a live
per-conversation subscription, so with the drawer closed — or another
conversation in view — a client watching only that surface learns nothing. A
host subscribes to `host.event` once, on connect, for the whole daemon, so
these reach it regardless.

```json
{
  "jsonrpc": "2.0",
  "method": "host.event",
  "params": {
    "id": "event-...",
    "sequence": 1043,
    "timestamp": "2026-04-25T13:00:00Z",
    "kind": "browser.signin_needed",
    "agent_id": null,
    "message": "Sign in at https://example.com/login",
    "payload": {
      "conversation_id": "chat-6f2c...",
      "standing_session": false,
      "message": "Sign in at https://example.com/login"
    }
  }
}
```

`browser.signin_resolved` carries the same envelope with the summary message
`"The browser sign-in wait ended"`; its payload is only
`{ "conversation_id", "standing_session" }` and omits the prompt `message`.

- `conversation_id` — the browser-view key, the same one `browser.view.*`
  takes. The **empty string** is the standing session, matching the
  `conversation_id: null` convention on that surface. For CAR Chat this is
  the per-turn `agents.chat` `session_id`, not a durable conversation id.
- `standing_session` — `true` iff `conversation_id` is empty.
- `message` — the plain-words prompt the drawer's strip shows, e.g. `"Sign in
  at https://example.com/login"`. This is the string the sign-in tool itself
  composed; **nothing read off the page ever appears here** — no title, no
  live URL, no form contents, no cookies. A sign-in window is exactly when the
  privacy blackout is up.

**When they fire — the transition rule.** Both fire on the pending-sign-in
state transition, never on an apply or a push. The last row is the one
exception, and it is a route change rather than a state change:

| before | after | emitted |
|---|---|---|
| none | pending | `browser.signin_needed` |
| pending | none | `browser.signin_resolved` |
| pending A | pending B | `browser.signin_needed` when the prompt changed |
| pending A | pending A | nothing |
| none | none | nothing |
| pending on view X | still pending, X retired | `browser.signin_resolved` for X's `conversation_id`, then `browser.signin_needed` for a surviving view of the same browser |

The third row is load-bearing for a client: a supervised agent republishes its
presentation on every change and re-registers its known conversations every 10
seconds, so an emitter that fired per apply would notify once every few
seconds for a single sign-in.

`browser.signin_resolved` is guaranteed for every `browser.signin_needed` that
the daemon outlives — signed in, handed back, timed out or the run ending when
nobody engaged, the host disconnecting, the disconnect grace expiring, or the
supervised process dying. It is also emitted when a wait MOVES: one supervised
process backs several per-turn views, and retiring the view that was reporting
a wait produces `resolved` for that `conversation_id` immediately followed by
`needed` for a surviving view of the same browser. The browser is still
blocked; only the route changed. Ordinary per-key handling gets this right —
clear the old key, raise the new one — but do not special-case `resolved` as
proof the sign-in finished. When a person engaged during the wait, timer expiry
and run end deliberately do **not** clear it: hand-back or disconnect grace is
the truthful ending.

`host.subscribe` also returns `pending_signins`, an authoritative array of
`{ conversation_id, standing_session, message }`, plus `event_sequence`, the
latest monotonic host-event sequence observed before that snapshot was read.
Reconcile local attention against the snapshot after every reconnect **one
conversation key at a time**: the snapshot's verdict stands for a key — listed
means waiting, omitted means resolved — unless a live event with a strictly
larger `sequence` already arrived on that socket **for that key**. Do not
reject the whole snapshot because one key raced. The subscriber is registered
before the response is written, so another conversation's sign-in can
legitimately overtake it, and discarding the snapshot on that basis leaves the
conversation that is actually blocked with no banner and no badge. The bounded
`events` array remains useful history but is not a reliable
state-reconciliation source.

**Both producers emit.** For an in-daemon runtime (`assistant_start`) the
control reducer is in this process and the transition is observed at its
single mutator. For a **supervised agent process** (`car do --serve`, CAR
Chat) the reducer is in that process, and the daemon derives the transition by
comparing the process's previous presentation with the one arriving on
`browser.producer.presentation` — which already flows on every presentation
change while the producer is registered, and is not gated on anybody watching
the drawer. The process owns the comparison once even when it backs several
per-turn views. There is no extra agent → daemon method for this. Exactly one
of the two producer paths applies, so a single sign-in is never announced
twice.

The **standing session** never emits: it is reachable only through
`browser.view.*` user input, never through an agent's tools, so no agent
sign-in wait can arise on it.

## Built-In Eventing

The WebSocket multi-agent callback runner automatically registers each agent
run with the host, marks it `running`, and then marks it `completed` or
`errored` when the callback returns. Scheduler runs use the same runner, so
scheduled agents appear in the host UI without additional client work.

## Streaming through a lifecycle agent

A lifecycle agent that serves its own UX (e.g., a chat front-end forwarding
`inference.stream.event` notifications from the daemon to a browser via SSE)
sits between two streaming layers with **independent backpressure**:

1. Daemon → agent: WS notifications arriving on the agent's `DaemonClient`
   recv loop.
2. Agent → its own client: SSE / WS / whatever the agent serves.

The trap: the recv loop in `DaemonClient` invokes notification handlers
*synchronously*. If the handler forwards by writing directly to a slow
downstream consumer (a tab on a flaky link, a paused SSE reader), the
handler blocks, the recv loop stalls, and **every other in-flight JSON-RPC
call on this client times out** — including unrelated calls (state,
memory, `tools.execute` callbacks). One slow SSE client takes the whole
agent down.

The contract for streaming through a lifecycle agent:

- **Never call the downstream sink directly inside the notification
  handler.** Push the event into a bounded channel (tokio mpsc / async
  queue) and return. The recv loop returns to demuxing other frames. This
  is the same pattern PyO3's `voice.event` handler uses to bridge into the
  GIL-holding Python thread; same shape applies here.
- A **dedicated forwarding task** drains the channel and writes to the
  downstream sink. When the channel fills (slow client), choose a policy:
  drop the oldest delta (acceptable for partial-token text), apply
  backpressure to the daemon by closing the upstream stream, or surface a
  `streaming.degraded` event the agent's UI can render. **Never block the
  producer.**
- One drain task **per downstream client**, not per agent. Two clients of
  the same agent must not interfere with each other's stream.
- Set send timeouts on the downstream writer. A wedged socket should be
  closed, not held open until it OOMs the agent.
- When a downstream client disconnects, signal the drain task to stop
  forwarding for that client. If the agent issued the
  `inference.stream.start` upstream and no client remains, send
  `inference.stream.cancel` to the daemon to free per-stream resources.

In short: the lifecycle agent owns the impedance mismatch between the
daemon's reliable single-producer recv loop and an arbitrary fan-out of
unreliable downstream readers. Treat the daemon connection as the
**authoritative source of truth** for in-flight inference, and the
downstream connections as **best-effort projections** of it.

## Live agent-run trace (`runs.subscribe` / `runs.trace.event`)

The daemon applies the streaming contract above to **agent run tracing**
(per `docs/plans/2026-06-03-001-feat-agent-run-tracing-dashboard-plan.md`).
A CarHost dashboard watches a run unfold by subscribing to its trace:

```json
{ "jsonrpc": "2.0", "method": "runs.subscribe",
  "params": { "run_id": "9f1c…" }, "id": 7 }
```

Response — the **snapshot at a cursor**:

```json
{ "jsonrpc": "2.0", "id": 7, "result": {
  "run_id": "9f1c…", "agent_id": "bulldozer",
  "turns_so_far": [ { "record": "turn", "index": 0, "prompt": "…", … } ],
  "cursor": 1, "status": "in_progress" } }
```

Then one notification per record the daemon appends:

```json
{ "jsonrpc": "2.0", "method": "runs.trace.event", "params": {
  "run_id": "9f1c…", "agent_id": "bulldozer",
  "record": { "record": "turn", "index": 1, "prompt": "…", … },
  "cursor": 2, "status": "in_progress" } }
```

The contract that makes this reconnect-safe and daemon-safe:

- **Snapshot + register is atomic (no gap, no dup).** The daemon reads the
  run's turns-so-far AND registers the subscriber under the **same lock**
  the per-turn recorder holds when it appends. So the snapshot covers
  exactly the turns ≤ `cursor`, and every turn appended after registration
  is streamed — a turn in the snapshot/register window is never dropped or
  double-delivered. Subscribe mid-run at turn 7 → snapshot has turns ≤7,
  `cursor=7`; turn 8 arrives via the stream with no dup of turn 7.
- **Cursor monotonicity = gap detection.** A `turn` event's `cursor` is the
  run's turn count immediately after that turn (1-based). A subscriber at
  `cursor=n` expects the next `turn` event's `cursor` to be `n+1`. A jump
  means an event was dropped (slow socket) — re-subscribe to backfill.
- **Bounded channel + drain task per subscriber (never stalls the
  daemon).** Exactly the "Streaming through a lifecycle agent" pattern: the
  recorder only `try_send`s the event onto a bounded `tokio::mpsc` and
  returns; a dedicated drain task owns the WS write. A wedged CarHost
  socket therefore never blocks the recv loop, the runs lock, or any other
  in-flight RPC. A full channel drops the event (the client re-subscribes).
- **Explicit fanout, not the single-subscriber registry.** Each
  `(connection, run_id)` is its own subscriber, so two CarHost windows on
  one run both get every event. The notification handler registry is
  single-subscriber-per-method; the daemon runs the fanout itself.
- **Reconnect-durable, NOT drained-and-failed.** Trace subscriptions are
  exempt from the chat-style "drain pending requests and synthesize an
  error" path. On a WS reconnect the CarHost re-issues `runs.subscribe
  {run_id}` on the new connection and gap-fills from the fresh snapshot;
  the underlying run is **never** marked failed just because a subscriber
  dropped. On disconnect the daemon removes only that connection's
  subscriptions (and ends their drain tasks).
- **Authorization (R16).** A connection may `runs.subscribe` for a run only
  if it **owns** the run's `agent_id` (its `session.auth {agent_id}`
  binding matches) or it is the **CarHost host-client** (it has called
  `host.subscribe`). A caller-supplied `run_id` is not a transparent key —
  an unentitled subscribe is rejected. This stops any authenticated WS
  client from enumerating runs and reading another agent's prompts/outputs.

The full method/notification field reference is in
[`docs/websocket-protocol.md`](./websocket-protocol.md) under `runs`.

## Live browser view (`browser.view.subscribe` / `browser.view.event`)

The Command Deck's browser drawer applies the same streaming contract to a
**live browser** instead of a run's trace: a host watches and drives the
browser a CAR agent (or the shared standing session) is actually using.
It is built directly on `runs.subscribe` / `runs.trace.event`, point for
point, plus three properties that are new to this surface and that Task 6
and any external consumer must read as **contract**, not as bugs to route
around.

```json
{ "jsonrpc": "2.0", "method": "browser.view.subscribe",
  "params": { "conversation_id": "chat-8f2c…" }, "id": 9 }
```

Response — the **snapshot at a cursor**:

```json
{ "jsonrpc": "2.0", "id": 9, "result": {
  "conversation_id": "chat-8f2c…", "standing_session": false,
  "cursor": 41, "presentation": { "revision": 7, "owner": "agent", … } } }
```

Then one notification per event the daemon (or a relayed agent process)
produces:

```json
{ "jsonrpc": "2.0", "method": "browser.view.event", "params": {
  "conversation_id": "chat-8f2c…", "cursor": 42, "kind": "frame",
  "frame": { "jpeg_base64": "…", "width": 1920, "height": 1080,
             "device_pixel_ratio": 1.0, "captured_at": 3.417 } } }
```

The `runs.subscribe` contract carries over unchanged: **snapshot + register
is atomic** (no gap, no dup — both happen under the same lock every
emitter holds); **cursor monotonicity is gap detection** (a subscriber at
`n` expects `n+1`; a jump means re-subscribe to backfill — `presentation`'s
own `revision` is a *separate* change counter and is never the thing a
client gap-detects on); **bounded channel + drain task per subscriber**
(capacity 32, smaller than the trace stream's on purpose — a slot can hold
a full-viewport JPEG — so a wedged drawer socket never blocks the browser,
the agent, or the daemon); **explicit fanout** (two Command Deck windows on
one browser both get every event); **reconnect-durable** (a dropped
subscriber is not a failure — the client re-issues `browser.view.subscribe`
on its next connection and gap-fills from the fresh snapshot). Full
method/event field reference:
[`docs/websocket-protocol.md`](./websocket-protocol.md) under `browser`.

Eleven properties are **ruled and deliberate** — ship-blocking if an
implementation assumes otherwise:

- **Authorization is host-client-only, tighter than `runs.subscribe`.**
  Every `browser.view.*` method requires the connection to have
  authenticated as the **host-management client**
  (`session.auth { host_token }`) — full stop, with no second admission
  path for the run's owning agent the way `runs.subscribe` has one. This
  is deliberately stricter: frames on this surface ARE page screenshots,
  and the input methods drive a logged-in browser, so admitting an agent
  would hand it both perception and actuation outside the `full_access`
  `browse_*` tool tier, and would let it read the page during the very
  privacy blackout that exists to keep it out. Agents browse through
  their tools; this surface belongs to the person. `browser.producer.*`
  (the agent publishing its own browser) is the mirror-image gate —
  agent-session only, and an agent may claim only the conversation it is
  actually serving — so the two authorization domains never overlap: a
  connection is either the human's host client or a supervised agent's
  session, never both, and neither can do the other's job.
- **A view outlives the run that created it.** Ending a run hands the
  browser back to the user (`owner` becomes `"none"`, every control
  accepts input with no Take-control click) — **unless the user was
  already holding control**, in which case ownership and the privacy
  blackout both SURVIVE the run end and clear only on an explicit
  `browser.view.hand_back`, which then lands on `"none"` because there is
  no longer an agent to hand back to. A run ending underneath a person who
  is driving must not silently retract their control or resume feeding
  frames to a recording mid-window — nor take the page away from them: the
  holder keeps control, and keeps being able to type into it, until they
  hand back. **Every AGENT-side ending is settled by whether anyone engaged
  with the browser** — a sign-in timing out, the run ending, the turn being
  aborted. The agent is unblocked with the same result either way.
  If nobody took control and nobody drove the browser during that window, the
  strip clears and the blackout lifts — there is no person to protect, and
  nothing that could ever settle it otherwise on a one-shot CLI run. If someone
  DID engage, the strip and the blackout persist until a signal from the
  PERSON: hand-back, or the grace period expiring after their connection went
  away, each of which resolves it honestly as `signed_in: false`. A timer
  expiring is not evidence the person finished, and neither is a turn ending;
  the ordinary sign-in flow never involves Take control (the strip is the
  affordance), so ownership alone cannot answer the question, and page input
  counts as engagement too. In that state `owner` reads `"none"` — the run
  really did end — while `pending_signin` and `blackout_active` stay set, and
  the drawer's strip offers hand-back rather than Take control (there is no
  agent to take control from). The grace clock for it starts when the LAST
  connection watching that view goes away, and is cancelled if a drawer comes
  back inside the window. **The blackout also stops an observation that is
  already in flight**: a browse tool running when it starts is cancelled and its result
  discarded rather than returned, because a result computed from the page
  the person just took over is exactly the observation the blackout exists
  to prevent — the agent is told to wait and retry. `browser_await_signin`
  likewise stops reading the page (and stops naming it in its timeout) for
  as long as the user holds control. A pending sign-in somebody engaged with
  is likewise not settled by the run ending; hand-back settles it, honestly, as
  `signed_in: false`. **A run ending also STOPS any recording that run
  started**, finalizing the artifact with the frames captured up to run-end:
  the browser is deliberately not torn down at run end and the person keeps
  driving the page, so a recording the agent never stopped would otherwise
  write their own browsing to disk. The model still gets its video — a later
  `browser_record_stop` encodes exactly those frames — it simply ends where
  the run did. Ending a run does **not** unregister
  a view somebody is subscribed to — the drawer keeps showing the last page
  exactly as the agent left it, and agent-opened tabs stay usable.
  **Replacement, not run end,
  is the lifetime bound**: a *new* run for the same conversation key
  replaces the previous view and releases the previous browser (one live
  Chromium per conversation that has actually browsed, not per run).
  **For a supervised agent, "the same key" is weaker than it sounds** —
  `agents.chat`'s `session_id` is minted fresh per TURN, so a process
  registers a new key each time and would accumulate one view (and one
  conversation binding) per turn it ever served. A `browser.producer.register`
  therefore also RETIRES that producer's oldest views, keeping the most recent
  eight: the same number the agent process itself re-publishes, so nothing
  reachable is retired and nothing retired is reachable. A retired view that a
  drawer is still subscribed to is kept — retiring marks it releasable, it does
  not take it away from a watcher. A
  finished run's view that **nobody is subscribed to** is released instead
  of waiting for a replacement that may never come: a producer keyed per
  run rather than per conversation (the in-daemon `assistant_start` path
  mints `mcp-run-<uuid>`) never registers the same key twice, so the
  replacement bound is unreachable for it and each browsing run would
  otherwise leave an idle Chromium behind for the daemon's lifetime. Both
  halves of that condition matter: a live run's browser is never released,
  and neither is one a drawer is watching. The
  replacement hands the drawer over rather than resetting it — the new
  view inherits the previous view's subscribers **and its event cursor**,
  then emits one presentation event carrying the new browser's state, so
  a subscriber follows its conversation to the new browser without
  re-subscribing and the cursor **never moves backwards** (a decreasing
  cursor is uninterpretable to a gap-detecting client, which is strictly
  worse than the gap it already knows how to handle).
- **Control is held by a CONNECTION, and take/hand-back are gated on it too.**
  `browser.view.take_control` records the calling connection; the input
  methods, `browser.view.take_control` and `browser.view.hand_back` all
  accept only that connection —
  or any authorized connection when nobody holds it, which is the state
  after a holder disconnects (cleared immediately, since that connection
  is provably gone) and after a run ends with no user driving. A client
  that reconnects therefore gets a new `client_id` and can still drive and
  hand back; a *second* live connection cannot take control from the holder,
  and therefore cannot revert the browser to the agent underneath the person
  who took it. **A pending sign-in relaxes this for the AGENT's browser only.**
  It admits any authorized connection while `owner` is still the agent —
  that is what lets a person type credentials without pressing Take control —
  and it does NOT survive someone taking control: `take_control` leaves the
  sign-in pending, and from then on input answers to the holder like every
  other input, so a second connection cannot interleave into the field. `take_control` records a holder only when the transition
  actually moved ownership — on the standing session, where no agent holds
  the browser, it is a no-op and leaves the holder unset.
- **The tab strip lists the tabs CAR opened, not every tab Chromium has.**
  `presentation.tabs` mirrors the runtime's own tab registry, which is
  populated by launch and by `browser.view.tab_open` / the agent's own tab
  tools. A target Chromium creates on its own — a `window.open`, a
  `target="_blank"` link, a popup — is not in it, so it does not appear in
  the strip and cannot be selected; likewise a tab closed from inside the
  page is not removed. CAR keeps driving, capturing and reporting the tab it
  knows, which is the correct page for everything the agent does, but a
  popup the page opened is invisible to the drawer. Reconciling against
  `Target.targetCreated` / `targetDestroyed` is not implemented; treat the
  strip as "CAR's tabs", not "Chromium's tabs".
- **History navigation is a server-side op, not a keystroke.** The nav
  bar's Back, Forward and Reload are `browser.view.back` /
  `browser.view.forward` / `browser.view.reload` — no params, acting on
  the active tab's own history. A client MUST NOT synthesise them as
  ⌘←/⌘→ keypresses: those shortcuts are browser chrome, the CDP input
  domain reaches only the page, and the injected keystroke lands in
  whatever the page focuses instead of moving history — the failure is
  silent, which is why this is a contract line rather than a footnote.
  Whether each is available is already on the wire
  (`presentation.tabs[].can_go_back` / `can_go_forward`), so a nav bar
  disables its buttons from the snapshot it already has; calling one
  anyway answers `no page to go back to` / `no page to go forward to`
  rather than hanging or succeeding silently.
- **One Chromium profile per purpose, with an ephemeral fallback.**
  Chromium allows exactly ONE live instance per `--user-data-dir`; a
  second launch on the same directory does not degrade, it dies with
  `SingletonLock: File exists`. Two CAR browsers wanting persistence at
  once is ordinary — two agents in two conversations, or an agent while
  the person uses the drawer — so the purposes have separate
  directories: agent browsers use `~/.car/browser-profile` (unchanged),
  the standing session uses `~/.car/browser-profile-user`, and its
  sign-ins persist independently. `browser.run` and the `car browse` CLI
  keep NO persistent profile at all and stay fully independent
  browsers. When the same directory is genuinely wanted twice, the later
  launch **falls back to a throwaway per-instance profile and logs a
  warning** rather than failing: that browser works but **starts signed
  out**, and a sign-in performed in it does not persist. That holds in
  both shapes it takes. Within one daemon — two in-daemon assistant
  runs — an in-process claim registry catches it before launching. Across
  processes — **two supervised agent processes, which is the shape the
  shipped topology actually produces**, since each `car do --serve`
  derives the same `$CAR_HOME/browser-profile` and no in-process registry
  can see another process — the launch is attempted, Chromium reports
  `SingletonLock: File exists`, and the backend relaunches once against a
  throwaway directory. Deliberately no lock file: Chromium already reports
  the collision precisely, and a lock's post-crash staleness is a worse
  failure mode. `browser.run`, the FFI browser sessions and `car browse`
  pass no profile at all, so they collide with nothing — unless the
  operator has set `CAR_BROWSER_PROFILE_DIR`, which points every browser
  that does not name its own directory at the same one. **That variable
  still relocates the assistant and standing-session browsers too**: when
  it is set, they pass no explicit directory, so car-browser's own
  resolution (`explicit → CAR_BROWSER_PROFILE_DIR → ephemeral`) reaches it
  and the operator's choice wins — the per-purpose directories above are
  the DEFAULT, not an override. Pointing both at one directory is then the
  operator's own call, and the SingletonLock fallback above covers the
  collision it implies. CAR code never *writes* that variable, which is
  process-global and would repoint every other browser in the daemon.
- **The headless flip needs a surface that can actually SHOW this browser.**
  An agent browser launches headless when a host client is connected, because
  the drawer is then its face. That reasoning only holds for a browser the
  drawer can reach: a run whose view is registered under a key no client can
  subscribe to has no surface at all, so it launches HEADED regardless of host
  connectivity. In-daemon `assistant_start` runs are exactly that case today —
  their view key is the run's own `mcp-run-<uuid>`, and the drawer subscribes
  only to `agents.chat` session ids or the standing session. `CAR_BROWSER_HEADLESS`
  still overrides in either direction.
- **A finished run's browser is released when the last watcher leaves,
  however it leaves.** Closing the drawer or switching conversations is an
  ordinary `browser.view.unsubscribe` over a live socket, not a disconnect, and
  it releases a run-ended view just as a disconnect does. A relayed view is
  released on the same condition when its agent process goes away: unwatched
  views for a dead producer are dropped (with the producer and its socket),
  while a view a drawer is still subscribed to stays registered so a restarted
  process can replace it in place.
- **A supervised process is TOLD when the host comes and goes.** It has
  no read of the daemon's session set, so it caches host connectivity —
  and that cached answer decides whether `browser_await_signin` returns
  the "open the CAR app" result or waits out its full timeout in front of
  a drawer that is not there. The daemon pushes
  `agent.browser.host_connected { connected }` on every transition it
  observes; a producer must apply it rather than relying on the next
  `browser.producer.register` ack, which is only refreshed per turn.
- **Frames are dropped, never queued without limit, at every hop.** A
  full-viewport JPEG per frame is enough that an unbounded buffer in front of
  any consumer slower than Chrome is a real leak, so each hop is bounded and
  drops rather than stalling: the capture pump's per-consumer buffer, the
  agent process's frame push (newest-wins), and the daemon's per-subscriber
  fan-out channel. The pump never blocks on a slow consumer, because the CDP
  ack it would delay is shared by every OTHER consumer. For a recording this
  degrades smoothly rather than corrupting: durations come from real arrival
  timestamps, so a dropped frame extends the previous frame's duration and a
  slow disk simply yields a lower frame rate.
- **A slow subscriber loses events, not its subscription.** The documented
  failure mode for a full per-subscriber channel is to **drop the event**
  and leave the subscriber registered — it recovers the ordinary way, by
  detecting the cursor gap and re-subscribing for a fresh snapshot. It is
  not evicted. Treat "the daemon silently unsubscribes a slow client" as a
  bug report, not this surface's behavior.

## Supervised-agent browsers (`browser.producer.*` / `agent.browser.*`)

The Command Deck's CAR Chat runs through a **supervised agent process**
(`car do --serve`), not an in-daemon runtime — so its browser lives in a
different process than the daemon that serves `browser.view.*`. This
namespace is the relay that makes the drawer work anyway: the process
publishes its browser as a producer, and the daemon relays input/control
calls to it over the same persistent WS session `agents.chat` already
uses. Above the relay seam nothing differs — `browser.view.*`'s fanout,
cursors, snapshots, control machine, and blackout serve a relayed browser
identically to a daemon-local one, error strings included (the two ends
share one Rust implementation of the input/control logic). Two properties
here are **ruled for v1, not gaps**:

- **One browser per agent process, shared by that agent's conversations.**
  A supervised process builds one runtime and multiplexes every chat
  session it serves through it, so it has exactly one browser. Two
  conversations served by the SAME agent process therefore show the
  *same* browser in the drawer — that is not cross-conversation leakage,
  it is what "one browser" means for v1. Two conversations served by
  *different* agent processes are fully isolated (different processes,
  different browsers, and neither can see the other's pushes or issue the
  other's input) — that isolation is enforced and tested. Splitting one
  process's browser per-conversation is a real capability, and a real
  restructure of the assistant runtime's delegate chain; it is future
  work, not something a v1 consumer should assume already happened.
- **A conversation has no view until its first agent turn, and a full
  daemon restart clears the claim bindings that make between-turn
  recovery work.** `browser.producer.register` needs either a live chat
  turn for the calling agent or a binding it already established on an
  earlier turn — so a fresh conversation with no turn yet, and every
  conversation right after a daemon restart (bindings are in-memory,
  cleared with everything else), both resolve `browser.view.subscribe` as
  the ordinary unknown-conversation error. **The correct client behavior
  is not an error state**: fall back to rendering the standing session,
  and re-subscribe when the conversation's next turn starts (there is no
  push that announces a view coming into existence — the turn start is
  the client's own signal to try again). This is the same recovery shape
  as an ordinary cursor gap: the fix is always "ask again", never "treat
  this as broken".

## Daemon-restart and reconnection contract

`DaemonClient` (Rust, behind NAPI/PyO3) does **not** auto-reconnect on its
own. The connection is lazy and per-call:

- The client connects on the first `call()` and keeps the WS open across
  subsequent calls.
- On a send or recv error (including a daemon restart that closes the
  socket), the recv loop ends. `DaemonClient::reset()` clears the
  connection state and **drops every pending oneshot waiter** — in-flight
  calls return a clear `daemon connection at … closed before response`
  error.
- The next `call()` lazy-reconnects from scratch. There is no automatic
  retry of the failed call — the caller decides whether to retry, surface
  the error, or apply its own backoff.
- Notification handlers and server-request handlers (`register_handler`,
  `register_notification_handler`) **persist across reconnects**. The new
  recv loop picks them up from the same `Arc<HashMap>` registries — agents
  do not need to re-register after a daemon restart.

Lifecycle agents that need to survive a daemon restart should:

- Build a thin retry loop around `call()` for idempotent methods. Daemon
  restarts are rare (LaunchAgent / systemd respawn), so a simple
  exponential backoff with a jitter and a small bounded retry count is
  enough.
- For non-idempotent methods (anything that mutates daemon-side state),
  surface the error to the caller — the agent has to decide whether the
  partial work is recoverable.
- For long-lived subscriptions (notification streams), the drain task in
  the streaming section above doubles as the reconnect detector: when the
  channel goes idle for longer than expected and the next upstream `call()`
  errors with a connect-or-closed message, re-issue the
  `inference.stream.start` (or whatever subscribe call) to resume.

The "single-source-of-truth" framing applies here too — assume the daemon
is the authority on what's in flight and treat the agent's local view as
something that must be reconciled when the connection resumes.
