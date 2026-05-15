# Common Agent Runtime (CAR)

A deterministic execution layer for AI agents, written in Rust.
**Models propose. The runtime validates, verifies, and executes.**

Agents that pass raw LLM output straight into tool calls fail unpredictably —
unsafe actions, hallucinated tool names, state drift. CAR treats plans as
first-class data: verify before executing, enforce policies in Rust before
any side effect, track memory as a graph, and learn reusable skills from
execution traces.

This repo ships the public binary distribution — install docs, examples,
issue tracker. Source is private.

## What you get

A single binary with:

- **Verification** — prove plan properties (`verify`, `simulate`,
  `equivalent`, `optimize`) before anything side-effecting runs
- **Policies** — Rust-enforced on every action (`deny_tool`,
  `deny_tool_param`, `require_state`)
- **State** — typed key/value store with snapshotting and rollback
- **Graph memory** — spreading activation, 4-layer context assembly for
  grounding LLM calls, persistence
- **Skills** — save learned procedures with triggers, distill from traces,
  evolve when they degrade
- **Tools** — callback-based; the runtime owns the DAG, you own the tool
  implementations
- **Planner** — generate, score, and rank candidate proposals using static
  verification + cost estimation + inference. Pick the best plan before
  executing any of them (`rank_proposals`, `car-active-planner`)
- **Code reasoning** — adaptive, graph-driven reasoning engine (`car-reason`)
  that accumulates structure from a codebase to answer why-questions and
  propose edits
- **Workflows** — declarative multi-stage pipelines with conditional edges
  and saga-style compensation for rollback on failure (`car-workflow`)
- **Conformance tests** — RuntimeBench suite verifies every runtime
  capability against spec, so the execution semantics are portable across
  implementations (`car-conformance`)
- **Unified inference** — local backends (Candle + MLX) for text (Qwen3,
  Gemma 4), vision (Qwen2.5-VL), embeddings + reranking (Qwen3-Embedding,
  Qwen3-Reranker), image (Flux), video (LTX-2.3, Yume), plus remote
  providers (OpenAI, Anthropic, Google) through one provider-agnostic
  protocol
- **Delegated wire formats** — host-registered inference runner. When a
  model schema declares `source: ModelSource::Delegated`, CAR routes
  the request through your host-side runner (Anthropic / OpenAI /
  Vercel AI SDK / GitHub Models) instead of any native backend; CAR
  stays in the policy + eventlog + replay path. "JS owns the wire,
  CAR owns the policy."
- **Adaptive router** — `route_model` picks local vs. remote by task
  complexity, context-window headroom, and per-model latency/cost
  profiles built from real call history. Caller-side `IntentHint`
  (`task`, `prefer_local`, `prefer_fast`, `require: ModelCapability[]`)
  threads through every infer surface so callers express what they
  need without pinning a model id. Semantic conversation compaction
  kicks in automatically when a call would exceed budget — clusters
  older turns, scores by importance, summarizes rather than truncates
- **Voice I/O** — speech-to-text via Whisper / Parakeet / ElevenLabs
  Realtime (`provider: 'elevenlabs'` on `transcribeStream`),
  text-to-speech via Kokoro / Qwen3-TTS, in-process (no Python server)
- **Voice-sidecar dispatch** — two-track conversation pattern for
  sub-500-ms first audio. The fast LLM streams audio while a heavier
  sidecar runs in parallel for the substantive answer; barge-in
  cancels both tracks and bumps the turn id so stale results are
  dropped. Optional `DirectDataFetcher` bypasses the LLM entirely
  for tool-likely utterances (calendar / email / search) on hit.
  Periodic progress phrases keep the user informed when a sidecar
  takes longer than expected. `dispatch_voice_turn` + `cancel_voice_turn`
  + `prewarm_voice_turn` on every binding (NAPI / PyO3 / UniFFI /
  WebSocket); voice-track telemetry in the eventlog
- **Browser automation** — Chromium control via `car browse run`.
  Accessibility-tree perception, element-ID resolution across ops,
  JSON script in → JSON trace out. Navigate / observe / click / type /
  scroll / keypress / wait
- **Multi-agent** — swarm, pipeline, supervisor, map-reduce, vote patterns
- **Scheduler** — background task execution with triggers and schedules
- **WebSocket server** — `car-server` exposes the runtime over JSON-RPC.
  Bidirectional callbacks let JS / Python / Swift / Kotlin clients act
  as tool dispatchers, agent runners, and voice-event sinks
