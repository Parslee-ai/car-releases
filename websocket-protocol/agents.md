{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### agents

**Lifecycle authorization (car#1295).** A connection that authenticated as an
agent — `session.auth { agent_id, token }` — may `agents.start`, `stop`, or
`restart` only that same agent. A host-management connection may control any
agent. When a host token is configured, an unbound daemon-token connection is
not host authority and is refused; this closes the second-connection bypass
where a supervised child reused `CAR_AUTH_TOKEN` without binding `agent_id`.
On an auth-disabled/dev daemon with no host token, an unbound developer client
continues to act as the authority.

`agents.upsert`, `agents.install`, and `agents.remove` require host-management
authority. They remain unavailable to a bound supervised agent even in the
auth-disabled degraded mode: upsert/install define what the supervisor executes,
and removal mutates the host-owned process inventory.

`agents.wait` and `agents.tail_log` retain the narrower bound-identity rule: an
agent may read only itself, while an unbound operator may read any id. The rule
is listed per method rather than asserted for the namespace, because not every
`agent_id` here is a subject: `agents.chat` and `agents.chat.*` take the agent as
the RECIPIENT of a turn and are cross-agent by design. `agents.list` and
`agents.health` enumerate and take no id at all.

`declagents.remove` and `declagents.set_enabled` are also refused to a bound
supervised-agent session. A declarative agent runs in-daemon and has no
per-agent token, so there is no bound "itself" exception: only host-management
authority (or an unbound developer on an auth-disabled daemon) may remove or
disable one.


> **Observe-only mode** (Parslee-ai/car-releases#44). The supervisor
> takes an exclusive OS-level lock on `<manifest>.lock` so two
> car-server processes can't supervise the same manifest and
> double-spawn every agent against shared external state. A
> secondary daemon that hits the lock at boot logs a clear warning,
> installs an *observer* marker, and continues running with the
> agents.* namespace partially degraded:
>
> - `agents.list`, `agents.health` keep working — they fall back to
>   reading the manifest directly (runtime fields like `pid`,
>   `status`, `restart_count` default; only the primary daemon
>   sees live state).
> - Every other agents.* method returns an error containing
>   "observe-only" plus the manifest path the lock-holder owns,
>   signalling that the caller should route the request to the
>   primary daemon (or give this daemon its own manifest via
>   `--agents-manifest` / `CAR_AGENTS_MANIFEST`).
>
> Single-daemon deployments are unaffected.

#### `agents.register_basics`
- **Params**: `null`
- **Returns**: `null`
- Registers CAR's built-in agent utility tools on this client's session. Mirrors `Runtime::register_agent_basics`.

#### `agents.list`
- **Params**: `{}`
- **Returns**: `[ ManagedAgent ]` — every supervised entry in `~/.car/agents.json` plus its current runtime status `{spec, method_allowlist?, status, pid?, last_exit_code?, restart_count, started_at?, blocked_by_pid?, attached, tools?, session_id?, manifest_path, log_path, stderr_log_path}`. `status` is one of `stopped | starting | running | backoff | errored`. `method_allowlist` is absent for an unrestricted legacy token, present (including `[]`) for a scoped token, and is shown by `car inspect`. `tools`, when present, is the attached flagship assistant's sorted current model-visible tool names, obtained through a bounded reverse query; it is omitted for detached, older, and other supervised agents rather than inferred from broad capabilities. `manifest_path` is the daemon-resolved per-agent `agents/<id>/manifest.toml`; `log_path` and `stderr_log_path` are the captured stdout/stderr files. Declarative rows remain tagged `kind:"declarative"` and carry their manifest tool allowlist but do not carry supervised paths.
- `blocked_by_pid` (car#732) is present only when the agent is in `backoff` **because a live process this supervisor does not own is already running as it** — typically one that outlived a previous `car-server` and still holds the agent's port. Without it, `backoff` + `pid: null` + a healthy process on the port is indistinguishable from a broken agent, and the cause is only visible via `lsof`. Stop the named pid and restart, or leave it: supervision resumes automatically once it exits.
- `attached` is `true` once the supervised child has called `session.auth { agent_id }` and bound a WS connection (#169). `session_id` carries the bound `client_id` while attached. The lifecycle status alone can't distinguish "alive but never attached" from "alive and attached".
- Driven by `car_registry::supervisor::Supervisor`. Closes [Parslee-ai/car-releases#27].

#### `agents.upsert`
- **Authorization**: host-management authority.
- **Params**: `AgentSpec` — `{ id, name, command, args?, cwd?, env?, restart?, max_restarts?, backoff_secs?, auto_start?, interpreter?, method_allowlist?: string[] }`. `restart` is `never | on_failure | always`. `id` must be filename-safe (alphanumeric + `-_.`).
- **Returns**: the resulting `ManagedAgent`.
- Persists the manifest; the agent is NOT auto-started — call `agents.start` (or rely on `auto_start: true` for the next car-server boot).
- **`method_allowlist`** scopes the per-agent token to a subset of daemon methods whose generated capability role is `agent`, `operator`, or `owner`. Unknown and `host`-role names are rejected at upsert/install. The list narrows existing authorization rather than granting the listed role. Omit it for backward-compatible unrestricted behavior; pass `[]` to deny every application method. When an upsert omits both the token and the allowlist for an existing scoped agent, both are retained together so an older client cannot silently widen the token. Removing the scope requires supplying/rotating the token explicitly.
- **`interpreter` sugar (#171)**: instead of hand-coding `/opt/homebrew/bin/node` (or whatever the current PATH resolves to), pass `interpreter: "node" | "python" | "deno" | ...` and the supervisor resolves the bare program name against `$PATH` *once* at upsert and writes the absolute path into `command`. Resolution then freezes — subsequent PATH changes do not silently rewire which binary the spec points to. The strict no-PATH-lookup rule at upsert time still holds: an interpreter that resolves into `/tmp` or fails the executable-bit check is rejected.

#### `agents.install`
- **Authorization**: host-management authority.
- **Params**: `AgentManifest` — the nested TOML shape from
  `docs/proposals/contributed-agents.md`, JSON-encoded for the
  wire: `{agent: {id, name, namespace?, version?, …}, publisher?,
  runtime?, lifecycle?, transport: {kind, …}, capabilities?}`.
  `transport.kind` is `pure_data` or `external_process`; the
  per-kind sub-table carries the rest. External-process transports accept the
  same optional `method_allowlist: string[]` scope as `agents.upsert`.
- **Returns**: `{report: {missingOptional: [{namespace, feature}]}, agent: ManagedAgent | null}`.
- Runs install-time validation against the daemon's default host
  capability advertisement (Parslee-ai/car#182 phase 3):
  - `runtime.car_min_version` (if present) must be satisfied by
    the daemon's own semver. Accepts a bare semver (interpreted
    as `>=`) or a cargo-style requirement (`">=0.8, <0.9"`).
  - Every `capabilities.required[namespace][feature]` must be
    advertised by the host. Fail-closed on any miss.
  - `capabilities.optional` is reported back as `missingOptional`
    when the host can't satisfy it — informational, not
    blocking.
- For `external_process` manifests with a `command`, the
  supervisor adopts the agent (mints a token if absent) and
  returns it. For `pure_data` and `health_url`-only manifests,
  the manifest is written to `~/.car/agents/<id>/manifest.toml`
  but `agent` comes back `null` (the supervisor only spawns
  command-shaped externals in phase 3).
- Signature verification: when the manifest carries a
  `[publisher]` block, the signature is verified via
  `car_bundle::verify_signature`. Phase 3 is still
  warn-but-not-reject for failed signatures (logs a warning,
  still installs); phase 4+ may tighten.

#### `agents.health`
- **Params**: `{}`
- **Returns**: `[ { id, command, ok, reason? } ]` — one entry per managed agent. `ok: true` means `validate_command(command)` still accepts the path; `ok: false` populates `reason` with the validator's error (file missing, no execute bit, lives under a scratch dir, etc.).
- Use after a system upgrade to surface broken specs before `agents.start` does. Pairs with the `interpreter` sugar — when `ok: false` for an interpreter-resolved entry, the host can re-upsert with the same interpreter name to pick up the new path.

#### `agents.remove`
- **Authorization**: host-management authority.
- **Params**: `{ id: string }`
- **Returns**: `{ removed: bool }`
- Stops the running child first if it's up. Idempotent.

#### `agents.start`
- **Authorization**: the same bound agent id or host-management authority.
- **Params**: `{ id: string }`
- **Returns**: `ManagedAgent`
- Spawns the child if it isn't running. No-op when already `running` or `starting`. Resets `restart_count`.

#### `agents.stop`
- **Authorization**: the same bound agent id or host-management authority.
- **Params**: `{ id: string, signal?: "term" | "kill" }`
- **Returns**: `ManagedAgent`
- `term` (default) sends SIGTERM and waits the supervisor's grace window before escalating to SIGKILL; `kill` skips the grace.

#### `agents.restart`
- **Authorization**: the same bound agent id or host-management authority.
- **Params**: `{ id: string }
- **Returns**: `ManagedAgent`

#### `agents.wait`
- **Params**: `{ id: string, targets?: AgentStatus[] = ["running"], timeout_secs?: number = 30, poll_ms?: number = 200 }`
- **Returns**: the matching `ManagedAgent` once its `status` is one of `targets`; an error if the timeout elapses first (`WaitTimeout`) or the agent isn't in the manifest (`NotFound`).
- Blocks until a supervised agent reaches a target state — the persistent-agent analogue of "wait until ready / wait until done". Pass `["running"]` to wait for an agent to come up, or `["stopped","errored"]` to wait for a one-shot child to finish. It only observes the supervisor's status transitions; it never starts or stops the agent. `poll_ms` is clamped to ≥10ms. FFI: `agentsWait` (NAPI) / `agents_wait` (PyO3).

#### `agents.tail_log`
- **Params**: `{ id: string, n?: number, stream?: "combined" | "stdout" | "stderr", offset?: number }`.
  - `n` — lines **per included stream** (default 100; `0` ⇒ whole file, still bounded by the tail byte ceiling below). Both `n` and the legacy alias `lines` are accepted (the CarHost UI historically sent `lines`).
  - `stream` — which captured stream(s) to return (default `combined`). Each stream is tailed **independently** to its own `n`-line budget, so a long stale `stderr` can no longer bury a healthy agent's live `stdout` (Parslee-ai/car#273).
  - `offset` — page back: skip this many lines from the end of each stream before taking the window (`offset = n` ⇒ previous page).
- **Returns**: `{ lines: [string], stdout: [string], stderr: [string], stdout_total: number, stderr_total: number, stdout_path: string, stderr_path: string, more: boolean }`.
  - `lines` — legacy combined view: stdout lines then stderr lines (each independently budgeted). Kept for back-compat.
  - `stdout` / `stderr` — the per-stream windows (empty when `stream` excluded that side), for separate-pane / stream-select viewers.
  - `stdout_total` / `stderr_total` — line count in the scanned tail before windowing (for "showing N of M" / scrollbar sizing). Exact for any log within the tail byte ceiling; for a multi-GB log it counts only the lines in the last ceiling bytes, and `more` is `true`.
  - `stdout_path` / `stderr_path` — absolute file paths (for "reveal in Finder" / opening the full log).
  - `more` — `true` when paging further back (larger `offset`) would surface older lines on at least one included stream, **or** when the tail read was truncated at the byte ceiling (older lines provably exist on disk).
- **Note**: the capture format is raw child output with no per-line timestamps, so a true cross-stream timestamp interleave isn't available; combined ordering is stdout-then-stderr with each side independently budgeted.
- **Bounded read**: agent logs are append-only and never rotated, so each stream is read via a **bounded backward seek** (at most an 8 MiB tail), not a whole-file slurp — keeping repeated polling (e.g. a live-follow viewer re-fetching every 2s) cheap regardless of how large the on-disk log has grown. A log larger than the ceiling is truncated to its last 8 MiB; the partial leading line is dropped and `more` is forced `true`. Combined-view paging (`stream: "combined"` + `offset`) is **not** order-preserving — a combined page is a stdout-block followed by a stderr-block, so prepending an older combined page scrambles that ordering; page within a single stream (`stdout`/`stderr`) to scroll back, or open the file directly.

#### `agents.chat`
- **Params**: `{ agent_id: string, prompt: string, session_id?: string, conversation_id?: string, stream?: boolean = true, voice_input?: boolean = false, model?: string, attachments?: ImageContentBlock[], goal?: { check: string, max_iterations?: number } }`.
  - `agent_id` — the flagship assistant's canonical id is `parslee-core`; `car-assistant` (its pre-car#1107 id, still hardcoded by macOS) is accepted as a server-side alias. If the caller sends one spelling and the assistant is attached under the other, the daemon transparently resolves to whichever is actually attached — this only applies to the flagship assistant, not other supervised or declarative agents.
  - `session_id` — host-generated id threaded through every event so one CarHost window with multiple in-flight chats can demux. Auto-generated when omitted.
  - `conversation_id` — optional stable id of the host's chat, 1–128 characters of `[A-Za-z0-9._-]` (from a host-management session anything else is refused; from any other caller the value is ignored). An approval for a web search answered **Allow for this conversation** is remembered under it, so it keeps applying when the host starts a fresh `session_id` for the same chat (after an error, a regenerate, a goal change) and across reconnects. Omitted, the session is its own conversation (scoped `session:<session_id>`). Honored only from a host-management session. The person's saved answers apply only to turns the person's host started: a turn another agent starts (or an A2A caller) consults no grant at all — not conversation, agent or all-agents — and its approvals offer plain approve/deny. A `session_id` whose turn another client still holds, or that has a running turn in a different conversation, is refused. The same client sending another turn in the same conversation while its earlier one is still routed replaces that route, which is ended (see `agents.chat.approve`). The daemon forwards the resolved value to the agent's `agent.chat` handler as `conversation_id`.
  - `model` — optional explicit CAR model ID for this turn. A non-empty value is a strict selection and reaches inference unchanged; CAR reports that model's failure rather than silently substituting another model. Omit it (or pass a blank string) to preserve the supervised agent's configured model and adaptive fallback policy.
  - `attachments` — optional array of image `ContentBlock`s the user attached: `{ "type": "image_base64", "data": "<b64>", "media_type": "image/png" }` or `{ "type": "image_url", "url": "https://…", "detail": "auto" }`. The daemon validates each entry's shape and content — `image_base64` must carry a string `data` and a `media_type` in `{image/png, image/jpeg, image/gif, image/webp}`; `image_url` must be http(s) — rejecting a malformed entry with a JSON-RPC error, then forwards the array verbatim to the agent's reverse-called `agent.chat` handler, which passes it to inference as `imagesJson`. Omitted when the turn has no images, so agents that don't read it see the legacy request shape. The daemon does **not** check provider vision capability; an agent or provider that can't accept images surfaces that error downstream.
  - `goal` — optional deterministic completion contract for this chat turn. `check` is a shell command the agent runtime runs after each assistant iteration; exit 0 means the condition is met. `max_iterations` defaults to 8 and is clamped to 1–50. Goal-driven agents stream `goal_evaluated { iteration, met, grounded, reason }` after each verifier pass and emit terminal `done` once the deterministic check passes (`met` with `grounded: true`). The flagship assistant still cross-checks conservative final-summary operational claims such as "tests passed" against same-run tool receipts, but once the deterministic check has itself passed an unmatched claim only **annotates the reply text** (a `[claim check]` note appended to the `done` message) — it no longer re-opens a deterministically-verified iteration on prose wording, and `grounded` stays `true`. A summary claim can still keep a completion ungrounded when the met verdict rested on a model judge rather than deterministic ground truth (it fails closed and keeps iterating). If the governor halts on a condition that actually ran and was not met (turn/cost/wall-clock budget, no-progress, cancel), the terminal event is `error`, naming the halt reason. If the check itself never got to run within its own bound — a stuck approval wait, a wedged subprocess — the loop fails open instead of hanging or discarding a working reply: it halts on the *first* such stall (it does not burn the rest of `max_iterations` retrying a check that structurally cannot be evaluated), and the terminal event is still `done`, with the reply text carrying a `[goal check] not verified — …` note (mirroring the `[claim check]` annotation convention above), `finish_reason` set to a short "unevaluated" string, and `goal_unevaluated: true` — a machine-readable marker `goal.status`'s persistence layer reads to record `status: "unevaluated"` rather than `"met"`, so a client polling `chatGoal.status`/`goal.status` cannot misread an unchecked condition as a verified pass. Currently mutually exclusive with `attachments`.
  - If no inline `goal` is passed, the daemon looks for a standing goal stored for the same `session_id` via `goal.set` and forwards that contract to the agent.
- **Returns**: an ack `{ accepted: true, session_id: string }`. The reply does **not** carry the answer — for attached supervised agents, the daemon reverse-calls the agent's `agent.chat` handler and fans the streamed reply back as `agents.chat.event` notifications (`kind: "inference_started" | "inference_retry" | "model_served" | "token" | "tool_call" | "tool_result" | "todos" | "approval_pending" | "approval_resolved" | "goal_evaluated" | "receipt_report" | "done" | "error" | "auth_required"`) keyed by `session_id`. `inference_started { model, attempt, turn }` is emitted before each model call is awaited; `inference_retry { model, attempt, reason, backoff_ms }` is emitted before a transient remote retry's backoff, with a generic reason that never copies the provider body. `model_served` precedes each completed turn's content and carries `{ model_id, local_last_resort }`, where the boolean is true only when the appended on-device last resort actually served. Each requested tool emits `tool_call { call_id, sequence, tool, params }` and exactly one matching `tool_result { call_id, sequence, tool, ok, excerpt, evidence }` before later assistant text; `call_id` is generated by CAR as `turn_<n>_call_<sequence>` because provider ids may repeat, and `sequence` is the call's one-based position in that turn. `n` counts every assistant turn the session has had, including turns history compaction has since removed, so an id is never reused within a session. A receipt merged up from a `delegate` child is namespaced `<parent call id>/<child call id>`: the child loop numbers its own turns from one and would otherwise collide with the parent's first call. A dispatch error or cancellation still closes the request with `ok: false`. `excerpt` is feedback-redaction-scrubbed and bounded to the first 2,048 UTF-8 bytes plus an explicit truncation marker; structured header maps drop every non-allowlisted header (including Authorization/Cookie), and URL userinfo plus credential query values are removed. Evidence is extracted from the complete observation before the model-facing cap can invalidate large JSON. It is a closed-world object containing only applicable identifiers/destinations/status/title/count fields (`requested_url`, `final_url`, `redirected`, `url`, `status`, `title`, `event_id`, `message_id`, `id`, `count`, `total`, `path`, `edited`, `image_path`, `audio_path`, `event_count`, `event_ids`, `message_count`, `message_ids`, `result_count`, `result_ids`); `redirected` is present when requested and final URLs are both known. Evidence strings are capped at 512 bytes and id lists at 20 items. `path` (written by `write_file`), `edited` (changed by `edit_file`), `image_path` and `audio_path` name what the tool produced, so a host can list a turn's outputs without parsing the excerpt. After a successful `todo_write`, the flagship assistant emits `todos { items: [{ id, text, status }] }` with the conversation's WHOLE task list (`status` is `"open" | "done" | "dropped"`; `dropped` means deliberately abandoned, never completed); the latest event is the state, so a host that missed one needs no replay. A rejected write emits nothing. Task lists are per conversation and persist in the conversation's durable checkpoint, and a conversation reopened after a daemon restart emits its restored list as the first event of its next turn. `receipt_report` is emitted immediately before the terminal frame and is capped at 64 KiB as a complete serialized frame. It carries the bounded software `completion` matrix, `desktop_actions: [{ action, target?, identifier?, verified, evidence }]` plus `desktop_actions_omitted`, and bounded `tool_receipts: [{ tool, call_id?, sequence?, ok, via?, excerpt, evidence }]` plus `tool_receipts_omitted`. Both lists cover **only the turn that just ran** — a continuity turn's earlier evidence still grounds the summary but is not republished as work the person just watched. A successful read action is verified; a write is verified only when a later successful read receipt contains the same identifier, otherwise it remains attempted. Whether an action counts as a write is read from the advertised tool definition's own `mutating` flag, not from its name, so a tool added later is classified without a protocol change. Hosts show `desktop_actions` instead of the six-stage software-delivery matrix when the list is non-empty; missing matrix evidence remains absent rather than inferred. `approval_pending { approval_id, tool, params, session_id, deadline, action_id?, scope? }` parks the turn on the person. An answer can be remembered only for a web search (`web_search`) by the built-in assistant, and an approval for one carries, all together, `permission_kind` (always `browse_web`; set by the runtime, never by the model), `purpose` (one fixed sentence, "CAR needs to search the web to continue this task."; it takes nothing from the call) and `choices` (exactly `[{answer: "allow_conversation"}, {answer: "allow_agent"}, {answer: "allow_all_agents"}, {answer: "deny"}]` in that order, each with a `label`) — answer through `agents.chat.approve` — but only when nothing forces a plain card: a web search approval carries none of the three when an exact `require_approval` override is set on `web_search`, when `agent-permissions.json` is damaged or has gone missing under the running agent, in a governed run, and in a turn another agent or an A2A caller started. Every other approval carries none of the three, an `http_request` in any shape included, so hosts show plain approve/deny for it; the daemon removes the three fields from an `approval_pending` it forwards for any agent other than the built-in assistant. A web search a saved answer covers runs without any `approval_pending`, and a call a saved standing refusal covers is refused without asking. `approval_resolved { approval_id, resolution: "approve" | "deny" | "timeout" }` is the authoritative terminal transition for an `approval_pending` gate: hosts clear the inline card and the mirrored ledger row on this frame rather than optimistically on their own request, so a resolve that never reached the parked turn cannot look successful. `auth_required { reason, message }` is a THIRD terminal frame alongside `done` and `error`: it arrives after `receipt_report`, is never followed by `done` or `error`, and means the turn could not reach Parslee inference because of the account — `reason` is `"signed_out" | "expired" | "no_workspace"` (branch on it; `message` is written for a person to read). The out-of-the-box agent runs on Parslee inference through a Parslee account, so a host should render this as a sign-in prompt rather than an error row; a turn that names an explicit `model` is unaffected and still reports that model's own failure. For in-daemon declarative agents, no child process or reverse call is needed: the daemon runs the declarative runner directly and emits the same event stream. `stream: false` still returns via the same event channel as a single terminal frame.
- **Task scoping on authenticated A2A surfaces.** `tasks/list` returns only the caller's own tasks; `tasks/get` and `tasks/cancel` answer `TaskNotFound` for a task created by a different verified caller (rather than confirming it exists); and a `message/send` whose `taskId` names another caller's task is refused instead of appending to their history. Tasks created on a surface with no caller identity are un-owned and stay visible to everyone, so unauthenticated embedder deployments are unchanged.
- **Admission (agent callers only).** When the caller is an *agent* rather than
  the host, this method now passes the same admission `agents.message` applies:
  the per-recipient channel guard (identical-body dedupe inside 10s, 20 sends
  per sender per minute — one shared budget per recipient across both methods)
  and the `AgentPermissionPolicy` decision at the `read_only` tier. An agent set
  to `Deny` is refused; one set to `RequireApproval` is refused too, with a
  pointer to `agents.message`, because chat is request/response and has no hold
  queue. **The host is exempt** — it is the operator's own client, and the dedupe
  window would otherwise swallow a person retyping the same prompt. Before this,
  `agents.chat` was the way around `agents.message`'s admission: a denied agent
  could reach another agent by chatting at it, and two agents could answer each
  other with nothing to terminate the loop.

  Two failure modes follow from that and are worth anticipating: an `agent_id`
  outside `[A-Za-z0-9._-]` (or over 128 chars) is refused as an invalid peer
  name, and a refusal names the guard rule that stopped it. Admission runs
  *after* the target is confirmed to exist, so an unroutable id is refused for
  that reason and does not consume the caller's dedupe or rate budget. A
  synchronous turn does not occupy the in-flight `QUEUE_CAP` slot that
  `agents.message` takes, so the two methods cannot exhaust each other on that
  axis; they do share the dedupe window and the rate budget, which is the point.
  Every refusal is written to `~/.car/peer-messages.jsonl` with its outcome.
- Host-side method is WS-only (no FFI binding — a host like CarHost calls it directly). The **agent side** has FFI helpers (below). See [`docs/proposals/agent-chat-surface.md`](.././proposals/agent-chat-surface.md) for the full host↔daemon↔agent flow.

#### `goal.suggest`
- **Params**: `{ prompt?: string, objective?: string, working_dir?: string, cwd?: string, session_id?: string, set?: boolean }`.
  - Produces an explainable deterministic completion-check candidate for a vague goal. `prompt` and `objective` are aliases; one is required.
  - `working_dir`/`cwd` is optional. When it points at a project directory, the daemon checks for `Cargo.toml`, `package.json`, `pyproject.toml`/`setup.py`, `go.mod`, `Package.swift`, `CMakeLists.txt`, `build.gradle(.kts)`, `pom.xml`, `.sln`/`.csproj`, `composer.json`, `Gemfile`, `mix.exs`, or a `Makefile` `test` target. If a prompt names a relative file or directory path inside a recognized project, including a nested project below `working_dir`, it uses the nearest project verifier. For create/write prompts, it also combines file existence with that verifier (for example `test -f src/lib.rs && cargo test -q`) instead of treating file creation alone as success. Outside a recognized project, a named path can still produce a file-existence check.
  - The method is conservative: when no deterministic signal is present, it returns `suggested: false` rather than inventing a weak completion check.
  - With `set: true`, `session_id` is required and a successful suggestion is stored exactly like `goal.set`.
  - Foreground `car do "<objective>" --infer-until` uses the same synthesis logic, prints the selected check/rationale, then enters deterministic `--until` goal mode.
- **Returns**: `{ suggested: boolean, goal: { check, max_iterations } | null, confidence: "high" | "medium" | "none", rationale: string, signals: string[], warnings: string[], set?: true, session_id?: string, stored_goal?: ChatGoalState }`.

#### `goal.set`
- **Params**: `{ session_id: string, goal?: { check: string, max_iterations?: number }, check?: string, max_iterations?: number }`.
  - Stores a durable deterministic completion contract for a chat `session_id`. `goal` is the preferred shape; top-level `check` / `max_iterations` are accepted as a convenience.
  - `check` is trimmed and must be non-empty. `max_iterations` defaults to 8 and is clamped to 1–50.
  - The daemon atomically rewrites the registry at `~/.car/chat-goals.json`, derived as a sibling of the configured journal directory.
- **Returns**: `{ set: true, goal: ChatGoalState }`.

#### `goal.status`
- **Params**: `{ session_id?: string }`.
  - With `session_id`, returns `{ session_id, goal: ChatGoalState | null }`.
  - Without `session_id`, returns `{ goals: ChatGoalState[] }`.
  - `ChatGoalState` carries `{ session_id, check, max_iterations, status, last_iteration?, last_met?, last_grounded?, last_reason?, terminal_kind?, terminal_message?, updated_at }`. `status` is one of `"active"` (set, not yet run), `"running"`, `"met"`, `"unevaluated"` (a `done` whose goal check never got the chance to run — see the fail-open case under `agents.chat`'s `goal` param above; `terminal_message` carries `finish_reason` for human-readable detail), or `"error"` (a check that ran and genuinely failed, a governor halt, or a turn refused on the Parslee account). It is updated from forwarded `goal_evaluated` events and from the three TERMINAL chat kinds — `done`, `error` and `auth_required` — and persisted. `auth_required` records `terminal_kind: "auth_required"` and carries its `message` in `terminal_message`, and it maps to `status: "error"` exactly as an `error` terminal does: the condition was not met and the run is over, so a poller reads `terminal_kind` when it needs to tell an account problem from a failed check. Ordering is the same as for the other two — it arrives after `receipt_report` and nothing follows it — so a poller that sees it has the last word it is going to get. On daemon restart, a stale persisted `running` status is reloaded as `active` while verifier details are preserved.

#### `goal.clear`
- **Params**: `{ session_id?: string }`.
  - With `session_id`, removes one standing goal and returns `{ cleared: boolean, session_id }`.
  - Without `session_id`, removes all standing goals and returns `{ cleared: number }`.

#### `agent.chat` (daemon → agent reverse-call) + `agent.chat.event`
- For attached supervised agents, `agents.chat` reverse-calls **`agent.chat`** on the target agent's WS connection — resolved via `attached_agents`, so the agent must have `session.auth`'d **with its `agent_id`** (`{ session_id, prompt, model?, attachments?, goal?, context? }`). The optional `model` is forwarded unchanged from the host request. The agent **acks** `{ accepted: true }` immediately, then streams its reply as **`agent.chat.event`** notifications `{ session_id, kind, delta? }` (`kind: "inference_started" | "inference_retry" | "model_served" | "token" | "tool_call" | "tool_result" | "todos" | "approval_pending" | "approval_resolved" | "goal_evaluated" | "receipt_report" | "done" | "error" | "auth_required"`), which the daemon rewrites to `agents.chat.event` for the host. `inference_started { model, attempt, turn }` arrives before CAR awaits a model call, and `inference_retry { model, attempt, reason, backoff_ms }` arrives before remote retry backoff. `model_served` carries `{ model_id, local_last_resort }` before each completed turn's content, so a host can identify the actual serving model and mark an on-device last-resort turn. `tool_result` carries the bounded/redacted observation shape documented above. `goal_evaluated` is emitted by goal-driven agents after each verifier pass as `{ iteration, met, grounded, reason }`; `receipt_report` carries bounded per-tool receipts, desktop actions when present, and the software completion matrix. `auth_required { reason, message }` replaces the `done`/`error` frame when the turn could not reach Parslee inference because of the account: it follows `receipt_report`, nothing follows it, and on the goal path the loop returns before the verifier runs, so no `goal_evaluated` is emitted for that iteration. `agents.chat.cancel` proxies to `agent.chat.cancel`; `agents.chat.approve` reverse-*requests* `agent.chat.approve` (resolving an `approval_pending` gate so the turn resumes). In-daemon declarative agents skip the reverse call and stream `token`/`goal_evaluated`/terminal frames directly; cancel flips a local run flag and halts at the next model/tool/goal-check boundary; inline `agents.chat.goal` and image attachments are rejected for them because their own manifest `goal` and scratch-worktree runner own completion.
- **FFI (agent side):** `registerChatHandler(handlerFn)` / `register_chat_handler(handler)` installs the handler (stored-callback pattern; the per-`CarRuntime` bridge acks and fires it with the params JSON). `CarRuntime.chatEvent(sessionId, kind, delta?)` / `chat_event(...)` emits each `agent.chat.event`. **The handler may call any runtime method and should run the turn inline** — in Python it is dispatched on a dedicated CAR-owned OS thread, never a tokio worker, so `infer_tracked`, `submit_proposal`, `state_set`, and `chat_event` all work from inside it. Before car#905 the Python bridge dispatched on a runtime worker and every one of those raised `PanicException: Cannot start a runtime from within a runtime`; because that is a `BaseException` and `chat_event` hit the same wall, the accepted turn was stranded with the host receiving zero frames. Any `threading.Thread` offload written to work around that is now unnecessary. NAPI was never affected (async `ThreadsafeFunction` dispatch). The same contract covers the `tools.execute`, `tools.cancel`, and `voice.event` callbacks. A `--serve` agent **attaches automatically**: the binding sends `agent_id` on `session.auth` when `CAR_AGENT_ID` + `CAR_AGENT_TOKEN` are set (the supervisor injects them). The bundled `create-car-agent` harness wires all of this in `--serve`, keeping an ephemeral per-`session_id` message thread and running the standard propose→verify→execute loop per turn.
- Bundled `car do` / `car do --serve` assistant loops run proactive memory before every model turn. The hidden pass maintains compact execution-state memory from the runtime event log, selects at most one relevant remembered fact/procedural warning, and injects it as a `## Proactive Memory` context block. This uses the same assistant memory bank as `remember` / `recall`, but does not require the model to call `recall`; maintenance/intervention decisions are journaled as `proactive_memory_maintained` and `proactive_memory_intervention`.
- Native coder loops also run proactive memory over the shared repair memgine when learning is enabled. The pass mines the coder session journal into procedural/open-subgoal facts, injects at most one `## Proactive Memory` context block before the next coding turn, and journals the same proactive-memory events into the coder session event log.

#### `agents.peers`
- **Params**: none (`{}`).
- Lists the peers visible to this caller. Use each row's `reachable` field before offering a send.
- **Returns**: `{ self: string | null, peers: [{ name, address, reference, kind, source, can_receive, reachable, display_name, capability, last_seen_ms }], count: number }`.
  - `self` is the caller's own name — the address other agents use to reach it. The caller is **never** among `peers`; addressing yourself is an error, not a loopback.
  - `address` is the form to pass as `agents.message`'s `to`. It is the bare `name` unless two live peers share that name, in which case it is `name [reference]`. References are assigned only where a name is genuinely ambiguous, so ordinary addresses stay readable.
  - `kind` is `car_agent`, `external_cli`, or `remote_car`; `can_receive` is the stable capability of that kind and is false for `external_cli`. CAR runs external CLIs as batch processes (the task goes in on stdin, which is closed immediately so the child sees EOF), so they can message CAR while running but have no inbox to deliver into.
  - `reachable` is the daemon's point-in-time delivery preflight over the same two descriptor guards `agents.message` applies: the kind must have an inbox (`can_receive`) and the emitted `source` must be trusted by default. It is false for an unpromoted `lan` peer even though that remote-CAR kind has `can_receive: true`. It is a snapshot, not a delivery guarantee: the send remains authoritative because sender policy, standing, message limits, recipient attachment, and remote liveness are evaluated later.
  - `source` is `attached`, `invocation`, `parslee`, or `lan`. Local peers come from the daemon's **live connection table**, not the on-disk agent registry — the registry is observe-only self-report whose reap sweep tolerates a 900s stale window, so a listing built from it would offer agents that exited a quarter of an hour ago.
  - **Cross-host discovery** has two independent routes, complementary rather than redundant:
    - `parslee` — this user's other machines, each announcing its A2A endpoint on the **synced oplog** (`Registry { kind: "host_endpoint" }`, folding LWW per device id so a machine that moves overwrites its own entry). The oplog is end-to-end encrypted, so Parslee relays the bytes without being able to read the endpoints. This is why discovery rides the oplog instead of an address field on the sync roster: the roster would publish a per-device address to the service. Covers every signed-in login, not only the one present at daemon start: each other login's endpoints ride its own personal oplog (opened on `sync.pump`; daemon boot stays credential-free, so this host's announcement is remembered at boot and published as each subsystem opens), and a machine signed in to several of your logins is listed once. Devices under any held login are trusted too: trust rests on a login signed in here plus the shared sync passphrase, so signing in a login that is not yours extends trust to its devices. Removing a login (`auth.remove_account`) or signing out (`auth.logout`) through the daemon withdraws its devices' trust immediately, the boot login's included; a change made through the in-process CLI is noticed within 30 s from the non-secret credential-authority hint and drops other logins' trust until the next `sync.pump`. Requires a login; empty without one.
    - `lan` — CAR daemons advertising `_car-a2a._tcp.local.` over mDNS. Needs no login but reaches only one broadcast domain. The peer-reachable URL travels in a TXT record rather than being rebuilt from the resolved IP and port, because an operator can pass `--a2a-public-url` to declare a URL that differs from the bound socket.
  - **A `lan` peer is listed with `can_receive: true` and `reachable: false`.** Anyone on a network can advertise any name, so discovery makes a peer *visible*, not reachable; `agents.message` refuses it with an error naming the remedy until an operator promotes it via `a2a.peers.add`. A promoted peer is reported under its trusted source instead, so it is not double-listed. Name collisions resolve toward the more *trusted* source, not the nearest one — a `parslee` device outranks a `lan` advertisement even though the LAN is the shorter path.
  - Cross-host delivery addresses the remote **daemon's** A2A surface, never one of its agents. That daemon applies its own guard and policy before reverse-calling a local agent, so a cross-host message passes two admissions — the sender's and the recipient's — and neither can be skipped. `PeerAddress` deliberately has no variant naming a remote agent.

#### `agents.message`
- **Params**: `{ to: string, body: string, summary?: string, kind?: string, in_reply_to?: string }`.
  - `to` is an `address` from `agents.peers`, or `human:<name>` for a human Lattice node. An attached agent's principal form `agent:<id>` — what its messages carry in `from` — resolves to that agent, so a reply can copy `from` verbatim. `body` is plain text.
  - `kind` says what the sender is asking for: `message` (default), `question`, `answer`, `review_request`, or `handoff`. It is a field rather than a body convention so a recipient can sort its inbox without parsing prose. It is advisory: every kind passes the same guard, policy, and audit, and a `review_request` or `handoff` grants the recipient nothing. A plain message omits `kind` from the stored envelope, so recipients that predate the field see the same envelope as before.
  - `in_reply_to` is the `id` of the message being answered, so an asker can match an answer to its question. The daemon checks its shape only — it is a correlation hint, not proof that a conversation happened. The reply path for a question is an `agents.message` back to the received `from` with `kind: "answer"` and `in_reply_to` set to the question's `id`.
  - `summary` is a label for the **sender's** own transcript; it is not transmitted.
  - There is no `from`. The daemon derives the sender from the connection's bound `agent_id` (the same server-side principal stamped into approval audit records), so a caller cannot attribute a message to another agent and the audit trail cannot be forged.
- **Authorization**: the caller must be a bound agent or a host session; an unauthenticated connection is refused. A bound agent is then resolved against `AgentPermissionPolicy` at the **`read_only`** tier — honestly what a peer message is, since it mutates nothing on the recipient, reaches no executor, and grants no authority. The tier is resolved for the *sender*: the question is whether this agent may talk to other agents. Under the Balanced preset `read_only` is `always_allow`, so the default is permissive; the value is that setting a specific agent's `read_only` posture to `deny` actually stops its peer messages (`require_approval` holds them instead of dropping them), rather than the rule living only in a system prompt the agent may or may not follow.
- **Semantics**: a peer message is **inert data**. It is not a `proposal.submit` and cannot reach the executor; whatever the receiving agent decides to do about it passes through that agent's own gates unchanged. It cannot answer a pending permission prompt, and a slash command in the body arrives as text.
- **Delivery**: the daemon reverse-calls **`agent.peer_message`** `{ id, from, body, sent_at_ms, no_reply, kind, in_reply_to, cross_owner }` on the recipient's attached connection (`kind` is always present, `"message"` when unset; `in_reply_to` is `null` when unset; `cross_owner` is true when the message came from another owner's CAR over a Lattice connection, recorded from the key that signed it — untrusted data from outside this owner's trust domain. `peer_inbox` rows carry the same `cross_owner`) — the same mechanism `agents.chat` uses. There is deliberately no per-agent socket: a path that reached an agent without passing through the daemon would make admission advisory, since nothing would sit between sender and recipient.
- **Channel limits** (these bound the channel, not the sender's authority — two agents answering each other form a loop that no policy rule catches because neither is misbehaving):
  - Body cap ~1 MB serialized. Over it, send a path or a state handle instead.
  - Identical body from the same sender inside 10s is dropped as a repeat.
  - 20 messages per sender per recipient per 60s.
  - 50 undelivered messages queued per recipient.
  - Each limit returns a distinct error naming the remedy: batch for a rate limit, wait for a full queue.
- **Returns**: `{ id, to, outcome }` where `outcome` is:
  - `delivered` — the recipient acknowledged.
  - `unacknowledged` — the frame was written but no ack arrived within 5s. Recorded as its own audit outcome rather than folded into `delivered` or `refused`: the frame demonstrably was written, so calling it a drop is as wrong as calling it a delivery. Reported honestly rather than as failure: an agent that does not implement `agent.peer_message` simply never answers, and the write did happen.
  - `awaiting_human` — the recipient is a human Lattice node (`to: "human:<name>"`): the message was recorded as a durable request for a person, and the answer arrives later as a reply (see `lattice.wait`). The result also carries `answer_token`, which only the asker receives.
  - `held` — the recipient's configured posture stopped it, or it is the first message this owner sends over a Lattice connection to another owner's CAR (below); carries `reason`, `retained: true`, `cross_owner`, and `awaiting_notice`. The message is kept for an operator decision — see `agents.message.pending` / `agents.message.approve` below.
- **The first message to another owner's CAR waits for its owner.** A message to `<node>@<label>` over a Lattice connection (never one of this owner's own devices) is held, with `cross_owner: true`, until the operator agrees to what may happen to it there. The `reason` is the notice: where it goes, the connection's purpose, and that what processes it on the other CAR — a cloud model included — is outside this owner's control. Nothing CAR can check rules a cloud model out on the far side, so every cross-owner target is in that one class today. Approving the message records the agreement on the connection (`lattice.connections` `acknowledged`), and later messages on it go without asking, from any of this owner's nodes. Declining shares nothing, records nothing (the next message waits again), and is not charged against the sender's standing: the owner declining to share is no fault of their node. The same applies to the MCP `peer_message` tool, which returns `outcome: "held"` instead of sending, and to a person's answer through `lattice.respond`. The operator decides in CarHost or with `car lattice held` / `car lattice release <id> [--decline | --acknowledge-processing]`. This is a consent step for the owner, not a barrier against software running as that same user: the host credential is a file in the user's own account, so a coding agent with a shell and that user's permissions can reach it, as it could reach CarHost's. Each held cross-owner message raises a `lattice.outgoing_held` host event `{ id, from, to, connection }` (no body). A message the credential heuristic flags is still refused when the operator approves it. When posture also holds the message, one record carries both reasons.
  - A refusal is an error, not an outcome.
- **Cross-host delivery passes two admissions when the far side is a
  peer-authenticated CAR listener** — the one `car-server` runs by default. That
  qualifier matters: a `remote_car` peer whose URL points at an `a2a.start`
  listener reaches a surface with no signature check and no broker, and the
  outcome reported there is `accepted`, not `delivered`. A message addressed to
  a peer-authenticated daemon lands on its **receiving-side broker**, which
  decides it
  before it reaches anyone: the sender is rebuilt from the *verified* signing
  key rather than the name the caller supplied, the recipient must be an agent
  attached to that host (a peer message is **never relayed** onward — that would
  make the host an open relay forwarding under its own signature to hosts that
  never trusted the origin), and the recipient's own channel guard applies. So
  `delivered` means the far side admitted it and reverse-called its agent, and
  the far side *said so* — the sender reads the broker's verdict out of the
  reply rather than assuming it, so a message whose recipient never acknowledged
  comes back `unacknowledged` on both hosts instead of being recorded as
  delivered on either. A peer with no broker reports `accepted`, which claims
  only what it can: the bytes were taken. A refusal returns as an error carrying
  the remote broker's reason. Peer messages are delivered over
  `message/send`; the streaming twin refuses them rather than compiling them
  into a proposal. What the far side does **not** do is grade the sender against
  a per-peer policy row: there is no local sender to resolve inbound, and a
  remote-supplied name must never select which local posture governs it.
- **Earned standing.** A sending principal — a verified peer key inbound, a
  local agent id outbound — accumulates a record from *this daemon's own
  observed outcomes*, never from message content (a body that could move a
  sender's standing would make the envelope an authority channel). A record
  degrades on the same rule that degrades a skill, `fail > success + 2`, now a
  single shared definition rather than three copies. What counts as a failure is
  narrow and deliberate: a chain over the hop cap, an oversized body, an illegal
  name or malformed lineage, an unresolvable recipient, and an operator's
  explicit denial through `agents.message.approve` — which is the only ground
  truth among them. What does **not** count: a rate limit or an in-window
  duplicate (the channel guard exists precisely because in a mutual loop neither
  party is misbehaving, so charging them would price correct behaviour as
  misconduct), a refusal by this host's own policy (our posture, not their
  conduct), and an unacknowledged delivery (the recipient's agent did not
  answer). The consequence is a **throttle, not a severance**: a degraded sender
  is limited to 2 messages per minute, host-scoped and checked *before* the
  per-recipient guard, so renaming agents or switching recipients does not buy a
  fresh budget. Successes saturate, so headroom never grows without bound, and
  both counters halve weekly, so a degraded peer recovers on its own without
  anyone remembering to forgive it. `agents.peers` renders a record where one
  exists — absent means nothing has been observed yet, which is not the same as
  a clean record. Counters are in-memory: only an operator's ledger decision is
  durable, by design.
- **Lineage.** A peer message carries `trace` (the id of the message that began
  the chain) and `via` (the ordered principals it passed through, origin first).
  Segments are `agent:<id>`, `conn:<id>`, `mcp:<peer-id>`, or
  `peer:<key>` — and a `peer:` segment is a **host-boundary marker stamped by
  the receiving daemon from the key it verified, never by the sender**. So
  everything before the last `peer:` marker is that key's *attestation*, and
  everything after was observed by the daemon holding the message. The list
  carries its own trust model; nothing downstream has to remember which half was
  witnessed. Lineage crosses the hop inside the signed request body, so it
  cannot be altered in flight — though the signer can still lie about its own
  prefix, which is what the hop cap bounds and what earned peer standing is
  meant to make expensive. A chain deeper than 8 **agent** hops is refused
  (boundary markers do not count: crossing a host changes who attests, not how
  far the work has travelled). This is the one hazard the dedupe and rate limits
  structurally cannot see — eight agents each forwarding a different body are
  eight legitimate sends by every per-pair rule, and still a runaway. Inbound
  `via` is validated for shape before an agent is shown it; both fields default,
  so a sender that predates lineage produces a root rather than an error.
- **Audit**: every attempted delivery, refusals included, appends to the `ServerState`'s configured peer audit journal (`~/.car/peer-messages.jsonl` for the standalone daemon). The path is resolved once at state construction; a test or embedder with a custom state directory never re-resolves process-global `CAR_HOME` while writing. Rows carry `dir` (`out` / `in`), `trace`, and `via`, plus `message_kind` when the message is not a plain `message` and `in_reply_to` when it answers one (the row's `kind` column is the recipient's peer kind, which predates message kinds); inbound rows also carry `attested_by` — the verified key the sender was derived from. The last `via` segment on an inbound row is therefore the receiver-appended `peer:<verified-key>` boundary, so an operator can distinguish what the remote key attested from what this daemon observed. Inbound rows are new: before the receiving broker existed there was no inbound admission to record. `agents.chat` writes to the same configured journal — it has driven another agent's turn since it shipped with no audit record of any kind, and adding a governed sibling beside an unrecorded surface would only have moved well-behaved callers onto the audited path.

#### `agents.message.pending`
- **Params**: none (`{}`).
- **Authorization**: **host-only.** An agent must not be able to read, or later approve, the queue that exists to gate it.
- Lists peer messages held awaiting an operator decision, oldest first.
- **Returns**: `{ held: [{ id, from, from_name, to, body, held_at_ms, reason, cross_owner, connection, awaiting_notice, notice_only, processing }], count, cap }`. `from_name` is the sender's Lattice display name when it has one (`null` otherwise). `cross_owner` is true when the recipient is a node on another owner's CAR, and `connection` is that Lattice connection's id (`null` otherwise). `awaiting_notice` is true while the message still waits on the processing notice (false once its connection has been agreed), with `processing` the class it was held for (`"may_use_cloud_model"`, else `null`). `notice_only` is true when the notice alone held it, so allowing the connection sends it; false when posture held it too, which still needs its own decision. A message posture held to another owner's node after the agreement has `cross_owner: true, awaiting_notice: false`.
- **Authorization**: also accepts the host-management credential, so `car lattice held` / `car lattice release` reach it from the CLI.
  - The queue is bounded at 100 undecided messages; past that the oldest is dropped, logged, and written to the audit journal as a refusal — a message the operator never saw must not vanish silently after the sender was told it was retained.
  - Held in memory only. A held message is a live decision awaiting a human, and one that outlived a daemon restart would be delivered into a world that had moved on.

#### `agents.message.approve`
- **Params**: `{ id: string, decision: boolean | string, acknowledge_processing?: boolean }`.
  - `acknowledge_processing` must be `true` to send a message still `awaiting_notice`, because sending it agrees for its whole connection; once the connection is agreed it is not needed. Without it the call fails with the notice, and the message stays held where it was. Declining needs no flag.
  - `decision` accepts a bool or a string (`"approve"`/`"approved"`/`"yes"` → approved; anything else, or omitted → denied). Same convention as `agents.chat.approve`, so an operator does not have to remember two.
- **Authorization**: **host-only**, as above.
- On approval the message is **re-admitted through the channel guard** before delivery. It passed the guard when it was sent, but time has moved and the recipient may since have been flooded; an approval authorizes the sender, it is not a licence to bypass the channel's limits. The message's own identical-repeat record is forgotten first, so an operator approving within 10 s is not told it "was already delivered". A message the guard refuses at this point (a rate limit after a burst of approvals) stays held and the call fails saying so.
- **Returns**: `{ id, outcome }` — `denied`, or the same `{ id, to, outcome }` shape `agents.message` returns on delivery. Both paths append to `~/.car/peer-messages.jsonl`.
- Approving an `awaiting_notice` message first records the agreement on its connection, which must still be active, then sends the other messages held only for that notice on the connection. They are taken off the queue one at a time, just before each is sent, so a decline made meanwhile still finds its message and wins. The agreement stands if the delivery itself then fails (a credential refused, the other CAR unreachable): the owner did see the notice. Declining a message posture held too is charged to the sender as any posture denial. Ending a connection drops its held messages, each journalled as refused. The journal records an approved message's actual delivery outcome, never `delivered` ahead of the attempt.
- The queue slot a held message occupied is released when it is held, not when it is decided: `QUEUE_CAP` bounds what a recipient has yet to read, `HOLD_CAP` bounds what an operator has yet to decide. Charging a held message against the delivery queue would let a slow human block a healthy channel.

#### `agents.chat.cancel`
- **Params**: `{ session_id: string }`.
- Best-effort cancellation. Attached supervised agents receive `agent.chat.cancel` so they can short-circuit their inference stream. In-daemon declarative agent sessions set a local cancellation flag and drop routing immediately; the runner stops at the next model/tool/goal-check boundary. Terminal for the session.
- **Requires the originating host session or the host-management role**, the same check `agents.chat.approve` applies. Being authenticated to the daemon is not sufficient: without this, any session could abort any live turn by observing a `session_id`. A refused cancel leaves the chat session routing untouched.

#### `agents.chat.approve`
- **Params**: `{ session_id: string, approval_id: string, decision?: boolean | string, answer?: "allow_conversation" | "allow_agent" | "allow_all_agents" | "deny", permission_kind?: string }`.
  - Resolves an inline human-in-the-loop approval an agent raised via an `approval_pending` event (carrying `approval_id`). `session_id` selects the agent connection (same routing as `agents.chat`); the session is **kept** so the turn resumes after the decision. The `approval_id` is the one the daemon showed the host for that event, never the agent's own id; see **Only an outstanding id is forwarded** below.
  - `decision` is the legacy answer — a bool, or a string the agent accepts (`"approve"`/`"approved"`/`"yes"` → approved; anything else → denied). Omitted (with no `answer`) ⇒ denied. It approves or declines this one call and remembers nothing.
  - `answer` is one of the four choices an `approval_pending` event offered; send it with the event's `permission_kind` echoed back (and `decision` too, so an older daemon still resolves). The choices are offered only for a web search, and the kind is always `browse_web`. An allow answer approves the call **and** is remembered (the agent stages the grant as an inert pending record, resumes the call, and activates the grant only after the parked gate has durably recorded the approval, all inside the acknowledgement window; if any step fails or runs late the call still goes as the gate decides and the next one asks, and `resolved: false` means the call had already given up and nothing was remembered): `allow_conversation` for this chat's `conversation_id` (see `agents.chat`), `allow_agent` for this agent in every chat, `allow_all_agents` for every agent. Once the grant is active, the next web search in that scope runs without asking; nothing else ever runs on it, and each use reads the file again, so a revoked answer, an exact `require_approval` override or a refusal applies to the very next search. The reply does not say whether the answer was remembered; `agent_permissions.list_grants` shows what is. It remembers nothing when the event offered no choices, or when `permission_kind` is missing or is not `browse_web` — then the answer approves this call only. `deny` declines this call only and creates no refusal.
  - The four-choice `answer` is forwarded only from a host-management session. The other caller allowed to approve — the client session that started the chat turn (for example another agent that called `agents.chat`) — is reduced to the legacy `decision`: it may approve one parked call, never create standing authority. While the person's host holds a turn's route, an agent connection cannot answer an approval in it. An agent that starts a chat itself is that chat's starting session, so it can approve one parked call there, never with a remembered answer; the same is true of a client that starts a turn on a session id whose earlier host has disconnected. A host built from an older release sends a plain `decision` and so remembers nothing, and this agent behind an older daemon may be told `resolved: true` for an allow answer that was not remembered (that daemon does not forward the kind).
- **Authorization**: the caller must be the host session that started the chat turn, or a host-management session authenticated with `session.auth { host_token }`. A supervised agent connection can approve a parked action only in a turn it started itself, and never with a remembered answer.
- **Returns**: `{ resolved: boolean, session_id: string }` — the daemon reverse-*requests* the agent's `agent.chat.approve` handler and relays its `{ resolved }` reply (bounded ack timeout), so the host gets a definitive answer rather than inferring from the stream.
- The daemon mirrors the chat gate into the host `ApprovalLedger` under the same `approval_id`. A host may call this method directly or call `host.resolve_approval`; the latter recognizes `source: "chat"` and routes to the same parked turn. The ledger row remains pending until the agent emits authoritative `approval_resolved` (or the routed resolve succeeds), so every host surface converges on the same decision.
- **Only an outstanding id is forwarded.** Approval frames reach a host only under a daemon-minted `approval_id` (the inline card and the mirrored ledger row share it); an approval frame the daemon cannot map is dropped, not forwarded with the agent's id. Each approval the agent parks gets its own id, a repeated announcement of one still open keeps the id it has, and the daemon keeps the mapping back to the agent's id on the chat turn's route. This method forwards a decision only for an id outstanding on the session's current route, sending the agent its own id. Each id carries one decision: the first call claims it, and a second call, or one whose turn ended before the decision was sent, fails. A failed delivery is not retried; the parked call then times out as declined. Any other id (already answered, expired, from an earlier turn, another session's, or the agent's raw id) fails with an error naming it as not pending, and nothing reaches the agent. A route ends with its turn (or when another `agents.chat` replaces it under the same `session_id`), so a cancelled, failed or replaced turn's approvals cannot be answered under the next turn. The agent's `approval_resolved` is forwarded under the same daemon id. Treat ids as opaque. This keeps an agent built before approval ids carried a turn token, which reused `<session_id>-appr-<n>` from zero each turn, from ever having a stale decision reach a newer call; a host should still disable a turn's unanswered cards when the turn ends.

#### `agents.list_external`
- **Params**: `{ include_health?: boolean }` — when `true`, also populates each spec's `health` field via the tool's auth-status command (slower; one subprocess per detected adapter). Default `false`.
- **Returns**: `[ExternalAgentSpec]` — cached snapshot of installed agentic CLIs (Claude Code, Codex, Gemini). Each entry carries `{id, display_name, binary_path, version?, auth_kind, capabilities, detected_at, health?, execution}`. `auth_kind` is **deprecated** (Phase 2 stage 1) — prefer `health` for ground-truth readiness.
- `execution` (car#746) answers a **different question** from `health`: *can this binary be executed at all*. `{"state":"runnable"}` or `{"state":"unusable","reason":"<names the path>","checked_at":<unix>}`. It is written by detection and **never revised by a health refresh**, whereas `health` is owned by refreshers that are free to rewrite it — which is why the executability verdict moved off `health.status`. Prefer it over `health.status == "not_executable"`, which is still emitted for one compatibility window. An absent `execution` (a pre-split daemon) reads as `runnable`. **Callers must not invoke a spec whose `execution.state` is `unusable`.**
- This is the discovery surface for the third kind of agent in CAR's taxonomy (sibling to lifecycle agents and in-process runners). See `docs/proposals/external-agent-detection.md`.

##### How `binary_path` is resolved

Resolution is executability-verified, not existence-based. In precedence order:

1. **Explicit pin** — `$CAR_<ADAPTER>_BIN` (`CAR_CODEX_BIN`, `CAR_CLAUDE_CODE_BIN`, `CAR_GEMINI_BIN`). When set, `$PATH` is not consulted. Use this for a CLI that ships inside an app bundle and was never on `$PATH` (ChatGPT.app vendors its own `codex`). A pin that doesn't resolve is reported as `not_executable` rather than silently falling back to `$PATH` — falling back would reintroduce exactly the ambiguity the pin removes. **The pin is process-local**: the daemon is launched by the GUI and inherits launchd's environment, so a `export` in a shell rc file is visible to `car` but *not* to the daemon that runs coder sessions.
2. **`$PATH` scan** — **every** match is collected in `$PATH` order (duplicate `$PATH` entries collapse), then each is probed with `--version` until one actually runs. A binary that resolves but cannot execute therefore **cannot shadow** a working one later on `$PATH`.

If no candidate runs, the adapter is still returned — omitting it would leave the user unable to find the broken install — but with `execution: {"state":"unusable", reason}` naming the path (and, for the compatibility window, `health.status: "not_executable"`). **Callers must not invoke a spec in that state.** The world-writable scratch-directory denylist (`/tmp`, `%TEMP%`, …) applies to the `$PATH` scan; an explicit pin bypasses it, since naming a path outright already requires a privilege that setting `PATH` itself would grant.

#### `agents.detect_external`
- **Params**: `{ include_health?: boolean }` — same as `agents.list_external` but always force-refreshes the presence cache (and the health-check TTL cache, when `include_health: true`).
- **Returns**: `[ExternalAgentSpec]` — same shape as `agents.list_external`. Use after the user installs / authenticates a new tool, or to refresh `health` after a login.

#### `agents.health_external`
- **Params**: `{ id?: string, force?: boolean }`
  - `id` selects a single adapter (`"claude-code"`, `"codex"`, `"gemini"`, `"mini-swe-agent"`). Omit to check every detected adapter.
  - `force` bypasses the 30s per-tool TTL cache. Default `false`.
- **Returns**: `[ExternalAgentHealth]` (when `id` omitted) or `ExternalAgentHealth` (when `id` supplied). Each entry: `{id, status, details, reason?, checked_at}` where `status` is one of `ready | not_configured | expired | network_error | not_executable | unknown` and `details` is tool-specific structured JSON parsed from the auth-status output.
- `not_executable` is set by **detection**, not by an auth-status command — a binary the OS refuses to run cannot report its own auth state, so the status probe is skipped entirely rather than spawning a second doomed process whose `unknown` would overwrite the diagnosis. It means the *install* is broken (macOS Gatekeeper quarantine, architecture mismatch, dangling symlink into a relocated app bundle), not that the user is signed out: hosts should surface the `reason` and **not** offer a login flow. On macOS, `xattr -l <binary_path>` showing `com.apple.quarantine` confirms the common case.
- **Ground truth**, not heuristic: delegates to each tool's own status command (`claude auth status` returning structured JSON, `codex login status` returning a single status line, etc.). Two adapters have no such command and say so in `reason`: Gemini (running it without args triggers a browser OAuth flow) falls back to credential-file shape inspection, and `mini-swe-agent` (which has no status command at all) reports `ready` when a provider API key **name** resolves from the daemon environment or from its own global `.env`. Neither is verified against the provider; a key that doesn't match the pinned model surfaces at invocation.
- **Replaces the Phase 1 `auth_kind` heuristic** as the primary signal for "is this tool ready to invoke." Existing callers reading `auth_kind` keep working; new callers should prefer `agents.health_external`. Phase 2 will demote `auth_kind` to optional and add a `health` field to `ExternalAgentSpec` carrying ground-truth status.

#### `agents.invoke_external`
- **Authorization**: a host, and a client not bound to an agent, may call it with or without a chat. It is not a host-management method, so the host-management authority `agents.upsert` requires does not apply to these callers. A connection bound to a supervised agent (`session.auth { token, agent_id }`) may call it only while it is answering an `agents.chat` turn a host started with it: the connection must be the agent's current one (an older connection a reconnect superseded is refused), and `session_id` must name that turn while it is still running. A later turn under the same `session_id` is a different turn. A host here is a connection with host-management authority; on a daemon with no host token (development mode), any connection not bound to an agent counts, the same exception the lifecycle methods make. An agent's call is refused with "An agent can ask an outside agent only while answering a chat you started." when it names no `session_id`, a chat sent to another agent, a chat another agent or a connection without host authority started, or a chat that has ended or been replaced by a new turn. The check is made when the call arrives and again, on both the one-shot and the streaming path, just before the call is handed to the CLI runner; the second check covers both the connection and the turn, and no reconnect can land between them. The runner then probes the installed tools before the CLI starts: about two seconds at most per installed binary of an adapter, with an adapter's binaries probed one after another and the adapters side by side. A streaming run that has been handed off keeps running if the chat then finishes or the agent reconnects; a host's `agents.chat.cancel` still stops it. A one-shot run is part of the calling connection's request, so it stops if that connection closes. The check reads the daemon's own record of the turn (who started it and which agent it was sent to), never the caller's params. It binds the connection, not the process: an agent that reconnects without its `agent_id` is an unbound client to this rule, with or without a host token (car#1297).
- **Discovery**: the method's derived role is `agent`, so `capabilities.list` lists it for agent sessions only. Hosts and unbound clients do not see it there and call it as before.
- **Params**: `{ id: string, task: string, stream?: boolean, session_id?: string, cwd?: string, allowed_tools?: [string], max_turns?: number, timeout_secs?: number, mcp_endpoint?: string, isolate_network?: boolean, isolate_config?: boolean, attachments?: [{ path: string, media_type?: string }] }`
  - `id` selects the adapter (`"claude-code"`, `"codex"`, `"gemini"`, `"mini-swe-agent"`).
  - `"mini-swe-agent"` is a **measurement baseline**, not a production engine — it is the control arm for `car coder-ab` (see `docs/coder-ab-guide.md`). It must be named explicitly: unnamed engine resolution (`coder.start` with `engine: "auto"` or a bare `"external"`) never selects it. It also has no default backbone of its own, so an invocation without `model` (and without `$MSWEA_MODEL_NAME` in the daemon environment) is refused up front rather than spawned; its model ids are **litellm** ids and need the provider prefix (`openai/gpt-5.5`, not `gpt-5.5`).
  - `task` is the prompt the agent runs to completion.
  - `stream` opts into per-event streaming over the existing `agents.chat.event` channel (default `false`). When `true`, the method returns an ack (`{accepted, session_id}`) and the runner fans `agents.chat.event` notifications to the originating host as the child emits stream-json events — `kind: "token"` per text content block, `kind: "tool_call"` per `tool_use` block, terminal `kind: "done"` with metadata folded into `finish_reason` (or `kind: "error"`). Every adapter emits events (car#213), but only two stream: `claude-code` forwards native stream-json events; `codex` synthesizes an Anthropic-Messages-shaped `Assistant` event per `item.completed` line (incremental `kind: "token"` / `"tool_call"` frames); `gemini` is text-only in 0.1.x (no event stream) and `mini-swe-agent` has none either (its trajectory JSON is read once after exit), so each emits one `Assistant` text event with the full reply on completion — a single-pop `kind: "token"` then the terminal `done`, not a token stream. `capabilities.streaming` (`agents.list_external`) says which is which. Each `tool_call` frame carries the `tool` name + `params` (the `tool_use` input) per the shape pinned in `docs/host-protocol.md` (plus a legacy `detail` = name alias).
  - `session_id` is the host-generated id threaded through every event. Auto-generated when omitted; an agent must name the chat it is answering (see **Authorization**), and its CLI's events then stream to the host that started that chat. Reuses the same routing infrastructure as `agents.chat`; when `stream: true`, `agents.chat.cancel { session_id }` flips the runner's local cancel flag and drops the child-process future (`kill_on_drop` reaps the CLI).
  - `cwd` defaults to the daemon's working directory.
  - `allowed_tools` is passed through as `--allowed-tools "<list>"`. `[]` denies every tool (text-only response). Omit to use the binary's default policy.
  - `max_turns` caps model turns. Cost-control guard for runaway loops.
  - `isolate_network` (default `false`) runs the CLI with no route off the machine: Codex gets `--ignore-user-config`, `web_search="disabled"`, the personal features off (as listed under `isolate_config`), a `workspace-write` sandbox without network, and a fresh temporary `CODEX_HOME` (none of the user's memories, past sessions or global `AGENTS.md`, which `--ignore-user-config` alone left readable). Only the login is carried into it: with `CODEX_API_KEY` set nothing is, otherwise the user's `auth.json` (from `CODEX_HOME`, else `~/.codex`) is linked in, and a login Codex refreshed into its own copy is written back while the user's file is unchanged since the run started. With neither, as with a login kept in the OS keyring, the call fails as a setup error; Claude Code runs with an empty temporary `CLAUDE_CONFIG_DIR` (none of the user's plugins, hooks, agents, skills, auto-memory or `~/.claude/CLAUDE.md`; its stock tools are unchanged; with no config it cannot use a claude.ai login or an `apiKeyHelper`, so it authenticates from the environment — `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or a Bedrock/Vertex/Foundry provider selected with `CLAUDE_CODE_USE_*` — and without one the call fails as a setup error) and `--setting-sources project,local` (the user's own settings are left out), `--strict-mcp-config` with no MCP config, WebFetch/WebSearch removed, `acceptEdits`, and an OS sandbox with no allowed network domain and no unsandboxed retry (on Linux the sandbox needs bubblewrap; without `bwrap` on PATH the call fails as a setup error). The MCP endpoint is not injected. `gemini` and `mini-swe-agent` refuse (a setup failure) because CAR has no verified way to cut their web access. Ignoring the user's Codex config also drops its personal defaults, such as reasoning effort.
  - `isolate_config` (default `false`) runs the CLI without its user's own configuration while keeping the web: Codex gets `--ignore-user-config`, `web_search="live"` (the default would otherwise come from the ignored user config), the personal features off (`apps`, `plugins`, `plugin_sharing`, `remote_plugin`, `browser_use`, `browser_use_external`, `browser_use_full_cdp_access`, `in_app_browser`, `computer_use`, `memories`, `multi_agent`, `image_generation` — on by default and not user config, so `--ignore-user-config` leaves them on; `isolate_network` turns them off too) and the same fresh temporary `CODEX_HOME` with only its login carried in, but keeps its own sandbox's network posture and its web search. The CAR MCP endpoint is not injected. Verified on codex-cli 0.160.1: it searched the web, listed no browser, computer-use, app or plugin tool, and reported no MCP servers. Claude Code, `gemini` and `mini-swe-agent` refuse as a setup failure: Claude Code keeps its claude.ai login in the configuration this leaves out. `isolate_network` implies it.
  - `timeout_secs` is the public invocation deadline. It defaults to 300s and
    is clamped to [1, 3600]. Only coder sessions bypass this public policy and
    pass no runner wall timeout, because their silence watchdog and no-progress
    rule provide the bound.
  - `mcp_endpoint` is the MCP server URL the agent should load via `--mcp-config`. **Auto-filled from the daemon's bound `/mcp` URL when omitted** — so external agents transparently pick up CAR's tools (`memory_*`, `verify`, `skill_*`) routed through the daemon's policy + shared memgine. Pass `""` (empty string) to opt out (no `--mcp-config` injected; agent runs without CAR's MCP namespace).
  - `attachments` are images attached to the prompt, each `{ path, media_type? }` where `path` is an **absolute path on the daemon's filesystem** (external CLIs are local subprocesses, so images are passed by path, not base64). The runner hands each to the CLI in its native form: `claude-code` reads the bytes and inlines a base64 image block on stdin, `codex` passes each via `--image`, `gemini` references it with `@path` (staged into a temp dir first). The runner validates every path it reads/stages: files over 32 MB are skipped, and the `claude-code`/`gemini` paths verify the bytes are a real image by magic signature (PNG/JPEG/GIF/WebP) and derive `media_type` from the **content** — the supplied `media_type` is advisory, so a non-image file (e.g. a secret the path points at) is never inlined. Adapters advertise support via `capabilities.images` (`agents.list_external`); a CLI without image input ignores them (`mini-swe-agent` has none, and reports every supplied image in `dropped_attachments`). Unreadable / oversized / non-image paths are skipped.
- **Returns** (non-streaming): `InvokeResult { answer, session_id?, turns, tool_calls, duration_ms, total_cost_usd?, dropped_attachments?, is_error, error? }`. `total_cost_usd` is the would-be API cost — subscription users don't pay this; reported for transparency. `tool_calls` counts `tool_use` blocks the assistant emitted across all turns. `dropped_attachments` (omitted when 0) is the number of supplied images the runner couldn't send (unreadable / oversized / not a recognized image).
- **Returns** (streaming, `stream: true`): `{ accepted: true, session_id: string }`. The full InvokeResult is *not* in the reply — the daemon emits `agents.chat.event` notifications on the originating host's channel and writes the same `~/.car/external-agents.jsonl` audit record when the invocation completes. The terminal `kind: "done"` event carries `dropped_attachments` (and folds an "N image(s) skipped" note into `finish_reason`) when any attachment was dropped, so a streaming host can warn the user.
- **Cost note**: each invocation burns subscription quota. The runner doesn't gate cost; hosts should rate-limit.
- **Audit trail (stage 4a)**: every invocation appends one JSONL record to `~/.car/external-agents.jsonl` with `{ts, adapter_id, task, options, result}`. The `result` includes a full `tool_uses` list — every `tool_use` block the assistant emitted, in stream order, with id/name/input. Even though built-in tools execute in-process and aren't policy-gated through CAR yet, there's a complete after-the-fact audit trail.
- **Policy gating (stage 4b, future)**: full pre-execution gating of each `tool_use` requires invoking the agent through a CAR-managed MCP server, not the default stream-json route. That's deliberately deferred — observability + audit ship first.
- See `docs/proposals/external-agent-detection.md` for the full architecture and Phase 2 design notes.


{% endraw %}
