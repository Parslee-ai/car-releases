{% raw %}
# macOS Apple-frameworks providers

CAR ships first-class STT, TTS, and on-device LLM backends that lean on the frameworks macOS already provides — `SFSpeechRecognizer` (Speech), `AVSpeechSynthesizer` (AVFoundation), and `SystemLanguageModel` (FoundationModels). On macOS they are the default; Linux and Windows fall back to the cross-platform stack (`whisper.cpp`, ElevenLabs, the local OpenAI-compatible TTS server). No feature flags — gating is purely `cfg(target_os = "macos")`, plus runtime version checks where the framework requires them.

This recipe covers two things integrators need to know:

1. **Permissions and code-signing** — what Apple's frameworks require before they'll actually return results.
2. **Provider selection priority** — what runs by default and how to override.

## Provider selection on macOS

| Capability | macOS default | Cross-platform default | Other on-platform options |
|------------|--------------|------------------------|---------------------------|
| STT (batch) | `apple_speech` | `whisper_cpp` | `elevenlabs`, `parakeet` (feature-gated) |
| STT (streaming) | `apple_speech` | `whisper_cpp` (streaming variant) | `parakeet` (feature-gated) |
| TTS | `apple_speech` | `elevenlabs` | `kokoro` (Apple-Silicon-only), `local`, `elevenlabs` |
| Inference (cheap, fast-turn) | `apple/foundation:default` via router | cloud | any registered cloud or local model |
| Inference (heavy reasoning) | best cloud model the router picks | cloud | n/a |

The defaults on macOS are chosen to be free, on-device, and require no model download. To override:

```bash
# Per-process env vars — also accepted in `~/.car/env`.
TOKHN_STT_PROVIDER=whisper_cpp        # or elevenlabs, parakeet, apple_speech
TOKHN_TTS_PROVIDER=kokoro             # or local, elevenlabs, apple_speech
```

Or programmatically via `VoiceConfig`:

```rust
use car_voice::{SttProvider, TtsProvider, VoiceConfig};

let cfg = VoiceConfig {
    stt_provider: SttProvider::WhisperCpp,
    tts_provider: TtsProvider::Kokoro,
    ..VoiceConfig::default()
};
```

Both knobs are independent — you can keep Apple Speech for STT and switch TTS to Kokoro because you prefer its voice character.

To see which providers were actually compiled in for the current binary (useful for diagnostics, picker UIs, or CI gating):

```ts
// NAPI
import { listVoiceProviders } from '@parslee-ai/car-runtime-native';
console.log(JSON.parse(listVoiceProviders()));
```

```python
# PyO3
from car_runtime import list_voice_providers
import json
print(json.loads(list_voice_providers()))
```

```jsonc
// WebSocket: { "method": "voice.providers.list" }
[
  { "id": "apple_speech",  "kind": "stt", "available": true,  "description": "..." },
  { "id": "whisper_cpp",   "kind": "stt", "available": true,  "description": "..." },
  { "id": "parakeet",      "kind": "stt", "available": false, "description": "..." },
  // ... and TTS
]
```

`available` reflects build-time presence — whether the impl compiled in for the target. Runtime readiness (API key set, model downloaded, microphone permission granted) is surfaced by each provider's first-use error path.

## Foundation Models routing

On macOS 26+ Apple Silicon with Apple Intelligence enabled, `apple/foundation:default` is registered automatically. The adaptive router picks it for short, fast-turn tasks (autocomplete, summarize, classify) via a tag-driven bonus on `low_latency` + `private` models. Heavier reasoning still routes to whichever cloud model wins on quality / context-window headroom. Nothing to configure for the default behavior.

Tool calling and `JsonSchema`-constrained output are supported: tool definitions become per-tool `DynamicGenerationSchema`s, a captured call comes back as the standard `tool_calls` shape, and `response_format: {type: "json_schema", ...}` uses the framework's native constrained decoding. Image/audio/video input is rejected with `UnsupportedMode` — the public FoundationModels API is text-only.

Tool-calling caveats to design around:

- **One tool call per turn, never parallel.** The catalog entry claims the `tool_use` capability but deliberately **not** `multi_tool_call` — that is the router-readable signal: prompts the adaptive router classifies as needing parallel tool calls require `multi_tool_call` and route to a model that has it, falling back past `apple/foundation:default` automatically.
- **Pre-call assistant text is discarded on captured-call turns.** The bridge ends the model turn the moment a tool call is captured, so `text` is empty whenever `tool_calls` is non-empty. Don't expect Anthropic-style "prose + tool_use in one turn".
- **Schema degradations are warned, not silent.** JSON-Schema constructs the `DynamicGenerationSchema` conversion can't represent (`oneOf`/`anyOf`/`$ref`, union types like `["number","null"]`, non-string enums) degrade to permissive string fields — never to an empty object — and numeric enums keep the base type but lose the value constraint. Each degradation is logged via `tracing::warn!` before the request crosses into Swift.

