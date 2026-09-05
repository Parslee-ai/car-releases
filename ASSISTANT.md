{% raw %}
# Parslee Core — the `car do` assistant

> Describes CAR **0.52.1**. Check yours with `car --version`; if it
> differs, prefer `car help <command>` on your own binary over this page.

CAR ships with a general-purpose agent that works out of the box: no tools to
register, no proposal schema to write. Point it at a task and it uses files, a
real shell, the web, image/speech/music/video generation, browser control,
Microsoft 365, and a durable memory graph to get it done.

```
car do "generate a 20-second commercial for a cold-brew coffee brand called Wanderlust Roasters, with a voiceover and music"
```

This is a different thing from the `CarRuntime` / `register_tool` / proposal
pattern in [SPEC.md](./SPEC.md) and [GUIDE.md](./GUIDE.md). Those docs are for
*building an agent on CAR* — you supply the tools, CAR supplies the DAG
executor, validator, and policy engine. `car do` is a finished agent CAR
already built that way: its tools are `car-server-core`'s own
`GeneralExecutor` plus a set of host-side delegates, driven through the same
`Runtime` (validator → policy → permission tiers → event log) any embedder
gets. If you want to write your own tools, read SPEC/GUIDE. If you want an
agent that already has real ones, this is it.

## Three ways to run it

```
car do "<goal>"     # one-shot: run to a terminal outcome, print it, exit
car do              # interactive REPL — multi-turn, in one process
car do --serve      # supervised, conversational agent for CarHost / agents.chat
```

`car do --serve` is what CarHost auto-starts: on daemon boot it registers
itself as agent id `parslee-core` (`car-assistant` is kept as a compatibility
alias for older clients) with `auto_start: true`, so a fresh CAR install has a
working conversational agent with no separate install step. Nothing else in
this document changes between the three modes — they share one system prompt,
one tool set, and one loop; they differ only in how a turn starts and how
output is delivered.

