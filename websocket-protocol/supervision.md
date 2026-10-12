{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### supervision

The admission gate published as an out-of-process subscription (proposal item 5;
Shepherd, arXiv 2605.10913 Appendix E).

CAR has always blocked before execution — `car_engine::AdmissionGate` runs on
every admitted proposal, conjunctively and fail-closed. Until this namespace
every gate was **in-process**, a Rust trait impl compiled into the daemon, so
supervising an agent meant forking CAR rather than connecting to it. A
supervisor is now any process that can hold a WebSocket.

**Flow.** Subscribe on your own connection. Every proposal submitted on *any*
session that matches your filter arrives as a `supervision.intent` notification
and **blocks** while you decide. Answer with `supervision.decide`, or poll
`supervision.pending` and answer a batch.

**Fail-closed.** An intent nobody answers within `decision_timeout_ms`
(30 s default) is rejected, not admitted — a supervisor that dies must not
become an open door. Disconnecting does not release intents you left parked
either, so a supervisor cannot convert a pending deny into an allow by dropping
its socket.

**Costs nothing when unused.** With no subscriber the gate short-circuits on an
empty-map read without building an intent.

**Intents are trimmed, not redacted-by-accident.** An intent carries action id,
type, tool, reversibility, parameter **key names**, and a digest of the
parameter map — never the parameter values. Supervision is affordable because
it is batched and trimmed, not because the meta-model is cheap. A supervisor
that needs full arguments fetches them out of band.

**Decision vocabulary.** `allow`, `deny`, `escalate` (hand it to the human
approval ledger). Shepherd's `inject` / `handoff` / `discard` are deliberately
**not** implemented: this gate sits at proposal admission, which has no
conversation to inject into and no session-restart primitive, and `discard`
additionally needs the scope rollback of item 4 — measured and found
constrained. The decision enum is `#[non_exhaustive]` so they can be added
without a break.

#### `supervision.subscribe`
- **Params**: `{ filter?: { tools?: string[], sessions?: string[], min_reversibility?: "reversible" | "compensable" | "irreversible" } }`
- **Returns**: `{ subscribed: true, decision_timeout_ms: number, supervisors: number }`
- Re-subscribing replaces the filter; no disconnect needed to narrow or widen.
- `min_reversibility` matches that contract **and worse** — `compensable` also
  shows `irreversible`, because asking to see risky proposals means "this risky
  and up". An unrecognised label sorts as most severe, so a future variant is
  over-reported rather than silently filtered out of view.
- An empty filter matches everything.

#### `supervision.unsubscribe`
- **Params**: `{}`
- **Returns**: `{ subscribed: false, was_subscribed: boolean }`
- Happens automatically when the connection drops.

#### `supervision.pending`
- **Params**: `{}`
- **Returns**: `{ intents: SupervisionIntent[] }`, oldest first
- The batching half: one model call can cover every parked intent, then issue N
  decisions. Also the fallback for clients that cannot consume notifications.
- `SupervisionIntent`: `{ id, proposal_id, source, session_id?, scope?, reversibility, created_at, actions: [{ id, action_type, tool?, reversibility, parameter_keys, parameters_digest }] }`

#### `supervision.decide`
- **Params**: `{ intent_id: string, decision: { kind: "allow" | "deny" | "escalate", reason?: string } }` (`reason` required for `deny` and `escalate`)
- **Returns**: `{ decided: true }`
- **Errors** when the intent is unknown — already decided, already timed out, or
  never existed. Deliberately an error rather than a silent success: a
  supervisor that believes it denied something needs to hear that the denial did
  not land.
- `allow` is not a bypass — the other admission gates still apply.


{% endraw %}
