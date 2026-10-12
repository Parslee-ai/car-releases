{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### fleet

One composite view of every CAR instance this daemon can reach — their agents,
capabilities, and models — plus the enrollment that lets `foreman.run` farm
subtasks across them.

`agents.peers` answers *who* is out there; `discovery.resolve` ranks services
against a need. `fleet.*` answers what the reachable machines can actually do,
folded so one row names every instance that offers it. That is the input a
placement decision needs, and it is what was missing when "farm this subtask
out" could only ever mean "to this machine".

Transport and trust are unchanged: remote reads and dispatches ride the existing
peer-signature-authenticated A2A listener (`--a2a-bind`), a LAN-discovered host
stays a visible candidate until an operator promotes it with `a2a.peers.add`,
and the merge-verify gate never leaves the orchestrating host.

#### `fleet.inventory`
- **Params**: none.
- **Returns**: `InstanceInventory { schema_version, instance: { name, kind: "local", source, version, platform }, fidelity: "full", agents: [{ id, kind, display_name?, status?, capability?, addressable }], capabilities: [{ name, kind, description?, tags }], models: [{ id, kind: "local"|"cloud", provider?, available, context_window?, capabilities }], worker?: WorkerProfile, collected_at_ms }`.
  - `agents[].kind` is one of `assistant`, `attached`, `supervised`, `declarative`, `external_cli`. `addressable` mirrors `agents.peers`' rule that an external CLI can message CAR while it runs but has no inbox.
  - `capabilities[].kind` is one of `tool`, `skill`, `connector`, `a2a_skill`. Tools come from the calling session's runtime (so a client's own `tools.register`ed tools appear); skills come from its memory graph and are capped at 200 rows.
- This is the same report peers receive over A2A, plus the session's own tools and skills.
- **FFI**: `fleetInventory()` (Node) / `fleet_inventory()` (Python).

#### `fleet.composite`
- **Params**: `{ include_remote?: boolean, timeout_ms?: number }` — `include_remote` defaults to `true`; `timeout_ms` (default `10000`) bounds **each peer individually**.
- **Returns**: `FleetComposite { schema_version, generated_at_ms, self_name, instances: [InstanceInventory], agents: [{ id, kind, instances: [string], capability? }], capabilities: [{ name, kind, instances: [string], description? }], models: [{ id, kind, provider?, instances: [string], available_on: [string], max_context_window? }], workers: [{ instance, kind, adapters: [string], max_parallel, repo_root_commits: [string] }], totals: { instances, reachable_instances, full_instances, agents, capabilities, models, workers, worker_slots } }`.
  - Rollups are **by identity across instances**: the same tool on four machines is one capability row naming four instances, and `totals` counts distinct things, not the sum of the per-instance counts.
  - A model served from local weights on one host and through a hosted API on another stays **two rows** (`kind` is part of the key) — different cost, latency, and failure modes, and a router picks between them. `available_on` is the subset that can serve it now; listed-but-unavailable says where a download or a login would unlock capacity.
  - An instance that could not be read is still a row, with `fidelity: "unreachable"` and an `error` naming the reason. A peer that answered only its public agent card is `fidelity: "card_only"`: its capabilities are real, and its empty agent/model lists mean **unknown, not none**. A LAN host that has not been promoted appears as unreachable with the promotion instruction as its reason.
  - `workers[].repo_root_commits` is how an orchestrator tells, before dispatching, whether a machine can reproduce a base tree. Root commits only — a repository path is local detail a peer has no business learning.
- **FFI**: `fleetComposite(includeRemote?, timeoutMs?)` (Node) / `fleet_composite(include_remote=None, timeout_ms=None)` (Python).

#### `fleet.worker.get`
- **Params**: none.
- **Returns**: `{ config: { accepts_work, repos: [string], max_parallel, local_parallel, dispatches_per_hour, max_subtask_secs, fetch_missing_base, fetch_remote, allowed_tools? }, profile: WorkerProfile { accepts_work, adapters: [string], max_parallel, repo_root_commits: [string] } }`.
- `config` is what an operator set (`~/.car/fleet-worker.json`); `profile` is what peers see — paths never leave this host.
- **FFI**: `fleetWorkerGet()` (Node) / `fleet_worker_get()` (Python).

