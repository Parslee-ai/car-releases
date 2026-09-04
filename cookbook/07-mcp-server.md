{% raw %}
# MCP server in Claude Desktop / Cursor

`car-mcp-server` exposes CAR's stateless capabilities as MCP (Model Context Protocol) tools. Wire it into any MCP-aware client — Claude Desktop, Cursor, etc. — and the model gets memory queries, skill lookup, and proposal verification as tools.

## What's exposed

Sixteen tools. (Tool names are underscore-separated; an earlier version of this
page listed dot-separated names, and two of them — `memory.build_context` and
`skill.report` — never existed.)

- **Memory** — `memory_add_fact`, `memory_query`, `memory_update_status`,
  `memory_save_knowledge`, `memory_save_procedural`, `memory_delete`,
  `memory_intervene`, `memory_evaluate`
- **Skills** — `skill_find`, `skill_ingest`, `skill_list`
- **Verification** — `verify`, `simulate`, `equivalent`, `optimize`
- **Governance** — `policy_check`

There is also one prompt, `car_context`, which assembles CAR's layered context
for a query.

Both the prompt and the resources autocomplete. `completion/complete` fills the
`car_context` prompt's `mode` argument from `["full","fast"]` (prefix-matched on
what has been typed) and completes resource URIs by prefix against the same
enumeration `resources/list` pages over — so a host's argument picker is
populated rather than blank, and a URI it offers is always one that
`resources/read` will accept. `initialize` advertises `"completions": {}` so
hosts know to ask.

`tools/list` carries MCP tool annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) on every entry, so a host can auto-approve a
read without prompting the way it must for a write. Read-only: `memory_query`,
`memory_evaluate`, `skill_find`, `skill_list`, `verify`, `simulate`,
`equivalent`, `optimize`, and `policy_check`.
Everything else is a write — including `memory_intervene`, which reads like a
query but records the injection it selects, and `skill_ingest`, which is marked
destructive because `supersedes` deprecates the skill it names. Nothing sets
`openWorldHint`. The hints are
host UX, not a security boundary: treat them the way the spec says to treat
annotations from any server, and keep `policy_check` and `.car/policies/` as
the actual gate. The full per-tool table is in
`docs/CAR_AGENT_AUTHORING_GUIDE.md`.

### Three more, on the daemon endpoint only

Point a client at the running daemon (`http://127.0.0.1:9102/mcp`) instead of
launching `car-mcp-server`, and `tools/list` returns **nineteen**: the sixteen
above plus `assistant_start`, `assistant_poll`, and `assistant_cancel` — CAR's
flagship agent, the one behind `car do`.

They are not missing from the stdio binary by oversight. `car-mcp-server` is
`car-mcp` plus telemetry: no `Runtime`, no inference engine, no daemon state.
Serving the assistant there would mean shipping the whole daemon inside the
plugin's MCP binary, so it advertises only what it can actually run and answers
`assistant_start` with "unknown tool". On stdio, delegate with `car do --json`.

A run takes minutes, so `assistant_start` hands back a `run_id` immediately
rather than blocking a `tools/call` your host would time out:

```jsonc
// tools/call assistant_start
{ "task": "make the tests pass", "cwd": "/path/to/repo", "until": "cargo test -q" }
// → { "run_id": "mcp-run-…", "status": "running", "poll_after_ms": 2000, "sandbox": {…} }

// tools/call assistant_poll — repeat, feeding next_seq back in
{ "run_id": "mcp-run-…", "since_seq": 0 }
// → { "status": "running", "events": [ {"seq":0,"type":"started",…} ], "next_seq": 1, "events_skipped": 0 }
// … and once terminal:
// → { "status": "ok", "result": { "schema": "car.do/1", "summary": …, "receipts": …, "goal": … } }
```

The events and the terminal `result` are the **`car.do/1` envelope**, the same
one `car do --json` writes — see [`docs/car-do-json.md`](../car-do-json.md).
There is no second format to learn.

Four things to design around, all of them stated in the responses rather than
left to be discovered:

- **8 runs executing at once, refused not queued.** A 9th `assistant_start`
  comes back with `isError: true` naming the cap. A finished run frees its slot
  right away, so you never have to age one out to start the next.
