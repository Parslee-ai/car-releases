{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### registry

File-based agent registry for cross-process discovery (issue #111). Each agent owns one JSON file under `~/.car/registry/<name>.json`; menubar / tray UIs poll the directory to enumerate running agents and their dashboards. There is no daemon — the directory itself is the shared state, and atomic writes (temp + rename) provide consistency. Operator and host sessions may pass `registry_path` on any method to override the default `~/.car/registry/` location (mainly for tests or per-tenant isolation). A session authenticated as a supervised agent may not: a call from one that names `registry_path` is refused ("does not accept `registry_path` from a supervised agent") and the refusal is logged, so an agent cannot point the registry at another agent's files. Running/idle entries from the user-default registry are also surfaced by `discovery.resolve` (kind `registry`), so a heartbeating local service is routable — set `capability` on the entry to rank it well.

#### `registry.register`
- **Params**: `{ entry: { name: string, dashboard_url: string, status?: "running"|"idle"|"errored"|"stopping", display_name?: string, capability?: string, port?: number, pid?: number }, registry_path?: string }` — `capability` is a natural-language description of what the service does; `discovery.resolve` ranks the service against a need by it (without it the service still resolves but ranks on its label alone).
- **Returns**: `null`
- Atomic write — concurrent readers never see a half-written entry. `name` and `dashboard_url` are required; missing-or-zero `registered_at` / `last_heartbeat_at` get filled with the current time.
- **Who writes which rows.** A session bound to a supervised agent may register only the entry whose `name` is its own agent id, the one row `registry.list` shows it; any other `name` (or none) is refused ("an agent writes only its own registry entry") and the refusal is logged. Host sessions, the daemon-token operator and the CLI may write any entry. The same rule holds for `registry.heartbeat` and `registry.unregister`.

#### `registry.heartbeat`
- **Params**: `{ name: string, registry_path?: string }`
- **Returns**: `{ refreshed: boolean }` — `false` indicates the agent isn't currently registered (caller should re-register)
- Recommended cadence: every 20s.
- A session bound to a supervised agent may name only its own agent id; see `registry.register`.

#### `registry.unregister`
- **Params**: `{ name: string, registry_path?: string }`
- **Returns**: `null`
- Idempotent. A session bound to a supervised agent may name only its own agent id; see `registry.register`.

#### `registry.list`
- **Params**: `{ registry_path?: string }`
- **Returns**: `AgentEntry[]` — sorted by `name`. Corrupt JSON files in the registry directory are silently skipped.
- **Who sees which rows.** A session bound to a supervised agent (`session.auth { agent_id, token }`) gets only the entry whose `name` is its own agent id, on every platform. Host sessions, the daemon-token operator and the CLI get every entry.

#### `registry.reap`
- **Params**: `{ max_age_secs?: number = 60, registry_path?: string }`
- **Returns**: `string[]` — names of reaped entries
- Recommended cadence: every 30s from the menubar process. Default 60s threshold catches an agent that missed two consecutive 20s heartbeats.
- On Linux a session bound to a walled supervised agent cannot call `registry.reap`: a walled agent is default-denied any method unless its role or the walled-agent list allows it, and this one is on neither. (CAR's own assistant runs unwalled.) Elsewhere, and for an unwalled agent, a session bound to a supervised agent reaps only its own entry: another agent's entry is left in place however stale it is, and the result lists at most the agent's own id. Host sessions, the daemon-token operator and the CLI reap every stale entry.


{% endraw %}