Full flag reference (`--local`, `--full-access`, `--until`, `--json`, …) is in
[CLI.md](./CLI.md#car-do).

## Execution posture: sandboxed by default

Unless you pass `--local`, `car do` binds a hardened Docker sandbox before
running anything:

- Container image `python:3.11` by default (override with `--image`) — the
  full (non-slim) image, so git/gcc/make/curl are present without network
  access to fetch them.
- `--network none`: file writes and shell execute **inside** the container;
  network tools (`http_request`, `web_search`, browser control) run from the
  **host**, because the container can't reach the network at all.
- If Docker isn't available, `car do` does not silently drop the sandbox — it
  falls back to the local host with every write and shell call gated behind
  human approval (see below), and tells the model why in the environment
  description.
- `--local` skips the sandbox and runs directly against your filesystem.
  `-y` / `--full-access` lifts the local-host approval gate.

Either way, execution goes through the runtime's admission gates before
anything runs: a **static verification gate** (tool exists, parameters are
well-formed) and, by default, an **information-flow gate** that blocks
confidential local data (files, recalled memories) from reaching an outbound
tool like `web_search` in the same proposal — CAR calls this out explicitly
because assistants that let persistent, high-privilege context flow straight
into outbound tools are a known failure class.

## What it can actually do

Every capability below is a real tool the model can call — read the parameter
names straight out of the source, not paraphrased. Several groups are
**conditionally advertised**: a tool never appears in the model's tool list
(and so never appears in the system prompt, since the prompt doesn't
re-enumerate tools — it points the model at the defs) on a host that can't run
it. That's deliberate: a tool that would only ever return an error is worse
than no tool.

### Files, shell, and planning — always available

| Tool | Parameters |
|---|---|
| `read_file` | `path`, `offset?`, `limit?` |
| `list_dir` | `path` |
| `find_files` | `pattern` (glob, `**` spans directories), `path?` (default `.`), `max_results?` (default 1000) |
| `grep_files` | `pattern` (regex), `path?` (default `.`), `max_results?` (default 50) |
| `write_file` | `path`, `content`, `append?` — overwriting or appending to an existing file requires you to have read its full current content earlier in the session (read-before-write guard); creating a new file needs no prior read |
| `edit_file` | `path`, `old_text`, `new_text`, `replace_all?` — same read-before-edit guard; `old_text` must match exactly one place unless `replace_all: true` |
| `calculate` | `expression` (`^` for exponentiation, plus `+ - * / %`, parentheses, `sqrt`/`sin`/`ln`/…) — pure, no substrate access |
| `shell` | `command`, `timeout_secs?` (default 120, max 600) |
| `todo_write` | `items: [{text, status?: "open"\|"done"\|"dropped"}]` — replaces the whole checklist each call; it's live state that survives history compaction, not a transcript entry |
| `events_query` | `kinds?`, `action_id?`, `limit?` — queries this run's own append-only event log: what you already tried, what failed. Advertised whenever a run has a bound event log (every `car do` invocation) |

`write_file`, `edit_file`, and `shell` auto-run inside the sandbox or under
`--full-access`; on the local host without `--full-access` they need approval
(see [Approvals](#approvals-what-it-may-do-without-asking)).

### Web and delegated work — approval-gated by default

| Tool | Parameters |
|---|---|
| `http_request` | `url`, `method?`, `headers?`, `body?`, `timeout_secs?` (default 30, max 120) |
| `web_search` | `query`, `max_results?` |
| `m365_task` | `task`, `conversation_id?` — delegates to the user's Microsoft 365 Parslee AI Employee (email, calendar, contacts, HubSpot CRM, meetings) over one chat call. Mutating actions (send mail, create an event) come back **drafted for approval**, never executed silently. Advertised only with a Parslee session (`car auth login`) |

These self-declare `"tier": "full_access"`, so — unlike file/shell — they need
approval even *inside* the sandbox unless the session was started with
`--full-access`. Network egress crosses the sandbox boundary; the container
walls it off from the filesystem, but not from the approval gate.

### Memory

| Tool | Parameters |
|---|---|
| `remember` | `subject`, `body`, `kind?: "fact"\|"preference"\|"procedure"` (full_access, gated) |
| `recall` | `query` (no declared tier — never gated) |

See [Memory](#memory-what-actually-persists) below for what this backs and
what it explicitly does not.

### Creative and media generation

The capability a text-only coding agent structurally does not have. Two tiers:
local models (fast, always-available-if-installed) and Parslee Studio
(slower, needs `car auth login`, materially higher quality on some axes).

**Local (`sandbox_edit` tier — no approval needed once the run has edit
permission), advertised only when the matching local model is installed:**

| Tool | Parameters |
|---|---|
| `generate_image` | `prompt`, `output_path?`, `width?` (≤1024, default 768), `height?` (≤1024, default 512), `seed?` |
| `generate_speech` | `text`, `output_path?`, `voice?` |

**Parslee Studio (`full_access` tier), advertised only with a Parslee
session:**

| Tool | Parameters |
|---|---|
| `generate_music` | `prompt`, `duration_seconds?` (5–300, default 30), `output_path?` — ElevenLabs Music, instrumental/ambience |
| `generate_jingle` | `brand_name`, `style?`, `tagline?`, `output_path?` — short sonic branding |
| `generate_studio_image` | `prompt`, `aspect_ratio?` (default "16:9"), `quality?: "low"\|"medium"\|"high"`, `output_path?` — gpt-image-2; reliably renders legible in-image text where the local generator doesn't |
| `generate_song` | `prompt`, `duration_seconds?` (30–480, default 60), `style?`, `lyrics?`, `instrumental?`, `title?`, `output_path?` — Suno, full song with vocals, up to 8 minutes |
| `list_voices` | — lists Studio's stock voices plus any this org has cloned from real people; call before `generate_voiceover` when a specific voice matters |
| `generate_voiceover` | `text`, `voice?` (name or id — matched against `list_voices`), `rate?` (e.g. `"-10%"`; **omitting it is not neutral** — the tool description documents measured wpm at each setting and recommends `"-10%"` for narration), `output_path?` |
| `generate_video` | `prompt`, `image_path?` (omit for text-to-video, supply to animate a still), `duration_seconds?` (default 5), `provider?: "veo"\|"kling"\|"ltx"`, `output_path?` — image-to-video is a diffusion repaint of every frame, so it warps fine text/UI in the source image; the tool description warns against animating text-heavy slides with it |
| `produce_commercial` | `brief`, `duration_seconds?` (8–60, default 20), `voiceover_script?`, `voiceover_voice?` (default `"brian"`), `music?` (default true), `output_path?` — plans shots, generates keyframes/video, adds voiceover and a music bed, and assembles a finished MP4. Slow (real productions run up to ~25 minutes) |

Every generator returns a **file path under the working directory**, never
inline bytes — the artifact contract exists so a producer's output survives
the loop's observation-size cap; embed or read the path like any other file.

### Vision — reading images back

The consumer counterpart to the generators. `read_image_text` (OCR) runs via
the Apple Vision shim on macOS with a Tesseract fallback elsewhere;
`classify_image` runs via Apple Vision on macOS and a bundled MobileNetV2
model elsewhere (auto-downloaded and cached on first use off-macOS). Both are
read-only; each is advertised whenever its own backend is present.

| Tool | Parameters |
|---|---|
| `read_image_text` | `image_path` — OCR: screenshots, scans, photographed documents, or a generated image containing words |
| `classify_image` | `image_path`, `top_k?` (default 5, max 20) — ranked content labels with confidence |

### Browser control and recording — `full_access` tier

Chromium launches lazily on first use, so a session that never browses pays
nothing for it.

| Tool | Parameters |
|---|---|
| `browse_navigate` | `url` |
| `browse_click` | `element_id` (accessibility node id, e.g. `"el_5"`) |
| `browse_type` | `element_id`, `text` |
| `browse_scroll` | `delta_y` |
| `browse_keypress` | `key`, `modifiers?: ["shift"\|"control"\|"alt"\|"meta"]` |
| `browse_wait` | `condition` (`"page_loaded"` or `"url_changed"`), `timeout_ms?` (default 5000) |
| `browse_observe` | `include_screenshot?`, `ocr?` — screenshot + accessibility tree + a fused `ui_map`; OCR recovers labels a polished SPA's accessibility tree misses |
| `browser_await_answer` | `timeout_seconds?` (default 45) — blocks until a page stops changing after you submit something, so you don't screenshot mid-load |
| `browser_await_signin` | `url?`, `success_url_contains?`, `timeout_seconds?` (default 300, max 1800) — asks the human to complete a sign-in the agent can't (SSO, MFA); the session persists afterward |
| `browser_record_start` | `quality?` (JPEG 1–100, default 80) |
| `browser_record_stop` | `output_path?` — writes an MP4 (requires ffmpeg), captures only frames where the page actually changed |

### Desktop automation — `full_access` tier, one platform-native tool

Cannot be sandboxed by construction — it drives the real host GUI — so it
self-declares `full_access` and is approval-gated by the same tier rule as
`web_search`/browser control/`m365_task` (see
[Approvals](#approvals-what-it-may-do-without-asking)): gated unless the
session was started with `--full-access`.

| Platform | Tool | Parameters |
|---|---|---|
| macOS | `run_applescript` | `script`, `language?: "applescript"\|"javascript"` (JXA preferred — models generate it more cleanly) |
| Windows | `run_powershell` | `script` |

### Linked devices

| Tool | Parameters |
|---|---|
| `linked_devices` | — (read-only, never gated) lists the user's linked CAR host devices and what they advertise (chat, approvals, notifications) |
| `notify_linked_device` | `device_id?`, `title`, `body` (full_access, gated) — a title/body push, nothing more; no contacts/location/photos/microphone access |

### Identity

| Tool | Parameters |
|---|---|
| `set_assistant_name` | `name`, `spellings?` (alternate speech-to-text spellings), `user_name?` |

`set_assistant_name` is gated on **every** session regardless of tier —
`--full-access` does not exempt it. Every other gate in this document is about
what the *session* is allowed to do; this one is about where the instruction
could have come from. A rename request can arrive inside a fetched web page,
a file, or a recalled memory, and an assistant that silently starts answering
to a name it read somewhere is an identity-spoof surface — one approval tap is
the cheaper mistake. See [Identity](#identity-1) below.

## Approvals: what it may do without asking

Two independent axes decide whether a tool call runs immediately or stops for
a human:

**1. The environment tier**, set once per run:

| Environment | Standing tier | Meaning |
|---|---|---|
| Sandbox (default) | `SandboxEdit` | Writes/shell inside the container auto-run; nothing crosses the container boundary without approval |
| Sandbox, `--full-access` | `FullAccess` | Everything auto-runs, including network/browser/automation |
| Local host (`--local`) | `ReadOnly` | Even `write_file`/`edit_file`/`shell` need approval |
| Local host, `--full-access` | `FullAccess` | Everything auto-runs |
| Docker unavailable (auto fallback) | `ReadOnly` | Same as `--local` without it — never a silent unsandboxed run |

**2. Each tool's self-declared `tier`** in its schema (`sandbox_edit` or
`full_access`; a tool with no `tier` field is never gated by this rule). A
tool is routed to approval whenever its declared tier **exceeds** the run's
standing tier. This is why `web_search`, the browser tools, `run_applescript`
/ `run_powershell`, `m365_task`, the Studio media tools, `remember`, and
`notify_linked_device` all stop for approval inside the *default sandboxed
run* — they declare `full_access`, and the sandbox's standing tier is only
`SandboxEdit`. The local generators (`generate_image`, `generate_speech`)
declare `sandbox_edit`, so they run without asking inside the sandbox but are
gated on an unelevated local run.

**How the human is asked** depends on the surface:

- One-shot / REPL (`car do "<goal>"` or `car do`): a terminal prompt —
  `⚠  Approve <tool>(<brief>)? [y/N]` — reading a single line from stdin.
  Anything but `y` is a denial with reason `"declined by user"`.
- `car do --serve` / `agents.chat`: routed through the chat surface's
  `approval_pending` → park → resolve flow. A connected host can present that
  same pending approval as a reviewable control rather than a plain
  yes/no modal — CarHost and the mobile apps do this — but the wire contract
  `car do` itself guarantees is the `approval_pending` event; how a given host
  renders it is that host's decision, not the assistant's.

**Changing the default posture** — the CLI counterpart to CarHost's
**Approvals** settings screen:

```
car approvals get                    # show the current default posture
car approvals default cautious       # ask before any edit or full-access action
car approvals default balanced       # allow sandboxed edits without asking
car approvals default trusting       # allow everything without asking
```

This proxies the daemon's `agent_permissions.*` JSON-RPC surface: it moves the
**default** posture applied to every agent that has no explicit per-agent
override, so setting it once changes the fallback for every agent the daemon
supervises, not just one `car do` invocation. The three presets are the only
accepted values; anything else is rejected before it reaches the daemon.

## Memory: what actually persists

`recall` and `remember` are backed by CAR's graph memory engine
(`car-memgine`) — not a bespoke store built for the assistant. It's the same
durable note store `car-mcp` reads and writes (with a two-writer caveat if you
run both at once — see [MCP.md's memory-durability
section](./MCP.md#memory-durability--read-this-before-relying-on-it)).

- **What persists**: durable *facts*, written one at a time by `remember`
  (`subject`, `body`, `kind`), stored as flat JSON notes at
  `<CAR_HOME>/memory/assistant.json` (`~/.car/memory/assistant.json` by
  default) and re-ingested into a fresh in-memory graph every time the
  assistant opens. A `remember` call with a subject that already exists
  **replaces** that note (case-insensitive match) rather than accumulating
  duplicates. `recall` queries that graph and returns a relevance-scored
  context string, not a raw list.
- **What does not persist**: the *conversation itself*. There is no
  disk-backed transcript store behind `car do` — a prior, unrelated
  `ConversationStore` mechanism was removed from CAR entirely, and nothing
  replaced it as a session-replay feature. What "the assistant remembers the
  conversation" cashes out to in practice is: whatever the model chose to
  write with `remember` during that conversation, as a fact — not a replay of
  what was said. Don't tell a user their chat history itself survives a
  restart; only the facts it explicitly saved do.
- **Cross-device**: only on `car do --serve` (the daemon-attached path). There,
  every `remember` is additionally mirrored into the daemon's synced knowledge
  oplog, and `recall` pulls in facts a *different* device wrote for subjects
  the local store doesn't already hold (local notes win on a subject both
  devices have — this is deliberately conservative, not last-write-wins). A
  one-shot `car do "<goal>"` run has no sync sink attached, so its `remember`
  calls stay local to that machine.
- **`kind` changes retrieval behavior, not just categorization**: a `"fact"`
  is retrieved when relevant to a query; a `"preference"` is surfaced in
  *every* future session (a standing instruction, not a recall hit) — reserve
  it for rules that should never be violated; a `"procedure"` records how a
  task was done and whether it worked, for reuse.

## Identity

The product is **Parslee Core** — that name is fixed (it's what the product
is called in store copy) and never changes. What the user calls the agent day
to day is a nickname layered on top, defaulting to **Parslee** (so an install
that never sets a name still answers to something short and won't confuse
itself with the brand string in casual conversation). The agent is told in
its system prompt to answer to either without correcting the user.

```
car identity show                                # current name, spoken forms, where the record lives
car identity set Jarvis --also-hear jervis        # rename it; --also-hear registers STT mis-hearings
car identity set-user Dana                        # tell it what to call YOU
```

The record lives at `<CAR_HOME>/identity.json` — one file feeding the system
prompt, the voice wake-word matcher, and every host's addressing copy, so
`car identity show` reports the same name CarHost displays and the voice
pipeline wakes on. Saying "sure, I'll go by Friday" in conversation changes
nothing by itself: the model is instructed to call the gated
`set_assistant_name` tool (approval required — see above) to make a rename
actually take effect for the next session and the wake word; agreeing in
prose alone is explicitly called out in the prompt as *not* persisting
anything.

## Worked examples

These are **illustrative** — derived directly from the tool schemas and loop
behavior above, not captured output from an actual run.

### 1. A capability a text-only coding agent doesn't have

```
car do "Make a 20-second commercial for a cold-brew coffee brand called \
  Wanderlust Roasters — warm, adventurous tone, with a voiceover and \
  background music."
```

Given a Parslee session, the model has `produce_commercial` in its tool list
and (per its schema) would call something like:

```json
{"tool": "produce_commercial", "parameters": {
  "brief": "Wanderlust Roasters cold brew — warm, adventurous, morning-ritual tone",
  "duration_seconds": 20,
  "music": true
}}
```

`produce_commercial` self-declares `full_access`, so on a sandboxed run
without `--full-access` this call pauses for approval first. Once approved,
Studio plans shots, generates keyframes and video, adds a voiceover and a
music bed, and the tool result is an MP4 path under the working directory —
which the agent then references in its final summary rather than describing
in prose.

### 2. Approval prompt on the local host

```
car do --local "delete every file in this directory older than 30 days"
```

`shell` (or `write_file`) is not `--full-access`, so before running the
deleting command the terminal shows:

```
⚠  Approve shell(find . -mtime +30 -delete)? [y/N]
```

Typing anything but `y` denies the call with `"declined by user"`, and the
model is told the boundary — the prompt instructs it not to retry the exact
same call, but to explain the limit and offer an alternative.

### 3. Machine-readable output (`--json`)

```
car do --json "summarize the CSV files in this directory"
```

emits exactly one JSON document on stdout (`schema: "car.do/1"`) — progress
goes to stderr as JSONL instead of human-readable text. The shape, per the
emitter that builds it:

```json
{
  "schema": "car.do/1",
  "status": "success",
  "summary": "…",
  "turns": 5,
  "delegations": 0,
  "model_used": "anthropic/claude-haiku-4-5:latest",
  "receipts": {
    "total": 11,
    "failed": 0,
    "by_tool": {"list_dir": 1, "read_file": 6, "grep_files": 4},
    "sample": [
      {"tool": "list_dir", "ok": true, "brief": "."},
      {"tool": "read_file", "ok": true, "brief": "prices.csv"},
      {"tool": "read_file", "ok": true, "brief": "orders.csv"},
      {"tool": "read_file", "ok": true, "brief": "notes.csv"},
      {"tool": "read_file", "ok": true, "brief": "invoices.csv"},
      {"tool": "read_file", "ok": true, "brief": "returns.csv"},
      {"tool": "read_file", "ok": true, "brief": "summary.csv"},
      {"tool": "grep_files", "ok": true, "brief": "prices.csv"}
    ],
    "sample_omitted": 3
  },
  "ungrounded_claims": [],
  "sandbox": {
    "mode": "docker",
    "image": "python:3.11",
    "network": "none",
    "tier": "sandbox_edit",
    "root": "/work",
    "fallback_notice": null
  },
  "elapsed_seconds": 12.4
}
```

`sample` is capped at 8 receipts (failures first, then successes) regardless of
how many tool calls the run actually made; `sample_omitted` says how many were
left out of that cap so the array never silently reads as the complete list.

`ungrounded_claims` is the mechanism behind "receipts decide completion, not
the prose": before the run is reported as finished, operational claims in the
model's own summary ("I ran the tests", "the file is updated") are
cross-checked against the actual tool receipts from *this* run. An unmatched
claim is not silently trusted — a deterministic pass (e.g. `--until` goal
mode) only annotates the reply with a `[claim check]` note, while a
model-judged completion is failed closed on an unmatched claim. This array is
empty here because nothing in the summary asserted anything the receipts
didn't back up.

### The failure shape

The block above is a **successful** run. A failed one keeps the same
`schema` and swaps in an error triple — parse `status` first, not the presence
of `summary`, which a failed run does not carry:

```json
{
  "schema": "car.do/1",
  "status": "error",
  "error": "AssistantLoopFailed",
  "message": "inference failed: Not enough memory is free to start this model while preserving CAR's 6553 MB emergency reserve. Close memory-heavy apps or choose a smaller model.",
  "turns": 1,
  "model_used": "",
  "elapsed_seconds": 0.007832208,
  "suggestions": [
    "Re-run the goal; the run failed mid-loop rather than completing with an answer.",
    "Check `receipts` for what had already executed before the failure."
  ],
  "receipts": {"total": 0, "failed": 0, "by_tool": {}, "sample": [], "sample_omitted": 0}
}
```

- `status` is `"success"` or `"error"`. Branch on it.
- `error` is a stable machine-readable kind (e.g. `AssistantLoopFailed`);
  `message` is the human-readable detail and is NOT stable enough to match on.
- `receipts` is always present, including on failure, and is how you see what
  had already run before the failure — a partially-completed run reports the
  tools it did execute.
- `model_used` is empty when the run failed before a model was selected.
- The process exits non-zero on `"error"`, so an exit-code check and a
  `status` check agree; the JSON is still emitted.

The exit status and the JSON both being authoritative matters for scripting:
`car do --json` writes exactly one document to stdout either way, with progress
as JSONL on stderr, so redirecting stdout to a file gives a parseable result
even on failure.

## Where this fits with the rest of CAR

- Building your *own* agent with your *own* tools — [SPEC.md](./SPEC.md) /
  [GUIDE.md](./GUIDE.md).
- Every CLI subcommand, including the rest of `car do`'s flags and every other
  top-level command — [CLI.md](./CLI.md).
- Wiring CAR (including a poll-based handle onto this same assistant,
  `assistant_start`/`assistant_poll`) into Claude Code, Cursor, or another
  MCP host — [MCP.md](./MCP.md).

{% endraw %}
