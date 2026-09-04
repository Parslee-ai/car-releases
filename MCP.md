{% raw %}
# CAR as an MCP server

> Describes CAR **0.52.0**. Check yours with `car --version`; if it
> differs, prefer `car help <command>` on your own binary over this page.

Wire CAR's graph memory, skill storage, static plan verification, and policy
enforcement into Claude Code, Cursor, Claude Desktop, or any other
[MCP](https://modelcontextprotocol.io)-aware host as native tools. This is the
most direct way for an external coding agent to use CAR — no SDK, no runtime
embedding, just a binary on `PATH` and a few lines of client config.

Everything below is read from `car-rs/crates/car-mcp/src/schemas.rs` and
`server.rs`, and from `plugins/car/` — the actual source, not the protocol
aspiration. Where the two transports differ, or where a tool is weaker than
its name suggests, that's called out rather than smoothed over.

## Two transports, two capability sets

CAR speaks MCP over **stdio** (`car-mcp` binary — one client per process) and
over **HTTP-streamable** (the `car-server` daemon's `/mcp` endpoint, default
`http://127.0.0.1:9102/mcp`). Same dispatch logic, same tool schemas — but they
are not equivalent, and the difference matters more than the transport choice:

| | stdio (`car-mcp`) | daemon (`/mcp`) |
|---|---|---|
| Tools advertised | 16 built-ins | 16 built-ins **+ 3** (`assistant_start`, `assistant_poll`, `assistant_cancel`) |
| Memory backing | Its own process, opens `<CAR_HOME>/memory/assistant.json` at startup | The daemon's live, already-running memgine — shared with everything else the daemon does (WS clients, `car do`) |
| Requires the daemon running? | No | Yes |
| Concurrent clients sharing state | No — one process per client | Yes |

Point a client at the running daemon instead of launching `car-mcp` and you
also get `assistant_start` / `assistant_poll` / `assistant_cancel` — a
poll-based handle onto CAR's flagship agent (the one behind `car do`), because
the daemon has the `Runtime` and inference engine to run it and the stdio
binary does not. `car-mcp-server` is `car-mcp` plus telemetry, nothing more;
it answers those three tool names with "unknown tool" rather than pretending
to run them. On stdio, delegate to the agent with `car do --json` directly
instead.

The daemon's `/mcp` endpoint validates the `Origin` header (present +
non-loopback → `403`) as its only access control — no bearer token. It does
not widen for a non-default `--mcp-bind`; front it with a reverse proxy if you
need to expose it beyond loopback.

## What this does NOT give you

- **No proposal execution.** `verify`, `simulate`, `equivalent`, and
  `optimize` all read an `ActionProposal` and run nothing — they check or
  predict, they never execute a tool. Actually running a proposal needs
  bidirectional tool callbacks, which MCP doesn't support cleanly; that's the
  WebSocket protocol's job (`docs/websocket-protocol.md`).
- **No multi-agent patterns** (swarm, pipeline, supervisor) over MCP.
- **Most memory writes over stdio don't survive the process exiting.** See
  below — only `memory_add_fact` is durable when you're talking to `car-mcp`
  directly rather than the daemon.
- **The four verification tools are checks and predictions, not proofs.**
  `verify`'s findings carry a `tier` (`decision_procedure` | `heuristic` |
  `sampled`) precisely so a caller can tell an exact check from a rule of
  thumb; `equivalent` samples two default states unless you supply your own
  and a `true` only means none of the probed states diverged, not that none
  ever would.

## Memory durability — read this before relying on it

The stdio binary (`car-mcp`) opens `<CAR_HOME>/memory/assistant.json` — the
**same** durable note store `car do` reads and writes — at startup, and
`memory_query` sees whatever is already in it. But only **`memory_add_fact`**
appends back to that file. `memory_save_knowledge`, `memory_save_procedural`,
`memory_delete`, `memory_intervene`, and `skill_ingest` all operate on the
in-process graph only; the on-disk note format has no schema for them yet, so
anything written through those five tools is gone when the client
disconnects. There's also no lock on the store — the server re-reads
immediately before appending, which narrows but doesn't close a two-writer
race window.

The daemon's `/mcp` endpoint doesn't have this asymmetry: it shares the
daemon's one live `MemgineEngine`, and the daemon owns persisting it — a
second writer to the same file would just drop one side's appends, which is
exactly why the stdio binary and the daemon never both hold `store: Some(path)`
at once.

