{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### secret

#### `secret.put`
- **Params**: `{ service?: string, key: string, value: string }`
- **Returns**: success indicator
- Uses the OS keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux). On a Linux machine with no Secret Service, it keeps one owner-only file per key under `~/.car/secrets/` (directory `0700`, files `0600`); a key file with wider permissions is refused with the fix `chmod 600 <file>`.
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
- **Credential-destination slots are operator-only** (car#3072). Three service-`"car"` slots choose where CAR sends a credential rather than holding one: `PARSLEE_STUDIO_BASE` (the host `parslee.capabilities` sends the Parslee bearer to), `PARSLEE_SYNC_BACKEND` (turns on Parslee sync, which sends the account bearer to a sync host), and `PARSLEE_CAR_SYNC_BASE_URL` (that sync host). `secret.put` and `secret.delete` on them fail unless the caller is the operator — a host-role session, or an unbound client of a daemon started without a host token — with an error saying to set it from the CAR app or `car secrets put`. The key and service compare without regard to ASCII case, because Windows reads names that way. Every other slot, and the same names under any other service, is unchanged.

#### `secret.get`
- **Params**: `{ service?: string, key: string, operator_broker?: boolean }`. `operator_broker` is reserved for CAR's local CLI client; external callers should omit it.
- **Returns**: `{ value: string }`
- A connection authenticated as a supervised agent is the credential-read broker path. The daemon derives `agent_id` from `session.auth` (never from params), constructs a `secret.get` tool action carrying the canonical service/key and that identity, and evaluates it through the connection's policy engine before reading. A supervised agent may read only the names its manifest declares in `secrets` (service `car`); any other name, or any other service, returns an error whose JSON message has `code: "not_declared"` and is journaled as a `policy_violation` with `outcome: "not_declared"`. This check runs after the inference-consumer and work-context rules, which are unchanged, and a declaration never widens either. A policy denial returns an error whose JSON message has `code: "policy_denied"`; clients must not fall back to direct storage after any daemon response.
- The native CLI uses `operator_broker: true` only for a loopback URL and authenticates with the owner-only local host-token file. The ordinary daemon token is available to loopback dashboard clients and therefore is not sufficient proof of the daemon user's filesystem identity; the cross-host `CAR_AUTH_TOKEN` override is never used for this role. The daemon accepts operator mode only from an authenticated host session with no supervised-agent identity and only while daemon auth is enabled. This allows `car keys`, provider resolution, and Parslee auth to reuse the daemon's already-approved credential-store identity, including their private provider/auth slots. A supervised agent cannot set this flag to bypass policy, and a `--no-auth` daemon cannot grant it.
- Every broker attempt appends one redacted event. Reads the daemon makes for an agent at spawn (its declared `secrets`) are journaled to `agent-secret-reads.jsonl` beside the peer-message journal with the same fields plus `via: "spawn"`. Supervised events are `action_succeeded` with `outcome: "read"`, `action_failed` with `outcome: "secret_store_error"` (or `"log_record_failed"`, below), or `policy_violation` with `outcome: "policy_denied"`; their data contains `tool`, `service`, `key`, authenticated `agent_id`, and outcome (plus denying policy names). Operator events contain `tool`, `service`, `key`, `caller_role: "operator"`, and outcome. Values and backend error text are never journaled.
- **Recorded before it is handed** (car#3637): a supervised agent is handed a value only after the value's salted fingerprint has been durably written into the record of every run of the agent this daemon holds and has not finished (see `agents.tail_log`, Per-run log files). Otherwise the call fails with `code: "log_record_error"` (journaled as `action_failed` with `outcome: "log_record_failed"`) and nothing is handed over. That includes: this daemon holding no run of the agent (a process that outlived an earlier daemon and is not adopted, or not adopted yet, still holds the agent's token), a run with no record, a record that cannot be read or parsed right now (it is left as it is), and one the value cannot be written into (it is removed or emptied in place, so no reader, `car feedback` included, takes that run's raw file as holding no value). No other exceptions.
- Environment-keyed resolution still checks a non-empty process environment value before this RPC. Every daemon refusal is terminal. A supervised process also fails closed on transport failure; the operator CLI falls back to its existing direct store only when no daemon response arrives within the two-second broker bound. This keeps standalone CLI use working while preventing an answered denial from becoming a local read.
- **A worker** (see [workers](workers.md)) reads the same way, for its declared names only. For a name its orchestrator handed over in `workers.start` `values`, it reads that value, and for any other declared name the store's. The read is journaled as above, in the worker's own folder, with the name and no value. No other agent has a per-agent value: an installed agent reads the one CAR-wide value for each name.
- Host and ordinary authenticated callers that omit `operator_broker` retain the existing generic `secret.get` behavior. Daemon-private slots remain unavailable on that generic path.

#### `secret.delete`
- **Params**: `{ service?: string, key: string }`
- **Returns**: success indicator
- The reserved and credential-destination slots under `secret.put` are refused here the same way.

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
