{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### server

#### `server.schema`

- **Params**: `{}`
- **Returns**: `{ schema: object, digest: string, digest_algorithm: "sha256", car_version: string }`.
  `schema` is the exact parsed release wire schema embedded in this daemon
  binary and published as `wire-schema.json` on car.parslee.ai. `digest` is the
  lowercase SHA-256 of that file's exact UTF-8 bytes, including its final
  newline; the same digest ships as `wire-schema.sha256`. Consumers can pin the digest for accepted CAR
  releases and validate results or journal records against the named schemas.
- **The release version is reported here, not inside the digested document.**
  `car_version` is read from the running binary at serve time. Keeping it out of
  `wire-schema.json` means the digest tracks *wire shape* alone: two releases
  that changed nothing on the wire share a digest, so a consumer that has
  already accepted one does not have to re-accept the other. It also keeps the
  release version bump — which rewrites the workspace version without
  regenerating this pair — from making the published artifact name the previous
  release.
- Available before protocol negotiation (after `session.auth` when daemon auth
  is enabled) and implicitly allowed for scoped agent tokens, because a client
  may need the schema to decide whether it can negotiate or consume the
  release. The call is read-only and performs no filesystem or network I/O; the
  release artifact is compiled into the daemon.
- `coverage.complete` becomes `true` only when both source-derived inventories
  are exhausted. `coverage.rpc_results` partitions every daemon dispatch method
  into `covered` and `uncovered`; `coverage.journal_event_payloads` does the
  same for every `EventKind`. The top-level `coverage.covered` list names schema
  keys that are safe to rely on. This release adds exact schemas from the real
  emitted Rust types for `capabilities.list`, all five `state.*` results, and
  all six `tools.*` results. The remaining method names and every still-open
  event `data` kind are listed explicitly under `uncovered`, rather than being
  summarized by prose. Do not treat an uncovered result or event payload as
  promised by this artifact.
- **Params (car-releases#98).** `rpc.<method>.params` describes what a method
  accepts, generated from the Rust type its handler deserializes the whole
  params object into. Unlike the result schemas, a params schema follows serde's
  input rules: a field is `required` unless it is an `Option` or has a serde
  default, and an object rejects unknown fields only where the type does
  (`deny_unknown_fields`). Field aliases the daemon also accepts are not
  listed. `rpc.server.handshake.params` is published too: `protocol_version`
  (required, an unsigned integer: the newest version the client speaks), the
  optional `protocol_version_min` (an unsigned integer, the oldest; omitted, it
  equals `protocol_version`), and the optional `required_capabilities` /
  `optional_capabilities` (arrays of non-blank strings). Seven handlers fall
  back to their defaults when their params do not parse (absent, `null`, or a
  mistyped field): `mail.inbox`, `mail.mailboxes`, `meeting.list`,
  `registry.list`, `registry.reap`, `events.truncate` and `models.search`. For
  those the schema is stricter than the daemon. `coverage.rpc_params` puts
  every dispatch method in exactly one bucket:
  - `covered`: a params schema is published.
  - `not_read`: the dispatch arm passes no params to the method's handler
    (`host.subscribe`, `mail.accounts`, `server.schema`, ...). Admission gates
    that run before dispatch still apply to the call itself.
  - `uncovered.typed_without_schema`: the params are parsed into the named Rust
    type, which does not derive a schema yet.
  - `uncovered.unresolved`: the params are read field by field, or through a
    path the generator does not follow. No schema is claimed for these.
- **The approval channel and mail.** `rpc.host.subscribe.result` is the
  snapshot, `notification.host.event.params` is the `params` of every
  `host.event` notification a subscriber then receives, and
  `type.host_approval_request` is the approval record carried in a
  snapshot's `approvals` and as the event `payload` of the kinds that
  `coverage.notifications.host_event_payloads` names (`approval.requested`,
  `approval.resolved`). Any other kind's `payload` is open JSON, including
  `approval.resolve_requested` and `approval.self_resolved`. All six `mail.*`
  results are covered, and so are the params of every `mail.*` method that reads
  them. Server-to-client notifications other than `host.event` are not
  inventoried yet, which is one reason `coverage.complete` is `false`.
- NAPI: `CarRuntime.serverSchema()`. Python:
  `CarRuntime.server_schema()`. Both return the whole result as a JSON string.


{% endraw %}
