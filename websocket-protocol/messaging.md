{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### messaging

Approval questions share the [owner conversation floor](conversation.md). Only the
current approval is presented; other approvals wait. Bare approve/deny replies
answer that presented topic, unless an expiry requires clarification. A known non-send releases its reservation for the next tick; an unknown
outcome retains it. A named code can answer a previously presented parked topic
and dismiss a clarification. Pending approvals past their deadline at a sync
tick emit a host event and an eventlog alert, including already mirrored approvals.

The governed `messaging.send` tool has optional `message_kind` (separate from
recipient `kind`: direct/channel). For the paired owner, omission means
`question`; questions join this same floor, and `emergency` interrupts through
it. The only other accepted owner kinds are `notice`, `standup`, `draft_to_send` and
`back_online`; these also cross the floor mutex boundary. Every other owner
kind is refused with a reason. Owner questions default to a 24-hour deadline from acceptance, including time
spent waiting behind approvals. Optional `deadline_ms` overrides it with a future
Unix-millisecond deadline. The 60-second deadline is reserved for clarification.
Every accepted owner-question send returns a receipt containing `topic_id`
(also retained in `message_id` for compatibility), `queued`, `delivered`, and an
optional `reason`. `queued:true` means the question is waiting or parked;
`queued:false` means it is not waiting for a turn. `delivered` reports a
confirmed send by this call (or its cached keyed receipt);
a reused topic can return `delivered:false` when no new send was attempted.
Acceptance is not delivery acknowledgement.
A known soft send failure (for example, Messages offline) returns the normal
receipt with `queued:false`, `delivered:false`, and the failure `reason`. The
floor keeps trying on subsequent ticks until the question's deadline. The caller
should retain the topic id and fetch its answer or `expired` state with
`conversation.get {topic_id}`; the attached session supplies the asker principal.
Questions and answers remain recorded. Delivery failures also emit
`conversation.delivery_failed` host events and local alerts-journal entries.
Refusals (bad recipient kind, unpaired recipient, or refused owner message kind)
and hard failures that leave no accepted topic return errors. A transport failure
after acceptance keeps the topic and returns its receipt. If the transport outcome
is unknown, the floor retains the send reservation to avoid duplicate delivery;
`delivered:false` does not authorize a blind resend of an unknown outcome.

Without an `idempotency_key`, identical question text and message kind from the
same asker reuse an unexpired open, waiting, or parked topic. After a
`delivered:false` receipt, poll `conversation.get` instead of sending again; a
retry of the same live question returns its topic id. Reuse preserves the
original deadline. Different text or kind creates a new topic. Settled or expired questions may be asked again. A supplied
idempotency key keeps its existing semantics: it identifies the accepted request
for that asker even if the text changes or the topic has finished. Use distinct
keys to intentionally ask identical questions as separate requests.
Other recipients retain their existing send behavior.

The **multi-channel** approval-transport config surface. This is the **only**
allowlist/config-mutation path in the system for the opt-in approval transport.
Every method here is **host/local-auth gated**: when the daemon has a host token
configured, a connection must be the host-management client (`session.is_host`,
via `session.auth { host_token }`) — the same trust root that gates
permission-tier / approval changes. An inbound message (iMessage text, Slack
event) carries no such credential, so it can **never** mutate the config
(anti-injection invariant). The config persists to `~/.car/messaging.json`
(one atomic write; per-channel sections under a single object).

**Per-channel `channel` field (multi-channel transport):** every method below
accepts an optional `channel` field selecting which channel to read or mutate.
`channel` is a stable string key — `"imessage"` or `"slack"` — and **defaults to
`"imessage"`** when absent (back-compat for the original single-channel surface
and the FFI bindings). Each channel has its own independent `enabled` flag,
allowlist, and pairing code; both channels default disabled (opt-in). An unknown
`channel` string is rejected with a clear error.

#### `messaging.config.get`
- **Params**: `{ channel?: "imessage" | "slack" }` (default `"imessage"`)
- **Returns**: `MessagingConfigView` — `{ channel: "imessage" | "slack", enabled: boolean, allowlisted_handles: string[], pairing_active: boolean }`. The `channel` key is **always present** and names which channel this view describes (so a per-channel round-trip can confirm which channel the flags belong to).
- Rejected (`-32603`) for a non-host caller when a host token is configured.

#### `messaging.config.set`
- **Params**: `MessagingConfigSetRequest` — `{ channel?: "imessage" | "slack", enabled?: boolean, allowlisted_handles?: string[], add_handles?: string[], remove_handles?: string[], bot_token?: string, app_token?: string, slack_channel?: string }`. `channel` selects which channel to mutate (default `"imessage"`). Only supplied fields mutate; `allowlisted_handles` replaces the whole list, then `add_handles`/`remove_handles` apply.
- **Slack token provisioning** (`channel: "slack"` only): supplying BOTH `bot_token` (`xoxb-`) and `app_token` (`xapp-`) writes the bearer tokens to the OS keychain (MC-9) and persists ONLY a keychain *reference* into the config — the bearer values never land in `messaging.json` nor echo back in the response view. Provisioning runs AFTER the host-authority gate (host-only; an inbound message can never reach this surface). Supplying only one token, or `channel: "imessage"`, is ignored for provisioning (the enable/allowlist mutation still applies). This is the path the macOS host UI's "Save Slack tokens" action drives.
- **Slack post-channel** (`channel: "slack"` only): `slack_channel` is the conversation/channel id (`C0123…` / `D024…`) the outbound approval prompt posts into. Unlike the tokens it is CONFIGURATION, not a secret — the daemon persists it IN `messaging.json` (host-gated), never the keychain. The boot path reads it from config to construct the Slack adapter with the channel to post into; without it outbound Slack posts to `channel:""` → `channel_not_found` → zero prompts. Set on the same `messaging.config.set` call as the tokens (the host UI's "Save Slack tokens" action sends all three).
- **Returns**: the updated `MessagingConfigView` (with its `channel` key). Never carries a bearer token.
- **Spawn-on-enable**: an OFF→ON `enabled` transition spawns that channel's watcher loop IMMEDIATELY — no daemon/app restart. (Before this, a runtime enable did nothing until car-server restarted, because the watcher was only spawned at boot.) Idempotent: enabling an already-running channel is a no-op. Disabling leaves the loop running (every tick already gates on the enabled flag, so a disabled channel does zero work). If the watcher cannot start (e.g. an unprovisioned Slack channel), the call returns an error AND persists the flag, so the host UI learns the watcher could not start.
- The ONLY allowlist/config-mutation path. Host/local-auth gated.

#### `messaging.pairing.start`
- **Params**: `{ channel?: "imessage" | "slack" }` (default `"imessage"`)
- **Returns**: `MessagingPairingStartResponse` — `{ pairing_code: string, config: MessagingConfigView }`. The 43-char high-entropy `pairing_code` is shown ONLY in local UI; the paired member sends it back over the selected channel to bind its handle into that channel's allowlist (constant-time validated server-side). Rotates any prior active code on that channel. Host/local-auth gated.

#### `messaging.pairing.status`
- **Params**: `{ channel?: "imessage" | "slack" }` (default `"imessage"`)
- **Returns**: `MessagingPairingStatusResponse` — `{ pairing_active: boolean, pairing_code?: string }` for the selected channel. The active code is re-surfaced here (host-gated only) so the local UI can re-display it after a reload; it is never exposed over any inbound channel.

#### `messaging.status`
- **Params**: `{ channel?: "imessage" | "slack" }` (default `"imessage"`)
- **Returns**: `MessagingStatusView` — `{ channel: "imessage" | "slack", enabled: boolean, paired: boolean, watcher_running: boolean, fda_readable: boolean, last_send_at_ms?: number, last_send_ok?: boolean, last_error?: string }`. The real runtime liveness, computed daemon-side so a host UI can render a SINGLE readiness state (resolve the FIRST failing condition: `enabled` → `watcher_running` → `fda_readable` → `paired` → Ready) plus "last delivered" (`last_send_at_ms`) and a surfaced send error (`last_error`). `fda_readable` reflects the **daemon's** Full Disk Access (the daemon is the chat.db reader), probed daemon-side. Host/local-auth gated.

#### `messaging.test_send`
- **Params**: `{ channel?: "imessage" | "slack" }` (default `"imessage"`)
- **Returns**: `MessagingTestSendResponse` — `{ ok: boolean, error?: string }`. Sends a fixed, clearly-labeled self-test message (`"CAR test: your iMessage approvals are connected. No action needed."`) to the channel's paired handle and returns the outcome synchronously. A pure send probe: it mints **NO** approval/pairing mapping and resolves nothing — it only proves the daemon can actually deliver (so a pass genuinely proves macOS Automation works; a failure surfaces the same actionable error a real send would). `ok:false` carries an actionable `error` (channel off, no paired handle, Automation denied, recipient-not-found). The outcome is recorded into liveness, so a following `messaging.status` reflects it in `last_send_*`. Host/local-auth gated. (Slack not yet wired — returns a clear "not supported on this channel yet" error.)


`message_kind: "notice"` asks nothing. It sends through the same serialized
owner-floor transport while leaving the current question and topic count
unchanged. Standup and back-online messages may use this kind. It creates no
answer attribution and does not take the question slot.

At installation the host binds the named assistant using
`conversation.assistant.bind {agent_id}`. That durable binding checks the
session's authenticated agent on owner-handle `messaging.send`,
`host.request_approval`, and conversation opens. Other agents and plain sessions
are refused and recorded in the existing floor journal once an assistant is
bound. Before the first binding, authenticated callers may submit approvals
and send to the owner's handles as before. The first binding is durably
recorded in the floor journal and activates the assistant gate. Non-owner
recipients retain their consent checks.
`agents.install` accepts `owner_assistant: true` beside the manifest to bind
that agent after a successful install. Worker bundles cannot hold this role.

{% endraw %}
