{% raw %}
# `car code-task` — the headless coder contract

`car code` drives the coder through the daemon: sessions outlive the client and
several clients can watch one run. That is the right shape for a human at a
board and the wrong one for an outer orchestrator, which wants a coder session
as a plain child process it can hold, budget, kill, and read a stream from.

`car code-task` is that shape. It composes the same library pieces the daemon's
work loop composes — the session, the worktree executor, the native loop,
contract evaluation, and PR delivery — **in the calling process**. No daemon is
contacted and none needs to be running.

### What the model can call

The same tools either way. Both entry points build the session's executor with
`WorktreeExecutor::for_coder_session`, and the coding loop advertises that
executor's built-ins: the worktree file tools (`read_file`, `list_dir`,
`find_files`, `grep_files`, `write_file`, `edit_file`) plus the policy-gated
`shell`. The daemon additionally attaches the Parslee platform tools as a
*delegate*, but those reach a model only on the **agent-build** project kind —
building a declarative agent, which `car code-task` does not run — and only when
the generated agent's spec allowlists them. So an orchestrator driving a headless
run gets the same surface as a supervised `car code` run. Both also accept
`--browser`; without that explicit option, browser names are absent.

On top of the built-ins, the loop names the delegate tools it wants, one by one,
and nothing else: graph-memory `recall`, and — when you have granted it — the
two network tools below. The rest of what the executor carries stays attached but
unoffered.

**Governed network, gated on your say-so.** A coder session carries
`http_request` and `web_search`, the same host-side pair the assistant uses.
They are attached rather than withheld because withholding bought no
containment: the coder's `shell` can already run `curl`, and nothing inspects
it. What was missing was never egress — it was *governed* egress. These two pass
the coder inspector chain, so a `deny_tool` rule refuses them by name, and every
call lands in the event log, neither of which is true of `sh -c curl`.

They are closed until you open them. Both declare the `full_access` risk tier,
and the Balanced default posture resolves that tier to `RequireApproval`, which
a coder run hard-blocks because it has no interactive approval channel. The loop
checks the grant before building the prompt, so an ungranted session is shown
exactly the list it was shown before rather than two tools it would spend a turn
discovering it cannot call. To grant them, give the `car-coder` subject
`full_access` on the Agent Permissions screen — over the wire,
`agent_permissions.set` with
`{"agent_id": "car-coder", "tier": "full_access", "mode": "always_allow"}`.

**Browser access is explicit.** `car code --browser` and `car code-task
--browser` attach the same lazy `BrowserTools` integration the assistant uses:
`browse_navigate`, `browse_click`, `browse_type`, `browse_scroll`,
`browse_keypress`, `browse_wait`, `browse_observe`, `browser_await_answer`,
`browser_await_signin`, `browser_record_start`, and `browser_record_stop`.
Chromium is not launched until the model calls one. `car code --browser` makes
`--engine auto` select the native loop; pairing it with an explicitly external
or foreman engine is refused because those processes do not receive CAR's tool
registry. A headless `code-task` process has no CarHost drawer, so a sign-in uses the visible Chromium window;
tasks that must remain unattended should avoid authenticated flows.

The flag is a session-scoped approval for those exact full-access tool names.
It satisfies the normal `RequireApproval` posture, but an Agent Permissions
`Deny` still wins. Every call then takes the ordinary coder path: parameter
validation in the browser executor, the frozen built-in and operator policy
inspector chain, and the session's `tool_call` / `tool_result` event receipts.
Without the flag, no browser delegate is attached or advertised, so a model
cannot invoke it by guessing the name.

```bash
car code-task \
  --repo /path/to/repo \
  --intent-file ./intent.txt \
  --contract-file ./contract.json \
  --target-branch goalpool/g_mt81ewky \
  --pr-base main --draft --deliver pr \
  --workspace-dir ~/.cache/goals/g_mt81ewky --keep-workspace \
  --browser --json
```

### What governs the model's calls

Every model-proposed tool call and every outcome-contract check passes through
an inspector chain before dispatch. First Deny wins. Two sources feed it.

**CAR's built-in guardrails:** deny git-remote mutation, forge publication,
history rewrite, privilege escalation, credential access, environment repair,
destructive commands outside the worktree, and path escape.
`coder::policy::coder_inspector_chain` is the model-facing list. All are always
on for the model. Contract checks keep the same list by default; the explicit
`allow_credentials` contract field removes only credential access from the
check chain, as described below.

**The operator's declarative rules**, merged from two directories in this order:

1. `<CAR_HOME>/policies/*.toml` — machine-wide
2. `<worktree>/.car/policies/*.toml` — committed with the project

These are the same two locations, in the same order, that `car policy-check-hook`
and `car-mcp`'s `policy_check` read, so a rule written once governs Claude Code,
the assistant, the daemon, and the coder alike. Neither directory is walked
upward, matching `car do`.

Four properties worth knowing before writing a rule:

- **Rules can only ever narrow.** Every kind is a prohibition — `allow_tool_param`
  states its prohibition as an allowlist, denying every value of that parameter
  it does not name — so a rule file cannot widen what the built-in chain permits.
- **Delegate tools are governed too.** Delegate-owned names (the `parslee_*`
  surface and opt-in browser tools) bypass the worktree path-clamp, because they execute on another
  substrate, but they still pass the inspector chain. Otherwise a `deny_tool`
  rule would stop a built-in and silently miss the same session's delegate. The
  built-ins are inert for those names — each early-returns Allow for a tool that
  is neither `shell` nor a known file tool — so only a rule naming the tool
  exactly can refuse one.
- **A rule file that will not parse fails the session**, before any model turn
  or baseline check, rather than starting a session with the rule silently
  dropped. `trace_rule` is rejected the same way: it needs a dispatch-time
  `TraceGate` that nothing outside tests constructs, so admitting it would
  report *N rules loaded* with one of them inert.
- **Rules are read once, at session start, and frozen.** This is deliberately
  unlike `car policy-check-hook`, which re-reads on every call so an operator can
  add a rule mid-session. The difference is who can write the directory: the
  coder's rules live inside the worktree the model has a mandate to edit, and a
  per-call re-read would make `rm -rf .car/policies` a one-command bypass.
  Editing a rule mid-session therefore requires restarting the session.

A refusal names the built-in that matched before it names a project rule, since
first-Deny-wins decides which reason the model is shown and a built-in's reason
("destructive command outside the worktree") tells it what to do differently.

### What the model is told about the repository

Repository conversations, initial and revised check planning, and native execution
load the same repository context. Reopening a saved conversation refreshes this
context while preserving its prior messages. Repository guidance does not expand
tool permissions. These rules can make a diff unacceptable even when checks pass.

Constraints distilled from a conversation are saved with new tasks and rechecked
when checks are revised. If the drafting model leaves one without a check after
the repair attempts, the proposal discloses it for manual review. This coverage
assessment uses a model; it is not proof that every constraint is enforced.
Older saved tasks without recorded constraints retain their previous behavior.

- **Root instructions** — both `AGENTS.md` and `CLAUDE.md` at the worktree
  root, labelled by source. Both apply; display order does not assign precedence.
  Explicit delegation between files is followed, and unresolved conflicts require
  clarification before the affected action. Their combined content budget is
  96,000 bytes, shared so one large file cannot hide the other. Truncation names
  the file whose remaining rules must be read before editing.
- **Directory-scoped instructions** — nested `CLAUDE.md` / `AGENTS.md` files,
  each labelled with the subtree it governs. When directory rules conflict,
  the deepest applicable directory's rule wins inside its subtree. Sibling
  directories' rules do not apply elsewhere. Enumerated with `git ls-files`,
  so only tracked nested instruction files are included; untracked instruction
  files are ignored. Budgeted at 8 files, 6KB each
  and 12KB combined; past a budget the remainder are listed as paths to read
  rather than silently dropped.
  Root and nested instruction reads stay inside the repository: symlinks to
  repository files are supported, while links outside it and non-files are skipped.
- **Project skills** — `.claude/skills/*/SKILL.md`, indexed by name and
  description only. Bodies are ordinary files the model can `read_file`.
- **`.car/` knowledge** — identity and recorded team knowledge, up to 8KB.

These are framed in the prompt as review-time constraints that the contract does
**not** check, together with an instruction never to weaken a check to satisfy
one: the contract decides whether the work is done, these decide whether it is
acceptable.

A note for anyone raising the root cap: it is guarded by a test
(`the_repos_own_instructions_fit_the_cap`) that fails when CAR's own `CLAUDE.md`
outgrows it. That guard exists because the previous 24,000-byte value went stale
as the file grew and began cutting 800 bytes before the "hard rules" heading —
the coder on this repo was receiving every architecture note and none of the
rules, with only a byte count to say so.

## The property that matters

**The runtime, not the model, decides the work is done.** After the coding loop
finishes, the command re-runs the whole outcome contract itself in the worktree
and observes the exit codes. Only then can anything be delivered. The
`contract_evaluated` event carries `"by": "runtime"` and is emitted immediately
before `delivery_started`, so the log proves the ordering rather than asserting
it. A model self-report never reaches GitHub.

Delivery is host code, not a hole in the coder's tool policy. `git push`,
`gh pr create`, `gh release create`, `npm`/`cargo publish` and `docker push` are
all denied, and the forge CLIs are cut to a read-only allowlist (`gh pr view`,
`gh run view`, `gh api` GET) so the coder can still watch CI. The runtime pushes
and opens the pull request only after it has verified the work itself.

