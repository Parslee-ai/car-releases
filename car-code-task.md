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
  64,000 bytes, shared so one large file cannot hide the other. Truncation names
  the file whose remaining rules must be read before editing.
- **Directory-scoped instructions** — nested `CLAUDE.md` / `AGENTS.md` files,
  each labelled with the subtree it governs. Where a scoped rule is stricter
  than a root one, the prompt states that the scoped rule wins inside that
  subtree. Enumerated with `git ls-files`, so only files a maintainer committed
  are read: an untracked instruction file is ignored, which matters because a
  session can write files into its own worktree. Budgeted at 8 files, 6KB each
  and 12KB combined; past a budget the remainder are listed as paths to read
  rather than silently dropped.
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
is **credential separation**, and that is now in place: the model's shell runs
with `GH_TOKEN`/`GITHUB_TOKEN` (and their enterprise spellings) removed,
`GH_CONFIG_DIR` pointed at an empty directory so `gh` cannot fall back to
`~/.config/gh/hosts.yml`, and git's `credential.helper` overridden to empty for
that child so `git push` over HTTPS cannot ask the keychain either.

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

**A contract check has its own credential policy, while the model's shell
always keeps the full deny.**

*The environment.* `run_check_shell` passes `ForgeCredentials::Inherit` where
`run_shell` passes `Withhold`. `Withhold` removes four variables —
`GH_TOKEN`, `GITHUB_TOKEN`, and their enterprise spellings — and neutralizes the
`gh`, `git` and `ssh` credential helpers. It does **not** clear the environment.
So every other variable, `$DATABASE_URL` and `$STAGING_API_TOKEN` alike, is
inherited by *both* paths; what a check additionally keeps is the forge
credential, which is the publication route the model is denied.

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
    { "name": "telemetry", "command": "az monitor app-insights query …" }
  ]
}
```

`allow_credentials` defaults to `false`. When true, every check in that contract
uses a frozen twin of the session's inspector chain with only
`DenyCredentialAccess` removed. Forge publication, history rewrite, privilege
escalation, destructive commands outside the worktree, path escape, environment
repair, and every machine/project `.car/policies` rule remain in the same order.
The model's own `shell` always uses the full chain, regardless of the contract.
Model-derived contracts are forced back to `false`, so an unattended derivation
(including self-heal) cannot grant itself this authority; supply a contract with
`--contract-file`, or edit the proposed daemon contract before confirming it.

Every `CheckResult` records `credentials_allowed`, including baseline results
and `check_completed` / `contract_evaluated` events. This is the effective
policy used for that execution, not an inference from the current contract.

Without the opt-in, read `DenyCredentialAccess` as hardening rather than a
boundary. It is a substring matcher over text handed to `/bin/sh`: the obvious
`$STAGING_API_TOKEN` or `~/.aws/credentials` spelling is refused, while
`$TOKEN`, `$APIKEY`, `$DBURL`, `aws sts get-caller-identity`, or `kubectl get
pods` carries no built-in marker and may reach inherited credentials. The opt-in
makes the decision explicit and reviewable; the default matcher was never proof
that a check was offline.

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
governance does not. It is also clamped by `--max-check-timeout-secs` and by the
session's remaining budget, so a check that polls a real system can be starved
rather than answered.

## Flags

| Flag | Meaning |
|---|---|
| `--repo <PATH>` | Repository to work in. Resolved to its top level; must be a git repo. |
| `--intent-file <PATH>` / `--intent <STRING>` | The task. Exactly one. |
| `--contract-file <PATH>` | JSON `OutcomeContract`. **When present, derivation does not run.** `allow_credentials` defaults to `false`; set it to `true` only when the runtime-owned checks need credentials. The opt-in removes `DenyCredentialAccess` for those checks only and is recorded in every result. Each check remains capped at `--max-check-timeout-secs`. See [The contract](#the-contract). |
| `--target-branch <NAME>` | Delivery branch, stable across sessions. Required for `--deliver pr`. |
| `--pr-base <NAME>` | PR base. Defaults to the repo's default branch. |
| `--body-prefix <TEXT>` | Trusted caller-supplied text placed verbatim at the start of the generated PR body. The model cannot edit it. Intended for stable orchestrator markers such as `<!-- car-selfheal:key=… -->`; do not pass untrusted model output. |
| `--draft` | Open the pull request as a draft. |
| `--deliver <MODE>` | `pr` \| `branch` \| `none`. Defaults to `pr` with a target branch, else `branch`. Pull-request delivery selects GitHub for `github.com` origins and Azure DevOps for `dev.azure.com`, `ssh.dev.azure.com`, and `*.visualstudio.com` origins. GitHub requires an authenticated `gh` CLI; Azure DevOps requires the `azure-devops` extension for `az` plus `az login` or `AZURE_DEVOPS_EXT_PAT`. Set `CAR_CODER_FORGE=github` or `CAR_CODER_FORGE=azure-devops` for a self-hosted or otherwise unrecognized origin; an unknown origin fails before the delivery commit or push and names that override. GitLab, Bitbucket, and other forges are not supported. Use `branch` when an external orchestrator will open the review artifact. `branch` publishes a clean worktree whose HEAD is ahead of the base as a re-delivery, the same as `pr`; it fails only when the base already contains HEAD. |
| `--model <ID>` | Pin the inference model. |
| `--max-iterations <N>` | Override the coder config's iteration ceiling. |
| `--max-session-wall-secs <N>` | Override the session wall clock. `0` = unlimited. Bounds the whole run — the baseline contract evaluation, the loop, and the runtime's own re-run — not just the loop: each check's `timeout_secs` is clamped to what is left. |
| `--max-check-timeout-secs <N>` | Ceiling for **one** check's command. Defaults to 600 (or `max_check_timeout_secs` in `~/.car/coder.toml`). Raise it for a verification gate that legitimately runs longer than ten minutes; the `shell` tool the model itself calls keeps the 600s ceiling regardless. `0` is treated as unset, not unlimited. |
| `--workspace-dir <PATH>` | Stable per-goal workspace. Reused when it is already a worktree of this repo. |
| `--keep-workspace` | Keep the workspace on any non-zero exit, and on a green `--deliver none` run. A deadline-starved post-loop gate is always retained because the loop already verified that tree green. |
| `--transcript <PATH>` | Mirror the JSONL stream to a file. A path that cannot be created or opened is a `config_error` refusal before any spend — never a silent downgrade to no transcript. |
| `--json` | Emit the JSONL stream on stdout, one compact object per line. |

## Exit codes

| Code | Meaning | What an orchestrator should do |
|---|---|---|
| `0` | Contract green and delivery succeeded (or `--deliver none`), **or** the session correctly concluded no code should change. | Progress. Read `status` to tell the two apart: `delivered` shipped a diff, `reported` shipped a conclusion. Do not retry either. |
| `1` | Ran out of iterations or wall-clock without the contract going green. | Read `failure_class`: `contract_not_green` / `task_max_turns` is a real, scorable no-progress round; `session_wall_exhausted` is a run that ran out of time and was never judged — do not score it. |
| `2` | Retriable infrastructure — transport, a lost push race, or a forge CLI/API blip. | Requeue; **not** a no-progress cycle. |
| `3` | Non-retryable — bad invocation, unusable contract, missing credential, a vacuous contract, **or** a no-change finding that needs a human this command cannot reach. | Park it and quote the failure class. For `finding_needs_review`, a person reads the finding; re-running changes nothing. |

`run_end.failure_class` ∈ `none` · `contract_not_green` · `delivery_failed` ·
`task_max_turns` · `session_wall_exhausted` · `infra_setup` · `infra_inference` ·
`config_error` · `car_bug` · `finding_needs_review`.

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

The session clock is never allowed to interrupt an iteration mid-flight, so the
loop routinely finishes *just past* its ceiling: the last round is admitted at
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

"Its own timeout" means the **effective** ceiling,
`min(timeout_secs, max_check_timeout_secs)`: every contract command runs through
the coder shell, which caps any timeout at the per-check ceiling — 600 seconds
by default. At that default a check declaring `timeout_secs: 900` is killed at
600 however much session budget is left, and that is reported as
`deadline_clamped: false` — a hang, not starvation; only a session with **under**
600 seconds left can clamp such a check.

`--max-check-timeout-secs` moves that ceiling. At `--max-check-timeout-secs 900`
the same check gets its full 900 seconds, and a session with 700 left now
*does* clamp it — `deadline_clamped: true`, starvation rather than a hang, which
is the honest reading once the check was allowed the duration it declared. Raise
it only for a gate you know is slow: the ceiling is what stops a genuine hang
from consuming the whole session budget.

The reclassification also yields to the loop's own verdict. If the loop itself
ended on a named machinery or configuration fault — an exhausted inference retry
chain (`infra_inference`, exit 2) or an expired token (`config_error`, exit 3) —
that class stands even though the gate that followed it was equally starved.
Only a loop that reached no verdict of its own, or one purely about the work
being red, can be reclassified as `session_wall_exhausted`. A missing credential
must not surface as a budget problem: exit 2 still means requeue and exit 3 still
means park it.

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

## The event stream

One compact JSON object per line on stdout under `--json`, **flushed per line**,
so a `SIGKILL` leaves a parseable partial stream. Every line has a `type`, and a
consumer must tolerate types it does not know.

```jsonc
{"type":"target_merge","branch":"goalpool/g_1","action":"merged","policy":"merge","commit":"…"}
{"type":"base_merge","base":"main","action":"already_current","policy":"merge"}
{"type":"run_start","repo":"…","target_branch":"…","worktree":"…","workspace_reused":false,
 "model":"…","contract_checks":7,"contract_supplied":true,"max_iterations":8,
 "max_session_wall_secs":3600,"max_check_timeout_secs":600,"deliver":"pr",
 "base_branch":"main","draft":true,
 "base_merge":"already_current","target_merge":"merged"}
{"type":"contract_baseline","gates_nothing":false,"workspace_reused":false,
 "carries_prior_work":false,"results":[…]}
{"type":"iteration_start","n":1}
{"type":"spend","cost_usd":0.0143,"cumulative_usd":0.0143}
{"type":"check_started","name":"build"}
{"type":"check_completed","name":"build","passed":true,"exit_code":0,"duration_ms":8123,
 "output_tail":"…","timed_out":false,"deadline_clamped":false}
{"type":"provider_error","status":429,"retry_after_ms":60000,"message":"…"}
{"type":"contract_evaluated","passed":true,"by":"runtime","iteration":3,"results":[…]}
{"type":"delivery_started","branch":"goalpool/g_1","draft":true,"base":"main"}
{"type":"delivery_completed","branch":"…","commit":"abc1234","pushed":true,"pr_number":123,
 "pr_url":"…","pr_action":"opened","draft":true,"body_names_commit":true}
{"type":"delivery_failed","reason":"…","retriable":true,"stage":"push"}
{"type":"budget_exhausted","reason":"…","elapsed_secs":3600,"iterations":5}
{"type":"auth_required","message":"…"}
{"type":"error","message":"…"}
{"type":"run_end","status":"delivered","failure_class":"none","iterations":3,"cost_usd":0.0421,
 "workspace_path":"…","workspace_kept":false,"branch":"…","commit":"…","pr_number":123,
 "pr_url":"…","delivered":true,"error":null}
