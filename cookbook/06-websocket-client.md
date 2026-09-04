# WebSocket client (non-Node)

When you're not on Node or Python, the WebSocket protocol is your interface. Anything that speaks WebSocket and JSON can drive CAR.

## Run the server

```bash
car-server --port 9100
```

## Minimal Python client (no FFI dependency)

This works with stock Python — `pip install websockets`, no `car-runtime` wheel needed.

```python
import asyncio
import json
import websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:9100") as ws:
        # 1. Initialize the session.
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.init",
            "params": {
                "tools": [
                    {"name": "shell", "description": "run a shell command"}
                ],
                "policies": [
                    {"name": "no_rm", "rule": "deny_tool_param",
                     "target": "shell", "key": "command", "pattern": "rm -rf"}
                ],
            },
            "id": 1,
        }))
        print(await ws.recv())

        # 2. Add a fact, then build context.
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "method": "memory.add_fact",
            "params": {"subject": "lang", "body": "Python", "kind": "pattern"},
            "id": 2,
        }))
        print(await ws.recv())

        await ws.send(json.dumps({
            "jsonrpc": "2.0", "method": "memory.build_context",
            "params": {"query": "what language is this?"},
            "id": 3,
        }))
        print(await ws.recv())

        # 3. Submit a proposal — must handle bidirectional tool callbacks.
        await ws.send(json.dumps({
            "jsonrpc": "2.0", "method": "proposal.submit",
            "params": {
                "proposal": {
                    "actions": [{
                        "id": "a1", "type": "tool_call", "tool": "shell",
                        "parameters": {"command": "echo hi"},
                    }]
                }
            },
            "id": 4,
        }))

        # The server may send tools.execute requests back to us — handle them
        # in the same recv loop.
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("method") == "tools.execute":
                # Server wants us to run a tool. Respond with the same id.
                tool = msg["params"]["tool"]
                params = msg["params"]["params"]
                if tool == "shell":
                    result = {"stdout": "hi\n", "stderr": "", "code": 0}
                else:
                    result = {"error": f"unknown tool: {tool}"}
                await ws.send(json.dumps({
                    "jsonrpc": "2.0", "result": result, "id": msg["id"],
                }))
            elif msg.get("id") == 4:
                # Final proposal result.
                print("proposal result:", msg)
                break

asyncio.run(main())
```

## Minimal Go client

```go
package main

import (
    "encoding/json"
    "log"

    "github.com/gorilla/websocket"
)

type RpcRequest struct {
    Jsonrpc string      `json:"jsonrpc"`
    Method  string      `json:"method"`
    Params  any         `json:"params"`
    ID      int         `json:"id,omitempty"`
}

type RpcResponse struct {
    Jsonrpc string          `json:"jsonrpc"`
    Method  string          `json:"method,omitempty"`
    Params  json.RawMessage `json:"params,omitempty"`
    Result  json.RawMessage `json:"result,omitempty"`
    Error   *struct {
        Code    int    `json:"code"`
        Message string `json:"message"`
    } `json:"error,omitempty"`
    ID json.RawMessage `json:"id,omitempty"`
}

func main() {
    c, _, err := websocket.DefaultDialer.Dial("ws://127.0.0.1:9100", nil)
    if err != nil {
        log.Fatal(err)
    }
    defer c.Close()

    // Initialize session.
    must(c.WriteJSON(RpcRequest{
        Jsonrpc: "2.0",
        Method:  "session.init",
        Params: map[string]any{
            "tools": []map[string]any{{"name": "shell"}},
        },
        ID: 1,
    }))

    // Add a fact.
    must(c.WriteJSON(RpcRequest{
        Jsonrpc: "2.0",
        Method:  "memory.add_fact",
        Params:  map[string]any{"subject": "lang", "body": "Go", "kind": "pattern"},
        ID:      2,
    }))

    // Drain responses (handle tools.execute callbacks here too).
    for i := 0; i < 2; i++ {
        var resp RpcResponse
        must(c.ReadJSON(&resp))
        log.Printf("resp: %+v", resp)
    }
}

func must(err error) {
    if err != nil {
        log.Fatal(err)
    }
}
```

## Request/response framing

- Every request has a numeric or string `id`. Match responses by `id`.
- Notifications (no `id`) come from the server: `host.event`, `voice.event`, and the `tools.execute` / `multi.run_agent` callbacks.
- For callbacks, you must respond on the **same** `id` the server sent. The server is blocked on your response.

## Discovery

Send `host.subscribe` first if you want to be notified of agent registrations, status changes, and approval requests:

```json
{"jsonrpc": "2.0", "method": "host.subscribe", "params": {}, "id": 1}
```

After this, the server pushes `host.event` notifications to you alongside any explicit responses.

## Full method reference

[`docs/websocket-protocol.md`](../websocket-protocol.md) — 73+ methods across 23 namespaces.
