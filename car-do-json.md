{% raw %}
# `car do --json` — the machine-readable run contract

`car do --json` is how another agent delegates work to CAR's assistant. It is
the contract behind the Claude Code subagent and the Codex skill described in
`docs/proposals/car-as-editor-plugin.md`, and it is a **public wire contract**:
anything parsing it is entitled to the guarantees on this page.

Current schema: **`car.do/1`**.

## Two streams

| Stream | Contents |
|---|---|
| **stdout** | Exactly one JSON document, written once, at the end. Nothing else, ever. |
| **stderr** | JSONL progress events, one object per line, written as they happen. |

`--json` also suppresses the human progress rendering and quiets the default
tracing filter to `warn`, so stderr is *mostly* pure JSONL.

**It is not guaranteed pure.** Warnings from the runtime — version skew,
credential expiry — can still land there. **Parse only lines beginning with
`{` and ignore the rest.** stdout is never mixed: it is always exactly one
document, including on failure.

Do not discard stderr with `2>/dev/null`. The event stream is the only record
of what happened during the run.

A checkpointed foreground one-shot run includes a `run_id` in its `started`
event and final stdout document. CAR checkpoints its exact model-facing
transcript after each
completed turn through the daemon's sync oplog. If inference fails after doing
useful work, continue from the latest checkpoint with:

```bash
car do --resume <run-id>
# Repeating the original text is allowed, but it must be byte-for-byte identical:
car do --resume <run-id> "the original goal"
```

An omitted goal is restored from the checkpoint. A different goal, a different
working repository, or a changed model-visible tool set is refused before
inference. The resumed loop keeps the same run id, prior tool receipts, task list, and
receipt-journal hash chain, and numbers its next inference turn after the last
completed checkpointed turn. That turn total is the loop's own count, so history
compaction never lowers it and `max_turns` stays a cap over the whole run. If the
run stopped after the model asked for tool calls but before every result was
recorded, those calls are not run again (the stopped process may already have
run them): each one is answered with a failed result saying its outcome is
unknown and it was not replayed, before the next inference, and a `text` event
names their tools. The restored task list is rendered in the next
turn's state block and reported as a `todos` event on that turn's first
successful `todo_write`, not at startup. `--resume` is for one-shot runs and cannot be
combined with `--serve`, `--until`, or `--infer-until`. A new run remains usable
when no daemon is available, but human output says it could not checkpoint and
JSON output omits `run_id`; that run cannot be resumed. Resuming always requires
the daemon that owns the sync oplog.

Neither Claude Code nor Codex streams a shell call, so in practice you read the
events after the process exits. They are still what lets you explain a slow run
and report what was rejected mid-flight, rather than narrating from the final
document alone.

## Check `status` first

The success and failure documents have **different shapes**. A failed run —
`status: "error"` or `status: "auth_required"` — has no `summary` key — deliberately, so that a consumer reading `summary` without
checking `status` gets a missing key rather than quietly presenting a transport
failure as the run's answer.

```jsonc
// status: "success" | "success_substituted" | "max_turns"
{
  "schema": "car.do/1",
  "status": "success_substituted",  // "success" when nothing substituted (below)
  "run_id": "run-…",          // pass to car do --resume after an interrupted run
  "summary": "…",              // the assistant's final text
  "turns": 7,                  // the parent loop's own turns — a delegate's are not counted
  "delegations": 1,            // `delegate` calls issued (0 when none)
  "model_used": "mlx/qwen3-4b:4bit", // canonical model on the final turn
  "models_served": [             // every completed turn, in order
    { "model_id": "openai/gpt-5", "local_last_resort": false },
    { "model_id": "mlx/qwen3-4b:4bit", "local_last_resort": true,
      "substituted_from": "openai/gpt-5", "substitution_reason": "timed_out" }
  ],
  "substituted_from": "openai/gpt-5",  // only when a turn was answered by a substitute
  "substitution_reason": "timed_out",
  "receipts": { … },
  "ungrounded_claims": [ … ],
  "sandbox": { … },
  "work_context": null,        // the bound org, or null for personal work (see below)
  "elapsed_seconds": 94.2,
  "goal": { … }                // only for --until / --infer-until runs
}
```