- **Mobile bindings** — Swift / Kotlin via UniFFI; ships as
  `CarFfi.xcframework` (iOS / macOS) and an `.aar` archive (Android).
  Same runtime, native idioms on each platform
- **Apple framework providers** (macOS) — `Speech` for STT,
  `AVSpeechSynthesizer` for TTS, on-device `FoundationModels` LLM
  (macOS 26+), `Vision` (OCR / faces / barcodes / image classification),
  `NaturalLanguage` (lang ID / NER / lemmatize / tokenize),
  `Translation` (headless XPC, macOS 26+), `SoundAnalysis`
  (ambient audio-event classification)
- **Meeting capture** (`car-meeting`) — multi-speaker transcription with
  diarization, voiceprint enrollment, optional summarization
- **A2A bridge** (`car-a2a`) — exposes CAR as an Agent2Agent v1.0 agent
  for cross-runtime interoperation

**What's exposed where today.** The Python and Node bindings cover state,
memory, skills, tools, policies, verification, unified inference (local +
remote), the adaptive router, voice I/O, multi-agent, workflows, code
reasoning, the active planner, browser automation, and meeting capture.
The `car` CLI wraps the same surfaces. **Swift / Kotlin bindings via
UniFFI** cover a runtime-construction subset (health, agent listing,
capability invocation, voice-turn dispatch) for iOS / macOS / Android
hosts — shipped as `CarFfi.xcframework` and an `.aar` archive.
**`car-server`** exposes everything over JSON-RPC WebSocket, the
language-agnostic surface other bindings build on.

## What using it looks like

```python
import json
import car_runtime

rt = car_runtime.CarRuntime()

# Tools are callbacks — you own the implementation.
rt.register_tool("shell")

# Policies are enforced in Rust before any tool fires.
rt.register_policy("no_rm", "deny_tool_param",
                   target="shell", key="command", pattern="rm -rf")

# A proposal is a DAG of actions with dependencies.
proposal = json.dumps({"actions": [
    {"id": "a1", "type": "tool_call", "tool": "shell",
     "parameters": {"command": "ls"}, "dependencies": []},
]})

# Verify first — catches bad plans before any side effect.
check = json.loads(rt.verify_proposal(proposal))
if not check["valid"]:
    raise RuntimeError(check["issues"])

# Execute with your tool dispatch.
def tool_fn(tool, params_json):
    return json.dumps({"stdout": "..."})

result = json.loads(rt.execute_proposal(proposal, tool_fn))
```

Equivalents exist for Node.js (`car-runtime` on npm), Swift / Kotlin
(UniFFI bindings shipped as `CarFfi.xcframework` / `.aar`), the
standalone `car` CLI, and the `car-server` JSON-RPC WebSocket protocol
for any other language.

## Platforms

| Platform | Binaries | Python wheel |
|----------|----------|--------------|
| macOS ARM64 (15+) | `car-darwin-arm64.tar.gz` | `macosx_15_0_arm64` |
| Linux x86_64 | `car-linux-x64-gnu.tar.gz` | `manylinux_2_28_x86_64` |
| Linux aarch64 | `car-linux-arm64-gnu.tar.gz` | (no wheel — use tarball) |
| Windows x86_64 | `car-win32-x64-msvc.zip` | `win_amd64` |

Intel Macs (`x86_64-apple-darwin`) are not supported — macOS is
Apple Silicon only. Windows aarch64 pending. Linux aarch64 ships a
CLI / server / `.node` tarball but no Python wheel.

## Install

### Python

```bash
pip install car-runtime
```

PyPI auto-resolves to the right wheel for your platform. Python 3.9+, abi3.
Import name is `car_runtime`.

