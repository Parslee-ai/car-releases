{% raw %}
# CAR WebSocket Protocol Reference

`car-server` exposes the runtime over a WebSocket using JSON-RPC 2.0. This is the **language-agnostic surface** for CAR — anything that can speak WebSocket and JSON can drive it.

As of **v0.8.0**, the WebSocket protocol is the only runtime entry point. The Node.js (`car-runtime` on npm) and Python (`car-runtime` on PyPI) bindings are thin clients that proxy every method over this same WebSocket — the embedded-engine fallback they shipped through v0.7.x has been retired (#139). For every consumer on a host, one daemon, one admission semaphore, one model cache.

Use the bindings when you want the ergonomic per-language API. Use the WebSocket directly when you're building from a language without bindings (Go, Rust, browser, Swift, Kotlin), or when you need streaming / callback-bearing methods (`infer_stream`, `tools.execute`, voice turns) — those are not bridged into the FFI surface in v0.8.

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
assistant (see [`assistant.identity.*`](#assistant)). They ride on the handshake
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

**`initialize` negotiates the protocol version.** The `initialize` result carries back the `protocolVersion` the client asked for when it is one this server supports (`car_mcp::SUPPORTED_VERSIONS`, a single entry — `2024-11-05` — today). Absent, non-string, and unsupported all get `car_mcp::PROTOCOL_VERSION` instead, as a normal result rather than a JSON-RPC error, leaving the client to proceed or disconnect. Nothing observable changes while the list holds one entry; the point is that appending a revision later cannot hand an old client a version it never asked for.

**A notification POST returns `202 Accepted` with an empty body.** A JSON-RPC message with no `id` has no reply, so `POST /mcp` answers it with a bare 202 — do not parse the body.

**`Origin` validation on `/mcp`** (DNS-rebinding protection, required by the MCP HTTP transport). The rule is absent-permissive, present-strict:

| `Origin` header | Result |
|-----------------|--------|
| absent | **allowed** — a browser always sends `Origin` cross-origin, so its absence cannot be a browser attack. This is what keeps `curl`, Claude Desktop, Cursor, Claude Code `--mcp-config`, Codex, and CAR's own connectors client working: none of them send one. |
| loopback — `http`/`https` on `localhost`, `127.0.0.0/8`, or `::1`, any port | **allowed** |
| anything else, including the literal `null` (sandboxed iframe, `file://`, redirected cross-origin) | **`403`** with `{"error":"origin not allowed"}` |

Both `POST /mcp` and `GET /mcp` are guarded; a rejected request never reaches `Server::handle` and never registers an SSE session. **`GET /mcp/health` is exempt** — it has no side effect and no secrets, and the documented uptime `curl` plus browser probes must keep working.

The rule does not widen for a non-loopback `--mcp-bind`: a wildcard bind's host is `0.0.0.0`, which never appears as an `Origin` value, and wider exposure makes the guard more important, not less. To serve browser traffic from another origin, front the daemon with a reverse proxy that owns its own CORS/`Origin` policy.

**`MCP-Protocol-Version` on `/mcp`.** Once a client has negotiated a revision on `initialize`, the HTTP transport asks it to name that revision on every later request. Same absent-permissive, present-strict shape as `Origin`:

| `MCP-Protocol-Version` header | Result |
|-------------------------------|--------|
| absent | **allowed** — every shipped client sends nothing today, and `car_mcp::SUPPORTED_VERSIONS` holds one entry, so the version a silent client negotiated is necessarily the one we would have demanded |
| a value in `car_mcp::SUPPORTED_VERSIONS` (`2024-11-05` today) | **allowed** |
| anything else, including an empty or non-UTF-8 value | **`400`** with `{"error":"unsupported MCP-Protocol-Version","requested":"…","supported":["2024-11-05"]}` |

Both `POST /mcp` and `GET /mcp` are guarded, before the JSON-RPC parse and before the SSE session insert respectively, so a rejected request runs no tool and leaves no session behind. **`GET /mcp/health` is exempt** — a client whose version we just rejected reads `protocol_version` off that probe to learn what we speak.

A foreign value is a `400` rather than a silent downshift because the header states which dialect the client will read the reply in; answering in a revision it never agreed to is the inversion `initialize` negotiation exists to prevent. The `400` body names the supported list so a client that guessed wrong can correct itself. CAR's own MCP *client* (`car-connectors`) already sends this header with the version it negotiated, so it is unaffected.

**`completion/complete` is served here too** (car#972 §4), and it changes nothing about the endpoint: argument autocompletion is one POST in, one response out — no session, no SSE stream, no server-to-client push — so `POST /mcp` stays stateless. `initialize` advertises `"completions": {}` on both transports. It completes the `car_context` prompt's `mode` argument and resource URIs by prefix; a request naming something CAR does not know returns an empty completion, while a request that names nothing to complete at all (no `ref`, no `argument`, no `argument.name`) is `-32602`. Full semantics in `docs/CAR_AGENT_AUTHORING_GUIDE.md`.

#### The assistant tools (`assistant_start` / `assistant_poll` / `assistant_cancel`)

**On the daemon endpoint only.** The MCP tool list is per-`Server`, and the daemon registers three tools the stdio binary (`car-mcp-server`) does not: it has no `Runtime` and no inference engine, so it answers `assistant_start` with a `-32601` "unknown tool". Delegate with `car do --json` there instead.

An assistant run takes minutes, so `assistant_start` returns a handle immediately rather than blocking a `tools/call` that most hosts would time out. **This does not make the endpoint stateful**: the `run_id` is application state the *client* carries between calls, the same category as the opaque `resources/list` cursor. `POST /mcp` still reads no session header.

| Tool | Arguments | Result |
|---|---|---|
| `assistant_start` | `task` (required), `cwd?`, `until?`, `max_turns?` (default 50, max 200), `local?` (default false), `model?`, `invoked_by?` | `{ run_id, status: "running", poll_after_ms, sandbox, ancestry }` |
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

- does **not** write the shared auth-token file — its token stays in memory, so reach it with the value you passed to `--auth-token` or `CAR_AUTH_TOKEN`;
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

Or an error:

```json
{"jsonrpc": "2.0", "id": "cb-1", "error": {"code": -32000, "message": "tool unavailable"}}
```

The Rust client at `car_ffi_common::proxy::DaemonClient` exposes `register_handler(method, handler)` which installs a closure that the recv loop dispatches inbound `tools.execute` requests to — that's the pattern any WS client should follow.

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

For a mutating request this is an ambiguous outcome: the handler may have
committed before its future was dropped. Clients must not treat `-32004` as a
terminal application failure or immediately retry the mutation. Reconcile
through that method's authoritative read before deciding whether to retry.

Most methods take a flat generous deadline (30 minutes by default, overridable
with `CAR_HANDLER_TIMEOUT`). `proposal.submit` is the exception: its deadline is
derived from the submitted proposal's own action budgets — the sum over actions
of `timeout_ms` (defaulting to the daemon's 300-second tool budget) times the
attempts the executor will run for that action (`max_retries + 1` for
`failure_behavior: "retry"`, otherwise one), plus a 15-second transport grace.
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
implementation with `car auth login parslee` (the `car-auth` crate).
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
| `auth.switch_account` | `account_id` (req), `api_base?` | `{ authenticated, session }` — swap which stored login is active (the daemon swaps the keychain token slots), refresh, and return the newly-active login's session. |
| `auth.remove_account` | `account_id` (req) | `{ ok, accounts }` — forget a stored login (deletes its stashed tokens). If it was active, another remaining login becomes active, or the session clears when none remain. |
| `auth.logout` | — | `{ ok: true }` — clears stored Parslee credentials |

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

### Secret-store activity diagnostics

`diagnostics.secret_store_activity {}` is a host-management-only, WS-only read
of process-lifetime aggregate operation attempts. It requires protocol v3 and
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
can technically invoke `automation.run_applescript` or
`messages.send`. AppleScript can do anything the user can; a
silent `messages.send` ships data to attacker-chosen contacts.
Auth gates *who* can call; the approval gate gates *what* runs.

**Gated methods** (default set):

- `automation.run_applescript`
- `automation.run_powershell`
- `automation.shortcuts.run`
- `messages.send`
- `mail.send`
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

#### `session.auth`

- **Params**: `{ token: string, agent_id?: string, memory_namespace?: string }` **or**
  `{ host_token: string, memory_namespace?: string }` (host-role handshake, #254)
- **Returns**: `{ ok: true, auth_enabled: bool, agent_id?: string, memory_namespace?: string, parslee?: ParsleeIdentity }`,
  or `{ ok: true, auth_enabled: true, role: "host", memory_namespace?: string }` for the host-token path
- **`memory_namespace`** binds this connection to a daemon-owned memory graph
  private to that namespace, persisted at
  `~/.car/memory/memory-namespaces/<encoded-ns>.json`.
  Omit it and the connection uses the daemon's **shared** graph — see the scope
  table under [memory](#memory) for what that means for a multi-project host.
  Accepted on every auth path, including the host-token handshake. **FFI hosts
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
  agent identity. A second connection presenting the same
  `agent_id` is rejected with "already attached on another
  connection" so daemon-side per-agent state stays unambiguous.
  The legacy unbound-token path remains valid for browser/host/CLI
  clients — `agent_id` is optional. Lifecycle-agent SDKs read
  `CAR_AGENT_ID` and `CAR_AGENT_TOKEN` from the env the supervisor
  set on spawn (#172).
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

411 methods across 71 namespaces. Each section below documents params, returns, and notable
behavior. This section is long — for a compact map of every method with deep links into it, read
[websocket-protocol-index.md](websocket-protocol-index.md) first and follow only the links you need.

<!-- These counts are derived, not hand-maintained: `bash scripts/gen-ws-namespace-index.sh`
     reports them and fails on coverage gaps. The previous figure here ("73+ methods across 23
     namespaces") had drifted to ~5.6x wrong on namespaces while sitting live on the public
     site, because nobody rereads 5000 lines to notice a stale summary. Re-run the generator
     rather than editing these numbers by hand. -->

### accounts

#### `accounts.list`
- **Params**: `{}`
- **Returns**: `{ accounts: Account[] }`
- OS-native account discovery.

#### `accounts.open`
- **Params**: `{ account_id?: string }`
- **Returns**: settings/UI data for account configuration

### assistant

The name the flagship assistant answers to — in its own system prompt, in every
host's addressing copy, and as its voice wake word. One record
(`~/.car/identity.json`, via the `car-identity` crate) feeds all three.

Not to be confused with `assistants.invoke` (invoking a *named assistant*) or
with `session.identity` (which identifies the connected *client*).

#### `assistant.identity.get`
- **Params**: `{}`
- **Returns**: `{ name, spellings: string[], aliases: string[], user_name: string | null, brand, updated_at_unix }`
- `aliases` is derived, not stored: the name and its alternate spellings crossed
  with `hey`/`hi`/`ok`/`okay`, longest first. Hosts match wake phrases against it
  **locally** (their matcher has to work before the daemon answers), and deriving
  it in one place is what keeps Swift, Kotlin, and Rust from drifting into three
  different wake sets.
- `spellings` are the ways speech-to-text is likely to mangle the name
  (`jervis` for `Jarvis`). The shipped default carries `parsley` for `Parslee`,
  which is the existing proof that one spelling never survives STT.
- `brand` is the fixed product name (`Parslee Core`) and never changes. The
  chosen name is a nickname layered on top: store copy uses `brand`, addressing
  copy uses `name`.
- **Ungated**, unlike the neighbouring `openrouter.status`. A name is not a
  credential — it is what every connected surface must render to address the
  assistant at all, and mobile hosts reach the daemon without approval
  authority. It also ships in the `server.handshake` reply, so gating the RPC
  would protect nothing while breaking mobile.
- A malformed `identity.json` is an **error**, not a silent fall back to the
  default name. This is the surface a user checks when the assistant stopped
  answering to the name they set, and "everything is fine, it's called Parslee"
  is the least useful possible answer.

#### `assistant.identity.set`
- **Params**: `{ name?: string, spellings?: string[], user_name?: string | null }`
- **Returns**: the updated identity, same shape as `assistant.identity.get`
- Read-modify-write: every field is optional and unset fields are preserved, so
  a host that only knows about the name cannot wipe spellings a voice-settings
  pane wrote. Pass `user_name: null` to clear it.
- `name` is validated: 1–32 characters, at least one letter or digit, and not a
  conversational role (`system`, `user`, `assistant`, …).
- **Host/local-auth gated** (`require_approval_authority`), the same trust root
  as `auth.*` / `openrouter.*` / `messaging.*`. A rename repoints the voice wake
  word; an ungated write would let any authenticated local connection make the
  assistant stop answering to the name its user knows.
- Broadcasts `host.event { kind: "assistant.identity.changed", payload: <identity> }`
  so a live rename reaches open sessions without a reconnect.

The assistant can also rename itself through the gated `set_assistant_name`
tool, which is what makes "call yourself Friday" work hands-free. That tool is
routed through human approval on **every** session including `--full-access`
ones — unlike the tier-gated write tools, the risk there is not what the session
may do but where the instruction came from, since a rename can arrive inside a
fetched page, a file, or a recalled memory.

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
[`docs/host-protocol.md`](./host-protocol.md#live-browser-view-browserviewsubscribe--browserviewevent)
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

### calendar

#### `calendar.list`
- **Params**: `{}`
- **Returns**: `{ calendars: Calendar[] }`

#### `calendar.create_event`
- **Params**: `{ calendar_id, title, start, end, all_day?, notes?, location?, url? }` — `start`/`end` are RFC3339.
- **Returns**: `{ ok: bool, event?: Event, reason?: string }` — on success `event` carries the host-assigned id, calendar metadata, and the round-trip times.
- Calendar must be writable; if it isn't, `ok: false` with `reason: "calendar_is_read_only"`. Permission failures surface as `unavailable` errors at the request layer (same as `calendar.list`/`events`).

#### `calendar.update_event`
- **Params**: `{ event_id, title?, start?, end?, all_day?, notes?, location?, url? }` — any absent field leaves the existing value alone. Empty-string for `notes`/`location`/`url` *clears* that field; `null` is treated the same as absent.
- **Returns**: `{ ok: bool, event?: Event, reason?: string }` with the round-tripped event on success.

#### `calendar.delete_event`
- **Params**: `{ event_id: string }`
- **Returns**: `{ ok: bool, reason?: string }`

#### `calendar.events`
- **Params**: `{ start: string (RFC3339), end: string (RFC3339), calendar_ids?: string[] }`
- **Returns**: `{ events: CalendarEvent[] }`. Each event carries `status` (`confirmed` | `tentative` | `canceled` | `none`, from `EKEvent.status`) and `attendees` as objects — `{ name?, email?, status?, role?, is_current_user }` where `status` is `accepted` | `declined` | `tentative` | `pending` | `delegated` | `completed` | `in_process` | `unknown` (`EKParticipant.participantStatus`) and `role` is `required` | `optional` | `chair` | `non_participant` | `unknown` — so a consumer can distinguish a firm commitment from a tentative RSVP.

### concierge

The model concierge — a learning agent that reasons over a user's model
portfolio and *observed usage* to suggest acquiring/switching models. Its
intelligence is a durable, attributable **outcome ledger**
(`~/.car/models/outcome_ledger.jsonl`) + the deterministic `recommend()`
oracle (no LLM in these methods). It speaks only on real friction and only
suggests a model it can show ranks higher than what's failing. WS-only.
See `docs/proposals/concierge-agent.md`.

#### `concierge.status`
- **Params**: `{ inference_active?: bool }` (defaults to the daemon's live
  inference state).
- **Returns**: `ConciergeStatus`
  - `lanes: LaneUsage[]` — per use-case lane (busiest first): calls,
    successes, failures, inconclusive, avg latency/quality, models used,
    failing models.
  - `decision: { mode: "observe"|"answer"|"ask"|"act", confidence,
    evidence: string[], suggestion?: ConciergeSuggestion }` — what the
    concierge would do now and the receipts behind it.
  - `models: ModelHealth[]` — `{ model_id, calls, success_rate,
    avg_latency_ms, quality, excluded }` from observed outcomes.
    `success_rate` is `number | null` — `null` when nothing has resolved
    yet (render "no resolved signal", not a fabricated 0.5). These are
    lifetime profiles, not the lanes' 30-day window.
- The pull-not-push surface CarHost's Model Health pane renders.

#### `concierge.dismiss`
- **Params**: `{ dismiss_key: string, reason?: "not_now"|"wrong"|"too_expensive"|"privacy"|"never_for_project" }`
  (defaults to `not_now`).
- **Returns**: `{ dismissed: string, reason }`
- Records a *labeled* dismissal: permanent reasons suppress the suggestion
  forever; `not_now` only cools it down (14-day cooldown). The reason is
  learning signal, not just a tombstone.

#### `concierge.defaults`
- **Params**: `{}`
- **Returns**: `LaneDefaults` `{ defaults: [{ project?, use_case, model_id, set_at }] }`
- Per-lane (optionally project-scoped) default models (Phase D1).

#### `concierge.set_default`
- **Params**: `{ use_case: string, model_id: string, project?: string }`
- **Returns**: `{ set, use_case }`
- A project entry overrides the global (`project` omitted) default for that lane.

#### `concierge.clear_default`
- **Params**: `{ use_case: string, project?: string }`
- **Returns**: `{ cleared: bool }`

#### `concierge.apply`
- **Params**: `{ use_case: string, model_id: string, project?: string }`
- **Returns**: `{ model_id, use_case, installed, set_default, prior_model_id }`
- Closed-loop "set it up" (Phase D3): acquires the model and sets it as the
  lane default, **capturing the prior default so the change is reversible**.
  User-consented; every step is recorded in the action ledger.

#### `concierge.rollback`
- **Params**: `{ use_case: string, project?: string }`
- **Returns**: `{ restored: string | null }`
- Reverts the lane default to its value before the last `apply` (restores the
  prior model, or clears if there was none).

#### `concierge.actions`
- **Params**: `{ limit?: number = 50 }`
- **Returns**: `{ actions: ConciergeActionEntry[] }` — the auditable log of
  consented concierge actions (install / set_default / clear_default /
  rollback), each with `prior_model_id` (Phase D2).

#### `concierge.refresh_catalog`
- **Params**: `{}`
- **Returns**: `{ refreshed: number, note }`
- Fetches the model catalog from `CAR_CATALOG_URL`, verifies a detached
  ed25519 signature (`{url}.sig`) against `CAR_CATALOG_PUBKEY`, and caches the
  verified models (Phase E1). New models apply at next daemon start (the
  registry is immutable at runtime) and then surface as grounded `recommend()`
  candidates / concierge suggestions. Refused if no source/key is configured.

#### `concierge.ask`
- **Params**: `{ question: string }`
- **Returns**: `{ answer: string }`
- Conversational concierge (Phase F1/F2): a grounded answer about the user's
  models, run on a local model. The LLM answers **only** from assembled
  evidence (observed usage, model health, the verified candidate menu) and is
  constrained from inventing models or asserting fit — `recommend()` remains
  the grounding oracle. Net-positive verification (Phase F3) runs separately:
  the daemon auto-reverts a `concierge.apply` switch that proves worse than the
  prior model (canary over observed post-switch outcomes).

### connectors

Remote MCP connectors — CAR as an MCP **client**. Adds remote MCP servers as
tool sources (like Claude/ChatGPT connectors). Process-wide and daemon-shared:
a connector enabled on one session is reachable from all. Tools discovered from
a connector are **disabled** until explicitly enabled — a disabled tool is
neither routed nor registered, so it is invisible to the model. Persisted to
`~/.car/connectors.json`; secret auth-header values live in the OS keychain,
never in the manifest. WS-only (no FFI surface in Phase 1). Phase 1 supports
unauthenticated and static-auth-header servers (`connectors.add`), OAuth 2.1
servers (`connectors.authenticate` / `connectors.complete_authentication`),
and local stdio servers (`connectors.add_stdio`).

**Governance.** A connector's tools are denied wholesale by registering a
`policy.register { rule: "deny_connector", target: "<slug>", name: "…" }`
policy — connector tools are named `mcp_{slug}_{tool}`, so one rule governs
the whole connector (the policy-level counterpart to per-tool enablement).

**Team config.** A secret-free `.car/connectors.toml` (nearest one, walking up
from cwd) seeds connector definitions at boot — `[[connector]]` entries with a
`name` and either a `url` (remote) or a `command`/`args` (stdio). Each member
authorizes interactively; tokens stay in their own keychain. These are not
written back to the user manifest until the user interacts with one.

See `docs/proposals/remote-mcp-connectors.md`.

#### `connectors.add`
- **Params**: `{ name: string, url: string, headers?: { [name: string]: string } }`
  — `headers` is an optional map of secret auth-header name → value (stored in
  the keychain, not the manifest).
- **Returns**: `ConnectorStatus` `{ slug, name, url, connected: bool, tool_count, enabled_count, last_error?: string }`
- For unauthenticated or static-token servers. Registers the connector,
  connects, and discovers tools. No tools are enabled by the add itself — call
  `connectors.enable_tools` next.

#### `connectors.authenticate`
- **Params**: `{ name: string, url: string, redirect_uri: string }`
- **Returns**: `{ authorize_url: string, state: string }`
- Begins an OAuth 2.1 flow: runs Protected Resource + Authorization Server
  metadata discovery, Dynamic Client Registration, and builds a PKCE authorize
  URL bound to the RFC 8707 resource. `redirect_uri` is the GUI's own callback
  (e.g. an `ASWebAuthenticationSession` scheme or a loopback it listens on).
  The daemon holds the pending flow under `state`; secrets never round-trip
  through the client.
- The GUI opens `authorize_url`, captures `code` (verifying `state`), then
  calls `connectors.complete_authentication`.

#### `connectors.complete_authentication`
- **Params**: `{ state: string, code: string }`
- **Returns**: `ConnectorStatus`
- Exchanges the authorization `code` for tokens (stored, with the refresh
  token, in the keychain — never the manifest), saves the connector config,
  connects, and discovers tools. Access tokens auto-refresh on use.

#### `connectors.list`
- **Params**: `{}`
- **Returns**: `{ connectors: ConnectorStatus[] }` (array)

#### `connectors.tools`
- **Params**: `{ slug: string }`
- **Returns**: `ToolView[]` — `{ name, canonical, description, enabled: bool }`
  where `name` is the bare server-side tool name and `canonical` is the
  model-visible `mcp_{slug}_{name}`.

#### `connectors.add_stdio`
- **Params**: `{ name: string, command: string, args?: string[], env?: { [k: string]: string } }`
- **Returns**: `ConnectorStatus`
- Registers a **local** MCP server launched as a subprocess over stdio
  (reusing the engine's stdio transport), connects, and discovers tools. No
  tools are enabled by the add itself.

#### `connectors.enable_tools`
- **Params**: `{ slug: string, tools: string[] }` — bare server-side tool names.
- **Returns**: `{ enabled: number }`
- Routes the named tools and registers their schemas into every open session's
  runtime; persists the choice.

#### `connectors.disable_tools`
- **Params**: `{ slug: string, tools: string[] }` — bare server-side tool names.
- **Returns**: `{ disabled: number }`
- Drops the named tools' routes and unregisters their schemas from every open
  session's runtime, so the model no longer sees them; persists the choice.

#### `connectors.refresh`
- **Params**: `{ slug: string }`
- **Returns**: `ToolView[]` — re-runs `tools/list` and re-registers any
  still-enabled tools.

#### `connectors.remove`
- **Params**: `{ slug: string }`
- **Returns**: `{ removed: string }`
- Disconnects, drops routes, deletes keychain secrets, and removes the
  connector from the manifest.

### contacts

#### `contacts.containers`
- **Params**: `{}`
- **Returns**: `{ containers: ContactContainer[] }`

#### `contacts.find`
- **Params**: `{ query: string, container_ids?: string[], limit?: number = 50 }`
- **Returns**: `{ contacts: Contact[] }`

### health

#### `health.status`
- **Params**: `{}`
- **Returns**: current health permission/availability status

#### `health.sleep`
- **Params**: `{ start: string (RFC3339), end: string (RFC3339) }`
- **Returns**: sleep windows for the date range

#### `health.workouts`
- **Params**: `{ start: string (RFC3339), end: string (RFC3339) }`
- **Returns**: `{ workouts: Workout[] }`

#### `health.activity`
- **Params**: `{ start: string (YYYY-MM-DD), end: string (YYYY-MM-DD) }` — note date-only format
- **Returns**: activity data for the range

### host

The `host.*` namespace is the OS-integration surface — terminal/tray clients use it to provide a unified UI across multiple agents. See also [`docs/host-protocol.md`](host-protocol.md).

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
- **Params**: `{ agent_id?: string, title: string, description?: string, context?: object, required_approvals?: number }`
- **Returns**: `HostApproval`
- If `agent_id` is provided, the agent's status auto-flips to `waiting_for_approval`.

#### `host.resolve_approval`
- **Params**: `{ approval_id: string, approved: boolean, notes?: string }`
- **Returns**: resolved `HostApproval`

### a2ui

Dynamic UI surfaces rendered by the CAR host window. A2UI messages are
data-only JSON envelopes; the host renders only supported catalog components.
The renderer supports the CAR-advertised A2UI v0.9 basic catalog (24
components): `Text`, `Row`, `Column`, `List`, `Card`, `Divider`, `Button`,
`TextField`, `CheckBox`, `ChoicePicker`, `Select`, `Slider`, `Image`, `Icon`,
`Video`, `AudioPlayer`, `DateTimeInput`, `Chart`, `File`, `FilePicker`,
`Spacer`, `Badge`, `Tabs`, and `Modal`.

#### `a2ui.capabilities`
- **Params**: `{}`
- **Returns**: `{ version, mimeType, catalogs, components, limits }`
- Reports the catalog/component set and server-side safety limits enforced
  while ingesting or applying surfaces.

#### `a2ui.apply`
- **Params**: an A2UI envelope, or `{ envelope: A2uiEnvelope }`
- **Returns**: `{ surfaceId, deleted, surface? }`
- Applies one direct A2UI v0.9 message (`createSurface`, `updateComponents`,
  `updateDataModel`, or `deleteSurface`) and broadcasts a `host.event` with
  kind `a2ui.surface_updated` or `a2ui.surface_deleted`.

#### `a2ui.ingest`
- **Params**: `{ payload: object, owner?: A2uiSurfaceOwner, endpoint?: string, routeAuth?: A2aRouteAuth, allowUntrustedEndpoint?: boolean }` or a raw payload
- **Returns**: `{ applied: A2uiApplyResult[] }`
- Scans A2A-shaped data/artifact/task payloads for direct envelopes or
  `{ "a2ui": envelope }` wrappers, then applies every discovered envelope.
  Use this when an A2A peer returns A2UI inside a `data` part. If the payload
  carries A2A `taskId` / `contextId`, or if `owner` is supplied, the surface
  records that routing target. Supplying a trusted loopback `endpoint` lets
  later `a2ui.action` calls continue the originating A2A task automatically.
  Non-loopback endpoints require `allowUntrustedEndpoint: true`. Optional
  `routeAuth` supports `{ "type": "bearer", "token": "..." }` or
  `{ "type": "header", "name": "...", "value": "..." }` and is stored only on
  the server.

#### `a2ui.reap`
- **Params**: `{}`
- **Returns**: `{ removed: string[] }`
- Removes expired surfaces and their server-side routing credentials.

#### `a2ui.surfaces`
- **Params**: `{}`
- **Returns**: current `A2uiSurface[]`

#### `a2ui.get`
- **Params**: `{ surface_id: string }` or `{ surfaceId: string }`
- **Returns**: one `A2uiSurface` or `null`

#### `a2ui.action`
- **Params**: `{ name, surfaceId, sourceComponentId, timestamp, context }`
  (`name` also accepts the alias `action`, since the web renderer forwards
  `@a2ui/web_core`'s action object verbatim).
- **Returns**: `{ event: HostEvent, route: object }`
- Called by the host renderer when the user activates an A2UI control.
  The action is delivered three ways:
  1. **Broadcast to `a2ui/subscribe`d clients** as an `a2ui.event` with
     `kind: "a2ui.action"` — the same channel that carries surface updates.
     This is how a host-language agent that created the surface receives the
     interaction (Parslee-ai/car-releases#58); without it, agent surfaces are
     display-only.
  2. Recorded/broadcast as `host.event` kind `a2ui.action` for host UIs.
  3. If the surface owner is `{ kind: "a2a", taskId, contextId, endpoint }`,
     CAR sends an A2A `SendMessage` continuation to `endpoint` with a data
     part shaped as `{ "a2uiAction": action }`.

#### `a2ui/subscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: true }`
- Opt this WS connection into `a2ui.event` notifications (see below).
  Subscribers receive every successful `a2ui.apply` / `a2ui.ingest`
  result for as long as they're connected; subscriptions are
  auto-cleaned on WS disconnect. Closes
  [Parslee-ai/car-releases#29](https://github.com/Parslee-ai/car-releases/issues/29).

#### `a2ui/unsubscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: false }`
- Idempotent.

#### `a2ui/replay`
- **Params**: `{ surface_id: string }` or `{ surfaceId: string }`
- **Returns**: one `A2uiSurface` or `null`
- Intended for late-joiners and reconnect: a client calls
  `a2ui/subscribe`, then `a2ui/replay` once per surface it's
  tracking, and from then on `a2ui.event` notifications keep it in
  sync. Equivalent to `a2ui.get` on the surface store.

##### `a2ui.event` (server → client notification)
After every `a2ui.apply` / `a2ui.ingest` succeeds, the server pushes
to all `a2ui/subscribe`d clients:

```json
{
  "jsonrpc": "2.0",
  "method": "a2ui.event",
  "params": {
    "kind": "a2ui.surface_updated" | "a2ui.surface_deleted" | "a2ui.action" | "a2ui.render_report",
    "result": { "surfaceId": "...", "deleted": false, "surface": { ... } }
  }
}
```

For `a2ui.surface_updated` / `a2ui.surface_deleted` the `result` payload is
the same `A2uiApplyResult` the `a2ui.apply` / `a2ui.ingest` call returned to
its requester. For `kind: "a2ui.action"` (emitted on every `a2ui.action`
call), the `result` is `{ surfaceId, action, owner }` — letting a
subscribed agent receive user interactions on surfaces it owns. (The A2A
`route` result is intentionally omitted from this broadcast — it stays in the
`a2ui.action` RPC return and the `host.event` record so an endpoint URL/response
isn't fanned out to unrelated subscribers.) For
`kind: "a2ui.render_report"`, the `result` is the renderer telemetry envelope.
Validation errors (`UnsupportedCatalog`, `UnsupportedComponent`,
`LimitExceeded`) propagate to the caller of `a2ui.apply` and **do
not** broadcast a half-applied envelope.

### a2a (in-core dispatcher — releases#28)

The 11 A2A v1.0 JSON-RPC methods (and their v0.3 slash aliases)
are dispatched in-core by `car-server-core` against an embedded
`car_a2a::A2aDispatcher`. Embedders that consume `car-server-core`
get A2A reachability automatically; no separate HTTP listener
required for JSON-RPC peers. Streaming (`message/stream`,
`tasks/resubscribe` and PascalCase aliases) returns
`MethodNotFound` from this transport — use
`car-server`'s `--a2a-bind` HTTP+SSE listener for streaming peers.

| v1.0 PascalCase | v0.3 slash form |
|---|---|
| `SendMessage` | `message/send` |
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

### mail

#### `mail.accounts`
- **Params**: `{}`
- **Returns**: `{ accounts: MailAccount[] }`

#### `mail.inbox`
- **Params**: `{ account_ids?: string[] }`
- **Returns**: `{ available, backend, reason?, summaries: InboxSummary[] }` where
  `InboxSummary` is `{ account_id, unread, total, most_recent_subject? }`
- **Note**: counts per account, **not** message rows — use `mail.messages` for
  rows. (This entry previously documented `{ messages: Message[] }`, which the
  code has never returned.)

#### `mail.mailboxes`
- **Params**: `{ account_ids?: string[] }` — omit to enumerate all accounts
- **Returns**: `{ available, backend, reason?, mailboxes: Mailbox[] }` where
  `Mailbox` is `{ account_id, name, full_name, unread, total }`
- **Notes**:
  - Nested mailboxes are included on **both** backends. `full_name` is the
    **selector** — pass it back verbatim as `mail.messages`'s `mailbox`. On
    macOS it is the slash-joined path from the account root (`"Travel"`,
    `"Travel/2026"`); on the Microsoft Graph backend it is the folder id.
    `name` is the leaf label.
  - Graph's `/me/mailFolders` returns only root-level folders, so nested ones
    come from a bounded `childFolders` walk: depth 8 (matching the macOS walk),
    at most 64 requests, following `@odata.nextLink` up to 5 pages per listing.
    A folder tree deeper or wider than that is truncated.
  - An `account_ids` filter that matches no account returns `available: false`
    with a reason naming the unmatched ids — not an empty list.

#### `mail.messages`
- **Params** (the params object *is* the `MessageQuery`; every field defaults):
  `{ account_ids?: string[], mailbox?: string | null, limit?: number,
  since?: string (RFC3339), include_body?: boolean }`
- **Returns**: `{ available, backend, reason?, messages: MessageSummary[] }`
  where `MessageSummary` is `{ id, account_id, mailbox, subject?, sender?,
  recipients: string[], date_received?, read, preview?, body? }`
- **Notes**:
  - `mailbox: null` (or omitted) reads `INBOX`, and `limit` defaults to `50`, so
    `{}` reproduces the pre-existing INBOX-only read for every current caller.
  - Rows come back newest first, and that ordering is **global, not per
    account**: rows from every matched account are merged into one date-ordered
    list before `limit` is applied, so `limit: 1` across two accounts that both
    hold the mailbox returns the newer of the two messages rather than
    whichever account the backend enumerated first. `since` is applied
    **before** `limit`, so a narrow window still returns the newest `limit`
    matches.
  - `body` is populated only when `include_body` is `true`, and each body is cut
    at 100,000 characters. `preview` is free on Graph (`bodyPreview`); on macOS
    it is `null` unless `include_body` was set.
  - `id` is opaque and backend-qualified — feed it to `mail.message_body`, do
    not parse it. A Mail.app id is composite because its numeric message id is
    only addressable inside one mailbox of one account.
  - A row's `mailbox` is the mailbox as the backend **resolved** it, not the
    selector the caller sent: a query for `"travel"` returns rows stamped
    `"Travel"`, and one for the bare leaf `"2026"` returns rows stamped
    `"Travel/2026"`, so rows can be matched against `mail.mailboxes` output.
  - A `mailbox` that resolves in no selected account — or an `account_ids`
    filter that matches no account — returns `available: false` with a reason
    naming it. An unreachable mailbox must not read as an empty one, which is
    the silent failure this method exists to end.

#### `mail.message_body`
- **Params**: `{ message_id: string }` — an `id` from a `mail.messages` row
- **Returns**: `{ available, backend, reason?, id, content_type: "text" | "html",
  body: string | null, truncated: boolean }`
- **Note**: like `mail.inbox`, this is **not** in the default `ApprovalGate` set
  (which covers write ops plus `vision.ocr`). An operator who wants message
  bodies to require approval adds it via
  `ServerStateConfig::with_approval_gate`.

#### `mail.send`
- **Params**: raw mail message object (`to`, `subject`, `body`, etc.)
- **Returns**: `{ message_id: string, ... }`

### messages

#### `messages.services`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, services: MessageService[] }`

#### `messages.chats`
- **Params**: `{ limit?: number }`
- **Returns**: `{ available, backend, reason?, chats: Chat[] }`

#### `messages.send`
- **Params**: `{ recipient: string, body: string, service_id?: string }`
- **Returns**: `{ available, backend, reason?, sent: boolean }`

> **`messages.send` is not the governed agent send surface.** It is a macOS
> host-automation integration RPC, a sibling of `mail.send` and
> `notes.accounts`, and it dispatches straight to the local Messages app. It
> does not run through the validator, the policy engine, the rate limiter or
> the event log; its only gate is the interactive per-call `ApprovalGate`
> (which `car-server --no-approvals` removes).
>
> The governed agent path is the **`messaging.send` tool** — one character
> apart. Rules written in `.car/policies` against the `messaging.send` tool do
> **not** constrain this RPC. Agents should use the tool.

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

### notes

#### `notes.accounts`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, accounts: NoteAccount[] }`

#### `notes.find`
- **Params**: `{ query: string, limit?: number = 50 }`
- **Returns**: `{ available, backend, reason?, notes: NoteSummary[] }`

### reminders

#### `reminders.lists`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, lists: ReminderList[] }`

#### `reminders.items`
- **Params**: `{ limit?: number = 50 }`
- **Returns**: `{ available, backend, reason?, reminders: ReminderItem[] }`

### photos

#### `photos.albums`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, albums: PhotoAlbum[] }`

### bookmarks

#### `bookmarks.list`
- **Params**: `{ limit?: number = 100 }`
- **Returns**: `{ available, backend, reason?, bookmarks: Bookmark[] }`

### files

#### `files.locations`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, locations: FileLocation[] }`

### keychain

#### `keychain.status`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason? }`

### meeting

The meeting surface is built on `car-voice` and persists transcripts/summaries under `.car/meetings/<id>/`. See [`car-rs/examples/meetily-clone/`](../car-rs/examples/meetily-clone/) for a working consumer.

#### `meeting.start`
- **Params**: `{ id?: string, audio_source: object, ... }` — `id` auto-generated if omitted
- **Returns**: `{ id: string, started_at: string, ... }`
- Pushes `voice.event` notifications back to the client. Transcript segments also flow into `car-memgine` automatically as Conversation nodes.

#### `meeting.stop`
- **Params**: `{ meeting_id: string, summarize?: boolean = true }`
- **Returns**: `{ summary, transcript, ... }`

#### `meeting.list`
- **Params**: `{ root?: string }` — defaults to current working directory
- **Returns**: `{ meetings: MeetingMetadata[] }`

#### `meeting.get`
- **Params**: `{ meeting_id: string, root?: string }`
- **Returns**: full meeting record

### registry

File-based agent registry for cross-process discovery (issue #111). Each agent owns one JSON file under `~/.car/registry/<name>.json`; menubar / tray UIs poll the directory to enumerate running agents and their dashboards. There is no daemon — the directory itself is the shared state, and atomic writes (temp + rename) provide consistency. Pass `registry_path` on any method to override the default `~/.car/registry/` location (mainly for tests or per-tenant isolation). Running/idle entries from the user-default registry are also surfaced by `discovery.resolve` (kind `registry`), so a heartbeating local service is routable — set `capability` on the entry to rank it well.

#### `registry.register`
- **Params**: `{ entry: { name: string, dashboard_url: string, status?: "running"|"idle"|"errored"|"stopping", display_name?: string, capability?: string, port?: number, pid?: number }, registry_path?: string }` — `capability` is a natural-language description of what the service does; `discovery.resolve` ranks the service against a need by it (without it the service still resolves but ranks on its label alone).
- **Returns**: `null`
- Atomic write — concurrent readers never see a half-written entry. `name` and `dashboard_url` are required; missing-or-zero `registered_at` / `last_heartbeat_at` get filled with the current time.

#### `registry.heartbeat`
- **Params**: `{ name: string, registry_path?: string }`
- **Returns**: `{ refreshed: boolean }` — `false` indicates the agent isn't currently registered (caller should re-register)
- Recommended cadence: every 20s.

#### `registry.unregister`
- **Params**: `{ name: string, registry_path?: string }`
- **Returns**: `null`
- Idempotent.

#### `registry.list`
- **Params**: `{ registry_path?: string }`
- **Returns**: `AgentEntry[]` — sorted by `name`. Corrupt JSON files in the registry directory are silently skipped.

#### `registry.reap`
- **Params**: `{ max_age_secs?: number = 60, registry_path?: string }`
- **Returns**: `string[]` — names of reaped entries
- Recommended cadence: every 30s from the menubar process. Default 60s threshold catches an agent that missed two consecutive 20s heartbeats.

### supervision

The admission gate published as an out-of-process subscription (proposal item 5;
Shepherd, arXiv 2605.10913 Appendix E).

CAR has always blocked before execution — `car_engine::AdmissionGate` runs on
every admitted proposal, conjunctively and fail-closed. Until this namespace
every gate was **in-process**, a Rust trait impl compiled into the daemon, so
supervising an agent meant forking CAR rather than connecting to it. A
supervisor is now any process that can hold a WebSocket.

**Flow.** Subscribe on your own connection. Every proposal submitted on *any*
session that matches your filter arrives as a `supervision.intent` notification
and **blocks** while you decide. Answer with `supervision.decide`, or poll
`supervision.pending` and answer a batch.

**Fail-closed.** An intent nobody answers within `decision_timeout_ms`
(30 s default) is rejected, not admitted — a supervisor that dies must not
become an open door. Disconnecting does not release intents you left parked
either, so a supervisor cannot convert a pending deny into an allow by dropping
its socket.

**Costs nothing when unused.** With no subscriber the gate short-circuits on an
empty-map read without building an intent.

**Intents are trimmed, not redacted-by-accident.** An intent carries action id,
type, tool, reversibility, parameter **key names**, and a digest of the
parameter map — never the parameter values. Supervision is affordable because
it is batched and trimmed, not because the meta-model is cheap. A supervisor
that needs full arguments fetches them out of band.

**Decision vocabulary.** `allow`, `deny`, `escalate` (hand it to the human
approval ledger). Shepherd's `inject` / `handoff` / `discard` are deliberately
**not** implemented: this gate sits at proposal admission, which has no
conversation to inject into and no session-restart primitive, and `discard`
additionally needs the scope rollback of item 4 — measured and found
constrained. The decision enum is `#[non_exhaustive]` so they can be added
without a break.

#### `supervision.subscribe`
- **Params**: `{ filter?: { tools?: string[], sessions?: string[], min_reversibility?: "reversible" | "compensable" | "irreversible" } }`
- **Returns**: `{ subscribed: true, decision_timeout_ms: number, supervisors: number }`
- Re-subscribing replaces the filter; no disconnect needed to narrow or widen.
- `min_reversibility` matches that contract **and worse** — `compensable` also
  shows `irreversible`, because asking to see risky proposals means "this risky
  and up". An unrecognised label sorts as most severe, so a future variant is
  over-reported rather than silently filtered out of view.
- An empty filter matches everything.

#### `supervision.unsubscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: false, was_subscribed: boolean }`
- Happens automatically when the connection drops.

#### `supervision.pending`
- **Params**: `{}`
- **Returns**: `{ intents: SupervisionIntent[] }`, oldest first
- The batching half: one model call can cover every parked intent, then issue N
  decisions. Also the fallback for clients that cannot consume notifications.
- `SupervisionIntent`: `{ id, proposal_id, source, session_id?, scope?, reversibility, created_at, actions: [{ id, action_type, tool?, reversibility, parameter_keys, parameters_digest }] }`

#### `supervision.decide`
- **Params**: `{ intent_id: string, decision: { kind: "allow" | "deny" | "escalate", reason?: string } }` (`reason` required for `deny` and `escalate`)
- **Returns**: `{ decided: true }`
- **Errors** when the intent is unknown — already decided, already timed out, or
  never existed. Deliberately an error rather than a silent success: a
  supervisor that believes it denied something needs to hear that the denial did
  not land.
- `allow` is not a bypass — the other admission gates still apply.

### admission

Process-wide concurrency gate for inference RPC handlers (`infer`, `embed`, `classify`). The daemon sizes the permit count from host RAM at startup (~1 permit per 8 GB, floor 1, ceiling 8) and serializes excess load instead of letting parallel calls pile up KV-cache and activation memory until the host OOMs. The cap can be overridden at start time with the `CAR_INFERENCE_MAX_CONCURRENT` env var.

#### `admission.status`
- **Params**: `{}`
- **Returns**: `{ permits_total: number, permits_available: number, permits_in_use: number, env_override: string }`
- Read-only snapshot. Racy by definition (counts can change between read and reply); intended for menubar/status dashboards, not for client-side rate-limiting decisions.

### a2a

Lifecycle for the in-process Agent2Agent (A2A) v1.0 listener. Same `car-a2a` HTTP service `car-server --a2a-bind` exposes, but driven over JSON-RPC so embedders can spin it up from their own daemon without the CLI flag. Process-global state holds the bound listener and join handle so a later `a2a.stop` / `a2a.status` reaches the right server.

The same lifecycle is reachable from the FFI bindings as `startA2AServer` / `stopA2AServer` / `a2AServerStatus` (NAPI — each takes the `CarRuntime` first; napi-rs camelCases `a2a` → `A2A`) and `start_a2a_server` / `stop_a2a_server` / `a2a_server_status` (PyO3), wired through `car-ffi-common::a2a`. JSON-RPC and FFI share the same process-global state, so a server started over JSON-RPC can be queried from the bindings and vice versa.

The spawned `car_engine::Runtime` is fresh — engine builtins via `register_agent_basics()`, no shared state with the per-WebSocket session runtime or the embedder's `CarRuntime`. Sharing state with the caller's runtime is future work.

#### `a2a.start`
- **Params**: `{ bind: string, public_url?: string, agent_name?: string, agent_description?: string, organization?: string, organization_url?: string, share_session_runtime?: boolean }`
- **Returns**: `{ bound: string }`
- Errors if a server is already running, the bind fails, or `bind` is malformed. `bind` accepts `host:port` (use `127.0.0.1:0` to ask the kernel for an ephemeral port, then read it back from `bound`). `public_url` defaults to `http://<bound>`; everything else has reasonable defaults.
- **`agent_name` defaults to the user's chosen assistant name** (see
  [`assistant.identity.*`](#assistant)) when they have set one, and to
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

### automation

Bridges around the OS-shipped scripting layer. `run_applescript` and the `shortcuts.*` methods are macOS-only (Apple CLIs); `run_powershell` is the Windows analog. Each method errors with a PlatformUnsupported message on the platforms it doesn't target.

#### `automation.run_applescript`
- **Params**: `{ script: string, language?: "applescript" | "javascript", args?: string[], timeout_ms?: number }`
- **Returns**: `{ stdout: string, stderr: string, exit_code: number | null }`
- Wraps `osascript -l <lang> -` with the script piped to stdin. `args` are passed positionally to the script's `on run argv` (AppleScript) or `function run(argv)` (JXA). Subprocess exit codes other than 0 surface as JSON-RPC errors with the script's own stderr in the message. macOS-only.

#### `automation.run_powershell`
- **Params**: `{ script: string, timeout_ms?: number }`
- **Returns**: `{ stdout: string, stderr: string, exit_code: number | null }`
- The Windows analog of `run_applescript`. Runs the script through `powershell.exe` (Windows PowerShell 5.1, `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`, UTF-8 output) to drive the host desktop and its apps — toast notifications, clipboard, Explorer/COM automation (Office, browsers), UI Automation, window/process control. Distinct from the `shell` tool (which runs `cmd.exe` and can't reach the GUI/COM surface). Windows-only; errors PlatformUnsupported elsewhere. **High-risk** — gated by the approval gate like `run_applescript`.

#### `automation.shortcuts.list`
- **Params**: `{ folder?: string, with_identifiers?: boolean }`
- **Returns**: `[ { name, identifier, tool_slug, tool_description, parameters_schema }, ... ]`
- Enumerates Shortcuts.app entries. The list contains both user-authored workflows and AppShortcuts donated by apps via the App Intents framework — they look identical from the CLI. The `tool_*` fields are pre-shaped for registering each shortcut as a runtime tool through `tools.register_schema`. `folder` accepts the literal `"none"` to list shortcuts not in any folder.

#### `automation.shortcuts.run`
- **Params**: `{ name_or_id: string, input?: string, output_type?: string, timeout_ms?: number }`
- **Returns**: `{ stdout: string, stderr: string, exit_code: number | null }`
- Invokes a Shortcut. Prefer `name_or_id` as a UUID from `automation.shortcuts.list` since names can collide. `input` is staged through a tempfile and passed as Shortcut Input. `output_type` is a Uniform Type Identifier (e.g. `"public.plain-text"`); when omitted the shortcut decides.

### notifications

#### `notifications.local`
- **Params**: `{ title: string, body: string, subtitle?: string, sound?: string }`
- **Returns**: `{ delivered: boolean, platform: string, backend: string }`
- Sends a user-visible local notification through the host platform when
  available. On macOS daemon builds this is a structured wrapper around the
  system notification Apple Event; on Windows a WinRT `ToastGeneric` toast
  (the AppUserModelId is registered in HKCU on first use so an unpackaged
  app's toasts appear). iOS notification delivery belongs to the signed host
  app, which uses `UserNotifications` directly.

### vision

#### `vision.ocr`
- **Params**: `{ image_path: string, fast_path?: boolean, languages?: string[], language_correction?: boolean, minimum_text_height?: number }`
- **Returns**: `{ available: boolean, observations: [ { text, confidence, x, y, w, h }, ... ] }`
- On-device text recognition. On macOS this uses Apple Vision's `VNRecognizeTextRequest`; on other hosts (or macOS builds without the Swift shim) it falls back to the **Tesseract CLI** if `tesseract` is installed on `PATH` (car#360) — same params, same result shape. `fast_path: true` selects `.fast` over `.accurate` recognition (~5× faster, lower accuracy; Apple path only). `languages` are BCP-47 hints (e.g. `["en-US"]`); empty lets the backend auto-detect (the Tesseract backend maps common BCP-47 tags to Tesseract language codes and passes through codes like `"eng"`). Bounding boxes are normalized to `[0, 1]` in a bottom-left origin coordinate space (the Tesseract backend flips Tesseract's top-left pixel coordinates to match). `available` is `false` only when neither backend is reachable — no Apple shim **and** no `tesseract` on `PATH`; in that case `observations` is an empty array rather than an error so callers can distinguish "OCR unavailable here" from "OCR ran and found no text."

### memory

**Scope: which graph do these methods act on?** This is the first thing to settle, because the per-file shape of `memory.load` / `memory.persist` suggests per-file namespacing and that is *not* the default.

| Session bound how | Graph used |
|---|---|
| `session.auth { memory_namespace }` | a daemon-owned graph private to that namespace |
| `session.auth { agent_id }` | that agent's daemon-owned graph |
| neither | **the daemon's single shared graph** |

The shared default is deliberate: facts ingested through the MCP endpoint show up in WS-served queries and vice versa, so external agents and embedded hosts work against one knowledge base.

**What that costs an unbound multi-project host.** Every unbound session on a daemon shares one graph, so:

- `memory.query` returns facts another project's session wrote.
- `memory.persist` writes the **entire** shared graph to whatever `path` it is given — so every per-project file accumulates every project's facts.
- `memory.load` **resets** that shared graph before ingesting (see below), so one session loading its own file discards facts another session had in memory.

If you key memory per project, bind a namespace. `session.auth { memory_namespace: "myapp-<projectID>" }` gives that connection a private graph, persisted under `~/.car/memory/memory-namespaces/<encoded-ns>.json` — the filename is a lowercase percent-encoding of the namespace's UTF-8 bytes (`a`-`z`, `0`-`9`, `-`, `_`, `.` pass through; everything else, including `%` and uppercase letters, becomes `%` plus two lowercase hex digits), which keeps the mapping injective so two namespaces can never share a snapshot file (#891) — and every `memory.*` call on that connection acts on it alone. A namespace is a **separate axis from `agent_id`** — one agent may work across several namespaces, and two hosts may share a namespace without sharing an identity. When both are supplied the namespace wins for the memory scope; the agent binding still governs identity and tokens. (Parslee-ai/car-releases#79.)

#### `memory.add_fact`
- **Params**: `{ subject: string, body: string, kind?: string = "pattern", committed_by?: string, verdicts?: VerifierVerdict[] }`
- **Returns**: updated fact count
- `kind: "constraint"` sets the constraint flag. WebSocket-ingested facts are auto-prefixed with `ws-` for provenance.
- This is the **externally-authored** memory write path, so it runs through the durable-state admission gate. With no admission table installed the gate is off and `committed_by` / `verdicts` are ignored — existing callers are unaffected. With a table installed, the candidate must satisfy that table's rule for the `memory` surface or the call fails with `memory admission refused for <id>: <refusals>`.
- `produced_by` is fixed to `execution` and is **not** caller-settable: a peer calling this surface *is* the execution path, and letting it name its own producer would let it satisfy any rule by declaring itself whatever the rule expects.
- **Limitation, stated plainly:** `committed_by` is a caller *claim* that this surface does not yet authenticate. With a table installed the gate therefore enforces **evidence** (a caller cannot conjure a passing verifier verdict) and structure, but not committer **identity**. Binding the committer to the authenticated session is follow-up work; until then treat that half as bookkeeping, not a security boundary.

#### `memory.set_admission_table`
- **Params**: `{ table?: OwnershipTable | null }`
- **Returns**: `{ enabled: boolean, ungated_surfaces: string[] }`
- Installs or clears the durable-state admission rules for the session's memgine. A null or absent `table` **clears** them, turning the gate off — the default, and what every deployment has until this is called.
- Off is **not** the same as an empty table. The gate core is fail-closed: a table with no rule for a surface refuses everything on it. So `{}` installs a table that rejects every externally-authored fact, while `null` disengages the gate entirely. That distinction is deliberate — engaging a fail-closed gate implicitly would refuse every memory write on every existing deployment.
- `ungated_surfaces` names surfaces whose rule imposes no real constraint (the producer may self-commit and no evidence is required). Check it after installing a table that only *looks* governed.
- A `SurfaceRule` is `{ surface, produced_by, committed_by, self_commit, requires }` where `surface` ∈ `memory | skills | tools | verification | routing | tasks`, the two authorities ∈ `execution | review | coordination | scheduling | system_config`, `self_commit` ∈ `forbidden | with_passing_evidence`, and `requires` is a list of `{ class, accepts_tiers?, operator_override? }`.
- Only the `memory` surface is enforced today — that is the write path this is wired into. Rules for other surfaces are accepted and stored so a table can be authored ahead of the call sites, but nothing consults them yet.

#### `memory.admission_table`
- **Params**: `{}`
- **Returns**: `{ enabled: boolean, table: OwnershipTable | null, ungated_surfaces: string[] }`
- Reads back the installed rules. `enabled: false` with a null `table` means the gate is off.

#### `memory.update_status`
- **Params**: `{ body: string, tenant_id?: string }`
- **Returns**: `{ id, body, tenant_id? }`
- Updates the proactive memory agent's private progress/risk status. This status is session-local and is not stored as a normal graph fact, so `memory.build_context` and generic retrieval cannot expose it to the action model by accident.

#### `memory.maintain`
- **Params**: `{ max_recent?: number = 32, tenant_id?: string }`
- **Returns**: `{ trigger, saved, skipped_existing, status? }`
- Runs Phase 1 of proactive memory over the recent session event log. CAR mines high-signal trajectory events such as failed actions, retries, exhausted replans, ungrounded/open goal evaluations, and truncated or stalled turns into compact knowledge/procedural entries with stable ids. Re-running maintenance over the same events is idempotent: existing event-derived memories are counted in `skipped_existing` instead of duplicated. The returned `trigger` can be passed directly into `memory.intervene`.
- Appends a `ProactiveMemoryMaintained` event with counts and trigger metadata, but not full memory bodies.

#### `memory.save_knowledge`
- **Params**: `{ id?: string, subject: string, body: string, tags?: string[], confidence?: string, tenant_id?: string, is_constraint?: boolean }`
- **Returns**: `{ id, kind: "knowledge", fact_count }`
- Saves durable execution-state knowledge such as task requirements, verified environment facts, paths, policies, and domain constraints. Entries are graph facts stamped with proactive-memory metadata, so they can participate in retrieval and selective intervention.

#### `memory.save_procedural`
- **Params**: `{ id?: string, subject: string, body: string, tags?: string[], confidence?: string, tenant_id?: string, is_constraint?: boolean }`
- **Returns**: `{ id, kind: "procedural", fact_count }`
- Saves durable procedural evidence such as failed attempts, successful fixes, diagnostics, ruled-out hypotheses, and tool/runtime gotchas. The proactive intervention selector gives these entries extra weight under tool-error and repeated-failure triggers.

#### `memory.delete`
- **Params**: `{ id: string }`
- **Returns**: `{ id, deleted, kind, fact_count }`
- Removes a stale proactive memory entry by fact id. Status ids have the form `proactive-status:<tenant-or-global>` and clear the private status slot; durable knowledge/procedural entries are removed from the graph.

#### `memory.query`
- **Params**: `{ query: string, k?: number = 5 }`
- **Returns**: `[ { subject, body, kind, confidence }, ... ]`
- Personalized PageRank retrieval over the memory graph. FFI parity with NAPI `query_facts` — same algorithm, same result shape, so the choice of transport does not shift ranking.

#### `memory.intervene`
- **Params**: `{ query?: string, recent?: string[], trigger?: { repeated_failures?: number, tool_error?: boolean, explicit_uncertainty?: boolean, high_risk_action?: boolean, context_shift?: boolean }, force?: boolean, max_candidates?: number = 8, tenant_id?: string }`
- **Returns**: either `{ decision: "inject", reminder, selected, candidates, bank }` or `{ decision: "silent", reason, candidates, bank }`
- Proactive memory hook for long-horizon runs. Unlike `memory.build_context`, this does not expose the full memory bank. It selects at most one grounded reminder from durable memgine state for the next action, or returns an explicit silence decision when no remembered state is strong enough to interrupt. An injected reminder increments the selected fact's usage counter so later outcome credit can update utility-aware retrieval.
- `trigger` carries runtime pressure signals such as repeated tool failures, uncertainty, high-risk actions, or context shifts. These signals bias the selector toward requirements, diagnostics, procedural attempts, and open subgoals without forcing always-on reminders. `force: true` is for harness ablations and debugging; normal callers should leave it false.
- Appends a `ProactiveMemoryIntervention` event with the inject/silent decision, selected fact id when present, candidate count, and bank counts.

#### `memory.evaluate`
- **Params**: `{ cases: [{ id: string, request: ProactiveMemoryRequest, relevant_fact_ids?: string[] }] }`
- **Returns**: `{ cases, selective, always_inject, passive_retrieval, no_memory }`; each mode reports `{ interventions, true_positives, false_positives, false_negatives, precision, recall, interruption_rate, avg_candidates_exposed }`.
- Offline calibration hook for proactive memory. It runs labeled next-action cases against the current graph and compares CAR's selective selector to the paper-style baselines: no memory, always inject the best candidate, and passive retrieval that exposes all candidates without an interruption policy. This is deterministic and does not call a model.
- FFI parity: NAPI/Python expose JSON-string wrappers for `memory_update_status`, `memory_maintain`, `memory_save_knowledge`, `memory_save_procedural`, `memory_delete`, `memory_intervene`, and `memory_evaluate`, all proxying to these daemon methods.

#### `memory.build_context`
- **Params**: `{ query: string, model_context_window?: number }`
- **Returns**: assembled context string (Identity → Constraints → Facts → Conversation → Environment → Known Unknowns)
- When `model_context_window` is provided, sizes the assembly budget against the model's window instead of the fixed 8K default. FFI parity with NAPI `build_context(query, model_context_window)`.

#### `memory.build_context_fast`
- **Params**: `{ query: string, model_context_window?: number }`
- **Returns**: assembled context string, same layer order as `memory.build_context`
- `ContextMode::Fast`. Skips embedding flush, skill lookup, PPR-based scoring, inline repairs, and known-unknowns extraction. Keeps identity, constraints, facts, conversation, and environment.
- **Facts come back in creation order, not relevance order.** That is the whole trade: this is for latency-sensitive callers (voice, real-time), and an agent on Fast advertises spreading-activation memory while doing keyword recall over a flat list. Use `memory.build_context` for anything that reasons over the result — `car do`'s assistant `recall` was moved back to it for exactly this reason. Pick Fast deliberately, and say why at the call site.
- Binds to the session's effective memgine, same namespace rules as `memory.build_context`.

#### `memory.persist`
- **Params**: `{ path: string }`
- **Returns**: number of facts written
- Writes the session's memgine to a JSON file at `path` (flat fact format, backward-compatible with `memory.load`). FFI parity with NAPI `persist_memory`.
- **Writes the whole graph, not a subset.** `path` names the destination file; it does not select what goes into it. On an unbound session that graph is the daemon-wide shared one, so per-project files each end up holding every project's facts. Bind a `memory_namespace` (see the scope table above) if you want a file to contain only one project's facts.
- **Filesystem caveat**: `path` is interpreted on the daemon's filesystem, not the caller's. Cross-process file access requires shared paths.
- **Sandbox**: `path` is sandboxed under `~/.car/memory/` on the daemon (same enforcement the FFI bindings have applied since v0.7.1 — see `car_ffi_common::memory_path::resolve`). Relative paths land under that base; `..` segments and symlinks pointing outside are rejected with a `memory.persist rejected path …` error. The audit-driven flip to require auth on the WS made this surface as exposed as the FFI; the sandbox guards both equally.

#### `memory.load`
- **Params**: `{ path: string }`
- **Returns**: number of facts loaded
- Replaces the session's memgine with the facts at `path`. Internally calls `engine.reset()` before ingest, so this is a full replace, not a merge. FFI parity with NAPI `load_memory`. Same filesystem caveat **and same `~/.car/memory/` sandbox** as `memory.persist`.
- **The reset is scoped to the graph, not the connection.** On an unbound session that graph is the daemon-wide shared one, so this discards facts other sessions currently hold in memory — including facts ingested over MCP. It is easy to miss when the file does not exist yet, because the call fails and no reset happens; the destructive path only appears once the file is there. Bind a `memory_namespace` to make load/persist affect only your own graph.

### models

#### `models.list`
- **Params**: `{}`
- **Returns**: legacy local-only catalog — `[ { name, hf_repo, hf_filename, tokenizer_repo, role, param_count, quantized_size_mb, downloaded }, ... ]`. Limited to the built-in Qwen3 GGUF catalog. Prefer `models.list_unified` for the full registry.

#### `models.list_unified`
- **Params**: `{}`
- **Returns**: full registry — `[ { id, name, provider, capabilities, param_count, size_mb, context_length, available, is_local, operator_managed_external_runtime, weights_ready, downloads_weights, max_output_tokens, public_benchmarks, cost, car_enabled, can_remove, in_use, management_evidence? }, ... ]`. Includes CAR-owned local models (Qwen3, MLX, managed vLLM-MLX), runtime-only local models (Ollama), operator-managed external runtimes, cloud providers, and user-registered models. CAR always includes exactly eleven reviewed personal OpenRouter rows under `openrouter/<provider>/<model>` IDs; they are visible with `available: false` without a personal credential and the same rows report `available: true` when one is present. Typoed or unregistered OpenRouter IDs are absent. Parslee-managed curated entries use eleven opaque `parslee/openrouter/<alias>` IDs that never disclose the upstream provider model. `available` reflects current credential/file presence on every call, including OpenRouter pasted/OAuth changes without restart; `is_local` distinguishes CAR-local accounting from nonlocal ownership without parsing `provider`. **One exception, and it is a correction rather than a caveat:** for the managed `parslee/openrouter/*` rows, credential presence alone is *not* sufficient. Those rows authenticate through the Parslee session, so credential presence means only "signed in" and says nothing about whether the gateway has an OpenRouter upstream to proxy to — an environment without one advertised all ten as available and then failed every request with `503 openrouter_not_configured` (car#786). There is no discovery endpoint to ask, so when the gateway reports that condition CAR records it and those rows report `available: false` until it is re-tested. The suppression is bounded (15 minutes) and cleared on sign-out, so an environment that gains OpenRouter recovers on its own; expect these rows to read available again after that window even with no client action. `public_benchmarks` is `[ { name, score, harness?, source_url?, measured_at? }, ... ]` with `score` on a 0.0–1.0 scale.
- **`cost`** is the model's declared price structure: `{ input_per_mtok, output_per_mtok, cache_read_input_per_mtok, cache_write_input_per_mtok, pricing_tiers, size_mb, ram_mb }`. The four rates are USD per 1M tokens for uncached input, output, cache-read input and cache-write input. `pricing_tiers` is `[ { min_prompt_tokens, input_per_mtok?, output_per_mtok?, cache_read_input_per_mtok?, cache_write_input_per_mtok? }, ... ]` — prompt-size overrides where the highest `min_prompt_tokens` not greater than the prompt wins, and a tier only overrides the components it declares. Every rate is nullable, and `null` means **unpriced, not free**: local/downloaded models declare no prices, and a consumer that reads `null` as `0` publishes a fabricated cost. The managed `parslee/openrouter/<alias>` rows publish the same prices as the personal row they front; a `CostModel` carries no identifiers, so adding `cost` to this response discloses nothing new about the upstream model. Note the scope: **`models.list_unified` carries no upstream identifier for a managed alias, but `models.search` does** — its entries add a `family` field, which for these rows is the upstream model family (e.g. `claude-4.8`), and it matches queries against that field. That is pre-existing and unchanged here; treat the non-disclosure guarantee as holding on `models.list_unified`, not registry-wide. The field is additive: a client built against this version parsing a response from a daemon that predates it sees `cost` absent and defaults it to all-`null`, rather than failing the whole catalog.
- **`weights_ready`** is weights-already-on-disk, and it answers a different question from `available`. `available` means CAR can use the model *here* — for a local MLX entry with a declared `hf_repo` that is `true` before a single byte has been fetched, because `ensure_local()` lazy-downloads on first use (car#164). `weights_ready` is `false` until those bytes actually land, and remote models — which have no weights to install — report `true`. Reading `available` as "installed" is what made `car models list` print MLX rows as available on a machine where `car doctor` said `Models: none installed` (car#894); the CLI now renders the two as separate `RUNNABLE` and `INSTALLED` columns and the two commands agree. The field is additive: a client built against this version parsing a response from an older daemon sees `weights_ready` absent and defaults it to `false`, rather than failing the whole catalog.
- **`downloads_weights`** is `true` only for entries whose weights CAR fetches before use (GGUF, MLX, managed vLLM-MLX, whisper.cpp). When it is `false` — OS-provided models such as `windows/speech-synthesis:os` and `apple/foundation:default`, runtime-only models such as Ollama, external `vllm_mlx` endpoints, and every remote API — there is nothing for CAR to install, so `weights_ready` carries no meaning and the CLI renders `INSTALLED` as `-` rather than a `yes`/`no` about nothing. Do not substitute `available` or `is_local`: a runtime-only row may be available with no downloadable artifact, and an external vLLM-MLX endpoint remains operator-owned even when its URL is loopback. The field is additive: a client built against this version parsing a response from an older daemon sees `downloads_weights` absent and defaults it to `false`, rather than failing the whole catalog.

- **Management fields**: `car_enabled` is false after a receipt-backed Remove from CAR even when shared physical weights still exist; `can_remove` is true only for an enabled receipt-backed managed symlink/file that CAR can unlink without recursive pathname traversal. Receipt-backed directories remain usable but report `can_remove=false` and `management_evidence=install_receipt_directory_cleanup_unsupported` until object-bound cross-platform directory deletion is available. `in_use` reflects live request/residency/teardown/cross-process lease evidence; other `management_evidence` values are `install_receipt`, `shared_or_hand_installed`, `disabled_tombstone`, or absent. These additive fields do not expose paths.
- **Lifecycle projection rule**: clients must not reconstruct a destructive or use action from `available` alone. A CAR-downloadable row is Installed only when `downloads_weights=true`, `weights_ready=true`, and `car_enabled=true`; Use additionally requires an allowed `models.preflight`. A row with `downloads_weights=false` and `available=true` is runtime-available, not Installed. If required lifecycle fields are missing (for example, an older daemon), fail closed for Use. Missing management evidence fails closed for ownership-sensitive Adopt and Remove without erasing otherwise complete runtime/download evidence.
- **Source ownership rule**: `managed_vllm_mlx` is an explicit CAR-owned local source. CAR downloads its artifact, admits and charges its memory, supervises its process group, and reaps it. `vllm_mlx` is an operator-owned external OpenAI-compatible endpoint. Endpoint location is not ownership evidence: a loopback `vllm_mlx` remains operator-owned and is never pulled, locally charged, or reaped by CAR. `operator_managed_external_runtime=true` is emitted only for this source. External describes ownership, not physical network locality; the endpoint may run on the same Mac, on a network host, or in a cloud service. Older rows that omit the additive field remain Unknown to clients and must not be classified from provider, id, or endpoint text.

#### `models.resource_policy.get`
- **Params**: `{}` (unknown fields rejected).
- **Returns**: `{ policy, evaluated_budget, hardware_total_mb, source, warning }`. `policy.custom_max_model_mb` is exact integer MB. `source` is `loaded`, `missing_default`, or `corrupt_default`.
- Everyday evaluates to a 40% host-memory admission ceiling and a separate 20% automatic-recommendation target. Local-focused evaluates to an 80% ceiling and target. Custom accepts exact 512 MB (0.5 GB) increments, including zero. The emergency reserve is the larger of 10% of total memory and 2048 MB. These are CAR admission limits, not kernel-enforced RSS caps.

#### `models.resource_policy.set`
- **Params**: `{ profile: "everyday"|"local_focused"|"custom", custom_max_model_mb: integer|null }` (host-management role required). Custom values must be nonnegative 512 MB increments; presets require `null`.
- **Returns**: `{ policy, evaluated_budget, hardware_total_mb, notice }`. The saved Custom value is preserved exactly; only `evaluated_budget.configured_model_ceiling_mb` and `effective_new_load_ceiling_mb` may clamp to retain the emergency reserve, with the adjustment in `notice`.

#### `models.preflight`
- **Params**: `{ model_id: string, context_tokens?: integer }`.
- **Returns**: `LocalLoadPreflight` without downloading or loading: `{ model_id, estimate, configured_ceiling_mb, resident_model_mb, active_reservations_mb, estimated_incremental_mb, accelerator_total_mb?, accelerator_resident_mb?, accelerator_incremental_mb?, live_available_mb?, emergency_reserve_mb, verdict }`. `verdict` is `allowed`, `live_memory_unknown`, `disabled_by_policy`, `exceeds_configured_ceiling`, `insufficient_live_memory`, `model_maintenance`, or `pending_teardown`. Tombstoned models fail until reinstalled. Only `allowed` authorizes Use in CAR Chat. This is a read-only snapshot; the actual launch atomically rechecks current reservations, residency, and live memory before admitting the allocation, so a later launch can still be rejected.

#### `models.storage_roots`
- **Params**: `{}` (host-management role required; WebSocket-only).
- **Returns**: canonical `{ state_root, models_dir, hf_home, hf_hub, install_receipts_dir, management_state_dir }`. No file contents or secrets are returned.

#### `models.adopt`
- **Params**: `{ model_id: string }` (host-management role required).
- **Returns**: `{ model_id, adopted: true, can_remove: true }`. Adoption is explicit. CAR resolves and identity-checks the registered artifact; callers cannot supply an arbitrary path. Safe legacy managed symlinks may be adopted automatically, but plain directories and shared-cache-only artifacts remain usable and unowned until this call succeeds.

#### `models.remove`
- **Params**: `{ model_id: string }` (host-management role required).
- **Returns**: `{ model_id, removed_from_car: true, artifact_kind, shared_cache_preserved: true }`.
- Requires a collision-checked receipt, serializes against new loads, drains and acknowledges runtime owners, rejects active leases and any in-use state, writes a tombstone, and unlinks only the CAR-managed link/copy. Hugging Face shared caches are never recursively deleted. A receipt-backed directory remains usable but is not removable until safe object-bound directory cleanup exists.

#### `models.route_provenance`
- **Params**: `{ id: "parslee/openrouter/<alias>" }`
- **Returns**: `{ id, provider: "parslee", source: "proprietary_oauth_pkce", is_local: false, endpoint, authority }` for exactly one canonical Parslee-managed OpenRouter alias. Both `endpoint` and `authority` are the sanitized HTTP(S) origin of the current `car_auth::api_base(None)` inference resolution (environment override, then active V2 login, then default); they never contain userinfo, path, query, fragment, or credentials.
- **Initialization requirement**: the model registry must already be initialized. Authenticated callers that receive `models.route_provenance requires an initialized model registry; call models.list_unified to initialize it, then retry` must call `models.list_unified`, wait for it to succeed, and retry. A cold provenance call never initializes the inference engine or performs an availability/PATH probe, SecretStore read, helper subprocess, credential refresh, or network request; any initialization side effects belong to the explicit `models.list_unified` call.
- **Authorization and safety after initialization**: ordinary daemon authentication is required when daemon auth is enabled; unauthenticated connections are rejected by the normal WebSocket auth boundary. The route inspects the already-initialized registered schema (including a valid signed-catalog replacement) through a pure lookup, then requires the same canonical managed selector/transport predicate inference uses. API-base resolution runs on a blocking worker. With no process environment override, it performs one authoritative V2 SecretStore read; on macOS that read may invoke the fixed `/usr/bin/security` helper and may display normal Keychain authorization or unlock UI. It never refreshes availability, writes credentials, starts OAuth, contacts the resolved origin, or invokes a PATH probe. It never returns tokens, account IDs, organization IDs, or persisted credential payloads. User registration/config cannot shadow the reserved `parslee/openrouter/<alias>` namespace; a signed row with a mismatched transport predicate fails closed. Personal `openrouter/*`, other `parslee/*`, and malformed/spoofed aliases are rejected. Callers can compare the returned origin to their approved staging target; CAR does not hardcode an environment.

#### `models.search`
- **Params**: `{ query?: string, capability?: ModelCapability, provider?: string, localOnly?: boolean = false, availableOnly?: boolean = false, limit?: number }`
- **Returns**: `{ models, upgrades, total, available, local, remote }`
- Searchable registry view for host UIs and non-technical installers. Each model entry includes the `models.list_unified` fields plus `{ family, version, tags, pullable, upgrade? }`. `pullable` is true for local/Hugging Face-backed models CAR can install itself. `upgrade` is present when an installed model has a curated replacement.

#### `models.upgrades`
- **Params**: `{}`
- **Returns**: `{ upgrades: [ { from_id, from_name, to_id, to_name, reason, target_runtime?, target_runtime_requirement?, minimum_runtimes, target_available, target_pullable, remove_old_supported }, ... ] }`
- Curated installed-model upgrade hints from the unified registry.

#### `models.recommend`
- **Params**: `{ use_case?, tier?, cloud_ok? }` — `use_case` ∈ `assistant | coding | search | vision | transcription | summarize` (default `assistant`); `tier` ∈ `fastest | balanced | most_capable` (default `balanced`); `cloud_ok` (default `false`) lets remote models compete. Present-but-invalid enum values are rejected as invalid params.
- **Returns**: a `RecommendationSet` — `{ picks: [Recommendation], not_enough_memory: [Recommendation], note? }`. A `Recommendation` is `{ model_id, display_name, role, rationale, download_mb, already_installed, fit: "fits"|"too_big"|"server_provided"|"unknown", acceleration, is_local, requires_cloud_consent, trust_tier, score, within_recommendation_target }`. `within_recommendation_target` is the automatic-selection gate: false candidates remain visible but require an explicit choice. Older serialized recommendations that omit this additive field deserialize as true. `picks` is ranked best-first; `note` is always present when `picks` is empty (machine too small, no cloud key, nothing in the lane), may flag a cloud top pick, and reports corrupt/unreadable persisted policy recovery.
- Ranks registry models for this machine + intent using the persisted local-model resource policy (missing state defaults to Everyday). Everyday Assistant/Balanced puts known-fitting, tool-capable local candidates inside the conservative recommendation target first; heavier and unknown-memory rows remain visible. Policy loading does not read credentials.

#### `models.setup_plan`
- **Params**: the `models.recommend` fields plus optional draft preview `{ resource_policy: { profile: "everyday"|"local_focused"|"custom", custom_max_model_mb: integer|null } }`. The nested policy is strict: unknown fields, malformed types, incomplete Custom values, preset/custom mismatches, negative or non-integer values, and non-512 MB increments are rejected. A present preview affects ranking, fit, automatic-target eligibility, and the evaluated budget but is never saved and never mutates engine admission state. `models.recommend` does not accept this preview.
- **Returns**: `{ machine, recommended: Recommendation|null, alternatives: [Recommendation], needs_more_memory: [Recommendation], note: string|null, resource_policy, evaluated_budget, policy_source }` — a host-actionable onboarding plan. `policy_source` is `preview`, `loaded`, `missing_default`, or `corrupt_default`. Without a preview, setup preserves the persisted-policy warning and Everyday fallback behavior. `recommended` is non-null only when a candidate has `within_recommendation_target: true`; heavier/unknown candidates stay in `alternatives` and never become an automatic default. `machine` is a plain-language hardware summary.

#### `models.detect_upgrades`
- **Params**: `{}`
- **Returns**: `{ upgrades: [ { from_id, from_name, to_id, to_name, reason, trust_tier: "curated"|"community", source: "curated"|"upstream", target_pullable } ] }`
- Combines curated rules with upstream Hub discovery. Upstream probing only runs on the `latest` update channel, is cached (TTL, invalidated when the installed set changes), and degrades silently offline.

#### `models.check_upgrade_nudge`
- **Params**: `{ inference_active? }` (default `false`)
- **Returns**: a `NudgeDecision` — `{ auto_apply: [UpgradeFinding], nudge?: { finding, message, dismiss_key } }`. Poll form of the proactive nudge; the daemon also pushes `models.upgrade_available` (below). Honors update preferences (policy/throttle/dismissals) and suppresses everything while `inference_active`.

#### `models.dismiss_upgrade`
- **Params**: `{ dismiss_key }` (non-empty)
- **Returns**: `{ dismissed: <key> }`
- Records that the user waved away a nudge so it never re-fires.

#### `models.check_concierge`
- **Params**: `{ inference_active? }` (default `false`)
- **Returns**: `{ suggestions: [ConciergeSuggestion] }` where each is `{ use_case, model_id, display_name, download_mb, message, dismiss_key }`. Poll form of the proactive concierge; the daemon also pushes `models.suggestion_available` (below). A suggestion fires only for a use-case lane the user has **no** installed model for (distinct from `models.upgrade_available`, which is installed→newer). Honors update preferences (`policy == off` → none), throttles independently of the upgrade nudge (≤ once/week), suppresses dismissals, and stays silent while `inference_active`.

#### `models.dismiss_suggestion`
- **Params**: `{ dismiss_key }` (non-empty)
- **Returns**: `{ dismissed: <key> }`
- Records that the user waved away a concierge suggestion so it never re-fires. Shares the dismissal store with `models.dismiss_upgrade`; the key namespaces are disjoint (`concierge:…` vs `from=>to`).

#### `models.update_prefs_get`
- **Params**: `{}`
- **Returns**: `UpdatePreferences` — `{ channel: "stable"|"latest", policy: "auto"|"notify"|"off", disk_budget_mb?, keep_old_until_verified }`.

#### `models.update_prefs_set`
- **Params**: the `UpdatePreferences` shape (all fields optional; missing → defaults). Malformed input is rejected.
- **Returns**: the stored `UpdatePreferences`.
- A team-shared project `.car/update-prefs.json` overrides the user file.

#### `models.pull_progress` (server → client notification)
- **Pushed** to subscribed UI clients while a `models.pull` / `models.install` is downloading. **Params**: `{ model, event }` where `event` is a tagged `DownloadEvent`: `{ event: "started", model, total_files, total_mb }`, `{ event: "file_started", filename, index, total_files, size_mb }`, `{ event: "file_progress", filename, downloaded_mb, total_mb }` (reserved; not emitted by the current downloader), `{ event: "file_completed", filename }`, `{ event: "completed", model }`, or `{ event: "failed", error }`. File-level granularity (a few dozen events per pull). Subscribe via the standard UI-event subscription. `completed` closes the transfer transaction; it is not sufficient evidence for a UI to claim Installed or select the model. Refresh `models.list_unified`, match the same model id, and require an allowed `models.preflight` before enabling Use.

#### `models.upgrade_available` (server → client notification)
- **Pushed** (not a request) to subscribed UI clients when the daemon's periodic check decides a newer model is worth surfacing. **Params**: `{ finding, message, dismiss_key }` (an `UpgradeNudge`). Throttled to ≤ once/day; respects update preferences and dismissals. Acknowledge with `models.dismiss_upgrade`.

#### `models.suggestion_available` (server → client notification)
- **Pushed** (not a request) to subscribed UI clients when the daemon's periodic concierge check finds a use-case lane with no installed model and a fitting on-device pick. **Params**: a `ConciergeSuggestion` — `{ use_case, model_id, display_name, download_mb, message, dismiss_key }`. One push per unserved lane. Throttled to ≤ once/week (independent of the upgrade nudge); respects update preferences and dismissals. Act on it with `models.pull` (the suggested `model_id`), or wave it away with `models.dismiss_suggestion`.

#### `models.register`
- **Params**: `ModelSchema` (the bare value) OR `{ schema: ModelSchema }`. Both shapes are accepted — `rt.registerModel(schemaJson)` from the FFI bindings passes the bare value; explicit JSON-RPC callers may prefer the wrapped form for readability.
- **Returns**: `{ id, registered: true, path, note }` — `path` is the resolved `models.json` location (`~/.car/models.json`, or `$CAR_HOME/models.json` when the daemon was started with a state root); `note` carries the daemon-restart-required reminder (see below).
- Persists the supplied `ModelSchema` to `models.json` under the daemon's state root (replacing any existing entry with the same `id`). The registry reads it back from the same resolved path on the next boot, so a registration against a relocated daemon takes effect on that daemon. Schema follows `car_inference::ModelSchema`: `{ id, name, provider, family, capabilities, source: ModelSource, context_length, ... }`. `ModelSource` is the load-bearing enum: `local | remote_api | ollama | mlx | vllm_mlx | managed_vllm_mlx | apple_foundation_models | proprietary | delegated`. `vllm_mlx` is always external/operator-owned; `managed_vllm_mlx` is the explicit CAR-owned local source.
- **Trust boundary**: every persisted row is normalized to `trust_tier: "community"`, even when the payload omits `trust_tier` (legacy serde defaults it to Curated) or explicitly claims `"curated"`. The same rule applies to public Rust `UnifiedRegistry::register` and `InferenceEngine::register_model`. The reviewed `parslee/openrouter/<alias>` namespace is reserved: `models.register` rejects it and stale persisted user rows with those IDs are ignored, so no user schema can shadow CAR-managed provenance. Only compiled builtins and detached-signature-verified project catalogs retain Curated provenance. Community rows remain explicitly selectable and learn from outcomes, but an eligible Curated remote peer excludes them from latency-sensitive quality-first cold-start candidates and fallbacks.
- **Visibility limitation (phase 1)**: the daemon's live `UnifiedRegistry` is not updated in-process. The model becomes visible to `models.list*` / `infer` / `infer_stream` on the **next daemon boot**, when `UnifiedRegistry::load_user_config` re-reads the file. Hot-update inside the running daemon requires interior mutability on `InferenceEngine` and is tracked as a separate follow-up. Callers SHOULD register models before issuing `infer` calls against them, or restart the daemon after a batch of registrations.
- Closes [Parslee-ai/car-releases#39].

[Parslee-ai/car-releases#39]: https://github.com/Parslee-ai/car-releases/issues/39

#### `models.unregister`
- **Params**: `{ id: string }` (a bare string is also accepted for symmetry with internal callers).
- **Returns**: `{ id, unregistered: true, path, note }` on success. Error when the id isn't present in the state root's `models.json`.
- Symmetric counterpart to `models.register`. Removes the entry from the same state-root `models.json` by id and writes the file back atomically.
- **Visibility limitation (phase 1)** matches `models.register`: the daemon's live `UnifiedRegistry` is not rebuilt, so the removal takes effect on the **next daemon boot**. Operators SHOULD restart the daemon after a batch of unregistrations if they need `models.list_unified` to reflect the change immediately.

#### `models.pull`
- **Host-management only. Params**: exactly one of `{ name: string }`, `{ id: string }`, or `{ model: string }`; unknown fields are rejected.
- **Returns**: `{ path: string }`
- The daemon owns the install transaction after authorization, so a client disconnect does not cancel a partially published receipt or tombstone reversal. CAR downloads into a private staging directory and atomically publishes only a new CAR-owned projection; a pre-existing unreceipted same-name directory is never promoted into deletion ownership. External `vllm_mlx` and runtime-only sources are not pullable. A successful response confirms the install transaction, not an allowed launch; clients still refresh the unified row and preflight before Use.

#### `models.install`
- **Host-management only. Params**: exactly one of `{ id: string }`, `{ name: string }`, or `{ model: string }`; unknown fields are rejected.
- **Returns**: `{ path: string }`
- Alias for `models.pull` with installer-friendly parameter names.

### multi

Multi-agent coordination. All variants delegate per-agent execution back to the client via `multi.run_agent` callbacks (same pattern as `tools.execute`).

All variants also accept an optional `budget` object — a runtime-enforced coordination budget (see [`BudgetLimits`](#budgetlimits) below).

#### `multi.swarm`
- **Params**: `{ mode: "parallel"|"sequential"|"hybrid", agents: AgentSpec[], task: string, synthesizer?: AgentSpec, budget?: BudgetLimits }`
- **Returns**: swarm result with per-agent outputs

#### `multi.pipeline`
- **Params**: `{ stages: AgentSpec[], task: string, budget?: BudgetLimits }`
- **Returns**: pipeline result with stage outputs

#### `multi.supervisor`
- **Params**: `{ workers: AgentSpec[], supervisor: AgentSpec, task: string, max_rounds?: number = 3, budget?: BudgetLimits }`
- **Returns**: supervision result

#### `multi.map_reduce`
- **Params**: `{ mapper: AgentSpec, reducer: AgentSpec, items: string[], task: string, budget?: BudgetLimits }`
- **Returns**: reduce result

#### `multi.vote`
- **Params**: `{ agents: AgentSpec[], task: string, synthesizer?: AgentSpec, budget?: BudgetLimits }`
- **Returns**: vote result with winning output

#### `multi.tournament`
- **Params**: `{ competitors: AgentSpec[], judge: AgentSpec, task: string, budget?: BudgetLimits }`
- **Returns**: `{ task, candidates: AgentOutput[], matches: MatchResult[], winner_name, winner_answer, ranking: string[] }`
- Each competitor produces one candidate answer to the task, then the `judge` agent compares candidates **pairwise** in a single-elimination bracket (odd one out gets a bye) until one winner remains. The judge is a fresh agent per match. `ranking` orders competitors best→worst by elimination round. Use this over `multi.vote` when you need a relative ordering by comparative judgment rather than single-shot majority.

#### `multi.subtask`
- **Params**: `{ main: AgentSpec, task: string, budget?: BudgetLimits }`
- **Returns**: `{ task, final_answer, subtasks: SubtaskRecord[] }`
- Runs the `main` agent with a `spawn_subtask` tool enabled. The agent can spawn ephemeral sub-agents and grant each a **subset of its own tools**. The subset is a verified precondition: the tool's schema constrains the `tools` parameter to an `enum` of the main agent's tool names, so the runtime validator rejects any out-of-subset call before execution; the executor re-checks it as defense in depth. Multiple `spawn_subtask` calls in one model turn run concurrently via the engine's DAG executor. A `budget` here also caps how many sub-agents the main agent may spawn.

`AgentSpec` (from `car_multi::AgentSpec`, serde — these fields are **required** unless marked optional): `{ name: string, system_prompt: string, tools: string[], max_turns: number, metadata: object, cache_control?: boolean }`. Model/provider selection is conventionally carried in `metadata` and interpreted by the caller's agent runner. For `multi.subtask`, `main.tools` is load-bearing — it is the universe a spawned sub-agent's tools must be a subset of.

<a id="budgetlimits"></a>
**`BudgetLimits`** (from `car_multi::BudgetLimits`, serde — every field optional, omitted means unbounded): `{ max_input_tokens?: number, max_output_tokens?: number, max_total_tokens?: number, max_cost_usd?: number, max_agents?: number }`. The runtime sums the token/cost spend the agent runner reports (via `AgentOutput.tokens`) and **refuses to start a new agent once any limit is crossed** — overshoot is bounded by the work already in flight when the limit trips. For sequential and iterative coordinations (sequential swarm, pipeline, supervisor rounds) this is tight between-agent enforcement; for a single parallel batch it is a pre-flight gate plus the hard `max_agents` cap. Agents the budget refuses to start appear in the result as outputs with an `error` describing the denial; a denied reviewer/synthesizer falls back rather than failing the whole run.

### permissions

#### `permissions.status`
- **Params**: `{ domain: string, target_bundle_id?: string }`
- **Returns**: `{ domain, status, target_bundle_id }`. `status` is one of `granted` | `denied` | `not_determined` | `restricted` | `not_applicable` | `restart_required` | `signature_changed` | `unknown`. The `calendar` domain reports a real, non-prompting EventKit query (not a stub) and can additionally return `write_only` (macOS-14 write-only calendar grant).

#### `permissions.request`
- **Params**: `{ domain: string, target_bundle_id?: string }`
- **Returns**: request result (granted / denied / pending)

#### `permissions.explain`
- **Params**: `{ domain: string, target_bundle_id?: string }`
- **Returns**: human-readable explanation of what the permission grants

#### `permissions.domains`
- **Params**: `{}`
- **Returns**: `string[]` — all known permission domain names

### proposal

#### `proposal.submit`
- **Params**: `{ proposal: ActionProposal, session_id?: string, scope?: RuntimeScope, ... }`
- **Returns**: `ExecutionResult { final_state, outputs, errors, ... }`
- Triggers `tools.execute` callbacks to the client for each `tool_call` action. See `docs/agent-ir-spec.md` for the proposal shape.
- **Gated by the session's permission tier.** Before any action dispatches, the proposal is admitted against the session's granted standing tier (`permission.set_tier`, default `sandbox_edit`). An action whose required tier exceeds the grant — or a `full_access` action, which is always mandatory HITL — blocks the **whole** proposal: every action comes back `rejected`, nothing executes, and no state write lands. The error names the fingerprints to hand to `permission.approve`; re-submitting after approval succeeds. Run `permission.evaluate` first to see the same verdict without submitting. See the `permission.*` section.
- `session_id` (optional) scopes per-action policy validation to a session opened via `session.policy.open` on this connection's runtime. Global policies still apply, plus the session's. Omit for the default global-only path. See `docs/proposals/per-session-policy-scoping.md`.
- `scope` (optional) is a `RuntimeScope` — `{ callerId?: string, tenantId?: string, claims?: object }` — attaching per-execution caller / tenant identity. When `tenantId` is set, the runtime routes per-action state R/W (`StateWrite` / `StateRead` / `Assertion` + action `expected_effects`) through the tenant-scoped view so distinct tenants can't observe each other's keys (Parslee-ai/car#187 phase 3). The car-a2a bridge already passes this automatically for inbound A2A messages; direct WS callers building their own proposals attach it here. When both `session_id` and `scope` are supplied, the runtime currently routes through `execute_scoped` (scope wins) — combining per-session policies with per-tenant scoping is a follow-up.

### policy

#### `policy.register`
- **Params**: `PolicyDefinition { name: string, rule: "deny_tool" | "deny_tool_param" | "require_state", target?: string, key?: string, pattern?: string, value?: any, session_id?: string }`
- **Returns**: `{ registered: string, scope: "global" | { session_id: string } }`
- Register a single policy on this WebSocket session's runtime. `session_id`, when set, scopes the policy to a per-session policy registry opened via `session.policy.open`; without it, the policy is global. Mirrors the `PolicyDefinition` shape used by `session.init` (which lets clients submit a batch at startup).

#### `policy.unregister`
- **Params**: `{ name: string, session_id?: string }`
- **Returns**: `{ unregistered: string, removed: number, scope: "global" | { session_id: string } }`
- Remove every policy registered under `name`. `removed` is how many were dropped — `0` means nothing matched, reported rather than raised, so a client cleaning up can call this unconditionally. (`policy.register` appends without de-duplicating, so a name can legitimately cover more than one policy; all of them go.)
- Before this existed a global policy could not be removed at all: once registered it lived until the daemon restarted, so a mistyped or over-broad rule could only be cleared by bouncing the process and losing every other piece of in-memory state with it. Session-scoped policies could already be dropped wholesale via `session.policy.close`; this removes one by name.

#### `policy.list`
- **Params**: `{ session_id?: string }`
- **Returns**: `{ policies: [{ name: string, description: string }], scope: "global" | { session_id: string } }`
- What is currently in force, in registration order. Without it a client could register a policy but never ask what was enforced, so an action rejection could not be explained beyond the single message on the rejection itself.

### scheduler

#### `scheduler.create`
- **Params**: `{ name: string, prompt: string, trigger?: "once"|"cron"|"interval"|"file_watch" = "manual", schedule?: string, system_prompt?: string }`
- **Returns**: task object (does NOT execute — just constructs the task definition)

#### `scheduler.run`
- **Params**: `{ task: object }`
- **Returns**: single execution result
- **Stateful dedup**: the daemon seeds the posted task with any prior execution
  history persisted for `task.id` (under `~/.car/tasks/`) before running, and
  saves the mutated task back afterward. This means the executor's deterministic
  occurrence guard survives across calls: re-posting the same Interval/Once/Cron
  task whose occurrence already ran returns the prior execution record instead of
  re-invoking the agent. `Manual` triggers carry no occurrence id and are
  intentionally never deduped (an explicit re-run is an intentional repeat).

#### `scheduler.run_loop`
- **Params**: `{ task: object, max_iterations?: number }`
- **Returns**: array of execution results
- **Stateful dedup**: same prior-history seeding and write-back as
  `scheduler.run` — occurrences already serviced in an earlier call are skipped.

#### Durable OS-level scheduling (`scheduler.os_*`)

`scheduler.run`/`run_loop` use in-process timers: if the daemon is down when a task is due, the run is missed. These methods delegate the *trigger* to the OS scheduler (`launchd` on macOS, `crontab` on Linux), which fires a command even with no CAR process running. Only `interval` and `cron` triggers are OS-schedulable (`once`/`manual`/`file_watch` are rejected). `program` + `args` are the command the OS runs to re-enter CAR and execute the task once (the caller owns this — e.g. a `car`/`car-server` invocation). Schedules are labeled `ai.parslee.car.task.<task_id>`.

- `scheduler.os_render` — **Params**: `{ task: object, program: string, args?: string[] }`. **Returns**: `{ label, launchd_plist, launchd_error, crontab_line, crontab_error, schtasks_xml, schtasks_error }` — a no-I/O preview of every backend (macOS launchd, Linux crontab, Windows Task Scheduler); each rendering is `null` when that backend can't express the schedule, with the reason in the matching `*_error`. (E.g. an interval that isn't a whole number of minutes can't map to cron; a `*/15` cron can't map to launchd's `StartCalendarInterval`; a multi-valued cron field can't map to a single `schtasks` trigger.)
- `scheduler.os_install` — **Params**: same as `os_render`. **Returns**: `{ label, backend: "launchd"|"cron"|"schtasks", detail }`. Writes the plist to `~/Library/LaunchAgents` and `launchctl load`s it (macOS), appends a tagged crontab line (Linux), or registers a Windows Task Scheduler task via `schtasks /Create /XML` (Windows). Idempotent — replaces any prior schedule for the same task. Also **persists the task to `~/.car/tasks/`** so the store stays the authoritative set of scheduled tasks (which `os_reconcile` reaps against); a persist failure aborts the install.
- `scheduler.os_uninstall` — **Params**: `{ label: string }` (full label or bare task id). **Returns**: `{ label, removed: boolean }`.
- `scheduler.os_list` — **Params**: none. **Returns**: a JSON array of installed CAR schedule labels on this host.
- `scheduler.os_reconcile` — **Params**: none. **Returns**: `{ removed: string[], kept: number, errors: string[] }`. Reaps orphaned schedules: uninstalls every CAR-managed label whose task is gone from `~/.car/tasks/` or whose trigger is no longer `interval`/`cron` (foreign launchd/cron entries are never touched). Best-effort per label — a failed uninstall is recorded in `errors` and the pass continues. Runs automatically at daemon boot; call this to reap on demand. Because `os_install` persists the task, a label with no backing task is normally a genuine orphan. If the task store can't be **read** (permission/IO error), it returns an error and reaps nothing rather than mistaking the failure for "no tasks"; a missing store dir is treated as legitimately empty.
- FFI: `renderOsSchedule`/`installOsSchedule`/`uninstallOsSchedule`/`listOsSchedules`/`reconcileOsSchedules` (NAPI) and the `snake_case` equivalents (PyO3).

#### `tasks.*` — daemon-native deterministic (command) scheduler (car-releases#72)

Schedule a **deterministic command** on a cadence expressed ONCE, with the OS backend hidden — the higher-level abstraction over the `scheduler.os_*` primitives for consumers who want "ask CAR to run my script on a cadence" rather than "deal with launchd/cron". The command runs a `program` + `args` (not an LLM prompt).

- `tasks.schedule` — **Params**: `{ name, program, args?: string[], cadence: { interval_secs?: number | cron?: string }, durable?: boolean, working_dir?, env?, permission_tier? }` — the cadence is expressed once (exactly one of `interval_secs` / `cron`). **Returns**: `{ id, durable, backend: "launchd"|"cron"|"schtasks"|"daemon", task }` (`schtasks` = Windows Task Scheduler). CAR picks the backend: `durable: true` (default) installs to the OS scheduler so it fires even when car-server is down — **`*/N` cron is normalized** (expanded to a launchd calendar array) so the same input works on macOS and Linux; `durable: false` uses the in-daemon timer (fires only while car-server runs, `backend: "daemon"`), which supports `interval_secs` only (a cron cadence requires the OS backend). The task is persisted to `~/.car/tasks/` first (authoritative for `os_reconcile`).
- `tasks.list` — **Params**: none. **Returns**: an array of `{ id, name, program, args, trigger, schedule, durable, backend, enabled }` for the command tasks in the store.
- `tasks.unschedule` — **Params**: `{ id }` (bare id or full `ai.parslee.car.task.<id>` label). **Returns**: `{ id, os_removed, deleted }` — removes any OS schedule AND deletes the task from the store (so the daemon timer drops it too).
- FFI: `scheduleTask`/`listScheduledTasks`/`unscheduleTask` (NAPI) and `snake_case` equivalents (PyO3).

### secret

#### `secret.put`
- **Params**: `{ service?: string, key: string, value: string }`
- **Returns**: success indicator
- Uses the OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux).
- `key: "openrouter"` is a convenience alias for `OPENROUTER_API_KEY` on put/get/delete/status. Values are never returned by list/status; changing this pasted slot supersedes any pending OpenRouter OAuth flow but never deletes the separate OAuth credential.
- The exact daemon-owned OAuth slot (`service: "car"`, `key: "OPENROUTER_OAUTH_API_KEY"`) is reserved: `secret.put`, `secret.get`, and `secret.delete` fail with `reserved_private_secret`. Use `openrouter.auth_start` / `openrouter.disconnect`; status/list remain metadata-only and never return its value.
- The Parslee-owned service-`"car"` slots are reserved by the same generic boundary:
  `PARSLEE_ACCESS_TOKEN`, `PARSLEE_REFRESH_TOKEN`,
  `PARSLEE_ACCESS_TOKEN_EXPIRES_AT`, `PARSLEE_API_BASE`,
  `PARSLEE_AUTH_STATE_V2`, `PARSLEE_ACCOUNTS`, every
  `PARSLEE_TOKENS_*` stash key,
  `PARSLEE_ACTIVE_ACCOUNT_ID`, `PARSLEE_AUTH_GENERATION`, and
  `PARSLEE_AUTH_COMPLETION`. Manage them only through `auth.*`; generic
  `secret.put`, `secret.get`, and `secret.delete` return
  `reserved_private_secret`.

#### `secret.get`
- **Params**: `{ service?: string, key: string }`
- **Returns**: `{ value: string }`

#### `secret.delete`
- **Params**: `{ service?: string, key: string }`
- **Returns**: success indicator

#### `secret.status`
- **Params**: `{ service?: string, key: string }`
- **Returns**: status / metadata

#### `secret.available`
- **Params**: `{}`
- **Returns**: `boolean` — whether the OS keychain is reachable

#### `secret.list`
- **Params**: `{}`
- **Returns**: `{ secrets: [{ service: string, key: string, exists: boolean | null }] }`
- Lists the **names** of secrets stored through the FFI/CLI/WS surface — never the values. Backed by the `~/.car/secret_index.json` name index (the OS keychain has no portable enumeration), with each name joined to a live existence check (`exists` is `null` when the backend couldn't be probed). CAR-internal secrets written directly to the keychain (connector OAuth tokens, browser session refs) are deliberately absent.

### session

#### `session.init`
- **Params**: `{ tools: ToolDefinition[], policies?: PolicyDefinition[] }`
- **Returns**: `{ session_id: string, tools_registered: number, policies_registered: number }`
- Initializes the per-session runtime. **Optional** — only required if the
  client wants to pre-declare tools or policies in a single batch.
  Connections that use only daemon-side capabilities (inference,
  memory, browser, A2UI, meeting, etc.) can skip `session.init`
  entirely and start calling those methods directly after
  `session.auth`. The first method that needs runtime state lazily
  creates an empty session.
- The required first frame is `session.auth` (auth handshake);
  `session.init` is the second frame *only when needed*. Lifecycle
  agents that don't expose tools through the daemon's executor
  typically skip this call.

#### `session.bindSubstrate`
- **Params**: `{ connector: string }` — the slug of an already-connected MCP connector (see `connectors.add` / `connectors.list`).
- **Returns**: `{ bound: true, substrate: string }` — `substrate` is the bound environment's name (the connector slug).
- Binds **this** session's runtime to the *execution substrate* of an
  already-connected MCP connector (`docs/execution-substrate.md`, phase 3).
  After binding, the session's commodity built-ins
  (`read_file`/`write_file`/`edit_file`/`list_dir`/`find_files`/`grep_files`)
  execute on the **connector's environment** (e.g. a VM bridge) instead of
  the WS client/host, so they co-locate with that session's `mcp_{slug}_*`
  tools — one coherent environment, no host/VM split.
- The built-in file tools keep their standard contract on the bound substrate:
  `read_file` returns line-numbered (`cat -n`) content, and `edit_file`/
  `write_file`-over-existing require the session to have read the path first
  (read-before-edit + staleness guard). A paged read supports a unique targeted
  edit; replace-all edits and whole-file overwrite or append need a fresh
  unpaged read. Only *where* they act changes.
- **Opt-in and per-session.** A session that never calls this keeps the
  historic composition: a default `LocalSubstrate` plus the
  MCP-routes-then-WS-client fallback. Every existing consumer (GUI,
  A2A-over-WS, connectors-as-tools, coder) is unaffected by default. This
  method does **not** change connector `mcp_{slug}_*` routing or the WS tool
  callback for non-built-in names — only the six bare built-in names are
  redirected to the bound substrate.
- **Errors** with `connector '<slug>' is not connected` if the named
  connector has not been dialed; the session's substrate is left unchanged.

#### `session.bindSandbox`
- **Params**: `{ working_dir: string, image?: string, network?: string, memory?: string, cpus?: string, pids_limit?: number, command_timeout_secs?: number }` — `command_timeout_secs` must be ≥ 1; a command timeout stops the daemon-side wait (the in-container process may keep running until the container is torn down — wrap workloads in `timeout N ...` when they must die)
- **Returns**: `{ bound: true, substrate: string }` — `substrate` is `docker:<image>`.
- Binds **this** session's runtime to a **Docker-sandboxed execution
  environment** (D1). After binding, the session's commodity built-ins
  (`shell`/`read_file`/`write_file`/`edit_file`/`list_dir`/`find_files`/
  `grep_files`) execute **inside a hardened container** whose `/workspace`
  is a bind-mount of `working_dir` — the mount namespace is the host
  boundary, so a path can never reach host files outside the workspace.
  The file built-ins keep their standard contract inside the container:
  line-numbered `read_file` output and the read-before-edit + staleness guard
  on `edit_file`/`write_file`, including the unpaged-read requirement for
  whole-file mutations and replace-all edits.
- **Default-secure posture (D3)**: `--network none` (no egress — opt in
  with `network: "bridge"` or a Docker network name, D2), memory `512m`,
  `pids_limit` 256, `cpus` 1.0, all Linux capabilities dropped,
  no-new-privileges. Every knob is overridable per bind; the DEFAULTS are
  the hardened ones. Default image `python:3.11-slim`.
- **Preflight-first, no silent fallback**: Docker and the image are
  preflighted before anything is bound. A host without a running Docker
  daemon (or an unpullable image) gets the preflight's actionable error —
  the daemon never silently substitutes unsandboxed host execution for the
  requested sandbox (that would be a security downgrade the caller can't
  see).
- **Not available to supervised agents** (agent-token sessions;
  Parslee-ai/car#480): `bindSandbox` mounts an arbitrary host `working_dir`
  read-write into a container the caller drives via shell. For an ordinary
  host/CLI client that's no escalation (its process already has user-level FS
  access), but a supervised, app-level-confined agent could use it to
  bind-mount any host directory (`/`, `~/.ssh`) — a confinement escape. Such a
  session is refused with a clear error.
- Same opt-in/per-session semantics as `session.bindSubstrate`: non-built-in
  tool names keep the WS callback path; only the substrate-owned built-ins
  are redirected into the container.

#### `session.policy.open`
- **Params**: `{}`
- **Returns**: `{ session_id: string }`
- Open a new in-runtime policy-scoping session and return its opaque id. Distinct from the WebSocket-connection session created by `session.init` — this is a sub-context within that connection's runtime, used to layer per-context deny rules on top of global policies. Hosts that drive multiple concurrent agent contexts (IDE per-project rules, multi-tenant servers) call this once per context. The id is consumed by `policy.register { ..., session_id }` and `proposal.submit { ..., session_id }`. See `docs/proposals/per-session-policy-scoping.md`.

#### `session.policy.close`
- **Params**: `{ session_id: string }`
- **Returns**: `{ closed: boolean }`
- Close a previously-opened policy session and drop every policy scoped to it. Returns `true` if the session existed; `false` if it didn't (already closed, never opened, etc.). Idempotent in effect.

### skill

Skills are learned procedures stored as graph nodes with trigger context. See `docs/agent-ir-spec.md` for the skill shape.

#### `skill.ingest`
- **Params**: `{ name: string, code: string, platform?: string, persona?: string, url_pattern?: string, description?: string, task_keywords?: string[], supersedes?: string }`
- **Returns**: numeric memgine node id of the ingested skill

#### `skill.find`
- **Params**: `{ persona?: string, url?: string, task?: string, max_results?: number = 1 }`
- **Returns**: `[ { name, code, platform, description, stats, match_score }, ... ]`
- Spreading-activation match against trigger edges.

#### `skill.report`
- **Params**: `{ skill_name: string, outcome: "success" | string }`
- **Returns**: updated stats. Skills auto-degrade when `fail_count > success_count + 2`.

#### `skill.gate_deployment`
- **Params**: `{ skill_name: string, provenance?: SkillProvenance, requested_tier: "read_only" | "sandbox_edit" | "full_access" }`
- **Returns**: `SkillDeploymentDecision` `{ trust, ceiling, granted, outcome: "allow" | "downgrade" | "deny", reason }`
- Gates a skill's requested deployment capability against its provenance (arXiv 2602.12430 "Agent Skills"; `docs/proposals/skill-trust-governance.md`). The caller supplies the **static** provenance (signature/scan/source — typically built from a `car-bundle` manifest via `assess_signature_trust`); the daemon overrides the **lifecycle** counts (`success_count`/`fail_count`) with the named skill's real track record before gating, so a skill failing in the field is demoted to `untrusted` and denied despite an official signature. Live counterpart to the stateless `gate_skill_deployment` FFI helper. FFI: `gateSkillDeploymentLive` (NAPI) / `gate_skill_deployment_live` (PyO3).

#### `skill.enforce_deployment`
- **Params**: `{ skill_name: string, provenance?: SkillProvenance, requested_tier: "read_only" | "sandbox_edit" | "full_access" }`
- **Returns**: `{ decision: SkillDeploymentDecision, enforcement: { deploy, effective_tier, overridden, blocked, pending, reason }, pending_approval?: { fingerprint, skill_name, requested_tier } }`
- The **load-time enforcement** bridge (Slice 4): gates the skill (as `skill.gate_deployment`), then resolves the verdict against the daemon's **shared durable** `ApprovalLedger` — the same restart-surviving, cross-connection ledger `permission.*` writes to. `Allow`/`Downgrade` deploy autonomously (a downgrade is the gate's own safe mitigation); a `Deny` is **overridden** if an operator previously approved it (deploys at the requested tier), **blocked** if rejected, or surfaced as `pending_approval` for an unseen deny. The host resolves a pending approval via `permission.approve`/`permission.reject` keyed by the returned `fingerprint`. FFI: `enforceSkillDeploymentLive` (NAPI) / `enforce_skill_deployment_live` (PyO3).

#### `skill.ingest_governed`
- **Params**: the same flat skill fields as `skill.ingest` (`name`, `code`, `platform`, `persona?`, `url_pattern?`, `description?`, `supersedes?`, `task_keywords?`), plus `provenance?: SkillProvenance` and `requested_tier: "read_only" | "sandbox_edit" | "full_access"`
- **Returns**: `{ ingested: bool, node?: number, decision: SkillDeploymentDecision, enforcement, pending_approval?: { fingerprint, skill_name, requested_tier } }`
- The **loader integration**: ingests a skill *through* the deployment gate. Gates the provenance against the requested capability, enforces against the daemon's shared durable `ApprovalLedger`, and **only adds the skill to the graph when deployment is permitted** — stamping the granted ceiling onto `SkillMeta.deployment_tier` (which survives `memory.persist` and is visible to execution). A denied skill is not ingested (`ingested: false`); an unseen deny surfaces a `pending_approval` resolved via `permission.approve`/`permission.reject`. FFI: `ingestSkillGoverned` (NAPI) / `ingest_skill_governed` (PyO3).

#### `skill.adopt_pack`
- **Params**: `{ pack: ApprovedSkillPack, requested_tier?: "read_only" | "sandbox_edit" | "full_access" = "read_only", manifest?: AgentManifest, provenance?: SkillProvenance, scanned?: boolean = false, vulnerabilities?: number = 0, source?: "official" | "first_party" | "community" | "unknown" = "unknown" }`
- **Returns**: `{ loaded: string[], pending: [ { skill_id, fingerprint }, ... ], refused: [ { skill_id, reason }, ... ], requested_tier: string, provenance: SkillProvenance, trusted_signers: number }`
- The **daemon call-site** for governed pack adoption: materializes an `ApprovedSkillPack` into the session graph with every skill routed through the deployment gate. Governance is **unconditional** here — there is no ungoverned mode on this method, which is what makes governed adoption the default rather than something a host opts into. Provenance comes from **either** `manifest` **or** a caller-assembled `provenance`; passing **both is an error**, because silently preferring one would drop a security-relevant input, and passing neither yields the conservative unsigned/unscanned default. The two paths are not equivalent: `manifest` is the **derived** path — the caller cannot assert `signed`/`signer_trusted`, which are computed by `MemgineEngine::skill_provenance_from_bundle` against the operator's `.car/config.toml` `trusted_skill_signers` keyring, read **only** from operator config and never from the request (a caller that could name its own trusted keys would be self-certifying). `provenance` is a **trusted-caller escape hatch**: it is taken at face value and nothing clamps or cross-checks it, so any caller that can reach this method can assert any trust tier, up to `official` + `full_access`. It exists for hosts carrying their own attestation — the same contract `skill.ingest_governed` offers — and it means the keyring rule constrains the `manifest` path only. On that path, an empty keyring costs less than it sounds: `signer_trusted` separates **only** `Official` from `Verified`, so a signed + scanned pack lands `Verified` → `sandbox_edit` rather than `Official` → `full_access`; it is never demoted to `Community` (which requires `scanned && !signed`), and an unscanned pack is `Untrusted` → denied either way. Since `scanned` is caller-supplied on every path, a self-signed manifest sent with `"scanned": true` reaches `sandbox_edit` against an empty keyring. Enforcement runs against the daemon's **shared durable** `ApprovalLedger` — the same restart-surviving, cross-connection ledger `permission.*` writes to: a `Deny` skill **never enters the graph**, a previously-approved override deploys, and an unseen deny surfaces in `pending` with a fingerprint the host resolves via `permission.approve`/`permission.reject` before re-adopting. Adoption is **per-skill, so a pack can adopt partially** — the skills whose verdict permits deployment land in `loaded` while the others surface in `pending`/`refused`, and the host re-adopts the same pack after resolving them. `trusted_signers` is a **count**, not the key ids — enough to tell an operator "your keyring is empty, that is why a signed pack stopped at Verified" without echoing configured identifiers over the wire. FFI: `adoptSkillPack` (NAPI) / `adopt_skill_pack` (PyO3).

### skills

#### `skills.distill`
- **Params**: `{ events: TraceEvent[] }`
- **Returns**: `DistilledSkill[]` — extracted from execution traces via inference

#### `skills.list`
- **Params**: `{ domain?: string }`
- **Returns**: `SkillMeta[]`

### state

All `state.*` methods accept an optional `tenant_id: string` sibling field (Parslee-ai/car#187 phase 3-E). When set and non-empty, the operation routes through `StateStore::scoped(tenant_id)` so distinct tenants can't see each other's keys over the WS surface. When omitted or empty, the legacy unscoped namespace applies — same strict-isolation contract as `Runtime::execute_scoped`: scoped tenants don't see unscoped keys, and unscoped callers don't see scoped keys (`state.keys` / `state.snapshot` filter accordingly).

#### `state.get`
- **Params**: `{ key: string, tenant_id?: string }`
- **Returns**: value at key, or `null`

#### `state.set`
- **Params**: `{ key: string, value?: any, tenant_id?: string }`
- **Returns**: `"ok"`

#### `state.exists`
- **Params**: `{ key: string, tenant_id?: string }`
- **Returns**: boolean. Cheaper than `state.get` + null-check when the value is large.

#### `state.keys`
- **Params**: `{ tenant_id?: string }`
- **Returns**: array of strings. When `tenant_id` is set, returns only that tenant's keys with the `tenant:<id>:` prefix stripped. When omitted, returns only unscoped keys (entries beginning with `tenant:` are filtered out).

#### `state.snapshot`
- **Params**: `{ tenant_id?: string }`
- **Returns**: object `{ key: value, ... }`. Same filtering as `state.keys`: scoped to one tenant when `tenant_id` set, unscoped-only otherwise.

### inference (additional)

#### `rerank`
- **Params**: full `RerankRequest` JSON: `{ query, documents: [...], model?, top_n?, instruction? }`
- **Returns**: `{ ranked: [{index, score, document}, ...], model_used }`
- Rerank candidate documents against a query using a cross-encoder.

#### `transcribe`
- **Params**: full `TranscribeRequest` JSON: `{ audio_path?, audio_b64?, model?, language?, prompt?, timestamps? }`
- **Returns**: transcription result JSON
- **Sandbox-crossing escape hatch** (closes [Parslee-ai/car-releases#31](https://github.com/Parslee-ai/car-releases/issues/31)): pass `audio_b64` (standard base64 of the audio bytes) instead of `audio_path` when the caller can't share a filesystem view with the daemon — typical for an unsandboxed WS client talking to a sandboxed daemon. The server decodes to a tempfile (auto-cleaned on response), then runs transcribe normally. `audio_b64` wins if both are set.
- **Filesystem caveat** (when using `audio_path`): the path is interpreted on the daemon's filesystem, not the caller's.

#### `synthesize`
- **Params**: full `SynthesizeRequest` JSON. Optional WS-only field: `return_b64: bool` (default false).
- **Returns**: synthesis result JSON `{ audio_path, media_type, ..., audio_b64? }`. The `audio_b64` field is included when `return_b64: true` is set OR when `output_path` was omitted (typical sandbox-crossing case where the caller has no shared path to pick).
- Same filesystem caveat as `transcribe` for `output_path` and `reference_audio_path` when supplied.
- Closes [Parslee-ai/car-releases#31](https://github.com/Parslee-ai/car-releases/issues/31) on the synthesize side.

#### `search`
- **Params**: `{ query: string, max_results?: number }` (`max_results` clamped to 1–20, default 5).
- **Returns**: `{ query, source, results: [{ title, url, snippet, score, published_date? }] }`, where `source` is `"parslee"`, `"tavily"`, or `"duckduckgo"`.
- **Backend resolution** (daemon-side, from its environment): a signed-in Parslee session (`PARSLEE_ACCESS_TOKEN`) → Parslee's hosted search (`/api/v1/orgs/{org}/search`); else `TAVILY_API_KEY` (env or keychain) → Tavily direct; else the keyless DuckDuckGo fallback (zero-config, lower quality). No params control the backend — it's environment-resolved.
- Results cached ~60s; rate-limited 10/min (per the `search` ToolSchema).

#### `web_fetch`
- **Params**: `{ url: string }`.
- **Returns**: `{ url, status, content_type, title?, text }` — `url` is the final URL after redirects; `text` is extracted readable text (HTML reduced to title + visible text, scripts/styles dropped; non-HTML returned verbatim).
- Keyless (plain HTTP GET). Cached ~300s; rate-limited 20/min. Companion to `search`.

#### `speech.prepare`
- **Params**: `null`
- **Returns**: managed speech runtime root path as JSON string — the same root
  `speech.health` / `car speech doctor` report, on every platform.
- Provisions the managed `mlx-audio` runtime (a `uv` venv + pip install, so the
  first call on a fresh machine can take minutes). Idempotent: a no-op once the
  runtime is ready.
- The returned path is **not** a success signal. On Apple Silicon the managed
  runtime is a fallback behind the native MLX backends, so a bootstrap that
  can't run (no `uv`, no usable Python) is logged and the root is still
  returned; everywhere else it is the only local speech path and the call
  errors. Read `speech.health.runtime.installed` for the real state
  (Parslee-ai/car#649).

#### `models.route`
- **Params**: `{ prompt: string, intent?: IntentHint }`. `intent` is an
  optional routing hint; notably `exclude_models: string[]` ("any capable
  model that is NOT one of these") for adversarial-reviewer separation so a
  model never grades its own work (car#358). Each entry may be a catalog
  `model_id` **or** a `model_name` — the two differ for most models, and
  `model_name` is what a result reports as the model it used, so the identifier
  you have in hand always works (car#889). Exclusion is soft — if it leaves
  no candidate it is dropped rather than failing. Absent `intent` routes
  exactly as before.
- **Returns**: route decision JSON for the adaptive router —
  `{ model_id, model_name, task, complexity, reason, strategy,
  predicted_quality, fallbacks: string[], context_length, needs_compaction,
  candidates: RouteCandidate[] }`. `fallbacks` is the ordered retry chain
  (in-band models first under outcome-first routing). `candidates` is the
  advisory ranking: every scored model the router considered, each
  `{ model_id, reliability, score, selected, in_band }` — `reliability` is the
  cost-free outcome-derived band key, `score` is the full blended score
  (reliability plus cost/latency/context tie-breakers), `selected` flags the
  chosen model, `in_band` marks models inside the outcome-first reliability band
  (the eligible set). Lets a UI/operator see *why* a model won and what the
  alternatives cost in reliability terms. Empty on explicit-model and
  cold-start/error paths where no ranking occurred. The FFI `route_model()`
  (NAPI/PyO3) returns this same JSON as a string and takes an optional
  `intentJson` / `intent_json` carrying the same `IntentHint`.

#### `models.stats`
- **Params**: `null`
- **Returns**: `{ profiles: ModelStat[] }` where each `ModelStat` is
  `{ model_id, total_calls, success_count, fail_count, success_rate,
  avg_latency_ms, ema_quality }`. `success_rate` is `number | null` — `null`
  until something resolves (never a fabricated 0.5 prior). The FFI
  `model_stats()` (NAPI/PyO3) returns this same JSON as a string.

### outcomes

#### `outcomes.scoreboard`
- **Params**: `null`
- **Returns**: the persistent, OUTCOME-DENOMINATED scoreboard folded from the durable outcome ledger (`models_dir/outcome_ledger.jsonl`):
  `{ rows: ScoreboardRow[], total_successes, total_failures, total_inconclusive, total_usd: number | null, total_usd_is_estimate: boolean, overall_usd_per_success: number | null, model_count, receipts }`, where each `ScoreboardRow` is `{ model_id, success_count, fail_count, inconclusive_count, total_input_tokens, total_output_tokens, avg_quality: number | null, avg_latency_ms, success_rate: number | null, tokens_per_success: number | null, usd_per_success: number | null, usd_is_estimate: boolean }`.
- `usd_per_success` (priced spend ÷ successes) is the headline per-model metric — the dollars-per-correct-outcome the "cry once" thesis is legible in; `overall_usd_per_success` is the deployment-wide figure. Values are `null` rather than fabricated: `usd_per_success`/`total_usd` are `null` for unpriced models, `success_rate`/`tokens_per_success` are `null` until something resolves, and `inconclusive_count` (completed-but-unscored receipts) is surfaced so the denominator's coverage is legible. `usd_is_estimate` and `total_usd_is_estimate` are true for prompt-tiered models whose already-aggregated ledger totals can only be priced at the catalog base tier; consumers must label those values as estimates. Rows are sorted cheapest-correct-outcome first.
- Distinct from `models.stats`: that is the **live in-memory** profiles; this reads the **cross-session ledger** (survives restart, de-biased by the pending-sweep) and joins per-model catalog prices. The FFI `outcome_scoreboard()` (NAPI/PyO3) returns this same JSON as a string.

#### `outcomes.resolve_pending`
- **Params**: `{ actionResults: [[traceId, success, confidence, output], ...] }` — flat tuples produced by a `car-reason` session's `ActionOutcome` vector. `traceId` is a string (`""` is treated as "no trace, skip"); `success` is a boolean; `confidence` is a float `[0.0, 1.0]`; `output` is the generated text.
- **Returns**: `{ recorded: number }` — the count of action results the caller passed (NOT the number of pending traces actually resolved — the tracker doesn't surface that yet).
- Symmetric to the in-process `ReasoningInferenceHandle::record_inferred_outcomes` impl. The daemon runs `OutcomeTracker::infer_outcomes_from_action_sequence` to convert the tuples into resolved outcomes, then writes them back under the tracker's write lock. Lets the routing-learning loop survive daemon-routed reasoning sessions instead of silently no-op'ing.
- Closes the follow-up flagged in Parslee-ai/car#189. Older daemons without this method respond with JSON-RPC `-32601`; the CLI's `DaemonInferenceHandle::record_inferred_outcomes` catches that specific code and falls back to its pre-existing soft no-op so a CLI / daemon version skew during a rolling upgrade doesn't crash reasoning sessions.

### memory (additional)

#### `memory.consolidate`
- **Params**: `null`
- **Returns**: `ConsolidationReport` JSON — operates on this client's per-session memgine.

#### `memory.fact_count`
- **Params**: `null`
- **Returns**: `number` — `valid_fact_count()` of the session's memgine. Mirrors the FFI `fact_count` accessor.

#### `memory.utility_get`
- **Params**: `null`
- **Returns**: `{ utility_weight, utility_exploration }` — the live engine's
  utility-aware retrieval blend (U-Mem, arXiv 2602.22406). Reads the same engine
  `memory.build_context` retrieves from.

#### `memory.utility_set`
- **Params**: `{ utility_weight?: number, utility_exploration?: number }`
- **Returns**: the applied (post-clamp) `{ utility_weight, utility_exploration }`
- Runtime override of utility-aware fact retrieval on the live engine.
  `utility_weight` 0 = pure relevance (ordering unchanged); when `> 0`, fact
  scoring blends each fact's learned utility posterior (an upper-confidence
  bound) on top of semantic relevance. `utility_exploration` scales the UCB
  uncertainty term (surfaces untried facts more aggressively; only consulted
  when weight `> 0`). `utility_weight` is clamped to `[0,1]`,
  `utility_exploration` to `[0,4]`; non-finite inputs become 0.
- **Read-modify-write**: an omitted field keeps the engine's current value (it
  does NOT reset to 0), so you can tune one knob without clearing the other.
- **Scope**: in the standalone daemon the engine is **global** (one
  `shared_memgine` across all WS sessions + MCP), so this shifts retrieval
  ranking for every client — last-writer-wins — and does **not** persist across
  daemon restarts. For persistent, team-shareable tuning, set
  `utility_weight` / `utility_exploration` in `.car/config.toml` instead (the
  daemon seeds its shared and per-agent engines from those at boot). Takes effect
  on the next `memory.build_context`. Mirrors the FFI `setUtilityRetrieval` /
  `set_utility_retrieval` accessor.

### cascade

#### `cascade.run`
- **Params**: `{ current_confidence: number, policy: CascadePolicy, observed:
  { <tier>: { confidence: number, knowledge?: string } }, claim?: string,
  dry_run?: boolean }` where `CascadePolicy` is `{ confidence_target, budget,
  tiers: [{ tier, cost, expected_confidence }] }` and `<tier>` is `self_reflect`
  | `tool_verify` | `human_expert`.
- **Returns**: `{ run: CascadeRun, pending_approval?: { fingerprint, claim } }`
- U-Mem Slice 5 live evolve loop (arXiv 2602.22406). Runs the cost-aware
  knowledge cascade for real (`car_memgine::cascade::run_cascade_async`),
  escalating cheapest-first on **observed** confidence: it walks `policy.tiers`
  within `budget`, runs each reached tier's mechanic, and stops once an observed
  confidence meets `confidence_target`. Per the **caller-injected-confidence**
  design, the daemon runs the mechanics + walk while the observed confidence for
  `self_reflect` / `tool_verify` is caller-supplied in `observed`. Mechanics:
  - `self_reflect` → `engine.reflect()` on the session memgine (a real side
    effect — ingests reflection insights; skipped when `dry_run` is `true`).
  - `tool_verify` → pass-through: CAR has no built-in verify tool, so its
    confidence/`knowledge` are **caller-attested** (the daemon does not verify).
  - `human_expert` → the daemon's **shared durable** `ApprovalLedger` (same
    HITL substrate as `permission.*` — cross-connection, restart-surviving)
    keyed `cascade:<claim>` is the **authority**, NOT the caller's
    number: a prior **approved** decision lets the tier contribute the caller's
    confidence; a **rejected** decision aborts the cascade (JSON-RPC error); an
    **undecided** claim forces the tier's confidence to `0.0` (it can never be
    accepted without a real approval) and surfaces `pending_approval` so the host
    approves it via `permission.approve` / `permission.reject` by that
    fingerprint. A `human_expert` tier requires a non-empty `claim`.
- Mirrors the FFI `cascadeRun` / `cascade_run` accessor.

#### `evolution.plan`
- **Params**: `{ policy?: { pressure_threshold?: number, budget?: number } }`
- **Returns**: `EvolutionPlan` `{ decisions: [{ component, action: "evolve_now" | "defer" | "skip", priority, defer_reason?, reason }], spent, evolve_now: [..] }`
- Self-evolution governor live host surface (arXiv 2507.21046, Slice 3 + the daemon populaters; `docs/proposals/self-evolution-governor.md`). **All five components are populated live**, each from its real signal source:
  - `memory` — from the session memgine: pressure = `(outstanding_outdated + facts_superseded) / total_facts` (the backlog `consolidate()` would clear); evidence = total facts.
  - `skills` — from the session memgine: pressure = degraded/broken skills over total; evidence = summed recorded skill outcomes.
  - `context` — from the session memgine: pressure = conversation-layer token saturation (summed layer-3 conversation-token estimate over the layer-3 budget, clamped `[0,1]` — the same signal the eager-compaction trigger fires on); evidence = conversation turns held.
  - `harness` — from the session event log via `harness_adapt::diagnose`: pressure = `min(1, implicated / total_events)` where `implicated` sums each *recurring* intervention's `evidence_count` (one-off failures are noise by the diagnosis's own rule); evidence = the number of events diagnosed over.
  - `tools` — from live connector health (`connectors.list`): pressure = disconnected connectors / total; evidence = connector count (connectors carry no per-connector call counters, so population size is the honest evidence figure).
  A component with no observable source (empty store/log, no connectors configured) is **omitted**, not fabricated at zero. **Read-only**: it plans; `evolution.run` dispatches. Live counterpart to the stateless `plan_evolution` FFI helper. FFI: `planEvolutionLive` (NAPI) / `plan_evolution_live` (PyO3).

#### `evolution.run`
- **Params**: `{ policy?: { pressure_threshold?: number, budget?: number }, dry_run?: boolean, harness_baseline_metrics?: HarnessMetrics, harness_candidate_metrics?: HarnessMetrics, harness_measure?: { model: string, split?: "held-out"|"held-in"|"all", held_in_fraction?: number, split_seed?: number, max_turns?: number, tasks_dir?: string }, context_measure?: { model: string, split?: "held-out"|"held-in"|"all", held_in_fraction?: number, split_seed?: number, max_turns?: number, tasks_dir?: string } }`
  - `harness_measure` and `context_measure` are the **same request shape** because they are the same replay over the same suite, the same deterministic split, the same seed and the same turn cap — only the config being varied differs (`HarnessConfig` for one, `MemgineConfig` for the other). Two shapes would let the two splits drift apart, at which point a context grade and a harness grade stop being comparable with each other or with a `car-bench-harness` CLI run.
  - They are **not mutually exclusive with each other** — they grade different pillars, and asking for both is asking for two independent measurements, not two answers to the same question (it costs the extra replays; that is the caller's explicit choice). `harness_measure` remains mutually exclusive with `harness_baseline_metrics` / `harness_candidate_metrics`.
- **Returns**: `{ plan: EvolutionPlan, steps: [{ component, ran, applied, out_of_scope, outcome }], evolved: [..], out_of_scope: [..], pending_approvals?: [{ fingerprint, mutation, component, safety_affecting, rationale, reason }], measurement?: { status: "measured"|"skipped_dry_run"|"measurement_failed", split, model, split_seed, baseline_metrics?, error? } }`
- The governor's **real executor** (arXiv 2507.21046 — the "remaining daemon step" of `docs/proposals/self-evolution-governor.md`). Plans exactly like `evolution.plan` (all five components live, over the session's *effective* engine — the daemon-owned per-agent memgine for `session.auth { agent_id }`-bound connections), then dispatches each `EvolveNow` component in priority order via `run_evolution_cycle`. At most one `evolution.run` executes per session at a time — a concurrent second call errs instead of overlapping (the dispatcher spawns requests concurrently even on one connection).
  - `memory` → `engine.consolidate()`, **sized by** `maintenance::decide_maintenance` off the live `memory_stats` (dirty regions = the outstanding + superseded backlog, global structural gain = the supersede-churn share valued at store size); the localized-vs-global choice is recorded in the step outcome — `consolidate()` is the single live mechanism for both today.
  - `skills` → `engine.evolve_skills(failed_events, domain)` for every domain `domains_needing_evolution` flags (success < 0.6 over ≥3 outcomes), with `failed_events` folded from the session event log's failure records (`ActionFailed`/`ActionRejected`/`PolicyViolation`/`ReplanExhausted` → `TraceEvent`s; the log carries per-action failures, **not** state-before/after trajectories — those fields are honest `None`s, never fabricated). A session engine without a model records `ran: false, outcome: "no inference engine"` — not a stub.
  - `harness` → the `harness_evolution` diagnose→gate→apply loop, **HITL-gated on the daemon's shared durable `ApprovalLedger`** (`~/.car/approvals.jsonl` — the same store `permission.*` writes; approve on a host connection, apply on the agent connection, and the decision survives restart). Fingerprint: `harness:<component>:<patch-digest>` — bound to the **patch content** (the concrete config change a human authorizes), not the diagnostic rationale (which embeds live measurements and would mint a fresh identity every re-run). A previously **approved** fingerprint applies its config patch to the session runtime's live `HarnessConfig` under one atomic read-modify-write (`Governance::HumanApproved`, rollback patch returned); **rejected** → blocked. The regression gate needs *measured post-mutation* metrics, which the live session log cannot produce — so auto-promotion runs **only** when such metrics exist, by one of two routes: the caller supplies `harness_candidate_metrics` from its own held-out replay (this bullet), or `harness_measure` (next bullet) has the daemon replay the split in process and measure them itself (baseline defaults to the live session metrics, overridable via `harness_baseline_metrics`; a supplied baseline also **replaces the Harness planning signal** — failed/total attempts — so the declared telemetry both elects and diagnoses the component): a gate-passed non-safety mutation then auto-applies (`Governance::Promoted`); safety-affecting mutations **always** route to HITL. Without candidate metrics from either route, every activation is a pending approval — the gate's input is never fabricated. The replay that produces those metrics ships as `car-bench-harness` (`car-rs/crates/car-bench/README.md`): it runs the checked-in task suite through the real assistant loop on a deterministic held-out split and writes `--metrics-out` as **exactly** a serialized `HarnessMetrics`, so the file goes into these two params verbatim. Its `HarnessMetrics` carries one field `harness.metrics`/`harnessMetrics` cannot produce — the optional `task_pass_rate`, end-**task** success — because an event log records what ran, not whether the task was satisfied. The gate guards it *and* `trajectory_efficiency.success_rate` (tool-**attempt** success), which are different quantities: a candidate that cuts tokens by abandoning hard tasks earlier holds a perfect attempt rate while solving fewer tasks. `task_pass_rate` absent on either side means *not measured* — that guard then does not fire at all, rather than reading absent as 0.0 or 1.0. Ahead of both guards the two rates must be over the **same task set**: the document also carries `task_pass_denominator` (how many tasks the rate is over) and `tasks_unrunnable` (how many the runner could not measure), and when both sides report a denominator and the two disagree the result is a fourth decision, **`incomparable`** — no verdict, nothing applied, `"status": "incomparable"` in the per-mutation result. A pass rate over a smaller task set is not an improvement over a larger one, and a harness that loses a capability also loses the ability to *measure* the tasks needing it — those tasks leave the denominator and the surviving rate rises, which without this check reads as a win. Both fields are optional: a document written before they existed carries neither, and the comparability check is then skipped rather than failing. **Arming the task-level guard takes both params.** The default baseline is the live session's own metrics folded from its event log, which never carries `task_pass_rate`; supplying only `harness_candidate_metrics` therefore gets you the attempt-level guard and not the task-level one. Pass a measured `harness_baseline_metrics` (a `car-bench-harness` run of the pre-mutation harness) as well.
  - **`harness_measure` — the daemon measures the candidate ITSELF.** Present = opt in. The daemon replays the deterministic task split in process through the real assistant loop: once for the **baseline**, under the session runtime's live `HarnessConfig` (absent = the runtime default), and then once per measurable mutation under that same config with the mutation's patch applied. The folded `HarnessMetrics` go straight into `EvolutionAgent::evaluate`, so a cycle can promote or reject unattended — no operator running `car-bench-harness` twice and handing both files back in. Defaults: `split: "held-out"`, `held_in_fraction: 0.5`, `split_seed: 0`, `max_turns: 20`, `tasks_dir` = the task suite built into the binary. Those are `HarnessBenchConfig::default()`'s values exactly, so an in-daemon measurement and a `car-bench-harness` CLI run are the *same* measurement over the *same* split; `model` is required, and the replay always runs `strict_model`, because a token count attributed to the wrong model is worse than none. The measured baseline also **replaces the Harness planning signal** exactly as a supplied `harness_baseline_metrics` does — the telemetry that elects the component is the telemetry that diagnoses it.
    The honesty rules, each of which is a refusal rather than a fallback:
    - **Mutually exclusive with `harness_baseline_metrics` / `harness_candidate_metrics`.** Sending both is an ERROR naming both params. Measuring and handing metrics in are two answers to the same question, and silently preferring one would let a caller believe the daemon graded a replay it never ran.
    - **`dry_run` measures nothing.** A benchmark replay is a paid side effect and `dry_run` performs none. The response reports `measurement: { "status": "skipped_dry_run" }` and every mutation routes to the usual `pending_approval` path with a reason naming `dry_run`; nothing is applied.
    - **No evaluator installed → error.** `car-server` installs `car-bench`'s in-process evaluator at startup; an embedder that has not called `ServerState::set_harness_measurer` gets an explicit error rather than a quiet degrade to HITL, because an opt-in that silently does nothing would report an unattended cycle that never measured anything.
    - **Safety-affecting mutations are never measured or auto-applied.** They can never auto-promote, so replaying one would spend real model calls to reach an outcome already decided; they route to HITL with a reason saying measurement was skipped. Mutations with **no patch** are likewise not measured — there is nothing to apply.
    - **A failed measurement fabricates nothing.** A candidate replay that errors is reported as `"status": "measurement_failed"` with the error, nothing is applied, no document is synthesized, and the cycle continues to the next mutation. A failed **baseline** replay fails the harness step with that error, applies nothing, and reports top-level `measurement: { "status": "measurement_failed", "error": ... }` — see the next bullet for why that top-level copy is the load-bearing one.
    - **Auditable — `measurement` is a TOP-LEVEL key on the response.** It is present whenever `harness_measure` was requested, in whichever shape the measurement ended in: `{ status: "measured", split, model, split_seed, baseline_metrics }`, `{ status: "skipped_dry_run", ... }`, or `{ status: "measurement_failed", error, ... }`. The harness step summary carries the same object when that component is elected, and every measured mutation's detail carries its full `candidate_metrics`. A promotion nobody can re-derive is not an audited promotion.

      The top level is where it has to live, not the step. The baseline replay is spent *before* the plan is assembled — it supplies the Harness planning signal — but the plan can legitimately never dispatch Harness: a harness with zero logged attempts elects no component at all, and an elected one can still `skip` (pressure below `pressure_threshold`) or `defer` (evidence below `min_evidence`). Reported only from the step, a caller who asked for `harness_measure` on a healthy harness would be billed for a full held-out replay and get a response that never mentions it, and a baseline replay that FAILED would vanish the same way — a normal-looking successful cycle with no hint that the measurement never happened. A paid side effect nobody can see in the response is one nobody can audit.
  - `context` → `car_memgine::context_evolution`, the pillar's **real mechanism** — diagnose → approve → apply → measure → revert. Diagnosis reads the engine's own live conversation-layer saturation (the summed token estimate of the layer-3 `Conversation` + `ConversationSummary` nodes over the layer-3 assembly budget) and fires only once saturation reaches `thresholds.hard` — the point at which the engine already compacts eagerly, so this is not a new opinion about when the layer is full, it is the engine's own. The one knob it turns is `MemgineConfig::conversation_keep_recent`, halved and floored at `MIN_KEEP_RECENT` (2 — the last exchange, the smallest amount that keeps a reply grounded in what was just said), which hands more of the older turns to compaction's summarizer. Deliberately **not** `token_budget` or the layer budgets: relieving "the conversation layer is full" by widening the conversation layer is the Governance-Decay failure — it never converges, always reports success, and spends the growth on tokens the caller pays for.
    Every mutation carries the same `ChangeContract` a harness mutation carries and is **HITL-gated on the same shared durable `ApprovalLedger`** (`~/.car/approvals.jsonl`), resolved by the same `permission.approve` / `permission.reject` calls from any connection. Fingerprint: **`context:<component>:<patch-digest>`** — a separate namespace from `harness:…` so an approval granted for one loop can never authorize the other (the two apply to different config objects under different governance), with the component slug kept as its own axis; today the only context component is `ContextBudget`, whose slug is also `context`, so a live fingerprint reads `context:context:<digest>`. As with harness fingerprints the digest binds the **patch content**, not the rationale (which embeds live measurements and would mint a fresh identity every re-diagnosis), so one standing approval matches every later cycle that proposes the same change.
    **There IS a pre-activation regression gate now, and it is opt-in** — `context_measure`. This paragraph used to say the opposite, so it is worth being precise about what changed. What used to be true: `car-bench-harness` replayed a task runtime with no memgine attached and never offered the model a `recall` tool, so a bench run did not exercise context assembly and would have scored a context mutation identically however the knob was set; a gate over that replay would have been a check nobody reaches. What is true now: a bench task may declare a `memory:` fixture, and a task that does is replayed with a real memgine seeded from it and the shipped `recall` tool advertised, so the assembled context — and therefore the answer the task is graded on — genuinely moves with `conversation_keep_recent`.
    Given `context_measure`, a mutation nobody has decided on in the ledger is graded before it is activated: the daemon replays the deterministic split **twice** — once under the engine's live `MemgineConfig`, once under that config plus the mutation's patch (`MemgineConfig::with_context_patch_for_measurement`, an ungoverned projection clamped to `MIN_KEEP_RECENT`, because requiring governance to build a config you are about to grade would assert the verdict before measuring it) — and hands both documents to `EvolutionAgent::evaluate_context`. That is literally the same gate, with the same comparability refusal, the same task- and attempt-level regression guards and the same tolerances, that grades a harness mutation; one gate for both pillars, so neither can drift into promoting what the other would reject. Both replays run under the runtime's **default harness config**, so baseline and candidate differ by the context patch and nothing else.
    Outcomes: `Promote` → applied for real through `apply_context_patch`, reported as `applied` with `governance: "promoted"` and the `rollback_patch`, with **no operator in the loop and no ledger entry**. `Reject` → `rejected_by_gate` with the reason, nothing applied, and deliberately **no fall-through to the human gate**: it is a verdict, not an absence of one, and soliciting an operator's approval for a change the daemon just measured as a regression — onto a daemon-wide ledger keyed on the *change*, where it would then stand for every engine forever — is how a measured system gets talked out of its own measurement (an operator who disagrees can still approve the fingerprint directly via `permission.approve`; what must not happen is the daemon asking). `NeedsApproval` / `Incomparable` → `pending_approval` carrying **the gate's own reason**, so an operator reads why the measurement did not decide. A replay that errors → `measurement_failed` with the error, nothing applied, nothing synthesized, and the mutation is **not** entered into the backoff — the measurement failed, not the change, and backing it off would delay the retry that would have graded it honestly. A `Promote` whose measured base MOVED while the replays ran → `config_moved_during_measurement`, and nothing applied: the engine lock is dropped across the replays (holding it for minutes of model calls would stall every ingest, recall and consolidate on the daemon), so under the same lock hold that would apply the patch the arm re-reads the live config and compares the fields a `ContextConfigPatch` can reach against what the baseline ran under. If another `evolution.run` over the same engine, the human-approved path or a cadence tick moved `conversation_keep_recent` in between, the verdict was computed against a base that no longer exists and the inverse patch handed back for rollback would name the CURRENT value rather than the measured one — so the arm refuses rather than degrades, reports `measured_under_conversation_keep_recent` and `current_conversation_keep_recent`, and records **no** backoff (the measurement was invalidated, not the change; a later cycle re-diagnoses and re-measures against the new base). Every graded outcome additionally carries `baseline_task_pass_rate`, `baseline_task_pass_denominator`, `baseline_total_tokens` and their `candidate_*` twins: a verdict nobody can re-derive is not an audited verdict.
    The honest limits: the grade is **paid** (each mutation costs two full benchmark replays) and therefore opt-in; **`dry_run` performs none** and every mutation routes to the human gate with a reason naming `dry_run`; **the unattended cadence never requests one**, on purpose, because a timer must not start spending model calls because someone set `evolution_interval_secs`; a **patchless** mutation has nothing to project into a candidate config and so nothing to grade; requesting `context_measure` on a build with **no evaluator installed is an error**, not a quiet degrade; and a bench task with no `memory:` fixture is insensitive to this config, so the grade is only as strong as the suite's memory coverage. Whenever `context_measure` was requested the context step's summary carries `context_measured: { status: "measured"|"skipped_dry_run", grade_attempts, model, split, split_seed }` — absent means "no measurement was needed", `grade_attempts: 0` means "one was requested and nothing reached the gate". It counts mutations that ENTERED the grading path, so one whose replay then errored still counts.
    Everything the grade did not decide falls back to the human gate below, whose reason now names the precondition that was missing. That path keeps its **post-apply** measurement of the **margin**, unchanged, as defence in depth: run heuristic compaction under the *unchanged* `conversation_keep_recent` and record the conversation-layer token total (`conversation_tokens_baseline`), then apply the patch, compact again, and compare. Measuring from the uncompacted layer instead would credit the mutation with every token compaction was going to save anyway — and on this path (an operator approved the change without asking for a grade) it is the only automatic check standing between an approved self-modification and a promotion. It is a weaker claim than the pre-activation grade above, and remains defence in depth rather than a substitute: it can prove a change did not achieve the token saving it predicted, never that the summarized context still answers the question. The reason field says which of two things a zero margin means, because only one of them is permanent: the second compaction pass ran and saved nothing, or it never ran at all because the baseline pass had already cut the verbatim turns below the engine's own hard threshold (`turns_summarized: 0` — "no saving available right now", a state the baseline pass itself creates and a later cycle clears). Worth knowing that compaction's internal gate counts verbatim turns while the diagnosis counts summaries too, so a layer whose saturation is carried by summaries diagnoses forever and this knob can never relieve it; that case measures zero every time and is what the backoff bounds. Measuring emits the compaction telemetry a real compaction emits, because it is one. If the margin is not positive the inverse patch goes back on — all under ONE lock acquisition on the engine, so another task's ingest cannot be credited or blamed. A reverted mutation reports `rolled_back`, counts as nothing applied, and keeps `context` out of `evolved`; a revert that itself fails reports `rollback_failed` (with `rollback_error`) and is logged at error level, because calling a still-mutated config "rolled back" would tell an operator nothing changed. Note what a rollback restores: the knob, not the graph — the summarization performed while measuring stays, which is what the engine's own heuristic does at this saturation anyway. Consequence worth stating plainly: **context is not unattended out of the box**; it becomes unattended for a given change only after that change's fingerprint has been approved once. And because the approval ledger is daemon-wide while the fingerprint names the *change*, not the engine, approving it authorizes that same `conversation_keep_recent` change on every engine this daemon evolves — the shared one the cadence runs over and every per-agent engine an `evolution.run` names. The pending entry says so.
    The step's `outcome` is a JSON string `{ mechanism: "context_evolution", mutations, applied, pending, details }`. Each entry in `details` carries `mutation`, `component`, `fingerprint`, `rationale` plus a status: `pending_approval` (no ledger decision and no grade decided it — also pushed to `pending_approvals` in the same object shape harness mutations use; the reason names the missing precondition, or the gate's own verdict when a measurement ran and returned `NeedsApproval`/`Incomparable`), `rejected_by_gate` (the pre-activation grade measured a regression — nothing applied, and NOT offered for approval), `measurement_failed` (a replay errored — with `error`, nothing applied, no backoff recorded), `config_moved_during_measurement` (the grade was favourable but the live config moved under it between the baseline replay and the apply — carries `measured_under_conversation_keep_recent` and `current_conversation_keep_recent`, applies nothing, and records no backoff), `applied`, `rolled_back`, `rollback_failed` (falsified, and the revert failed too — carries `rollback_error`), `apply_failed` (with `error` and `baseline_turns_summarized`; also records a backoff, since an apply that refuses will refuse again and reaching it costs a full compaction pass), `would_apply` (approved, but `dry_run`), `in_backoff` (approved, but falsified — or refused at apply — on an earlier unattended tick, and waiting out its exponential window; read before `dry_run`, since what the next real cycle would do with a backed-off fingerprint is wait), `rejected_by_operator`, or `approved_no_patch` (approved but carrying no concrete patch — a human designs that change). `applied`, `rolled_back` and `rollback_failed` additionally carry `conversation_tokens_baseline` (the layer's tokens after compacting *without* the change), `conversation_tokens_after`, `baseline_turns_summarized` and `turns_summarized` — those four are the *human-approved* path's post-apply margin, so an `applied` entry with `governance: "promoted"` (the graded path) carries the six `*_task_pass_rate` / `*_task_pass_denominator` / `*_total_tokens` audit fields instead. `applied` and `rollback_failed` carry the `rollback_patch`. With no observable signal at all, or nothing diagnosed, the step is an honest `applied: false` no-op naming which.
  - `tools` → recorded as **`out_of_scope`**, not as a failure. Connector remediation means re-running a connector's OAuth or credential exchange; that is an access change, and this loop deliberately holds no authority to grant, refresh or move credentials — reconnect and re-auth stay operator actions through the `connectors.*` surface. Such a step is `ran: true, applied: false, out_of_scope: true` with the reason in `outcome`, and the component is listed in the response's top-level `out_of_scope` array. This replaced an `Err("not_executable: …")`, which the cycle records as `ran: false` — the same shape a crashed mechanism produces, so a boundary the project chose on purpose read as a failing subsystem in every report. `ran: false` now means one thing only: the mechanism was invoked and errored.
  `out_of_scope` is a **top-level array of component names** on the response, always present (empty when none) so a caller can tell "no boundary was hit" from "this daemon predates the field"; the matching `steps` entries carry `out_of_scope: true` and the reason. `EvolutionStep`, `EvolutionCycleReport` and `EvolutionOutcome` all take the field under `#[serde(default)]`, because the cadence journal is append-only and cycle records written before it existed must keep parsing.
  `evolved` lists only components that **applied a change** — a step that completed without changing anything (nothing to evolve, every mutation still pending approval, a dry run) appears in `steps` with `applied: false` but not in `evolved`; the `EvolutionTriggered` audit event carries the same semantics. `dry_run: true` skips every side effect (no consolidate, no evolve, no config apply, no event append) and reports what would run — **including** `pending_approvals` (listing what needs approval is response data, not a side effect). A real run appends one `EvolutionTriggered` event (`data.source = "evolution.run"`) to the session event log and, on a bound-agent session, persists the per-agent memgine after a cycle that applied something. FFI: `runEvolutionCycleLive` (NAPI) / `run_evolution_cycle_live` (PyO3).
- **Autonomous cadence (opt-in)**: setting `evolution_interval_secs = N` (N > 0) in `.car/config.toml` makes the daemon spawn ONE background task over its **shared** engine that every N seconds runs the same plan+dispatch unattended (`dry_run = false`), appending each cycle's outcome as an `EvolutionTriggered` event (`data.source = "cadence"`) to `<journal_dir>/evolution.jsonl` — capped at 1000 in-memory events, and **no-op cycles (nothing planned, nothing run) are not appended**, so an idle daemon doesn't mint an audit line per tick. Absent or `0` = off (the no-surprise default). Ticks never overlap (a tick landing while the previous cycle still runs is skipped), and the task shuts down with the daemon. The unattended Skills arm is **per-domain exponentially backed off** (an attempted domain waits `2^attempts` ticks, capped at 64, resetting only when the domain is observed recovered) so unattended inference spend never repeats the same failing domain every tick. The unattended **Context** arm is the real `context_evolution` mechanism, not a stub: the cadence holds both the shared engine and the shared durable `ApprovalLedger`, which is everything that arm needs. Its pending approvals are collected locally and reported in the step summary as a count rather than an array — an unattended cycle has no response to hang `pending_approvals` off, and the durable ledger is where an operator resolves them by fingerprint via `permission.approve`; the daemon also logs a line naming the count when a tick surfaces any. The unattended arm deliberately requests **no pre-activation grade** — it passes no `context_measure`, because a grade costs two full benchmark replays per mutation and a timer must not start spending model calls because someone set `evolution_interval_secs`; an operator who wants an unattended-shaped cycle graded runs `evolution.run` with `context_measure`, where the spend is something they asked for. So on the cadence, context activation still always takes a human decision first: an unattended tick applies a context change only once that change's fingerprint has been approved — after which every later tick applies it, measures the conversation tokens it saved *over compacting without it*, and rolls it back if it saved none. A rolled-back mutation then enters a **per-fingerprint exponential backoff** (`2^attempts` ticks, capped at 64, cleared as soon as that change measurably pays), reported as `in_backoff`: the revert restores the knob, so the next tick would otherwise re-diagnose the identical change, re-match the same standing approval, and pay for another full compaction pass under the engine lock to reach the same verdict — forever. The approval itself is never touched by the backoff. A session-driven `evolution.run` has no backoff at all: a person asking for the check now gets it now. **Tools** is recorded as `out_of_scope` with its reason (connector re-auth is a credential operation this loop holds no authority to perform), which is a boundary, not a failing step. Daemon-scope boundaries, stated not papered over: harness telemetry and the HITL apply path are per-session, so the unattended cycle plans over Memory/Skills/Context/Tools only and Skills runs with an empty failure-trace set (the engine's own per-domain outcome stats elect domains); use `evolution.run` on a session for the full five-component cycle.

### sync

Multi-device sync (B6, `docs/proposals/multi-device-sync.md`). The daemon holds
**one `SyncSubsystem` per device** — a `car_sync::SyncSession` over an `FsRelay`
rooted at `~/.car/sync/relay/` (the single-user two-device case converges out of
the box) — lazily opened on first contact and shared across connections. All
methods are FFI-proxied (`syncStatus` etc. NAPI / `sync_status` etc. PyO3).

Domain wiring is an honest boundary: **Conversation** is wired end-to-end
(`sync.record_turn` → oplog → `sync.resume`), the **leased-intent** ledger is
wired (`sync.record_intent` + `sync.fence_check`), and `sync.append` is a generic
tee for any other surface. Auto-teeing the daemon's *internal* conversation /
knowledge write paths into the oplog is a documented follow-up. E2E payload
encryption ships as a tested `car_sync::crypto` library boundary (ChaCha20-Poly1305)
but is not yet applied to the live oplog stream (decrypt-before-fold + key
distribution are follow-ups).

#### `sync.status`
- **Params**: `{}`
- **Returns**: `{ device_id, state_hash, journal_frontier: { device: seq }, stable_frontier: Hlc | null, base_checkpoint: string | null, roster: RosterEntry[] }`
- The device roster, this device's journal frontier (per-device max seq), the relay's stable frontier, and the divergence-invariant fold `state_hash` two synced devices must agree on. FFI: `syncStatus` (NAPI) / `sync_status` (PyO3).

#### `sync.append`
- **Params**: `{ surface: "knowledge" | "skill" | "declagent" | "conversation" | "routing" | "trajectory" | "run" | "intent" | "registry:<kind>", payload: object, scope?: "personal" | { org: string } }`
- **Returns**: `{ op_id, seq, hlc }`
- Record an op on any surface — the generic domain tee for wiring knowledge/registry/routing state into the oplog. FFI: `syncAppend` / `sync_append`.
- `payload` is opaque to the daemon, but each surface has a shape its readers expect. For `"knowledge"` — the assistant's synced `remember` facts — that shape is `{ subject: string, body: string, kind: "fact" | "preference" | "procedure" }`. There is no explicit id: the op is **content-addressed by the whole payload**, so on the grow-only Knowledge tier an edit appends a new entity (both survive the fold) while an identical re-remember dedups. `kind` is part of that address, which matters on upgrade: a fact synced before `kind` existed and then re-remembered folds as a second entity rather than deduping. That is harmless because readers reduce newest-per-subject first (see `sync.knowledge`), so only the newer, kinded entity is ever seen. A payload with no `kind`, or one this device does not recognize, reads as `"fact"`.

#### `sync.assistant_checkpoint.put` / `sync.assistant_checkpoint.get`
- **Put params**: `{ checkpoint: AssistantCheckpoint }`; **returns** the oplog append receipt `{ op_id, seq, hlc }`.
- **Get params**: `{ session_id: string }`; **returns** the latest `AssistantCheckpoint | null`.
- A checkpoint contains the exact provider-facing `Message[]` (including multimodal input, tool calls/results, thinking signatures, and provider output items), repository root, monotone revision, goal/compaction state, and the stage-separated completion matrix. Put fails closed for an empty/mismatched session id or a non-increasing revision.
- FFI: `syncAssistantCheckpointPut` / `sync_assistant_checkpoint_put` and `syncAssistantCheckpointGet` / `sync_assistant_checkpoint_get`.

#### `sync.assistant_action.put` / `sync.assistant_action.get`
- **Put params**: `{ record: SupervisedActionRecord }`; **returns** the oplog append receipt `{ op_id, seq, hlc }`.
- **Get params**: `{ action_id: string }`; **returns** the latest `SupervisedActionRecord | null`.
- The record binds an exact canonical action digest to session, tool call, parameters, repository, target environment, and named credential capabilities. Its lifecycle is monotone: `proposed -> approved|denied`, `approved -> dispatched`, and `dispatched -> completed|failed|indeterminate`. Invalid transitions and scope mutation fail closed. A resumed `dispatched` action becomes `indeterminate` and is never automatically replayed.
- FFI: `syncAssistantActionPut` / `sync_assistant_action_put` and `syncAssistantActionGet` / `sync_assistant_action_get`.

#### `sync.knowledge`
- **Params**: `{ pump?: boolean }`
- **Returns**: `{ facts: object[] }` — the folded `Surface::Knowledge` payloads, **ascending by `(hlc, op_id)`**
- Read the synced knowledge facts, optionally pumping the oplog first so the read reflects peers with no interleave window (the daemon pumps under the same lock it reads under). Payloads are returned verbatim, unreduced: the ascending order is the contract, and callers converge a subject by taking the **last** entry for it, never the first. Daemon-only — `car do --serve` uses it for cross-device assistant memory; there is no FFI wrapper.

#### `sync.record_turn`
- **Params**: `{ conversation_id: string, role: "user" | "assistant" | "tool", content: string, tool_calls?: ToolCall[], tool_use_id?: string, timestamp?: number, scope? }`
- **Returns**: `{ op_id, seq, hlc }`
- Route a conversation turn **through the oplog** (a `Surface::Conversation` op) so `sync.resume` is a real, provider-valid transcript replay across devices. FFI: `syncRecordTurn` / `sync_record_turn`.
- **Validated** (fails fast rather than persist a malformed turn): `conversation_id` must be non-empty — it's the scoping key `sync.resume` folds on, so a blank one would pool unrelated conversations into one anonymous thread. A turn must also carry `content`, **unless** it's a tool turn identified by `tool_use_id` (or carries `tool_calls`), which may have empty content.

#### `sync.record_intent`
- **Params**: `{ agent_id: string, run_id: string, epoch: number, status: "pending" | "committed" | "failed", scope? }`
- **Returns**: `{ recorded: boolean, op_id?: string, reason?: string }`
- Write the leased-execution intent ledger (`Surface::Intent`), **terminal-guarded**: a `pending`/`failed` write for an already-committed run is a no-op. Populates the committed-run oracle `sync.fence_check` reads. FFI: `syncRecordIntent` / `sync_record_intent`.

#### `sync.pump`
- **Params**: `{}`
- **Returns**: `{ pushed, push_deduped, folded, acked: Hlc | null, state_hash }`
- One reconciliation round against the relay: push journal-durable own ops → pull → verify → fold → ack. Returns `FrontierTruncated` (as an error) when the relay has GC'd past this device's frontier — call `sync.rebase` and pump again. FFI: `syncPump` / `sync_pump`.

#### `sync.checkpoint`
- **Params**: `{}`
- **Returns**: `{ published: boolean, checkpoint_hash?: string }`
- Compute + upload a device-side checkpoint at the relay's stable frontier (the E2E-ready snapshot; the relay never folds). FFI: `syncCheckpoint` / `sync_checkpoint`.

#### `sync.rebase`
- **Params**: `{}`
- **Returns**: `{ rebased: boolean, base_checkpoint?: string }`
- Cold bootstrap / straggler re-entry: re-anchor on the relay's latest checkpoint, carrying uncovered local ops across. FFI: `syncRebase` / `sync_rebase`.

#### `sync.transcript`
- **Params**: `{ conversation_id?: string }`
- **Returns**: `Turn[]` `{ conversation_id, role, content, tool_calls?, tool_use_id?, provenance?, timestamp, hlc, op_id }`
- `provenance` is `"external"` on a tool turn whose bytes came from outside the trust boundary (a web page, an HTTP response, a remote MCP server); omitted otherwise, which means internal. Carried through the oplog so a resumed conversation does not silently re-trust fetched content (car#723).
- The ordered, role-threaded raw transcript projection of the conversation ops. FFI: `syncTranscript` / `sync_transcript`.

#### `sync.resume`
- **Params**: `{ conversation_id?: string }`
- **Returns**: `Message[]` (`user` / `assistant {content, tool_calls}` / `tool_result {tool_use_id, content, provenance?}`)
- `provenance` is `"external"` for retrieved content and omitted for internal results. Hosts that render or re-send these messages should preserve the field; CAR's own protocol handlers fence external content before it reaches a model.
- The **repaired, provider-valid** message sequence a host replays to continue the conversation — the verbatim resume path. FFI: `syncResume` / `sync_resume`.

#### `sync.fence_check`
- **Params**: `{ agent_id: string, run_id: string, epoch: number }`
- **Returns**: `{ decision: { decision: "proceed" | "already_committed" | "stale_epoch" | "not_held", .. }, may_dispatch: boolean }`
- The **executor dispatch fence** at the point of effect (B5's deferred exactly-once completion): the durable, fence-independent committed-run oracle read **first** (an already-committed run never re-executes, whatever the epoch), then the linearizable "am I still epoch N?" read (a stale-epoch zombie is refused). Only `may_dispatch == true` authorizes the external side effect. FFI: `syncFenceCheck` / `sync_fence_check`.

### lease

Per-agent execution lease (B6). A `car_sync::LeaseCoordinator` — a **linearizable
compare-and-swap register**, deliberately separate from the eventually-consistent
sync relay. The daemon reference is an in-process `InMemoryLeaseCoordinator`
(linearizable **within one daemon**); a cross-daemon distributed backend (Cosmos
`if_match` / single-writer daemon / Postgres advisory lock) is the documented B6
follow-up behind the same trait. The device is the holder.

#### `lease.acquire`
- **Params**: `{ agent_id: string, ttl_ms?: number }` (default TTL 30000)
- **Returns**: `Lease` `{ agent_id, holder, epoch, expires_at_ms }`, or an error when the lease is held (unexpired) by another.
- CAS-acquire the lease; grants iff unheld or expired, bumping the monotone, never-reused fencing `epoch`. FFI: `leaseAcquire` / `lease_acquire`.

#### `lease.renew`
- **Params**: `{ agent_id: string, epoch: number, ttl_ms?: number }`
- **Returns**: the renewed `Lease`, or an error (`Lost`) if no longer the holder at `epoch`.
- Heartbeat: extend `expires_at_ms` **without** bumping the epoch. Works past wall-clock expiry until actually stolen. FFI: `leaseRenew` / `lease_renew`.

#### `lease.release`
- **Params**: `{ agent_id: string, epoch: number }`
- **Returns**: `{ released: true }`, or an error (`Lost`) if not the holder at `epoch`.
- Clean handoff — the next acquire grants immediately with the next epoch (no TTL wait). Hook to graceful shutdown. FFI: `leaseRelease` / `lease_release`.

#### `lease.status`
- **Params**: `{ agent_id: string }`
- **Returns**: `{ lease: Lease | null }`
- The linearizable read of the current lease (the fence's "who holds now" read). `null` when unheld. An *expired* but un-stolen lease still reports its holder. FFI: `leaseStatus` / `lease_status`.

### skills (additional)

#### `skill.repair`
- **Params**: `{ skill_name }`
- **Returns**: `{ code }` on success, `null` if skill isn't broken or repair fails

#### `skills.ingest_distilled`
- **Params**: `{ skills: [DistilledSkill...] }`
- **Returns**: `{ ingested: N }`

#### `skills.evolve`
- **Params**: `{ events: [TraceEvent...], domain: string }`
- **Returns**: `[DistilledSkill...]` JSON

#### `skills.domains_needing_evolution`
- **Params**: `{ threshold?: number }` (default 0.6)
- **Returns**: `[string]` array of domain names

#### `skills.ingest_provisional`
- **Params**: `{ skills: [DistilledSkill...], tenant?: string }`
- **Returns**: `{ ingested: N }`
- Validation-gated ingest (SkillOpt-inspired). Skills enter as **provisional
  candidates** on trial keyed `<base>@cand` — they must beat their incumbent on
  real outcomes before the promotion gate makes them Active, vs
  `skills.ingest_distilled` which trusts skills active immediately. Drops
  already-rejected or already-trialing candidates from the count. See
  `docs/solutions/gated-skill-optimization.md`.

#### `skills.gate`
- **Params**: `null`
- **Returns**: `{ promoted: [string], rejected: [string] }` — resolved candidate keys
- Runs the promotion gate manually (it also runs automatically in
  `memory.consolidate`). Provisional candidates with ≥ `min_trial_samples` trial
  outcomes are promoted (candidate Wilson lower bound strictly beats the
  incumbent's) or rejected into the rejected-edit buffer.

#### `skill.meta`
- **Params**: `{ key }`
- **Returns**: `SkillMeta` JSON, or `null` if no active skill node holds the key
- Includes the lifecycle `status` (`active` / `provisional`), `incumbent` (base
  name a candidate trials to replace), `version`, and `stats`.

#### `skill.export`
- **Params**: `{ key }`
- **Returns**: portable markdown document (string), or `null` if the key is
  absent or not exportable
- Exports a **validated** skill (the SkillOpt `best_skill.md` analog) — only
  `Active`, healthy (non-degraded) skills export; provisional candidates and
  degraded skills don't. The document is TOML frontmatter (machine
  source-of-truth, including a SHA-256 content digest) plus a human-rendered
  body. See `docs/solutions/gated-skill-optimization.md`.

#### `skill.import`
- **Params**: `{ markdown }`
- **Returns**: `{ imported: true }`, or a JSON-RPC error if the document is
  malformed or its content digest doesn't verify
- Imports a skill from a `skill.export` document as a fresh `Active` skill with
  zeroed stats (it earns its own track record on this instance).

> **`memory.consolidate`** additionally returns `candidates_promoted` and
> `candidates_rejected` (`[string]`) on its `ConsolidationReport`, and emits one
> `CandidatePromoted` / `CandidateRejected` event per resolution to the event log.

### events / replan

#### `events.count`
- **Params**: `null`
- **Returns**: `u64` — per-session event log size

#### `events.stats`
- **Params**: `null`
- **Returns**: the event log's `stats()` object — current event and span counts for the session log.

#### `events.truncate`
- **Params**: `{ maxEvents?: number, maxSpans?: number }` (camelCase; both optional)
- **Returns**: `{ removedEvents, removedSpans, stats }`
- Keeps the **last** N of each and drops the rest. An omitted bound leaves that series untouched — omitting both is a no-op that just reports `stats`. Malformed params degrade to that no-op rather than erroring.
- Retention trimming for a long-lived session. For age-based policy use `events.retention` instead.

#### `events.clear`
- **Params**: `null`
- **Returns**: `{ removed, stats }`
- **Destructive and unconditional** — drops the entire session event log, including the audit trail `events.query` reads and any hash chain `events.chain.enable` established. There is no undo and no confirmation. Prefer `events.truncate` or `events.retention` when you only need to bound growth.

#### `events.query`
- **Params**: an `EventQuery` object — all fields optional, AND-conjoined:
  - `kinds` (array of `EventKind`) — restrict to these kinds (empty = any).
  - `action_id` / `proposal_id` (string) — exact match.
  - `since` / `until` (RFC3339 timestamp) — inclusive lower / exclusive upper time bound.
  - `data_matches` (`{ key: value }`) — match events whose `data` contains all
    these string pairs (covers `caller`/`tenant`/`tool`/`gate`/`decision`).
  - `limit` (u64) — cap results (most-recent-first). Omit/0 = unlimited.
- **Returns**: `{ count, events }` — the matching events, most-recent-first.
- The audit/compliance query (EPIC G / G2): "who ran what tool when, and which
  approvals applied" over the `SessionScope` / `PermissionDecision` /
  `ApprovalRecorded` / `GoalEvaluated` / action trail. Pairs with A9
  hash-chaining. Goal-loop evidence can be inspected with
  `events.query { "kinds": ["goal_evaluated"] }`; each `GoalEvaluated`
  event carries `data.goal`, serialized `data.condition`, `iteration`, `met`,
  `grounded`, and `reason`. Proactive memory calibration can be inspected with
  `proactive_memory_maintained` and `proactive_memory_intervention` events.

#### `events.chain.enable`
- **Params**: `null`
- **Returns**: `{ ok: true }`
- Turns on tamper-evident hash chaining for the session event log
  (EPIC A / A9). Every event appended from now on is linked to its
  predecessor by a SHA-256 content hash. Opt-in and idempotent; events
  appended before enabling stay byte-identical (and are skipped by verify).

#### `events.chain.verify`
- **Params**: `null`
- **Returns**: `{ verified: n }` — the number of chained events verified — or
  `{ tampered_at: i }` — the index of the first event whose hash/linkage
  doesn't match.
- Detects **interior** edits, deletions, and reorderings of chained events.
  It cannot detect truncation at either end of the log (there is no anchored
  head hash, and the first chained event's `prev_hash` is taken on trust);
  head/tail truncation detection is out of scope until the chain head is
  anchored.

#### `events.retention`
- **Params**: `{ policy?: { max_events?, max_age_secs? } }`
  - With `policy`: installs it and immediately enforces the age bound;
    `max_events` is then also enforced automatically on every append.
  - Without `policy`: returns the current policy.
- **Returns**: `{ policy, removed }` on set (events reaped by the age sweep), or
  `{ policy }` on get.
- Bounds the log by size and age so it can't grow unbounded (EPIC G / G2).
- **Journal compaction**: when the session log has a JSONL journal, a
  retention trim also compacts the journal — the file is atomically rewritten
  to exactly the retained events, throttled to fire only when it holds
  ≥ 1024 more lines than the retained set and would shrink by ≥ 25% (so the
  journal tracks retention instead of growing forever, without rewriting on
  every trim). A9 hash chaining still verifies over the retained tail.

#### `nlp.identify_language` / `nlp.tokenize` / `nlp.extract_entities`
- **Params**: `{ text: string }`
- **Returns**:
  - `identify_language` → `{ language: string | null, backend }` — BCP-47/ISO code of the dominant language (`null` if undetermined).
  - `tokenize` → `{ tokens: string[], backend }` — word-level tokens.
  - `extract_entities` → `{ entities: [{ text, kind, byte_range }], backend }`.
- `backend` is `"apple"` (macOS NaturalLanguage) or `"fallback"` (pure-Rust: `whatlang` + UAX #29 + a proper-noun heuristic). The fallback reports `kind: "entity"` (no person/place/org classification); Apple reports the typed category. Stateless (EPIC F / F4).
- FFI: also exposed as free functions `nlpIdentifyLanguage`/`nlpTokenize`/`nlpExtractEntities` (NAPI) and `nlp_identify_language`/`nlp_tokenize`/`nlp_extract_entities` (PyO3), which run the backend in-process.

#### `metrics.summary`
- **Params**: `null`
- **Returns**: a `MetricsSummary` — `total_events`, `actions_succeeded` /
  `actions_failed` / `actions_rejected`, `success_rate` / `error_rate`,
  `cost_usd` (fold over the retained window), `cumulative_cost_usd`
  (monotonic lifetime spend — survives retention trims), `tokens_in` /
  `tokens_out`, `avg_latency_ms`, `approvals_recorded`,
  `permission_decisions`, `gate_rejections`, `policy_violations`,
  `goal_evaluations`, `goals_met`, `goals_ungrounded`, and `cost_by_agent`
  (G3). The live operational rollup for a host dashboard (EPIC G / G1).

#### `metrics.alerts`
- **Params**: `AlertThresholds` (all optional): `max_cost_usd`,
  `max_error_rate` (0..1), `max_avg_latency_ms`, `max_goals_ungrounded`,
  `min_actions` (default 5 — the error-rate alert is suppressed below this many
  actions).
- **Returns**: `{ summary, alerts }` where each alert is
  `{ kind, message, observed, threshold }` (`kind` ∈ `cost_overage` /
  `error_rate` / `latency` / `goal_ungrounded`). Fired alerts are also written
  to the operational log (`tracing::warn target=car::alerts`). A synthetic cost
  overage fires the `cost_overage` alert (EPIC G / G1).
- The `max_cost_usd` budget is checked against the summary's **monotonic**
  `cumulative_cost_usd` counter (maintained at append time), not the
  windowed `cost_usd` fold — a retention trim can never slide the counter
  backward and un-fire an already-tripped budget alert.
- `max_goals_ungrounded` is checked against `summary.goals_ungrounded`, so a
  monitor can fail loud when a goal condition was met through ungrounded
  evidence instead of CAR's deterministic runtime receipts.

#### `selfheal.status`
- **Params**: `null`
- **Returns**: `{ cadence_secs, last_tick_at, route, source_checkout?,
  refusal_reason?, detectors, detection_count, warning_count, critical_count,
  dismissed_count, filing_mode }`.
- `route` is `"local"` only when the tick validates a filesystem candidate as
  the CAR source checkout; `source_checkout` then gives the canonical path.
  Otherwise it fails closed to `"ledger-only"` and `refusal_reason` explains
  why, including the actual origin remote when one was refused. `"feedback"`
  is reserved for the separately gated feedback sink and is never selected by
  this implementation.
- Source candidates are bounded and deterministic: `[selfheal]
  source_checkout = "/path/to/car"` in `<CAR_HOME>/config.toml` is authoritative,
  followed (only when it is absent) by running-binary ancestors and the root of
  the `.car/` project discovered from `CAR_PROJECT_DIR` or cwd. A candidate must
  contain a `.git` directory or worktree file whose config names a GitHub
  `Parslee-ai/car` origin. Detection performs file checks/reads only: no `git`
  subprocess, network, or filesystem-wide scan.
- `filing_mode` remains `"watch-only"`: local issue documents are private
  handoff artifacts, not off-machine filings or remediation. The daemon runs
  one non-overlapping tick immediately at boot and then every 900 seconds by
  default. `CAR_SELFHEAL_INTERVAL_SECS` changes cadence only.
- The five detector IDs are `metrics_alerts.v1`, `agent_gave_up.v1`,
  `agent_log_errors.v1`, `recurring_tool_failure.v1`, and
  `capability_miss.v1` (the unversioned detection `kind` values are listed
  below).
- FFI: `selfhealStatus()` (NAPI) / `selfheal_status()` (PyO3), returning JSON.

#### `selfheal.detections`
- **Params**: optional `{ kind, severity, since, offset, limit }`. `kind` is one
  of `metrics_alert` / `agent_gave_up` / `agent_log_error` /
  `agent_silently_idle` / `recurring_tool_failure` / `capability_miss`;
  severity is `warning` / `critical`; `since` is RFC 3339.
  Default limit is 100 and the server clamps it to 1..500.
- **Returns**: `{ detections, total, offset, limit, next_offset }`, latest first.
  Dismissed stable keys are omitted. Each detection carries its SHA-256
  `dedup_key`, evidence/provenance, observation times, affected component,
  detector/version identity, redacted summary/detail, the tick's `route`, and
  `local_issue_path` when routed locally.
- FFI: `selfhealDetections(queryJson?)` / `selfheal_detections(query_json=None)`.

#### `selfheal.dismiss`
- **Params**: `{ dedup_key }`, the 64-character SHA-256 hex key from a
  detection.
- **Returns**: `{ dedup_key, dismissed, already_dismissed, dismissed_at }`.
- Appends a dismissal marker; it never rewrites/deletes history. Later ticks
  suppress that key. FFI: `selfhealDismiss(dedupKey)` /
  `selfheal_dismiss(dedup_key)`.

#### `selfheal.run`
- **Params**: `null`
- **Returns**: a tick summary with `route`, `source_checkout?` or
  `refusal_reason?`, evidence counts, and new/changed/suppressed detection
  counts. A concurrent tick fails instead of overlapping.
- Runs the same watch-only path as the cadence. It reads active session event
  slices since the prior tick, current supervised-agent state, bounded
  activity/stderr tails and activity-log metadata, and the observe-only
  registry, invokes all five deterministic detectors, and
  performs no network request, off-machine issue filing, proposal execution,
  agent restart, or remediation.
- FFI: `selfhealRun()` / `selfheal_run()`.

All four methods share the daemon-wide private append-only ledger at
`<CAR_HOME>/selfheal/detections.jsonl`. JSONL records are tagged `detection`,
`dismissal`, or `tick`; new ticks append only new/changed detections plus their
summary. A `local` route additionally renders one owner-private
`<CAR_HOME>/selfheal/issues/<dedup-key>.md` per active key, stamped
`Trust-Tier: trusted`, and updates its occurrence count in place. Directories
and files are 0700/0600 on Unix. No self-heal path writes into the detected
source checkout.

#### `events.cost_by_agent`
- **Params**: `null`
- **Returns**: array of `{ agent, calls, tokens_in, tokens_out, cost_usd }` —
  the per-agent token/cost report, folded from `InferenceMetered` events by
  their `agent` field (EPIC G / G3). A multi-agent run reports cost per agent;
  provenance (which tool/workflow) is queryable via
  `events.query {data_matches:{agent}}`.

#### `replan.set_config`
- **Params**: `{ max_replans, delay_ms, verify_before_execute, replan_on_rejected }` flat shape
- **Returns**: `null`
- Configures the per-session replan loop. `replan_on_rejected` (default `false`): when `true`, validator/policy/capability rejections (`ActionStatus::Rejected`) — not just runtime failures — also trigger rollback + replan, feeding the offending tool/error/parameters back to the replan callback. Conservative default preserves abort-only-on-failure behavior for all existing consumers.

### runs

Agent run tracing (U1). A *run* is one `runs.start` / `runs.complete`
bracket around an agent loop, identified by a durable `run_id` (a uuid)
that is **independent of the ephemeral, server-assigned WS `client_id`**.
The `run_id` is the connection-independent, restart-surviving key the
`client_id` cannot be: it groups a run's records and maps an agent to its
runs. The per-turn capture (`RunTurn`/`CliOutcome`/`VerifierVerdict`), the
disk store, the live `runs.trace.event` notification (`runs.subscribe`
/ `runs.unsubscribe`), and the replay read RPCs (`runs.list` /
`runs.get_trace`) are documented below.

**Authorization (R16 + #254).** Every read/subscribe method —
`runs.subscribe`, `runs.list`, `runs.get_trace` — verifies the calling
connection is entitled to the run's owning `agent_id`: it either **owns**
the agent (its `session.auth {agent_id}` binding matches) or it holds the
**host-management role** (it authenticated via `session.auth { host_token }`
with the per-launch host token). Merely having called `host.subscribe` is
**not** sufficient — that check let any authenticated local connection
self-elevate and read every agent's run traces (Parslee-ai/car#254); the
host token, readable only from the `0600` `host-token` file and never
served over HTTP, is now required. A caller-supplied `agent_id` / `run_id`
is **not** a transparent key — an unentitled request is rejected, not
served (an `agent_id` can't be used to enumerate another agent's runs).

**Write authorization is stricter — owner-binding only.** The one *write*
method, `runs.record_turns`, accepts the run's **owning agent** alone: the
calling connection's `session.auth {agent_id}` binding must equal the run's
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
  Lost/ambiguous control persists `cancellation_result` with
  `termination_unconfirmed`; this is a quarantined nonterminal state that
  blocks proposals, completion, orphan adoption, and retention eviction.
- This is a WebSocket newsroom/operator surface only; no NAPI, PyO3, UniFFI,
  or mobile binding is part of this contract.

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
- **Params**: `{ run_id }`.
- **Returns** (the snapshot at cursor): `{ run_id, agent_id, turns_so_far,
  cursor, status }` where
  - `turns_so_far` — the run's ordered `RunRecord::Turn` records captured
    at subscribe time. `cursor == turns_so_far.length`.
  - `cursor` — the turn boundary the daemon streams strictly after. Every
    `RunTurn` recorded **after** this index arrives as a `runs.trace.event`
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
  - `{ record: "turn", ... }` — one captured turn (`RunTurn`). `cursor` is
    the run's turn count immediately **after** this turn was appended
    (1-based); the next `turn` event's `cursor` is this `+ 1`.
  - `{ record: "ended", ... }` — the terminal record (a reported
    `Outcome` or an `Incomplete` marker). `cursor` carries the final turn
    count; `status` flips to `completed` / `incomplete`.
- `status` is the run's live status after this record.

#### `runs.list`
- **Params**: `{ agent_id }`.
- **Returns**: `{ agent_id, runs }` where `runs` is an array of
  `RunSummary`, **newest first** (by `started_at`):
  - `RunSummary`: `{ run_id, agent_id, intent, started_at, ended_at?,
    status, turn_count }` where `status` is `in_progress` | `completed` |
    `incomplete` and `turn_count` is the number of persisted `RunTurn`
    records. `ended_at` is present once the run reached a terminal state.
- Reads the **disk store** (`~/.car/runs/{agent_id}/`), not live session
  state, so it works across daemon restart and `client_id` churn —
  `agent_id` is the durable key.
- An agent with no runs returns `{ agent_id, runs: [] }` (the empty state,
  not an error).
- **Authorization (R16)** — see the section intro. The `agent_id` is
  checked FIRST; an unentitled caller is rejected before any directory is
  read (the param is an authorization subject, not a lookup key).
- **WS-only** — no FFI binding (CarHost consumes it over the socket, like
  `runs.subscribe`). The FFI parity table is unchanged.

#### `runs.get_trace`
- **Params**: `{ run_id, cursor? }`.
  - `cursor` (optional) — a start index into the run's ordered `RunRecord`
    stream; the first record returned. Omitted / `0` returns the whole
    trace; a non-zero cursor pages a large run from that offset.
- **Returns** (run found): `{ run_id, agent_id, records, cursor }` where
  - `records` — the run's persisted `RunRecord`s in order, bracketed
    `{ record: "started" } … (RunTurn records) … { record: "ended" }`. The
    `RunTurn` records are **identical to what the live `runs.trace.event`
    stream delivered** — replay and live render through one buffer (R9).
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
  unauthorized rejection never leaks the run's prompts/outputs. (An
  unknown `run_id` returns the not-found marker without revealing whether
  the id exists, since there is no owner to authorize against.)
- **WS-only** — no FFI binding. The FFI parity table is unchanged.

### tools

#### `tools.register`
- **Params**: `ToolDefinition[]` (an array, not an object)
- **Returns**: number of tools registered

`ToolDefinition`: `{ name: string, description?: string, parameters?: object }`. Tools registered here are dispatched via `tools.execute` callbacks during proposal execution.

#### `tools.list`
- **Params**: none
- **Returns**: `{ tools: [ToolSchema], count: number }`, where each `ToolSchema` is `{ name, description, parameters, returns?, idempotent, cache_ttl_secs?, rate_limit? }` (optional fields omitted when unset)
- The toolset actually in effect on this connection. The full schema comes back, not just names — what a tool accepts is part of the surface being proven.
- **The array is sorted by tool name.** The underlying store is a hash map, so unsorted output would reorder between two calls that registered nothing in between; an audit surface whose order changes on its own cannot be diffed and is not usable as proof.
- Scope is the connection: each WebSocket client gets its own runtime, so this reports what is in force on *this* session, not a daemon-wide set. It is also **not** the assistant's set — `car do` / `agents.chat` build their own runtime, so listing here does not describe the toolset those will execute with.
- "In force" is a superset of "what you registered", which is much of why enumerating is worth doing: a fresh session already carries the `messaging.send` built-in, because the daemon attaches an outbound message sink and the sink and its schema arrive together (a tool the runtime cannot execute is never advertised to the model). The commodity stdlib is *not* included until the session asks for it — both `session.bindSubstrate` and `session.bindSandbox` register it.
- Before this existed, `tools.register` had no counterpart: a client could add tools but never ask what was registered, so a governed or read-only deployment could not prove "only tools X and Y are callable here".

#### `tools.unregister`
- **Params**: `{ name: string }`
- **Returns**: `{ unregistered: string, removed: number }` — `removed` is `1` if the tool was present, `0` if it was not
- Removes the tool from both the runtime's canonical registry and its schema map, so the model stops seeing it and the validator stops accepting it.
- `removed: 0` for an unknown tool is reported, not raised, so a client cleaning up can call this unconditionally without listing first — the same contract as `policy.unregister`. A missing `name` *is* an error.
- Without it a tool added to a session could not be taken back for the life of the connection: narrowing an over-broad registration meant reconnecting and rebuilding the session's state.

#### Detached tool dispatch (streaming / long-running, EPIC C / C2)

A ToolCall action with `invocation_mode: "streaming" | "long_running"` (see
`docs/agent-ir-spec.md`) is *started*, not awaited: dispatch returns
`{ "tool_handle": "<id>", "status": "running" }` as the action's output and
the DAG proceeds without blocking on completion. The methods below drive
that handle. Handles are scoped to the session runtime that started them.

> **Support status.** Detached dispatch requires the runtime's configured
> tool executor to implement `ToolExecutor::execute_stream`. The daemon's
> WS-callback executor (`tools.execute` round-trips to the client) does
> **not** implement it yet — a detached ToolCall submitted over the WS
> today fails at dispatch with "does not support streaming/long-running
> invocation". The handle surface below is live for in-process embedders
> (and for the daemon once a streaming executor lands; that is the
> planned follow-up). `tools.poll` / `tools.cancel` / the event stream
> work against any handle regardless of which executor started it.

Two lifecycle bounds (both surfaced, not silent): a handle's undrained
chunk buffer is capped at 1024 — oldest chunks are dropped first and the
drop count is reported as `dropped_chunks` on the next poll (the event
stream may still have delivered them live) — and a terminal handle that
is never polled is reaped after 15 minutes. `timeout_ms` on a detached
action bounds only the `execute_stream` *startup*; the stream itself has
no deadline (cancel it explicitly).

#### `tools.poll`
- **Params**: `{ handle: string }` — the `tool_handle` a detached ToolCall action returned as its output
- **Returns**: a `ToolPollResult` — `{ handle, tool, action_id, status, chunks, dropped_chunks?, result?, error? }` — or `null` for an unknown / already fully-consumed handle (absence, not an error)
- `status` ∈ `running | succeeded | failed | cancelled`. `chunks` are the
  `ToolStreamChunk`s produced since the previous poll (oldest first; each is
  tagged by `kind` ∈ `text | data | progress | done | error`), so polling
  *drains* — a second immediate poll returns `chunks: []`. `result` is set
  once `succeeded` (from the terminal `done` chunk), `error` once `failed`.
- Consumed-after-terminal contract: the poll that observes a terminal status
  with an empty buffer marks the handle consumed; the next poll returns
  `null`. A caller always sees the terminal status at least once.

```json
{"jsonrpc": "2.0", "method": "tools.poll", "params": {"handle": "b41dfc2a9e01"}, "id": 7}
{"jsonrpc": "2.0", "result": {"handle": "b41dfc2a9e01", "tool": "tail_log", "action_id": "a1", "status": "running", "chunks": [{"kind": "text", "text": "line 1\n"}, {"kind": "progress", "fraction": 0.5, "message": "halfway"}]}, "id": 7}
```

#### `tools.cancel`
- **Params**: `{ handle: string }`
- **Returns**: `{ cancelled: bool }` — `false` for an unknown handle
- Cooperative: fires the invocation's cancel token and seals the handle as
  `cancelled` (unless already terminal); the executor observes the token /
  the dropped chunk stream. A subsequent `tools.poll` reports the sealed
  status.
- **Not** the same thing as the server → client `tools.cancel` *notification*
  (car#264, documented above): same method name, opposite direction. The
  notification correlates by `request_id` and aborts a reaped `tools.execute`
  callback; this request correlates by `handle` and cancels a detached
  invocation.

#### `tools.stream.subscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: true }`
- Subscribes this connection to the session runtime's tool-stream fanout:
  every chunk from every detached invocation in the session then arrives as
  a `tools.stream.event` notification (no `id`):

```json
{"jsonrpc": "2.0", "method": "tools.stream.event", "params": {"handle": "b41dfc2a9e01", "chunk": {"kind": "text", "text": "line 2\n"}}}
{"jsonrpc": "2.0", "method": "tools.stream.event", "params": {"handle": "b41dfc2a9e01", "chunk": {"kind": "done", "result": {"exit": 0}}}}
```

- Idempotent per connection — a second subscribe is a no-op (one forwarder,
  no duplicate notifications). There is no unsubscribe; the forwarder ends
  with the connection.
- Best-effort/lossy under lag: the fanout is a bounded broadcast and the
  per-connection write is bounded, so a slow consumer can miss events. Missed
  chunks are **not** lost — they remain drainable via `tools.poll`, which
  reads the per-handle buffer, not the broadcast. Poll is the reliable path;
  the event stream is the low-latency one.
- WS-only — no FFI binding (same contract as `runs.subscribe` /
  `coder.subscribe`). FFI callers drive handles with
  `toolPoll`/`tool_poll` + `toolCancel`/`tool_cancel`.

### policy

#### `policy.register`
- **Params**: a single `PolicyDefinition`: `{ name, rule, target?, key?, value?, pattern? }`
- **Returns**: `{ name }`
- Mirrors `session.init`'s policy slot for callers that want to register one policy at a time. Supported `rule` values: `deny_tool`, `deny_tool_param`, `require_state`. Callback rules (`deny_tool_callback`) are NOT supported on the daemon — the FFI binding is expected to reject them in Daemon mode and route through Embedded mode instead.

### agents

> **Observe-only mode** (Parslee-ai/car-releases#44). The supervisor
> takes an exclusive OS-level lock on `<manifest>.lock` so two
> car-server processes can't supervise the same manifest and
> double-spawn every agent against shared external state. A
> secondary daemon that hits the lock at boot logs a clear warning,
> installs an *observer* marker, and continues running with the
> agents.* namespace partially degraded:
>
> - `agents.list`, `agents.health` keep working — they fall back to
>   reading the manifest directly (runtime fields like `pid`,
>   `status`, `restart_count` default; only the primary daemon
>   sees live state).
> - Every other agents.* method returns an error containing
>   "observe-only" plus the manifest path the lock-holder owns,
>   signalling that the caller should route the request to the
>   primary daemon (or give this daemon its own manifest via
>   `--agents-manifest` / `CAR_AGENTS_MANIFEST`).
>
> Single-daemon deployments are unaffected.

#### `agents.register_basics`
- **Params**: `null`
- **Returns**: `null`
- Registers CAR's built-in agent utility tools on this client's session. Mirrors `Runtime::register_agent_basics`.

#### `agents.list`
- **Params**: `{}`
- **Returns**: `[ ManagedAgent ]` — every entry in `~/.car/agents.json` plus its current runtime status `{spec, status, pid?, last_exit_code?, restart_count, started_at?, blocked_by_pid?, attached, session_id?}`. `status` is one of `stopped | starting | running | backoff | errored`.
- `blocked_by_pid` (car#732) is present only when the agent is in `backoff` **because a live process this supervisor does not own is already running as it** — typically one that outlived a previous `car-server` and still holds the agent's port. Without it, `backoff` + `pid: null` + a healthy process on the port is indistinguishable from a broken agent, and the cause is only visible via `lsof`. Stop the named pid and restart, or leave it: supervision resumes automatically once it exits.
- `attached` is `true` once the supervised child has called `session.auth { agent_id }` and bound a WS connection (#169). `session_id` carries the bound `client_id` while attached. The lifecycle status alone can't distinguish "alive but never attached" from "alive and attached".
- Driven by `car_registry::supervisor::Supervisor`. Closes [Parslee-ai/car-releases#27].

#### `agents.upsert`
- **Params**: `AgentSpec` — `{ id, name, command, args?, cwd?, env?, restart?, max_restarts?, backoff_secs?, auto_start?, interpreter? }`. `restart` is `never | on_failure | always`. `id` must be filename-safe (alphanumeric + `-_.`).
- **Returns**: the resulting `ManagedAgent`.
- Persists the manifest; the agent is NOT auto-started — call `agents.start` (or rely on `auto_start: true` for the next car-server boot).
- **`interpreter` sugar (#171)**: instead of hand-coding `/opt/homebrew/bin/node` (or whatever the current PATH resolves to), pass `interpreter: "node" | "python" | "deno" | ...` and the supervisor resolves the bare program name against `$PATH` *once* at upsert and writes the absolute path into `command`. Resolution then freezes — subsequent PATH changes do not silently rewire which binary the spec points to. The strict no-PATH-lookup rule at upsert time still holds: an interpreter that resolves into `/tmp` or fails the executable-bit check is rejected.

#### `agents.install`
- **Params**: `AgentManifest` — the nested TOML shape from
  `docs/proposals/contributed-agents.md`, JSON-encoded for the
  wire: `{agent: {id, name, namespace?, version?, …}, publisher?,
  runtime?, lifecycle?, transport: {kind, …}, capabilities?}`.
  `transport.kind` is `pure_data` or `external_process`; the
  per-kind sub-table carries the rest.
- **Returns**: `{report: {missingOptional: [{namespace, feature}]}, agent: ManagedAgent | null}`.
- Runs install-time validation against the daemon's default host
  capability advertisement (Parslee-ai/car#182 phase 3):
  - `runtime.car_min_version` (if present) must be satisfied by
    the daemon's own semver. Accepts a bare semver (interpreted
    as `>=`) or a cargo-style requirement (`">=0.8, <0.9"`).
  - Every `capabilities.required[namespace][feature]` must be
    advertised by the host. Fail-closed on any miss.
  - `capabilities.optional` is reported back as `missingOptional`
    when the host can't satisfy it — informational, not
    blocking.
- For `external_process` manifests with a `command`, the
  supervisor adopts the agent (mints a token if absent) and
  returns it. For `pure_data` and `health_url`-only manifests,
  the manifest is written to `~/.car/agents/<id>/manifest.toml`
  but `agent` comes back `null` (the supervisor only spawns
  command-shaped externals in phase 3).
- Signature verification: when the manifest carries a
  `[publisher]` block, the signature is verified via
  `car_bundle::verify_signature`. Phase 3 is still
  warn-but-not-reject for failed signatures (logs a warning,
  still installs); phase 4+ may tighten.

#### `agents.health`
- **Params**: `{}`
- **Returns**: `[ { id, command, ok, reason? } ]` — one entry per managed agent. `ok: true` means `validate_command(command)` still accepts the path; `ok: false` populates `reason` with the validator's error (file missing, no execute bit, lives under a scratch dir, etc.).
- Use after a system upgrade to surface broken specs before `agents.start` does. Pairs with the `interpreter` sugar — when `ok: false` for an interpreter-resolved entry, the host can re-upsert with the same interpreter name to pick up the new path.

#### `agents.remove`
- **Params**: `{ id: string }`
- **Returns**: `{ removed: bool }`
- Stops the running child first if it's up. Idempotent.

#### `agents.start`
- **Params**: `{ id: string }`
- **Returns**: `ManagedAgent`
- Spawns the child if it isn't running. No-op when already `running` or `starting`. Resets `restart_count`.

#### `agents.stop`
- **Params**: `{ id: string, signal?: "term" | "kill" }`
- **Returns**: `ManagedAgent`
- `term` (default) sends SIGTERM and waits the supervisor's grace window before escalating to SIGKILL; `kill` skips the grace.

#### `agents.restart`
- **Params**: `{ id: string }`
- **Returns**: `ManagedAgent`

#### `agents.wait`
- **Params**: `{ id: string, targets?: AgentStatus[] = ["running"], timeout_secs?: number = 30, poll_ms?: number = 200 }`
- **Returns**: the matching `ManagedAgent` once its `status` is one of `targets`; an error if the timeout elapses first (`WaitTimeout`) or the agent isn't in the manifest (`NotFound`).
- Blocks until a supervised agent reaches a target state — the persistent-agent analogue of "wait until ready / wait until done". Pass `["running"]` to wait for an agent to come up, or `["stopped","errored"]` to wait for a one-shot child to finish. It only observes the supervisor's status transitions; it never starts or stops the agent. `poll_ms` is clamped to ≥10ms. FFI: `agentsWait` (NAPI) / `agents_wait` (PyO3).

#### `agents.tail_log`
- **Params**: `{ id: string, n?: number, stream?: "combined" | "stdout" | "stderr", offset?: number }`.
  - `n` — lines **per included stream** (default 100; `0` ⇒ whole file, still bounded by the tail byte ceiling below). Both `n` and the legacy alias `lines` are accepted (the CarHost UI historically sent `lines`).
  - `stream` — which captured stream(s) to return (default `combined`). Each stream is tailed **independently** to its own `n`-line budget, so a long stale `stderr` can no longer bury a healthy agent's live `stdout` (Parslee-ai/car#273).
  - `offset` — page back: skip this many lines from the end of each stream before taking the window (`offset = n` ⇒ previous page).
- **Returns**: `{ lines: [string], stdout: [string], stderr: [string], stdout_total: number, stderr_total: number, stdout_path: string, stderr_path: string, more: boolean }`.
  - `lines` — legacy combined view: stdout lines then stderr lines (each independently budgeted). Kept for back-compat.
  - `stdout` / `stderr` — the per-stream windows (empty when `stream` excluded that side), for separate-pane / stream-select viewers.
  - `stdout_total` / `stderr_total` — line count in the scanned tail before windowing (for "showing N of M" / scrollbar sizing). Exact for any log within the tail byte ceiling; for a multi-GB log it counts only the lines in the last ceiling bytes, and `more` is `true`.
  - `stdout_path` / `stderr_path` — absolute file paths (for "reveal in Finder" / opening the full log).
  - `more` — `true` when paging further back (larger `offset`) would surface older lines on at least one included stream, **or** when the tail read was truncated at the byte ceiling (older lines provably exist on disk).
- **Note**: the capture format is raw child output with no per-line timestamps, so a true cross-stream timestamp interleave isn't available; combined ordering is stdout-then-stderr with each side independently budgeted.
- **Bounded read**: agent logs are append-only and never rotated, so each stream is read via a **bounded backward seek** (at most an 8 MiB tail), not a whole-file slurp — keeping repeated polling (e.g. a live-follow viewer re-fetching every 2s) cheap regardless of how large the on-disk log has grown. A log larger than the ceiling is truncated to its last 8 MiB; the partial leading line is dropped and `more` is forced `true`. Combined-view paging (`stream: "combined"` + `offset`) is **not** order-preserving — a combined page is a stdout-block followed by a stderr-block, so prepending an older combined page scrambles that ordering; page within a single stream (`stdout`/`stderr`) to scroll back, or open the file directly.

#### `agents.chat`
- **Params**: `{ agent_id: string, prompt: string, session_id?: string, stream?: boolean = true, voice_input?: boolean = false, model?: string, attachments?: ImageContentBlock[], goal?: { check: string, max_iterations?: number } }`.
  - `agent_id` — the flagship assistant's canonical id is `parslee-core`; `car-assistant` (its pre-car#1107 id, still hardcoded by macOS) is accepted as a server-side alias. If the caller sends one spelling and the assistant is attached under the other, the daemon transparently resolves to whichever is actually attached — this only applies to the flagship assistant, not other supervised or declarative agents.
  - `session_id` — host-generated id threaded through every event so one CarHost window with multiple in-flight chats can demux. Auto-generated when omitted.
  - `model` — optional explicit CAR model ID for this turn. A non-empty value is a strict selection and reaches inference unchanged; CAR reports that model's failure rather than silently substituting another model. Omit it (or pass a blank string) to preserve the supervised agent's configured model and adaptive fallback policy.
  - `attachments` — optional array of image `ContentBlock`s the user attached: `{ "type": "image_base64", "data": "<b64>", "media_type": "image/png" }` or `{ "type": "image_url", "url": "https://…", "detail": "auto" }`. The daemon validates each entry's shape and content — `image_base64` must carry a string `data` and a `media_type` in `{image/png, image/jpeg, image/gif, image/webp}`; `image_url` must be http(s) — rejecting a malformed entry with a JSON-RPC error, then forwards the array verbatim to the agent's reverse-called `agent.chat` handler, which passes it to inference as `imagesJson`. Omitted when the turn has no images, so agents that don't read it see the legacy request shape. The daemon does **not** check provider vision capability; an agent or provider that can't accept images surfaces that error downstream.
  - `goal` — optional deterministic completion contract for this chat turn. `check` is a shell command the agent runtime runs after each assistant iteration; exit 0 means the condition is met. `max_iterations` defaults to 8 and is clamped to 1–50. Goal-driven agents stream `goal_evaluated { iteration, met, grounded, reason }` after each verifier pass and emit terminal `done` once the deterministic check passes (`met` with `grounded: true`). The flagship assistant still cross-checks conservative final-summary operational claims such as "tests passed" against same-run tool receipts, but once the deterministic check has itself passed an unmatched claim only **annotates the reply text** (a `[claim check]` note appended to the `done` message) — it no longer re-opens a deterministically-verified iteration on prose wording, and `grounded` stays `true`. A summary claim can still keep a completion ungrounded when the met verdict rested on a model judge rather than deterministic ground truth (it fails closed and keeps iterating). If the governor halts on a condition that actually ran and was not met (turn/cost/wall-clock budget, no-progress, cancel), the terminal event is `error`, naming the halt reason. If the check itself never got to run within its own bound — a stuck approval wait, a wedged subprocess — the loop fails open instead of hanging or discarding a working reply: it halts on the *first* such stall (it does not burn the rest of `max_iterations` retrying a check that structurally cannot be evaluated), and the terminal event is still `done`, with the reply text carrying a `[goal check] not verified — …` note (mirroring the `[claim check]` annotation convention above), `finish_reason` set to a short "unevaluated" string, and `goal_unevaluated: true` — a machine-readable marker `goal.status`'s persistence layer reads to record `status: "unevaluated"` rather than `"met"`, so a client polling `chatGoal.status`/`goal.status` cannot misread an unchecked condition as a verified pass. Currently mutually exclusive with `attachments`.
  - If no inline `goal` is passed, the daemon looks for a standing goal stored for the same `session_id` via `goal.set` and forwards that contract to the agent.
- **Returns**: an ack `{ accepted: true, session_id: string }`. The reply does **not** carry the answer — for attached supervised agents, the daemon reverse-calls the agent's `agent.chat` handler and fans the streamed reply back as `agents.chat.event` notifications (`kind: "token" | "tool_call" | "approval_pending" | "goal_evaluated" | "receipt_report" | "done" | "error"`) keyed by `session_id`. `receipt_report` is emitted immediately before the terminal frame and reports local verification, remote main, CI/CD, deployment, health, and production-browser proof separately; missing evidence remains absent rather than being inferred. For in-daemon declarative agents, no child process or reverse call is needed: the daemon runs the declarative runner directly and emits the same event stream. `stream: false` still returns via the same event channel as a single terminal frame.
- Host-side method is WS-only (no FFI binding — a host like CarHost calls it directly). The **agent side** has FFI helpers (below). See [`docs/proposals/agent-chat-surface.md`](./proposals/agent-chat-surface.md) for the full host↔daemon↔agent flow.

#### `goal.suggest`
- **Params**: `{ prompt?: string, objective?: string, working_dir?: string, cwd?: string, session_id?: string, set?: boolean }`.
  - Produces an explainable deterministic completion-check candidate for a vague goal. `prompt` and `objective` are aliases; one is required.
  - `working_dir`/`cwd` is optional. When it points at a project directory, the daemon checks for `Cargo.toml`, `package.json`, `pyproject.toml`/`setup.py`, `go.mod`, `Package.swift`, `CMakeLists.txt`, `build.gradle(.kts)`, `pom.xml`, `.sln`/`.csproj`, `composer.json`, `Gemfile`, `mix.exs`, or a `Makefile` `test` target. If a prompt names a relative file or directory path inside a recognized project, including a nested project below `working_dir`, it uses the nearest project verifier. For create/write prompts, it also combines file existence with that verifier (for example `test -f src/lib.rs && cargo test -q`) instead of treating file creation alone as success. Outside a recognized project, a named path can still produce a file-existence check.
  - The method is conservative: when no deterministic signal is present, it returns `suggested: false` rather than inventing a weak completion check.
  - With `set: true`, `session_id` is required and a successful suggestion is stored exactly like `goal.set`.
  - Foreground `car do "<objective>" --infer-until` uses the same synthesis logic, prints the selected check/rationale, then enters deterministic `--until` goal mode.
- **Returns**: `{ suggested: boolean, goal: { check, max_iterations } | null, confidence: "high" | "medium" | "none", rationale: string, signals: string[], warnings: string[], set?: true, session_id?: string, stored_goal?: ChatGoalState }`.

#### `goal.set`
- **Params**: `{ session_id: string, goal?: { check: string, max_iterations?: number }, check?: string, max_iterations?: number }`.
  - Stores a durable deterministic completion contract for a chat `session_id`. `goal` is the preferred shape; top-level `check` / `max_iterations` are accepted as a convenience.
  - `check` is trimmed and must be non-empty. `max_iterations` defaults to 8 and is clamped to 1–50.
  - The daemon atomically rewrites the registry at `~/.car/chat-goals.json`, derived as a sibling of the configured journal directory.
- **Returns**: `{ set: true, goal: ChatGoalState }`.

#### `goal.status`
- **Params**: `{ session_id?: string }`.
  - With `session_id`, returns `{ session_id, goal: ChatGoalState | null }`.
  - Without `session_id`, returns `{ goals: ChatGoalState[] }`.
  - `ChatGoalState` carries `{ session_id, check, max_iterations, status, last_iteration?, last_met?, last_grounded?, last_reason?, terminal_kind?, terminal_message?, updated_at }`. `status` is one of `"active"` (set, not yet run), `"running"`, `"met"`, `"unevaluated"` (a `done` whose goal check never got the chance to run — see the fail-open case under `agents.chat`'s `goal` param above; `terminal_message` carries `finish_reason` for human-readable detail), or `"error"` (a check that ran and genuinely failed, or a governor halt). It is updated from forwarded `goal_evaluated`, `done`, and `error` chat events and persisted. On daemon restart, a stale persisted `running` status is reloaded as `active` while verifier details are preserved.

#### `goal.clear`
- **Params**: `{ session_id?: string }`.
  - With `session_id`, removes one standing goal and returns `{ cleared: boolean, session_id }`.
  - Without `session_id`, removes all standing goals and returns `{ cleared: number }`.

#### `agent.chat` (daemon → agent reverse-call) + `agent.chat.event`
- For attached supervised agents, `agents.chat` reverse-calls **`agent.chat`** on the target agent's WS connection — resolved via `attached_agents`, so the agent must have `session.auth`'d **with its `agent_id`** (`{ session_id, prompt, model?, attachments?, goal?, context? }`). The optional `model` is forwarded unchanged from the host request. The agent **acks** `{ accepted: true }` immediately, then streams its reply as **`agent.chat.event`** notifications `{ session_id, kind, delta? }` (`kind: "token" | "tool_call" | "approval_pending" | "goal_evaluated" | "receipt_report" | "done" | "error"`), which the daemon rewrites to `agents.chat.event` for the host. `goal_evaluated` is emitted by goal-driven agents after each verifier pass as `{ iteration, met, grounded, reason }`; `receipt_report` is the stage-separated terminal evidence matrix. `agents.chat.cancel` proxies to `agent.chat.cancel`; `agents.chat.approve` reverse-*requests* `agent.chat.approve` (resolving an `approval_pending` gate so the turn resumes). In-daemon declarative agents skip the reverse call and stream `token`/`goal_evaluated`/terminal frames directly; cancel flips a local run flag and halts at the next model/tool/goal-check boundary; inline `agents.chat.goal` and image attachments are rejected for them because their own manifest `goal` and scratch-worktree runner own completion.
- **FFI (agent side):** `registerChatHandler(handlerFn)` / `register_chat_handler(handler)` installs the handler (stored-callback pattern; the per-`CarRuntime` bridge acks and fires it with the params JSON). `CarRuntime.chatEvent(sessionId, kind, delta?)` / `chat_event(...)` emits each `agent.chat.event`. **The handler may call any runtime method and should run the turn inline** — in Python it is dispatched on a dedicated CAR-owned OS thread, never a tokio worker, so `infer_tracked`, `submit_proposal`, `state_set`, and `chat_event` all work from inside it. Before car#905 the Python bridge dispatched on a runtime worker and every one of those raised `PanicException: Cannot start a runtime from within a runtime`; because that is a `BaseException` and `chat_event` hit the same wall, the accepted turn was stranded with the host receiving zero frames. Any `threading.Thread` offload written to work around that is now unnecessary. NAPI was never affected (async `ThreadsafeFunction` dispatch). The same contract covers the `tools.execute`, `tools.cancel`, and `voice.event` callbacks. A `--serve` agent **attaches automatically**: the binding sends `agent_id` on `session.auth` when `CAR_AGENT_ID` + `CAR_AGENT_TOKEN` are set (the supervisor injects them). The bundled `create-car-agent` harness wires all of this in `--serve`, keeping an ephemeral per-`session_id` message thread and running the standard propose→verify→execute loop per turn.
- Bundled `car do` / `car do --serve` assistant loops run proactive memory before every model turn. The hidden pass maintains compact execution-state memory from the runtime event log, selects at most one relevant remembered fact/procedural warning, and injects it as a `## Proactive Memory` context block. This uses the same assistant memory bank as `remember` / `recall`, but does not require the model to call `recall`; maintenance/intervention decisions are journaled as `proactive_memory_maintained` and `proactive_memory_intervention`.
- Native coder loops also run proactive memory over the shared repair memgine when learning is enabled. The pass mines the coder session journal into procedural/open-subgoal facts, injects at most one `## Proactive Memory` context block before the next coding turn, and journals the same proactive-memory events into the coder session event log.

#### `agents.peers`
- **Params**: none (`{}`).
- Lists the agents this caller can send a peer message to.
- **Returns**: `{ self: string | null, peers: [{ name, address, reference, kind, source, can_receive, display_name, capability, last_seen_ms }], count: number }`.
  - `self` is the caller's own name — the address other agents use to reach it. The caller is **never** among `peers`; addressing yourself is an error, not a loopback.
  - `address` is the form to pass as `agents.message`'s `to`. It is the bare `name` unless two live peers share that name, in which case it is `name [reference]`. References are assigned only where a name is genuinely ambiguous, so ordinary addresses stay readable.
  - `kind` is `car_agent`, `external_cli`, or `remote_car`; `can_receive` is false for `external_cli`. CAR runs external CLIs as batch processes (the task goes in on stdin, which is closed immediately so the child sees EOF), so they can message CAR while running but have no inbox to deliver into.
  - `source` is `attached`, `invocation`, `parslee`, or `lan`. Local peers come from the daemon's **live connection table**, not the on-disk agent registry — the registry is observe-only self-report whose reap sweep tolerates a 900s stale window, so a listing built from it would offer agents that exited a quarter of an hour ago.
  - **Cross-host discovery** has two independent routes, complementary rather than redundant:
    - `parslee` — this user's other machines, each announcing its A2A endpoint on the **synced oplog** (`Registry { kind: "host_endpoint" }`, folding LWW per device id so a machine that moves overwrites its own entry). The oplog is end-to-end encrypted, so Parslee relays the bytes without being able to read the endpoints. This is why discovery rides the oplog instead of an address field on the sync roster: the roster would publish a per-device address to the service. Requires a login; empty without one.
    - `lan` — CAR daemons advertising `_car-a2a._tcp.local.` over mDNS. Needs no login but reaches only one broadcast domain. The peer-reachable URL travels in a TXT record rather than being rebuilt from the resolved IP and port, because an operator can pass `--a2a-public-url` to declare a URL that differs from the bound socket.
  - **A `lan` peer is listed but not addressable.** Anyone on a network can advertise any name, so discovery makes a peer *visible*, not reachable; `agents.message` refuses it with an error naming the remedy until an operator promotes it via `a2a.peers.add`. A promoted peer is reported under its trusted source instead, so it is not double-listed. Name collisions resolve toward the more *trusted* source, not the nearest one — a `parslee` device outranks a `lan` advertisement even though the LAN is the shorter path.
  - Cross-host delivery addresses the remote **daemon's** A2A surface, never one of its agents. That daemon applies its own guard and policy before reverse-calling a local agent, so a cross-host message passes two admissions — the sender's and the recipient's — and neither can be skipped. `PeerAddress` deliberately has no variant naming a remote agent.

#### `agents.message`
- **Params**: `{ to: string, body: string, summary?: string }`.
  - `to` is an `address` from `agents.peers`. `body` is plain text.
  - `summary` is a label for the **sender's** own transcript; it is not transmitted.
  - There is no `from`. The daemon derives the sender from the connection's bound `agent_id` (the same server-side principal stamped into approval audit records), so a caller cannot attribute a message to another agent and the audit trail cannot be forged.
- **Authorization**: the caller must be a bound agent or a host session; an unauthenticated connection is refused. A bound agent is then resolved against `AgentPermissionPolicy` at the **`read_only`** tier — honestly what a peer message is, since it mutates nothing on the recipient, reaches no executor, and grants no authority. The tier is resolved for the *sender*: the question is whether this agent may talk to other agents. Under the Balanced preset `read_only` is `always_allow`, so the default is permissive; the value is that setting a specific agent's `read_only` posture to `deny` actually stops its peer messages (`require_approval` holds them instead of dropping them), rather than the rule living only in a system prompt the agent may or may not follow.
- **Semantics**: a peer message is **inert data**. It is not a `proposal.submit` and cannot reach the executor; whatever the receiving agent decides to do about it passes through that agent's own gates unchanged. It cannot answer a pending permission prompt, and a slash command in the body arrives as text.
- **Delivery**: the daemon reverse-calls **`agent.peer_message`** `{ id, from, body, sent_at_ms, no_reply }` on the recipient's attached connection — the same mechanism `agents.chat` uses. There is deliberately no per-agent socket: a path that reached an agent without passing through the daemon would make admission advisory, since nothing would sit between sender and recipient.
- **Channel limits** (these bound the channel, not the sender's authority — two agents answering each other form a loop that no policy rule catches because neither is misbehaving):
  - Body cap ~1 MB serialized. Over it, send a path or a state handle instead.
  - Identical body from the same sender inside 10s is dropped as a repeat.
  - 20 messages per sender per recipient per 60s.
  - 50 undelivered messages queued per recipient.
  - Each limit returns a distinct error naming the remedy: batch for a rate limit, wait for a full queue.
- **Returns**: `{ id, to, outcome }` where `outcome` is:
  - `delivered` — the recipient acknowledged.
  - `unacknowledged` — the frame was written but no ack arrived within 5s. Reported honestly rather than as failure: an agent that does not implement `agent.peer_message` simply never answers, and the write did happen.
  - `held` — the recipient's configured posture stopped it; carries `reason` and `retained: true`. The message is kept for an operator decision — see `agents.message.pending` / `agents.message.approve` below.
  - A refusal is an error, not an outcome.
- **Audit**: every attempted delivery, refusals included, appends to `~/.car/peer-messages.jsonl`. `agents.chat` writes to the same journal — it has driven another agent's turn since it shipped with no audit record of any kind, and adding a governed sibling beside an unrecorded surface would only have moved well-behaved callers onto the audited path.

#### `agents.message.pending`
- **Params**: none (`{}`).
- **Authorization**: **host-only.** An agent must not be able to read, or later approve, the queue that exists to gate it.
- Lists peer messages held awaiting an operator decision, oldest first.
- **Returns**: `{ held: [{ id, from, to, body, held_at_ms, reason }], count, cap }`.
  - The queue is bounded at 100 undecided messages; past that the oldest is dropped, logged, and written to the audit journal as a refusal — a message the operator never saw must not vanish silently after the sender was told it was retained.
  - Held in memory only. A held message is a live decision awaiting a human, and one that outlived a daemon restart would be delivered into a world that had moved on.

#### `agents.message.approve`
- **Params**: `{ id: string, decision: boolean | string }`.
  - `decision` accepts a bool or a string (`"approve"`/`"approved"`/`"yes"` → approved; anything else, or omitted → denied). Same convention as `agents.chat.approve`, so an operator does not have to remember two.
- **Authorization**: **host-only**, as above.
- On approval the message is **re-admitted through the channel guard** before delivery. It passed the guard when it was sent, but time has moved and the recipient may since have been flooded; an approval authorizes the sender, it is not a licence to bypass the channel's limits. The identical-repeat window has long since expired for anything that sat awaiting a human, so this does not spuriously reject.
- **Returns**: `{ id, outcome }` — `denied`, or the same `{ id, to, outcome }` shape `agents.message` returns on delivery. Both paths append to `~/.car/peer-messages.jsonl`.
- The queue slot a held message occupied is released when it is held, not when it is decided: `QUEUE_CAP` bounds what a recipient has yet to read, `HOLD_CAP` bounds what an operator has yet to decide. Charging a held message against the delivery queue would let a slow human block a healthy channel.

#### `agents.chat.cancel`
- **Params**: `{ session_id: string }`.
- Best-effort cancellation. Attached supervised agents receive `agent.chat.cancel` so they can short-circuit their inference stream. In-daemon declarative agent sessions set a local cancellation flag and drop routing immediately; the runner stops at the next model/tool/goal-check boundary. Terminal for the session.

#### `agents.chat.approve`
- **Params**: `{ session_id: string, approval_id: string, decision: boolean | string }`.
  - Resolves an inline human-in-the-loop approval an agent raised via an `approval_pending` event (carrying `approval_id`). `session_id` selects the agent connection (same routing as `agents.chat`); the session is **kept** so the turn resumes after the decision.
  - `decision` is forwarded verbatim to the agent — a bool, or a string the agent accepts (`"approve"`/`"approved"`/`"yes"` → approved; anything else → denied). Omitted ⇒ denied.
- **Authorization**: the caller must be the host session that started the chat turn, or a host-management session authenticated with `session.auth { host_token }`. A supervised agent connection cannot approve its own parked action.
- **Returns**: `{ resolved: boolean, session_id: string }` — the daemon reverse-*requests* the agent's `agent.chat.approve` handler and relays its `{ resolved }` reply (bounded ack timeout), so the host gets a definitive answer rather than inferring from the stream.
- Distinct from `host.resolve_approval` (the permission-tier / `ApprovalLedger` flow): this resolves the agent's own ephemeral chat-turn gate. A host renders Approve/Deny on an `approval_pending` event and calls **this**; the parked turn then continues streaming.

#### `agents.list_external`
- **Params**: `{ include_health?: boolean }` — when `true`, also populates each spec's `health` field via the tool's auth-status command (slower; one subprocess per detected adapter). Default `false`.
- **Returns**: `[ExternalAgentSpec]` — cached snapshot of installed agentic CLIs (Claude Code, Codex, Gemini). Each entry carries `{id, display_name, binary_path, version?, auth_kind, capabilities, detected_at, health?, execution}`. `auth_kind` is **deprecated** (Phase 2 stage 1) — prefer `health` for ground-truth readiness.
- `execution` (car#746) answers a **different question** from `health`: *can this binary be executed at all*. `{"state":"runnable"}` or `{"state":"unusable","reason":"<names the path>","checked_at":<unix>}`. It is written by detection and **never revised by a health refresh**, whereas `health` is owned by refreshers that are free to rewrite it — which is why the executability verdict moved off `health.status`. Prefer it over `health.status == "not_executable"`, which is still emitted for one compatibility window. An absent `execution` (a pre-split daemon) reads as `runnable`. **Callers must not invoke a spec whose `execution.state` is `unusable`.**
- This is the discovery surface for the third kind of agent in CAR's taxonomy (sibling to lifecycle agents and in-process runners). See `docs/proposals/external-agent-detection.md`.

##### How `binary_path` is resolved

Resolution is executability-verified, not existence-based. In precedence order:

1. **Explicit pin** — `$CAR_<ADAPTER>_BIN` (`CAR_CODEX_BIN`, `CAR_CLAUDE_CODE_BIN`, `CAR_GEMINI_BIN`). When set, `$PATH` is not consulted. Use this for a CLI that ships inside an app bundle and was never on `$PATH` (ChatGPT.app vendors its own `codex`). A pin that doesn't resolve is reported as `not_executable` rather than silently falling back to `$PATH` — falling back would reintroduce exactly the ambiguity the pin removes. **The pin is process-local**: the daemon is launched by the GUI and inherits launchd's environment, so a `export` in a shell rc file is visible to `car` but *not* to the daemon that runs coder sessions.
2. **`$PATH` scan** — **every** match is collected in `$PATH` order (duplicate `$PATH` entries collapse), then each is probed with `--version` until one actually runs. A binary that resolves but cannot execute therefore **cannot shadow** a working one later on `$PATH`.

If no candidate runs, the adapter is still returned — omitting it would leave the user unable to find the broken install — but with `execution: {"state":"unusable", reason}` naming the path (and, for the compatibility window, `health.status: "not_executable"`). **Callers must not invoke a spec in that state.** The world-writable scratch-directory denylist (`/tmp`, `%TEMP%`, …) applies to the `$PATH` scan; an explicit pin bypasses it, since naming a path outright already requires a privilege that setting `PATH` itself would grant.

#### `agents.detect_external`
- **Params**: `{ include_health?: boolean }` — same as `agents.list_external` but always force-refreshes the presence cache (and the health-check TTL cache, when `include_health: true`).
- **Returns**: `[ExternalAgentSpec]` — same shape as `agents.list_external`. Use after the user installs / authenticates a new tool, or to refresh `health` after a login.

#### `agents.health_external`
- **Params**: `{ id?: string, force?: boolean }`
  - `id` selects a single adapter (`"claude-code"`, `"codex"`, `"gemini"`). Omit to check every detected adapter.
  - `force` bypasses the 30s per-tool TTL cache. Default `false`.
- **Returns**: `[ExternalAgentHealth]` (when `id` omitted) or `ExternalAgentHealth` (when `id` supplied). Each entry: `{id, status, details, reason?, checked_at}` where `status` is one of `ready | not_configured | expired | network_error | not_executable | unknown` and `details` is tool-specific structured JSON parsed from the auth-status output.
- `not_executable` is set by **detection**, not by an auth-status command — a binary the OS refuses to run cannot report its own auth state, so the status probe is skipped entirely rather than spawning a second doomed process whose `unknown` would overwrite the diagnosis. It means the *install* is broken (macOS Gatekeeper quarantine, architecture mismatch, dangling symlink into a relocated app bundle), not that the user is signed out: hosts should surface the `reason` and **not** offer a login flow. On macOS, `xattr -l <binary_path>` showing `com.apple.quarantine` confirms the common case.
- **Ground truth**, not heuristic: delegates to each tool's own status command (`claude auth status` returning structured JSON, `codex login status` returning a single status line, etc.). For Gemini, which doesn't expose a safe headless status command, falls back to credential-file shape inspection and surfaces that limitation in the `reason` field.
- **Replaces the Phase 1 `auth_kind` heuristic** as the primary signal for "is this tool ready to invoke." Existing callers reading `auth_kind` keep working; new callers should prefer `agents.health_external`. Phase 2 will demote `auth_kind` to optional and add a `health` field to `ExternalAgentSpec` carrying ground-truth status.

#### `agents.invoke_external`
- **Params**: `{ id: string, task: string, stream?: boolean, session_id?: string, cwd?: string, allowed_tools?: [string], max_turns?: number, timeout_secs?: number, mcp_endpoint?: string, attachments?: [{ path: string, media_type?: string }] }`
  - `id` selects the adapter (`"claude-code"` ships in Phase 2 stage 3; `"codex"` / `"gemini"` return a structured `is_error` until follow-up PRs land their JSON-stdio adapters).
  - `task` is the prompt the agent runs to completion.
  - `stream` opts into per-event streaming over the existing `agents.chat.event` channel (default `false`). When `true`, the method returns an ack (`{accepted, session_id}`) and the runner fans `agents.chat.event` notifications to the originating host as the child emits stream-json events — `kind: "token"` per text content block, `kind: "tool_call"` per `tool_use` block, terminal `kind: "done"` with metadata folded into `finish_reason` (or `kind: "error"`). All three adapters stream (car#213): `claude-code` forwards native stream-json events; `codex` synthesizes an Anthropic-Messages-shaped `Assistant` event per `item.completed` line (incremental `kind: "token"` / `"tool_call"` frames); `gemini` is text-only in 0.1.x (no event stream), so it emits one `Assistant` text event with the full reply on completion — a single-pop `kind: "token"` then the terminal `done`, not a token stream. Each `tool_call` frame carries the `tool` name + `params` (the `tool_use` input) per the shape pinned in `docs/host-protocol.md` (plus a legacy `detail` = name alias).
  - `session_id` is the host-generated id threaded through every event. Auto-generated when omitted. Reuses the same routing infrastructure as `agents.chat`; when `stream: true`, `agents.chat.cancel { session_id }` flips the runner's local cancel flag and drops the child-process future (`kill_on_drop` reaps the CLI).
  - `cwd` defaults to the daemon's working directory.
  - `allowed_tools` is passed through as `--allowed-tools "<list>"`. `[]` denies every tool (text-only response). Omit to use the binary's default policy.
  - `max_turns` caps model turns. Cost-control guard for runaway loops.
  - `timeout_secs` is the hard deadline. Defaults to 300s; clamped to [1, 3600].
  - `mcp_endpoint` is the MCP server URL the agent should load via `--mcp-config`. **Auto-filled from the daemon's bound `/mcp` URL when omitted** — so external agents transparently pick up CAR's tools (`memory_*`, `verify`, `skill_*`) routed through the daemon's policy + shared memgine. Pass `""` (empty string) to opt out (no `--mcp-config` injected; agent runs without CAR's MCP namespace).
  - `attachments` are images attached to the prompt, each `{ path, media_type? }` where `path` is an **absolute path on the daemon's filesystem** (external CLIs are local subprocesses, so images are passed by path, not base64). The runner hands each to the CLI in its native form: `claude-code` reads the bytes and inlines a base64 image block on stdin, `codex` passes each via `--image`, `gemini` references it with `@path` (staged into a temp dir first). The runner validates every path it reads/stages: files over 32 MB are skipped, and the `claude-code`/`gemini` paths verify the bytes are a real image by magic signature (PNG/JPEG/GIF/WebP) and derive `media_type` from the **content** — the supplied `media_type` is advisory, so a non-image file (e.g. a secret the path points at) is never inlined. Adapters advertise support via `capabilities.images` (`agents.list_external`); a CLI without image input ignores them. Unreadable / oversized / non-image paths are skipped.
- **Returns** (non-streaming): `InvokeResult { answer, session_id?, turns, tool_calls, duration_ms, total_cost_usd?, dropped_attachments?, is_error, error? }`. `total_cost_usd` is the would-be API cost — subscription users don't pay this; reported for transparency. `tool_calls` counts `tool_use` blocks the assistant emitted across all turns. `dropped_attachments` (omitted when 0) is the number of supplied images the runner couldn't send (unreadable / oversized / not a recognized image).
- **Returns** (streaming, `stream: true`): `{ accepted: true, session_id: string }`. The full InvokeResult is *not* in the reply — the daemon emits `agents.chat.event` notifications on the originating host's channel and writes the same `~/.car/external-agents.jsonl` audit record when the invocation completes. The terminal `kind: "done"` event carries `dropped_attachments` (and folds an "N image(s) skipped" note into `finish_reason`) when any attachment was dropped, so a streaming host can warn the user.
- **Cost note**: each invocation burns subscription quota. The runner doesn't gate cost; hosts should rate-limit.
- **Audit trail (stage 4a)**: every invocation appends one JSONL record to `~/.car/external-agents.jsonl` with `{ts, adapter_id, task, options, result}`. The `result` includes a full `tool_uses` list — every `tool_use` block the assistant emitted, in stream order, with id/name/input. Even though built-in tools execute in-process and aren't policy-gated through CAR yet, there's a complete after-the-fact audit trail.
- **Policy gating (stage 4b, future)**: full pre-execution gating of each `tool_use` requires invoking the agent through a CAR-managed MCP server, not the default stream-json route. That's deliberately deferred — observability + audit ship first.
- See `docs/proposals/external-agent-detection.md` for the full architecture and Phase 2 design notes.

### assistants

#### `assistants.invoke`
- **Params**: `{ capability: string, agent_hint?: string, payload_json: string }`
- **Returns**: `{ agent, result, run_id }`
- Daemon-owned invocation of a built-in ready-to-use assistant. Mirrors the UniFFI `invoke_capability` contract, but brackets the model call in the durable run-trace store so CarHost's Activity tab can explain what ran — which is the reason to prefer it over the UniFFI path from a host.
- `capability` selects the assistant through `AgentCapabilityRegistry` over the registered builtins; `agent_hint` breaks a tie when several satisfy it. An unsupported capability is an error, not a fallback. An empty `capability` is rejected.
- `payload_json` is the capability's own payload, passed as a **JSON string**, not an object.
- Runs with `prefer_fast`, and is capped at a hard **30s** timeout; expiry returns an error naming the timeout rather than a partial result.
- Every call records a run either way: success completes it `Success` with one turn carrying the prompt, capability, parsed payload, and output; failure records the error and terminates the run. `run_id` is how a host correlates the call with that trace.

### foreman

The Foreman pattern decomposes a coding goal into a footprint-annotated,
scheduled subtask plan, then (in a later surface) farms the plan out to external
coding CLIs in isolated git worktrees and verifies the integrated result. The
soundness boundary is the merge-verify gate; the footprint scheduler is advisory.
See `docs/proposals/verified-parallel-coding-orchestrator.md`.

#### `foreman.plan`
- **Params**: `{ goal: string, repo?: string, max_attempts?: number }`
  - `goal` is the natural-language coding objective to decompose.
  - `repo` is the repository root to plan against (used to ground symbol
    footprints). Defaults to the daemon's working directory.
  - `max_attempts` bounds the parse/conflict repair loop (default `3`). The
    planner regenerates on unparseable output, duplicate subtask ids, missing
    footprints, or two subtasks declaring the same write.
- **Returns**: `ForemanPlanReport { schema_version, valid, prefer_single_session, attempts, issues: [string], levels: [[string]], subtasks: [{ id, prompt, files: [string], writes: [{file, symbol}], reads: [{file, symbol}] }] }`.
  - `levels` and `prefer_single_session` are a **scheduling hint**, not a safety
    verdict — execution is still gated per-subtask and at the integrated union.
  - `subtasks[].writes`/`reads` carry only the **declared** footprint, never the
    scheduler's expanded blast radius.
  - `prefer_single_session` is `true` when farming out buys no parallel speedup
    (≤1 subtask, or every level is a single subtask).
- **Cost note**: runs one or more inference calls (the repair loop) against the
  daemon's configured model.
- **FFI**: `foremanPlan(goal, repo?, maxAttempts?)` (Node) / `foreman_plan(goal, repo=None, max_attempts=None)` (Python).

#### `foreman.run`
- **Params**: `{ goal: string, repo?: string, adapter?: string, verify_command?: [string], union_verify_command?: [string], max_attempts?: number }`
  - `adapter` selects the external coding CLI (`"claude-code"` default; `"codex"` / `"gemini"` as their adapters land).
  - `verify_command` is the **per-worktree regression** check — "does this one subtask's change compile / not break existing tests?" (e.g. `["cargo", "check"]`). A subtask implements only PART of the goal, so a goal-level test that needs every subtask must NOT run here, or it rejects each subtask.
  - `union_verify_command` is the **integrated-union goal** check — "does the merged result achieve the goal?" (e.g. `["cargo", "test"]`). **Falls back to `verify_command` when omitted**, so callers wanting one command for both set only `verify_command`. Omit both and the gate is `Inconclusive` (never accepts) unless a subtask is explicitly waived.
  - other params as for `foreman.plan`.
- **Returns**: `{ plan: ForemanPlanReport, mode: "parallel"|"single_session"|"regional_replan"|"parallel_then_single_session", ran: true, delivered: boolean, run: ForemanReport }`.
  - The pipeline **always runs**: when the plan decomposes it farms the subtasks out and verifies the integrated union (`mode: "parallel"`); when it does NOT decompose — the plan is invalid, or the planner found no parallelism worth it (coupled work) — it **falls back to a single whole-goal session** (`mode: "single_session"`). And if the plan *did* decompose but the integrated union was rejected, recovery (opt-in) prefers a **regional replan** when `run.integration.blame` localizes the failure to a proper subset of the accepted subtasks: it resumes from the clean (non-implicated) patches and completes the goal in one session, redoing only the failing region while preserving the successful parallel work (`mode: "regional_replan"`). When the failure can't be localized (it implicates everything, e.g. a build failure naming no known file) or the regional attempt doesn't deliver, it **re-runs the whole goal as one session** (`mode: "parallel_then_single_session"`). The failed parallel attempt is retained in `run.integration` either way. It never just gives up, so `ran` is always `true`.
  - `delivered` is `true` when the result is sound: the integrated union was accepted (parallel) or the single session was accepted (fallback).
  - `run` is the execution report: `{ schema_version, subtasks: [{ id, verdict?, error? }], integration?: { applied, apply_conflicts, integrated_cleanly, verdict?, blame? } }` (one subtask, no `integration`, in single-session mode). Each `verdict` is `{ outcome: "accepted"|"rejected"|"inconclusive", ... }` with structured `evidence` (containment violations, semantic conflicts, typed `build_test`, policy). Use `outcome == "accepted"` as the only accepting state (forward-compat `"unknown"` is non-accepting).
  - `integration.blame` is present **only when the union did not integrate cleanly** — structured attribution of *why*, for a UI ("why did this run fail") or a future regional replan: `{ apply_conflicts: [{ subtask_id, files, detail }], duplicate_conflicts: [{ file, symbol, candidate_subtask_ids }], build_test?: { code?, output_tail, candidate_subtask_ids } }`. `apply_conflicts.subtask_id` is the patch that failed to apply (definitive) plus the files involved; `duplicate_conflicts.candidate_subtask_ids` are the subtasks whose patches touched the offending file (candidates, not proven culprits — attribution is file-granular); `build_test` is the union goal-check failure with `candidate_subtask_ids` = the whole integrated set (a build failure isn't localized further — mapping a failing test back to a symbol is not done here — so the retry region is all of them).
- **Cost note**: farms each subtask to a real external CLI — **burns subscription/API quota** and can run for minutes. Hosts should rate-limit.
- **FFI**: `foremanRun(goal, repo?, adapter?, verifyCommand?, unionVerifyCommand?, maxAttempts?)` (Node) / `foreman_run(goal, repo=None, adapter=None, verify_command=None, union_verify_command=None, max_attempts=None)` (Python).

### coder

The built-in coding agent. The user states an intent; the daemon turns it
into a **verifiable outcome contract** (shell commands that must pass),
provisions a throwaway **git worktree** of the repo (under `~/.car/coder/`,
never inside the user's checkout), and works until the contract is green —
natively (CAR inference + policy-gated tools) or by delegating to a detected
external CLI (Claude Code / Codex / Gemini) — either as a single session or
through **foreman** (the verified parallel orchestrator, see the `foreman`
namespace above): decompose, farm subtasks to the CLI in parallel worktrees,
gate each patch + the integrated union, then land the verified union in the
session worktree. Auto routing is foreman-first for broad tasks; the fallback
ladder is foreman → single-session external → native (foreman declines
cleanly on `prefer_single_session`, an invalid plan, or a rejected gate; a
red contract after foreman's union falls to the native loop, which repairs
*on top of* the applied work). Whichever engine ran, **CAR re-evaluates the
contract itself** before asking for merge approval. Approved results are
published as a `car/coder/<short-id>` branch in the user's repo; the user's
checkout, index, and refs are otherwise untouched. Session snapshots persist
at `~/.car/coder/<session_id>.json`; an audit event journal sits alongside as
`<session_id>.events.jsonl`.

**Security model** — read before extending. The native engine's `shell` tool
executes on the **host** with the daemon's privileges and (deliberately) the
real toolchain + network. An inspector chain (native engine only — the
governed assistant in `assistant/governance.rs` keeps its own, wider chain)
denies the unambiguous footguns (`git push`/remote mutation, history rewrite,
`sudo`/`doas`/service managers, destructive ops and writes outside the
worktree, credential-path reads) and every route that would publish the work
around the merge gate: the forge CLIs (`gh`, `glab`, `hub`) are reduced to a
read-only allowlist — `pr view`/`list`/`diff`/`checks`, `run view`/`list`,
`issue list`, `gh api` GET, `auth status` — so `gh pr create`, `gh pr merge`,
`gh release create` and `gh auth token` come back as denials, and
`npm`/`cargo publish`, `gem push`, `twine upload`, `docker push`/`login` are
denied alongside them. The executor pins the working directory to the worktree — but this is policy
hardening, **not a sandbox**: a model can still e.g. pipe curl to sh inside
the worktree. The hard stops are the two human gates: `coder.confirm_contract`
before any work starts and `coder.approve_merge` before anything reaches the
repo. For the **external** and **foreman** engines, the coder threads the
daemon's bound MCP URL into the delegated CLI: its **CAR-namespace** tool calls
(`memory_*`, `verify`, `skill_*`) route back through the daemon's policy +
shared memgine — gated and audited — exactly like a direct `agents.invoke_external`
call. The residual limitation is narrower than before: the CLI's own **built-in**
tools (Edit, Bash, …) still run with the CLI's permissions inside the worktree
(external-agents stage 4b is pending), so the pinned cwd, the independent
contract re-evaluation, and the merge gate remain the containment for those.
When the daemon has no MCP listener (`--mcp-bind disabled`), CAR-namespace
calls degrade to ungoverned and delegation continues unchanged. Adapter caveat:
MCP injection currently covers the **claude-code** and **codex** adapters; the
**gemini** adapter does not yet support `--mcp-config`, so a Gemini-backed
external/foreman session runs with the CLI's built-in tools only and no
CAR-namespace tools — contained by the same pinned cwd + contract re-eval +
merge gate as the built-in tools.

State machine: `created → contract_proposed → contract_confirmed → running →
needs_approval → merged`, with `failed` / `abandoned` reachable from any
non-terminal state (`coder.cancel` → `abandoned`).

There is a second, non-failure terminal: **`reported`**. It means the session
concluded that *no code should change* and the runtime accepted that — a correct
outcome with no diff, rather than a loss. Reaching it requires a contract the
session's own model did not author (operator-supplied, human-confirmed, or
runtime-generated) whose every check already passed against the untouched
worktree. A conclusion that needs human judgement instead parks at
`needs_approval` and is never auto-promoted.

**The daemon does not yet produce `reported` itself** — only `car code-task`
does. It still appears on this surface, because a CLI-run session persists its
snapshot under the same `~/.car/coder` state root the daemon merges into
`coder.list`, so a client must already tolerate the value. The daemon-side gate
for accepting or rejecting a parked finding is not implemented; until it lands,
a `needs_approval` session on this wire is always a merge gate. The worktree is removed on
terminal transitions (unless `keep_workspace_on_failure` is set — see below —
in which case a `failed` session's worktree is retained for postmortem).

**Operator config (`~/.car/coder.toml`)** — an optional, tolerant TOML file the
operator can drop next to the coder state dir to tune three knobs. A missing
file, a missing `[coder]` table, or any missing/empty/zero key falls back to
the documented default; a malformed file is logged and treated as absent (the
daemon never fails to boot over it). `CAR_CODER_CONFIG` overrides the path (for
tests/embedders), mirroring `CAR_CODER_STATE_DIR`.

```toml
[coder]
engine_preference = ["claude-code", "codex", "gemini"]  # external/foreman delegation order
keep_workspace_on_failure = false                        # keep the worktree for postmortem
default_max_iterations = 8                               # coder.start fallback when max_iterations omitted
```

- `engine_preference` — the order in which a *ready* external CLI is chosen for
  `auto` / `external` / `foreman` routing; the first ready entry wins (a ready
  CLI outside the list still beats nothing). An empty list falls back to the
  built-in `["claude-code", "codex", "gemini"]`.
- `keep_workspace_on_failure` — when `true`, a session ending `failed` keeps its
  throwaway git worktree on disk (the RAII reap is suppressed) and emits a
  `coder.event` error noting the retained path; `coder.get` still reports
  `workspace_path`. Default `false` (reap, same as every other terminal state).
- `default_max_iterations` — the iteration cap `coder.start` uses when the
  request omits `max_iterations`. Default `8`; a value of `0` is ignored.

#### `coder.start`
- **Params**: `{ repo?: string, project?: string, intent: string, engine?: "auto"|"native"|"external[:<agent_id>]"|"foreman[:<agent_id>]", max_iterations?: number, model?: string, repair_invokes?: number, transient_retries?: number, discussion_id?: string }` — **exactly one of `repo` (a raw git path) or `project` (a managed-project slug)**. A `project` session delivers to the project's `main` on approve (no `car/coder/<id>` branch); an `agent`-kind project synthesizes a scenario contract and runs the coder→agent build loop. (`engine` defaults to `auto`; `max_iterations` defaults to `~/.car/coder.toml`'s `default_max_iterations`, then `8`). `model` pins the inference model for this session (e.g. `"parslee/reasoning"` for gpt-5.5), overriding `~/.car/coder.toml`'s `model`; blank/omitted = the config default, then adaptive routing. The pin applies to **whichever engine runs the session**: the native loop reasons on it, and an `external:<agent_id>` session passes it to the CLI (`codex -m`, `claude --model`, `gemini -m`). It previously reached only the native loop, so `--engine external:codex --model X` silently ran codex on its own configured default — which left the paired A/B's "both arms on the same backbone" invariant an unverified assumption rather than something the runtime enforced. The pin reaches the daemon-run coder over the wire, so a paired A/B (`car coder-ab`) can put both arms on one backbone without the daemon needing the pin in its own environment. `repair_invokes` and `transient_retries` tune the **external** engine's two budgets, both defaulting to the engine's own values: `repair_invokes` is the *hypothesis* budget (fresh repair invocations after a red pass — recurrence escalation needs >= 2 to reach the model at all, since round 1 establishes a failure signature, round 2 is the first that can repeat it, and round 3 the first that can be told), while `transient_retries` is the *availability* budget (re-invocations after the CLI process itself died mid-run). They are deliberately separate counters: sharing one lets a single flaky timeout consume a replan the coder needed for an actual hypothesis.
- **Returns**: `{ session_id, state: "contract_proposed", engine, worktree, contract: { description, checks: [{ name, command, expect_exit_zero, output_contains?, timeout_secs }] }, baseline, baseline_gates_nothing, journal_path, model }` — `journal_path` is the `car_eventlog` JSONL this session journals its actions to (per-tool `action_id`, `ActionFailed`/`TurnCompleted`/…), so a caller (e.g. `car coder-ab`) can attribute the run's failure mechanisms via `harness_adapt::diagnose` without guessing the state dir. `model` is the **effective** native-loop pin (the per-session request, else the config, else `null` = adaptive routing) — surfaced so a caller can verify the coder is on the intended backbone rather than silently falling back to a local model.
- **Red-green baseline** (car#707): before returning, the contract is evaluated once against the **unmodified** worktree. `baseline` is a `CheckResult[]` in check order, and `baseline_gates_nothing` is true when *every* check already passed — meaning the contract verifies nothing for this task and there is nothing to turn red-to-green. Only an all-green baseline sets the flag: individual passing checks are ordinary (a refactor's checks are green before and after by design), so flagging one would abort sessions over a non-fault. `validate()` already rejects contracts that gate nothing *structurally* (assertion-less checks, toolchain-only no-ops); this catches the semantic case that clears validation. Skipped for `agent`-kind projects, whose synthesized check is an in-daemon scenario run rather than a shell command. Costs one contract evaluation, bounded by the checks' own `timeout_secs`. The same results are pushed as a `coder.contract_baseline` event. The baseline is a vacuity check, not a captured measurement a later evaluation compares against — every evaluation point sits before delivery, and none of them receives the baseline results, so a before/after claim about a live system is not expressible in a contract even though an individual check may reach one. See "What a contract cannot assert" in [`docs/car-code-task.md`](car-code-task.md).
- **Visible while drafting.** The session is registered at `created` **before**
  contract derivation begins, so it appears in `coder.list` / `coder.watch` (and
  fans out a `coder.session_changed`) for the whole 3-5 minute drafting window,
  with `needs_you: null` — nothing is being asked of the operator yet. It is
  also **cancellable** there: `coder.cancel` aborts the derivation, reaps the
  worktree, and lands the session at `abandoned`, and the abandon sticks (the
  contract is never proposed into existence afterwards, and no
  `contract_proposed` reaches a subscriber). `coder.start`'s own return shape
  and timing are unchanged — it still returns after drafting with the same keys;
  this is purely additive visibility. Previously the session was registered only
  once drafting finished, so it existed on disk but was absent from the wire:
  unaddressable, uncancellable, and invisible to every other client.
- **Survives the calling connection.** `coder.start` runs on a daemon-owned
  task, not on the connection that asked for it. Every other method is
  dispatched on a per-connection task set that is aborted the moment the
  WebSocket closes; for `coder.start` that was wrong, because the session is
  registered and its worktree provisioned *before* the multi-minute contract
  derivation — so a client that disconnected while drafting left a `created`
  session row, a provisioned worktree, no contract and no driver until the
  daemon restarted. Disconnecting now abandons only your own response: the
  derivation, the red-green baseline and the transition to `contract_proposed`
  all complete, and any client can pick the session up from `coder.list` /
  `coder.watch`. A connection that stays open sees the same response at the
  same time as before. The only supported way to stop a drafting session
  remains `coder.cancel`.
- Provisions the worktree, resolves the engine (auto = complexity assessment + detected-CLI preference, default claude-code → codex → gemini but overridable via `~/.car/coder.toml`'s `engine_preference`, delegating foreman-first for broad tasks), and derives the contract with a bounded model repair loop. Foreman's gates split regression vs goal (#275): each subtask worktree runs a build-system regression check detected from the repo (`cargo check` / `go build ./...` / `swift build`; unknown build systems decline to single-session), while the integrated union runs the contract's plain exit-zero checks as the goal leg (`sh -lc "<check> && …"`). Output-substring checks are enforced only by the coder's final contract evaluation. Synchronous — expect seconds while the model drafts the contract.

#### `coder.confirm_contract`
- **Params**: `{ session_id: string, contract?: OutcomeContract }` — pass `contract` to replace the proposal with a user-edited version (validated before acceptance).
- **Returns**: `{ state: "running" }`
- The first human gate. Spawns the work loop; progress streams as `coder.event`.

#### `coder.list`
- **Params**: `{}`
- **Returns**: `{ sessions: [session_summary] }` — live sessions plus persisted snapshots from prior daemon lifetimes (`live: false`), newest first.

##### `session_summary`

The row shape shared by `coder.list`, `coder.watch`, and the
`coder.session_changed` notification. Every pre-existing key keeps its name and
type; the rest is additive.

```jsonc
{
  // --- existing ---
  "session_id": "coder-…", "state": "running", "intent": "…", "repo": "/abs/path",
  "engine": "native", "iterations": 3, "updated_at": 1781234567, "live": true, "error": null,
  // `iterations` tracks the run live (the last `iteration_started.n`) and settles
  // to the loop's final count when it finishes — it previously read 0 until then.

  // --- what the session is waiting on a human for ---
  "needs_you": "contract" | "question" | "approval" | "auth" | null,
  "needs_you_label": "contract awaiting confirmation" | "question waiting"
                   | "diff ready for approval" | "sign-in needed" | null,
  "question_prompt": "…" | null,      // set iff needs_you == "question"
  "auth_message": "…" | null,         // set iff needs_you == "auth"
  "auth_wait_secs": 120 | null,       // set iff needs_you == "auth"

  // --- outcome + provenance ---
  "failure_kind": "budget_exhausted" | "auth_required" | "infrastructure" | "error" | null,
                                      // set iff state == "failed"
  "worktree": "/abs/path" | null,     // only when the directory still exists on disk
  "project": "slug" | null,
  "result_branch": "car/coder/ab12cd34" | null,
  "model": "…" | null,
  "discussion_id": "disc-…" | null,
  "next_seq": 42 | null               // live sessions only; the coder.subscribe cursor
}
```

`needs_you` is **always `null` for a non-live session** (`live: false`), even a
`needs_approval` snapshot preserved across a daemon restart. Such a session is
genuinely not approvable — `coder.approve_merge` requires a live registry entry,
which orphan adoption deliberately does not rehydrate — so advertising it as
actionable lit up a board row whose action returned a protocol error. A board
renders those from `state` plus the retained `worktree` path, and
`coder.approve_merge` / `coder.cancel` on one answer with the already-happened
wording (naming the surviving worktree so it can be merged by hand).

For a live session `needs_you` is derived **server-side** by one function, and
`needs_you_label` is a fixed daemon-owned string — the same precedent as `diff_ready`'s
`overlap_disclosure`, so two clients can never say different words about the
same state:

| value | condition |
|---|---|
| `"contract"` | `state == contract_proposed` |
| `"approval"` | `state == needs_approval` |
| `"question"` | `state == running` AND a mid-session question is parked on the input gate |
| `"auth"` | `state == running` AND an `auth_required` event is the latest unresolved auth event (cleared by any subsequent event) |
| `null` | otherwise |

`failure_kind` is `"budget_exhausted"` when the session hit its wall-clock
ceiling, `"auth_required"` when it ended waiting on a sign-in nobody supplied —
**or** when contract DERIVATION or REVISION died on a rejected credential, which
does not wait at all (`coder.start` and `coder.revise_contract` are synchronous
RPCs the client is blocked on, so they emit `auth_required` with `wait_secs: 0`
and end rather than hold the call open). A run loop with no auth gate — the
default adaptive-routing path — is the one case that emits `auth_required` and
still ends `"infrastructure"`: it does not wait, so the strikes run out
normally. Read the **event**, not `failure_kind`, to decide whether to show a
sign-in prompt.
`"infrastructure"` is used when the machinery failed rather than the work (the
worker
could not be started or never received the task, the backbone stopped
answering, the outcome contract could not even be derived for any reason other
than a rejected credential, or a **daemon
restart** adopted the session while it was still mid-flight — the most common
of the four), and `"error"`
otherwise — i.e. the work ran and was judged red.

`"infrastructure"` is the one to check before reading a failure as a result: no
check ever passed judgement on the task, so a scorer must exclude it rather than
count it as a loss. It exists as its own value because the alternative — folding
it into `"error"` — leaves consumers recovering the distinction by matching the
runtime's error prose, which only recognises failure modes somebody already met.
One such prose scan silently recorded 18 sessions that died in seconds on a
backbone that could not make structured tool calls as genuine task failures, and
while the kinds stay collapsed the
next unfamiliar error string reads the same way. `"auth_required"` outranks it:
both mean nothing was attempted, but only one is fixed by asking a human.

`failure_kind`, `needs_you`, `worktree`, `result_branch`,
`project`, `model` and `discussion_id` are all **persisted on the session
snapshot**, so a summary read after a daemon restart still carries them —
otherwise the distinction between "ran out of clock", "nobody signed in", "the
machinery broke" and "the work was judged red" would go blank exactly when the
operator comes back to look. `worktree` is reported only when the directory
still exists (the
`keep_workspace_on_failure` / preserved-orphan cases): a path whose tree was
reaped is a snapshot detail, not a place to send someone.

#### `coder.watch` / `coder.unwatch`
- **Params**: `{ renew?: boolean }` (default `false`) / `{}`
- **Returns**: `{ sessions: [session_summary] }` (newest `updated_at` first) — or,
  when `renew: true`, `{ was_registered: boolean }` / `{ ok: true }`
- The board's **one** subscription. `coder.subscribe` is per-session, which is
  exactly what a board cannot use: it has to learn about sessions started by
  *any* client (`car code`, CarHost, milo) without polling and without
  restarting. `coder.watch` answers with the current full list **and** registers
  the caller for change notifications, atomically — registration happens under
  the same `coder_sessions` lock the snapshot is taken under, so a session
  created between the two cannot slip through the gap and go unrendered until
  some later unrelated change.
- Watchers are keyed by `client_id` and dropped on disconnect, exactly like
  `coder.subscribe`rs. **Lock order:** a session's `events` buffer →
  `coder_subscribers` → `coder_watchers`; never the reverse.
- **Idempotent, and meant to be re-called on a timer.** Registration is keyed by
  `client_id`, so a second call is a no-op on the registration and answers with
  a fresh snapshot. Because a shed is silent and the connection survives it (see
  `coder.session_changed` below), a client with no periodic re-watch can render
  a permanently frozen list with nothing on the wire to tell it — the reference
  board renews every **4 s**.
- **Renew on the timer, not the full call.** `{ renew: true }` re-registers
  idempotently and returns `{ was_registered }` and nothing else: `true` if a
  live registration was already present, `false` if this call had to create one
  — i.e. the client had been shed or dropped and has missed changes, so it
  should follow up with a default `coder.watch` to resync. A renewal builds **no
  summaries**, which is the point: the default call lists every persisted
  session from disk, and that scan grows with accumulated history rather than
  with what is live. A daemon predating `renew` ignores the unknown param and
  answers with the full list — clients should treat a missing `was_registered`
  as "old daemon, this reply is the snapshot".
- Each registration is stamped internally, so a registration **created** while a
  shed is timing out on a previous one (an unwatch/reconnect) is not removed by
  that shed's cleanup. A bare re-watch or renewal from a connection that already
  has a live registration keeps that registration's stamp — deliberately: with a
  new stamp per call, a client renewing faster than the 10 s write deadline
  could never be shed at all.

#### `coder.session_changed` (notification)
- **Payload**: `{ summary: session_summary }`
- Pushed to every `coder.watch`er when a session is created, changes `state`,
  changes `needs_you`, changes `error`, or reaches a terminal state. Emitted
  **synchronously from the event path, never from a poller**, so an
  operator-attention transition reaches an open board in well under 5 s. Two
  boards — one open the whole time, one that just called `coder.watch` —
  converge to the same list.
- Fanned out on **one** daemon-wide drain, coalesced per session, so a board
  that stops reading cannot slow the others down. A watcher whose socket does
  not take a frame within **10 s** is **deregistered** — its
  `coder.session_changed` stream ends and it must call `coder.watch` again to
  resume (which also re-answers with the full current list).

#### `coder.revise_contract`
- **Params**: `{ session_id: string, request: string }` — `request` is plain English, e.g. `"also verify the Windows path"`.
- **Returns**: `{ state: "contract_proposed", revised: boolean, contract: OutcomeContract, baseline: CheckResult[], baseline_gates_nothing: boolean, message: string | null }`
- `CheckResult` is `{ name, passed, exit_code: number | null, output_tail, duration_ms, timed_out, deadline_clamped }`. The last two are additive and optional (default `false`) — see `coder.check_completed` below for what they mean and why a starved check is not a red verdict.
- Redrafts a **proposed** contract from the operator's reply instead of making
  them hand-edit JSON or reject and start over. Legal **only** in
  `contract_proposed`; any other state returns the already-happened error below.
  **Nothing executes** — the session stays at the gate awaiting a fresh
  confirm/reject either way. **Unlimited rounds**; there is no principled cap,
  since each round costs one derivation and the alternative (reject and restart)
  costs strictly more.
- On success: `revised: true`, a re-run red-green `baseline` for the new checks,
  and fresh `contract_proposed` + `contract_baseline` events so **every**
  subscribed client re-renders the new draft and cannot confirm the stale one.
- On failure to honor (the redraft does not validate, or the request is not
  expressible as checks): `revised: false`, the previously drafted contract
  returned **byte-identical** together with **its own stored `baseline` and
  `baseline_gates_nothing`**, `message` explaining why, and a
  `contract_revision_rejected { request, reason }` event. A revision that
  silently passed as applied would let an operator confirm a contract they
  believe says something it does not — the one outcome this must never produce,
  so read `revised` before trusting `contract`. The baseline is returned rather
  than blanked because a board renders it beside the contract: an empty
  `baseline` would read as a change to the very draft this reply promises is
  unchanged. (The baseline is persisted on the session snapshot for exactly this
  reason, and moves with the contract it describes on every successful
  revision.)
- "Expressible as checks" is judged on the **checks alone**. A redraft that
  changes only `description` gates nothing new, so it comes back
  `revised: false` — restating an unverifiable requirement in prose is exactly
  the case this rejection exists for. `output_contains` is compared
  byte-for-byte, so tightening `"0 failures"` to `" 0 failures "` (so it can no
  longer match `"10 failures"`) *is* a revision.
- **Two revisions racing**: the write is conditional on the stored contract
  still being the one this redraft was derived from. If another revision landed
  first, this one is **not applied** and returns `revised: false` with the
  **current** contract and baseline plus a `message` beginning `another revision
  of this contract landed while yours was being drafted` — re-read it and revise
  again if you still need your change. Both revisions previously reported
  `revised: true` and the second silently discarded the first.

#### Already-happened errors (confirm / approve / revise)

Acting on a session that is past (or not yet at) the gate returns a JSON-RPC
error whose `message` names what already happened and the current state — never
a panic, never a silent `{ok: true}`:

- `contract already confirmed for coder-ab12cd34 (state: running)`
- `coder-ab12cd34 was already merged — nothing left to approve`
- `coder-ab12cd34 was already merged — nothing left to revise`
- `coder-ab12cd34 is not ready to approve yet (state: running, expected needs_approval)`

These three are exactly the gates a second operator can wrongly believe they
just passed — two boards racing on one session is the normal case now, and a
bare success for "confirm this contract" or "approve this merge" would tell them
their decision took effect when it did not.

**`coder.cancel` is deliberately excluded** and reports the same information
without erroring — see its section below. Cancelling a stopped session is the
outcome the caller wanted, and `car code`'s one-shot Ctrl-C path calls it
unconditionally, so making it an error would change the frozen one-shot flow.
Every pre-existing `coder.*` method keeps its parameters **and its return
shapes**; the already-happened information arrives in additive keys there.

#### `coder.get`
- **Params**: `{ session_id: string }`
- **Returns**: the full session snapshot (contract, `last_check_results`, `workspace_path`, `result_branch?`, `error?`, `live`, `next_seq` when live).

#### `coder.subscribe` / `coder.unsubscribe`
- **Params**: `{ session_id: string, from_seq?: number }` / `{ session_id: string }`
- **Returns**: `{ state, events_replayed, live, replay_available }` / `{ ok: true }`
- A session that is **not live but has a persisted snapshot** (the daemon
  restarted under it) succeeds with `{ state, events_replayed: 0, live: false,
  replay_available: false }` rather than erroring. Erroring made every
  pre-restart session unopenable from a board — precisely when an operator goes
  looking for it. There is no event history for those sessions (full pre-restart
  replay is deferred), and the reply says so instead of implying an empty stream
  is the whole stream. Only an id with neither a live entry nor a snapshot is an
  error. `coder.unsubscribe` on a non-live session is a no-op returning
  `{ ok: true }`.
**`coder.diff_ready` payload** (car#706): `{ stat, patch, patch_truncated: boolean, patch_full_bytes: number, changed_paths: number, overlap_disclosure: string | null, contract_overlap: [{ check, paths }] }`. `stat` is the full `git diff --cached --stat`, never truncated. `patch` is tail-capped to `~/.car/coder.toml`'s `approval_patch_bytes` (default 512 KB, previously a hardcoded 32 KB), and `patch_truncated` says so as a field rather than only via the `…[truncated]…` marker inside the string — a reviewer must be able to tell they are approving against a partial diff without string-matching. `changed_paths` counts every path the diff touches, including BOTH endpoints of a rename — one moved file is two paths, because a file moved out of a directory is a change to that directory, and reporting only the destination made a rename look like a creation. `overlap_disclosure` is the rendered sentence, or `null` when nothing overlaps; it is on the wire so every surface prints the same words rather than hand-rolling copies that drift. `contract_overlap` lists contract checks whose commands execute a path this diff modified: **disclosure, never denial**, since editing tests is frequently the task and `coder::policy` deliberately does not block test-adjacent edits. Path extraction from a shell command is heuristic and biased toward flagging — a false positive costs one line a human dismisses, a false negative silently restores the gap.

- Subscribes this connection to the session's `coder.event` stream. Buffered events with `seq >= from_seq` are replayed before live delivery (no gap, no dup), so a reconnecting client resumes from its cursor. Subscriptions are per-connection and dropped on disconnect; the session keeps running.

#### `coder.respond`
- **Params**: `{ session_id: string, text: string }`
- **Returns**: `{ ok: true }` when a pending request was fulfilled; errors with "no pending user-input request for this session" when nothing is waiting.
- Answers a mid-session `user_input_requested` event. The **native** loop can call an `ask_user` tool (offered to the model only when it genuinely cannot proceed without a user decision); the loop emits `user_input_requested { prompt }` and blocks until either `coder.respond` supplies `text` or a 600s timeout elapses (on timeout the model receives a tool error and continues). `coder.cancel` unblocks a waiting request immediately. The external/foreman CLIs own their own interaction model and do not surface this event.

#### `coder.approve_merge`
- **Params**: `{ session_id: string, approve: bool }`
- **Returns**: `{ state: "merged", branch }` on approve; `{ state: "abandoned" }` on deny.
- The second human gate, valid only in `needs_approval`. Approve squash-commits the worktree (author `car-coder`) and creates `car/coder/<short-id>` in the repo — merge with `git merge <branch>`; fully reversible via `git branch -D`.

#### `coder.cancel`
- **Params**: `{ session_id: string }`
- **Returns**: `{ state: "abandoned", already_terminal: false, message: null }`
- Flags the loop, aborts its task (in-flight shell processes are killed), abandons the session, removes the worktree. Valid from any non-terminal state. Note: an in-flight **external** CLI invocation cannot be killed mid-run yet (same limitation as `agents.chat`); its own timeout bounds the wait.
- Cancelling an **already-terminal** session **succeeds** — same `state` key, same
  type — with `already_terminal: true` and an operator-readable `message`, e.g.
  `{ state: "merged", already_terminal: true, message: "coder-ab12cd34 was already merged — nothing left to cancel" }`.
  Deliberately not an error, unlike the confirm/approve/revise gates below, for
  two reasons: `car code`'s one-shot Ctrl-C path calls `coder.cancel`
  unconditionally, so a session that raced to terminal first would turn a quiet
  exit into a protocol error; and "stop this" on a session that already stopped
  is the outcome the caller wanted, so the honest answer is "yes, it's stopped,
  and here is why nothing happened just now". The `state` key and its type are
  unchanged for every input — the two new keys are purely additive.

#### `coder.discuss.*`

A repo-grounded, strictly **read-only** conversation that can be distilled into
a run intent. The gap it closes: `coder.start` demands a well-formed intent
before anything exists to react to, so an operator still working out *what* they
want either guesses (and burns a session on a badly-aimed contract) or goes and
thinks somewhere without the repo in front of them.

Grounding reuses the same `AssistantService` that backs `car do`, bound with
`bind_default_substrate(prefer_local = true, full_access = false, repo, None)` —
`PermissionTier::ReadOnly`, where every write and every shell escalates to an
approval gate. **This surface auto-DENIES those escalations** rather than
prompting: a discussion is a thinking surface, and the one property that must
hold unconditionally is that it never touches the repo. The refusal is visible
as a `tool_result { ok: false }` rather than silent. `coder.start` is the only
thing that starts work.

Discussions are **in-memory only** and do not survive a daemon restart: the model
thread, the bound runtime and the substrate are process-local, and persisting the
transcript alone would resume a conversation whose grounding no longer exists.
They are also **owned by the connection that opened them** — closing that
connection closes the discussion and cancels any in-flight turn, because a
detached turn keeps billing model tokens to nobody. Bounded four ways: at most
**8 open discussions** per daemon (a slot is reserved before the runtime is
built, so pipelined starts cannot exceed it), a **1-hour idle TTL** reaped on the
next `coder.discuss.start`, per-discussion caps on the replay buffer (2000
events, oldest dropped) and the distillation transcript (40 turns retained, the
most recent 12 handed to `promote`), and a **64 KiB cap on one `send`**.

**Ownership is enforced, not merely recorded.** `send`, `subscribe`, `promote`,
`close` and `coder.start { discussion_id }` all refuse a caller that is not the
opening connection, with
`discussion '<id>' belongs to another connection — a discussion is owned by the
connection that opened it and closes with it; start your own with
coder.discuss.start`. `coder.discuss.list` returns only the caller's own
discussions. Resolving by id alone let any connected client drive — or close
mid-turn — a discussion it did not open.

**One wedged subscriber cannot stall a discussion.** Each subscriber owns a
bounded outbound queue drained by its own task, so the discussion's event drain
never awaits a socket: a subscriber that stops reading (queue full, or a write
that does not complete within 10s) is **dropped from the fanout**, and its
`coder.discuss.event` stream simply ends. Re-`subscribe` with `from_seq` to
resume. The turn itself is unaffected either way.

**Read scope.** As well as auto-denying every write/shell escalation, the
discussion's bound environment pins the read tools (`read_file`, `list_dir`,
`find_files`, `grep_files`) inside the repo root. Mutation-gating alone left
those pointed at the whole filesystem, and their output streams to every
subscriber — so a prompt-injected repo file could ask for
`grep_files {"path":"/Users/<user>","pattern":"sk-ant-"}` and exfiltrate the
hits. Scoped to this surface; the general assistant's read reach is unchanged.

- `coder.discuss.start` — **Params** `{ repo: string }`. **Returns**
  `{ discussion_id: "disc-…", repo, repo_summary }`. A non-git path errors with
  `"<path> is not a git repository — discuss needs a repo to ground itself in"`
  (the same git check `coder.start` uses).
- `coder.discuss.send` — **Params** `{ discussion_id, text }`. **Returns**
  `{ ok: true, seq }`, where `seq` is the sequence number of the FIRST event
  this turn emits (the `user_message`), so a caller that has not yet subscribed
  can resume from exactly there without missing or replaying a frame. The reply
  streams as `coder.discuss.event`.
  **Returns as soon as the turn is dispatched** — it never waits on the model,
  and it never waits on a subscriber's socket, so a stalled board cannot delay
  it. **One turn at a time.** A `send` arriving while a turn is in flight is
  **refused** with `<id> is still answering the previous message — wait for
  \`turn_complete\` before sending another`, not queued: two overlapping turns
  clone the same model thread and the last to finish overwrites the other, so
  an exchange would vanish from the conversation *and* from what `promote`
  later distills. Wait for `turn_complete`. That in-flight latch is released on
  every exit path including a cancelled request, so a `send` that is abandoned
  mid-flight leaves the discussion answerable rather than stuck reporting "still
  answering" with nothing running.
  A message over **64 KiB** is refused naming its size and the limit; a `close`
  that lands while a `send` is still being dispatched refuses the `send` with
  `<id> was closed while your message was being dispatched` and starts no turn.
- `coder.discuss.subscribe` / `coder.discuss.unsubscribe` — **Params**
  `{ discussion_id, from_seq?: number }` / `{ discussion_id }`. **Returns**
  `{ events_replayed }` / `{ ok: true }`. Same replay-then-register-under-the-
  buffer-lock discipline as `coder.subscribe` (no gap, no dup). Owner-only.
  WS-only.
- `coder.discuss.promote` — **Params** `{ discussion_id }`. **Returns**
  `{ discussion_id, proposed_intent, constraints: string[] }`. **Starts
  nothing** — no worktree, no branch, no session. It is a pure distillation
  call: the caller shows `proposed_intent` (a distilled instruction, never the
  transcript) to the operator, who may edit it before calling `coder.start`.
  Callable repeatedly on an open discussion. **Refused while a turn is
  streaming** (`<id> is still answering — try again in a moment`): distilling
  then would run on the operator's question with no answer beside it, and the
  model would return a confident intent invented from an unanswered question —
  which then feeds `coder.start { discussion_id }` and contract derivation.
- `coder.discuss.close` — **Params** `{ discussion_id }`. **Returns**
  `{ ok: true }`. Frees the in-memory discussion and drops its subscribers.
  Owner-only.
- `coder.discuss.list` — **Params** `{}`. **Returns**
  `{ discussions: [{ discussion_id, repo, created_at, turns }] }` — **this
  connection's** discussions only. Also serves
  as the **capability probe**: a daemon predating this work answers JSON-RPC
  `-32601` (method not found), which a client maps to a plain "this daemon is
  too old for discuss / promote / revise" message rather than a raw protocol
  error or a hang.

`coder.start` accepts `discussion_id`: the discussion's agreed `constraints` are
appended to the repo/intent context handed to contract derivation — so a
constraint stated only in the discussion lands in the drafted contract without
the operator restating it — and the session records the id, which `coder.get`
and every session summary surface as provenance. An unknown `discussion_id` is a
clear error; it never silently starts an ungrounded run. It must be **your own**
discussion, and it must not be mid-turn — starting while it is still answering
is refused, because the constraints would be distilled from a question with no
answer beside it.

Carry-through is **verified against the checks, not the prose.** Each constraint
is judged against the drafted contract, and a constraint counts as captured only
when some check's command would fail if it were violated. A constraint that
reaches only the contract's `description` drives the repair loop like a dropped
one; if the attempt budget runs out with it still ungated, the contract comes
back with a `NOT VERIFIED BY THIS CONTRACT` block in its `description` naming
it. Render that block — it is the difference between a constraint the run
enforces and one it merely narrates.

#### Managed projects (`coder.projects.*`)

A **project** is a named, CAR-managed git repository under `~/.car/projects/<slug>/` — created and initialized for the user so the coder's worktree/branch machinery works underneath while they only ever see a name. The non-developer path: no repo to pick. Projects have a **kind** — `app` (generic code) or `agent` (an in-daemon declarative agent, see `declagents` below). A project session delivers on approve by committing straight to the project's `main` (fast-forward), not a `car/coder/<id>` branch. `coder.start` takes **exactly one of** `repo` (a raw git path) or `project` (a managed slug).

- `coder.projects.create` — **Params** `{ name: string, kind?: "app"|"agent" }` (default `app`). **Returns** `CoderProject { slug, display_name, kind, repo_path, created_at }`. Idempotent: an existing slug loads its metadata (the persisted kind wins).
- `coder.projects.list` — **Params** `{}`. **Returns** `{ projects: [CoderProject] }`, newest first.
- `coder.projects.get` — **Params** `{ slug: string }`. **Returns** `CoderProject`.

### declagents

**In-daemon declarative agents.** A declarative agent is pure data — an identity (system prompt), a tool **allowlist** (names of tools the daemon already exposes), an optional deny list, a standing goal, an optional deterministic `goal { check, max_iterations }`, and scenarios (test cases). The daemon runs it with a generic model→tool loop: there is no command to spawn, so a non-developer installs nothing. Built by the coder→agent loop (an `agent`-kind project: `coder.start { project }` synthesizes a "scenarios pass" contract, the build loop generates the spec and drives its scenarios green in-daemon, and `coder.approve_merge` registers it). This is a **parallel registry** to the supervised `agents.*` — a declarative agent has no command, so it never travels through the supervisor's absolute-path validation. `agents.list` read-merges declarative entries tagged `kind:"declarative"` (carrying `enabled` instead of process status), `capabilities:["chat"]`, and `description` (the trimmed standing goal when nonblank, otherwise the trimmed identity); hosts can call `agents.chat` with the declarative agent id and receive the normal `agents.chat.event` stream from the in-daemon runner. `agents.chat.cancel` is honored in-daemon via a local cancellation flag; the runner stops at the next model/tool/goal-check boundary and late frames are suppressed once routing is dropped.

**Security**: the tool allowlist is strict — an empty/typo'd allowlist exposes ZERO tools, never the full set — and the daemon's inspector chain hard-enforces beneath it. A declarative agent can only call tools it was granted, gated by the same policy as the coder.

- `declagents.list` — **Params** `{}`. **Returns** `{ agents: [{ id, name, description, kind:"declarative", enabled, capabilities:["chat"], tools, goal?, scenarios }] }`; `description` is the trimmed standing goal when nonblank, otherwise the trimmed identity.
- `declagents.get` — **Params** `{ id: string }`. **Returns** the full `DeclarativeAgentSpec`.
- `declagents.remove` — **Params** `{ id: string }`. **Returns** `{ removed: bool }`.
- `declagents.set_enabled` — **Params** `{ id: string, enabled: bool }`. **Returns** `{ ok: true }`. A disabled agent stays registered but refuses to run.
- `declagents.invoke` — **Params** `{ id: string, input: string }`. **Returns** `{ output, turns, tool_calls, error?, goal? }`. Runs the agent on `input` entirely in-daemon (no process), bounded by a turn cap, with file tools rooted in an ephemeral scratch workspace. When the spec has a `goal`, CAR runs `goal.check` in that same scratch workspace after each pass, re-drives the agent with the verifier reason until the check exits 0, and returns `goal: { check, max_iterations, iterations, met, grounded, last_exit_code, last_reason }`; if the check never passes, `error` is `goal_not_met ...`.
- `declagents.route` — **Params** `{ need: string, invoke?: bool, from?: string, visited?: string[] }`. **Returns** `{ chosen, candidates: [{ id, name, score, similarity, success_rate, edge_weight }], next_visited, invoked, result? }`. Capability-similarity routing: embeds `need` (query-side) and each eligible agent's capability surface (name + identity + standing goal + tools), then ranks by `score = 0.7·similarity + 0.3·success_rate + 0.2·edge_weight` (the AgentNet milestone, see `docs/proposals/agentnet-self-organization.md`). `success_rate` is the agent's learned success prior: the Beta(success+1, fail+1) posterior UCB (the `car-memgine::utility` substrate) over the raw success/failure counts persisted in `~/.car/routing.json` — folded across BOTH the agent-id key (outcomes recorded by `declagents.route`/`invoke`) and the agent's `agentdns://local/agent/<id>` identifier key (outcomes recorded by `discovery.report`), so `declagents.route` and `discovery.resolve` score the same agent identically (one agent, one score — H2 Part 2, `docs/proposals/h2-builder-discovery-acceptance.md`). The cold-start posterior mean is exactly the neutral `0.5`; the persisted EMA field remains in `declagents.routing_stats` for display but no longer drives ranking. Similarity dominates so cold-start ranking is correct, the prior nudges toward agents that actually finish work. `similarity` itself blends cold-start similarity (need vs the agent's static capability text) with learned similarity (need vs the agent's reinforced capability centroid, `0.6·cold + 0.4·learned`) once the agent has succeeded at least once — so an agent's effective profile drifts toward the needs it actually handles well. **Forward op:** when `from` (the delegating agent) is set, it is excluded from candidates and a learned directed edge `from → candidate` adds `edge_weight` to the score — so a proven delegation path re-ranks peers. `visited` is the set of agents already on the routing path (DAG/cycle guard): all are excluded, and routing refuses the next hop once 4 agents are already on the path (a chain runs at most 4 agents before terminating). To walk a Forward chain, the next hop passes `from = chosen` and `visited = next_visited` (the response echoes `next_visited = visited + [chosen]`, so each hop strictly grows the path and the hop cap always terminates it). `score` is an unbounded ranking score (a fully-forwarded agent can exceed 1.0), not a probability — only the order across candidates is meaningful. `candidates` are the top 3 ranked descending. With `invoke: true`, the top-ranked agent is run on `need` via the same governed path as `declagents.invoke`; its outcome is recorded, the `from → chosen` edge is reinforced/weakened by that outcome, and its `{ output, turns, tool_calls, error?, goal? }` lands in `result`. Errors if no eligible declarative agents exist.
- `declagents.route_split` — **Params** `{ need: string, invoke?: bool, max_subtasks?: number, decomposition_mode?: "vanilla"|"sad", sad_hints?: number, sad_iterations?: number, sad_convergence_jaccard?: number }`. **Returns** `{ subtasks: [{ subtask, chosen, score, result? }], count, invoked, decomposition_mode, rounds, initial_subtasks, final_subtasks, hints, hint_jaccard? }`. AgentNet's **Split** op as a fan-out: a planner model decomposes `need` into independent subtasks (`max_subtasks` clamped to [1, 10], default 5), then each subtask is routed to its best-matching agent by the same capability-similarity ranking as `declagents.route`. `decomposition_mode` defaults to `"vanilla"` for compatibility. `"sad"` enables Skill-Aware Decomposition: CAR decomposes once, retrieves candidate agent hints, re-decomposes with those hints, and stops early when hint-set Jaccard reaches `sad_convergence_jaccard` (default 0.6; hints clamp [1, 50], iterations [1, 3]). Any decomposition failure falls back to the last valid subtasks or the whole `need`. A per-subtask infra failure is captured into that subtask's `result.error` and the fan-out continues. **Cost:** `invoke: true` runs up to `max_subtasks` full agent loops sequentially; SAD adds extra decomposition/embedding work.
- `declagents.routing_stats` — **Params** `{}`. **Returns** `{ agents: { <id>: { successes, failures, ema_success_rate, learned } }, edges: { <from>: { <to>: weight } } }`. Read-only view of the learned routing topology — the success priors, the `learned` flag (whether the agent has a reinforced capability centroid), and directed agent→agent forward-edge weights that `declagents.route` ranks with. The centroid vector itself is omitted (large embedding, noise for observability). Empty when nothing has been routed yet.
- `discovery.resolve` — **Params** `{ need: string, limit?: number }`. **Returns** `{ services: [{ identifier, name, kind, protocol, score, similarity }], count }`. AgentDNS-style service discovery ([arXiv:2505.22368](https://arxiv.org/abs/2505.22368), design in `docs/proposals/agentdns-discovery-layer.md`): resolves `need` into ranked CAR services across providers, each named under the `agentdns://organization/category/name` scheme. Providers: **declarative agents** (`kind:"declarative"`, `protocol:"in-daemon"`, `agentdns://local/agent/<id>`), **observe-only registry services** (the dashboard-registered local services under `~/.car/registry/`, written by `registry.register` / `register_agent` / the supervisor — `kind:"registry"`, `protocol:"http"`, `agentdns://local/service/<name>`; only running/idle entries are surfaced, ranked by the entry's `capability` text and reachable at its `dashboard_url`), **connected MCP connector tools** (`kind:"connector"`, `protocol:"mcp"`, `agentdns://<connector-slug>/tool/<tool>`, `name` = the canonical `mcp_<slug>_<tool>` handle), **installed external agent CLIs** (Claude Code / Codex / Gemini — `kind:"external"`, `protocol:"cli"`, `agentdns://external/agent/<id>`; detection is cached ~60s to avoid per-call `--version` probes), and **registered remote A2A peers' skills** (`kind:"a2a"`, `protocol:"a2a"`, `agentdns://<peer-slug>/skill/<skill-id>`; each peer's agent card is fetched concurrently with a per-peer timeout and cached ~60s — register peers via `a2a.peers.add`). Ranking is uniform — cosine similarity of `need` vs each service's capability text blended with a learned success prior for **every** provider kind: the Beta(success+1, fail+1) posterior UCB (the `car-memgine::utility` substrate, shared with `declagents.route` — one agent, one score, both surfaces) over the routing-store history keyed by the service's `agentdns://` identifier (fed by `discovery.report`; a never-reported service's cold posterior mean is exactly the neutral 0.5). Declarative agents additionally fold in their agent-id-keyed history (the `declagents.route`/`invoke` learning) and blend their learned capability centroid. `limit` clamps to [1, 50] (default 5). Pure resolution — it does **not** invoke; the caller selects an `identifier`/`name` and invokes via the matching surface (`declagents.invoke`, or the connector's canonical tool name). Empty `services` (not an error) when nothing matches. A fifth provider, the **remote AgentDNS root server** (cross-vendor registry), is included when `CAR_AGENTDNS_ROOT_URL` is set — CAR POSTs the need to the root and folds its records into the same ranking via their description (signed-in users send the Parslee token as bearer). The root contract is `docs/agentdns-root-contract.md`; the provider is inactive until the backend is deployed and the URL configured. Provider gathering is best-effort and each probing provider is time-bounded (5s): a flaky connector, slow detection, unreachable A2A peer, or unreachable root is skipped, never failing discovery of everything else.
- `discovery.report` — **Params** `{ identifier: string, outcome: "success"|"failure" }`. **Returns** `{ identifier, outcome, successes, failures }` (the updated raw counts). Records a discovery-routed run's outcome into the routing learning store (`~/.car/routing.json`), keyed by the service's `agentdns://` identifier — for **every** provider kind (connector, registry, external, a2a, declarative), not just declarative agents. This is the feedback loop `discovery.resolve`'s success prior learns from (H2 Part 2): a service that keeps failing is demoted below a healthy sibling on the next resolve — e.g. a broken MCP-connector tool sinks under its backup provider — while a never-reported service stays at the neutral cold-start prior. The identifier is validated against the `agentdns://` scheme and must be passed **verbatim** from `discovery.resolve` (the parser validates, it does not normalize — a re-spelled identifier records feedback that ranking never reads; charset-valid identifiers for nonexistent services are persisted but never rank); `outcome` is strict (anything else errors). **`agentdns://local/agent/*` identifiers are rejected**: in-daemon declarative runs are recorded automatically by `declagents.invoke`/`route`, and their agent-id and identifier keys fold together at ranking time — reporting them here too would teach the same run twice. Recording is caller-attested — CAR doesn't verify the run happened; the caller that invoked the service reports what it observed.
- `discovery.route_compose` — **Params** `{ need: string, max_subtasks?: number, decomposition_mode?: "vanilla"|"sad", sad_hints?: number, sad_iterations?: number, sad_convergence_jaccard?: number, candidates_per_step?: number, rerank?: bool }`. **Returns** `{ plan: { steps: [{ id, subtask, service, invoke_kind, invoke_target }], edges }, decomposition, candidates, metadata }`. This is SkillWeaver-style decompose → retrieve → compose over the same provider set as `discovery.resolve`. It plans only: CAR does not synthesize parameters or auto-invoke cross-kind services in v1. Each chosen step carries `invoke_kind`/`invoke_target` so callers can invoke via the existing governed surface (`declagents.invoke`, connector tool execution, `agents.invoke_external`, A2A dispatch, or — for a `registry` service — a plain `http` call to its dashboard URL). `rerank: true` optionally asks the model to listwise rerank each step's candidates; default `false`.

### voice

#### `voice.prepare_parakeet`
- **Params**: `{}`
- **Returns**: prep status — downloads the Parakeet TDT model on first call (~600 MB)

#### `voice.prepare_diarizer`
- **Params**: `{}`
- **Returns**: prep status — downloads the diarization model

#### `voice.transcribe_stream.start`
- **Params**: `{ session_id: string, audio_source: object, options?: object }`
- **Returns**: `{ session_id: string, status: string, ... }`
- Pushes `voice.event` notifications with partials and finals.
- `options.provider` selects the streaming STT backend. Default is the in-process pipeline (whisper.cpp / VPIO / Apple Speech). `"elevenlabs"` routes pushed PCM through ElevenLabs' Realtime STT websocket — only meaningful with `audio_source.kind = "pcm_push"` and 1 channel; requires `ELEVENLABS_API_KEY` in env, config, or keychain. `"local"` is the explicit form of the default. Unknown values are rejected at start time.

#### `voice.transcribe_stream.push`
- **Params**: `{ session_id: string, pcm_b64: string }` — base64-encoded 16-bit signed PCM
- **Returns**: interim update

#### `voice.transcribe_stream.stop`
- **Params**: `{ session_id: string }`
- **Returns**: final transcription result

#### `voice.tts_stream.start`
- **Params**: `{ stream_id: string, text: string, options?: object }`
- **Returns**: `{ stream_id: string, binary_frames: boolean }`
- Begins streaming TTS synthesis. Provider-agnostic — dispatches through the configured `Speaker` (`build_tts_speaker(&config)`); any provider with the default `synth_stream` trait method emits one final chunk, providers that override it (e.g. ElevenLabs `/stream`) emit chunks as they arrive.
- `options`:
  - `provider`: `"elevenlabs"` | `"local"` | `"kokoro"` | `"apple_speech"`. Default uses the platform default from `VoiceConfig`.
  - `voice_id`: provider-specific voice id. ElevenLabs is the only provider that consumes this today; other providers ignore it.
  - `binary_frames`: when `true`, audio chunks ride as CAR binary frames (type `0x02`, see below) and JSON `tts_chunk` events are suppressed. The `stream_id` MUST be a 32-char lowercase hex UUID (no dashes) in this mode — the binary header needs raw UUID bytes.
- Pushes `voice.event` notifications with `type = "tts_chunk"` carrying `{ stream_id, seq, audio_b64, format: "mp3" | "wav", is_final }` when `binary_frames = false`.

#### `voice.tts_stream.cancel`
- **Params**: `{ stream_id: string }`
- **Returns**: `{ stream_id, cancelled: boolean }`
- Aborts an in-flight TTS stream. Idempotent: unknown ids return `{cancelled: false}` rather than an error so callers can race cancellation against natural completion. This is the barge-in path.

#### `voice.tts_stream.list`
- **Params**: `{}`
- **Returns**: `{ streams: [stream_id, ...] }`

#### `voice.sessions.list`
- **Params**: `{}`
- **Returns**: `[ { session_id, status, ... }, ... ]`

#### `voice.providers.list`
- **Params**: `{}`
- **Returns**: `[ { id: string, kind: "stt" | "tts", available: boolean, description: string }, ... ]`
- Stateless. Enumerates STT/TTS providers compiled into the server binary. `available` reflects build-time presence (cfg-target, build features). Runtime readiness — API key set, permission granted (e.g. `apple_speech` requires `SFSpeechRecognizer.requestAuthorization`), model downloaded — surfaces only when the caller actually exercises that provider.

#### `voice.enroll_speaker`
- **Params**: `{ label: string, audio: object }`
- **Returns**: enrollment success indicator

#### `voice.list_enrollments`
- **Params**: `{}`
- **Returns**: enrolled speaker labels

#### `voice.remove_enrollment`
- **Params**: `{ label: string }`
- **Returns**: success indicator

#### `voice.dispatch_turn`
- **Params**: `{ utterance: string, session_id?: string, config_overlay?: string, sidecar_timeout_ms?: number }`
- **Returns**: `{ turn_id: number }` — minted synchronously
- Two-track sidecar pattern: a fast inference (`prefer_fast: true`) streams text deltas while a parallel sidecar runs to completion. Tool-likely utterances (email/calendar/search) skip the fast track and play a hardcoded bridge phrase via `voice.event` while only the sidecar runs (the "STRUCTURAL HALLUCINATION FIX" — prevents the fast model from inventing tool data).
- Pushes `voice.event` notifications carrying `voice.turn.*` payloads (see below).
- `config_overlay` overrides the voice-context prompt overlay; an empty string disables it. Omit to use the built-in default.
- `sidecar_timeout_ms` defaults to 30000.

#### `voice.cancel_turn`
- **Params**: `{}`
- **Returns**: `{ cancelled: true }`
- Cancels the in-flight voice turn. Idempotent. Bumps the stored turn id so any in-flight sidecar result is dropped at its arrival gate (race-recovery on barge-in).

#### `voice.prewarm_turn`
- **Params**: `{}`
- **Returns**: `{ prewarmed: true }`
- Issues a 1-token probe with `prefer_fast: true` so the fast model is loaded into memory before the first user turn. Best-effort and idempotent — call at session start so the first turn meets the <500ms first-audio target.

### inference

Closes [Parslee-ai/car-releases#24](https://github.com/Parslee-ai/car-releases/issues/24). When a model schema declares `source: { type: "delegated", ... }`, CAR routes the request through the registered WebSocket session. The host owns the wire format (Anthropic, OpenAI, Vercel AI SDK, etc.); CAR observes events and stays in the policy / replay path.

#### `inference.register_runner`
- **Params**: `{}`
- **Returns**: `{ registered: true }`
- Marks this WebSocket session as the inference runner host. Idempotent — re-calling overwrites any prior registration. Only one runner can be registered per process.

#### `inference.runner.event`
- **Params**: `{ call_id: string, event: object }`
- **Returns**: `{ emitted: true }`
- **Optional.** A runner that has nothing to stream may go straight to `inference.runner.complete`; see below.
- Called by the runner host for every chunk its provider streams back. `event` must be one of the shapes below — **this list is exhaustive**, and any other shape is rejected with `unrecognised runner event shape`:
  - `{ type: "text", data: string }`
  - `{ type: "tool_start", name: string, index: number, id?: string }`
  - `{ type: "tool_delta", index: number, data: string }`
  - `{ type: "usage", input_tokens: number, output_tokens: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }`
  - `{ type: "provider_output_item", item: object }`
  - `{ type: "error", message: string }`
  - `{ type: "done", text: string, tool_calls: ToolCall[] }`
- The tags above are the wire vocabulary and deliberately do **not** match the internal `StreamEvent` variant names (`TextDelta`, `ToolCallStart`, …). Use the tags, not the variant names.

#### `inference.runner.complete`
- **Params**: `{ call_id: string, result: { text: string, tool_calls: ToolCall[] } }`
- **Returns**: `{ completed: true }`
- Called by the runner host once the upstream call finishes successfully. Resolves CAR's awaiting future for `call_id` with `result`.
- **Terminal on its own.** A runner that emits no `inference.runner.event` at all and answers with `complete` is fully supported — a delegated model returning a short non-streaming answer has nothing to stream. `result.text` / `result.tool_calls` are used whenever no events were emitted; when events *were* emitted, the accumulated stream is authoritative and `result` supplies only what the stream did not. (Before car-releases#76 an event-less completion returned empty text and was silently retried, doubling latency.)

#### `inference.runner.fail`
- **Params**: `{ call_id: string, error: string }`
- **Returns**: `{ failed: true }`
- Called by the runner host on upstream failure (HTTP error, auth failure, provider rate limit). Surfaces as `InferenceError::InferenceFailed(error)` to the original caller.

##### `inference.runner.invoke` (server → client notification)

When CAR needs to dispatch a delegated model, the server sends:

```json
{
  "jsonrpc": "2.0",
  "method": "inference.runner.invoke",
  "params": {
    "call_id": "uuid-string",
    "request": { /* GenerateRequest */ }
  }
}
```

The client correlates events back via `call_id` through the three methods above.

**Correlating an invoke with your own request.** `call_id` is minted by the daemon *after* the caller issued `infer`, so a host with several calls in flight cannot use it to find its own request state. Set `client_ref` on the `GenerateRequest` — an opaque string CAR never reads, routes on, or interprets — and it is echoed verbatim inside `params.request.client_ref`:

```json
{ "method": "inference.runner.invoke",
  "params": { "call_id": "…", "request": { "client_ref": "your-uuid", "…": "…" } } }
```

Do not smuggle an identifier through `prompt`. That worked only because delegated models ignore `prompt` for prompt construction, and breaks silently the moment one stops ignoring it (car-releases#78).

##### `voice.turn.*` event taxonomy

`voice.event` notifications fired during a turn carry one of:

| Event `type` | Additional fields |
|--------------|-------------------|
| `voice.turn.fast_delta` | `turn_id: number`, `text: string` |
| `voice.turn.fast_done` | `turn_id: number` |
| `voice.turn.bridge` | `turn_id: number`, `kind: "email"\|"calendar"\|"search"\|"unknown"`, `phrase: string` |
| `voice.turn.sidecar` | `turn_id: number`, `text: string` |
| `voice.turn.error` | `turn_id: number`, `error: string` |
| `voice.turn.cancelled` | `turn_id: number` |

The host plays audio (or otherwise renders) from these events — CAR does NOT own the speaker on this path. Bridge phrases are handed to the host as `voice.turn.bridge` for the host's TTS to synthesize.

### workflow

Declarative multi-stage orchestration with conditional edges and saga compensation. See `crates/car-workflow/`.

#### `workflow.run`
- **Params**: `{ workflow: object, initial_state?: object }`
- **Returns**: workflow execution result. Uses `multi.run_agent` callbacks for stage execution.
- **Initial-state injection** (EPIC H / H3): `initial_state`, when given, is a `{key: value}` map seeded into workflow state before the run starts — the inter-workflow chaining hook (hand a prior run's `final_state` to the next workflow so its edge conditions and stages can read upstream results). Omitted = prior behavior. The reserved `goal` drift anchor is always re-derived from the workflow definition and cannot be injected this way. FFI: `runWorkflow(workflowJson, initialStateJson?)` (NAPI) / `run_workflow(workflow_json, initial_state_json=None)` (PyO3).
- **Goal pinning**: an optional top-level `workflow.goal` string is pinned into run state as `goal` and re-anchored into every `pattern` step's task (`"Overall goal: … / Current step: …"`) — a structural guard against goal drift across a long run.
- **Verification pattern kinds**: a `pattern` step's `pattern` may be `adversarial_review` (a fresh reviewer checks prior work — `agents[0]` is the reviewer, `config.criteria` is a string array, `config.review_key` names the state key holding the work; the verdict is exposed as the typed `stage.<id>.review_passed` boolean for edge branching, plus a `PASS`/`FAIL` answer summary; it fails closed when there's no work) or `tournament` (rank competitors by pairwise judging — last agent or `config.judge_index` is the judge). These wire fresh-context verification and comparative ranking into the declarative layer.
- **Human-in-the-loop**: a stage of type `approval` pauses the run. The result then has `status: "paused"` and a `paused` checkpoint object `{ run_id, paused_stage_id, prompt, fields, output_key, ... }`. The daemon persists the checkpoint durably under `~/.car/workflow-runs/` keyed by `run_id`, so it survives a restart. Resume with `workflow.resume`. An `approval` stage is defined as `{ "type": "approval", "prompt": string, "fields": ApprovalField[], "output_key": string }` where `ApprovalField` is `{ name, label?, field_type?, options?, required? }`.
- **Dynamic stage steps** (control flow that depends on runtime state, while staying declarative and statically verifiable):
  - `loop_until`: `{ "type": "loop_until", "body": StageStep, "until": Precondition[], "max_iterations": number }` — repeat `body` until `until` (AND of preconditions over state) holds or the cap is reached. The body's produced state plus `stage.<id>.answer` / `stage.<id>.iteration` are visible to `until`; an empty `until` runs exactly `max_iterations` times. `max_iterations >= 1` is enforced by `workflow.verify`.
  - `for_each`: `{ "type": "for_each", "items_from": string, "body": StageStep, "max_concurrent"?: number }` — resolve a JSON array from state key `items_from` **at runtime** and run `body` once per item (bounded concurrency). `{{item}}` and `{{index}}` are substituted into every string value in the body before each run. Per-item answers land at `foreach.<id>.<index>.{item,answer}` and each body's state deltas at `foreach.<id>.<index>.state.<key>` (namespaced per item); the count at `foreach.<id>.count`. A missing/non-array key is a no-op. A non-empty `items_from` is enforced by `workflow.verify`. Nesting of loop/foreach/sub-workflow bodies is capped (depth 32) and rejected by `workflow.verify`.
  - `dedup`: `{ "type": "dedup", "items_from": string, "into": string, "store": string, "hash_fields"?: string[], "ttl_secs"?: number }` — read the candidate array at `items_from`, drop items already processed in a **prior run** (a persistent content-hash seen-set under the `store` namespace, default `~/.car/workflow-dedup/<store>.json`), record the survivors, and write the unseen subset to `into` for a downstream `for_each` to fan out over. Exposes `stage.<id>.unseen_count` and `stage.<id>.total_count` for edge branching (e.g. skip delivery when nothing is new). `hash_fields`, when set, hashes only those top-level object fields (an identity key, e.g. `["id"]`), so unrelated churn in an item doesn't resurface it; empty hashes the whole item canonically. `ttl_secs`, when set, evicts seen-set entries first seen more than that many seconds ago (before the dedup check) so the file stays bounded to a recent window — an item that aged past the TTL and reappears in the source is reprocessed; omit it (or pass `null` in an `AutomationSpec`) to dedup forever (an unbounded file). `ttl_secs: 0` is rejected by `workflow.verify` (it would evict everything each run — the disable sentinel is omit/`null`, not `0`). Non-empty `items_from` / `into` / `store` are enforced by `workflow.verify`. This is the deduplication primitive behind the external-item automation recipe (`workflow.build_automation`).
  - `deliver`: `{ "type": "deliver", "sinks": ActionProposal[], "payload_key"?: string }` — fan the workflow's result out to N delivery sinks, the terminal "publish everywhere" stage (EPIC H / H3). Each sink is a plain action proposal executed through the same path as a `proposal` step — so e.g. messaging delivery is *a proposal invoking the messaging tool*, not a car-messaging dependency; any tool the runtime can execute is a valid sink. Sinks run **sequentially, best-effort per sink**: a failed sink records its error and the remaining sinks still run; the stage fails only when ALL sinks fail. `payload_key`, when set, names the state key whose value seeds a `{{payload}}` template substitution in every string value of each sink proposal (mirroring `for_each`'s `{{item}}` templating; a string substitutes raw, other JSON as compact JSON, a missing key as the empty string). The stage output is `{ "type": "deliver", "results": [{ sink_id, ok, result?, error? }, ...] }` (one entry per sink, in order), and `stage.<id>.delivered_count` / `stage.<id>.failed_count` are exposed for edge branching. **Per-sink evidence survives failure**: when the fan-out fails as a whole — every sink failed, or a `Stage.timeout_ms` cancelled it mid-way — the failed stage's `output` still carries the per-sink results recorded up to that point (a timed-out fan-out reports exactly which sinks fired before the deadline; only the sinks that never ran are absent), so a retry decision can avoid double-sending sinks that already landed. There is no per-sink timeout parameter: bound an individual sink via `Action.timeout_ms` on the actions inside its proposal; `Stage.timeout_ms` bounds the whole fan-out. A `deliver` nested as a `for_each` body is templated twice: `{{item}}`/`{{index}}` expand first (per item), then `{{payload}}` expands at delivery — so item text containing the literal `{{payload}}` is itself expanded (second-order), the same ordering rule as `{{item}}`→`{{index}}`. At least one sink is enforced by `workflow.verify`, including on a deliver nested as a loop/foreach body (each sink proposal is verified too, and outgoing edges draw a warning — deliver is intended terminal).
  - Neither `loop_until` nor `for_each` may use an `approval` gate as its `body`.

#### `workflow.chain`
- **Params**: `{ workflows: object[], initial_state?: object }`
- **Returns**: `{ results: WorkflowResult[], status: string, paused_at_index?: number, error?: string, failed_at_index?: number }`
- Inter-workflow chaining (EPIC H / H3): runs the workflows **sequentially**, seeding each next workflow's initial state with the previous result's `final_state` merged over the caller's `initial_state` (the previous result wins on key collisions; the first workflow gets exactly `initial_state`). Stops at the first non-`completed` result: `results` holds every workflow that ran (in order), `status` is `"completed"` when the whole chain finished or the stopping result's status otherwise.
- **Pre-validation**: every workflow in the array is statically verified (same checks as `workflow.verify`) **before any of them executes** — a structurally invalid manifest anywhere in the chain rejects the whole call as an error up front, so a chain never performs external side effects and then dies on a manifest defect downstream.
- **Mid-chain runtime errors are not thrown away**: an engine error that produces no result for a workflow (cycle limit reached, stage not found, …) still returns a normal chain response — `results` holds everything that ran (including delivery evidence from completed workflows), `status` is `"failed"`, and top-level `error` + `failed_at_index` name the cause and the workflow that produced no result. A workflow that *ran* and failed instead appears as the last entry of `results` (no top-level `error`). Retry decisions need this evidence to avoid double-delivery.
- **Shared infrastructure**: all workflows in one chain share a single `SharedInfra` (state store + event log) — workflow B can read workflow A's `state_write`s directly, beyond the explicit `final_state` seeding. Two separate `workflow.run` calls do NOT share this (each gets a fresh infra).
- A **paused** intermediate persists its checkpoint durably exactly like `workflow.run` (under `~/.car/workflow-runs/`, resumable by `run_id` via `workflow.resume`); the chain returns with `paused_at_index` naming the workflow whose run parked, and its `paused` checkpoint is inside that result. Resuming continues only that workflow — re-chain the remainder (seeded with its `final_state`) if desired.
- FFI: `workflowChain(workflowsJson, initialStateJson?)` (NAPI) / `workflow_chain(workflows_json, initial_state_json=None)` (PyO3) — embedded (in-process) chain over the runner registered via `registerAgentRunner`; checkpoint persistence stays caller-owned there, like `runWorkflow`.

#### `workflow.resume`
- **Params**: `{ run_id: string, input?: object }`
- **Returns**: the next workflow execution result — `status: "completed"` (or `failed`/`compensated`), or `status: "paused"` again if the run hits another approval gate.
- `input` is a JSON object of the human's response fields; it is validated against the gate's declared `fields` (`required` present, `options` in range) and rejected with an error otherwise (resubmit with corrected input). On resume the response is written to the gate's `output_key`, flattened to `output_key.<field>` for edge conditions, and mirrored to `stage.<id>.answer`.
- **Exactly-once**: the daemon atomically claims the checkpoint before resuming, so a duplicate or racing `workflow.resume` for the same `run_id` returns an error rather than re-running side-effecting downstream stages.

#### `workflow.list_paused`
- **Params**: `null`
- **Returns**: array of `{ run_id, paused_stage_id, prompt, created_at }` — every resumable run, skipping in-flight and corrupt checkpoints.
- The discovery half of durable resume (EPIC H / H1): after a daemon restart a client no longer holds the paused `run_id`s, so it enumerates them here and resumes each by `run_id` via `workflow.resume`. Durable checkpoints are saved on pause and re-armed at boot (`recover_workflow_checkpoints`), so paused runs survive a restart.
- FFI: also exposed as the embedded free function `listPausedWorkflows(runsDir)` (NAPI) / `list_paused_workflows(runs_dir)` (PyO3), which reads a caller-managed checkpoint directory.

#### `workflow.verify`
- **Params**: `{ workflow: object }`
- **Returns**: `{ valid: boolean, issues: string[], has_cycles: boolean, reachable_stages: string[], unreachable_stages: string[], semantic: string[] }`
- Structural rules (reported as `error`, so `valid` is `false`): the `start` stage must exist, every edge endpoint must reference a declared stage, and **stage IDs must be unique** — a duplicate id silently shadows one of the collisions in the engine's id→stage lookup, so that stage never runs and edges to it are ambiguous. Unreachable stages and cycles are `warning`s (a cycle is bounded by `max_iterations`).
- Approval-gate rules: an `approval` stage must declare a non-empty `output_key`, and may not be referenced as a stage's compensation handler. Both are reported as `error` issues.
- Dynamic-step rules: `loop_until` requires `max_iterations >= 1`; `for_each` requires a non-empty `items_from`; neither may have an `approval` body. The verifier recurses into `loop_until`/`for_each` bodies (and nested sub-workflows) to validate the proposals and constructs inside them.
- `semantic` carries **advisory** findings that don't affect `valid`: edge-condition keys and proposal state-dependencies that no stage produces (e.g. an approve/revise branch keyed on `approval.<field>` the gate never declares — it would silently never fire).

#### `workflow.build_automation`
- **Params**: `{ spec: AutomationSpec }`
- **Returns**: a runnable `Workflow` object — hand it to `workflow.run` (typically on a schedule via the scheduler).
- Lowers the **external-item automation recipe** to a plain workflow: `poll` (a proposal that fetches items and writes a JSON array to `items_key`) → `dedup` (drop items handled in a prior run via a persistent content-hash seen-set under `dedup_store`) → `process` (a `for_each` that fans the `worker` pattern over each new item, templating `{{item}}`/`{{index}}`) → optional `deliver` (a proposal that posts results, reading `foreach.process.<i>.answer`). Stateless; performs no I/O.
- `AutomationSpec` is `{ id: string, name: string, poll: ActionProposal, items_key?: string (default "items"), dedup_store: string, hash_fields?: string[], dedup_ttl_secs?: number (default 7776000 = 90 days; pass null to dedup forever), worker: PatternStep, max_concurrent?: number, deliver?: ActionProposal }`. The recipe's seen-set is bounded to a 90-day window by default so it doesn't grow without limit.
- The lowered workflow passes `workflow.verify` and runs/checkpoints/compensates like any hand-written workflow — there is no separate execution path. The `poll` proposal action should declare `items_key` in its `expected_effects` so static verification sees it produced.
- FFI: also exposed as the stateless free function `buildAutomationWorkflow(specJson)` (NAPI) / `build_automation_workflow(spec_json)` (PyO3).

#### `builder.build`
- **Params**: `{ goal: string, existing?: object, max_attempts?: number }`
- **Returns**: `{ valid: boolean, workflow: Workflow | null, issues: string[], warnings: string[], attempts: number }`
- Natural language → a runnable `car-workflow` manifest (`car-builder`). Prompts a model to emit the manifest, parses it tolerantly, then **validates with `verify_workflow`** plus a tool-existence cross-check, feeding concrete errors back for up to `max_attempts` repair rounds. `valid` means the returned `workflow` passed verification; `warnings` are the advisory semantic findings.
- The catalog is authoritative on the daemon: tool names come from **this session's registered tool schemas** and model ids from the inference registry, so the cross-check flags invented tools. `existing` (a workflow object) switches to update/edit mode. The approve/revise loop is caller-driven — re-call with an edited goal or `existing` set to the prior result.
- FFI: the in-process bindings expose this as a `CarRuntime` method — `buildWorkflow(requestJson)` (NAPI) / `build_workflow(request_json)` (PyO3) — which proxies to this daemon method.

### Top-level (no namespace)

#### `verify`
- **Params**: `{ proposal: ActionProposal, initial_state?: object }`
- **Returns**: `{ valid: boolean, issues: VerifyIssue[], simulated_state: object, execution_levels: string[][], conflicts: [string, string, string][], evidence: VerificationEvidence }`
- Static verification only — no tools are called. 30s timeout.
- Each `tool_call` is checked against the session's registered tool schemas (those declared via `register_tool_schema`): unknown tools, and — since car-releases#56 — `parameters` that violate the schema's declared `type`s or omit a `required` field, are reported as `error` issues with `valid: false`.
- Each `VerifyIssue` is `{ action_id, severity, message, tier }`. **`tier` is the evidence tier** — `"decision_procedure"` | `"heuristic"` | `"sampled"` — saying which *kind* of check produced the finding, so a consumer no longer has to recognise the message string to tell them apart. Today `verify`'s findings are all `decision_procedure` (set membership, the STRIPS-style forward walk, write-conflict detection) except the repeated-identical-call loop rule, which is `heuristic`: the repeat count is exact but the step from "three identical calls" to "runaway loop" is a proxy, so a legitimate 3× poll trips it. The tier is **orthogonal to `severity`** (how bad, not how derived) and orthogonal to whether a finding blocks admission — `car_engine`'s gate treats the precondition and state-dependency findings as advisory even though both are `decision_procedure`, because they are decided over a forward model that sees only *declared* effects. A `decision_procedure` tier is not a proof, a soundness claim, or a prediction that the plan will run: it means the check decides the property it reports over the inputs it was given. Older daemons omit the field.
- `evidence` is the verifier's **declared scope** (survey "Code as Agent Harness" §5.2.2 — execution feedback is only as trustworthy as the oracle's scope): `{ checks: [{ name, ran, verifies, cannot_verify, findings, tier }], assumptions: string[], untested_regions: string[], residual_risks: string[], confidence: number }`. Each `CheckRecord` declares what a pass establishes (`verifies`), what it does **not** even on a pass (`cannot_verify`), its `tier` (the same one every finding it contributed carries), and whether it `ran` (e.g. `param_schema` is skipped when no schemas are registered). `confidence` is a 0–1 **coverage** signal (how completely the applicable checks covered the proposal), not a probability of runtime success. This lets a `valid: true` verdict be consumed with its blind spots visible rather than as a blanket guarantee — important for self-repair and harness-evolution loops that must not optimize against a weak oracle.
- `execution_levels` are the DAG's parallelizable batches (action IDs); `conflicts` are undeclared concurrent writes `(action1, action2, key)`.

#### `verify.monte_carlo`
- **Params**: `{ proposal: ActionProposal, initial_state?: object, tool_success_rates?: { [tool: string]: number }, goal?: GoalCondition, rate_window_days?: number, config?: { trials?: number, seed?: number, default_success_rate?: number, retry_attempts?: number } }`
- **Returns**: `{ trials, seed, p_goal_reached: number | null, goal_underivable_conditions: string[], p_all_effects_landed: number, tool_calls: Distribution, actions_executed: Distribution, state_distribution: [{ key, p_present, values: [{ value, probability }] }], action_outcomes: [{ action_id, p_rejected, p_failed, p_effects_landed, mean_blast_radius }], rate_provenance: {...} }`, where `Distribution` is `{ mean, min, p50, p95, max }`.
- Static, no tools are called — same as `verify`. Where `verify`/`simulate` answer "what state does this plan leave behind **assuming every dispatched tool succeeds**", this answers "how often does it work, and when it doesn't, what breaks first". Each `tool_call` succeeds with probability `tool_success_rates[tool]`; failures then cascade through the data dependencies exactly as `simulate` models them (an action whose dependency never landed is rejected before dispatch — `ActionStatus::Rejected`, the car#622 rule).
- **Rates come from real execution history by default.** Every session's `Runtime` carries the daemon-wide `TrajectoryStore` (`~/.car/trajectories/`, override with `ServerStateConfig::with_trajectory_dir`), so each proposal execution persists a trajectory. Omit `tool_success_rates` and the daemon derives them from the last `rate_window_days` (default 30, `0` disables derivation). Supplying the field does **not** replace the derived map — entries merge per tool, so `{"deploy": 0.99}` models a hypothetical for one tool while the rest keep their observed rates. Tools with no history use `config.default_success_rate` (0.5). Rates outside `0.0..=1.0` are clamped.
- **The derived rates are dispatch-conditional** — `P(succeeds | dispatched)`, from `car_planner::ToolFeedback::dispatched_from_trajectories`, which counts only `action_succeeded` + `action_failed`. This is deliberately *not* `ToolFeedback::from_trajectories`, whose denominator also includes `action_rejected` and `action_skipped`. That conflation is right for planner scoring (a tool whose actions keep getting rejected is a worse bet) and wrong here: this method already models rejection structurally from the dependency cascade, so a rate with rejections baked in would count the same failure twice and report the plan as more fragile than the evidence supports.
- Derived rates are **Laplace-smoothed** — `(succeeded + 1) / (dispatched + 2)`. One success reads as 0.67 rather than a categorical 1.0, while 100/100 reads as 0.99; evidence dominates once there is any. The alternative — a hard minimum-sample threshold — would make a rate jump from the 0.5 default to 1.0 on crossing an arbitrary count. Raw counts are reported in `rate_provenance` for callers that want to smooth differently.
- `rate_provenance` says where every rate actually came from: `{ window_days, trajectories_available: boolean, overridden_by_caller: string[], tools: [{ tool, rate, source: "caller"|"trajectories"|"default", succeeded: number|null, dispatched: number|null }] }`. A probability with no provenance is not actionable — 0.9 from 500 observations and 0.9 because nothing was ever recorded warrant very different confidence in the verdict, and without this the two are indistinguishable in the response.
- `config` fields are individually optional. Defaults: 1000 trials, a **fixed** seed, 0.5 default rate, no retries. Sampling uses a seeded SplitMix64 stream rather than wall-clock entropy, so the same proposal + rates + seed produce byte-identical output and every ordered field has a defined sort — a surprising verdict can be re-run and inspected. The seed is echoed in the result so it carries everything needed to reproduce it. `retry_attempts: n` gives each dispatched action `n+1` independent draws, raising effective success to `1-(1-p)^(n+1)` at a matching rise in `tool_calls`.
- `goal` is an optional `GoalCondition` (the same enum `evaluate_goal` takes) evaluated against each trial's final state to produce `p_goal_reached`; omit it and `p_goal_reached` is `null`. Only `state_predicate` (and `all_of`/`any_of` over it) is decidable from a simulated state — `tool_receipts_grounded`, `plan_achieved`, `state_consistent`, `command`, and `model_judge` **fail closed** and are named in `goal_underivable_conditions`. Read a `p_goal_reached: 0.0` alongside that list: a non-empty list means the number is a lower bound on the *condition*, not a verdict on the plan.
- `tool_calls` is the cost proxy — dispatch attempts per trial, retries included; its `p95` is what capacity planning needs. `mean_blast_radius` is the average number of transitive dependents rejected in the trials where that action failed, so `action_outcomes` ranks *which* failure hurts most. Attribution is per failing action, so overlapping cascades are counted for each and these do not sum to a total.
- **Not modelled**, matching `simulate`'s documented scope: `failure_behavior` (an independent action alongside a failed one still runs here, whereas the executor's default `Abort` may stop first), partial effects (an action lands all of its `expected_effects` or none), and **correlated failure** — draws are independent, so a plan calling one flaky tool repeatedly reads more optimistically here than it behaves when that tool's backing service is down. Non-`tool_call` actions (e.g. `state_write`) have no tool to fail and succeed whenever dispatched.
- **FFI**: `simulateMonteCarlo(proposalJson, initialStateJson?, toolSuccessRatesJson?, goalJson?, configJson?)` (Node) / `simulate_monte_carlo(proposal_json, initial_state_json=None, tool_success_rates_json=None, goal_json=None, config_json=None)` (Python). Both are stateless and compute in-process — they do **not** proxy to the daemon.

#### `permission.*` — the permission-tier safety governor (survey §3.4.3, §5.2.5)

A per-session permission gate classifies each action's risk into `read_only` / `sandbox_edit` / `full_access` and gates it against the session's granted standing tier. Human-in-the-loop decisions are recorded on the daemon's **shared, journal-backed approval ledger** (`~/.car/approvals.jsonl`, keyed by a stable operation fingerprint): an approval recorded on ONE connection (e.g. a host UI) is visible to EVERY other connection's evaluations (`permission.evaluate`/`pending`, `evolution.run`, `cascade.run`, `skill.enforce_deployment`/`ingest_governed`/`adopt_pack`) and **survives daemon restart**. Tier state stays per-session; the approval store is daemon-wide — a per-connection ledger would strand the approver's decision where the runner never reads it. Distinct from the method-level `host.*_approval` gate, which is per-call and time-boxed; this is keyed by *operation* and durable. The session defaults to a `sandbox_edit` standing tier.

**The tier is enforced on `proposal.submit`, not merely reported** (Parslee-ai/car#890). A `PermissionAdmissionGate` runs on every session runtime alongside the static-verification and supervision gates, and it asks the *same* session gate the *same* question `permission.evaluate` asks, against the *same* shared ledger — so the advisory answer and the enforced one cannot diverge. An action the gate escalates blocks the **whole** proposal before any action dispatches (a safety hazard is a property of the action set, not an isolated action), and the rejection names each offending action's fingerprint with its required and granted tier, so `permission.approve` can be driven straight off the error text. Approving a fingerprint makes the next submit of that operation evaluate to `allow` with no escalation raised at all — that is how the loop closes, through the shared ledger rather than through the executor's own. Until this landed the classification was published and never consulted: an action `permission.evaluate` called `needs_approval` executed anyway, on the same session, and its state write persisted.

- **`permission.get_tier`** — Returns `{ granted_tier }`. Also proxied to the bindings as `permissionGetTier()` (Node) / `permission_get_tier()` (Python).
- **`permission.set_tier`** — Params `{ tier: "read_only"|"sandbox_edit"|"full_access" }`. Returns `{ granted_tier }`. Also proxied to the bindings as `permissionSetTier(tier)` (Node) / `permission_set_tier(tier)` (Python) — a binding client can govern its own session's standing authority rather than only classifying against a tier it supplies by hand to the in-process `permission_evaluate` helper. Subject to the same **Authority** rule below: under a host token this is host-management-only.
- **`permission.classify`** — Params `{ proposal: ActionProposal }`. Returns `{ classifications: [{ action_id, tool, required_tier, reversibility, missing_compensation }], declared_rollback_contract }`.
  - `required_tier` is the minimum tier each action needs — *who may authorize this*. It is the **highest** tier any signal implies, over five signals matched at different granularities, each against the part of the action that actually carries the evidence: the **tool name** (whole `snake`/`camel` segments — `deploy_service`, `send_email`, `read_secret`); the **command line** only (a broad keyword list over `command`/`args`/`argv`/`flags` — `curl`, `terraform apply`, `aws `); **parameter keys** (`api_key`, `db_password`, a nested `auth.token` — the key names the credential, the value is opaque); **declared target paths** (`path`/`file`/`dest`/… holding `~/.ssh/id_rsa`, `.aws/credentials`, `*.pem`); and a narrow set of **always-dangerous phrases** anywhere in the flattened parameters (`drop table`, `delete from`, `rm -rf`, `git reset`). Nothing scans arbitrary parameter *values* for single common words. Before v0.48.0 one broad substring scan covered the whole flattened payload, so a URL matched `http`, a message body matched `send`, a `format_date` call matched `format`, and a search for "release notes" matched `release` — all of them `full_access`, which since Parslee-ai/car#915 is a hard block on a connection with no approver (Parslee-ai/car#917). A command-shaped action classifies identically before and after.
  - **`reversibility`** — `"reversible" | "compensable" | "irreversible"` — is the orthogonal second axis, *can this be undone*, from `car_policy::classify_reversibility` over the tool name and flattened parameters. It is classified **independently** of the tier, not derived from it, because deriving it would rebuild the conflation the axis exists to remove: `PermissionTier` used to describe `full_access` as "externally-consequential **or** irreversible", collapsing a `git push` (force-push the prior ref), a production `INSERT` (delete the row) and a charged card onto one rung. The two disagree in both directions — `read_secret` is `full_access` + `reversible` (a read leaves nothing to undo), `db_insert` is `sandbox_edit` + `compensable`.
  - **`missing_compensation`** is `true` when the action *declares* `reversibility: "compensable"` but carries no `compensation` — an incoherent rollback plan, visible before execution instead of at the point someone needs the undo. It reads the declared IR fields, not the classifier.
  - **`declared_rollback_contract`** is the whole proposal's contract: the **worst** of its actions' declared `reversibility` values, since a plan is only as recoverable as its least recoverable step (an empty batch is `"reversible"` — nothing to undo is not the same as unclassified). Note this envelope field and the per-row `reversibility` answer different questions: the envelope reports what the *author declared* in the IR, the rows report what the *classifier inferred*. A proposal written before this axis existed declares nothing, so its actions default to `irreversible` and the envelope reads `"irreversible"` even where the rows classify individual actions as `reversible`.
  - Both are conservative keyword heuristics — an unrecognized tool comes back `irreversible`. **`reversibility` is still classified, reported, and audited (`PermissionDecision` events carry it too), never enforced.** `required_tier` no longer is: since Parslee-ai/car#915 `proposal.submit` admits against it, and a `full_access` action is mandatory HITL regardless of the granted tier — so an over-classification on an automated connection is a rejection, not a nag. That is why the signals above are matched at boundaries rather than as substrings. Older daemons omit all three fields.
- **`permission.evaluate`** — Params `{ proposal, skill? }`. Returns `{ decisions: [{ action_id, fingerprint, decision: "allow"|"needs_approval"|"deny", required, reversibility, granted?, reason? }], skill_ceiling? }`. **`reversibility`** is on *every* row, `allow` rows included, and is orthogonal to `decision`: the gate's verdict says whether the action may run, not whether it could be taken back afterwards. Two actions that both escalate to `needs_approval` are not the same decision for a human if one of them is the one there is no undoing, and a trail that records the rollback contract only for actions the gate *stopped* is missing the rows an incident review reads first. Same classifier, same values, and the same "classified, not enforced" caveat as `permission.classify` above; older daemons omit the field. A `full_access` action always yields `needs_approval` (mandatory HITL) unless previously approved; a prior rejection yields `deny`. When `skill` names a governed skill (arXiv 2602.12430 "Agent Skills"), its persisted `deployment_tier` caps the session's standing authority for this evaluation — the effective tier is `min(granted, deployment_tier)`, so an action driven by a `read_only`-capped skill escalates instead of running even in a `full_access` session. The applied ceiling is echoed as `skill_ceiling`. This is the join from skill-trust governance to the action-level gate: the caller already knows which skill drove the actions, so it names it; the gate honours the ceiling without inventing action→skill provenance.
- **`permission.pending`** — Params `{ proposal, skill? }`. Returns `{ pending: [...] }` — only the `needs_approval` decisions (the approval work-queue), each row identical in shape to `permission.evaluate`'s, `reversibility` included. Honours the same optional `skill` ceiling as `permission.evaluate`. The field matters most here: this queue is where a human decides, and "can this be undone?" is the question they are actually weighing.
- **`permission.approve`** / **`permission.reject`** — Params `{ fingerprint, required_tier, reason?, evidence? }` (from a prior `evaluate`) **or** `{ action, reason?, evidence? }`. Records a durable decision on the **shared daemon ledger** (visible to every connection, restart-surviving) that overrides future evaluations of the same operation, and audits it as `ApprovalRecorded`. The `reviewer` is **stamped server-side** from the authenticated principal (bound `agent:<id>` or `conn:<id>`) — it is not a caller param, so the audit's "who decided" can't be forged. An under-scoped `required_tier` cannot widen access: the gate re-classifies the action and only honors an approval at or above its true tier. Returns the stored `ApprovalRecord`.
- **Authority**: when the daemon runs under a host token (CarHost), the mutating methods (`set_tier`/`approve`/`reject`) require the host-management role — a registered agent connection can classify/evaluate/pending but can't self-elevate or self-approve. In tokenless dev/embedder mode the connection governs its own session.

#### `agent_permissions.*` — per-agent approval policy (WS-only)

Orthogonal to the per-session standing tier above: a durable **per-agent** posture stored at `~/.car/agent-permissions.json`. For each agent and each risk tier (`read_only`/`sandbox_edit`/`full_access`), CAR either **always allows**, **requires approval** (routes through the shared approval ledger where an interactive approval channel exists), or **denies**. The store is a fully-specified `default` posture (Balanced by default — auto-allow reads, ask before edits/consequential actions), sparse per-agent tier overrides, and optional exact agent/tool overrides. Resolution for a tool call is exact `(agent_id, tool)` override → the existing gate result; both identifiers are literal, with no wildcard, prefix, regex, or tier-wide grant. An exact `always_allow` is narrower still: the target agent must be live and authenticated, the tool must be an eligible reverse callback registered by that exact session, and CAR persists the canonical digest of the schema it observed. The only eligible callback profile is the non-idempotent `newsroom.publish` capability with one required non-empty `edition_id` string and no additional parameters; aliases and generic executable, payload, or destination shapes remain on ordinary HITL. Admission rechecks the current callback digest. A changed or missing schema falls back to ordinary mandatory HITL, and a governed skill's lower `deployment_tier` remains an effective ceiling for both `permission.evaluate` and `proposal.submit` even when an exact override exists. A durable human rejection always wins. Authenticated bound WebSocket agents use the same exact evaluator for `permission.evaluate` and `proposal.submit`; a valid override can admit the callback when no lower skill ceiling applies even though it remains classified `full_access` and `irreversible`. Decisions retain their required tier and reversibility, and exact-override decisions carry `authorization_source: "agent_tool_override"` plus `authorization_schema_digest` in the decision/audit data. Backed by `car_policy::agent_permissions`; host-facing, consumed over the socket, so **WS-only** (no FFI proxy, like `runs.subscribe`/`coder.subscribe`).

Clients that require this exact override surface must include `permissions.agent-tool-overrides.v1` in `server.handshake.required_capabilities` and verify it appears in `negotiated_capabilities`. An older daemon rejects that mandatory capability before the client calls an override RPC.

- **`agent_permissions.get`** — Params `{}`. Returns the raw policy `{ default: TierPosture, agents: { <agent_id>: TierPosture }, tool_overrides?: { <agent_id>: { <tool>: { mode: ApprovalMode, schema_digest? } } } }`, where `TierPosture` is `{ read_only?, sandbox_edit?, full_access?: "always_allow"|"require_approval"|"deny" }`. `tool_overrides` is omitted when empty for backward-compatible persistence. Legacy string-valued tool overrides remain readable; a digestless `always_allow` is inactive and falls back to HITL.
- **`agent_permissions.set`** — **Host-management-only.** Params `{ agent_id, mode: "always_allow"|"require_approval"|"deny", tier? }`. Sets one tier for an agent, or every tier when `tier` is omitted.
- **`agent_permissions.set_default`** — **Host-management-only.** Params `{ preset: "cautious"|"balanced"|"trusting" }` **or** `{ tier, mode }`. Moves the default posture applied to agents without an override.
- **`agent_permissions.reset`** — **Host-management-only.** Params `{ agent_id }`. Drops an agent's tier override so it reverts to the default; exact tool overrides are managed independently.
- **`agent_permissions.evaluate`** — Params `{ agent_id, tier }`. Returns `{ agent_id, tier, mode, has_override }` — the resolved decision the executor/HITL path consults before an agent acts.
- **`agent_permissions.set_tool`** — **Host-management-only and capability-gated.** Params `{ agent_id, tool, mode: "always_allow"|"require_approval"|"deny" }`. Sets one literal pair; a managed agent cannot self-grant. For `always_allow`, the named agent must currently be attached with the exact eligible `newsroom.publish` callback profile described above. The server records its schema digest; callers must not supply `schema_digest`.
- **`agent_permissions.reset_tool`** — **Host-management-only.** Params `{ agent_id, tool }`. Removes one literal pair.
- **`agent_permissions.evaluate_tool`** — **Host-management-only and capability-gated.** Params `{ agent_id, tool, tier }`. Returns the exact override when present, otherwise the tier posture, plus `has_tool_override`, `active`, `schema_bound`, `schema_digest_present`, the stored non-secret `schema_digest` when present, and `authorization_source`. For `always_allow`, `active` is true only while the exact authenticated agent callback is attached with the matching current schema.

#### `infer`
- **Params**: `GenerateRequest { model: string, messages: Message[], system?: string, max_tokens?: number, temperature?: number, tools?: ToolDef[], context_query?: string, memory_intervention?: boolean | ProactiveMemoryRequest, response_format?: ResponseFormat, intent?: IntentHint, ... }`
- **Returns**: `{ text: string, tool_calls: ToolCall[], usage: { input_tokens, output_tokens }, model_used: string, trace_id: string, latency_ms: number, time_to_first_token_ms: number | null, stop_reason: string | null }`
- Supplying a non-null `model` is a hard pin. The daemon forces `params.strict_model` to `true` even when the caller sends `false`, so an error from the selected provider is returned directly instead of appending CAR's on-device last-resort fallback. Omit `model` to let adaptive routing select and fall back across eligible models.
- `time_to_first_token_ms` is the wall-clock from request start to the first generated token sample, populated by the local Candle/MLX paths. Always present in the response (`null` when not measured — currently the non-streaming remote path; for honest TTFT on remote models, use streaming and time the first chunk client-side).
- `stop_reason` is the raw provider termination reason (OpenAI `finish_reason`, Anthropic `stop_reason`, Google `finishReason`). Always present (`null` for local backends or providers that don't report one). A value of `"length"` / `"max_tokens"` / `"MAX_TOKENS"` means the output was truncated at the token cap. On local Qwen3 hybrid-thinking models it is also set by the reasoning-recovery path: when the caller leaves `thinking` on `auto` and reasoning consumes the whole `max_tokens` budget inside an unclosed `<think>` block (leaving empty text), CAR retries once with reasoning suppressed and returns the direct answer with `stop_reason: "thinking_recovered"`; if even the retry is empty the result carries `stop_reason: "thinking_truncated"`. This keeps a small-budget `infer` from silently returning `""` (car-releases#60, #62). A model CAR decodes **in this process** (`mlx/*`, `local/*` — not vLLM-MLX, which is an HTTP server) is additionally bounded by a wall-clock ceiling, `CAR_LOCAL_DECODE_TIMEOUT_SECS` (default `300`, `0` disables): reaching it stops the decode, keeps whatever text was produced, and returns `stop_reason: "local_decode_timeout"`. The ceiling (and the decode-progress logging that goes with it) lives in the MLX decode loops, so it covers in-process decoding **on Apple Silicon**; on other platforms the in-process path is Candle, which is not yet bounded — it does get the `max_tokens` rule below, which takes away the widening that made an in-process decode run long. That value counts as truncation for `was_truncated()`. **If the ceiling is reached before any text or tool call exists, `infer` returns a JSON-RPC error rather than an empty success** — a turn nobody can act on has to read as a failure. Such a model also no longer has its `max_tokens` silently widened to the model's advertised output cap: an in-process token budget is spent as wall clock, and a 131072-context model widened 4096 to 32768 was ~24 minutes of silent decode per turn (#851). Remote models and vLLM-MLX still get the widening.
- If `context_query` is set, CAR builds a memory context for that query and injects it into the request automatically.
- Proactive memory runs before inference for long-horizon/high-stakes requests: sessions already granted `FullAccess`, requests with `intent.high_stakes`, requests with tools, and `intent.task` of `code` or `reasoning`. It appends at most one targeted `## Proactive Memory` reminder to the request context. `memory_intervention: false` or `null` is a hard opt-out; `true` forces the default proactive request; an object is parsed as `memory.intervene` params. This is a two-phase pass: first `memory.maintain` updates compact execution-state memory from the recent event log, then the selector decides whether to inject or remain silent. A silent decision leaves the request unchanged. It can be combined with `context_query`; the reminder is appended after the assembled memory context. The selector merges explicit trigger fields with recent runtime telemetry from the session event log: `ActionFailed`, `ActionRetrying`, `ReplanExhausted`, ungrounded `GoalEvaluated` completions, and truncated/max-turn/stalled `TurnCompleted` records. Full-access/high-stakes sessions also set the high-risk trigger.
- `response_format` constrains output to JSON. Two variants: `{ "type": "json_schema", "schema": <JSON Schema>, "strict": bool, "name"?: string }` or `{ "type": "json_object" }` for the looser JSON-mode form. Maps to OpenAI `response_format`, Google `responseMimeType` + `responseSchema`. **Anthropic** is not wired for a provider-enforced `response_format` field under CAR's pinned `anthropic-version`, so CAR rejects both variants rather than silently weakening the request: `json_object` returns `UnsupportedMode` with `mode: "structured-output-json"` and `json_schema` returns `mode: "structured-output-json-schema"`, both with `backend: "anthropic"`. Supply a tool whose input schema is your schema plus a forcing `tool_choice` for structured Claude output. This applies to both `infer` and `infer_stream` (the streaming path performs the same rejection before credential lookup). **Known-remaining silent paths** (unchanged this pass): Bedrock Converse has no response-format field, so `response_format` is silently ignored on Bedrock models. The `parslee/*` proprietary endpoint rejects any `response_format` (`backend: "parslee-inference"`).
- `params.tool_choice` is honored per provider, not just on OpenAI — but the supported vocabulary is provider-dependent:
  - **Portable subset** `"auto"` (default when tools present) / `"required"` / `"none"` — accepted on OpenAI-family, Anthropic, and Google. `"required"` maps to Anthropic `{"type":"any"}` and Google mode `ANY`.
  - **Forcing modes** `"any"` and a specific tool NAME — honored on **Anthropic** (`{"type":"any"}` / `{"type":"tool","name":...}`), **Google/Vertex** (mode `ANY`, a name adds `allowedFunctionNames: [name]`; previously hardcoded `AUTO`), and **Bedrock** (a name → `{"tool":{"name":...}}`). **OpenAI-family passes the `tool_choice` string through verbatim**, so `"any"` or a bare tool name is sent as-is and the OpenAI API 400s — use `"required"` there. This OpenAI passthrough is pre-existing and deliberately unchanged.
  - **Managed (`parslee/*`) lane** — the shipped inference gateway speaks the OpenAI Responses contract, and CAR maps into it rather than passing through: `"auto"` → `"auto"`, `"required"` **and** `"any"` → `"required"`, `"none"` → `"none"`, and a specific tool NAME → `{"type":"function","name":...}` (a bare name is not valid on Responses). Two differences from every lane above, both deliberate: the mapping is applied instead of the OpenAI-family verbatim passthrough, so `"any"` and a tool name work here; and **an unset `tool_choice` emits no field at all** rather than defaulting to `"auto"` — this gateway answers an unexpected request field with an opaque HTTP-200 `event: error` that reads as "no content", so the field only rides when a caller asked for it. Before this, the managed request body carried `tools` but no choice at all, so tool use could not be forced on the managed lane (car#895). **The gateway does not yet bind this field.** Its request record has no `tool_choice` member (confirmed by reading the endpoint owner's own source, not inferred from behavior), and its JSON binder skips unmapped members rather than rejecting them — so the field CAR sends is accepted and ignored, and the upstream call runs at the provider default. A managed caller who asks for `required` still does not get a forced tool call today. CAR emits the correct Responses spelling so the knob takes effect the moment the gateway binds it; closing it end-to-end needs a change on the endpoint owner's side (car#895).
  - **Managed (`parslee/*`) tool DEFINITIONS use the flat Responses shape** — `{type:"function", name, description, parameters}`, not the Chat-Completions `{type:"function", function:{…}}` nesting. That is what the endpoint's contract names: its tool DTO declares the flat fields directly and carries a separate optional nested member it unwraps, so the nested form is accepted as a second spelling rather than being the declared one. Nothing in that source marks the nested form deprecated — CAR emits the declared shape because relying on the other one is a bet on unstated intent, not because a break is imminent. Both managed call sites used to emit the nested shape; both now emit the flat one (car#1010, car#1011). Personal Chat-Completions models are unaffected and keep the nested shape their own endpoints require.
  - **Caveats:** `params.parallel_tool_calls: false` adds Anthropic `disable_parallel_tool_use`. On Anthropic a forcing choice (`any` / a named tool) **wins over auto-enabled extended thinking** for that request — thinking is dropped and a warning logged (Anthropic rejects forced tool use + thinking). **Bedrock Converse has no `none` mode**: a `"none"` string falls through to a forced tool literally named "none" (`{"tool":{"name":"none"}}`), so `tool_choice: "none"` is effectively unsupported on Bedrock. `tool_choice` is only emitted when `tools` are present; OpenAI and Bedrock tool_choice mapping is otherwise unchanged.
- `intent` is an optional `IntentHint` that lets callers express task semantics without pinning a model id. Shape: `{ task?: "chat" | "classify" | "summarize" | "reasoning" | "code" | "extract", prefer_local?: boolean, prefer_fast?: boolean, prefer_quality?: boolean, high_stakes?: boolean, require?: ModelCapability[] }`. When set together with `model`, the explicit model wins (`intent` is recorded for telemetry but does not override the pin). When set without `model`, the adaptive router uses `require` as a hard filter and `task` / `prefer_local` / `prefer_fast` / `prefer_quality` as score biases. `high_stakes` (consequential/irreversible work) forces the strongest quality posture and outranks every other bias — the daemon sets it automatically for `FullAccess`-granted sessions. Omitting `intent` preserves the no-hint adaptive routing behavior bit-for-bit. See `docs/proposals/policy-intent-surface.md` for the full surface.
- **Prompt caching (Anthropic).** `cache_control: boolean` (top-level, default `false`) marks the system prompt, the last tool definition, and — for multi-turn requests (≥2 messages) — the growing conversation prefix with `cache_control` breakpoints so a shared prefix is read from cache (~0.1× input) instead of reprocessed. When `context_query` is set, the assembled memory context is split at the stable Identity+Constraints boundary and the system breakpoint is placed after it, so the stable prefix hits across queries instead of being re-written every request (the volatile facts/conversation/environment tail stays uncached). `context_stable_prefix` (a prefix of `context`) carries this hint explicitly for callers that build the context themselves; it is ignored unless it is a genuine prefix of the system and `cache_control` is on. `params.cache_ttl: "five_minutes" | "one_hour"` (default `"five_minutes"`) sets the cache lifetime uniformly across every breakpoint; use `"one_hour"` for agentic loops where minutes pass between calls (tool execution, HITL approval) so the prefix survives instead of silently expiring. The TTL is uniform per request, so Anthropic's "1-hour entries must precede 5-minute" ordering rule never applies. Ignored by non-Anthropic providers. When caching is requested but nothing was cached (prompt below the model's minimum cacheable length, ~1024 tokens on Opus 4.8, or a churning prefix), the daemon logs a debug line — there is no error, by Anthropic's design.
- **Cache-aware routing estimates.** `params.estimated_cache_read_input_tokens`
  and `params.estimated_cache_write_input_tokens` are caller-supplied estimates
  used only to price adaptive-routing candidates (including OpenRouter's
  per-model cache rates). Both default to `0`; `cache_control` never implies a
  hit or write. CAR clamps the two mutually exclusive buckets to the estimated
  prompt footprint. They do not alter the provider payload and are not actual
  usage telemetry.
- `usage` carries the prompt-cache split when the provider reports it: `{ prompt_tokens, completion_tokens, total_tokens, cache_read_input_tokens, cache_creation_input_tokens }`. `prompt_tokens` is the **uncached** prefix only; `cache_read_input_tokens` (hit) and `cache_creation_input_tokens` (write) account for the cached portion, so true input is the sum of all three. Both cache fields are `0` for uncached calls and non-caching providers. This is normalized across providers: Anthropic reports the uncached tail directly, while OpenAI's `cached_tokens` (Chat Completions `prompt_tokens_details` / Responses `input_tokens_details`) is subtracted out of `prompt_tokens` so the cached part isn't double-counted. The durable cost view (`outcomes.scoreboard`) prices each bucket at the provider's own cache rate — Anthropic ~0.1× read / ~1.25×–2× write, OpenAI ~0.5× read with no write charge.
- **A content refusal is its own error code, `-32007` — not `-32603`.** When
  something in FRONT of the model declines the request's content — a managed
  gateway's content filter, a provider's moderation layer — `infer` (and
  `infer_stream`, for a rejection raised before the stream opens) returns JSON-RPC
  error `-32007` with a message prefixed `content refused:`, followed by the
  provider's own text including its `type=` / `code=` tags where it sent them
  (e.g. `content refused: parslee refused this request on content grounds
  (type=invalid_request_error, code=content_policy_violation): …`). The numeric
  code is the contract; the prefix is the fallback for consumers that only see
  the flattened message string. **What to do with it:** record it as a policy
  refusal and do **not** retry — the ruling is deterministic for that content, so
  a retry replays it and spends the budget for nothing. It is not a fault
  signal: it says nothing about the health of the model, the lane, or the
  daemon, and CAR does not count it against the provider's circuit breaker.
  Everything else — a crashed backend, a dead credential, a timeout — still
  returns `-32603`, so `-32007` is safe to treat as "blocked, by design"
  (Parslee-ai/car#796). **Both stream timings are covered.** A refusal raised
  before the stream opens still carries its type, and one raised *mid-stream*
  reaches the daemon as flattened text — but the verdict there is read from the
  same `type=` / `code=` tags, using the same function the non-streaming path
  uses, so `infer_stream` returns `-32007` either way. Note that a mid-stream
  refusal can arrive *after* `inference.stream.event` frames have already
  delivered partial text; the frames you received stand, and the call still ends
  in `-32007`. A stream failure whose gateway sent no classification tags stays
  `-32603`.

  **A refusal reaches you instead of being answered by a fallback model.** CAR
  normally advances its fallback chain when a candidate fails, and a remote-only
  chain has an installed on-device model appended as its last resort. A content
  refusal is exempt: the chain cannot vary the request, so every remaining
  candidate would replay the payload the filter just declined — and the on-device
  tail has no filter in front of it, so it would answer, and its answer would be
  attributed to the model you asked for. That silent substitution is what made
  the reported benchmark's counts move between runs. The chain now stops at the
  refusal and returns `-32007`. If you *want* a fallback attempt for refused
  content, make it yourself against an explicitly chosen second model — CAR will
  not choose one for you behind a refusal.
- **Local models report `usage` too.** The in-process MLX and Candle paths report the post-truncation prompt length and the number of tokens they sampled; the mlx-vlm CLI path reports the counts the CLI prints (image patches included). Both cache fields are always `0` — on-device inference has no remote prompt cache. `usage` is `null` only when nobody could produce a count: Apple FoundationModels (the framework exposes none), a delegated runner that emits no `usage` stream event, and an mlx-vlm build whose performance summary doesn't parse. `null` is deliberate rather than a zeroed struct — a consumer summing `total_tokens` can't distinguish a fabricated `0` from a real "this used no tokens", so treat `null` as "estimate it yourself" (car#795).

#### `infer_stream`
- **Params**: same `GenerateRequest` shape as `infer` (including the `context_query` and `memory_intervention` conveniences).
- Explicit-model pinning is identical to `infer`: a non-null `model` forces `params.strict_model: true`, overriding `false`, and the selected provider's error is surfaced without adding CAR's on-device last-resort fallback. Omit `model` for adaptive fallback.
- **Returns** (final JSON-RPC response): `{ text: string, tool_calls: ToolCall[], usage: { input_tokens, output_tokens } | null, stop_reason: string | null, trace_id: string, model_used: string }`. `trace_id`/`model_used` (added for parity with non-streaming `infer`) identify the model that produced the turn and the trace the outcome was booked under — a client can use them to attribute the turn or resolve outcomes later. When the session marks the request as a chat turn (`intent.task == "chat"`), the daemon also feeds the conversation-outcome signal from the streamed turn, same as `infer`.
- **Server → client notifications during the run**: `inference.stream.event` with params `{ request_id: <original RPC id>, event: { type, ... } }`. Event types:
  - `{ "type": "text", "data": "<chunk>" }`
  - `{ "type": "tool_start", "name": "<tool>", "index": <int> }`
  - `{ "type": "tool_delta", "index": <int>, "data": "<json fragment>" }`
  - `{ "type": "usage", "input_tokens": <n>, "output_tokens": <n>, "cache_read_input_tokens": <n>, "cache_creation_input_tokens": <n> }` — `input_tokens` is the uncached prefix; the cache fields carry the prompt-cache split decoded from the stream (Anthropic `message_start`, OpenAI final usage chunk). `0` when uncached / non-caching. Streamed calls now price cache identically to non-streaming. **Local (in-process MLX/Candle) streams emit this event too**, once at end of generation with the counts their decode loop observed — before car#795 they emitted none, so every streamed local turn ended with `usage: null` while the non-streaming call for the same model returned real numbers. `context_window` is absent from the stream event and therefore `0` in the accumulated `usage`: stream events carry no model metadata. Non-streaming `infer` populates it.
  - `{ "type": "stop_reason", "data": "<provider termination reason>" }` — raw provider string (`"length"`/`"max_tokens"` ⇒ truncated at the token cap)
  - `{ "type": "provider_output_item", "item": { ... } }` — an opaque OpenAI Responses continuity item. Managed reasoning items preserve `id`, `status`, `summary`, and `encrypted_content` verbatim so the caller can replay them as `Message::ProviderOutputItems` on the next turn. Personal OpenRouter's Chat Completions path never emits this event.
  - `{ "type": "error", "message": "<sanitized provider failure>" }` — terminal failure, including an OpenRouter error frame delivered inside an HTTP-200 SSE response. The final JSON-RPC response is an error (never a successful `result`), and the trace is booked as a failure with no inference-metered success telemetry.
- Successful completion is delivered as the final JSON-RPC response (with the
  accumulated `text` + `tool_calls`), not as a `done` notification. Direct
  NAPI/Python inference-streaming symbols are unsupported compatibility stubs;
  use this WebSocket contract. Closes
  [Parslee-ai/car-releases#30](https://github.com/Parslee-ai/car-releases/issues/30).

#### `image.generate`
- **Params**: `GenerateImageRequest { prompt: string, model?: string, width?, height?, steps?, guidance?, seed?, output_path?, ... }`. Mirrors `InferenceEngine::generate_image` field-for-field.
- **Returns**: `GenerateImageResult { image_path: string, model_used, latency_ms, ... }`
- The CLI's `car image …` routes through this method first and falls back to an in-process engine only when the daemon is unreachable (Parslee-ai/car#186). Shares the same admission gate as `infer` / `video.generate` so concurrent image bursts can't smuggle around the concurrency cap.

#### `video.generate`
- **Params**: `GenerateVideoRequest { prompt: string, model?: string, width?, height?, num_frames?, steps?, guidance?, seed?, fps?, output_path?, format?, image_path?, video_path?, audio_path?, audio_passthrough: boolean, mode?: VideoMode, ... }`. `VideoMode` is one of `t2v | i2v | audio_video | audio_ref_video | extend | retake`; inferred from inputs when unset.
- **Returns**: `GenerateVideoResult { video_path: string, model_used, latency_ms, ... }`
- **`audio_passthrough` gate (Parslee-ai/car#185)**: when `audio_path` is set AND the resolved mode is `audio_ref_video`, the request MUST also set `audio_passthrough: true` to acknowledge the muxing-only behavior. No in-tree backend currently conditions video generation on audio bytes (tracked at [Parslee-ai/car#130]). Requests that omit the opt-in fail with a clear error rather than silently producing text-only video. The CLI's `car video --audio-mux <path>` flag sets `audio_passthrough: true` implicitly; raw JSON-RPC callers set the field directly.
- Mirrors the in-process `InferenceEngine::generate_video` shape so the CLI (which previously constructed an in-process engine — a v0.7 holdover) can route through the daemon and inherit its admission gate.

#### `embed`
- **Params**: `{ texts: string[], model?: string }`
- **Returns**: `{ embeddings: number[][] }`

#### `classify`
- **Params**: `{ text: string, labels: string[] }`
- **Returns**: `{ classifications: Classification[] }`

#### `tokenize`
- **Params**: `{ model: string, text: string }`
- **Returns**: `{ tokens: number[] }` — raw u32 token IDs from the named local model's tokenizer (no chat-template wrapping, no BOS prepending).
- Local models only (Qwen3 GGUF / MLX). Remote models return an `UnsupportedMode` error — provider tokenizers vary too widely to bundle. Pair with `detokenize` for the round-trip property `detokenize(model, tokenize(model, s)) == s`.

#### `detokenize`
- **Params**: `{ model: string, tokens: number[] }`
- **Returns**: `{ text: string }` — inverse of `tokenize`, decoded without skipping special tokens.

---

## Notification methods (server → client)

These arrive as JSON-RPC notifications (no `id`). The client doesn't respond to them.

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
`kind` values: `agent.registered`, `agent.unregistered`, `agent.status_changed`, `approval.requested`, `approval.resolved`, `host.notification`, `device.registered`, `device.updated`, `browser.signin_needed`, `browser.signin_resolved`.

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

### `voice.event`
Pushed during active `meeting.*`, `voice.transcribe_stream.*`, and `voice.tts_stream.*` sessions. Payload includes transcript segments, partials, finals, source identifiers, and TTS chunk metadata (`type = "tts_chunk"` carrying `{ stream_id, seq, audio_b64, format, is_final }`).

### `coder.event`
Pushed to `coder.subscribe`d connections during a coder session. `seq` is
monotonically increasing per session (the resume cursor for
`coder.subscribe { from_seq }`).
```json
{
  "jsonrpc": "2.0",
  "method": "coder.event",
  "params": {
    "session_id": "coder-…",
    "seq": 17,
    "ts": 1781234567,
    "type": "check_completed",
    "result": {
      "name": "tests_pass", "passed": true, "exit_code": 0, "output_tail": "…",
      "duration_ms": 8123, "timed_out": false, "deadline_clamped": false
    }
  }
}
```
A `CheckResult` carries two additive booleans alongside the verdict (both
optional, defaulting to `false`, so a result persisted before car#1053 still
deserializes). `timed_out` says the command was killed at a timeout instead of
exiting on its own; `deadline_clamped` says the timeout it was killed at was the
**session's** remaining wall-clock budget rather than the check's own ceiling.
That ceiling is `min(timeout_secs, 600)` — every contract command runs through
the coder shell, which caps any timeout at 600s — so a check declaring
`timeout_secs: 900` that dies at 600 with 700s of session budget left reports
`deadline_clamped: false`: the shell ceiling cut it, not the clock.
Both together mean the check was starved by the session clock
and its `passed: false` is not a verdict on the work — see "A starved gate is
not a red contract" in `docs/car-code-task.md`. `timed_out` alone is an ordinary
red: the check hung inside its own ceiling.
`type` values and their payload fields: `state_changed {from, to}`,
`contract_proposed {contract}`, `engine_selected {engine, reason}`,
`engine_fallback {from, to, reason}`,
`model_fallback {from, to, reason}` (the preferred inference **lane** was
skipped and a different MODEL served the call — distinct from
`engine_fallback`, which is about the coder engine, native vs an external CLI,
not the model behind it. Emitted at most once per **phase** — contract
derivation, each contract revision, and the run loop announce independently, and
a session that degrades in more than one of them emits more than one; the guard
is against narrating every routing decision inside a phase, not against a second
phase reporting a degrade the operator has not seen resolved. Currently emitted
only when the skipped lane's credential was **rejected**: the run keeps working
on a fallback backbone, so without this event an operator whose sign-in lapsed
sees a healthy run on a model they never chose. `reason` names the remedy),
`iteration_started {n, max}`,
`budget_exhausted {reason, elapsed_secs, iterations}` (the session hit its
wall-clock ceiling and the next iteration was not admitted; the session ends in
`failed` — it does not reach the approval gate, which requires green checks —
but its worktree is retained on disk at `workspace_path` so the partial work
survives for inspection),
`invocation_retried {hypothesis, reason, retries_remaining}` (an external-CLI
invocation died mid-run — timeout or I/O — with the contract still red, and the
same hypothesis is being re-invoked; this costs no `iteration_started`, so one
iteration may legitimately show two runs), `plan_text {text}`,
`tool_call {tool, params_preview}`,
`tool_result {tool, ok, preview}`, `check_started {name}`,
`check_completed {result}`, `external_event {raw}` (forwarded external-CLI
stream event), `diff_ready {stat, patch, patch_truncated, patch_full_bytes, changed_paths, contract_overlap}` (`changed_paths` counts BOTH endpoints of a rename, so one moved file is two paths; `contract_overlap` lists checks whose commands execute paths this diff also modified — disclosure, not a denial),
`user_input_requested {prompt}` (reserved),
`user_input_expired {prompt, waited_secs}` (the answer window closed
server-side without an answer and the loop carried on without one — the prompt
is DEAD). A client has no other way to learn this: the gate simply stops being
pending, which is only discoverable by asking again, so a board kept rendering
the question as live and counting it under "needs you" until the operator
refreshed. It also drives the `coder.session_changed` that drops `needs_you`
back to `null`,
`auth_required {message, wait_secs}` (the run is blocked on **sign-in**.
`wait_secs > 0` means the loop is waiting rather than failing — **not terminal**:
if a credential appears within `wait_secs` the session resumes where it stopped,
worktree intact, and no iteration is consumed. `wait_secs: 0` means this emitter
is **not** waiting and the call is ending: contract derivation and contract
revision are synchronous RPCs the client is blocked on, and a run loop with no
auth gate configured — the default adaptive-routing path — has nothing to poll a
sign-in against, so it says "sign in" and then fails the turn normally instead of
stalling for minutes — and it says it at most **once per run**, because it cannot
resume, so the second and third strike would repeat a prompt that has not changed.
A `wait_secs > 0` emitter repeats on every lapse instead: it can resume, so a
second lapse after a successful sign-in is a new event the operator must act on
again. Either way the remedy is the same: `car auth login`, then
start or revise again). Surface this as an action the user can take ("sign in to
continue"), not as an error: it is the one failure mode a person at the machine
clears in seconds, and it previously surfaced as `no inference backend is
available`, which points at models and accounts rather than at the sign-in it
actually needs. Only the **native** engine emits it — an external CLI owns its
own credentials, so CAR has nothing to re-authenticate on its behalf. If nobody
signs in within the window the session ends with a distinct `needs_auth`
failure rather than `infrastructure`, and its worktree is retained, so re-running
after `car auth login` resumes from the work already done.
`contract_revision_rejected {request, reason}` (a `coder.revise_contract`
request could NOT be honored — the redraft did not validate, or the request was
not expressible as checks — and the session is still sitting on the PREVIOUS
contract; its own event rather than a generic `error` because an operator has to
know the contract in front of them is the old one),
`merge_completed {branch}`, `error {message}`.

### `coder.session_changed`
Pushed to `coder.watch`ing connections whenever any session is created, changes
`state`, changes `needs_you`, changes `error`, or reaches a terminal state.
```json
{
  "jsonrpc": "2.0",
  "method": "coder.session_changed",
  "params": { "summary": { "session_id": "coder-…", "state": "needs_approval", "needs_you": "approval", "needs_you_label": "diff ready for approval", "…": "…" } }
}
```
`summary` is the full `session_summary` documented under `coder.list`. Emitted
from the event path rather than a poller, so an operator-attention transition
reaches an open board in well under 5 s. It is a *notification*, not a stream
with a cursor: a client that missed frames re-derives the whole list from
`coder.watch`.

### `coder.discuss.event`
Pushed to `coder.discuss.subscribe`d connections during a discussion. `seq` is
monotonic per discussion (the resume cursor for
`coder.discuss.subscribe { from_seq }`).
```json
{
  "jsonrpc": "2.0",
  "method": "coder.discuss.event",
  "params": { "discussion_id": "disc-…", "seq": 7, "ts": 1781234567, "type": "assistant_delta", "text": "…" }
}
```
`type` values and their payload fields: `user_message {text}`,
`assistant_delta {text}` (streaming chunk), `assistant_message {text}`
(the complete turn), `tool_call {tool, params_preview}`,
`tool_result {tool, ok, preview}` — **`ok` is always `false` today**: the underlying loop does not surface successful tool results as their own event (the model's following text conveys them), so the only `tool_result` emitted is the auto-denied write/shell refusal below. Treat a success row as reserved, not as something to wait for.
`turn_complete {}`, `error {message}`.

A `tool_result` with `ok: false` is how the no-mutation boundary surfaces: a
discussion's write/shell attempt is auto-denied and reported, never silently
dropped and never parked as a human approval prompt.

Each subscriber is fanned to through its own bounded queue, so a subscriber that
stops reading is **dropped from the fanout** (queue full, or a write that does
not complete within 10 s) rather than being allowed to delay the discussion's
turn. Its stream just ends; re-`subscribe` with `from_seq` to resume from the
last `seq` seen, up to the 2000-event buffer.

When the **Foreman (parallel)** engine runs, it reports its pipeline through
`external_event` payloads whose `raw` object is tagged `foreman`. Run-level
stages: `{foreman: "planning", adapter}`, `{foreman: "planned", subtasks,
levels, prefer_single_session}`, `{foreman: "union_verified", applied}`, and
`{foreman: "union_rejected", reason, implicated, detail}` — emitted when the
integrated union is rejected even though the subtasks gated green individually;
`reason` is `patch conflict` | `duplicate declaration` | `build/test failed` |
`rejected`, `implicated` is the list of subtask ids blame attributes the failure
to, and `detail` is a short human string. A renderer flags the implicated rows
and shows why (see the CarHost Coder tab's board).
Per-subtask lifecycle (per farmed-out subtask, in order):
`{foreman: "subtask_started", subtask_id, index, level, total}` (worktree
provisioned, agent editing) →
`{foreman: "subtask_verifying", subtask_id}` (agent done, gate build/test
running — its own event because that phase can dominate wall-clock) →
`{foreman: "subtask_gated", subtask_id, accepted, status}` where `status` is
`accepted` | `rejected` | `inconclusive` | `error`. (An agent that fails before
the gate goes `subtask_started` → `subtask_gated` with `status: "error"`, no
`subtask_verifying`.) Subtasks in the same `level` run concurrently, so their
events interleave. A renderer can fold these into a live per-subtask board (see
the CarHost Coder tab). Unknown `foreman` stages should be ignored
(forward-compatible).

---

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

// client → server (response)
{ "jsonrpc": "2.0", "result": { "stdout": "...", "stderr": "" }, "id": 17 }
```

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
| `-32004` | Handler deadline exceeded; the operation may have committed, so consult the method's authoritative read before retrying. `proposal.submit`'s deadline is derived from the submitted proposal's action budgets rather than flat, so an in-budget proposal is not abandoned |
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

{% endraw %}
