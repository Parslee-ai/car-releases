{% raw %}
# CAR A2A (Agent2Agent) Bridge

`car-a2a` exposes a CAR runtime as an [Agent2Agent](https://a2a-protocol.org/) v1.0 agent. Peer agents built on **any** A2A-compliant SDK (Python, JavaScript, Java, Go, .NET, Rust) can discover the runtime via an Agent Card and drive it as a remote agent.

A2A is the Linux Foundation's open standard for agent-to-agent communication — donated by Google in mid-2025 and now hosted by the Agentic AI Foundation.

## When to use this surface

- You want a peer agent to call into CAR over the network without speaking CAR's native WebSocket protocol.
- You need agent-to-agent interop with frameworks like LangChain, ADK, AutoGen, etc.
- You want a stable public-facing identity (Agent Card at a fixed URL) for your CAR deployment.

If you're driving CAR from your own application, the FFI bindings (`@parslee-ai/car-runtime-native` on npm / PyPI) or the WebSocket protocol are usually the better fit — they expose the full surface, not just the A2A subset.

## Transport

```bash
car-server --a2a-bind 127.0.0.1:9101
# or
CAR_A2A_BIND=127.0.0.1:9101 car-server
```

Three endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/.well-known/agent-card.json` | Agent Card discovery (canonical, A2A v1.0 §5.3) |
| `GET`  | `/.well-known/agent.json` | Pre-1.0 alias |
| `POST` | `/` (and `/a2a`) | JSON-RPC 2.0 dispatch |
| `GET`  | `/a2a/stream/:task_id` | Server-Sent Events for streaming |

A2A's WebSocket binding is **not** implemented; A2A v1.0 specifies HTTP+JSON (with optional gRPC). The CAR-native WebSocket on the main port is unaffected.

## CAR ↔ A2A mapping

| A2A | CAR |
|-----|-----|
| Agent Card | Manifest of registered tools + host metadata |
| Skill | One per registered `ToolEntry` |
| Task | One-shot wrapper around an `ActionProposal` |
| Message (`data` part with `tool` + `parameters`) | Single `ToolCall` action in the proposal |
| Message (text part) | Stashed as `a2a_text` in proposal `context` |
| Artifact | One per `ActionResult` from `Runtime::execute` |
| `TaskState::SUBMITTED` → `WORKING` → `COMPLETED`/`FAILED` | Lifecycle of `Runtime::execute` |
| `tasks/cancel` | `JoinHandle::abort()` on the spawned executor task |

## A2UI payloads

CAR advertises `application/vnd.a2ui+json` as an A2A output mode. If a tool or
peer agent returns an A2UI v0.9 envelope in a `data` part, either directly or
wrapped as `{ "a2ui": envelope }`, CAR can ingest it into the host-visible A2UI
surface store:

```json
{
  "kind": "data",
  "data": {
    "a2ui": {
      "version": "v0.9",
      "createSurface": { "surfaceId": "approval" }
    }
  }
}
```

The WebSocket host surface exposes `a2ui.ingest` for A2A artifact/task payloads
and `a2ui.apply` for direct envelopes. In the desktop host window, these
surfaces render under **A2UI Surfaces**. When `a2ui.ingest` sees A2A
`taskId` / `contextId` values, it records them as the surface owner. If the
caller also supplies a trusted loopback `endpoint`, user actions are sent back
to that A2A peer as a `SendMessage` continuation with a data part shaped as
`{ "a2uiAction": action }`; otherwise the action is still broadcast as
`host.event` kind `a2ui.action` with the owner metadata attached. Non-loopback
continuation endpoints require `allowUntrustedEndpoint: true`, and optional
`routeAuth` credentials are kept server-side rather than exposed to renderers.

## Methods supported

The dispatcher accepts both A2A **v1.0** PascalCase method names and **v0.3** slash aliases. Same handlers, two name forms — peers on either side of the version bump work without a compat shim. The card advertises `protocolVersion: "1.0"` since v1.0 is the natively-accepted form.

| v1.0 method | v0.3 alias | Status |
|------|------|--------|
| `SendMessage` | `message/send` | ✅ blocking (`configuration.blocking: true`) and async |
| `SendStreamingMessage` | `message/stream` | ✅ HTTP layer flips the response to SSE |
| `GetTask` | `tasks/get` | ✅ honours `historyLength` |
| `ListTasks` | `tasks/list` | ✅ filter by `contextId` / `state` / `limit` |
| `CancelTask` | `tasks/cancel` | ✅ cooperative cancel via `CancellationToken` |
| `SubscribeToTask` | `tasks/resubscribe` | ✅ HTTP layer flips the response to SSE |
| `CreateTaskPushNotificationConfig` | `tasks/pushNotificationConfig/set` | ✅ |
| `GetTaskPushNotificationConfig` | `tasks/pushNotificationConfig/get` | ✅ |
| `ListTaskPushNotificationConfigs` | `tasks/pushNotificationConfig/list` | ✅ |
| `DeleteTaskPushNotificationConfig` | `tasks/pushNotificationConfig/delete` | ✅ |
| `GetExtendedAgentCard` | `agent/getAuthenticatedExtendedCard` | ✅ returns same card as `/.well-known/agent-card.json` |

## Inbound message shapes

### Structured (preferred)

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "m-1",
      "role": "user",
      "parts": [{
        "kind": "data",
        "data": { "tool": "fs.read", "parameters": { "path": "/tmp/x" } }
      }]
    },
    "configuration": { "blocking": true }
  },
  "id": 1
}
```

The `data` part with a `tool` key compiles directly into a CAR `ActionProposal` of one `ToolCall` action.

### Free-text

```json
{
  "kind": "text",
  "text": "Summarise the latest meeting"
}
```

Free-text parts are not auto-compiled. They land in the proposal's `context["a2a_text"]` so a downstream planner (e.g. `car-active-planner`) can pick them up.

## Streaming

After `message/send` returns a `Task`, a peer can connect to:

```
GET /a2a/stream/:task_id
Accept: text/event-stream
```

Each SSE `data:` frame is one of:

- `TaskStatusUpdateEvent` — kind `"status-update"`. The terminal one has `final: true`.
- `TaskArtifactUpdateEvent` — kind `"artifact-update"`. One per `ActionResult`.

Subscribers that fall behind get `RecvError::Lagged`; the bridge silently drops missed events. Recover by calling `tasks/get` to resync.

## Push notifications

Register a webhook for a task:

```json
{
  "jsonrpc": "2.0",
  "method": "tasks/pushNotificationConfig/set",
  "params": {
    "taskId": "task-abc",
    "config": {
      "url": "https://your-server/hooks/a2a",
      "token": "Bearer-token-the-receiver-validates"
    }
  },
  "id": 1
}
```

On every state transition or artifact append, the bridge POSTs the current `Task` JSON to your URL. Delivery is fire-and-forget — no retries, no signed payloads, no replay protection. Production embedders that need those should replace `PushDispatcher` with their own implementation.

## Authentication

The default listener has **no auth.** This is correct for local development and for deployments behind an authenticating reverse proxy. Direct internet exposure is a Bad Idea.

A2A's spec defines API-key, HTTP-basic, OAuth2, OIDC, and mTLS schemes; declaring them in the Agent Card and enforcing them is the embedder's responsibility for now.

## Python and Node.js consumers

The A2A surface lives inside the `car-server` daemon. Python and Node.js callers
drive it through the standard FFI bindings — there is no separate Python or
Node.js A2A entry point. The bindings proxy to the daemon's `a2a.*` JSON-RPC
namespace.

### Starting the listener

```python
import car_runtime as cr
import json

rt = cr.CarRuntime()  # connects to the daemon at ws://127.0.0.1:9100

# Start the A2A HTTP listener. The daemon owns the dispatcher; this just
# binds the HTTP transport.
cr.start_a2a_server(rt, json.dumps({
    "bind": "127.0.0.1:9101",
}))

# Status (bound address, served card name, task count).
print(cr.a2a_server_status(rt))

# Later:
cr.stop_a2a_server(rt)
```

Node.js (`car-runtime` on npm) exposes the same surface as `startA2AServer`,
`stopA2AServer`, `a2AServerStatus` (each takes the `CarRuntime` first;
napi-rs camelCases `a2a` → `A2A`).

### What the A2A agent exposes

The daemon's A2A dispatcher does **not** take a freeform Python handler.
Instead, every CAR-registered tool becomes one **A2A skill** on the Agent Card.
When an A2A peer sends a `message/send` with a structured `data` part
(`{ "tool": "...", "parameters": { ... } }`), the bridge compiles it into a
single-action `ActionProposal` and runs it on the daemon's runtime — the same
path local FFI callers use.

So the Python pattern for hosting a custom agent over A2A today is:

1. `register_tool_schema(...)` to declare the skill (name, description, JSON
   schema for params).
2. From Node.js: `registerToolHandler(handlerFn)` installs a single callback
   that the daemon invokes for *all* dispatched tools, multiplexing on the
   tool name. The daemon emits a server-initiated `tools.execute` over the
   WebSocket; the binding hands the call to your callback and pipes the
   return value back as the JSON-RPC response.
3. From Python: `register_tool_handler` currently raises
   `NotImplementedError` (parity gap tracked in Parslee-ai/car-releases#38).
   Until that lands, Python callers either (a) invoke
   `execute_proposal(proposal_json, handler_fn)` per call to supply a
   one-shot handler, or (b) connect to the daemon's WebSocket directly and
   service `tools.execute` requests from there. There is no "decorate a
   `def handle(input) -> output`" path yet.

The Agent Card is auto-generated from the runtime's tool registry plus host
metadata (`name`, `description`, `protocolVersion: "1.0"`, default
input/output modes including `application/vnd.a2ui+json`, the `/.well-known`
URL, and any registered push-notification or extended-card flags). To
customize identity, use `car-server`'s host config (`name`, `description`,
`provider`, etc.) — the dispatcher reads it through the
`AgentCardSource` closure on startup.

### Streaming from Python

`message/stream` is served by the HTTP transport — the SSE feed comes back
to the *A2A peer*, not to the Python embedder hosting the agent. From the
hosting side there is no `yield` API today; if you need to emit incremental
artifacts to a streaming peer, the runtime's action results are published
as `TaskArtifactUpdateEvent` frames automatically as each action completes.
A single-action proposal therefore looks like one bursty `WORKING` → final
artifact frame to the peer; to get genuine multi-step streaming, split the
work across multiple actions or multiple `message/send` continuations on
the same `taskId`.

### When to pick A2A vs the native WebSocket

- **A2A** — when the *caller* is a peer agent on a different runtime
  (LangChain, ADK, AutoGen, another CAR) and you want zero-glue
  interoperation. The wire shape is the Linux Foundation v1.0 spec; the
  CAR-specific extensions live in metadata.
- **Native WebSocket / FFI** — when you control both ends. The native
  surface exposes the full method set (memgine, planner, scheduler,
  workflows, multi-agent runners), not just the A2A subset.

## Discovery and multi-agent layout

The default listener binds at `127.0.0.1:9101` and serves the Agent Card at
the spec's canonical well-known path:

```
GET http://127.0.0.1:9101/.well-known/agent-card.json
```

Pre-1.0 peers can also hit `/.well-known/agent.json` — same content.

**One server = one Agent Card.** The dispatcher is single-card by design;
running multiple distinct agents on the same host means binding multiple
A2A listeners (each on its own port) backed by distinct daemons, each with
its own tool registry. There is no multiplexed "router" card that fans out
to sub-agents. The recommended layout for a developer machine hosting
multiple A2A agents:

| Agent | Port | Agent Card URL |
|-------|------|----------------|
| reasoning helper | 9101 | `http://127.0.0.1:9101/.well-known/agent-card.json` |
| codebase indexer | 9102 | `http://127.0.0.1:9102/.well-known/agent-card.json` |
| code reviewer    | 9103 | `http://127.0.0.1:9103/.well-known/agent-card.json` |

For team or CI deployments there is **no CAR-provided registry yet**. Most
deployments either (a) put each agent behind its own DNS name + reverse
proxy and let callers cache the resolved card URL, or (b) stand up a static
file or repo that lists known card URLs. A2A's spec doesn't prescribe a
registry mechanism either; vendor registries (e.g. ADK Agent Hub) work
against `car-a2a` because the wire shape is spec-compliant.

The card-serving path checks the `Authorization` header against the
configured auth scheme **before** dispatching to the handler (see
`Authentication` below). A 401 / 403 fires before any CAR tool runs.

## Caller identity and state scoping

A2A v1.0 carries the caller's session through `taskId` and `contextId` on
every `Message`. The bridge stores those on the `TaskRecord` and uses them
for `tasks/get`, `tasks/list`, `tasks/cancel`, and the SSE stream — that
half works today.

**What's *not* wired yet, and you should plan around it:**

- **One Arc<Runtime> per A2A listener.** All callers share the same tool
  registry, the same memgine graph, the same state store, and the same
  policy set. There is no per-caller, per-org, or per-project namespace
  inside the runtime today.
- **No automatic scope from `contextId`.** `contextId` partitions A2A's
  task history but does not partition CAR's memgine working set or state
  keys. Facts ingested from caller A's task are visible to caller B's task
  on the same listener.
- **Two identity surfaces, distinguishable.** When auth is configured
  AND the validator surfaces a verified subject, `proposal.context`
  carries **both**:
  - `a2a_caller` — peer-supplied claims from `Message.metadata`
    (`caller_id` / `org_id` / `project_id` / `tenant_id`). Allow-list
    only; other metadata keys do not leak here.
  - `a2a_caller_verified` — `{ subject, claims }` from the
    `AuthValidator`. Server-controlled, peer cannot forge.

  Tools and policies can cross-check: e.g. reject when
  `a2a_caller.caller_id != a2a_caller_verified.subject`. The
  built-in `BearerKeyAuth` / `ApiKeyHeaderAuth` validators do **not**
  surface a subject (allow-list-only — they identify the credential,
  not the caller), so `a2a_caller_verified` is absent under those.
  Custom validators that resolve OIDC subjects, OAuth2 introspection
  responses, or mTLS certificates implement
  [`AuthValidator::validate`](../car-rs/crates/car-a2a/src/auth.rs)
  to return `Ok(Some(Identity { subject, claims }))`.

  Without a verified identity, `a2a_caller_verified` is absent —
  distinguishable from "present but empty" so default-deny policies
  can check `!context.contains_key("a2a_caller_verified")`.

If your deployment needs hard multi-tenancy (independent memgine state,
distinct skill libraries, no cross-caller fact bleed), the supported
shape today is **one daemon per tenant**, each on its own port, with a
front-end router (reverse proxy or registry) mapping the caller's identity
to the right port. That's heavy but it's correct.

A lighter pattern for soft scoping is to (a) require an
`org_id` / `project_id` in the inbound `Message.metadata`, (b) namespace
state keys and memgine queries inside your tool handler
(`state_get("<org>/<project>/<key>")`, scoped fact tags), and (c) treat
the absence of those fields as a reject. This is on the embedder today,
not the runtime — until per-caller scoping lands, document the namespace
convention explicitly with peers.

### Runtime-level scope foundation (Parslee-ai/car#187 phase 3)

Phase 3 phase A landed the runtime API for per-tenant scoping. Today
it carries the caller-identity surface into `Runtime::execute*` and
records it on the event log; memgine and state stores still operate
in the global namespace (those are the next phase-3 follow-ups).

What's wired today:

- **`car_engine::RuntimeScope`** — value type carrying
  `caller_id` / `tenant_id` / `claims`. The dispatcher builds one
  per inbound message, with verified-Identity values overriding
  cooperative-peer hints (see `bridge::scope_from_message_and_identity`).
- **`Runtime::execute_scoped` / `execute_scoped_with_cancel`** —
  sibling entry points to `execute` / `execute_with_cancel` that
  accept a `&RuntimeScope`. The A2A bridge always routes through
  these now; existing in-process callers stay on the legacy entry
  points unchanged.
- **`EventKind::SessionScope`** — emitted once per proposal when
  the scope carries any identity. Audit / log analysis can
  correlate actions to the caller / tenant that triggered them.
- **`A2aDispatcher::with_require_identity(true)`** — multi-tenant
  default-deny posture. When set, inbound messages without a
  verified `Identity` are rejected with JSON-RPC `-32600
  InvalidRequest` before any proposal hits the runtime. Leave it
  off for single-tenant or `NoAuth` / `BearerKeyAuth` deployments
  where the dispatcher intentionally runs unscoped.

What's *not* yet wired (remaining phase-3 follow-ups):

- **Snapshot / restore on the state store** still operate on the
  full state HashMap. Under concurrent multi-tenant proposals this
  can clobber another tenant's writes during proposal-level
  rollback. See `docs/persistence.md` for the workaround pending
  the proposal-transaction-per-tenant fix.

**Now enforced** (after phases 3-B / 3-C / 3-D / 3-E / 3-F / 3-G):

- **State key namespacing** (phase 3-B). `StateStore::scoped(tenant)`
  returns a view that transparently prefixes keys with `tenant:<id>:`.
  `Runtime::execute_scoped*` routes per-action `StateWrite` /
  `StateRead` / `Assertion` and `expected_effects` through it, so
  two tenants running the same proposal don't see each other's keys.
- **FFI parity for `proposal.submit`** (phase 3-C). NAPI
  `executeProposal` and the WS `proposal.submit` handler both accept
  a `scope` parameter that routes through `Runtime::execute_scoped`.
  Direct WS callers and Node consumers get scope-aware execution.
- **Memgine fact + skill scoping** (phase 3-D). Facts and skills
  carry `metadata.tenant_id`; `MemgineEngine::scoped(tenant)` returns
  a view whose `build_context` and ingest methods are tenant-aware.
  Strict isolation: scoped tenants don't see unscoped content, and
  vice-versa. Runtime auto-distill stamps the executing tenant. See
  `docs/persistence.md` for the API surface and known limitations.
- **WS `state.*` per-call scope** (phase 3-E). `state.get` /
  `state.set` / `state.exists` / `state.keys` / `state.snapshot`
  accept an optional `tenant_id` sibling field. Same strict
  isolation contract as `proposal.submit` — see
  `docs/websocket-protocol.md` § state.
- **Memgine `evolve_skills` tenant filter** (phase 3-F). The
  `current_skills` query that feeds the evolution prompt filters
  by `tenant_id`, so cross-tenant skill names / descriptions can't
  bleed into another tenant's evolution.
  `ScopedMemgineView::evolve_skills` is the scoped entry point;
  it keeps the evolve → ingest cycle tenant-isolated end-to-end.
- **Memgine `consolidate()` per-tenant domain selection** (phase
  3-G). The internal `domain_stats` map is keyed by `(Option<tenant>,
  domain)`, `report_outcome` routes per-skill outcomes to the
  calling tenant's slot, and `consolidate()` evolves each
  underperforming `(tenant, domain)` independently. Legacy
  accessors (`domain_stats`, `domains_needing_evolution`,
  `should_evolve`, `mark_evolved`) operate only on the unscoped
  slot; new `*_for_tenant` variants reach the per-tenant slots.

Until the memgine + state pieces land, tools that need per-tenant
behavior should keep reading `proposal.context["a2a_caller_verified"]`
directly (the phase 1 / 2 surface). `RuntimeScope` is the structured
handle the runtime itself uses; tool handlers read the proposal
context.

## Embedding

The `car-a2a` crate exposes a transport-neutral [`A2aDispatcher`](../car-rs/crates/car-a2a/src/server.rs) plus a thin Axum [`serve`](../car-rs/crates/car-a2a/src/http.rs) helper. Mount it inside your own Axum app:

```rust
use car_a2a::{build_router, A2aDispatcher, InMemoryTaskStore};

let dispatcher = A2aDispatcher::new(runtime, Arc::new(InMemoryTaskStore::new()), card);
let app = your_app.merge(build_router(dispatcher));
```

Or run the standalone listener:

```rust
let (addr, handle) = car_a2a::serve(dispatcher, "0.0.0.0:9101".parse()?).await?;
```

## Outbound calls

CAR also ships a thin outbound A2A client (`car_a2a::A2aClient`) for the case where one CAR runtime needs to drive *another* A2A peer over HTTP+JSON-RPC. Useful for CAR-to-CAR plumbing or smoke-testing the inbound surface from a Rust integration test:

```rust,ignore
use car_a2a::{A2aClient, ClientAuth};

let client = A2aClient::new("http://peer-agent.local")
    .with_auth(ClientAuth::Bearer("…".into()));
let card = client.agent_card().await?;
let task = client.send_message(my_message, /* blocking = */ true).await?;
```

For richer outbound features (multi-transport selection, automatic retries, agent-card-driven negotiation, OAuth2 token refresh), the upstream [`a2a-protocol-client`](https://crates.io/crates/a2a-protocol-client) and [`a2a-client`](https://crates.io/crates/a2a-client) crates are the right pick — `car_a2a::A2aClient` is intentionally minimal.

## Cancellation

`tasks/cancel` cooperates with the engine via `tokio_util::sync::CancellationToken`. When a peer issues `tasks/cancel`:

1. The bridge's `AbortRegistry` trips the token registered for that task.
2. `car_engine::Runtime::execute_with_cancel` sees the token at its next DAG-level boundary and emits `Skipped("canceled: cancellation requested by caller")` for every action that hadn't started yet.
3. The bridge converts the resulting `ProposalResult` into the task's final state — peers see clean partial artifacts instead of a half-flushed mystery.

Actions already in flight (tool calls dispatched to user-provided executors) cannot be safely interrupted from the engine and run to completion. Their results are recorded in the `ProposalResult` like any other action.

## Deferred

- **gRPC binding** — A2A v1.0 also defines a gRPC binding generated from [`a2a.proto`](https://github.com/a2aproject/A2A/blob/main/specification/a2a.proto). Bringing this in requires:
  - `tonic` + `prost` + `prost-build` (large dep tree, requires `protoc` on the build machine).
  - A separate crate (`car-a2a-grpc`) so the gRPC dep cost is opt-in by reverse-dependency, not by feature flag (which the project bans).
  - A conversion layer between the prost-generated message types and `car-a2a`'s JSON-RPC types — the canonical proto has 30+ messages.
  - Routing each gRPC method through `A2aDispatcher`.
  
  This is a focused multi-day effort and most real-world A2A traffic uses HTTP+JSON. Tracked as a separate, dedicated workstream.

## What this is, then

Functionally complete for A2A v1.0 over JSON-RPC + SSE: spec-correct wire format, lifecycle, streaming, push delivery, auth, RFC 8785-canonical card signing, cooperative cancellation, outbound client. The single remaining gap (gRPC) is a separate workstream.

{% endraw %}
