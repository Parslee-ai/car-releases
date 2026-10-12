{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

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


{% endraw %}
