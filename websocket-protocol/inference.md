{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### inference (additional)

#### `rerank`
- **Params**: full `RerankRequest` JSON: `{ query, documents: [...], model?, top_n?, instruction? }`
- **Returns**: `{ ranked: [{index, score, document}, ...], model_used }`
- Rerank candidate documents against a query using a cross-encoder.

#### `transcribe`
- **Params**: full `TranscribeRequest` JSON: `{ audio_path?, audio_b64?, model?, language?, prompt?, timestamps? }`
- **Returns**: transcription result JSON
- **Sandbox-crossing escape hatch** (closes [Parslee-ai/car-releases#31](https://github.com/Parslee-ai/car-releases/issues/31)): pass `audio_b64` (standard base64 of the audio bytes) instead of `audio_path` when the caller can't share a filesystem view with the daemon — typical for an unsandboxed WS client talking to a sandboxed daemon. The server decodes to a tempfile (auto-cleaned on response), then runs transcribe normally. `audio_b64` wins if both are set.
- **Filesystem caveat** (when using `audio_path`): the path is interpreted on the daemon's filesystem, not the caller's.

#### `synthesize`
- **Params**: full `SynthesizeRequest` JSON. Optional WS-only field: `return_b64: bool` (default false).
- **Returns**: synthesis result JSON `{ audio_path, media_type, ..., audio_b64? }`. The `audio_b64` field is included when `return_b64: true` is set OR when `output_path` was omitted (typical sandbox-crossing case where the caller has no shared path to pick).
- Same filesystem caveat as `transcribe` for `output_path` and `reference_audio_path` when supplied.
- Closes [Parslee-ai/car-releases#31](https://github.com/Parslee-ai/car-releases/issues/31) on the synthesize side.

#### `search`
- **Params**: `{ query: string, max_results?: number }` (`max_results` clamped to 1–20, default 5).
- **Returns**: `{ query, source, results: [{ title, url, snippet, score, published_date? }] }`, where `source` is `"parslee"`, `"tavily"`, or `"duckduckgo"`.
- **Backend resolution** (daemon-side, from its environment): a signed-in Parslee session (`PARSLEE_ACCESS_TOKEN`) → Parslee's hosted search (`/api/v1/orgs/{org}/search`); else `TAVILY_API_KEY` (env or keychain) → Tavily direct; else the keyless DuckDuckGo fallback (zero-config, lower quality). No params control the backend — it's environment-resolved.
- Results cached ~60s; rate-limited 10/min (per the `search` ToolSchema).

#### `web_fetch`
- **Params**: `{ url: string }`.
- **Returns**: `{ url, status, content_type, title?, text }` — `url` is the final URL after redirects; `text` is extracted readable text (HTML reduced to title + visible text, scripts/styles dropped; non-HTML returned verbatim).
- Only the first 8 MiB of the response body are read; the `text` of a longer page is of that part and ends in `…[truncated]…`.
- Keyless (plain HTTP GET). Cached ~300s; rate-limited 20/min. Companion to `search`.

#### `speech.prepare`
- **Params**: `null`
- **Returns**: managed speech runtime root path as JSON string — the same root
  `speech.health` / `car speech doctor` report, on every platform.
- Provisions the managed `mlx-audio` runtime (a `uv` venv + pip install, so the
  first call on a fresh machine can take minutes). Idempotent: a no-op once the
  runtime is ready.
- The returned path is **not** a success signal. On Apple Silicon the managed
  runtime is a fallback behind the native MLX backends, so a bootstrap that
  can't run (no `uv`, no usable Python) is logged and the root is still
  returned; everywhere else it is the only local speech path and the call
  errors. Read `speech.health.runtime.installed` for the real state
  (Parslee-ai/car#649).

#### `models.route`
- **Params**: `{ prompt: string, intent?: IntentHint }`. `intent` is an
  optional routing hint; notably `exclude_models: string[]` ("any capable
  model that is NOT one of these") for adversarial-reviewer separation so a
  model never grades its own work (car#358). Each entry may be a catalog
  `model_id` **or** a `model_name` — the two differ for most models, and
  `model_name` is what a result reports as the model it used, so the identifier
  you have in hand always works (car#889). Exclusion is soft — if it leaves
  no candidate it is dropped rather than failing. Absent `intent` routes
  exactly as before.
- **Returns**: route decision JSON for the adaptive router —
  `{ model_id, model_name, task, complexity, reason, strategy,
  predicted_quality, fallbacks: string[], context_length, needs_compaction,
  candidates: RouteCandidate[] }`. `fallbacks` is the ordered retry chain
  (in-band models first under outcome-first routing). `candidates` is the
  advisory ranking: every scored model the router considered, each
  `{ model_id, reliability, score, selected, in_band }` — `reliability` is the
  cost-free outcome-derived band key, `score` is the full blended score
  (reliability plus cost/latency/context tie-breakers), `selected` flags the
  chosen model, `in_band` marks models inside the outcome-first reliability band
  (the eligible set). Lets a UI/operator see *why* a model won and what the
  alternatives cost in reliability terms. Empty on explicit-model and
  cold-start/error paths where no ranking occurred. The FFI `route_model()`
  (NAPI/PyO3) returns this same JSON as a string and takes an optional
  `intentJson` / `intent_json` carrying the same `IntentHint`.

#### `models.stats`
- **Params**: `null`
- **Returns**: `{ profiles: ModelStat[] }` where each `ModelStat` is
  `{ model_id, total_calls, success_count, fail_count, success_rate,
  avg_latency_ms, ema_quality }`. `success_rate` is `number | null` — `null`
  until something resolves (never a fabricated 0.5 prior). The FFI
  `model_stats()` (NAPI/PyO3) returns this same JSON as a string.

### inference

Closes [Parslee-ai/car-releases#24](https://github.com/Parslee-ai/car-releases/issues/24). When a model schema declares `source: { type: "delegated", ... }`, CAR routes the request through the registered WebSocket session. The host owns the wire format (Anthropic, OpenAI, Vercel AI SDK, etc.); CAR observes events and stays in the policy / replay path.

#### `inference.register_runner`
- **Params**: `{}`
- **Returns**: `{ registered: true }`
- Marks this WebSocket session as the inference runner host. Idempotent — re-calling overwrites any prior registration. Only one runner can be registered per process.

#### `inference.runner.event`
- **Params**: `{ call_id: string, event: object }`
- **Returns**: `{ emitted: true }`
- **Optional.** A runner that has nothing to stream may go straight to `inference.runner.complete`; see below.
- Called by the runner host for every chunk its provider streams back. `event` must be one of the shapes below — **this list is exhaustive**, and any other shape is rejected with `unrecognised runner event shape`:
  - `{ type: "text", data: string }`
  - `{ type: "tool_start", name: string, index: number, id?: string }`
  - `{ type: "tool_delta", index: number, data: string }`
  - `{ type: "usage", input_tokens: number, output_tokens: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }`
    CAR books the runner's reported `output_tokens` as the turn's output and records the usage on the generation span; a missing usage event or `output_tokens: 0` falls back to an estimate of ~4 bytes per token over the text and tool calls.
  - `{ type: "provider_output_item", item: object }`
  - `{ type: "error", message: string }`
  - `{ type: "done", text: string, tool_calls: ToolCall[] }`
- The tags above are the wire vocabulary and deliberately do **not** match the internal `StreamEvent` variant names (`TextDelta`, `ToolCallStart`, …). Use the tags, not the variant names.

#### `inference.runner.complete`
- **Params**: `{ call_id: string, result: { text: string, tool_calls: ToolCall[] } }`
- **Returns**: `{ completed: true }`
- Called by the runner host once the upstream call finishes successfully. Resolves CAR's awaiting future for `call_id` with `result`.
- **Terminal on its own.** A runner that emits no `inference.runner.event` at all and answers with `complete` is fully supported — a delegated model returning a short non-streaming answer has nothing to stream. `result.text` / `result.tool_calls` are used whenever no events were emitted; when events *were* emitted, the accumulated stream is authoritative and `result` supplies only what the stream did not. (Before car-releases#76 an event-less completion returned empty text and was silently retried, doubling latency.)

#### `inference.runner.fail`
- **Params**: `{ call_id: string, error: string }`
- **Returns**: `{ failed: true }`
- Called by the runner host on upstream failure (HTTP error, auth failure, provider rate limit). Surfaces as `InferenceError::InferenceFailed(error)` to the original caller.

##### `inference.runner.invoke` (server → client notification)

When CAR needs to dispatch a delegated model, the server sends:

```json
{
  "jsonrpc": "2.0",
  "method": "inference.runner.invoke",
  "params": {
    "call_id": "uuid-string",
    "request": { /* GenerateRequest */ }
  }
}
```

The client correlates events back via `call_id` through the three methods above.

**Correlating an invoke with your own request.** `call_id` is minted by the daemon *after* the caller issued `infer`, so a host with several calls in flight cannot use it to find its own request state. Set `client_ref` on the `GenerateRequest` — an opaque string CAR never reads, routes on, or interprets — and it is echoed verbatim inside `params.request.client_ref`:

```json
{ "method": "inference.runner.invoke",
  "params": { "call_id": "…", "request": { "client_ref": "your-uuid", "…": "…" } } }
```

Do not smuggle an identifier through `prompt`. That worked only because delegated models ignore `prompt` for prompt construction, and breaks silently the moment one stops ignoring it (car-releases#78).

##### `voice.turn.*` event taxonomy

`voice.event` notifications fired during a turn carry one of:

| Event `type` | Additional fields |
|--------------|-------------------|
| `voice.turn.fast_delta` | `turn_id: number`, `text: string` |
| `voice.turn.fast_done` | `turn_id: number`; when the on-device last resort answered the fast track, also `local_last_resort: true`, `substituted_from?: string` (the model the request was routed to) and `substitution_reason?: string` (`credential_rejected` \| `credential_absent` \| `rate_limited` \| `quota_exhausted` \| `timed_out` \| `failed`) |
| `voice.turn.bridge` | `turn_id: number`, `kind: "email"\|"calendar"\|"search"\|"unknown"`, `phrase: string` |
| `voice.turn.sidecar` | `turn_id: number`, `text: string` |
| `voice.turn.error` | `turn_id: number`, `error: string` |
| `voice.turn.cancelled` | `turn_id: number` |

The host plays audio (or otherwise renders) from these events — CAR does NOT own the speaker on this path. Bridge phrases are handed to the host as `voice.turn.bridge` for the host's TTS to synthesize.


{% endraw %}
