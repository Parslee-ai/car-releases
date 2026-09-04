# Voice orchestration

CAR's voice stack ships listener / VAD / TTS primitives in `car-voice`. To turn a finalized utterance into voice-shaped audio, callers also need *voice-tuned prompting* — without it, models emit markdown, ask clarifying questions, and dump multi-paragraph answers that take ten seconds to read out loud.

Phase A ships the prompting piece: `DEFAULT_VOICE_PROMPT_OVERLAY` + `compose_voice_context`. Phases B–D (covered later in this doc when they land) layer the two-track sidecar architecture on top.

> **Status — Phases A–D shipped on `main`.** Voice-context overlay (Phase A), the engine-side `dispatch_voice_turn` core (Phase B), the orchestrator + classifier + bridge phrases + prewarm (Phase B), the `DirectDataFetcher` fast-data-path (Phase C), and progress phrases (Phase D) are all available today.
>
> **v0.8 surface change.** `dispatchVoiceTurn` / `cancelVoiceTurn` / `prewarmVoiceTurn` were exposed on the NAPI/PyO3 surface in v0.7.0 but were retired from the FFI bindings in v0.8 — voice turn dispatch lives daemon-side now. From Node/Python, drive the flow through the daemon's WebSocket: call `voice.dispatch_turn`, register a notification handler for `voice.event` (which carries `voice.turn.*` payloads), and call `voice.cancel_turn` for barge-in. In-process Rust consumers can still use `car_voice::VoiceOrchestrator` directly. See [`docs/proposals/voice-sidecar-orchestration-plan.md`](../proposals/voice-sidecar-orchestration-plan.md) and [`docs/websocket-protocol.md`](../websocket-protocol.md) for the wire shapes.
>
> **Runnable demo:** [`car-rs/examples/voice-loop/`](../../car-rs/examples/voice-loop/) wires listener → orchestrator → speaker end-to-end on macOS. `cargo run --release --manifest-path car-rs/examples/voice-loop/Cargo.toml`.

## The voice-context overlay

```rust
use car_voice::{compose_voice_context, VoiceConfig};
use car_inference::{GenerateRequest, InferenceEngine};

let cfg = VoiceConfig::default();
let context = compose_voice_context(&cfg, None);

let req = GenerateRequest {
    prompt: utterance,
    context, // overlay folded in here
    ..Default::default()
};
let answer = engine.generate(req).await?;
```

The overlay tells the model: brief replies (<500 chars), no clarifying questions, no markdown, fetch broadly when checking email/calendar. Verbose by design — quip's production canaries showed this exact shape works where shorter prompts didn't.

## Customizing the overlay

`VoiceConfig.voice_prompt_overlay` is `Option<String>`:

| Value | Behavior |
|-------|----------|
| `None` (default) | Use `DEFAULT_VOICE_PROMPT_OVERLAY` |
| `Some("custom prompt")` | Substitute the custom string |
| `Some("")` | Disable overlay (caller supplies their own voice-tuned prompt) |

Compose with a caller-supplied system prompt:

```rust
let cfg = VoiceConfig {
    voice_prompt_overlay: Some(my_overlay.into()),
    ..VoiceConfig::default()
};
let context = compose_voice_context(&cfg, Some("You are Tokhn, an assistant."));
// context = Some("<my_overlay>\n\nYou are Tokhn, an assistant.")
```

When both an overlay and a caller prompt are present, the overlay precedes the caller prompt with a blank line between them.

## From the FFI side

JS / Python / WebSocket callers pass the overlay through `TranscribeStreamOptions.voice_prompt_overlay`. The runtime threads it into `VoiceConfig` for that session.

### TypeScript

```typescript
import { transcribeStream, type TranscribeStreamOptions } from 'car-runtime';

const opts: TranscribeStreamOptions = {
  voice_prompt_overlay: null, // null = use default
  // voice_prompt_overlay: '', // empty string = disable
  // voice_prompt_overlay: 'Custom voice prompt...', // custom override
};

await transcribeStream(rt, sessionId, JSON.stringify({ kind: 'mic' }), JSON.stringify(opts));
```

