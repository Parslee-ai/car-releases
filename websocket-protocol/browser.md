{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### browser

`browser.run` / `browser.close` is a per-connection **scripted** browser —
the caller sends a script, gets a trace back, nothing streams. The
**browser drawer surface** documented below it is a different feature
entirely: a live, two-way, host-facing window onto the browser a CAR agent
(or the shared standing session) is *actually* using — built for the
Command Deck's drawer. It has three families:

- **`browser.view.*`** — the HOST side: subscribe, drive input, take/hand
  back control. **Host-management-client only**
  (`session.auth { host_token }`) — deliberately **stricter** than
  `runs.subscribe`, which also admits the run's owning agent: frames here
  ARE page screenshots and the input methods drive a logged-in browser, so
  admitting an agent would hand it perception and actuation outside the
  `full_access` `browse_*` tool tier, and would let it read a page during
  the privacy blackout that exists to keep it out.
- **`browser.producer.*`** — the AGENT side: a supervised `car do --serve`
  process publishing ITS OWN browser so `browser.view.*` can serve it.
  Agent-session only (`session.auth { token, agent_id }`).
- **`agent.browser.*`** — reverse calls the DAEMON makes on the agent's own
  session (input/control/capture) to drive a relayed browser, the mirror
  image of `agent.chat`.

**All three families are WS-only — no FFI binding on any of the twenty-four
methods/events below** (the sixteen `browser.view.*` methods + its
`browser.view.event` notification, plus the seven Task 4b added:
`browser.producer.register`, the `browser.producer.presentation` /
`browser.producer.frame` notification pair, and `agent.browser.input` /
`agent.browser.control` / `agent.browser.capture` /
`agent.browser.host_connected`). `browser.view.*` mirrors the `runs.subscribe` /
`coder.subscribe` precedent exactly: its authorization is CarHost-only, so
there is no JS/Python SDK caller to bind. `browser.producer.*` /
`agent.browser.*` mirrors `agent.chat` / `agent.chat.event`: today the only
producer is the Rust `car-cli` binary (`car do --serve`) talking to the
daemon over its own `DaemonClient` session in-process, and there is no
generic "register a browser producer" callback primitive exposed to
JS/Python (unlike `register_chat_handler` for `agent.chat`) — adding one
would be inventing a new binding mechanism, not documenting an existing
one. See
[`docs/host-protocol.md`](.././host-protocol.md#live-browser-view-browserviewsubscribe--browserviewevent)
for the reconnect/cursor/authorization contract, written in the same voice
as `runs.subscribe`'s; this section is the field-level params/returns
reference.

Every `browser.view.*` method shares the envelope field
`conversation_id?: string | null` — omitted or `null` means the **standing
session**, the one shared browser every conversation without an
agent-attached browser shows. A `browser.view.*` response always echoes the
`conversation_id` it was given and adds `standing_session: bool`.

`browser.producer.register` takes the same field but **requires a non-empty
value**: there is no standing session to publish — that browser is the
daemon's own — so an omitted, null or empty `conversation_id` is refused
(see its own entry below).

#### `browser.run`
- **Params**: `{ script: string | object, width?: number = 1280, height?: number = 720, headed?: boolean = false }`
- **Returns**: browser trace/result object
- `script` accepts an inline JSON string or structured object. `headed` only applies on first launch; subsequent calls reuse the existing session.

#### `browser.close`
- **Params**: `{}`
- **Returns**: `{ closed: boolean }`

#### `browser.view.subscribe`
- **Params**: `{ conversation_id?: string | null }`
- **Returns** (the snapshot at a cursor): `{ conversation_id, standing_session, cursor, presentation }` where `cursor` (`u64`) is the event boundary the daemon streams strictly after and `presentation` is a `Presentation` object (below).
- **Atomicity.** The presentation read and the subscriber registration happen under the same lock every emitter holds, so the snapshot covers exactly the events through `cursor` — no gap, no duplicate, at the boundary. Subscribing does **not** launch Chromium.
- **Re-subscribing** on the same connection replaces the prior subscriber and re-snapshots — the reconnect path.
- **Unknown conversation**: `` no browser view for conversation '<id>' — that conversation has no agent-attached browser; omit `conversation_id` for the standing session ``. A drawer opened on a conversation with no turn yet gets this and falls back to the standing session (see `browser.producer.register` below — a conversation resolves only once its agent has registered it, from the start of its first turn).
- **Authorization** — see the section intro above; checked *before* params are parsed and before any view is resolved, so an unauthorized caller never learns whether a conversation exists: `not authorized to use browser.view.*: this connection is not the host management client (session.auth { host_token })`.
- **WS-only** — no FFI binding (CarHost consumes the notification, same contract as `runs.subscribe`).

#### `browser.view.unsubscribe`
- **Params**: `{ conversation_id?: string | null }`
- **Returns**: `{ conversation_id, removed: bool }` — idempotent; `removed: false` when there was nothing to remove. No authorization gate beyond the base check — removing your own subscription leaks nothing.
- **WS-only** — no FFI binding.

#### `browser.view.take_control` / `browser.view.hand_back`
- **Params**: `{ conversation_id?: string | null }`
- **Returns**: the same shape as `browser.view.subscribe`'s reply (`conversation_id, standing_session, cursor, presentation`).
- `take_control` records the calling connection as the control holder and drives the control reducer's `TakeControl` transition. `hand_back` clears the holder, drives `HandBack` (which also resolves a pending sign-in), and returns control to the agent.
- **Both are gated on holding control, exactly like the input methods.** Only the connection that took control may take it again or hand it back — or any authorized connection when nobody holds it (nothing has been taken, or the holder disconnected). Otherwise: `another connection holds control of this browser — it must hand back before another can take control` / `another connection holds control of this browser — only the control holder may hand it back`. Gating `hand_back` alone would not have closed the case it exists for: a second connection could simply `take_control` first, overwriting the holder, and then hand back. `take_control` also records a holder only when the reducer actually moved ownership to the user — on the standing session it is a documented no-op, and recording one there would lock every other connection out of a browser nobody had taken. Without this, a second host connection could revert the browser to the agent while the holder was mid-sign-in, resolving their pending sign-in and lifting the privacy blackout underneath them.
- **A holder that disconnects is cleared immediately**, not at the end of the grace period: the connection is provably gone, and the reducer does not always ask for a grace timer (a relayed transition that fails to reach a wedged agent process returns no effects at all). Ownership reversion is still the timer's job. While ownership sits with the user and no connection holds it, any authorized connection may drive and hand back — "a person has control but we do not know which connection" must not mean nobody may.
- **The browser is driven first; the daemon's record of who holds control moves only on success.** On a **relayed** view (a supervised agent process's browser), a transition that never reached the process leaves both sides agreeing — the call fails and nothing changed, so the drawer can retry safely rather than believing it holds control it does not. New failure modes, relay-only: `the agent process serving this browser is unreachable: <e>` · `the agent process serving this browser disconnected before answering` · ``the agent process serving this browser did not answer `agent.browser.control` within 30s`` · `the agent process that owns this browser has disconnected — its browser is gone`.
- **WS-only** — no FFI binding.

#### The input methods
All take the shared envelope plus their own fields; all return `{ ok: true, conversation_id }` (plus `tab_id` for `tab_open`).

| Method | Extra params |
|---|---|
| `browser.view.navigate` | `{ url: string }` |
| `browser.view.click` | `{ x: number, y: number }` — viewport pixels, matching the frame's `width`/`height` |
| `browser.view.type` | `{ text: string }` |
| `browser.view.keypress` | `{ key: string, modifiers?: ("alt" \| "control" \| "meta" \| "shift")[] }` |
| `browser.view.scroll` | `{ delta_y: integer }` |
| `browser.view.paste` | `{ text: string }` |
| `browser.view.back` | — |
| `browser.view.forward` | — |
| `browser.view.reload` | — |
| `browser.view.tab_open` | — (response adds `tab_id: string`) |
| `browser.view.tab_close` | `{ tab_id: string }` |
| `browser.view.tab_switch` | `{ tab_id: string }` |

- Modifier aliases (case-insensitive): `alt`/`option`, `control`/`ctrl`, `meta`/`command`/`cmd`, `shift`. An unknown name is a clean error — `unknown modifier '<x>' — use alt, control, meta, or shift` — never silently dropped.
- `tab_id` is the tab's opaque id rendered as a string (`"tab-3"`), exactly as it appears in `presentation.tabs[].id`. Ids are never reused, so a stale one errors cleanly: `no open tab '<id>'`.
- **`browser.view.paste` carries the TEXT, and a client MUST NOT synthesise ⌘V as a keypress.** The clipboard belongs to the host's OS; CDP's `Input.dispatchKeyEvent` reaches only the page and has no access to a clipboard, so an injected Cmd+V delivers a key event and nothing arrives — silently. The host reads its own pasteboard and sends the string, which the daemon applies with `Input.insertText`: one insertion that replaces the selection, rather than N keydown handlers a page could read as N keystrokes. This is also why `browser.view.type` is not a substitute — it types character by character. Errors are the ordinary input family: `browser.view.paste requires { text }`, `no browser is running for this view — navigate to a page first`, and `paste: <e>` for a browser-level failure.
- **Editing keys work through `browser.view.keypress`.** `Backspace`, `Delete`, `Tab`, `Enter`, `Escape`, the four arrows, `Home`/`End`/`PageUp`/`PageDown`, and any single printable character are sent with the `code`, `windowsVirtualKeyCode` and `text` Chromium's editing layer requires — without those it delivers a DOM event the page can observe and performs no edit. `text` is suppressed while Control or Meta is held, so `⌘A` selects rather than typing an `a`. An unrecognised key name still dispatches under its own `key`.
- **The three nav-bar history buttons — `back` / `forward` / `reload` — take no params of their own**: which page they act on is the ACTIVE tab's own history, per tab. They drive Chromium's real session history over CDP (`Page.navigateToHistoryEntry` on the adjacent entry, `Page.reload`); a synthesised ⌘←/⌘→ keypress does **not** move history, because the shortcut is browser chrome the CDP input domain never reaches — it injects into the page instead. Whether each is available is already on the wire: `presentation.tabs[].can_go_back` / `can_go_forward` are what a nav bar disables its buttons from. A tab is born at `about:blank` and Chromium records that as history entry zero, so `can_go_back` deliberately EXCLUDES it — Back enables after the *second* navigation, and never lands on a blank page that would read as the empty state. (A later, deliberate navigation to `about:blank` is a real entry and does count.) Calling one anyway (a race, or a client bug) is a clean error, never a hang or a silent success: `no page to go back to` · `no page to go forward to`.
- **Who may call them**, checked immediately after view resolution:

  | Control state | Who may drive |
  |---|---|
  | `owner: "none"` (no agent involved) | any authorized connection — zero ceremony |
  | a sign-in is pending | any authorized connection — a human must be able to type credentials |
  | `owner: "user"` | only the connection that called `take_control` |
  | `owner: "agent"` | nobody, until `take_control` |

  Errors: `the agent holds control of this browser — call browser.view.take_control first` · `another connection holds control of this browser — input is accepted only from the control holder`.
- **Which can launch Chromium**: only `navigate` and `tab_open` — the standing session comes to life on the user's first navigation. Every other input against no running browser errors cleanly: `no browser is running for this view — navigate to a page first`. That is also `reload`'s answer on the empty state, which is what "reload is inactive on the empty state" means on the wire.
- **Validation happens before the view is touched**, so a malformed call is refused identically whether the browser is local to the daemon or relayed to a supervised agent process, and a relayed call never pays a round trip for a request that could never have worked: `browser.view.navigate requires { url }` · `` navigate requires a non-empty `url` `` · `browser.view.click requires { x, y }` · `browser.view.type requires { text }` · `browser.view.keypress requires { key }` · `browser.view.scroll requires { delta_y }` · `browser.view.tab_close requires { tab_id }` · `browser.view.tab_switch requires { tab_id }`. `back`/`forward`/`reload` have nothing to validate. Browser-level failures: `navigate to <url>: <e>` · `click: <e>` · `type: <e>` · `keypress: <e>` · `scroll: <e>` · `reload: <e>` · `open tab: <e>` · `close tab: <e>` · `switch tab: <e>`.
- **A pending sign-in relaxes the input gate for the agent's browser, not for a browser someone has taken.** While a sign-in is pending and the agent still owns the browser, any authorized connection may drive — that is how a person completes a sign-in without pressing Take control. Once a connection takes control the ordinary holder rule applies again (the sign-in stays pending; `take_control` does not clear it), so another connection is refused with `another connection holds control of this browser — input is accepted only from the control holder`.
- **On a relayed view, the control gate is re-checked a second time — in the agent process, immediately before injection.** The daemon's own check reads a *cached* presentation, and on the relay path that read is separated from the injection by a WS round trip; without the second check a user's click could land after the agent legitimately resumed driving, one hop late. Both checks answer the identical string, so a person cannot tell which one refused them.
- **WS-only** — no FFI binding, for all twelve.

#### `browser.view.event` (server → client notification)
Pushed once per event to every `(connection, view)` subscriber. Shape (a tagged union flattened onto the envelope): `{ conversation_id, cursor, kind: "presentation", presentation }` or `{ conversation_id, cursor, kind: "frame", frame }`.

- `cursor` (`u64`) counts **all** events — presentation deltas and frames alike. A subscriber at `n` expects `n+1`; a jump means the daemon dropped an event for a slow subscriber, and the fix is to re-subscribe (fresh snapshot + fresh cursor). `presentation.revision` is a **separate** counter that advances only when the presentation actually changed, and it is **per producer** — it can reset when a view's producer is replaced (a restarted supervised process starts its own counter at 0). `cursor`, by contrast, is per **view** and never resets and never moves backwards, including across that handover — a client should gap-detect on `cursor`, never on `revision`.
- `frame`: `{ jpeg_base64: string, width: number, height: number, device_pixel_ratio: number, captured_at: number }` — standard base64, no `data:` prefix; `captured_at` is wall-clock seconds since THIS subscription started (frames are change-driven, not fixed-rate).
- **Bounded channel + drain task per subscriber**, capacity 32 (`BROWSER_VIEW_CHANNEL_CAP`) — small on purpose, since a slot can hold a full-viewport JPEG. A full channel **drops the event**; the subscriber stays registered and recovers by detecting the cursor gap and re-subscribing (it is not evicted).
- **Explicit fanout** — each `(connection, view)` is its own subscriber, so two Command Deck windows on the same browser both get every event.
- **WS-only** — no FFI binding; no dispatch arm in `handler.rs` (a push notification, like `runs.trace.event`).

#### `browser.producer.register`
- **Params**: `{ conversation_id: string, presentation?: Presentation }` — `conversation_id` is the `agents.chat` `session_id`, required and non-empty; `presentation` optionally seeds the cache the daemon serves reads from.
- **Returns**: `{ ok: true, conversation_id, host_connected: boolean, capture: boolean }` — `capture` is whether anything is currently watching this producer's browser, and the producer MUST apply it: the daemon's capture signal is per-connection and edge-published while a supervised process's own capture state survives the connection, so a process that was capturing when its session dropped would otherwise keep screencasting and pushing frames under a fresh producer that never tells it to stop. `host_connected` is whether a CarHost host-client is connected to the daemon right now (`ServerState::any_host_connected`). This is how a supervised process learns to launch its own browser headless (the drawer is its face) vs headed (no host, so `browser_await_signin` still needs a visible window) — see `assistant::browser_tools::HostConnectivity` and the freshness note on `assistant::browser_producer::BrowserProducer`: refreshed on every registration that actually reaches the daemon (the first for a given conversation, and any resync after a reconnect), not continuously.
- **Idempotent for the same connection.** A supervised process registers on every chat turn; re-registering the same conversation on the same session is a no-op that keeps the existing view, its subscribers and its cursor. A DIFFERENT process claiming the key **replaces** the view (the same `adopt` handover Task 4 built for run replacement), carrying subscribers and cursor across.
- **Admission — a live turn OR a binding this agent already established.** A conversation may be claimed by the agent serving a *live* chat turn for it, or, between turns, by the agent that established the FIRST such claim (the daemon remembers the binding in `ProducerRegistry`). A live turn for a different agent beats a stale binding; another agent's binding, and a conversation nobody has ever served, are both refused. This widens *liveness*, not authorization — the agent_id↔conversation binding is still validated against the daemon's own record on every claim. **A full daemon restart clears these bindings** (they are in-memory only): those conversations resolve as "no browser view" — the drawer falls back to the standing session, the same state as a conversation that has not had a turn yet — until their next turn.
- Errors: `browser.producer.register requires a non-empty { conversation_id }` · `conversation '<id>' is served by agent '<other>', not '<agent>'` · `conversation '<id>' is not an active chat session for agent '<agent>' — register from inside the turn that serves it` · ``browser.producer.register `presentation` is not a presentation object: <serde error>``.
- **Authorization**: agent session only — `not authorized to use browser.producer.*: this connection is not a supervised agent (session.auth { token, agent_id })`.
- **WS-only** — no FFI binding.

#### `browser.producer.presentation` / `browser.producer.frame` (client → server notifications, no `id`)
- `browser.producer.presentation`: `{ presentation: Presentation }`. `browser.producer.frame`: `{ frame }`, the same shape as `browser.view.event`'s frame payload.
- Pushed by the agent process whenever its browser changes (presentation) or while a drawer is watching it (frame) — capture is **reference-counted at the producer**: 0→1 watching views asks the process to start capturing, 1→0 asks it to stop, so a browser nobody has a drawer open on pays for no CDP screencast and no WS traffic. Both are recognized and silently dropped, not errored, when the sending connection has no registered producer — and both fall through to the ordinary auth gate (which rejects and closes) on a connection that has not authenticated against a daemon that requires it.
- **A frame is capped at `MAX_PRODUCER_FRAME_BYTES` (8 MiB of base64) and dropped with a log above it.** A registered producer already runs arbitrary code on the box, so this is not a privilege boundary — but the daemon is the shared component, one frame fans out to every watching view, and the only bound underneath is tungstenite's 64 MiB message cap. A 1920x1080 quality-60 JPEG is a few hundred KB.
- **A frame reaches only the views somebody is actually watching.** A view with no subscribers is skipped entirely, and its cursor does not advance — which is invisible to a later subscriber, since `browser.view.subscribe` hands out the view's CURRENT cursor.
- **WS-only** — no FFI binding; no dispatch arm in `handler.rs` (intercepted ahead of method dispatch since a notification carries no `id`, the same shape as `agent.chat.event`'s interceptor).

#### `agent.browser.input`, `agent.browser.control`, `agent.browser.capture`, `agent.browser.host_connected` (daemon → agent reverse calls)
The mirror image of `agent.chat`: the DAEMON calls these on the agent process's own WS session — the same string-request-id / oneshot / response-demuxer machinery `agent.chat` uses — bounded by `RELAY_CALL_TIMEOUT` (30s).

- **`agent.browser.input`** — params are one of `{ op: "navigate", url }` · `{ op: "click", x, y }` · `{ op: "type", text }` · `{ op: "keypress", key, modifiers? }` · `{ op: "scroll", delta_y }` · `{ op: "paste", text }` · `{ op: "back" }` · `{ op: "forward" }` · `{ op: "reload" }` · `{ op: "tab_open" }` · `{ op: "tab_close", tab_id }` · `{ op: "tab_switch", tab_id }`. Returns `{ ok: true }` (plus `tab_id` for `tab_open`). Runs through the **same code** the in-daemon `browser.view.*` input path runs (`ViewInput::apply`), error strings included, and re-checks the control state in the process that owns the browser immediately before injecting — refused with `the agent holds control of this browser — call browser.view.take_control first` when the agent is driving and no sign-in is pending. Applied one at a time per process (the daemon dispatches each relayed call on its own task, so two keystrokes in flight can otherwise interleave mid-`apply`), and that wait is bounded at `INPUT_QUEUE_TIMEOUT`: an input still queued past it is refused with `the browser is still applying earlier input — the drawer gave up waiting for this one` rather than applied, because by then the daemon has already answered the drawer with an error and applying it would put a click on a page the person moved on from. Errors: `agent.browser.input requires { op }` · `` agent.browser.input `<op>` requires { <field> } `` · `` agent.browser.input `click` requires { x, y } `` · `` agent.browser.input `keypress` modifiers must be strings `` · `unknown agent.browser.input op '<x>'`.
- **`agent.browser.control`** — params `{ action: "take_control" | "hand_back" | "run_ended" | "holder_disconnected" | "grace_expired" }`. Returns `{ presentation, effects }` where `effects` is `[{ effect: "start_grace_period" }]` or `[{ effect: "sign_in_resolved", signed_in: bool }]` — they cross back because the daemon owns the clock the grace period runs on. An effect the daemon does not recognize is dropped rather than failing the transition, so a newer process talking to an older daemon can still hand control back. Errors: `agent.browser.control requires { action }` · `unknown agent.browser.control action '<x>' — use take_control, hand_back, run_ended, holder_disconnected or grace_expired`.
- **`agent.browser.capture`** — params `{ enabled: boolean }` → `{ ok: true }`. Toggles the agent process's frame pump; see the reference-counting note on `browser.producer.frame` above.
- **`agent.browser.host_connected`** — params `{ connected: boolean }` → `{ ok: true }`. Pushed on every transition the daemon observes: a connection authenticating as the host-management client, and the last host connection dropping. A supervised process has no read of the daemon's session set, so it CACHES this answer — and the cached value decides whether `browser_await_signin` returns the "open the CAR app" result or waits out its whole timeout pointing at a drawer that is not there. Refreshing it only from `browser.producer.register`'s ack meant a host that disconnected mid-run was never noticed. Broadcast fire-and-forget, one task per producer, so a wedged process delays neither the disconnect sweep nor the other producers — but SERIALIZED per producer, and a transition superseded while it waited its turn is collapsed rather than sent: unordered tasks meant a host flap (disconnect, immediate reconnect) could leave the process believing whichever call happened to finish last. Errors: `agent.browser.host_connected requires { connected }` — a malformed push leaves the process's belief unchanged rather than flipping it.
- **WS-only** — no FFI binding; no dispatch arm in `handler.rs` (reverse calls, like `agent.chat`).

#### `Presentation` object
Shared by `browser.view.event`'s `presentation` payload, `browser.view.subscribe`/`take_control`/`hand_back`'s `presentation` field, `browser.producer.presentation`/`browser.producer.register`'s `presentation`, and `agent.browser.control`'s `presentation`:

```jsonc
{
  "revision": 7,                    // u64; advances only on a real change; see the cursor note above
  "owner": "none",                  // "none" | "agent" | "user"
  "current_action": "Navigate https://x.test",         // string | null
  "pending_signin": "Sign in at accounts.example.com",  // string | null — the orange strip
  "blackout_active": false,
  "tabs": [
    { "id": "tab-0", "url": "https://x.test/", "title": "X",
      "active": true, "can_go_back": false, "can_go_forward": false }
  ],
  "active_tab": "tab-0",            // string | null — convenience projections of the active tab,
  "url": "https://x.test/",         // string | null   so a client does not have to scan `tabs`
  "title": "X"                      // string | null   to render the nav bar
}
```
`owner` maps 1:1 from the control reducer's owner state, matched exhaustively on the Rust side — a new owner state is a compile error, not a silent re-use of an existing wire name.

#### Constants
- `BROWSER_VIEW_CHANNEL_CAP = 32` — per-subscriber bounded channel on the drawer side.
- `CONTROL_GRACE = 30s` — how long control stays with a connection that dropped while holding it, before it reverts to the agent.
- `RELAY_CALL_TIMEOUT = 30s` — how long the daemon waits for a relayed `agent.browser.*` call to answer.
- `REPUBLISH_INTERVAL = 10s` — how often an idle supervised process re-checks that its browser is still published to the daemon; recovers from a daemon session lost between turns without waiting for the user's next message.
- `INPUT_QUEUE_TIMEOUT = 15s` — half `RELAY_CALL_TIMEOUT`; how long a relayed `agent.browser.input` waits behind an earlier one before it is refused instead of applied. The other half is left for the input to actually reach the page.
- `MAX_VIEWS_PER_PRODUCER = 8` — how many conversation views one supervised process keeps. `agents.chat`'s `session_id` is minted fresh per TURN, so a registration retires this producer's older views (and their conversation bindings) past this cap. Deliberately the same number as `MAX_KNOWN_CONVERSATIONS`, which is what the agent side re-publishes: nothing reachable is retired, nothing retired is reachable. A retired view a drawer is still subscribed to is kept.
- `MAX_PRODUCER_FRAME_BYTES = 8 MiB` — largest `browser.producer.frame` payload the daemon fans out; anything bigger is logged and dropped.
- `FRAME_PUSH_TIMEOUT = 5s` — bound on one `browser.producer.frame` push occupying the agent process's shared WS write mutex. Frames are the one writer here that is safe to drop (a stale frame is worthless; the next one is along shortly), so they are the writer that gives up rather than parking `agent.chat.event` token deltas, the heartbeat, and relayed-call responses behind them.


{% endraw %}
