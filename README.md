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
- **Local inference** — Candle + MLX backends for Qwen3, Gemma, Flux, LTX,
  Parakeet, Whisper, Kokoro
- **Multi-agent** — swarm, pipeline, supervisor, map-reduce, vote patterns
- **Scheduler** — background task execution with triggers and schedules

## What using it looks like

```python
import json
import car_native

rt = car_native.CarRuntime()

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

Equivalents exist for Node.js (`car-runtime` on npm) and as a standalone
`car` CLI.

## Platforms

| Platform | Binaries | Python wheel |
|----------|----------|--------------|
| macOS ARM64 (14+) | `car-darwin-arm64.tar.gz` | `macosx_14_0_arm64` |
| macOS x86_64 (14+) | `car-darwin-x64.tar.gz` | `macosx_14_0_x86_64` |
| Linux x86_64 | `car-linux-x64-gnu.tar.gz` | `manylinux_2_17_x86_64` |
| Linux aarch64 | `car-linux-arm64-gnu.tar.gz` | `manylinux_2_28_aarch64` |
| Windows x86_64 | `car-win32-x64-msvc.zip` | `win_amd64` |

Windows aarch64 pending.

## Install

### Python

```bash
pip install car-runtime
```

PyPI auto-resolves to the right wheel for your platform. Python 3.9+, abi3.
Import name is `car_native`.

<details>
<summary>Direct wheel download (if PyPI isn't available)</summary>

Pick the wheel for your platform from the [latest release](https://github.com/Parslee-ai/car-releases/releases/latest):

- `car_runtime-*-cp39-abi3-macosx_14_0_arm64.whl` — Apple Silicon (macOS 14+)
- `car_runtime-*-cp39-abi3-macosx_14_0_x86_64.whl` — Intel Mac (macOS 14+)
- `car_runtime-*-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl` — Linux x86_64
- `car_runtime-*-cp39-abi3-manylinux_2_28_aarch64.whl` — Linux aarch64

```bash
pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car_runtime-0.3.0-cp39-abi3-macosx_14_0_arm64.whl
```

</details>

### Node.js

```bash
npm install car-runtime
```

The install step auto-downloads the matching native binary for your platform.
Node 18+.

```typescript
import { CarRuntime } from 'car-runtime';
const rt = new CarRuntime();
rt.stateSet('project', JSON.stringify('my-agent'));
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
with `CAR_VERSION=v0.3.1`, override the install dir with `CAR_INSTALL=...`.

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

## Quickstart

See [`examples/`](./examples/):

- [`examples/python/hello_car.py`](./examples/python/hello_car.py) — state, facts, verify, execute
- [`examples/node/hello-car.js`](./examples/node/hello-car.js) — same idea in JS
- [`examples/python/inference.py`](./examples/python/inference.py) — local inference + streaming
- [`examples/python/agent_with_tools.py`](./examples/python/agent_with_tools.py) — real filesystem tools + policies, a runnable end-to-end agent
- [`examples/python/memory_and_skills.py`](./examples/python/memory_and_skills.py) — facts, 4-layer context, skills with triggers, persist + reload
- [`examples/python/multi_agent.py`](./examples/python/multi_agent.py) — pipeline of agents, trace collection, skill distillation + evolution loop
- [`examples/node/multi-agent.js`](./examples/node/multi-agent.js) — JS version of the multi-agent + evolution flow

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
`car_native`) unless I tell you otherwise. Keep everything in one file.

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
import car_native

def build_agent():
    rt = car_native.CarRuntime()

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

- `car_runtime` / `car_native` → `car-runtime` (npm)
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
`car_native`). One file. No mocks.

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
import car_native

def main():
    rt = car_native.CarRuntime()

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

    car_native.register_agent_runner(agent_fn)

    # Define your agents — pick fields that match what your agent_fn uses.
    agents = json.dumps([
        {"name": "<AGENT_1>", "system_prompt": "<ROLE>",
         "tools": [], "max_turns": 5, "metadata": {"domain": "<DOMAIN>"}},
        # ...
    ])

    # Pick the coordination pattern that fits the task.
    result = json.loads(car_native.run_pipeline(agents, "<TASK>"))
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

## Issues

Report binary-side problems (install, crashes, platform support, docs) on
this repo's issue tracker. Source-related issues stay with the maintainers.

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
