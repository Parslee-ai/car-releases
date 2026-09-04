{% raw %}
# Streaming inference

Streaming is a daemon WebSocket feature. Send the `infer_stream` JSON-RPC
method to `car-server`; token and tool deltas arrive as
`inference.stream.event` notifications, and the final accumulated result is
the JSON-RPC response. The NAPI `inferStream` export and Python
`CarRuntime.infer_stream` method are compatibility stubs that always raise.

## Request

```json
{
  "jsonrpc": "2.0",
  "id": "turn-1",
  "method": "infer_stream",
  "params": {
    "prompt": "Explain CAR in one sentence.",
    "model": "openrouter/openai/gpt-5.4",
    "max_tokens": 1024
  }
}
```

Connect to the daemon URL (by default `ws://127.0.0.1:9100/`) and complete
`session.auth` first when daemon authentication is enabled. See
[the WebSocket protocol](../websocket-protocol.md) for the handshake and token
file locations.

The example names a model, so CAR treats it as a hard pin. The daemon forces
`params.strict_model` to `true` even if the request sends `false`; if that
provider fails, the JSON-RPC call returns its error instead of silently adding
CAR's on-device last-resort fallback. Leave `model` out when you want adaptive
routing and automatic fallback.

On Windows the auth-token file contains DPAPI ciphertext, not the plaintext
token. Do not read that file directly from JavaScript or Python. The examples
below prefer `CAR_AUTH_TOKEN`; for a same-host loopback daemon they otherwise
fetch the already-decrypted token from CAR's colocated, no-store UI endpoint on
the WebSocket port plus one. For a remote Windows daemon, set
`CAR_AUTH_TOKEN` explicitly.

## TypeScript

```typescript
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ws = new WebSocket(process.env.CAR_DAEMON_URL ?? 'ws://127.0.0.1:9100/');

async function loadAuthToken(daemonUrl: string): Promise<string> {
  const fromEnv = process.env.CAR_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === 'win32') {
    const uiUrl = new URL(daemonUrl);
    if (!['127.0.0.1', 'localhost', '::1'].includes(uiUrl.hostname)) {
      throw new Error('Set CAR_AUTH_TOKEN for a remote Windows CAR daemon.');
    }
    uiUrl.protocol = uiUrl.protocol === 'wss:' ? 'https:' : 'http:';
    uiUrl.port = String(Number(uiUrl.port || (uiUrl.protocol === 'https:' ? 443 : 80)) + 1);
    uiUrl.pathname = '/auth-token';
    uiUrl.search = '';
    uiUrl.hash = '';
    const response = await fetch(uiUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`CAR auth-token endpoint returned ${response.status}`);
    const token = (await response.text()).trim();
    if (!token) throw new Error('CAR daemon has no auth token; set CAR_AUTH_TOKEN or use --no-auth.');
    return token;
  }
  const tokenPath = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'ai.parslee.car', 'auth-token')
    : process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, 'ai.parslee.car', 'auth-token')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
          'ai.parslee.car', 'auth-token');
  return readFileSync(tokenPath, 'utf8').trim();
}

ws.on('open', async () => {
  try {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'auth',
      method: 'session.auth',
      params: { token: await loadAuthToken(ws.url) },
    }));
  } catch (error) {
    console.error(error);
    ws.close();
  }
});

ws.on('message', (bytes) => {
  const frame = JSON.parse(bytes.toString());
  if (frame.id === 'auth') {
    if (frame.error) throw new Error(frame.error.message);
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 'turn-1',
      method: 'infer_stream',
      params: {
        prompt: 'Explain CAR in one sentence.',
        model: 'openrouter/openai/gpt-5.4',
        max_tokens: 1024,
      },
    }));
    return;
  }
  if (frame.method === 'inference.stream.event') {
    const event = frame.params.event;
    if (event.type === 'text') process.stdout.write(event.data);
    if (event.type === 'error') console.error(`\n${event.message}`);
    return;
  }
  if (frame.id === 'turn-1') {
    if (frame.error) throw new Error(frame.error.message);
    console.log('\nfinal:', frame.result);
    ws.close();
  }
});
```

