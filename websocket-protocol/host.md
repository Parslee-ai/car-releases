{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### host

The `host.*` namespace is the OS-integration surface — terminal/tray clients use it to provide a unified UI across multiple agents. See also [`docs/host-protocol.md`](../host-protocol.md).

#### `host.subscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: boolean, agents: HostAgent[], devices: HostDevice[], approvals: HostApproval[], events: HostEvent[], pending_signins: { conversation_id: string, standing_session: boolean, message: string }[], event_sequence: number, identity?: HostIdentity }`
- Registers the connection to receive `host.event` notifications. Returns the current snapshot.
- **`identity` (added 2026-05)**: daemon-identifying metadata so hosts that connect to multiple daemons (e.g. one supervised by CarHost.app plus an ad-hoc `cargo run -p car-server` dev/eval daemon on a different port) can tell which one they're on and whether it's the supervisor lock owner.
  - `version` — `CARGO_PKG_VERSION` of the daemon binary
  - `pid` — daemon process id
  - `manifest_path` — absolute path to the agents manifest this daemon supervises or observes; `null` when no manifest is configured (HOME unset; embedder didn't install one)
  - `manifest_role` — exactly one of the lower-case strings `"owner"`, `"observer"`, or `"none"`. `"owner"` = this daemon holds the manifest's exclusive `<manifest>.lock`; `"observer"` = another `car-server` on the host owns it and this daemon runs in observe-only mode (Parslee-ai/car-releases#44); `"none"` = no manifest is configured
- Snapshot once on subscribe — these fields are stable for the daemon's lifetime (a manifest-role change requires a daemon restart, which would close this WS anyway), so they're not republished as events.

#### `host.agents`
- **Params**: `{}`
- **Returns**: `HostAgent[]` — agents explicitly registered into host state (callback clients via `host.register_agent`, multi-agent runners), **merged** with any registry-supervised agent that advertises `capabilities` (e.g. the flagship assistant, `parslee-core`, with `["chat"]`) and in-daemon declarative agents (tagged `kind:"declarative"` with `capabilities:["chat"]`). Supervised agents attach via `session.auth { agent_id }` and don't register into host state, so their `AgentSpec.capabilities` are read from the supervisor at request time (status/pid reflect the live supervisor; an explicit registration for the same id wins). This lets a host show a Chat tab by checking `capabilities.contains("chat")`.

#### `host.devices`
- **Params**: `{}`
- **Returns**: `HostDevice[]` — native host apps currently linked to the daemon.
  `HostDevice` is status and capability metadata: `{ id, name, platform,
  capabilities, status, session_id?, updated_at, metadata }`. It is not a raw
  remote-exec or sensor-invoke surface; privacy-heavy phone capabilities still
  require dedicated, policy-gated RPCs.
- Parslee Core exposes this same read-only roster through its `linked_devices`
  tool when it is running as the supervised flagship assistant (agent id
  `parslee-core`; `car-assistant` is accepted as a server-side compatibility
  alias for pre-car#1107 clients), so the assistant can reason about the
  user's phone/tablet surfaces without gaining access to contacts, location,
  photos, microphone, or other private device data.
- With full-access approval, Parslee Core can also call `notify_linked_device`
  for a device that advertises `notifications.deliver`. That path sends only a
  title/body notification through `host.notify`; it is not contacts, location,
  photos, microphone, files, or arbitrary phone control.

#### `mobile.runtime`
- **Params**: `{}`
- **Returns**: `{ name: "Parslee Core", source: "car", url, token? }`.
- Returns the internal runtime payload Parslee can use after account sign-in to
  connect a consumer mobile app to this CAR runtime. `url` is the daemon
  WebSocket URL from `CAR_MOBILE_RUNTIME_URL` or the daemon bind address, and
  `token` is the current per-launch auth token when auth is enabled.
- This method is protected by the normal `session.auth` gate. It does not grant
  host-management authority and does not expose the host token.
- For a phone off the local network, run CAR behind a reachable `wss://` relay
  or reverse proxy and set `CAR_MOBILE_RUNTIME_URL` before starting
  `car-server`. Parslee cloud mobile discovery returns the same shape under
  its `/mobile/runtimes` endpoints.
- When the daemon is signed in to Parslee and `CAR_MOBILE_RUNTIME_URL`
  is explicitly set, `car-server` best-effort registers this connection with
  Parslee at startup via `POST /mobile/runtimes`. Registration failure is logged
  but does not block local CAR startup.

#### `host.register_device`
- **Params**: `{ id?: string, name: string, platform: string, capabilities?: string[], status?: string, metadata?: object }`
- **Returns**: registered `HostDevice`.
- Ownership follows the registering WebSocket session. Re-registering the same
  `id` from the same session updates the row; another session cannot overwrite
  it.

#### `host.update_device`
- **Params**: `{ device_id: string, name?: string, platform?: string, capabilities?: string[], status?: string, metadata?: object }`
- **Returns**: updated `HostDevice`.
- Broadcasts a `device.updated` host event to subscribers. Only the owning
  session can update its device row.

#### `host.events`
- **Params**: `{ limit?: number = 100 }`
- **Returns**: `{ events: HostEvent[] }`

#### `host.approvals`
- **Params**: `{}`
- **Returns**: `{ approvals: HostApproval[] }`

#### `host.register_agent`
- **Params**: `{ id?: string, name: string, kind: string, capabilities?: string[], project?: string, pid?: number, display?: object, metadata?: object }`
- **Returns**: registered `HostAgent` (with assigned `id` if not provided)

#### `host.unregister_agent`
- **Params**: `{ agent_id: string }`
- **Returns**: `{ ok: boolean }`

#### `host.set_status`
- **Params**: `{ agent_id: string, status: "idle"|"running"|"waiting_for_approval"|"paused"|"completed"|"errored"|"stopped", current_task?: string, message?: string, payload?: object }`
- **Returns**: updated `HostAgent`
- Broadcasts an `agent.status_changed` event to subscribers.

#### `host.notify`
- **Params**: `{ kind?: string = "host.notification", agent_id?: string, message?: string, payload?: object }`
- **Returns**: the recorded `HostEvent`
- Native hosts may honor `payload.target_device_id` to ignore notifications
  intended for another linked device.

#### `host.request_approval`
- **Params**: `CreateHostApprovalRequest` — `{ agent_id?: string, action: string, details?: object, options?: string[], system_level?: boolean }`
- **Returns**: `HostApproval`
- `action` is **required**: the one-line summary every approval surface shows.
  `details` is the structured payload surfaces render underneath it (the macOS
  dashboard as typed fields, the Windows tray and the iMessage/Slack prompts via
  `car_proto::approval_summary`); for a gate-raised row it is
  `{ method, params_preview }`, and for a row mirrored from Chat it is exactly
  `{ source: "chat", session_id, agent_id, tool, target, deadline, params_preview }`,
  which surfaces render as tool / target / parameters (never `session_id`); a
  row that claims `source: "chat"` while carrying any other key, or lacks
  `session_id`/`tool`, gets the generic rendering. `options` defaults to
  `["approve", "deny"]`.
- `system_level: true` opts the row out of per-session ownership so any
  authenticated session (typically CarHost or `car-host approve`) can resolve it.
  Agents requesting user approval should always set it — session-owned is only
  correct when the requesting session is also the resolving session, which
  approval-via-UI never is.
- `agent_id` is **stamped by the server** from the session's authenticated agent
  binding when the session has one, so an agent cannot attribute its request to
  another agent or leave it unattributed; a client with no binding (the operator
  surface) keeps what it sends. When the resulting id names an agent, that
  agent's status auto-flips to `waiting_for_approval`.

> Earlier revisions of this page documented the params as
> `{ agent_id?, title, description?, context?, required_approvals? }`. No such
> fields exist — the handler deserializes `CreateHostApprovalRequest`, and a
> payload in the old shape is rejected because `action` is required.

#### `host.resolve_approval`
- **Params**: `ResolveHostApprovalRequest` — `{ approval_id: string, resolution: string }`
- **Returns**: the `HostApproval` row. `status: "resolved"` with a `resolution`
  different from the one sent means another decision already won (or the
  approval expired), and this request was not applied. `status: "pending"`
  means it was forwarded to the owning session.
- `resolution` is the **verb**, matched against the row's `options` (default
  `["approve", "deny"]`); the gate treats anything other than its approve label
  as a denial. Both fields are required.

> Earlier revisions documented the params as
> `{ approval_id, approved: boolean, notes? }`. There is no `approved` or
> `notes` field — a payload in that shape is rejected, because `resolution` is
> required and has no default. The gate description above this section has always
> described the real contract ("waiting for `host.resolve_approval` to land with
> `resolution: \"approve\"`").

### `host.event`
Broadcast to subscribers after `host.subscribe`.
```json
{
  "jsonrpc": "2.0",
  "method": "host.event",
  "params": {
    "id": "event-...",
    "sequence": 1042,
    "timestamp": "2026-04-25T13:00:00Z",
    "kind": "agent.status_changed",
    "agent_id": "researcher-1",
    "message": "Researcher completed",
    "payload": {}
  }
}
```
`kind` values: `agent.registered`, `agent.unregistered`, `agent.status_changed`, `approval.requested`, `approval.resolved`, `approval.resolve_requested`, `approval.self_resolved`, `host.notification`, `device.registered`, `device.updated`, `browser.signin_needed`, `browser.signin_resolved`.

`approval.self_resolved` fires when the agent an approval was raised for is the
one that resolved it — the requester approving its own request. Payload:
`{ approval_id, agent_id, action, resolution }`. It is emitted alongside
`approval.resolved`, not instead of it: the resolution **is** applied. The
separation of requester from overseer is documented on
`CreateHostApprovalRequest.system_level` but has never been enforced, so this is
the observability half of a warn-then-enforce rollout — a later release refuses
the resolve instead. If you see this event, something is approving its own
work.

For an `approval.requested` created from `agents.chat.event`, the ledger row
uses the chat event's `approval_id` and its `details` include
`{ source: "chat", session_id, deadline? }`, where `deadline` is RFC 3339.
Resolving that row through
`host.resolve_approval` routes the decision to the parked chat gate rather than
only changing ledger state. The agent's matching `approval_resolved` chat event
also resolves the row, covering direct inline decisions and timeouts. When the
parked gate refuses a decision, answering `resolved: false` (the call had
already given up) or with an error, no `approval_resolved` follows: the daemon
closes the row itself as `timeout` or `interrupted` respectively, and
`host.resolve_approval` returns an error ("was not resolved by the parked
gate").

#### `browser.signin_needed` / `browser.signin_resolved`

An agent's browser is blocked waiting for a human sign-in
(`browser_await_signin`, which blocks the agent for up to 1800 s), and then
that wait ended.

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

`browser.signin_resolved` is the same envelope with the summary message
`"The browser sign-in wait ended"`; its payload is only
`{ "conversation_id", "standing_session" }` and omits the prompt `message`.

- `payload.conversation_id` — the browser-view key `browser.view.*` takes.
  The **empty string** is the standing session (that surface's
  `conversation_id: null`). For CAR Chat this is the per-turn `agents.chat`
  `session_id`.
- `payload.standing_session` — `true` iff `conversation_id` is empty.
- `payload.message` — the sign-in prompt the tool composed. Never anything
  read off the page: no title, no live URL, no form contents, no cookies.

**These are on `host.event`, not `browser.view.event`, on purpose.**
`browser.view.*` needs a live per-conversation subscription, so it structurally
cannot reach a client whose drawer is closed or who is watching a different
conversation — which is the whole situation this exists for. `host.event` is
subscribed once per connection, for the whole daemon.

**Transition rule.** Emitted on the pending-sign-in transition only:
`none -> pending` emits `browser.signin_needed`, `pending -> none` emits
`browser.signin_resolved`, and a changed pending prompt emits a fresh
`browser.signin_needed`; unchanged pending and `none -> none` emit nothing. A
supervised agent republishes its presentation on every change and
re-registers every 10 s, so an emitter that fired per push would notify
repeatedly for one sign-in.

Every `needed` is followed by a `resolved` — signed in, handed back, timed out
or run ended when nobody engaged, host gone, grace expired, or the supervised
process dying. One `resolved` does **not** always mean the browser is
unblocked: a supervised process backs several per-turn views, and when the view
that was reporting a wait retires the daemon emits `resolved` for that
`conversation_id` immediately followed by `needed` for a surviving one. Treat
that pair as the wait MOVING — clear the old key and raise the new one, which
falls out of ordinary per-key handling — rather than as an ending. If a person
engaged during the wait, timer expiry and run end deliberately leave it pending
until hand-back or disconnect grace.

On every connection, `host.subscribe.pending_signins` is the authoritative
snapshot of active waits (`conversation_id`, `standing_session`, `message`).
`host.subscribe.event_sequence` is captured before that snapshot is read, and
every live `HostEvent` carries its monotonic `sequence`. Reconcile local
attention against that snapshot after reconnect **one conversation key at a
time**: the snapshot's verdict stands for a key — listed means waiting, omitted
means resolved — unless a live event with a strictly larger `sequence` already
arrived on that socket **for that key**. Do not reject the whole snapshot
because one key raced: the subscriber is registered before the response is
written, so an unrelated conversation's event can legitimately overtake it, and
throwing the snapshot away with it leaves the conversation that is actually
blocked with nothing on screen. Do not clear on the transport drop or depend on
the bounded `events` history.

**Both producers emit.** In-daemon runtimes report the transition at their
control reducer; a supervised agent process's browser has its reducer in that
process, so the daemon derives the transition from
`browser.producer.presentation` (which already carries the pending sign-in and
already flows on every change, ungated by any watcher). No extra agent → daemon
method exists for this, and exactly one of the two paths applies to a given
view, so a sign-in is never announced twice. The standing session never emits:
no agent tool can run against it.


{% endraw %}
