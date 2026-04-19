# Common Agent Runtime — Binary Releases

Pre-built binaries, Python wheels, Node.js native modules, and examples for
**Common Agent Runtime (CAR)** — a deterministic execution layer for AI agents,
written in Rust.

Models propose. The runtime validates, verifies, and executes.

> **Source code** lives in a private repository. This repo is the public
> distribution channel: install instructions, examples, release artifacts,
> issue tracker for binary consumers.

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

## What's in the box

A deterministic DAG executor with built-in:

- **State** — typed key/value store with snapshotting
- **Memory** — graph-based (`car-memgine`) with spreading activation, 4-layer context assembly, and skill learning
- **Tools** — callback-based execution (the runtime doesn't own tools; you wire them up)
- **Policies** — Rust-enforced on every action (`deny_tool`, `deny_tool_param`, `require_state`)
- **Verification** — prove plan properties (`verify`, `simulate`, `equivalent`, `optimize`) before executing
- **Local inference** — Candle + MLX backends for Qwen3, Gemma, Flux, LTX, Parakeet, Whisper, Kokoro
- **Multi-agent coordination** — swarm, pipeline, supervisor, map-reduce, vote patterns
- **Scheduler** — background task execution with triggers and schedules

## Platforms

| Platform | Binaries | Python wheel |
|----------|----------|--------------|
| macOS ARM64 (14+) | `car-darwin-arm64.tar.gz` | `macosx_14_0_arm64` |
| macOS x86_64 (14+) | `car-darwin-x64.tar.gz` | `macosx_14_0_x86_64` |
| Linux x86_64 | `car-linux-x64-gnu.tar.gz` | `manylinux_2_17_x86_64` |
| Linux aarch64 | `car-linux-arm64-gnu.tar.gz` | `manylinux_2_28_aarch64` |
| Windows x86_64 | `car-win32-x64-msvc.zip` | `win_amd64` |

Windows aarch64 is not yet built — follows once the x64 path has soaked.

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
