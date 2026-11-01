{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

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
and local stdio servers (`connectors.add_stdio`). A remote (HTTP) connector
reply longer than 8 MiB is an error naming the cap, rather than being read
without end. A remote connector follows a redirect only on the origin (scheme,
host and port) of the URL it was added with; a 307 or 308 that only upgrades it
from `http` to `https` on the same host is re-sent there with the same auth
headers, and any other cross-origin redirect is an error naming that origin, so
the call's body and the connector's auth headers never reach a host nobody
added. A server that really moved is added again at its new URL.

**Governance.** A connector's tools are denied wholesale by registering a
`policy.register { rule: "deny_connector", target: "<slug>", name: "…" }`
policy — connector tools are named `mcp_{slug}_{tool}`, so one rule governs
the whole connector (the policy-level counterpart to per-tool enablement).

**Team config.** A secret-free `.car/connectors.toml` (nearest one, walking up
from cwd to the git repository root, or only cwd's own outside a repository;
CAR's own `~/.car` is never read as a team file) seeds connector definitions at boot — `[[connector]]` entries with a
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
- The slug comes from `name`, with `_2`, `_3`, … appended when a connector
  already has it. That includes another add of the same name still in
  progress, so two adds at once get two connectors rather than one replacing
  the other. The same holds for `connectors.add_stdio` and
  `connectors.complete_authentication`.

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
- Saved connectors are listed as soon as the daemon has read them, with
  `connected: false` until each one's own connection finishes. A saved
  connector whose server never answers holds up nothing else: it stays
  listed as not connected and can still be removed.

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
- **Linux, supervised agents.** The daemon starts the named program as itself, outside any agent's Landlock wall, so a session bound to a supervised agent (`session.auth { agent_id, token }`) is refused with `connectors.add_stdio is not available to a supervised agent: it makes the daemon start a program outside the agent's wall`, and the refusal is logged. On the Mac (no agent wall) nothing changes. Host sessions, the daemon-token operator and the CLI are unchanged on every platform.

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
- Tools enabled or disabled while the refresh is connecting stay that way.
  If the connector is removed meanwhile, the refresh fails with
  `connector not found: <slug>`, even if a new connector has taken the slug; the
  new connector is left as it is, and its stored header secrets and OAuth
  tokens are never read for, or sent to, the removed connector's server.
- The connector's stored header secrets and tokens are read under the same
  per-connector lock a token refresh, a removal, or another refresh of the same
  connector hold, so a refresh of a connector with either can wait for those,
  at most 60 s.

#### `connectors.remove`
- **Params**: `{ slug: string }`
- **Returns**: `{ removed: string }`
- Disconnects, drops routes, deletes keychain secrets, and removes the
  connector from the manifest. When an OAuth token refresh for the connector
  is in flight, the removal waits for it to finish and then deletes, so the
  refresh cannot save its tokens back. Refreshes queued behind it give up
  rather than each making its own request. A refresh's request is bounded at
  30 s, and the removal's whole wait at 60 s. The connector leaves the list,
  the manifest and the tool routes together before the call returns. A tool
  call still running on its session finishes in the background. The slug is
  free for a new connector as soon as the call returns. By then the removed
  connector's keychain secrets are already deleted, and nothing left over from
  it (its session's closing, its tools' unregistering from open sessions, or a
  `connectors.refresh` of it still connecting) disconnects the new one, takes
  its tools away, deletes its secrets or sends them to the removed connector's
  server.
- **Errors**: `connector <slug> is busy (credential refresh or removal) after
  60s; try again` when that wait runs out. The connector is then left exactly as it
  was.


{% endraw %}
