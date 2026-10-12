{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

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

### policy

#### `policy.register`
- **Params**: a single `PolicyDefinition`: `{ name, rule, target?, key?, value?, pattern? }`
- **Returns**: `{ name }`
- Mirrors `session.init`'s policy slot for callers that want to register one policy at a time. Supported `rule` values: `deny_tool`, `deny_tool_param`, `require_state`. Callback rules (`deny_tool_callback`) are NOT supported on the daemon — the FFI binding is expected to reject them in Daemon mode and route through Embedded mode instead.


{% endraw %}
