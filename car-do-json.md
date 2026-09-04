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

Neither Claude Code nor Codex streams a shell call, so in practice you read the
events after the process exits. They are still what lets you explain a slow run
and report what was rejected mid-flight, rather than narrating from the final
document alone.

## Check `status` first

The success and failure documents have **different shapes**. A failed run has
no `summary` key — deliberately, so that a consumer reading `summary` without
checking `status` gets a missing key rather than quietly presenting a transport
failure as the run's answer.

```jsonc
// status: "success" | "max_turns"
{
  "schema": "car.do/1",
  "status": "success",
  "summary": "…",              // the assistant's final text
  "turns": 7,                  // the parent loop's own turns — a delegate's are not counted
  "delegations": 1,            // `delegate` calls issued (0 when none)
  "model_used": "claude-opus-5",
  "receipts": { … },
  "ungrounded_claims": [ … ],
  "sandbox": { … },
  "elapsed_seconds": 94.2,
  "goal": { … }                // only for --until / --infer-until runs
}
```

```jsonc
// status: "error"
{
  "schema": "car.do/1",
  "status": "error",
  "error": "AssistantLoopFailed",
  "message": "…",              // NOT `summary`
  "turns": 9,
  "model_used": "…",
  "receipts": { … },           // work done before the failure is still reported
  "sandbox": { … },
  "elapsed_seconds": 12.4,
  "suggestions": ["…"]
}
```

A flag error before the run starts (`--json` with `--serve`, `--json` with no
goal, `--until` and `--infer-until` together, a `--json-schema` file that is
unreadable, not JSON, or not a valid JSON Schema) produces the error shape with
`error: "InvalidArguments"` and no run fields. `--strict-model` with a model
that would have been substituted produces the same shape with
`error: "StrictModelUnavailable"` and `suggestions` naming the two ways out
(drop the flag, or name a model that is available here); `--strict-model` with
a format the model's protocol rejects produces `error:
"ResponseFormatUnsupported"`. The stdout invariant
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
  "root": "/work",
  "fallback_notice": null      // non-null ⇒ sandbox was requested and unavailable
}
```

`fallback_notice` is the field to check. A run that *silently fell back* to the
local host is materially different from one that chose it, and a caller
reporting on an autonomous run should say which happened.

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
| `started` | Run began. `data` carries the goal, model, and sandbox posture. |
| `text` | The model's prose for a turn — plus the loop's own bracketed notices (below). |
| `tool_called` | A tool is about to run. `data.tool`, `data.brief` (the goal, for `delegate`). |
| `tool_result` | A tool succeeded. |
| `tool_failed` | A tool failed or was denied. |
| `goal_evaluated` | One goal-loop verdict. `data.iteration`, `data.met`, `data.grounded`. |
| `completed` | Run finished. |
| `failed` | Run failed. `data.error`. |

**Exactly one of `completed` / `failed` terminates every run.** A stream that
carries `started` and neither terminator means the process was killed — say
that, rather than guessing at a result from the partial stream.

`Done` and `Error` from the internal loop are deliberately not emitted as
events: the terminal event is written alongside the stdout document, so the two
can never disagree about how the run ended.

Three loop notices arrive as `text` events whose message starts with `[`, so a
consumer can tell them from the model's prose:

| message starts with | Meaning |
|---|---|
| `[delegate: <goal> — N turns, ok]` / `…, error]` | A `delegate` call returned; `N` is the child's turn count, never added to `turns`. |
| `[format repair: …]` | Under `--response-format` / `--json-schema`, the final answer was not the requested JSON (for a schema: did not conform) and the model was re-asked once with no tools. A second line says if the repaired answer still misses; it is returned as-is. |
| `[format repair failed: …]` | The repair call itself errored (e.g. the model's protocol rejects the format); the DRAFT answer is returned. |
| `[context window: …]` | `--context-window` asked for more than the model's known window and was clamped to it. |

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
