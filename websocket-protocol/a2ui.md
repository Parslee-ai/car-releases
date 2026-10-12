{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### a2ui

Dynamic UI surfaces rendered by the CAR host window. A2UI messages are
data-only JSON envelopes; the host renders only supported catalog components.
CAR speaks A2UI v0.9.1 (<https://a2ui.org/specification/v0.9.1-a2ui/>), which
is wire-compatible with v0.9: every method below accepts envelopes and action
messages whose `version` is `"v0.9"` or `"v0.9.1"` and rejects any other. CAR
stamps `"v0.9"` on what it authors — valid v0.9.1, and accepted by CAR releases
from before v0.9.1 support, which reject `"v0.9.1"`. The A2UI MIME type is
`application/a2ui+json`.
The renderer supports the CAR-advertised A2UI basic catalog (24
components): `Text`, `Row`, `Column`, `List`, `Card`, `Divider`, `Button`,
`TextField`, `CheckBox`, `ChoicePicker`, `Select`, `Slider`, `Image`, `Icon`,
`Video`, `AudioPlayer`, `DateTimeInput`, `Chart`, `File`, `FilePicker`,
`Spacer`, `Badge`, `Tabs`, and `Modal`.

#### `a2ui.capabilities`
- **Params**: `{}`
- **Returns**: `{ version, mimeType, catalogs, components, limits }` —
  `version` is the version CAR emits (`"v0.9"`; `"v0.9.1"` is also accepted
  inbound), `mimeType` is `"application/a2ui+json"`, and
  `catalogs` is the basic catalog's canonical id
  `https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json`.
- Reports the catalog/component set and server-side safety limits enforced
  while ingesting or applying surfaces.

#### `a2ui.apply`
- **Params**: an A2UI envelope, or `{ envelope: A2uiEnvelope }`
- **Returns**: `{ surfaceId, deleted, surface? }`
- Applies one direct A2UI v0.9.1 (or v0.9) message (`createSurface`, `updateComponents`,
  `updateDataModel`, or `deleteSurface`) and broadcasts a `host.event` with
  kind `a2ui.surface_updated` or `a2ui.surface_deleted`.

#### `a2ui.ingest`
- **Params**: `{ payload: object, owner?: A2uiSurfaceOwner, endpoint?: string, routeAuth?: A2aRouteAuth, allowUntrustedEndpoint?: boolean }` or a raw payload
- **Returns**: `{ applied: A2uiApplyResult[] }`
- Scans A2A-shaped data/artifact/task payloads for direct envelopes or
  `{ "a2ui": envelope }` wrappers, then applies every discovered envelope.
  Use this when an A2A peer returns A2UI inside a `data` part. If the payload
  carries A2A `taskId` / `contextId`, or if `owner` is supplied, the surface
  records that routing target. Supplying a trusted loopback `endpoint` lets
  later `a2ui.action` calls continue the originating A2A task automatically.
  Non-loopback endpoints require `allowUntrustedEndpoint: true`. Optional
  `routeAuth` supports `{ "type": "bearer", "token": "..." }` or
  `{ "type": "header", "name": "...", "value": "..." }` and is stored only on
  the server.

#### `a2ui.reap`
- **Params**: `{}`
- **Returns**: `{ removed: string[] }`
- Removes expired surfaces and their server-side routing credentials.

#### `a2ui.surfaces`
- **Params**: `{}`
- **Returns**: current `A2uiSurface[]`

#### `a2ui.get`
- **Params**: `{ surface_id: string }` or `{ surfaceId: string }`
- **Returns**: one `A2uiSurface` or `null`

#### `a2ui.action`
- **Params**: `{ name, surfaceId, sourceComponentId, timestamp, context }`
  (`name` also accepts the alias `action`, since the web renderer forwards
  `@a2ui/web_core`'s action object verbatim), or the A2UI client-to-server
  message `{ version, action: { name, surfaceId, sourceComponentId, timestamp, context } }`
  with `version` `"v0.9"` or `"v0.9.1"`.
- **Returns**: `{ event: HostEvent, route: object }`
- Called by the host renderer when the user activates an A2UI control.
  The action is delivered three ways:
  1. **Broadcast to `a2ui/subscribe`d clients** as an `a2ui.event` with
     `kind: "a2ui.action"` — the same channel that carries surface updates.
     This is how a host-language agent that created the surface receives the
     interaction (Parslee-ai/car-releases#58); without it, agent surfaces are
     display-only.
  2. Recorded/broadcast as `host.event` kind `a2ui.action` for host UIs.
  3. If the surface owner is `{ kind: "a2a", taskId, contextId, endpoint }`,
     CAR sends an A2A `SendMessage` continuation to `endpoint` with one data
     part whose `data` is the A2UI client-to-server message
     `{ "version": "v0.9", "action": action }` (a single object, as
     upstream's reference agent and Lit client exchange it) and whose
     `metadata.mimeType` is `"application/a2ui+json"`. A receiving CAR also
     accepts a list of such messages and the pre-v0.9.1 `{ "a2uiAction": action }`
     part, exposing the actions under proposal context key `a2ui_actions`.
     The continuation carries no `metadata.a2uiClientDataModel` and no
     `X-A2A-Extensions` header.

#### `a2ui.render_report`
- **Params**: a renderer telemetry envelope with required `surfaceId` and `timestamp`, plus `signature`, `viewport`, density/count observations, correlation fields, and optional metadata.
- **Returns**: `{ event: HostEvent }` after recording the report and broadcasting `a2ui.event { kind: "a2ui.render_report", result: <validated report> }` to subscribers. UI-improvement patches are best-effort and bounded server-side.

#### `a2ui/subscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: true }`
- Opt this WS connection into `a2ui.event` notifications (see below).
  Subscribers receive every successful `a2ui.apply` / `a2ui.ingest`
  result for as long as they're connected; subscriptions are
  auto-cleaned on WS disconnect. Closes
  [Parslee-ai/car-releases#29](https://github.com/Parslee-ai/car-releases/issues/29).

#### `a2ui/unsubscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: false }`
- Idempotent.

#### `a2ui/replay`
- **Params**: `{ surface_id: string }` or `{ surfaceId: string }`
- **Returns**: one `A2uiSurface` or `null`
- Intended for late-joiners and reconnect: a client calls
  `a2ui/subscribe`, then `a2ui/replay` once per surface it's
  tracking, and from then on `a2ui.event` notifications keep it in
  sync. Equivalent to `a2ui.get` on the surface store.

##### `a2ui.event` (server → client notification)
After every `a2ui.apply` / `a2ui.ingest` succeeds, the server pushes
to all `a2ui/subscribe`d clients:

```json
{
  "jsonrpc": "2.0",
  "method": "a2ui.event",
  "params": {
    "kind": "a2ui.surface_updated" | "a2ui.surface_deleted" | "a2ui.action" | "a2ui.render_report",
    "result": { "surfaceId": "...", "deleted": false, "surface": { ... } }
  }
}
```

For `a2ui.surface_updated` / `a2ui.surface_deleted` the `result` payload is
the same `A2uiApplyResult` the `a2ui.apply` / `a2ui.ingest` call returned to
its requester. For `kind: "a2ui.action"` (emitted on every `a2ui.action`
call), the `result` is `{ surfaceId, action, owner }` — letting a
subscribed agent receive user interactions on surfaces it owns. (The A2A
`route` result is intentionally omitted from this broadcast — it stays in the
`a2ui.action` RPC return and the `host.event` record so an endpoint URL/response
isn't fanned out to unrelated subscribers.) For
`kind: "a2ui.render_report"`, the `result` is the renderer telemetry envelope.
Validation errors (`UnsupportedCatalog`, `UnsupportedComponent`,
`LimitExceeded`) propagate to the caller of `a2ui.apply` and **do
not** broadcast a half-applied envelope.


{% endraw %}
