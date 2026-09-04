# Agent Bundle Specification

> **Status:** draft. Not yet implemented. This document describes the target shape; tracking implementation in [`docs/agent-portability-roadmap.md`](./agent-portability-roadmap.md).

An **agent bundle** is the unit of distribution for a CAR agent. It is a signed, versioned, host-agnostic archive that any CAR runtime — desktop, mobile, or cloud — can install and execute. Bundles are the "write once, run anywhere" surface for agents.

The agent author writes against **capabilities**, not platforms. The host advertises what it provides. The runtime negotiates: the bundle runs only if the host can satisfy its required capabilities, and gracefully degrades if optional capabilities are unavailable.

```
my-agent/
├── manifest.toml          # identity, version, capabilities, signature info
├── identity.md            # persona / system prompt
├── skills.jsonl           # skills — one graph node per line
├── policies.json          # policy rules (deny_tool, deny_tool_param, etc.)
├── facts-seed.jsonl       # initial facts to prime memory
├── capabilities.toml      # what the agent needs from the host
└── signature              # ed25519 detached signature over the canonicalized bundle
```

The packed form is a deterministic gzipped tarball: `my-agent-1.2.3.car.tar.gz`.

---

## `manifest.toml`

The bundle's identity card. One required file per bundle.

```toml
[agent]
name = "note-taker"                    # registry-unique
namespace = "parslee"                  # publisher namespace
version = "1.2.3"                      # semver
description = "Captures and organizes meeting notes"
license = "Apache-2.0"
homepage = "https://github.com/parslee/note-taker"

[publisher]
key_id = "ed25519:abc123..."           # public key fingerprint
signature = "..."                      # base64 ed25519 over canonicalized bundle (excluding signature itself)

[runtime]
car_min_version = "0.3.0"              # minimum CAR runtime semver
bundle_format_version = 1              # this spec version

[lifecycle]
stateful = false                       # see "State model" below
persistence = "session"                # "session" | "host" | "synced"
default_inference_complexity = "medium"
```

| Field | Purpose |
|-------|---------|
| `agent.name` + `agent.namespace` | Globally unique identifier in the registry: `parslee/note-taker` |
| `agent.version` | Semver. Multiple versions can be installed side-by-side. |
| `publisher.signature` | Ed25519 detached signature over the canonicalized bundle. Verified at install. |
| `runtime.car_min_version` | Runtime refuses to load if its version is older. |
| `lifecycle.stateful` | Declares whether the agent accumulates memory between runs. |
| `lifecycle.persistence` | `session` (in-memory only), `host` (single device), `synced` (multi-device). |

---

## `capabilities.toml`

The load-bearing piece. Declares what the agent needs from the host.

```toml
# Capabilities the agent cannot run without.
# If the host can't satisfy ALL of these, install is rejected.
[required]
inference = ["text-generation"]
storage = ["persistent-kv"]

# Capabilities the agent uses when available, degrades gracefully otherwise.
[optional]
inference = ["embedding", "classification"]
tools = ["email-send", "calendar-read"]
sensors = []

# Capabilities the agent will NEVER use.
# Hosts may use this for surface-area attestation.
[denied]
tools = ["filesystem-write", "shell-exec"]
network = ["arbitrary-http"]
```

### Capability vocabulary (v1)

A capability is a stable identifier the host advertises and the agent requests. The vocabulary is versioned with the bundle format. New capabilities are additive; old ones are never repurposed.

#### Agent verbs (the App Intents bridge)

These capabilities name **what the agent does**, not what the host provides. The runtime's `invoke_capability(verb, …)` dispatches on these to pick a concrete agent. The host app (macOS / iOS) declares an `@AssistantIntent` per verb so Apple Intelligence / Siri can route natural-language requests to the right agent automatically.

