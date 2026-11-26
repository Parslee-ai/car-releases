{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### host

The `host.*` namespace is the OS-integration surface — terminal/tray clients use it to provide a unified UI across multiple agents. See also [`docs/host-protocol.md`](../host-protocol.md).

#### `host.subscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: boolean, agents: HostAgent[], devices: HostDevice[], approvals: HostApproval[], events: HostEvent[], pending_signins: { conversation_id: string, standing_session: boolean, message: string }[], event_sequence: number, identity?: HostIdentity }`
- Registers the connection to receive `host.event` notifications. Returns the current snapshot.
- **Handshake first.** The connection must have completed `server.handshake` (`{"protocol_version":N}`) with a success reply before `host.subscribe`; until then the call is refused with error code `-32005` and a message that starts `protocol handshake required:` and names `server.handshake`.
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
- **Returns**: `HostEvent[]` — a bare array of `{ id, sequence, timestamp, kind, agent_id?, message, payload }`, newest first. There is no `events` envelope: unlike the `host.subscribe` snapshot, whose `events` field holds the newest 50 rows in this same shape and order, this reply is the array itself, so a client reading `result.events` gets nothing.
- **Who sees which events (#3419).** An agent-bound session gets only the events whose `agent_id` is its own (an unattributed event such as `device.*` is not its own), and `limit` counts those, so it gets its own newest `limit` rather than its share of everyone's. On macOS and Windows, an agent the host granted the watcher view (`agent_permissions.set_observer`) gets every event, as host sessions, the daemon-token operator and the CLI do. On Linux a walled agent cannot call this method at all, so for a walled agent the grant changes nothing there (CAR's own assistant runs unwalled and is scoped like any agent).

#### `host.approvals`
- **Params**: `{ pending?: boolean, collaboration?: string }`
- **Returns**: `(HostApproval & { subscribed: boolean, answerable: boolean })[]`;
  with `pending: true`, the person's pending asks (below).
- Without `pending` (or with `pending: false`), newest first: the approvals
  ledger, described in the rest of this section, every row with exactly the
  fields it always had. `collaboration` is read only with `pending`.
- **Every other ask, in the unfiltered list.** For the person's own two
  surfaces (the host client and the signed-in dashboard) the list also holds
  every other ask the pending view lists, with the same `id`, and each of
  those settled in the last 24 hours, in the ledger row's shape: `action` is
  the question, `details` is the pending view's row for it (`kind`,
  `source`, `from`, `collaboration`, and the rest below), `options`,
  `status` (`pending` or `resolved`), `created_at` (when it was asked),
  `resolved_at` and `resolution` once settled, `presented: true`,
  `subscribed: false` and `answerable: true`. `resolution` is the answer as
  this CAR holds it: the option or words the person chose, the reply that
  settled a thread question, `accept` or `decline` for a board item
  (`withdrawn` when its sender took it back), or a Lattice request's answer.
  A settled question asking everyone (`details.everyone: true`) also names
  who took it in `details.resolved_by` (their name, as `from` names people)
  and `details.resolved_by_account`, for every member it asked.
  Every one is read from the mechanism that owns that ask, the same read the
  pending view and the `collab.list` and `collab.wait` counts make, so the
  lists cannot disagree; settled asks survive a restart because each owner
  keeps them (the collaboration store, the Lattice request ledger, the work
  board). A source that cannot be read just now is missing from the list,
  which has no `unavailable`. Any other session gets the ledger alone, as
  before.
- **The person's pending asks (`pending: true`).** Every ask waiting on the
  person signed in here, oldest first:
  `{ count, asks: [PendingAsk], unavailable?: [{ source, org, sentence }] }`.
  `count` is the length of `asks`. Each `PendingAsk` is
  `{ id, kind, source, org?, from, question, options, collaboration, asked_at_ms, message_id?, everyone?, item?, request_id?, request_kind?, to?, origin?, remote? }`:
  - `id` is what `host.resolve_approval` takes as `approval_id`. A ledger
    row keeps its own id (`approval-…`); the other kinds use
    `ask:<org>:<collaboration>:<message_id>`, `direct:<org>:<conversation>:<message_id>`,
    `board:<org>:<item>` and `lattice:<request_id>`. Treat it as opaque.
  - `kind` is `decision` (a question asking the person, in a collaboration or
    a direct conversation), `approval` (a ledger row: a solo agent's approval,
    or an agent's approval raised for a collaboration), `handoff` or
    `assignment` (a work-board item waiting on the person to accept it), or
    `request` (a Lattice request to a person: a question, review, handoff or
    message another session or agent sent a person node outside any
    collaboration, as `lattice.requests` lists it).
  - `source` is `collaboration`, `direct`, `agent` (a ledger row raised for no
    collaboration), `board` or `lattice`.
  - A `request` also carries `request_id` (its id in `lattice.requests`),
    `request_kind` (`question`, `review_request`, `handoff` or `message`),
    `to` (the person it asks, by name), `origin` (`local`, `device`,
    `another_owner` or `unknown`, as `lattice.requests` says) and `remote`
    (the asker's CAR, or `null`). Its `options` are `["approve", "deny"]`
    for a review and empty otherwise. A review that has an approve/deny row
    right now is listed once, as that `approval`, never also as a request.
    A request is in no collaboration, so it is counted in the unscoped view
    and `collab.wait`, never in a collaboration's.
  - `from` is who asks (a member's name as `collab.list` shows it, or the
    agent's name). A question one of another person's sessions or supervised
    agents asked on their CAR is from that session, and its row adds
    `from_owner`, the person's name, as `collab.read` does; it is never shown
    as from the person; `question` is the question's text, the approval's action,
    or the board item's title; `options` are the choices the ask offers (empty
    for a question that offers none; `["accept", "decline"]` for a board item).
  - `collaboration` is `{ id, title }` for an ask in a collaboration (an
    approval is in one when its `details.collaboration` names it), else
    `null`. `message_id` is the question's message id; `item` the board item.
  - `everyone: true` marks a question asking every person in its
    collaboration (`collab.message` with `ask: "everyone"`): it is listed for
    each of them, and the first answer, from any of them through any route,
    takes it off every one of their lists and counts. Who took it, and what
    they answered, is on the question's `ask` mark in `collab.read` and
    `collab.conversation`.
  - With `collaboration` (a handle from `collab.list`), only that
    collaboration's asks. A plain @-mention is never an ask, and a question
    asking someone else, a resolved approval or an answered question is not
    listed.
  - `unavailable` names a source that could not be read just now (an
    organization's shared work board, or `lattice`, with no `org`, for the
    Lattice request ledger); its asks are missing from `asks`, not answered.
  - Only the person's own two surfaces read it: the host client and the
    signed-in dashboard. Any other session is refused with a JSON-RPC error
    ("Only the person answers their own asks…").
- Every row has the same readiness fields as `host.request_approval`, computed
  from current subscriptions whenever the list is read. Subscription changes
  therefore update readiness without replacing the approval.
- Resolved rows stay for 24 hours from `resolved_at`, including across daemon restarts, or until `host.dismiss_approval` removes them. Restart preserves the row id, resolution, `resolved_at`, `resolver`, and presentation choice without replaying `approval.requested` or `approval.resolved`. `resolver` carries the daemon-stamped `{principal, transport}` from the resolving connection or trusted transport, as described under `host.resolve_approval`. Disconnect reaping (`agent_gone`) has no resolver (`None`, omitted on the wire); older rows may also omit it. Reading the ledger drops expired resolved rows using their original resolution time (creation time only for older rows without `resolved_at`). Creating an approval also drops pending rows older than 24 hours unless a high-risk-method gate is still waiting on them; no event is sent for a pending row dropped that way.
- Resolution, dismissal, disconnect reaping, withdrawal, and hidden-row creation each save one complete floor-journal revision before changing the live approval ledger or publishing an approval event. The saved resolved row includes its resolver before the transaction commits. The resolution audit sink runs only after that commit and after `approval.resolved`. A failed save calls no resolution sink, restores the prior floor and ledger and returns a persistence error; disconnect cleanup logs that error because its socket has already closed. Withdrawal still removes the asker's pending question and records its reason; it does not create an owner decision.
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
- **Params**: `HostRequestApprovalParams` (the flattened `CreateHostApprovalRequest` plus presentation controls) — `{ agent_id?: string, action: string, details?: object, options?: string[], system_level?: boolean, deadline?: number, a2ui?: { components: object[], dataModel?: object }, present?: boolean, only_if_floor_clear?: boolean }`
- **Returns**: `HostApproval & { subscribed: boolean, answerable: boolean }` on acceptance, or `{ refused: true, reason: "floor_busy" }` for a busy-floor refusal.
- `present` defaults to `true`. Set `false` to open an approval row without
  opening, presenting, or parking a phone question. The pending row still
  lists in `host.approvals` and the standup/dashboard can resolve it through
  `host.resolve_approval` with one of its `options` (for example `ask`, `leave`,
  `skip`). Existing ownership and `answerable` rules still apply; use
  `system_level: true` for a row the owner answers. The presentation choice
  survives restart until the row is settled or pruned.
- A row whose `details.collaboration` names a collaboration is that
  collaboration's Approval ask (see `host.resolve_approval`). It offers
  exactly Allow once (`approve`) and Decline (`deny`): `options` must be those
  two or left out (they are then filled in), and any other options are refused
  with a sentence saying to post a question in the collaboration instead. It
  is always raised system-level, whatever `system_level` says, because the
  person answers it, never the session that raised it.
- Every accepted row carries `presented: boolean`: `false` for `present:false`,
  `true` otherwise. It travels in the request reply, `host.approvals`, the
  `host.subscribe.approvals` snapshot, durable approval records, and full-row
  `approval.requested` and `approval.resolved` event payloads (including
  auto-cancellation). These are the events that announce an approval row;
  `approval.resolve_requested`, `approval.self_resolved`, `approval.withdrawn`
  and refusal events describe lifecycle actions, not new rows.
  CarHost on iOS, Android and macOS keeps hidden rows in its approvals view
  and lets the owner answer them, but skips notifications, sounds, banners and
  new-request activity announcements. Attention badges/counts exclude hidden
  rows; list membership and empty states still include them. Android has no
  separate approval badge. Old stored rows and payloads from older daemons
  without `presented` mean `true`; durable hidden ids from the initial
  `present:false` implementation are migrated to `presented:false` on restart.
- `only_if_floor_clear` defaults to `false`. Set `true` to atomically refuse
  while an owner question is current, including a prior approval awaiting its
  next mirror tick. Refusal creates no approval row or queued topic, returns
  `floor_busy` in this call, and is saved in the owner-floor journal and an
  `approval.request_refused` host event. It can never deliver later. A clear
  floor admits and opens an eligible system-level question under the same lock;
  session-owned and `ws.method:` rows retain their existing transport exclusion. Each transport
  retains its existing once-per-presentation delivery reservation. Physical
  delivery still requires an enabled, paired transport. With `present: false`,
  the busy check still applies, but acceptance only opens the row.
  The guarded reconciliation also opens topics for older eligible pending rows
  on a daemon with no messaging transport; those rows keep the floor busy
  until settled or expired, although no transport sends them.
- `capabilities.list` advertises `present` and `only_if_floor_clear` in the
  `features` array of this method's own entry. Check that entry before sending
  these fields to an older daemon, which could ignore unknown fields.
- `subscribed` is literal: whether the requesting session is subscribed to host
  events (the same meaning as `host.subscribe`'s `subscribed`). An unsubscribed
  session receives neither `approval.resolve_requested` nor
  `approval.resolved`, whatever kind of row it raised. Daemon-raised rows have
  no requesting WebSocket session and report `subscribed: false`.
- `answerable` says whether a host's decision can take effect through its live,
  authenticated owner channel. A system-level row is precisely one with no
  owning `client_id` (`system_level: true` at creation); the owner resolves it
  directly in the ledger, so it is answerable independently of the requesting
  session's subscription. A host reading the row or resolving it already has
  that live owner channel. It is also `true` for a session-owned row whose session is subscribed. It is `false` for a
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
  the question and what Approve answers. `colleague_request` is a colleague's
  request that one of the person's agents merge, approve, deploy, delete,
  spend, send outside the organization or change access; it takes
  `{ requester, agent?, operation?, target? }`, with `action` saying what would
  happen. The macOS host labels its buttons Allow once (resolution `approve`)
  and Decline (`deny`), and while CarHost is not the active app it raises a
  banner titled "<requester> asks <agent>" with those two buttons, which
  answer it through `host.resolve_approval`; `approval.resolved` takes the
  banner down however it was answered. Any other
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
  decision. An `Image` must be a `data:` image the card carries itself; a
  remote, relative or data-model-bound address is refused, because a host
  would fetch it when the card opens, before the person decides. The stored
  row's `a2ui` is the checked `A2uiSurface` (`surfaceId: "approval"`), not the
  request as sent. `action` and `details` stay required context: the Windows
  tray, iOS and Android, and the iMessage and Slack prompts show those, not the
  tree. A request with `a2ui` and empty `details` (absent, null, `{}`, `[]` or
  `""`) gets `details: { "card_text": "<the card's text, one line per Text
  component in layout order>" }`; one whose card has no text either is
  refused. When a row has both `a2ui` and a `details.kind` layout, CarHost
  shows `a2ui`.
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
  another agent or leave it unattributed. The assistant gate applies only to
  agent-originated `host.request_approval`; daemon-raised and owner-raised rows
  pass. An unbound owner connection retains its advisory `agent_id`. When the
  resulting id names an agent, that agent's status auto-flips to
  `waiting_for_approval`.

> Earlier revisions of this page documented the params as
> `{ agent_id?, title, description?, context?, required_approvals? }`. No such
> fields exist — the handler deserializes `CreateHostApprovalRequest`, and a
> payload in the old shape is rejected because `action` is required.

#### `host.resolve_approval`
- **Params**: `ResolveHostApprovalRequest` — `{ approval_id: string, resolution?: string, text?: string, acknowledge_processing?: boolean }`.
  `acknowledge_processing` is read only for a `lattice:` ask (below).
  A ledger row takes `resolution`, one of its options; the other pending asks
  take `resolution` or `text` (below). A call that gives neither is refused
  with a sentence saying which to give.
- **Answering any pending ask.** `approval_id` takes any `id` from
  `host.approvals { pending: true }`. A ledger row is resolved exactly as the
  rest of this section describes; when its `details.collaboration` names a
  collaboration, the reply also carries `receipt`, the post in that
  collaboration whose body is the resolution itself (`approve` or `deny`). Such a row is
  that collaboration's Approval ask, the person's decision: only the host
  client and the signed-in dashboard may resolve it, and any other session,
  the agent that raised it included, is refused `not_your_ask` with the row
  left pending. A typed reply in the thread naming it (`collab.message` with
  `in_reply_to` its id) is an ordinary post and leaves it pending; only Allow
  once (`approve`) or Decline (`deny`) answers it. The other ids
  go to the mechanism that owns the ask, and only the host client and the
  signed-in dashboard may answer them:
  - `ask:` (a question in a collaboration): every answer is an ordinary
    post in the thread, a reply to the question that the asker and every
    member read (CAR-1006). `resolution` is one of its `options`, or
    `decline`, which posts the answer "declined"; `text` is a typed answer.
    Returns `{ id, status: "answered", private: false, resolution?, answer?, post }`.
    A question asking one person settles only by that person's own answer:
    this call, or a `collab.message` from the host client with
    `in_reply_to` the question. A reply from an agent session of the same
    account (Claude Code, Codex) is an ordinary post and leaves the ask
    pending, and such a session reads the ask with `for_you: false`.
    A question asking everyone (`everyone: true`) is answered for the whole
    team, so nothing in it is private: `resolution` is posted in the thread as
    the reply that takes it, with the option as its body, and every member,
    the asker included, reads who took it and what they chose. Returns
    `{ id, status: "answered", private: false, resolution, post }`. An answer
    after someone took it is refused `already_resolved` with the sentence
    "<name> already took this; their answer stands." and
    `data.taken: { resolved_by, resolved_by_account, resolved_at_ms, answer, answer_message_id }`.
  - `direct:` (a question in a direct conversation): `text` (or `resolution`)
    is the reply to it: `{ id, status: "answered", private: true, delivery }`.
  - `lattice:` (a Lattice request to a person): `text` is the answer, or
    `resolution`, one of its `options` (a review's `approve` or `deny`). It
    is recorded and delivered exactly as `lattice.respond` from the host
    does, so the asker gets it as an `answer` with `in_reply_to` the request
    and `answered_by: "host"`, and the request leaves `lattice.requests` and
    this list together; an answer through `lattice.respond` likewise
    removes it here. Returns
    `{ id, status: "answered", private: true, delivery, resolution? }`. A
    request from another owner's CAR whose processing notice the person
    has not yet agreed to is refused with `lattice.respond`'s own
    `processing_notice_pending` error (code `-32020`, the notice's text) and
    stays pending. Answering again with `acknowledge_processing: true`
    agrees to that connection's notice and sends, exactly as
    `lattice.respond { acknowledge_processing: true }`. Only the host client
    may agree: from the signed-in dashboard it is refused
    (`consent_is_host_only`) and nothing is sent.
  - `board:` (a handoff or assignment): `resolution` is `accept` or
    `decline`, applied by `board.accept` or `board.decline`:
    `{ id, status: "answered", private: false, resolution, item }`.
  - Give `resolution` or `text`, not both. The first answer stands, whichever
    route gives it: this call, a `collab.message` reply with `in_reply_to`
    from the member the question asks (for a question asking everyone, from
    any person it asks, written by that person and not by any session,
    supervised agent or assistant of theirs), `lattice.respond`, or
    `board.accept`/`board.decline`. A
    later answer is refused and changes nothing.
  - Refusals are JSON-RPC errors carrying `data.reason`: `unknown_approval`
    (no pending ask has that id), `already_resolved`, `not_your_ask` (the ask
    names someone else, or the caller is not the person's own surface),
    `invalid_resolution` (not one of the ask's options, or a choice where it
    offers none), `no_private_route` (the asker cannot be reached privately
    from here: another person's registered agent, or a question from the
    person's own other computer), `not_saved` (the answer could not be saved,
    so the ask stays pending), `refused`, `receipt_not_posted` and
    `board_refused` (the owning mechanism refused; `data.sentence` says why).
- **Returns**: the `HostApproval` row, resolved with the canonical option text
  (see the single-option rule below).
  When the resolution could not be appended to the durable journal
  (`host-approval-resolutions.jsonl`), the approval still resolves and the row
  carries `journal_warning`, a string naming the journal path and the error
  (car#4383).
  The resolved row carries `resolver: { principal, transport }`, stamped by the
  daemon from the session or transport that resolved it and never from the
  request (car#3398). `principal` is `conn:<client id>` for a WebSocket client,
  `agent:<id>` for an agent-bound session, `dashboard:<client id>` for the
  signed-in browser, or a messaging transport's own name; `transport` is `ws`,
  `host`, `dashboard`, `agent`, or the messaging transport (`imessage`,
  `slack-transport`). A plain WebSocket client stays a connection id: the
  daemon cannot tell CarHost from `car-host approve` or iOS when each holds the
  host token, so all three read `conn:<id>` with transport `host`. Identity
  only: the text of a message that carried a messaging decision is never
  recorded. Each resolution is also appended to the owner-private
  `host-approval-resolutions.jsonl` beside the peer-message journal (action
  text redacted and bounded, `details` never written, and never trimmed:
  approval records are kept), so a decision is still readable after the 24-hour
  in-memory row is gone and after a restart. It is not `approvals.jsonl`, the
  standing-authority store: a host approval never becomes a standing grant.
  `permission.approve` and `permission.reject` record their reviewer in the
  same form, `conn:<client id>@host`.
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
  - `invalid_resolution`: the verb is not an offered option or a supported
    single-option alias, or it is a reserved daemon closing reason.
    `error.data` is `{ reason, approval_id, resolution }`. The row is unchanged.
  - `owner_not_connected`: the row is not answerable: it is owned by a session
    that is not subscribed to host events, so nothing can deliver the request to it.
    `error.data` is `{ reason, approval_id, owner_client_id }`. The message
    still reads "… is owned by session '…' which is not currently connected".
- `resolution` is the **verb**, matched case-sensitively against the row's
  `options` (default `["approve", "deny"]`). When a row has exactly one option,
  `approve` selects a non-negative option: an `options: ["acknowledge"]` warning resolves
  as `acknowledge`, including in the stored row and emitted events. For a lone
  negative option (`deny`, `reject`, `cancel`, `no`, or `decline`, recognized
  without regard to ASCII case), `approve` is refused and names the option;
  `deny` or the exact option text selects that negative option. `deny` on any
  other single-option row is refused and names its option. Multi-option rows
  require an exact option match. These
  rules and the readiness check apply at the shared resolution boundary to
  host apps and paired phone replies alike. The gate treats anything other than
  its approve label as a denial. Both fields are required. An off-option answer
  is refused before forwarding to a session or a parked chat gate. An `answerable: false` row is
  refused even when its requesting session tries to answer it. Both refusals
  emit `approval.resolve_refused` and are durably recorded on the floor journal;
  neither changes the approval.
- **Daemon closure is not an owner resolution.** When a gate ends without an
  owner answer, the daemon closes its row through an internal lifecycle path.
  The resolved row and `approval.resolved` event carry the closing reason in
  `resolution`: `disconnected`, `interrupted`, `timeout`, `cancelled`,
  `answered` (a Lattice answer recorded in its own ledger), or `agent_gone`.
  These reserved reasons are refused from `host.resolve_approval` and paired
  phone answers even if a row lists one as an option; `approve` cannot alias
  one either. Closing a chat after host disconnect clears its pending phone
  question immediately, so later questions can take the floor. A closing
  reason records why the row ended; it grants no owner approval.
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
  method outright (`agent_default_deny`), for every row, as is a Mac's
  orchestrator (a worker session is answered by the worker gate first), and
  that refusal is recorded as the same event
  with `reason: "walled_agent_default_deny"`. Host sessions, the daemon-token
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
  seconds; once the ledger records the answer, the row can be dismissed), `unknown_approval`,
  `persistence_failed` (the journal could not save the dismissal; the row stays listed).

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

`approval.resolve_refused` fires when `host.resolve_approval` is refused by the
agent wall, the walled-agent default-deny, option validation, or readiness
check. Wall and default-deny refusals are attributed to the refused agent;
option/readiness refusals to the approval's agent. Payload:
`{ approval_id, agent_id, client_id, resolution, reason }`, where `agent_id` is
the refused agent for wall refusals (otherwise the approval's agent, or null),
`client_id` is the resolving connection, and `reason` is `"gate_row"` (a
high-risk gate row, anyone's) or `"own_system_row"` (a system-level row it
raised), `"invalid_resolution"`, `"owner_not_connected"`, or
`"walled_agent_default_deny"` (a walled agent may not call the method at all:
an ordinary supervised agent or orchestrator on Linux, an orchestrator on a
Mac; a worker session is answered by the worker gate before this). A
default-deny refusal carries `approval_id` and `resolution` as the caller sent
them, strings only and cut to 256 characters (no row is looked up, so the event
says nothing about whether the approval exists), and
`method: "host.resolve_approval"`; it is in the
host event ledger, not the floor journal. Every refused call adds one event and
none is coalesced, so a walled agent that repeats the call can push older
events out of the bounded ledger, as repeated wall refusals already could.
Option/readiness refusals also carry
`method: "host.resolve_approval"` and are durable on the floor journal. The row is not touched and no `approval.resolved` follows.

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
gate"). When the agent's turn acknowledged `approval_frames: true` (see
`agents.chat` in agents.md), a decision the gate took does not close the row:
`host.resolve_approval` returns the row as it stands, and the gate's own
`approval_resolved` closes it with the word the gate recorded, also after a
refused decision. If that turn's route ends first, the row closes `unknown`. iMessage and Slack replies to a
chat approval are routed to the parked gate the same way.

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


#### `host.withdraw_approval`

- **Params**: `{ id: string, reason: string }`.
- **Returns**: `{ withdrawn: true, id: string }`.
- Only the authenticated opener principal may withdraw its own pending question,
  including a system-level row. Withdrawal is never an approval. It closes the
  mirrored floor topic, removes the pending approval and durably records one
  withdrawal on the existing floor journal, then emits `approval.withdrawn`.
  A repeated withdrawal is refused. Opener identity is stamped independently
  of the caller's advisory `agent_id`.

`host.request_approval` accepts an optional `deadline` in absolute Unix
milliseconds. Past deadlines are refused; the returned approval carries it.
The floor uses it instead of its default 24-hour deadline. The opener may take
its own reversible default at the deadline and withdraw the stale question.
CAR does not itself execute a default or infer authorization from silence.
The host installs the assistant with `agents.install {owner_assistant: true, …}`
or binds an existing installation with `conversation.assistant.bind`.
Before the first binding, any authenticated caller may raise an approval.
The binding is durably recorded in the floor journal and activates the gate:
the gate applies to agent-originated `host.request_approval` and accepts only
that authenticated assistant. Other agents are refused, including a forged
advisory `agent_id`, and the refusal is durably recorded on the floor.
Daemon-raised rows (including spend warnings, heal, and Lattice approvals with
no agent id) and owner-raised rows pass both this gate and the phone mirror.
The opener may still withdraw its own question; withdrawal grants no authority.

{% endraw %}