Relocate the store with `CAR_HOME` — every other daemon state path moves with
it, so an editor plugin that wants an isolated memory sets that one variable.

## The tool list — 16 tools, verified against source

`memory_add_fact`, `memory_query`, `memory_update_status`,
`memory_save_knowledge`, `memory_save_procedural`, `memory_delete`,
`memory_intervene`, `memory_evaluate`, `skill_ingest`, `skill_list`,
`skill_find`, `verify`, `simulate`, `equivalent`, `optimize`, `policy_check` —
this is the complete, alphabetically-sorted list the crate's own test suite
asserts against (`server.rs`, `tool_names` test). There is also one MCP
**prompt** (not a tool), `car_context`.

Every entry carries all four MCP tool annotations
(`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`) so a host
can auto-approve a read without prompting for a write — these are host UX
hints per the MCP spec, not a security boundary; CAR's own gate is
`policy_check` plus `.car/policies/`, and nothing in CAR's governance keys off
them.

### Memory (8 tools)

| Tool | Read-only | Required params | Notes |
|---|---|---|---|
| `memory_add_fact` | no | `subject`, `body` | `kind`: `"pattern"` (default) or `"constraint"`. The one memory write durable over stdio. |
| `memory_query` | **yes** | `query` | `k` (1–50) caps results. Spreading-activation retrieval, returns nodes + activation scores. |
| `memory_update_status` | no | `body` | Session-local progress/risk status; a map slot, so a second call overwrites the first. `tenant_id` optional. |
| `memory_save_knowledge` | no | `subject`, `body` | Durable *proactive* knowledge (requirements, policies, verified environment facts). Additive — a repeat `id` mints `<id>-2` rather than overwriting. In-process only over stdio (see durability section). |
| `memory_save_procedural` | no | `subject`, `body` | Same shape as above, for procedural evidence (failed attempts, fixes, gotchas). Same in-process-only caveat. |
| `memory_delete` | no | `id` | Deletes a fact by id, or clears a status id like `proactive-status:global`. In-process only over stdio. |
| `memory_intervene` | no | *(none required)* | Selects at most one proactive reminder for the next action, or an explicit silent decision. Reads like a query but bumps the chosen fact's injection counter — not idempotent. |
| `memory_evaluate` | **yes** | `cases` (array of `{id, request, relevant_fact_ids?}`) | Evaluates proactive memory against selective / always-inject / passive-retrieval / no-memory baselines on labeled cases. |

`memory_save_knowledge` / `memory_save_procedural` share this input shape:

```jsonc
{
  "id": "string",            // optional
  "subject": "string",       // required
  "body": "string",          // required
  "tags": ["string"],
  "confidence": "string",
  "tenant_id": "string",
  "is_constraint": false
}
```

`memory_intervene` / `memory_evaluate`'s `request` shape:

```jsonc
{
  "query": "string",
  "recent": ["string"],
  "trigger": {
    "repeated_failures": 0,
    "tool_error": false,
    "explicit_uncertainty": false,
    "high_risk_action": false,
    "context_shift": false
  },
  "force": false,
  "max_candidates": 8,       // 1-32
  "tenant_id": "string"
}
```

### Skills (3 tools)

| Tool | Read-only | Required params | Notes |
|---|---|---|---|
| `skill_ingest` | no | `name`, `code` | Also takes `platform`, `persona`, `url_pattern`, `description`, `task_keywords`, `supersedes`. Marked *destructive*: naming an existing skill in `supersedes` flips it to deprecated. In-process only over stdio. |
| `skill_list` | **yes** | *(none)* | Optional `domain` filter — returns skills scoped Global or that Domain. |
| `skill_find` | **yes** | `task` | Optional `persona`, `url`, `k` (1–20). Top-k skills ranked by activation. |

### Static verification (4 tools) — all stateless, no memory, no daemon

Each of these reads a `car_ir::ActionProposal` JSON object and runs nothing.

| Tool | Required params | What it answers |
|---|---|---|
| `verify` | `proposal` (+ optional `max_actions`, 1–1000) | Findings: dependency cycles, missing tools, simulated final state. Each issue has a `tier`. |
| `simulate` | `proposal` (+ optional `initial_state`) | The state an executor would be left holding, from *declared* `expected_effects` only — a declared effect is assumed to land, `failure_behavior` is not modelled. |
| `equivalent` | `proposal_a`, `proposal_b` (+ optional `test_states`, 1–256 items) | Whether two proposals leave the same state behind — **sampled**, not proven. Two trivial default states if you omit `test_states`; passing `[]` is treated as omitted, not a zero-probe `true`. |
| `optimize` | `proposal` | Rewrites the proposal to widen parallelism by dropping `state_dependency` entries naming keys nothing in the proposal writes. Returns `pruned` per action. Re-run `verify` on the result — a pruned dependency is one `verify` would flag as unavailable. |