### Python

```python
import json
import car_runtime

opts = {
    "voice_prompt_overlay": None,  # use default
}

car_runtime.transcribe_stream(
    session_id=session_id,
    audio_source_json=json.dumps({"kind": "mic"}),
    options_json=json.dumps(opts),
)
```

### WebSocket

```json
{
  "jsonrpc": "2.0",
  "method": "voice.transcribe_stream",
  "params": {
    "session_id": "abc-123",
    "audio_source": {"kind": "mic"},
    "options": {
      "voice_prompt_overlay": null
    }
  },
  "id": 1
}
```

## Why this matters

Voice has different latency and brevity constraints than text. A model asked "what's on my calendar today" without voice context might respond:

> Sure, I'd be happy to help! Could you let me know which calendar you'd like me to check — work, personal, or something else? I can also filter by attendee or location if that's useful.

That's a clarifying question on a live call where the user is staring at silence. With the overlay, the same model emits:

> You have three meetings today: 9 AM standup, 11 AM with Bob, 3 PM review.

The overlay is unconditional and adds ~500 bytes to every voice-path inference. Negligible cost; large quality difference.

## The orchestrator (Rust, in-process)

In-process Rust consumers go through `VoiceOrchestrator` instead of composing the request manually:

```rust
use std::sync::Arc;
use car_inference::{InferenceConfig, InferenceEngine};
use car_voice::{
    apple_speech_tts::AppleSpeechSpeaker,
    cpal_listener::CpalListener,
    events::VoiceEvent,
    listener::Listener,
    Speaker, VoiceConfig, VoiceOrchestrator,
};

let engine = Arc::new(InferenceEngine::new(InferenceConfig::default()));
let speaker: Arc<dyn Speaker> = Arc::new(AppleSpeechSpeaker::from_config(&VoiceConfig::default()));
let orchestrator = Arc::new(VoiceOrchestrator::new(engine, speaker, VoiceConfig::default()));

orchestrator.prewarm().await; // load the fast model once at startup

let mut listener = CpalListener::new();
let mut events = listener.start(VoiceConfig::default()).await?;

while let Some(evt) = events.recv().await {
    match evt {
        VoiceEvent::Transcript { text, .. } => {
            let orch = orchestrator.clone();
            tokio::spawn(async move {
                let _ = orch.handle_utterance(text).await;
            });
        }
        VoiceEvent::BargeIn => {
            orchestrator.cancel_current_turn().await;
        }
        _ => {}
    }
}
```

The orchestrator handles classifier routing, bridge phrases, fast-track streaming-into-TTS, sidecar timeouts, race-recovery on barge-in, and (optionally) telemetry / mixer-routed cancellable playback. All builder methods:

| Builder | Effect |
|---------|--------|
| `with_mixer(Some(handle))` | Cancellable TTS — barge-in halts the active clip |
| `with_telemetry(sink)` | Emit `VoiceFastTurnStarted` / `VoiceSidecarResolved` / etc. to a `car-eventlog` sink |
| `with_direct_fetcher(fetcher)` | Phase C — bypass the LLM for tool-likely utterances |
| `with_sidecar_timeout(Duration)` | Override the 30s default sidecar wait |

A complete runnable example lives at [`car-rs/examples/voice-loop/`](../../car-rs/examples/voice-loop/). `cargo run --release --manifest-path car-rs/examples/voice-loop/Cargo.toml`.

## From the FFI side (v0.7.0+)

Once v0.7.0 ships, JS / Python / Swift / Kotlin hosts use `dispatchVoiceTurn` (or its language equivalent) and feed the events into the host's own TTS. The `voice.turn.*` event taxonomy is shared across all four bindings and the WebSocket protocol. See [`docs/websocket-protocol.md`](../websocket-protocol.md) for the JSON-RPC method shapes.