**`success_substituted` is an answer, but not from the model you asked for.**
A run that finished with an answer keeps the `summary` shape and exits 0 either
way; `status` is `"success"` only when every turn was answered by the model the
run named. When any turn was answered by a substitute, `status` is
`"success_substituted"` and the document adds `substituted_from` (the model the
run named) and `substitution_reason`. There are two ways it happens:

- **At request time**, without `--strict-model`: the named model fails — a
  rejected credential, a timeout, a 5xx — and CAR finishes the turn on an
  on-device model installed through CAR. `substitution_reason` is
  `credential_rejected`, `credential_absent`, `rate_limited`,
  `quota_exhausted`, `timed_out`, or `failed`, and the turn's `models_served`
  entry has `local_last_resort: true`.
- **At startup**: the named model cannot call tools, or is not available here,
  and `car do` picks another (it says so on stderr, too). `substitution_reason`
  is `not_tool_capable` or `unavailable` — `unavailable` also covers a listed
  model too large for this machine's memory — and every turn that substitute
  serves carries the same two fields.

The top-level fields describe the first substitution; each substituted turn
also carries them in `models_served` and on its `model_served` event. Their
absence means nothing substituted. A run that stopped at `max_turns` or
`stalled` keeps that status and still carries the two fields when it
substituted, and so do the `error` and `auth_required` documents.

"Installed through CAR" means the model's files are in CAR's models directory —
put there by `car models install` / `car models pull`, CarHost's Models setup,
or by hand — or CAR holds its install receipt. A model whose only copy is a
snapshot in the shared Hugging Face cache is never substituted; when the run
then fails with no fallback, the error names `car models adopt <id>` for each
such model, which makes it eligible. Among eligible on-device models the
fallback is the most capable that fits in free memory: a tool-capable one first,
then the largest. Pass `--strict-model` to fail instead of substituting at all.

```jsonc
// status: "error"
{
  "schema": "car.do/1",
  "status": "error",
  "run_id": "run-…",          // resume handle; prior receipts remain in this run
  "error": "AssistantLoopFailed",
  "message": "…",              // NOT `summary`
  "turns": 9,                   // attempts consumed, including the failed turn
  "turns_completed": 8,         // primary model turns that returned successfully
  "failure": {                  // typed; branch on `cause`, not `message`
    "cause": "transient_inference",
    "status": 503                // provider HTTP status, or null for transport failures
  },
  "model_used": "…",
  "models_served": [ … ],      // completed turns before failure remain attributable
  "receipts": { … },           // work done before the failure is still reported
  "sandbox": { … },
  "work_context": null,
  "elapsed_seconds": 12.4,
  "suggestions": ["…"]
}
```

```jsonc
// status: "auth_required"
{
  "schema": "car.do/1",
  "status": "auth_required",
  "run_id": "run-…",
  "error": "AuthRequired",     // a string, like every other `error` value
  "reason": "signed_out",      // "signed_out" | "expired" | "no_workspace"
  "message": "…",              // NOT `summary` — the remedy, in plain language
  "turns": 1,
  "turns_completed": 0,
  "model_used": "…",
  "models_served": [ … ],
  "receipts": { … },
  "sandbox": { … },
  "work_context": null,
  "elapsed_seconds": 0.4,
  "suggestions": ["Sign in to your Parslee account, then re-run.", "…"]
}
```

A run that tried an action and never got it done also ends with
`status: "error"`, even when the model's final answer explains why politely.
`error` and `failure.cause` say which:

- `"ApprovalDenied"` / `"approval_denied"` — a person declined at the prompt,
  or a standing answer they saved said no.
- `"NeededApproval"` / `"needed_approval"` — nobody could be asked: no
  terminal (piped input, a CI job), the prompt could not be shown, or the
  request timed out.
- `"ActionFailed"` / `"action_failed"` — the action could not run, or
  the approval machinery around it failed.

