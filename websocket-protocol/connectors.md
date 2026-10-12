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


{% endraw %}
