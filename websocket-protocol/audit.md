{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### audit

The owner's exportable record of what each agent did and who approved it
(car#3399). One export joins the per-client event journals, the
`permission.approve` and `permission.reject` decisions in `approvals.jsonl`,
the host approvals with their resolvers (the daemon-stamped
`resolver: { principal, transport }` of [host](host.md#host), kept in
`host-approval-resolutions.jsonl`), and the policy denials.

The same document comes from two entry points that never fall back to each
other: `car audit export`, which reads the files directly and works with the
daemon down, and `audit.export`, which reads them through a running daemon.

#### `audit.export`
- **Params**: `{ since?: string, until?: string, agent?: string }`. The times
  are RFC 3339; `since` is inclusive and `until` exclusive.
- **Returns**: `{ generated_at, range: { since, until, agent }, sources,
  journals: [{ path, events_read, chain: { status } }], actions, denials,
  approvals, host_approvals, notes }`.
  - `actions`: the proposals, action transitions and policy violations in the
    per-client journals, with run content redacted. `denials`: the rejected
    actions and policy violations only, with the kind, the subject and the
    reason, and no parameters or output.
  - `approvals`: every `permission.*` decision in append order (the ledger keeps
    only the last per fingerprint), each with its `resolver`, time,
    `fingerprint` and the `actions_admitted` it matched. `host_approvals`: the
    host approvals with their `resolver` (`principal`, `transport`).
  - `sources` reports, for `journals`, `approvals` and `host_approvals` each on
    its own: `earliest_record` (the oldest record that source could read, or
    null with `holds_no_records: true`), `range_starts_before_earliest_record`
    (true also for a source that holds nothing when `since` is set, because all
    of it may have been deleted), `rows_read`, `rows_skipped` (a journal
    file that could not be read counts as one skipped) and `read_error` (why a
    file or journals directory that exists could not be read at all, so it is
    never reported as empty). Each
    source has its own earliest record because approval records are kept
    while a finished session journal is deleted after 30 days or past 1,024
    files; one time over all of them would hide a gap in the action history.
    `rows_skipped` counts a torn or malformed line that was read past, so it is
    never dropped without a word.
  - `chain.status` is `verified`, `broken` (with the loader's reason),
    `not_chained` or `unreadable`. The export never switches hash chaining on.
    - With `agent`, only what belongs to that agent is returned. An event's agent
    is read from the run CAR stamped on it (`run_id`): the run's file sits
    under its agent's folder in `runs/`. An event whose run file is gone (run
    retention) cannot be attributed, so it is counted in
    `sources.journals.events_unattributed` and left out, never silently. A
    permission decision names no agent and is kept only when it matches the
    fingerprint of an exported action, gate decision or denial. The gate
    decisions (`admission_gate_decision`, `approval_recorded`,
    `permission_decision`) are exported with the actions.
  - A plain WebSocket client is a connection id: the daemon cannot tell CarHost
    from `car-host` or iOS when each holds the host token.
- **Authorization**: the host-management session only. A session bound to an
  agent is refused, and a daemon with no host token installed refuses every
  caller with the single-principal notice (a host gate there would admit every
  authenticated client). A dashboard session is refused.
- Errors: `audit.export takes { since?, until?, agent? }` for params of another
  shape, and `audit.export `since` is not an RFC 3339 time` for a time that does
  not parse.

{% endraw %}
