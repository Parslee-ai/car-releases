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
- NAPI: `CarRuntime.serverSchema()`. Python:
  `CarRuntime.server_schema()`. Both return the whole result as a JSON string.


{% endraw %}
