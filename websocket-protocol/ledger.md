{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### ledger

The owner's decision ledger, stored in the same device oplog as assistant action
records. All methods require host-management authority, including grades; a
supervised agent cannot grade itself or override its class. Node and Python use
the generated `HostClient` methods (`ledgerList` / `ledger_list`, etc.); Swift
and Kotlin use the host-management daemon bridge.

Rungs, ordered from most to least autonomy: `out_loop` (act, count), `near_loop`
(act, offer for grading and undo), `draft` (owner sends), `ask_first` (owner
decides). A new class starts at `near_loop`, or at an explicitly declared
`starting_rung: draft` or `starting_rung: ask_first`; `out_loop` is never a
starting rung. Wrong drops one rung; promotion
requires owner-configured pass-rate bars, a clean streak, and enough tap cases.
Without evaluated bars, promotion is disabled. Class scope and paid-spend fields
are shared policy data for later classifier/enforcement consumers; they do not
replace existing tool permissions, grants, or spend gates.

A `LedgerEntry` requires `id`, one-line `what` and `why`, `class_id`,
`deciding_rung`, `evidence_link`, `undo`, `actor`, `bead_id`, `created_at`,
`version`, `grade_state`, `note`, `dispatch_state`, and `provider_message_id`.
Additive `graph_fact_ids:string[]` names the exact curated facts a compiled precedent carries.
Nullable fields use JSON null. `undo` is either the exact string
`"cannot be undone"` or `{tool, params, timeout_ms}`. The body assigns time,
rung, initial version 1, ungraded state, and pending dispatch; callers cannot
supply history or an already-completed entry.

A class has `id`, `name`, `rung`, `allowed_tools`, `denied_tools`,
`data_scope_tags`, `recipient_scope`, `stance` (`as_grace_openly` or
`as_keenan_no_disclosure`), nullable `paid_spend_cap` (USD millionths), nullable
`pass_rate_bars` (map keyed by rung, with `min_tap_cases`, `min_clean_streak`,
`pass_rate`), `tap_graded_case_count`, `clean_streak_length`, and nullable
`last_mover`, plus optional `approval_rules:string[]`, `report_format:string`,
and `skill_ids:string[]` for the brief compiler. Configuration through put preserves the existing rung and counters.
Creation records `{creation: class_id}` in `last_mover` and rung history, with
no owner override. Grades, owner overrides and recorded lineage caps can change
a rung. Promotion reads the TARGET rung's `pass_rate_bars[target]`, never the
departing rung's bar. The target's tap minimum, clean-streak minimum and weighted
pass rate must all be met; a missing target bar disables that promotion.

#### `ledger.put`

**Params:** `{ entry?: LedgerEntry, class?: DecisionClass, expected_class_rung?: "out_loop"|"near_loop"|"draft"|"ask_first" }`.

At least one of `entry` and `class` is required. A class alone returns the configured class without a registration entry. `expected_class_rung` is checked under the write mutex against the current class rung; stale writes are refused.

Creates an immutable decision description. Duplicate entry ids are refused.
Optional owner-authored class configuration initializes the policy or updates its
thresholds without changing its rung. Returns the stored entry. Each ledger
mutation crosses the oplog's fsync barrier before returning success.

#### `ledger.get`

**Params:** `{ id: string }`.

Returns `{entry: LedgerEntry|null, grades: GradeRecord[], classifier_case: object|null}`.
Grades include their request, accepted time, weight, and nullable `undo_result`.

#### `ledger.list`

**Params:** `{ class_id?: string, since?: number, until?: number, grade_state?: string }`.

Returns entries filtered by class (including all recursive predecessors), inclusive Unix-millisecond time bounds, and
`ungraded|good_tap|good_silence|wrong|undone`. Only completed entries age; refused, pending, dispatched and indeterminate entries never earn silence Good. Reads apply seven-day aging using
the body's clock. A silence Good weighs 1 versus 4 for a tap Good, does not add
a tap-graded case, and does extend the class's clean streak by one. Silence
never satisfies the target rung's tap minimum and cannot itself promote a
class. A later tap can promote once all target thresholds are met. Tapping a
silence-graded entry adds one tap case without counting that decision twice in
the clean streak.

#### `ledger.grade`

**Params:** `{ grade: { entry_id: string, entry_version_seen: number, operation_id: string, kind: "good"|"wrong"|"undo", note?: string|null, source: "phone"|"dashboard"|"import" }, undo_resolution?: string }`.

Returns `{entry, accepted}`. Exact operation retries are no-ops (`accepted:false`);
reusing an operation id for a different grade is refused. Stale versions are
refused. Wrong and Undo are final: Good never revives them. Every accepted grade
moves autonomy at most once. Internal `silence` grades cannot be submitted.

Undo commits Wrong, its rung drop, classifier case and replayable memory fact
before running the stored compensation through the existing runtime. Success
sets `undone`; failure, timeout, unavailable tool, or `cannot be undone` retains
`wrong`. `undo_result` explains the outcome. Compensation is at-most-once: a
crash after acceptance may leave a pending/unknown result and is never retried
automatically. An accepted Undo immediately shows
`undo_result: "unresolved: compensation outcome unknown; owner settlement required"`.
After reconciling the external outcome, the owner can retry the exact original
`grade` with `undo_resolution: "<what was verified or done manually>"` to settle
that unresolved record without dispatching compensation again. This is only
accepted for an already committed Undo operation. The result becomes
`"owner settled: <resolution>"`; the entry stays Wrong and its class is not
demoted again. Existing completed results cannot be replaced. A retry still
projects the Wrong memory fact without duplication.

#### `ledger.grade_note`

**Params:** `{ entry_id: string, grade_operation_id: string, operation_id: string, note: string }`.

Host authority attaches a nonempty one-line note to an already accepted tap
grade. Returns `{entry, accepted}`. One note is allowed per grade, including a
note supplied with the original grade; a second note is refused. Exact retries
of the note operation are no-ops (`accepted:false`), and reusing its operation
id with different params is refused. The grade record returned by `ledger.get`
exposes the attached `note` alongside the immutable original grade request.
Notes do not add a grade, bump the entry `version`, change its grade state, or
move autonomy. The entry's `note` reflects its latest grade; a note attached to
an older grade remains on that grade without replacing the latest entry note.

#### `ledger.classes.list`

**Params:** `{}`.

Returns all decision classes owned by this body.

#### `ledger.class.override`

**Params:** `{ class_id: string, rung: "out_loop"|"near_loop"|"draft"|"ask_first", operation_id: string }`.

Returns the class after an idempotent explicit owner override. `out_loop` is refused with `zero tap graded cases` when the class has no tap cases, including inherited cases. Its change names
`{owner_override: operation_id}`; grade changes name `{grade: operation_id}`.

#### `ledger.rung_changes.list`

**Params:** `{ class_id?: string }`.

Returns `{class_id, from, to, cause, at}[]`. Causes name a committed grade, override, creation, or `{lineage: source_class_id}` cap in the same ledger transaction. A successor filter includes every predecessor recursively, deduplicating shared ancestors.

The dispatch boundary covers configured assistant executor tools in daemon MCP
runs and coding discussions, including delegates. Both the entry and dispatch
claim share one fsynced transaction before the inner tool executes, followed by
one durable outcome transaction. The projection is rebuilt once at open and
updated after each committed delta, so dispatch never replays historical rows.
Identified actions include the caller's run id (even without a runtime session)
and retain one ledger
id across retry attempts; a cancelled call retains its dispatch claim, and a tool
error leaves an indeterminate result. Existing entries refuse automatic replay. Classes at draft or ask_first refuse autonomous dispatch.
The caller supplies the bead or manifest's `decision_class` to the runtime
binding (`assistant_start` and `coder.discuss.start` accept this optional id).
A discussion preserves its declared class on resume. Without a declaration the
class is `agent:<owner>`, shared by that owner's tools; classes are never per tool.
The executor is generic over class ids and uses the configured class rung.
Direct messaging RPCs, engine Message actions, proposal.submit callbacks,
loop-intercepted delegation, and supervised/CLI assistant runs are not covered
by this boundary. Provider reconciliation and classifier construction are later
Grace work. Provider-message ids remain null until a provider read-back adapter
is integrated. Ledger rows are body-owned; cross-device write arbitration and
phone/dashboard grading UIs are outside this change.

CLI: `car ledger list --json`; `car ledger grade <id> good --version <n>
--operation-id <stable-id> --json`. Reuse that operation id for a retry.

#### `ledger.class.put`

**Params:** `{ class: DecisionClass }`.

Creates or configures a class without an entry, using the same host-authority and
fsync barrier as `ledger.put`. Returns the stored class. New optional class fields:
`starting_rung` (`near_loop`, `draft`, or `ask_first`, creation only), `succeeds` (an array of
existing class ids; a single string is also accepted), `irreversible_actions`
(array of action descriptions), and `gates` (array of `policy:<file>`,
`reversible_default`, or `approval_rule:<id>`). Omission defaults to no predecessors,
no irreversible actions and no gates. An irreversible class without a gate is
refused. Gates are declared policy references; this method does not load policies.
Existing lineage is immutable, preventing cycles and removal of restrictions.

Successors inherit the most restrictive predecessor rung, distinct tap cases,
clean streak (the minimum at merges), and predecessor grade/rung history. Shared
ancestors count once. A Good cannot promote a successor above an ancestor's
current rung. A later family move reapplies the most restrictive family cap over
an earlier owner override; caps name their source and never become independent
restrictions that prevent that source recovering. A fresh override stands until
another family move. No parallel history store is introduced.

New optional entry fields: `reserved_markers` is an array from `money_or_legal`,
`identity`, `no_undo`, `reserved_for_owner` (default empty); `reason` is nullable
and is one of those four values or `pulled_back_to_ask_first`; `recipient` is
nullable `{kind: "person"|"org"|"system", id: string}`. A class with nonempty
`recipient_scope` requires a recipient on its entries. A reserved entry is
recorded at `ask_first`; every entry recorded at `ask_first` requires a reason.
The internal executor records a reserved marker's reason when it forces
`ask_first`, or `pulled_back_to_ask_first` when the class requires that rung.
Its entries at other rungs carry `reason: null`.
The internal executor accepts `reserved_markers` and `recipient` tool metadata,
refuses a reserved autonomous dispatch regardless of class rung, and opens one
system-level approval through the host approval mechanism. The pending entry
remains durable; a repeated entry cannot dispatch again.

#### `ledger.dispatch`

**Params:** `{ id: string, state: "dispatched"|"completed"|"failed"|"indeterminate", provider_message_id?: string|null }`.

Host-management authority only. Returns the updated entry after the existing
oplog fsync barrier. Allowed transitions are pending → dispatched → one of
completed, failed or indeterminate; repeats, including a second completed, are
refused. Each transition is recorded in ordered ledger revisions. The host may
record its own authorized dispatch at owner rungs; the autonomous boundary
retains its rung and reserved-marker checks. Completed entries age into silence
Good after seven days on the body's injected clock. Provider ids are retained
on the recorded outcome.

{% endraw %}
