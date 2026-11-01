{% raw %}
# Storing API keys in CAR's secret store

CAR resolves remote-model API keys in this priority:

1. **Process env var** — wins everything. Right for containers, CI, K8s, systemd, headless Linux.
2. **CAR's secret store** — Keychain on macOS, Credential Manager on Windows, Secret Service on Linux. On a Linux machine with no Secret Service, one owner-only file per key under `~/.car/secrets/` (directory `0700`, files `0600`; a key file with wider permissions is refused with the fix `chmod 600 <file>`).
3. **Hard error.**

On a desktop the store is encrypted at rest by the OS, and keys never appear in `ps` or your shell history.

## Store a key

`car keys set <provider>` is the one way to store a key:

```bash
car keys set openai                  # prompts on stdin if the value is omitted
echo sk-... | car keys set openai    # or via stdin
car keys list                        # names and sources, never values
car keys remove openai
```

`car keys list` shows the source that wins for each key: `env` for a process environment variable, `store` for the secret store.

## Upgrading from `~/.car/env`

Earlier versions read keys and settings from a dotenv file at `~/.car/env`. CAR no longer reads it. On the first daemon start after you upgrade, the daemon moves every entry of the file into the store, reads each back, and then deletes the file. No backup is kept, because a backup would be the same keys in plain text. If any entry fails to move, nothing is deleted and `car doctor` names the entries that did not move (names only). If the file's value for a key differs from the one already in the store, the store keeps its own value, the other entries still move, and the file stays; the daemon log and `car doctor` name the key (never its value), and `car secrets migrate-from-env --replace` overwrites the store with the file's value if that is the right one. A `CAR_AUTH_TOKEN` found in the file stays the daemon's token on every start: the move saves it to an owner-only file (`secrets/adopted-auth-token`, mode `0600`, in the same state folder) before deleting the old file, and the daemon reads it from there, never from the store. A token supplied by `--auth-token`, `CAR_AUTH_TOKEN` or `--auth-token-file` (CarHost uses the file) always wins. Settings such as `RUST_LOG` or `VLLM_MLX_ENDPOINT` are moved to the store but are no longer applied to the daemon environment: set them in the launch environment (launchd plist, or `Environment=` in a systemd unit).

A `~/.car/env` made by hand later is ignored; the daemon logs once that it is ignored and `car doctor` lists its entry names. To import it, run:

```bash
car secrets migrate-from-env
```

Output:

```
ANTHROPIC_API_KEY: moved
OPENAI_API_KEY: moved
```

The command:

- writes every entry of the file to the store, reads each back, and only then deletes the file (no copy is kept)
- also copies provider keys set in your shell environment into the store (`--include EXTRA_VAR` adds names, `--service` applies to that part)
- prints one line per entry, by name, never the value
- keeps a different value already in the store, exits non-zero, and tells you to pass `--replace` if the file's or the shell's value should win; when the file and the shell both set a key, `--replace` keeps the shell's value
- leaves the file untouched and exits non-zero if any entry fails to move
- prints `nothing to move` when run again

Use `--dry-run` to preview the names; it changes nothing.

## Manage individual keys

```bash
# Store a key (prompts on stdin if --value omitted).
car secrets put OPENAI_API_KEY
echo sk-... | car secrets put OPENAI_API_KEY      # or via stdin

# Read a key (echoes value verbatim, exit 1 if missing).
car secrets get OPENAI_API_KEY

# Resolve exactly as a contract-check rerun: the secret store only.
car secrets get OPENAI_API_KEY --check-credential

# Check existence without revealing the value.
car secrets status OPENAI_API_KEY
# {"service": "car", "key": "OPENAI_API_KEY", "exists": true}

# Delete (idempotent).
car secrets delete OPENAI_API_KEY

# Probe whether the OS keychain is reachable on this host.
car secrets available
# {"available": true}
```

All ordinary `car secrets *` commands accept `--service NAME` to override the
namespace. `get --check-credential` conflicts with `--service`: it must use
the runtime's fixed CAR secret-store namespace and never consults the
process environment. It prints the
value on stdout and a value-free source label on stderr.

On macOS, CAR reads, writes, checks, and deletes Keychain entries through the Apple-signed `/usr/bin/security` helper. Reads parse the helper's byte-preserving `-g` output, so valid UTF-8 values with trailing newlines still round-trip. Using the Apple-signed helper keeps authorization stable across rebuilt `car-server` helpers whose CDHash changes, avoiding repeated prompts after the user has already allowed access.

## How `car-inference` resolves a key

The resolver runs once per endpoint at registration time:

```rust
fn resolve_raw_key(env_var: &str) -> Option<String> {
    if let Ok(v) = std::env::var(env_var) { return Some(v) }       // 1. process env
    if SecretStore::new().is_available() {                         // 2. secret store
        if let Ok(v) = SecretStore::new().get(&SecretRef::new("car", env_var)) {
            return Some(v);
        }
    }
    None                                                            // 3. unresolved
}
```

The keychain step is **skipped silently** when the OS store isn't available — no pinentry prompts on locked desktops, no DBus dial-out on headless Linux for every endpoint.

Comma-separated multi-key pools work in both env and keychain:

```bash
car secrets put OPENAI_API_KEY --value 'sk-a,sk-b,sk-c'
```

becomes a 3-key load-balanced pool with per-sub-key rate-limit awareness.

## When NOT to use the keychain

- **Headless Linux** (no Secret Service daemon). CAR keeps one owner-only file per key under `~/.car/secrets/`; store keys with `car keys set`. If your deployment already injects keys as environment variables, those still win.
- **Docker / Kubernetes**. Inject keys via env vars or mounted secrets.
- **CI** (GitHub Actions, etc.). The runner has no keychain. Use repo / org secrets.
- **systemd units** running pre-login. No keychain available before user session.

In all these cases env vars work and the keychain code path is silent. If you want to disable the keychain dep entirely for a container build:

```bash
cargo build --no-default-features --features ast -p car-inference
```

That drops `car-secrets` from the dependency graph — not just the runtime lookup, the linker too.

## Service namespace

All CAR components use service `"car"` (per-app). One bucket. `car secrets put` writes the entry that `car-inference` reads. The `car-secrets::DEFAULT_SERVICE` constant defines this; pre-v0.5.2 it was `"car-runtime"` — entries written before that date live under the old name.

{% endraw %}
