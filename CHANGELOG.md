# Changelog

All notable changes are documented in the [GitHub Releases](https://github.com/Parslee-ai/car-releases/releases) for this repo.
This file is a chronological index linking to each release's full notes.

## [v0.31.0] — 2026-06-25
Added: car purge — clean removal of a CAR install's own state; Added: car doctor — offline install diagnosis + repair; Added: self-healing model load — a corrupt cache re-pulls and retries instead of failing; Fixed: presence-only HuggingFa… See the [release notes][v0.31.0].

## [v0.30.0] — 2026-06-24
Removed: judged task_33 (probability) — no local-tier signal (#421); Changed: judged track — better local-tier discriminators (#405); Changed: judged track no longer lets a contestant grade itself (#405); Fixed: gpt-5.5 rejected every call… See the [release notes][v0.30.0].

## [v0.29.0] — 2026-06-23
Changed: router seed ships local-model PERF, not quality (benchmark doesn't discriminate yet); Fixed: benchmark contribution flow — MoE discovery + a per-row perf trust gate; Added: CAR supervises the vllm-mlx server — multimodal models "j… See the [release notes][v0.29.0].

## [v0.28.0] — 2026-06-20
Added: secret.list / secretList — enumerate stored secret names for a CarHost Secrets pane (#366); Added: router quality follow-ups — frontier-less guard, above-frontier telemetry, shadow calibration (#369, #370, #371); Changed: benchmark … See the [release notes][v0.28.0].

## [v0.27.0] — 2026-06-18
Added: agent-chat surface — converse with create-car-agent agents (car#364, car#365); Added: local (in-process) tool-calling for Qwen3, plus honest tool-capability routing; Docs: clarify conversation persistence after the 0.25 store remova… See the [release notes][v0.27.0].

## [v0.26.0] — 2026-06-17
Changed (breaking for external Rust consumers of car-inference); Added: stakes-aware routing for the in-process autonomous loops; Added: stakes-aware routing for the coder loop; Added: persistent outcome scoreboard (outcomes.scoreboard — t… See the [release notes][v0.26.0].

## [v0.25.0] — 2026-06-15
Fixed: model-path follow-ups (streaming telemetry, sampler, stop sequences, etc.); Added: car run-task completion-discipline mode (experimental, opt-in); Fixed: MCP tool errors (isError: true) were silently surfaced as success; Fixed: Pars… See the [release notes][v0.25.0].

## [v0.24.1] — 2026-06-14
Fixed: CUDA-built Linux artifacts now load on machines without CUDA installed; Fixed: McpSubstrate spoke a wire protocol no bridge implements — every VM op failed; Fixed: car run-task sent dot-named inference tools to the model, 400ing Ant… See the [release notes][v0.24.1].

## [v0.24.0] — 2026-06-14
Fixed: resumed releases no longer break Sparkle signatures (publish-appcast-entry.sh) — closes #272; Security: Windows auth-token encrypted at rest with DPAPI (#295); A2UI Image accepts inline data: URIs (car-releases#57); Fixed: tool-call… See the [release notes][v0.24.0].

## [v0.23.0] — 2026-06-06
Added: proactive model concierge (car-inference, car-server, CarHost); Fix: Apple Silicon detected as CPU, hiding MLX models from the recommender (car-inference). See the [release notes][v0.23.0].

## [v0.22.1] — 2026-06-05
Fix: CarHost Runs tab no longer renders a blank "Run trace" pane (CarHost). See the [release notes][v0.22.1].

## [v0.22.0] — 2026-06-05
Added; Fixed. See the [release notes][v0.22.0].

## [v0.21.0] — 2026-06-04
Calendar event mutations across the integration surface; A2UI: standard components CAR's catalog lacked — Icon, Video, AudioPlayer, DateTimeInput; Web renderer: CAR-only components rendered (A2UI component-set extend); A2UI v0.9 form-input… See the [release notes][v0.21.0].

## [v0.20.0] — 2026-05-30
First-class model UX — intent → recommend → keep current. See the [release notes][v0.20.0].

## [v0.19.0] — 2026-05-29
Fix: Windows platform findings from issue #231 (car-registry, car-inference, car-ffi-common, car-cli); Added: car tail-log <id> (alias car logs) (car-cli) — #231 §5.2. See the [release notes][v0.19.0].

## [v0.18.0] — 2026-05-26
Fix: MLX backends fail cleanly when mlx.metallib is missing instead of aborting (car-inference); Fix: Host.app Chat tab renders the done.text reply from supervised agents (CarHost); Fix: verify now validates tool_call parameters against re… See the [release notes][v0.18.0].

## [v0.17.0] — 2026-05-24
Note: car video LTX-2 multi-issue (Parslee-ai/car-releases#53); Add: images parameter on infer_tracked (NAPI + PyO3); Diagnostic: log dropped agent.chat.event forwards; Fix: CarHost dashboard window stays open when clicking away; CarHost: … See the [release notes][v0.17.0].

## [v0.16.1] — 2026-05-23
Fix: prepareDiarizer / prepareParakeet now reach the daemon; Fix: CAR Host menubar Settings… opens Settings even when Dashboard is closed; Fix: macOS Keychain no longer prompts on every CAR rebuild; Fix: First-launch onboarding now gates o… See the [release notes][v0.16.1].

## [v0.16.0] — 2026-05-18
Added: CarHost approval rows now show what an agent is asking to do; Fixed: MLX Device::gpu() aborted with "Failed to load the default metallib"; Removed: Homebrew distribution path for macOS (use the .pkg + Sparkle instead); Fixed: launch… See the [release notes][v0.16.0].

## [v0.15.2] — 2026-05-17
Fixed: car-browser leaked headless Chrome subprocesses on shutdown and on panic; Fixed: task=code didn't prioritise quality over speed/cost in routing (car-releases#52); Fixed: CarHost Chat tab rendered nothing for supervised agents (#222)… See the [release notes][v0.15.2].

## [v0.15.1] — 2026-05-17
Fixed: car start | stop | restart missing for contributed agents (#221); Fixed: car ls and car inspect mis-handled the flat agents.list response shape (#219, #220); Fixed: contributed-agent install rejected the stock template (#218); Fixed… See the [release notes][v0.15.1].

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

[v0.31.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.31.0
[v0.30.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.30.0
[v0.29.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.29.0
[v0.28.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.28.0
[v0.27.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.27.0
[v0.26.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.26.0
[v0.25.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.25.0
[v0.24.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.24.1
[v0.24.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.24.0
[v0.23.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.23.0
[v0.22.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.22.1
[v0.22.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.22.0
[v0.21.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.21.0
[v0.20.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.20.0
[v0.19.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.19.0
[v0.18.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.18.0
[v0.17.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.17.0
[v0.16.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.16.1
[v0.16.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.16.0
[v0.15.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.15.2
[v0.15.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.15.1
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