`is_available()` is checked behind a 5 s TTL cache — Apple Intelligence can be toggled in System Settings or finish provisioning after process start, and a long-running daemon recovers without a restart.

To explicitly request the system LLM:

```ts
const out = await rt.infer({
    model: 'apple/foundation:default',
    prompt: 'classify: "shipping update"',
});
```

If the framework reports unavailable (pre-26 macOS, Intel Mac, Apple Intelligence off), the call returns `UnsupportedMode` and the router falls through to the next candidate.

## Permissions: what `SFSpeechRecognizer` actually requires

Phase A's biggest surprise is that getting Apple Speech STT to return results requires **all three** of:

1. **`NSSpeechRecognitionUsageDescription` in `Info.plist`.** Without it, the Speech framework logs `SFUtilities defaultClientID: Application does not have a bundle identifier; using unstable "<private>" as client identifier` and recognition fails to resolve assets.
2. **`SFSpeechRecognizer.requestAuthorization` called and granted by the user.** The provider re-checks status on every transcribe call and surfaces an actionable error if not `Authorized`.
3. **A real Developer ID signature.** Apple Mobile File Integrity (`amfid`) rejects ad-hoc signed binaries with code -423, and the Speech framework's XPC service then *silently drops* the result-handler callback. Recognition appears to run for the full request window with no result and no error — only the 60 s safety timeout catches it.

Practically: the recognizer works inside a properly-signed host app (`apps/host-macos/Parslee.app`, the future iOS host) but **does not work inside a stand-alone `cargo run` CLI binary**. The smoke example at `car-rs/crates/car-voice/examples/apple_speech_stt_smoke.rs` documents this and exits non-fatally on the timeout pattern; integration tests for the happy path live in the host app.

A minimal `Info.plist` for a host app:

```xml
<key>CFBundleIdentifier</key>
<string>your.bundle.id</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Used to transcribe your voice for the agent.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Used to capture your voice when speaking to the agent.</string>
```

Both privacy strings are required even if the host claims to never record audio — `SFSpeechRecognizer` won't resolve its on-device assets without `NSMicrophoneUsageDescription` declared. See `apps/host-macos/Resources/Info.plist` for the full host-app version.

The provider's authorization-status error spells out the exact remediation:

```
apple speech: authorization not yet requested — host app must call
SFSpeechRecognizer.requestAuthorization at startup. Note: bundle Info.plist
must declare NSSpeechRecognitionUsageDescription or the app will crash on
first request.
```

If you see this, the host app's startup path is missing the prompt. The ObjC call from Swift:

```swift
import Speech

SFSpeechRecognizer.requestAuthorization { _ in
    // The status comes through asynchronously; the runtime will check
    // it again on the next transcribe call, so no action needed here.
}
```

## TTS playback paths

`AppleSpeechSpeaker` exposes two paths:

- `speak(text)` — direct playback through `AVSpeechSynthesizer.speakUtterance`. No PCM round-trip, no temp file. Use this when you just want the device to speak.
- `synth(text)` — captures 16-bit PCM WAV via `say(1)` and returns it as bytes. Use this when you need the audio (mixing, file output, network streaming).

The reason `synth()` shells out to `say(1)` instead of using `AVSpeechSynthesizer.writeUtterance(toBufferCallback:)`: that callback path is broken on macOS 26.4.1 — the block is never invoked, even when `speakUtterance` works on the same synthesizer instance. `say(1)` is Apple's own thin wrapper around the same engine, ships with every macOS install, and produces exactly the audio we want.

## Cross-platform fallback

On Linux and Windows the Apple variants are not compiled in (`available: false`), and `provider::build_stt_provider` / `build_tts_speaker` reject them with a config error pointing at the cross-platform alternatives. No code change is needed when moving a config across platforms — leave the providers unset and the per-platform `Default` impl picks the right backend.

## See also

- `docs/mobile-platform.md` — the iOS / Android plan that builds on these same providers.
- `apps/host-macos/Resources/Info.plist` — concrete reference Info.plist for a host app that uses Speech + microphone.

{% endraw %}
