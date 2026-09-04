{% raw %}
# Storing API keys in the OS keychain

CAR resolves remote-model API keys in this priority:

1. **Process env var** — wins everything. Right for containers, CI, K8s, systemd, headless Linux.
2. **OS keychain via `car-secrets`** — Keychain on macOS, Credential Manager on Windows, Secret Service on Linux.
3. **Hard error.**

This recipe walks through Option 2 — the desktop default. Keys are encrypted at rest by the OS, never appear in `ps` or your shell history, and survive `~/.car/env` going missing.

## Migrate existing keys

If you already have keys in `~/.car/env` or your shell, one command moves them into the keychain:

```bash
car secrets migrate-from-env
```

Output:

```json
{
  "dry_run": false,
  "service": "car",
  "migrated": ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  "already_current": [],
  "empty_in_env": ["GOOGLE_API_KEY"]
}
```

The command:

- walks the well-known remote-model env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`)
- copies any non-empty values into the keychain under service `"car"` and account = the env var name
- skips writes when the keychain already has the same value (no extra Keychain prompts on re-run)
- is idempotent — safe to re-run

Use `--dry-run` to preview, or `--include EXTRA_VAR` to migrate additional names.

After migration, you can `unset OPENAI_API_KEY` (etc.) in your shell rc — `car-inference` picks the values up from the keychain at runtime.

## Manage individual keys

```bash
# Store a key (prompts on stdin if --value omitted).
car secrets put OPENAI_API_KEY
echo sk-... | car secrets put OPENAI_API_KEY      # or via stdin

# Read a key (echoes value verbatim, exit 1 if missing).
car secrets get OPENAI_API_KEY

# Check existence without revealing the value.
car secrets status OPENAI_API_KEY
# {"service": "car", "key": "OPENAI_API_KEY", "exists": true}

# Delete (idempotent).
car secrets delete OPENAI_API_KEY

# Probe whether the OS keychain is reachable on this host.
car secrets available
# {"available": true}
```

All `car secrets *` commands accept `--service NAME` to override the namespace. The default `"car"` is the same namespace `car-inference` reads at runtime — don't change it unless you know why.

On macOS, CAR reads, writes, checks, and deletes Keychain entries through the Apple-signed `/usr/bin/security` helper. Reads parse the helper's byte-preserving `-g` output, so valid UTF-8 values with trailing newlines still round-trip. Using the Apple-signed helper keeps authorization stable across rebuilt `car-server` helpers whose CDHash changes, avoiding repeated prompts after the user has already allowed access.

## How `car-inference` resolves a key

The resolver runs once per endpoint at registration time:

```rust
fn resolve_raw_key(env_var: &str) -> Option<String> {
    if let Ok(v) = std::env::var(env_var) { return Some(v) }       // 1. process env
    if SecretStore::new().is_available() {                         // 2. OS keychain
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

- **Headless Linux** (no Secret Service daemon). Use `~/.car/env` instead.
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
