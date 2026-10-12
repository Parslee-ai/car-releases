{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### a2a (in-core dispatcher — releases#28)

The 11 A2A v1.0 JSON-RPC methods (and their v0.3 slash aliases)
are dispatched in-core by `car-server-core` against an embedded
`car_a2a::A2aDispatcher`. Embedders that consume `car-server-core`
get A2A reachability automatically; no separate HTTP listener
required for JSON-RPC peers. Streaming (`message/stream` /
`SendStreamingMessage`, `tasks/resubscribe` / `SubscribeToTask`) returns
`MethodNotFound` from this transport — use
`car-server`'s `--a2a-bind` HTTP+SSE listener for streaming peers.

| v1.0 PascalCase | v0.3 slash form |
|---|---|
| `SendMessage` | `message/send` |
| `SendStreamingMessage` | `message/stream` |
| `SubscribeToTask` | `tasks/resubscribe` |
| `GetTask` | `tasks/get` |
| `ListTasks` | `tasks/list` |
| `CancelTask` | `tasks/cancel` |
| `CreateTaskPushNotificationConfig` | `tasks/pushNotificationConfig/set` |
| `GetTaskPushNotificationConfig` | `tasks/pushNotificationConfig/get` |
| `ListTaskPushNotificationConfigs` | `tasks/pushNotificationConfig/list` |
| `DeleteTaskPushNotificationConfig` | `tasks/pushNotificationConfig/delete` |
| `GetExtendedAgentCard` | `agent/getAuthenticatedExtendedCard` |

All take per-method params per the
[A2A v1.0 spec](https://a2aproject.github.io/A2A/) and return the
per-method result. Embedders wanting to plug in a custom
`AgentCardSource` (e.g. tokhn-style tools) or `TaskStore` use
`ServerStateConfig::with_a2a_card_source` /
`with_a2a_store` / `with_a2a_runtime` before constructing
`ServerState`.

### a2a

Lifecycle for the in-process Agent2Agent (A2A) v1.0 listener. Same `car-a2a` HTTP service `car-server --a2a-bind` exposes, but driven over JSON-RPC so embedders can spin it up from their own daemon without the CLI flag. Process-global state holds the bound listener and join handle so a later `a2a.stop` / `a2a.status` reaches the right server.

The same lifecycle is reachable from the FFI bindings as `startA2AServer` / `stopA2AServer` / `a2AServerStatus` (NAPI — each takes the `CarRuntime` first; napi-rs camelCases `a2a` → `A2A`) and `start_a2a_server` / `stop_a2a_server` / `a2a_server_status` (PyO3), wired through `car-ffi-common::a2a`. JSON-RPC and FFI share the same process-global state, so a server started over JSON-RPC can be queried from the bindings and vice versa.

The spawned `car_engine::Runtime` is fresh — engine builtins via `register_agent_basics()`, no shared state with the per-WebSocket session runtime or the embedder's `CarRuntime`. Sharing state with the caller's runtime is future work.

#### `a2a.start`
- **Params**: `{ bind: string, public_url?: string, agent_name?: string, agent_description?: string, organization?: string, organization_url?: string, share_session_runtime?: boolean, allow_non_loopback_bind?: boolean }`
- **Returns**: `{ bound: string }`
- Errors if a server is already running, the bind fails, or `bind` is malformed. `bind` accepts `host:port` (use `127.0.0.1:0` to ask the kernel for an ephemeral port, then read it back from `bound`). `public_url` defaults to `http://<bound>`; everything else has reasonable defaults.
- **`agent_name` defaults to the user's chosen assistant name** (see
  [`assistant.identity.*`](assistant.md#assistant)) when they have set one, and to
  `"Common Agent Runtime"` when they have not. A conversational A2A message
  routes to the flagship agent's own loop, so a card reading "Common Agent
  Runtime" while the replies come back from something calling itself "Jarvis"
  names the same thing two ways. The unnamed case is left byte-identical on
  purpose: a card name is also a discovery identifier a peer may key on, so a
  deployment where nobody named their assistant sees no change. An explicit
  `agent_name` always wins.
- **`share_session_runtime`** (default `false`): when `true`, the A2A dispatcher uses *this* WS session's runtime, so tools the session registered (`tools.register`) appear on the Agent Card's `skills` and a peer `message/send` is served by this session:
  - a message carrying an explicit tool invocation (a `data` part `{ "tool", "parameters" }`) routes to the session's `tools.execute` callback;
  - a purely **conversational** message (free text, no tool `data` part) routes to the session's **`agent.chat`** handler — the daemon reverse-calls `agent.chat` on this session, aggregates the streamed `agent.chat.event` deltas (5s to ack, then a 180s cap on the full reply), and returns the reply as the A2A agent message (car-releases#65). A session that doesn't handle `agent.chat` never acks, so the call falls back to the `"Acknowledged."` acknowledgement after the ~5s ack timeout.
  With `share_session_runtime: false` (or started off a non-WS path), a conversational message keeps the `"Acknowledged."` acknowledgement — CAR's runtime executes proposals but does not itself plan.
- **`allow_non_loopback_bind`** (default `false`): required to bind anything other
  than loopback. This listener serves **no authentication** — there is no auth
  parameter, and its router is `NoAuth` — and with `share_session_runtime: false`
  its runtime registers the agent-basics filesystem tools, so a reachable bind
  publishes `write_file`/`edit_file` to anyone who can route to the port. A
  wildcard bind (`0.0.0.0:…`) is refused too, being the most reachable of all.
  The same explicit-opt-in rule `a2a.peers.add` and `a2a.send` already apply to
  their endpoints. **If you want to be reachable by other CAR daemons, you do
  not want this** — `car-server` runs a peer-authenticated, messaging-only
  listener for that by default (see `docs/a2a.md`).

#### `a2a.stop`
- **Params**: `{}`
- **Returns**: `{ stopped: true }`
- Errors if no server is running. Aborts the spawned task — Axum has no graceful-shutdown hook on the listener, same seam as `tasks/cancel` in the bridge itself.

#### `a2a.status`
- **Params**: `{}`
- **Returns**: `{ running: true, bound: string, uptime_secs: number }` when up, `{ running: false }` otherwise. Never errors — polling code doesn't have to distinguish "not running" from a failure.

#### `a2a.send`
- **Params**: `{ endpoint: string, message: A2AMessage, blocking?: boolean = false, ingestA2ui?: boolean = true, routeAuth?: A2aRouteAuth, allowUntrustedEndpoint?: boolean }`
- **Returns**: `{ result: SendMessageResult, a2ui: { applied: A2uiApplyResult[] } }`
- Sends an A2A `SendMessage` request to a peer endpoint. When `ingestA2ui`
  is true, CAR scans the returned task/message for A2UI envelopes, stores any
  surfaces, records a trusted peer endpoint as the A2A owner, and broadcasts
  the resulting `a2ui.surface_updated` events to host subscribers. `routeAuth`
  is also used for the initial send and persisted server-side for later
  `a2ui.action` continuations when a route endpoint is stored.

#### `a2a.peers.add` / `a2a.peers.list` / `a2a.peers.remove`
- Registry of remote A2A peers CAR can **discover** across (`discovery.resolve` resolves a need into a registered peer's advertised skills). File-backed at `~/.car/a2a-peers.json`. Reachable from the language bindings via the generic `a2a_dispatch(method, paramsJson)` proxy.
- `a2a.peers.add` — **Params** `{ url: string, label?: string, allowUntrusted?: boolean }`. **Returns** the `PeerEntry` `{ slug, url, label? }`. Validates `url` is http(s), canonicalizes it (trailing-slash/default-port dedup), derives a unique identifier-safe `slug` from its host (the `organization` segment of that peer's skill identifiers), rejects a duplicate URL. **Trust gate** (SSRF guard, mirrors `a2a.send`): a non-loopback `url` is refused unless `allowUntrusted` is true — registering a peer means discovery will issue an outbound GET to it.
- `a2a.peers.list` — **Params** `{}`. **Returns** `{ peers: PeerEntry[] }`.
- `a2a.peers.remove` — **Params** `{ slug: string }`. **Returns** `{ removed: boolean }`.


{% endraw %}
