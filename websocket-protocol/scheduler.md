{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### scheduler

#### `schedule.suggest`
- **Params**: `{ phrase: string, timezone?: string }`
- **Returns**: `{ cadence: { trigger: "interval"|"cron"|"manual", schedule: string, timezone: string|null, phrase: string } | null, reason?: string }`
- Deterministic and inference-free. The supported grammar is `every N minutes`, `every N hours`, `hourly`, `daily at HH:MM`, `weekdays at HH:MM`, `weekly on <day> at HH:MM`, and `on request`. Matching ignores case and repeated whitespace; times are 24-hour values. Interval schedules use `Nm`/`Nh`; cron schedules use the ordinary five-field form; manual schedules use an empty string.
- The Agent Builder's three shipped template phrases are also stable inputs: `Weekdays in the morning, plus when I ask` maps to weekday cron at 09:00, while `Whenever I assign a research question` and `When I ask for a reply or follow-up` map to `manual`.
- `timezone` is trimmed and preserved as cadence metadata; an empty value becomes `null`. It is not embedded in the cron string. Unsupported or invalid phrases are not RPC errors: `cadence` is `null` and `reason` tells the caller which forms are accepted.
- FFI: `suggestSchedule(phrase, timezone?)` (NAPI) and `suggest_schedule(phrase, timezone=None)` (PyO3) return the same JSON.

#### `scheduler.create`
- **Params**: `{ name: string, prompt: string, trigger?: "once"|"cron"|"interval"|"file_watch" = "manual", schedule?: string, system_prompt?: string }`
- **Returns**: task object (does NOT execute — just constructs the task definition)

#### `scheduler.run`
- **Params**: `{ task: object }`
- **Returns**: single execution result
- **Stateful dedup**: the daemon seeds the posted task with any prior execution
  history persisted for `task.id` (under `~/.car/tasks/`) before running, and
  saves the mutated task back afterward. This means the executor's deterministic
  occurrence guard survives across calls: re-posting the same Interval/Once/Cron
  task whose occurrence already ran returns the prior execution record instead of
  re-invoking the agent. `Manual` triggers carry no occurrence id and are
  intentionally never deduped (an explicit re-run is an intentional repeat).

#### `scheduler.run_loop`
- **Params**: `{ task: object, max_iterations?: number }`
- **Returns**: array of execution results
- **Stateful dedup**: same prior-history seeding and write-back as
  `scheduler.run` — occurrences already serviced in an earlier call are skipped.

#### Durable OS-level scheduling (`scheduler.os_*`)

`scheduler.run`/`run_loop` use in-process timers: if the daemon is down when a task is due, the run is missed. These methods delegate the *trigger* to the OS scheduler (`launchd` on macOS, `crontab` on Linux), which fires a command even with no CAR process running. Only `interval` and `cron` triggers are OS-schedulable (`once`/`manual`/`file_watch` are rejected). `program` + `args` are the command the OS runs to re-enter CAR and execute the task once (the caller owns this — e.g. a `car`/`car-server` invocation). Schedules are labeled `ai.parslee.car.task.<task_id>`.

- `scheduler.os_render` — **Params**: `{ task: object, program: string, args?: string[] }`. **Returns**: `{ label, launchd_plist, launchd_error, crontab_line, crontab_error, schtasks_xml, schtasks_error }` — a no-I/O preview of every backend (macOS launchd, Linux crontab, Windows Task Scheduler); each rendering is `null` when that backend can't express the schedule, with the reason in the matching `*_error`. (E.g. an interval that isn't a whole number of minutes can't map to cron; a `*/15` cron can't map to launchd's `StartCalendarInterval`; a multi-valued cron field can't map to a single `schtasks` trigger.)
- `scheduler.os_install` — **Params**: same as `os_render`. **Returns**: `{ label, backend: "launchd"|"cron"|"schtasks", detail, conflict_preserved? }`. Writes the plist to `~/Library/LaunchAgents` and `launchctl load`s it (macOS), appends a tagged crontab line (Linux), or registers a Windows Task Scheduler task via `schtasks /Create /XML` (Windows). Idempotent — replaces any prior schedule for the same task. On macOS the replacement is divergence-safe: the prior plist is claimed by rename (same inode) and the new plist published atomically; if some process wrote through a file descriptor it opened before the claim, those bytes are preserved at a sibling `<plist>.car-conflict-<utc>` file — never deleted or overwritten — and `conflict_preserved` carries that path (absent otherwise, and always absent for cron/schtasks). Also **persists the task to `~/.car/tasks/`** so the store stays the authoritative set of scheduled tasks (which `os_reconcile` reaps against); a persist failure aborts the install.
- `scheduler.os_uninstall` — **Params**: `{ label: string }` (full label or bare task id). **Returns**: `{ label, removed: boolean }`.
- `scheduler.os_list` — **Params**: none. **Returns**: a JSON array of installed CAR schedule labels on this host.
- `scheduler.os_reconcile` — **Params**: none. **Returns**: `{ removed: string[], kept: number, errors: string[] }`. Reaps orphaned schedules: uninstalls every CAR-managed label whose task is gone from `~/.car/tasks/` or whose trigger is no longer `interval`/`cron` (foreign launchd/cron entries are never touched). Best-effort per label — a failed uninstall is recorded in `errors` and the pass continues. Runs automatically at daemon boot; call this to reap on demand. Because `os_install` persists the task, a label with no backing task is normally a genuine orphan. If the task store can't be **read** (permission/IO error), it returns an error and reaps nothing rather than mistaking the failure for "no tasks"; a missing store dir is treated as legitimately empty.
- FFI: `renderOsSchedule`/`installOsSchedule`/`uninstallOsSchedule`/`listOsSchedules`/`reconcileOsSchedules` (NAPI) and the `snake_case` equivalents (PyO3).

