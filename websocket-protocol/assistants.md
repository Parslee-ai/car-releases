{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### assistants

#### `assistants.invoke`
- **Params**: `{ capability: string, agent_hint?: string, payload_json: string }`
- **Returns**: `{ agent, result, run_id }`
- Daemon-owned invocation of a built-in ready-to-use assistant. Mirrors the UniFFI `invoke_capability` contract, but brackets the model call in the durable run-trace store so CarHost's Activity tab can explain what ran — which is the reason to prefer it over the UniFFI path from a host.
- `capability` selects the assistant through `AgentCapabilityRegistry` over the registered builtins; `agent_hint` breaks a tie when several satisfy it. An unsupported capability is an error, not a fallback. An empty `capability` is rejected.
- `payload_json` is the capability's own payload, passed as a **JSON string**, not an object.
- Runs with `prefer_fast`, and is capped at a hard **30s** timeout; expiry returns an error naming the timeout rather than a partial result.
- Every call records a run either way: success completes it `Success` with one turn carrying the prompt, capability, parsed payload, and output; failure records the error and terminates the run. `run_id` is how a host correlates the call with that trace.


{% endraw %}
