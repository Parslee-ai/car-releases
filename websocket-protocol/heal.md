{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### `heal.*` — the self-healing repair loop

`selfheal.*` above **detects and never writes**. `heal.*` is the other half: it
reads a configured issue tracker, runs a real coder session, gates the result on
a multi-model review panel, and opens a pull request. It **never merges** —
`coder.approve_merge` is where a human belongs, and a pull request is undone by
closing it.

**Default off, by absence rather than a flag.** There are no compiled-in
targets: a daemon with no `<CAR_HOME>/heal.toml` starts nothing. A repository
must also carry an explicit opt-in label on an issue (`self-heal` by default)
before the loop can see it — silence is not consent.

```toml
# <CAR_HOME>/heal.toml
review_models = ["claude-opus-5", "gpt-5.5", "gemini-3-pro"]
engine = "foreman"            # optional; foreman by default

[[target]]
repo  = "acme/widgets"        # where the work QUEUE lives
path  = "/Users/me/git/widgets"  # or `project = "<slug>"`; omit both for watch-only
label = "self-heal"           # optional
base  = "main"                # optional
fix_repo = "acme/widgets-src" # optional; when fixes land in a different repo

human_label = "needs-human"   # optional; hands an item to a person
escalate_to = ["octocat"]     # optional; GitHub logins assigned on escalation
notify = ["human:sam@sams-car", "codex-3@laptop"]  # optional; Lattice addresses told

# Whole organizations: every repository you can push to AND have checked out
# under `roots` (matched by origin remote); its labelled issues are worked.
[[org]]
owner = "*"                   # you plus every organization you belong to, or a login
roots = ["~/git", "~/work"]   # searched two levels deep; nothing is ever cloned
label = "self-heal"           # optional
base  = "main"                # optional

[unattended]                  # optional; the cadence. LOCAL models only.
coder_model = "qwen3-coder-30b"           # omit to pick from installed local models
review_models = ["gemma-4-26b", "gpt-oss-20b"]  # omit to pick; two families or more
```

**Any project, in any organization.** A `[[target]]` names one repository. An
`[[org]]` names a GitHub organization or user, or `*` for the `gh` login and
every organization it belongs to, so one entry covers every project you work
on. Each sweep (and `heal.run`) lists each owner's unarchived repositories the
`gh` login can push to (`WRITE`, `MAINTAIN` or `ADMIN`; one `gh repo list` per
owner) and keeps those you have a checkout of under `roots`. A checkout is
matched by its `origin` remote, never by directory name, at `<root>/<name>` or
`<root>/<group>/<name>`; symlinks, hidden directories, `Library`,
`node_modules`, `target` and `Applications` are not entered, nor is a
checkout's own tree, and a main checkout is preferred over a linked worktree
of the same repository. Nothing is ever cloned. Each kept repository's
labelled issues are then worked like a `[[target]]`'s; one a `[[target]]`
also names keeps that entry.

What decides that a repository is worked, under `*`: you can push to it, and
you cloned it under a heal root. Its issues still need the opt-in label and an
author with triage-or-better permission on it (the provenance gate). In an
organization where every member can label issues, that is every member, so
list the owners you trust instead of `*` where that matters. A sweep works at
most three items (`MAX_ITEMS_PER_SWEEP`) across every target, and the next one
starts just past the last target it reached, so a wide `[[org]]` cannot hold
the loop for hours or starve the repositories after the first few.
`heal.status` reports `orgs` and what the last sweep `discovered`.

**Escalation to a person.** Some work needs a person or a stronger model, and
an unattended sweep never decides that by spending money. An item carrying
`human_label` (`needs-human` by default) is skipped by the cadence, whoever
applied it. When local models fail an item twice (`UNATTENDED_ESCALATE_AFTER`),
or it hits a failure no retry changes, the cadence hands it to a person:
- it applies the label, creating it in the repository if needed;
- it assigns the `escalate_to` logins, so GitHub notifies those teammates in
  whatever organization the repository belongs to;
- it comments the reason and how to run the item with the attended
  configuration;
- it raises a CarHost approval card, `heal:<owner>/<repo>#<number>`;
- it tells each `notify` address over Lattice: one of your other devices, or a
  node a consented connection shares, so a teammate's CAR hears about it. The
  sender is the reserved node `car-self-heal` (no agent may take that id),
  acting for the operator in the work context of the item's repository: the
  operator's context for the organization its checkout declares in
  `.car/config.toml`, or personal when it declares none. An organization the
  login does not hold, or an unreadable declaration, sends nothing. The message
  passes every stage `agents.message` applies, with that context: the channel
  guard, the context rule (an organization's notice reaches only that
  organization's nodes, on devices in its roster or over a connection it
  verified), policy and the audit. A first message to another owner's CAR is
  held for the operator like any other. `notify` takes only `<node>@<car>`
  addresses; a reply to `car-self-heal@<car>` reaches no agent.

An item is handed over once: the claim ledger records it, so a label edit that
failed does not make every later failure escalate again. Its escalating failure
posts one comment, the escalation. A change that passed review but could not
be delivered (a refusal no retry changes) is escalated at once, without a card:
a stronger model would hit the same refusal.

The card is a high-risk method gate row (`ws.method:heal.run`), so a supervised
agent cannot approve the frontier run it starts; a person resolves it in
CarHost or any host session. Approving it runs that item with the attended
configuration on the next cadence tick, charged to the operator; the card is
dismissed once that run has happened, so a tick that finds the loop busy keeps
it for the next one. Denying it dismisses the card and leaves the item labelled
for a person. Cards live in the daemon's memory, so a restart, or a pending card
older than a day, loses one; `car heal run --item owner/repo#N` (`heal.run`
with `item`) works at any time and is what the escalation comment names first.
Closing or relabelling the issue is the person's call; the loop never removes
the label.

The cadence runs `[unattended]`, local models only (see `unattended` under
`heal.status` below); with the section omitted it picks from installed local
models. `review_models`, `coder_model` and `engine` at the top level are for a
sweep a person starts with `heal.run`. That panel is required for such a run and
must resolve to seats served by at least two attributable model vendors. The
gate refuses a panel of zero, and a one-vendor panel is correlated by
construction, so either configuration declines to start before spending a coder
session and says which models resolved to which vendors.

#### `heal.status`
- **Params**: `null`
- **Returns**: `{ config_path, enabled, cadence_secs, disabled_reason?,
  targets[], rejected[{ repo, reason }], review_models[],
  panel[{ model, vendor? }], panel_warning?, coder_pin?{ model, source },
  run_refusal?, engine, spend_meter, unattended{ coder_model?, review_models[],
  source?, refusal? }, running_unattended?{ coder_model?, review_models[],
  source? }, orgs[], discovered[{ repo, checkout?, reason? }] }`.
- `orgs` lists the configured `[[org]]` owners. `discovered` is what the most
  recent sweep found under them: each repository it will work, with its
  checkout, plus any reason an owner produced nothing (`roots` empty, no
  checkout under it, or an owner `gh` could not list). It comes from that
  sweep, so `heal.status` itself makes no network call.
- `unattended` is what a sweep nobody started, the cadence, runs on. Unattended
  sweeps use **local models only**, so the loop never spends money with no one
  watching: the engine is `native` (an outside coding CLI bills its own
  provider outside CAR's meter), the coder and every panel seat are pinned to
  installed local models, and the sweep runs under a local-only spend scope, so
  a remote call refuses at admission (`remote_in_local_only_scope`) whatever
  chose it. Models come from `[unattended]` in `heal.toml` (`source:
  "heal_toml"`) or are picked from the installed local catalog (`source:
  "auto"`). Only downloaded text models with at least 32,768 tokens of context
  are considered; an image, video or speech model is never seated, and neither
  is one that cannot run here: a model served by vLLM-MLX while that runtime is
  missing or outdated, or one larger than the Local Models RAM allocation.
  Candidates rank by CAR's own measured quality (`car-judged`), then size, so a
  bigger model that measured worse does not win. The best-ranked one that
  writes code, calls tools and generates at least 50 tokens per second (when
  its speed is measured) codes, and the best model of each other vendor
  reviews, up to three seats, never a model already named for the panel; a
  reviewer from the coder's own vendor is seated only after every other vendor
  has one. Named models meet the same bar: a named coder must write code and
  call tools, a named seat must be a text model with that context, and a named
  model that is not ready or does not fit the allocation refuses the cadence
  with that reason. A local seat's independence is its lineage, who trained it, so
  `qwen3`, `qwen3.5` and `qwen3-vl` are one seat and two vendors satisfy the
  panel's two-key diversity floor; a model whose vendor CAR cannot name counts
  for nothing. Under the same scope the verification auditor (`auditor_model =
  "auto"`) picks a local text model, with the same context floor, from a vendor
  other than the coder's; a remote `verifier_model`, or an `auditor_model` other
  than `"auto"` that is not local, in `~/.car/coder.toml` refuses the cadence,
  because every item would otherwise end refused at verification.
  `refusal` names what is missing (no local coder, fewer than two vendors, a
  named model that is not local or not downloaded) and the cadence does not
  start. The self-heal detector hands detections to this loop only while the
  unattended cadence is running, and stops when the cadence task ends. `review_models`, `coder_model` and `engine` at the top level
  apply to a sweep a person starts with `heal.run`, which may use frontier
  models.
- `unattended` is resolved from `heal.toml` as it is now. A running cadence
  keeps the models it started with until the daemon restarts; while it runs,
  `running_unattended` names those, so an edit to `[unattended]` shows as the
  next models without claiming the running cadence uses them. Absent while no
  cadence runs.
- `spend_meter` is the spend meter's health, the same object `spend.status`
  and `spend.costs` report: `{ healthy, last_error, clock, zone, zone_source }`,
  or `{ healthy: true, last_error: null, note }` when no supervisor is
  installed. `healthy` is `false` with the error in `last_error` when the
  meter could not write its ledger; while it stays so, a capped agent's model
  calls made through CAR are refused `-32018` `spend_unrecordable`, and an
  uncapped principal's go through uncounted, so this is where the cause is
  read (see [spend](spend.md#spend)). `clock` is `synchronized |
  held_until_synchronized | adopted_unsynchronized`; `zone_source` is `TZ |
  system | utc_fallback`.
- `heal.toml` is re-read on every call and on every sweep, so an edit takes
  effect without a daemon restart and `heal.status` always reports what the next
  sweep will use. `config_path` names the file it was read from — an operator
  editing the wrong one otherwise learns nothing from a status that reports
  exactly what they did not change.
- `disabled_reason` names "no usable targets or organizations are configured", and also carries a
  boot-time ASSEMBLY failure — an unknown model name, fewer than two attributable
  serving vendors, or a `coder_model` that is also a review seat. Those are
  validated when the loop is assembled rather than when the config is parsed,
  so without this a rejected configuration would
  leave `enabled: true` with no reason and a loop that never runs, which is the
  state this field exists to make impossible. `rejected` carries
  targets that were named but unusable (a malformed `owner/name`, both `path`
  and `project` set) — a typo that silently dropped a target would present as a
  loop that never does anything, which is the hardest failure to notice in a
  subsystem whose normal state is idle.
- `panel` is `review_models` after the deduplication the live panel applies,
  with each seat resolved to the organization that actually serves it. That is
  not the model's `provider`, which names the AGGREGATOR — everything routed
  through OpenRouter reports `openrouter` and everything through the Parslee
  gateway reports `parslee` — so three vendors behind one gateway would look
  like one, and one vendor reached two ways like two. A `vendor` of `null` means
  unknowable, not absent: a Parslee capability endpoint (`parslee/reasoning`) is
  routed by the gateway to whatever it prefers, so no vendor can honestly be
  attributed. Never count `null` as a distinct vendor.
- Assembly REFUSES a panel with fewer than two attributable serving vendors.
  The error names every configured model and its resolved vendor; an
  unattributable seat is `unresolved` and does not invent a second provider.
  Refusing rather than silently dropping seats matters because a smaller panel
  has a different majority threshold and is a configuration the operator must
  choose explicitly.
- `panel_warning` covers the stronger condition that remains after that floor:
  a panel can span two vendors while one vendor still holds the voting majority,
  or include an unattributable seat alongside two attributable providers. The
  warning reaches the pull request because that accepted panel is not fully
  demonstrably independent even though it meets the minimum construction rule.
- Every model that AUTHORED part of a change is recorded on the session
  (`authored_by`, also on the `coder.list` row) and checked against the panel
  when the gate runs. That is the case the assembly-time check below cannot
  reach: it checks a resolved pin, but adaptive routing can choose a different
  model on each request. A set rather than one name, because a turn terminal is
  journaled per iteration and an unpinned session may route each iteration
  differently; a reviewer judges the accumulated diff, not the last iteration.
  Models that served turns INSIDE an iteration another model finished are
  counted too (car#1333) — the terminal names only whoever reached it, so a
  model could otherwise write most of a change and still sit on the panel
  judging it.

  When neither pin source below supplies a coder model, self-heal also prevents
  the collision before inference: every turn carries the canonical review-seat
  names in `IntentHint.exclude_models` with `strict_exclusions: true`. If no
  independent model remains, generation stops before provider dispatch with
  `failure_kind: "configuration"`; the cadence releases the item claim without
  item backoff or a public failure comment, because the remedy is in
  `heal.toml`, not the backlog item. The durable `authored_by` check remains the
  delivery backstop for routing changes and already-running cadence state.

  Both sides are canonicalized to registry ids before comparison. An unpinned
  turn reports the model's display NAME while a seat is configured however the
  operator spelled it, and `review_models` accepts an id or a name — so for
  every model whose id and name differ these are two spellings of one model,
  and comparing the strings would let it sit on both sides of the gate.

  **Native-rung enforcement.** `authored_by` is empty for a foreman or external
  session, whose CLI backbone CAR never resolved — that is most runs, since
  `foreman` is the default engine, and it is permitted rather than refused: read
  it as "CAR's own loop did not write this", not "nobody did". An empty set on a
  session that RAN native IS refused — the engine the session RESOLVED to, not
  the one `heal.toml` asked for. `engine = "auto"` is a legal setting and
  resolves to native for any simple task and on any machine with no CLI
  installed, so comparing the request let exactly this case through (car#1357), because every exit from that loop
  journals a terminal — including the two that return early, an auth lapse and a
  dead backbone after the edit landed (car#1333) — so an empty set means the
  attribution was lost rather than that there was none to take.
- A pinned coder that resolves to the same model as a review seat is REFUSED at
  assembly: a model cannot review its own output, and counting it as a seat
  reports an independence the gate does not have. Compared by resolved model
  id, so two spellings of one model are recognized as one. `heal.toml`'s
  `coder_model` is validated against the catalog alongside `review_models`.

  **Two pin sources.** `coder.start` resolves a session's model as the request
  pin, then `~/.car/coder.toml`'s `[coder] model` — and heal passes `heal.toml`'s
  `coder_model` as the request pin. So an unset `coder_model` does NOT mean the
  coder is unpinned; it means the coder runs on whatever `coder.toml` says, and
  that value is checked against the panel too, with the error naming which file
  the pin came from. Whichever source wins is also what heal pins the session
  to, so the value checked is the value that runs. Only when NEITHER file pins
  is the coder chosen by the router; in that case every review seat is a strict
  routing exclusion, with the `authored_by` gate above retained as a delivery
  backstop.

  A `coder.toml` pin the daemon's catalog does not know is NOT refused, unlike
  an unknown `coder_model`. That file is shared with `coder.start` and
  `car code-task`, neither of which validates it, and on the `external` rung
  the value is forwarded verbatim to a CLI's own namespace (`codex -m`,
  `claude --model`) — so a name `car models list` has never heard of can be
  exactly right for the rung that runs, and refusing would take the loop
  offline over a working configuration.

  **When it fires.** `heal.run` assembles per call, so it re-reads both files
  and re-runs the check; a refusal there lands in `run_refusal`, so
  `heal.status` cannot describe a configuration `heal.run` will not run on.
  The cadence assembles ONCE at boot — an assembly
  error there is reported through `disabled_reason` and the loop does not start
  until the daemon restarts. Editing `coder.toml` after boot therefore does not
  re-run this check for the cadence; the runtime `authored_by` gate is what
  covers that window, and `coder_pin` makes the staleness visible by showing
  what the next `heal.run` would use.
- `coder_pin` is the model the coder will run on and which file pinned it —
  `source` names the setting (`` `coder_model` in `heal.toml` `` or
  `` `[coder] model` in `coder.toml` ``), so an operator goes straight to the
  line in force rather than opening both files and re-deriving the precedence
  by hand. That re-derivation is not hypothetical: doing it from one source
  only is what let a coder sit on its own review panel (car#1360).

  **Absent means unpinned, which is a third state.** Neither file names a
  model, so adaptive routing picks per request while strictly excluding every
  review seat. Nothing before the run can say which remaining model it will
  pick. That is different from "pinned to something the panel rejects", and
  the two need different fixes.

  `source` is a MACHINE value — `heal_toml` or `coder_toml` — not prose; `car
  heal status` renders the operator-facing wording. The model is reported
  verbatim rather than canonicalized, for the same reason an unknown
  `coder.toml` pin is not refused (below): on the `external` rung it is
  forwarded to a third-party CLI's own namespace, so what the file says is the
  useful answer.

  **What a RUNNING cadence uses may differ.** `coder.toml` is consulted only
  when `heal.toml` does not pin, resolved through the one helper the sweep's
  own check calls — so this cannot disagree with what the next `heal.run`
  assembles. It is not a claim about a cadence already running: that assembles
  once at boot and bakes the pin in, the same freeze this document notes for
  the panel. A session started by `coder.start` can also differ, since it
  re-reads `coder.toml` itself at start. Read `coder_pin` as what the next
  `heal.run` would use.
- `run_refusal` is why the most recent manual `heal.run` refused to ASSEMBLE,
  cleared as soon as one gets past assembly. Deliberately not folded into
  `disabled_reason`: a cadence that came up cleanly at boot keeps sweeping on
  its boot-time setup, so a manual refusal is a warning that the config as it
  stands now would not assemble — reporting it as "disabled" would describe a
  dead loop that is in fact running.
- `panel_warning` reports vendor CAPTURE of the majority beyond the enforced
  two-vendor floor: approval needs a strict majority, so two OpenAI seats decide
  a three-seat panel whatever the third says. That framing also catches one model
  seated twice under different ids — a direct id, an OpenRouter id and a Parslee
  alias can all be the same model — without having to prove they are the same
  model, which is not reliably decidable.
- The resolved panel and this caveat are also written into the PULL REQUEST
  BODY, beside the gate verdict. "approved by 3/3 reviewers" is the number a
  human uses to decide how closely to read the change, and a correction that
  lives only here corrects the claim everywhere except where it is made.
- Answerable whether or not the loop is enabled.
- FFI: `healStatus()` (NAPI) / `heal_status()` (PyO3), returning JSON.

#### `heal.run`
- **Params**: `null` or `{ chat_session_id?: string, item?: string }`
- `item` (`owner/repo#number`) runs that one item with the attended
  configuration, the top-level `review_models`/`coder_model`/`engine`, which may
  be frontier models. Its backoff, exhaustion and human label are set aside,
  because a person asked for it; the opt-in label, provenance and coverage
  rules still apply, and the repository must be a configured target. Without
  `item` the sweep covers every target, at most one item each.
- **Who may call it (car#2445):** a sweep's coder sessions run the configured
  engine, `foreman` (an outside coding CLI) by default, so a connection bound
  to a supervised agent needs the host chat to start a sweep, whatever engine
  is configured: it passes the `session_id` of the `agents.chat` turn a host
  started with that agent as `chat_session_id`, the rule `foreman.run` uses.
  The turn is checked once, when the call arrives. Hosts and connections not
  bound to an agent send `null` as before.
- **Returns**: `{ outcomes: [[repo, outcome]], skipped_overlap }`, where each
  `outcome` is tagged. An opened result is
  `{"outcome":"opened", repo, number, pr_url, gate, ci, delivery}`. `ci` is
  `{head_sha, state, checks:[{name,state}], observation_error?}`; every state is `"green"`,
  `"pending"`, or `"red"`, and it combines GitHub check runs with legacy
  commit-status contexts for that exact delivered SHA. An empty rollup is
  pending rather than green. A failed CI lookup preserves the opened result,
  with pending state, no checks, and an `observation_error` diagnostic; it does
  not retry publication or release its held claim. `delivery` is the matching plain summary, such as
  `delivered with green checks and ready for review at <sha>` or
  `delivered red on windows at <sha>`. The other variants remain
  `{"outcome":"rejected", repo, number, gate}`, `{"outcome":"idle", skipped[]}`,
  or `{"outcome":"failed", detail}`.
- One sweep now instead of waiting for the cadence: **at most one item per
  configured target**, so a busy repository cannot starve the entries after it.
- `skipped_overlap` is `true` when a sweep was already running and this one
  stood down. Ticks are expected to collide — the claim TTL is 90 minutes and
  the cadence is shorter — and queueing them would only do the same work twice.
- This can run a real coder session and open a real pull request. After
  reconciliation, the host reads CI for the delivered head and includes it in
  the report; a head race is refused rather than reporting another commit's
  checks. It goes through the same service the cadence uses, so it shares the
  single-sweep lock and the claim ledger. It does not merge the pull request.
- Errors rather than running when the loop is disabled or cannot be assembled:
  no review panel, fewer than two attributable serving vendors, a coder that is
  also a review seat, an unparseable engine name, or a `review_models` entry that
  names no model this daemon knows. The error for insufficient diversity names
  the models and providers. An unknown id is refused rather than dropped — a
  panel silently shrunk from three seats to two lowers the approval threshold
  without saying so.
- Exempt from the handler's request deadline, and the sweep runs as its own
  task. A sweep that was cut in half would leave a detached coder session
  editing the repository with `coder.cancel` unable to reach it, so the sweep
  outlives the request: the caller may miss the answer, the daemon never loses
  the work.
- The claim for an item reaches disk **before** its coder session starts, so a
  daemon that dies mid-session does not re-pick work that is already in flight.
- FFI: `healRun(chatSessionId?)` (NAPI) / `heal_run(*, chat_session_id=None)` (PyO3), returning JSON.
- `CAR_HEAL_INTERVAL_SECS` changes the cadence only (900 seconds by default).
  The first tick is skipped on boot, so a daemon restart does not start a coder
  session before the operator has seen it come up.

#### `selfheal.status`
- **Params**: `null`
- **Returns**: `{ cadence_secs, auto_fix_enabled, max_concurrent, max_per_day,
  max_rounds_per_key, auto_fix_refusal_reason?, notification_refusal_reason?,
  config_warnings?, last_tick_at, route,
  source_checkout?, refusal_reason?, detectors, detection_count, warning_count,
  critical_count, dismissed_count, filing_mode }`.
- `route` is `"local"` only when the tick validates a filesystem candidate as
  the CAR source checkout; `source_checkout` then gives the canonical path.
  Otherwise it fails closed to `"ledger-only"` and `refusal_reason` explains
  why, including the actual origin remote when one was refused. `"feedback"`
  is reserved for the separately gated feedback sink and is never selected by
  this implementation.
- Source candidates are bounded and deterministic: `[selfheal]
  source_checkout = "/path/to/car"` in `<CAR_HOME>/config.toml` is authoritative,
  followed (only when it is absent) by running-binary ancestors and the root of
  the `.car/` project discovered from `CAR_PROJECT_DIR` or cwd. A candidate must
  contain a `.git` directory or worktree file whose config names a GitHub
  `Parslee-ai/car` origin. Detection performs file checks/reads only: no `git`
  subprocess, network, or filesystem-wide scan.
- `auto_fix_enabled` reflects `[selfheal] auto_fix` (default true) after
  fail-closed config validation. The three limits default to 1 concurrent, 3
  starts per UTC day, and 3 rounds per key and cannot be raised. A malformed or
  raised-limit config disables auto-fix and sets `auto_fix_refusal_reason`.
  A refused `[selfheal] notification_command` (an empty program or argument,
  a control character, a stored secret in an argument, or an unexpected
  field) sends no agent notification and sets `notification_refusal_reason`;
  a TOML syntax error anywhere in the file is reported as the file's, with its
  line. `config_warnings` names each key under `[selfheal]` nothing reads, such
  as a misspelling, which is otherwise ignored. `car selfheal status` and
  `car info` print both.
  `filing_mode` is `"pr-only"` after a local route is validated with auto-fix
  enabled; otherwise it is `"watch-only"`. The daemon runs one non-overlapping
  tick immediately at boot and then every 900 seconds by default.
  `CAR_SELFHEAL_INTERVAL_SECS` changes cadence only.
- The six detector IDs are `metrics_alerts.v1`, `agent_protocol_skew.v1`,
  `agent_gave_up.v1`, `agent_log_errors.v1`, `recurring_tool_failure.v1`, and
  `capability_miss.v1` (the unversioned detection `kind` values are listed
  below).
- FFI: `selfhealStatus()` (NAPI) / `selfheal_status()` (PyO3), returning JSON.

#### `selfheal.detections`
- **Params**: optional `{ kind, severity, since, offset, limit }`. `kind` is one
  of `metrics_alert` / `agent_gave_up` / `agent_log_error` /
  `agent_silently_idle` / `recurring_tool_failure` / `capability_miss` /
  `agent_protocol_skew`;
  severity is `warning` / `critical`; `since` is RFC 3339.
  Default limit is 100 and the server clamps it to 1..500.
- **Returns**: `{ detections, total, offset, limit, next_offset }`, latest first.
  Dismissed stable keys are omitted. Each detection carries its SHA-256
  `dedup_key`, evidence/provenance, observation times, affected component,
  detector/version identity, redacted summary/detail, the tick's `route`, and
  `local_issue_path` when routed locally. A `recurring_tool_failure` also has
  `eligible: boolean`. It is true only when the matching `ActionFailed` names
  `tool_source: "builtin"`, its `proposal_id` + `action_id` resolve against a
  `ProposalReceived.data.proposal` in the same journal, and serializing the
  recovered params through the self-heal redactor changes no bytes. A safe
  recovered call appears as `reconstructed_call: { tool, params }`; any
  redaction omits it rather than copying raw parameters. Local routing also
  supplies `reconstructed_call_path` for the owner-private 0600
  `<dedup-key>.call.json` sidecar beside the issue document. Durable coder state
  adds `auto_fix_attempts`, `auto_fix_exhausted`, `auto_fix_in_progress`, and
  `last_auto_fix_attempt` (round/trigger/timestamps/branch/workspace,
  `spawned`, `exit_code`, and `failure_class`). Remote deduplication adds
  `auto_fix_awaiting_review`, `auto_fix_parked`, `remote_pr_number`, and
  `remote_pr_url`; an open stable-key PR is awaiting review, while a
  closed-unmerged PR is parked and never reopened. A detection handed to the
  repair loop carries `heal_issue` (`{repo, number, url}`); see
  [Detector to repair loop](../self-healing.md#detector-to-repair-loop).
- FFI: `selfhealDetections(queryJson?)` / `selfheal_detections(query_json=None)`.

#### `selfheal.dismiss`
- **Params**: `{ dedup_key }`, the 64-character SHA-256 hex key from a
  detection.
- **Returns**: `{ dedup_key, dismissed, already_dismissed, dismissed_at }`.
- Appends a dismissal marker; it never rewrites/deletes history. Later ticks
  suppress that key. FFI: `selfhealDismiss(dedupKey)` /
  `selfheal_dismiss(dedup_key)`.

#### `selfheal.fix`
- **Params**: `{ dedup_key }`, an active eligible recurring-tool key.
- **Returns**: `{ dedup_key, round, trigger, started_at, completed_at,
  target_branch, workspace_dir, spawned, exit_code, failure_class }`.
- Starts one explicit bounded round even when unattended `auto_fix` is off.
  It requires a validated `Parslee-ai/car` checkout, a safe reconstructed
  builtin call, an available daily/key budget, and no concurrent self-heal
  operation. The daemon writes private intent/params/contract files, requires
  `git fetch origin main` to succeed, and spawns `car code-task` with PR-only
  delivery, the stable `car/selfheal/<dedup-key>` branch/worktree, isolated
  `<CAR_HOME>/selfheal/target`, a 15-minute child wall limit, a private flushed
  `code-task-round-<n>.jsonl` transcript, and the stable PR body marker. The
  detector registry, not a model, owns the three contract checks. An exited
  child whose stream has no terminal `run_end` records `failure_class` as
  `missing_run_end`.
- FFI: `selfhealFix(dedupKey)` / `selfheal_fix(dedup_key)`.

#### `selfheal.run`
- **Params**: `null`
- **Returns**: a tick summary with `route`, `source_checkout?` or
  `refusal_reason?`, evidence counts, new/changed/suppressed detection
  counts, and `observed_keys` (omitted when empty): the dedup keys this tick
  observed, dismissed keys excluded. `selfheal.detections` reports a key's
  `last_observed_at` from the newest tick listing it, so it survives a daemon
  restart. A concurrent tick fails instead of overlapping.
- Runs the same path as the cadence. It reads active session event slices since
  the prior tick, current supervised-agent state, bounded activity/stderr tails
  and activity-log metadata, and the observe-only registry, then invokes all
  six deterministic detectors. After the detector ledger commit, an enabled
  local route may start the first round for one eligible recurring-tool key.
  Later ticks never start that key's initial round again. Other detectors remain
  watch-only and CAR never executes a proposed repair or merges a PR itself.
- FFI: `selfhealRun()` / `selfheal_run()`.

All five methods share the daemon-wide private append-only ledger at
`<CAR_HOME>/selfheal/detections.jsonl`. JSONL records are tagged `detection`,
`dismissal`, `tick`, `fix_started`, `fix_attempt`, `remote_pr`, or
`heal_issue`; new ticks append only
new/changed detections plus their summary, while every accepted coder round has
one durable start and terminal exit/failure-class record. A `local` route
additionally renders one owner-private
`<CAR_HOME>/selfheal/issues/<dedup-key>.md` per active key, stamped
`Trust-Tier: trusted`, and updates its occurrence count in place. A recurring
key also gets the `<dedup-key>.call.json` eligibility sidecar described above.
Directories and files are 0700/0600 on Unix. Auto-fix creates only its isolated
`<checkout>/.worktrees/selfheal-<dedup-key>` worktree and Git refs; it never
edits the maintainer's working tree or index.

#### `events.cost_by_agent`
- **Params**: `null`, or `{ agent }` — optional; a bare agent id or a full
  spend-meter key (`agent:<id>`, `operator`, `car:<purpose>`, …). With it, the
  method reads that principal's call ledger, every model call it made through
  CAR, daemon-wide, and returns that principal's one row over it, instead of
  folding this connection's in-memory log. A host or operator session may name
  any principal; a session bound to a supervised agent, or an outside
  credential's session, only itself (another is refused `-32003`,
  `data.reason: "not_your_agent"`, and recorded). Without it, the method
  behaves exactly as before.
- **Returns**: array of `{ agent, calls, tokens_in, tokens_out, cost_usd,
  priced_calls, subscription_calls, unpriced_calls, ambiguous_reports,
  ambiguous_reported_cost_usd }` — the per-agent
  token/cost report, folded from `InferenceMetered` events by their `agent`
  field (EPIC G / G3). `cost_usd` sums only the `priced_calls` (a provider's
  figure, a list price, or a local model's $0). A subscription call adds no
  dollars, and an `unpriced_calls` call's cost is unknown, not $0, so a row
  with any is a lower bound. Calls that name no agent are their own
  `"unattributed"` row, never merged into an agent's. `ambiguous_reports`
  counts `multi.*` sub-agent self-reports the daemon could not tie to one
  run (rows marked `summary_of: "ambiguous"`, see [events](events.md)), and
  `ambiguous_reported_cost_usd` is what those runners reported: listed apart,
  never part of `calls` or `cost_usd`, whose measured rows already count the
  calls once (car#3492). Over a principal's ledger (`{ agent }`) every call
  names its payer, and a call from a connection bound to no agent is the
  `operator`'s, so the daemon-wide rows are the agents' and `operator`. The
  daemon keeps each payer's ambiguous self-reports beside its ledger (a
  separate file, never a ledger row, never counted against a cap, never
  dropped: rotated by size and read whole), so `{ agent }` reports them too,
  under the same authorization; `events.query { agent }` returns them as
  `inference_metered` rows marked `summary_of: "ambiguous"`. It reads only the calling connection's
  session log (see [events](events.md) for scope and journal retention). A
  multi-agent run reports cost per agent;
  provenance (which tool/workflow) is queryable via
  `events.query {data_matches:{agent}}`.
- A `multi.*` run writes one row per sub-agent, and in the daemon that row
  is a **summary** of the sub-agent's run: `agent` is the paying principal's
  meter key (`agent:<id>`, `operator`), `sub_agent` the sub-agent's name,
  `cause` the request's, and `reported_cost_usd` the figure the runner
  reported. The sub-agent's model calls are the client's own `infer`
  requests, each recorded on its own `infer` row with its own `call_id`, so
  the summary row carries no `call_id` or `cost_source` of its own and adds no
  cost on top of those rows (see [events](events.md) for the exact fields and
  the fold rule). Rows written by earlier versions (`agent` = the sub-agent's
  name, `cost_usd` self-reported) fold exactly as they always did. The
  daemon's own `infer`, `infer_stream` and assistant-loop records carry
  `agent` as the paying principal's meter key (see `events.query`), so an
  `infer` from an agent-bound session is reported under `agent:<id>` and one
  from the daemon token under `operator`, never `unknown`.

#### `replan.set_config`
- **Params**: `{ max_replans, delay_ms, verify_before_execute, replan_on_rejected }` flat shape
- **Returns**: `null`
- Configures the per-session replan loop. `replan_on_rejected` (default `false`): when `true`, validator/policy/capability rejections (`ActionStatus::Rejected`) — not just runtime failures — also trigger rollback + replan, feeding the offending tool/error/parameters back to the replan callback. Conservative default preserves abort-only-on-failure behavior for all existing consumers.


{% endraw %}