| Capability | Apple AssistantSchema | Wire-format payload (JSON) |
|------------|----------------------|------------------------------|
| `summarize` | `.system.summarize` | `{"text": "..."}` |
| `transcribe-audio` | `.system.transcribeAudio` | `{"audio_path": "..."}` |
| `research` | (custom intent — Apple's `.system.search` is for app-content search, not knowledge Q&A) | `{"question": "..."}` |
| `search-knowledge` | (custom intent — same caveat) | `{"question": "..."}` |
| `verify-claim` | (custom intent) | `{"claim": "..."}` |
| `create-note` | `.system.createNote` | `{"content": "..."}` |

When more than one agent advertises the same verb (e.g. two summarizers), the runtime picks one in this order: caller-supplied `agent_hint` > most-recently-used > first registered. The host app's intent UI exposes the `agent_hint` parameter so users can pin a specific agent for a verb if they want to.

**MRU caveat:** the registry's most-recently-used tracking is in-memory only — a process restart resets it to "first-registered wins." Hosts that want session-spanning user pinning should persist the chosen agent themselves and re-supply it via `agent_hint` on subsequent calls. Any successful `invoke_capability` call updates MRU regardless of whether `agent_hint` was supplied, so a one-off hint becomes the new MRU.

**Verbs not yet shipping:** earlier drafts listed `translate-text` mapped to `.system.translate`. Cut from v1 — no built-in translator agent exists yet. Will land alongside the Translation framework wrapper (separate roadmap item) so the spec doesn't promise a verb the runtime doesn't serve.

The vocabulary is intentionally small for v1. New verbs are additive; existing ones are never repurposed (clients depend on the wire-format `payload` schema). When Apple adds new `AssistantSchemas.system.*` entries, prefer matching them — the alignment buys us natural-language routing for free.

#### `inference.*` (host capabilities)

These name what the **host** can provide for the agent's internal use, not what the agent does for the user.

| Capability | Means |
|------------|-------|
| `text-generation` | The host can run a chat-completion model (any provider) |
| `embedding` | The host exposes an embedding model |
| `classification` | The host exposes a fast classifier model |
| `tool-use` | The host's text-generation supports native tool calling |
| `extended-thinking` | The host supports thinking budgets (Claude / o-series) |
| `vision` | Host can route image inputs to a multimodal model |

#### `storage.*`
| Capability | Means |
|------------|-------|
| `persistent-kv` | Bundle gets a sandboxed key-value store that survives restart |
| `persistent-graph` | Bundle gets a sandboxed memory graph (full memgine) |
| `temporary` | In-memory only, cleared between sessions |

#### `tools.*` (capabilities, not specific tool names)
| Capability | Means |
|------------|-------|
| `email-send` | Host wires `send_email` tool to its native email surface |
| `email-read` | Host exposes mailbox query/search |
| `calendar-read` / `calendar-write` | Calendar access |
| `contacts-read` / `contacts-write` | Address book access |
| `location` | Current location, possibly continuous |
| `notifications` | Send local notifications to the user |
| `clipboard` | Read/write clipboard |
| `filesystem-read` / `filesystem-write` | Sandboxed file IO |
| `shell-exec` | Run shell commands (desktop only, gated) |
| `browser` | Browser automation (Playwright/CDP) |
| `voice-tts` / `voice-stt` | Native speech I/O |
| `nlp.identify-language` | Detect language of a text snippet (Apple `NaturalLanguage`) |
| `nlp.tokenize` | Split text into words/sentences with locale awareness |
| `nlp.entities` | Extract named entities (person/place/organization) |
| `nlp.lemmatize` | Reduce tokens to dictionary form |
| `vision.ocr` | Extract text + bounding boxes from an image |
| `vision.detect-faces` | Find face bounding boxes (no identity recognition) |
| `vision.detect-barcodes` | Read 1D/2D barcodes (QR, UPC, EAN, etc.) |
| `vision.classify-image` | Top-K scene classification from Apple's built-in classifier |
| `audio.classify` | Classify ambient/audio events (speech, music, alarms, …) |
| `translate.text` | Translate text between languages (Apple `Translation`, macOS 26+) |

The agent author writes `tools = ["email-send"]`. The host wires that capability to a concrete implementation: SMTP on Linux desktop, `MFMailComposeViewController` on iOS, SendGrid in the cloud. The agent code is identical.

For Apple platforms, permissioned and user-visible capabilities should be
implemented by the host with the native framework whenever one exists:
`UserNotifications` for `tools.notifications`, EventKit for calendars and
reminders, Contacts for address book data, Speech / AVFoundation for voice,
Vision for OCR and image analysis, and App Intents / Shortcuts for user-owned
automation. AppleScript and JXA remain desktop escape hatches for apps without
structured APIs; they are not the first-class capability contract.

#### `sensors.*` (mobile-leaning)
| Capability | Means |
|------------|-------|
| `accelerometer`, `gyroscope`, `magnetometer` | Motion sensors |
| `camera`, `microphone` | Media capture |
| `health` | Health/fitness data (HealthKit, Health Connect) |

#### `network.*`
| Capability | Means |
|------------|-------|
| `arbitrary-http` | Make outbound HTTP to any URL |
| `host-api` | Call back into host APIs only |
| `none` | No network at all |

---

## `identity.md`

Plain markdown. Loaded as the agent's identity layer in the four-layer context model. Treated as immutable after install.

```markdown
# Note Taker

You are a meeting-notes assistant. Capture decisions, action items, and open
questions. Default to terse bullet lists. When uncertain, ask one targeted
follow-up rather than guessing.
```

---

## `skills.jsonl`

One JSON object per line, each a fully-formed skill graph node. Loaded into the agent's memory graph at install time.

```jsonl
{"id": "skill-summarize-meeting", "trigger": "user requests meeting summary", "procedure": "...", "domain": "summarization", "success_count": 0, "fail_count": 0}
{"id": "skill-extract-action-items", "trigger": "decisions or commitments mentioned", "procedure": "...", "domain": "extraction", "success_count": 0, "fail_count": 0}
```

Field shape matches the Skill type in `car-memgine`. Source of truth for that schema is the Rust type — see `car-rs/crates/car-memgine/src/skill.rs`.

---

## `policies.json`

Array of policy rules. Loaded into the agent's policy enforcer at register time.

```json
[
  { "type": "deny_tool", "tool": "shell-exec", "reason": "agent declared no shell capability" },
  { "type": "deny_tool_param", "tool": "send_email", "param": "bcc", "reason": "no silent CC" }
]
```

The runtime enforces that bundle policies are a *superset* of denied capabilities — you can't declare `tools.shell-exec` denied and then have a policy that allows it.

---

## `facts-seed.jsonl`

Optional. Initial facts to seed the memory graph. Useful for agents that need persona knowledge ("you work for Acme Corp", "the user prefers metric units").

```jsonl
{"text": "Default to metric units unless the user specifies imperial.", "kind": "Constraint", "confidence": 1.0}
```

---

## State model

The `lifecycle.stateful` and `lifecycle.persistence` flags drive how the runtime treats the agent's memory across runs and devices. See [`docs/agent-portability-roadmap.md`](./agent-portability-roadmap.md) for the phased rollout.

| `persistence` | Meaning | Phase |
|---------------|---------|-------|
| `session` | Memory exists only for the duration of a run. Wiped on exit. | Phase 1 — ships first |
| `host` | Memory persists on the host that ran the agent. Phone has its memory; laptop has its own. | Phase 2 |
| `synced` | Memory is logically a single graph synced across all hosts the agent runs on. | Phase 3 |

`synced` requires a CRDT-merged memory graph (see roadmap). Bundles can declare it before the runtime supports it; the runtime falls back to `host` with a warning until sync ships.

---

## Canonicalization and signing

The signature in `manifest.toml` covers the **canonicalized bundle**:

1. Sort all files lexicographically by path within the bundle.
2. For TOML/JSON files, normalize: keys sorted, no trailing whitespace, LF line endings, no comments.
3. JSONL files are normalized line-by-line (each JSON object canonicalized, blank lines stripped) but **line order is preserved** — order is meaningful for skills.
4. Concatenate files in sorted order with `\0` separators between path and content, `\0\0` between files.
5. SHA-256 the result; sign the digest with ed25519.

Verification re-runs canonicalization at install time and checks the signature against the publisher's public key (resolved from the registry).

The `signature` file at the bundle root is excluded from canonicalization (it cannot sign itself) and contains the same value as `manifest.toml.publisher.signature` for tools that don't parse TOML.

---

## Distribution

### Registry

Bundles are distributed via an HTTP registry. The minimal API:

```
GET  /agents/{namespace}/{name}                  # list versions, latest pointer
GET  /agents/{namespace}/{name}/{version}        # bundle metadata
GET  /agents/{namespace}/{name}/{version}/bundle # signed tarball
GET  /publishers/{key_id}                        # publisher pubkey for verification
POST /agents/{namespace}/{name}                  # publish (auth required)
```

V1 implementation: GitHub Releases as the registry backend. Bundle tarballs are release assets; manifests live in a manifest branch. Drop-in replaceable with a hosted service later — the URL is the only thing that changes for clients.

### CLI

```bash
car publish ./my-agent              # canonicalize, sign, push to default registry
car install parslee/note-taker      # pull, verify signature, register with runtime
car install ./local-bundle.tar.gz   # local install for development
car list                            # show installed agents
car run note-taker                  # invoke the agent (one-shot or interactive)
car remove note-taker               # uninstall
```

The same `car install` command runs on desktop, mobile (via the host app's CLI shim), and cloud.

---

## What is *not* in a bundle

- **Tool implementations.** Only tool *capabilities* are declared. Hosts wire concrete tools to capabilities. This is what makes bundles portable.
- **Model weights.** Inference is host-mediated. The agent says "I need text-generation"; the host picks the model.
- **Runtime code.** Bundles are pure data. They never contain executable code. (This is also why the security story is tractable.)
- **Secrets.** API keys, tokens, passwords. Hosts manage secrets via their native key store (Keychain, etc.) and inject them into tool implementations, never into the bundle.

This separation is the whole point: bundles are declarative, portable, and signable. The platform-specific work lives in hosts.

---

## Open questions

1. **Versioned capability vocabulary** — when a new capability is added (e.g., `inference.video`), older runtimes need to either gracefully ignore it (if optional) or reject the bundle (if required). The bundle format version handles big breaks; per-capability minimums may also be needed.
2. **Tool capability granularity** — `email-send` covers a lot of ground. Do we need `email-send-plain`, `email-send-attachments`, etc.? Lean: keep it coarse for v1, refine if real bundles run into mismatches.
3. **Dependency between bundles** — can agent A invoke agent B? Multi-agent already supports this in-runtime; bundles need a way to declare "I require parslee/researcher@^1.0.0 to be installed". Defer to v2.
4. **Local bundles in `.car/`** — do project-local agents (development, not published) live in `.car/agents/` and bypass signing? Lean: yes, with a `--unsafe-local` flag for `car run`.
