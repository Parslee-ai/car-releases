{% raw %}
# Cross-host deployment — daemon and client on different machines

CAR's FFI bindings, the `car` CLI, and the in-tree mcp-proxy all default to
talking to a daemon on `127.0.0.1:9100`. For most use cases — single user,
single workstation — that's exactly right and you don't need this recipe.

When the daemon and the client run on **different hosts** (e.g. an FFI
process on a Windows laptop talking to a daemon on a Linux dev rig or
on-prem server), two env vars steer the client without code changes.

## The two env vars

| Variable | Purpose | Default |
|---|---|---|
| `CAR_DAEMON_URL` | WebSocket URL of the remote daemon | `ws://127.0.0.1:9100` |
| `CAR_AUTH_TOKEN` | Auth token for `session.auth` handshake | read from local file at the per-platform well-known path |

Both follow the same "env var wins when set" precedence — see
[websocket-protocol.md → Cross-host clients](../websocket-protocol.md#cross-host-clients-car_auth_token)
for the full contract (trimming, empty-handling, server-side exclusion).

## Walkthrough

### On the daemon host (Linux, say `daemon.example.invalid`)

Start the daemon listening on a network interface, not loopback:

```bash
car-server --host 0.0.0.0 --port 9100
```

> **Security note:** binding to `0.0.0.0` makes the daemon reachable from any
> peer that can route to the host. Restrict to a tunnel or office subnet with
> a firewall rule, or bind to a specific interface IP (e.g.
> `--host 192.0.2.10`). See the §8.0.0 setup gates in
> [the Windows surface workstream plan](../plans/2026-05-23-001-feat-windows-surface-workstream-plan.md)
> for the full pre-bind checklist.

Read the per-launch token the daemon just wrote:

```bash
cat "$XDG_RUNTIME_DIR/ai.parslee.car/auth-token"
```

(On a non-systemd Linux box where `XDG_RUNTIME_DIR` is unset, the path is
`~/.config/ai.parslee.car/auth-token`.)

### On the client host (Windows, say from a pwsh prompt)

Set both env vars and the FFI / CLI just-works:

```powershell
# Get the token from the daemon host (avoid recording it in pwsh history)
Set-PSReadLineOption -AddToHistoryHandler { param($l) $l -notmatch 'auth-token' }
$env:CAR_AUTH_TOKEN = ssh user@daemon.example.invalid "cat `$XDG_RUNTIME_DIR/ai.parslee.car/auth-token"
$env:CAR_DAEMON_URL = "ws://daemon.example.invalid:9100"

# Now any FFI/CLI invocation talks to the remote daemon
node -e "const {CarRuntime} = require('car-runtime'); new CarRuntime().queryFacts('test').then(console.log)"
```

The token transfer is out-of-band (ssh, scp, secrets store, vault). CAR does
not ship a token-distribution mechanism — just the client-side consumption.
A token transferred via `ssh ... cat ...` typically has a trailing newline;
`read_for_client` trims it automatically.

### Token rotation

The daemon mints a fresh token on every launch and deletes the file on graceful
shutdown. When the daemon restarts, the old token in `$CAR_AUTH_TOKEN` becomes
stale and the next `session.auth` handshake will be rejected with a clear
`-32001` error. Re-fetch the token (same one-liner as above) and update the
env var.

For long-running clients, a small wrapper that fetches the token on each
connect — rather than once per shell session — handles restarts transparently.

## See also

- [`docs/websocket-protocol.md`](../websocket-protocol.md) — full protocol
  reference, including the `session.auth` frame shape and the auth-required
  error response
- [`docs/plans/2026-05-23-001-feat-windows-surface-workstream-plan.md`](../plans/2026-05-23-001-feat-windows-surface-workstream-plan.md) —
  the Windows-surface workstream that this env var lands as F2
- [`car-rs/crates/car-ffi-common/src/auth_token.rs`](../../car-rs/crates/car-ffi-common/src/auth_token.rs) —
  the source-of-truth for `read_for_client()` and `TOKEN_ENV_VAR`

{% endraw %}
