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

Download a wheel from the [latest release](https://github.com/Parslee-ai/car-releases/releases/latest):

```bash
# Apple Silicon
pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car_runtime-0.3.0-cp39-abi3-macosx_14_0_arm64.whl

# Intel Mac
pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car_runtime-0.3.0-cp39-abi3-macosx_14_0_x86_64.whl

# Linux x86_64
pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car_runtime-0.3.0-cp39-abi3-manylinux_2_17_x86_64.manylinux2014_x86_64.whl

# Linux aarch64
pip install https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car_runtime-0.3.0-cp39-abi3-manylinux_2_28_aarch64.whl
```

Python 3.9+, single wheel per platform (abi3). The import name is `car_native`.

### Node.js

Native modules are bundled in the platform tarballs below. `npm` package
publishing on a public registry is planned — for now, extract and load manually:

```bash
# Pick the tarball for your platform (see Binary tarballs below).
tar -xzf car-darwin-arm64.tar.gz
# The NAPI module is at: ./car-runtime.darwin-arm64.node
```

```javascript
const native = require('./car-runtime.darwin-arm64.node');
const rt = new native.CarRuntime();
rt.stateSet('project', JSON.stringify('my-agent'));
```

### CLI + server

Each platform tarball includes:

- `car` — the CLI
- `car-server` — WebSocket server exposing the runtime over JSON-RPC
- `car-memgine-eval` — StateBench evaluation bridge
- `car-runtime.{platform}.node` — Node.js native module

```bash
# Apple Silicon
curl -sL https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car-darwin-arm64.tar.gz | tar -xz
./car --help

# Linux x86_64
curl -sL https://github.com/Parslee-ai/car-releases/releases/download/v0.3.0/car-linux-x64-gnu.tar.gz | tar -xz
./car --help
```

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

Windows is not currently supported.

## Versioning

CAR is pre-1.0. Breaking changes between minor versions are possible — pin to
exact versions until the API stabilizes. Each release lists breaking changes
in the GitHub release notes.

## Issues

Report binary-side problems (install, crashes, platform support, docs) on
this repo's issue tracker. Source-related issues stay with the maintainers.

## License

Apache-2.0