### Governance (1 tool) — also stateless

| Tool | Required params | What it answers |
|---|---|---|
| `policy_check` | `tool` (+ optional `params`) | Evaluates a proposed tool call against CAR's policy layer *before* it runs: allow/deny plus the rule that decided it. Merges `<CAR_HOME>/policies/` + `.car/policies/` (under the working directory — **neither is walked upward**) with CAR's stateless egress guardrail. |

Read `basis`, not just `decision`: `no_rules_configured` means nothing was
loaded — an allow with nothing behind it — versus `passed_rules`, real rules
that the call cleared. `policy_load_failed` denies rather than failing open on
an unparseable file. This is exactly what backs the Claude Code plugin's
`PreToolUse` hook below.

### The prompt: `car_context`

Not a tool — an MCP *prompt*. Assembles CAR's four-layer context (identity →
constraints → facts → conversation → environment → known-unknowns) for a
query and returns it as one user message a host can prepend to its own
prompt. Arguments: `query` (required), `mode` — `"full"` (default) or
`"fast"` (skips embedding flush, skill lookup, PPR scoring).

## Getting the binary

`car-mcp` (package name `car-mcp-server`) **ships in every release archive
today** — `.github/workflows/build.yml` builds it (`cargo build ... -p
car-mcp-server`) and sweeps the resulting `car-mcp` binary into every
per-platform tarball/zip alongside `car`, `car-server`, and
`car-memgine-eval`. It is not a separate download or a standalone release
asset; it comes from wherever you already get the CAR CLI:

```bash
# install script (macOS + Linux) — the recommended CLI install today
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh

# There is no Homebrew path — it was removed in May 2026 when the signed
# .pkg + Sparkle became the macOS install.

# manual tarball
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
```

Confirm it's on `PATH`:

```bash
which car-mcp
```

`car-mcp` takes no CLI arguments — it starts the stdio JSON-RPC loop
immediately and blocks reading stdin, so don't run it bare to "check" it
(there's no `--help`/`--version` to print; a bare invocation just hangs until
stdin closes). Let your MCP client launch it.

See [DISTRIBUTION.md](./DISTRIBUTION.md) for every platform/package manager.

## Client configuration

### Claude Code — bare `.mcp.json`

Project- or user-scoped MCP config, independent of the plugin below:

```json
{
  "mcpServers": {
    "car": {
      "command": "car-mcp"
    }
  }
}
```

### Cursor

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

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS):

```json
{
  "mcpServers": {
    "car": {
      "command": "car-mcp"
    }
  }
}
```

If `car-mcp` isn't on the config-file reader's `PATH` (a common GUI-app
gotcha), use the absolute path from `which car-mcp` instead of the bare name.
Restart the client after editing — the CAR tools then appear in the tool list
automatically.

### Pointing any of the above at the daemon instead

To get the 3 extra assistant tools, point the client at the running daemon's
HTTP endpoint (`http://127.0.0.1:9102/mcp` by default, `--mcp-bind` /
`CAR_MCP_BIND` to change it, `disabled` to turn it off) rather than launching
`car-mcp` per-client. The exact MCP-over-HTTP config stanza is client-specific
— consult that client's docs for "remote"/"HTTP" MCP servers.

### Isolating memory per client

```json
{
  "mcpServers": {
    "car": {
      "command": "car-mcp",
      "env": { "CAR_HOME": "/path/to/an/isolated/state/root" }
    }
  }
}
```

One variable relocates every CAR state path together — journals,
`agents.json`, the memory store, policies — so the isolated instance is
coherent rather than half-moved.

## The Claude Code plugin (`plugins/car/`)

Beyond raw MCP wiring, `plugins/car/` is a working Claude Code plugin that
bundles the MCP server with two subagents, three slash commands, and a policy
hook — install it and you get the tools plus opinionated glue in one step.

**Not installable from here today.** `plugins/car/` lives only in the CAR
source repository, which is private — nothing in the release pipeline
publishes it, so a `/plugin marketplace add` pointed at that repo 404s for
every reader of this document. What's below documents what the plugin does
and how it's laid out; treat it as a preview of what a future public
marketplace entry would provide, not a command you can run yet. Until then,
get the same tools with the bare `.mcp.json` config further up this page, and
write `.car/policies/rules.toml` — CAR's `car do` reads it directly, so
policy enforcement works without the plugin's hook.

