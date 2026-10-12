{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### proposal

#### `proposal.submit`
- **Params**: `{ proposal: ActionProposal, session_id?: string, scope?: RuntimeScope, ... }`
- **Returns**: serialized `ProposalResult`; each `ActionResult` may carry `rolled_back: true` when the action succeeded but an enclosing abort restored the proposal's state transaction. False is omitted. `status` still reports whether the action executed, `state_changes` is empty after rollback, and `error` may retain a human warning that external effects remain; never match that warning to detect rollback.
- Triggers `tools.execute` callbacks to the client for each `tool_call` action. See `docs/agent-ir-spec.md` for the proposal and result shapes.
- **Gated by the session's permission tier.** Before any action dispatches, the proposal is admitted against the session's granted standing tier (`permission.set_tier`, default `sandbox_edit`). An action whose required tier exceeds the grant — or a `full_access` action, which is always mandatory HITL — blocks the **whole** proposal: every action comes back `rejected`, nothing executes, and no state write lands. The error names the fingerprints to hand to `permission.approve`; re-submitting after approval succeeds. Run `permission.evaluate` first to see the same verdict without submitting. See the `permission.*` section.
- `session_id` (optional) scopes per-action policy validation to a session opened via `session.policy.open` on this connection's runtime. Global policies still apply, plus the session's. Omit for the default global-only path. See `docs/proposals/per-session-policy-scoping.md`.
- After a `tools.execute` callback explicitly returns terminal failure, this WebSocket session is halted. Later submissions return the normal whole-proposal `rejected` result shape and dispatch no tools until a host clears the latch or the client reconnects. No run is synthesized or completed automatically.
- `scope` (optional) is a `RuntimeScope` — `{ callerId?: string, tenantId?: string, claims?: object }` — attaching per-execution caller / tenant identity. When `tenantId` is set, the runtime routes per-action state R/W (`StateWrite` / `StateRead` / `Assertion` + action `expected_effects`) through the tenant-scoped view so distinct tenants can't observe each other's keys (Parslee-ai/car#187 phase 3). The car-a2a bridge already passes this automatically for inbound A2A messages; direct WS callers building their own proposals attach it here. When both `session_id` and `scope` are supplied, the runtime currently routes through `execute_scoped` (scope wins) — combining per-session policies with per-tenant scoping is a follow-up.


{% endraw %}
