# Governed production assistant

CAR's supervised assistant has an opt-in host mode for repository engineering:

```sh
car do --serve --governed-host --dir /absolute/path/to/repository
```

Run that command once from a terminal with CarHost running. CAR registers and
starts a repository-bound supervised agent, then exits the setup process. The
new agent appears in CarHost as `Parslee Core - <repository>`; its supervised
child process receives the normal per-agent token from CarHost.

The mode requires an explicit Git repository root. It rejects a missing path,
a nonexistent path, `/`, and the user's home directory before constructing any
tools. Files and shell use the real host toolchain and network, with reads and
writes clamped to the repository. CAR's browser uses its own persistent
profile; browser credentials are not copied to the shell or transcript.

Since this mode runs as a supervised agent behind CarHost, its browser is
normally headless — the Command Deck's browser drawer is its visible face, not
a separate Chrome window; open the drawer on this agent's conversation to
watch it and take control when a sign-in needs a human. If CarHost is not
connected (a pure command-line session with no host app ever attached), the
browser launches headed instead, exactly as it always has, so a sign-in still
has a visible window to complete in. `CAR_BROWSER_HEADLESS` still overrides
either default.

Balanced permissions allow reads, ask before edits, and ask before every
full-access action. In governed mode a standing full-access preference does not
waive per-action approval for pushes, deployments, database/production writes,
or similar remote mutations. Approval events identify the canonical action id,
exact tool parameters, repository, target, environment, and credential
capability names. They never contain credential values.

Normal targeted pushes may be approved. Force-push, Git remote
reconfiguration, history rewrite, privilege escalation, credential-file reads,
broad staging (`git add .`, `git add -A`, `git commit -a`), and repository-scope
escapes are unconditional denials.

## Mandatory project gates

Database commands fail closed unless the repository contains a matching gate
in `.car/production-gates.toml`:

```toml
[[gates]]
name = "dba-policy"
action = "database"
check = "./scripts/verify-database-change.sh"

[[gates]]
name = "release-readiness"
action = "deployment"
check = "./scripts/verify-release-readiness.sh"
```

Supported action classes are `database`, `deployment`, and
`production_write`. A gate check must itself classify below full access, must
pass inside the repository, and runs before the consequential command. Missing,
malformed, non-read-only, or failing database gates refuse the action.

## Restart behavior and receipts

The daemon's append-only sync oplog stores exact model-facing checkpoints and a
separate supervised-action ledger. Checkpoints preserve every `Message` variant,
goal metadata, and compaction state. An action progresses monotonically through
`proposed`, `approved`, `dispatched`, and `completed`/`failed`; denial and
indeterminate outcomes are terminal.

On restart:

- an approved but undispatched action is dispatched once from its durable exact scope;
- a completed action is represented by its stored receipt and is not repeated;
- a dispatched action without a terminal receipt is marked `indeterminate` and is never automatically replayed.

CAR also maintains a hash-chained event journal and emits a `receipt_report`
before the terminal chat event. Its completion matrix keeps local verification,
remote-main state, CI/CD state, deployment identity, health, and browser-backed
production proof separate; an absent receipt remains an absent gate.