**This is hardening, not a sandbox, and the distinction is load-bearing.** The
inspector reads the verb in each shell segment, and the segment is then handed
to `/bin/sh`. Anything that moves the verb out of position — `sh -c '…'`,
`env`, `timeout`, a `$(…)` substitution, a `\gh` escape, an alias, a wrapper
script — is not caught, and neither is a delegated `car do "…push it"`, which
re-enters the assistant's own wider policy chain. A command-string matcher
cannot enforce an any-route property against an unrestricted shell, and
claiming otherwise here would be the same shape of defect as the gap it
describes: a stated boundary the enforcement does not implement.

What the deny-list buys is that publication cannot happen *by accident* or by
the obvious spelling. The property that does not depend on out-lexing `/bin/sh`
is **credential separation** of the environment, and that is now in place:
the model's shell removes every name from `$CAR_HOME/env`, every provider credential name CAR
declares, CAR's auth-token names, and every inherited credential-shaped name.
It also removes `GH_TOKEN`/`GITHUB_TOKEN` (and their enterprise spellings),
points `GH_CONFIG_DIR` at an empty directory, and overrides git's
`credential.helper` to empty for that child.

Every publication route then fails on **authentication** rather than on being
recognised — `gh pr create`, `curl` to `api.github.com`, `\gh`, `sh -c '…'`,
and a delegated `car do "…push it"` alike. Environment removal is inherited by
the whole process tree, which is what covers the routes the matcher cannot see.

Delivery is unaffected: `coder::merge` is host code that builds its own `gh` and
`git` argv outside the model's shell and keeps the real credential. The runtime
publishes; the model cannot.

**One deliberate cost.** The read allowlist (`gh pr view`, `gh run view`,
`gh api` GET) is still permitted by policy, but on a **private** repository
those calls now fail unauthenticated, so a session cannot watch its own CI
there. Public repositories are unaffected. Restoring it would mean either
provisioning a scoped read-only token for the coder shell, or moving CI
observation into host code the way publication already is — both larger changes
than this one, and neither is done.

**A contract check inherits no credential from the daemon's environment and
receives only declared, operator-approved environment credentials. The model
shell inherits none and has no injection path.**

The scrub is paired with the secret sandbox described below. On macOS,
Seatbelt still cannot mediate `sysctl(KERN_PROCARGS2)`: a same-user process can
read a sibling's argv and environment through that API even though `ps`,
`proc_pidinfo`, and `lsof` are blocked. CAR therefore keeps tokens out of daemon
argv and denies the daemon's sockets and TCP ports so a token recovered through
that macOS gap is unusable from inside the sandbox. Do not claim macOS blocks
all peer-process argv or environment reads.

**Delivery refuses an approved value.** Before a branch is committed, the
staged tree is searched (`git grep --cached`, value passed on stdin) for every
credential value resolved for an approved check in this daemon process. A match
fails the session with a delivery failure that names the credential and files,
never the value. `car coder-ab` applies the same check to `delivered.patch` and
fails the attempt without writing the patch.

At each local spawn, CAR removes the union of names from `$CAR_HOME/env`,
built-in model/provider declarations, explicit CAR secret and auth-token
constants, and inherited names ending in a credential suffix such as
`_API_KEY`, `_TOKEN`, `_PASSWORD`, or `_PRIVATE_KEY`. PATH, HOME, locale,
terminal, shell, temporary-directory, and toolchain variables remain. The
`car do` assistant is a separate caller and keeps its existing inherited
environment behavior.

A check asks for an environment credential with `credentials`:

*The inspector chain.* By default a check and the model's shell both go through
`DenyCredentialAccess`, which matches substrings in the **command text**:

- `_key`, `_token`, `_secret`, `_password`, `openai_`, `anthropic_`,
  `azure_client_`, `github_token`, `connection_string` (case-folded)
- the path segments `/.ssh`, `/.aws`, `/.gnupg`, `/.kube`, `/.car/secrets`,
  `/.netrc`, wherever they appear once `~/`, `$HOME/`, `%USERPROFILE%\` and
  `%HOMEPATH%\` are normalized — not only under a home directory. These are
  matched case-sensitively, unlike the substrings above, so `~/.AWS` is not
  denied
- keychain and Windows Credential Manager tooling: `find-generic-password` and
  `find-internet-password` (matched case-sensitively), `cmdkey` and `vaultcmd`
  (case-folded)
- dumping the environment with `printenv`, a bare `env`, or a bare `set`

A caller-supplied or user-edited contract may opt in at contract scope:

```json
{
  "description": "staging emits the repaired telemetry",
  "allow_credentials": true,
  "checks": [
    {
      "name": "telemetry",
      "command": "az monitor app-insights query …",
      "credentials": ["AZURE_CLIENT_SECRET"]
    }
  ]
}
```

`credentials` declares need; it never grants access. A caller-supplied
contract (including `--contract-file`) approves its declarations because the
contract itself is operator-authored. For a proposed daemon contract,
`coder.confirm` may add `approved_credentials: ["AZURE_CLIENT_SECRET"]` to
that exact payload check. Approval is keyed by check name and command, is
intersected with the declaration, and is lost when the name, command, or
declaration changes. Model-derived and model-revised checks never approve
themselves.

An unapproved declaration fails without executing and records
`credentials_withheld`. An approved name resolves from the CAR secret store
first, then `$CAR_HOME/env`; the daemon process environment is never a source.
An unresolved approval also fails without executing. Resolved values are
injected only after scrubbing, into that child only. Exact occurrences printed
by a check are replaced with `[REDACTED:NAME]` before output, events, session
snapshots, journals, or evidence files persist.

`allow_credentials` remains a separate command-policy switch. It defaults to
`false`; when true, every check in that contract uses a frozen twin of the
session's inspector chain with only
`DenyCredentialAccess` removed. Forge publication, history rewrite, privilege
escalation, destructive commands outside the worktree, path escape, environment
repair, and every machine/project `.car/policies` rule remain in the same order.
It does not approve or inject a credential. The model's own `shell` always
uses the full chain and has no credential-injection path.

Every `CheckResult` records `credentials_allowed`, `credential_sources`
(name to value-free source label), `credentials_withheld`, and
`network_isolation` plus `secret_isolation` and `keychain_access`,
including baseline results and `check_completed` / `contract_evaluated`
events. These are the effective policies used for that execution, not an
inference from the current contract.
Its human rerun line resolves each approved value at execution time as
`NAME="$(car secrets get NAME --check-credential)"`; no credential value is
embedded in the result.
It also records `cwd` and an `env` map containing only non-secret values CAR
injected for the check, including `CAR_CHECK_EVIDENCE_DIR`,
`CAR_CHECK_TMPDIR=<CAR_CHECK_EVIDENCE_DIR>/tmp`,
`CAR_HOME=<CAR_CHECK_EVIDENCE_DIR>/car-home`, the session's
`INTERCEPTOR_GROUP=cc-<session-id-prefix>`, and the effective `PATH` resolved
after the login-shell profile and CAR's inherited-PATH prepend. CAR creates the
per-check scratch and CAR home directories before dispatch. The operator's
`TMPDIR` remains inherited so tools can discover host services whose socket and
lock files live there. On macOS, sandboxed checks prepend a write-protected
`mktemp` shim to `PATH`. Bare calls, `-d`, `-q`, `-u`, and `-t prefix` gain
`-p "$CAR_CHECK_TMPDIR"`; calls with an explicit template or `-p` pass through
unchanged. The shim reaches nested scripts and execs root-owned
`/usr/bin/mktemp` directly, so a builder-planted `mktemp` later on `PATH` cannot
run. It uses `-p` because macOS `mktemp` ignores `TMPDIR` for an implicit
template and uses the per-user Darwin temp directory. Other POSIX platforms
retain the top-level shell prelude; Windows `cmd /C` receives neither mechanism.
A bare executor with no evidence directory
receives neither isolated variable. The result does not snapshot any other
inherited process environment.

The isolated `CAR_HOME` moves CAR's coder state, auth-token directory, and
`run/` socket and lock beneath the check evidence. CAR also removes inherited
narrower CAR state, profile, project, socket, daemon-endpoint, and daemon-token
overrides that would point back at operator state; `HOME` remains inherited for
toolchains. A check that needs a CAR daemon must start its own. That daemon and
clients in the same check share the isolated `CAR_HOME`; the operator daemon's
token is not available to the check.

CAR applies one composed OS sandbox to every coder-model shell and local
contract check. Builder children in trusted and untrusted repositories also
receive a write allowlist: the worktree; Git's object, ref, reflog,
`packed-refs`, and current linked-worktree administrative paths; the session's
private Cargo home and target; private temporary, SwiftPM, Clang module, npm,
pip, XDG, and Bun caches; and that session's shell/check evidence directories.
The Git common directory remains closed, so builder writes cannot reach its
`config`, `hooks`, or `info`. `TMPDIR`, `CAR_CHECK_TMPDIR`,
`CARGO_TARGET_DIR`, `CLANG_MODULE_CACHE_PATH`, and the package-manager cache
variables point into the session-private state. SwiftPM's PATH shims pass its
supported `--cache-path`, `--config-path`, and `--security-path` flags; plain
`swift --version`, `swift -frontend`, and `swiftc` receive none of them.
Swift Build also creates Foundation atomic-save directories under the Darwin
user temporary directory instead of `TMPDIR`. On macOS CAR therefore admits
only `TemporaryItems` and randomized `TemporaryDirectory.*` descendants there.
Those directories are exclusively created and consumed by one build; shared
lookup caches such as `xcrun_db*` remain write-denied, so `xcrun` may print a
cache-write warning on a cold lookup without widening the boundary.

Protected baseline and verifier checks do not execute tools from the merged
login PATH directly. CAR puts the trusted Cargo/rustup proxy directory first,
then keeps merged entries whose canonical path and every ancestor are owned by
root, are not group- or other-writable, and are not writable by the runner.
An already-present Homebrew `bin` or `sbin` is appended after those system
directories only when builder write confinement is enforced and the prefix
overlaps no builder-, verifier-, or CAR-writable root. Homebrew is
operator-writable, but no confined builder can write it and no builder spawn
may run unwrapped; operator processes are inside the trust boundary. This does
not cover pre-fix builder poisoning or an unconstrained platform, which is why
CAR checks confinement at run time. Other user-writable, relative, empty, and
`seats/bin` entries are dropped and recorded in check evidence. Each protected
Swift run also gets a fresh empty SwiftPM cache/config/security root and Clang
module cache under that check's private state.

Protected Cargo checks use one stable Cargo-home path per Git repository under
CAR's runtime-owned state root, next to the repository-keyed trusted baseline
target store. Builders are write-denied that path. A baseline publisher or
verifier `run_check` takes its exclusive lock for the whole check, removes the
previous materialization, and recreates it without credential files from the
pristine operator Cargo home. Consequently two protected checks never observe
one another's Cargo-home writes, while Cargo sees the same registry source path
and can reuse target fingerprints. Protected checks for the same repository
serialize; inability to obtain the lock within that check's remaining timeout
is an infrastructure failure, not a red contract result. macOS uses CoW clones
where supported. Linux hosts without CoW retain the existing cold
empty/full-copy behavior, but at the stable path.

The protected `CARGO_TARGET_DIR` remains a fresh check-private copy seeded from
the stable trusted target store; Cargo does not record that target-directory
path as a registry source identity. `RUSTUP_HOME` is the stable, shared,
read-only toolchain root. The check tree itself remains fresh, with workspace
members addressed relative to that root, and CAR injects no variable
`--remap-path-prefix` into protected checks.

Daemon-owned Git in builder-shared and verifier trees passes
`-c core.fsmonitor=false -c core.hooksPath=/dev/null`, preventing repository
configuration from executing builder-controlled programs. CAR does not set
`protocol.file.allow=never`: freezing a verifier tree legitimately performs a
local `clone --bare --no-local` from the session repository.

On macOS the composed profile denies read and write access to the daemon's
`$CAR_HOME/env`, `run/` tree, auth-token directory, configured file-secret
directory, and the user's Keychains directory; denies Unix-socket connections
under the run/token directories; denies the daemon's registered TCP listener
ports; blocks SecurityServer/securityd lookup; and denies `process-info` for
other processes. Raw and canonical paths are both denied. Checks without
explicit network approval also deny non-loopback outbound network. The remaining macOS gap is
`sysctl(KERN_PROCARGS2)`, which Seatbelt does not mediate; see the paragraph
above.

On Linux the wrapper uses user, mount, and PID namespaces with a private
`/proc`. It first gives each write-allowed root its own bind mount, then
remounts every other filesystem mount read-only while preserving `nosuid`,
`nodev`, and `noexec`; it separately restores the permitted `/dev` devices.
It also overlays each existing secret directory with a mode-000 tmpfs and
bind-mounts `/dev/null` over each existing secret file. Any failed setup mount
exits 125 without running the check. Checks without explicit network approval
also receive a network namespace. Model shells and network-approved checks run without `--net`, so
loopback TCP to the operator daemon remains reachable on Linux; the token/run
files and peer `/proc` state remain hidden. Windows and other platforms have no
secret sandbox.

Supervised agents remain separate from coder children and continue receiving
`CAR_AUTH_TOKEN` or `CAR_AGENT_TOKEN` in their environment. A macOS coder child
may recover a sibling value through the `KERN_PROCARGS2` gap, but its daemon
endpoint is denied. On Linux the coder child's private PID namespace hides the
supervised process and its environment.

The exact composed profile is probed once per process/posture. If it cannot run
(including inside a parent sandbox), macOS and Linux refuse the local command
instead of spawning it unwrapped; the failed check records
`secret_isolation: "unavailable"`. A CarCoder builder also refuses a platform
that cannot enforce its write allowlist; a successfully wrapped check records
`"sandboxed"`.
`network_isolation` remains `"sandboxed"`, `"unwrapped_approved"`, or
`"unavailable"`; `"unwrapped_approved"` means only the network restriction was
omitted, not the secret sandbox. Network approval is tied to the exact check
name and command, so editing a command removes it.

The proposal filter is deliberately narrower than the runtime isolation. It
holds commands whose own command words are recognized network tools or network
verbs, plus commands containing `http://`, `https://`, `ftp://`, `/dev/tcp`, or
`/dev/udp`. It still follows nested shell `-c`, `eval`, and AppleScript `do shell
script` commands. It does not inspect Python, Node, Ruby, Perl, awk, heredoc, or
redirected interpreter bodies for networking keywords; those checks remain in
the contract and the OS sandbox enforces their network boundary. A recognized
network check without approval is moved to `Not verified by this contract`
before baseline, confirmation, execution, or restart adoption. It is never run
and never aborts the session merely because approval is absent.

