# Contributed agents

Third parties ship agents to CAR by packaging a **manifest** plus
a binary (or, for pure-data bundles, a directory of declarative
files). The runtime adopts the agent without recompiling
`car-server` — the manifest is the entire integration surface.

This doc is the end-user walkthrough. Reference:

- [`docs/proposals/contributed-agents.md`](proposals/contributed-agents.md) — design proposal
- [`docs/agent-bundle-spec.md`](agent-bundle-spec.md) — bundle format + canonicalization
- [`car-rs/crates/car-bundle/src/lib.rs`](../car-rs/crates/car-bundle/src/lib.rs) — schema source of truth
- [`car-rs/examples/contrib-template/`](../car-rs/examples/contrib-template/) — worked example

## The three things a contributed agent ships

1. **`manifest.toml`** — identity, transport, capabilities,
   `car_min_version`. The runtime reads this.
2. **A binary or bundle** — for `external_process` transports,
   the actual executable. For `pure_data`, an
   `identity.md` + `skills.jsonl` + `policies.json` tree.
3. **(optional) An ed25519 signature** — proves who signed the
   manifest. Required for registry distribution; unsigned
   local-install works for development with a warning.

## Quickstart — local install from a directory

```bash
# 1. Make sure car-server is running.
car daemon --port 9100   # in a separate shell

# 2. cd into your agent's source dir (must contain manifest.toml).
cd ~/projects/my-cool-agent

# 3. Install. The CLI parses manifest.toml, runs install-time
#    validation against the daemon, and adopts the agent on
#    success. Adopted external-process agents run immediately when
#    `[transport] auto_start = true`; otherwise start them manually.
car install .

# 4. Verify.
car ls
car inspect my-cool-agent

# 5. Run.
car start my-cool-agent
```

For a fully worked example (1 manifest + 1 trivial shell script),
see [`car-rs/examples/contrib-template/`](../car-rs/examples/contrib-template/).

## Anatomy of `manifest.toml`

```toml
[agent]
id = "my-cool-agent"            # supervisor-local handle, filename-safe
name = "My Cool Agent"
namespace = "yourname"          # publisher namespace; "yourname/my-cool-agent"
version = "0.1.0"               # semver
description = "What this agent does, in one line."
license = "Apache-2.0"
# homepage = "https://github.com/yourname/my-cool-agent"

[publisher]
# Added by signing. Omit for local-install during development.
# key_id = "<base64 ed25519 public key>"
# signature = "<base64 ed25519 signature over canonicalized manifest>"

[runtime]
car_min_version = "0.8.0"        # bare semver = ">=" or use cargo-style ranges
bundle_format_version = 1

[lifecycle]
stateful = false                 # does the agent accumulate memory between runs?
persistence = "session"          # session | host | synced (see portability roadmap)
default_inference_complexity = "low"

[transport]
kind = "external_process"        # pure_data | external_process
command = "/usr/local/bin/my-cool-agent"  # absolute path; freezes at install
sha256 = "<hex digest>"          # required when distributing binaries
# interpreter = "node"           # OR a bare interpreter name (node/python3/deno/…)
#                                # resolved against the consumer's $PATH at install.
#                                # Mutually exclusive with `command`. Use this for
#                                # portable manifests where the publisher can't know
#                                # the consumer's absolute interpreter path.
# binary_url = "https://github.com/yourname/my-cool-agent/releases/download/v0.1.0/my-cool-agent-darwin-arm64"
# OR
# health_url = "https://my-cool-agent.example.com/.well-known/a2a/agent.json"
args = ["--mode", "production"]
cwd = "/opt/my-cool-agent"       # optional working dir for the spawned child
env = { RUST_LOG = "info" }
restart = "on_failure"           # never | on_failure | always
max_restarts = 10
backoff_secs = 5
auto_start = false               # spawn immediately on install and on car-server boot?

[capabilities.required]
# Capabilities your agent CANNOT run without. Install fails if
# the host doesn't advertise all of these. Vocabulary:
#   inference: text-generation, embedding, classification, tool-use
#   storage:   persistent-kv, persistent-journal, persistent-graph, temporary
#   a2ui:      render_report.subscribe, render_report.emit,
#              patch_components.emit, surface_subscribe
#   a2a:       message_send, task_subscribe
#   tools:     email-send, calendar-read, filesystem-read, …
#              (full list in docs/agent-bundle-spec.md)
inference = ["text-generation"]
storage = ["persistent-kv"]

[capabilities.optional]
# Used when available, agent degrades gracefully otherwise.
# Missing optionals are reported in the install output so users
# see which features won't work.
a2ui = ["render_report.subscribe"]
a2a = ["message_send"]

[capabilities.denied]
# Capabilities you'll NEVER use. CAR's policy engine enforces
# this — even if a tool slipped into your code, the runtime
# blocks the call.
tools = ["shell-exec", "filesystem-write"]
network = ["arbitrary-http"]
```

## Transport kinds

### `external_process` — the common case

