{% raw %}
# Common Agent Runtime (CAR)

A deterministic execution layer for AI agents, written in Rust.
**Models propose. The runtime validates, verifies, and executes.**

Agents that pass raw LLM output straight into tool calls fail unpredictably —
unsafe actions, hallucinated tool names, state drift. CAR treats plans as
first-class data: verify before executing, enforce policies in Rust before any
side effect, track memory as a graph, and learn reusable skills from execution
traces.

This repo is the **public binary distribution** — install, docs, examples, issue
tracker. The source is private (see *License*).

## Two ways to use CAR

**Using the `car` CLI or the flagship assistant as a product, not writing
code against it?** Skip to *Install*, then read:

- **[CLI.md](./CLI.md)** — every `car` subcommand (`car do`, `car code`,
  `car agent`, `car voice`, 60+ more), generated straight from the binary's
  own `--help` output.
- **[ASSISTANT.md](./ASSISTANT.md)** — `car do` / **Parslee Core**, the
  flagship general agent: its tools, approval tiers, sandboxing, and memory.
- **[MCP.md](./MCP.md)** — drive CAR from Claude Code, Cursor, or Claude
  Desktop over MCP, including the Claude Code plugin.

**Embedding the CAR runtime as a library in your own agent?** The rest of
this page, plus [SPEC.md](./SPEC.md) and [GUIDE.md](./GUIDE.md), are written
for you.

Everything above — plus the wire-protocol reference, the agent-bundle spec,
the host protocol, the A2A bridge, and a full cookbook — is mirrored onto
this repo as plain `.md` files: see **[llms.txt](./llms.txt)** for the full
index. (The mdBook these were authored in is GitHub Pages built from the
private source repo, and is not reachable by an anonymous reader — it 200s
and then redirects to a GitHub sign-in page — so this repo is the only
public copy.)

## What it does

A single signed binary with:

- **Verify before execute** — prove plan properties (`verify`, `simulate`,
  `equivalent`, `optimize`) before anything side-effecting runs.
- **Policies in Rust** — enforced on every action before a tool fires
  (`deny_tool`, `deny_tool_param`, `require_state`), plus risk tiers with
  human-in-the-loop approval and per-agent permissions.
- **Graph memory + skills** — spreading-activation memory, 4-layer context
  assembly for grounding LLM calls, and learned procedures that distill from
  traces and evolve when they degrade.
- **Unified inference** — local backends (Candle + MLX: Qwen3, Gemma, vision,
  embeddings, image/video) and remote providers (OpenAI/Anthropic/Google) behind
  one protocol, with an adaptive local-vs-remote router.
- **Agents at scale** — multi-agent coordination (swarm/pipeline/supervisor/
  map-reduce/vote), declarative workflows, a scheduler, and browser automation.
- **Voice + desktop (macOS)** — STT/TTS in-process, two-track voice dispatch, and
  Apple framework providers (Speech, Vision, NaturalLanguage, Translation).
- **Everywhere** — Python + Node bindings, Swift/Kotlin via UniFFI, and a
  `car-server` JSON-RPC WebSocket surface any language can drive.

→ The data shapes and semantics these build on: **[SPEC.md](./SPEC.md)**.

## What using it looks like (embedding CAR as a library)

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
# The callback takes ONE argument: a JSON string of the whole call,
# {"tool", "params", "action_id", "request_id", "timeout_ms", ...}.
def tool_fn(call_json):
    return json.dumps({"stdout": "..."})