#### `tasks.*` — daemon-native deterministic (command) scheduler (car-releases#72)

Schedule a **deterministic command** on a cadence expressed ONCE, with the OS backend hidden — the higher-level abstraction over the `scheduler.os_*` primitives for consumers who want "ask CAR to run my script on a cadence" rather than "deal with launchd/cron". The command runs a `program` + `args` (not an LLM prompt).

- `tasks.schedule` — **Params**: `{ name, program, args?: string[], cadence: { interval_secs?: number | cron?: string }, durable?: boolean, working_dir?, env?, timeout_secs? }` — the cadence is expressed once (exactly one of `interval_secs` / `cron`). **Returns**: `{ id, durable, backend: "launchd"|"cron"|"schtasks"|"daemon", task }` (`schtasks` = Windows Task Scheduler). CAR picks the backend: `durable: true` (default) installs to the OS scheduler so it fires even when car-server is down — **`*/N` cron is normalized** (expanded to a launchd calendar array) so the same input works on macOS and Linux; `durable: false` uses the in-daemon timer (fires only while car-server runs, `backend: "daemon"`), which supports `interval_secs` only (a cron cadence requires the OS backend). The task is persisted to `~/.car/tasks/` first (authoritative for `os_reconcile`). Commands execute with the daemon OS user authority; no per-task permission tier is enforced.
- `tasks.list` — **Params**: none. **Returns**: an array of `{ id, name, program, args, trigger, schedule, durable, backend, enabled }` for the command tasks in the store.
- `tasks.unschedule` — **Params**: `{ id }` (bare id or full `ai.parslee.car.task.<id>` label). **Returns**: `{ id, os_removed, deleted }` — removes any OS schedule AND deletes the task from the store (so the daemon timer drops it too).
- FFI: `scheduleTask`/`listScheduledTasks`/`unscheduleTask` (NAPI) and `snake_case` equivalents (PyO3).


{% endraw %}