#### `fleet.worker.set`
- **Params**: `{ accepts_work?: boolean, repos?: [string], max_parallel?: number, local_parallel?: number, dispatches_per_hour?: number, max_subtask_secs?: number, allowed_tools?: [string], fetch_missing_base?: boolean, fetch_remote?: string }` — only the fields supplied change.
- **Returns**: the same `{ config, profile }` shape as `fleet.worker.get`.
- **Operator-only, and a real grant.** Enrolling lets a trusted peer run a coding CLI against the checkouts named in `repos`, so it is refused for any session bound to an agent id — an agent cannot enroll the machine, least of all the one that would benefit. Deliberately *not* `is_host` (which the peer-approval surfaces use): this is a configuration change, and the operator's own CLI already holds the daemon's auth token. Off by default, and a malformed config file reads as *declining*, never as accepting under half-read limits.
- Each entry in `repos` is validated as a git repository at set time, so a typo surfaces here rather than as a peer's subtask being declined for reasons that look like the peer's fault. A dispatch is matched to one of them by **root commit**; a peer that names a repository this host does not have, or a base commit it has never seen, is declined with the specific reason (`repo_unavailable` vs `commit_unavailable`) so the orchestrator can place the subtask elsewhere.
- **The limits are this machine's, not the caller's.** Three of them exist because the dispatch itself is written by the sender:
  - `dispatches_per_hour` (default 60) budgets the **payer's** spend. Deliberately *not* keyed by device fingerprint: a person with a laptop, a desktop and a CI box would then draw three separate allowances and the limit would scale with the caller's hardware instead of bounding it. Every caller that passes peer auth is provably a device of one account (`refresh_peer_trust` trusts only this login's roster, and installs an empty set without sync), so they share one bucket. When org attestation lands the key becomes the attested member id. `max_parallel` bounds *concurrency*, which is not a bound on spend — a peer that dispatches one subtask, waits, and dispatches the next never exceeds it and can still drain this machine's coding-CLI quota. The budget is charged **last**, immediately before the CLI runs, so declines that cost this machine nothing (wrong repo, no adapter) do not spend the caller's allowance. Over budget returns `outcome: "declined", reason: "rate_limited"`, whose detail says when capacity frees.
  - `max_subtask_secs` (default 1800) is the ceiling a sender's `timeout_secs` is clamped to; an omitted one means this ceiling, not "unbounded".
  - `allowed_tools` is **intersected** with whatever the dispatch requests — whichever side is stricter wins, and a sender naming nothing does not thereby get everything. Unset (the default) adds no restriction beyond the CLI's own, because a coding subtask needs to read, edit and usually build, and too narrow a list just fails every dispatch for reasons the sender cannot see.
- `fetch_missing_base` (default `false`) makes this machine a **runner**: rather than decline a base commit it does not hold, it fetches from `fetch_remote` (default `origin`) and serves the subtask. This is what turns an idle pool into a working one — a runner tracking `origin` always has the commit, where a laptop on an unpushed branch declines every dispatch. It adds **no trust**: the fetch targets the remote this checkout is already configured with, never anything the dispatch supplied, and a commit that is not on that remote still declines. Off by default because on a person's machine a peer's dispatch should not cause a fetch in a repository they are working in.
- `local_parallel` is this host's own share when *it* orchestrates a distributed run.
- Every dispatch — accepted or declined — appends a record to `~/.car/fleet-work.jsonl`, carrying the **peer's verified public key** (`peer_key`) and its short label (`peer`, which two keys can share), the run and subtask ids, the repository root commit, the outcome and its reason. The key comes from the request signature, never from anything the dispatch body claims about itself; a dispatch the transport cannot attribute is refused outright rather than run anonymously.
- **FFI**: `fleetWorkerSet(acceptsWork?, repos?, maxParallel?, localParallel?)` (Node) / `fleet_worker_set(accepts_work=None, repos=None, max_parallel=None, local_parallel=None)` (Python).


{% endraw %}
