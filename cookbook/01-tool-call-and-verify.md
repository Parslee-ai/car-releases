# Tool call: register, verify, execute

The canonical CAR lifecycle: register a tool, build a proposal, verify it statically, then execute it with a callback.

> **Daemon prerequisite (v0.8+).** Every binding in this recipe is a
> thin client to the singleton `car-server` daemon. Start it once
> per host before running these snippets:
> ```bash
> npx --package=car-runtime car-server &     # or: python -m car_runtime.server &
> ```
> The daemon owns inference, the per-session memory graph, and tool
> dispatch. The TypeScript snippet below uses `executeProposal` with
> a JS callback — those calls travel over WebSocket via
> `DaemonClient::register_handler` (phase 7.4); your callback still
> runs in this Node process, but the dispatch round-trip is daemon-mediated.

## TypeScript

```typescript
import { CarRuntime, executeProposal } from 'car-runtime';

const rt = new CarRuntime();
await rt.registerTool('shell');

const proposal = JSON.stringify({
  actions: [
    {
      id: 'a1',
      type: 'tool_call',
      tool: 'shell',
      parameters: { command: 'echo hello' },
      idempotent: true,
      timeout_ms: 5000,
    },
  ],
});

const check = JSON.parse(await rt.verifyProposal(proposal));
if (!check.valid) {
  throw new Error(`invalid: ${JSON.stringify(check.issues)}`);
}

const result = await executeProposal(rt, proposal, async (callJson) => {
  const { tool, params } = JSON.parse(callJson);
  if (tool === 'shell') {
    // your real shell dispatch here — child_process.execSync, etc.
    return JSON.stringify({ stdout: 'hello\n', stderr: '', code: 0 });
  }
  throw new Error(`unknown tool: ${tool}`);
});

console.log(JSON.parse(result));
```

## Python

```python
import json
from car_runtime import CarRuntime

rt = CarRuntime()
rt.register_tool("shell")

proposal = json.dumps({
    "actions": [
        {
            "id": "a1",
            "type": "tool_call",
            "tool": "shell",
            "parameters": {"command": "echo hello"},
            "idempotent": True,
            "timeout_ms": 5000,
        }
    ]
})

# Static verification — runs daemon-side, no model needed.
check = json.loads(rt.verify_proposal(proposal))
if not check["valid"]:
    raise RuntimeError(f"invalid: {check['issues']}")
```

**Proposal execution with a Python tool callback is not exposed on the
PyO3 surface in v0.8** (the daemon-only FFI cleanup retired
`execute_proposal` from the bindings). Drive execution over the
daemon's WebSocket directly — submit via `proposal.submit` and
register a `tools.execute` handler on the same connection. The
sketch:

```python
import asyncio, json, websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:9100/") as ws:
        # 1. Auth (read the token from
        #    ~/Library/Application Support/ai.parslee.car/auth-token
        #    on macOS, $XDG_CONFIG_HOME/ai.parslee.car/auth-token on Linux).
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1,
            "method": "session.auth",
            "params": {"token": open(TOKEN_PATH).read().strip()}}))
        await ws.recv()

        # 2. Submit the proposal.
        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 2,
            "method": "proposal.submit",
            "params": {"proposal": json.loads(proposal)}}))

        # 3. Drain frames. `tools.execute` arrives as a server-initiated
        #    JSON-RPC request — respond with the tool's result.
        while True:
            frame = json.loads(await ws.recv())
            if frame.get("method") == "tools.execute":
                tool, params = frame["params"]["tool"], frame["params"]["parameters"]
                # Dispatch to your real tool here.
                result = {"stdout": "hello\n", "stderr": "", "code": 0}
                await ws.send(json.dumps({"jsonrpc": "2.0",
                    "id": frame["id"], "result": result}))
            elif frame.get("id") == 2:
                print(frame.get("result"))
                break

asyncio.run(main())
```

The complete pattern lives in
`car-rs/examples/ws-client-python/` (in the source tree; see [the WebSocket client cookbook](06-websocket-client.md) for a runnable equivalent) —
including the auth-token resolution helper and a more fleshed-out
recv loop.

## Why verify before execute

`verify` is pure static analysis — it doesn't call any tools. It catches:

- references to tools you haven't registered
- preconditions that no prior action provides
- two unordered actions writing the same state key
- duplicate identical tool calls (loops)
- proposals exceeding `max_actions`

Verification cost is negligible compared to a tool round-trip, so verify everything before execution. See [`docs/agent-ir-spec.md`](../agent-ir-spec.md#verification-result) for the full result shape.

## Callback contract

The callback receives `{"tool": str, "params": object}` as a JSON string and must return the tool's result as a JSON string. Errors should be raised — the runtime catches them and emits a failed `ActionResult`.

For idempotent tools, set `idempotent: true` on the action so the runtime can cache the result and safely retry on transient failure.
