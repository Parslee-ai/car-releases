{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### host

The `host.*` namespace is the OS-integration surface — terminal/tray clients use it to provide a unified UI across multiple agents. See also [`docs/host-protocol.md`](../host-protocol.md).

#### `host.subscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: boolean, agents: HostAgent[], devices: HostDevice[], approvals: HostApproval[], events: HostEvent[], pending_signins: { conversation_id: string, standing_session: boolean, message: string }[], event_sequence: number, identity?: HostIdentity }`
- Registers the connection to receive `host.event` notifications. Returns the current snapshot.
- **Who sees which records (#3419).** A session bound to a supervised agent (`session.auth { agent_id, token }`, or an outside credential acting as one) is subscribed to its own records only: the snapshot's `agents`, `approvals` and `events` hold only what is attributed to that agent (`approvals` also keeps a row its own connection raised), and the later `host.event` broadcasts it receives are only those whose `agent_id` is its own, plus the `approval.resolve_requested` fan-out for an approval its connection owns. `devices`, `pending_signins` and `identity` are unchanged. On macOS and Windows, an agent the host granted the watcher view (`agent_permissions.set_observer`) gets every record, as host sessions, the daemon-token operator and the CLI always do; its snapshot `agents` holds every registered agent too. Granting or withdrawing through `agent_permissions.set_observer` re-scopes a subscription that is already open; the snapshot already returned is not re-sent, so call `host.subscribe` again for it. A grant changed by another process (a hand edit of `agent-permissions.json`) applies to an open subscription only when it subscribes again. On Linux a walled agent cannot call this method at all, so for a walled agent the grant changes nothing there (CAR's own assistant runs unwalled and is scoped like any agent).
- **`identity` (added 2026-05)**: daemon-identifying metadata so hosts that connect to multiple daemons (e.g. one supervised by CarHost.app plus an ad-hoc `cargo run -p car-server` dev/eval daemon on a different port) can tell which one they're on and whether it's the supervisor lock owner.
  - `version` — `CARGO_PKG_VERSION` of the daemon binary
  - `pid` — daemon process id
  - `manifest_path` — absolute path to the agents manifest this daemon supervises or observes; `null` when no manifest is configured (HOME unset; embedder didn't install one)
  - `manifest_role` — exactly one of the lower-case strings `"owner"`, `"observer"`, or `"none"`. `"owner"` = this daemon holds the manifest's exclusive `<manifest>.lock`; `"observer"` = another `car-server` on the host owns it and this daemon runs in observe-only mode (Parslee-ai/car-releases#44); `"none"` = no manifest is configured
- Snapshot once on subscribe — these fields are stable for the daemon's lifetime (a manifest-role change requires a daemon restart, which would close this WS anyway), so they're not republished as events.

#### `host.agents`
- **Params**: `{}`
- **Returns**: `HostAgent[]` — agents explicitly registered into host state (callback clients via `host.register_agent`, multi-agent runners), **merged** with any registry-supervised agent that advertises `capabilities` (e.g. the flagship assistant, `parslee-core`, with `["chat"]`) and in-daemon declarative agents (tagged `kind:"declarative"` with `capabilities:["chat"]`). Supervised agents attach via `session.auth { agent_id }` and don't register into host state, so their `AgentSpec.capabilities` are read from the supervisor at request time (status/pid reflect the live supervisor; an explicit registration for the same id wins). This lets a host show a Chat tab by checking `capabilities.contains("chat")`.
- **Who sees which rows.** A session bound to a supervised agent (`session.auth { agent_id, token }`) gets only the row whose `id` is its own, on every platform. That holds for an agent with the watcher grant too: `agent_permissions.set_observer` covers `host.approvals`, `host.events` and `host.subscribe`, not this method. Host sessions, the daemon-token operator and the CLI get every row.

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
  `token` is the current per-launch auth token when auth is enabled **and the
  caller holds host authority**. A session bound to a supervised agent, and any
  unbound client on a daemon that has a host token but did not authenticate with
  it, gets the response without `token`, as does every session on a daemon
  with no host token, which has no host.
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
- **Who sees which events (#3419).** An agent-bound session gets only the events whose `agent_id` is its own (an unattributed event such as `device.*` is not its own), and `limit` counts those, so it gets its own newest `limit` rather than its share of everyone's. On macOS and Windows, an agent the host granted the watcher view (`agent_permissions.set_observer`) gets every event, as host sessions, the daemon-token operator and the CLI do. On Linux a walled agent cannot call this method at all, so for a walled agent the grant changes nothing there (CAR's own assistant runs unwalled and is scoped like any agent).

#### `host.approvals`
- **Params**: `{}`
- **Returns**: `{ approvals: HostApproval[] }`
- Resolved rows created more than 24 hours ago are dropped when the ledger is read. When an approval is created, every row older than 24 hours is dropped, pending ones included, unless a high-risk-method gate is still waiting on the row; no event is sent for a pending row dropped that way. Resolved rows stay until then, or until `host.dismiss_approval` removes them.
- **Who sees which approvals (#3419).** An agent-bound session gets only the approvals raised for it (`agent_id` is its own) or by its own connection, so another agent's `details.params_preview` never reaches it. The approval the high-risk-method gate raises for an agent's own call is attributed to that agent, so it stays visible here. On macOS and Windows, an agent the host granted the watcher view (`agent_permissions.set_observer`) gets every approval, as host sessions, the daemon-token operator and the CLI do. On Linux a walled agent cannot call this method at all, so for a walled agent the grant changes nothing there (CAR's own assistant runs unwalled and is scoped like any agent).

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
- **Params**: `CreateHostApprovalRequest` — `{ agent_id?: string, action: string, details?: object, options?: string[], system_level?: boolean, a2ui?: { components: object[], dataModel?: object } }`
- **Returns**: `HostApproval & { subscribed: boolean, answerable: boolean }`
- `subscribed` is literal: whether the requesting session is subscribed to host
  events (the same meaning as `host.subscribe`'s `subscribed`). An unsubscribed
  session receives neither `approval.resolve_requested` nor
  `approval.resolved`, whatever kind of row it raised.
- `answerable` says whether a host's decision can take effect. It is `true` for
  a `system_level` row, which a host resolves in the ledger directly, and for a
  session-owned row whose session is subscribed. It is `false` for a
  session-owned row from a session that never completed `server.handshake` +
  `host.subscribe`: a host's answer to that row is an
  `approval.resolve_requested` the session will never receive, so the row stays
  pending and a host trying to resolve it gets `owner_not_connected`. The daemon
  logs a warning for that case. A `system_level` row from an unsubscribed
  session (`subscribed: false, answerable: true`) can be decided, but the
  requester will not hear `approval.resolved`: it has to poll `host.approvals`
  to learn the outcome. The row is created in every case. Subscribe first, and
  set `system_level`.
- `action` is **required**: the one-line summary every approval surface shows.
  `details` is the structured payload surfaces render underneath it (the macOS
  dashboard as typed fields, the Windows tray and the iMessage/Slack prompts via
  `car_proto::approval_summary`); for a gate-raised row it is
  `{ method, params_preview }`, and for a row mirrored from Chat it is exactly
  `{ source: "chat", session_id, agent_id, tool, target, deadline, params_preview }`,
  which surfaces render as tool / target / parameters (never `session_id`). An
  agent can instead name its payload with `details.kind`, which the macOS host
  renders as typed fields: `message_send` takes `{ text, target: { counterpart?,
  chatName?, id?, service? }, sourceEmail?: { sender?, subject?, receivedAt?,
  accountName? } }` and shows the recipient, the message and the email it
  answers; `message_send` may add `summary`, the agent's reason for the text, shown as
  Why; `email_reply` takes `{ to, cc?, subject, body, from? }`; `human_request`
  takes `{ question, context?, options?, approveMeans?, requester? }` and shows
  the question and what Approve answers. Any other
  `kind` gets the generic rendering. A
  row that claims `source: "chat"` while carrying any other key, or lacks
  `session_id`/`tool`, gets the generic rendering. `action` and every
  parameter name and value are agent-authored, so surfaces show each without
  its line breaks: collapsed to one line, or kept inside a labelled block of
  its own. On macOS the generic rendering is never JSON: each field is a
  labelled row, with nested objects flattened into their parents' labels. A
  line break in agent text can't add a line that looks like a field the
  surface wrote. The text summary also prints a parameter's name quoted
  (`"path": /etc/hosts`), so a parameter named `Agent` can't pass for the
  renderer's own `Agent:` line. Bidirectional control characters are dropped
  from those lines, and Slack receives agent text with `&`, `<` and `>`
  escaped, so it can't open a link or a mention. The iOS and Android cards
  read Risk and Reason only from the top level of `details`, never from
  `params_preview`. `options` defaults to `["approve", "deny"]`.
- `a2ui` draws the approval as an A2UI v0.9 component tree, for a host that
  renders A2UI (CarHost on macOS). The host shows it under its own header and
  its own Approve and Deny controls. The daemon checks it with
  `car_a2ui::approval_surface` and refuses the whole request if it fails:
  every component needs an `id`, one must be `root`, and only display
  components are allowed (`Text`, `Row`, `Column`, `List`, `Card`, `Divider`,
  `Image`, `Icon`, `Chart`, `Spacer`, `Badge`), at most 64 KiB. Anything that
  takes input, plus `Tabs` and `Modal`, is refused, because an agent-drawn
  Approve button would be a forged control on the card where a click is a
  decision. The stored row's `a2ui` is the checked `A2uiSurface`
  (`surfaceId: "approval"`), not the request as sent. `action` and `details`
  stay required context: the Windows tray, iOS and Android, and the iMessage
  and Slack prompts show those, not the tree. When a row has both `a2ui` and a
  `details.kind` layout, CarHost shows `a2ui`.
- `system_level: true` opts the row out of per-session ownership so any
  authenticated session (typically CarHost or `car-host approve`) can resolve it.
  Agents requesting user approval should always set it: such a row is the
  person's decision, and the requesting agent itself is refused if it tries to
  resolve it (#3453). Session-owned (the default) is the agent's own record,
  resolved by the requesting connection; a host that resolves it only forwards
  the decision to that connection as `approval.resolve_requested` (the host
  gets the row back still `pending`). If that connection is not currently
  subscribed, the host instead gets the error `approval '<id>' is owned by
  session '<owner>' which is not currently connected`.
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
- **Returns**: the `HostApproval` row, resolved with the `resolution` sent.
  `status: "pending"` means the request was forwarded to the owning session,
  whose own resolve settles the row and broadcasts `approval.resolved`.
- **Errors** (`-32003`, with a stable `error.data.reason`):
  - `already_resolved`: the row was no longer pending. Another decision won,
    or the daemon closed it as `agent_gone` when the session that raised it
    disconnected. Nothing was changed: the first resolution stands.
    `error.data` is `{ reason, approval_id, resolution, resolved_at, approval }`,
    where `resolution` is the one that stands and `approval` is the row as it
    is. Daemons before this change answered this case with a success carrying
    that row, so a client that supports both compares the returned row's
    `resolution` with the one it sent. A walled agent never gets this for a
    gate row or for a system-level row attributed to itself: the walled
    refusal below is checked first, so it gets the plain walled error and
    never the row.
  - `owner_not_connected`: the row is owned by a session that is not
    subscribed to host events, so nothing can deliver the request to it.
    `error.data` is `{ reason, approval_id, owner_client_id }`. The message
    still reads "… is owned by session '…' which is not currently connected".
- `resolution` is the **verb**, matched against the row's `options` (default
  `["approve", "deny"]`); the gate treats anything other than its approve label
  as a denial. Both fields are required.
- **A supervised agent cannot answer the person's approvals (#3453).** A
  session walled to an agent (`session.auth { agent_id, token }`, or an outside
  credential acting as one) gets a plain error (no `error.data.reason`), and the
  row is left as it is (pending, or as already decided), for:
  - a row the dispatcher's high-risk-method gate raised (system-level, `action`
    `ws.method:<method>`), whether the parked call is its own agent's or
    another agent's;
  - a system-level row attributed to itself (one it raised with
    `system_level: true`): it asked the person, so it does not answer.

  Each refusal is recorded as an `approval.resolve_refused` event and a daemon
  warning. This holds on every platform; on Linux a walled agent is refused the
  method outright (`agent_default_deny`). Host sessions, the daemon-token
  operator, the `car-host` CLI and the paired approval transports resolve these
  rows as before.

  Only system-level approvals, gate rows among them, are the human gate. A
  **session-owned** approval (raised with `system_level: false`) is the
  agent's own record, not a human gate, and no CAR gate waits on it. Its owning connection may resolve it,
  agent or not: that is how an agent records a decision the person made in the
  agent's own UI, and how it completes a decision a host forwarded to it as
  `approval.resolve_requested`.

> Earlier revisions documented the params as
> `{ approval_id, approved: boolean, notes? }`. There is no `approved` or
> `notes` field — a payload in that shape is rejected, because `resolution` is
> required and has no default. The gate description above this section has always
> described the real contract ("waiting for `host.resolve_approval` to land with
> `resolution: \"approve\"`").

#### `host.dismiss_approval`
- **Params**: `{ approval_id: string }`
- **Returns**: `{ dismissed: true, approval: HostApproval }`, the row removed.
- **Role**: `agent`: every supervised agent may call it, walled ones on Linux
  included, because it is scoped in the handler. A session bound to a
  supervised agent may remove only a resolved row raised for that agent; the
  watcher grant does not widen this. The agent identity is the same one
  `host.resolve_approval` walls on, so a `session.auth` rebind in progress on
  the connection does not lift the restriction. Outside credential sessions cannot call
  any `host.*` method, this one included. A host client, the daemon-token
  operator and the CLI may remove any resolved row.
- Removes a resolved row from `host.approvals`, such as one the daemon closed
  as `agent_gone` after the agent's session dropped. No event is broadcast: the
  row's `approval.resolved` already told every host to drop it.
- **Errors** (`-32003`, `error.data.reason`): `approval_pending` (a pending row
  is answered, not dismissed), `not_your_approval` (raised for another agent,
  or for none), `lattice_mirror` (a Lattice review mirror whose review is
  still unanswered in the Lattice ledger: undecided, or decided on an approval
  channel and not yet folded in, which the daemon does within about two
  seconds; once the ledger records the answer, the row can be dismissed), `unknown_approval`.

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
`kind` values: `agent.registered`, `agent.unregistered`, `agent.status_changed`, `approval.requested`, `approval.resolved`, `approval.resolve_requested`, `approval.self_resolved`, `approval.resolve_refused`, `host.notification`, `device.registered`, `device.updated`, `browser.signin_needed`, `browser.signin_resolved`, `spend.changed` (a principal entered or left "at budget" on its spend caps; payload in [spend](spend.md#spend)), `agent.scheduled_run_refused` (a declarative agent's scheduled run was refused for want of host authority, as on a daemon with no host token; payload `{ scheduled_for, reason }` — see [declagents](declagents.md)), `memory.shared_graph.replaced` (a deliberate `memory.load { replace: true }` replaced the daemon-wide shared memory graph; `agent_id` is null, payload `{ path, records, client_id, host, operator }` — see [memory](memory.md)).

`approval.self_resolved` fires when the agent an approval was raised for is the
one that resolved it — the requester approving its own request. Payload:
`{ approval_id, agent_id, action, resolution }`. It is emitted alongside
`approval.resolved`, not instead of it: the resolution **is** applied. A
supervised agent is refused on a high-risk gate row and on a system-level row
it raised (see `approval.resolve_refused`), so for a walled agent this event
now means it resolved its own session-owned row. It still fires for a session
bound to the agent that is not walled. If you see it on a row meant for the
person, something is approving its own work.

`approval.resolve_refused` fires when a supervised agent's `host.resolve_approval`
is refused. It is attributed to the refused agent. Payload:
`{ approval_id, agent_id, client_id, resolution, reason }`, where `agent_id` is
the refused agent, `client_id` its connection, and `reason` is `"gate_row"` (a
high-risk gate row, anyone's) or `"own_system_row"` (a system-level row it
raised). The row is not touched and no `approval.resolved` follows.

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
