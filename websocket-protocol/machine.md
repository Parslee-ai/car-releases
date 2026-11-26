{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### machine

What coding sessions leave on this machine: Docker containers, volumes, images,
build cache and buildx builders, the Docker VM's host memory, and long-lived
processes whose parent went away, each attributed to the coding session that
made it or marked unattributed with the reason
(docs/proposals/own-devices-everywhere.md §6a).

Docker is read through its local socket (`DOCKER_HOST` when it is a `unix://`
or `npipe://` endpoint, else Docker Desktop's per-user socket,
`/var/run/docker.sock`, or the Windows `docker_engine` pipe) with `GET` requests
only. No Docker is an empty inventory, not an error.

**Attribution never guesses.** A coding session is an agent enrolled with the
`coding-assistant` capability (`car claude`, `car codex`, `car session-enroll`);
the daemon records its start and working directory at `agents.upsert`, each
sign of life while it runs, and its end at `agents.remove`. A session swept as
abandoned ends at its last sign of life plus two minutes, not when the sweep ran.
A container is a session's only when its compose working directory
(`com.docker.compose.project.working_dir`) is the session's directory or inside
it, it was created while the session was live, and exactly one session matches;
a volume follows the first recorded container that mounted it. Containers
started with plain `docker run` carry no directory and are unattributed
(`no_working_directory`), as are objects CAR never saw (`not_recorded`) and build
cache, which records no directory at all. The daemon samples containers every
60 s so that a volume's creator is on record before `docker rm -f` removes the
only link; on macOS it reads Docker only while Docker Desktop's VM is running,
so it never wakes it from Resource Saver, and on Windows only when one of these
methods is called.

`machine.resources` and `machine.leftovers` are refused to a session bound to a supervised agent
(`machine.resources is not available to a supervised agent: …`): the machine
inventory is the operator's. Removal is host-only.

#### `machine.resources`
- **Params**: none.
- **Returns**: `{ sampled_at_ms, docker, containers, volumes, images, build_cache, builders, docker_vm, virtual_machines, containers_memory_bytes, containers_memory_unread, docker_sampling_paused?, orphans, leaks, unrecorded_anonymous_volumes, unrecorded_anonymous_bytes, findings }`.
  - `docker`: `{ status: "present", endpoint }`, `{ status: "absent", reason }` or `{ status: "unreadable", endpoint, error }`.
  - `containers[]`: `{ id, name, image, image_id, state, created_ms, compose_project, compose_working_dir, volumes, size_rw_bytes, attribution }`; `volumes[]`: `{ name, anonymous, created_ms, compose_project, size_bytes, ref_count, in_use, attribution }`. `attribution` is `{ kind: "session", id }` or `{ kind: "unattributed", reason: "not_recorded" | "no_working_directory" | "no_session" | "several_sessions" }`.
  - `images[]`: `{ id, tags, size_bytes, containers, dangling }`; `build_cache`: `{ entries, total_bytes, reclaimable_bytes }` (`null` when `/system/df` could not be read); `builders`: buildx builder names the CLI registered.
  - `docker_vm` / `virtual_machines[]`: `{ pid, footprint_bytes, owner: "docker" | "unknown", path }`. Memory is the physical footprint (macOS `ri_phys_footprint`, which counts compressed memory; Linux `VmRSS + VmSwap`), never RSS. `containers_memory_bytes` is what the running containers use, counted as `docker stats` does, for comparison. `containers_memory_unread` is how many running containers' stats could not be read; when it is above zero `containers_memory_bytes` is a lower bound and the finding says "at least".
  - `docker_sampling_paused` (macOS; present only while it applies): why the background sampler is not recording containers, today when a VM is running but none can be identified as Docker's. The sampler waits rather than read Docker, since a read could wake a stopped Docker VM, so short-lived containers made meanwhile are not recorded.
  - `orphans[]`: `{ pid, path, footprint_bytes, started_s, evidence }`, processes of at least 1 GiB whose parent is init or launchd. `evidence` is `{ kind: "observed", former_parent }` when the daemon saw the same process under another parent, or `{ kind: "candidate" }` for one older than an hour that is not an application, app extension or system service by its path (on macOS every application's parent is launchd too, so a candidate is not a finding).
  - `leaks[]`: `{ image, image_id, declared_volumes, volumes, containers, total_bytes, likely_cause }`, two or more anonymous volumes nothing uses that were made by removed containers of one image declaring `VOLUME`: the `docker rm -f` without `-v` pattern.
  - `findings`: the same, as sentences, most important first.
- Reads `/system/df` and each running container's one-shot stats, so it can take seconds. Records the listing it reads.
- CLI `car machine resources [--json]`; `car doctor` prints the findings without the daemon.

#### `machine.leftovers`
- **Params**: `{ session?: string }`: one recorded session, ended or not. Without it, every ended session that left something.
- **Returns**: `{ docker, sessions: [{ session, cwd, started_ms, ended_ms, items, total_bytes, removable_bytes }], note }`. `items[]`: `{ kind: "container" | "volume", id, detail, size_bytes, removable, kept_because }`. Offered for removal (`removable: true`): a stopped container, or an anonymous volume no container uses, of an ended session. Never offered: running containers, named volumes (reported only), anything of a live session.
- Refused with `no recorded coding session` when `session` names none.
- Nothing is removed by this method; `machine.leftovers.remove` removes what it offers.
- CLI `car machine leftovers [--session <id>] [--json]`.

#### `machine.leftovers.remove`
- **Params**: `{ ids: string[], session?: string }`. `ids` are the container ids and volume names `machine.leftovers` offered (`removable: true`).
- **Returns**: `{ removed: [{ session, kind, id, detail, size_bytes, outcome: "removed" | "skipped" | "refused", reason? }] }`.
- **Host-only**: the one method that changes Docker, on the owner's explicit request.
- The offer is recomputed from a fresh listing. An id not on offer now refuses the **whole** request and nothing is removed: not a running container, not a named volume, not anything of a live session, not an object of no session. Build cache is never attributed, so never offered.
- Each item is read again immediately before a single `DELETE /containers/{id}` or `DELETE /volumes/{name}` with no `force` and no `v`: one that started running, or that a container took up, is `skipped`; Docker refusing (409) is `refused`. No prune endpoint is used.
- CLI `car machine leftovers --remove [--session <id>] [--yes]` lists exactly what it will remove and asks first.

`machine.capacity` answers a different question: how much room this machine has right now. The daemon samples its own load every
30 seconds — load average per core, the OS memory-pressure verdict, bytes
swapped out since the previous sample, swap in use, free disk on the state root,
and any registered capacity inputs — and folds them into one rating:

| Rating | Meaning |
|---|---|
| `plenty` | takes heavy work |
| `tight` | takes light work only |
| `overloaded` | swapping, memory pressure critical, or the disk nearly full: declines new work |

Nothing is configured. Each threshold is a ratio of something the machine
reports about itself (cores, memory, disk size), and the `car-fleet` crate's
`capacity` module documents each one and why. Load alone never makes a machine
`overloaded`, and swap is judged by what was swapped *out* during the last
interval, never by swap in use, which macOS keeps long after the pressure has
passed.

The same rating, without the numbers, appears as `capacity` on this instance's
row in `fleet.inventory` / `fleet.composite`. A fleet worker that rates itself
`overloaded` declines dispatches with `busy`, `foreman.run`'s pool leaves
overloaded peers out, and `car policy-check-hook` reads the copy the daemon
writes to `<state root>/run/capacity.json` to warn about or refuse heavy
commands.

#### `machine.capacity`
- **Params**: none.
- **Returns**: `CapacityAssessment { rating: "plenty"|"tight"|"overloaded", sampled_at_ms, findings: [{ signal, rating, reason }], sample: { sampled_at_ms, interval_ms, cores, memory_total_bytes, load_average?: [number, number, number], memory_pressure?: "normal"|"warning"|"critical", memory_available_bytes?, swap_used_bytes?, swapped_out_bytes?, disk_free_bytes?, disk_total_bytes?, contributions?: [{ source, rating, reason }] }, sample_interval_ms, stale_after_ms }`.
  - `findings` lists what made the rating worse than `plenty`, worst first; it is empty for `plenty`. `signal` is `load`, `swap`, `memory`, `disk`, or a contribution's `source`.
  - A measurement the platform cannot make is absent, never guessed: Windows has no load average or swap-out counter, and its memory signal is the available-memory ratio.
  - When the daemon has not sampled yet, or its last sample is older than `stale_after_ms`, the call samples once before answering.
- Local only: peers see the rating in the fleet inventory, never these numbers.
- **FFI**: `machineCapacity()` (Node) / `machine_capacity()` (Python).

{% endraw %}