<details>
<summary>Direct wheel download (if PyPI isn't available)</summary>

Pick the wheel for your platform from the [latest release](https://github.com/Parslee-ai/car-releases/releases/latest):

- `car_runtime-*-cp39-abi3-macosx_15_0_arm64.whl` — Apple Silicon (macOS 15+)
- `car_runtime-*-cp39-abi3-manylinux_2_28_x86_64.whl` — Linux x86_64
- `car_runtime-*-cp39-abi3-win_amd64.whl` — Windows x86_64

Linux aarch64 has no wheel — use the platform tarball below.

Wheel filenames carry the version, so there is no version-independent
`latest` URL — substitute the current release:

```bash
VERSION=0.13.0  # current release
pip install "https://github.com/Parslee-ai/car-releases/releases/download/v${VERSION}/car_runtime-${VERSION}-cp39-abi3-macosx_15_0_arm64.whl"
```

</details>

### Node.js

```bash
npm install car-runtime
```

The post-install hook downloads the platform `.node` module from the latest
GitHub release. Air-gapped installs can set `CAR_RUNTIME_SKIP_DOWNLOAD=1` and
drop the `.node` file in by hand.

Or load the platform `.node` module directly (they ship as standalone
release assets):

```bash
curl -OL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-runtime.darwin-arm64.node
```

```javascript
const native = require('./car-runtime.darwin-arm64.node');
const rt = new native.CarRuntime();
```

<details>
<summary>Tarball (no npm, just the CLI + native .node file)</summary>

Platform tarballs ship the CLI, server, and the Node.js `.node` binary:

```bash
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
./car --help
```

Tarball filenames are stable across versions — `/releases/latest/download/...`
always resolves to the newest.

</details>

### CLI + server

The CAR CLI (`car`), server (`car-server`), and evaluation bridge
(`car-memgine-eval`) ship as native binaries.

**Homebrew (macOS + Linux):**

```bash
brew install Parslee-ai/car/car
```

Tap: https://github.com/Parslee-ai/homebrew-car

**Scoop (Windows):**

```powershell
scoop bucket add car https://github.com/Parslee-ai/scoop-car
scoop install car
```

Bucket: https://github.com/Parslee-ai/scoop-car

**Winget (Windows):** Submission in progress — manifest lives at
[`winget/manifests/p/Parslee/Car/`](./winget). Will be `winget install Parslee.Car`
once the PR to `microsoft/winget-pkgs` lands.

**Install script (macOS + Linux, no Homebrew):**

```bash
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh
```

Installs to `~/.car/bin/` and prints the PATH snippet to add. Pin a version
with `CAR_VERSION=v0.13.0`, override the install dir with `CAR_INSTALL=...`.

**Manual tarball / zip:**

```bash
# Apple Silicon
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz

# Linux x86_64
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-linux-x64-gnu.tar.gz | tar -xz

# Windows x86_64 (PowerShell)
Invoke-WebRequest -Uri https://github.com/Parslee-ai/car-releases/releases/latest/download/car-win32-x64-msvc.zip -OutFile car.zip
Expand-Archive car.zip -DestinationPath .
```

Each tarball / zip also contains the Node.js native module
(`car-runtime.{platform}.node`) for users who prefer not to use npm.

### CAR Host.app (macOS menu bar)

A signed, notarized SwiftUI menubar app — dashboard (agents, chat,
approvals, diagnostics) plus the approval UI for high-risk calls. It
embeds and supervises `car-server`, so it's the no-terminal way to
run CAR on macOS (Apple Silicon, macOS 26+).

**Homebrew Cask:**

```bash
brew install --cask Parslee-ai/car/car-host
```

**Or the installer — no Homebrew:** download `CAR-darwin-arm64.pkg`
from the [latest release](https://github.com/Parslee-ai/car-releases/releases/latest)
and double-click. It installs `CAR Host.app` → `/Applications` and
the `car` CLI → `/usr/local/bin`.

Either way the app keeps itself up to date automatically (built-in
Sparkle updater) — no `brew upgrade` needed for the app.

## Quickstart

See [`examples/`](./examples/):

- [`examples/python/hello_car.py`](./examples/python/hello_car.py) — state, facts, verify, execute
- [`examples/node/hello-car.js`](./examples/node/hello-car.js) — same idea in JS
- [`examples/python/inference.py`](./examples/python/inference.py) — local inference + streaming
- [`examples/python/agent_with_tools.py`](./examples/python/agent_with_tools.py) — real filesystem tools + policies, a runnable end-to-end agent
- [`examples/python/memory_and_skills.py`](./examples/python/memory_and_skills.py) — facts, 4-layer context, skills with triggers, persist + reload
- [`examples/python/multi_agent.py`](./examples/python/multi_agent.py) — pipeline of agents, trace collection, skill distillation + evolution loop
- [`examples/node/multi-agent.js`](./examples/node/multi-agent.js) — JS version of the multi-agent + evolution flow
- [`examples/python/voice_turn.py`](./examples/python/voice_turn.py) — voice-sidecar dispatch (two-track conversation, conversational vs tool-likely classification, barge-in cancel) — v0.7.0
- [`examples/node/voice-turn.js`](./examples/node/voice-turn.js) — same voice-sidecar pattern in JS — v0.7.0

## Build your first agent (copy/paste into an LLM)

Paste everything in the block below into Claude / ChatGPT / Cursor and fill in
the `TASK:` line. The model has enough context to produce a working agent on
first try.

````markdown
I want to build an AI agent using **Common Agent Runtime (CAR)**, a Rust-native
runtime where models propose actions and the runtime validates + executes them
deterministically.

TASK: <DESCRIBE WHAT YOU WANT THE AGENT TO DO — e.g. "read a directory of PDFs,
extract titles + abstracts, produce a JSON report">

Use the Python binding `car_runtime` (pip install car-runtime — import name is
`car_runtime`) unless I tell you otherwise. Keep everything in one file.

## What CAR gives you

- `CarRuntime()` — a stateful runtime. Exposes `state_*`, `add_fact`,
  `register_tool`, `register_policy`, `verify_proposal`, `execute_proposal`,
  `infer_tracked`, `infer_stream`, plus persistence + memory graph.
- **You write the tools.** Tools are Python functions dispatched by a callback.
  The runtime owns the DAG, state, policies, verification — not the tools.
- **Proposals are plans.** A proposal is JSON describing a list of actions and
  their dependencies. Verify before executing.

## Action / proposal shape

```json
{
  "actions": [
    {
      "id": "a1",
      "type": "tool_call",
      "tool": "read_file",
      "parameters": {"path": "/tmp/foo.txt"},
      "dependencies": []
    },
    {
      "id": "a2",
      "type": "tool_call",
      "tool": "summarize",
      "parameters": {"text_ref": "$a1.output"},
      "dependencies": ["a1"]
    }
  ]
}
```

Valid `type` values: `tool_call`, `state_write`, `state_read`, `assertion`.

## Tool callback contract

```python
def tool_fn(tool: str, params_json: str) -> str:
    params = json.loads(params_json)
    # dispatch to your real implementation
    if tool == "read_file":
        return json.dumps({"content": open(params["path"]).read()})
    # ...
    return json.dumps({"error": f"unknown tool: {tool}"})
```

Return a JSON string. Errors are just a `{"error": "..."}` payload — the
runtime handles retries + replans if configured.

## Skeleton to fill in

```python
import json
import car_runtime

def build_agent():
    rt = car_runtime.CarRuntime()

    # 1. Register the tools your agent will use.
    for tool_name in ["<TOOL_1>", "<TOOL_2>"]:
        rt.register_tool(tool_name)

    # 2. Add safety policies. Examples:
    rt.register_policy("no_rm", "deny_tool_param",
                       target="shell", key="command", pattern="rm -rf")

    # 3. Seed facts the agent should know (optional).
    rt.add_fact("goal", "<WHAT THE AGENT IS TRYING TO DO>", "pattern")

    # 4. Build a proposal (hand-written for deterministic flows, or generated
    #    by infer_tracked for model-driven ones).
    proposal = {"actions": [ ... ]}

    # 5. Verify first — cheap, catches bad plans before any tool runs.
    check = json.loads(rt.verify_proposal(json.dumps(proposal)))
    if not check["valid"]:
        raise SystemExit(f"invalid plan: {check['issues']}")

    # 6. Execute.
    def tool_fn(tool, params_json):
        params = json.loads(params_json)
        # IMPLEMENT ME
        return json.dumps({"ok": True})

    result = json.loads(rt.execute_proposal(json.dumps(proposal), tool_fn))
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    build_agent()
```

## Model-driven proposals (optional)

If the plan itself should come from an LLM, use `infer_tracked`:

```python
out = json.loads(rt.infer_tracked(
    f"Propose a JSON action plan for: {task}. "
    f"Return ONLY a JSON object with an `actions` array.",
    max_tokens=2048,
))
proposal = json.loads(out["text"])
```

## Rules for the code you generate

- **No mocks.** Use real filesystem, real HTTP, real subprocess calls.
- **Verify before execute.** Every proposal goes through `verify_proposal`
  first — show the check in the output.
- **One file.** Put everything in a single runnable `.py`.
- **Fail loud.** Don't swallow errors. Raise `SystemExit` with a useful message.
- **Print the final result as JSON** so it's easy to diff / test.

Now write the agent for my TASK above.
````

For a TypeScript version of this prompt, swap:

- `car_runtime` (Python import) → `car-runtime` (npm)
- `rt.register_tool` / `register_policy` → `await rt.registerTool` / `registerPolicy`
- `rt.execute_proposal(json, fn)` → `await executeProposal(rt, json, fn)` (standalone)
- `rt.infer_tracked` → `await rt.inferTracked`

## Build a multi-agent system (copy/paste into an LLM)

For systems with more than one agent — a pipeline, a swarm, a supervisor — or
anything that should learn from its own traces, paste this into Claude / ChatGPT
/ Cursor with the `TASK:` line filled in.

````markdown
I want to build a multi-agent system using **Common Agent Runtime (CAR)** that
also learns skills from its own execution traces and evolves them over time.

TASK: <DESCRIBE WHAT THE SYSTEM SHOULD DO — e.g. "given a repo URL, use a
scraper agent to pull the README, a reviewer agent to identify the 3 biggest
risks, and a writer agent to draft an executive summary">

Use the Python binding `car_runtime` (pip install car-runtime — import name is
`car_runtime`). One file. No mocks.

## CAR's multi-agent building blocks

Five coordination patterns are exposed as standalone functions. You pick the
one that matches the shape of the work:

- `run_pipeline(stages_json, task, agent_fn)` — linear chain, each stage's
  output feeds the next. Use for staged refinement.
- `run_swarm(mode, agents_json, task, agent_fn, synthesizer_json=None)` — mode
  is `"parallel"` (independent), `"sequential"`, or `"debate"`. Use for
  exploration or multi-perspective synthesis.
- `run_supervisor(workers_json, supervisor_json, task, max_rounds, agent_fn)` —
  a supervisor agent routes subtasks to workers over several rounds. Use for
  long-horizon planning.
- `run_map_reduce(mapper_json, reducer_json, task, items_json, agent_fn)` —
  map `items_json` in parallel, reduce to one answer. Use for batch work.
- `run_vote(agents_json, task, agent_fn, synthesizer_json=None)` — parallel +
  voted/synthesized result. Use for higher-confidence answers.

You can call `register_agent_runner(agent_fn)` once instead of passing `agent_fn`
to every call; subsequent run_* invocations use the stored callback.

## AgentSpec + AgentOutput shape

```python
spec = {
    "name": "reviewer",
    "system_prompt": "You review code for the 3 biggest risks.",
    "tools": ["grep", "read_file"],
    "max_turns": 5,
    "metadata": {"model": "claude-opus-4-7", "temperature": 0.3},
}
```

The `agent_fn(spec_json, task)` callback is YOUR code. It MUST return a JSON
string with this shape:

```python
{
    "name": spec["name"],
    "answer": "...final answer text...",
    "turns": 1,
    "tool_calls": 0,
    "duration_ms": 100.0,
    "error": None,        # or a string if the agent failed
}
```

The runtime doesn't care how you produce `answer` — Anthropic API, OpenAI,
local Qwen3 via `rt.infer_tracked`, a deterministic tool chain, whatever.

## Learning loop: trace → distill → evolve

After running agents, collect `TraceEvent` objects and feed them back:

```python
trace = [
    {"kind": "action_succeeded", "action_id": "step1", "tool": "scraper",
     "data": {"task": task, "domain": "web"}, "reward": 1.0},
    {"kind": "action_failed", "action_id": "step2", "tool": "scraper",
     "data": {"task": task, "domain": "web"}, "reward": 0.0},
    # ...
]

# Extract skills from successful traces (requires configured inference).
skills_json = rt.distill_skills(json.dumps(trace))
rt.ingest_distilled_skills(skills_json)

# Track per-skill outcomes — this is what makes domains look weak.
rt.report_outcome("scrape_and_summarize", "success")
rt.report_outcome("scrape_and_summarize", "fail")

# Find domains below the success threshold.
weak = rt.domains_needing_evolution(threshold=0.6)

# Evolve new skill variants for weak domains (requires inference).
for domain in weak:
    rt.evolve_skills(json.dumps(trace), domain)

# Repair a specific degraded skill.
repaired = rt.repair_skill("scrape_and_summarize")
```

Skills that degrade past a threshold get auto-marked for repair. See
[`examples/python/multi_agent.py`](./examples/python/multi_agent.py) for a
reference implementation.

## Skeleton to fill in

```python
import json
import car_runtime

def main():
    rt = car_runtime.CarRuntime()

    def agent_fn(spec_json: str, task: str) -> str:
        spec = json.loads(spec_json)
        # CALL YOUR LLM HERE. Build a system prompt from spec["system_prompt"],
        # optionally enrich with rt.build_context(task), optionally stream via
        # rt.infer_stream. Must return the AgentOutput JSON shape.
        return json.dumps({
            "name": spec["name"],
            "answer": "IMPLEMENT ME",
            "turns": 1, "tool_calls": 0, "duration_ms": 1.0,
        })

    car_runtime.register_agent_runner(agent_fn)

    # Define your agents — pick fields that match what your agent_fn uses.
    agents = json.dumps([
        {"name": "<AGENT_1>", "system_prompt": "<ROLE>",
         "tools": [], "max_turns": 5, "metadata": {"domain": "<DOMAIN>"}},
        # ...
    ])

    # Pick the coordination pattern that fits the task.
    result = json.loads(car_runtime.run_pipeline(agents, "<TASK>"))
    print(json.dumps(result, indent=2))

    # Collect a trace from the result, call rt.distill_skills / evolve_skills
    # as shown above. Repeat on subsequent runs to close the learning loop.

if __name__ == "__main__":
    main()
```

## Rules for the code you generate

- **Pick one coordination pattern** and justify it in a comment.
- **agent_fn does the LLM work.** Don't try to make CAR call an LLM directly.
- **AgentOutput shape is strict:** `name`, `answer`, `turns`, `tool_calls`
  (integer count — NOT an array), `duration_ms`, `error`. Missing fields break
  deserialization silently.
- **Synthesize traces from pipeline/swarm output** if you want to feed the
  learning loop — convert each stage's success/error into a `TraceEvent`.
- **Report outcomes** (`rt.report_outcome`) as agents succeed or fail in
  production — that's what drives `domains_needing_evolution`.
- **Skip distill_skills / evolve_skills if no inference is configured** —
  they'll hang waiting for a model otherwise. Use hand-coded skills +
  `ingest_distilled_skills` as a bootstrap.
- **One file. Print the final result as JSON.**

Now write the multi-agent system for my TASK above.
````

## Versioning

CAR is pre-1.0. Breaking changes between minor versions are possible — pin to
exact versions until the API stabilizes. Each release lists breaking changes
in the GitHub release notes.

## Releases

Releases in this repo are auto-mirrored from the private `Parslee-ai/car`
source repo via its `.github/workflows/build.yml` workflow (job
`mirror-to-car-releases`), which runs on every `v*` tag push. The manual
`mirror-release.yml` workflow in this repo is a fallback for backfilling
older tags or recovering from a failed auto-mirror — it is not the primary
path.

## Issues

Report binary-side problems (install, crashes, platform support, docs) on
this repo's issue tracker. Source-related issues stay with the maintainers.

## Why the runtime ships as a sealed binary

Two reasons, both load-bearing.

**1. The runtime is the agent's guardrail.** CAR validates and verifies what
models propose before any side-effect runs. If an agent operating in your
environment can rewrite the validator, the validator stops being a check on
the model — it becomes a suggestion the agent can edit out. Distributing
the runtime as a sealed binary means agents can call into CAR but cannot
patch their own guardrails. Verification stays a property of the substrate.

**2. A stable signed identity unlocks privileged OS surfaces.** On macOS in
particular, the things users actually want from an agent — microphone /
screen-capture / accessibility access, App Intents registration, Apple
Translation XPC, Keychain-stored secrets, notarized framework calls — are
bound to a code-signed binary identity. A user-rebuildable runtime resets
TCC permissions on every build and can't carry entitlements that the OS
gates behind notarized signatures. Shipping one signed binary lets the user
grant permission once to "Common Agent Runtime" and have it persist across
upgrades, and lets CAR reach OS capabilities a from-source build can't.

Source access for vendors, integrators, and research collaborations is
available under separate terms — see License below.

## License

Two licenses, depending on what you're using — see [LICENSE](./LICENSE) for the
authoritative text.

- **Binaries** (tarballs, wheels, `.node` modules, CLI) — free for any use
  including commercial, free to redistribute unmodified. Modification, reverse
  engineering, and derivative works are not permitted. Copyright © 2026
  Parslee AI. Source is not published under an open license.
- **Repository contents** (README, examples, install scripts, workflows) —
  Apache-2.0. Copy, modify, and reuse freely.

If you need terms beyond those — source access, modification rights, a
commercial redistribution agreement — contact Parslee AI.