- **Poll or lose it.** A run nobody has polled for an hour is cancelled and
  dropped — including one still executing, because an abandoned run bills model
  tokens to nobody.
- **`events_skipped`.** The buffer keeps 2000 events and trims the head; a
  non-zero `events_skipped` is how you know a gap happened, instead of a stream
  that silently looks complete.
- **A handle is not a record.** The registry is in memory. After a daemon
  restart every `run_id` is unknown, and the poll says so.

`assistant_cancel` lands at the next **turn boundary**, not mid-model-call —
expect one more turn, then poll for the document describing what the run did.
Runs are sandboxed by default (Docker, no network); `local: true` runs on the
host **read-only**, because a tool call has no way to ask a human to approve a
write. If your host is itself an agent CLI, send
`invoked_by: "claude-code" | "codex" | "gemini"` so CAR's recursion guard can
see the call — the daemon is not launched by you, so it cannot infer it.

### `policy_check` — governing the agent that calls you

`policy_check` evaluates a tool call *before* it runs: pass a tool name and its
parameters, get back allow/deny with the rule that decided it. It exists for a
host's `PreToolUse` hook, which is where CAR's "models propose, the runtime
validates" thesis stops being about CAR's own loop and starts governing the
agent in your editor.

It merges the operator's declarative rules from `<CAR_HOME>/policies/` and
`.car/policies/` (under the server's working directory) with CAR's stateless
egress guardrail.

```json
{
  "decision": "deny",
  "basis": "denied_by_rule",
  "tool": "WebFetch",
  "findings": [
    {
      "source": "policy_rules",
      "rule": "deny_tool:WebFetch",
      "severity": "deny",
      "reason": "tool 'WebFetch' is denied by project policy"
    }
  ],
  "rules_loaded": 2,
  "policy_sources": [
    { "path": "~/.car/policies", "exists": false, "rules": 0 },
    { "path": "/project/.car/policies", "exists": true, "rules": 2 }
  ]
}
```

**Read `basis`, not just `decision`.** `no_rules_configured` means nothing was
loaded, so the allow reviewed nothing — treating that as a pass turns an
unconfigured system into a rubber stamp. `passed_rules` means real rules ran and
the call cleared them. An unparseable policy file returns
`basis: "policy_load_failed"` with `decision: "deny"`: failing open on a typo
would enforce nothing while reporting a clean result.

`findings[].source` separates an operator-authored rule (`policy_rules`) from a
built-in guardrail (`inspector:*`), and `severity` separates a warn from a deny.

Two limits worth knowing. Neither policy directory is walked upward — same as
`car do` — which is why the response names every directory it consulted and how
many rules each contributed. And the stateful repetition inspector is
deliberately excluded: a gate whose answer depends on hidden history is not one
an operator can reason about, and this server sees only the calls a host happens
to route through it.

### The four verification tools — what each one is worth

All four read an `ActionProposal` and run nothing. What separates them is the
kind of answer they return, and each answer has a limit worth stating.

- **`verify`** — the findings. Each issue comes back as
  `{action_id, severity, message, tier}`. The `tier` —
  `decision_procedure` | `heuristic` | `sampled` — names which *kind* of check
  produced the finding, so a client can tell an exact check (this tool is not
  registered) from a rule of thumb (three identical calls look like a loop)
  without pattern-matching the message. It is not a strength score and not a
  proof: `decision_procedure` means the check decides its own question over the
  inputs it was handed, nothing about what the tools will do at runtime.
- **`simulate`** — the state an executor would be left holding, from the
  proposal's *declared* `expected_effects`. An action whose preconditions or
  state dependencies are unsatisfied contributes nothing and its dependents
  drop out with it, so the cascade follows the data dependencies. What it does
  not establish: a declared effect is assumed to land, and `failure_behavior`
  is not modelled — read `final_state` as the state assuming execution gets as
  far as the dependency graph allows, never as a claim that a blocked action
  ran.
- **`equivalent`** — do two proposals leave the same state behind? This
  **samples**: it probes the states in `test_states` and nothing else (two
  trivial defaults if you pass none). A `false` is a witness — some sampled
  state separated them. A `true` establishes only that none of the sampled
  states did. The result carries `tier: "sampled"`, `states_tested`, and
  `used_default_states` so that distinction survives the wire. Passing `[]`
  gets you the defaults, not a zero-probe `true`; more than 256 states is a
  `-32602`.
- **`optimize`** — a rewrite, not a check. It drops every `state_dependency`
  naming a key no action in the proposal writes, so the DAG builder can widen
  an execution level; `pruned` lists exactly what went, per action. A pruned
  dependency is one `verify` would have flagged as unavailable, so re-run
  `verify` on the returned proposal rather than reading the rewrite as a
  repair.

See `car-rs/crates/car-verify/README.md`.

Stateful capabilities — proposal execution, multi-agent — are intentionally **not** exposed over MCP. Those need bidirectional tool callbacks, which MCP doesn't support cleanly. Use `car-server`'s WebSocket transport for execution.

## Install

> **The stdio binary is not currently distributed.** CI builds
> `car-server`, `car`, `car-host`, and `car-memgine-eval`; the `car-mcp-server`
> package is not in that list, so it is in no release archive, no `.pkg`, and
> no `.exe` installer. This page previously said it shipped with every release.
> It does not, and never has. Tracked in car#972.

Until it ships, build it from a checkout:

```bash
cd car-rs && cargo build --release -p car-mcp-server
# the binary is named `car-mcp` (the package is car-mcp-server)
ls target/release/car-mcp
```

## Wire into Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "car": {
      "command": "/absolute/path/to/car-rs/target/release/car-mcp"
    }
  }
}
```

If `car-mcp` is on your `$PATH`, you can pass the bare name instead:

Restart Claude Desktop. The CAR tools appear in the model's tool list automatically.

## Wire into Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "car": {
      "command": "car-mcp"
    }
  }
}
```

