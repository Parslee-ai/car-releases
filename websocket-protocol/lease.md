{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### lease

**Bound-identity authorization (car#1295, car#1296).** A connection that
authenticated as an agent — `session.auth { agent_id, token }` — may act only as
that agent. `lease.acquire`, `lease.renew`, `lease.release`, `lease.status`,
`sync.record_intent` and `sync.fence_check` refuse an `agent_id` naming a
*different* agent: the bound identity wins over the parameter, the same rule
`runs.start` applies to trace attribution. A matching id is redundant and
accepted. `lease.status` is included because its answer names the holder and its
fencing epoch — everything needed to decide when to try stealing the lease.

For the five lease/sync **mutations** (`lease.acquire`, `lease.renew`,
`lease.release`, `sync.record_intent`, `sync.fence_check`), an unbound
connection carrying only the daemon-wide token is refused when the daemon has a
host token. Only `session.auth { host_token }` may then supply an explicit
`agent_id`; auth-disabled developer daemons preserve the legacy unbound path.
`lease.status` remains a read: an unbound authenticated operator may name an
agent explicitly, while a bound agent may read only its own status.

This closes the daemon-token bypass for lease and fence mutations, but does not
make the daemon-wide token an agent isolation boundary. Supervised processes can
still obtain that token through the paths tracked by car#1297; every other
identity-sensitive RPC must independently bind or authorize its resource until
that credential design is resolved.

Per-agent execution lease (B6). A `car_sync::LeaseCoordinator` — a **linearizable
compare-and-swap register**, deliberately separate from the eventually-consistent
sync relay. The daemon reference is an in-process `InMemoryLeaseCoordinator`
(linearizable **within one daemon**); a cross-daemon distributed backend (Cosmos
`if_match` / single-writer daemon / Postgres advisory lock) is the documented B6
follow-up behind the same trait. The device is the holder.

#### `lease.acquire`
- **Params**: `{ agent_id: string, ttl_ms?: number }` (default TTL 30000)
- **Returns**: `Lease` `{ agent_id, holder, epoch, expires_at_ms }`, or an error when the lease is held (unexpired) by another.
- CAS-acquire the lease; grants iff unheld or expired, bumping the monotone, never-reused fencing `epoch`. FFI: `leaseAcquire` / `lease_acquire`.

#### `lease.renew`
- **Params**: `{ agent_id: string, epoch: number, ttl_ms?: number }`
- **Returns**: the renewed `Lease`, or an error (`Lost`) if no longer the holder at `epoch`.
- Heartbeat: extend `expires_at_ms` **without** bumping the epoch. Works past wall-clock expiry until actually stolen. FFI: `leaseRenew` / `lease_renew`.

#### `lease.release`
- **Params**: `{ agent_id: string, epoch: number }`
- **Returns**: `{ released: true }`, or an error (`Lost`) if not the holder at `epoch`.
- Clean handoff — the next acquire grants immediately with the next epoch (no TTL wait). Hook to graceful shutdown. FFI: `leaseRelease` / `lease_release`.

#### `lease.status`
- **Params**: `{ agent_id: string }`
- **Returns**: `{ lease: Lease | null }`
- The linearizable read of the current lease (the fence's "who holds now" read). `null` when unheld. An *expired* but un-stolen lease still reports its holder. FFI: `leaseStatus` / `lease_status`.


{% endraw %}
