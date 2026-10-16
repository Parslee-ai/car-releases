{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### concierge

The model concierge — a learning agent that reasons over a user's model
portfolio and *observed usage* to suggest acquiring/switching models. Its
intelligence is a durable, attributable **outcome ledger**
(`~/.car/models/outcome_ledger.jsonl`) + the deterministic `recommend()`
oracle (no LLM in these methods). It speaks only on real friction and only
suggests a model it can show ranks higher than what's failing. WS-only.
See `docs/proposals/concierge-agent.md`.

#### `concierge.status`
- **Params**: `{ inference_active?: bool }` (defaults to the daemon's live
  inference state).
- **Returns**: `ConciergeStatus`
  - `lanes: LaneUsage[]` — per use-case lane (busiest first): `use_case`,
    `calls`, `successes`, `failures`, `inconclusive`, `not_model_fault`,
    `total_latency_ms`,
    `avg_quality: number | null`, `models_used`, `failing_models`.
    `avg_quality` is `null` when no receipt in the lane carried a quality
    signal — the usual case, since mechanical successes are unscored; it used
    to read `0.0`, which rendered as "every answer was wrong". Receipts the
    model was not at fault for — a local admission refusal (memory), a missing
    key or expired sign-in, a content ruling, a stream the caller dropped —
    are unattributed and counted in `not_model_fault`, never in `failures` or
    against a model's health.
  - `decision: { mode: "observe"|"answer"|"ask"|"act", confidence,
    evidence: string[], suggestion?: ConciergeSuggestion }` — what the
    concierge would do now and the receipts behind it.
  - `models: ModelHealth[]` — `{ model_id, calls, success_rate,
    avg_latency_ms, quality, excluded }` from observed outcomes.
    `success_rate` is `number | null` — `null` when nothing has resolved
    yet (render "no resolved signal", not a fabricated 0.5). These are
    lifetime profiles, not the lanes' 30-day window.
  - `catalog: CatalogFreshness` — whether signed-catalog updates (new models,
    revocations) reach this machine, read from the daemon's recorded checks
    (`catalog-status.json` in the state root; reading never fetches). Tagged by
    `state`:
    - `{ state: "never_checked" }` — no check recorded.
    - `{ state: "off", since }` — the update policy `off` skips the scheduled
      check.
    - `{ state: "current", last_verified_at, verified_version }` — the last
      check fetched and verified (newer than the cache or equal to it), or
      checks have failed for less than three days.
    - `{ state: "stale", source, last_verified_at, failing_since, failure,
      last_error }` — checks have kept failing for at least three days (about
      twelve missed six-hourly refreshes), measured from the first failure to
      the latest attempt rather than against the clock, so a machine that was
      simply switched off is not stale. `failure` is `unreachable` (the catalog
      could not be fetched: no network, or the source answered with an error),
      `rejected` (what it served did not verify, usually a signing key this
      build predates, so update CAR), or `older` (a validly signed catalog
      older than the cached one, such as a cache left from a staging
      `CAR_CATALOG_URL`, a publisher rollback or a stale mirror; updating CAR
      does not fix it). Logic reads `failure`; `last_error` is display text, and
      `source` has any query string removed. `car doctor` prints a warning for
      either kind; CarHost's Concierge pane shows the same warning, worded for the kind.
    `car doctor` adds one state this field never carries: `{ state:
    "stalled", loop_alive_at, daemon_alive_at }`. This home's daemon heartbeat
    is recent, but its catalog loop, which ticks every 15 minutes in another
    task of the same daemon, has not ticked for an hour of the daemon's current
    run. So the loop has stopped and records no failures either. Both
    timestamps are this home's and tick on the same clock, so a sleeping
    machine, a stopped daemon, the minutes after a wake, or another `CAR_HOME`'s
    daemon never reads as stalled. A daemon older than the loop tick records
    none and gets no verdict. Doctor's advice is to restart the daemon.
  - `revoked_pins: RevokedPin[]` — the same list `concierge.portfolio`
    carries (agents still pinning a model the signed catalog revoked), so a
    client can check it without a portfolio assessment. The daemon re-reads
    agent pins first; when the agent registry cannot be read it answers with
    the pins it last read.
- The pull-not-push surface CarHost's Model Health pane renders.

#### `concierge.dismiss`
- **Params**: `{ dismiss_key: string, reason?: "not_now"|"wrong"|"too_expensive"|"privacy"|"never_for_project" }`
  (defaults to `not_now`).
- **Returns**: `{ dismissed: string, reason }`
- Records a *labeled* dismissal: permanent reasons suppress the suggestion
  forever; `not_now` only cools it down (14-day cooldown). The reason is
  learning signal, not just a tombstone.

#### `concierge.defaults`
- **Params**: `{}`
- **Returns**: `LaneDefaults` `{ defaults: [{ project?, use_case, model_id, set_at }] }`
- Per-lane (optionally project-scoped) default models (Phase D1).

#### `concierge.set_default`
- **Params**: `{ use_case: string, model_id: string, project?: string }`
- **Returns**: `{ set, use_case }`
- A project entry overrides the global (`project` omitted) default for that lane.

#### `concierge.clear_default`
- **Params**: `{ use_case: string, project?: string }`
- **Returns**: `{ cleared: bool }`

#### `concierge.apply`
- **Params**: `{ use_case: string, model_id: string, project?: string }`
- **Returns**: `{ model_id, use_case, installed, set_default, prior_model_id }`
- Closed-loop "set it up" (Phase D3): acquires the model and sets it as the
  lane default, **capturing the prior default so the change is reversible**.
  User-consented; every step is recorded in the action ledger.

#### `concierge.rollback`
- **Params**: `{ use_case: string, project?: string }`
- **Returns**: `{ restored: string | null }`
- Reverts the lane default to its value before the last `apply` (restores the
  prior model, or clears if there was none).

#### `concierge.actions`
- **Params**: `{ limit?: number = 50 }`
- **Returns**: `{ actions: ConciergeActionEntry[] }` — the auditable log of
  concierge actions (install / set_default / clear_default / rollback /
  retire / retire_started / discard_partials / resource_policy / auto_upgrade), each with `prior_model_id`
  (Phase D2). `retire_started` is written before a retirement's first
  deletion, so one a crash cut short still leaves a record; an orphaned repo's
  entries carry `model_id: "repo:<owner/name>"`.

#### `concierge.maintain`
- **Params**: `{ dry_run?: boolean }` (host-management role required; `dry_run` defaults to `false`).
- **Returns**: a `MaintenanceReport` — `{ policy, dry_run, disk: { free_bytes, total_bytes } | null, pressured, plan: { act?: Decision, suggest: Decision[], held: [{ model_id, why }] }, retired?: { model_id, also_retired: string[], freed_bytes, restore }, orphan_retired?: { repo, freed_bytes }, upgraded?: { from, to, lanes: string[] }, partials_discarded: string[], resource_policy?: { from, to, reason, applied }, auto_grace_until?: number, errors: string[] }`. `auto_grace_until` is present during the first week a machine runs under the unchosen default `auto`: until then the pass behaves as `notify` and only suggests, and so does the upgrade notice. A `Decision` is `{ model_id, verdict, freed_bytes, digest, reason }`.
- Runs one maintenance pass now, the same pass the daemon runs on its own at most hourly when nothing is inferring or downloading. It honours the update policy: `off` does nothing at all, `notify` decides and suggests but never deletes, and `auto` acts. A pass:
  - finishes interrupted retirements;
  - re-reads agent model pins, and fails rather than proceed without them;
  - assesses the portfolio (`concierge.portfolio`) and retires at most one model, executing exactly its assessed plan (`expect` = `digest`).
- Which verdicts act:
  - `never_runs_here` and `cannot_load` act whenever recommended.
  - `superseded` acts after 30 days of observed silence (counted from the later of its last use and when usage became observable), or under disk pressure.
  - A candidate whose plan is busy right now (`in_use`, `downloading`) is suggested, never acted on, so it cannot stall the rest.
  - `idle` acts only under disk pressure.
  - Under pressure with no model to retire, the largest orphaned repo CAR fetched entirely goes instead — never while a link in the models directory, or any row's on-disk artifact, still resolves into it (a row discovered on disk names no repo, so nothing could fetch it back).
- **Disk pressure** is measured on the hub's volume, with hysteresis: it starts when free space falls under 15% or 20 GB, and holds until free space is over 25% and 40 GB.
- **Never retired:**
  - a model you asked to keep (`concierge.dismiss` with `dismiss_key: "retire:<model_id>"`: any permanent reason keeps it for good, `not_now` for 30 days);
  - a model CAR retired before and you fetched back, unless it cannot run here at all.
- **Partial downloads:** under `auto`, abandoned partial downloads in repos CAR fetches whole are discarded — never in a repo it took files from, where a partial may be someone's paused download. A partial is abandoned when no writer holds its lock and it has been untouched for a day.
- **Curated and benchmark upgrades:** under `auto`, when it retires nothing else and disk space is not short, a pass applies at most one pullable upgrade with `trust_tier: "curated"` (a curated rule, or a confirmed benchmark finding) that the user has not dismissed, that fits this machine and has room on the hub's disk, for a model a lane defaults to. Each such lane is switched through `concierge.apply`, whose canary reverts a regression. A model used only by explicit id is left to the upgrade notice, because a replacement nobody routes to would never run. A failed upgrade is retried after a day, not every pass. The old model is left to the portfolio, which retires it once the replacement has run and the old one has gone unused. The upgrade notice (`models.upgrade_available`) still announces auto-apply candidates, because a pass applies only those it can. The report carries `upgraded: { from, to, lanes }`.
- **Silence** counts only over time a usage-stamping daemon was continuously up. A stopped daemon breaks the run; sleep does not.
- **Memory policy:** a pass raises the local-model memory policy from `everyday` (40% of RAM) to `local_focused` (80%) when all of these hold:
  - nobody chose the saved policy (none is saved, or the saved one matches the concierge's marker);
  - the machine has at least 32 GB of RAM;
  - at least 3 loads of local models too big for `everyday` that `local_focused` admits were refused for memory, on at least 2 distinct days, since usage became observable. A model the current policy admits that was refused anyway ran into live memory, which a bigger allocation would only worsen, so it never counts.

  It undoes its own raise, back to `everyday`, when either of these happens afterwards: at least 3 loads of models `everyday` admits are refused for live memory, or the models only the raise admits fail at least 3 times without a single success. After undoing it, it never raises again. Under `auto` it saves and applies the change (a `resource_policy` entry in `concierge.actions`); under `notify` it only reports it in `resource_policy`. It never touches a policy the user chose.

#### `concierge.portfolio`
- **Params**: `{}`
- **Returns**: `{ policy, models: Assessment[], reclaimable_bytes, orphans: HubOrphan[], recent_actions: RecentAction[], revoked_pins: RevokedPin[], revoked_copies: RevokedCopy[], pins_unreadable?: string }`. `pins_unreadable` is present only when the declarative agent registry could not be read: it says why, and the protected verdicts may then miss models an agent pins (`models.retire` still refuses until the registry can be read). A `RevokedCopy` is `{ model_id, path, bytes }`: a folder still holding real files at an installed revoked model's `models_dir/<name>`, or at the path its install receipt records for a copy. `path` is a local filesystem path on the daemon's machine. `bytes` counts real files only, without following links. Computing this list only reads: it never resumes an interrupted removal. A revocation removes CAR's links and never real bytes, so these folders are reported and never deleted, by maintenance or anything else, and never counted in `reclaimable_bytes`. (A revoked model's hub download is a different case: once nothing references it, it is an ordinary `orphan`, which maintenance may retire under disk pressure by the usual rules. The rule is that a signed catalog never orders a deletion.) The record says the folder was named for a revoked model, not that its contents are that model's: a user's own folder put at that name later is listed too. Once a newer catalog stops revoking the model, the record is pruned, and the folder is neither listed nor hidden from discovery. A `RevokedPin` is `{ pin, model_id, agents: string[] }`: a model registered declarative agents pin (`inference.model`, as `pin` — an id or a model name) that the signed catalog revoked, resolved to the revoked `model_id`, with every agent pinning it, sorted. Nothing re-points an agent on its own, so an entry stays until the agents are changed. A pin is resolved against the live registry first; the recorded name of a revoked signed row is used only for a pin nothing live answers. Routing to a revoked signed row fails meanwhile; a revoked builtin still runs, deprecated. A `RecentAction` is `{ at, kind: "retire" | "upgrade" | "discard_partials" | "resource_policy" | "lane_cleared", subject, detail, undo?, use_case?, prior?, interrupted }`: what was retired or changed in the last 30 days, newest first — by the concierge on its own, or through `models.retire`. `undo` is the command that reverses it: `car models pull <id>` for a retirement, `car concierge rollback <use_case>` (`concierge.rollback`) for an upgrade that switched a lane, and `car models resource-policy set <previous>` for a memory-policy change. `interrupted` marks a retirement that began and never recorded completion; it is finished at the next daemon start. `undo` is display text; a client acts on the structured fields: `use_case` is the lane an upgrade switched (what `concierge.rollback` takes), and `prior` is what the action replaced — the previous model of an upgrade, or the previous memory profile of a policy change (what `models.resource_policy.set` takes). `policy` is `{ now, tracking_since: number | null, idle_after_secs, superseded_after_secs, cannot_load_failures }`. An `Assessment` is `{ model_id, name, verdict, action: "keep" | "retire", evidence: string[], kept: boolean, last_used: number | null, retire?: { freed_bytes, digest, refusals: string[], also_retires: string[] } }`, where `verdict` is `protected | never_runs_here | cannot_load | superseded | idle | active | unknown`. A `HubOrphan` is `{ repo, bytes, owner: "car" | "user" }`.
- Assesses every installed local model, reads only, and deletes nothing. The first rule that applies decides:
  - **protected**: a lane default, the configured generation/embedding/classification model, a local speech default, the local tool model CAR's setup guidance installs, a model a registered declarative agent pins (`inference.model`, enabled or not), or the MLX twin of any of these. Both `concierge.portfolio` and `models.retire` re-read the agent registry first. When it cannot be read, `models.retire` (and `concierge.maintain`) fail with an error rather than proceed without the pins; `concierge.portfolio`, which only reads, still answers and adds `pins_unreadable: string` saying why models an agent pins may not show as protected. `models.retire` refuses all of them (`lane_default` or `protected`).
  - **never_runs_here**: the platform cannot run it, or its cold-load peak exceeds this machine's memory with no policy applied — unless it has succeeded here or been used since tracking began, which outranks the estimate.
  - **cannot_load**: it failed at least `cannot_load_failures` times and never once succeeded.
  - **superseded**: a curated replacement is installed, runnable, and has itself succeeded or been used here; the user has not dismissed that upgrade; and this row has been unused `superseded_after_secs`.
  - **idle**: unused `idle_after_secs`.
  - otherwise **active**, or **unknown** while there is too little history to tell silence from disuse.
- Use is stamped whenever any local model — text, embedding, speech, image or video — is leased for a request. Silence counts only from when the daemon began tracking usage (`tracking_since`, set at the first daemon start with this version), so nothing is idle until a full idle period has been tracked. The outcome ledger can show a text model *was* used but never shortens that wait, because it records only this daemon's text calls. A CAR consumer older than stamping that loads local models in process is invisible to this assessment. `evidence` states the facts and thresholds in plain words.
- `action` is `retire` only when retiring would free something, the plan's refusals, if any, are ones time clears (`in_use`, `downloading`), and the user has not asked to keep the model (`kept`: a `retire:<model_id>` dismissal, permanent or `not_now` for 30 days). A kept model keeps its honest verdict but is never recommended, and is left out of `reclaimable_bytes`. Pass `retire.digest` as `models.retire`'s `expect` to execute exactly that plan. Rows that share a repo appear once in the recommendations, and none is recommended while a row sharing its files is still needed; `reclaimable_bytes` counts each shared repo once.
- `orphans` lists hub model repos no registry row references. `owner` is `car` only when CAR owns the whole repo by recorded provenance; otherwise it is `user`, reported and never touched. Repos the managed runtimes load on a row's behalf count as that row's references — the LTX video rows' text encoder (`mlx-community/gemma-3-12b-it-4bit`, which CAR now passes to `ltx-2-mlx` explicitly) — so they are never orphans and go when the row retires.

#### `concierge.refresh_catalog`
- **Params**: `{}`
- **Returns**: `{ refreshed: number, note }`
- Fetches the signed model catalog — `https://car.parslee.ai/catalog.json`
  unless `CAR_CATALOG_URL` names another — verifies its detached ed25519
  signature (`{url}.sig`) against CAR's built-in catalog key, or
  `CAR_CATALOG_PUBKEY` when set, caches it when
  its `version` is newer than the cached one (an older or equal version is
  refused), and loads it into the running daemon — no restart. Its rows then
  surface as grounded `recommend()` candidates / concierge suggestions.
  The daemon also does this on its own 10–40 minutes after start and about
  every six hours after (jittered), unless the update policy is `off` — `notify`
  still checks, without applying anything; on that schedule a catalog no
  newer than the cached one is a quiet no-op. Merge rules, the same at startup and
  live: a row for a compiled builtin id may update only that model's
  `public_benchmarks`, `cost`, `performance` and `deprecated` — never which
  weights it loads (a row naming different weights is ignored); a row for an id
  the user registered is ignored, so the user's definition wins; any other row
  is added. A row an earlier catalog added and the new one drops is removed,
  unless it is installed, pinned, or a lane default — then it stays, marked
  `deprecated`, until nothing depends on it. Kept rows survive a daemon
  restart: `catalog-retained.json` in the state root records each one's id and
  the signed catalog it came from, re-verified against `CAR_CATALOG_PUBKEY` at
  startup (an envelope that no longer verifies restores nothing). A model a
  catalog withdraws while it is downloading is kept the same way once the
  download finishes. A builtin a new catalog no longer
  overlays returns to the values this build shipped. A catalog may also list
  `revoked` model ids (bad weights, a compromised repo): a revoked signed row is
  removed even when it is installed, pinned or a lane default, is never
  restored at startup, and its directory under the models directory is never
  rediscovered (`catalog-revoked.json` in the state root records it); CAR
  removes its links to the weights but never deletes a copy holding real files.
  A revoked builtin is marked `deprecated` until a later catalog stops revoking
  it. A lane default naming a revoked model is cleared under every update
  policy, after a catalog swap and on every maintenance pass — routing then
  picks among installed models — and recorded in `concierge.actions` as
  `revoked_lane_cleared`, shown in `concierge.portfolio`'s `recent_actions` as
  kind `lane_cleared` with no `undo`. A revoked model cannot be set as a lane
  default (`concierge.apply`, `concierge.set_default` and rollback refuse it).
  Agents pinning a revoked model, by id or by name, are listed in
  `concierge.portfolio`'s `revoked_pins` and named in the daemon log; a
  revoked signed row's name stays recorded in `catalog-revoked-models.json` so
  a pin by name is recognised after the row has left the registry (discovery
  still skips only the installed ones, recorded in `catalog-revoked.json`). `CAR_CATALOG_PUBKEY` (and the built-in key) may be
  a comma-separated list; a catalog signed by any listed key verifies. Because an overlay can
  carry `public_benchmarks[].runs` and `spread`, the catalog signing key can
  confirm a `benchmark` upgrade finding (see `models.detect_upgrades`), which
  under `auto` switches a lane default through the canary-guarded
  `concierge.apply`.

#### `concierge.ask`
- **Params**: `{ question?: string }`
- **Returns**: `{ answer: string, summary: string, model_used?: string, ungrounded: string[] }`
- Conversational concierge (Phase F1/F2). `summary` states the facts with no model involved:
  - what each installed local model is doing (`concierge.portfolio`) and what retiring it would free;
  - the update policy, the disk, and what a maintenance pass would do and why;
  - the memory policy;
  - what the concierge did on its own in the last 30 days, with undo commands.
- Without a `question`, or with a blank one, `answer` is `summary` and no model runs.
- With a question, a model answers from that summary plus observed usage, model health and the verified candidate menu. It is routed for quality over latency, prefers on-device, is capped at 600 tokens, is cut at its first repeated line, and what it names is checked against the evidence. That covers every model id (`owner/name[:tag]` or longer, with a digit in the name) and every model family named by bare name ("Llama 3.1 70B"). Anything the evidence does not contain is listed in `ungrounded` and flagged in the answer. The answering model is a local model like any other, so asking counts as its use.
- If no model can answer, `answer` is the summary with a note, never an error. If agent model pins cannot be read, the summary says so (pinned models may not show as protected) rather than failing. `recommend()` remains the grounding oracle for acquisitions. Net-positive verification (Phase F3) runs separately:
  the daemon auto-reverts a `concierge.apply` switch that proves worse than the
  prior model (canary over observed post-switch outcomes).


{% endraw %}