```

`run_end.status` ∈ `delivered` · `reported` · `needs_review` · `contract_failed`
· `failed`.

`delivered` and `reported` share exit 0 and are never conflated: an orchestrator
counting shipped changes and one counting triaged conclusions read the same
stream.

`budget_exhausted` and `auth_required` are the two an orchestrator most wants to
key on — a wall-clock kill versus a missing credential — and correspond to the
`session_wall_exhausted` and `config_error` failure classes. `error` carries a
mid-run loop error that did not end the run.

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

`output_contains` normally performs a literal substring check. Its reserved
`$json:<JSON Pointer>=<JSON value>` form parses the complete command output as
JSON and compares the addressed value in the runtime; for example,
`$json:/ok=true` requires the top-level `ok` field to be the boolean `true`, not
merely text that resembles it.

There is **no maximum check count** — a 95-check contract is legal, and every
check runs and is reported. Two controls do bind:

- **Duration.** `timeout_secs` is capped at `--max-check-timeout-secs` (600 by
  default), so the 600 in the example above is also the largest value that has
  any effect until that flag is raised. This ceiling **is** caller-set: raise it
  for a gate that legitimately runs longer than ten minutes.
- **Credentials.** By default, a check naming a credential-looking environment
  variable or directory is refused before it runs. A caller-supplied or
  user-edited contract can set `allow_credentials: true`; that removes only
  `DenyCredentialAccess` from the check chain and records the choice in each
  result. The model's shell remains denied. Without the opt-in, the matcher is
  hardening rather than a boundary: `$TOKEN` carries no marker and `aws sts
  get-caller-identity` names no path, so a differently spelled check can still
  reach inherited credentials. See
  [The property that matters](#the-property-that-matters).

Before the loop starts, the contract is evaluated once against the *unmodified*
worktree. If every check already passes, the contract gates nothing — nothing
the session does would be verified — and the run refuses with exit 3 rather than
delivering a pull request that proves nothing.

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
