{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### messaging

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


{% endraw %}
