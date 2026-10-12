{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### voice

#### `voice.prepare_parakeet`
- **Params**: `{}`
- **Returns**: prep status — downloads the Parakeet TDT model on first call (~600 MB)

#### `voice.prepare_diarizer`
- **Params**: `{}`
- **Returns**: prep status — downloads the diarization model

#### `voice.transcribe_stream.start`
- **Params**: `{ session_id: string, audio_source: object, options?: object }`
- **Returns**: `{ session_id: string, status: string, ... }`
- Pushes `voice.event` notifications with partials and finals.
- `options.provider` selects the streaming STT backend. Default is the in-process pipeline (whisper.cpp / VPIO / Apple Speech). `"elevenlabs"` routes pushed PCM through ElevenLabs' Realtime STT websocket — only meaningful with `audio_source.kind = "pcm_push"` and 1 channel; requires `ELEVENLABS_API_KEY` in env, config, or keychain. `"local"` is the explicit form of the default. Unknown values are rejected at start time.

#### `voice.transcribe_stream.push`
- **Params**: `{ session_id: string, pcm_b64: string }` — base64-encoded 16-bit signed PCM
- **Returns**: interim update

#### `voice.transcribe_stream.stop`
- **Params**: `{ session_id: string }`
- **Returns**: final transcription result

#### `voice.tts_stream.start`
- **Params**: `{ stream_id: string, text: string, options?: object }`
- **Returns**: `{ stream_id: string, binary_frames: boolean }`
- Begins streaming TTS synthesis. Provider-agnostic — dispatches through the configured `Speaker` (`build_tts_speaker(&config)`); any provider with the default `synth_stream` trait method emits one final chunk, providers that override it (e.g. ElevenLabs `/stream`) emit chunks as they arrive.
- `options`:
  - `provider`: `"elevenlabs"` | `"local"` | `"kokoro"` | `"apple_speech"`. Default uses the platform default from `VoiceConfig`.
  - `voice_id`: provider-specific voice id. ElevenLabs is the only provider that consumes this today; other providers ignore it.
  - `binary_frames`: when `true`, audio chunks ride as CAR binary frames (type `0x02`, see below) and JSON `tts_chunk` events are suppressed. The `stream_id` MUST be a 32-char lowercase hex UUID (no dashes) in this mode — the binary header needs raw UUID bytes.
- Pushes `voice.event` notifications with `type = "tts_chunk"` carrying `{ stream_id, seq, audio_b64, format: "mp3" | "wav", is_final }` when `binary_frames = false`.

#### `voice.tts_stream.cancel`
- **Params**: `{ stream_id: string }`
- **Returns**: `{ stream_id, cancelled: boolean }`
- Aborts an in-flight TTS stream. Idempotent: unknown ids return `{cancelled: false}` rather than an error so callers can race cancellation against natural completion. This is the barge-in path.

#### `voice.tts_stream.list`
- **Params**: `{}`
- **Returns**: `{ streams: [stream_id, ...] }`

#### `voice.sessions.list`
- **Params**: `{}`
- **Returns**: `[ { session_id, status, ... }, ... ]`

#### `voice.providers.list`
- **Params**: `{}`
- **Returns**: `[ { id: string, kind: "stt" | "tts", available: boolean, description: string }, ... ]`
- Stateless. Enumerates STT/TTS providers compiled into the server binary. `available` reflects build-time presence (cfg-target, build features). Runtime readiness — API key set, permission granted (e.g. `apple_speech` requires `SFSpeechRecognizer.requestAuthorization`), model downloaded — surfaces only when the caller actually exercises that provider.

#### `voice.enroll_speaker`
- **Params**: `{ label: string, audio: object }`
- **Returns**: enrollment success indicator

#### `voice.list_enrollments`
- **Params**: `{}`
- **Returns**: enrolled speaker labels

#### `voice.remove_enrollment`
- **Params**: `{ label: string }`
- **Returns**: success indicator

#### `voice.dispatch_turn`
- **Params**: `{ utterance: string, session_id?: string, config_overlay?: string, sidecar_timeout_ms?: number }`
- **Returns**: `{ turn_id: number }` — minted once the utterance is routed (see **Routing**)
- Two-track sidecar pattern: a fast inference (`prefer_fast: true`) streams text deltas while a parallel sidecar runs to completion. Tool-likely utterances (email/calendar/search) skip the fast track and play a hardcoded bridge phrase via `voice.event` while only the sidecar runs (the "STRUCTURAL HALLUCINATION FIX" — prevents the fast model from inventing tool data).
- Pushes `voice.event` notifications carrying `voice.turn.*` payloads (see below).
- `config_overlay` overrides the voice-context prompt overlay; an empty string disables it. Omit to use the built-in default.
- `sidecar_timeout_ms` defaults to 30000.
- **Routing**: where the OS's on-device model (Apple FoundationModels) is available, the utterance is classified on it by guided generation before dispatch (~0.4 s, at most ~2 s); a refusal, failure or timeout routes the turn as tool-likely (a bridge phrase). Without an OS model, keyword matching decides. Voice never uses a hosted or CAR-bundled model for this.
- **Superseded**: a dispatch overtaken while it is being classified — by a newer `voice.dispatch_turn` or `voice.cancel_turn` — returns an error (`voice turn superseded …`) and dispatches nothing.

#### `voice.cancel_turn`
- **Params**: `{}`
- **Returns**: `{ cancelled: true }`
- Cancels the in-flight voice turn. Idempotent. Bumps the stored turn id so any in-flight sidecar result is dropped at its arrival gate (race-recovery on barge-in).

#### `voice.prewarm_turn`
- **Params**: `{}`
- **Returns**: `{ prewarmed: true }`
- Issues a 1-token probe with `prefer_fast: true` so the fast model is loaded into memory before the first user turn. Best-effort and idempotent — call at session start so the first turn meets the <500ms first-audio target.

### `voice.event`
Pushed during active `meeting.*`, `voice.transcribe_stream.*`, and `voice.tts_stream.*` sessions. Payload includes transcript segments, partials, finals, source identifiers, and TTS chunk metadata (`type = "tts_chunk"` carrying `{ stream_id, seq, audio_b64, format, is_final }`).


{% endraw %}
