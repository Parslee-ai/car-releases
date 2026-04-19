# Common Agent Runtime — Binary Releases

Pre-built binaries, Python wheels, Node.js native modules, and examples for
**Common Agent Runtime (CAR)** — a deterministic execution layer for AI agents,
written in Rust.

Models propose. The runtime validates, verifies, and executes.

> **Source code** lives in a private repository. This repo is the public
> distribution channel: install instructions, examples, release artifacts,
> issue tracker for binary consumers.

## Install

### Python

```bash
pip install car-runtime
```

PyPI auto-resolves to the right wheel for your platform. Python 3.9+, abi3.
Import name is `car_native`.

<details>
<summary>Direct wheel download (if PyPI isn't available)</summary>

Pick the wheel for your platform from the [latest release](https://github.com/Parslee-ai/car-releases/releases/latest):

- `car_runtime-*-cp39-abi3-macosx_14_0_arm64.whl` — Apple Silicon (macOS 14+)
- `car_runtime-*-cp39-abi3-macosx_14_0_x86_64.whl` — Intel Mac (macOS 14+)
- `car_runtime-*-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl` — Linux x86_64
- `car_runtime-*-cp39-abi3-manylinux_2_28_aarch64.whl` — Linux aarch64

```bash
pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car_runtime-0.3.0-cp39-abi3-macosx_14_0_arm64.whl
```

</details>

### Node.js

```bash
npm install car-runtime
```

The install step auto-downloads the matching native binary for your platform.
Node 18+.

```typescript
import { CarRuntime } from 'car-runtime';
const rt = new CarRuntime();
rt.stateSet('project', JSON.stringify('my-agent'));
```

<details>
<summary>Tarball (no npm, just the CLI + native .node file)</summary>

Platform tarballs ship the CLI, server, and the Node.js `.node` binary:

```bash
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
./car --help
```

Tarball filenames are stable across versions — `/releases/latest/download/...`
always resolves to the newest.

</details>

### CLI + server

The CAR CLI (`car`), server (`car-server`), and evaluation bridge
(`car-memgine-eval`) ship as native binaries.

**Homebrew (macOS + Linux):**

```bash
brew install Parslee-ai/car/car
```

Tap source: https://github.com/Parslee-ai/homebrew-car

**Install script (macOS + Linux, no Homebrew):**

```bash
curl -fsSL https://raw.githubusercontent.com/Parslee-ai/car-releases/main/install.sh | sh
```

Installs to `~/.car/bin/` and prints the PATH snippet to add. Pin a version
with `CAR_VERSION=v0.3.0`, override the install dir with `CAR_INSTALL=...`.

**Manual tarball:**

```bash
# Apple Silicon
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-darwin-arm64.tar.gz | tar -xz
./car --help

# Linux x86_64
curl -sL https://github.com/Parslee-ai/car-releases/releases/latest/download/car-linux-x64-gnu.tar.gz | tar -xz
./car --help
```

Each tarball also contains the Node.js native module
(`car-runtime.{platform}.node`) for users who prefer not to use npm.

## Quickstart

See [`examples/`](./examples/):

- [`examples/python/hello_car.py`](./examples/python/hello_car.py) — state, facts, verify, execute
- [`examples/node/hello-car.js`](./examples/node/hello-car.js) — same idea in JS
- [`examples/python/inference.py`](./examples/python/inference.py) — local inference + streaming

## What's in the box

A deterministic DAG executor with built-in:

- **State** — typed key/value store with snapshotting
- **Memory** — graph-based (`car-memgine`) with spreading activation, 4-layer context assembly, and skill learning
- **Tools** — callback-based execution (the runtime doesn't own tools; you wire them up)
- **Policies** — Rust-enforced on every action (`deny_tool`, `deny_tool_param`, `require_state`)
- **Verification** — prove plan properties (`verify`, `simulate`, `equivalent`, `optimize`) before executing
- **Local inference** — Candle + MLX backends for Qwen3, Gemma, Flux, LTX, Parakeet, Whisper, Kokoro
- **Multi-agent coordination** — swarm, pipeline, supervisor, map-reduce, vote patterns
- **Scheduler** — background task execution with triggers and schedules

## Platforms

| Platform | Binaries | Python wheel |
|----------|----------|--------------|
| macOS ARM64 (14+) | `car-darwin-arm64.tar.gz` | `macosx_14_0_arm64` |
| macOS x86_64 (14+) | `car-darwin-x64.tar.gz` | `macosx_14_0_x86_64` |
| Linux x86_64 | `car-linux-x64-gnu.tar.gz` | `manylinux_2_17_x86_64` |
| Linux aarch64 | `car-linux-arm64-gnu.tar.gz` | `manylinux_2_28_aarch64` |

Windows is not currently supported. When Windows builds land, distribution
via [Winget](https://github.com/microsoft/winget-pkgs) and
[Scoop](https://scoop.sh) will follow.

## Versioning

CAR is pre-1.0. Breaking changes between minor versions are possible — pin to
exact versions until the API stabilizes. Each release lists breaking changes
in the GitHub release notes.

## Issues

Report binary-side problems (install, crashes, platform support, docs) on
this repo's issue tracker. Source-related issues stay with the maintainers.

## License

Two licenses, depending on what you're using — see [LICENSE](./LICENSE) for the
authoritative text.

- **Binaries** (tarballs, wheels, `.node` modules, CLI) — free for any use
  including commercial, free to redistribute unmodified. Modification, reverse
  engineering, and derivative works are not permitted. Copyright © 2026
  Parslee AI. Source is not published under an open license.
- **Repository contents** (README, examples, install scripts, workflows) —
  Apache-2.0. Copy, modify, and reuse freely.

If you need terms beyond those — source access, modification rights, a
commercial redistribution agreement — contact Parslee AI.
