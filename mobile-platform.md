# Mobile Platform Plan

> **Status:** in progress. M1 ✅ shipped, M2 ✅ landed (XCFramework + AAR build chains, iOS and Android slices in CI), M3 🟡 scaffolded (iOS host SwiftPM package, Package.swift CI check, voice loop, typed ask, Parslee Core work-location chooser, local OS capability disclosure; TestFlight upload itself is a manual Xcode step). M4 🟡 Foundation Models shim builds for iOS device + simulator slices; runtime validation on real iOS 26 hardware pending. M6 🟡 scaffolded (Kotlin + Compose host app, Android speech/TTS loop, Parslee OAuth sign-in, automatic Parslee Core discovery, approvals, fixture mode, emulator runner, and local emulator validation). M5, M7 not started. See the [phased delivery section](#phased-delivery) for per-milestone status.

CAR's existing architecture is unusually well-suited for mobile because three load-bearing abstractions are already in place:

- **Tools are callbacks.** The runtime doesn't own tools; the host wires them. iOS wires `send_email` to `MFMailComposeViewController`, Android wires it to an Intent.
- **Inference goes through `ProtocolHandler`.** Adding a new model provider — including OS-provided ones — means implementing one trait.
- **Bundles are declarative.** Agents are pure data ([`docs/agent-bundle-spec.md`](./agent-bundle-spec.md)). They don't carry platform-specific code.

The binding surface (`car-ffi-uniffi`) is in tree as of v0.6.0 with iOS + Android slices both buildable. The platform-specific protocol handlers and host apps are partially scaffolded; per-milestone state is in the [phased delivery section](#phased-delivery).

---

## What the mobile OSes give us (and how much we can lean on)

### iOS

| Capability | Framework | Min OS | Notes |
|------------|-----------|--------|-------|
| **STT** | `SFSpeechRecognizer` | iOS 13 | On-device since iOS 13. Multilingual. Replaces `whisper-rs` on iOS. |
| **TTS** | `AVSpeechSynthesizer` | iOS 7 | Native voices. Decent quality. |
| **Audio I/O** | `AVAudioEngine` + `AVAudioSession` | iOS 8+ | Session model handles interruptions, Bluetooth, lock screen. |
| **On-device LLM** | Foundation Models framework | iOS 26 (public) | ~3B-class model. Apple Silicon (A17+) only. |
| **Wake word** | — | — | Not exposed. Bring your own (Porcupine, OpenWakeWord). |
| **Push** | APNs + UserNotifications | always | For "agent finished" notifications and local alerts. |
| **Background work** | BGTask, audio session | always | Severe limits — no long-running agents in background. |

### macOS — same Apple stack, mostly, and shipping first on its own merits

The same Apple frameworks that run on iOS also run on macOS, with one difference (no `AVAudioSession`; macOS uses Core Audio routing directly). **macOS Apple-frameworks integration shipped first on its own merits** in v0.5.2 — see the cookbook recipe [`docs/cookbook/12-macos-apple-frameworks.md`](./cookbook/12-macos-apple-frameworks.md) — not as a stepping stone to mobile. The macOS work delivered standalone value (free, on-device STT/TTS replacing whisper-rs/Kokoro on macOS; on-device LLM via Foundation Models) independent of iOS. iOS reuses those provider impls.

| Capability | Framework | Min OS |
|------------|-----------|--------|
| `SFSpeechRecognizer` | Speech | macOS 10.15 |
| `AVSpeechSynthesizer` | AVFoundation | macOS 10.14 |
| `AVAudioEngine` | AVFoundation | macOS 10.10 |
| Foundation Models framework | FoundationModels | macOS 26 (public), 15 (private) |

CAR already has macOS-specific code (`cidre`, `mlx-rs`, `whisper-rs` Metal feature, `coreaudio-sys`). Adding the Apple speech and Foundation Models surfaces on macOS extends the existing pattern.

### Android

| Capability | API | Min OS | Notes |
|------------|-----|--------|-------|
| **STT** | `SpeechRecognizer` | always | Quality varies by OEM. `EXTRA_PREFER_OFFLINE` for on-device. |
| **TTS** | `TextToSpeech` | always | Decent. Multiple voice packs. |
| **Audio I/O** | `AudioRecord`, `AudioTrack` | always | Lower-level than iOS but flexible. |
| **On-device LLM** | AICore (Gemini Nano) via ML Kit GenAI | Android 14+ | Pixel 8 Pro+, Galaxy S24+ only. ~3B model. |
| **Wake word** | — | — | Not exposed. Bring your own. |
| **Push** | FCM | always | For "agent finished" notifications. |
| **Background work** | WorkManager, foreground services | always | Doze/App Standby limit reliability. |

The Android story is messier than iOS: more OEM variation, more permission complexity, less consistent quality. But the protocol handler abstraction means all this lives behind the same trait.

### What this means for `car-inference`

Add two new `ProtocolHandler` impls in `car-rs/crates/car-inference/src/`:

| Handler | Targets | Bridge |
|---------|---------|--------|
| `AppleFoundationModelsHandler` | macOS 15+, iOS 26+ | Swift bridge via UniFFI; calls FoundationModels framework |
| `AICoreHandler` | Android 14+ on supported devices | Kotlin/JNI bridge; calls AICore APIs |

Both register with the model router. The router already prefers context-window headroom; teaching it to also prefer **"local, free, no network"** for cheap classification/embedding steps and **"cloud, expensive, capable"** for actual reasoning is a scoring-function change, not architecture.

The non-obvious win: **on-device STT + on-device classification = zero-roundtrip wake-to-intent**. Wake fires → STT runs locally → on-device model decides "is this for the agent" → only then does anything leave the device. That latency floor matters for whether voice agents feel alive.

---

## Binding surface: `car-ffi-uniffi`

A new FFI crate parallel to `car-ffi-napi` and `car-ffi-pyo3`. Uses [UniFFI](https://mozilla.github.io/uniffi-rs/) to generate Swift and Kotlin bindings from a single `.udl` definition. This is the same Rust workspace, same memgine, same engine — just a different shim.

```
car-rs/crates/car-ffi-uniffi/
├── src/
│   ├── lib.rs               # the surface (analogous to car-ffi-napi/src/lib.rs)
│   └── runtime.udl          # UniFFI interface definition
├── ios/                     # iOS XCFramework build script
└── android/                 # Android AAR build script
```

Per the project's hard rule on bindings parity ([CLAUDE.md §2](../CLAUDE.md)): every change to the FFI surface lands in *all* binding crates simultaneously, including `car-ffi-uniffi`. No "follow up later".

### Targets

| Platform | Triple | Toolchain |
|----------|--------|-----------|
| iOS device | `aarch64-apple-ios` | Xcode 15+ |
| iOS simulator (Apple Silicon) | `aarch64-apple-ios-sim` | Xcode 15+ |
| iOS simulator (Intel) | `x86_64-apple-ios` | Xcode 15+ |
| Android arm64 | `aarch64-linux-android` | NDK r26+ |
| Android armv7 | `armv7-linux-androideabi` | NDK r26+ |
| Android x86_64 (emulator) | `x86_64-linux-android` | NDK r26+ |

iOS ships as an `XCFramework` containing all three slices. Android ships as an `.aar` containing all three ABIs.

### What's excluded from the mobile build

- **`car-server`** — the WebSocket server doesn't run on-device; mobile uses CAR as an embedded library. (The server is still useful as a *backend* for the hybrid model below.)
- **`car-cli`** — the CLI binary itself isn't on-device; CLI features (publish, install, list) are reimplemented as host-app affordances.
- **`mlx-rs`** — already cfg-gated to macOS; iOS build excludes it.
- **`coreaudio-sys` (current usage)** — replaced on iOS by `AVAudioEngine` via the Swift bridge.
- **`whisper-rs`** — replaced on Apple platforms by `SFSpeechRecognizer`. Stays on Linux/Windows.

This needs cfg auditing during implementation; some of these may already work and just need to be verified.

---

## Host application

The bundle spec makes the agent portable; the **host app** makes a phone a secure control surface for Parslee Core. The host app is what users install from the App Store / Play Store; it advertises OS-provided capabilities, wires platform implementations such as voice and notifications, and provides UX (voice, chat, approvals, continuity, settings). Long-running agents and non-OS model runtimes do not execute on the phone in v1; Parslee Core reasoning and assistant work happen through Parslee or a user-owned connected computer running CAR.

### Architecture

```
┌─ Host App (iOS or Android) ─────────────────────────────────┐
│                                                              │
│  ┌── UI Layer ──────────────────────────────────────────┐   │
│  │  Typed turns, voice messages, foreground wake,       │   │
│  │  chat history, approvals, live controls,             │   │
│  │  notifications, settings, work-location chooser      │   │
│  └────────────────────────────┬─────────────────────────┘   │
│                               │                              │
│  ┌── Capability Wiring ───────┴─────────────────────────┐   │
│  │  email-send → MFMailComposeViewController / Intent   │   │
│  │  calendar-* → EventKit / CalendarContract            │   │
│  │  voice-tts  → AVSpeechSynthesizer / TextToSpeech     │   │
│  │  ...                                                  │   │
│  └────────────────────────────┬─────────────────────────┘   │
│                               │                              │
│  ┌── Remote Execution Link ──────────────────────────────┐  │
│  │  Parslee Core on Parslee or connected computers        │  │
│  │  agents.chat • approvals • device sync • notifications │  │
│  └────────────────────────────┬──────────────────────────┘  │
│                               │                              │
│  ┌── Inference Routing ───────┴──────────────────────────┐  │
│  │  OS-local providers │ Parslee Core work locations       │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Host responsibilities

1. **Advertise OS capabilities** to Parslee Core — speech, notifications, Shortcuts / intents, and explicitly granted personal-data surfaces.
2. **Wire tool callbacks** — each phone capability maps to a concrete platform implementation.
3. **Manage secrets** — API keys for cloud inference live in Keychain / Keystore, never in the bundle.
4. **Provide UX** — chat surface, voice messages, foreground wake while open, approvals, live controls, notifications, device continuity, and Parslee sign-in.
5. **Mediate remote execution** — long jobs continue through Parslee Core on Parslee or connected computers; the phone remains the user's live control and consent surface.

Apple hosts should treat Apple frameworks as first-class capability backends
when they match the requested capability. For example, `tools.notifications`
maps to `UserNotifications` inside the macOS / iOS host apps; it should not be
implemented by asking agents to run AppleScript. The same principle applies to
Speech, Vision, Contacts, EventKit, HealthKit, App Intents, and Shortcuts.

### Distribution model

A single first-party host app on each platform (Parslee) carries the consumer UX and OS capability bridge. Agent bundles are distributed via the CAR registry to Parslee or user-owned connected computers, not as executable mobile plug-ins. This keeps App Review focused on the signed host app and keeps mobile policy simple: bundles are pure data, and execution is remote unless the capability is an OS-provided local provider such as Apple Speech, Foundation Models, Android SpeechRecognizer, or AICore.

This is the same pattern that emoji keyboards, scripting apps (Pythonista, Scriptable), and PWA hosts already use successfully. Apple and Google permit it as long as the bundles are pure data and not arbitrary executable code — which CAR bundles are by design.

### What about hybrid (cloud-hosted runtime)?

For agents whose work clearly belongs on a server (long-running research, large memory graphs, multi-agent orchestration), the host app is a client to a `car-server` instance running in Parslee or on the user's home machine. WebSocket protocol already supports this. The agent bundle is the same; only the runtime location changes.

The product line-up in v1 looks like:

| Where the runtime runs | When it's the right answer |
|-------------------------|----------------------------|
| Parslee cloud runtime | Consumer default, long jobs, large memory, multi-agent flows |
| Connected computer running CAR | Personal data locality, desktop tools, developer workstations |
| OS-provided phone provider | Speech, voice playback, notifications, intents, and cheap classification when the OS exposes it |
| Backend service (`car-server`) | Scheduled agents and product integrations |

The same bundle can be targeted at Parslee or a connected computer; the phone contributes local OS capabilities without becoming a general-purpose agent runner.

---

## Voice as agent UX

Voice is the natural mobile interface for agents, and the OSes hand us most of the stack. The first-product voice loop:

1. **User taps the mic to record a voice message** or enables foreground listening while the app is open.
2. `SFSpeechRecognizer` / `SpeechRecognizer` transcribes on-device.
3. **Optional** local classification: is this for the agent, or background chatter? (Foundation Models / Gemini Nano cost: ~free.)
4. Transcript becomes a Parslee Core turn in the conversation; Parslee Core runs through Parslee or a connected computer.
5. Response streams back. `AVSpeechSynthesizer` / `TextToSpeech` speaks it.

CAR already has the streaming-transcription primitive (`transcribeStream` in `car-ffi-napi`, see `docs/proposals/streaming-transcription.md`). The mobile path adds OS-mediated implementations of the same surface.

### What we don't ship in v1

- **Background wake word.** Foreground wake works while the app is open; background listening remains out of v1.
- **Background voice.** OSes restrict it heavily and battery cost is real.
- **Custom voice models.** Use platform voices.

---

## App-store release planning

The mobile host apps are consumer products, so release readiness includes the
brochureware and review surfaces, not only compile artifacts. The store
metadata, screenshots, preview videos, privacy declarations, reviewer access,
and demo flows live in the [mobile app-store release playbook](./mobile-app-store-release.md).

## CI and release

The existing `.github/workflows/build.yml` builds 4 desktop targets (macOS arm64/x64, Linux x64, Windows x64). Mobile expansion adds:

| Target | Builder | Output |
|--------|---------|--------|
| iOS device | macOS-14 + Xcode 15 | `.xcframework` slice |
| iOS sim arm64 | macOS-14 + Xcode 15 | `.xcframework` slice |
| iOS sim x64 | macOS-14 + Xcode 15 | `.xcframework` slice |
| Android arm64 | ubuntu + NDK | `.aar` slice |
| Android armv7 | ubuntu + NDK | `.aar` slice |
| Android x86_64 | ubuntu + NDK | `.aar` slice |

Distribution:

- **iOS:** the `XCFramework` is published to a Swift Package Manager registry (or a private CocoaPods repo). Host-app developers add CAR as a Swift Package dependency.
- **Android:** the `.aar` is published to GitHub Packages (or Maven Central). Host-app developers add `implementation 'ai.parslee:car-runtime:X.Y.Z'`.
- **First-party host apps:** distributed via App Store / Play Store, on their own release cadence, pinned to a CAR runtime version.

---

## Phased delivery

This document focuses on the platform; the **agent-side phasing** (stateless → single-host → multi-host) is in [`docs/agent-portability-roadmap.md`](./agent-portability-roadmap.md). Platform milestones, in order:

### M1 — macOS Apple-frameworks integration (standalone) ✅ shipped (v0.5.2)

- New `SttProvider` / `Speaker` impls in `car-voice` backed by `SFSpeechRecognizer` and `AVSpeechSynthesizer`. New `AppleFoundationModelsHandler : ProtocolHandler` in `car-inference`.
- macOS users got free, on-device speech and inference; Linux/Windows unchanged.
- Independent value: shipped on its own merits, no other milestone required.
- Cookbook coverage: [`docs/cookbook/12-macos-apple-frameworks.md`](./cookbook/12-macos-apple-frameworks.md).

### M2 — `car-ffi-uniffi` crate ✅ landed (v0.6.0)

- New crate. Mirror the NAPI/PyO3 surface. UniFFI interface definition (`runtime.udl`). ✅
- Build XCFramework on macOS-14 CI. Validate it loads in a Swift test harness. ✅ — `apple/build-xcframework.sh` with all three slices (`aarch64-apple-darwin` + `aarch64-apple-ios` + `aarch64-apple-ios-sim`); `check-ios` CI job exercises both iOS slices on every PR.
- Build Android `.aar` on Linux CI. Validate it loads in an Android Studio test harness. 🟡 — `android/build-aar.sh` produces the per-ABI `.so` + Kotlin bindings; `check-android` CI validates arm64-v8a, armeabi-v7a, and x86_64 compile paths. Full Android Studio harness validation waits for the Kotlin host.
- Both as static libs only; no dynamic loading. ✅

### M3 — minimal iOS host app (TestFlight) 🟡 scaffolded

- Voice message loop using `SFSpeechRecognizer` + `AVSpeechSynthesizer`, plus foreground wake aliases while the app is open. ✅ — `apps/host-ios/Sources/CarHostApp/{PushToTalkView,SpeechManager}.swift`.
- Typed prompt fallback. ✅ — the `Ask Parslee Core` input sends through the same
  selected-agent path as voice, so simulator/noisy/permission-denied use cases
  still reach the flagship assistant.
- Parslee Core work-location selection. ✅ — `PushToTalkView` calls the selected
  Parslee Core work location's `agents.list`, defaults to Parslee Core, hides chooser mechanics
  when there is only one place to work, presents only chat-capable remote
  targets when alternatives exist, shows a compact trust disclosure derived from
  each target's declared capabilities / tools / permissions, and sends turns
  through `agents.chat`.
- Host device registration. ✅ — after the Parslee Core runtime connection is active, the iOS host
  calls `host.register_device` so the daemon can surface this phone as a linked
  consumer device with chat, approvals, notifications, typed ask, and
  voice capabilities. This is status/capability metadata first; sensor
  and personal-data invokes remain separate, policy-gated follow-ups.
- Verified assistant chat for chat-capable agents. ✅ — when the selected agent
  advertises `chat`, `PushToTalkView` uses `HostEventsClient` to call
  `goal.suggest`, send `agents.chat { goal }`, stream `agents.chat.event`, and
  surface `goal_evaluated` verifier feedback before speaking the answer. The
  app defaults to Parslee Core, keeps recent assistant activity visible, lets
  the user sign into Parslee for automatic Parslee Core discovery, preserves recent
  user / tool / assistant turns locally, and records completed turns through
  `sync.record_turn` so `sync.transcript` can restore a Parslee Core
  conversation across reconnects and linked devices. In-flight Parslee Core
  turns expose a
  native Stop control wired to `agents.chat.cancel`, show tool-use progress,
  and render inline chat approvals with Approve / Deny actions routed through
  `agents.chat.approve`.
  iOS lists chat-capable agents from the selected Parslee Core work location via
  `agents.list`; those agents execute remotely through Parslee, with connected
  computers treated as optional work locations for device-specific tasks. The iOS
  app no longer falls back to local `CarRuntime.runAgent`.
- Remote A2UI surfaces. ✅ — the iOS host subscribes to daemon
  `a2ui.event`, backfills `a2ui.surfaces`, renders populated surfaces with the
  shared SwiftUI A2UI renderer, and routes user actions back to the owning
  selected Parslee Core work location through `a2ui.action` instead of the local embedded bridge.
- Local OS capability disclosure. ✅ — the iOS surface separates "On this
  iPhone" OS-provided surfaces (Apple Speech, system voice, notifications,
  Shortcuts, Foundation Models when device-gated support is present) from
  Parslee account products and remote agent targets. Speech, microphone, and
  notification status are permission-aware without prompting on launch; iOS asks
  only when the app first records or first needs to deliver an alert.
- Mobile model policy. ✅ — OS-provided local frameworks/models are allowed
  (`SFSpeechRecognizer`, `AVSpeechSynthesizer`, Foundation Models when routed in
  M4, and Android system equivalents). Parslee Core reasoning, assistant work,
  and non-OS model runtimes do not execute on the phone; they execute remotely
  through Parslee or optional connected-computer work locations.
- TestFlight distribution. 🟡 — `apps/host-ios/README.md` documents the manual Xcode flow (open the SwiftPM package, add an iOS app target with signing, archive + upload). The actual TestFlight upload requires Apple Developer Program enrollment + signing material that aren't reproducible in CI.

### M4 — Foundation Models routing 🟡 in progress

- iOS host app routes classification/embedding to Foundation Models when available, falls back to remote Parslee models otherwise.
- Latency and battery measurement. Validate the "feels alive" claim.
- Note: the macOS path (M1) already does this via `AppleFoundationModelsHandler` + the `low_latency`+`private` tag bonus. M4 is wiring that same router preference into the iOS host once it's running on a real device.
- Status:
  - ✅ `car-inference/build.rs` compiles the FoundationModels Swift shim for `aarch64-apple-ios` (device) and `aarch64-apple-ios-sim` (simulator) in addition to `aarch64-apple-darwin`. `xcrun --sdk iphoneos|iphonesimulator swiftc` is invoked with the matching deployment target; the framework stays weak-linked so binaries still load on pre-26 OSes.
  - ✅ Swift shim's `@available` checks now cover `macOS 26.0, iOS 26.0, *`.
  - ✅ Registry availability + streaming-dispatch cfg-gates broadened to `any(macOS-aarch64, iOS-aarch64)`. The adaptive router automatically considers `apple/foundation:default` on iOS once the runtime probe (Apple Intelligence enabled, A17+) returns true; the `low_latency`+`private` tag bonus carries over from M1 with no router-side change.
  - ⏳ Runtime validation on real iOS 26 hardware (TestFlight build, latency / battery measurement) blocked by the same Apple Developer Program enrollment that gates M3's TestFlight upload.

### M5 — bundle install UX — not started

- Install agent bundles by URL or registry handle.
- Capability negotiation visible in UI ("This agent wants email-send. Allow?").
- Multiple remote agents. The iOS host already has the remote picker and a
  read-only per-agent trust disclosure; install/uninstall and explicit
  allow/deny capability negotiation are still pending.

### M6 — Android host app 🟡 scaffolded

- Same as iOS, on Android. AICore routing where supported.
- Play Internal Testing distribution.
- Status:
  - ✅ `car-rs/crates/car-ffi-uniffi/android/build-aar.sh` produces per-ABI `.so` + Kotlin bindings (M2 prereq for any Android consumer).
  - ✅ `apps/host-android/` now contains a real Kotlin + Jetpack Compose app scaffold with typed ask, voice input via Android `SpeechRecognizer`, `TextToSpeech` replies, browser-based Parslee OAuth sign-in, automatic Parslee Core discovery, a remote work-location picker, streamed `agents.chat`, cancellation, approvals, verifier display, remote A2UI interactive views, local OS capability disclosure, and fixture-mode visual smoke.
  - ✅ `apps/host-android/scripts/{prepare,check,run-emulator}.sh` provide the developer-machine flow to prepare UniFFI artifacts, assemble the debug APK, install it, launch it, and capture an emulator screenshot.
  - ✅ `apps/host-android/scripts/build-play-bundle.sh` produces a signed Play upload `.aab` for Internal Testing or production when the release owner provides the Play upload-key environment variables; unsigned bundles are limited to explicit local dry runs.
  - ✅ Runtime validation passed on the `ParsleeAndroid` emulator fixture with Parslee Core connected state, approvals, verifier display, and local OS capability disclosure visible.
  - ⏳ AICore / Gemini Nano routing is still pending.

### M7 — public release — not started

- App Store / Play Store. Pinned CAR runtime version.
- Public registry for bundles.

Each milestone is shippable on its own. M1 alone shipped real value to macOS users (free OS-integrated voice + on-device inference). M3's scaffold landed without blocking on M4 / M5. The roadmap doesn't depend on every milestone landing in order — M6 can ship before M5 is fully polished, etc.

---

## Open questions

1. **Registry hosting.** Start with GitHub Releases as the backing store, or stand up a hosted service from day one? Lean: GitHub Releases, swap later. The HTTP API in the bundle spec is a thin shim over either.
2. **Capability disclosure UX.** How aggressively do we surface "this agent uses your contacts"? Apple/Google permission models are precedent; we likely just inherit those for sensor capabilities and add our own scrim for tool capabilities.
3. **Cross-runtime version skew.** Bundle `car_min_version` handles forward-compat at install. What about an installed bundle when the runtime updates and breaks something? Need a re-validation step on runtime upgrade.
4. **Apple Foundation Models availability gating.** Pre-iOS 26 / pre-A17 devices won't have it. The router needs to handle "this device can't do OS-provided on-device inference" gracefully by falling back to remote Parslee models with clear consent and cost/data expectations.
5. **Background execution policy.** Both OSes restrict it. Do we declare CAR agents as "foreground-only" by default, with an opt-in "may run briefly in background" flag? Lean: yes.
