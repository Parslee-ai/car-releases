# Common Agent Runtime

A deterministic execution layer for AI agents. Models propose; the runtime validates and executes.

CAR sits between models and tools, turning probabilistic model output into validated, state-aware, auditable execution. It is **not a framework for building agents** — it is the runtime that agents execute on.

```
model → Agent IR → Common Agent Runtime → tools and state transitions
```

## Why

Most agent systems treat the model as both the source of reasoning and the controller of execution. That works for demos. It does not work for durable systems.

CAR separates those concerns. The model proposes. The runtime decides and executes.

- **Static verification before execution** — check a plan is satisfiable, and catch missing tools, bad parameters, and dependency errors, before calling any tools.
- **Policies enforced on every action** — declarative rules, not prompt engineering.
- **Graph-based memory** — spreading activation over a knowledge graph, not flat key-value.
- **Native skills** — learned procedures as first-class runtime primitives.
- **DAG execution** — independent actions run concurrently.
- **Idempotency, retry, timeout, rollback** — execution safety the model doesn't have to think about.
- **Language-agnostic** — native Rust core with Node.js, Python, and WebSocket bindings.

## How to read this site

- **Specifications** — wire-format contracts you build against. Start with [Agent IR](./agent-ir-spec.md) for the proposal/action shape, then [WebSocket Protocol](./websocket-protocol.md) for the language-agnostic surface.
- **Cookbook** — short, focused recipes for the things people actually want to do. Each is self-contained and runnable. New to CAR? Start with [Tool call: register, verify, execute](./cookbook/01-tool-call-and-verify.md).
- **Reference** — release process, case studies, integration notes.

## Quickstart

Install:

```bash
npm install car-runtime          # Node.js (bundles car-server too)
pip install car-runtime          # Python (bundles car-server too)
# macOS .pkg / GitHub Release archive (Linux/Windows) — see README.md
```

Start the daemon (v0.8+) — every binding is a thin client to one
singleton `car-server` process per host:

```bash
# Foreground (Ctrl-C to stop). Default port 9100; auth on by default.
npx --package=car-runtime car-server
# or:
python -m car_runtime.server
# or, on macOS, double-click CAR Host.app — it supervises car-server
# for you and updates in place via Sparkle.
```

Code:

```typescript
import { CarRuntime, executeProposal } from 'car-runtime';

const rt = new CarRuntime();   // lazy-connects to ws://127.0.0.1:9100/
await rt.registerTool('shell');
await rt.registerPolicy('no_rm', 'deny_tool_param', 'shell', 'command', 'rm -rf');

const proposal = JSON.stringify({
  actions: [{
    id: 'a1', type: 'tool_call', tool: 'shell',
    parameters: { command: 'ls' }, idempotent: true,
  }],
});

const check = JSON.parse(await rt.verifyProposal(proposal));
if (!check.valid) throw new Error(JSON.stringify(check.issues));

// The callback runs in this Node process; the daemon's WsToolExecutor
// calls back over the same WebSocket via DaemonClient::register_handler
// (phase 7.4) when an action needs to dispatch a tool.
const result = await executeProposal(rt, proposal, async (callJson) => {
  const { tool, params } = JSON.parse(callJson);
  return JSON.stringify(await myTools[tool](params));
});
```

For full quickstarts in Node, Python, and over WebSocket, see the [project README](https://car.parslee.ai/README.md).

## For AI coding agents

Working on a project that *uses* CAR? The repo ships two LLM-friendly bundles:

- [`llms.txt`](https://car.parslee.ai/llms.txt) — navigational index. Tell your assistant where the docs live.
- [`llms-full.txt`](https://car.parslee.ai/llms-full.txt) — concatenated full docs (~722 KB). Drop into a Claude Project, ChatGPT custom instructions, or Cursor docs to seed an assistant with everything it needs.