`message` is the model's answer followed by a plain line saying the request did
not finish. A refused action is cleared only by a later successful call of the
same tool **with the same arguments**: approving a fetch of one URL does not
fetch the URL that was declined. A failed action is cleared by any later
successful call of the same tool, since that is how a model corrects arguments
it got wrong. A command that ran and exited non-zero (a `grep` that found
nothing) is a result the model reads, not a failed action.

**Exit codes for a batch run** follow whether the turn finished: `0` when it
did (`success`), `1` when it did not (`error`, `max_turns`, `stalled`,
`cancelled`, including a refused action), `3` for `auth_required`, and `2`
when the run never started.

On an `AssistantLoopFailed` inference error, `failure.cause` is
`"transient_inference"` when the remote retry budget was exhausted and
`"inference"` for another generation failure. A transient failure also carries
`failure.status`: the provider HTTP status when one exists, otherwise `null`
for a transport/body-read timeout. `message` remains explanatory text; do not
parse it to recover the cause. `turns_completed` deliberately differs from
`turns`: the latter includes the failed in-flight attempt, while the former
counts only primary model calls that returned. Receipts retain the same bounded
success shape, so inspect `receipts.total` rather than treating `sample` as the
complete list.

The first suggestion is chosen by `reason` and never contains a shell command —
this document is read by programs and by hosts with their own sign-in entry, and
a `no_workspace` account is not repaired by signing in at all. `signed_out`:
"Sign in to your Parslee account, then re-run."; `expired`: "Your Parslee
sign-in has expired. Sign in again, then re-run."; `no_workspace`: "Finish
setting up your Parslee account at parslee.ai, then re-run."

`auth_required` is the third terminal status. The out-of-the-box agent runs on
Parslee inference through a Parslee account, so a run with no usable account
ends here rather than on a local model: the turn was refused, not attempted.
It takes the failure shape — no `summary` — because it is not an answer, and
`reason` is what you branch on (`message` is for a person to read). A batch
run exits **3**; exit 2 still means the run never started. `reason` and `message` are additive fields
on the existing schema, so `car.do/1` is unchanged.

An explicit `--model` or `CAR_DO_MODEL` is not affected: naming a model keeps
the previous selection behaviour for it, including the on-device fallback.

`work_context` names the organization the run works in: `--org`, the
repository's declared org, or your default org. It appears on `started` and on
every terminal document as `{ "api_base", "account_id", "organization_id" }`,
and it is `null` for personal work. Runs started through the MCP endpoint's
`assistant_start` bind by the same rule and report it the same way. A bound
run keeps its memory and trajectories (and, for `car do`, its receipts) in that
org's private store and has only that org's own-account tools, so check the
field before treating a result as personal. It is an additive field, so
`car.do/1` is unchanged.

