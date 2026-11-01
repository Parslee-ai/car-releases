{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### credentials

An **outside credential** lets a program on another machine reach this CAR
without the host token. The owner issues it; the program presents it as
`Authorization: Bearer car_oc_…` on the **public door**, a separate listener
that accepts nothing else. The design is
`docs/proposals/orchestrator-workers.md` ("`credentials.*` (host)", "What each
outside credential may call" and "Remote access"); the deployment guide is
[Remote access](../remote-access.md).

**One kind today: `orchestrator`.** It acts as one **outside agent**: an agent
installed from a bundle with `[transport] kind = "outside"`. CAR runs no
process for an outside agent. It has an id, the worker bundles its manifest
declares, and caps and records like any orchestrator; its credential is how it
reaches CAR. A credential can be bound only to such an agent: a reserved id
(CAR's own assistant, a `wk_` worker handle) and any agent CAR runs a process
for are refused. The chat kind, scoped to one full label set, arrives with
live chat from outside apps.

**What an orchestrator credential may call**, and nothing else, on every
platform: `server.handshake`, `server.schema`, `workers.start`, `agents.list`,
`agents.health`, `agents.stop`, `agents.wait` and `agents.remove` (its own
workers only). Any other method is refused with `-32003`
`not_on_credential_list` and recorded. The list is fixed in
`car-server-core/src/outside_credentials.rs`; a method added to CAR later is
refused until it is put on a list on purpose. It cannot read its workers' runs,
events, memory or logs, chat with them, message them, or call `credentials.*`,
`secret.*` or `host.*`.

**The label selector.** A credential may carry `label_selector`, exact
`key = value` pairs (no wildcard). It then sees and affects only workers that
carry every pair: `workers.start` with other labels is refused
(`-32013` `label_out_of_scope`), and a worker outside the selector is absent
from `agents.list` and `agents.health` and refused with the same bytes as an
id that does not exist. A selector-scoped credential gets the shared form of
a worker-limit refusal (`data.cap: "shared"`). With no selector it covers
every label in its orchestrator's tree.

**The store.** One owner-only file per credential,
`<CAR_HOME>/credentials/<credential_id>.json`, holding the token's SHA-256,
never the token. The token is shown once, in the `credentials.issue` result,
and cannot be shown again. Each credential records the **install generation**
of its agent. Installing an id fresh mints a new generation (an upgrade keeps
it), so after a remove and a reinstall under the same id, a credential issued
before them never reaches the new agent: the door refuses it
(`credential_invalid`), and removing the agent closes the credential's open
sockets at once with `4001`. A credential with `expires_at` has a timer that closes its open sockets
at that moment with `4002`. A revoke closes them with `4001`.

**The public door.** `car-server --public-bind <addr:port>` (env
`CAR_PUBLIC_BIND`). Unset or empty, nothing opens. It refuses to open under
`--no-auth` or when the daemon has no host token, and `credentials.list` says
why (`public_door`). It must sit behind a TLS terminator and serves:

- `GET /v1/ws`: a WebSocket upgrade. Before the upgrade it requires
  `X-Forwarded-Proto: https` (else `400`, `{ "error":
  "tls_terminator_required", "message": "this port must sit behind the TLS
  terminator" }`, a catch for a plain port published by mistake, not a
  boundary) and a bearer token that resolves to a live credential whose agent
  is still the one it was issued against (else `401` with
  `WWW-Authenticate: Bearer` and `{ "error": "credential_required" |
  "credential_invalid" | "credential_expired" | "credential_revoked",
  "message": "<sentence>" }`). An unknown token and a malformed one both get
  `credential_invalid`; so do this daemon's daemon, host and agent tokens.
  A credential may hold 16 open connections; the 17th gets `429` with
  `{ "error": "connection_limit", "message": "this credential already has 16
  open connections" }`.
- `GET /healthz`: `200` with the body `ok`. It is exempt from the
  `X-Forwarded-Proto` check, which applies to requests to `/v1/ws` only,
  because a platform health probe may not send the header.
- Anything else: `404`.
- At most 256 connections may be open at once before their upgrade or
  answer; past that the door answers `503` (`{ "error": "busy", … }`) with
  nothing read.

A door session is bound to its credential before its first frame. Its first
frame must be `server.handshake`, which negotiates the wire version as on any
connection (any other call first gets `-32005`). `session.auth` on it is
refused (`-32003` `credential_session_bound`). It is never the operator or the
host. Limits on the door only: 1 MiB per frame and per message (a larger one
ends the connection). When CAR closes a door socket itself it sends a close
code: `4001` credential revoked (or its agent removed), `4002` credential
expired, `4003` label ended (reserved, sent once label deletion exists), `4004`
daemon shutting down.

**Never on the private port.** `session.auth` on the ordinary WebSocket (9100)
refuses any value starting `car_oc_` (`-32003`
`outside_credential_on_private_port`) before comparing it with anything.

**Clients.** The language bindings take a `bearer` connect option:
`new CarRuntime({ url: "wss://<host>/v1/ws", bearer })` in Node and
`CarRuntime(url=..., bearer=...)` in Python. They send the header on the
upgrade and skip `session.auth`.

**Errors.** `credentials.*` refusals use `-32017` with `data.reason`:
`unknown_agent`, `not_outside_agent`, `reserved_agent`, `invalid_scope`,
`invalid_selector`, `unknown_credential`, `expires_in_past`, `name_in_use`.
Every `credentials.*` method is host-only: it needs `session.auth
{ host_token }` and refuses every other session, an agent-bound one included.

#### `credentials.issue`
- **Params**: `{ name: string, kind: "orchestrator", agent_id: string, label_selector?: { <key>: <value> }, expires_at?: string }`.
  - `name`: 1 to 64 of `[A-Za-z0-9._-]`, unique among credentials that are not revoked (`name_in_use`).
  - `kind`: `orchestrator`. `chat` is refused (`invalid_scope`) until live chat from outside apps exists, as are its `scope` and `max_chats` fields.
  - `agent_id`: an installed agent with `[transport] kind = "outside"` (`unknown_agent`, `not_outside_agent`, `reserved_agent`).
  - `label_selector`: at most 8 pairs, each key `[a-z][a-z0-9_-]{0,31}` and value `[A-Za-z0-9._-]{1,64}` (`invalid_selector`).
  - `expires_at`: an RFC 3339 time in the future (`expires_in_past`).
  - Unknown fields are refused.
- **Returns**: `{ credential_id: "cr_<32 hex>", token: "car_oc_<43 base64url>", name, kind, access: "orchestrator", agent_id, label_selector, created_at, expires_at }`. The token appears here once and nowhere else.

#### `credentials.list`
- **Params**: `{}`.
- **Returns**: `{ credentials: [ { credential_id, name, kind, access, agent_id, label_selector, created_at, last_used_at, expires_at, state: "live" | "revoked" | "expired", open_connections, revoked_at, revoked_by, refused_last_day } ], public_door: { state: "not_configured" | "open" | "refused" | "failed", bind?, reason?, error? } }`. No token and no hash.

#### `credentials.revoke`
- **Params**: `{ credential_id: string }`.
- **Returns**: `{ credential_id, revoked_at, revoked_by }`. Idempotent: a second revoke returns the first one's time and actor. A revoked credential is never re-enabled. Its open door sockets close with `4001`. Revoking does not stop the agent's workers (decision 7). Unknown id: `unknown_credential`.

#### `credentials.refusals`
- **Params**: `{ credential_id: string, limit?: number }`. `limit` is 1 to 1000, default 100.
- **Returns**: `[ { at, method, reason, target_kind?, target? } ]`, newest first: every call of that credential that was refused. `target` is kept only for a name that was not a worker (an invented id); an existing worker's handle is not kept here, so deleting its label leaves nothing of it in this record.

{% endraw %}
