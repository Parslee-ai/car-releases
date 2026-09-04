{% raw %}
# Agent Portability Roadmap

> **Status:** draft. Not yet implemented. Companion to [`docs/agent-bundle-spec.md`](./agent-bundle-spec.md) (the bundle format) and [`docs/mobile-platform.md`](./mobile-platform.md) (iOS/Android plan).

The vision: **a user writes an agent once, publishes it, and runs it on desktop, mobile, or cloud — all on top of CAR.** The bundle spec gives us a portable, signable, host-agnostic distribution unit. The mobile plan gives us the platforms to run it on. This document is the phased rollout that connects them, focused on the hardest dimension: **state**.

State is what separates a stateless agent (runs anywhere, trivial) from a personal assistant that knows you across every device you own (graph CRDTs, real engineering). We deliberately phase this so each step ships something useful, and so we don't burn months on synchronization before validating that anyone wants it.

---

## Three phases of statefulness

| Phase | What ships | Memory model | When the agent is "the same agent" |
|-------|-----------|--------------|------------------------------------|
| **1 — Stateless** | Agent bundles run anywhere with no memory between runs | `lifecycle.persistence = "session"` | The bundle is the same; each invocation is fresh |
| **2 — Single-host stateful** | Agents accumulate memory on a specific device | `lifecycle.persistence = "host"` | Same bundle on phone and laptop, but they have separate memories |
| **3 — Multi-host stateful** | One agent identity, memory synced across devices | `lifecycle.persistence = "synced"` | Phone-Claude and laptop-Claude share memory; either can answer "what did the user say yesterday?" |

The bundle spec accommodates all three from day one. The runtime ships them in order. Bundles published before a phase is supported degrade gracefully (a `synced` bundle on a phase-2 runtime falls back to `host` with a warning).

---

## Phase 1 — Stateless agents

**Ships first. Useful by itself. The shortest path to "the same agent runs everywhere."**

A stateless agent has no memory between runs. Every invocation starts from `identity.md` + `skills.jsonl` + `facts-seed.jsonl`, processes a query, returns a result, exits. Memory is built up during the run for context assembly, then discarded.

This covers a surprising number of useful agents:
- Researchers (gather → synthesize → return)
- Summarizers (read → compress → return)
- Code reviewers (read diff → comment → return)
- Verifiers (check claim → respond)
- One-shot task runners (do thing → done)

It does *not* cover personal assistants, but it covers everything multi-agent systems already use as constituent agents. The CAR codebase already has commodity agents in `car-agents` (Researcher, Planner, Verifier, Summarizer); these become the first published bundles.

### What we need to build

| Item | Where | Status |
|------|-------|--------|
| Bundle format spec | `docs/agent-bundle-spec.md` | Drafted in this PR |
| Bundle loader (canonicalization, signature verify, register) | `car-engine` or new `car-bundle` crate | Not started |
| `car publish` and `car install` CLI commands | `car-cli` | Not started |
| Capability vocabulary (v1) | Bundle spec | Drafted |
| Capability negotiation in runtime (fail-closed if required missing) | `car-engine` | Not started |
| Registry — GitHub Releases backend | `car-cli` + repo conventions | Not started |
| Convert built-in agents to bundles | `car-agents` → bundles published to registry | Not started |
| `car-ffi-uniffi` crate (so iOS/Android can load bundles too) | New crate | Not started — see mobile plan M2 |

### What "done" looks like for Phase 1

- I can run `car publish ./researcher` from my laptop.
- Someone else can `car install parslee/researcher` on their laptop, their phone (via host-app affordance), or their server.
- It runs identically in each location.
- No memory persists between runs in any of those locations.

### Non-goals for Phase 1

