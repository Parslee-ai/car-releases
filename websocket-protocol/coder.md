{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### coder

The built-in coding agent. The user states an intent; the daemon turns it
into a **verifiable outcome contract** (shell commands that must pass),
provisions a throwaway **git worktree** of the repo (under `~/.car/coder/`,
never inside the user's checkout), and works until the contract is green —
natively (CAR inference + policy-gated tools) or by delegating to a detected
external CLI (Claude Code / Codex / Gemini) — either as a single session or
through **foreman** (the verified parallel orchestrator, see the `foreman`
namespace above): decompose, farm subtasks to the CLI in parallel worktrees,
gate each patch + the integrated union, then land the verified union in the
session worktree. Auto routing is foreman-first for broad tasks; the fallback
ladder is foreman → single-session external → native (foreman declines
cleanly on `prefer_single_session`, an invalid plan, or a rejected gate; a
red contract after foreman's union falls to the native loop, which repairs
*on top of* the applied work). Whichever engine ran, **CAR re-evaluates the
contract itself** before asking for merge approval. Approved results are
published as a `car/coder/<short-id>` branch in the user's repo; the user's
checkout, index, and refs are otherwise untouched. Session snapshots persist
at `~/.car/coder/<session_id>.json`; an audit event journal sits alongside as
`<session_id>.events.jsonl`.

**Security model** — read before extending. The native engine's `shell` tool
executes on the **host** with the daemon's privileges and (deliberately) the
real toolchain + network. An inspector chain (native engine only — the
governed assistant in `assistant/governance.rs` keeps its own, wider chain)
denies the unambiguous footguns (`git push`/remote mutation, history rewrite,
`sudo`/`doas`/service managers, destructive ops and writes outside the
worktree, credential-path reads) and every route that would publish the work
around the merge gate: the forge CLIs (`gh`, `glab`, `hub`) are reduced to a
read-only allowlist — `pr view`/`list`/`diff`/`checks`, `run view`/`list`,
`issue list`, `gh api` GET, `auth status` — so `gh pr create`, `gh pr merge`,
`gh release create` and `gh auth token` come back as denials, and
`npm`/`cargo publish`, `gem push`, `twine upload`, `docker push`/`login` are
denied alongside them. The executor pins the working directory to the worktree — but this is policy
hardening, **not a sandbox**: a model can still e.g. pipe curl to sh inside
the worktree. The hard stops are the two human gates: `coder.confirm_contract`
before any work starts and `coder.approve_merge` before anything reaches the
repo. For the **external** and **foreman** engines, the coder threads the
daemon's bound MCP URL into the delegated CLI: its **CAR-namespace** tool calls
(`memory_*`, `verify`, `skill_*`) route back through the daemon's policy +
shared memgine — gated and audited — exactly like a direct `agents.invoke_external`
call. The residual limitation is narrower than before: the CLI's own **built-in**
tools (Edit, Bash, …) still run with the CLI's permissions inside the worktree
(external-agents stage 4b is pending), so the pinned cwd, the independent
contract re-evaluation, and the merge gate remain the containment for those.
When the daemon has no MCP listener (`--mcp-bind disabled`), CAR-namespace
calls degrade to ungoverned and delegation continues unchanged. Adapter caveat:
MCP injection currently covers the **claude-code** and **codex** adapters; the
**gemini** adapter does not yet support `--mcp-config`, so a Gemini-backed
external/foreman session runs with the CLI's built-in tools only and no
CAR-namespace tools — contained by the same pinned cwd + contract re-eval +
merge gate as the built-in tools.

State machine: `created → contract_proposed → contract_confirmed → running →
verifying → needs_approval → merged`, with `verifying → running` for a repair
round and `failed` / `abandoned` reachable from any
non-terminal state (`coder.cancel` → `abandoned`).

Independent verification begins only after the runtime's contract checks are
green. Each round creates a frozen copy and a fresh verifier conversation. The
verifier can probe that copy and submit one `PASS`, `FAIL`, or `UNPROVEN` grade
per stable outcome id. `PASS` requires recorded command evidence; Page outcomes
also require an Interceptor macOS walk and an image the verifier opened, while
Artifact outcomes require a complete read of the produced document. `FAIL`
requires a probe whose observed exit code misses its expectation. `UNPROVEN`
requires a typed network, credential, tool, Interceptor-session, or manual
prerequisite. A prerequisite whose descriptive fields are all blank counts as
absent on `PASS` and `FAIL`; `UNPROVEN` still requires a real prerequisite, and
the payload-free `InterceptorSession` variant remains real.

Every verifier `shell` probe carries a required `outcome_id` (or the literal
`"_unscoped"` for exploration no grade may cite), and a grade cites only probes
recorded under its own outcome. The verifier's shell has no credentials, no
keychain, and a throwaway HOME, and it may write only its working copy and
its evidence store: it cannot write the shared cargo target directory, the
system temporary directories, or anything else, so it cannot re-run a build
the way the builder's checks ran it. Contract checks are graded through
`run_check {outcome_id, check}` instead. It runs one contract check, by name:
any check a frozen outcome names that declares no credential, and any check
whose every declared credential the operator approved (supplied contract or
`coder.confirm` `approved_credentials`), with only that approved credential
injected. The verifier input lists those names as `approved_checks` and maps
each outcome to the check that backs it as `outcome_checks` (outcome id to
check name); the verifier is instructed to call `run_check` first for every
outcome in `outcome_checks` and grade from its result, using its shell only
for further independent probes and for outcomes no check backs. It never runs the verifier's working copy: each call
materializes a fresh checkout of the graded tree id from a runtime-owned
repository the verifier's shell cannot reach, re-hashes what landed on disk and
refuses unless it is that tree id, and runs it with a
throwaway HOME and the same real-home credential-store denies as the
verifier's shell. In a repository the operator trusts (the session's pinned
`coder-trust.toml` decision), `run_check` instead runs with the credential
posture the builder's contract checks get in that repository: the real HOME,
the macOS keychain and securityd, the real `~/.azure` and `gh` config, and
git's credential helper. On macOS that posture also includes ordinary
dependency network access, so a check that needs a signed-in `az` or `gh`
session or an uncached package can pass in an unattended run. Linux does not
turn repository trust into a network grant: builder shells remain in a private
network namespace so the daemon's host-loopback ports stay unreachable, and
`run_check` remains unavailable there as described below. A trusted check may
also write the Azure CLI's config directory (`AZURE_CONFIG_DIR`, else
`~/.azure`), which `az` rewrites on every call. There, a contract check that
declares no credential is also runnable when a frozen outcome names it. Every
other property below still holds in a trusted repository, the private
TMPDIR and CAR_HOME included (they are per-run directories whichever HOME the
check uses). On macOS they live in a short random mode-0700 directory under
canonical `/tmp` (`/private/tmp`), and `run_check` refuses before launch if the
CAR_HOME or TMPDIR socket path would exceed the platform's `sun_path` limit.
The verifier's own shell never gains that posture: the real
`~/.azure` and any `AZURE_CONFIG_DIR` are among the stores it cannot read. On macOS the verifier's shell may write only to its working
copy and its evidence store (which holds its throwaway HOME and a private
TMPDIR); Seatbelt denies every other write, the real HOME, shared `/tmp` and
caches included, so nothing it writes can land on a check's PATH. The check's
checkout is writable, as the builder's worktree is, so a check that writes into
its own tree (`npm pack`'s prepack, generated sources) behaves the same; only
that `run_check` may write it, and each call gets a new one. `run_check` may
write a fresh check-private Cargo target copied from the repository-keyed
trusted baseline target store. Its Cargo home is a stable repository-keyed path
under the daemon state root. The baseline publisher and every `run_check` take
that path's exclusive lock for the whole protected run, remove the previous
materialization, and seed it without credential files from the pristine
operator Cargo home. Protected checks for one repository therefore serialize,
cannot observe one another's Cargo-home writes, and retain the registry source
pathname Cargo needs to reuse trusted target fingerprints. A lock wait that
exhausts the check's own budget is an infrastructure failure, not a red check.
Builder children are always write-denied the stable Cargo-home path; only the
protected check process receives the exact temporary carve-out. On Linux hosts
without CoW, the existing cold empty or full-copy behavior remains, now at the
stable path. The verifier's shell can write
neither Cargo location and cannot read the target or protected Cargo home.
Each `run_check` tree also gets the resolved SwiftPM dependency state
(`.build/repositories`, `checkouts`, `artifacts`, `registry`,
`workspace-state.json`) of every remotely pinned package, cloned from the
operator's checkout and relocated, because the check has no network to fetch
it. When a check fails, a package whose pins that checkout cannot satisfy is listed
in the result's `dependency_preparation` array with the `swift package resolve` fix; see
`docs/car-code-task.md`.
`run_check` never reads a `.cargo/config.toml` inside the graded tree to decide
what it may write. It gets a private TMPDIR and CAR_HOME outside every verifier-writable directory,
and points `npm_config_cache`, `npm_config_logs_dir`, `PIP_CACHE_DIR`, and
`XDG_CACHE_HOME` into that private directory. It grants no write to HOME for
those caches; the existing Seatbelt write roots and read rules are unchanged.
It refuses if the PATH it will actually receive (the daemon's plus the
user's login-shell entries) has an empty, relative, or verifier-writable
entry. Hardlinks out of the working copy are refused by the same write
confinement. It
needs verifier isolation and that write confinement; where either is missing
(Linux and Windows today) `run_check` refuses. The builder's shell is
unaffected.
Any other name is refused. The run is recorded as a probe with
`check: "<name>"`; replay re-runs such a probe through `run_check`. Two limits
are inherent to operator-approved checks and are not new here: the check's
script comes from the delivered tree, so the builder wrote it; and redaction
replaces the exact credential value, so output that transforms the value
(reversed, encoded, split) is not caught. Approve a credential only for a
check whose script you trust.

An outcome the verifier leaves ungraded is recorded `UNPROVEN` with
`no_verdict: true`, no prerequisite, and a running `missed_verdicts` count.
It is re-verified in the next round (at once, in a fresh round, when nothing
else is red). An outcome left ungraded in any two rounds in total, consecutive
or not, ends the session as `failure_kind: "verification"` with a reason
naming `verifier gave no verdict for <ids>`. A verifier round has no turn
budget: it ends when every outcome is graded, when the verifier stops calling
tools, or after 30 consecutive turns that grade no outcome for the first
time (the builder's no-progress limit); new probes, re-grades, and flipped
verdicts do not count as progress.

If the runtime cannot build the frozen copy it grades from (a directory, git,
or tar step fails), the session ends as `failure_kind: "infrastructure"` with
a reason beginning `verifier infrastructure failure` — the delivered tree was
not graded, so this is not a verdict on the code, and the workspace is kept.
Delivered inputs that cannot be frozen as given (a nested Git repository)
still end as `failure_kind: "verification"`.

A red round returns the session to `running` with outcome-scoped repair text.
Before round 2 or later, CAR replays every prior FAIL reproducer in the new
frozen copy; one that still fails ends the session as `failure_kind:
"verification"` without starting the next verifier. A builder may answer a
prior UNPROVEN outcome with the native-only `cannot_show_here {outcome_id}`
tool. CAR tests a satisfiable prerequisite itself; a newly runnable probe that
still fails becomes a FAIL for the next repair round. A declared outcome also
gets one fresh verification pass. If it is raised UNPROVEN again, the existing
headless stuck stop ends the session instead of cycling through the builder.

All-PASS rounds continue to a read-only audit. Its serving model must attest a
vendor different from the builder's actually served vendor, and it is never an
Anthropic model. Each finding has `kind: "defect" | "challenge" | "note"`.
For legacy replies, missing `kind` plus a non-empty trimmed `reproduction`
means `defect`; otherwise it means `note`. Explicit notes never execute a
reproduction. A known outcome id remains scoped, and a recorded scoped probe id
maps to its outcome. Missing, unknown, and unscoped ids instead use the reserved
`_audit_session` grade, preserving the original id in the claim. Defect
reproductions run only through the confined verifier shell (`_unscoped` for a
session defect): non-zero makes the affected grade FAIL, while zero, a tool
error, or no reproduction makes it UNPROVEN with a Manual prerequisite.

A challenge says a PASS lacks proof. A session challenge applies to every PASS
outcome. Each challenged outcome gets at most one fresh verifier round, whose
runtime-owned input carries `audit_challenges: [{outcome_id, reason}]`; PASS is
accepted only when it cites a probe recorded in that round. Otherwise the
runtime makes it UNPROVEN with the reason as a Manual prerequisite. A repeated
challenge after that recorded round goes directly to UNPROVEN and the normal
builder repair/stuck-stop path. Challenges on already FAIL or UNPROVEN outcomes
are recorded without opening another round.

An audit question may carry `outcome_id` and has
`what_would_decide: {read: string[], run?: string}`. Reads stay inside the
frozen tree or the allowlisted probe-evidence layout, and typed runs use the
confined verifier shell. Legacy free text is accepted for persisted sessions,
but is never executed; existing repo-relative file paths are extracted and
read. One follow-up resolves all current questions. Notes, questions, and blind
spots use the replacement reply, but defects and challenges are sticky. CAR
assigns each blocker a stable `defect_id`; omission does not remove it. Only
`withdrawn: [{defect_id, reason}]` with an existing id and non-empty reason
removes one, and the attestation records `{defect_id, claim, reason}`. Invalid
withdrawals remove nothing. Follow-ups are stably deduplicated and stop when no
question remains, no request is new, or three rounds have run.

`coder.get` exposes the current `verification: {round, grades, probes,
isolation, audit?, challenge_reverifications}` receipt, including notes,
withdrawals, remaining unresolved questions, and each challenge outcome/reason
with the round that re-verified it. `coder.approve_merge`, checkout delivery,
branch delivery, and headless PR publication re-check that every grade is PASS,
isolation is sandboxed, the audit has neither defects nor unanswered
challenges, and its vendor differs from the builder. Notes, valid withdrawals,
and unresolved sensitivity questions remain recorded but do not block delivery.

The legacy live fixture intentionally no longer delivers: its kindless
machine-1 and machine-4 reproductions exit zero, so both outcomes are UNPROVEN.
Its kindless `_unscoped:probe-1` finding has no reproduction and remains a
session note. Relabeling the affirmations as explicit notes delivers and keeps
the notes and unresolved question on the receipt.

There is a second, non-failure terminal: **`reported`**. It means the session
concluded that *no code should change* and the runtime accepted that — a correct
outcome with no diff, rather than a loss. Reaching it requires a contract the
session's own model did not author (operator-supplied, human-confirmed, or
runtime-generated) whose every check already passed against the untouched
worktree. A conclusion that needs human judgement instead parks at
`needs_approval` and is never auto-promoted.

**The daemon does not yet produce `reported` itself** — only `car code-task`
does. It still appears on this surface, because a CLI-run session persists its
snapshot under the same `~/.car/coder` state root the daemon merges into
`coder.list`, so a client must already tolerate the value. The daemon-side gate
for accepting or rejecting a parked finding is not implemented; until it lands,
a `needs_approval` session on this wire is always a merge gate. The worktree is removed on
terminal transitions (unless `keep_workspace_on_failure` is set — see below —
in which case a `failed` session's worktree is retained for postmortem).

**Operator config (`~/.car/coder.toml`)** — an optional, tolerant TOML file the
operator can drop next to the coder state dir to tune a handful of knobs. A missing
file, a missing `[coder]` table, or any missing key falls back to the documented
default; empty and zero values follow each key's semantics below. A malformed
file is logged and treated as absent (the daemon never fails to boot over it).
`CAR_CODER_CONFIG` overrides the path (for
tests/embedders), mirroring `CAR_CODER_STATE_DIR`.

```toml
[coder]
engine_preference = ["claude-code", "codex", "gemini"]  # external/foreman delegation order
keep_workspace_on_failure = false                        # keep the worktree for postmortem
default_max_iterations = 0                               # 0 = unlimited; positive values are explicit caps
model = "parslee/reasoning"                              # session model pin; coder.start's `model` overrides
verifier_model = "parslee/reasoning"                     # omitted = the builder model
auditor_model = "auto"                                   # Kimi K3 via OpenRouter first, Parslee last; never Anthropic
max_session_wall_secs = 0                                # 0 = unlimited; positive values are explicit caps
max_agent_build_wall_secs = 600                          # Agent-build ceiling; 0 keeps contract value
max_check_timeout_secs = 0                               # 0/unset = no per-check ceiling
silence_window_secs = 900                                # 0 disables the silence watchdog
no_progress_turn_limit = 30                              # 0 disables the no-progress rule
max_replay_events = 2000                                 # reconnect replay per live session; 0 = unlimited
max_sessions = 200                                       # session-snapshot retention; 0 = unlimited
max_session_age_days = 30                                # 0 = unlimited
max_shared_cache_age_days = 30                           # baseline targets + protected Cargo homes; 0 = unlimited
```

- `engine_preference` — the order in which a *ready* external CLI is chosen for
  `auto` / `external` / `foreman` routing; the first ready entry wins (a ready
  CLI outside the list still beats nothing). An empty list falls back to the
  built-in `["claude-code", "codex", "gemini"]`. One detected adapter is never
  eligible here, in the list or through the outside-the-list fallback:
  `mini-swe-agent` is the `coder-ab` measurement baseline, so only an explicit
  `engine: "external:mini-swe-agent"` reaches it. Routing a real task to a
  control arm is choosing the control as the product.
- `keep_workspace_on_failure` — when `true`, a session ending `failed` keeps its
  throwaway git worktree on disk (the RAII reap is suppressed) and emits a
  `coder.event` error noting the retained path; `coder.get` still reports
  `workspace_path`. Default `false` (reap, same as every other terminal state).
- `default_max_iterations` — the iteration cap `coder.start` uses when the
  request omits `max_iterations`. Default `0` (unlimited); a positive value is
  an explicit cap. A capped run that reaches it ends with
  `failure_kind: "budget_exhausted"`, and its reason names the iterations used
  and the cap.
- `model` — pins the session's inference model; `coder.start`'s `model` param
  overrides it, and a blank value here is "unset", not "pin blank". Unset =
  adaptive routing. A pin sets `strict_model`, so a pinned session does not
  degrade to another model on an outage — it fails, which is what keeps a
  paired A/B honest. The pin applies to whichever engine runs the session (the
  native loop reasons on it; an `external:<agent_id>` session forwards it to
  the CLI) — foreman is the exception, since its farmed workers run their own
  configured backbones. Nothing validates the value against CAR's catalog,
  deliberately: on the external rung it belongs to the CLI's namespace.
  **The self-heal loop reads this key**: `heal.toml`'s `coder_model` is passed
  as `coder.start`'s request pin, so leaving that unset makes THIS the model
  heal's coder runs on, and heal's assembly check refuses the configuration if
  it resolves to a review seat.
- `verifier_model` — pins each fresh independent-verifier round. When omitted,
  the verifier uses the builder model but receives an empty conversation and
  only the frozen intent, outcomes, and verifier tools. It never receives the
  builder plan, tool-call ids, repository instructions, or diff narrative.
- `auditor_model` — selects the read-only cross-vendor auditor. `"auto"` tries
  Kimi K3 through OpenRouter (`openrouter/moonshotai/kimi-k3`, vendor
  `moonshot`) first, then Google, then any other non-OpenAI OpenRouter family,
  then a Parslee route: `parslee/openrouter/frontier-general` (GPT-5.4),
  `frontier-multimodal` (Gemini 3.1 Pro), `open-multimodal` (Kimi K2.5),
  `open-reasoning` (DeepSeek V3.2), then any other curated
  `parslee/openrouter/*` alias. Parslee comes last so a personal key keeps the
  auditor it had, while a signed-in operator with no key still gets one: an
  Anthropic builder is audited by GPT-5.4, an OpenAI builder by Gemini 3.1 Pro.
  **`"auto"` never selects a local auditor** (MLX, Apple Foundation, or any
  other on-device model) under any key configuration; a local auditor runs only
  when `auditor_model` names it explicitly. **Anthropic models are never
  eligible**, in any form — an `anthropic/*` API key, an
  `openrouter/anthropic/*` model, a Parslee alias that resolves to Claude, or
  the `claude` CLI and Claude subscription: `"auto"` skips them, an explicit
  `auditor_model` naming one is refused with an error that says so, and a
  response served by one is refused. API-backed candidates require their key
  in the daemon process's environment, so `OPENROUTER_API_KEY` must be visible
  to the daemon for the preferred auditor; when nothing is eligible the refusal
  names `OPENROUTER_API_KEY` as the missing key and a Parslee sign-in
  (`car auth login`) as the no-key alternative. **A Parslee route's vendor is
  its upstream, as the curated catalog records it**, never the Parslee
  aggregator: that upstream must differ from the builder's and must not be
  Anthropic. Its credential is the operator's Parslee sign-in, judged the way
  the inference registry judges it (signed in, the gateway serving OpenRouter
  routes, the credential not rejected), not an environment key; the token
  itself is read only when the audit call is made. The capability routes
  `parslee/reasoning`, `parslee/advisor` and `parslee/fast` are routed by the
  gateway as it sees fit and have no recorded upstream, so they are refused
  with an error saying the catalog does not record their upstream vendor.
  A Parslee route's attestation rests on that curated alias-to-upstream
  mapping: CAR sees which alias served, not what the gateway ran behind it. On
  the builder side, a builder on a curated alias is placed by the same
  recorded upstream, and a builder on a capability route is placed as OpenAI
  by assumption (what those routes have served), not by a catalog record.
  ChatGPT/Claude subscriptions, `openai-codex/*`, CLI transports and any
  non-Parslee OAuth transport are never eligible. Delivery requires the
  served model's vendor, not merely its requested alias, to differ from the
  builder's served vendor. For an `external:<agent_id>` or `foreman:<agent_id>`
  session with an empty `authored_by`, the builder's vendor comes from what the
  CLI ran: models its stream reported (Claude Code's `system`/`init` `model`
  and assistant `message.model`, `<synthetic>` skipped), else the session's
  `model` pin for a single-session external run, else the CLI's own vendor
  (`claude-code` Anthropic, `codex` OpenAI, `gemini` Google). That last rung
  applies only when the CLI ran without its user's configuration
  (`isolate_external_network`, or a bound session): Codex reports no model and
  its `config.toml` can route it to any provider, so an unpinned, un-isolated
  Codex session is refused. A reported model absent from the catalog is placed
  by its name (`claude-opus-5-5`); Bedrock/Vertex-style ids such as
  `us.anthropic.claude-…` are not placed and are refused. Evidence that cannot
  be placed, spans two vendors, or contradicts the CLI's vendor is refused, as
  is an unknown CLI that reported nothing, and a distributed foreman run, whose
  fleet workers' streams this host never sees. Those models are not added to
  `authored_by`. Known gap: when foreman's union is repaired by the native
  loop, the native model alone decides the builder's vendor.
- `max_session_wall_secs` / `max_agent_build_wall_secs` — end-to-end wall
  clocks. The ordinary coder fallback ladder defaults to `0` (unlimited); a
  positive value is an explicit cap whose `budget_exhausted` reason names the
  elapsed time and cap. An Agent-project build defaults to a 600-second
  operator ceiling across
  credential discovery, spec generation, every repair attempt, and every
  scenario. A confirmed contract may lower that Agent-build deadline, but it
  cannot remove or raise a positive ceiling. An Agent-build value of `0` is the
  operator's explicit choice to keep the contract's positive timeout, with a
  missing or zero contract timeout meaning unlimited; ordinary-session `0`
  remains unlimited. The synthesized `agent_scenarios_pass.timeout_secs` is
  the configured Agent-project value at synthesis time. The ceiling is read
  again when the build starts, so if the operator lowers it between synthesis
  and confirmation, the enforced deadline is the lower current ceiling, not
  what the card showed (raising it later has no effect on a card that already
  carries the lower value). At expiry the session ends as `failed` with
  `failure_kind: "budget_exhausted"`, a failed timed-out
  `agent_scenarios_pass` result, and retry/config guidance, and the build's
  in-flight model call is dropped. That stops the work on the default paths:
  on-device generation in the inference worker is killed with its worker
  process, and a remote request is cancelled. The in-process fallback (worker
  disabled with `CAR_NO_INFERENCE_WORKER=1`, or unable to start) and
  FoundationModels cannot be interrupted mid-decode, so that generation
  finishes in the background: in-process MLX within
  `CAR_LOCAL_DECODE_TIMEOUT_SECS` (300 seconds by default) plus prefill;
  in-process Candle, off Apple Silicon, is bounded only by `max_tokens`; and
  FoundationModels whenever the framework call returns.
- `max_check_timeout_secs` — optional operator ceiling for one outcome-contract
  check. Unset or `0` means no ceiling. A check's own `timeout_secs`, when
  present, is still honored; when both exist, the lower explicit cap wins.
- `silence_window_secs` — maximum time without runtime-owned progress. Default
  `900`; `0` disables it. It is the ordinary coder's only default time-based
  stop. For external and foreman engines, a streamed CLI line is output but is
  not progress; a change in that CLI worker's pinned worktree is progress (the
  runtime checks the same Git status-plus-diff fingerprint used by the native
  loop, at most once every five seconds). Streamed output inside the silence
  window that just elapsed, without a worktree change, ends with
  `failure_kind: "no_progress"`. No output inside that window remains
  `failure_kind: "stalled"`, even if an older line preceded it. A contract check,
  or a command the native builder runs through its `shell` tool, that
  produces no output for the window is killed and returns `timed_out: true`
  with an output line naming the silence window. The builder's `shell` has no
  default wall-clock limit and no ceiling: a command that keeps printing runs
  until it exits, and a `timeout_secs` the model passes explicitly is honored as
  given. `0` disables both watchdog outcomes.
- `no_progress_turn_limit` — consecutive agent turns that may leave the
  worktree unchanged. Default `30`; `0` disables it. A turn counts as a change
  only when it reaches a worktree state the session has not produced before,
  so flipping a file between two contents is not progress, within one iteration
  or across many. Known limit: a builder that writes a genuinely new state every
  turn (a new random file each time) counts as progressing, and each changed
  worktree also counts as activity to the silence watchdog, so only the
  operator's cancel stops it. Reaching the limit ends
  the session with `failure_kind: "no_progress"`. This turn-based limit applies
  to the native loop; external and foreman engines use the one-silence-window
  output-without-worktree-change rule above.

The standalone `car code-task` command accepts `--silence-window-secs` with the
same default and zero semantics. In `--json` mode, `check_started` carries
`index`, `total`, and `progress: "check i/N"`; terminal `run_end.failure_class`
may be `stalled` or `no_progress`. Human mode prints `check i/N: name`.

- `max_replay_events` (car#1311) — the per-live-session in-memory reconnect
  window. Default `2000`; `0` disables the cap. It is read when a session starts,
  so changing the file affects new sessions. This does not change sequence
  numbers or the durable event journal: trimming removes only the oldest events
  available for immediate WebSocket replay, and `coder.subscribe.events_skipped`
  names the resulting gap.
- `max_shared_cache_age_days` — age retention for repository-shared build
  caches under `coder/baseline-targets/` and `coder/protected-cargo-homes/`.
  The default is `30`; `0` disables the cap. A successful baseline-target seed
  refreshes its store age, while protected Cargo-home materialization naturally
  refreshes its directory, so the limit measures last successful use rather
  than creation. The sweep runs at daemon boot and joins the at-most-hourly
  coder retention sweep thereafter. It takes each store's nonblocking exclusive
  reader/writer lock and skips a live cache. GC removes the cached payload but
  keeps the store directory and lock file: unlinking an open lock would let a
  second process lock a new inode while the original user still holds the old
  one.
- `max_sessions` / `max_session_age_days` (car#1310) — retention for the coder
  state dir, GC'd at daemon boot (right after orphan adoption, beside the
  equivalent `[runs]` pass for run traces) **and thereafter amortized onto
  `coder.start`, at most hourly** (car#1346's sibling, car#1339). Boot-only
  meant the effective bound was `max_sessions` plus everything created since
  the last start, and on a daemon that supervises agents for weeks the age cap
  never fired between restarts at all.

  The mid-lifetime sweep differs from boot's in two ways. It skips any id the
  in-memory session registry still holds — deleting a snapshot under a live
  entry does not free anything, it pins that entry in memory forever, because
  the in-memory prune reads a missing snapshot as "keep the entry rather than
  lose the session". And it does **not** sweep orphan journals: a CONCURRENT
  `coder.start` registers itself after the sweep has read the live set, then
  emits its first event — which is what opens the journal — so it has a
  journal, no snapshot yet, and no entry in the set the sweep is holding. A
  snapshot caught in that race is saved by carrying a non-terminal state; a
  journal carries no state at all, so nothing can exempt it. At boot the
  registry is empty and neither restriction applies.

  Because registered sessions are filtered out before the count cap ranks
  anything, the mid-lifetime bound is `max_sessions` plus whatever is still
  registered, not `max_sessions` flat. And `car code-task` writes into the same
  directory from its own process, where there is no registry to consult, so
  that population is still swept only at daemon boot.

  Defaults `200` and `30`. A
  nonzero collection is logged at `info` with both caps, because this policy is
  new and applies retroactively — the first boot after an upgrade can delete
  years of snapshots under caps the operator never chose.

  **`0` disables a cap**, here and in `config.toml`'s `[runs]`. The two used to
  disagree — run-trace retention read `0` literally, so `max_per_agent = 0` or
  `max_age_days = 0` deleted every collectable run instead of keeping it — which
  made carrying what you learned from one file to the other a silent data loss.
  car#1338 settled it in favour of "no cap", the meaning `max_session_wall_secs`
  already had.

  Nothing pruned this directory before, so `<id>.json` and the larger
  `<id>.events.jsonl` beside it accumulated for the life of the installation —
  and `coder.list` pays a read, a parse and a `stat` for every session ever run
  on every call. The journal is unlinked first and the collection counted on the
  snapshot: only `*.json` is enumerated, so a journal whose snapshot went first
  and whose own unlink then failed would be stranded permanently. A separate
  boot-only pass sweeps journals already stranded that way — a `coder.start`
  opens the sink's journal before anything persists a snapshot, so a start that
  dies in between leaves one nothing else can reach.

  Two exemptions, both about not destroying CAR's only record of something that
  still exists. A session that is not terminal is never collected — the same
  rule run-trace retention applies to an in-progress run, and it covers
  `needs_approval`, which is deliberately non-terminal because a change waiting
  on a human is not garbage however old it is. And a session whose `worktree` is
  still a directory is never collected: the snapshot is the only thing that
  names it, so dropping it would turn a worktree an operator kept
  (`keep_workspace_on_failure`) into an unattributable leak. Adoption now reaps a
  CRASH orphan's worktree when rewriting it to `failed`, which is what a live
  terminal transition would have done — otherwise every daemon crash would add a
  permanently exempt snapshot, journal and git checkout.

  **`max_sessions` bounds what retention manages, not the directory.** The count
  cap ranks only collectable sessions, so an exempt one neither dies nor consumes
  a keeper slot — an install running `keep_workspace_on_failure` holds every
  failed session's snapshot, journal and worktree on top of the cap, by its own
  request, and a preserved `needs_approval` orphan is permanent by construction.

  It also bounds what is RETAINED, not what one call reads: `coder.list` still
  returns every retained session, so retention caps that cost at O(retained)
  rather than removing it, and `max_sessions = 0` does not bound it at all. (The
  run store answered its read arm separately, with a paged summary index.)
  Bounding this response is a wire change with its own paging question and is not
  folded in here. Note the board's 4 s poll is `coder.watch { renew: true }`,
  which builds no summaries — the whole-directory scan fires on connect and on
  resync, not on the poll.

  Boot-only, matching the run store. The in-memory registry's equivalent
  (car#1262) instead amortizes onto `coder.start`; doing the same for disk needs
  a live-id filter to avoid deleting a snapshot underneath a registered session,
  and is tracked as car#1339.

#### `coder.start`

While preparation is in progress, live `created` summaries expose optional
`preparation_status` text. It reports the current drafting or coverage-review
stage, or the baseline check being run. It is absent/null for persisted or
non-preparing tasks; clients must not interpret it as a percentage or an ETA.
The runtime emits `preparation_started` events with `stage` and optional `model`
fields before drafting/review inference, including retries. Baseline execution emits
`baseline_check_started` with a check `name`, distinct from work-verification
`check_started`/`check_completed` events. Both preparation event types notify board
watchers. Older daemons may
omit this field; clients should retain a generic preparation message.

For native raw-repository and app tasks, the effective model pin also applies
to every initial contract-derivation lane and `coder.revise_contract`. Those calls use strict
selection, and an unparseable-reply retry re-asks the pinned model instead of
rotating away from it. An external
engine's model name is not forwarded to CAR's planning router because it belongs
to the external CLI's namespace. A saved `coder.discuss.start` model choice
also controls conversation replies and supplies the default for linked native tasks.

- **Params**: `{ repo?: string, project?: string, intent: string, contract?: OutcomeContract, contract_source?: "supplied"|"derived", subscribe?: boolean, headless?: boolean, engine?: "auto"|"native"|"external[:<agent_id>]"|"foreman[:<agent_id>]", max_iterations?: number, distributed?: boolean, browser?: boolean, lattice?: { project: string, capabilities: string[], display_name?: string }, isolate_external_network?: boolean, workers?: string[], repair_invokes?: number, transient_retries?: number, model?: string, discussion_id?: string, base?: string, trust_source_repo?: string, organization_id?: string, personal?: boolean }` — **exactly one of `repo` (a raw git path) or `project` (a managed-project slug)**. `contract_source` defaults to `"supplied"`; `"derived"` requires `contract` and records the caller-provided contract as model-derived, so its checks start with network denied and no approved credentials and receive the same headless holding behavior as daemon derivation. Unknown values and `"derived"` without `contract` are invalid params. `subscribe` defaults to `false`; when true, the daemon registers the calling connection for the new session before derivation starts, so `outcomes_step`, `outcome_dropped`, and `outcomes_written` notifications can arrive while the start RPC is pending. Those notifications carry the new `session_id`, letting the caller reconnect if the eventual response is lost. A later `coder.subscribe` on that same connection is idempotent and does not replay those events. `headless` defaults to `false`. When true, no person is available at the terminal: an action the existing policy allows still runs without entering the approval gate, an approval-required action is denied immediately with a headless explanation, and `ask_user` returns an immediate error. If its connection closes after the session id was published but before contract confirmation, the daemon keeps the session detached for its `silence_window_secs` (900 seconds by default; `0` disables expiry). `coder.subscribe { reattach_headless_start: true }` on a new authenticated connection reclaims the starter role and receives a pending start result. If no client returns, the existing disconnect reason cancels the session when that window expires. A disconnect before the session id is published still cancels because the caller has no resumable identity. A headless session watched by another client is not cancelled, and confirmation ends starter ownership; non-headless sessions are unchanged. Neither path emits `UserInputRequested` or waits for the 600-second answer window. A `project` session delivers to the project's `main` on approve (no `car/coder/<id>` branch); an `agent`-kind project synthesizes a scenario contract and runs the coder→agent build loop. `contract` is not valid for an Agent project because its synthetic scenario contract is the build definition. Its initial `agent_scenarios_pass.timeout_secs` comes from `[coder] max_agent_build_wall_secs` (600 by default). A confirmed card may shorten the Agent-build deadline but cannot remove or extend it past a positive configured ceiling; a configured `0` instead keeps a positive contract timeout and treats a missing or zero contract timeout as unlimited. The effective value enforces one deadline across generation, repair, and scenarios. (`engine` defaults to `auto`; `max_iterations` defaults to `~/.car/coder.toml`'s `default_max_iterations`, then `0`, meaning unlimited.) `model` pins the inference model for this session (e.g. `"parslee/reasoning"` for gpt-5.5), overriding `~/.car/coder.toml`'s `model`; blank/omitted = the config default, then adaptive routing. The pin applies to **whichever engine runs the session**: the native loop reasons on it, and an `external:<agent_id>` session passes it to the CLI (`codex -m`, `claude --model`, `gemini -m`). It previously reached only the native loop, so `--engine external:codex --model X` silently ran codex on its own configured default — which left the paired A/B's "both arms on the same backbone" invariant an unverified assumption rather than something the runtime enforced. The pin reaches the daemon-run coder over the wire, so a paired A/B (`car coder-ab`) can put both arms on one backbone without the daemon needing the pin in its own environment. `repair_invokes` and `transient_retries` tune the **external** engine's two budgets, both defaulting to the engine's own values: `repair_invokes` is the *hypothesis* budget (fresh repair invocations after a red pass — recurrence escalation needs >= 2 to reach the model at all, since round 1 establishes a failure signature, round 2 is the first that can repeat it, and round 3 the first that can be told), while `transient_retries` is the *availability* budget (re-invocations after the CLI process itself died mid-run). They are deliberately separate counters: sharing one lets a single flaky timeout consume a replan the coder needed for an actual hypothesis. `browser` defaults to `false`. With `engine: "auto"`, true selects the native coder loop; an explicitly external or foreman engine is refused because it cannot receive CAR's in-process tools. When true, the native coder loop receives the assistant's lazy Chromium tools (`browse_navigate`, `browse_click`, `browse_type`, `browse_scroll`, `browse_keypress`, `browse_wait`, `browse_observe`, `browser_await_answer`, `browser_await_signin`, `browser_record_start`, `browser_record_stop`). The option is a session-scoped approval for those exact full-access names, but it does not override an Agent Permissions `Deny` or any built-in/project policy rule. Every attempted call is recorded as the ordinary `tool_call` / `tool_result` pair. Each coder browser owns a fresh isolated profile, independent of assistant and standing-session profiles and of `CAR_BROWSER_PROFILE_DIR`. Cookies and sign-ins do not persist across coder sessions; the profile is deleted when its browser is dropped. When false or omitted, the browser tools are neither attached nor advertised. `lattice` joins the run to the CAR Lattice (see `lattice.join`) for as long as it executes: the daemon opens an `mcp:<peer-id>` peer identity for the run, declares the given project and capabilities with runtime `car-coder` (display name `mcp-<prefix>`, like any MCP session, unless supplied; the runtime is shown to the operator only), and offers the native loop the tools `lattice_wait` (at most 120 s per call), `lattice_find`, `lattice_nodes`, `peer_message`, `peer_inbox`, `lattice_claim`, `lattice_release`, and `lattice_claims` at the `read_only` tier, so the coder can be found by capability, answer questions, request reviews, and claim work beside Claude Code, Codex, and CAR agents. A verification round keeps the same identity. When the run ends the identity is closed, which drops its profile and unread inbox and releases its claims. Like `browser`, `lattice` makes `auto` select the native loop and refuses an explicitly external or foreman engine, which cannot receive the tools — run that CLI against the daemon's `/mcp` endpoint to make it a node instead. An invalid declaration fails `coder.start`. A join that fails at run time (for example, a `display_name` that collides with an agent that attached after the start) is logged by the daemon and the run continues without peer tools; it is not reported on the session event stream. The identity is released however the run ends — completion, `coder.cancel`, a watchdog abort, or a panic — and the peer tools refuse to act once it has. Omitted keeps the run invisible to nodes. `isolate_external_network` defaults to `false`; when true, an `external:<agent_id>` engine runs with no route off the machine — no web search or fetch tool, no browser, computer-use or app connectors, no MCP servers (CAR's own endpoint included), and a shell without network — via `agents.invoke_external`'s `isolate_network`. Codex and Claude Code support it; an engine that cannot guarantee it (Gemini, mini-swe-agent) refuses with a setup failure rather than running with the web. `car coder-ab` sets it for the external arm unless `--allow-external-web` is passed. An isolated session never runs a foreman farm-out: an explicit `foreman:<agent_id>` or `distributed` request is refused, and `auto` that resolves to foreman runs the same CLI as one isolated external session. `trust_source_repo` is an operator-authored GitHub URL or `owner/name` used only by replay clients; omit it for live sessions, which are trusted only from the canonical `repo` or resolved `project` path. `organization_id` runs the session in one organization a signed-in login holds and `personal: true` runs org-less work; passing both is invalid params. Omitted, the session binds the repository's `.car/config.toml` `[organization] id`, else the person's default org (`auth.default_context.*`), else runs personal (`car_context::resolve`). A default that cannot be used refuses the start and names the fix (`personal: true`): a `distributed` run (fleet workers do not carry an organization yet), a default no signed-in login holds any more, or a membership check that fails (offline, revoked). Nothing falls back to personal silently. A bound session may use the native engine or an external CLI that can run without its user's own configuration, which is Codex: a bound external session always runs with `agents.invoke_external`'s `isolate_config`, so the CLI loads none of its user's MCP servers, plugins, app connectors, settings or memory (which would carry org work into personal state) but keeps the web; `isolate_external_network` still removes the web when asked for. It is also given no CAR MCP endpoint, because that endpoint serves the personal memgine. Codex runs isolated (either way) only with a login an isolated home can carry (`CODEX_API_KEY`, or a file-stored `auth.json`); without one, a run naming Codex refuses at start with that remedy and `auto` runs native. Under `auto` a bound session that resolves to another external CLI runs Codex instead, or the native engine when no such Codex is available; bare `external` takes Codex or refuses; one that names `external:claude-code`, Gemini or mini-swe-agent refuses, naming `external:codex`, the native engine and `personal: true` — unless `isolate_external_network` was asked for, which runs Claude Code fully isolated as before. A foreman farm-out cannot be isolated, so a bound `auto` that resolves to foreman runs one external session, and an explicit bound `foreman:` refuses. `distributed` with a named or declared org is refused. A repository's org is a hard constraint: naming another org or `personal` there fails the start with a message naming the fix, as do an org no signed-in login holds and an unreadable repository declaration. Credentials are read only when an org is named or a default org is set. The decision runs before any repository, memory or provider work, and a bound session carries its context through inference, admission and recovery (`work_context` in the reply and on `coder.get`). Work that already has an owner keeps it, and passing `organization_id` or `personal` for it is refused: a conversation's retained task keeps the context in its own task snapshot (even in a repository that has since declared an org), a conversation keeps the context it recorded when it opened (subject to the repository's org), and a caller attached as an agent bound to a context keeps that context. A conversation saved before ownership was recorded binds nothing, so its runs resolve as above. An agent with no organization of its own runs personal work, never the person's default org, and naming an org is refused. Under a `PARSLEE_ACCESS_TOKEN` environment bearer, a named org or a declaring repository is refused rather than run personal.
- **Returns**: `{ session_id, state: "contract_proposed", engine, requested_engine, engine_ran, worktree, base, contract: { description, allow_credentials?, protected_paths?: string[], editable_paths?: string[], checks: [{ name, command, credentials?, expect_exit_zero, output_contains?, timeout_secs?, baseline?, differential? }] }, outcomes_path: string, outcome_groups: [{ group: "page" | "artifact" | "machine", outcomes: [{ id: string, text: string, check: string, network_approved: boolean, approved_credentials?: string[] }] }], outcome_count: number, dropped_outcomes: [{ kept: string, dropped: string, group: "page" | "artifact" | "machine", reason: string }], baseline, baseline_gates_nothing, journal_path, model, browser, repo_trust: RepoTrust }` — `id` is stable for the frozen outcome and defaults to an empty string when an older record is read. `credentials` declares uppercase environment names a check needs; declaration grants nothing. A supplied contract is operator-authored and approves its declarations. Model-derived and model-revised outcomes keep `approved_credentials` empty. Every local check and coder-model shell scrubs inherited credential names; only an exact approved check receives resolved values, secret store first and `$CAR_HOME/env` second. The model shell has no injection path. `allow_credentials` defaults to `false` and only removes `DenyCredentialAccess` from check command inspection; it does not grant an environment credential. `protected_paths` adds committed files, directories, or globs to the start-commit check surface; check commands add the committed test-logic paths they name through the same parser used by `car coder-ab`. `editable_paths` opts matching protected files into builder edits: checks run the builder's copy, but the change remains recorded as allowed. Files absent from the start commit are outside both lists' captured surface. A check's optional `timeout_secs` is an explicit wall-clock cap; absent means it runs until it exits, unless the silence watchdog kills it for producing no output. `baseline: true` marks a capture-only check, run once at session start with its output kept as a before-value; `differential: { baseline: "<capture name>", expect: "changed" | "unchanged" | { "delta_within": { "min"?, "max"? } } }` makes the runtime compare the check's output against that capture at every later evaluation (car#1067). These fields are additive with defaults; empty path and credential collections and false `allow_credentials` are omitted when serialized. — `journal_path` is the `car_eventlog` JSONL this session journals its actions to (subject to the coder state dir's retention — see `max_session_age_days` above; consume it before the session ages out) (per-tool `action_id`, `ActionFailed`/`TurnCompleted`/…), so a caller (e.g. `car coder-ab`) can attribute the run's failure mechanisms via `harness_adapt::diagnose` without guessing the state dir. `browser` echoes the effective opt-in. `model` is the **effective** native-loop pin (the per-session request, else the config, else `null` = adaptive routing). `requested_engine` echoes the requested engine before resolution; `engine_ran` is always `null` in this initial reply.
- Provisions the worktree, resolves the engine (auto = complexity assessment + detected-CLI preference, default claude-code → codex → gemini but overridable via `~/.car/coder.toml`'s `engine_preference`, delegating foreman-first for broad tasks), and derives the contract with a bounded model repair loop. Contract derivation has no fixed 120-second timeout; the silence watchdog stops a derivation that makes no runtime-owned progress. Foreman's gates split regression vs goal (#275): each subtask worktree runs a build-system regression check detected from the repo (`cargo check` / `go build ./...` / `swift build`; unknown build systems decline to single-session), while the integrated union runs the contract's plain exit-zero checks as the goal leg (`sh -lc "<check> && …"`). Output-substring checks are enforced only by the coder's final contract evaluation. Synchronous — expect seconds while the model drafts the contract.
- **Repository trust result:** the start result and every serialized session
  record (`coder.get` and each `coder.list` row) include
  `repo_trust: { trusted: boolean, basis: "repository_path"|"github_owner"|"github_repo"|"none"|"config_unreadable", key: string|null, subject: string|null, reason: string, sandbox_gap: string|null }`.
  Older session JSON defaults this object to untrusted. The daemon pins it at
  start; resume never re-evaluates it.
- The generic handler wall clock applies only until `coder.start` registers the
  session. Derivation and baseline checks are then silence-supervised, so
  healthy work may run past `CAR_HANDLER_TIMEOUT`. A terminal session whose
  response waiter remains stuck is abandoned with `-32004` after a two-second
  grace. `silence_window_secs = 0` leaves non-terminal waits unbounded but does
  not suppress terminal notification.
- **Already-satisfied result.** A model-derived contract that has authored
  outcomes but whose ordinary checks still all pass after the one baseline
  repair, with nothing held or listed under Not verified, does not return the
  success shape above. `coder.start` returns an
  error such as ``The repository already does this:
  `readme_documents_name_usage` passes on the untouched code. Nothing to
  change.`` The persisted session is `abandoned` with
  `failure_kind: "already_satisfied"`; every passing ordinary check is named.
  If any outcome is held or Not verified, the session instead returns the
  normal `contract_proposed` summary with that outcome visible, even when every
  runnable check passes before and after repair.
- `outcomes_path` names the private `<state_dir>/<session_id>.outcomes.md`
  review artifact. `outcome_groups` is the merged outcome list by user group:
  `text` is the user-visible outcome, `check` names its one contract check, and
  `network_approved` records whether an operator approved a network-reaching
  check; `approved_credentials` contains only declared names approved for the
  exact check. `outcome_count` is the sum of those outcomes. `dropped_outcomes`
  records each duplicate or contradiction removed by the merge, including what
  was kept and why the other outcome was dropped.
- A supplied `contract` is validated before a session or worktree is created.
  Validation problems are returned together. A valid supplied contract skips
  every derivation lane (`contract_derivation` is absent), is recorded with
  `outcomes.source: "supplied"`, and keeps every check — including network
  checks — operator-approved (`network_approved: true`) without applying the
  model/network filter. Its declared credentials are also operator-approved.
  CAR still runs the ordinary session-start baseline and
  reports `baseline_gates_nothing`; it does not ask a model to reassess an
  all-green supplied contract, because caller-owned checks run verbatim.
  Callers replaying a model-derived contract set `contract_source: "derived"`;
  validation stays identical, but the stored source is `fan_out`, network starts
  denied, and credentials remain unapproved. This is intended for headless
  evaluation parity, not for changing an operator-supplied contract's default.
- The outcomes file is written when the contract is proposed. Its sections are
  `Outcomes`, the intent, `Who uses this and how it is confirmed`, the populated
  Page/Artifact/Machine groups in that order, optional `Not verified by this
  contract`, and `Not in this version`. Every included outcome maps to exactly
  one check, and every check maps to exactly one outcome. Outcomes without an
  executable check appear under `Not verified by this contract`; deliberately
  deferred work appears under `Not in this version`. A proposed-contract
  revision reconciles and rewrites the file before confirmation; after
  `contract_confirmed`, its bytes never change. The early network classifier
  holds recognized network command words and URL schemes, including nested
  shell commands, but deliberately leaves interpreter source and redirected
  interpreter input to OS sandbox enforcement. An unapproved recognized check
  is recorded under Not verified and omitted from baseline and execution; it
  does not abort `coder.start`, revision, or restart adoption. If every check is
  held, the session stays `contract_proposed` and unchanged confirmation is
  refused until the operator approves a held check or adds an executable one. An
  outcome that promises specific printed or displayed text must pair with
  `output_contains` or a grep/test/diff-style output assertion in its command.
  Contract repair is asked to add that assertion; an unfixed outcome moves to
  Not verified instead of reaching the summary as verified. Internal repair
  prompt text is never used as fallback outcome prose.
  An
  enumerator or critic call that
  stays silent past the session's `silence_window_secs` counts as a failed
  attempt; `0` disables that per-call limit.
- **Thin-intent refusal (D-92).** A model-derived request is thin only when a
  completed enumerator-plus-critic fan-out authored zero outcomes before filtering/repair, or
  when the whole trimmed request is one of the small case-insensitive no-op
  forms (`fix it`, `make it better`, `do something`, `improve`, plus empty or
  near-empty equivalents). Any authored outcome is specificity evidence even
  when its check is held for network approval or shown under Not verified; a
  held-only contract therefore remains reviewable instead of being abandoned,
  but it cannot be confirmed unchanged with no executable check. The thin
  refusal is also disabled whenever any outcome is already under Not verified.
  Supplied contracts and Agent projects do not use this rule.
- The `car code` terminal client calls `coder.start`, then `coder.get` for the
  full outcomes record: `groups`, `not_verified` entries with their complete
  `check`, `dropped`, and `network_approved`. It shows a bounded summary and a
  single-key menu: `y` starts, `l` lists everything, `c` revises in plain
  English, `a` approves the exact held network checks, and `n` cancels.
  `car code --yes` prints the summary without prompting. A thin intent prints
  the daemon's refusal on stderr and exits 3; an already-satisfied intent prints
  the daemon's message on stderr and exits 2.
- **`distributed`** (car#1243, default `false`) farms this session's subtasks
  across every reachable CAR instance that can serve the repository, instead of
  this machine alone. It applies to the **`foreman` engine only** — nothing else
  decomposes a goal into independent subtasks, and a subtask is the unit a peer
  can be handed. Asked for on any other engine, the session runs locally and
  emits a `foreman: "not_distributed"` event naming the engine that ran, rather
  than silently ignoring the flag: a run that quietly drops it is
  indistinguishable from one that distributed and found no peers.
  - Off by default and never inferred by `auto`, because distribution spends
    agent quota on other people's machines.
  - The merge-verify **decision** does not move. A peer edits its own worktree
    and returns a patch; this host applies it, runs the union gate against the
    session's `OutcomeContract`, and decides, and delivery stays here too. A
    peer cannot widen what is accepted.
  - It **can** cause code to run here, and that is inherent to gating a patch
    rather than new in this change: verifying a peer's patch executes the
    repository's own build and test commands locally, so a `build.rs`, a
    proc-macro, or a test harness in that patch runs on the orchestrating host
    before any human sees a diff. Enrol only peers you would let run code on
    this machine — which is what enrolment already means (`fleet::serve` is an
    operator grant, limited to named repositories, audited per dispatch).
  - It offloads the **coding CLI**, not the build. Every subtask's regression
    check and the union contract run here, so a machine that cannot build this
    repository is not made able to by distributing it.
  - `workers` restricts placement to named instances, mirroring
    `foreman.run { workers }`; omitted means every instance that can serve the
    repository.
  - The pool is assembled inside the spawned run task, not at `coder.confirm`
    — it is a network round-trip per peer, and doing it at confirm made
    `coder.confirm_contract` block on the inventory timeout while the session
    was already `Running` with no task handle. A `foreman: "pool"` event
    reports which instances joined and `degraded` names why any were left out.
    An unreachable peer slows a run; it never refuses one, since the pool
    always contains this host.

    `pool_workers` on the session is that membership, PERSISTED (car#1346).
    The event reaches only a subscriber that was attached when it fired, and
    `workers` above is the operator's restriction filter rather than what the
    filter resolved to — so before this there was no durable record of which
    machines a run actually went to. It is written before any subtask runs,
    which is what lets it answer that question for a run that was cancelled,
    crashed, or is still going.
  - **Where each subtask actually ran** is recorded (car#1322), as TWO records
    that answer two different questions.

    `placements` on the session is the DIAGNOSTIC ledger: every subtask a worker
    was handed, as
    `{ subtask_id, worker, remote, failed_attempts: [{ worker, error }] }` — the
    same shape `foreman.run` reports, from the same type. Failed attempts belong
    here rather than in a run-level degradation note: a subtask that failed on
    one peer and succeeded on another produced a patch whose author is not the
    machine the plan first chose.

    `integrated_subtasks` is what actually LANDED in the worktree —
    `{ subtask_id, files }`, the files read off each applied patch by the gate's
    own parser. **Only this may back a claim about the delivered commit.** A
    placement is recorded when a worker RETURNS, which is before the per-patch
    gate rules on what it produced, so a fully populated ledger is compatible
    with zero fleet-authored hunks: `NothingAccepted` and `IntegrationRejected`
    both fall all the way back to a locally-authored diff. Crediting a peer there
    would be a false attribution — worse than the missing one this closes.
    `repaired_locally` covers the milder version, where foreman's union was
    integrated and the native loop then repaired on top of it.

    All three are on `coder.get`, and a `foreman: "placements"` event carries the
    ledger plus the integrated count live.

    A `foreman: "gate"` event narrates each per-patch merge verdict live —
    `decision: "accepted" | "rejected"` plus the gate's own evidence (`subtask`,
    `build_test`, containment and semantic-conflict counts, and `reasons` on a
    rejection).

    Runtime policies registered on the client session apply to this delivery
    gate exactly as they do to `foreman.run`. In particular, a
    `deny_tool = ["foreman.integrate"]` rule rejects every proposed patch before
    its build check and prevents it from reaching the delivery worktree. The
    gate writes `gate_accepted` / `gate_rejected` directly into that client
    session's runtime audit journal (car#1321); the delivery loop also projects
    those rows into the coder run's `<id>.events.jsonl` so the run remains
    independently reviewable after its originating connection is gone. Each
    invocation stamps a unique `gate_audit_scope` on its primary gate records;
    the coder projection accepts only that scope, so concurrent runs sharing a
    client session cannot copy each other's verdicts even with reused subtask IDs.

    **The journal records are not derived from the event.** Do not read the two
    as one thing with two spellings. Events on this stream include everything a
    supervised coding CLI writes to stdout, so a `foreman: "gate"` event is
    narration and a client should treat it as such; the journal rows originate
    in the merge gate using the session's shared runtime log, then the coder
    journal projection is written directly by the foreman loop. That is what
    makes them audit records for patches authored on machines this host does not
    control (car#1243).

    The journaled kind is binary while the gate's verdict is not: an
    inconclusive gate (verify timed out, or not configured) is not an
    acceptance, so it journals as `gate_rejected` carrying
    `outcome: "inconclusive"`. Read `outcome`, not just the kind, to tell "we
    checked and it failed" from "we could not check". The `foreman: "placements"`
    event also carries
    `quarantined: [string]` — peers dropped for the rest of the run, the same
    set `foreman.run` reports under `pool.quarantined` (car#1323). It is NOT
    persisted on the session: it describes this run's pool rather than the work,
    and each placement's `failed_attempts` already carries the per-subtask
    evidence.

    **`coder.cancel` keeps the ledger** (car#1346). Cancel aborts the loop task
    at its next await, so the fold at the end of the run never happens — the
    pool dropped and the record of where the work went was gone for exactly the
    run an operator wants a receipt for, the one they stopped because it looked
    wrong. The pool is now reachable from the session entry and cancel drains it
    before the state transition (the transition is what writes the snapshot, so
    a drain after it would never reach disk). Cancel writes ONLY `placements` —
    it cannot reach the integrated set, and guessing one would be the false
    attribution above.

    **The cancel-time ledger is a floor, not a census.** A placement is recorded
    when a worker RETURNS, and foreman runs a level under `join_all` rather than
    spawning, so aborting drops every in-flight future before it records: the
    subtasks running at the moment an operator gives up are precisely the ones
    missing. `pool_workers` is what answers "which machines was this farmed
    to?" completely, which is why it is persisted up front rather than folded at
    the end. Each serving peer also appends its own audit row keyed by the same
    `run_id`, so the peer side can name what the orchestrator never saw finish.

    The ledger itself is in memory until a drain, so a killed daemon still loses
    it — this closes the cancel path, not the crash path.

    The integrated set also goes into the **delivered commit**, as
    `CAR-Placement: subtask=… worker=… remote=… files=…` trailers. The commit is
    the artifact a reviewer of a distributed run reads — `coder.approve_merge`
    publishes a `car/coder/<id>` branch, not a pull request — and its body opens
    "Authored by CAR Coder.", which is wrong on its own for work authored on
    several machines. Same argument as car#1263 one level up: a caveat has to
    reach the thing it is read on, not only a status call. Trailers rather than
    prose so `git interpret-trailers` and `%(trailers:key=CAR-Placement)` can
    read them; not `Co-authored-by:`, which GitHub resolves to user accounts.
    Values are control-character-stripped and length-capped, and the ledger's
    failure strings are deliberately **not** in the commit at all — they carry a
    peer's verbatim response body and git stderr, which in the last paragraph of
    a `git commit -m` is a trailer-forgery seam and, at NUL or at length, makes a
    green run undeliverable.

    A local run's commit body is byte-identical to before, and a distributed run
    whose every peer was excluded — the pool always seeds the local worker — adds
    no trailers rather than announcing a fleet that did not participate.

    Recorded when the loop completes. `coder.cancel` aborts the task, so a
    cancelled run records nothing; car#1346 tracks making the ledger survive
    that.

- **`base`** (optional) starts the worktree at this commit-ish instead of the
  repository's `HEAD` — another developer's published branch, a tag, a SHA —
  without touching the user's checkout. It is resolved to a full commit SHA
  before anything is provisioned, and that SHA is what the reply's `base`
  carries (`null` = the repository's `HEAD`) and what the session snapshot
  persists, so the session names exactly what it started from after the ref
  moves. An unknown revision, a non-commit, or a value beginning with `-`
  fails the start with no worktree and no session left behind; fetch another
  developer's branch before naming it. Not valid with `project`, which
  delivers straight to the project's `main`. Explicit branch delivery publishes
  `car/coder/<id>` on top of the base, carrying its history plus this session's
  squash commit. Checkout delivery applies only the task delta. This is the primitive a
  multiplayer Improve or Polish stage starts from
  (`docs/proposals/multiplayer-development.md`).
- **Current checkout inputs.** Without an explicit base, saved conversation result,
  retained workspace, or managed project, a task snapshots the current tracked
  and non-ignored untracked files into a private input commit. A temporary index
  leaves the original HEAD and staged index unchanged. The reply's `base` names
  this input commit when it differs from HEAD; review compares against it so
  preexisting edits are not attributed to the agent. An unresolved merge refuses
  start. Ignored inputs are excluded. Concurrent edits during capture are not an
  atomic filesystem snapshot. After a checkout delivery, follow-ups capture
  current checkout files again, including manual edits and deletions.
- **Baseline inputs are disposable.** Each baseline check runs in its own temporary workspace copied from the task's current tracked and non-ignored untracked files, including staged and unstaged contents. Its writes cannot feed the next baseline check through the task directory. Existing frozen policies still apply, with additional path checks for the temporary root. The check-private target is discarded after its guarded publication to the trusted target store. The protected Cargo home is also cleared and rematerialized before every run, although its repository-keyed pathname is stable so Cargo registry fingerprints remain reusable. An exclusive lock serializes protected checks for that repository across baseline publication and verifier `run_check`; a lock timeout is infrastructure failure. Ignored dependencies/caches are not copied into the workspace. Internal symlinks point into the copy; external/broken symlinks and nested Git inputs currently fail preparation rather than being followed or silently flattened. Preparation failures produce failed checks. This is filesystem separation, not a new OS sandbox or a guarantee about external side effects. Ordinary post-implementation checks retain their existing execution path.
- **Red-green baseline** (car#707): before returning, the contract is evaluated once against the **unmodified** worktree. `baseline` is a `CheckResult[]` in check order, and `baseline_gates_nothing` is true when *every* check already passed. For a model-derived contract with fan-out outcomes, all-green now triggers exactly one contract-repair round with the baseline results and the instruction: "These checks already pass on the untouched repository; write checks that fail until the requested change is made." The repaired contract is evaluated again under the same sandbox, policy, approval, timeout, and silence settings. A completed repair whose ordinary derived checks are still all green ends `abandoned` with `failure_kind: "already_satisfied"` only when no outcome is held or Not verified; otherwise it proceeds to `contract_proposed` with the unresolved outcome visible. A repair that produces a red check also proceeds to `contract_proposed`. This differs from thin intent: authored outcomes establish specificity, while `fix it` or a fan-out with zero outcomes retains the thin refusal. The journal records `coder.outcomes_step` with `step: "baseline_repair"`, `phase: "started"` and `"finished"`; the finished event uses `detail: "already_satisfied"` for this result. Supplied contracts keep their verbatim all-green behavior, and Agent projects skip the shell baseline. Only an all-green baseline sets the flag: individual passing checks are ordinary (a refactor's checks are green before and after by design), and an exit-zero-only check that already exits zero counts as passing. Contract derivation rejects contracts that gate nothing structurally: assertion-less checks, toolchain-only no-ops, output claims without output assertions, and simple literal echo branches whose success and failure both satisfy the assertion. The baseline catches the semantic case that clears validation. A check with `timeout_secs` is bounded by that explicit cap; one without it runs until exit, while output keeps the silence watchdog alive. The same full results are pushed as a `coder.contract_baseline` event; `car code-task` likewise emits full `CheckResult` values rather than projecting them down to `{name, passed, exit_code}`. The pass also captures the output of checks marked `baseline: true`; later differential checks receive those runtime-owned before-values and compare them with their current output as `changed`, `unchanged`, or `delta_within`. This makes a live-system before/after claim expressible across the session, while an evaluation after a deployment the session does not perform still belongs to the surrounding orchestrator. See "What a contract can and cannot assert" in [`docs/car-code-task.md`](../car-code-task.md).
- **Visible while drafting.** The session is registered at `created` **before**
  contract derivation begins, so it appears in `coder.list` / `coder.watch` (and
  fans out a `coder.session_changed`) for the whole 3-5 minute drafting window,
  with `needs_you: null` — nothing is being asked of the operator yet. It is
  also **cancellable** there: `coder.cancel` aborts the derivation, removes the
  unpublished worktree and its Git registration, and lands the session at
  `abandoned`, and the abandon sticks (the
  contract is never proposed into existence afterwards, and no
  `contract_proposed` reaches a subscriber). `coder.start`'s own return shape
  and timing are unchanged — it still returns after drafting with the same keys;
  this is purely additive visibility. Previously the session was registered only
  once drafting finished, so it existed on disk but was absent from the wire:
  unaddressable, uncancellable, and invisible to every other client.
- **Survives the calling connection.** `coder.start` runs on a daemon-owned
  task, not on the connection that asked for it. Every other method is
  dispatched on a per-connection task set that is aborted the moment the
  WebSocket closes; for `coder.start` that was wrong, because the session is
  registered and its worktree provisioned *before* the multi-minute contract
  derivation — so a client that disconnected while drafting left a `created`
  session row, a provisioned worktree, no contract and no driver until the
  daemon restarted. Disconnecting now abandons only your own response: the
  derivation, the red-green baseline and the transition to `contract_proposed`
  all complete, and any client can pick the session up from `coder.list` /
  `coder.watch`. A connection that stays open sees the same response at the
  same time as before. The only supported way to stop a drafting session
  remains `coder.cancel`.

#### `coder.confirm_contract`
- **Params**: `{ session_id: string, contract?: OutcomeContract }` — pass `contract` to replace the proposal with a user-edited version (validated before acceptance). Check objects in this confirm-only payload may add `network_approved?: boolean` and `approved_credentials?: string[]`. A credential is approved only when it is both declared in `credentials` and listed in `approved_credentials` on that exact name and command. An unchanged check, including its credential declaration, keeps prior approval; changing its name, command, or declarations drops approval. Model revisions never carry approval. Network approval retains its existing exact-command behavior. This confirm rule does not change `coder.start`: a caller-supplied start contract remains operator-approved.
- **Returns**: `{ state: "running" }`
- The first human gate. Spawns the work loop; progress streams as `coder.event`.
- On a session that builds an agent, only the CAR app or you at your terminal may confirm; see [agent builds](#managed-projects-coderprojects).

#### `coder.list`
- **Params**: `{}`
- **Returns**: `{ sessions: [session_summary] }` — live sessions plus persisted snapshots from prior daemon lifetimes (`live: false`), newest first.

##### `session_summary`

The row shape shared by `coder.list`, `coder.watch`, and the
`coder.session_changed` notification. Every pre-existing key keeps its name and
type; the rest is additive.

```jsonc
{
  // --- existing ---
  "session_id": "coder-…", "state": "running", "intent": "…", "repo": "/abs/path",
  "engine": "native", "iterations": 3, "updated_at": 1781234567, "live": true, "error": null,
  // `iterations` tracks the run live (the last `iteration_started.n`) and settles
  // to the loop's final count when it finishes — it previously read 0 until then.

  // --- which engine, asked for vs. ran ---
  // `engine` above is the RESOLVED choice: `auto` that picked claude-code and an
  // explicit `external:claude-code` both read `external:claude-code` there.
  "requested_engine": "auto" | "native" | "external[:id]" | "foreman[:id]" | null,
                                      // what the caller passed to `coder.start`;
                                      // null on a session started before this existed
  "engine_ran": "native" | "external:id" | "foreman:id" | null,
                                      // the engine that produced the outcome —
                                      // `native` after an external → native fallback.
                                      // null until the run ends, and on older sessions;
                                      // show `engine` when it is null.

  // --- what the session is waiting on a human for ---
  "needs_you": "contract" | "question" | "approval" | "auth" | null,
  "needs_you_label": "contract awaiting confirmation" | "question waiting"
                   | "diff ready for approval" | "sign-in needed" | null,
  "question_prompt": "…" | null,      // set iff needs_you == "question"
  "auth_message": "…" | null,         // set iff needs_you == "auth"
  "auth_wait_secs": 120 | null,       // set iff needs_you == "auth"

  // --- outcome + provenance ---
  "failure_kind": "checks_red" | "already_satisfied" | "stalled" | "no_progress" | "cancelled" | "inference_unavailable" | "model_not_found" | "engine_fallback_then_failed" | "delivery_failed" | "interrupted" | "budget_exhausted" | "auth_required" | "configuration" | "infrastructure" | "verification" | "error" | null,
                                      // set for failed sessions and an
                                      // abandoned already-satisfied session
  "worktree": "/abs/path" | null,     // only when the directory still exists on disk
  "project": "slug" | null,
  "result_branch": "car/coder/ab12cd34" | null,
  "result_commit": "<full delivered commit SHA>" | null,
  "excluded_artifacts": [{"path":"car_runtime/car_runtime.abi3.so","reason":"compiled_binary","size_bytes":127926272}],
  "model": "…" | null,                // the pin the CALLER asked for
  "authored_by": ["…"],               // every model that actually completed a turn,
                                      // distinct, first-seen order; `[]` for a
                                      // foreman/external session (no native turns)
  "distributed": false,               // the session farmed subtasks across the fleet
  "discussion_id": "disc-…" | null,
  "next_seq": 42 | null               // live sessions only; the coder.subscribe cursor
}
```

`needs_you` is **always `null` for a non-live session** (`live: false`), even a
`needs_approval` snapshot preserved across a daemon restart. Such a session is
genuinely not approvable — `coder.approve_merge` requires a live registry entry,
which orphan adoption deliberately does not rehydrate — so advertising it as
actionable lit up a board row whose action returned a protocol error. A board
renders those from `state` plus the retained `worktree` path, and
`coder.approve_merge` / `coder.cancel` on one answer with the already-happened
wording (naming the surviving worktree so it can be merged by hand).

For a live session `needs_you` is derived **server-side** by one function, and
`needs_you_label` is a fixed daemon-owned string — the same precedent as `diff_ready`'s
`overlap_disclosure`, so two clients can never say different words about the
same state:

| value | condition |
|---|---|
| `"contract"` | `state == contract_proposed` |
| `"approval"` | `state == needs_approval` |
| `"question"` | `state == running` AND a mid-session question is parked on the input gate |
| `"auth"` | `state == running` AND an `auth_required` event is the latest unresolved auth event (cleared by any subsequent event) |
| `null` | otherwise |

`failure_kind` is `"budget_exhausted"` when the session hit an explicit
iteration or wall-clock cap; the reason names the elapsed/used amount and cap.
It is `"auth_required"` when it ended waiting on a sign-in nobody supplied —
**or** when contract DERIVATION or REVISION died on a rejected credential, which
does not wait at all (`coder.start` and `coder.revise_contract` are synchronous
RPCs the client is blocked on, so they emit `auth_required` with `wait_secs: 0`
and end rather than hold the call open). `"configuration"` means routing
constraints left no eligible model before dispatch; self-heal releases the
item claim without adding item backoff or posting a public failure comment,
because changing the item cannot repair `heal.toml`. Since car#1534 it also
covers a broken ENVIRONMENT under an external engine: the MCP config could not
be written, or stdin/stdout/stderr could not be acquired, so the CLI never
received the task. That ends the session naming the underlying error and
NEVER falls back to native — the native engine would run in the same broken
environment. Automatic fallback is now exactly one case: the engine cannot run
here at all (not installed, not detected, not executable, unknown adapter,
`ENOENT`), on a session that did not name its engine. An explicit
`engine: "external:<id>"` or `"foreman:<id>"` never falls back; it ends with
its typed cause plus guidance to re-run without the pin, or with
`engine: "native"`. A run loop with no auth gate — the
default adaptive-routing path — is the one case that emits `auth_required` and
still ends `"infrastructure"`: it does not wait, so the strikes run out
normally.

Since the failure-reason change, every failed session carries a redacted plain-language reason in `error` and one of these kinds. `checks_red` names the checks still red on the last round and the round count. With red checks, a headless native session keeps iterating until it succeeds or ends through `NoProgress` (the idle-iteration guard or session no-progress turn guard), the silence watchdog, cancellation, or a genuine infrastructure, authentication, or configuration failure; a repeated-read trip ends only that attempt. A worker-reported execution error is `failure_kind: "error"`, and its reason keeps the worker's text followed by the final red-check summary. `already_satisfied` belongs to an `abandoned` session whose authored ordinary checks all passed after baseline repair; its error names every passing check and says nothing needs to change. `interrupted` is a daemon restart that adopted a mid-flight session (it replaces `infrastructure` there). `inference_unavailable` and `model_not_found` refine an inference-backend failure and name the model when known. `engine_fallback_then_failed` names the engine asked for and the one that ran. `delivery_failed` names the delivery step that failed after the checks passed. `cancelled` is recorded on the snapshot of an abandoned session, though this summary field stays null for it. `error` is otherwise the residual. Scorers exclude `already_satisfied`, `infrastructure`, `auth_required`, `inference_unavailable`, `model_not_found`, `interrupted` and `delivery_failed`, because the work was not judged as an attempted change. A record written before this change has no reason, and listings show it as "not recorded".

Read the **event**, not `failure_kind`, to decide whether to show a
sign-in prompt.
`"infrastructure"` is used when the machinery failed rather than the work (the
worker could not be started — an external CLI that never received the task
because its environment was broken is `"configuration"` instead, see above —
the backbone stopped answering, or the outcome contract could not even be
derived for any reason other than a rejected credential). `"stalled"` means
the live-session watchdog observed no runtime-owned progress for the configured
silence window. Its reason names what the session was waiting on and the
retained worktree path. `"no_progress"` means either the configured number of
native agent turns changed nothing, or an external/foreman CLI streamed output
inside the silence window that just elapsed without changing its pinned worktree.
An older line followed by a full silent window is `stalled`. Streamed CLI lines
alone are output, not progress. Sessions waiting at a contract, approval,
question, or sign-in gate are exempt from the silence watchdog. `"error"` means
the work ran and was judged red.

`"infrastructure"` is the one to check before reading a failure as a result: no
check ever passed judgement on the task, so a scorer must exclude it rather than
count it as a loss. It exists as its own value because the alternative — folding
it into `"error"` — leaves consumers recovering the distinction by matching the
runtime's error prose, which only recognises failure modes somebody already met.
One such prose scan silently recorded 18 sessions that died in seconds on a
backbone that could not make structured tool calls as genuine task failures, and
while the kinds stay collapsed the
next unfamiliar error string reads the same way. `"auth_required"` outranks it:
both mean nothing was attempted, but only one is fixed by asking a human.

`failure_kind`, `needs_you`, `worktree`, `result_branch`,
`project`, `model` and `discussion_id` are all **persisted on the session
snapshot**, so a summary read after a daemon restart still carries them —
otherwise the distinction between "ran out of clock", "nobody signed in", "the
machinery broke" and "the work was judged red" would go blank exactly when the
operator comes back to look. `worktree` is reported only when the directory
still exists (the
`keep_workspace_on_failure` / preserved-orphan cases): a path whose tree was
reaped is a snapshot detail, not a place to send someone.

#### `coder.watch` / `coder.unwatch`
- **Params**: `{ renew?: boolean }` (default `false`) / `{}`
- **Returns**: `{ sessions: [session_summary] }` (newest `updated_at` first) — or,
  when `renew: true`, `{ was_registered: boolean }` / `{ ok: true }`
- The board's **one** subscription. `coder.subscribe` is per-session, which is
  exactly what a board cannot use: it has to learn about sessions started by
  *any* client (`car code`, CarHost, milo) without polling and without
  restarting. `coder.watch` answers with the current full list **and** registers
  the caller for change notifications, atomically — registration happens under
  the same `coder_sessions` lock the snapshot is taken under, so a session
  created between the two cannot slip through the gap and go unrendered until
  some later unrelated change.
- Watchers are keyed by `client_id` and dropped on disconnect, exactly like
  `coder.subscribe`rs. **Lock order:** a session's `events` buffer →
  `coder_subscribers` → `coder_watchers`; never the reverse.
- **Idempotent, and meant to be re-called on a timer.** Registration is keyed by
  `client_id`, so a second call is a no-op on the registration and answers with
  a fresh snapshot. Because a shed is silent and the connection survives it (see
  `coder.session_changed` below), a client with no periodic re-watch can render
  a permanently frozen list with nothing on the wire to tell it — the reference
  board renews every **4 s**.
- **Renew on the timer, not the full call.** `{ renew: true }` re-registers
  idempotently and returns `{ was_registered }` and nothing else: `true` if a
  live registration was already present, `false` if this call had to create one
  — i.e. the client had been shed or dropped and has missed changes, so it
  should follow up with a default `coder.watch` to resync. A renewal builds **no
  summaries**, which is the point: the default call lists every persisted
  session from disk, and that scan grows with accumulated history rather than
  with what is live. A daemon predating `renew` ignores the unknown param and
  answers with the full list — clients should treat a missing `was_registered`
  as "old daemon, this reply is the snapshot".
- Each registration is stamped internally, so a registration **created** while a
  shed is timing out on a previous one (an unwatch/reconnect) is not removed by
  that shed's cleanup. A bare re-watch or renewal from a connection that already
  has a live registration keeps that registration's stamp — deliberately: with a
  new stamp per call, a client renewing faster than the 10 s write deadline
  could never be shed at all.

#### `coder.session_changed` (notification)
- **Payload**: `{ summary: session_summary }`
- Pushed to every `coder.watch`er when a session is created, changes `state`,
  changes `needs_you`, changes `error`, or reaches a terminal state. Emitted
  **synchronously from the event path, never from a poller**, so an
  operator-attention transition reaches an open board in well under 5 s. Two
  boards — one open the whole time, one that just called `coder.watch` —
  converge to the same list.
- Fanned out on **one** daemon-wide drain, coalesced per session, so a board
  that stops reading cannot slow the others down. A watcher whose socket does
  not take a frame within **10 s** is **deregistered** — its
  `coder.session_changed` stream ends and it must call `coder.watch` again to
  resume (which also re-answers with the full current list).

#### `coder.refresh_review`

- **Params**: `{ session_id: string }`.
- **Returns**: `{ state: "running", review_refresh: true }`; progress and the
  refreshed diff arrive on the existing task event stream.
- Available only for a stopped native task with a pending diff, valid saved
  checks, and a saved review identity. `coder.get` exposes
  `review_refresh_available`; older daemons omit it.
- Restages the task's current files and reruns the accepted checks in disposable
  workspaces. Original differential baseline captures are retained. There is no
  inference, replanning, check rewrite, checkout delivery, or branch publication.
- The old review is invalidated before work starts. Passing checks and unchanged
  task files produce a new diff and return to `needs_approval`. Failed checks,
  a changed task HEAD, or files changing during verification fail the task and
  retain its worktree; those results cannot be delivered. Cancellation uses
  `coder.cancel` and drains the verification task.
- Delivery still requires a separate `coder.approve_merge` action after review.

#### `coder.revise_contract`
A revision request of `/check name command` sets that named check's command
verbatim (or appends a new exit-zero check when absent), without inference.
Existing check assertions, captures and timeouts are preserved. It still uses
the same validation, baseline execution, concurrency guard and separate confirm
step; it does not authorize broader execution or credentials.

A model revision preserves a prior network approval only when the complete
check is byte-identical. A changed or duplicate network check is held under Not
verified instead of being executed or panicking the revision task.

- **Params**: `{ session_id: string, request: string }` — `request` is plain English, e.g. `"also verify the Windows path"`, or the verbatim `/check` form described above.
- **Returns**: `{ state: "contract_proposed", revised: boolean, contract: OutcomeContract, baseline: CheckResult[], baseline_gates_nothing: boolean, message: string | null }`
- Redrafts a **proposed** contract from the operator's reply instead of making
  them hand-edit JSON or reject and start over. Legal **only** in
  `contract_proposed`; any other state returns the already-happened error below.
  Baseline checks execute; coding stays at the gate awaiting a fresh
  confirm/reject. Requests are limited to 16 KiB, and accepted revisions share
  the session's 64-message durable guidance limit. Their exact wording is
  retained for execution and subsequent revisions.
- `message` lists every check this revision held or moved to Not verified, with
  its reason and any required approval action, whether or not the rest of the
  revision applied. It is `null` when this revision held no check.
- `CheckResult` is `{ name, command, started_at, passed, exit_code: number | null, output_tail, duration_ms, timed_out, deadline_clamped, credentials_allowed, credential_sources?: Record<string, string>, credentials_withheld?: string[], network_isolation: "sandboxed" | "unwrapped_approved" | "unavailable", secret_isolation: "sandboxed" | "unavailable", keychain_access: "denied" | "allowed", evidence_dir: string | null, evidence_files: string[], env: Record<string, string>, cwd: string | null }`. `secret_isolation` records whether the platform applied the operator-secret and daemon-endpoint sandbox and defaults to `"unavailable"` for old records. `keychain_access` records the pinned macOS posture and defaults to `"denied"`; it does not change Linux behavior. `credential_sources` maps injected names to value-free labels; `credentials_withheld` names declared values refused for missing approval. Empty collections are omitted. Credential values never enter `env`, output tails, events, journals, or evidence; exact printed occurrences are redacted before persistence. Human reruns resolve approved values without embedding them as `NAME="$(car secrets get NAME --check-credential)"`. The existing booleans and isolation/evidence fields retain their additive defaults and semantics.
- Plain-English corrections are explicit coverage-review criteria alongside
  retained task constraints. An unrelated check change does not suffice when
  review reports the requested correction missing. If that review fails or
  remains negative after drafting attempts, the revision is rejected and the
  current contract and baseline are retained. This assessment is model-based,
  not proof of semantic correctness; inspect the commands and results.
- On success: `revised: true`, a re-run red-green `baseline` for the new checks,
  and fresh `contract_proposed` + `contract_baseline` events so **every**
  subscribed client re-renders the new draft and cannot confirm the stale one.
- On failure to honor (the redraft does not validate, or the request is not
  expressible as checks): `revised: false`, the previously drafted contract
  returned **byte-identical** together with **its own stored `baseline` and
  `baseline_gates_nothing`**, `message` explaining why, and a
  `contract_revision_rejected { request, reason }` event. A revision that
  silently passed as applied would let an operator confirm a contract they
  believe says something it does not — the one outcome this must never produce,
  so read `revised` before trusting `contract`. The baseline is returned rather
  than blanked because a board renders it beside the contract: an empty
  `baseline` would read as a change to the very draft this reply promises is
  unchanged. (The baseline is persisted on the session snapshot for exactly this
  reason, and moves with the contract it describes on every successful
  revision.)
- "Expressible as checks" is judged on the **checks alone**. A redraft that
  changes only `description` gates nothing new, so it comes back
  `revised: false` — restating an unverifiable requirement in prose is exactly
  the case this rejection exists for. `output_contains` is compared
  byte-for-byte, so tightening `"0 failures"` to `" 0 failures "` (so it can no
  longer match `"10 failures"`) *is* a revision.
- Targeted generated edits may remove and upsert the same existing check name;
  this means replacement in its original position, preserving baseline dependency
  ordering. Unknown removals, repeated removals and duplicate upserts remain
  invalid. Unmentioned checks are retained unchanged.
- Check `output_contains` accepts `$exact:<text>` for complete, lossless captured
  UTF-8 output equality, including whitespace and final newlines (64 KiB limit).
  `$json:` retains semantic JSON matching; other values remain literal substrings.
  Exact equality requires local capture evidence and never accepts truncated or
  unattested output. See [contract assertions](../car-code-task.md) for examples and
  compatibility. Clients display the exact expected text with escaped whitespace.
- **Two revisions racing**: the write is conditional on the stored contract
  still being the one this redraft was derived from. If another revision landed
  first, this one is **not applied** and returns `revised: false` with the
  **current** contract and baseline plus a `message` beginning `another revision
  of this contract landed while yours was being drafted` — re-read it and revise
  again if you still need your change. Both revisions previously reported
  `revised: true` and the second silently discarded the first.

#### Already-happened errors (confirm / approve / revise)

Acting on a session that is past (or not yet at) the gate returns a JSON-RPC
error whose `message` names what already happened and the current state — never
a panic, never a silent `{ok: true}`:

- `contract already confirmed for coder-ab12cd34 (state: running)`
- `coder-ab12cd34 was already merged — nothing left to approve`
- `coder-ab12cd34 was already merged — nothing left to revise`
- `coder-ab12cd34 is not ready to approve yet (state: running, expected needs_approval)`

These three are exactly the gates a second operator can wrongly believe they
just passed — two boards racing on one session is the normal case now, and a
bare success for "confirm this contract" or "approve this merge" would tell them
their decision took effect when it did not.

**`coder.cancel` is deliberately excluded** and reports the same information
without erroring — see its section below. Cancelling a stopped session is the
outcome the caller wanted, and `car code`'s one-shot Ctrl-C path calls it
unconditionally, so making it an error would change the frozen one-shot flow.
Every pre-existing `coder.*` method keeps its parameters **and its return
shapes**; the already-happened information arrives in additive keys there.

#### `coder.get`
- **Params**: `{ session_id: string }`
- `event_cursor` reserves the next event sequence at durable state transitions. `review_restored: true` identifies a review reopened after restart; its check results are historical, not newly executed.
- Completed diff reviews may include `review_identity: { head, tree }`, the worktree HEAD and staged Git tree presented for review. It persists across restart and is absent on older snapshots and no-change findings. Delivery for a live task carrying this receipt refuses changed HEAD, staged content, unstaged tracked files, or non-ignored untracked files. The receipt does not claim fresh verification or restore a post-restart approval gate by itself.
- **Returns**: the full session snapshot (contract, `outcomes_path?`, `outcomes?`, `contract_derivation?`, `last_check_results`, `protected_edits?`, `evidence_dir`, `evidence_bytes`, `workspace_path`, `result_branch?`, `result_commit?`, `excluded_artifacts?`, `error?`, `live`, `next_seq` when live). `protected_edits` is `[{ path, kind: "modified" | "deleted", allowed, first_iteration_seen? }]`, retaining the first observation of each distinct builder edit to a start-commit contract input. `excluded_artifacts` is omitted when empty; otherwise it is `[{ path, reason, size_bytes }]` and records either a delivery-time exclusion or a check effect that CAR reverted before returning the check result. Delivery-time `reason` values are `"over_size_limit" | "compiled_binary" | "ignored" | "root_check_evidence" | "interceptor_screenshot"`. Successful check restores use ``"reverted: written by contract check run `<name>`"``, `"reverted: written by a coder-shell check run"`, ``"reverted: modified by contract check run `<name>`"``, `"reverted: modified by a coder-shell check run"`, ``"reverted: deleted by contract check run `<name>`"`` or `"reverted: deleted by a coder-shell check run"`. If snapshot or restore fails, the delivery backstop retains the older ``"written by contract check run `<name>`"``, `"written by a coder-shell check run"`, ``"modified by contract check run `<name>`"`` and `"modified by a coder-shell check run"` reasons for the unrestored paths only. Each check that executes in the coder worktree snapshots its non-ignored tree through private copied Git indexes, restores changed bytes, executable modes, and symlinks immediately, removes check-added paths and newly empty directories, and never writes the real index. Ignored output remains in place. Baseline and review rechecks execute in disposable `check_workspace` copies instead. `outcomes` has shape `{ source: "fan_out" | "supplied" | "agent_project", groups: [{ group, outcomes: [{ text, check, network_approved, approved_credentials? }] }], not_verified, not_in_this_version, dropped, missing_groups, critic_ran }`; `OutcomeContract` is `{ description, allow_credentials?, protected_paths?: string[], editable_paths?: string[], checks: ContractCheck[] }`, and `ContractCheck` is `{ name, command, credentials?, expect_exit_zero, output_contains?, timeout_secs?, baseline?, differential? }`. Empty path and credential collections are omitted for backward-compatible reads. `not_verified[].check` carries the complete held check; legacy string-valued checks load as absent. `contract_derivation` retains `{ calls, prompt_tokens, completion_tokens, cost_usd, billing, models }`, with metered cost separated from execution-loop spend. `evidence_dir` and `evidence_bytes` retain the durable evidence root and recursive size. Restart adoption records interrupted checks as `{ name, completed: false, rerun_required: true }` without inventing a verdict. The snapshot also includes optional `agent_build_progress` for an Agent-project build:
  `{ phase: "generating_spec" | "repairing" | "running_scenario", attempt, max_attempts, scenario?, scenarios_total?, model?, started_at, elapsed_secs }`. `scenario` is 1-based and appears only while a scenario is running; `model` is the requested pin until a completed generation identifies the model that actually served; it clears when a repair attempt or scenario starts, because those route independently of spec generation, and then follows the model serving each scenario turn. `started_at` is Unix seconds and `elapsed_secs` is refreshed on each live `coder.get` poll, then frozen when the build ends. The whole object is additive and omitted for every non-Agent session, so older hosts keep working unchanged.

#### `coder.subscribe` / `coder.unsubscribe`
- **Params**: `{ session_id: string, from_seq?: number, reattach_headless_start?: boolean }` / `{ session_id: string }`
- **Returns**: `{ state, events_replayed, events_skipped, live, replay_available, review_restored, silence_window_secs, reattached_headless_start, start_result? }` / `{ ok: true }`
- `reattach_headless_start: true` reclaims a detached headless starter role on a
  freshly authenticated connection. While `coder.start` is still pending, the
  subscription is registered first, then the RPC waits without a separate wall
  clock and returns the original `coder.start` result in `start_result`. A
  competing live starter is refused. A session whose reconnect window expired
  or was cancelled returns a definitive error. After confirmation the flag is
  an idempotent event resubscription and does not reopen the contract gate.
- Opening a stopped native task at diff review can restore its live delivery gate. Restoration requires a saved review identity, event cursor, passing saved checks, the original linked worktree, and unchanged staged/revision/file state. It runs no model or verification commands. It emits a newly reconstructed diff and a notice labeling the saved checks and historical activity. The reply includes `review_restored: true`, `live: true`, and `replay_available: false` (earlier activity is not in the live buffer); new review events use sequences above the saved cursor. Clients should refresh `coder.get` for delivery capabilities after restoration. Repeated opens reuse the live entry. A failed restoration keeps the snapshot readable and adds `review_restore_error`; legacy snapshots, unfinished executions, findings, managed projects, and external-engine tasks remain historical. Direct approval before opening a recoverable task asks the caller to open it first.
- A session that is **not live but has a persisted snapshot** (the daemon
  restarted under it) succeeds with `{ state, events_replayed: 0,
  events_skipped: 0, live: false, replay_available: false }` rather than erroring. Erroring made every
  pre-restart session unopenable from a board — precisely when an operator goes
  looking for it. Historical activity is returned separately from live notifications, as described below. Only an id with neither a live entry nor a snapshot is an
  error. `coder.unsubscribe` on a non-live session is a no-op returning
  `{ ok: true }`.
- Historical sessions and restored reviews additionally return `history: { events, partial, events_skipped }` when their journal can be read, or `history_error` when it cannot. `events` contains saved Coder event envelopes at or after `from_seq`, retaining original sequences and timestamps. These are **presentation only**: clients must not fold them into live prompts, checks, state, or approval controls. `replay_available` continues to describe the in-memory notification stream, independently of this historical payload. Older audit-only rows, sequence gaps, and retention trimming set `partial: true`; this is not a guarantee against a lost journal tail after a crash. The existing `max_replay_events` setting bounds the returned historical window (`0` disables the event-count cap); `events_skipped` counts matching saved events removed by that cap. Journals over 64 MiB are refused before loading, and malformed/torn journals are reported without rewriting them. A missing or unreadable journal never prevents opening the saved task snapshot.
- A live session retains the newest **2,000 events** for reconnect replay by
  default. Operators can set `[coder] max_replay_events` in `~/.car/coder.toml`;
  `0` means unlimited, and the value is captured when a new session starts. When
  `from_seq` predates the retained window, the surviving events retain their
  original `seq` values and `events_skipped` reports exactly how many earlier events are
  unavailable. It is `0` for an in-window cursor and for a persisted non-live
  session, so replay loss is explicit rather than inferred from the response
  length.
- A **finished** session leaves the in-memory registry once it has been terminal
  for 30 minutes, so a long-lived daemon does not hold every event of every
  session it has ever run (car#1262). It keeps appearing in `coder.list` — that
  merges persisted snapshots from disk — and subscribing to it still succeeds;
  what expires is `replay_available`, which becomes `false` with
  `events_replayed: 0`, the same shape as a session that outlived a daemon
  restart. This bounds MEMORY only: nothing prunes the snapshots themselves, so
  `coder.list` still reads every session ever run.
- The sweep runs when a session is **started**, not on a timer, so a daemon that
  has stopped starting sessions keeps its last generation of finished ones. Two
  cases are never collected however old: a session that is not terminal
  (`NeedsApproval` is deliberately not terminal — it is waiting on a human), and
  a terminal session with no snapshot on disk, since that entry is the only copy
  left. `coder.cancel` and friends answer a collected session from its snapshot,
  so an id that merged an hour ago still reports as merged rather than as
  unknown.
**`coder.diff_ready` payload** (car#706): `{ stat, patch, patch_truncated: boolean, patch_full_bytes: number, changed_paths: number, overlap_disclosure: string | null, contract_overlap: [{ check, paths }] }`. `stat` is the full `git diff --cached --stat`, never truncated. `patch` is tail-capped to `~/.car/coder.toml`'s `approval_patch_bytes` (default 512 KB, previously a hardcoded 32 KB), and `patch_truncated` says so as a field rather than only via the `…[truncated]…` marker inside the string — a reviewer must be able to tell they are approving against a partial diff without string-matching. `changed_paths` counts every path the diff touches, including BOTH endpoints of a rename — one moved file is two paths, because a file moved out of a directory is a change to that directory, and reporting only the destination made a rename look like a creation. `overlap_disclosure` is the rendered sentence, or `null` when nothing overlaps; it is on the wire so every surface prints the same words rather than hand-rolling copies that drift. `contract_overlap` lists contract checks whose commands execute a path this diff modified: **disclosure, never denial**, since editing tests is frequently the task and `coder::policy` deliberately does not block test-adjacent edits. Path extraction from a shell command is heuristic and biased toward flagging — a false positive costs one line a human dismisses, a false negative silently restores the gap.

- Subscribes this connection to the session's `coder.event` stream. Buffered events with `seq >= from_seq` are replayed before live delivery (no gap, no dup), so a reconnecting client resumes from its cursor. Subscriptions are per-connection and dropped on disconnect; the session keeps running.

#### `coder.respond`

With `steer: true`, queues operator guidance for a running native loop instead
of answering a question. First require `steering_available: true` from
`coder.get` or a session summary; older daemons do not support this mode.
Returns `{ok: true, queued: true}` after persisting the text in the session's
`steering_messages`. Guidance is delivered at the next model-turn boundary;
an unused tool proposal from an in-flight inference is discarded if another
turn remains. An already executing tool is not interrupted. Use `coder.cancel`
to stop execution. This does not revise the approved checks or permissions.
The event `operator_guidance {text, status}` distinguishes `queued`, `applied`
(included in the next model request), and `not_applied` (the loop ended first).
At most 16 messages may be pending, with 64 accepted per task and 16 KiB per
message. Rejected guidance leaves the persisted history unchanged. Saved
guidance is included in linked-task observations for follow-up conversations;
it does not make a crashed task automatically resumable.
- **Params**: `{ session_id: string, text: string, steer?: boolean }`
- **Returns**: `{ ok: true }` when a pending request was fulfilled; errors with "no pending user-input request for this session" when nothing is waiting.
- Answers a mid-session `user_input_requested` event. The **native** loop can call an `ask_user` tool (offered to the model only when it genuinely cannot proceed without a user decision); the loop emits `user_input_requested { prompt }` and blocks until either `coder.respond` supplies `text` or a 600s timeout elapses (on timeout the model receives a tool error and continues). `coder.cancel` unblocks a waiting request immediately. The external/foreman CLIs own their own interaction model and do not surface this event.

#### `coder.approve_merge`
- **Params**: `{ session_id: string, approve: bool }`
- **Returns**: `{ state: "merged", branch, commit, excluded_artifacts: [...], contract_changes: [{ path, kind: "modified" | "deleted", allowed }], agent_id?, registry_path? }` on approve; `{ state: "abandoned" }` on deny. `excluded_artifacts` uses the `coder.get` shape above. `contract_changes` flags protected edits left in the delivered diff; `allowed: false` means checks ran the start-commit copy, not that delivery removed the edit. Agent-project approvals populate `agent_id` and the daemon-derived declarative `registry_path`; ordinary code-project approvals leave both null. When the project was created with `existing_agent_id`, `agent_id` is that same id rather than the project slug.
- The second human gate, valid only in `needs_approval`. Approve squash-commits the worktree (author `car-coder`) and creates `car/coder/<short-id>` in the repo — merge with `git merge <branch>`; fully reversible via `git branch -D`. An Agent rebuild replaces the matching registry entry and retains its immediately preceding spec as `previous` (one level only).
- On a session that builds an agent, only the CAR app or you at your terminal may approve or reject; see [agent builds](#managed-projects-coderprojects).
- **A pending no-change finding** (`needs_you: "finding"`, `no_change_finding` on `coder.get` with `resolved_at: null`) is decided by the same call, with an **explicit** optional param: `{ session_id, approve: true, accept_finding: true }` accepts it — publishes nothing, marks the finding `verification: "human_approved"`, emits `finding_resolved { accepted: true }`, and returns `{ state: "reported", branch: null }`. A plain `approve: true` on a finding is **refused** (it is what every pre-finding client and every unattended approver sends, and an accepted finding leaves nothing in git to review afterwards), and `accept_finding: true` on a session with a diff waiting is refused too. `approve: false` resolves the finding as rejected (`resolved_at` set, `verification` null), emits `finding_resolved { accepted: false }`, and abandons. A daemon session reaches a finding two ways: the native loop's `report_no_change` nomination, judged by the runtime (the native loop returns tool feedback for a nomination after its executor recorded an edit or when the run began with retained worktree changes, allowing ordinary verification to continue without undoing those changes; the runtime still refuses and fails an ineligible nomination that reaches adjudication, including a worktree moved off its provisioning commit; an admissible one **always** waits here — the daemon never takes `car code-task`'s autonomous path, because it cannot know a human read the contract), or a run that finished green with the worktree still on its provisioning commit and no edit recorded by the session's executor, which the runtime records itself (noting whether the baseline was already green) rather than offering an unpublishable empty diff. `car code --yes` never accepts a finding; it leaves it at the gate and exits non-zero.

- `delivery: "checkout"` applies the reviewed patch to the original checkout without moving its HEAD or staged index. It is available only for live, ordinary-repository tasks whose worktree starts from the checkout's current `HEAD` (or the private input snapshot committed on top of it) — a task started from an explicit `base`, a follow-up continuing a published branch, or a continuation whose checkout has since moved reports `checkout_delivery_available: false`, because its patch is computed against a tree the checkout does not have. Clients must check `checkout_delivery_available: true` in `coder.get` before sending this option, so an older daemon cannot silently ignore the additive option. A changed starting revision/branch or a conflicting patch is refused, preserving the worktree. Returns `{state:"merged", delivery:"checkout", branch:null, commit, repo, already_applied, excluded_artifacts:[...]}`. The commit is a private checkpoint under `refs/car/coder/<session-id>` for follow-up work, not a commit on the user's branch. Checks passed in the isolated worktree, not necessarily in a checkout with additional user edits. The default remains legacy branch delivery for callers omitting `delivery`. Managed projects retain their existing save flow. A task started from a dirty checkout also reports `inputs_snapshot: "<commit>"` — the private `refs/car/coder-inputs/<session-id>` commit holding the user's uncommitted work that the worktree starts from. It is informational: branch delivery rebuilds the delivered commit on the checkout's `HEAD` rather than on that snapshot, so the user's uncommitted work is never published, and a multiplayer stage is placed on that same `HEAD`.

#### `coder.cancel`
- **Params**: `{ session_id: string, reason?: string }`
- `reason` names a non-operator cause — a harness wall bound, a supervisor shutting down. The session records `failure_kind: "cancelled"` with the reason `cancelled: <reason>`. Omit it only when a person cancelled: the record then reads `cancelled by the operator`, and that sentence appears nowhere else. A blank reason or one over 1024 bytes is refused as invalid params. `car coder-ab run` sends `harness wall bound <N>s reached` when its explicit `--timeout-secs` fires, and the daemon itself names a disconnected headless client.
- **Returns**: `{ state: "abandoned", already_terminal: false, message: null, worktree: string | null, recoverable: bool }`
- Flags the loop, aborts and joins its task (in-flight shell processes are killed), and abandons the session. A standalone session cancelled while it is still `created` (contract/outcome derivation), or rejected at `contract_proposed` before confirmation starts, removes its task worktree, Git worktree registration, and any task branch; `worktree` is null and `recoverable` is false. If confirmation is already preparing work, an iteration has run, execution is running, or the session is conversation-backed, cancellation preserves the unfinished worktree for recovery. `worktree` is returned only while that path still exists, and `recoverable` additionally requires confirmed execution stop; a retained path alone does not prove execution stopped. Cancelling an already-terminal session leaves its prior cleanup or retention unchanged. Valid from any non-terminal state. Note: an in-flight **external** CLI invocation cannot be killed mid-run yet (same limitation as `agents.chat`); its own timeout bounds the wait.
- Cancelling an **already-terminal** session **succeeds** — same `state` key, same
  type — with `already_terminal: true` and an operator-readable `message`, e.g.
  `{ state: "merged", already_terminal: true, message: "coder-ab12cd34 was already merged — nothing left to cancel" }`.
  Deliberately not an error, unlike the confirm/approve/revise gates below, for
  two reasons: `car code`'s one-shot Ctrl-C path calls `coder.cancel`
  unconditionally, so a session that raced to terminal first would turn a quiet
  exit into a protocol error; and "stop this" on a session that already stopped
  is the outcome the caller wanted, so the honest answer is "yes, it's stopped,
  and here is why nothing happened just now". The `state` key and its type are
  unchanged for every input — the two new keys are purely additive.

#### `coder.discuss.*`

A repo-grounded, strictly **read-only** conversation that can be distilled into
a run intent. The gap it closes: `coder.start` demands a well-formed intent
before anything exists to react to, so an operator still working out *what* they
want either guesses (and burns a session on a badly-aimed contract) or goes and
thinks somewhere without the repo in front of them.

Grounding reuses the same `AssistantService` that backs `car do`, bound with
`bind_default_substrate(prefer_local = true, full_access = false, repo, None)` —
`PermissionTier::ReadOnly`, where every write and every shell escalates to an
approval gate. **This surface auto-DENIES those escalations** rather than
prompting: a discussion is a thinking surface, and the one property that must
hold unconditionally is that it never touches the repo. The refusal is visible
as a `tool_result { ok: false }` rather than silent. `coder.start` is the only
thing that starts work.

Discussion model transcripts and action receipts are checkpointed through the
daemon's existing assistant oplog, scoped to the discussion id and repository.
Use `coder.discuss.start { repo, resume_id }` to recover a closed conversation,
including after a daemon restart. Recovery rebuilds the read-only repository
runtime and projects saved user/assistant messages into a fresh event stream
(subscribe from sequence 0). The conversation id and exact model checkpoint
are retained. Local metadata binds recovery to the same canonical repository
and authenticated principal: operator connections share the single-owner daemon
identity; supervised agents are bound to their authenticated agent id. Caller
parameters cannot choose this identity. Resuming a conversation that is still
open **reattaches** to the live discussion instead of rebuilding it (see
below). Closing revokes its checkpoint writer before cancelling the turn,
preventing late writes from an old runtime after recovery.
This recovers discussions, not unfinished coding worktrees.

**Discussions are owned by a principal, not a connection, and outlive the
connection.** The owner is the same identity saved conversations are bound to:
`operator` for a connection authenticated with the daemon-wide token or the
host token (or on a daemon with auth disabled), `agent:<id>` for a connection
bound to a supervised agent with `session.auth { token, agent_id }`. A connection that opens, subscribes to, sends to,
promotes or starts a task from a discussion is *attached* to it until that
connection closes. Closing a connection (the app quits, sleeps, crashes or
reconnects) only detaches it and ends its event stream: **a turn in flight
keeps running**, and every event it emits lands in the discussion's replay
buffer. The owner reconnecting on a new connection finds the discussion in
`coder.discuss.list`, catches up with `coder.discuss.subscribe { from_seq }`
(from `0`, or one past the last `seq` it saw), and can `send` to it again.
`coder.discuss.start { repo, resume_id }` for a discussion that is still open
returns it with `resumed: true` and attaches the caller, so a client that
already reopens by id after a disconnect needs no other change. Passing a
`model` different from the live discussion's is refused; close it first.

A discussion **no connection is attached to** is closed once its turn has
ended and it has had no activity for the **detached TTL (1 hour)**, through the
same terminal close as `coder.discuss.close`. The TTL starts when the last
connection detaches or the turn ends, whichever is later, and is checked at
most once per TTL while a turn runs, so the close lands between one and two
TTLs after the turn ends. A running turn is never closed by it. A closed
discussion stays in `saved` and reopens with `resume_id`, including its
visible history. An explicit `coder.discuss.close` still closes at once and
cancels any turn in flight; a daemon shutdown ends every discussion with the
process.

Bounded five ways: at most **8 open discussions** per daemon (a slot is
reserved before the runtime is built, so pipelined starts cannot exceed it), a
**1-hour idle TTL** reaped on the next `coder.discuss.start` (activity is a
send, an attach, a subscribe or an event from the turn, so a working turn is
spared and one that has emitted nothing for an hour is stopped), the **1-hour
detached TTL** above, per-discussion caps on the replay buffer (2000 events,
oldest dropped) and the distillation transcript (40 turns retained, the most
recent 12 handed to `promote`), and a **64 KiB cap on one `send`**.

**Ownership is enforced, not merely recorded.** `send`, `subscribe`, `promote`,
`close` and `coder.start { discussion_id }` all refuse a caller whose principal
does not own the discussion, including while no connection is attached, with
`discussion '<id>' belongs to another principal — a discussion is owned by the
operator or agent that opened it; start your own with coder.discuss.start`.
`coder.discuss.list` keeps live `discussions` scoped to the caller's principal.
Its additive `saved` array lists closed conversations owned by the same
principal; conversations still open are excluded. Every operator connection is
the same principal, so two operator windows see and may drive the same open
discussion; a connection bound to an agent identity sees only that agent's.
The boundary is the credential: a process holding the daemon-wide token is the
operator here, as it is everywhere else on the daemon. Resolving by id alone let
any connected client drive, or close mid-turn, a discussion it did not open.

**One wedged subscriber cannot stall a discussion.** Each subscriber owns a
bounded outbound queue drained by its own task, so the discussion's event drain
never awaits a socket: a subscriber that stops reading (queue full, or a write
that does not complete within 10s) is **dropped from the fanout**, and its
`coder.discuss.event` stream simply ends. Re-`subscribe` with `from_seq` to
resume. The turn itself is unaffected either way.

**Read scope.** As well as auto-denying every write/shell escalation, the
discussion's bound environment pins the read tools (`read_file`, `list_dir`,
`find_files`, `grep_files`) inside the repo root. Mutation-gating alone left
those pointed at the whole filesystem, and their output streams to every
subscriber — so a prompt-injected repo file could ask for
`grep_files {"path":"/Users/<user>","pattern":"sk-ant-"}` and exfiltrate the
hits. Scoped to this surface; the general assistant's read reach is unchanged.

- `coder.discuss.start` — **Params** `{ repo: string, resume_id?: string, model?: string, organization_id?: string, personal?: boolean }`. **Returns**
  `{ discussion_id: "disc-…", repo, repo_summary, persistent: true, resumed: boolean, model: string | null }`. A non-git path errors with
  `"<path> is not a git repository — discuss needs a repo to ground itself in"`
  (the same git check `coder.start` uses).
  `model` pins replies, task distillation, and new linked native tasks to a
  registered tool-capable model without cross-model fallback. Models without
  tool support are rejected before opening, including a saved choice that is
  no longer supported. Omission restores the saved
  choice on resume; `"auto"` or a blank string clears it. The returned `model`
  is the effective saved choice, or `null` for default routing. Close the
  conversation before reopening it with a different model. Changing its saved
  model is refused while a linked task is unfinished. A pinned conversation
  selects the native engine for linked tasks and rejects an explicitly requested
  external engine; an explicit per-task model can override the conversation pin.
  A new conversation records its organization by the `coder.start` rule: a
  caller attached as an agent bound to a context keeps it; an agent with no
  organization of its own opens a personal one; otherwise `organization_id`
  (one a signed-in login holds) or `personal: true`, else the repository's
  `[organization] id`, else the default org, else personal. A default that
  cannot be used refuses and names `personal: true`. A reopened conversation
  keeps the organization it recorded, personal included, so `organization_id`
  and `personal` are refused with `resume_id`; one saved before ownership was
  recorded reopens personal. `coder.discuss.list` returns an operator's
  conversations in every organization, each saved row naming its
  `work_context`.
- `coder.discuss.send` — **Params** `{ discussion_id, text }`. **Returns**
  `{ ok: true, seq }`, where `seq` is the sequence number of the FIRST event
  this turn emits (the `user_message`), so a caller that has not yet subscribed
  can resume from exactly there without missing or replaying a frame. The reply
  streams as `coder.discuss.event`.
  **Returns as soon as the turn is dispatched** — it never waits on the model,
  and it never waits on a subscriber's socket, so a stalled board cannot delay
  it. **One turn at a time.** A `send` arriving while a turn is in flight is
  **refused** with `<id> is still answering the previous message — wait for
  \`turn_complete\` before sending another`, not queued: two overlapping turns
  clone the same model thread and the last to finish overwrites the other, so
  an exchange would vanish from the conversation *and* from what `promote`
  later distills. Wait for `turn_complete`. That in-flight latch is released on
  every exit path including a cancelled request, so a `send` that is abandoned
  mid-flight leaves the discussion answerable rather than stuck reporting "still
  answering" with nothing running.
  A message over **64 KiB** is refused naming its size and the limit; a `close`
  that lands while a `send` is still being dispatched refuses the `send` with
  `<id> was closed while your message was being dispatched` and starts no turn.
- `coder.discuss.subscribe` / `coder.discuss.unsubscribe` — **Params**
  `{ discussion_id, from_seq?: number }` / `{ discussion_id }`. **Returns**
  `{ events_replayed }` / `{ ok: true }`. Same replay-then-register-under-the-
  buffer-lock discipline as `coder.subscribe` (no gap, no dup). Owner-only.
  Replays events emitted while no connection was subscribed, up to the
  2000-event buffer. WS-only.
- `coder.discuss.promote` — **Params** `{ discussion_id }`. **Returns**
  `{ discussion_id, proposed_intent, constraints: string[] }`. **Starts
  nothing** — no worktree, no branch, no session. It is a pure distillation
  call: the caller shows `proposed_intent` (a distilled instruction, never the
  transcript) to the operator, who may edit it before calling `coder.start`.
  Callable repeatedly on an open discussion. **Refused while a turn is
  streaming** (`<id> is still answering — try again in a moment`): distilling
  then would run on the operator's question with no answer beside it, and the
  model would return a confident intent invented from an unanswered question —
  which then feeds `coder.start { discussion_id }` and contract derivation.
- `coder.discuss.close` — **Params** `{ discussion_id }`. **Returns**
  `{ ok: true }`. Frees the in-memory discussion, cancels any turn in flight
  and drops its subscribers, immediately, from any of the owner's connections.
  Owner-only.
Discussion answers and promotion read linked coder records matching both the
conversation id and repository. They include bounded check results and task status
as runtime observations, persisted with the model checkpoint. These observations
do not switch the repository checkout to a result branch or retained worktree.
Conversation-backed tasks retain their worktree on cancellation, failure, and
restart. Cancellation waits for the execution task to exit before returning its
retained path. `recoverable` is true only after native execution was joined.
For a conversation-backed task with no explicit base, the next `coder.start`
reopens this retained tree without reset and returns `resumed_from` naming the
prior task. It creates a fresh plan and verification run, preserving partial
files and recording the continuation link. Reopening validates both the state
directory and Git repository identity. A failed reopen cannot delete the tree.
Crash orphans and external-engine tasks remain retained but cannot automatically
resume without evidence that their execution stopped.
Starting another task from a discussion with unfinished linked work is refused;
finish or cancel the existing run first. New turns invalidate cached constraints.
For a raw-repository task with `discussion_id` and no explicit `base`, the next
worktree uses the previous delivery destination: a branch delivery starts from
the recorded `result_commit`, while a checkout delivery captures current checkout
files so later manual edits and deletions remain authoritative. Approval persists
the immutable result SHA and returns it as `commit`; branch movement does not
change a branch delivery's continuation base. A legacy delivery without a recorded SHA,
or retained failed/abandoned work without a confirmed native stop, refuses implicit
restart from repository HEAD.
Ambiguous delivery ordering (different commits with the same recorded timestamp)
also requires an explicit base. An explicit `base` remains authoritative.
Managed projects keep their existing
main-based delivery behavior.

- `coder.discuss.list` — **Params** `{}`. **Returns**
  `{ discussions: [{ discussion_id, repo, created_at, turns, answering }], saved: [{ discussion_id, repo, created_at }] }`.
  `discussions` contains the **caller's principal's** open discussions, whether
  or not any connection is attached, so a reconnected client finds what it left
  running; `answering` (additive) is `true` while a reply turn is in flight.
  `saved` contains the same principal's closed conversations, newest-created
  first.
  Missing `saved` indicates an older daemon without history discovery. Also serves
  as the **capability probe**: a daemon predating this work answers JSON-RPC
  `-32601` (method not found), which a client maps to a plain "this daemon is
  too old for discuss / promote / revise" message rather than a raw protocol
  error or a hang.

`coder.start` accepts `discussion_id`: the discussion's agreed `constraints` are
appended to the repo/intent context handed to contract derivation — so a
constraint stated only in the discussion lands in the drafted contract without
the operator restating it — and the session records the id, which `coder.get`
and every session summary surface as provenance. An unknown `discussion_id` is a
clear error; it never silently starts an ungrounded run. It must be **your own**
discussion, and it must not be mid-turn — starting while it is still answering
is refused, because the constraints would be distilled from a question with no
answer beside it. If extracting requirements from the conversation fails,
starting also fails before provisioning a task; retry after resolving model
access. Failure never substitutes an empty requirements list.

Carry-through is **verified against the checks, not the prose.** Each constraint
is judged against the drafted contract, and a constraint counts as captured only
when some check's command would fail if it were violated. A constraint that
reaches only the contract's `description` drives the repair loop like a dropped
one; if the attempt budget runs out with it still ungated, the contract comes
back with a `NOT VERIFIED BY THIS CONTRACT` block in its `description` naming
it. Render that block — it is the difference between a constraint the run
enforces and one it merely narrates.

#### Managed projects (`coder.projects.*`)

A **project** is a named, CAR-managed git repository under `~/.car/projects/<slug>/` — created and initialized for the user so the coder's worktree/branch machinery works underneath while they only ever see a name. The non-developer path: no repo to pick. Projects have a **kind** — `app` (generic code) or `agent` (an in-daemon declarative agent, see `declagents` below). A project session delivers on approve by committing straight to the project's `main` (fast-forward), not a `car/coder/<id>` branch. `coder.start` takes **exactly one of** `repo` (a raw git path) or `project` (a managed slug).

**Agent builds need the CAR app or you at your terminal.** An agent connected to CAR can't create, confirm or approve an agent build; the CAR app or you at your terminal can. Three calls take the authority `declagents.remove` takes: `coder.projects.create` with `kind: "agent"`, and `coder.confirm_contract` and `coder.approve_merge` (with either `approve` value) on a session that builds an agent. That authority is a host-management connection, or an unbound client on a daemon with no host token; a daemon started without authentication has none, so there any unbound client passes, an agent's included. Every other caller is refused with ``Building an agent needs the CAR app or `car agent new` in your terminal.`` App projects and ordinary coding sessions are unchanged. A connection bound to an agent is refused on every daemon, including one without a host token. `car agent new` and `car project new --kind agent` refuse with `Building an agent needs you at the terminal or in the CAR app.` when `CAR_AGENT_ID` is set, whether or not CAR's local host key exists. When stdin and stdout are a terminal (and, for `car agent new`, `--yes` is not given), they ask first (for example `Build an agent for "<description>" with CAR's permission? [y/N]`); nothing is sent to the daemon before the answer, a no sends nothing, and a yes connects with CAR's local host key when the key file exists. Otherwise (`--yes`, or no terminal) they never present the key and connect as usual, so a daemon with a host token refuses the build and one with no host token builds it. When a person said yes but there was no key file to present and a daemon with a host token refuses, they say where CAR expected the key and how to recreate it. Like every host-only action, this doesn't stop a program running as you that reads CAR's local host key.

- `coder.projects.create` — **Params** `{ name: string, kind?: "app"|"agent", existing_agent_id?: string, builder_draft?: { template_id, name, responsibility, example, access, cadence, delivery, privacy } }` (default `kind` is `app`; the two edit fields require `agent`). **Returns** `CoderProject { slug, display_name, kind, repo_path, created_at, existing_agent_id?, builder_draft? }`. `existing_agent_id` must name a registered declarative agent and makes the approved build replace that id instead of minting the project slug; an existing project cannot be rebound to a different id. `builder_draft` carries the seven guided answers and template id through registration. Idempotent: an existing slug loads its metadata (the persisted kind wins) and may refresh its staged builder draft. Agent project names are free-form build descriptions: descriptions whose sanitized form exceeds 64 characters receive an at-most-64-character slug made from a readable prefix plus a 16-hex-character digest, while `display_name` and the later `coder.start` intent retain the complete description. Slugs contain only lowercase ASCII letters, digits, and hyphens.
- `coder.projects.list` — **Params** `{}`. **Returns** `{ projects: [CoderProject] }`, newest first.
- `coder.projects.get` — **Params** `{ slug: string }`. **Returns** `CoderProject`.

### `coder.event`
Pushed to `coder.subscribe`d connections during a coder session. `seq` is
monotonically increasing per session (the resume cursor for
`coder.subscribe { from_seq }`).
```json
{
  "jsonrpc": "2.0",
  "method": "coder.event",
  "params": {
    "session_id": "coder-…",
    "seq": 17,
    "ts": 1781234567,
    "type": "check_completed",
    "result": {
      "name": "tests_pass", "command": "cargo test", "started_at": 1781234559,
      "passed": true, "exit_code": 0, "output_tail": "…",
      "protected_edits": [{"path":"checks/walk.sh","kind":"modified"}],
      "duration_ms": 8123, "timed_out": false, "deadline_clamped": false,
      "credentials_allowed": false,
      "credential_sources": {"OPENAI_API_KEY": "keychain"},
      "credentials_withheld": [],
      "network_isolation": "sandboxed",
      "evidence_dir": "/…/coder-…/evidence/1/tests_pass",
      "evidence_files": ["/…/coder-…/evidence/1/tests_pass/result.json", "/…/coder-…/evidence/1/tests_pass/stderr.txt", "/…/coder-…/evidence/1/tests_pass/stdout.txt"],
      "env": {"CAR_CHECK_EVIDENCE_DIR": "/…/coder-…/evidence/1/tests_pass", "CAR_CHECK_TMPDIR": "/…/coder-…/evidence/1/tests_pass/tmp", "CAR_HOME": "/…/coder-…/evidence/1/tests_pass/car-home", "INTERCEPTOR_GROUP": "cc-coder-…", "PATH": "/…", "PYTHONDONTWRITEBYTECODE": "1"},
      "cwd": "/…/worktree"
    }
  }
}
```
A `CheckResult` carries three additive booleans alongside the verdict (all
default to `false`, so older persisted results still deserialize) and an
additive `network_isolation` string and `secret_isolation` string; both default
to `"unavailable"` for old records. `keychain_access` is also additive and
defaults to `"denied"`. Its additive `protected_edits` array names
start-commit check files the builder modified or deleted and that this command
used; the check ran their pristine bytes. The array is empty when no protected
input changed or when a changed path was opted into `editable_paths`.
`credentials_allowed` records that command inspection omitted
`DenyCredentialAccess`; it does not grant or report an injected value and does
not describe the model shell, which always keeps that inspector. A contract check's
`credential_sources` records only injected names and value-free source labels;
`credentials_withheld` records declarations refused for missing approval.
Both are omitted when empty. Credential values never enter `env`, event
payloads, output tails, journals, session snapshots, or evidence files; exact
occurrences printed by a check are replaced with `[REDACTED:NAME]`. A human rerun resolves the
same source order without embedding a value by using
`NAME="$(car secrets get NAME --check-credential)"`. A contract check's
`cwd` and non-secret, runtime-injected `env` make the recorded command
copy-pasteable without persisting inherited environment variables or
credentials. The one inherited value recorded is the effective `PATH` after
the login shell and CAR's prepend, because the rerun must resolve the same
binaries. A contract check's
`timeout_secs` is optional: absent means it runs until it exits. The optional
`[coder] max_check_timeout_secs` is a separate operator ceiling; unset or `0`
means no ceiling. `timed_out` says the command was killed by either an explicit
check/operational cap, the session's remaining explicit wall-clock cap, or the
silence watchdog. A check that produces no output for `silence_window_secs`
returns `timed_out: true`, and `output_tail` ends with
`[runtime] check produced no output for <N>s (the silence window) and was killed`.
`deadline_clamped` is true only when the **session's** remaining wall-clock cap
killed it. Those two booleans together mean the check was starved by the session
clock and its `passed: false` is not a verdict on the work — see "A starved gate
is not a red contract" in `docs/car-code-task.md`. `timed_out: true` with
`deadline_clamped: false` is an ordinary red check, including a silence kill.
Evidence uses `<state dir>/<session-id>/evidence/<evaluation-n>/<check-name>/`,
with `stdout.txt`, `stderr.txt`, `result.json`, and anything the check writes under
`$CAR_CHECK_EVIDENCE_DIR`; `evaluation-n` counts the baseline, every repair
round, and the final gate in order. Text files are redacted with the same
feedback-bundle scrub up to 64 MiB per file; any larger stream or text artifact is
replaced with a placeholder instead of being retained unredacted, while a
larger binary artifact is kept as it always was. `output_tail`
keeps its type and size bound but is redacted with the same scrub before it is
emitted or persisted.
Recorded rerun lines export the recorded effective `PATH` inside the login
shell and restore `CAR_CHECK_TMPDIR` plus isolated `CAR_HOME`. On POSIX they
prepend the same `mktemp` function used for live execution, so top-level
`mktemp` calls write below evidence while nested programs continue to inherit
the host `TMPDIR`; Windows `cmd /C` has no prelude. Reruns include the complete
`sandbox-exec` or `unshare` wrapper for `sandboxed` results; approved and
unavailable results retain the plain shell invocation.
Before a check runs, a lexical policy denies recognized write targets outside
the worktree, evidence directory, `$CAR_CHECK_TMPDIR`, or `$CAR_HOME` and
records the failure in `stderr.txt`; `$TMPDIR` writes are outside those roots
and are denied. For
both model and check shells, every Interceptor browser verb must carry the
literal `--context interceptor-test` (a missing, indirect, or other context is
denied; metadata verbs and `macos` window automation need none).
`type` values and their payload fields: `state_changed {from, to}`,
`contract_proposed {contract}`, `engine_selected {engine, reason}`,
`harness_overlay {fingerprint, prompt_chars, tools}` (the native loop started
with an operator-approved system-prompt or tool-description overlay in force —
see `evolution.run`; `fingerprint` is a content hash, so two runs under
different overlays can be told apart),
`engine_fallback {from, to, reason}`,
`model_fallback {from, to, reason}` (the preferred inference **lane** was
skipped and a different MODEL served the call — distinct from
`engine_fallback`, which is about the coder engine, native vs an external CLI,
not the model behind it. Emitted at most once per **phase** — contract
derivation, each contract revision, and the run loop announce independently, and
a session that degrades in more than one of them emits more than one; the guard
is against narrating every routing decision inside a phase, not against a second
phase reporting a degrade the operator has not seen resolved. Emitted only when
the skipped lane's credential was **rejected**: the run keeps working on a
fallback backbone, so without this event an operator whose sign-in lapsed sees a
healthy run on a model they never chose, and `reason` names that remedy. A
degrade with another cause — a rate limit, a timeout — is deliberately NOT
announced here, because this event's wording tells the operator to sign in and
sending someone to fix a credential that is not broken is worse than saying
nothing.

Those degrades are not lost: a backbone change, whatever the cause, is written
to the session journal as `model_fallback` with `from`, `to` and a `reason` of
`credential_rejected` / `credential_absent` / `rate_limited` / `quota_exhausted`
/ `timed_out` / `failed`. One row per HOP of a fallback chain — `from` is the
candidate skipped and `to` is the next one tried, so a 1→2→3 chain is two rows,
not one summary.

Repeats are collapsed **consecutively**, not globally: a condition that persists
across fifty turns writes one row, but a lane that rate-limits, recovers, and
rate-limits again later writes a second — otherwise the journal could not tell
"changed once, early" from "flapped all run", which is the question it exists to
answer. The event stays latched per phase; the journal is
the surface to read for why a run's results changed mid-session (car#1351).

Two limits worth knowing before counting rows. A `reason` is classified from the
runtime's own typed error, so `credential_rejected` covers both a lapsed Parslee
session and a provider refusing an API key — broader than the sign-in
announcement above, deliberately, because those need different remedies.
(`quota_exhausted` is likewise kept apart from `rate_limited`: an empty balance
does not clear by waiting.) A statusless transport failure — connection refused,
DNS, TLS — is `failed` rather than `timed_out`, since the runtime cannot tell
those apart from a real deadline. And a
candidate the **router never offered** uses a second journal-only payload shape:
`model_fallback {lane, reason, until}`. `reason` is `rate_limited` when a prior
429 excluded the lane for the engine session, or `circuit_open` when the lane's
breaker filtered it before dispatch. `until` is the Unix cooldown end for an
open circuit and `null` for a session-long rate-limit exclusion or a half-open
circuit waiting on its probe. These pre-dispatch conditions are recorded once
per lane per coder session, unlike dispatched hops whose repeats are collapsed
only consecutively. They stay journal-only and do not change the live
`coder.model_fallback {from,to,reason}` event),
`iteration_started {n, max}` (`max: 0` means unlimited),
`verification_started {round}` (a fresh independent verifier began on one
frozen tree), `outcome_verdict {outcome_id, verdict, probes}` (one frozen
outcome's verdict and evidence references), `verifier_tool_call {round, tool,
params_preview}` and `verifier_tool_result {round, tool, ok, preview}` (one
independent-verifier tool call and its result, redacted like the builder's
`tool_call`/`tool_result`; `ok: false` carries the refusal reason in `preview`.
Journaled in the session's `.events.jsonl` with `data.actor: "verifier"` and
`action_id: "verifier:<tool>"`, kept apart from the builder's per-tool
buckets), `audit_completed {provider,
model_served, family, findings, unresolved}` (the different-vendor audit
attestation; `findings` contains defect claims only, while notes remain in the
persisted `verification.audit` and `unresolved` keeps the outstanding question
text),
`audit_reply {call, attempt, model, model_served, stop_reason, content_chars,
reasoning_chars, tool_calls, parsed, evidence_path}` (one reply from the
different-vendor auditor, parsed or not; `call` is `audit` or `follow-up-N`,
`attempt` counts retries of that call from 1, and `evidence_path` holds the
redacted reply body capped at 64 KiB. Journaled with `data.actor: "auditor"`.
An unusable reply is retried under the shared three-strike policy and then
ends the run as `infrastructure`),
`inference_waiting {elapsed_secs}` (a native model call is still pending,
reported every 15 seconds; not evidence of tool activity or completion),
`inference_retry {model, attempt, reason, backoff_ms}` (sanitized retry metadata
from the inference engine within one native model call; `attempt` starts at 2,
and `reason` is a generic failure class, not a provider response body),
`budget_exhausted {reason, elapsed_secs, iterations}` (the session hit its
wall-clock ceiling and the next iteration was not admitted; the session ends in
`failed` — it does not reach the approval gate, which requires green checks —
but its worktree is retained on disk at `workspace_path` so the partial work
survives for inspection),
`invocation_retried {hypothesis, reason, retries_remaining}` (an external-CLI
invocation died mid-run — timeout or I/O — with the contract still red, and the
same hypothesis is being re-invoked; this costs no `iteration_started`, so one
iteration may legitimately show two runs), `plan_text {text}`,
`outcomes_step {step, group: string | null, phase, outcomes: number | null,
detail: string | null}` (one fan-out, critic, or merge progress step;
`group` and `outcomes` are present when the step applies to one user group),
`outcome_dropped {kept, dropped, group, reason}` (the merge removed a duplicate
or contradiction and records which outcome survived),
`outcomes_written {path, groups: [{group, outcomes}]}` (the outcomes file was
written and reports the outcome count for each included group),
`tool_call {tool, params_preview}`,
`tool_result {tool, ok, preview, worktree_changed?}` (`worktree_changed` is
`true` only when that tool call changed the worktree and is omitted when false),
`check_started {name, index, total}` (`index` is one-based; `total` is the
number of checks in this evaluation),
`check_completed {result}`,
`contract_protected_edits {edits: [{path, kind}], allowed: [{path, kind}], note}`
(emitted once per evaluation that observes either kind; `allowed` paths ran the
builder's copy, while `edits` ran their start-commit copy),
`contract_protected_surface {paths: [{path, origin, kind}], unprotected_checks,
partially_protected: [{check, script, line, reason}], invoked_product_files:
[{path, invoked_by}]}`
(the complete start-commit grading boundary after each fresh capture; the
latest fields are also persisted on the session),
`contract_unprotected_check {check, warning}` (one visible warning per check
whose command names no start-commit test logic CAR can protect),
`contract_partial_protection {partial: {check, script, line, reason}, warning}`
(one visible warning per unresolved invocation inside protected helper logic),
`interceptor_group_close {group, success, detail, trigger}` (best-effort cleanup
after an evaluation pass whose contract contains an Interceptor check when
`trigger` is `"contract_pass"`, or once when a session ends when it is
`"session_end"`; `success: false` records the redacted spawn, timeout, or exit
failure without changing the contract verdict or terminal outcome),
`external_event {raw}` (forwarded external-CLI
stream event), `diff_ready {stat, patch, patch_truncated, patch_full_bytes, changed_paths, contract_overlap}` (`changed_paths` counts BOTH endpoints of a rename, so one moved file is two paths; `contract_overlap` lists checks whose commands execute paths this diff also modified — disclosure, not a denial),
`artifact_excluded {artifact: {path, reason, size_bytes}}` (one event per check effect reverted immediately or path withheld from staged review and delivery; `reason` values are listed under `coder.get`),
`user_input_requested {prompt}` (reserved),
`user_input_expired {prompt, waited_secs}` (the answer window closed
server-side without an answer and the loop carried on without one — the prompt
is DEAD). A client has no other way to learn this: the gate simply stops being
pending, which is only discoverable by asking again, so a board kept rendering
the question as live and counting it under "needs you" until the operator
refreshed. It also drives the `coder.session_changed` that drops `needs_you`
back to `null`,
`auth_required {message, wait_secs}` (the run is blocked on **sign-in**.
`wait_secs > 0` means the loop is waiting rather than failing — **not terminal**:
if a credential appears within `wait_secs` the session resumes where it stopped,
worktree intact, and no iteration is consumed. `wait_secs: 0` means this emitter
is **not** waiting and the call is ending: contract derivation and contract
revision are synchronous RPCs the client is blocked on, and a run loop with no
auth gate configured — the default adaptive-routing path — has nothing to poll a
sign-in against, so it says "sign in" and then fails the turn normally instead of
stalling for minutes — and it says it at most **once per run**, because it cannot
resume, so the second and third strike would repeat a prompt that has not changed.
A `wait_secs > 0` emitter repeats on every lapse instead: it can resume, so a
second lapse after a successful sign-in is a new event the operator must act on
again. Either way the remedy is the same: `car auth login`, then
start or revise again). Surface this as an action the user can take ("sign in to
continue"), not as an error: it is the one failure mode a person at the machine
clears in seconds, and it previously surfaced as `no inference backend is
available`, which points at models and accounts rather than at the sign-in it
actually needs. Only the **native** engine emits it — an external CLI owns its
own credentials, so CAR has nothing to re-authenticate on its behalf. If nobody
signs in within the window the session ends with a distinct `needs_auth`
failure rather than `infrastructure`, and its worktree is retained, so re-running
after `car auth login` resumes from the work already done.
`contract_revision_rejected {request, reason}` (a `coder.revise_contract`
request could NOT be honored — the redraft did not validate, or the request was
not expressible as checks — and the session is still sitting on the PREVIOUS
contract; its own event rather than a generic `error` because an operator has to
know the contract in front of them is the old one),
`merge_completed {branch}`, `error {message}`.

### `coder.session_changed`
Pushed to `coder.watch`ing connections whenever any session is created, changes
`state`, changes `needs_you`, changes `error`, or reaches a terminal state.
```json
{
  "jsonrpc": "2.0",
  "method": "coder.session_changed",
  "params": { "summary": { "session_id": "coder-…", "state": "needs_approval", "needs_you": "approval", "needs_you_label": "diff ready for approval", "…": "…" } }
}
```
`summary` is the full `session_summary` documented under `coder.list`. Emitted
from the event path rather than a poller, so an operator-attention transition
reaches an open board in well under 5 s. It is a *notification*, not a stream
with a cursor: a client that missed frames re-derives the whole list from
`coder.watch`.

### `coder.discuss.event`
Pushed to `coder.discuss.subscribe`d connections during a discussion. `seq` is
monotonic per discussion (the resume cursor for
`coder.discuss.subscribe { from_seq }`).
```json
{
  "jsonrpc": "2.0",
  "method": "coder.discuss.event",
  "params": { "discussion_id": "disc-…", "seq": 7, "ts": 1781234567, "type": "assistant_delta", "text": "…" }
}
```
`type` values and their payload fields: `user_message {text}`,
`history_notice {message}` (nonterminal recovery, retention, or history-write notice),
`inference_started {model, attempt}` (a request began, not proof of generation progress),
`inference_retry {model, attempt, reason, backoff_ms}` (nonterminal retry status),
`model_served {model_id, local_last_resort}` (actual serving model and on-device fallback attribution),
`assistant_delta {text}` (streaming chunk), `assistant_message {text}`
(the complete turn), `tool_call {tool, params_preview}`,
`tool_result {tool, ok, preview}` — **`ok` is always `false` today**: the underlying loop does not surface successful tool results as their own event (the model's following text conveys them), so the only `tool_result` emitted is the auto-denied write/shell refusal below. Treat a success row as reserved, not as something to wait for.
`task_prepared {proposed_intent, constraints}` (an editable task prepared from an
implementation request; no execution or approval has occurred),
`turn_complete {}`, `error {message}`.

Before `prepare_coding_task` can save a proposal, a separate model review checks
the latest user request against the proposed change and recent role-tagged
conversation. It uses the conversation's selected model, offers no tools, and
requires a boolean approval. Explicit verification and continuation of stopped
work qualify even when the request prohibits additional edits; questions and
planning-only requests do not. Refusal, malformed output or inference failure
leaves the proposal unset and returns feedback to the discussion loop. This is
an additional semantic check, not a deterministic proof of user intent; check
approval remains required before execution.

`task_prepared` is emitted when `prepare_coding_task` succeeds. The shared
assistant loop ends that reply immediately with a host-authored review notice,
without another model request. Remaining tool calls in the same response are
recorded as skipped, not executed, and checkpointed before the handoff. A failed
or policy-denied preparation does not end the reply, so the assistant can explain
or correct it. Clients may show the existing task editor, but must preserve
unsent drafts and deduplicate by `seq`. Terminal and desktop clients can prepare
checks directly for the current submitted request: they require its acknowledged
`coder.discuss.send` sequence, a later `task_prepared`, and the subsequent
`turn_complete`. A replayed proposal alone never triggers this transition, and
an unsent correction or edited task summary keeps the task in manual review.
Existing `coder.start` and check review remain required before execution. Prepared proposals and constraints are persisted
in the owned conversation record and replayed as `task_prepared` after reopening.
A new conversation turn or acceptance through `coder.start` clears the saved
proposal. Unsent client-side edits are not included in that saved proposal.

A `tool_result` with `ok: false` is how the no-mutation boundary surfaces: a
discussion's write/shell attempt is auto-denied and reported, never silently
dropped and never parked as a human approval prompt.

Each subscriber is fanned to through its own bounded queue, so a subscriber that
stops reading is **dropped from the fanout** (queue full, or a write that does
not complete within 10 s) rather than being allowed to delay the discussion's
turn. Its stream just ends; re-`subscribe` with `from_seq` to resume from the
last `seq` seen, up to the 2000-event buffer.

When the **Foreman (parallel)** engine runs, it reports its pipeline through
`external_event` payloads whose `raw` object is tagged `foreman`. Run-level
stages: `{foreman: "planning", adapter}`, `{foreman: "planned", subtasks,
levels, prefer_single_session}`, `{foreman: "union_verified", applied}`, and
`{foreman: "union_rejected", reason, implicated, detail}` — emitted when the
integrated union is rejected even though the subtasks gated green individually;
`reason` is `patch conflict` | `duplicate declaration` | `build/test failed` |
`rejected`, `implicated` is the list of subtask ids blame attributes the failure
to, and `detail` is a short human string. A renderer flags the implicated rows
and shows why (see the CarHost Coder tab's board).
Per-subtask lifecycle (per farmed-out subtask, in order):
`{foreman: "subtask_started", subtask_id, index, level, total}` (worktree
provisioned, agent editing) →
`{foreman: "subtask_verifying", subtask_id}` (agent done, gate build/test
running — its own event because that phase can dominate wall-clock) →
`{foreman: "subtask_gated", subtask_id, accepted, status}` where `status` is
`accepted` | `rejected` | `inconclusive` | `error`. (An agent that fails before
the gate goes `subtask_started` → `subtask_gated` with `status: "error"`, no
`subtask_verifying`.) Subtasks in the same `level` run concurrently, so their
events interleave. A renderer can fold these into a live per-subtask board (see
the CarHost Coder tab). Unknown `foreman` stages should be ignored
(forward-compatible).

---


{% endraw %}