Requires `car` and `car-mcp` on `PATH` from a CAR newer than v0.48.0 (the
first release with `car policy-check-hook`, which the hook below runs).

| Component | What it does |
|---|---|
| `@agent-car:car` | Delegates a task to CAR's autonomous agent (`car do --json` under the hood) — Docker sandbox, no network by default, validator + policy chain, returns tool receipts and a claim check |
| `@agent-car:car-reason` | CAR's code reasoning engine (`car reason`) — adaptive model routing over a graph of the codebase |
| `/car-do` | Shorthand for delegating to the `car` subagent |
| `/car-remember`, `/car-recall` | Write and search CAR's durable memory via the `memory_add_fact` / `memory_query` MCP tools |
| MCP server `car` | The 16 tools above, launched as `car-mcp` with `CAR_INVOKED_BY=claude-code` set (required — it seeds CAR's recursion guard so `car do` doesn't spawn a `claude` subprocess that loads this same plugin and calls back in) |
| `PreToolUse` hook | Runs **your** `.car/policies/*.toml` against Claude Code's own Bash/Write/Edit/WebFetch/NotebookEdit calls, via `car policy-check-hook` |

The hook is declarative — write `.car/policies/rules.toml`:

```toml
deny_tool = ["WebFetch"]
deny_keyword = ["rm -rf /", "DROP TABLE"]
```

Two behaviors worth knowing precisely: **an unparseable policy file blocks the
call** (an operator wrote a rule; silently enforcing nothing is the failure
declarative policy exists to prevent), but **the hook itself fails open** on
anything that isn't a rule decision — an unreadable payload or a missing
`tool_name` lets the call proceed with a note to stderr, because a hook that
fails closed on an install problem would make it look like a policy denial.
The hook command is literally `car policy-check-hook; exit 0`, so any exit
code the subcommand returns is discarded rather than read as a deny — that
guards a stale `car` too: an older binary that doesn't recognize the
subcommand used to exit 2, which Claude Code reads as *deny*, so every
matching call in the session was refused with clap's usage text as the stated
reason (Parslee-ai/car#993). Note this hook is a `car` subcommand
(`car_policy::tool_gate` in-process) — it doesn't shell out to `car-mcp` at
all, despite the MCP server enforcing the same policy engine. `.car/policies/`
is read from the working directory only and is **not walked upward**, matching
`car do`.

### The plugin-authoring gotcha this repo has already hit

Plugin components — agents, commands, hooks, `.mcp.json` — must live at the
plugin **root**, not nested inside `.claude-plugin/`. Anything placed inside
`.claude-plugin/` silently fails to load, and `claude plugin validate` passes
it anyway; the only way to catch the mistake is `claude plugin details`. In
this repo, `.claude-plugin/` correctly holds only `plugin.json` — `.mcp.json`,
`agents/`, `commands/`, and `hooks/` all sit one level up, at
`plugins/car/`. If you're authoring a plugin of your own against this as a
reference, that layout is the one to copy.

## The mirror image: CAR as an MCP client (`car-connectors`)

Everything above is CAR exposing its own tools to an external host. The
reverse also exists: `car-connectors` lets CAR add a **remote** MCP server as
a tool source, the way Claude or ChatGPT add connectors — connect over
HTTP-streamable, discover tools via `tools/list`, translate each tool's JSON
Schema into a `car_ir::ToolSchema`, and register it so it dispatches through
CAR's own validator/policy/eventlog like any other tool.

Worth knowing if you're evaluating this direction:

- A newly discovered connector tool is **disabled by default** and has no
  route in the executor until a user enables it — structural, not a
  permission flag someone could forget to set.
- Connector config (slug, name, URL, enabled tools, auth-header names)
  persists to `~/.car/connectors.json`; secret header *values* go to the OS
  keychain, never the JSON file.
- Phase 1 (unauthenticated / static-header servers) and Phase 2 (OAuth 2.1
  with PKCE + token refresh) are the current scope. Connector management
  itself is GUI-driven through CarHost, not a CLI flag.

This is the mirror of everything documented above, not a replacement for it —
use `car-mcp` / the daemon's `/mcp` endpoint to bring CAR's tools *into* an
external agent, and `car-connectors` to bring an external MCP server's tools
*into* CAR.

{% endraw %}