Without the opt-in, read `DenyCredentialAccess` as command-text hardening.
The environment boundary does not depend on its spelling: inherited
credential-shaped variables are scrubbed either way, and a declared name is
injected only after exact operator approval.

### What a contract can and cannot assert

A point-in-time check asserts two things about one shell command: that it
exited zero, and that its combined output contains a substring. The *schema*
therefore has no comparison operator — but the command runs through a shell
(`sh -lc` on Unix, `cmd /C` on Windows) and is graded on its exit code, so a
threshold is writable today, and against a live system: on a POSIX host
`[ "$(psql -tAc 'select count(*) from orphans')" -lt 100000 ]` is a legal check.
Reach is not the limit, and neither is arithmetic.

**Before/after claims are expressible too** (car#1067). A check marked
`"baseline": true` is a *capture*: it runs once, at session start, during the
same baseline pass that detects a contract gating nothing, and its output
(the 4 KiB tail — keep a capture's output down to the one value that matters:
a count, a digest, a `curl` body) is kept as the before-value. A check carrying
a `"differential"` runs at every later evaluation, and the RUNTIME compares its
output against the named capture — the claim is exactly one of:

- `"changed"` — the output must differ from the capture ("this trace now
  appears and did not before", "the heartbeat flipped");
- `"unchanged"` — the output must be identical to the capture: the
  control-group claim ("the other tenant's rows did not move");
- `{"delta_within": {"min": …, "max": …}}` — both outputs carry a number and
  `after - before` must fall inside the stated bounds (either side optional,
  at least one required). "Orphaned rows fell by at least 100" is
  `{"max": -100.0}`.

```jsonc
{
  "description": "orphan cleanup works and the control tenant is untouched",
  "allow_credentials": true,
  "checks": [
    { "name": "orphan_rows", "command": "psql -tAc 'select count(*) from orphans'",
      "baseline": true },
    { "name": "control_rows", "command": "psql -tAc 'select count(*) from tenant_b'",
      "baseline": true },
    { "name": "orphans_fell", "command": "psql -tAc 'select count(*) from orphans'",
      "differential": { "baseline": "orphan_rows", "expect": { "delta_within": { "max": -100.0 } } } },
    { "name": "control_unmoved", "command": "psql -tAc 'select count(*) from tenant_b'",
      "differential": { "baseline": "control_rows", "expect": "unchanged" } }
  ]
}
```

Declare captures before the differentials that reference them; validation
rejects a differential naming a capture that does not exist, is not marked
baseline, or is declared after it, a `delta_within` with no bounds, and a
contract that is captures only. Both executions are runtime-owned — the capture
lands in the baseline results, the comparison in the check's own result, and a
failed differential's message names what was compared and how it missed. Model
claims count for nothing on either side, and a differential evaluated without
its capture fails closed rather than passing silently. At the baseline pass
itself the differentials are evaluated against the values captured moments
before, which gives the red-green story the honest reading: `changed` and a
moving `delta_within` are red before any work, while `unchanged` — the control
group — is green and must stay green. The external subject falls out of the
command being arbitrary, subject to the contract's effective policy chain —
what was missing was the before/after structure, not a transport.

What is still missing is an **evaluation point past delivery**. Every
evaluation is on this side of it: once against the unmodified worktree
before the loop, once per repair round inside it, and once as the gate that
admits delivery. Under `car code-task` that gate is a distinct re-run the
runtime performs after the loop, deliberately treating the loop's own verdict as
advisory; a daemon session has no separate re-run, and the loop's final
evaluation is the gate. Either way nothing is evaluated after.

So a contract can now say "fewer than before" — across the session's own work —
and still cannot say "fewer after the deploy this session does not perform".
The orphaned-rows table going from 435,594 to 76,330 *after a deploy*, or a
heartbeat flipping *once the new build is serving*, is a claim about a window
the session does not own; it belongs to the orchestrator wrapping
`car code-task`, which owns the deploy and therefore owns both sides of it.
One practical consequence: under `car code-task` the differential gate
currently evaluates with the captures of the in-process session that made them
— a `--contract-file` with baselines captures them at that run's own start,
never from an earlier invocation.

One caveat on outward-reaching checks: they are still policy-inspected. A check
runs through the same `.car/policies` inspector chain as the model's own shell,
so a project `deny_tool` rule can refuse it — the credential differs, the
governance does not. Optional operator caps from `--max-check-timeout-secs` and
`--max-session-wall-secs` also apply when set, so a check that polls a real
system can be starved rather than answered.

## Flags

| Flag | Meaning |
|---|---|
| `--repo <PATH>` | Repository to work in. Resolved to its top level; must be a git repo. |
| `--intent-file <PATH>` / `--intent <STRING>` | The task. Exactly one. |
| `--contract-file <PATH>` | JSON `OutcomeContract`. **When present, derivation does not run.** A check may declare `credentials: [ENV_NAME]`; because this file is operator-supplied, those exact declarations are approved. `allow_credentials` separately removes only `DenyCredentialAccess` from check command inspection. Each check remains capped at `--max-check-timeout-secs`. See [The contract](#the-contract). |
| `--target-branch <NAME>` | Delivery branch, stable across sessions. Required for `--deliver pr`. |
| `--pr-base <NAME>` | PR base. Defaults to the repo's default branch. |
| `--body-prefix <TEXT>` | Trusted caller-supplied text placed verbatim at the start of the generated PR body. The model cannot edit it. Intended for stable orchestrator markers such as `<!-- car-selfheal:key=… -->`; do not pass untrusted model output. |
| `--draft` | Open the pull request as a draft. |
| `--deliver <MODE>` | `pr` \| `branch` \| `none`. Defaults to `pr` with a target branch, else `branch`. Pull-request delivery selects GitHub for `github.com` origins and Azure DevOps for `dev.azure.com`, `ssh.dev.azure.com`, and `*.visualstudio.com` origins. GitHub requires an authenticated `gh` CLI; Azure DevOps requires the `azure-devops` extension for `az` plus `az login` or `AZURE_DEVOPS_EXT_PAT`. Set `CAR_CODER_FORGE=github` or `CAR_CODER_FORGE=azure-devops` for a self-hosted or otherwise unrecognized origin; an unknown origin fails before the delivery commit or push and names that override. GitLab, Bitbucket, and other forges are not supported. Use `branch` when an external orchestrator will open the review artifact. `branch` publishes a clean worktree whose HEAD is ahead of the base as a re-delivery, the same as `pr`; it fails only when the base already contains HEAD. |
| `--model <ID>` | Pin the inference model. The pin governs every contract-derivation lane, and an unparseable-reply retry re-asks that model instead of rotating away from it. |
| `--max-iterations <N>` | Optional explicit operator cap on contract-evaluation rounds. The default is unbounded (`default_max_iterations` unset or `0` in `~/.car/coder.toml`). Exhaustion is persisted as `failure_kind: "budget_exhausted"` and names the used iterations and cap. |
| `--max-session-wall-secs <N>` | Optional explicit operator cap on the baseline, loop, and runtime re-run. The default is unbounded (`max_session_wall_secs` unset or `0`). Exhaustion is persisted as `failure_kind: "budget_exhausted"` and names elapsed time and cap. |
| `--max-check-timeout-secs <N>` | Optional explicit operator ceiling for **one** contract check. The default is unbounded (`max_check_timeout_secs` unset). A check that reaches the cap is killed and judged red. The model's own `shell` tool keeps its separate ceiling regardless. |
| `--silence-window-secs <N>` | Stop the run when nothing makes progress for this many seconds. Default `900`; `0` disables it. A silent check is killed and judged red. A silent session ends `stalled`; an external or foreman CLI that streams output for one window without changing its pinned worktree ends `no_progress`. Streamed lines alone are not progress. |
| `--workspace-dir <PATH>` | Stable per-goal workspace. Reused when it is already a worktree of this repo. |
| `--keep-workspace` | Keep the workspace on any non-zero exit, and on a green `--deliver none` run. A deadline-starved post-loop gate is always retained because the loop already verified that tree green; a stalled run is always retained for diagnosis. |
| `--transcript <PATH>` | Mirror the JSONL stream to a file. A path that cannot be created or opened is a `config_error` refusal before any spend — never a silent downgrade to no transcript. |
| `--json` | Emit the JSONL stream on stdout, one compact object per line. |

The three cap flags and their config keys are opt-in operator policy; none has a
finite default. External-agent invocations likewise have no default wall-clock
stop; the silence watchdog and no-progress rule govern them unless an explicit
session cap supplies the remaining timeout. An explicit cap remains
authoritative. Separately,
`no_progress_turn_limit` defaults to `30`: that many agent turns whose actions
change nothing ends the run with `failure_kind: "no_progress"`. Set it to `0`
to disable the native-loop rule. External and foreman engines instead compare
the worker's Git status-plus-diff fingerprint at most every five seconds. A
streamed line does not count as progress; a worktree change does. Output inside
the silence window that just elapsed ends `no_progress`; no output inside that
window ends `stalled`, even if an older line preceded it. Setting
`silence_window_secs` to `0` disables both outcomes. A
non-JSON run prints its terminal label and reason to stderr; `run_end` carries
the same reason and retained workspace path.

With red checks, a headless native session keeps iterating until it succeeds or
ends through `NoProgress` (the idle-iteration guard or session no-progress turn
guard), the silence watchdog, cancellation, or a genuine infrastructure,
authentication, or configuration failure. A repeated-read trip ends only that
attempt. If the worker itself reports an execution error, the session records
`failure_kind: "error"` with that text followed by the final red-check summary.

Output from a command the native builder runs through its own `shell` tool, and
from the verifier's `shell` probes and `run_check` runs, keeps the session
alive the same way contract-check output does: each chunk resets the silence
window, so a fifteen-minute build that prints throughout is never killed as
silent. A command that stops printing for a full window is still killed and the
session still ends `stalled`. That output is liveness only. It never counts as
a worktree change, so a builder that prints on every turn but changes nothing
still ends `no_progress` at `no_progress_turn_limit`.

## Exit codes

| Code | Meaning | What an orchestrator should do |
|---|---|---|
| `0` | Contract green and delivery succeeded (or `--deliver none`), **or** the session correctly concluded no code should change. | Progress. Read `status` to tell the two apart: `delivered` shipped a diff, `reported` shipped a conclusion. Do not retry either. |
| `1` | Work not done: the contract stayed red, an explicit operator cap was exhausted, the session stalled, or the no-progress rule fired. | Read the terminal class and persisted `failure_kind`. A `stalled` run keeps its workspace for diagnosis; `budget_exhausted` names usage and cap; `no_progress` names either the native unchanged-turn limit or the external unchanged-chatter window. |
| `2` | Retriable infrastructure, **or** an already-satisfied request. | Read `failure_class`: requeue infrastructure; do not retry `already_satisfied`. |
| `3` | Non-retryable — bad invocation, unusable contract, missing credential, a vacuous contract, **or** a no-change finding that needs a human this command cannot reach. | Park it and quote the failure class. For `finding_needs_review`, a person reads the finding; re-running changes nothing. |

`run_end.failure_class` ∈ `none` · `contract_not_green` · `delivery_failed` ·
`task_max_turns` · `session_wall_exhausted` · `stalled` · `no_progress` · `infra_setup` · `infra_inference` ·
`config_error` · `already_satisfied` · `car_bug` · `finding_needs_review`.

| Persisted `failure_kind` | Trigger | Exit |
|---|---|---|
| `budget_exhausted` | An explicit iteration or session-wall operator cap is exhausted. The reason names elapsed/used and cap. | `1` |
| `stalled` | No runtime-owned progress for `silence_window_secs`, with no streamed external output during the window; the reason names the check, tool, model call, or runtime step. | `1` |
| `no_progress` | Native: `no_progress_turn_limit` turns change nothing while work remains red. External/foreman: the silence window that just elapsed contains streamed output but no worktree fingerprint change. | `1` |
| `already_satisfied` | The repaired derived contract's ordinary checks all pass on untouched code. The session is `abandoned`; every passing check is named in `run_end.error`. | `2` |

## When the right answer is to change nothing

A session that investigates correctly and concludes no code should change used
to have nowhere to land: the only non-failure terminal required a diff that
turned a contract green, so restraint scored as a loss and an orchestrator
branching on exit codes was told to retry a task that was answered the first
time. That pressure is worst exactly where restraint matters most.

The model can now call **`report_no_change`** with a `kind`
(`premise_wrong` · `deliberate_behavior` · `non_code_decision`), a `summary` and
`evidence`. This is a **nomination, not a verdict** — the tool cannot set a
terminal state. The runtime judges it against facts it collected itself, and
almost every branch of that judgement is a refusal:

- **A session that ever edited is ineligible**, and reverting does not restore
  eligibility. Mutation history is monotonic, deliberately: otherwise "try, fail,
  revert, declare the premise wrong, exit 0" is a laundry for any hard task. A
  `shell` call is judged by effect — the worktree is fingerprinted either side —
  so investigating with grep, builds and tests costs nothing, while a shell that
  actually writes disqualifies the session exactly as `edit_file` would.
- **The worktree must be pristine right now**, and if git cannot answer, that is
  not a clean bill of health.
- **The baseline must have completed.** A run the session clock cut short is not
  evidence of anything.

Only one path terminates without a human, and every conjunct is load-bearing:
the kind is `premise_wrong`, **every** check of the contract passed against the
untouched baseline, **and** the contract is trusted. Then the run ends
`status: "reported"`, exit 0.

**Trusted** means the bytes came from somewhere other than this session's model
— `--contract-file`, a human-confirmed contract, or a runtime-generated
reproduction. A contract the model derived itself is never trusted at any tier,
because a model citing its own checks as proof it need not work is precisely the
escape hatch this gate exists to close. That is also why an issue body cannot
mint one: on a public tracker it is attacker-controlled text.

Everything else — both judgement-shaped kinds, and `premise_wrong` without a
trusted green baseline — is recorded and routed to a person. Headless, that is
`finding_needs_review` at **exit 3**, never exit 0: a pending approval is not a
verified result.

`delivery_failed` and `contract_not_green` are **distinct and never conflated**:
a green contract whose push was rejected reports `delivery_failed`, and under
`--keep-workspace` reports `workspace_kept: true`, so the next round re-delivers
the same work instead of redoing it. Without `--keep-workspace` the worktree is
reaped and the next round redoes the session.

### A starved gate is not a red contract

When an operator sets a session wall-clock cap, that clock is never allowed to
interrupt an iteration mid-flight, so the loop can finish *just past* its ceiling: the last round is admitted at
t=3580, returns green at t=3720, and the runtime's own contract re-run then
starts with zero budget left. Each check's `timeout_secs` is clamped to what
remains, floored at one second, so a `cargo test` check is killed after a second
through no fault of the change.

That is a run that ran out of time, not a change that failed. When **every**
failing check in the runtime's re-run was killed by the session clock — each one
reporting `timed_out: true` *and* `deadline_clamped: true` — the run reports
`failure_class: "session_wall_exhausted"`, preceded by a `budget_exhausted`
event naming the mechanism. It never reports `contract_not_green`. Nothing is
delivered either: the gate produced no green, and the loop's own results are
advisory by design.

The rule is **all**, not **any**. A check that exited non-zero inside its own
timeout is a genuine red verdict and keeps the run on `contract_not_green`
however many of its siblings the clock starved — otherwise one starved check
would launder a real failure into a budget excuse. A check that blew its *own*
`timeout_secs` (`timed_out: true`, `deadline_clamped: false`) is likewise a real
red: a hang is a defect.

"Its own timeout" means the **effective** ceiling. A check's explicit
`timeout_secs` is further clamped by `max_check_timeout_secs` only when the
operator sets that optional flag/config key. With both omitted, the check has no
total-duration ceiling; the `900`-second silence watchdog is the default guard
against a genuine hang. A check that declares `timeout_secs: 900` therefore gets
its full declared duration unless an explicit check or session cap is lower.
The model's own `shell` tool keeps its separate ceiling regardless.

The reclassification also yields to the loop's own verdict. If the loop itself
ended on a named machinery or configuration fault — an exhausted inference retry
chain (`infra_inference`, exit 2) or an expired token (`config_error`, exit 3) —
that class stands even though the gate that followed it was equally starved.
Only a loop that reached no verdict of its own, or one purely about the work
being red, can be reclassified as `session_wall_exhausted`. A missing credential
must not surface as a budget problem: for these two failure classes, exit 2
still means requeue and exit 3 still means park it.

The workspace is retained on this path even without `--keep-workspace`, and
`run_end` reports `workspace_kept: true` plus its `workspace_path`. The loop had
already verified that tree green; deleting it because the runtime exhausted the
budget for its own second verdict would destroy finished work. This is the one
exception to the flag's ordinary failure-retention policy.

A missing GitHub or Azure DevOps credential is **not** a `delivery_failed`, and neither is
either delivery-head refusal — an ambiguous head, or a closed pull request into
this round's base (see Delivery semantics ▸ 2). All are checked before any work,
so nothing has been coded and no workspace exists; all report `config_error`
(still exit 3). The `delivery_failed` playbook — "green work
exists on disk, retry the delivery only" — has nothing to act on here. The
`delivery_failed` event that precedes either still carries
`stage: "preflight"`. A forge's pull-request listing that *fails* at the
preflight is not a refusal: only a positive answer parks a run, so the round
proceeds and delivery reports the listing failure as `stage: "pr", retriable: true`
if it persists.

## Check evidence

Every contract evaluation writes check output beneath
`<state dir>/<session-id>/evidence/<evaluation-n>/<check-name>/`: `stdout.txt`,
`stderr.txt`, `result.json`, and any artifact the check writes through
`$CAR_CHECK_EVIDENCE_DIR`. Each check also receives a pre-created `tmp/` below
that directory as `CAR_CHECK_TMPDIR`. On macOS, the runtime's write-protected
PATH shim redirects implicit-template `mktemp` calls there while leaving host
`TMPDIR` unchanged for daemon discovery; nested scripts inherit the PATH and
receive the same behavior. Other POSIX platforms retain the top-level shell
prelude. Scratch output is retained, capped, and scrubbed
with the rest of the check evidence. Evaluation numbers cover the
baseline, each repair round, and the final gate in order. Text evidence uses the feedback-bundle
redaction scrub up to 64 MiB per file; any larger stream or text artifact is replaced
with a placeholder instead of being retained unredacted, while a larger binary
artifact is kept as it always was. `output_tail` keeps
its type and size bound but is redacted with the same scrub before it is emitted
or persisted.

Before a contract check runs, CAR lexically checks redirections, `tee`,
`-o`/`--output`/`--out`/`--output-file`/`--path` values, and `cp`/`mv`/`install`
destinations. It denies targets outside the worktree (or its baseline copy) and
the check's evidence directory, then records the denial as the failed check and
in `stderr.txt`. `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, and paths
under `$CAR_CHECK_EVIDENCE_DIR`, `$CAR_CHECK_TMPDIR`, or `$CAR_HOME` are
allowed. A write through `$TMPDIR` is denied because it names the host temp
directory, outside the worktree and evidence roots. A variable assigned
directly from `$(mktemp)`, `$(mktemp -d)`, or the equivalent backtick form is
treated as contained for writes to the variable itself (and descendants for
`-d`). An explicit outside template such as `mktemp /tmp/x.XXXX`, an explicit
`/tmp/x`, `$HOME/x`, `../x`, or `/etc/x` remains denied. The same inspector and
representative baseline/evidence context run during contract admission, so a
denied model proposal enters repair before review; a still-denied check is kept
under Not verified and removed before baseline. This checks those recognizable
shell patterns; it is not a sandbox.

In any coder shell command, whether from the model or a contract check, every
`interceptor` browser verb must carry exactly one literal
`--context interceptor-test`. A missing `--context` is denied because
Interceptor auto-routes it to whichever single profile remains, which may be the
operator's own. Any other value, and any environment-variable or command
indirection, is denied too. Checks therefore drive the isolated profile opened
by Interceptor's `LaunchTestProfile.sh`. `interceptor --version`, `status`,
`help`, and CarHost `macos` window automation such as
`interceptor macos trust --no-prompt` remain available without a context. If
Interceptor is not running, the check fails with Interceptor's own error in
`stderr.txt`.

The same `INTERCEPTOR_GROUP=cc-<session-id-prefix>` is injected into every
model-facing `shell` command in the session, not only runtime-owned contract
checks. Labels keep at most 24 valid session-id characters and hash short or
otherwise unusable ids, so they remain stable and never exceed Interceptor's
32-character limit. A bare executor created without session context injects no
group.

After every baseline, repair-round, and final evaluation pass whose contract
contains an Interceptor command, `car code-task` starts a detached cleanup task
that runs
`interceptor group close cc-<session-id-prefix> --context interceptor-test`.
The evaluation returns as soon as its results exist; it never awaits cleanup.
The same detached, 15-second-bounded cleanup starts once more after a daemon or
`car code-task` session has durably entered merged/delivered, reported, failed,
abandoned/cancelled, or stalled; restart adoption persists the orphan's failed
state before starting its one cleanup. Session-end cleanup is skipped only when
the contract has no Interceptor check and no model shell invoked Interceptor.
Cleanup never changes an evaluation verdict or terminal state. The JSONL stream records
`interceptor_group_close {group, success, detail, trigger}` with `trigger` set
to `contract_pass` or `session_end`; `success: false` carries the redacted
spawn, timeout, or non-zero-exit failure. At process exit, `car code-task`
waits at most two seconds total for unfinished cleanup tasks. It then exits
without killing a still-running Interceptor child and appends a journal-only
close event with `success: false` and `detail: "not awaited at exit"`; the child
can finish independently.

If a check's latest output says Cargo is `Blocking waiting for file lock`, or
says it is `waiting for` or `waiting on` the build lock, CAR appends
`[runtime] still waiting on the build lock (Ns)` every third of the silence
window and counts that line as progress. The silence watchdog therefore leaves
a check queued behind another build running, while the check's own timeout
still applies.

At every terminal outcome, `car code-task` writes `Evidence: <session evidence
dir>` to stderr. If the directory exceeds 1 GiB it also writes one
`warning: evidence directory is <human size> (over 1 GiB): <dir>` line without
changing state or exit code. It then writes `rerun <check-name>:
<copy-pasteable shell line>` for every failed check in the latest evaluation.
Those lines restore the recorded working directory and CAR-injected
environment, including the check's `CAR_CHECK_TMPDIR`, isolated `CAR_HOME`, and
exact effective `PATH` before invoking the command, so tool resolution
matches the original check. A sandboxed result includes the complete
`sandbox-exec` or `unshare` wrapper, so the copied line reproduces the network
posture that produced the evidence. Approved and unavailable results print the
plain shell invocation. They stay on stderr, so `--json` stdout remains a
JSONL event stream. The board, CarHost, and ledger link the same proof by
session id at `<state dir>/<session-id>/evidence`, outside the disposable
worktree so successful cleanup does not remove it.

## The event stream

One compact JSON object per line on stdout under `--json`, **flushed per line**,
so a `SIGKILL` leaves a parseable partial stream. Every line has a `type`, and a
consumer must tolerate types it does not know.

```jsonc
{"type":"target_merge","branch":"goalpool/g_1","action":"merged","policy":"merge","commit":"…"}
{"type":"base_merge","base":"main","action":"already_current","policy":"merge"}
{"type":"run_start","repo":"…","target_branch":"…","worktree":"…","workspace_reused":false,
 "model":"…","outcomes_path":"…/coder-….outcomes.md","contract_checks":7,"contract_supplied":true,"max_iterations":0,
 "max_session_wall_secs":0,"max_check_timeout_secs":null,"silence_window_secs":900,"deliver":"pr",
 "base_branch":"main","draft":true,
 "base_merge":"already_current","target_merge":"merged"}
{"type":"contract_baseline","gates_nothing":false,"workspace_reused":false,
 "carries_prior_work":false,"results":[{"name":"build","command":"cargo build",…}]}
{"type":"outcomes_step","step":"enumerate","group":"page","phase":"finished",
 "outcomes":3,"detail":null}
{"type":"outcomes_step","step":"baseline_repair","group":null,"phase":"finished",
 "outcomes":3,"detail":"repaired_with_failing_check"}
{"type":"outcome_dropped","kept":"…","dropped":"…","group":"page","reason":"…"}
{"type":"outcomes_written","path":"…/coder-….outcomes.md",
 "groups":[{"group":"page","outcomes":3},{"group":"artifact","outcomes":2}]}
{"type":"iteration_start","n":1}
{"type":"spend","phase":"contract","cost_usd":0.0143,"cumulative_usd":0.0143}
{"type":"check_started","name":"build"}
{"type":"check_completed","name":"build","command":"cargo build","started_at":1781234559,
 "passed":true,"exit_code":0,"duration_ms":8123,"output_tail":"…","timed_out":false,
 "deadline_clamped":false,"credentials_allowed":false,"network_isolation":"sandboxed",
 "evidence_dir":"/…/evidence/1/build",
 "evidence_files":["/…/evidence/1/build/result.json","/…/evidence/1/build/stderr.txt","/…/evidence/1/build/stdout.txt"],
 "env":{"CAR_CHECK_EVIDENCE_DIR":"/…/evidence/1/build","CAR_CHECK_TMPDIR":"/…/evidence/1/build/tmp","CAR_HOME":"/…/evidence/1/build/car-home","PATH":"/…","PYTHONDONTWRITEBYTECODE":"1"},
 "cwd":"/…/worktree"}
{"type":"interceptor_group_close","group":"cc-coder-…","success":true,"detail":"closed","trigger":"contract_pass"}
{"type":"provider_error","status":429,"retry_after_ms":60000,"message":"…"}
{"type":"contract_evaluated","passed":true,"by":"runtime","iteration":3,"results":[…]}
{"type":"delivery_started","branch":"goalpool/g_1","draft":true,"base":"main"}
{"type":"artifact_excluded","path":"car_runtime/car_runtime.abi3.so","reason":"compiled_binary","size_bytes":127926272}
{"type":"delivery_completed","branch":"…","commit":"abc1234","pushed":true,"pr_number":123,
 "pr_url":"…","pr_action":"opened","draft":true,"body_names_commit":true,
 "excluded_artifacts":[{"path":"car_runtime/car_runtime.abi3.so","reason":"compiled_binary","size_bytes":127926272}]}
{"type":"delivery_failed","reason":"…","retriable":true,"stage":"push"}
{"type":"budget_exhausted","reason":"explicit session cap exhausted: elapsed 1800s of 1800s","elapsed_secs":1800,"iterations":5}
{"type":"auth_required","message":"…"}
{"type":"error","message":"…"}
{"type":"run_end","status":"delivered","failure_class":"none","iterations":3,"cost_usd":0.0421,
 "contract_cost_usd":0.0143,"contract_billing":"metered",
 "workspace_path":"…","workspace_kept":false,"branch":"…","commit":"…","pr_number":123,
 "pr_url":"…","delivered":true,"excluded_artifacts":[{"path":"car_runtime/car_runtime.abi3.so","reason":"compiled_binary","size_bytes":127926272}],"error":null}
```

`contract_baseline.results` contains full `CheckResult` objects, not the former
`{name, passed, exit_code}` projection, so its command, evidence, environment,
and working-directory fields match later check events and the persisted session.

`run_start.outcomes_path` names the outcomes file written for both derived and
`--contract-file` contracts. `spend.phase` is `contract` or `work`, so callers
can separate contract derivation from the coding loop. `run_end.cost_usd` is
the total reported spend; `run_end.contract_cost_usd` is its optional
contract-derivation subtotal. `run_end.contract_billing` is `"metered"`,
`"subscription"`, `"unknown"`, or `null` when no derivation call ran. Any
subscription call makes the aggregate `subscription`; otherwise any
unpriceable call makes it `unknown`; otherwise it is `metered`. Dollar totals
sum only metered calls, so mixed derivation can retain a metered subtotal
without fabricating a price for subscription or unknown calls.
`outcomes_step` reports fan-out, critic, merge, and all-green baseline-repair
progress; nullable `group`, `outcomes`, and `detail` fields apply only to steps
that have those values.
`outcome_dropped` records a duplicate or contradiction removed by the merge,
and `outcomes_written` names the artifact plus the outcome count by group. An
enumerator or critic call that stays silent past the session's effective
`silence_window_secs` counts as a failed attempt; `0` disables that per-call
limit.

`run_end.status` ∈ `delivered` · `reported` · `needs_review` · `contract_failed`
· `abandoned` · `failed`. A request that does not say what should change or
how anyone would see it ends as `abandoned` with `failure_class: "config_error"`
and exit 3; its `run_end.error` asks for the missing observable change.
An authored request whose checks all still pass after baseline repair also ends
`abandoned`, but with `failure_class: "already_satisfied"` and exit 2; its
error names every passing check and ends `Nothing to change.`

`delivered` and `reported` share exit 0 and are never conflated: an orchestrator
counting shipped changes and one counting triaged conclusions read the same
stream.

`budget_exhausted`, `stalled`, `no_progress`, and `auth_required` are the
persisted failure kinds an orchestrator most often acts on: an explicit cap, a
silent phase, unchanged native turns or unchanged external chatter, or a missing
credential. `error` carries a mid-run loop error that did not end the run.

## The cross-vendor audit

Before anything is delivered, a model from a different vendor than the builder
reads the verified work and may raise findings. The default auditor is Kimi K3
through OpenRouter (`openrouter/moonshotai/kimi-k3`), so the CAR daemon needs
`OPENROUTER_API_KEY` in its own environment; without an eligible auditor the
run is refused and the refusal names that key. Anthropic models are never used
as the auditor, whether through an Anthropic API key, OpenRouter, a Parslee
alias, or a Claude subscription, and naming one in `auditor_model` in
`~/.car/coder.toml` is refused. Local models (MLX, Apple Foundation and other
on-device models) are never chosen automatically; one runs only when
`auditor_model` names it. The full selection rules are under
`auditor_model` in `docs/websocket-protocol.md`.

The auditor is offered no tools: a reply that is only a tool call carries no
text. Its initial
payload includes each graded probe's exit code plus redacted, head-and-tail
capped stdout and stderr. The `start..delivered` diff is also capped and names
whether it is complete or truncated, along with the delivered and total byte
counts.

Audit findings are typed as `defect`, `challenge`, or `note`. A `defect`
contradicts a verdict and carries a confined reproduction command. A known
outcome id stays scoped to that outcome, and a recorded scoped probe id maps to
its outcome. A missing, unknown, or unscoped id instead creates the reserved
session grade `_audit_session`; the original id remains in the claim. A
non-zero reproduction makes the affected grade FAIL with that probe as its
reproducer. A missing reproduction, tool error, or exit zero makes it UNPROVEN
with a manual prerequisite. Session-level reproductions run as `_unscoped`
probes through the same confined shell. Legacy findings without `kind` are
defects when `reproduction` is non-empty after trimming and notes otherwise;
an explicit `kind: "note"` is always a note and its reproduction never runs.

A `challenge` says a PASS is not proven. CAR gives each challenged PASS outcome
one fresh verifier round without a builder repair and includes
`audit_challenges: [{outcome_id, reason}]` in the verifier input. PASS then
requires a probe recorded in that round; otherwise CAR records UNPROVEN with a
manual prerequisite carrying the reason. A challenge without an outcome id
applies to every PASS outcome. A challenge on FAIL or UNPROVEN is recorded but
opens no extra round. If an outcome is challenged again after its one challenge
round, CAR makes it UNPROVEN and returns to the bounded builder repair path; it
never opens a second challenge round.

`cannot_decide.what_would_decide` is `{"read":["repo/relative/path"]}` and/or
`{"run":"command"}`. Reads are canonicalized inside the frozen tree; probe
evidence directories return only their captured `check`, `command`, `cwd`,
`exit`, stdout, stderr, and optional `result.json` files. Nested `car-home` and
`tmp` directories are not traversed. Absolute paths, `..`, symlink escapes, and
other paths outside the frozen tree or session evidence are returned as refused
evidence. A typed `run` uses the verifier's confined shell and the item's known
outcome id, or `_unscoped` otherwise. Legacy free text is never executed: CAR
extracts existing repo-relative file paths and reads them, or reports that no
path could be obtained.

Each evidence round resolves every pending item in one follow-up. Notes,
questions, and blind spots use the replacement reply. Blocking defects and
challenges are sticky: CAR assigns `defect_id` values (`D1`, `D2`, ...) in
first-seen order and retains an omitted blocker. A follow-up removes one only
with `withdrawn: [{defect_id, reason}]` naming an existing id and a non-empty
reason. Valid withdrawals retain the removed claim and reason in the audit
attestation and delivery ledger; unknown ids and empty reasons remove nothing.
CAR stably deduplicates the resulting state. The loop stops when nothing is
pending, the remaining requests were already answered, or three follow-up
rounds have run. Notes and unresolved sensitivity questions remain recorded and
do not block delivery; unanswered challenges and every defect do.

The checked-in legacy live-audit replies now block as designed: the kindless
machine-1 `cargo test` and machine-4 `cargo run` findings carry reproductions,
so they are defects. Both reproductions exit zero in the fixture and those
outcomes finish UNPROVEN with manual prerequisites. The kindless
`_unscoped:probe-1` “suggestive but not decisive” finding has no reproduction
and remains a session-level note. A test variant that marks the same
affirmations explicitly as notes delivers while retaining notes and unresolved
questions.

The follow-up asks for only the JSON object, but reply extraction also accepts
that strict audit object inside a JSON or bare Markdown fence or surrounded by
reasoning prose. A reply with no valid audit object remains unusable. Empty or
unusable replies are retried under the same three-strike policy as the builder
and verifier. If a reply is still unusable, the run ends as an
`infrastructure` failure, not a `verification` one: the message names the
auditor model and what came back, meaning the content length, reasoning length,
any tool calls, and the `finish_reason`. A missing audit is never treated as a
pass. Every auditor reply, parsed or not, is written redacted and capped at 64
KiB to `<evidence>/audit/reply-NNN.json` and journaled as a
`coder.audit_reply` event, so a failed audit can be read directly.

## Delivery semantics

1. **Append-only.** The push is a plain `<sha>:refs/heads/<branch>` refspec. No
   force marker exists anywhere on the path. A non-fast-forward rejection is a
   retriable failure, and the remote is left exactly as it was.
2. **One pull request per branch and base — and a clear head.**
   Reconciliation looks only at pull requests whose base is this round's
   `--pr-base`, because the supported forges identify an open pull request by its
   (head, base) pair and two open pull requests from the same branch into different
   bases are legal. Within that set: an open one receives the push (`updated`);
   otherwise one is created (`opened`) — **including when the only existing pull
   request for that branch and base is merged**, since a merge is that branch's
   work landing rather than a decision against it. `pr_action` is therefore
   `opened` or `updated`; there is no `reopened`.

   That filter decides *which* pull request this round reconciles. It does not
   make the bases independent, because **the push is shared**: a pull request
   tracks its head branch, so every commit pushed to `--target-branch` shows up
   in every open pull request whose head that branch is, whatever base each
   merges into. Git offers no way to push to a branch and update only one of
   them. So the round is **refused** when `--target-branch` already has an open
   pull request into any base other than `--pr-base`, naming each number and its
   base. The two remedies are to close the other pull request, or to deliver to
   a different `--target-branch`. The refusal is reported as
   `delivery_failed { stage: "preflight", retriable: false }` and parks the
   round: retrying cannot change it, a person must.

   The check runs in **both** preflights, exactly like point 5. `car
   code-task`'s own preflight applies it before any model session, so a head
   that is already unclear costs nothing; delivery applies it again before it
   commits or pushes anything, which is the load-bearing one — a person can open
   or close a pull request while the session is running, and only that call sits
   between it and the push.

   A merged pull request never parks a round: it is inert, it cannot gain
   commits, and its branch simply gets a fresh pull request for the next round.
   So a round with a changed `--pr-base` delivers normally once the previous
   pull request is merged — and opens its own. With it still open, the round is
   refused rather than quietly adding this round's commits to it.

   **A closed pull request into this round's own `--pr-base` also parks the
   round, and the runtime never reopens it.** This reverses what this document
   used to promise. The runtime never *closes* a pull request, so it is never
   the party entitled to undo a close, and nothing at this seam distinguishes
   "closed because it went stale" from "closed by a reviewer who read it and
   said no". Before this, a reviewer who read the pull request, edited its body
   and closed it got it reopened on the next round with their edits replaced
   wholesale — every round, for as long as the branch existed — so closing a
   pull request did not stop the runtime. A close is now a stop: the refusal
   names the number and says a human reopens it to continue, or the round
   delivers to a different `--target-branch`. It is base-scoped, so a closed
   pull request from this branch into some *other* base is nothing to do with
   this round and does not park it. It is also **suppressed by an open pull
   request into the same base**, which is why the rule above still holds without
   exception: the supported forges permit at most one open pull request per (head, base)
   pair, so when one exists it is unambiguously the one this round reconciles,
   and opening it was a later human decision than the close. A reviewer who
   closes #40 as the wrong approach and opens #55 from the same branch into the
   same base has carried the work forward; #55 receives the push (`updated`) and
   #40 gets no veto. Same reporting as the ambiguous head —
   `delivery_failed { stage: "preflight", retriable: false }`, `config_error`,
   exit 3 — and it runs in both preflights for the same reason.
3. **Draft is a create-time decision.** The runtime never marks a pull request
   ready for review.
4. **The branch is brought up to date by merge** — `git merge origin/<base>` and
   `git merge origin/<target>`, at the start of a round and before any work.
   Never rebase, never force: a rebase rewrites commits a reviewer may already
   have read, and a force-update can discard a round's work. Each update reports
   an `action`: `already_current`, `merged`, `skipped` (no such ref yet — round
   one has no `origin/<target>`), `declined` (git refused to start the merge at
   all) or `conflict`. A reused worktree's own uncommitted edits used to be the
   ordinary way to reach `declined`; they are now discarded at provisioning, so
   what is left here is the genuinely unexplained refusal. `declined` and `conflict` both **park the round**
   before the model runs, with exit 3: a merge that could not start is not
   "nothing to do", and proceeding would deliver a branch that never integrated
   its base.
5. **The target branch may not be the base branch.** `--target-branch main` on a
   repository whose default branch is `main` would push the round's unreviewed
   output straight onto the base rather than opening a pull request, and an
   append-only path has no way to take it back. It is refused in the preflight,
   before any model session, and refused again inside delivery.
6. **Every pull request gets a substantive body** naming the intent, the checks
   that passed with their commands, and the iteration count. It is the next
   fresh session's only context and must stand alone without the diff. A pull
   request being *created* is opened with `- commit: recorded on this pull
   request once delivery completes`, because its number is not known until the
   create returns; the body is rewritten with the commit immediately after. Read
   a body naming no commit as "the rewrite has not landed yet", not as "no
   commit was delivered".

## The contract

`--contract-file` takes the `OutcomeContract` JSON:

```json
{
  "description": "what done means",
  "checks": [
    {"name": "build", "command": "cargo build", "expect_exit_zero": true, "timeout_secs": 600},
    {"name": "greeting", "command": "cat HELLO.txt", "expect_exit_zero": true,
     "output_contains": "hello", "timeout_secs": 30}
  ]
}
```

### The contract's checks are immutable

A contract must keep measuring the outcome the operator approved. At session
start, CAR captures committed test logic: scripts a check executes, the
repo-relative scripts those scripts invoke through shell execution, `node`,
`python`/`python3`, or `uv run` (recursively, with an eight-edge limit and cycle
detection), test files or directories a test runner targets, and files matched
by the contract's optional `protected_paths` entries. The parser recognizes
Node test targets, `python -m` test runners, `uv run` wrappers, and `swift test`;
`swift test` protects the package's complete `Tests/` tree because a `--filter`
may name a type or method rather than a path. A protected directory means its
exact start-commit contents: additions inside it are hidden for the check and
restored afterwards. CAR uses a test-logic view of the shell-command parser
shared with `car coder-ab`; coder-ab keeps restoring its broader historical set
of named inputs. A product or fixture that an
ordinary assertion command merely reads (`cat`, `grep`, `diff`, `cmp`, `test`,
`python -c`, or `< file`) is not protected, because the check must inspect the
builder's result. Captured files come only from the start commit; the explicit
directory and configuration rules also reject builder-added entries.

CAR also protects every start-commit `conftest.py` and `pytest.ini`. At each
ancestor directory from a protected test path through the repository root, it
protects start-commit `conftest.py`, `pytest.ini`, `.pytest.ini`, `tox.ini`,
`setup.cfg`, `pyproject.toml`, and `package.json`; builder-added files at those
locations are hidden for the check. `package.json` is protected as a whole, so
edits to unrelated fields are reported too. `editable_paths` is the operator's
escape hatch when such an edit is intentional. Builder-added `conftest.py` and
`pytest.ini` are protected anywhere in the repository.

Builder-iteration checks and the final gate temporarily overlay changed or
deleted protected files with their start-commit bytes, run the check, and then
restore the builder's working copy. The verifier's `run_check` sees the same
start-commit versions when CAR materializes the frozen delivered tree. This
keeps a builder from changing the test logic that decides its result while
leaving the builder's worktree intact for review.

The overlay writes a crash journal before it changes the worktree. Normal
cleanup restores the builder's bytes, modes, symlinks, and builder-added files,
then completes the journal. Daemon startup and retained-task resume recover an
unfinished journal before adopting or reopening the session. Recovery failure
ends the session as infrastructure failure; CAR does not run checks on a
partially overlaid tree.

The journal lives at
`<state dir>/<session-id>/protected-overlay-journal`, outside the worktree,
its Git directory, check evidence, and check scratch directories. Recovery
takes the worktree root from the persisted session record; a root in the
journal must match it. CAR validates every entry and blob as a strict relative
path, walks components without following symlinks, and validates the complete
transaction before restoring anything. An unsafe journal is left in place and
the session records an infrastructure error for operator repair.

Added or changed symlinks in that surface are contract changes. CAR inspects
symlinks without following them, removes or replaces them for the check, and
restores the builder's link afterwards. A symlink in a protected path's parent
is never followed, so pristine writes cannot escape the repository root.

When CAR observes a protected edit, it records the path and whether it was
added, modified, or deleted, emits `contract_protected_edits`, attaches the
relevant edits to each `CheckResult.protected_edits`, and tells the builder that the
original ran. The note appears again in the next repair turn. The session
snapshot retains the first iteration that observed each edit.

Every fresh capture emits
`contract_protected_surface {paths, unprotected_checks, partially_protected, invoked_product_files}`
and stores all four fields in the session snapshot. `car code` prints a capped **Protected
contract files** list and lines such as `invoked product file (not protected):
<path> (run by <invoked_by>)`. For each check in `unprotected_checks`, CAR also emits
`contract_unprotected_check`, writes a tracing warning, and prints a warning
naming the check: its command names no start-commit test logic CAR can protect,
so a builder could change what it runs. This warns about the grading boundary;
it does not turn the check into a failure.

Static discovery follows commands in conditionals, loops, negation, brace and
subshell groups, boolean chains and sequences, and recognizes `tsx` and
`ts-node` launchers. A test runner inside a protected helper protects the same
named tests, directories, and test configuration as a top-level command.
Runtime-selected helper behavior such as `eval`, command substitutions,
variable-held programs, computed `cd`, `exec "$@"`, and generated `xargs` or
`find -exec` invocations appears in `partially_protected`. CAR emits one
`contract_partial_protection` warning per entry with the check, helper path,
bounded source line, and reason; `car code` prints the same warning.

Two optional `OutcomeContract` arrays let an operator make the boundary
explicit:

```json
{
  "protected_paths": ["checks", "test/support/*.py"],
  "editable_paths": ["test/support/generated.py"]
}
```

The builder can never weaken HOW it is graded, and can always change WHAT is
graded. A check script invoking the product is testing the product, not defining
the test. The protected surface contains (a) committed files and exact directory
contents declared in `protected_paths`, plus ancestor test configuration for
declared test paths; (b) files and directories named on a check's own command
line; and, only when no paths are declared, (c) transitively referenced files
that are themselves recognizable test logic. Conventional test logic includes
`test`, `tests`, `testing`, `spec`, `__tests__`, and Swift `Tests` directories,
test-shaped filenames, and test configuration. A referenced CLI, library, or
data file outside those locations remains editable and appears in
`invoked_product_files`; non-test directories referenced inside scripts are
ignored.

When `protected_paths` is non-empty it is authoritative: the transitive walk
still reports partial-protection gaps and invoked product files, but it can
recurse only within declared directories or directories named directly by a
check. Directly declared and check-command paths always win, even when they look
like product code. In the deploy-lag replay, `live-fleet.sh` remains pristine
while its invoked `deploy_lag.py` and `repo-deploy-map.json` use the builder's
fixed bytes.

`editable_paths` opts matching protected files out of the overlay, so checks
run the builder's copy. Those changes are still
recorded as allowed and shown to the verifier and auditor. An ordinary
builder-added test file outside a protected directory is not protected,
reported, or overwritten because it did not exist in the start commit.

For replay rows, `car coder-ab` merges the row's recorded `protected_paths`
into the `OutcomeContract` it sends to every arm, without removing or
duplicating paths already declared by that contract. Ground-truth restoration
still uses the row's recorded paths and the broader data-operand rules.

Delivery reports any remaining protected-file edit as a **contract change (not
graded)** because the checks ran the original. An `editable_paths` edit is
reported as a **contract change (allowed)**. These labels disclose what the
delivered diff contains; they do not remove the edit from delivery.

Remaining limits: transitive discovery is static and follows only direct,
repo-relative script invocations visible in committed script text. It does not
evaluate variables, command substitutions, generated commands, or runtime
imports, and it stops after eight invocation edges. Files merely consumed as
products remain editable by design. Builder background processes are not
stopped before the pristine check pass. Use `protected_paths` when required
test logic falls outside the parser's visible surface.

`output_contains` normally performs a literal substring check. Its reserved
`$json:<JSON Pointer>=<JSON value>` form parses the complete command output as
JSON and compares the addressed value in the runtime; for example,
`$json:/ok=true` requires the top-level `ok` field to be the boolean `true`, not
merely text that resembles it.

Choose a substring that distinguishes success from failure: `match` also occurs
in `mismatch`. Validation rejects simple literal `command && echo success ||
echo failure` checks when both branches exit zero and satisfy the same substring
assertion (or no output assertion is present). Keep the comparison's exit status,
or use an assertion that distinguishes its results. This lint recognizes a
limited literal shell form; checks still need review for task coverage.

`$exact:<text>` requires the complete captured UTF-8 output to equal `<text>`
without trimming. For example, this checks both lines and the final newline
without generating a shell comparison program:

```json
{"name":"readme_text","command":"cat -- README.md","expect_exit_zero":true,
 "output_contains":"$exact:# Example\nWelcome to CAR.\n"}
```

Use a read command supported by the check's platform (`cat` in this POSIX
example). Expected text is limited to 64 KiB. The local shell capture must be
complete and lossless; truncated, invalid-UTF-8, or unattested remote-substrate
output cannot pass this assertion. Stdout and stderr use the existing combined
capture format, so diagnostic text also prevents equality. Exit and timeout
requirements still apply. Binary data and larger files need the repository's
own tests or a bounded digest check. This reserved form requires a runtime that
supports exact output; older runtimes interpret it as an ordinary substring.

There is **no maximum check count** — a 95-check contract is legal, and every
check runs and is reported. Two controls do bind:

- **Duration.** `timeout_secs` is an optional explicit cap for that check. The
  global `--max-check-timeout-secs` / `max_check_timeout_secs` ceiling is also
  optional and unbounded by default. With neither set, only silence stops a
  check: no output for `silence_window_secs` (default `900`, `0` disables) kills
  it and records a red result. The `600` in the example is therefore that
  check's own explicit cap, not a default.
- **Credentials.** Every check starts with inherited credential names scrubbed.
  A check receives a value only when it declares the uppercase environment
  name and an operator approves that declaration for its exact name and
  command. `allow_credentials: true` only removes
  `DenyCredentialAccess` from command inspection. The model shell remains
  scrubbed and has no injection path. See
  [The property that matters](#the-property-that-matters).

Before the loop starts, the contract is evaluated once against the *unmodified*
worktree. For a model-derived contract with fan-out outcomes, an all-green first
baseline is sent through one contract-repair round with the observed results and
the instruction: "These checks already pass on the untouched repository; write
checks that fail until the requested change is made." The repaired contract is
then baselined under the same sandbox, approval, timeout, and silence settings.
If every ordinary derived check is still green and no outcome is held or Not
verified, the run ends `abandoned` with `failure_class: "already_satisfied"`
and exit 2. Its message names every passing
check, backticked and comma-separated, uses `passes` for one or `pass` for
several, and ends `on the untouched code. Nothing to change.` If the repair
produces a red check, the run continues. The round emits `outcomes_step` entries
with `step: "baseline_repair"` and `started`/`finished` phases; this terminal
result uses `detail: "already_satisfied"`. Supplied contracts keep their
existing behavior and are not repaired. An exit-zero-only check that already
exits zero counts as a passing baseline check. If a held or Not verified outcome
remains beside the green runnable checks, the task stops before the work loop as
`needs_review`/`finding_needs_review` and keeps the unresolved outcome visible.

D-92 treats a model-derived request as thin only when its completed enumerator-
plus-critic fan-out authored zero outcomes before filtering/repair, or the whole trimmed
request is a conservative case-insensitive no-op such as `fix it`, `make it
better`, `do something`, or `improve`. Held network checks and all other Not
verified outcomes still count as specificity evidence, even when no runnable
check remains. A held-only run stops before the work loop with
`status: "needs_review"`, `failure_class: "finding_needs_review"`, and exit 3;
it is specific, but cannot execute until a caller approves or supplies a check.
No request can be refused as thin while an outcome is listed under Not verified.

Outcome prose that promises specific printed or displayed text must have an
`output_contains` assertion or a grep/test/diff-style output assertion in its
command. The normal contract repair loop receives `check <name> must assert the
output its outcome claims`; if repair still omits the assertion, that outcome
moves to Not verified. Internal repair and reassessment prompts use neutral
fallback outcome prose and prompt-marker linting prevents them from appearing
in the outcomes file.

The refusal stands down when the tree **already carries work**, reported as
`carries_prior_work` on `contract_baseline`. That is `workspace_reused || HEAD is
ahead of the base` — the second half matters, and keying on reuse alone was the
bug: a freshly cut round-N+1 workspace is cut from the *delivery branch*, so it
already contains round N's committed work and passes at baseline with
`workspace_reused: false`. Under `--keep-workspace` a delivered round always
reaps its workspace (`kept` requires a non-zero exit), so the fresh cut is the
design's own happy path, not an edge case.

## Workspace lifecycle

`--workspace-dir` is a stable per-goal path. It is reused when it is already a
git worktree **of this repository** — ownership is the `.git` file's `gitdir`
pointer, not merely the presence of a `.git`, so an unrelated clone is refused
rather than deleted. `--keep-workspace` holds the tree on any non-zero exit — including a green
contract whose push failed, and a verify-only (`--deliver none`) run, where the
worktree is the only place the work exists.

A workspace the **caller** created and handed over is borrowed: it is adopted
as-is and never deleted, on any exit code, because the caller still needs it to
find the work. It must be clean the first time it is handed over — a worktree
with uncommitted changes in it is somebody's live work and is refused — and from
then on this command tracks that it adopted it. A round that ends before the
delivery commit (any red round, and a green `--deliver none` round) leaves its
own uncommitted edits behind, so the next round on that same path discards them
(`git reset --hard HEAD` plus `git clean -fd`, leaving ignored files and every
commit alone) and runs. Without that, the first red round left a directory only a
human could clear, and every round after it exited 3.

**The same discard runs on a workspace this command owns**, and for the same
reason. `--keep-workspace` plus a red round leaves the tree dirty; the base merge
cannot *start* in a dirty tree, which reports as `declined` and parks — exit 3
before a single model call, on every subsequent round. Commits survive the
discard, so a green round whose push failed still re-delivers its work rather
than redoing it.

That licence to discard is **released as soon as a run ends with the workspace
clean** — which is what a green delivery leaves, having committed everything.
Nothing of this command's is then left to discard, so the directory is handed
back unclaimed and anything that appears in it afterwards is treated as somebody
else's: a later run refuses rather than resetting it. Cleanliness is judged with
`status.showUntrackedFiles` pinned, so a repository or global `no` cannot hide a
tree that holds nothing but new files.

`SIGTERM`/`SIGINT` cancel the run between turns, so a budget-kill leaves through
the ordinary terminal path instead of leaking a checkout and a worktree
registration in the user's repository.

{% endraw %}