- Persistence. (That's phase 2.)
- Sync. (That's phase 3.)
- A registry beyond "GitHub Releases".
- A signing infrastructure beyond "ed25519 keypairs you generate locally".

---

## Phase 2 — Single-host stateful agents

**Memory persists, but only on the device the agent ran on.**

A user's note-taking agent on their laptop accumulates a memory graph in `~/.car/agents/parslee.note-taker/state/`. The same agent on their phone accumulates a *different* memory graph in the iOS host app's sandboxed storage. These graphs are unrelated; if the user told their laptop-agent something, the phone-agent doesn't know.

This is honestly a lot of value already — most personal-assistant flows happen on one device, and "remember X" is the load-bearing feature. The CAR memgine already supports this via `persist_memory` / `load_memory`. We mostly need to wire it through the bundle lifecycle.

### What we need to build

| Item | Where | Status |
|------|-------|--------|
| Per-bundle storage sandboxes (key derivation, isolation) | `car-engine` | Not started — directory layout exists, isolation does not |
| `lifecycle.persistence = "host"` honored by bundle loader | Bundle loader | Not started |
| Memory schema migration (when an upgraded bundle changes its memory shape) | `car-memgine` | Not started |
| Storage paths for each platform (laptop: `~/.car/`, iOS: app sandbox, Android: app data dir) | Host apps + `car-engine` | Partially done on desktop |
| `car export` / `car import` for one-off backup and inter-device transfer | `car-cli` | Not started — note: this is **not** sync, it's manual |
| Storage quota / GC | `car-memgine` | Not started |

### What "done" looks like for Phase 2

- I install `parslee.note-taker` on my laptop. I tell it "I'm working on the migration to Postgres 16." Later, I ask "what was I working on?" and it remembers.
- I install the same bundle on my phone. The phone-instance does *not* know about the migration unless I tell it again.
- If I want to bring my laptop's memory to my phone, I run `car export note-taker > snapshot.car-state` and import it manually.

### Non-goals for Phase 2

- Multi-host sync. (Phase 3.)
- Conflict resolution. (Phase 3.)
- Cross-user sharing. (Out of scope entirely.)

### Why this might be enough

There's a real argument that phase 2 is the right *terminal* state for a long time. CRDT-merged memory graphs are months of work. If users mostly work on one device per task and don't expect cross-device continuity, phase 2 is the product. We commit to phase 3 only after phase 2 is shipping and we've validated the demand.

---

## Phase 3 — Multi-host stateful agents (synced memory)

**The hard problem. The dream. Months of work.**

A user has the same agent on their phone and their laptop. The agent's memory is logically a single graph; updates on either device propagate to the other. If the laptop-agent learned something this morning and the user goes to lunch and asks the phone-agent about it, the phone-agent knows.

The technical challenge is **graph CRDTs**. CAR's memory is a `petgraph::StableGraph` of `MemKind` nodes connected by `EdgeKind` edges, with relevance scoring via spreading activation. Synchronizing this across devices means:

- Every node and edge has a stable causal identifier (vector clock or hybrid logical clock).
- Concurrent insertions on two devices are commutative.
- Concurrent deletions and updates have a deterministic merge — likely **last-writer-wins for fields, add-wins for membership**, with explicit deletion tombstones.
- Spreading-activation scores are recomputed locally after merge; they're a pure function of the graph and don't sync.
- Skill `success_count` / `fail_count` use a CRDT counter (PN-counter), not LWW.

### Approach

Two paths, both real:

**Path A — Off-the-shelf CRDT framework.** Use Automerge or Yjs as the underlying store; rebuild memgine's graph queries on top of it. Pro: well-tested merge semantics, mature codebases. Con: rewriting memgine is a big project, and Automerge's perf characteristics need validation against memgine's spreading-activation workload.

**Path B — Custom CRDT on top of `StableGraph`.** Add causal metadata to every node/edge insert; merge is a function over two operation logs. Pro: smallest change to memgine; we control the perf. Con: writing a graph CRDT correctly is famously difficult — the "moves" problem (a node simultaneously edited and deleted) has subtle gotchas.

Lean: **Path B**, with rigorous testing using simulation (Maelstrom, or a hand-rolled fuzzer) to validate convergence under adversarial schedules. Path A is the fallback if path B turns out to be a tar pit.

### What we need to build

| Item | Where | Status |
|------|-------|--------|
| Causal metadata on graph operations | `car-memgine` | Not started |
| Operation log (append-only, causally ordered) | `car-memgine` | Not started |
| Merge function with property-based tests | `car-memgine` | Not started |
| Sync protocol — operation pull/push between hosts | New `car-sync` crate | Not started |
| Sync transport — direct device-to-device + relay server | `car-server` extension or new service | Not started |
| Identity — same logical agent across devices, with per-device sub-identity for op attribution | Bundle loader + `car-memgine` | Not started |
| End-to-end encryption of synced state | `car-sync` | Not started |
| Device authorization UX (pairing, revocation) | Host apps | Not started |

### What "done" looks like for Phase 3

- I install `parslee.note-taker` on my laptop and pair it with my phone install of the same bundle.
- I tell my laptop "I'm working on the Postgres migration."
- Some seconds later (or minutes, or after both come back online), my phone agent knows.
- I delete a fact on my phone. Later it's gone on my laptop.
- The user never sees CRDT machinery — it's just "their agent."

### Non-goals for Phase 3

- Real-time collaborative editing semantics (this isn't Google Docs).
- Cross-user sync (still out of scope — that's a different product).
- Server-authoritative storage (sync is peer-driven; relay is for offline catch-up only).
- Conflict UX (the merge is deterministic; we don't surface conflicts to the user).

---

## Cross-cutting concerns

These apply across all phases and need decisions early so we don't paint into corners.

### Identity

A bundle has an identifier (`namespace/name@version`). An *installed bundle* has an identifier *and a per-device install ID*. A *synced bundle* (phase 3) has an identifier, a per-device install ID, and a logical agent identity that ties multiple installs together.

The simplest model: when a user pairs two devices for an agent, they exchange a logical agent ID (random 128-bit value). Operations carry `(logical_id, device_id, timestamp)`. The merge dedupes by `(device_id, op_id)`.

### Privacy and security

- **Bundles are signed at the publisher level** (phase 1). Verifies authenticity; doesn't address malice. A malicious bundle from a trusted publisher is a problem the bundle format can't solve — we rely on the capability model to limit blast radius.
- **Capability denial is mandatory** — hosts must enforce that an agent declaring `tools = ["email-send"]` cannot exfiltrate via filesystem-write or shell-exec. This is the existing CAR policy enforcement; bundles must compose with it.
- **Synced state is end-to-end encrypted** (phase 3) — the relay never sees plaintext. Pairing exchanges the symmetric key.
- **No third-party access** to a user's memory graphs in any phase, including by Parslee. The relay sees only ciphertext.

### Versioning

- Bundle format itself is versioned (`bundle_format_version` in manifest). Major bumps are rare and require runtime support.
- Capability vocabulary is additive within a bundle format version.
- Memory schema migrations (phase 2+) — bundles declare their memory schema version; the runtime runs migrations on upgrade. Skipping major versions is unsupported.
- Sync protocol (phase 3) is versioned independently; devices negotiate the highest mutually supported version on pair.

### Observability

CAR's existing event log (`car-eventlog`) captures runtime events as JSONL. Extends naturally:

- Bundle install / uninstall events.
- Capability grant / deny events.
- Sync events (phase 3): operations sent, received, merged, conflicts resolved.
- Inference routing events: which provider served a given turn.

For host apps, an in-app "what did the agent do" view is built on top of the event log. This is also the audit trail for capability use.

---

## Sequencing summary

| Phase | Approx. effort | Ships | Critical dependencies |
|-------|----------------|-------|------------------------|
| **1 — Stateless** | weeks | Bundle format, publish/install, registry, built-in agents as bundles | None — buildable today |
| **2 — Single-host stateful** | low single digit months | Per-host persistence, export/import, schema migration | Phase 1 must ship first |
| **3 — Multi-host stateful** | multi-month | Graph CRDT, sync protocol, transport, E2E encryption, device pairing | Phase 2 must be stable; demand validated |

Phase 1 should ship behind no flag. Phase 2 is gated on real bundles (built-in agents) using it. Phase 3 is gated on user pull — we don't build it speculatively.

The mobile platform plan ([`docs/mobile-platform.md`](./mobile-platform.md)) sequences in parallel: M1 (macOS testbed) and M2 (`car-ffi-uniffi`) are prerequisites for any mobile work; M3 (iOS host app TestFlight) can ship in parallel with phase 2 of this roadmap. Phase 3 sync is post-launch.

---

## Open questions

1. **Memory ownership during sync (phase 3) — does a paired device own anything, or is everything shared?** Lean: everything synced. If a user wants device-local memory, they install the bundle as `host` not `synced`.
2. **What's the upper bound on synced graph size?** If a user has 50,000 nodes, sync can't be naive. Likely needs delta-only sync after the first full bootstrap.
3. **Can a synced agent be running concurrently on two devices?** What if both devices are online and active? Operations from each are independent and merge fine; the user might just see weird-feeling double-responses. Probably need device-of-record arbitration: the device that started a turn owns it through completion.
4. **Bundle revocation.** A publisher's signing key is compromised; old bundles signed with it must be marked unsafe. Registry needs a revocation list, runtime checks it on install and periodically.
5. **Stateful agents with no `persistence` declared** — runtime default? Lean: default to `session`. Authors who want persistence opt in explicitly. Surprise persistence is bad.

{% endraw %}