## Memory persistence across sessions

Memory is durable by default, and it is the **same** memory the assistant
behind `car do` uses — a fact remembered in your editor is recalled by
`car do`, and vice versa. No configuration required.

The store is `<CAR_HOME>/memory/assistant.json` (`~/.car/memory/assistant.json`
unless `CAR_HOME` is set). The server loads it at startup, so `memory_query`
sees everything already remembered, and appends on each `memory_add_fact`.

To give a client its own isolated memory, move the whole CAR state root:

```json
{
  "mcpServers": {
    "car": {
      "command": "car-mcp",
      "env": {
        "CAR_HOME": "/path/to/an/isolated/state/root"
      }
    }
  }
}
```

That one variable relocates every CAR state path together, which is what makes
an isolated instance coherent rather than half-moved.

Two caveats worth knowing:

- **Only `memory_add_fact` is durable.** The lower-level `memory_save_knowledge`
  / `memory_save_procedural` / `memory_delete` / `memory_intervene` tools and
  `skill_ingest` operate on the in-process graph and are lost when the client
  closes the server. The on-disk format has no schema for them yet.
- **There is no lock on the store.** The server re-reads immediately before it
  appends, which narrows but does not close the window where two processes
  writing at the same instant lose one side's note.

> Before v0.48 this section described a `CAR_MEMORY_PATH` variable. That
> variable was never implemented — the stdio server ran on a throwaway graph, so
> every fact written through MCP was discarded when the client disconnected and
> `memory_query` never saw the user's real memory (car#972 §1).

## Sanity-check it works

After wiring, the model should be able to call the new tools. Ask it: "What CAR tools do you have?" — it should list the namespaces above.

## Logs

`car-mcp-server` logs to stderr, not stdout (stdout is the MCP protocol stream). To see what's happening:

```bash
tail -f ~/Library/Logs/Claude/mcp-server-car.log
```

(Path differs by client; Cursor uses `~/Library/Logs/Cursor/`.)

## When to reach for the WebSocket server instead

- you need to **execute** proposals (tool callbacks) — note that running the
  *assistant* no longer needs WS: point at the daemon's MCP endpoint and use
  `assistant_start`
- you need **multi-agent** patterns (swarm, pipeline, supervisor)
- you need **streaming** inference, voice, browser, or meeting capture

For those, run `car-server` and connect via WebSocket. See [`docs/websocket-protocol.md`](../websocket-protocol.md) and [recipe 06](./06-websocket-client.md).

{% endraw %}
