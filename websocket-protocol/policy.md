{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### policy

#### `policy.register`
- **Params**: `PolicyDefinition { name: string, rule: "deny_tool" | "deny_tool_param" | "require_state" | "deny_connector", target?: string, key?: string, pattern?: string, value?: any, session_id?: string }`
- **Returns**: `{ registered: string, scope: "global" | { session_id: string } }`
- Register a single policy on this WebSocket session's runtime. `deny_connector` denies every tool of the remote MCP connector whose slug is `target` (its tools are named `mcp_<slug>_<tool>`). Any other `rule`, including `deny_tool_callback`, is not accepted: a callback cannot ride the JSON-RPC wire. `session_id`, when set, scopes the policy to a per-session policy registry opened via `session.policy.open`; without it, the policy is global. Takes the same `PolicyDefinition` shape as `session.init` (which lets clients submit a batch at startup), but answers an unsupported `rule` with the error `unsupported policy rule '<rule>'`, where `session.init` skips it (see [session.init](session.md#sessioninit)). A `require_state` policy reads the shared store, even for a proposal submitted with a `scope.tenantId`: policies are operator rules, registered globally or per session and never per tenant, so a tenant cannot satisfy one by writing the key into its own tenant namespace (Parslee-ai/car#3121). Preconditions and `state_dependencies` on the actions themselves read the tenant's view instead.

#### `policy.unregister`
- **Params**: `{ name: string, session_id?: string }`
- **Returns**: `{ unregistered: string, removed: number, scope: "global" | { session_id: string } }`
- Remove every policy registered under `name`. `removed` is how many were dropped — `0` means nothing matched, reported rather than raised, so a client cleaning up can call this unconditionally. (`policy.register` appends without de-duplicating, so a name can legitimately cover more than one policy; all of them go.)
- Before this existed a global policy could not be removed at all: once registered it lived until the daemon restarted, so a mistyped or over-broad rule could only be cleared by bouncing the process and losing every other piece of in-memory state with it. Session-scoped policies could already be dropped wholesale via `session.policy.close`; this removes one by name.

#### `policy.list`
- **Params**: `{ session_id?: string }`
- **Returns**: `{ policies: [{ name: string, description: string }], scope: "global" | { session_id: string } }`
- What is currently in force, in registration order. Without it a client could register a policy but never ask what was enforced, so an action rejection could not be explained beyond the single message on the rejection itself.

{% endraw %}
