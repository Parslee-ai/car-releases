{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### secret

#### `secret.put`
- **Params**: `{ service?: string, key: string, value: string }`
- **Returns**: success indicator
- Uses the OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux).
- `key: "openrouter"` is a convenience alias for `OPENROUTER_API_KEY` on put/get/delete/status. Values are never returned by list/status; changing this pasted slot supersedes any pending OpenRouter OAuth flow but never deletes the separate OAuth credential.
- The exact daemon-owned OAuth slot (`service: "car"`, `key: "OPENROUTER_OAUTH_API_KEY"`) is reserved on the generic surface: `secret.put`, `secret.get`, and `secret.delete` fail with `reserved_private_secret`. Use `openrouter.auth_start` / `openrouter.disconnect`; status/list remain metadata-only and never return its value. The authenticated local-operator broker described below is an internal exception so the CLI's own provider resolver can load this credential.
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
- **Params**: `{ service?: string, key: string, operator_broker?: boolean }`. `operator_broker` is reserved for CAR's local CLI client; external callers should omit it.
- **Returns**: `{ value: string }`
- A connection authenticated as a supervised agent is the credential-read broker path. The daemon derives `agent_id` from `session.auth` (never from params), constructs a `secret.get` tool action carrying the canonical service/key and that identity, and evaluates it through the connection's policy engine before reading. A denial returns an error whose JSON message has `code: "policy_denied"`; clients must not fall back to direct storage after any daemon response.
- The native CLI uses `operator_broker: true` only for a loopback URL and authenticates with the owner-only local host-token file. The ordinary daemon token is available to loopback dashboard clients and therefore is not sufficient proof of the daemon user's filesystem identity; the cross-host `CAR_AUTH_TOKEN` override is never used for this role. The daemon accepts operator mode only from an authenticated host session with no supervised-agent identity and only while daemon auth is enabled. This allows `car keys`, provider resolution, and Parslee auth to reuse the daemon's already-approved credential-store identity, including their private provider/auth slots. A supervised agent cannot set this flag to bypass policy, and a `--no-auth` daemon cannot grant it.
- Every broker attempt appends one redacted event. Supervised events are `action_succeeded` with `outcome: "read"`, `action_failed` with `outcome: "secret_store_error"`, or `policy_violation` with `outcome: "policy_denied"`; their data contains `tool`, `service`, `key`, authenticated `agent_id`, and outcome (plus denying policy names). Operator events contain `tool`, `service`, `key`, `caller_role: "operator"`, and outcome. Values and backend error text are never journaled.
- Environment-keyed resolution still checks a non-empty process environment value before this RPC. Every daemon refusal is terminal. A supervised process also fails closed on transport failure; the operator CLI falls back to its existing direct store only when no daemon response arrives within the two-second broker bound. This keeps standalone CLI use working while preventing an answered denial from becoming a local read.
- Host and ordinary authenticated callers that omit `operator_broker` retain the existing generic `secret.get` behavior. Daemon-private slots remain unavailable on that generic path.

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


{% endraw %}
