{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### spend

Spend on model calls made through CAR, read from CAR's one spend meter
(`car-registry/src/spend.rs`; design: `docs/proposals/spend-caps.md`). Every
key the meter knows is counted by the calls it made: an agent, a worker, a
label (charged by its workers' calls), the operator (daemon-token and host
sessions), CAR's own background work (`car:<purpose>`), a declarative agent
run inside the daemon, or an outside credential. Only calls routed through
CAR are counted: a call made around it (`claude -p`, an agent's own provider
key, in-process FFI inference, or `agents.invoke_external`, which starts an
installed agentic CLI that calls its provider with its own credentials) is not
seen by the meter, is not counted here, and is not stopped by a cap.

**Caps.** An agent's bundle may declare caps, an amount per calendar period:
`[spend] caps = [ { usd = 2, per = "hour" }, { usd = 10, per = "month" } ]`
(the rules are in `docs/agent-bundle-spec.md`, "`[spend]`"). CAR caps that
agent's spend on model calls made through CAR: before each such call leaves
CAR it is admitted against the agent's caps, and at a cap it is refused with
the error below. No cap declared means no cap: an agent without a `[spend]`
table has no bundle cap; owner and class limits still apply. Periods are calendar hours, days and
months in the server's zone (`zone` below). A call already in flight finishes
and counts in full, in the period it was admitted in, so one call may overshoot
a cap. Local models count $0 and never reach a cap. Caps change only by
installing a new version of the bundle (`agents.install`); `agents.upsert`
refuses a non-empty `spend_caps` field (an absent, null or empty one, as an
`agents.list` row of an uncapped agent carries, is accepted and the installed
caps are kept). A refusal sends nothing to the provider and
costs nothing, and the agent's process is not stopped, restarted or paused:
its next call after the period resets goes through by itself. A capped
orchestrator's own calls are capped; its workers' calls are not counted
against its cap until workers PR 5 (`docs/proposals/orchestrator-workers.md`)
adds the orchestrator's key to every worker call.

**The refusal, error `-32018`.** Every refusal is a JSON-RPC error with
`code: -32018`, the exact text below as `message`, and a stable
`error.data.reason`:

| `data.reason` | `message` | When | `data` |
|---|---|---|---|
| `budget_reached` | `budget reached until 3:00 PM EDT`; when the reset falls on a later local date, `budget reached until 12:00 AM EST on Dec 1` | a cap that applies to the caller is reached. With several reached at once, the one that resets latest is named, so a retry time read from it is right | `{ reason, cap: { usd, per }, holding: "agent", spent_usd, resets_at, zone }` — `resets_at` is RFC3339 in the server's zone. Below the root of a worker tree a shared cap gives only `{ reason, cap: "shared", resets_at, zone }`, naming no amount (the shared case is wired by the workers design; the shape is fixed now) |
| `price_unknown` | `price unknown for <model>; this agent has a spend cap`; for a model the price list does price but whose price yields no estimate for this call (a voice stream, whose length is not known when it opens), `the cost of this call to <model> cannot be estimated before it is sent; this agent has a spend cap` | a caller with a bundle cap or an owner-set owner/class cap pins a remote model that has no list price and whose provider reports no cost, or whose call cannot be estimated. A router-chosen candidate refused this way is skipped for the next candidate instead, on `infer` and `infer_stream` alike, and leaves no refusal record; only the refusal the caller receives (a pinned model, or a request no other candidate could serve) is recorded | `{ reason, model }` |
| `unpriced_call_in_flight` | `<model> is priced only when a call finishes, and this agent already has one such call running; this agent has a spend cap, so it may make one at a time` | a capped caller asks for a second call to a remote model with no list price whose provider reports the cost (OpenRouter), while its first is still running. Skipped and recorded exactly as `price_unknown` is | `{ reason, model }` |
| `spend_unrecordable` | `spend could not be recorded` | the meter could not write the ledger row for a capped caller; an uncapped caller's call goes through and `heal.status`'s `spend_meter` names the cause | `{ reason }` |

Where it arrives: as the JSON-RPC error of `infer`, of `infer_stream` (before
the stream opens), or of whichever method's model call was refused. In the
Node package it is an `Error` whose `name` is `SpendRefusedError`, with
`code`, `message` and `data`, plus `reason`, `cap`, `resetsAt` and `zone`
copied out of `data`; in Python it is `car_runtime.SpendRefusedError`, a
subclass of `DaemonRpcError`, with `code`, `message`, `data`, `reason`,
`cap`, `resets_at` and `zone`. Over MCP (`assistant_start` / `assistant_poll`)
the run's document carries `status: "spend_refused"` and
`refusal: { code: -32018, reason, message, data }`, and the poll reports
`status: "error"`. In CAR's own assistant loop (`car do`, chat) the turn ends
with the refusal message as its final text (the `done` frame), its outcome
status is `spend_refused`, and the loop makes no further model call that
turn.

What a refusal writes: a `model_call_refused` event (`EventKind::ModelCallRefused`,
data `{ agent: "agent:<id>", cause, reason, message?, model, cap: { usd, per },
holding, spent_usd, resets_at, zone }`, no metrics, because nothing was
spent) in the session's journal and in the principal's call ledger, so
`events.query { agent }` reads it from any owner connection; when the session
has a current run, a `{ record: "model_call_refused", … }` record (see
`runs.trace.event` in [runs](runs.md#runs)), one step of a run that
continued, never a failed run; and one more on `refused_calls` for the
principal's day and period.

**Prices.** A capped agent's admission holds the call's estimate (input
tokens plus `max_tokens`, at the list price) in flight against the caps,
which is what bounds a burst of parallel calls to one overshoot, so the price
list matters here. A remote model with no list price has no estimate. When
its provider reports the cost of each call (OpenRouter's `usage.cost`), a
capped agent may still use it, one call at a time (owner decision,
2026-10-26): while one such call is running for the agent, a second is
refused `unpriced_call_in_flight` and nothing is sent; calls to priced models
are not held up by it. The provider's figure is charged when the call
finishes. If the call ends with no figure but the provider named the
generation, CAR looks the figure up afterwards, however the call ended (a
success, an error, a cancelled or broken stream, a candidate the router fell
back from), and the agent's next such call stays refused until that figure
is applied to the call, or the lookup gives up, at most 11 minutes later; so the next call is admitted against a total that includes this one.
If no figure ever arrives, the call settles as any unpriced call does: cost
unknown, counted $0 against the cap and as a call that was not priced
(`unpriced_calls`). A period's total is at most the cap, plus one priced
overshoot, plus the one unpriced call in flight, plus whatever the calls with
no figure cost.

**Accepted gap: a cap cannot stop spending on a model whose provider never
reports the cost** (owner decision, 2026-10-26). A capped agent's
provider-priced call that ends with no figure stays at $0 against its cap,
and the agent may keep making such calls, one at a time. `unpriced_calls` in
`spend.status` (each period, and the day history) counts them: it is how an
owner sees spending a cap did not count.

A remote model with no list price whose provider reports nothing is refused
`price_unknown` when a bundle cap or an owner-set owner/class cap applies.
The automatic $300 owner ceiling alone preserves admission for such models:
missing cost counts $0 and one `unpriced_calls` on the caller, owner and class
keys, and later calls continue. Provider-priced models still use the
one-at-a-time slot under that default ceiling. The slot lives in the daemon's
memory, and a restart ends every call it had in flight. ElevenLabs Scribe
(speech to text) is priced in the built-in catalog at $0.22 per hour of audio. ElevenLabs text to speech
(`eleven-flash-v2.5`) is unpriced (it is credit-based per plan, with no single
list price), and so are the `parslee/*` models (`parslee/fast`,
`parslee/reasoning`, `parslee/advisor`): with a bundle cap or an owner-set
owner/class cap, a call to any of them is refused `price_unknown` until the
price list has them. Under only the automatic ceiling, it goes through with
its cost unknown, counted as a call that was not priced. A call that ends after it was sent but before its answer was read
(a stream the caller dropped or that broke off, a call the caller abandoned
or whose deadline elapsed, a request that timed out or was reset after it
was sent, a 200 whose body could not be read) is charged,
for a capped agent, its admission estimate: the
input it sent plus the `max_tokens` ceiling, at the list price, unless the
provider's own figure arrived. Most providers send output usage only in the
last chunk, so this is the upper bound that keeps the cap from under-counting
the output already generated. An uncapped agent's such stream settles on its
input tokens only, as before (PR 3).

#### `spend.status`
- **Params**: `{ agent }` — `agent` is required for host and operator sessions (a bare agent id, `invoice-bot`). A session bound to a supervised agent, or an outside credential's session, may omit it or name itself; naming any other id is refused `-32003` with `data.reason: "not_your_agent"`, and the refusal is recorded in that principal's own refusal rows. A host or operator session that omits it gets an invalid-params error, "spend.status requires `agent` on a host or operator session".
- **Role**: `operator` in the generated role table (the handler guards inside `spend_rpc`), and on the agent-usable list and Linux's walled-agent list, so every supervised agent may call it for itself. A principal reads its own spend and caps; no method an agent's credential can reach writes caps or spend.
- **Returns**: `{ agent, zone, zone_label, capped, periods: { hour, day, month }, declared, at_budget, caps_from_version, cap_history, meter }`.
  - `zone` is the IANA zone the periods are computed in, the server's; `zone_label` its current abbreviation (`EDT`).
  - `capped` is `true` when the agent's installed bundle declares at least one cap.
  - `periods.<hour|day|month>`: `{ start, resets_at, spent_usd, calls, unpriced_calls, refused_calls, cap_usd, left_usd, at_budget }`. `start` and `resets_at` are RFC3339 in `zone`. `spent_usd` is the period's spend rounded **up** to the cent from the meter's micro-dollars; `left_usd` is `max(0, cap - spent)` rounded down to the cent, and `null` with `cap_usd` when no cap is declared for that period. `calls` counts the period's admitted calls, `unpriced_calls` those nobody could price plus local-model calls, `refused_calls` the refusals. The three periods are returned for an uncapped agent too, so its figures are visible. The figures are the meter's own sums and equal the sum of the agent's ledger rows.
  - `declared`: the caps as written in the bundle, `[ { usd, per } ]`, the amount printed as declared (`2`, not `2.0`); `[]` for an uncapped agent.
  - `at_budget`: `null`, or `{ cap: { usd, per }, holding: "agent", resets_at, zone }` while a cap is reached. It is derived from the meter and the agent's current caps on every read (settled spend plus the estimates in flight has reached a cap, as the next admission would find it), never remembered: it holds across a daemon restart, and a new install that raises the cap clears it at once.
  - `caps_from_version`: the bundle version that declared the current caps, or `null`.
  - `cap_history`: every install that changed the caps, oldest first, `[ { at, version, by: "owner", from: [ { usd, per } ], to: [ { usd, per } ] } ]` (`at` is RFC3339 UTC). Read from `<CAR_HOME>/spend/agents/<id>.history.jsonl`.
  - `meter`: `{ healthy, last_error, clock, zone, zone_source }`, the same health `spend.costs` and `heal.status` report. An unknown agent id reads zeros, `capped: false` and an empty history; nothing is created.
- CLI: `car spend <agent> [--json]` prints this. Inside a supervised agent's own environment (`CAR_AGENT_TOKEN` set) `car spend` with no agent prints the agent's own.

#### `spend.costs`
- **Params**: `{}`
- **Role**: `operator`. A session bound to a supervised agent gets the refusal every operator-only method gives it (`-32603`, "`spend.costs` is not available to a supervised agent …"); an outside credential's session is refused `-32003` with `data.reason: "car_wide_not_allowed"`, and that refusal is recorded in the credential's own refusal rows: a principal reads its own spend with `spend.status`, never everyone's.
- **Returns**: `{ zone, rows: [ { agent, kind, today_usd, last_7_days_usd, this_month_usd, calls, tokens_in, tokens_out, cost_not_reported_calls, capped, at_budget } ], total: { today_usd, last_7_days_usd, this_month_usd }, at_budget: [ { agent, cap, holding, resets_at, zone } ], meter: { healthy, last_error, clock, zone_source, prices: { refreshed_at, last_refresh_error, stale } } }`
  - `zone`: the IANA zone the periods are computed in, the server's (`America/New_York`).
  - `rows`: one per key that holds spend, sorted by key id. `agent` is the key's full id, so rows of every kind are unambiguous: `agent:<id>`, `worker:wk_<ULID>`, `label:<orchestrator>/label-<key>`, `operator`, `car:<purpose>`, `declarative:<id>`, `credential:<id>`, `owner:<id>`, `class:<owner>/<class>`. `kind` is `agent | worker | label | operator | car | declarative | credential | owner | class`.
  - `today_usd` is today's spend in `zone`; `last_7_days_usd` the last seven calendar days in `zone`, today included; `this_month_usd` the open month period, which is the same figure the key's own `spend.status` shows, so the two agree to the cent. All three are dollars rounded **up** to the cent from the meter's micro-dollars: a key that spent $0.00001 shows `0.01`, never `0`.
  - `calls`, `tokens_in`, `tokens_out` and `cost_not_reported_calls` count this month's calls. `cost_not_reported_calls` are calls nobody could price (no provider figure, no catalog price) plus calls to a local model; they count in `calls` and add nothing to the dollar figures, so a key whose every call this month was local shows calls with no spend rather than a false $0 of priced work.
  - `capped` is `true` for an agent whose installed bundle declares caps, else `false`. `at_budget` on a row is `null`, or `{ cap: { usd, per }, holding, resets_at, zone }` while one of that agent's caps is reached, derived as `spend.status` derives it.
  - `total`: the three periods summed over payer rows, excluding `label`, `owner`, and `class` aggregates. Those aggregates repeat their payers' calls, so leaving them out counts every call once. The sum is taken in micro-dollars and rounded up once, so it can sit a cent or so under the sum of the rounded rows.
  - `at_budget`: every principal currently at a cap, `[ { agent: "agent:<id>", cap, holding, resets_at, zone } ]`; `[]` when none is.
  - `meter.healthy` is `true` while `last_error` is `null`; a meter that could not record a charge reports `false` with the error. `clock` is `synchronized | held_until_synchronized | adopted_unsynchronized` (the meter's own clock after a reboot). `zone_source` is `TZ | system | utc_fallback`: whether `zone` came from `$TZ`, from the system, or from neither, in which case periods use UTC. `prices` is `{ refreshed_at: null, last_refresh_error: null, stale: [] }` until the price refresh arrives.
- CLI: `car spend --all [--json]` prints this as a table (`KEY  KIND  TODAY  7 DAYS  MONTH  CALLS  NOT REPORTED`, a total line with labels left out, and the zone and meter health) or, with `--json`, the result as is. `car ls` shows "at budget until <resets_at>" in the status note of an agent whose `agents.list` row has `budget: "at_budget"`.

#### `spend.limits`
- **Params**: `{}`
- **Role**: `host`.
- **Returns**: `{ default_owner: "local", default_monthly_usd: 300, class_default, limits: { caps, assignments, warned_months, delivered_warnings, events }, periods }`. `caps` maps owner/class meter keys to monthly dollar amounts; `assignments` maps payer keys to `{owner,class}`. `periods` maps aggregate keys to the existing hour/day/month status objects. Audit events carry cap changes (`by: "owner"`), refused changes, class assignments, and monthly warnings.
- CLI: `car spend --limits [--url ws://127.0.0.1:<port>/]` uses the host credential and prints this JSON view. Node/Python: `HostClient.spendLimits(paramsJson)` / `HostClient.spend_limits(params_json)`.

#### `spend.set_limit`
- **Params**: `{ owner?: string, class?: string, usd?: number, shadow_average_usd?: number }`. `owner` defaults to `local`. Supply `usd`, or supply a class with `shadow_average_usd`; the latter stores twice the supplied average as the cap. Amounts must be positive and within the existing spend amount range.
- **Role**: `host`, with no agent binding. Agent, credential, and ordinary daemon-token sessions are refused and recorded. This applies to every change, including a raise by Grace.
- **Returns**: the `spend.limits` view after the change. A missing class sets the owner's monthly ceiling; a class sets that class's monthly cap under that owner. An unset class cap means ceiling only; no shadow-run history or average is invented.
- Node/Python: `HostClient.spendSetLimit(paramsJson)` / `HostClient.spend_set_limit(params_json)`.

#### `spend.assign_class`
- **Params**: `{ principal: string, owner?: string, class: string }`. `principal` is the full payer key, such as `agent:invoice-bot`. Owner/class IDs are nonempty filename components, without separators, NUL, `.` or `..`, at most 255 bytes.
- **Role**: `host`, with no agent binding; unauthorized assignments are refused and recorded.
- **Returns**: the `spend.limits` view. The assignment applies to subsequent calls; already admitted calls keep their recorded keys. Unassigned principals charge owner `local`, class `unclassified`. Each call may supply `decision_class` to select its decision-ledger class instead of this fallback. The owner remains host-controlled.
- Node/Python: `HostClient.spendAssignClass(paramsJson)` / `HostClient.spend_assign_class(params_json)`.

**Call classification.** Supply `decision_class?: string` at the top level of a model-calling RPC, such as `infer` or `infer_stream`. MCP assistant starts and coder discussions retain their declared decision class across their spawned model work. It names the same class as the decision ledger, never a class inferred from the tool. The host-assigned owner cannot be overridden by a call.

**Owner/class paid limits.** Each paid admission adds `owner:<id>` and `class:<owner>/<class>` to the existing meter row. Aggregate keys use the same replay, clock, and period arithmetic as agent keys; they are excluded from `spend.costs.total` to prevent double counting. The default owner ceiling is $300 per calendar month. The check includes the new call's estimate, along with settled spend and existing reservations, before provider dispatch. A request that cannot fit is refused without sending it, with the existing `-32018 budget_reached` shape and `holding: "owner:<id>"` or `"class:<id>"`. The refusal ledger's keys retain both owner and class. Only bundle caps and explicitly stored owner/class caps require a known price; explicitly setting the owner ceiling to $300 also enables that rule. Provider-priced models without a list price are admitted one call at a time under either default or owner-set caps; missing reported cost counts $0 and one `unpriced_calls`, an accepted gap described above. The default ceiling alone also admits true Unknown models, preserving existing workers; their missing cost is counted the same way. Provider corrections can raise a settled charge above its estimate; that spend is kept and subsequent paid calls are refused. Local and exact `subscription` catalog rows bypass paid caps and never charge owner/class keys. Seat-pool CLI calls do not enter the paid meter.

At 80% of settled monthly spend, CAR durably reserves one warning for that owner/month in the meter's `spend/limits.json`, then opens an owner-facing `HostApprovalRequest` with one option, `acknowledge`, and month, spend, and ceiling in its text. The existing approval fanout handles paired iMessage/Slack delivery. A stable approval ID and persisted month prevent repeat requests; pending delivery is retried by the spend minute tick. `spend_gate::warn_owner` uses the existing `host.request_approval` need path. The warning is journaled as a `state_changed` event with `data.alert` in `spend/alerts.jsonl`; host `metrics.alerts` adds `monthly_spend_warning` rows from the durable warning events, including after reconnection. Acknowledging does not raise a limit. Cap changes have a pre-application entry in the existing decision ledger and a completed dispatch after application; an interrupted operation remains visibly pending or dispatched. Refused changes are also decision-ledger entries. Query them with host `ledger.list`.

#### `spend.changed` (server → client notification)
- A `host.event` with `kind: "spend.changed"` on the `host.subscribe` stream (see [host](host.md#host)): `{ kind: "spend.changed", agent_id, payload: { agent: "agent:<id>", at_budget, periods } }`. `agent_id` is the bare id for an agent; `payload.agent` is the meter key; `at_budget` is `null` or `{ cap, holding, resets_at, zone }`; `periods` is `spend.status`'s `periods` object (`hour`, `day`, `month`, each `{ start, resets_at, spent_usd, calls, unpriced_calls, refused_calls, cap_usd, left_usd, at_budget }`).
- Published when a principal enters "at budget" (on the refusal that reached the cap) and when the meter's minute tick clears it after the period resets, so a dashboard shows and removes "At budget" without reloading, within a minute of the reset. A session bound to a supervised agent receives only its own.

{% endraw %}
