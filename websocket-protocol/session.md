{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### session

#### `session.init`
- **Params**: `SessionInitRequest` — `{ client_id: string, tools?: ToolDefinition[], policies?: PolicyDefinition[] }`
- **Returns**: `{ session_id: string, tools_registered: number, policies_registered: number }`
- `client_id` is **required** and was missing from this line in earlier
  revisions; a payload without it is rejected before any tool is registered.
  `tools` and `policies` both default to empty.
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

#### `session.clear_halt`
- **Params**: `{}`
- **Returns**: `{ cleared: boolean, halted: false }`
- **Packaged clients**: `HostClient.sessionClearHalt` / `session_clear_halt` uses the runtime's existing connection and never loads a host token or authenticates a new connection. It fails unless the caller has already explicitly authenticated that same connection as host. It cannot clear another runtime's latch; ordinary clients recover by reconnecting.
- Clears the terminal-tool-failure latch on this exact WebSocket connection. The caller must have authenticated this connection with `session.auth { host_token }`; ordinary authenticated clients are rejected. `cleared` is false when the latch was already clear. Reconnect is the ordinary client recovery path and starts with a fresh, clear latch; this method does not alter or synthesize a durable run outcome.

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


{% endraw %}