A long-running supervised child process. The supervisor spawns
your binary, restarts on failure (per `restart` + `max_restarts`),
captures stdout/stderr to `~/.car/logs/<id>.{stdout,stderr}.log`,
and injects two env vars the child uses to attach back to the
daemon:

- `CAR_DAEMON_URL` — the daemon's WS URL.
- `CAR_AGENT_TOKEN` — per-agent token minted at install; the
  child calls `session.auth { agent_id, token }` to bind the
  WS connection (#169).

For CAR's current manifest parser, set `kind = "external_process"`
and place external process fields directly in `[transport]`.

Four sub-shapes:

1. **Local binary + sha256** — `command` points at an absolute
   path on the install host; `sha256` is the expected digest.
   `car install` verifies the file in place. Use when you're
   shipping a binary the user already has on disk.
2. **Binary URL + sha256** — `binary_url` is an `https://` URL
   the publisher hosts. `car install` fetches, verifies the
   digest, writes the binary under
   `~/.car/agents/<id>/bin/<basename>`, chmods +x on POSIX, and
   rewrites `command` to the local path. Use when distributing
   through GitHub Releases or similar.
3. **Interpreter on PATH** — set `interpreter` (a bare program
   name like `"node"`, `"python3"`, `"deno"`) instead of
   `command`. At install the daemon resolves the name against the
   consumer's `$PATH` to an absolute path, runs it through the same
   `validate_command` gate a bare `command` passes (so a
   PATH-injection or `/tmp`-parked interpreter is still rejected),
   and uses the resolved path as the spawn command. Use this for
   **portable** manifests: a registry publisher can't know whether
   the consumer's `node` lives under nvm, fnm, Homebrew, or Volta,
   so `interpreter = "node"` + `args = ["agent.js"]` ships once and
   resolves per-machine. `interpreter` and `command` are mutually
   exclusive — set exactly one. A bare `command` still requires an
   absolute path; `interpreter` is the only opt-in to PATH lookup.
4. **Remote service** — set `health_url` instead of `command`.
   The supervisor doesn't spawn anything; it just tracks the
   manifest and periodically pings the URL. The operator owns
   the service's lifecycle. (Health probe lands when
   `/.well-known/a2a/agent.json` ships in `car-a2a`.)

### `pure_data` — declarative agents

No code. A directory of `identity.md` + `skills.jsonl` +
`policies.json` + `facts-seed.jsonl` that the runtime loads into
the agent's memgine slice. The bundle spec defines the layout in
detail.

Phase 1's supervisor writes pure-data manifests to disk but
doesn't load them into the runtime — that integration lands in a
later phase alongside full pure-data bundle support.

## What happens during `car install`

1. CLI reads `manifest.toml`, parses via `car_bundle::AgentManifest::from_toml_str`.
2. For `external_process`:
   - If `binary_url` is set, fetch via reqwest, verify
     `sha256`, write locally, rewrite `command`.
   - If only `sha256` is set, verify the file at `command`
     in place.
   - If `interpreter` is set (and `command` is not), the daemon
     resolves the bare name against `$PATH` to an absolute path
     at adoption time (`to_agent_spec` → `resolve_interpreter`)
     and spawns that. No binary fetch or digest applies.
   - If neither is set, warn about unverified install.
3. CLI sends the (possibly modified) manifest to the daemon as
   `agents.install`.
4. Daemon runs `install_check`:
   - `runtime.car_min_version` against the daemon's own semver.
   - Every `capabilities.required[ns][feat]` against the host
     advertisement. Missing any → install fails.
   - `capabilities.optional` misses are collected for the
     install report.
5. Daemon adopts the agent: writes
   `~/.car/agents/<id>/manifest.toml`, mirrors the entry into
   the legacy `agents.json` (dual-write during the phase 1
   migration window), mints a per-agent token if absent.
6. Returns `{report, agent}` to the CLI.

The agent is now installed. With `auto_start = true`, spawnable
external-process agents are started immediately and will also spawn
on future car-server boots. With `auto_start = false`, operators run
`car start <id>` when they want the agent running.

## Signing (for registry distribution)

The proposal calls for ed25519-signed manifests when distributing
through a registry. Phase 2 shipped the primitives in
`car_bundle`:

```rust
use car_bundle::{AgentManifest, sign_manifest, verify_signature};
use ed25519_dalek::SigningKey;
use rand_core::OsRng;

// Generate a publisher key (do this once, keep the secret).
let key = SigningKey::generate(&mut OsRng);

// Sign your manifest in place.
let text = std::fs::read_to_string("manifest.toml")?;
let mut manifest = AgentManifest::from_toml_str(&text)?;
sign_manifest(&mut manifest, &key)?;

// Write the signed manifest back.
std::fs::write("manifest.toml", manifest.to_toml_string()?)?;

// Anyone can verify with the publisher's public key (carried in
// `manifest.publisher.key_id`):
verify_signature(&manifest)?;
```

A `car publish` CLI command that wraps this is the next slice of
work; for now `cargo run --example sign-manifest` or a
hand-rolled script does the job.

**What the signature covers + doesn't:**