A flag error before the run starts (`--json` with `--serve`, `--json` with no
goal, `--until` and `--infer-until` together, a `--json-schema` file that is
unreadable, not JSON, or not a valid JSON Schema) produces the error shape with
`error: "InvalidArguments"` and no run fields. `--strict-model` with a model
that would have been substituted produces the same shape with
`error: "StrictModelUnavailable"` and `suggestions` naming the two ways out
(drop the flag, or name a model that is available here); `--strict-model` with
a format the model's protocol rejects produces `error:
"ResponseFormatUnsupported"`. A run that would work in an organization but
cannot be bound produces `error: "WorkContextUnavailable"`. That happens when
the daemon is not running, or when the org cannot be used, for example because
no signed-in login holds it. The stdout invariant
holds even then: a `--json` invocation always writes exactly one document, so
you never have to distinguish "no output" from "no answer".

## Flags that change what the document says

- `--response-format json_object` / `--json-schema <file>`: `summary` is the
  assistant's final answer constrained to JSON — parse it, but still through
  the 4096-byte cap below (a large object is elided with the marker, not
  silently cut). The constraint applies to the final answer only: turns that
  offer tools are never JSON-constrained (that suppresses tool use), so the
  run's receipts look exactly as they would without the flag. The loop checks
  the final answer itself — for `--json-schema` it validates against the
  schema, so valid JSON of the wrong shape counts as a miss — and, only on a
  miss, re-asks the model once without tools and with the format on; that
  repair shows up as `[format repair: …]` `text` events (see the event
  stream), and an answer that already parses (and conforms) costs no extra
  call. The repair turn is provider-dependent: Anthropic-protocol models
  reject the format there, and a FAILED repair call returns the draft answer
  with a `[format repair failed: …]` `text` event — `summary` is then the
  draft, not JSON, so parse defensively. `car do` warns at startup when the
  named model's protocol is known to reject the format, and refuses with
  `error: "ResponseFormatUnsupported"` (exit 2) under `--strict-model`.
- `--strict-model`: no substitution is ever announced — a model that cannot
  run here is the `StrictModelUnavailable` startup error above.
- `--context-window <tokens>`: bounds the running history to a smaller window
  than the registry's. A value above the model's known window is clamped and
  reported as a `[context window: …]` `text` event.

## `ungrounded_claims` — do not drop these

Operational claims the final prose makes that **no tool receipt from the same
run supports**: "I ran the tests" with no matching shell call, "I created X"
with no matching write.

This is the mechanical half of the assistant's receipts-decide-completion rule.
It is a field rather than a note appended to the summary precisely so a
relaying agent cannot quietly drop it — surface every entry.

Negated file-operation statements such as "No files were edited" or "I have not
read the files" do not assert completed work. Separate affirmative clauses still
require receipts: "No files were edited, but I read the source" claims a read.

Two limits, and both matter:

- Detection is **lexical and conservative**. An empty array means *nothing was
  detected*, not *the summary is verified*. Never report an empty
  `ungrounded_claims` as a clean bill of health.
- A populated array does not mean the assistant lied. It means the wording
  claimed an operation the receipts do not show, which is worth saying out loud
  and is not the same as a false result.

## `receipts`

Counts plus a bounded, failure-first sample — never a transcript.

```jsonc
"receipts": {
  "total": 23,
  "failed": 1,
  "by_tool": { "shell": 11, "write_file": 6, "recall": 3, "http_request": 3 },
  "sample": [ { "tool": "shell", "ok": false, "brief": "cargo test -q" } ],
  "sample_omitted": 15
}
```

Failures are selected into `sample` first — that is what a caller diagnosing a
run needs, and `by_tool` already accounts for the successes. `sample_omitted`
states how many receipts did not make it in, because a sample that silently
drops 15 calls reads as a complete list to anyone who does not check `total`.

`brief` is a one-line gist drawn from the identifying parameter (`command`,
`path`, `url`, `query`, `goal`, `expression`, `subject`, `name`, `content`),
not the full parameter object. Parameters carry file contents, request bodies,
and whatever the model put in a shell command.

### The `delegate` receipt

`delegate` is the assistant's fresh-context sub-agent: the parent hands it a
`goal` (and optionally a `tools` subset and a `max_turns` budget), the child
runs to completion in-process with an empty transcript, and the parent gets
back only the child's final text. In this document a delegation is **one
receipt** — `tool: "delegate"`, `brief` = the goal — with `ok: true` when the
child finished and `ok: false` when it hit its turn cap, stalled, was
cancelled, or errored (the parent sees the reason as the tool result, so an
unfinished delegation is never read as an answer). The child's own receipts
are ALSO merged into `receipts` — counted in `total` / `by_tool`, and marked
`"via": "delegate:<call id>"` when they appear in `sample` — so the evidence
for what a delegation actually ran is in the document, and a claim the child's
work supports ("the tests passed") is grounded rather than flagged. The
child's turns are still not in `turns`; `delegations` counts how many children
were issued. A run may issue at most `--max-delegations` children (default 20,
plus a 300-cumulative-child-turn ceiling); past the budget a `delegate` call
is an `ok: false` receipt with a "delegation budget exhausted" result and no
child runs. A child inherits every gate the parent has and cannot delegate
further. The tool exists only on `car do` foreground runs — the MCP assistant
surface and `--serve` do not advertise it.

## `sandbox`

What the run was actually bound to, not what was requested.

```jsonc
"sandbox": {
  "mode": "docker",            // or "local"
  "image": "python:3.11",      // null when local
  "network": "none",           // "host" when local
  "tier": "SandboxEdit",       // permission tier
  "root": "/work",             // where the run stands
  "mount": null,               // non-null ⇒ the container can reach MORE than root
  "fallback_notice": null      // non-null ⇒ sandbox was requested and unavailable
}
```

`fallback_notice` is the field to check. A run that *silently fell back* to the
local host is materially different from one that chose it, and a caller
reporting on an autonomous run should say which happened.

`mount` is non-null when the run started inside a subdirectory of a git
repository. The repository root is mounted — otherwise `.git` sits outside the
container and the run has no history, branch, or remote — while `root` stays the
subdirectory the caller asked for. A caller reporting on what an autonomous run
could *touch* must read `mount`, falling back to `root`; `root` alone answers
only where the run stood.

## `goal` — only for `--until` / `--infer-until`

```jsonc
"goal": {
  "check": "cargo test -q",
  "passed": true,
  "grounded": true,
  "iterations": 3,
  "halt": null                 // set when the governor stopped the run
}
```

**`grounded` is reported separately from `passed` on purpose.** `passed: true,
grounded: false` means completion was established by a model judge rather than
the deterministic check. That is a weaker result, and a caller that collapses
the two will report it as verified when it is not.

## Event stream

Each stderr line is `{"type", "phase", "message", "data"}`.

| `type` | Meaning |
|---|---|
| `started` | Run began. `data` carries the goal, model, sandbox posture, and `work_context` (the bound org, or `null`). |
| `inference_started` | A model call is about to begin, emitted before CAR awaits the generator. `data.model` is the requested model (or `(router)`), `data.attempt` is `1`, and `data.turn` is the assistant turn. |
| `inference_retry` | A transient remote failure will be retried. `data.model` is the canonical model, `data.attempt` is the attempt about to start, `data.reason` is a generic failure class (`http_status` or `transport`), and `data.backoff_ms` is the delay before it starts. Provider response bodies are never copied into this event. |
| `model_served` | One model call completed. `data.model_id` is the canonical model that served the turn; `data.local_last_resort` is true only when CAR appended and then used an on-device model behind a remote-only chain, and on a substituted turn (last resort, or every turn after a startup substitution) `data.substituted_from` and `data.substitution_reason` name the model it stood in for and why. |
| `text` | The model's prose for a turn — plus the loop's own bracketed notices (below). |
| `tool_called` | A tool is about to run. `data.call_id` is CAR-generated, `data.sequence` is its one-based position in the turn, plus `data.tool` and `data.brief` (the goal, for `delegate`). |
| `tool_result` | A tool succeeded. `data.call_id` and `data.sequence` match its `tool_called` event. |
| `tool_failed` | A tool failed, was denied, or was cancelled. A tool that returned normally but reported its own failure (`"ok": false`, a non-null `error`, `"success": false`, or `"status": "Failed"` in its top-level result) also emits `tool_failed`. `data.call_id` and `data.sequence` still close the matching request. |
| `todos` | The run's whole task list after a successful `todo_write`. `data.items` is `[{id, text, status}]`, where `status` is `open`, `done`, or `dropped`. Not emitted for a rejected write. |
| `goal_evaluated` | One goal-loop verdict. `data.iteration`, `data.met`, `data.grounded`. |
| `completed` | Run finished. `data.models_served` matches the terminal receipt. |
| `failed` | Run failed. `data.error`; completed calls remain in `data.models_served`. Mid-loop failures also carry `data.turns_completed` and the typed `data.failure` when known. |

**Exactly one of `completed` / `failed` terminates every run.** A stream that
carries `started` and neither terminator means the process was killed — say
that, rather than guessing at a result from the partial stream. A host can use
`inference_started` to distinguish an awaited model call from silence between
loop stages, and `inference_retry` resets that liveness window before each
remote backoff. Neither event is a success receipt; only `model_served` says a
call completed.

`Done` and `Error` from the internal loop are deliberately not emitted as
events: the terminal event is written alongside the stdout document, so the two
can never disagree about how the run ended.

Human-readable `car do` prints `model: <id>` on stderr for every completed model
turn. If the appended on-device last resort served it, the line is marked with a
warning and says `(on-device last-resort fallback in place of <requested>: <reason>)`. This attribution is per
turn. On an assistant-loop error, the terminal block goes to stderr and prints
the typed cause (when known), completed versus consumed turns, and preserved
receipt totals/by-tool counts before the error message. The terminal document's
`models_served` array retains every completed turn in order, including turns
before an error; `model_used` is the canonical model id for its final entry.
Durable assistant transcripts store the same `model_id` and
`local_last_resort` metadata on each assistant message, without sending that
metadata back to providers during replay.

These loop notices arrive as `text` events whose message starts with `[`, so a
consumer can tell them from the model's prose:

| message starts with | Meaning |
|---|---|
| `[delegate: <goal> — N turns, ok]` / `…, error]` | A `delegate` call returned; `N` is the child's turn count, never added to `turns`. |
| `[format repair: …]` | Under `--response-format` / `--json-schema`, the final answer was not the requested JSON (for a schema: did not conform) and the model was re-asked once with no tools. A second line says if the repaired answer still misses; it is returned as-is. |
| `[format repair failed: …]` | The repair call itself errored (e.g. the model's protocol rejects the format); the DRAFT answer is returned. |
| `[context window: …]` | `--context-window` asked for more than the model's known window and was clamped to it. |
| `[N interrupted tool call(s) were not replayed: <tools>]` | On resume, tool calls the stopped run asked for but never recorded a result for were answered as failed with an unknown outcome, and were not run again. |

## Truncation

Every bound states what it dropped rather than clipping silently:

```
…[truncated: 4096 of 8231 bytes shown; 4135 elided]…
```

The summary is capped at 4096 bytes and a `brief` at 160. This is a
correctness property, not cosmetics: **Codex has no plugin-authored subagent
surface**, so a `car do` delegation there runs as a skill on the main thread
and every byte lands in the user's primary context. An envelope sized for
Claude Code's isolated subagent poisons Codex sessions.

## What `--json` refuses

- `--serve` — a long-lived supervised agent has no terminal document.
- No goal (the interactive REPL) — an open-ended conversation has no single
  result to describe.

Both exit 2 with an `InvalidArguments` document. (`--response-format` and
`--json-schema` are likewise refused with `--serve`, `--json` or not: a
conversational agent has no single final answer to constrain.)

## The same envelope over MCP

`car do --json` is not the only producer. The daemon's MCP endpoint runs the
same assistant through `assistant_start` / `assistant_poll` /
`assistant_cancel` (car#972 §6), and a poll returns **these exact shapes**:

- `assistant_poll`'s `events` are the stderr JSONL events above, each with a
  monotonic `seq` added so a caller can resume from a cursor.
- Once the run is terminal, `assistant_poll`'s `result` is the stdout document
  above, verbatim — same keys, same truncation caps.

That is deliberate rather than convenient. The truncation exists because a
delegating caller pays for every byte in the user's context, and that reasoning
applies to an MCP tool result exactly as it applies to a Codex skill; a second
envelope would have been a second place to forget it. The builder lives in
`car_server_core::assistant::do_json` — it moved out of `car-cli` when the MCP
tools landed — and both callers construct their values with the same code,
which is what makes "the same envelope" a property rather than a promise.

Read `status` twice when polling: the poll's own `status`
(`running`/`ok`/`error`/`cancelled`) describes the run **handle**, and this
document's `status` describes the **work**. See `docs/websocket-protocol.md`
for the poll contract and its bounds.

## Compatibility

Additive fields are compatible and may appear without notice. Removing a field
or changing its type is not, and takes a new schema id. Pin on the `schema`
value if you need to.

{% endraw %}
