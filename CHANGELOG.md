# Changelog

All notable changes are documented in the [GitHub Releases](https://github.com/Parslee-ai/car-releases/releases) for this repo.
This file is a chronological index linking to each release's full notes.

## [v0.15.0] — 2026-05-16
Fixed: CarHost sign-in showed a cryptic error against a stale daemon (#217); Fixed: Codex/Gemini chat replies never reached the host in streaming mode (#213); Fixed: ad-hoc-signed macOS host bundle crashed at launch on Sparkle load (#212);… See the [release notes][v0.15.0].

## [v0.14.0] — 2026-05-15
Fixed: car-server FD leak on WS peer disconnect → EMFILE (car#209); Fixed: stale approvals never reaped on agent disconnect (car-releases#48); Fixed: host.mail_send silently sent from the wrong account (car-releases#47); Added: car-auth cr… See the [release notes][v0.14.0].

## [v0.13.0] — 2026-05-15
`host.resolve_approval` fans out to the owning session (cross-session approval UIs no longer error) + `release.sh` auto-publishes the Sparkle appcast entry. See the [release notes][v0.13.0].

## [v0.12.0] — 2026-05-14
**Portable release path via Azure Key Vault** — any authorized operator can cut a release, not just the cert-owner's machine. `car-runtime` umbrella crate (#205), menubar badge, CI hardening. See the [release notes][v0.12.0].

## [v0.11.1] — 2026-05-13
A2UI Text renders Markdown. See the [release notes][v0.11.1].

## [v0.11.0] — 2026-05-13
agent-chat protocol, Chat tab, External streaming, Settings IA. See the [release notes][v0.11.0].

## [v0.10.1] — 2026-05-12
CAR Host.app via Homebrew Cask. See the [release notes][v0.10.1].

## [v0.10.0] — 2026-05-12
observe-only fallback (#44), dashboard productionization, AudioRefVideo. See the [release notes][v0.10.0].

## [v0.9.0] — 2026-05-12
multi-tenant scoping (car#187 phase 3), daemon-routed inference + reasoning, contributed agents GA, Homebrew tap automation. See the [release notes][v0.9.0].

## [v0.8.2] — 2026-05-11
macOS npm hotfix (continued). See the [release notes][v0.8.2].

## [v0.8.1] — 2026-05-11
macOS npm hotfix. See the [release notes][v0.8.1].

## [v0.8.0] — 2026-05-10
daemon-only FFI, macOS host overhaul, external-agent orchestration, MCP server foundation. See the [release notes][v0.8.0].

## [v0.7.0] — 2026-05-09
**Voice sidecar shipped end-to-end, mobile platform scaffolds, FFI parity story complete.** Two-track voice dispatch (fast LLM streams audio while sidecar runs the substantive turn in parallel) with `IntentHint::prefer_fast`, classifier, telemetry, and `DirectDataFetcher` fast-data bypass. Per-session policy scoping. Host-registered inference runner for delegated wire formats (Anthropic / OpenAI / Vercel AI SDK). ElevenLabs Realtime STT streaming. iOS host scaffold + Android AAR build chain. crates.io publishing of 36 library crates. See the [release notes][v0.7.0].

## [v0.6.1] — 2026-05-07
Daemon contract follow-ups (#139 fu1+fu2+fu3) + ElevenLabs secrets (#140) + debug rpath (#150). See the [release notes][v0.6.1].

## [v0.6.0] — 2026-05-07
Apple-frameworks expansion + daemon-mode FFI hardening + browser/voice fixes. See the [release notes][v0.6.0].

## [v0.5.2] — 2026-05-07
Notes only — no binaries published. Use [v0.5.1] or [the latest release](https://github.com/Parslee-ai/car-releases/releases/latest).

## [v0.5.1] — 2026-05-01
`car-server-core` library extraction; WS session leak fix; AST ignore handling. See the [release notes][v0.5.1].

## [v0.4.9] — 2026-04-25
Release pipeline fix — darwin `.node` upload + mirror assets, bumped timeout. See the [release notes][v0.4.9].

## [v0.4.8] — 2026-04-24
Speaker enrollment + diarization API; Anthropic `message_start` / `message_delta` usage parsing; FFI streaming `Usage` events. See the [release notes][v0.4.8].

## [v0.4.7] — 2026-04-21
Bumped `MACOSX_DEPLOYMENT_TARGET` to 15.0 so the wheel tag matches what it actually requires. See the [release notes][v0.4.7].

## [v0.4.6] — 2026-04-21
**Renamed Python import `car_native` → `car_runtime` to match package name.** See the [release notes][v0.4.6].

## [v0.4.5] — 2026-04-21
`publish-pypi` pulls wheels from the GitHub release, not CI artifacts. See the [release notes][v0.4.5].

## [v0.4.4] — 2026-04-21
npm `install.js` exits non-zero on download failure; release preflight + auto-mirror to `car-releases`. See the [release notes][v0.4.4].

## [CAR v0.4.0] — 2026-04-20
**OS Integration Foundations.** `car-secrets` (cross-platform OS keyring — macOS Keychain, Windows Credential Manager, Linux Secret Service), broader installer surface, Windows binary parity. See the [release notes][v0.4.0].

## [v0.3.2] — 2026-04-20
**Browser automation on the release contract** — reachable from CLI (`car browse run`), Python / Node bindings, and the WebSocket method, all backed by one implementation. See the [release notes][v0.3.2].

## [v0.3.1] — 2026-04-19
Windows x64 binaries and wheel; `car`, `car-server`, `car-memgine-eval` ship as `.exe` in `car-win32-x64-msvc.zip`; `win_amd64` wheel; CI Windows compile-check on every push. See the [release notes][v0.3.1].

## [v0.3.0] — 2026-04-19
First public release. Full Python / Node.js binding parity, macOS + Linux binaries and wheels. See the [release notes][v0.3.0].

[v0.15.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.15.0
[v0.14.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.14.0
[v0.13.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.13.0
[v0.12.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.12.0
[v0.11.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.11.1
[v0.11.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.11.0
[v0.10.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.10.1
[v0.10.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.10.0
[v0.9.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.9.0
[v0.8.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.8.2
[v0.8.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.8.1
[v0.8.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.8.0
[v0.7.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.7.0
[v0.6.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.6.1
[v0.6.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.6.0
[v0.5.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.5.2
[v0.5.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.5.1
[v0.4.9]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.9
[v0.4.8]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.8
[v0.4.7]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.7
[v0.4.6]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.6
[v0.4.5]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.5
[v0.4.4]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.4
[v0.4.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.0
[v0.3.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.3.2
[v0.3.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.3.1
[v0.3.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.3.0
