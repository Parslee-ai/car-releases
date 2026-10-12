{% raw %}
# CAR WebSocket Protocol Reference

`car-server` exposes the runtime over a WebSocket using JSON-RPC 2.0. This is the **language-agnostic surface** for CAR — anything that can speak WebSocket and JSON can drive it.

As of **v0.8.0**, the WebSocket protocol is the only runtime entry point. The Node.js (`car-runtime` on npm) and Python (`car-runtime` on PyPI) bindings are thin clients that proxy every method over this same WebSocket — the embedded-engine fallback they shipped through v0.7.x has been retired (#139). For every consumer on a host, one daemon, one admission semaphore, one model cache.

Use the bindings when you want the ergonomic per-language API. Use the WebSocket directly when you're building from a language without bindings. NAPI, PyO3, and UniFFI also expose a generic daemon bridge for methods that do not yet have a typed wrapper, including server-initiated request and notification handlers.

## Binding escape hatch and JSON-RPC errors

The package escape hatches accept JSON strings so the generated ABI does not change whenever a daemon request shape grows:

- Node: `CarRuntime.daemonCall(method, paramsJson)` and `daemonCallHostManagement(...)` return result JSON. Rejected Promises carry the daemon's numeric `.code`, `.message`, and optional `.data`. `registerDaemonHandler(method, async paramsJson => resultJson)` and `registerDaemonNotificationHandler(method, paramsJson => {})` service arbitrary reverse calls.
- Python: `CarRuntime.daemon_call(...)` and `daemon_call_host_management(...)` return result JSON. Daemon rejections raise `DaemonRpcError` with `code`, `message`, and optional `data` attributes. `register_daemon_handler` and `register_daemon_notification_handler` install the reverse-call equivalents; Python callables run on dedicated OS threads rather than the daemon client's Tokio workers.
- Swift/Kotlin UniFFI: `CarDaemonClient.daemon_call(...)` returns result JSON and reports daemon rejections as `CarError.DaemonRpc { code, message, data_json }`. `DaemonHandler` and `DaemonNotificationHandler` provide the reverse-call bridge.

The host-management twins retain the client's strict local allowlist and refuse non-host methods before reading or sending the host token. Generic calls do not bypass authentication, protocol negotiation, role gates, policy, approvals, or any other daemon admission check.

The dispatcher follows standard JSON-RPC classification: an `unknown method: ...` response has code `-32601`; request parameter extraction/deserialization failures have code `-32602`; an actual handler failure remains `-32603`. Every `-32602` message retains the missing or malformed field detail (for example, `invalid params: key is required`) rather than collapsing to opaque internal-error text. Callers must use the numeric code—not English text—to distinguish reachability from a malformed request or an internal failure.

#### `capabilities.list`

Runtime discovery for clients that cannot read files or run `car capabilities`.

- **Params:** `{}`.
- **Returns:** `{ caller_role, count, methods: [{ method, role }] }`, sorted by method through the generated capability table. Each role is one of `agent`, `owner`, `operator`, or `host` and is the same derived role published in the generated capability manifest (`car capabilities --json`, car.parslee.ai/capabilities.json).
- **Filtering:** an agent-scoped session receives `agent`, resource-conditional `owner`, and ungated `operator` rows, but never `host`; an unbound daemon session receives `operator`; a host-management session receives `host`, `owner`, and `operator`. Ownership remains checked against the concrete resource when an owner method is called.

The package form is `daemonCall("capabilities.list", "{}")` / `daemon_call("capabilities.list", "{}")`: the second argument is a JSON string even though the wire params are an object. The generated typed forms are `capabilitiesList("{}")` and `capabilities_list("{}")`.

## Transport

```bash
car-server --port 9100
```

Default port `9100`. Each WebSocket connection is its own session — runtime state, registered tools, policies, and memory are per-connection.

## Protocol version

The JSON-RPC surface carries a **wire protocol version** (`car-proto::PROTOCOL_VERSION`, currently `3`) that is **independent of the package semver** — it is bumped only on a backward-incompatible change to request/response shapes or method semantics, not on every release. Protocol v3 adds immutable model/catalog identity and capability-negotiated inference controls; the two identity capabilities are mandatory for bundled v3 clients.

Clients negotiate it with `server.handshake`, run once after `session.auth` and before the main request loop:

```json
// → client request
{"jsonrpc": "2.0", "id": 1, "method": "server.handshake",
 "params": {"protocol_version": 3, "client_version": "0.51.0",
            "required_capabilities": ["infer.model-identity.v1", "models.catalog-identity.v1"],
            "optional_capabilities": []}}
// ← server reply
{"jsonrpc": "2.0", "id": 1,
 "result": {"protocol_version": 3, "server_version": "0.51.0", "client_protocol_version": 3,
            "client_version": "0.51.0",
            "assistant_name": "Jarvis",
            "assistant_aliases": ["hey jarvis", "ok jarvis", "jarvis"],
            "assistant_brand": "Parslee Core",
            "negotiated_capabilities": ["infer.model-identity.v1", "models.catalog-identity.v1"]}}
```

The three `assistant_*` fields carry the name this user chose for the flagship
assistant (see [`assistant.identity.*`](websocket-protocol/assistant.md#assistant)). They ride on the handshake
every client already performs, so a host can render "Ask Jarvis" on its first
frame and its in-app wake matcher can listen for the right word immediately —
no extra round trip, and no window where the composer offers one name while the
agent answers to another. They are **additive**, so they did not bump
`PROTOCOL_VERSION`: an older client ignores them and keeps its built-in
defaults. `assistant_brand` is the fixed product name and never changes.

Protocol v3 is exact-version and fail-closed:

- On an auth-enabled daemon, await a successful `session.auth` response first; request dispatch is concurrent, so pipelining `server.handshake` before that response can race the auth gate.
- `host.subscribe` and every `auth.*` method return `-32005` (`protocol handshake required:`) until the current WebSocket session has negotiated the exact version. This prevents a legacy host from opening a browser flow it cannot safely complete.
- A missing, non-numeric, or differing request version returns `-32006` (`protocol version mismatch:`) and does not negotiate the session. A same-v3 repeat is idempotent.
- `required_capabilities` and `optional_capabilities` must be arrays of non-empty strings. Unsupported mandatory entries return `-32008` (`protocol capability mismatch:`) and do not negotiate; unsupported optional entries are ignored. A success returns the sorted, deduplicated `negotiated_capabilities`.
- Bundled v3 clients require `infer.model-identity.v1` and `models.catalog-identity.v1`, and fail closed if a nominally successful reply omits either. `infer.cancel.v1` and `infer.deadline.v1` are optional and must not be inferred from protocol version alone.
- `feedback.v1` is optional and gates every `feedback.*` method: a negotiated v3 session that did not request it is refused with `-32008` (`protocol capability mismatch:`) naming the capability. The bundled host requests it as an optional capability so an older daemon still connects.
- Negotiation is per connection. A reconnect starts unnegotiated and repeats `session.auth` (when enabled) → `server.handshake` → `host.subscribe`.
- Bundled clients reject an old daemon's unknown-method response, a malformed success, and a handshake timeout instead of proceeding on an unproven protocol.

The bundled NAPI/PyO3/UniFFI clients run this handshake automatically (via
`car-daemon-client`), the in-tree CLI negotiates on every raw daemon connection,
and the native macOS/iOS/Android/Windows hosts negotiate before subscribing.
The bindings expose the constant as `protocolVersion()` /
`protocol_version()`.

`client_version` is the build the *client* reported in its request, echoed back
(truncated to 64 characters, since it is client-controlled). It is an echo, not
a census — a client that reports nothing reads back `unknown`, which today
includes the native CarHost macOS/iOS/Android clients and the web dashboard.
It matters because it is otherwise unobservable: on macOS `car --version` reads
`/usr/local/bin/car`, a symlink into `CarHost.app`, so it answers for the bundled
CLI — a different component from the `car-runtime` npm/PyPI package that may have
made the call. The bindings expose their own build as `clientVersion()` /
`client_version()` (and Python `car_runtime.__version__`), and the daemon's
version-skew notice names whichever of the two is actually stale plus a command
that reaches it (Parslee-ai/car#1050). Echoing is additive — an older client
ignores the field.

## Sibling endpoints on the same daemon

`car-server` binds three endpoints by default — one daemon, three transports for different consumer shapes:

- **WS `ws://127.0.0.1:9100/`** — this document. JSON-RPC 2.0 over WebSocket; full surface.
- **HTTP `http://127.0.0.1:9101/`** — embedded dashboard (browser-attached monitoring). Read-only.
- **MCP `http://127.0.0.1:9102/mcp`** — Model Context Protocol HTTP-streamable endpoint. Lets any MCP-aware client (Claude Desktop, Cursor, Claude Code's `--mcp-config`, Codex, custom GPTs, third-party agents) call a focused subset of CAR's capabilities. POST one JSON-RPC 2.0 request, get one response. `GET /mcp/health` is a liveness probe.

The MCP endpoint shares the daemon's memgine with WS — facts ingested via MCP `tools/call memory_add_fact` show up in WS `memory.query` and vice versa, and MCP agents can call proactive memory tools such as `memory_save_procedural`, `memory_intervene`, and `memory_evaluate`. Override the bind address via `--mcp-bind <host:port>` or `CAR_MCP_BIND`; pass `disabled` to skip the listener entirely. See `docs/cookbook/07-mcp-server.md` for client wiring examples and the per-tool schema list.

**`initialize` negotiates the protocol version.** The `initialize` result carries back the `protocolVersion` the client asked for when it is one this server supports (`car_mcp::SUPPORTED_VERSIONS` — `2024-11-05`, `2025-06-18` and `2025-11-25` today). Absent, non-string, and unsupported all get `car_mcp::PROTOCOL_VERSION` (`2025-11-25`, the newest entry) instead, as a normal result rather than a JSON-RPC error, leaving the client to proceed or disconnect. The append-plus-move design is what makes each bump safe: a client still asking for `2024-11-05` keeps getting it back rather than being handed a revision it never asked for, and nothing is ever dropped from the list. `2025-03-26` is deliberately absent — that revision makes receiving JSON-RPC batches a MUST, which this server does not implement; `2025-06-18` removed batching again.

**On `2025-11-25`.** Its one normative server requirement is on this HTTP transport — servers must answer `403` to an invalid `Origin` — which CAR has done since before the revision (see the `Origin` table below). Everything else in the delta is a capability a server declares or declines, and CAR declines all of them: no `tasks` (experimental), no icon metadata, no OAuth/OIDC discovery on this transport, and the elicitation and sampling additions extend *client* capabilities CAR-as-server never invokes. One behavioural change rides with it, and it is the only part an *older* client also sees: that revision says input validation errors *should* be returned as tool execution errors, so on `tools/call` an argument CAR's tool schema rejects now comes back as an `isError: true` result rather than a JSON-RPC `-32602`. The envelope is unchanged — a request that fails the `CallToolRequest` schema itself (no `name`, or a non-object `arguments`) is still `-32602`, as is an unknown tool. It applies whatever revision a client negotiated: dispatch is stateless and does not record that, `isError` has existed since `2024-11-05` so the shape is legal in every revision CAR speaks, and the item is a clarification rather than a new wire feature. Clients must check `isError` rather than treating a non-null `result` as success.

**`outputSchema` / `structuredContent` (2025-06-18).** Tools whose result is a JSON object declare an `outputSchema` in `tools/list`, and their `tools/call` results carry `structuredContent` — the parse of the same serialization the text block already holds, so a `2024-11-05` client reads identical data from `content[0].text`. Array- and prose-valued tools (`memory_query`, `skill_find`, `skill_list`, `memory_add_fact`, `skill_ingest`) declare no `outputSchema` and never emit `structuredContent`, because the spec requires it to be an object and wrapping would desynchronize the two representations. Elicitation is not declared (it is a client capability; CAR-as-server never initiates one) and `resources/templates/list` stays unimplemented by decision — every URI CAR exposes is fully enumerable through `resources/list`.

**A notification POST returns `202 Accepted` with an empty body.** A JSON-RPC message with no `id` has no reply, so `POST /mcp` answers it with a bare 202 — do not parse the body.

**Each daemon HTTP client gets a peer identity.** A successful `initialize` response includes `MCP-Session-Id`; send that header on every later POST. That header is a **bearer credential** — treat it the way you would a token, and never publish it. CAR mints a SEPARATE, unforgeable peer id at `initialize` and derives the sender as `mcp:<peer-id>` from that, so concurrent CLI sessions no longer share an audit principal and no principal discloses the value that authenticates its session. `peer_list` publishes names to every caller, so a name derived from the credential would hand one session the means to act as another. A receive-capable session appears in `peer_list` as kind `mcp_session`, and `peer_inbox {limit?}` drains only its queue (default/max 50). The ordinary peer guards apply independently to each session: serialized-size cap, identical-repeat window, 20 messages per sender per recipient per minute, and 50 unread queued messages. `DELETE /mcp` with the session header removes the address and unread queue; 24 hours without a request does the same for clients that disappear without DELETE. An unknown/expired supplied session id gets HTTP 404. Calls that omit the header can still use older non-peer tools, but `peer_list`, `peer_message`, `peer_inbox`, and the node tools refuse rather than falling back to a shared sender.

**Lattice tools.** The same endpoint serves `lattice_join`, `lattice_leave`, `lattice_nodes`, `lattice_find`, `lattice_claim`, `lattice_release`, `lattice_claims`, and `lattice_wait`, which mirror the `lattice.*` methods documented under the method reference, keyed on the session's `mcp:<peer-id>`. The operator-only `lattice.requests` and `lattice.respond` are deliberately **not** MCP tools: an MCP session is never the operator. `peer_message` accepts the same optional `kind` and `in_reply_to` as `agents.message`, can address a human node as `human:<name>`, and `peer_list` rows carry each peer's `node` profile (or `null`) and include human nodes. Nothing pushes to an MCP client, so every node tool result, `peer_list`, and `peer_message` include `inbox_pending` — the session learns it has mail the next time it calls any of them.

CAR-spawned batch CLIs remain send-only. Their generated MCP URL carries `car-mcp-mode=batch`; initialize still gives the child a distinct sender principal, but CAR omits it from the peer directory and `peer_inbox` refuses it. This keeps `PeerKind::ExternalCli`'s closed-stdin lifecycle separate from `PeerKind::McpSession`.

**The push channel is declined** (car#972 Track B). CAR's MCP server sends no server-initiated messages on either transport, by decision: stdio is a strict request/response loop with exclusively-owned stdout, and HTTP offers no response stream. The daemon now retains a small protocol-session identity and a polled peer inbox, but neither is a sink and neither can emit a notification. Concretely:

- `initialize` advertises `subscribe: false` and `listChanged: false` on `resources`, `listChanged: false` on `prompts`, no `listChanged` on `tools`, and **no `logging` capability**. These are the decision, not a gap — a host reads them and simply does not subscribe.
- A client that asks anyway gets the documented method-not-found: `resources/subscribe`, `resources/unsubscribe`, and `logging/setLevel` are all answered `-32601`.
- **`GET /mcp` returns `405 Method Not Allowed`** (with `Allow: POST, DELETE`) — the streamable-HTTP spec's branch for a server that offers no SSE stream. The old SSE sink registry and its `push_to_session` primitive remain removed.

Adding push would still require per-connection sinks, a writer handle through the stdio loop, subscriptions, and `logging/setLevel`; the polling inbox does not supply any of those pieces.

**`Origin` validation on `/mcp`** (DNS-rebinding protection, required by the MCP HTTP transport). The rule is absent-permissive, present-strict:

| `Origin` header | Result |
|-----------------|--------|
| absent | **allowed** — a browser always sends `Origin` cross-origin, so its absence cannot be a browser attack. This is what keeps `curl`, Claude Desktop, Cursor, Claude Code `--mcp-config`, Codex, and CAR's own connectors client working: none of them send one. |
| loopback — `http`/`https` on `localhost`, `127.0.0.0/8`, or `::1`, any port | **allowed** |
| anything else, including the literal `null` (sandboxed iframe, `file://`, redirected cross-origin) | **`403`** with `{"error":"origin not allowed"}` |

`POST /mcp` and `DELETE /mcp` are guarded; a rejected request never reaches dispatch or session teardown. `GET /mcp` needs no guard — it is a constant `405` with no side effect (see the push-channel decline above). **`GET /mcp/health` is exempt** — it has no side effect and no secrets, and the documented uptime `curl` plus browser probes must keep working.

The rule does not widen for a non-loopback `--mcp-bind`: a wildcard bind's host is `0.0.0.0`, which never appears as an `Origin` value, and wider exposure makes the guard more important, not less. To serve browser traffic from another origin, front the daemon with a reverse proxy that owns its own CORS/`Origin` policy.

**`MCP-Protocol-Version` on `/mcp`.** Once a client has negotiated a revision on `initialize`, the HTTP transport asks it to name that revision on every later request. Same absent-permissive, present-strict shape as `Origin`:

| `MCP-Protocol-Version` header | Result |
|-------------------------------|--------|
| absent | **allowed** — requiring the header would break every client that predates it, and the 2025-06-18 delta on this surface is additive result keys an older client ignores, so dispatch answers a silent client correctly whichever revision it negotiated |
| a value in `car_mcp::SUPPORTED_VERSIONS` (`2024-11-05`, `2025-06-18` or `2025-11-25` today) | **allowed** |
| anything else, including an empty or non-UTF-8 value | **`400`** with `{"error":"unsupported MCP-Protocol-Version","requested":"…","supported":["2024-11-05","2025-06-18","2025-11-25"]}` |

`POST /mcp` is guarded before the JSON-RPC parse, so a rejected request runs no tool; `DELETE /mcp` uses the same check before session teardown. `GET /mcp` needs no guard — it is a constant `405` whatever the header says. **`GET /mcp/health` is exempt** — a client whose version we just rejected reads `protocol_version` off that probe to learn what we speak.

A foreign value is a `400` rather than a silent downshift because the header states which dialect the client will read the reply in; answering in a revision it never agreed to is the inversion `initialize` negotiation exists to prevent. The `400` body names the supported list so a client that guessed wrong can correct itself. CAR's own MCP *client* (`car-connectors`) already sends this header with the version it negotiated, so it is unaffected.

**`completion/complete` is served here too** (car#972 §4), and it changes nothing about the endpoint's no-push posture: argument autocompletion is one POST in, one response out. `initialize` advertises `"completions": {}` on both transports. It completes the `car_context` prompt's `mode` argument and resource URIs by prefix; a request naming something CAR does not know returns an empty completion, while a request that names nothing to complete at all (no `ref`, no `argument`, no `argument.name`) is `-32602`. Full semantics in `docs/CAR_AGENT_AUTHORING_GUIDE.md`.

#### The assistant tools (`assistant_start` / `assistant_poll` / `assistant_cancel`)

**On the daemon endpoint only.** The MCP tool list is per-`Server`, and the daemon registers three tools the stdio binary (`car-mcp-server`) does not: it has no `Runtime` and no inference engine, so it answers `assistant_start` with a `-32601` "unknown tool". Delegate with `car do --json` there instead.

An assistant run takes minutes, so `assistant_start` returns a handle immediately rather than blocking a `tools/call` that most hosts would time out. The `run_id` remains application state the *client* carries between calls, separate from the transport's MCP session id and peer inbox.

| Tool | Arguments | Result |
|---|---|---|
| `assistant_start` | `task` (required), `cwd?`, `until?`, `max_turns?` (default 50, max 200), `local?` (default false), `model?`, `invoked_by?`, `org?`, `personal?` | `{ run_id, status: "running", poll_after_ms, sandbox, ancestry }` |
| `assistant_poll` | `run_id` (required), `since_seq?` (default 0) | `{ run_id, status, events, next_seq, events_skipped, ancestry, created_at }` plus `poll_after_ms` while running or `result` once terminal |
| `assistant_cancel` | `run_id` (required) | `{ run_id, status: "cancelled" \| "already_terminal" \| "unknown" }` |

**The poll envelope is the `car.do/1` envelope.** `events` are exactly the JSONL progress events `car do --json` writes to stderr, each with a `seq` added. A terminal poll's `result` is exactly the `car.do/1` document `car do --json` writes to stdout — `summary`, `turns`, `model_used`, `receipts`, `ungrounded_claims`, `sandbox`, `elapsed_seconds`, and `goal` for an `until` run — including its truncation caps. Both are documented in `docs/car-do-json.md`; there is no second envelope to learn.

Read `status` twice. The poll's own `status` (`running` | `ok` | `error` | `cancelled`) describes the **handle**; `result.status` (`success` | `max_turns` | `stalled` | `goal_pending` | `cancelled` | `error`) describes the **work**. A run that stopped at its turn cap is `status: "ok"` with `result.status: "max_turns"`; so are `stalled` (the loop stopped making progress) and `goal_pending` (an `until` run whose check never passed). Handle-`ok` means "the loop reached a terminal outcome", not "the work succeeded" — read `result.status` for that, and match it exhaustively rather than assuming the set above is closed.

Bounds, all reported rather than implied:

- **8 concurrently *executing* runs.** A 9th `assistant_start` is refused with `isError: true` naming the cap — refused, never queued. A run releases its slot the moment it stops, so polling one to a terminal status frees a slot immediately; the finished record stays pollable until it ages out.
- **A 1-hour idle TTL** measured from the last poll. A run nobody polls is cancelled *and dropped*, including one still executing: an abandoned run bills model tokens to nobody.
- **A 2000-event buffer**, trimmed at the head. `events_skipped` is how many events were dropped before your `since_seq`, so a gap is stated and never silent. Surviving events keep their original `seq`. A poll returns everything at or after `since_seq` with no per-poll cap, so `since_seq: 0` on a long run can hand you all 2000 at once — pass `next_seq` and poll incrementally, because every one of those events lands in the calling model's context.
- **No cap on retained *records*.** The 8-run limit counts executing runs; a terminal record stays pollable (with its events) until the idle TTL reaps it. A client that starts many short runs and never polls them again holds those buffers for up to an hour.

`assistant_cancel` lands at the next **turn boundary**, not mid-model-call — expect one more turn's worth of activity, then poll for the document describing what the run had done. Cancelling a finished or unknown run is a successful no-op.

**A run handle is not a durable record.** The registry is in memory: after a daemon restart every `run_id` is unknown, and `assistant_poll` returns `isError: true` saying so rather than an empty `running` forever. A run whose task dies without producing an outcome is likewise settled by the next poll, as `status: "error"` with a `car.do/1` `result` naming `run_task_died` — a dead run is never reported as still running.

Execution posture matches `car do`: sandbox-first (Docker, no network), and `local: true` binds at the `ReadOnly` tier, where `write_file`, `edit_file`, and `shell` are all refused — an MCP tool call has no transport to ask a human for approval, so a gated tool is denied rather than queued. `until` therefore requires the sandbox and is refused up front on a ReadOnly binding. Send `invoked_by` (`claude-code`, `codex`, `gemini`) if your host is itself an agent CLI: the daemon is not spawned by its callers, so its own `$CAR_INVOKED_BY` cannot answer who is calling. The id is merged with the daemon's own chain (read once at startup, not per request) and the result is **recorded on the run and echoed by every poll** as `ancestry`. Recorded, not enforced — nothing on this surface spawns an external agent, so there is no adapter to refuse; what closes the CAR → `shell` → agent CLI → CAR cycle here is the execution posture above.

A run works in an organization by `car do`'s rule (proposal §9): `org` (an org id you are signed in to) or `personal: true`, never both. With neither, the repository's declared org under `cwd` applies, then your default org, then personal work. A context that cannot be used refuses the start and names the fix, and a repository that declares an org refuses `personal`. A bound run's model calls go out in that org. Its memory, learned repairs and trajectories stay in that org's private store, and it gets only that org's own-account tools. The run's car.do/1 documents report the binding as `work_context`, `null` for personal work.

Loopback reachability is not caller identity. Every `assistant_start` that resolves to an organization requires `Authorization: Bearer <generic-daemon-token>` on that HTTP request, and every later `assistant_poll` or `assistant_cancel` for its handle requires the same per-launch token. The token is an HTTP header, never a tool argument shown to the model. Missing or invalid credentials return a tool result with `isError: true` before a run starts or an existing org handle is read or changed. Personal runs retain their token-free behavior. On an explicitly auth-disabled daemon (`--no-auth` / `CAR_NO_AUTH=1`) there is no per-launch token, so this gate is a no-op like `session.auth`; that mode keeps its documented trusted single-user posture. The listener restriction remains in addition to authentication: bound beyond loopback with `CAR_MCP_BIND`, the endpoint refuses any run that would bind even with a valid token, and only `personal: true` runs there.

#### Daemon-only tool groups: eventlog, workflow, scheduler (car#972 Track C)

The production daemon registers the six read tools by default. Calls to this
daemon tool group require
`Authorization: Bearer <generic-daemon-token>` on each HTTP request; tenant
binding uses `X-Car-Tenant-Id`. Supervised-agent credentials are unsupported:
requests carrying `X-Car-Agent-Id` are explicitly refused before dispatch, so
they cannot replace a live agent connection or silently lose its identity.
Agents must use their existing WebSocket connection. The bridge
passes these credentials through `session.auth` and protocol negotiation on a
fresh daemon session for each invocation. Missing or invalid credentials fail;
no daemon, host, environment, or disk credential is substituted. Host-management
elevation is not supported through this bridge. Requests never share an
authenticated connection. Offline stdio still omits these tools. Organization-bound assistant handles use
the same per-request bearer header; personal assistant runs and other MCP tools
retain their existing authentication behavior.


Three more groups register through the same per-`Server` seam as the assistant trio (`car_mcp::register_daemon_tools`, given a `car_mcp::DaemonClient` that carries the caller's session authority). Each tool is a **thin adapter over an existing daemon JSON-RPC method** — arguments forwarded verbatim as the method's params, the method's result serialized verbatim as the tool text (plus `structuredContent` where the result is a JSON object) — so the daemon handler stays the single implementation and the single authority check: a bound agent token sees exactly what the same method would give it over WS. On stdio none of these exist (`-32601`), by design.

| Tool | Daemon method | Notes |
|---|---|---|
| `events_query` | `events.query` | audit-trail query; same `EventQuery` params |
| `events_stats` | `events.stats` | event/span counts |
| `events_cost_by_agent` | `events.cost_by_agent` | per-agent token/cost receipts; array result, text only |
| `workflow_verify` | `workflow.verify` | pure static manifest check |
| `workflow_list_paused` | `workflow.list_paused` | resumable approval gates; array result, text only |
| `scheduler_list` | `tasks.list` | scheduled command tasks; array result, text only |
| `workflow_run` † | `workflow.run` | runs real stages — `openWorldHint: true`, `destructiveHint: true` |
| `workflow_resume` † | `workflow.resume` | continues side-effecting stages |
| `scheduler_schedule` † | `tasks.schedule` | can install a durable OS schedule (launchd/cron/schtasks) |
| `scheduler_unschedule` † | `tasks.unschedule` | removes the OS schedule and the stored task |

† **Mutating tools are opt-in.** The read surfaces register whenever the embedder supplies a daemon client; the four mutating/triggering tools register only when the embedder sets `DaemonToolOptions { enable_mutations: true }`, because an MCP host may auto-approve unattended and a workflow stage or scheduled program can do anything the runtime can. When not enabled they are absent from `tools/list` and a call is `-32601` — absent, not advertised-but-broken.

**External-agent invocation is deliberately excluded** from this surface. The fourth §6 group is blocked on the §7 ancestry gap: the recursion guard decides from process environment (`$CAR_INVOKED_BY` via `ancestry()`), while the daemon path only records a per-call caller — exposing invocation over MCP before that gap closes would let a nested agent bypass the guard. It stays off this surface until §7 lands.

These are MCP **tools**, not JSON-RPC methods — nothing was added to the WS dispatcher, and `scripts/check-ffi-parity.sh` is unaffected.

On macOS and Linux, `car-server` also binds a Unix Domain Socket — at
`$XDG_RUNTIME_DIR/ai.parslee.car/car-server.sock` when that variable is set,
otherwise `$car_dir/run/car-server.sock` (where `$car_dir` is the state root,
below). Local FFI consumers can prefer the UDS to skip the TCP listening port and any localhost firewall prompts. The wire format is identical — same JSON-RPC, same auth handshake.

### The state root (`CAR_HOME`)

Everything the daemon persists lives under one directory, `~/.car` by default.
Set `CAR_HOME` to an absolute path and all of it moves together:

| Default | With `CAR_HOME=/tmp/car-alt` |
| --- | --- |
| `~/.car/…` — journals, `agents.json`, `tasks/`, `registry/`, `memory/`, `approvals.jsonl`, `logs/`, `coder/`, `projects/`, `version.json`, … | `/tmp/car-alt/…` |
| `~/.car/run/car-server.sock`, `~/.car/run/daemon.lock`, `~/.car/run/*.pid` | `/tmp/car-alt/run/…` |
| `~/.car/models/` — the small state files that sit beside the weights: `discovered_models.json`, `outcome_profiles.json`, `outcome_ledger.jsonl`, `key_pool_stats.json`, `benchmark_priors.json` | `/tmp/car-alt/models/…` |
| the per-platform auth-token dir (`~/Library/Application Support/ai.parslee.car` on macOS, `$XDG_RUNTIME_DIR`/`~/.config/ai.parslee.car` on Linux, `%LOCALAPPDATA%\ai.parslee.car` on Windows) | `/tmp/car-alt/ai.parslee.car/…` |

Three things to know:

- **The auth token and the socket move too.** They are the pair Parslee-ai/car#629 saw one daemon take from another, so an override that left them behind would not actually isolate anything. `XDG_RUNTIME_DIR` stops deciding the socket path when `CAR_HOME` is set, for the same reason — it is per-*user*, so honouring it would put two relocated daemons back on one socket.
- **Narrower overrides still win — with one deliberate exception.** `CAR_SERVER_SOCKET`, `CAR_AUTH_TOKEN`, `--journal-dir`, `--agents-manifest`, `CAR_CODER_STATE_DIR`, `CAR_PROJECTS_DIR` and friends all take precedence where they are set, so `CAR_HOME` sets the floor rather than a ceiling. The exception is a path that *starts with the literal prefix* `~/.car/`: `car-server` reads that prefix as "the state root", not as your home directory, so `--journal-dir ~/.car/journals` under `CAR_HOME=/tmp/car-alt` resolves to `/tmp/car-alt/journals`, not `~/.car/journals`. That is what keeps the flag's own default from being the one daemon path left behind in the shared location. With `CAR_HOME` unset the two readings are the same path. To pin journals to your real home while relocating everything else, spell it out — `--journal-dir "$HOME/.car/journals"`, or any other absolute path.
- **Model weights and the Python runtimes do not move.** The model directories under `~/.car/models/`, plus `~/.car/speech-runtime/` and `~/.car/visual-runtime/`, are a multi-gigabyte machine-global cache of identical bytes — not per-instance state — so a relocated daemon keeps *reading* them instead of re-downloading them. Point `CAR_SPEECH_RUNTIME_DIR` or `HF_HOME` elsewhere if you genuinely want separate copies. Only the weights are shared: the small state files that happen to sit in the same directory (row 3 of the table) follow the state root, so two daemons never overwrite each other's routing history or discovery cache.

`CAR_HOME` must be an **absolute** path. The daemon, the CLI and any FFI host each have their own working directory, so a relative value would silently hand them three different roots; both `car-server` and the `car` CLI refuse to run on one instead, exiting 2 with the offending value in the message.

### Running a second daemon

The recommended way to run a second daemon is to give it its own state root and
its own port, which makes the two independent rather than merely polite to each
other:

```bash
CAR_HOME=/tmp/car-alt car-server --port 9200 --mcp-bind disabled
```

`--port 9200` also moves the dashboard to 9201 (it is always `port + 1`), but
the MCP endpoint defaults to a *fixed* `127.0.0.1:9102` and would collide — so
disable it on the second daemon, or give it its own `--mcp-bind 127.0.0.1:9202`.
`CAR_HOME` isolates state, not ports; TCP ports are a separate namespace and
still need saying.

Point clients at it with `CAR_DAEMON_URL=ws://127.0.0.1:9200`, and read its
token from `/tmp/car-alt/ai.parslee.car/auth-token`. It **creates and modifies
nothing** under `~/.car` or in the default token directory, and the only thing
it reads there is the shared model-weight cache — including leaving alone the
`run/daemon.lock` and `run/car-server.sock` that decide primacy, so the isolated
daemon is the primary *of its own root* and publishes its token normally.

That one read is by design (see the third bullet above): weights are a shared
multi-gigabyte cache, and the daemon does not write to it. "Isolated" here means
isolated state, not an empty machine.

Without `CAR_HOME`, a second daemon shares one root with the first, and the
following applies instead.

The auth-token file and that shared socket are **per-user singletons** — neither path carries a port or instance id. Only one `car-server` per user owns them: the **primary**, decided by an advisory lock on `~/.car/run/daemon.lock` plus a liveness probe of the shared socket (so an already-running daemon whose binary predates the lock is still respected).

A non-primary daemon starts normally but:

- does **not** write the shared auth-token file — its token stays in memory, so reach it with the value supplied through `--auth-token`, `CAR_AUTH_TOKEN`, `--auth-token-file`, or `CAR_AUTH_TOKEN_FILE`; the file form is read and deleted at startup;
- binds `car-server-<port>.sock` instead of the shared path.

Both are logged at startup. Before this, a second daemon on another port silently overwrote the token file (breaking every client of the running daemon with `token mismatch`) and unlinked its live socket, leaving that listener orphaned until it restarted — with nothing logged on either side (Parslee-ai/car#629).

## Server-initiated requests

Most JSON-RPC frames are client → server. For tool dispatch the direction inverts: the daemon's `WsToolExecutor` sends a `tools.execute` request *back to the client* and waits for the response. Same envelope, same wire shape:

```json
{"jsonrpc": "2.0", "method": "tools.execute", "params": {"action_id": "a0", "tool": "search", "parameters": {...}, "timeout_ms": 180000, "attempt": 1, "request_id": "cb-1", "session_id": "sess-7"}, "id": "cb-1"}
```

`params` fields:
- `action_id` — the originating proposal `Action.id` (empty for legacy `execute()` callers).
- `timeout_ms` — the action's per-call budget, when declared; the host may bound its own tool runner by it.
- `request_id` — the daemon-side callback-routing id (equal to the JSON-RPC `id`). Key a per-call abort registry on this — `tools.cancel` (below) carries the same value. Correlate by `request_id`, **not** `action_id` (which is empty for legacy callers and not unique across concurrent/retried attempts).
- `attempt` — the engine's retry counter for this action, **1-based** (`1` on the first try, `2` on the first retry). Until car#928 this was hardcoded to `1` on the wire and dropped by both bindings, so a join built on it silently never varied; it now carries the real value and both bindings forward it. For correlating a *specific* in-flight call use `request_id`, which is unique per callback — `attempt` answers the different question of *which retry am I serving*.
- `session_id` — the Runtime execution session this call belongs to, **stamped by the daemon** (car#904). Omitted when the caller has no session (the legacy `execute()` path, in-process executors). This is the attribution key for "which mission does this callback belong to": `action_id` is client-authored and not unique across attempts, so a submit-time map keyed on it inherits that weakness, and an agent keeping per-mission receipts that threads identity through its own convention — a process-global run id being the naive choice — can let a later mission's artifact inherit an earlier mission's receipts. Bracket the mission with `runs.start` / `runs.complete` (see **Agent run tracing**) and join on this.

  **Agent authors:** `runs.*` is the supported way to bracket a mission, and it is easy to miss if you only read the serve-mode/agent-chat sections. `runs.start` → per-turn records → `runs.complete` writes a durable trace under `~/.car/runs/`, with `idempotency_key` dedupe; `runs_start`/`runs_complete` are in the NAPI and PyO3 bindings too.

The client must reply with a JSON-RPC response carrying the matching `id`:

```json
{"jsonrpc": "2.0", "id": "cb-1", "result": {"hits": [...]}}
```

Or an ordinary error:

```json
{"jsonrpc": "2.0", "id": "cb-1", "error": {"code": -32000, "message": "tool unavailable"}}
```

A callback that knows retry cannot recover may opt into terminal failure:

```json
{"jsonrpc": "2.0", "id": "cb-1", "error": {"code": -32000, "message": "receipt journal is unavailable", "data": {"terminal": true}}}
```

`error.data.terminal` is optional and defaults to `false`. The daemon never
infers it from `error.message`. When true, the engine stops retries, aborts and
rolls back the current proposal, and marks the failed `ActionResult` with
`terminal: true`; the daemon then halts this WebSocket session so later
`proposal.submit` calls return rejected action results without dispatching a
tool. The halt is connection-local and is discarded on reconnect. A host-role
connection may clear its own latch with `session.clear_halt`; durable run
failure remains an explicit `runs.complete` responsibility.

The NAPI package exposes `TerminalToolError`, and Python exposes
`car_runtime.TerminalToolError`. Throw or raise that distinguished class from a
tool handler to produce this typed wire bit. Ordinary exceptions and legacy
JSON results preserve their previous behavior.

The Rust client at `car_ffi_common::proxy::DaemonClient` exposes `register_handler(method, handler)` for legacy `Result<Value, String>` callbacks. Typed tool bindings use `register_typed_handler(method, handler)` and return `ServerRequestFailure::terminal(message)` only after recognizing their distinguished exception; both install a closure that the receive loop dispatches inbound `tools.execute` requests to.

### `tools.cancel` (server → client notification, Parslee-ai/car#264)

When an in-flight `tools.execute` callback is **cancelled** for any reason, the daemon emits a fire-and-forget `tools.cancel` notification so the host can kill the in-flight child instead of orphaning it (e.g. a `claude -p` / `codex exec` driven by `drive_cli`). All three cancellation sources fire it:

- the **executor's per-action deadline** (`Action.timeout_ms`) — the common case, since it expires before the daemon's own wait by design;
- the **server's per-method deadline** on the handler that owns the dispatch;
- the **daemon's own callback wait** (`Action.timeout_ms` + grace, or the `CAR_TOOL_TIMEOUT`-overridable 300s default when the action declares no budget).

```json
{"jsonrpc": "2.0", "method": "tools.cancel", "params": {"request_id": "cb-1", "action_id": "a0", "reason": "tool 'drive_cli' callback timed out (185s)"}}
```

It is a **notification** (no `id`, no response expected) — the daemon has already given up on the call. Correlate by `request_id` against the value seen on the originating `tools.execute`; abort the child registered under it regardless of `reason`. FFI clients receive this through `registerToolCancelHandler` (NAPI) / `register_tool_cancel_handler` (PyO3); raw WS clients install a notification handler for the `tools.cancel` method. A host that ignores it is unchanged except the orphan persists until self-exit.

Not to be confused with the client → server `tools.cancel` **request** (C2, see the tools section in the method reference), which takes `{ handle }` and cancels a detached streaming/long-running tool invocation — same method name, opposite direction.

### `messaging.channel_send` (host-delivered messaging channel, Parslee-ai/car#885)

Not a new JSON-RPC method — a **tool name** that arrives over the ordinary `tools.execute` callback above. It is how a messaging channel CAR has no built-in transport for still gets delivered.

The runtime owns message semantics (validation, policy, rate limiting, idempotency, the event log); the host owns channels. When an agent calls the `messaging.send` tool with a `channel` no built-in adapter claims — Teams, Discord, an internal bus — the daemon's fallback adapter asks the host to deliver it, by dispatching `messaging.channel_send` back to you:

```json
{"jsonrpc": "2.0", "method": "tools.execute", "params": {"tool": "messaging.channel_send", "parameters": {"channel": "teams", "kind": "direct", "to": "user@example.invalid", "body": "Build is green."}, "request_id": "cb-9"}, "id": "cb-9"}
```

- `channel` — the channel name the agent asked for, verbatim.
- `kind` — `"direct"` (a person) or `"channel"` (a shared channel). Same vocabulary the `messaging.send` schema advertises to the model, so one shape runs from the model's JSON through to your handler.
- `to` — the handle for `direct`, the channel id for `channel`.
- `body` — the message text.

Reply with a normal tool result. `{"message_id": "…"}` is picked up as the channel-assigned id; anything else (including `{}` or `null`) is treated as a successful delivery with no id. Return an **error** to fail the send — your error text reaches the model verbatim, so say what would make it work ("not a member of that team", "rate limited").

Three properties matter if you implement this:

- **Exact match wins.** The fallback is only consulted for channels no registered adapter claims, so installing it can never divert `imessage` away from the built-in adapter that holds the pairing state for it.
- **Dedup happens before you are called.** `messaging.send`'s `idempotency_key` is checked against the registry's ledger *before* routing, so a suppressed retry never reaches your handler at all. A send that fails records no key and stays retryable.
- **Not implementing it is a supported state.** Returning an error whose message starts with `unknown tool` is translated into a message telling the operator this host does not implement the callback — not surfaced as a missing CAR tool.

Hosts register nothing to opt in; handling the tool name *is* the registration. There is deliberately no `register_message_adapter` FFI entry point, since every host (WS, NAPI, PyO3, UniFFI) already implements tool dispatch.

Send JSON-RPC 2.0 requests:

```json
{"jsonrpc": "2.0", "method": "memory.add_fact", "params": {"subject": "x", "body": "y", "kind": "pattern"}, "id": 1}
```

Receive responses:

```json
{"jsonrpc": "2.0", "result": 1, "id": 1}
```

Ordinary handler failures use code `-32603` for internal errors:

```json
{"jsonrpc": "2.0", "error": {"code": -32603, "message": "..."}, "id": 1}
```

If the daemon abandons a handler at its own server-side deadline, it returns
`-32004` instead:

```json
{"jsonrpc": "2.0", "error": {"code": -32004, "message": "handler 'auth.completion_status' exceeded its 95s response deadline; daemon-owned reconciliation continues and a later proof read is safe"}, "id": 1}
```

For a mutating request this is normally an ambiguous outcome: the handler may
have committed before its future was dropped. Clients must not immediately
retry the mutation; reconcile through that method's authoritative read first.
The coder session-liveness form is narrower: its message names the session's
already-recorded terminal state and failure reason, and `coder.get` remains the
authoritative read.

Most methods take a flat generous deadline (30 minutes by default, overridable
with `CAR_HANDLER_TIMEOUT`). Silence-supervised coder work is exempt:
`coder.start`, `coder.confirm_contract`, `coder.refresh_review`,
`coder.revise_contract`, and `coder.approve_merge` have no request wall-clock
budget once their live session exists. Their liveness is owned by the session's
silence watchdog; if the session becomes terminal while its handler still has
not answered, a terminal event wakes the request guard immediately. After a
two-second grace it sets session
cancellation, and returns `-32004` with the session id, terminal state, and
recorded failure reason. `coder.start` retains the generic deadline only for
repository resolution and worktree provisioning before registration; checks
and model turns begin after registration. Setting `silence_window_secs = 0`
disables stall detection only. A non-terminal wait remains unbounded, but a
terminal session still releases it.

The CAR daemon client, its NAPI/PyO3/UniFFI coder bindings, `car code`, and
`car coder-ab run` impose no client read timeout on those same five methods.
The daemon is the single liveness owner. A WebSocket Close, EOF, or read error
still drops every pending response sender, so a daemon process exit returns a
transport error promptly instead of leaving an unbounded call parked.

The daemon sends WebSocket Ping frames every 30 seconds and closes a peer after
90 seconds without any inbound frame. It drains already-readable frames before
making that decision. If an overdue tick shows the daemon's own dispatch loop
was stalled for more than two ping intervals, it resets the liveness window and
sends a fresh Ping instead of charging the stalled time to the peer. `car code`
also sends a Ping every 30 seconds while waiting and continues polling the
stream so tungstenite can flush automatic Pong replies. These transport clocks
do not cap a coder run; the coder silence watchdog and normal terminal states
remain the run-liveness rules.

`proposal.submit` is the other exception: its deadline is derived from the
submitted proposal's own action budgets — the sum over actions of `timeout_ms`
(defaulting to the daemon's 300-second tool budget) times the attempts the
executor will run for that action (`max_retries + 1` for `failure_behavior:
"retry"`, otherwise one), plus a 15-second transport grace.
The derivation only ever raises the deadline above the generous default, so a
legitimately long in-budget proposal — a retried action with a ten-minute
budget, or a chain of actions summing past 30 minutes — is not abandoned while
the executor is still running it. A short proposal, or params with no parseable
proposal, keeps exactly the generous default. The grace is deliberately smaller
than the client's own 30-second transport grace, so the reap order stays
innermost-first: the executor reaps an attempt, then the daemon abandons the
handler with `-32004`, then the client read times out.
Credential-backed `auth.*` operations are daemon-owned rather than
connection-owned: after host authorization, socket teardown drops only the
response waiter and cannot cancel an in-flight coordinator/keychain mutation.
`auth.start`, the durable claim in `auth.complete`, and
`auth.completion_status` each have an explicit 95-second state-response bound:
30 seconds for the coordinator queue, 30 for the cross-process lock, 15 for
the authoritative read, 15 for publication, and 5 seconds of margin.
`auth.complete` returns an acceptance receipt only after its daemon-owned
worker has durably claimed the exact attempt and spawned redemption; the
receipt is not proof of successful sign-in. Its 210-second redeeming lease is
derived from every serial pre-publication bound (15s claim publication + 90s
network + 30s coordinator queue + 30s process lock + 15s strict-expiry state
read) plus 30s of positive scheduling margin. One typed pre-redemption
coordination deadline may be retried safely with the same request because no
claim or code exchange began; that retry through both coordinator contention
layers plus worker, proof, and hydration fit inside the host's 480-second
reconciliation horizon. Any other client-side acceptance timeout or dropped
connection is ambiguous. In those cases, reconnect as the host and query
`auth.completion_status` with the exact `attempt_id`; never replay the one-time
code. Stable `-32004` messages distinguish a coordination deadline known to
precede state work from an ambiguous response-waiter timeout. Proof
coordination/timeouts are retried serially. An `auth.start` coordination
deadline before reservation is safe to retry; an `auth.start` waiter timeout is
ambiguous and must not overlap another start. Other daemon-returned errors,
including genuine state corruption as `-32603`, are terminal unless that
method's contract says otherwise.

## Bidirectional callbacks

CAR doesn't own tools — when the runtime needs to call one, the *server* sends a request *to the client*. The client executes the tool locally and sends the result back.

```
                proposal.submit (with tool_call action)
client ─────────────────────────────────────► server
                    runtime sees tool_call, dispatches:
client ◄───────────────────────────────────── server
                tools.execute { tool, params }, id=N
                    client runs tool locally...
client ─────────────────────────────────────► server
                response { result }, id=N
                    runtime continues execution
client ◄───────────────────────────────────── server
                proposal.submit response, id=1
```

The same callback pattern applies to multi-agent (`multi.swarm`, `multi.pipeline`, etc.) — agent execution is delegated to the client via `multi.run_agent` callbacks.

## Server-pushed notifications

Some calls produce ongoing events. After subscribing, clients receive:

- `host.event` — agent registered/unregistered, status changed, approval
  requested/resolved, and browser sign-in needed/resolved (see the `kind`
  list under `host.event` in the notification reference — sign-in attention
  is deliberately here, not on `browser.view.event`, because this channel is
  on whether or not the drawer is)
- `auth.credential.event` — host-only, process-owned Parslee credential-read
  lifecycle `{ generation, state }`, where `state` is `pending`, `configured`,
  `signed_out`, `denied`, `cancelled`, `timed_out`, or `unreadable`. One
  generation emits pending before its physical read and one terminal update;
  generations are monotonic. Authenticated non-host clients receive none.
- `supervision.intent` — a proposal is parked at the admission gate awaiting
  your verdict, after `supervision.subscribe`. **Consuming this is mandatory**:
  every matching proposal blocks until you answer or it fails closed
- `voice.event` — transcript segments, partials, finals during meetings or transcription sessions
- `runs.trace.event` — live agent-run trace records (per turn + terminal), after `runs.subscribe`
- `tools.stream.event` — chunks from detached (streaming/long-running) tool
  invocations, after `tools.stream.subscribe`. Params: `{ handle, chunk }`.
  Best-effort; the reliable drain is `tools.poll` (see the tools section)
- `tools.execute` — see callback section above
- `infer.progress` — liveness heartbeat emitted every ~10s while an `infer` call
  is in flight (cold model load, queued admission, or slow generation). No
  subscription needed; sent automatically for the duration of each `infer`.
  Params carry `{ "id": <the infer request's id> }`. The bundled FFI client uses
  it to hold an *idle* (reset-per-heartbeat) read timeout so a legitimately long
  inference is not reaped mid-flight — a client that ignores it just keeps its
  absolute deadline. Model-agnostic: covers both a local cold-start and a slow
  remote without the client knowing which the daemon routed to. (car#476)

Notifications have no `id` field (JSON-RPC convention).

The Rust client at `car_ffi_common::proxy::DaemonClient` exposes
`register_notification_handler(method, handler)` — parallel to
`register_handler` but for fire-and-forget notifications. The recv
loop invokes the closure synchronously after parsing the frame, so
keep it cheap (post into a queue, fire a TSF, etc.). Handlers
panicking are caught and logged — they do not tear down the recv
task. Registration is single-subscriber-per-method by design;
layer a fanout dispatcher above this if a method needs multiple
observers.

Update the subscriber list as new push surfaces land — currently
also includes `a2ui.event` (after `a2ui/subscribe`),
`inference.stream.event` (during `infer_stream` runs), and
`infer.progress` (automatically, during every `infer` call).

---

## Authentication & authorization

> **Status: ON by default since 2026-05.** The flip closes the
> drive-by-RCE chain a security audit walked end-to-end (browser →
> unauth `ws://localhost:9100/` → `agents.upsert` → LaunchAgent →
> persistent RCE at next login). Pass `--no-auth` (or set
> `CAR_NO_AUTH=1`) to opt back into the legacy "any local caller
> wins" posture — only appropriate for trusted single-user developer
> machines. The legacy `--require-auth` flag is still accepted but
> is now a no-op kept for backward compatibility with launchers
> minted before the flip; it logs a deprecation warning.

### Parslee account sign-in (`auth.*`)

GUI-driven Parslee OAuth2 PKCE sign-in for CAR Host.app, sharing one
implementation with `car auth login` (the `car-auth` crate).
The trusted in-process GUI carries the PKCE `verifier` + `state`
between `auth.start` and `auth.complete`. The daemon serializes every
process-global `auth.*` operation and persists only an attempt-bound,
generation-bound completion proof beside the credentials. This lets a
host reconcile a lost completion reply without replaying the one-time
authorization code. Every Parslee-owned credential-store slot under service
`"car"` is daemon-private: generic `secret.*`, CLI, and FFI secret surfaces
cannot read, replace, or delete it. The complete reserved contract is:

- fixed session keys: `PARSLEE_ACCESS_TOKEN`, `PARSLEE_REFRESH_TOKEN`,
  `PARSLEE_ACCESS_TOKEN_EXPIRES_AT`, and `PARSLEE_API_BASE`;
- canonical auth state: `PARSLEE_AUTH_STATE_V2`;
- multi-account registry/stash: `PARSLEE_ACCOUNTS` and every key with the
  `PARSLEE_TOKENS_` prefix;
- attribution/proof metadata: `PARSLEE_ACTIVE_ACCOUNT_ID`,
  `PARSLEE_AUTH_GENERATION`, and `PARSLEE_AUTH_COMPLETION`.

| Method | Params | Result |
|--------|--------|--------|
| `auth.authority_hint` | — | Non-secret passive presentation hint `{ state: "unknown" \| "signed_out" \| "configured", generation, updated_at_unix_ms }`. This never reads the credential store and `configured` is not identity proof. |
| `auth.start` | `redirect_uri` (req), `api_base?`, `client_id?` (default `parslee-car`), `provider?`, `prompt?` (`select_account` to add a second login) | `{ authorize_url, state, verifier, attempt_id, expires_at_unix_ms }` — the authorization base resolves explicit non-empty override → non-empty `PARSLEE_API_BASE` environment → public default, without reading an existing credential to build the URL. It atomically publishes the durable `awaiting_callback` reservation before returning. The daemon-owned response waiter has a 95-second bound; clients use more than 95 seconds. `-32004` with `auth.start coordination deadline before reservation; safe to retry auth.start serially` means no reservation work began and is safe to retry. A 95-second waiter timeout instead says the reservation outcome is ambiguous and still running; do not overlap another start. The GUI opens `authorize_url`, runs a loopback listener on `redirect_uri`, and captures `code`+`state`. |
| `auth.complete` | `code`, `verifier`, `redirect_uri`, `attempt_id` (req), `api_base?`, `client_id?` | Returns `{ state: "accepted", attempt_id }` only after atomically claiming the exact current reservation as a `redeeming` lease and spawning the daemon-owned redemption task. Accepted therefore implies durable claim, but is not commit proof. Duplicate, expired, or stale attempts fail before exchange and never return accepted. `-32004` beginning `auth coordination deadline before redemption; safe to retry auth.complete` means no claim/code exchange began and permits exactly one bounded retry of the same attempt/code. Any response-waiter timeout or transport ambiguity may have claimed and is proof-only: never replay the code. The worker survives a request connection closing, fetches the new session before mutating credentials, stores tokens plus exact completion proof, and after a successful exchange makes at most one additional bounded `/connect/session` check before publishing a consumed-code failure. |
| `auth.completion_status` | `attempt_id` (req) | One already-published V2 authoritative snapshot: pending `{ state: "pending", attempt_id, generation, phase: "awaiting_callback" \| "redeeming", expires_at_unix_ms }`; success `{ state: "complete", attempt_id, generation, account_id?, session? }`; terminal failure `{ state: "failed", attempt_id, generation, error_code: "completion_failed" \| "attempt_expired" \| "daemon_restarted", message, retryable: true }`; or `{ state: "stale", attempt_id, generation }`. No legacy migration, token refresh, publication barrier, or network call. An expired or old-daemon redeeming worker is atomically closed before return, which may require one terminal publication. The daemon-owned proof operation survives socket loss. Its response waiter has a composed 95-second bound; bounded coordination and waiter timeouts use stable `-32004` retry-later messages, while genuine corruption/internal failures remain terminal `-32603`. Clients use a longer timeout and never overlap proof reads. |
| `auth.snapshot` | — | `{ authenticated, active_account_id? }`. No token refresh or network call. Its first local read may migrate an attributable legacy login into V2; an ambiguous legacy marker degrades to a signed-out snapshot (`authenticated: false`) and the orphan fixed-slot credential is discarded, so a fresh sign-in can proceed. `active_account_id` is omitted when the fixed credential slots cannot be attributed exactly; registry rows are never substituted as proof. |
| `auth.status` | `retry_keychain_access?: bool` (default `false`) | `{ authenticated: bool, session? }`. Ordinary calls use the current coordinator state and never clear a failed-read cooldown. Only the literal boolean `retry_keychain_access: true` explicitly clears cooldown and starts one new credential-read generation. |
| `auth.switch_org` | `organization_id` (req), `api_base?` | `{ authenticated, session }` — **silently** switches the signed-in account's active organization: mints a fresh token scoped to `organization_id` via the refresh grant's `organization_id` override (the backend validates membership; no browser), persists the rotated tokens, and returns the refreshed session. Inference follows immediately (the new token carries `active_org`). The org must be one the login belongs to (`session.Organizations[]`). |
| `auth.accounts` | `api_base?` | `{ accounts: [{ id, email?, name?, active }] }` — every stored Parslee **login** (multiple can coexist; exactly one is `active`). Migrates a pre-multi-login session into the registry on first call. |
| `auth.switch_account` | `account_id` (req), `api_base?` | `{ authenticated, session }` — make another held login the active view (one compare-and-swap publication of the V2 record; every login keeps its own refresh token), refresh, and return the newly-active login's session. The active login is the CLI/UI default view; it does not change the default org. |
| `auth.remove_account` | `account_id` (req) | `{ ok, accounts }` — forget a stored login (deletes its stashed tokens). If it was active, another remaining login becomes active, or the session clears when none remain. A default org held by the removed login is cleared, never moved to another login. |
| `auth.logout` | — | `{ ok: true }` — clears stored Parslee credentials and the default org. |
| `auth.organizations` | — | `{ organizations: [{ context: { api_base, account_id, organization_id }, email?, role? }], default: WorkContext \| null, default_error? }` — `default_error` names an unreadable `work-contexts.json` without hiding the list. Errors while `PARSLEE_ACCESS_TOKEN` overrides the stored logins. Every (login, org) pair **every** signed-in login holds, not just the active one, read locally from the `memberships` claim of each login's own tokens (no network). Sorted by account, then org. The claim reflects membership when the token was minted; the issuer re-checks it on every context renewal. |
| `auth.default_context.get` | — | `{ default: WorkContext \| null }` — the person's default org: what new work uses when nothing more specific (an explicit choice, the repository's `.car/config.toml`, the agent's default) names one. Stored in `work-contexts.json` under the CAR state root; separate from the active login. A malformed file is an error, not an empty default. |
| `auth.default_context.set` | `organization_id` (req), `account_id?` | `{ default: WorkContext }` — set the default org. The signed-in login that holds the org supplies the account; `account_id` is required only when more than one does (otherwise the call fails naming them). The issuer must mint a credential for the org first, so a default is never an org this CAR cannot use. Cleared automatically when its login is removed or signed out, or when the issuer answers `invalid_organization` for it. |
| `auth.default_context.clear` | — | `{ cleared: WorkContext \| null }` — remove the default org; returns the one that was set. |
| `auth.resolve_context` | `working_dir?` (absolute), `organization_id?`, `personal?: bool` | Which org a session started in `working_dir` would bind, and why: `{ context: WorkContext \| null, source: "explicit" \| "repository" \| "user_default" \| "personal", repository }` or, when the rule refuses, `{ refusal: { code, message }, repository }`. `repository` is `null`, `{ organization_id, declared_in }`, or `{ unreadable, error }`. Sources apply in order — explicit choice, the repository's `[organization] id`, the default org, personal — and a repository's org is a hard constraint: an explicit choice of another org is refused (`repository_mismatch`), never overridden. A malformed `.car/config.toml` refuses (`repository_unreadable`) rather than reading as "no org". Previews with no agent definition, so any held org is permitted and personal work is allowed. Refusal codes: `repository_unreadable`, `repository_mismatch`, `not_permitted`, `personal_not_allowed`, `not_held`, `ambiguous`, `context_not_held`, `default_unavailable`, `unresolved`. The rule is `car_context::resolve::resolve`. |

**All of these require the host-management role** (`session.auth { host_token }`),
the same trust root as `openrouter.*`, `permission.*`, and `messaging.*`
(car#661). They own the daemon's
Parslee identity: `logout` clears the active login's tokens, `switch_org` /
`switch_account` silently repoint which identity subsequent inference runs and
bills against, and `remove_account` drops a stored login — so an authenticated
but non-host connection could sign the user out of every Parslee-routed model
with one call. The reads are gated too: `status` / `accounts` enumerate which
identities exist and which is active, while `snapshot` / `completion_status`
expose authentication and attempt state. As with the other host-gated surfaces, the
gate is a no-op when the daemon runs with no host token configured (`--no-auth` /
pure-dev), where the connection is the authority.

This costs the CLI nothing: `car auth login` / `logout` / `orgs` / `switch-org` /
`accounts` never call this surface — they use the `car-auth` crate in-process.
The native CarHost WebSocket clients authenticate with the host token and
negotiate protocol v3 before calling this surface.

Credential reads also emit `auth.credential.event` to host-management
connections after authorization and protocol negotiation. The notification is
secret-free and generation ordered: `pending` is published before the physical
read and exactly one terminal state follows for that generation. Non-host
connections receive no credential events.

The stored token is what `car-inference` reads at request time for
`parslee/*` models (`ModelSource::Proprietary` / `OAuth2Pkce`).
Brand-new accounts complete Parslee's existing hosted web
consent/onboarding inside the `auth.start` browser hand-off, so the
redeemed token already carries an org — CAR ships no consent surface.
The backend gateway contract (token `aud`/`scope`, hosted-onboarding
routing) is tracked in `m365dotnet` PR — until it lands the end-to-end
flow is unverified.

### Which credential each model provider uses

These credentials authorize model-provider requests; they are separate from
the daemon's own WebSocket token presented to `session.auth`.

| Provider / row IDs | Credential | How to supply it | Notes |
|--------------------|------------|------------------|-------|
| `openai/*` API rows | OpenAI Platform API key | Set `OPENAI_API_KEY` or run `car keys set openai`. | These are the `RemoteApi` rows that call `api.openai.com`; this excludes the Codex CLI row below. |
| `openai/gpt-5.6-sol:high` | The Codex CLI's own ChatGPT sign-in | Install the Codex CLI and run `codex login`. | CAR launches the CLI with `OPENAI_API_KEY` removed; the CLI owns its authentication. |
| `openai-codex/*` | ChatGPT subscription credential, not an API key: the stored `CAR_OPENAI_CODEX_OAUTH` record | Run `car auth login --provider openai-codex`. | Requests go to `https://chatgpt.com/backend-api/codex/responses`, never `api.openai.com`, and do not use `OPENAI_API_KEY`. Only the `openai-codex` provider may use this credential gate. Usage is reported as `subscription`, never a dollar figure. |
| `anthropic/*` | Anthropic API key | Set `ANTHROPIC_API_KEY` or run `car keys set anthropic`. | The catalog names `ANTHROPIC_API_KEY` for these remote API rows. |
| `parslee/*` | Parslee OAuth2 PKCE sign-in | Run `car auth login`. | Only `parslee` rows may use this credential gate. |
| `openrouter/*` | OpenRouter API key from the environment, the pasted-key slot, or the daemon-owned OAuth slot | Set `OPENROUTER_API_KEY`, run `car keys set openrouter`, or connect the OpenRouter account in CarHost. | Resolution order is environment, pasted key, then OAuth. |

`openai-codex` availability is existence-only: passive reads use the
process-local sign-in hint, while explicit status reads check whether the
stored record exists without reading it. When signed out,
`car models list` prints the sign-in instruction below the table. A `401`
refreshes the credential once and then fails with that instruction; a
subscription usage-limit `429` stops with a reset hint, while other `429`
responses and `500`, `502`, `503`, `504`, and `529` responses retry within a
bounded attempt limit.

### Secret-store activity diagnostics

#### `diagnostics.secret_store_activity`

This host-management-only, WS-only method is a read of process-lifetime
aggregate operation attempts. It requires protocol v3 and
returns exactly:

```json
{
  "get_attempts": 0,
  "status_attempts": 0,
  "availability_attempts": 0,
  "write_attempts": 0,
  "delete_attempts": 0
}
```

The integers are diagnostic counters, not credential state. The response has
no service name, key name, path, value, identity, or per-credential detail.
When a host token is configured, authenticated non-host clients are rejected by
the same host-management gate as `auth.*` and `openrouter.*`.

### OpenRouter account connection (`openrouter.*`)

Daemon-owned [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
for CarHost on macOS and Windows. Unlike
`auth.*`, the daemon owns the verifier, random loopback callback path, code
exchange, timeout, cancellation, and keychain write; hosts only open the URL,
render status, and may poll if a terminal notification is missed.

| Method | Params | Result |
|--------|--------|--------|
| `openrouter.status` | `{}` | `{ authority_generation, state: "idle"|"pending"|"connected", effective_source: "none"|"env"|"pasted"|"oauth", pasted_key_exists, oauth_key_exists, pending?, last_result? }` |
| `openrouter.auth_start` | `{}` | `{ authority_generation, authorize_url, flow_id, deadline_unix_ms }`; supersedes an older pending flow |
| `openrouter.auth_cancel` | `{ flow_id? }` | full status; a stale/non-matching id is a no-op |
| `openrouter.disconnect` | `{}` | full status after deleting only the OAuth credential; a separately pasted key remains intact |

**All four require the host-management role** (`session.auth { host_token }`),
the same trust root as `permission.*` and `messaging.*`
(car#650). The OAuth credential
is daemon-private — `secret.put`/`get`/`delete` fail closed on the reserved slot
— which left `openrouter.disconnect` as the only path that could delete it, and
it was ungated: any authenticated local connection could log the user out of
OpenRouter, cancel the host's in-progress connect, or read credential-source
metadata. The read (`status`) is gated too, for the same reason. As with the
other host-gated surfaces, the gate is a no-op when the daemon runs with no host
token configured (`--no-auth` / pure-dev), where the connection is the authority.

Every authenticated WebSocket connection receives `openrouter.auth.event` with
the full non-secret status as `params` whenever daemon authority changes or a
same-generation vault/terminal result becomes observable. The daemon reserves
the strictly increasing `authority_generation` before OAuth setup or pasted-key
vault work. Hosts retain the highest generation observed, reject lower-generation
responses/events, and accept a strictly higher generation before applying flow
correlation. Within one generation, pending/terminal updates remain exact-flow
and terminal-monotonic. This closes the cross-client case where a delayed flow-A
`openrouter.auth_start` response arrives after client B has already replaced it.
Polling `openrouter.status` carries the same generation and remains authoritative
across a dropped notification or UI restart. Terminal result kinds are
`connected`, `cancelled`, `timed_out`,
`exchange_rejected`, and `superseded`; neither status nor notifications contain
the credential. Endpoint overrides used by a local OAuth contract test are
rejected unless the daemon was explicitly launched with
`CAR_OPENROUTER_TEST_MODE=1`. In that mode, the exact native empty-params
action may resolve `OPENROUTER_AUTHORIZATION_BASE_URL` and
`OPENROUTER_EXCHANGE_URL`; both environment values are ignored when test mode
is absent, so a normal daemon returns to OpenRouter's production endpoints.

OpenRouter request credentials resolve on every call in this order: non-empty
`OPENROUTER_API_KEY` environment value, pasted `OPENROUTER_API_KEY` in the
default keychain service, then the separate OAuth keychain slot. Thus adding,
removing, connecting, or disconnecting changes the next model list/route/request
without a daemon restart. `models.list_unified` and `models.search` always expose
exactly eleven reviewed personal OpenRouter rows: they remain visible but
unavailable without a credential, and the same rows become available with one.
Typoed or unregistered IDs retain the ordinary model-not-found behavior.

### Default posture (auth on)

Every WS connection MUST call `session.auth` as its first
JSON-RPC method, presenting the per-launch token. See "Token
handshake" below for the exact mechanics.

`car-server` continues to bind `127.0.0.1` by default (loopback
only). Auth-on plus loopback gives a defense-in-depth posture:
the network reach is already constrained, and the token gate
prevents a co-resident malicious process — or a malicious web
page abusing the browser's no-CORS-on-WebSocket behaviour — from
driving the daemon.

### Opt-out posture (`--no-auth`)

`car-server --no-auth` (or `CAR_NO_AUTH=1`) skips the token handshake
and reverts to the pre-2026-05 authorization model: any local process
that can open a TCP socket to `127.0.0.1:9100` can call any
method after the non-secret protocol negotiation. This is appropriate **only** when:

- The daemon is talking exclusively to in-process FFI consumers
  (NAPI/PyO3) which already have full access by virtue of
  process identity, AND
- No other untrusted user process or web view is running on the
  same machine.

#### Threat model

- ✅ **Same-user, in-process FFI** (NAPI/PyO3 in the daemon
  process): the auth gate is irrelevant — same-process FFI
  consumers don't traverse the WS at all.
- ✅ **Same-user daemon + their own UI** (auth on, default):
  `car-host` reads the token from the well-known path and
  authenticates transparently, then negotiates the exact wire protocol before
  its first host request. The locally-served HTML UI
  fetches the token from the colocated `GET /auth-token`
  endpoint on `port + 1` (loopback only).
- ✅ **Same-user, multiple unrelated processes** (auth on,
  default): a second user process must read the `0600` token
  file to authenticate — not a fresh exposure (anything running
  as the user could read the file already), but pre-auth-flip
  this surface was wide open.
- ⚠️ **Browser-driven WS to localhost** (auth on, default):
  malicious web pages can still open WebSockets to `localhost`
  (browsers don't enforce CORS for WebSocket upgrades) but
  cannot read the token from disk, so they fail at
  `session.auth`. The token is also `cache-control: no-store`
  on the UI server's auth-token endpoint and the UI server is
  loopback-bound, so a remote page can't fetch it either.
- ❌ **Multi-user / network-reachable**: not supported. Don't
  bind to a routable interface; don't expose the port through
  reverse proxies; don't run `car-server` as a shared service.

### High-risk method approval gate (audit 2026-05)

Independent of the auth gate, the dispatcher wraps a small set of
methods in a per-call user-approval handshake. The motivating
threat: an authenticated caller (the user's own NAPI consumer, an
in-process tool callback driven by a model output, an A2A peer)
can technically invoke `automation.run_applescript`,
`messages.send`, or a mutating `calendar.*` method. AppleScript can do
anything the user can; a silent message or calendar mutation changes or
ships the user's data without consent. Auth gates *who* can call; the
approval gate gates *what* runs.

**Gated methods** (default set):

- `automation.run_applescript`
- `automation.run_powershell`
- `automation.shortcuts.run`
- `messages.send`
- `mail.send`
- `calendar.create_event`
- `calendar.update_event`
- `calendar.delete_event`
- `vision.ocr`

When one of those arrives, the dispatcher:

1. Creates an approval row via `host.create_approval` with
   `action: "ws.method:<method>"` and a truncated params preview.
2. Broadcasts an `approval.requested` host event so subscribers
   (the local HTML UI; tray apps; any host shell) can render
   approve / deny buttons.
3. Parks for up to 60 seconds (configurable per `ServerState`)
   waiting for `host.resolve_approval` to land with
   `resolution: "approve"`.
4. On approve → routes to the underlying handler.
5. On deny or timeout → returns JSON-RPC error `-32003`. The
   approval row stays in `Pending` for forensics; the connection
   is *not* closed (the caller may retry with revised params).

`car-server --no-approvals` (or `CAR_NO_APPROVALS=1`) disables
the gate. Only safe on trusted single-user developer machines.
Embedders override the method set, the timeout, and the on/off
switch via `ServerStateConfig::with_approval_gate(ApprovalGate)`.

**Scope.** The gate is WS-only. Same-process FFI consumers
(NAPI/PyO3 calling `car_ffi_common::automation::*` directly) skip
it because in-process compromise already implies full access — the
gate's job is closing the network-reachable path.

### Per-session ACL on host state (audit 2026-05)

`HostState` (the registry behind `host.*` methods) now enforces
per-session ownership on every mutation:

- **Agents.** The session that called `host.register_agent` is the
  agent's owner (recorded in `HostAgent.session_id`). Only the
  owning session may call `host.set_status` or
  `host.unregister_agent`. A second client trying to mutate
  someone else's agent gets `"agent '<id>' is owned by another
  session"`. `host.register_agent` also refuses to overwrite an
  agent owned by a different session — unregister-from-owner
  first.
- **Approvals.** `HostApprovalRequest` carries an optional
  `client_id` field:
  - `Some(x)` — the approval was raised by session `x` via
    `host.request_approval`. Only `x` may call
    `host.resolve_approval` on it.
  - `None` — the approval is *system-level* (raised by the
    high-risk-method gate above). Any authenticated session may
    resolve. This is intentional: the parking dispatch is one
    session, the local UI doing the click is a different session,
    and the gate would deadlock the UX if approvals were strictly
    session-scoped.
- **Reads** (`host.agents`, `host.approvals`, `host.events`)
  remain unrestricted so a single dashboard can render every
  agent and approval across sessions. The trust model is "any
  authed caller is the user," so cross-session *visibility* is by
  design; cross-session *mutation* is what the audit closed.

### Token handshake (default behaviour)

The handshake fires automatically unless `--no-auth` is set:

```
car-server --port 9100         # auth on (default)
car-server --no-auth --port 9100   # auth off (opt-out)
```

#### What car-server does

1. On startup, generates a fresh 32-byte random token (43-char
   base64url-no-pad).
2. Writes it to a per-platform well-known path with `0600`
   permissions:
   - **macOS**: `~/Library/Application Support/ai.parslee.car/auth-token`
   - **Linux**: `$XDG_RUNTIME_DIR/ai.parslee.car/auth-token` if set,
     otherwise `~/.config/ai.parslee.car/auth-token`
   - **Windows**: `%LOCALAPPDATA%\ai.parslee.car\auth-token`
3. Installs the token on `ServerState`. Every WS connection MUST
   call `session.auth` as its first JSON-RPC method; non-auth
   methods on unauthenticated sessions get `{"code": -32001,
   "message": "auth required: ..."}` and the connection is closed.
4. On graceful shutdown, removes the token file so a stale token
   doesn't outlive the daemon that minted it. (Forced kills skip
   this; the next start overwrites the file.)

#### What WS clients do

```jsonc
// First frame on every WS connection:
{"jsonrpc":"2.0","id":0,"method":"session.auth","params":{"token":"<43 chars>"}}

// Server responds:
{"jsonrpc":"2.0","id":0,"result":{"ok": true, "auth_enabled": true}}

// Then negotiate this connection's exact wire protocol:
{"jsonrpc":"2.0","id":1,"method":"server.handshake","params":{"protocol_version":3,"required_capabilities":["infer.model-identity.v1","models.catalog-identity.v1"],"optional_capabilities":[]}}
{"jsonrpc":"2.0","id":1,"result":{"protocol_version":3,"server_version":"0.51.0","client_protocol_version":3,"negotiated_capabilities":["infer.model-identity.v1","models.catalog-identity.v1"]}}

// Subsequent calls work normally. Host/auth clients subscribe only after
// the handshake succeeds:
{"jsonrpc":"2.0","id":2,"method":"host.subscribe","params":{}}
```

Token discovery is filesystem-first — read it from the path above
with the user's own permissions. Sandboxed callers that can't
read the path directly receive it via the host process that
holds the entitlement (XPC for macOS bundles).

##### Cross-host clients: `$CAR_AUTH_TOKEN`

When the client and daemon are on **different hosts** (FFI or CLI
running on Windows, daemon on Linux; or any other split), the local
per-platform file path is the wrong source — there is no file to
read locally. Set `$CAR_AUTH_TOKEN` on the client to the daemon's
token (transferred out of band — ssh, scp, secrets store, vault)
and the FFI bindings, the in-tree `car` CLI, and any code path
that calls `car_ffi_common::auth_token::read_for_client()` will use
the env var instead of the local file.

Precedence — matches `$CAR_DAEMON_URL`:

1. `$CAR_AUTH_TOKEN` if set and non-empty → wins
2. otherwise → local file at the platform-specific path above
3. otherwise → `Ok(None)` (handshake is skipped; daemon's
   `--no-auth` shape, or token write hasn't landed yet)

Whitespace-only or empty values are treated as unset — a shell-
quoting bug shouldn't silently disable auth. Leading/trailing
whitespace around a real token is trimmed (so `ssh host cat token`
output works without further cleanup).

Server-side code (the daemon reading its own token to install on
`ServerState`, the UI server exposing it at `GET /auth-token`)
continues to use `auth_token::read()` directly — that read is *not*
overridable by env var, since the daemon should advertise the token
it actually minted, not whatever the operator put in their shell.

The in-tree `car` CLI uses the same auto-handshake pattern as the
FFI bindings (Parslee-ai/car#211): every CLI subcommand that
opens a WS connection sends `session.auth` as its first frame
when a token is discoverable (env or file), and silently skips
when neither is set.

#### What the FFI bindings do

Both NAPI (`car-runtime` npm) and PyO3 (`car-runtime` PyPI) auto-read
the token via `auth_token::read_for_client()` at WebSocket-connect
time — `$CAR_AUTH_TOKEN` first, local file path second — and send
`session.auth` as the first frame transparently. Same-user same-host
FFI consumers just-work after the user opts the daemon in; cross-host
FFI consumers set `$CAR_AUTH_TOKEN` (with `$CAR_DAEMON_URL` pointing
at the remote daemon) and just-work. No code change at the FFI call
site for either shape. When `read_for_client()` returns `Ok(None)`
(neither source set — auth disabled on the daemon side), the
handshake step is skipped entirely.

The release schema can be read before negotiation through
[`server.schema`](websocket-protocol/server.md#serverschema), after `session.auth` when daemon auth is
enabled. A client can therefore check the release's schema digest before using
application methods.

#### `session.bind_context`

- **Params**: `{ working_dir: string, organization_id?: string, personal?: boolean }`. `working_dir` must be absolute.
- **Returns**: `{ work_context: WorkContext | null, from_default: boolean }`.
- Binds this connection, once, to the work context a new `car do` run works in (proposal §9). The context is resolved by `coder.start`'s rule: an explicit `organization_id` or `personal` (not both), else the repository's `[organization] id` under `working_dir`, else the person's default org, else personal. A context that cannot be used refuses and names the fix (`personal: true`, `car do --personal`); nothing falls back to personal silently, and a repository's declared org is a hard constraint.
- Once bound, the connection is a context-bound session:
  - the work-context gate admits only context-aware calls;
  - `infer` runs in the context;
  - its `sync.*` records go to a private per-context store;
  - its memory is a private per-context graph.
- A personal resolution leaves the connection unbound (`work_context: null`).
- Refused:
  - on an agent or inference-consumer connection, whose context comes from its own authentication;
  - on a connection that is already bound;
  - before `session.auth`, since the gate admits a bound session only once it authenticated;
  - on a connection that authenticated with a `memory_namespace`;
  - on a connection whose tenant is a different org.
- The binding belongs to the connection, so a reconnected socket starts unbound. A client must bind every new connection before sending anything else on it, and treat a different `work_context` as an error, never as personal work. The Rust `DaemonClient::with_bound_context` does this for `car do`.

#### `session.consumer.issue`

- **Params**: `{ methods: string[], ttl_secs?: integer }`.
- **Returns**: `{ consumer_id: string, token: string, role: "inference_consumer", parent_agent_id: string, resource_key: string, work_context: WorkContext, methods: string[], issued_at_ms: integer, expires_at_ms: integer }`.
- Requires the currently authenticated supervised coordination socket that owns the parent's inbox, original context, private resource and token generation. The parent scope must permit issuance and the requested inference subset (`infer`, `infer_stream`, `classify`, `models.route`, `infer.cancel`, `infer.deadline`). An agent with no method allowlist is unrestricted and permits both, since a grant never carries more than the parent's own socket may call; an explicit allowlist must name `session.consumer.issue` and each granted method. A consumer call refused because the context's membership could not be confirmed returns code `-32012` and leaves the grant in place; `-32001` means the grant itself ended (revoked, expired, parent rotated). `car do --serve` under a supervisor requests an `infer` grant on its coordination connection, sends its daemon-routed model calls over a consumer socket authenticated with it, and requests a new grant a minute before expiry or after a failed call, revoking the superseded one. TTL defaults to 300 seconds and cannot exceed 900. Caller-supplied context, namespace, agent and role selectors refuse. The credential is daemon-ephemeral and distinct from the coordination token; grant caps refuse rather than evict another organization.

#### `session.consumer.revoke`

- **Params**: `{ consumer_id: string }`.
- **Returns**: `{ consumer_id: string, revoked: bool }`.
- Requires the original parent coordination socket and revocation permission. A consumer cannot revoke, issue or expand credentials. Revocation signals that consumer's sockets and aborts their owned inferences without altering the parent's attachment or another organization.

#### `session.auth`

- **Params**: `{ token: string, agent_id?: string, memory_namespace?: string }` **or**
  `{ host_token: string, memory_namespace?: string }` (host-role handshake, #254) **or** `{ consumer_id: string, token: string }` (auxiliary inference role; no other selectors accepted)
- **Returns**: `{ ok: true, auth_enabled: bool, agent_id?: string, method_allowlist?: string[], memory_namespace?: string, parslee?: ParsleeIdentity }`,
  or `{ ok: true, auth_enabled: true, role: "host", memory_namespace?: string }` for the host-token path
- Consumer authentication returns the issuance receipt without `token`, plus `ok: true` and `auth_enabled: true`. The role is `inference_consumer`. It pins the original parent/resource/context, binds that private graph and method subset, and never takes an agent attachment or inbox. It cannot change roles or ownership on the same socket. Current parent generation, expiry, revocation and original context authorization are checked before application calls; background validation cancels this socket's running inference after authority loss. Restart requires a separately reissued grant on the original parent socket. A consumer can control only its own negotiated inference IDs.
- **`memory_namespace`** binds this connection to a daemon-owned memory graph
  private to that namespace, persisted at
  `~/.car/memory/memory-namespaces/<encoded-ns>.json`.
  Omit it and the connection uses the daemon's **shared** graph — see the scope
  table under [memory](websocket-protocol/memory.md#memory) for what that means for a multi-project host.
  Accepted on ordinary agent and host auth paths; consumer auth derives the original resource and refuses this selector. **FFI hosts
  set `CAR_MEMORY_NAMESPACE`** instead of composing the frame themselves — the
  shared daemon transport that every binding proxies through owns this
  handshake, so the environment variable is the only route from NAPI/PyO3
  (car-releases#80). Same configuration shape as `CAR_DAEMON_URL` and
  `CAR_AUTH_TOKEN`. The filename is a lowercase percent-encoding of the
  namespace's UTF-8 bytes — `a`-`z`, `0`-`9`, `-`, `_` and `.` pass through and
  every other byte (including `%` and every uppercase letter, since APFS is
  case-insensitive) becomes `%` plus two lowercase hex digits — so path
  separators and `..` cannot escape the memory base and two namespaces can
  never share a snapshot file (#891). It is a separate axis from `agent_id`; when both are
  given the namespace determines the memory scope and the agent binding still
  governs identity. (Parslee-ai/car-releases#79.)
- **Errors**: `-32001` ("auth required" — not actually used by
  this method itself, but produced by the dispatcher gate when
  another method is called on an unauthenticated session) or a
  generic `-32603` "auth failed: token mismatch" when the
  supplied token is wrong. Wrong-token responses leave the
  session unauthenticated; the next non-auth call closes the
  connection.
- When `auth_token` is unset on the daemon (auth disabled), the
  method accepts any token and returns `{ ok: true,
  auth_enabled: false }` — keeps the FFI proxy's
  always-handshake path uniform.
- Comparison is constant-time (length-checked).
- **Lifecycle-agent identity binding (#169)**: when `agent_id` is
  supplied, the daemon validates the supplied `token` against the
  per-agent token the supervisor minted at upsert (NOT the
  daemon-wide auth token), and binds the WS connection to that
  agent identity. A later primary connection with the same valid credential
  replaces a stale primary attachment, so supervisor respawns recover even if
  the old socket has not closed yet; only the connection that still owns the
  attachment removes the agent's chats when it disconnects. A second socket for
  the same agent's inference authenticates as a scoped consumer
  (`{ consumer_id, token }`, see `session.consumer.issue`) and never takes the
  attachment. The legacy unbound-token path remains valid for browser/host/CLI
  clients — `agent_id` is optional. Lifecycle-agent SDKs read
  `CAR_AGENT_ID` and `CAR_AGENT_TOKEN` from the env the supervisor
  set on spawn (#172). When that registration carries `method_allowlist`, the
  successful response echoes the canonical list and the daemon checks every
  later request or notification before any method handler runs. `session.auth`
  and `server.handshake` are implicit transport-establishment calls. A method
  outside the list returns `-32601` with the named
  `agent_method_not_allowed` error; an out-of-scope notification is dropped.
  The scope only removes access — it never grants host, owner, or other
  authority that the method's normal handler requires. An absent allowlist
  preserves the historical unrestricted token; an empty list permits only the
  two implicit transport-establishment calls.
- **Host-management role (#254)**: when `host_token` is supplied,
  the daemon validates it against the per-launch **host token** — a
  credential *distinct* from the daemon `token` and from per-agent
  tokens. On match the connection is both authenticated and granted
  the host role (`role: "host"` in the response), which
  `authorize_run_access` requires for cross-agent run-trace reads
  (`runs.list` / `runs.get_trace` / `runs.subscribe`). The host token
  is **never** served over `GET /auth-token`; it is readable only from
  the `0600` `host-token` file (sibling of the auth-token file), so a
  different local user — or a generic client that scraped the auth
  token from the HTTP endpoint — cannot self-elevate to host. Merely
  calling `host.subscribe` no longer grants this access. CarHost reads
  the file and presents it on connect.
- **Persistent per-agent memgine (#170)**: a successful
  `agent_id` bind also attaches the connection to a daemon-owned
  persistent memgine keyed on the id, lazy-loaded from
  `~/.car/memory/agents/<id>.json` on first attach and retained
  across daemon restart. `memory.add_fact`, `memory.query`,
  `memory.fact_count`, and `memory.consolidate` route through the
  bound engine; bound writes persist to disk synchronously.
  Connections without an `agent_id` keep the per-WS ephemeral
  memgine — no behaviour change for non-lifecycle clients.

#### `parslee.auth`

- **Auth**: requires a successful local `session.auth` first.
- **Params**: none.
- **Returns**:
  `{ authenticated: true, token_type: "Bearer", access_token: string,
  authorization_header: string, identity: ParsleeIdentity }`.
- **Errors**: generic `-32603` with
  `"Parslee account not authenticated; run `car auth login`"` when
  the user has not connected a Parslee account.
- Purpose: lets managed agents use CAR as the bridge from local
  daemon auth (`CAR_AUTH_TOKEN`) to the user's Parslee backend
  auth without injecting the Parslee bearer token into every child
  process environment.

#### `parslee.capabilities`

- **Auth**: requires a successful local `session.auth` first; uses the
  signed-in Parslee account's bearer (no params).
- **Params**: none.
- **Returns** (authenticated):
  ```json
  {
    "authenticated": true,
    "identity": { "account_id": "...", "email": "...", "display_name": "...",
                  "active_organization": "...", "organization_name": "..." },
    "entitlements": {
      "organization_id": "...",
      "enabled_products": ["studio", "aie", "..."],
      "products": [ { "product_id": "studio", "enabled": true,
                      "tier": "Standard", "quotas": { } } ]
    },
    "entitlements_error": null,
    "studio": { "host": "https://studio.parslee.ai", "reachable": true,
                "bearer_accepted": true, "probe_status": 200, "note": "..." }
  }
  ```
- **Returns** (not signed in, or a stored session that can't be established —
  e.g. an expired refresh token): `{ authenticated: false, hint: string,
  error?: string }`. `error` carries the underlying reason when a stored
  session failed to refresh (re-authenticate with `car auth login`).
- Read-only discovery: resolves the Parslee bearer, reads the account
  identity, fetches the active org's product entitlements from m365
  (`/api/v1/orgs/{orgId}/entitlements`), and probes Studio with the bearer
  (authed `…/studio/quota/me` when an org is known, else `/health`) to confirm
  the platform is reachable and accepts the token. `entitlements` is `null`
  with a populated `entitlements_error` when that fetch fails (e.g. no active
  org, or insufficient role) — the call still returns identity + Studio status.
  `studio.bearer_accepted` is `false` if Studio rejected the bearer (the
  token → Studio → m365 chain is broken), `null` if it couldn't be probed.
  Override hosts with `PARSLEE_API_BASE` / `PARSLEE_STUDIO_BASE`.
- It is the foundation other Parslee capability tools gate on (check
  `enabled_products` before offering a creative/document action).

#### `parslee.m365.generate_document`

- **Auth**: requires a successful local `session.auth`; uses the signed-in
  Parslee account's bearer.
- **Gated on**: the `aie` entitlement (M365 AI Employees — the core platform
  that owns document generation). Override the gating product with
  `PARSLEE_M365_DOC_PRODUCT`.
- **Params**:
  `{ content_brief: string (20–2000 chars), output_file_path: string
  (e.g. "Generated/report.docx"), document_type?: string
  (Report|Proposal|Memo|Letter|Contract|ExecutiveSummary|MeetingMinutes|ProjectPlan,
  default "Report"), title?: string, author?: string }`.
- **Returns**:
  `{ ok: true, file_id, file_name, web_url, size, generated_title,
  section_count, generation_time_ms, document_type, output_file_path }`.
- **Errors** (generic `-32603`): not signed in; no active organization; the
  `aie` product not enabled for the org (the message lists the enabled
  products); brief too short/long or missing output path; or the upstream m365
  HTTP error.
- Generates the document content with AI, builds a `.docx`, and uploads it to
  the user's connected drive (OneDrive / Google Drive — provider chosen by org
  config) at `output_file_path`. Synchronous: returns once the file is saved.
  Calls m365 `POST /api/v1/orgs/{orgId}/documents/word/generate`.

---

## Method reference

437 methods across 77 namespaces. Each section below documents params, returns, and notable
behavior. This section is long — for a compact map of every method with deep links into it, read
[websocket-protocol-index.md](websocket-protocol-index.md) first and follow only the links you need.

<!-- These counts are derived, not hand-maintained: `bash scripts/gen-ws-namespace-index.sh`
     reports them and fails on coverage gaps. The previous figure here ("73+ methods across 23
     namespaces") had drifted to ~5.6x wrong on namespaces while sitting live on the public
     site, because nobody rereads 5000 lines to notice a stale summary. Re-run the generator
     rather than editing these numbers by hand. -->

- [accounts](websocket-protocol/accounts.md#accounts) <!-- ws-protocol:include -->
- [assistant](websocket-protocol/assistant.md#assistant) <!-- ws-protocol:include -->
- [browser](websocket-protocol/browser.md#browser) <!-- ws-protocol:include -->
- [calendar](websocket-protocol/calendar.md#calendar) <!-- ws-protocol:include -->
- [concierge](websocket-protocol/concierge.md#concierge) <!-- ws-protocol:include -->
- [connectors](websocket-protocol/connectors.md#connectors) <!-- ws-protocol:include -->
- [contacts](websocket-protocol/contacts.md#contacts) <!-- ws-protocol:include -->
- [health](websocket-protocol/health.md#health) <!-- ws-protocol:include -->
- [feedback](websocket-protocol/feedback.md#feedback) <!-- ws-protocol:include -->
- [host](websocket-protocol/host.md#host) <!-- ws-protocol:include -->
- [a2ui](websocket-protocol/a2ui.md#a2ui) <!-- ws-protocol:include -->
- [a2a (in-core dispatcher — releases#28)](websocket-protocol/a2a.md#a2a-in-core-dispatcher--releases28) <!-- ws-protocol:include -->
- [mail](websocket-protocol/mail.md#mail) <!-- ws-protocol:include -->
- [messages](websocket-protocol/messages.md#messages) <!-- ws-protocol:include -->
- [messaging](websocket-protocol/messaging.md#messaging) <!-- ws-protocol:include -->
- [notes](websocket-protocol/notes.md#notes) <!-- ws-protocol:include -->
- [reminders](websocket-protocol/reminders.md#reminders) <!-- ws-protocol:include -->
- [photos](websocket-protocol/photos.md#photos) <!-- ws-protocol:include -->
- [bookmarks](websocket-protocol/bookmarks.md#bookmarks) <!-- ws-protocol:include -->
- [files](websocket-protocol/files.md#files) <!-- ws-protocol:include -->
- [keychain](websocket-protocol/keychain.md#keychain) <!-- ws-protocol:include -->
- [meeting](websocket-protocol/meeting.md#meeting) <!-- ws-protocol:include -->
- [registry](websocket-protocol/registry.md#registry) <!-- ws-protocol:include -->
- [supervision](websocket-protocol/supervision.md#supervision) <!-- ws-protocol:include -->
- [admission](websocket-protocol/admission.md#admission) <!-- ws-protocol:include -->
- [a2a](websocket-protocol/a2a.md#a2a) <!-- ws-protocol:include -->
- [automation](websocket-protocol/automation.md#automation) <!-- ws-protocol:include -->
- [notifications](websocket-protocol/notifications.md#notifications) <!-- ws-protocol:include -->
- [vision](websocket-protocol/vision.md#vision) <!-- ws-protocol:include -->
- [memory](websocket-protocol/memory.md#memory) <!-- ws-protocol:include -->
- [models](websocket-protocol/models.md#models) <!-- ws-protocol:include -->
- [multi](websocket-protocol/multi.md#multi) <!-- ws-protocol:include -->
- [permissions](websocket-protocol/permissions.md#permissions) <!-- ws-protocol:include -->
- [proposal](websocket-protocol/proposal.md#proposal) <!-- ws-protocol:include -->
- [policy](websocket-protocol/policy.md#policy) <!-- ws-protocol:include -->
- [scheduler](websocket-protocol/scheduler.md#scheduler) <!-- ws-protocol:include -->
- [secret](websocket-protocol/secret.md#secret) <!-- ws-protocol:include -->
- [server](websocket-protocol/server.md#server) <!-- ws-protocol:include -->
- [session](websocket-protocol/session.md#session) <!-- ws-protocol:include -->
- [skill](websocket-protocol/skill.md#skill) <!-- ws-protocol:include -->
- [skills](websocket-protocol/skills.md#skills) <!-- ws-protocol:include -->
- [state](websocket-protocol/state.md#state) <!-- ws-protocol:include -->
- [inference (additional)](websocket-protocol/inference.md#inference-additional) <!-- ws-protocol:include -->
- [outcomes](websocket-protocol/outcomes.md#outcomes) <!-- ws-protocol:include -->
- [memory (additional)](websocket-protocol/memory.md#memory-additional) <!-- ws-protocol:include -->
- [cascade](websocket-protocol/cascade.md#cascade) <!-- ws-protocol:include -->
- [sync](websocket-protocol/sync.md#sync) <!-- ws-protocol:include -->
- [lease](websocket-protocol/lease.md#lease) <!-- ws-protocol:include -->
- [skills (additional)](websocket-protocol/skills.md#skills-additional) <!-- ws-protocol:include -->
- [events / replan](websocket-protocol/events.md#events--replan) <!-- ws-protocol:include -->
- [`heal.*` — the self-healing repair loop](websocket-protocol/heal.md#heal--the-self-healing-repair-loop) <!-- ws-protocol:include -->
- [runs](websocket-protocol/runs.md#runs) <!-- ws-protocol:include -->
- [tools](websocket-protocol/tools.md#tools) <!-- ws-protocol:include -->
- [policy](websocket-protocol/policy.md#policy-1) <!-- ws-protocol:include -->
- [agents](websocket-protocol/agents.md#agents) <!-- ws-protocol:include -->
- [assistants](websocket-protocol/assistants.md#assistants) <!-- ws-protocol:include -->
- [foreman](websocket-protocol/foreman.md#foreman) <!-- ws-protocol:include -->
- [multiplayer](websocket-protocol/multiplayer.md#multiplayer) <!-- ws-protocol:include -->
- [fleet](websocket-protocol/fleet.md#fleet) <!-- ws-protocol:include -->
- [coder](websocket-protocol/coder.md#coder) <!-- ws-protocol:include -->
- [declagents](websocket-protocol/declagents.md#declagents) <!-- ws-protocol:include -->
- [voice](websocket-protocol/voice.md#voice) <!-- ws-protocol:include -->
- [inference](websocket-protocol/inference.md#inference) <!-- ws-protocol:include -->
- [workflow](websocket-protocol/workflow.md#workflow) <!-- ws-protocol:include -->
- [Top-level (no namespace)](websocket-protocol/top-level.md#top-level-no-namespace) <!-- ws-protocol:include -->
- [lattice](websocket-protocol/lattice.md#lattice) <!-- ws-protocol:include -->
## Notification methods (server → client)

These arrive as JSON-RPC notifications (no `id`). The client doesn't respond to them.

- [`host.event`](websocket-protocol/host.md#hostevent) <!-- ws-protocol:include -->
- [`voice.event`](websocket-protocol/voice.md#voiceevent) <!-- ws-protocol:include -->
- [`coder.event`](websocket-protocol/coder.md#coderevent) <!-- ws-protocol:include -->
- [`coder.session_changed`](websocket-protocol/coder.md#codersession_changed) <!-- ws-protocol:include -->
- [`coder.discuss.event`](websocket-protocol/coder.md#coderdiscussevent) <!-- ws-protocol:include -->
## CAR binary frame protocol

For high-rate audio exchange (PCM ingest, TTS chunk delivery), CAR transports payloads as **WebSocket binary frames** alongside the JSON-RPC text channel. This avoids the ~33% base64 overhead and the JSON encode/decode cost on the hot path.

### Header

26-byte fixed header. All multi-byte fields little-endian.

```
  offset  size  field
  0       1     type tag
                  0x01 = inbound PCM (client → server)
                  0x02 = outbound TTS audio chunk (server → client)
                  0x03 = outbound TTS final marker (server → client)
                  0x04 = outbound TTS error (server → client)
  1       16    session/stream UUID (raw bytes; the JSON-RPC
                `session_id` / `stream_id` MUST be the 32-char
                lowercase hex form of these bytes with no dashes)
  17      8     seq (u64 LE) — monotonic within a session/stream
  25      1     format byte (type 0x02 only):
                  0x00 = raw 16-bit signed LE PCM
                  0x01 = MP3
                  0x02 = WAV
                Ignored / zero for other types.
  26+     N     payload bytes
```

### Inbound (client → server)

Type `0x01`. Payload is 16-bit signed LE PCM at the sample rate / channel count declared in the matching `voice.transcribe_stream.start` call (where `audio_source.kind = "pcm_push"`). The `session_id` declared in that call MUST be the lowercase hex form of the UUID bytes used in subsequent binary frames.

This is equivalent to calling `voice.transcribe_stream.push` with base64 in JSON, but cheaper: ~25-byte overhead vs. ~33% expansion plus JSON parse.

### Outbound (server → client)

Type `0x02` carries audio chunks for an in-flight `voice.tts_stream.start` call where `options.binary_frames = true`. Type `0x03` marks the end of the stream (zero-length payload). Type `0x04` carries a UTF-8 error message as payload (no length prefix; the whole payload is the message).

When `binary_frames = true`, no JSON `tts_chunk` events are emitted — the bot reads `seq` and `format` from the header and decodes payload bytes per `format`.

### Reference implementation

`car-rs/crates/car-ffi-common/src/voice.rs::binary` exposes `parse_frame` / `build_frame` and the `FRAME_TYPE_*` / `FORMAT_*` constants. Test vectors live in the same module's `mod tests`.

### `tools.execute` (callback)
Sent when the runtime needs the client to execute a registered tool. The client responds with a JSON-RPC response carrying the same `id`:
```json
// server → client (request)
{ "jsonrpc": "2.0", "method": "tools.execute", "params": { "tool": "shell", "params": {"command": "ls"} }, "id": 17 }

// client → server (success response)
{ "jsonrpc": "2.0", "result": { "stdout": "...", "stderr": "" }, "id": 17 }

// client → server (typed terminal error response)
{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "receipt journal unavailable", "data": { "terminal": true } }, "id": 17 }
```

The optional `error.data.terminal` boolean defaults to false. Only the NAPI or
PyO3 `TerminalToolError` (or an explicit raw-WS field) opts in; message text is
never classified.

### `multi.run_agent` (callback)
Same pattern as `tools.execute`, but for delegating per-agent inference during `multi.*` and `workflow.run` operations.

---

## Error codes

| Code | Meaning |
|------|---------|
| `-32600` | Invalid Request (malformed JSON-RPC) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error (most runtime errors land here) |
| `-32001` | Transport auth required; send `session.auth` first (connection closes) |
| `-32003` | Approval denied or timed out |
| `-32004` | Handler deadline or coder session-liveness response bound exceeded. The operation may have committed, so consult the method's authoritative read before retrying. Coder liveness errors name the session id, already-terminal state, and recorded failure reason; `coder.get` is the authoritative coder read. `proposal.submit` derives its deadline from submitted action budgets rather than a flat cap |
| `-32005` | Protocol handshake required; `host.subscribe` / `auth.*` did not dispatch |
| `-32006` | Protocol version missing, malformed, or incompatible |
| `-32007` | Content refused — something in front of the model (a managed gateway's content filter, a provider's moderation layer) declined the request's content. Not a fault: record it as a policy refusal and do not retry. Message is prefixed `content refused:` |
| `-32008` | Protocol capability mismatch — a mandatory handshake capability is unsupported, or a capability-gated method was called without negotiating it. Message is prefixed `protocol capability mismatch:` |

The error `message` field contains a human-readable description.

---

## Notes

- **Sessions are per-connection.** Memgine, runtime state, registered tools, and policies do not survive a disconnect. Persistent memory requires explicit `persist_memory` (FFI) or external storage.
- **The built-in session token is local transport admission, not network
  security.** Add TLS plus an authenticated reverse proxy before exposing the
  WebSocket beyond localhost.
- **API keys** for remote inference (Anthropic, OpenAI, Google) are read from `~/.car/env` at server startup, not per-request. See README "Configuring API keys via `~/.car/env`".
- **Source of truth.** This document is hand-maintained from `car-rs/crates/car-server-core/src/handler.rs`, `host.rs`, and `session.rs`. If you find drift, the Rust dispatcher wins.

<!-- ws-protocol:moved-anchors:begin -->
## Moved anchors

The method reference used to be one page. Its sections now live in one file per
namespace, linked from [Method reference](#method-reference). A link written
against the single page (`websocket-protocol.md#<anchor>`) lands on its entry below,
which points at where that heading lives now. This list is frozen at the split;
headings added later are reachable from the namespace files and
[websocket-protocol-index.md](websocket-protocol-index.md).

- <a id="accounts"></a>[accounts](websocket-protocol/accounts.md#accounts)
- <a id="accountslist"></a>[`accounts.list`](websocket-protocol/accounts.md#accountslist)
- <a id="accountsopen"></a>[`accounts.open`](websocket-protocol/accounts.md#accountsopen)
- <a id="assistant"></a>[assistant](websocket-protocol/assistant.md#assistant)
- <a id="assistantidentityget"></a>[`assistant.identity.get`](websocket-protocol/assistant.md#assistantidentityget)
- <a id="assistantidentityset"></a>[`assistant.identity.set`](websocket-protocol/assistant.md#assistantidentityset)
- <a id="browser"></a>[browser](websocket-protocol/browser.md#browser)
- <a id="browserrun"></a>[`browser.run`](websocket-protocol/browser.md#browserrun)
- <a id="browserclose"></a>[`browser.close`](websocket-protocol/browser.md#browserclose)
- <a id="browserviewsubscribe"></a>[`browser.view.subscribe`](websocket-protocol/browser.md#browserviewsubscribe)
- <a id="browserviewunsubscribe"></a>[`browser.view.unsubscribe`](websocket-protocol/browser.md#browserviewunsubscribe)
- <a id="browserviewtake_control--browserviewhand_back"></a>[`browser.view.take_control` / `browser.view.hand_back`](websocket-protocol/browser.md#browserviewtake_control--browserviewhand_back)
- <a id="the-input-methods"></a>[The input methods](websocket-protocol/browser.md#the-input-methods)
- <a id="browserviewevent-server--client-notification"></a>[`browser.view.event` (server → client notification)](websocket-protocol/browser.md#browserviewevent-server--client-notification)
- <a id="browserproducerregister"></a>[`browser.producer.register`](websocket-protocol/browser.md#browserproducerregister)
- <a id="browserproducerpresentation--browserproducerframe-client--server-notifications-no-id"></a>[`browser.producer.presentation` / `browser.producer.frame` (client → server notifications, no `id`)](websocket-protocol/browser.md#browserproducerpresentation--browserproducerframe-client--server-notifications-no-id)
- <a id="agentbrowserinput-agentbrowsercontrol-agentbrowsercapture-agentbrowserhost_connected-daemon--agent-reverse-calls"></a>[`agent.browser.input`, `agent.browser.control`, `agent.browser.capture`, `agent.browser.host_connected` (daemon → agent reverse calls)](websocket-protocol/browser.md#agentbrowserinput-agentbrowsercontrol-agentbrowsercapture-agentbrowserhost_connected-daemon--agent-reverse-calls)
- <a id="presentation-object"></a>[`Presentation` object](websocket-protocol/browser.md#presentation-object)
- <a id="constants"></a>[Constants](websocket-protocol/browser.md#constants)
- <a id="calendar"></a>[calendar](websocket-protocol/calendar.md#calendar)
- <a id="calendarlist"></a>[`calendar.list`](websocket-protocol/calendar.md#calendarlist)
- <a id="calendarcreate_event"></a>[`calendar.create_event`](websocket-protocol/calendar.md#calendarcreate_event)
- <a id="calendarupdate_event"></a>[`calendar.update_event`](websocket-protocol/calendar.md#calendarupdate_event)
- <a id="calendardelete_event"></a>[`calendar.delete_event`](websocket-protocol/calendar.md#calendardelete_event)
- <a id="calendarevents"></a>[`calendar.events`](websocket-protocol/calendar.md#calendarevents)
- <a id="concierge"></a>[concierge](websocket-protocol/concierge.md#concierge)
- <a id="conciergestatus"></a>[`concierge.status`](websocket-protocol/concierge.md#conciergestatus)
- <a id="conciergedismiss"></a>[`concierge.dismiss`](websocket-protocol/concierge.md#conciergedismiss)
- <a id="conciergedefaults"></a>[`concierge.defaults`](websocket-protocol/concierge.md#conciergedefaults)
- <a id="conciergeset_default"></a>[`concierge.set_default`](websocket-protocol/concierge.md#conciergeset_default)
- <a id="conciergeclear_default"></a>[`concierge.clear_default`](websocket-protocol/concierge.md#conciergeclear_default)
- <a id="conciergeapply"></a>[`concierge.apply`](websocket-protocol/concierge.md#conciergeapply)
- <a id="conciergerollback"></a>[`concierge.rollback`](websocket-protocol/concierge.md#conciergerollback)
- <a id="conciergeactions"></a>[`concierge.actions`](websocket-protocol/concierge.md#conciergeactions)
- <a id="conciergemaintain"></a>[`concierge.maintain`](websocket-protocol/concierge.md#conciergemaintain)
- <a id="conciergeportfolio"></a>[`concierge.portfolio`](websocket-protocol/concierge.md#conciergeportfolio)
- <a id="conciergerefresh_catalog"></a>[`concierge.refresh_catalog`](websocket-protocol/concierge.md#conciergerefresh_catalog)
- <a id="conciergeask"></a>[`concierge.ask`](websocket-protocol/concierge.md#conciergeask)
- <a id="connectors"></a>[connectors](websocket-protocol/connectors.md#connectors)
- <a id="connectorsadd"></a>[`connectors.add`](websocket-protocol/connectors.md#connectorsadd)
- <a id="connectorsauthenticate"></a>[`connectors.authenticate`](websocket-protocol/connectors.md#connectorsauthenticate)
- <a id="connectorscomplete_authentication"></a>[`connectors.complete_authentication`](websocket-protocol/connectors.md#connectorscomplete_authentication)
- <a id="connectorslist"></a>[`connectors.list`](websocket-protocol/connectors.md#connectorslist)
- <a id="connectorstools"></a>[`connectors.tools`](websocket-protocol/connectors.md#connectorstools)
- <a id="connectorsadd_stdio"></a>[`connectors.add_stdio`](websocket-protocol/connectors.md#connectorsadd_stdio)
- <a id="connectorsenable_tools"></a>[`connectors.enable_tools`](websocket-protocol/connectors.md#connectorsenable_tools)
- <a id="connectorsdisable_tools"></a>[`connectors.disable_tools`](websocket-protocol/connectors.md#connectorsdisable_tools)
- <a id="connectorsrefresh"></a>[`connectors.refresh`](websocket-protocol/connectors.md#connectorsrefresh)
- <a id="connectorsremove"></a>[`connectors.remove`](websocket-protocol/connectors.md#connectorsremove)
- <a id="contacts"></a>[contacts](websocket-protocol/contacts.md#contacts)
- <a id="contactscontainers"></a>[`contacts.containers`](websocket-protocol/contacts.md#contactscontainers)
- <a id="contactsfind"></a>[`contacts.find`](websocket-protocol/contacts.md#contactsfind)
- <a id="health"></a>[health](websocket-protocol/health.md#health)
- <a id="healthstatus"></a>[`health.status`](websocket-protocol/health.md#healthstatus)
- <a id="healthsleep"></a>[`health.sleep`](websocket-protocol/health.md#healthsleep)
- <a id="healthworkouts"></a>[`health.workouts`](websocket-protocol/health.md#healthworkouts)
- <a id="healthactivity"></a>[`health.activity`](websocket-protocol/health.md#healthactivity)
- <a id="feedback"></a>[feedback](websocket-protocol/feedback.md#feedback)
- <a id="feedbackcompose_preview"></a>[`feedback.compose_preview`](websocket-protocol/feedback.md#feedbackcompose_preview)
- <a id="feedbacksubmit"></a>[`feedback.submit`](websocket-protocol/feedback.md#feedbacksubmit)
- <a id="feedbackstatus"></a>[`feedback.status`](websocket-protocol/feedback.md#feedbackstatus)
- <a id="feedbacklist"></a>[`feedback.list`](websocket-protocol/feedback.md#feedbacklist)
- <a id="host"></a>[host](websocket-protocol/host.md#host)
- <a id="hostsubscribe"></a>[`host.subscribe`](websocket-protocol/host.md#hostsubscribe)
- <a id="hostagents"></a>[`host.agents`](websocket-protocol/host.md#hostagents)
- <a id="hostdevices"></a>[`host.devices`](websocket-protocol/host.md#hostdevices)
- <a id="mobileruntime"></a>[`mobile.runtime`](websocket-protocol/host.md#mobileruntime)
- <a id="hostregister_device"></a>[`host.register_device`](websocket-protocol/host.md#hostregister_device)
- <a id="hostupdate_device"></a>[`host.update_device`](websocket-protocol/host.md#hostupdate_device)
- <a id="hostevents"></a>[`host.events`](websocket-protocol/host.md#hostevents)
- <a id="hostapprovals"></a>[`host.approvals`](websocket-protocol/host.md#hostapprovals)
- <a id="hostregister_agent"></a>[`host.register_agent`](websocket-protocol/host.md#hostregister_agent)
- <a id="hostunregister_agent"></a>[`host.unregister_agent`](websocket-protocol/host.md#hostunregister_agent)
- <a id="hostset_status"></a>[`host.set_status`](websocket-protocol/host.md#hostset_status)
- <a id="hostnotify"></a>[`host.notify`](websocket-protocol/host.md#hostnotify)
- <a id="hostrequest_approval"></a>[`host.request_approval`](websocket-protocol/host.md#hostrequest_approval)
- <a id="hostresolve_approval"></a>[`host.resolve_approval`](websocket-protocol/host.md#hostresolve_approval)
- <a id="a2ui"></a>[a2ui](websocket-protocol/a2ui.md#a2ui)
- <a id="a2uicapabilities"></a>[`a2ui.capabilities`](websocket-protocol/a2ui.md#a2uicapabilities)
- <a id="a2uiapply"></a>[`a2ui.apply`](websocket-protocol/a2ui.md#a2uiapply)
- <a id="a2uiingest"></a>[`a2ui.ingest`](websocket-protocol/a2ui.md#a2uiingest)
- <a id="a2uireap"></a>[`a2ui.reap`](websocket-protocol/a2ui.md#a2uireap)
- <a id="a2uisurfaces"></a>[`a2ui.surfaces`](websocket-protocol/a2ui.md#a2uisurfaces)
- <a id="a2uiget"></a>[`a2ui.get`](websocket-protocol/a2ui.md#a2uiget)
- <a id="a2uiaction"></a>[`a2ui.action`](websocket-protocol/a2ui.md#a2uiaction)
- <a id="a2uirender_report"></a>[`a2ui.render_report`](websocket-protocol/a2ui.md#a2uirender_report)
- <a id="a2uisubscribe"></a>[`a2ui/subscribe`](websocket-protocol/a2ui.md#a2uisubscribe)
- <a id="a2uiunsubscribe"></a>[`a2ui/unsubscribe`](websocket-protocol/a2ui.md#a2uiunsubscribe)
- <a id="a2uireplay"></a>[`a2ui/replay`](websocket-protocol/a2ui.md#a2uireplay)
- <a id="a2uievent-server--client-notification"></a>[`a2ui.event` (server → client notification)](websocket-protocol/a2ui.md#a2uievent-server--client-notification)
- <a id="a2a-in-core-dispatcher--releases28"></a>[a2a (in-core dispatcher — releases#28)](websocket-protocol/a2a.md#a2a-in-core-dispatcher--releases28)
- <a id="mail"></a>[mail](websocket-protocol/mail.md#mail)
- <a id="mailaccounts"></a>[`mail.accounts`](websocket-protocol/mail.md#mailaccounts)
- <a id="mailinbox"></a>[`mail.inbox`](websocket-protocol/mail.md#mailinbox)
- <a id="mailmailboxes"></a>[`mail.mailboxes`](websocket-protocol/mail.md#mailmailboxes)
- <a id="mailmessages"></a>[`mail.messages`](websocket-protocol/mail.md#mailmessages)
- <a id="mailmessage_body"></a>[`mail.message_body`](websocket-protocol/mail.md#mailmessage_body)
- <a id="mailsend"></a>[`mail.send`](websocket-protocol/mail.md#mailsend)
- <a id="messages"></a>[messages](websocket-protocol/messages.md#messages)
- <a id="messagesservices"></a>[`messages.services`](websocket-protocol/messages.md#messagesservices)
- <a id="messageschats"></a>[`messages.chats`](websocket-protocol/messages.md#messageschats)
- <a id="messagesread"></a>[`messages.read`](websocket-protocol/messages.md#messagesread)
- <a id="messagessend"></a>[`messages.send`](websocket-protocol/messages.md#messagessend)
- <a id="messaging"></a>[messaging](websocket-protocol/messaging.md#messaging)
- <a id="messagingconfigget"></a>[`messaging.config.get`](websocket-protocol/messaging.md#messagingconfigget)
- <a id="messagingconfigset"></a>[`messaging.config.set`](websocket-protocol/messaging.md#messagingconfigset)
- <a id="messagingpairingstart"></a>[`messaging.pairing.start`](websocket-protocol/messaging.md#messagingpairingstart)
- <a id="messagingpairingstatus"></a>[`messaging.pairing.status`](websocket-protocol/messaging.md#messagingpairingstatus)
- <a id="messagingstatus"></a>[`messaging.status`](websocket-protocol/messaging.md#messagingstatus)
- <a id="messagingtest_send"></a>[`messaging.test_send`](websocket-protocol/messaging.md#messagingtest_send)
- <a id="notesaccounts"></a>[`notes.accounts`](websocket-protocol/notes.md#notesaccounts)
- <a id="notesfind"></a>[`notes.find`](websocket-protocol/notes.md#notesfind)
- <a id="reminders"></a>[reminders](websocket-protocol/reminders.md#reminders)
- <a id="reminderslists"></a>[`reminders.lists`](websocket-protocol/reminders.md#reminderslists)
- <a id="remindersitems"></a>[`reminders.items`](websocket-protocol/reminders.md#remindersitems)
- <a id="photos"></a>[photos](websocket-protocol/photos.md#photos)
- <a id="photosalbums"></a>[`photos.albums`](websocket-protocol/photos.md#photosalbums)
- <a id="bookmarks"></a>[bookmarks](websocket-protocol/bookmarks.md#bookmarks)
- <a id="bookmarkslist"></a>[`bookmarks.list`](websocket-protocol/bookmarks.md#bookmarkslist)
- <a id="files"></a>[files](websocket-protocol/files.md#files)
- <a id="fileslocations"></a>[`files.locations`](websocket-protocol/files.md#fileslocations)
- <a id="keychain"></a>[keychain](websocket-protocol/keychain.md#keychain)
- <a id="keychainstatus"></a>[`keychain.status`](websocket-protocol/keychain.md#keychainstatus)
- <a id="meeting"></a>[meeting](websocket-protocol/meeting.md#meeting)
- <a id="meetingstart"></a>[`meeting.start`](websocket-protocol/meeting.md#meetingstart)
- <a id="meetingstop"></a>[`meeting.stop`](websocket-protocol/meeting.md#meetingstop)
- <a id="meetinglist"></a>[`meeting.list`](websocket-protocol/meeting.md#meetinglist)
- <a id="meetingget"></a>[`meeting.get`](websocket-protocol/meeting.md#meetingget)
- <a id="registry"></a>[registry](websocket-protocol/registry.md#registry)
- <a id="registryregister"></a>[`registry.register`](websocket-protocol/registry.md#registryregister)
- <a id="registryheartbeat"></a>[`registry.heartbeat`](websocket-protocol/registry.md#registryheartbeat)
- <a id="registryunregister"></a>[`registry.unregister`](websocket-protocol/registry.md#registryunregister)
- <a id="registrylist"></a>[`registry.list`](websocket-protocol/registry.md#registrylist)
- <a id="registryreap"></a>[`registry.reap`](websocket-protocol/registry.md#registryreap)
- <a id="supervision"></a>[supervision](websocket-protocol/supervision.md#supervision)
- <a id="supervisionsubscribe"></a>[`supervision.subscribe`](websocket-protocol/supervision.md#supervisionsubscribe)
- <a id="supervisionunsubscribe"></a>[`supervision.unsubscribe`](websocket-protocol/supervision.md#supervisionunsubscribe)
- <a id="supervisionpending"></a>[`supervision.pending`](websocket-protocol/supervision.md#supervisionpending)
- <a id="supervisiondecide"></a>[`supervision.decide`](websocket-protocol/supervision.md#supervisiondecide)
- <a id="admission"></a>[admission](websocket-protocol/admission.md#admission)
- <a id="admissionstatus"></a>[`admission.status`](websocket-protocol/admission.md#admissionstatus)
- <a id="a2a"></a>[a2a](websocket-protocol/a2a.md#a2a)
- <a id="a2astart"></a>[`a2a.start`](websocket-protocol/a2a.md#a2astart)
- <a id="a2astop"></a>[`a2a.stop`](websocket-protocol/a2a.md#a2astop)
- <a id="a2astatus"></a>[`a2a.status`](websocket-protocol/a2a.md#a2astatus)
- <a id="a2asend"></a>[`a2a.send`](websocket-protocol/a2a.md#a2asend)
- <a id="a2apeersadd--a2apeerslist--a2apeersremove"></a>[`a2a.peers.add` / `a2a.peers.list` / `a2a.peers.remove`](websocket-protocol/a2a.md#a2apeersadd--a2apeerslist--a2apeersremove)
- <a id="automation"></a>[automation](websocket-protocol/automation.md#automation)
- <a id="automationrun_applescript"></a>[`automation.run_applescript`](websocket-protocol/automation.md#automationrun_applescript)
- <a id="automationrun_powershell"></a>[`automation.run_powershell`](websocket-protocol/automation.md#automationrun_powershell)
- <a id="automationshortcutslist"></a>[`automation.shortcuts.list`](websocket-protocol/automation.md#automationshortcutslist)
- <a id="automationshortcutsrun"></a>[`automation.shortcuts.run`](websocket-protocol/automation.md#automationshortcutsrun)
- <a id="notifications"></a>[notifications](websocket-protocol/notifications.md#notifications)
- <a id="notificationslocal"></a>[`notifications.local`](websocket-protocol/notifications.md#notificationslocal)
- <a id="vision"></a>[vision](websocket-protocol/vision.md#vision)
- <a id="visionocr"></a>[`vision.ocr`](websocket-protocol/vision.md#visionocr)
- <a id="memory"></a>[memory](websocket-protocol/memory.md#memory)
- <a id="memoryadd_fact"></a>[`memory.add_fact`](websocket-protocol/memory.md#memoryadd_fact)
- <a id="memoryset_admission_table"></a>[`memory.set_admission_table`](websocket-protocol/memory.md#memoryset_admission_table)
- <a id="memoryadmission_table"></a>[`memory.admission_table`](websocket-protocol/memory.md#memoryadmission_table)
- <a id="memoryupdate_status"></a>[`memory.update_status`](websocket-protocol/memory.md#memoryupdate_status)
- <a id="memorymaintain"></a>[`memory.maintain`](websocket-protocol/memory.md#memorymaintain)
- <a id="memorysave_knowledge"></a>[`memory.save_knowledge`](websocket-protocol/memory.md#memorysave_knowledge)
- <a id="memorysave_procedural"></a>[`memory.save_procedural`](websocket-protocol/memory.md#memorysave_procedural)
- <a id="memorydelete"></a>[`memory.delete`](websocket-protocol/memory.md#memorydelete)
- <a id="memoryquery"></a>[`memory.query`](websocket-protocol/memory.md#memoryquery)
- <a id="memoryintervene"></a>[`memory.intervene`](websocket-protocol/memory.md#memoryintervene)
- <a id="memoryevaluate"></a>[`memory.evaluate`](websocket-protocol/memory.md#memoryevaluate)
- <a id="memorybuild_context"></a>[`memory.build_context`](websocket-protocol/memory.md#memorybuild_context)
- <a id="memorybuild_context_fast"></a>[`memory.build_context_fast`](websocket-protocol/memory.md#memorybuild_context_fast)
- <a id="memorypersist"></a>[`memory.persist`](websocket-protocol/memory.md#memorypersist)
- <a id="memoryload"></a>[`memory.load`](websocket-protocol/memory.md#memoryload)
- <a id="models"></a>[models](websocket-protocol/models.md#models)
- <a id="modelslist"></a>[`models.list`](websocket-protocol/models.md#modelslist)
- <a id="modelslist_unified"></a>[`models.list_unified`](websocket-protocol/models.md#modelslist_unified)
- <a id="modelscatalog_snapshot"></a>[`models.catalog_snapshot`](websocket-protocol/models.md#modelscatalog_snapshot)
- <a id="modelsresource_policyget"></a>[`models.resource_policy.get`](websocket-protocol/models.md#modelsresource_policyget)
- <a id="modelsresource_policyset"></a>[`models.resource_policy.set`](websocket-protocol/models.md#modelsresource_policyset)
- <a id="modelspreflight"></a>[`models.preflight`](websocket-protocol/models.md#modelspreflight)
- <a id="modelsstorage_roots"></a>[`models.storage_roots`](websocket-protocol/models.md#modelsstorage_roots)
- <a id="modelsadopt"></a>[`models.adopt`](websocket-protocol/models.md#modelsadopt)
- <a id="modelsremove"></a>[`models.remove`](websocket-protocol/models.md#modelsremove)
- <a id="modelsretire"></a>[`models.retire`](websocket-protocol/models.md#modelsretire)
- <a id="modelsroute_provenance"></a>[`models.route_provenance`](websocket-protocol/models.md#modelsroute_provenance)
- <a id="modelssearch"></a>[`models.search`](websocket-protocol/models.md#modelssearch)
- <a id="modelsupgrades"></a>[`models.upgrades`](websocket-protocol/models.md#modelsupgrades)
- <a id="modelsrecommend"></a>[`models.recommend`](websocket-protocol/models.md#modelsrecommend)
- <a id="modelssetup_plan"></a>[`models.setup_plan`](websocket-protocol/models.md#modelssetup_plan)
- <a id="modelsdetect_upgrades"></a>[`models.detect_upgrades`](websocket-protocol/models.md#modelsdetect_upgrades)
- <a id="modelscheck_upgrade_nudge"></a>[`models.check_upgrade_nudge`](websocket-protocol/models.md#modelscheck_upgrade_nudge)
- <a id="modelsdismiss_upgrade"></a>[`models.dismiss_upgrade`](websocket-protocol/models.md#modelsdismiss_upgrade)
- <a id="modelscheck_concierge"></a>[`models.check_concierge`](websocket-protocol/models.md#modelscheck_concierge)
- <a id="modelsdismiss_suggestion"></a>[`models.dismiss_suggestion`](websocket-protocol/models.md#modelsdismiss_suggestion)
- <a id="modelsupdate_prefs_get"></a>[`models.update_prefs_get`](websocket-protocol/models.md#modelsupdate_prefs_get)
- <a id="modelsupdate_prefs_set"></a>[`models.update_prefs_set`](websocket-protocol/models.md#modelsupdate_prefs_set)
- <a id="modelspull_progress-server--client-notification"></a>[`models.pull_progress` (server → client notification)](websocket-protocol/models.md#modelspull_progress-server--client-notification)
- <a id="conciergemaintenance-server--client-notification"></a>[`concierge.maintenance` (server → client notification)](websocket-protocol/models.md#conciergemaintenance-server--client-notification)
- <a id="modelsupgrade_available-server--client-notification"></a>[`models.upgrade_available` (server → client notification)](websocket-protocol/models.md#modelsupgrade_available-server--client-notification)
- <a id="modelssuggestion_available-server--client-notification"></a>[`models.suggestion_available` (server → client notification)](websocket-protocol/models.md#modelssuggestion_available-server--client-notification)
- <a id="modelsregister"></a>[`models.register`](websocket-protocol/models.md#modelsregister)
- <a id="modelsunregister"></a>[`models.unregister`](websocket-protocol/models.md#modelsunregister)
- <a id="modelspull"></a>[`models.pull`](websocket-protocol/models.md#modelspull)
- <a id="modelsinstall"></a>[`models.install`](websocket-protocol/models.md#modelsinstall)
- <a id="multi"></a>[multi](websocket-protocol/multi.md#multi)
- <a id="multiswarm"></a>[`multi.swarm`](websocket-protocol/multi.md#multiswarm)
- <a id="multipipeline"></a>[`multi.pipeline`](websocket-protocol/multi.md#multipipeline)
- <a id="multisupervisor"></a>[`multi.supervisor`](websocket-protocol/multi.md#multisupervisor)
- <a id="multimap_reduce"></a>[`multi.map_reduce`](websocket-protocol/multi.md#multimap_reduce)
- <a id="multivote"></a>[`multi.vote`](websocket-protocol/multi.md#multivote)
- <a id="multitournament"></a>[`multi.tournament`](websocket-protocol/multi.md#multitournament)
- <a id="multisubtask"></a>[`multi.subtask`](websocket-protocol/multi.md#multisubtask)
- <a id="permissions"></a>[permissions](websocket-protocol/permissions.md#permissions)
- <a id="permissionsstatus"></a>[`permissions.status`](websocket-protocol/permissions.md#permissionsstatus)
- <a id="permissionsrequest"></a>[`permissions.request`](websocket-protocol/permissions.md#permissionsrequest)
- <a id="permissionsexplain"></a>[`permissions.explain`](websocket-protocol/permissions.md#permissionsexplain)
- <a id="permissionsdomains"></a>[`permissions.domains`](websocket-protocol/permissions.md#permissionsdomains)
- <a id="proposal"></a>[proposal](websocket-protocol/proposal.md#proposal)
- <a id="proposalsubmit"></a>[`proposal.submit`](websocket-protocol/proposal.md#proposalsubmit)
- <a id="policy"></a>[policy](websocket-protocol/policy.md#policy)
- <a id="policyregister"></a>[`policy.register`](websocket-protocol/policy.md#policyregister)
- <a id="policyunregister"></a>[`policy.unregister`](websocket-protocol/policy.md#policyunregister)
- <a id="policylist"></a>[`policy.list`](websocket-protocol/policy.md#policylist)
- <a id="scheduler"></a>[scheduler](websocket-protocol/scheduler.md#scheduler)
- <a id="schedulesuggest"></a>[`schedule.suggest`](websocket-protocol/scheduler.md#schedulesuggest)
- <a id="schedulercreate"></a>[`scheduler.create`](websocket-protocol/scheduler.md#schedulercreate)
- <a id="schedulerrun"></a>[`scheduler.run`](websocket-protocol/scheduler.md#schedulerrun)
- <a id="schedulerrun_loop"></a>[`scheduler.run_loop`](websocket-protocol/scheduler.md#schedulerrun_loop)
- <a id="durable-os-level-scheduling-scheduleros_"></a>[Durable OS-level scheduling (`scheduler.os_*`)](websocket-protocol/scheduler.md#durable-os-level-scheduling-scheduleros_)
- <a id="tasks--daemon-native-deterministic-command-scheduler-car-releases72"></a>[`tasks.*` — daemon-native deterministic (command) scheduler (car-releases#72)](websocket-protocol/scheduler.md#tasks--daemon-native-deterministic-command-scheduler-car-releases72)
- <a id="secret"></a>[secret](websocket-protocol/secret.md#secret)
- <a id="secretput"></a>[`secret.put`](websocket-protocol/secret.md#secretput)
- <a id="secretget"></a>[`secret.get`](websocket-protocol/secret.md#secretget)
- <a id="secretdelete"></a>[`secret.delete`](websocket-protocol/secret.md#secretdelete)
- <a id="secretstatus"></a>[`secret.status`](websocket-protocol/secret.md#secretstatus)
- <a id="secretavailable"></a>[`secret.available`](websocket-protocol/secret.md#secretavailable)
- <a id="secretlist"></a>[`secret.list`](websocket-protocol/secret.md#secretlist)
- <a id="server"></a>[server](websocket-protocol/server.md#server)
- <a id="serverschema"></a>[`server.schema`](websocket-protocol/server.md#serverschema)
- <a id="session"></a>[session](websocket-protocol/session.md#session)
- <a id="sessioninit"></a>[`session.init`](websocket-protocol/session.md#sessioninit)
- <a id="sessionclear_halt"></a>[`session.clear_halt`](websocket-protocol/session.md#sessionclear_halt)
- <a id="sessionbindsubstrate"></a>[`session.bindSubstrate`](websocket-protocol/session.md#sessionbindsubstrate)
- <a id="sessionbindsandbox"></a>[`session.bindSandbox`](websocket-protocol/session.md#sessionbindsandbox)
- <a id="sessionpolicyopen"></a>[`session.policy.open`](websocket-protocol/session.md#sessionpolicyopen)
- <a id="sessionpolicyclose"></a>[`session.policy.close`](websocket-protocol/session.md#sessionpolicyclose)
- <a id="skill"></a>[skill](websocket-protocol/skill.md#skill)
- <a id="skillingest"></a>[`skill.ingest`](websocket-protocol/skill.md#skillingest)
- <a id="skillfind"></a>[`skill.find`](websocket-protocol/skill.md#skillfind)
- <a id="skillreport"></a>[`skill.report`](websocket-protocol/skill.md#skillreport)
- <a id="skillgate_deployment"></a>[`skill.gate_deployment`](websocket-protocol/skill.md#skillgate_deployment)
- <a id="skillenforce_deployment"></a>[`skill.enforce_deployment`](websocket-protocol/skill.md#skillenforce_deployment)
- <a id="skillingest_governed"></a>[`skill.ingest_governed`](websocket-protocol/skill.md#skillingest_governed)
- <a id="skilladopt_pack"></a>[`skill.adopt_pack`](websocket-protocol/skill.md#skilladopt_pack)
- <a id="skills"></a>[skills](websocket-protocol/skills.md#skills)
- <a id="skillsdistill"></a>[`skills.distill`](websocket-protocol/skills.md#skillsdistill)
- <a id="skillslist"></a>[`skills.list`](websocket-protocol/skills.md#skillslist)
- <a id="state"></a>[state](websocket-protocol/state.md#state)
- <a id="stateget"></a>[`state.get`](websocket-protocol/state.md#stateget)
- <a id="stateset"></a>[`state.set`](websocket-protocol/state.md#stateset)
- <a id="stateexists"></a>[`state.exists`](websocket-protocol/state.md#stateexists)
- <a id="statekeys"></a>[`state.keys`](websocket-protocol/state.md#statekeys)
- <a id="statesnapshot"></a>[`state.snapshot`](websocket-protocol/state.md#statesnapshot)
- <a id="inference-additional"></a>[inference (additional)](websocket-protocol/inference.md#inference-additional)
- <a id="rerank"></a>[`rerank`](websocket-protocol/inference.md#rerank)
- <a id="transcribe"></a>[`transcribe`](websocket-protocol/inference.md#transcribe)
- <a id="synthesize"></a>[`synthesize`](websocket-protocol/inference.md#synthesize)
- <a id="search"></a>[`search`](websocket-protocol/inference.md#search)
- <a id="web_fetch"></a>[`web_fetch`](websocket-protocol/inference.md#web_fetch)
- <a id="speechprepare"></a>[`speech.prepare`](websocket-protocol/inference.md#speechprepare)
- <a id="modelsroute"></a>[`models.route`](websocket-protocol/inference.md#modelsroute)
- <a id="modelsstats"></a>[`models.stats`](websocket-protocol/inference.md#modelsstats)
- <a id="outcomes"></a>[outcomes](websocket-protocol/outcomes.md#outcomes)
- <a id="outcomesscoreboard"></a>[`outcomes.scoreboard`](websocket-protocol/outcomes.md#outcomesscoreboard)
- <a id="outcomesresolve_pending"></a>[`outcomes.resolve_pending`](websocket-protocol/outcomes.md#outcomesresolve_pending)
- <a id="memory-additional"></a>[memory (additional)](websocket-protocol/memory.md#memory-additional)
- <a id="memoryconsolidate"></a>[`memory.consolidate`](websocket-protocol/memory.md#memoryconsolidate)
- <a id="memoryfact_count"></a>[`memory.fact_count`](websocket-protocol/memory.md#memoryfact_count)
- <a id="memoryutility_get"></a>[`memory.utility_get`](websocket-protocol/memory.md#memoryutility_get)
- <a id="memoryutility_set"></a>[`memory.utility_set`](websocket-protocol/memory.md#memoryutility_set)
- <a id="cascade"></a>[cascade](websocket-protocol/cascade.md#cascade)
- <a id="cascaderun"></a>[`cascade.run`](websocket-protocol/cascade.md#cascaderun)
- <a id="evolutionplan"></a>[`evolution.plan`](websocket-protocol/cascade.md#evolutionplan)
- <a id="evolutionrun"></a>[`evolution.run`](websocket-protocol/cascade.md#evolutionrun)
- <a id="sync"></a>[sync](websocket-protocol/sync.md#sync)
- <a id="syncstatus"></a>[`sync.status`](websocket-protocol/sync.md#syncstatus)
- <a id="syncappend"></a>[`sync.append`](websocket-protocol/sync.md#syncappend)
- <a id="syncassistant_checkpointput--syncassistant_checkpointget"></a>[`sync.assistant_checkpoint.put` / `sync.assistant_checkpoint.get`](websocket-protocol/sync.md#syncassistant_checkpointput--syncassistant_checkpointget)
- <a id="syncassistant_actionput--syncassistant_actionget"></a>[`sync.assistant_action.put` / `sync.assistant_action.get`](websocket-protocol/sync.md#syncassistant_actionput--syncassistant_actionget)
- <a id="syncknowledge"></a>[`sync.knowledge`](websocket-protocol/sync.md#syncknowledge)
- <a id="syncrecord_turn"></a>[`sync.record_turn`](websocket-protocol/sync.md#syncrecord_turn)
- <a id="syncrecord_intent"></a>[`sync.record_intent`](websocket-protocol/sync.md#syncrecord_intent)
- <a id="syncpump"></a>[`sync.pump`](websocket-protocol/sync.md#syncpump)
- <a id="synccheckpoint"></a>[`sync.checkpoint`](websocket-protocol/sync.md#synccheckpoint)
- <a id="syncrebase"></a>[`sync.rebase`](websocket-protocol/sync.md#syncrebase)
- <a id="synctranscript"></a>[`sync.transcript`](websocket-protocol/sync.md#synctranscript)
- <a id="syncresume"></a>[`sync.resume`](websocket-protocol/sync.md#syncresume)
- <a id="syncfence_check"></a>[`sync.fence_check`](websocket-protocol/sync.md#syncfence_check)
- <a id="lease"></a>[lease](websocket-protocol/lease.md#lease)
- <a id="leaseacquire"></a>[`lease.acquire`](websocket-protocol/lease.md#leaseacquire)
- <a id="leaserenew"></a>[`lease.renew`](websocket-protocol/lease.md#leaserenew)
- <a id="leaserelease"></a>[`lease.release`](websocket-protocol/lease.md#leaserelease)
- <a id="leasestatus"></a>[`lease.status`](websocket-protocol/lease.md#leasestatus)
- <a id="skills-additional"></a>[skills (additional)](websocket-protocol/skills.md#skills-additional)
- <a id="skillrepair"></a>[`skill.repair`](websocket-protocol/skills.md#skillrepair)
- <a id="skillsingest_distilled"></a>[`skills.ingest_distilled`](websocket-protocol/skills.md#skillsingest_distilled)
- <a id="skillsevolve"></a>[`skills.evolve`](websocket-protocol/skills.md#skillsevolve)
- <a id="skillsdomains_needing_evolution"></a>[`skills.domains_needing_evolution`](websocket-protocol/skills.md#skillsdomains_needing_evolution)
- <a id="skillsingest_provisional"></a>[`skills.ingest_provisional`](websocket-protocol/skills.md#skillsingest_provisional)
- <a id="skillsgate"></a>[`skills.gate`](websocket-protocol/skills.md#skillsgate)
- <a id="skillmeta"></a>[`skill.meta`](websocket-protocol/skills.md#skillmeta)
- <a id="skillexport"></a>[`skill.export`](websocket-protocol/skills.md#skillexport)
- <a id="skillimport"></a>[`skill.import`](websocket-protocol/skills.md#skillimport)
- <a id="events--replan"></a>[events / replan](websocket-protocol/events.md#events--replan)
- <a id="eventscount"></a>[`events.count`](websocket-protocol/events.md#eventscount)
- <a id="eventsstats"></a>[`events.stats`](websocket-protocol/events.md#eventsstats)
- <a id="eventstruncate"></a>[`events.truncate`](websocket-protocol/events.md#eventstruncate)
- <a id="eventsclear"></a>[`events.clear`](websocket-protocol/events.md#eventsclear)
- <a id="eventsquery"></a>[`events.query`](websocket-protocol/events.md#eventsquery)
- <a id="eventschainenable"></a>[`events.chain.enable`](websocket-protocol/events.md#eventschainenable)
- <a id="eventschainverify"></a>[`events.chain.verify`](websocket-protocol/events.md#eventschainverify)
- <a id="eventsretention"></a>[`events.retention`](websocket-protocol/events.md#eventsretention)
- <a id="nlpidentify_language--nlptokenize--nlpextract_entities"></a>[`nlp.identify_language` / `nlp.tokenize` / `nlp.extract_entities`](websocket-protocol/events.md#nlpidentify_language--nlptokenize--nlpextract_entities)
- <a id="metricssummary"></a>[`metrics.summary`](websocket-protocol/events.md#metricssummary)
- <a id="metricsalerts"></a>[`metrics.alerts`](websocket-protocol/events.md#metricsalerts)
- <a id="heal--the-self-healing-repair-loop"></a>[`heal.*` — the self-healing repair loop](websocket-protocol/heal.md#heal--the-self-healing-repair-loop)
- <a id="healstatus"></a>[`heal.status`](websocket-protocol/heal.md#healstatus)
- <a id="healrun"></a>[`heal.run`](websocket-protocol/heal.md#healrun)
- <a id="selfhealstatus"></a>[`selfheal.status`](websocket-protocol/heal.md#selfhealstatus)
- <a id="selfhealdetections"></a>[`selfheal.detections`](websocket-protocol/heal.md#selfhealdetections)
- <a id="selfhealdismiss"></a>[`selfheal.dismiss`](websocket-protocol/heal.md#selfhealdismiss)
- <a id="selfhealfix"></a>[`selfheal.fix`](websocket-protocol/heal.md#selfhealfix)
- <a id="selfhealrun"></a>[`selfheal.run`](websocket-protocol/heal.md#selfhealrun)
- <a id="eventscost_by_agent"></a>[`events.cost_by_agent`](websocket-protocol/heal.md#eventscost_by_agent)
- <a id="replanset_config"></a>[`replan.set_config`](websocket-protocol/heal.md#replanset_config)
- <a id="runs"></a>[runs](websocket-protocol/runs.md#runs)
- <a id="runsstart"></a>[`runs.start`](websocket-protocol/runs.md#runsstart)
- <a id="runsresume-runsresumev1"></a>[`runs.resume` (`runs.resume.v1`)](websocket-protocol/runs.md#runsresume-runsresumev1)
- <a id="runscomplete"></a>[`runs.complete`](websocket-protocol/runs.md#runscomplete)
- <a id="runscancel-runscancelv1"></a>[`runs.cancel` (`runs.cancel.v1`)](websocket-protocol/runs.md#runscancel-runscancelv1)
- <a id="runsrecord_model_turn"></a>[`runs.record_model_turn`](websocket-protocol/runs.md#runsrecord_model_turn)
- <a id="runsrecord_turns"></a>[`runs.record_turns`](websocket-protocol/runs.md#runsrecord_turns)
- <a id="runssubscribe"></a>[`runs.subscribe`](websocket-protocol/runs.md#runssubscribe)
- <a id="runsunsubscribe"></a>[`runs.unsubscribe`](websocket-protocol/runs.md#runsunsubscribe)
- <a id="runstraceevent-server--client-notification"></a>[`runs.trace.event` (server → client notification)](websocket-protocol/runs.md#runstraceevent-server--client-notification)
- <a id="runslist"></a>[`runs.list`](websocket-protocol/runs.md#runslist)
- <a id="runsget_trace"></a>[`runs.get_trace`](websocket-protocol/runs.md#runsget_trace)
- <a id="tools"></a>[tools](websocket-protocol/tools.md#tools)
- <a id="toolsregister"></a>[`tools.register`](websocket-protocol/tools.md#toolsregister)
- <a id="toolslist"></a>[`tools.list`](websocket-protocol/tools.md#toolslist)
- <a id="toolsunregister"></a>[`tools.unregister`](websocket-protocol/tools.md#toolsunregister)
- <a id="detached-tool-dispatch-streaming--long-running-epic-c--c2"></a>[Detached tool dispatch (streaming / long-running, EPIC C / C2)](websocket-protocol/tools.md#detached-tool-dispatch-streaming--long-running-epic-c--c2)
- <a id="toolspoll"></a>[`tools.poll`](websocket-protocol/tools.md#toolspoll)
- <a id="toolscancel"></a>[`tools.cancel`](websocket-protocol/tools.md#toolscancel)
- <a id="toolsstreamsubscribe"></a>[`tools.stream.subscribe`](websocket-protocol/tools.md#toolsstreamsubscribe)
- <a id="policy-1"></a>[policy](websocket-protocol/policy.md#policy-1)
- <a id="policyregister-1"></a>[`policy.register`](websocket-protocol/policy.md#policyregister-1)
- <a id="agents"></a>[agents](websocket-protocol/agents.md#agents)
- <a id="agentsregister_basics"></a>[`agents.register_basics`](websocket-protocol/agents.md#agentsregister_basics)
- <a id="agentslist"></a>[`agents.list`](websocket-protocol/agents.md#agentslist)
- <a id="agentsupsert"></a>[`agents.upsert`](websocket-protocol/agents.md#agentsupsert)
- <a id="agentsinstall"></a>[`agents.install`](websocket-protocol/agents.md#agentsinstall)
- <a id="agentshealth"></a>[`agents.health`](websocket-protocol/agents.md#agentshealth)
- <a id="agentsremove"></a>[`agents.remove`](websocket-protocol/agents.md#agentsremove)
- <a id="agentsstart"></a>[`agents.start`](websocket-protocol/agents.md#agentsstart)
- <a id="agentsstop"></a>[`agents.stop`](websocket-protocol/agents.md#agentsstop)
- <a id="agentsrestart"></a>[`agents.restart`](websocket-protocol/agents.md#agentsrestart)
- <a id="agentswait"></a>[`agents.wait`](websocket-protocol/agents.md#agentswait)
- <a id="agentstail_log"></a>[`agents.tail_log`](websocket-protocol/agents.md#agentstail_log)
- <a id="agentschat"></a>[`agents.chat`](websocket-protocol/agents.md#agentschat)
- <a id="goalsuggest"></a>[`goal.suggest`](websocket-protocol/agents.md#goalsuggest)
- <a id="goalset"></a>[`goal.set`](websocket-protocol/agents.md#goalset)
- <a id="goalstatus"></a>[`goal.status`](websocket-protocol/agents.md#goalstatus)
- <a id="goalclear"></a>[`goal.clear`](websocket-protocol/agents.md#goalclear)
- <a id="agentchat-daemon--agent-reverse-call--agentchatevent"></a>[`agent.chat` (daemon → agent reverse-call) + `agent.chat.event`](websocket-protocol/agents.md#agentchat-daemon--agent-reverse-call--agentchatevent)
- <a id="agentspeers"></a>[`agents.peers`](websocket-protocol/agents.md#agentspeers)
- <a id="agentsmessage"></a>[`agents.message`](websocket-protocol/agents.md#agentsmessage)
- <a id="agentsmessagepending"></a>[`agents.message.pending`](websocket-protocol/agents.md#agentsmessagepending)
- <a id="agentsmessageapprove"></a>[`agents.message.approve`](websocket-protocol/agents.md#agentsmessageapprove)
- <a id="agentschatcancel"></a>[`agents.chat.cancel`](websocket-protocol/agents.md#agentschatcancel)
- <a id="agentschatapprove"></a>[`agents.chat.approve`](websocket-protocol/agents.md#agentschatapprove)
- <a id="agentslist_external"></a>[`agents.list_external`](websocket-protocol/agents.md#agentslist_external)
- <a id="how-binary_path-is-resolved"></a>[How `binary_path` is resolved](websocket-protocol/agents.md#how-binary_path-is-resolved)
- <a id="agentsdetect_external"></a>[`agents.detect_external`](websocket-protocol/agents.md#agentsdetect_external)
- <a id="agentshealth_external"></a>[`agents.health_external`](websocket-protocol/agents.md#agentshealth_external)
- <a id="agentsinvoke_external"></a>[`agents.invoke_external`](websocket-protocol/agents.md#agentsinvoke_external)
- <a id="assistants"></a>[assistants](websocket-protocol/assistants.md#assistants)
- <a id="assistantsinvoke"></a>[`assistants.invoke`](websocket-protocol/assistants.md#assistantsinvoke)
- <a id="foreman"></a>[foreman](websocket-protocol/foreman.md#foreman)
- <a id="foremanplan"></a>[`foreman.plan`](websocket-protocol/foreman.md#foremanplan)
- <a id="foremanrun"></a>[`foreman.run`](websocket-protocol/foreman.md#foremanrun)
- <a id="multiplayer"></a>[multiplayer](websocket-protocol/multiplayer.md#multiplayer)
- <a id="multiplayerpublish"></a>[`multiplayer.publish`](websocket-protocol/multiplayer.md#multiplayerpublish)
- <a id="multiplayerstart_stage"></a>[`multiplayer.start_stage`](websocket-protocol/multiplayer.md#multiplayerstart_stage)
- <a id="multiplayersubmit_stage"></a>[`multiplayer.submit_stage`](websocket-protocol/multiplayer.md#multiplayersubmit_stage)
- <a id="multiplayerabandon"></a>[`multiplayer.abandon`](websocket-protocol/multiplayer.md#multiplayerabandon)
- <a id="multiplayerlist"></a>[`multiplayer.list`](websocket-protocol/multiplayer.md#multiplayerlist)
- <a id="multiplayerget"></a>[`multiplayer.get`](websocket-protocol/multiplayer.md#multiplayerget)
- <a id="multiplayermerge_check"></a>[`multiplayer.merge_check`](websocket-protocol/multiplayer.md#multiplayermerge_check)
- <a id="fleet"></a>[fleet](websocket-protocol/fleet.md#fleet)
- <a id="fleetinventory"></a>[`fleet.inventory`](websocket-protocol/fleet.md#fleetinventory)
- <a id="fleetcomposite"></a>[`fleet.composite`](websocket-protocol/fleet.md#fleetcomposite)
- <a id="fleetworkerget"></a>[`fleet.worker.get`](websocket-protocol/fleet.md#fleetworkerget)
- <a id="fleetworkerset"></a>[`fleet.worker.set`](websocket-protocol/fleet.md#fleetworkerset)
- <a id="coder"></a>[coder](websocket-protocol/coder.md#coder)
- <a id="coderstart"></a>[`coder.start`](websocket-protocol/coder.md#coderstart)
- <a id="coderconfirm_contract"></a>[`coder.confirm_contract`](websocket-protocol/coder.md#coderconfirm_contract)
- <a id="coderlist"></a>[`coder.list`](websocket-protocol/coder.md#coderlist)
- <a id="session_summary"></a>[`session_summary`](websocket-protocol/coder.md#session_summary)
- <a id="coderwatch--coderunwatch"></a>[`coder.watch` / `coder.unwatch`](websocket-protocol/coder.md#coderwatch--coderunwatch)
- <a id="codersession_changed-notification"></a>[`coder.session_changed` (notification)](websocket-protocol/coder.md#codersession_changed-notification)
- <a id="coderrefresh_review"></a>[`coder.refresh_review`](websocket-protocol/coder.md#coderrefresh_review)
- <a id="coderrevise_contract"></a>[`coder.revise_contract`](websocket-protocol/coder.md#coderrevise_contract)
- <a id="already-happened-errors-confirm--approve--revise"></a>[Already-happened errors (confirm / approve / revise)](websocket-protocol/coder.md#already-happened-errors-confirm--approve--revise)
- <a id="coderget"></a>[`coder.get`](websocket-protocol/coder.md#coderget)
- <a id="codersubscribe--coderunsubscribe"></a>[`coder.subscribe` / `coder.unsubscribe`](websocket-protocol/coder.md#codersubscribe--coderunsubscribe)
- <a id="coderrespond"></a>[`coder.respond`](websocket-protocol/coder.md#coderrespond)
- <a id="coderapprove_merge"></a>[`coder.approve_merge`](websocket-protocol/coder.md#coderapprove_merge)
- <a id="codercancel"></a>[`coder.cancel`](websocket-protocol/coder.md#codercancel)
- <a id="coderdiscuss"></a>[`coder.discuss.*`](websocket-protocol/coder.md#coderdiscuss)
- <a id="managed-projects-coderprojects"></a>[Managed projects (`coder.projects.*`)](websocket-protocol/coder.md#managed-projects-coderprojects)
- <a id="declagents"></a>[declagents](websocket-protocol/declagents.md#declagents)
- <a id="voice"></a>[voice](websocket-protocol/voice.md#voice)
- <a id="voiceprepare_parakeet"></a>[`voice.prepare_parakeet`](websocket-protocol/voice.md#voiceprepare_parakeet)
- <a id="voiceprepare_diarizer"></a>[`voice.prepare_diarizer`](websocket-protocol/voice.md#voiceprepare_diarizer)
- <a id="voicetranscribe_streamstart"></a>[`voice.transcribe_stream.start`](websocket-protocol/voice.md#voicetranscribe_streamstart)
- <a id="voicetranscribe_streampush"></a>[`voice.transcribe_stream.push`](websocket-protocol/voice.md#voicetranscribe_streampush)
- <a id="voicetranscribe_streamstop"></a>[`voice.transcribe_stream.stop`](websocket-protocol/voice.md#voicetranscribe_streamstop)
- <a id="voicetts_streamstart"></a>[`voice.tts_stream.start`](websocket-protocol/voice.md#voicetts_streamstart)
- <a id="voicetts_streamcancel"></a>[`voice.tts_stream.cancel`](websocket-protocol/voice.md#voicetts_streamcancel)
- <a id="voicetts_streamlist"></a>[`voice.tts_stream.list`](websocket-protocol/voice.md#voicetts_streamlist)
- <a id="voicesessionslist"></a>[`voice.sessions.list`](websocket-protocol/voice.md#voicesessionslist)
- <a id="voiceproviderslist"></a>[`voice.providers.list`](websocket-protocol/voice.md#voiceproviderslist)
- <a id="voiceenroll_speaker"></a>[`voice.enroll_speaker`](websocket-protocol/voice.md#voiceenroll_speaker)
- <a id="voicelist_enrollments"></a>[`voice.list_enrollments`](websocket-protocol/voice.md#voicelist_enrollments)
- <a id="voiceremove_enrollment"></a>[`voice.remove_enrollment`](websocket-protocol/voice.md#voiceremove_enrollment)
- <a id="voicedispatch_turn"></a>[`voice.dispatch_turn`](websocket-protocol/voice.md#voicedispatch_turn)
- <a id="voicecancel_turn"></a>[`voice.cancel_turn`](websocket-protocol/voice.md#voicecancel_turn)
- <a id="voiceprewarm_turn"></a>[`voice.prewarm_turn`](websocket-protocol/voice.md#voiceprewarm_turn)
- <a id="inference"></a>[inference](websocket-protocol/inference.md#inference)
- <a id="inferenceregister_runner"></a>[`inference.register_runner`](websocket-protocol/inference.md#inferenceregister_runner)
- <a id="inferencerunnerevent"></a>[`inference.runner.event`](websocket-protocol/inference.md#inferencerunnerevent)
- <a id="inferencerunnercomplete"></a>[`inference.runner.complete`](websocket-protocol/inference.md#inferencerunnercomplete)
- <a id="inferencerunnerfail"></a>[`inference.runner.fail`](websocket-protocol/inference.md#inferencerunnerfail)
- <a id="inferencerunnerinvoke-server--client-notification"></a>[`inference.runner.invoke` (server → client notification)](websocket-protocol/inference.md#inferencerunnerinvoke-server--client-notification)
- <a id="voiceturn-event-taxonomy"></a>[`voice.turn.*` event taxonomy](websocket-protocol/inference.md#voiceturn-event-taxonomy)
- <a id="workflow"></a>[workflow](websocket-protocol/workflow.md#workflow)
- <a id="workflowrun"></a>[`workflow.run`](websocket-protocol/workflow.md#workflowrun)
- <a id="workflowchain"></a>[`workflow.chain`](websocket-protocol/workflow.md#workflowchain)
- <a id="workflowresume"></a>[`workflow.resume`](websocket-protocol/workflow.md#workflowresume)
- <a id="workflowlist_paused"></a>[`workflow.list_paused`](websocket-protocol/workflow.md#workflowlist_paused)
- <a id="workflowverify"></a>[`workflow.verify`](websocket-protocol/workflow.md#workflowverify)
- <a id="workflowbuild_automation"></a>[`workflow.build_automation`](websocket-protocol/workflow.md#workflowbuild_automation)
- <a id="builderbuild"></a>[`builder.build`](websocket-protocol/workflow.md#builderbuild)
- <a id="top-level-no-namespace"></a>[Top-level (no namespace)](websocket-protocol/top-level.md#top-level-no-namespace)
- <a id="verify"></a>[`verify`](websocket-protocol/top-level.md#verify)
- <a id="verifymonte_carlo"></a>[`verify.monte_carlo`](websocket-protocol/top-level.md#verifymonte_carlo)
- <a id="permission--the-permission-tier-safety-governor-survey-343-525"></a>[`permission.*` — the permission-tier safety governor (survey §3.4.3, §5.2.5)](websocket-protocol/top-level.md#permission--the-permission-tier-safety-governor-survey-343-525)
- <a id="agent_permissions--per-agent-approval-policy-ws-only"></a>[`agent_permissions.*` — per-agent approval policy (WS-only)](websocket-protocol/top-level.md#agent_permissions--per-agent-approval-policy-ws-only)
- <a id="infer"></a>[`infer`](websocket-protocol/top-level.md#infer)
- <a id="infercancel"></a>[`infer.cancel`](websocket-protocol/top-level.md#infercancel)
- <a id="inferdeadline"></a>[`infer.deadline`](websocket-protocol/top-level.md#inferdeadline)
- <a id="infer_stream"></a>[`infer_stream`](websocket-protocol/top-level.md#infer_stream)
- <a id="imagegenerate"></a>[`image.generate`](websocket-protocol/top-level.md#imagegenerate)
- <a id="videogenerate"></a>[`video.generate`](websocket-protocol/top-level.md#videogenerate)
- <a id="embed"></a>[`embed`](websocket-protocol/top-level.md#embed)
- <a id="classify"></a>[`classify`](websocket-protocol/top-level.md#classify)
- <a id="tokenize"></a>[`tokenize`](websocket-protocol/top-level.md#tokenize)
- <a id="detokenize"></a>[`detokenize`](websocket-protocol/top-level.md#detokenize)
- <a id="lattice"></a>[lattice](websocket-protocol/lattice.md#lattice)
- <a id="latticejoin"></a>[`lattice.join`](websocket-protocol/lattice.md#latticejoin)
- <a id="latticeleave"></a>[`lattice.leave`](websocket-protocol/lattice.md#latticeleave)
- <a id="latticenodes"></a>[`lattice.nodes`](websocket-protocol/lattice.md#latticenodes)
- <a id="latticefind"></a>[`lattice.find`](websocket-protocol/lattice.md#latticefind)
- <a id="latticewait"></a>[`lattice.wait`](websocket-protocol/lattice.md#latticewait)
- <a id="latticerequests"></a>[`lattice.requests`](websocket-protocol/lattice.md#latticerequests)
- <a id="latticerespond"></a>[`lattice.respond`](websocket-protocol/lattice.md#latticerespond)
- <a id="latticeclaim"></a>[`lattice.claim`](websocket-protocol/lattice.md#latticeclaim)
- <a id="latticerelease"></a>[`lattice.release`](websocket-protocol/lattice.md#latticerelease)
- <a id="latticeclaims"></a>[`lattice.claims`](websocket-protocol/lattice.md#latticeclaims)
- <a id="latticeconnectinvite"></a>[`lattice.connect.invite`](websocket-protocol/lattice.md#latticeconnectinvite)
- <a id="latticeconnectinspect"></a>[`lattice.connect.inspect`](websocket-protocol/lattice.md#latticeconnectinspect)
- <a id="latticeconnectaccept"></a>[`lattice.connect.accept`](websocket-protocol/lattice.md#latticeconnectaccept)
- <a id="latticeconnectconfirm"></a>[`lattice.connect.confirm`](websocket-protocol/lattice.md#latticeconnectconfirm)
- <a id="latticeconnections"></a>[`lattice.connections`](websocket-protocol/lattice.md#latticeconnections)
- <a id="latticeconnectshare"></a>[`lattice.connect.share`](websocket-protocol/lattice.md#latticeconnectshare)
- <a id="latticeconnectlabel"></a>[`lattice.connect.label`](websocket-protocol/lattice.md#latticeconnectlabel)
- <a id="latticedisconnect"></a>[`lattice.disconnect`](websocket-protocol/lattice.md#latticedisconnect)
- <a id="latticeknock"></a>[`lattice.knock`](websocket-protocol/lattice.md#latticeknock)
- <a id="latticeknocks"></a>[`lattice.knocks`](websocket-protocol/lattice.md#latticeknocks)
- <a id="latticeknockaccept"></a>[`lattice.knock.accept`](websocket-protocol/lattice.md#latticeknockaccept)
- <a id="latticeknockdecline"></a>[`lattice.knock.decline`](websocket-protocol/lattice.md#latticeknockdecline)
- <a id="latticeknockwithdraw"></a>[`lattice.knock.withdraw`](websocket-protocol/lattice.md#latticeknockwithdraw)
- <a id="latticeknocksettings"></a>[`lattice.knock.settings`](websocket-protocol/lattice.md#latticeknocksettings)
- <a id="latticeknockblock"></a>[`lattice.knock.block`](websocket-protocol/lattice.md#latticeknockblock)
- <a id="latticedirectory"></a>[`lattice.directory`](websocket-protocol/lattice.md#latticedirectory)
- <a id="latticerelayprobe"></a>[`lattice.relay.probe`](websocket-protocol/lattice.md#latticerelayprobe)
- <a id="latticeorgstatus"></a>[`lattice.org.status`](websocket-protocol/lattice.md#latticeorgstatus)
- <a id="latticeorgattest"></a>[`lattice.org.attest`](websocket-protocol/lattice.md#latticeorgattest)
- <a id="latticeorgrevoke"></a>[`lattice.org.revoke`](websocket-protocol/lattice.md#latticeorgrevoke)
- <a id="latticeorgpolicy"></a>[`lattice.org.policy`](websocket-protocol/lattice.md#latticeorgpolicy)
- <a id="latticeorgrules"></a>[`lattice.org.rules`](websocket-protocol/lattice.md#latticeorgrules)
- <a id="latticeorgruleadd"></a>[`lattice.org.rule.add`](websocket-protocol/lattice.md#latticeorgruleadd)
- <a id="latticeorgruleremove"></a>[`lattice.org.rule.remove`](websocket-protocol/lattice.md#latticeorgruleremove)
- <a id="peerscert_status"></a>[`peers.cert_status`](websocket-protocol/lattice.md#peerscert_status)
- <a id="peerscert_conflict_clear"></a>[`peers.cert_conflict_clear`](websocket-protocol/lattice.md#peerscert_conflict_clear)
- <a id="hostevent"></a>[`host.event`](websocket-protocol/host.md#hostevent)
- <a id="browsersignin_needed--browsersignin_resolved"></a>[`browser.signin_needed` / `browser.signin_resolved`](websocket-protocol/host.md#browsersignin_needed--browsersignin_resolved)
- <a id="voiceevent"></a>[`voice.event`](websocket-protocol/voice.md#voiceevent)
- <a id="coderevent"></a>[`coder.event`](websocket-protocol/coder.md#coderevent)
- <a id="codersession_changed"></a>[`coder.session_changed`](websocket-protocol/coder.md#codersession_changed)
- <a id="coderdiscussevent"></a>[`coder.discuss.event`](websocket-protocol/coder.md#coderdiscussevent)
- <a id="notes-1"></a>[Notes](#notes)
<!-- ws-protocol:moved-anchors:end -->

{% endraw %}
