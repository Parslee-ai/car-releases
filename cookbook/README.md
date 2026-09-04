# CAR Cookbook

Short, focused recipes for the things people actually want to do with CAR. Each recipe is self-contained and runnable.

If you're just starting:
- New to CAR? Start with [01-tool-call-and-verify.md](./01-tool-call-and-verify.md).
- Building an OS-level integration over WebSocket? See [06-websocket-client.md](./06-websocket-client.md).
- Wiring CAR into Claude Desktop / Cursor? See [07-mcp-server.md](./07-mcp-server.md).

| # | Recipe | What it shows |
|---|--------|---------------|
| 01 | [Tool call: register, verify, execute](./01-tool-call-and-verify.md) | the canonical lifecycle |
| 02 | [Memory: facts and 4-layer context](./02-memory-and-context.md) | `addFact` + `buildContext` for grounding |
| 03 | [Skills: ingest, find, report outcome](./03-skills-loop.md) | learned procedures with auto-degradation |
| 04 | [Multi-agent: swarm, pipeline, and advisor](./04-multi-agent.md) | parallel, sequential, and bounded-advisor coordination |
| 05 | [Persist and resume conversation](./05-persist-conversation.md) | JSONL write-through + reload |
| 06 | [WebSocket client (non-Node)](./06-websocket-client.md) | minimal Go / Python WS consumer |
| 07 | [MCP server in Claude Desktop](./07-mcp-server.md) | wire `car-mcp-server` into MCP clients |
| 08 | [Policies: deny, gate, require state](./08-policies.md) | the four built-in policy rules |
| 09 | [Streaming inference](./09-streaming-inference.md) | per-token output via daemon WebSocket |
| 10 | [`.car/` project directory](./10-car-project-directory.md) | team-shareable knowledge / rubrics / config |
| 11 | [Keychain-stored API keys](./11-keychain-keys.md) | desktop-friendly secrets via `car secrets` + migrate-from-env |
| 12 | [macOS Apple-frameworks providers](./12-macos-apple-frameworks.md) | Speech / AVFoundation / FoundationModels — defaults, permissions, overrides |
| 13 | [Voice orchestration](./13-voice-orchestration.md) | voice-context prompt overlay (Phase A); two-track sidecar lands in subsequent phases |
| 14 | [Cross-host deployment](./14-cross-host-deployment.md) | daemon on Linux + client on Windows (or any split) via `$CAR_DAEMON_URL` + `$CAR_AUTH_TOKEN` |

Recipes use TypeScript and Python interchangeably — pick whichever is clearer for the surface. The runtime behavior is identical across bindings.
