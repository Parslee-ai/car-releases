{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### admission

Process-wide concurrency gate for inference RPC handlers (`infer`, `embed`, `classify`). The daemon sizes the permit count from host RAM at startup (~1 permit per 8 GB, floor 1, ceiling 8) and serializes excess load instead of letting parallel calls pile up KV-cache and activation memory until the host OOMs. The cap can be overridden at start time with the `CAR_INFERENCE_MAX_CONCURRENT` env var.

#### `admission.status`
- **Params**: `{}`
- **Returns**: `{ permits_total: number, permits_available: number, permits_in_use: number, env_override: string }`
- Read-only snapshot. Racy by definition (counts can change between read and reply); intended for menubar/status dashboards, not for client-side rate-limiting decisions.


{% endraw %}
