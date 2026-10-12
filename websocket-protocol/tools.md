{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### tools

#### `tools.register`
- **Params**: `ToolDefinition[]` (an array, not an object)
- **Returns**: number of tools registered

`ToolDefinition`: `{ name: string, description?: string, parameters?: object }`. Tools registered here are dispatched via `tools.execute` callbacks during proposal execution.

#### `tools.list`
- **Params**: none
- **Returns**: `{ tools: [ToolSchema], count: number }`, where each `ToolSchema` is `{ name, source, description, parameters, returns?, idempotent, cache_ttl_secs?, rate_limit? }`; `source` is the runtime-assigned `builtin | user_defined | subprocess | mcp` origin category (other optional fields are omitted when unset)
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


{% endraw %}