## Python

```python
import asyncio
import json
import os
import platform
from pathlib import Path
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen
import websockets

def read_windows_loopback_token(daemon_url: str) -> str:
    parsed = urlparse(daemon_url)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise RuntimeError("Set CAR_AUTH_TOKEN for a remote Windows CAR daemon.")
    scheme = "https" if parsed.scheme == "wss" else "http"
    port = (parsed.port or (443 if scheme == "https" else 80)) + 1
    host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
    token_url = urlunparse((scheme, f"{host}:{port}", "/auth-token", "", "", ""))
    with urlopen(Request(token_url, headers={"Cache-Control": "no-store"})) as response:
        token = response.read().decode("utf-8").strip()
    if not token:
        raise RuntimeError("CAR daemon has no auth token; set CAR_AUTH_TOKEN or use --no-auth.")
    return token

async def load_auth_token(daemon_url: str) -> str:
    if token := os.getenv("CAR_AUTH_TOKEN", "").strip():
        return token
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        token_path = home / "Library/Application Support/ai.parslee.car/auth-token"
    elif system == "Windows":
        return await asyncio.to_thread(read_windows_loopback_token, daemon_url)
    elif runtime_dir := os.getenv("XDG_RUNTIME_DIR"):
        token_path = Path(runtime_dir) / "ai.parslee.car/auth-token"
    else:
        token_path = Path(os.getenv("XDG_CONFIG_HOME", home / ".config"))
        token_path /= "ai.parslee.car/auth-token"
    return token_path.read_text(encoding="utf-8").strip()

async def main() -> None:
    url = os.getenv("CAR_DAEMON_URL", "ws://127.0.0.1:9100/")
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "auth",
            "method": "session.auth",
            "params": {"token": await load_auth_token(url)},
        }))
        auth = json.loads(await ws.recv())
        if "error" in auth:
            raise RuntimeError(auth["error"]["message"])
        await ws.send(json.dumps({
            "jsonrpc": "2.0",
            "id": "turn-1",
            "method": "infer_stream",
            "params": {
                "prompt": "Explain CAR in one sentence.",
                "model": "openrouter/openai/gpt-5.4",
                "max_tokens": 1024,
            },
        }))
        async for raw in ws:
            frame = json.loads(raw)
            if frame.get("method") == "inference.stream.event":
                event = frame["params"]["event"]
                if event["type"] == "text":
                    print(event["data"], end="", flush=True)
                elif event["type"] == "error":
                    print(f"\n{event['message']}")
                continue
            if frame.get("id") == "turn-1":
                if "error" in frame:
                    raise RuntimeError(frame["error"]["message"])
                print("\nfinal:", frame["result"])
                break

asyncio.run(main())
```

## Event types

| `type` | Fields | Meaning |
|---|---|---|
| `text` | `data: string` | next text delta |
| `tool_start` | `name: string`, `index: number` | model started a tool call |
| `tool_delta` | `index: number`, `data: string` | partial JSON arguments |
| `usage` | token-count fields | provider usage |
| `stop_reason` | `data: string` | provider stop reason |
| `provider_output_item` | `item: object` | opaque replayable provider item |
| `error` | `message: string` | terminal failure |

The final response contains accumulated `text`, `tool_calls`, `usage`,
`stop_reason`, `trace_id`, and `model_used`. A stream that emits `error`
returns a JSON-RPC error, never a partial success.

## Memory context and tools

`infer_stream.params` accepts the same `GenerateRequest` fields as `infer`,
including `context`, `context_query`, `tools`, `tool_choice`,
`parallel_tool_calls`, and `intent`. Put those fields in the request object;
there is no positional streaming signature.

## Cancellation

Close the WebSocket to stop receiving notifications. Cooperative request-level
cancellation is not currently a separate JSON-RPC method.

{% endraw %}
