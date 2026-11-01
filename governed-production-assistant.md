{% raw %}
# Governed production assistant

CAR's supervised assistant has an opt-in host mode for repository engineering:

```sh
car do --serve --governed-host --dir /absolute/path/to/repository
```

Run that command once from a terminal with CarHost running. It asks
`Install and start a governed Parslee Core for <repository> with CAR's
permission? [y/N]`; after a yes CAR registers and starts a repository-bound
supervised agent with CAR's local host key, then exits the setup process. Run
with no terminal, it never presents the key, so a CAR with a host key refuses
the registration (car#2444). The
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
watch it and take control. If CarHost is not connected (a pure command-line
session with no host app ever attached), the browser launches headed instead,
exactly as it always has. When a sign-in needs a human
(`browser_await_signin`) and CarHost is connected, or the browser has not
launched yet, macOS moves it into its own visible Chrome window that is not
flagged as automation, on this agent's persistent profile, so OAuth providers
that refuse automated browsers ("Sign in with Google") no longer refuse it. Once
the sign-in window opens, this agent keeps browsing in that visible window
until its process restarts, and `navigator.webdriver` is hidden only in that window. If CarHost
has disconnected from a headless browser, the sign-in ends at once telling the
user to open the CAR app. `CAR_BROWSER_HEADLESS` set truthy still keeps every
browser windowless, the sign-in included.

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

On macOS and Linux, every local assistant shell child also runs under CAR's OS
secret sandbox. The daemon `auth-token` and `host-token` files can be neither
read nor written, after path resolution, so a glob, symlink, `/dev/fd`,
subshell, or encoder cannot turn either file into tool output. CAR also checks
the protected files' inode link counts before spawning; a pre-existing hard-link
alias refuses the command rather than leaving a second readable name. If the OS
wrapper cannot be applied on those platforms, the local command is refused.
Exact token value redaction remains in the output path as a second layer.
The shell also loses the user-session services that would run a process for it
outside the sandbox, such as `systemd-run --user`; the car-server-core README's
"The assistant shell's OS sandbox" section lists what it loses and keeps.

Windows keeps the existing approval boundary and output redaction: approved
local shell commands still run without an OS file-read sandbox. Redaction
removes exact token values but cannot remove every encoded or split form. The
Windows OS boundary is tracked in car-96vm; until it lands, approval is the
boundary for that residual risk.

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

{% endraw %}