result = json.loads(rt.execute_proposal(proposal, tool_fn))
```

Equivalents exist for Node.js, Swift/Kotlin (UniFFI), the `car` CLI, and the
`car-server` JSON-RPC protocol. To have an LLM write you a working agent, paste a
prompt from **[GUIDE.md](./GUIDE.md)**.

## Install

Pick the path that matches what you want; the full platform matrix and every
package is in **[DISTRIBUTION.md](./DISTRIBUTION.md)**.

| You want… | Do this |
|-----------|---------|
| **CAR on a Mac, no terminal** | Download **`CAR-darwin-arm64.pkg`** from the [latest release](https://github.com/Parslee-ai/car-releases/releases/latest) and double-click. Installs the **CAR Host** menu-bar app *and* the `car` CLI. Signed, notarized, auto-updating. |
| **To build on CAR** in Python / Node | `pip install car-runtime` · `npm install car-runtime` |
| **The CLI on Linux / Windows**, or scripted installs | install script · Scoop · tarball — see [DISTRIBUTION.md](./DISTRIBUTION.md) |

```bash
# macOS + Linux convenience installer (inspect-then-run guidance in SECURITY.md):
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh
# pin a version with CAR_VERSION=v0.52.0
```

macOS is Apple Silicon only (15+). Linux x86_64/aarch64 and Windows x86_64 are
supported; see the matrix for wheel availability.

## Quickstart

**Just installed the Mac app?** Read
**[`examples/macos-getting-started.md`](./examples/macos-getting-started.md)** — a
plain-English walkthrough (find it in the menu bar, sign in, open Chat, approve
the actions that matter). No terminal, no code.

**Embedding CAR in code?** The rest of [`examples/`](./examples/) is runnable
Python/Node:

- [`python/hello_car.py`](./examples/python/hello_car.py) · [`node/hello-car.js`](./examples/node/hello-car.js) — state, verify, execute
- [`python/agent_with_tools.py`](./examples/python/agent_with_tools.py) — real tools + policies, end to end
- [`python/memory_and_skills.py`](./examples/python/memory_and_skills.py) — facts, context, skills, persist + reload
- [`python/multi_agent.py`](./examples/python/multi_agent.py) · [`node/multi-agent.js`](./examples/node/multi-agent.js) — pipeline + distill/evolve loop
- [`python/voice_turn.py`](./examples/python/voice_turn.py) · [`node/voice-turn.js`](./examples/node/voice-turn.js) — voice-sidecar dispatch

## Documentation

| Doc | What's in it |
|-----|--------------|
| **[CLI.md](./CLI.md)** | Every `car` subcommand's `--help` output, generated from the real binary. |
| **[ASSISTANT.md](./ASSISTANT.md)** | `car do` / Parslee Core: tools, approvals, sandbox posture, memory. |
| **[MCP.md](./MCP.md)** | Use CAR from Claude Code / Cursor / Claude Desktop over MCP — tool list, client config, plugin. |
| **[api/car_runtime.pyi](./api/car_runtime.pyi)** · **[api/index.d.ts](./api/index.d.ts)** | The complete typed Python and Node surfaces — 229 and 200 methods, with docstrings. Read these before writing code; the examples below show a fraction of what exists. |
| **[SPEC.md](./SPEC.md)** | Proposal/action shape, tool + agent contracts, policy semantics, verification guarantees, conformance. |
| **[GUIDE.md](./GUIDE.md)** | Copy-paste-into-an-LLM prompts to build a single agent and a multi-agent learning system. |
| **[DISTRIBUTION.md](./DISTRIBUTION.md)** | Platforms, every package (PyPI/npm/Homebrew/Scoop/winget/pkg/tarball), release-asset contract. |
| **[SECURITY.md](./SECURITY.md)** | Signing/notarization, verifying a download, the sealed-binary trust boundary, reporting a vulnerability. |
| **[BENCHMARKS.md](./BENCHMARKS.md)** | How the numbers are produced + how to reproduce; live results in [LEADERBOARD.md](./LEADERBOARD.md). |
| **[CHANGELOG.md](./CHANGELOG.md)** | Per-release changes. |
| **[llms.txt](./llms.txt)** | Full index: wire-protocol reference, agent-bundle spec, host protocol, A2A bridge, and the full cookbook. |

## Versioning

CAR is pre-1.0. Breaking changes between minor versions are possible — **pin to
exact versions** until the API stabilizes. Each release lists breaking changes in
its GitHub release notes.

## Issues

Report binary-side problems (install, crashes, platform support, docs) on this
repo's issue tracker. **Security issues** go through private advisories — see
[SECURITY.md](./SECURITY.md). Source-related issues stay with the maintainers.

## License

Two licenses — see [LICENSE](./LICENSE) for the authoritative text.

- **Binaries** (tarballs, wheels, `.node` modules, CLI) — free for any use
  including commercial, free to redistribute unmodified. Modification, reverse
  engineering, and derivative works are not permitted. © 2026 Parslee AI. Source
  is not published under an open license.
- **Repository contents** (README, docs, examples, install scripts) — Apache-2.0.

Need source access, modification rights, or a commercial redistribution
agreement? Contact Parslee AI.

{% endraw %}
