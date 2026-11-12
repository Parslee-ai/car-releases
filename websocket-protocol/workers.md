{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### workers

An **orchestrator** is a supervised agent whose installed manifest declares the
worker bundles it may start (`[[workers]]`). It starts **workers** at runtime,
one per customer source for example, each labelled with what it is for, such as
`tenant=t-81f2`. A worker is its own supervised process with its own handle,
token and records. The design is `docs/proposals/orchestrator-workers.md`.

**Where workers start, and without what.** Workers run only where the file
wall applies (decision 20, amended 2026-10-27 to add macOS): on Linux, Landlock
at the ABI CAR needs and the daemon's own binary as each worker's per-agent
init; on macOS, Seatbelt (`/usr/bin/sandbox-exec`) with a self-test that
passes at daemon start, in which a probe under a real wall must fail to read a
token-shaped file outside its folder and succeed in its own `data/`. On both,
the worker's `workers/<handle>/home/` is read-only, `home/data/` is its only
writable folder, its bundle root is read-only, and the daemon's token files,
key store, other agents' and workers' folders and the rest of `CAR_HOME` are
refused (the `agents` reference lists the Mac's system paths). On a Mac the
orchestrator that starts workers is walled the same way and held to the same
walled-agent default-deny as on Linux, so it cannot read its workers' approval
text through `host.approvals`, `host.events` or `host.subscribe`; no other Mac
agent changes. A Mac has no per-agent init: a worker's tree is ended by process
group. **There is no network
fence yet** (CAR-544). A worker on such a host starts walled in to its own
folder but **can reach any host**, including the cloud metadata address and
services on the server's network. That is never hidden. The worker's row in
`agents.list` (and so `car ls --json`, also spelled `car agents --json`) carries
`network_fence_warning: "Network fence: not built yet. This worker can reach any
host."`, which `car ls` (`car agents`) and the dashboard's home screen and
worker row show in red. `car doctor` names, in red, every worker running now
that started without the fence. The `workers.start` reply carries the same
field. Every start of a worker, whichever path started it (`workers.start`,
`agents.start` or `agents.restart`, a crash restart, a boot resume), is one
row in `workers/<handle>/worker-starts.jsonl`, never trimmed, and one
`worker_started` event (`data.handle`, `data.at`, `data.seq`, the start's place
among the worker's starts from 0, `data.network_fence: "none"`,
`data.warning`) in the event log of its orchestrator's sessions and of host
sessions, read with `events.query`, each start once per session. A session's
first read of a worker's starts gives it the newest 256, and, when there are
older ones, one `worker_starts_omitted` event (`data.handle`, `data.omitted`,
how many were not replayed, and `data.path`, the file that holds them); after
that it is given each new start. A start whose row could not be written still
starts, is logged, and still reaches those event logs, with `data.record_error`
saying why it was not recorded. Such an event has no `data.seq`: it was never
numbered, because it is delivered from the daemon's memory, not from the file
(and so is not delivered again after a daemon restart). The daemon keeps the newest 1,024 such starts; when older ones were let go before a host session read them, that session gets one `worker_starts_omitted` event with `data.unrecorded: true` and `data.omitted`, how many it missed, and no `data.handle` (car#3381). The warning is also in the worker's own start
record, `workers/<handle>/starts.jsonl`. Windows, a Linux host where the file
wall cannot be applied, and a Mac where it cannot be applied or its self-test
failed (the daemon itself runs inside a Seatbelt sandbox, say) refuse every
`workers.start`, and the install and start of an orchestrator, with
`fence_unavailable`. Under `--no-auth` they are refused
with `auth_disabled`.

**One admission point.** Every path that makes a worker process run applies the
same checks under the supervisor's state write lock: `workers.start`,
`agents.start` and `agents.restart` on a worker's handle, the supervisor's
crash restart, and a worker resumed at boot. The checks are daemon auth, the
platform and fence self-test, the label's state (a label being deleted admits
nothing, and a worker of a deleted label's earlier epoch is never started
again), that the orchestrator still declares the bundle version, and the
author's caps counted over the orchestrator's whole tree. A refused start
spawns nothing and counts nothing.

**What a worker session may call.** Once a session authenticates as a worker
(`session.auth { agent_id: <handle>, token }`), every frame it sends passes the
worker gate first, on every platform. It may call only `session.auth` (its own
handle and token, nothing else), `server.handshake`, `workers.report`, the
model calls `infer`, `infer_stream` and `infer.cancel` (its own calls), and
`secret.get` for the names its bundle declares (see "Handed-over values").
Anything else is refused with `-32003`, `data.reason: "not_on_worker_list"`,
and recorded in the worker's own folder. Binary frames (the voice PCM
transport) are dropped and recorded the same way. A parameter that names a file or
folder on the server is refused with `data.reason: "host_path_not_allowed"`:
a path-like key (`path`, `file`, `filename`, `cwd`, `*_path`, …), a content
block whose `type` is a path kind, or any value that is a `file:` URL or an
absolute, home-relative, climbing or Windows drive path.
A worker's socket carries only responses to its own calls, the
`inference.stream.event`, `infer.started` and `infer.progress` frames of its own
model calls, and control frames: no host event, credential event, peer message
or other push reaches it. Nobody
may send a worker an `agents.message`, and `agents.chat` with a worker is
refused until chat credentials exist.

**Where a worker's files live.** Everything about a worker is written under
`<CAR_HOME>/workers/<handle>/`, never into a daemon-wide file: its spec, its
stdout and stderr logs (`logs/`), its session journals (`journals/`), its
supervisor pid record (`supervisor.pid`), its start records, key-read rows,
refusal rows, last report, end reason and handed-over values (`values/values.json`). On Linux its wall is
`workers/<handle>/home/`, read-only with `home/data/` its only writable folder,
plus its bundle version read-only. It has no `/dev/shm`. A worker cannot read,
list or write another worker's root. `agents.list` reports a worker's
`manifest_path` and log paths inside its root.

**Stopping a worker.** The host, or the worker's own orchestrator, calls
`agents.stop`. The worker records `stopped_by` with who stopped it (the
orchestrator's id, or the server owner). Its process tree ends within the stop
grace period (10 s by default), then SIGKILL.

**The orphan rule.** When an orchestrator is stopped with `agents.stop`, is
removed, exits and its restart policy does not bring it back, or crashes past
`max_restarts`, every worker it started is stopped at once, in parallel, within
the stop grace period. Each records `orchestrator_stopped`. A crash the restart
policy recovers from, `agents.restart` of the orchestrator, and a daemon
shutdown leave its workers running.

**Time limit.** A worker's `time_limit_secs` counts from its `workers.start`
request, across restarts: a crash restart, `agents.start`, `agents.restart` and
a start at a daemon's boot all keep the original deadline. When it passes, CAR
stops the worker's whole process tree and records `timed_out`.

**Crash loops.** A worker that keeps crashing is restarted by the supervisor
with growing gaps (its bundle's `backoff_secs`, doubling each time, capped at
60 s), up to its bundle's `max_restarts` in a row. Past that it is `errored`
and records `kept_crashing` ("stopped: kept crashing"), with the last crash's
exit code or signal as its `last_error`. It is not restarted again.

**End reasons.** Each worker records how it ended, and its last error, in
`workers/<handle>/end.json`: `finished` (it exited and its restart policy did
not bring it back), `stopped_by`, `orchestrator_stopped`, `timed_out`,
`kept_crashing`, `interrupted_by_restart`, `restart_refused` (a crash restart
or a start at boot the admission point refused, with the refusal's code) or
`environment_failed` (its wall could not be applied, or a key it declares
could not be handed to it). Every way a worker ends for good records one. The
record is written before the worker's status says it ended, and it is sticky:
the first end since the worker last started is kept until its next start. `agents.wait` returns it
with the worker's last report in one reply (`agents.md`); none of it is text
the worker wrote.

**Daemon restarts** (decision 5). The supervisor never adopts a worker: a
worker that comes back is started again, through the admission point, under
the same handle, name, labels and history, and still belongs to its
orchestrator. Which workers come back:

- **A clean shutdown** marks each running worker to resume
  (`workers/<handle>/resume-on-boot`), except one whose end is already on
  record: a worker inside a deliberate stop's grace period is still running
  but is not marked. The next boot starts a marked worker again; the marker is
  removed once its process runs, so a start refused at this boot is tried
  again at the next.
- **A worker waiting out a crash restart's backoff** carries a `restarting`
  marker (`workers/<handle>/restarting`), written when the backoff begins and
  removed at the next spawn or when the worker ends. A daemon that dies in
  between left a start owed, so the next boot gives it one.
- **An end on record wins.** A worker that has an end since its last start,
  such as one stopped on purpose (`stopped_by`, `orchestrator_stopped`), is
  left as it ended, even when the daemon died during its stop grace and its
  init then said `daemon_gone`. Only a resume marker starts such a worker
  again.
- **Nothing on record means interrupted.** The last rule: a worker that every
  rule above left with no end, no marker and no process (a marker that could
  not be written, a crash between the two halves of `agents.restart`) records
  `interrupted_by_restart`. A worker is never left stopped with no end.

The order at boot: a resume marker; an end on record; a `restarting` marker or
a surviving process; the init's record; the host-instance key; and last,
nothing on record at all.

An end that cannot be written to disk is held in the daemon's memory, so
`agents.wait` still returns it, with `end_record_error` saying why it is not
on disk; it is lost if the daemon restarts first, and the boot then treats the
worker by the rules above.
- **A daemon that died** leaves each running worker's pid record, and beside it
  the host-instance key the worker was spawned under
  (`workers/<handle>/host-instance`) and its walled init's word on why the
  worker ended (`workers/<handle>/init-outcome`). The rule: start again what
  died with CAR; a worker that ended on its own, its exit unrecorded because
  CAR was down, is interrupted. At the next boot:
  - a worker whose process is still alive is killed (on Linux through its
    walled init) and started again;
  - one whose init ended it because CAR's side of its control socket closed
    (`daemon_gone`: the daemon exited or crashed) died with CAR, and is
    started again, on the same host too;
  - one whose init saw it exit first (`exited code=<n>` or
    `exited signal=<n>`) ended on its own: it records `interrupted_by_restart`
    ("interrupted by restart") with that exit as its `last_error`, which is
    final, and no boot starts it again;
  - with no word from an init (an unwalled worker, or an init killed along
    with the host), it is started again only if the host-instance key changed,
    which means everything died with the host or the container; under the same
    key it is interrupted.
- **The host-instance key** is, on Linux, the boot id
  (`/proc/sys/kernel/random/boot_id`) plus the start time of PID 1 as the
  daemon's own pid namespace sees it, so a reboot or a container restart
  changes it and a daemon restart does not. On macOS it is the kernel's boot
  time (`kern.boottime`); on Windows, the kernel's per-boot `BootId` counter.
  A key that cannot be read counts as unchanged, so CAR never starts a worker
  again on a guess.
- **Only beside its orchestrator.** A worker whose installed orchestrator did
  not start at that boot (no `auto_start`, or another instance answers for it)
  is not started, its marker is cleared, and it records
  `orchestrator_stopped`. An outside orchestrator has no process, so it counts
  as present whenever it is installed, and its workers come back the same way.
- **Through the admission point.** Every one of these starts passes the same
  checks as `workers.start`, under the supervisor's write lock: under
  `--no-auth` nothing starts, the caps are never exceeded, and a worker of a
  label being deleted is not started. A worker the admission point refuses at
  boot records `restart_refused` and keeps its resume marker, so a later boot
  that admits it starts it. Nothing else starts a worker.

**Removing a worker.** The host, or the worker's own orchestrator, calls
`agents.remove { id: <handle>, stop?: bool }`. A worker that is running,
starting or in backoff is refused unless `stop: true` (`-32003`,
`worker_running`, "worker is running: <handle>"). Removal deletes the worker's
home folder and everything in its root that could start, resume or describe a
live worker: the spec, the resume marker, the pid record (one a crash left
behind included), the last report, and its handed-over values. The spec goes
first: when it cannot be deleted the removal fails and the worker stays
registered. Once it is gone the worker is removed: if deleting the other files
then fails, the daemon logs the failure, the files not yet deleted (the
handed-over values among them) stay on disk, and the removal still succeeds. A removed worker never comes back at a
boot. Its records (logs, journals, key-read and refusal rows, its end reason)
stay readable to the server owner, marked removed in `worker.json`, until a
label delete removes the root. Removing an orchestrator stops and removes all
its workers first.

**Who sees and acts on a worker.** Only the host and the worker's own
orchestrator. An orchestrator's `agents.list` and `agents.health` hold its own
row and its own workers' rows, and nobody else's. `agents.peers` shows a
worker, and lets it be addressed by name, only to the host and its own
orchestrator. `agents.stop`, `agents.start`, `agents.restart`, `agents.wait`
and `agents.remove` on another orchestrator's worker, or on a handle that does
not exist, are refused the same way: `-32003`, `not_your_worker`, "not your
worker: <handle>". Each refusal is recorded in the caller's own record without
the target's handle, and, when the target is a real worker, as a full row in
that worker's root.

**Handed-over values.** An orchestrator can give each worker its own secret
values at start, such as a short-lived token scoped to one tenant:
`workers.start { ..., values: { SOURCE_PASSWORD: "…" } }`. Each name must be
one the worker bundle declares in `secrets`.

- **How the worker reads one.** In its environment under the declared name,
  and through `secret.get { key: "<name>" }` from its own session.
- **Resolution.** For each declared name, the handed-over value comes first,
  then the CAR store. A declared name that is neither handed over nor in the
  store refuses the start (`missing_key`). A name a value was handed over for
  is never read from the store: the worker's spec records the handed names
  (never the values), and if one of their values is missing, every later
  start of that worker is refused ("the value handed over for <name> is
  missing") and `secret.get` for it fails the same way. Installed agents are
  unchanged: one CAR-wide value per name, and no per-agent layer.
- **Where they are kept.** In `workers/<handle>/values/values.json`, a folder
  of their own (`0700`, the file `0600`) marked with `.nobackup` (and, on
  macOS, the Time Machine exclusion), inside `CAR_HOME` and outside the
  worker's wall. The marker covers that folder only: a backup that honours
  it still keeps the worker's logs, start records, key-read rows, journals
  and other records. They survive a crash restart, `agents.restart`, a daemon
  restart and a boot resume, so every start of that worker gets the same
  values. They cannot be changed after the start. A refused start removes
  them, and so does removing the worker. A name reused after removal starts
  with no values.
- **Where they never appear.** No reply, error message, worker row,
  `agents.list` or `workers.*` output, event, run record, export or daemon
  log line holds a value. A start writes one key-read row per handed-over
  name to `workers/<handle>/secret-reads.jsonl`, with the name and time and
  `source: "handed_over"`; a start refused because a handed value is
  missing or its file unusable writes the same row with outcome
  `handed_value_missing` or `handed_values_unreadable`. Each start writes
  log files of its own, so a value is never handed to a process whose logs
  hold output of an earlier run (see `agents.tail_log`, Per-run log files).
  A `secret.get`
  that fails on an unusable values file journals outcome
  `handed_values_unreadable`. A value the worker prints to its own output is
  replaced in its run's redacted log once its process ends, as for a store
  value. One
  worker's values never reach a sibling's or the orchestrator's environment.
- **Refused values.** A value under a name CAR or the operating system
  controls (`CAR_*`, `PATH`, a loader hook) is refused with `reserved_value`.
  So is a value equal to this daemon's token, its host token or a supervised
  agent's token, compared in constant time; that attempt is recorded in the
  orchestrator's refusal record and the daemon log, without the value.
- **Telling that a CAR takes them.** The handshake grants the optional
  capability `workers.start-values.v1` when the client asks for it in
  `optional_capabilities`. An older daemon refuses `values` as an unknown
  field.

**A worker's model calls.** `infer` and `infer_stream` from a worker differ
from anyone else's in five ways (I1, I5):

- **Fields.** Only `prompt`, `messages`, `model`, `params`, `tools`, `context`,
  `images`, `response_format`, `intent`, `client_ref` and `cache_control` are
  accepted, and in `params` only `temperature`, `max_tokens`, `stop`,
  `tool_choice`, `thinking` and `cache_ttl`. Any other field, `model_id`,
  `context_query` and `memory_intervention` included, is refused with `-32003`,
  `model_field_not_allowed`, naming it. So is a `messages` entry with role
  `provider_output_items`: those opaque items would reach the provider
  verbatim. A `response_format` JSON schema may take any shape (`$defs` and
  `$ref`, draft-07 `definitions`, a root `anyOf`, `oneOf` or `allOf`,
  `additionalProperties` as a schema) and is sent as given. Content arrives
  inline only: a path is refused by the gate (`host_path_not_allowed`).
- **Models.** The call runs on a model the worker bundle declares in
  `[worker] models`: the one named in `model`, or the first declared when none
  is named. Any other model is refused (`model_field_not_allowed`), and the
  model is pinned, so routing never moves the call to another. The adaptive
  router neither steers a worker's call nor learns from it.
- **Prompt cache.** A provider caches prompt prefixes per account, so CAR puts
  a short value derived from the worker's full label set (and the per-CAR
  secret) at the start of every part of the request a provider caches ahead
  of the conversation: the system text, into which the request's `context`
  and any system message are folded; the tools, as a CAR-defined first tool
  named after the value, when tools are present; and a structured-output
  format, as its `name` (a worker's own `name` is replaced; the schema is
  untouched). Before a worker's request is sent, CAR checks the serialized
  body: each part the provider caches ahead of the conversation either has
  the value starting within its first 256 bytes or is itself no longer than
  that (an empty `tools` list, a `{"type": "json_object"}` format: nothing a
  worker can fill and no slot for the value), and at least one of them must
  hold the value, so a request with no value anywhere is refused even where
  its conversation is not a checked part. So at most 768 bytes can come
  before the value, far less than any provider's minimum cacheable prefix
  (1,024 tokens), and no cached prefix can be shared across label sets. A
  request that fails the check is refused before it reaches the provider and
  counts nothing on spend. Workers of one label set share cache entries; workers of
  different sets never do. CAR adds no memory to a worker's request.
- **Usage.** The usage a worker receives reports the cache counts only inside
  the input total (`prompt_tokens`, or a stream event's `input_tokens`), with
  no `cache_read_input_tokens` or `cache_creation_input_tokens`, and
  `total_tokens` is always `prompt_tokens` + `completion_tokens`. A worker's
  calls also never trip the model's shared circuit breaker, so one label's
  failures cannot put a model another label uses into cooldown.
- **Spend.** A call counts once it was sent to a model: a one-shot call once
  the engine dispatched it, a streamed call once its request was handed to
  the HTTP client. One refused before that (an unknown or ineligible model, a
  missing key, the cache check) counts nothing. A call that was sent counts
  on the worker's spend and on the spend of each
  of its labels (`workers.spend`), streamed calls included, however it ends:
  completed, failed, timed out, cancelled, cut off mid-stream, or its worker
  disconnected. A call that did not complete counts the usage reported so
  far, or, when none was, its input estimated before it was sent. A cancelled
  call is counted when its backend actually stops.

**Error codes.** Every refusal carries the outcome text as `message` and a
stable `data.reason`:

| Code | Name | `data.reason` |
|---|---|---|
| `-32003` | refused | `not_on_worker_list`, `host_path_not_allowed`, `report_field_not_allowed`, `not_a_worker`, `not_your_worker`, `worker_running`, `model_field_not_allowed` |
| `-32013` | worker start refused | `no_worker_bundles`, `not_declared`, `name_in_use`, `invalid_name`, `invalid_label`, `label_out_of_scope`, `undeclared_value`, `reserved_value`, `missing_key`, `environment_failed` (with `data.stage`), `start_failed`, `auth_disabled`, `unknown_field`, `fence_unavailable` |
| `-32014` | worker limit reached | `worker_limit_reached`, with `data.cap` (`total` or `label <key>=<value>`) and `data.orchestrator` |
| `-32015` | label state | `label_deleting`, `label_ended` |

#### `workers.start`
- **Params**: `{ bundle: string, version?: string, name: string, labels?: { <key>: <value> }, values?: { <name>: string }, wait_ready_secs?: number, time_limit_secs?: number }`.
  - `bundle` is a worker bundle the calling orchestrator declares in `[[workers]]`; `version`, when given, must be the declared one.
  - `name` follows the agent-id rule (1 to 128 of `[A-Za-z0-9._-]`, no leading `.` or `-`, no `..`), may not be a reserved id, and may not start with `wk_`. It is unique per (orchestrator, full label set), not CAR-wide: the same name under another label set is another worker, and a collision is reported only inside the caller's own label set.
  - `labels`: at most 8; each key `[a-z][a-z0-9_-]{0,31}`, each value `[A-Za-z0-9._-]{1,64}`. Set once, by CAR, at start; nothing can change them later.
  - `wait_ready_secs`: 0 to 60, default 0 (reply after the spawn). With more, the reply waits until the worker's own `session.auth` attaches.
  - `time_limit_secs`: 1 to 2592000 (30 days), default 86400 (24 hours). It counts from this request, across restarts; when it passes, the worker's whole process tree is stopped and it records `timed_out`.
  - `values`: secret values for this worker only, by name. Each name must be one the worker bundle declares in `secrets` (else `undeclared_value`, "not a declared key: <name>"), not one CAR or the operating system controls (`reserved_value`, "reserved key: <name>"), and each value 8 to 65536 bytes with no NUL (shorter is refused with `invalid params: values.<name> must be 8 to 65536 bytes with no NUL`, because the log scrubber masks every occurrence of a value in the worker's logs), never equal to this daemon's, its host's or a supervised agent's token (`reserved_value`, "value is CAR's daemon credential: <name>"). A declared name neither handed over nor in the store is `missing_key`. Every refusal creates nothing. A malformed `values` is an `invalid params:` error naming at most the key. See "Handed-over values" above.
  - Unknown fields are refused (`-32013`, `unknown_field`). The request has no network, fence, cwd, env, command or wall field and cannot carry one.
- **Returns**: `{ handle: "wk_<ULID>", name, state: "starting" | "running" | "ready", labels, orchestrator, bundle, version, network_fence_warning? }`. `network_fence_warning` is present while this CAR starts workers without the network fence (CAR-544). No environment, progress or timing field: those go to the owner only.
- **Who may call it**: an orchestrator's own agent session (`session.auth { agent_id, token }`), or an outside orchestrator's credential on the public door (see [credentials](credentials.md#credentials)). A credential with a `label_selector` may start a worker only with labels that hold every selector pair (`-32013` `label_out_of_scope`), and gets the shared form of a worker-limit refusal (`data.cap: "shared"`). A worker may not (no nesting in v1).
- Every later request addresses the worker by its `handle`.

#### `workers.report`
- **Params**: `{ status: "ok" | "partial" | "failed" | "needs_attention", counters?: { <key>: <u64> }, run_ids?: [string] }`.
  - Each counter key must be one the worker bundle declares in `[report] counters`, and each value a non-negative integer. Each run id must be one CAR minted for this worker; no run is minted for a worker yet, so `run_ids` must be empty.
  - Any other key, value or field is refused (`-32003`, `report_field_not_allowed`, naming the field). No field holds text the worker chose.
- **Returns**: `{ stored: true }`. The report is stored in the worker's own folder; the last write wins.
- **Who may call it**: the worker itself, and nobody else (`-32003`, `not_a_worker`).

#### `workers.spend`
- **Params**: `{ label?: "<key>=<value>", worker?: "wk_<ULID>", days?: number, orchestrator?: string }`. Name exactly one of `label` and `worker`. `days` is 1 to 92, default 7. `orchestrator` is for the host only, to say whose label to read; an orchestrator reads its own.
- **Returns**: `{ label | worker, timezone: "<UTC offset>", days: [ { date: "YYYY-MM-DD", spent_usd, input_tokens, output_tokens, calls, unpriced_calls } ] }`, one row per calendar day in the server's time zone, oldest first, ending today, a day with no calls included as zeros. Numbers only.
  - Every model call of a worker counts, `infer` and `infer_stream` alike, however it ends: once on the worker's own spend and once on the spend of each label it carries. `input_tokens` counts every input token, cached or not; a call that ended before the provider reported usage counts its estimated input.
  - A call counts on the server-local date it was sent, so a call that crosses midnight counts on the day it started.
  - `spent_usd` is each call's cost, rounded up to the next micro-dollar ($0.000001), and a day's figure is the exact sum of its calls. A call's cost is the provider's own dollar figure when the response carried one (OpenRouter's `usage.cost`); otherwise its usage times the catalog price of the model that served it, at the prompt-size tier its whole prompt falls in; otherwise $0 for a local or subscription model. A provider figure that is negative, not finite, above 100 times the call's list price (but never a ceiling below $1), or above $1,000 for a call with no list price is not taken, and the call is priced by the next of these. A call none of these can price adds to `calls` and `unpriced_calls` and nothing to `spent_usd`.
  - A call to OpenRouter that ended without OpenRouter's figure (a stream cut off before its final usage chunk) is looked up by its generation id for up to 10 minutes, and the figure found raises the call's cost on the day it was first counted. A later figure never lowers what was counted, and a lookup that finds nothing leaves the call as first counted.
  - The totals are kept in files, `workers/<handle>/spend.json` and each label's `labels/<orchestrator>/label-<key>/spend.json`, written by CAR's one spend meter from the worker's own call ledger, `workers/<handle>/calls.jsonl`. They survive a daemon restart, and a crash mid-call never leaves the worker's and its labels' totals disagreeing. A label deleted and used again starts a new total.
  - Nothing is capped yet: spend is reported, not enforced.
- **Who may call it**: an orchestrator's own agent session, for its own labels and its own workers (another worker's handle, existing or not, is `-32003`, `not_your_worker`, as is naming another orchestrator); and the host, for any. A label is read from the caller's own label folder, so another orchestrator's label of the same value is a different total. A worker may not call it.

{% endraw %}