- Covers: `[agent]`, `[runtime]`, `[lifecycle]`, `[transport]`
  (including `command` + `sha256` + `binary_url`),
  `[capabilities]`. The publisher's claim about WHO ships the
  agent + WHICH binary is the authentic one.
- Does not cover: the bytes running behind a `health_url`
  (operator trust, not publisher trust). The behavior of any
  verified executable code (capability + policy enforcement
  bound blast radius, not the signature).

## Capability vocabulary

The full vocabulary lives in
[`docs/agent-bundle-spec.md`](agent-bundle-spec.md#capability-vocabulary-v1).
Highlights:

| Namespace | Examples |
|---|---|
| `inference.*` | `text-generation`, `embedding`, `classification`, `tool-use` |
| `storage.*` | `persistent-kv`, `persistent-journal`, `persistent-graph` |
| `a2ui.*` | `render_report.subscribe`, `patch_components.emit`, `surface_subscribe` |
| `a2a.*` | `message_send`, `task_subscribe` |
| `tools.*` | `email-send`, `calendar-read`, `filesystem-read`, `browser`, `voice-tts`, … |
| `network.*` | `arbitrary-http`, `host-api`, `none` |
| `sensors.*` | `accelerometer`, `microphone`, `health` |

New capabilities are additive within `bundle_format_version = 1`.
Don't repurpose existing names; ask in the proposal thread if a
new one is needed.

## CLI surface

| Command | Effect |
|---|---|
| `car install <path>` | Install the manifest at `<path>/manifest.toml`. Local-install path; registry refs land in a later phase. |
| `car ls` (alias `agents`) | List every installed agent (id / status / pid / command). `--json` for tooling. |
| `car inspect <id>` | Show one agent's manifest + runtime status. `--json` supported. |
| `car start <id>` | Start an installed spawnable agent. |
| `car stop <id>` | Stop a running installed agent. |
| `car restart <id>` | Stop then start an installed agent. |
| `car tail-log <id>` (alias `logs`) | Show the last N (`-n`, default 100) stdout/stderr lines captured from a supervised agent. `--json` emits `{ "lines": [...] }`. |
| `car uninstall <id>` | Stop, remove from supervisor, reap manifest dir. Idempotent. |

The supervisor's existing CRUD methods (`agents.list`, `agents.start`,
`agents.stop`, `agents.restart`, `agents.tail_log`) all work on
installed contributed agents the same way they work on
legacy-supervised entries.

## The registry — `Parslee-ai/car-agent-registry`

Contributed agents are cataloged in a dedicated repo,
`Parslee-ai/car-agent-registry`
(private). It holds one directory per agent under
`agents/<namespace>/<id>/` (a `manifest.toml` + `README.md`), an
`index.json` catalog that pins each manifest's path and `sha256`
digest, and `schema/index.schema.json` (the catalog's JSON Schema,
generated from the `car` binary so it stays the single source of
truth). The repo README renders the catalog as a human-browsable
table; `CONTRIBUTING.md` is the cold-start guide.

The `car registry` subcommand is the tooling layer:

```bash
# Print the canonical SHA-256 of a manifest (the value an index row pins).
car registry digest agents/parslee/<id>/manifest.toml

# Validate a registry directory — the exact gate CI runs on every PR.
# Checks index.json against the schema, that each row's sha256 matches
# its manifest, that row id == manifest [agent].id == dir name, and for
# audience:public rows the signature + absence of internal-infra strings
# (/Users/ paths, internal *.parslee.ai hosts, localhost, private IPs,
# file:// URLs) + no baked-in transport.token.
car registry validate .

# Regenerate the registry's schema copy from this binary.
car registry schema > schema/index.schema.json
```

### Contribute by PR

To add an agent: copy `agents/parslee/contrib-template/` to
`agents/parslee/<your-agent-name>/`, edit `manifest.toml` (set
`[agent].id` to match the directory name, choose `audience`), compute
the digest with `car registry digest`, add the `index.json` row and the
README catalog row, run `car registry validate .` until it prints
`validated N agents, all checks passed`, and open a PR. The full
step-by-step lives in the registry's
its `CONTRIBUTING.md`.
A `car publish` command (signs + writes the row + opens the PR in one
step) is the intended primary flow and ships in a later phase.

## What's NOT shipped yet

- **`car publish` CLI** that signs + uploads in one step.
- **Registry refs** — `car install <namespace>/<name>` resolution
  against the hosted `car-agent-registry`.
  The catalog (`index.json` + signed/digest-pinned manifests) exists
  now; the CLI-side resolution that fetches a row by `<namespace>/<name>`
  is the remaining piece. Today the manifest URL goes in `binary_url`
  directly, or you point `command` at a local file.
- **Pure-data bundle loading** into the memgine. The manifest
  format supports it; the loader is a separate phase per the
  portability roadmap.
- **`http_service` as a distinct transport kind.** Folded into
  `external_process` with `health_url` for v1. Will graduate to
  its own kind when `/.well-known/a2a/agent.json` ships in
  `car-a2a` and a real consumer wants the seam.

The proposal at
[`docs/proposals/contributed-agents.md`](proposals/contributed-agents.md)
covers the full scope. This doc tracks what shipped.
