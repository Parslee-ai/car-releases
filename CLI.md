{% raw %}
# CAR CLI reference

> **Generated file — do not hand-edit below the task map.** Produced by
> `scripts/gen-cli-docs.sh` from `car --help` / `car help <command>` on car
> 0.51.0 (2026-09-03). Every subcommand the installed binary reports is
> below; a new subcommand cannot ship without appearing here the next time
> this script runs. To regenerate: `bash scripts/gen-cli-docs.sh`.
>
> 66 top-level commands, 98 nested subcommands
> (one level deep) — counted from the live binary at generation time, not
> typed by hand.

## Finding your way around

`car` is one binary with 66 subcommands spanning several different jobs:
running the built-in agent, coding, local model management, OS integrations,
and installing other people's agents on your machine. This map groups the
commands people actually reach for; the full alphabetical reference with every
flag follows below.

### Run an agent

- [`car do`](#car-do) — the general-purpose CAR Assistant. No goal opens an
  interactive REPL; with a goal it runs once and prints the result. Ships
  wired with files, a real shell, web access, and durable memory; runs
  sandbox-first (a hardened Docker container) unless you pass `--local`.
- [`car board`](#car-board) — fullscreen supervision board for coder
  sessions: attach to a run's history, confirm its outcome contract, answer
  its questions, approve its diff.
- [`car agent`](#car-agent) — build and run in-daemon agents from
  plain-language descriptions; nothing extra to install.
- [`car build`](#car-build) — build a runnable workflow from a
  natural-language goal.
- [`car run-task`](#car-run-task) — headless entry point for external eval
  harnesses: run a goal autonomously against stdio MCP tool servers, emitting
  a JSONL transcript.

### Code

- [`car code`](#car-code) — built-in coding agent: state an intent, confirm
  the verifiable outcome contract, and CAR delivers it in an isolated git
  worktree (natively or via an installed frontier CLI). Results land on a
  `car/coder/<id>` branch after your approval; your checkout is never
  touched.
- [`car code-task`](#car-code-task) — run a coder session headlessly and in
  this process, driving to a green outcome contract and delivering a PR.
- [`car coder-ab`](#car-coder-ab) — A/B-test CAR's coder against an external
  agent (Codex / Claude Code) over a corpus, and grow that corpus from git
  history.

### Models and media

- [`car setup`](#car-setup) — detect hardware, recommend, and install the
  right model for this machine. Interactive walkthrough with no flags.
- [`car models`](#car-models) — manage local inference models: list, pull,
  remove, benchmark, route, and more (see the subcommand table below).
- [`car infer`](#car-infer) — run text generation with a local model.
- [`car image`](#car-image) / [`car video`](#car-video) — generate an
  image or video with a local MLX model.
- [`car speech`](#car-speech) — manage the CAR speech runtime, health
  checks, and smoke tests.
- [`car embed`](#car-embed) — generate embeddings for text.
- [`car reason`](#car-reason) — reason about code: diagnose, suggest fixes,
  explain.

### Memory and skills

- [`car skills`](#car-skills) — manage learned skills (SkillRL-inspired).
- [`car dream`](#car-dream) — run memory consolidation ("dream") — prune,
  GC, embed, evolve.
- [`car eval`](#car-eval) — evaluate agent improvement from stored
  trajectories.

### Auth and accounts

- [`car auth`](#car-auth) — Parslee account authentication for CAR
  cloud-backed features (`login`, `status`, `logout`, `orgs`,
  `switch-org`, `accounts`, `switch-account`).
- [`car parslee`](#car-parslee) — Parslee platform capabilities for the
  signed-in account (requires `car auth login`).
- [`car keys`](#car-keys) — store cloud-provider API keys in the OS
  keychain, so a native-app user never sets an environment variable.
- [`car secrets`](#car-secrets) — OS-native secret store (Keychain /
  Credential Manager / Secret Service); aliased `secret`.
- [`car keychain`](#car-keychain) — OS keychain integration.
- [`car identity`](#car-identity) — show or change the name your assistant
  answers to, in conversation, in the host apps, and as its voice wake word.

### Install and supervise contributed agents

- [`car install`](#car-install) — install a contributed agent, from a local
  directory or a registry reference.
- [`car ls`](#car-ls) — list every installed contributed agent (long alias
  `agents`).
- [`car inspect`](#car-inspect) — inspect a single installed agent: on-disk
  manifest plus the supervisor's current status.
- [`car start`](#car-start) / [`car stop`](#car-stop) /
  [`car restart`](#car-restart) — control a supervised, installed agent.
- [`car tail-log`](#car-tail-log) — tail an installed agent's captured
  stdout/stderr (long alias `logs`).
- [`car uninstall`](#car-uninstall) — uninstall a contributed agent
  (idempotent).
- [`car registry`](#car-registry) — registry tooling: `digest` a manifest,
  `validate` a registry directory, or print the canonical `schema`.
- [`car publish`](#car-publish) — publish a contributed agent to the
  registry (signs, stages, opens a PR).

### OS integrations

`car` reaches into the OS for accounts, calendar, contacts, mail, messages,
notes, reminders, photos, bookmarks, files, wearable health data, and browser
bookmarks, plus the permission preflight that gates them and voiceprint
enrollment. Most of these are cross-platform (TCC on macOS, WAM/Credential
Manager on Windows, GOA/xdg-desktop-portal on Linux, per the command's own
`--help`); `car notes`, `car reminders`, and `car photos` are macOS-only —
each says so in its own description below:
[`car accounts`](#car-accounts), [`car cal`](#car-cal),
[`car contacts`](#car-contacts), [`car mail`](#car-mail),
[`car messages`](#car-messages), [`car notes`](#car-notes),
[`car reminders`](#car-reminders), [`car photos`](#car-photos),
[`car bookmarks`](#car-bookmarks), [`car files`](#car-files),
[`car health`](#car-health), [`car permissions`](#car-permissions),
[`car voice`](#car-voice).

### Diagnose an install

- [`car doctor`](#car-doctor) — diagnose (and optionally repair) a CAR
  install: corrupt model weights, unparseable `~/.car` state files, version
  skew, leftover files from a previous install. Runs against the local
  filesystem only — no daemon required.
- [`car update`](#car-update) — update the locally-installed `car` CLI and
  its sibling `car-server` daemon to the latest release (or a pinned
  version), in place, reconciling drift between update channels.
- [`car purge`](#car-purge) — remove this install's own state under
  `~/.car` and reap OS-level schedules CAR installed, for a clean slate
  before reinstalling.
- [`car onboard`](#car-onboard) — onboarding readiness: what's set up and
  what's still pending (headless equivalent of the CarHost setup wizard).
- [`car approvals`](#car-approvals) — the default posture for what agents
  may do without asking (CLI counterpart to CarHost's Approvals settings).
- [`car info`](#car-info) — show runtime info.

### Runtime internals

Lower-level commands mostly useful when embedding CAR or debugging the
runtime itself: [`car daemon`](#car-daemon) (start the daemon server),
[`car verify`](#car-verify) / [`car simulate`](#car-simulate) /
[`car optimize`](#car-optimize) (static proposal verification — see
[SPEC.md](./SPEC.md)), [`car replay`](#car-replay) (replay an event journal
and show reconstructed state), [`car policy-check-hook`](#car-policy-check-hook)
(evaluate a host's proposed tool call against `.car/policies/` for that
host's hook decision envelope), [`car ui`](#car-ui) (open the browser
dashboard served by the daemon), [`car project`](#car-project) (manage
CAR-managed, git-backed workspaces), [`car init`](#car-init) (initialize a
`.car/` project directory), [`car browse`](#car-browse) (browser
automation through the runtime), [`car schedule`](#car-schedule) (schedule
commands on a cadence via launchd / cron / schtasks).

---

## All commands

| Command | Description |
|---|---|
| [`car info`](#car-info) | Show runtime info |
| [`car ui`](#car-ui) | Open the browser dashboard served by the daemon |
| [`car verify`](#car-verify) | Statically verify a proposal |
| [`car simulate`](#car-simulate) | Simulate a proposal's state effects without executing |
| [`car optimize`](#car-optimize) | Optimize a proposal (remove phantom dependencies) |
| [`car replay`](#car-replay) | Replay an event journal and show reconstructed state |
| [`car run-task`](#car-run-task) | Run a goal autonomously against stdio MCP tool servers, emitting a JSONL transcript. Headless entry point for external eval harnesses |
| [`car code-task`](#car-code-task) | Run a coder session headlessly and IN THIS PROCESS: derive or accept an outcome contract, work in a git worktree until the runtime's own re-run of that contract is green, then deliver the result as a pull request |
| [`car coder-ab`](#car-coder-ab) | A/B-test CAR's coder against an external agent (Codex / Claude Code) over a corpus, and grow that corpus from git history — the productionized dogfooding loop (docs/proposals/coder-ab-dogfood.md) |
| [`car keys`](#car-keys) | Store cloud-provider API keys in the OS keychain, so a native-app user never sets an environment variable (docs/proposals/native-secrets-no-env.md). The key is read env-first, keychain-fallback by the runtime |
| [`car daemon`](#car-daemon) | Start the daemon server (delegates to car-server binary) |
| [`car models`](#car-models) | Manage local inference models |
| [`car setup`](#car-setup) | Set up the right model for this machine — detect hardware, recommend, and install. Run with no flags for an interactive walkthrough |
| [`car speech`](#car-speech) | Manage CAR speech runtime, health checks, and smoke tests |
| [`car infer`](#car-infer) | Run text generation with a local model |
| [`car image`](#car-image) | Generate an image with a local MLX model |
| [`car video`](#car-video) | Generate a video with a local MLX model |
| [`car embed`](#car-embed) | Generate embeddings for text |
| [`car skills`](#car-skills) | Manage learned skills (SkillRL-inspired) |
| [`car reason`](#car-reason) | Reason about code: diagnose, suggest fixes, explain |
| [`car eval`](#car-eval) | Evaluate agent improvement from stored trajectories |
| [`car identity`](#car-identity) | Show or change the name your assistant answers to — in conversation, in the host apps, and as its voice wake word |
| [`car init`](#car-init) | Initialize a .car/ project directory for team-shared configuration |
| [`car doctor`](#car-doctor) | Diagnose (and optionally repair) a CAR install: corrupt model weights, unparseable `~/.car` state files, version skew, and leftover files from a previous install. Runs entirely against the local filesystem — no daemon required, so it works even when `car-server` won't start |
| [`car update`](#car-update) | Update the locally-installed `car` CLI and its sibling `car-server` daemon to the latest release (or `--version <X.Y.Z>`), in place — regardless of how they were installed. Reconciles the drift that otherwise builds up when one channel updates and another doesn't (e.g. CarHost.app auto-updates its bundled daemon via Sparkle but leaves the `/usr/local/bin/car` CLI behind). The npm/PyPI `car-runtime` client packages are separate — this command never touches them; `car doctor` reports which of your agents have drifted, and prints the exact command per environment. Both remedies pin: `npm install car-runtime@<version>` (`npm update` CANNOT cross a 0.x minor — npm reads `^0.41.0` as `>=0.41.0 <0.42.0`, so it is a no-op) and `<venv>/bin/python -m pip install -U car-runtime==<version>` (a bare `-U` can be silently defeated by the consumer's own pin, and the wrong interpreter installs into an environment that does not hold the stale wheel) |
| [`car purge`](#car-purge) | Remove this CAR install's own state under `~/.car` (config, logs, managed models, binaries) and reap any OS-level schedules CAR installed — for a clean slate before a reinstall. On macOS this also clears CarHost.app's user-level state and resets its privacy (TCC) permissions, so a reinstall really does re-run permission onboarding. NEVER touches the shared HuggingFace model cache (other tools use it); managed models are symlinks into it, so only the links are removed, not the multi-GB blobs. (To uninstall a single contributed agent instead, use `car uninstall <id>`.) |
| [`car code`](#car-code) | Built-in coding agent: state an intent, confirm the verifiable outcome contract, and CAR delivers it in an isolated git worktree — natively or via an installed frontier CLI. Results land on a `car/coder/<id>` branch after your approval; your checkout is never touched |
| [`car board`](#car-board) | Fullscreen supervision board for coder sessions — one screen for every run on this host, whoever started it (`car code`, CarHost, milo, another board). Attach to a run's full history, confirm its outcome contract, answer its questions, approve its diff, or scope work in a repo-grounded discussion first. Closing the board never stops a run |
| [`car do`](#car-do) | CAR Assistant: a general-purpose agent that works out of the box |
| [`car policy-check-hook`](#car-policy-check-hook) | Evaluate a host's proposed tool call against `.car/policies/` and answer on stdout with that host's hook decision envelope |
| [`car project`](#car-project) | Manage CAR-managed projects (a named, git-backed workspace CAR creates for you — no repo to pick) |
| [`car parslee`](#car-parslee) | Parslee platform capabilities for the signed-in account (requires `car auth login`) |
| [`car agent`](#car-agent) | Build and run in-daemon agents from plain-language descriptions. An agent runs inside CAR — nothing to install |
| [`car build`](#car-build) | Build a runnable workflow from a natural-language goal |
| [`car dream`](#car-dream) | Run memory consolidation ("dream") — prune, GC, embed, evolve |
| [`car browse`](#car-browse) | Browser automation — drive Chromium through the CAR runtime |
| [`car secrets`](#car-secrets) | OS-native secret store — Keychain / Credential Manager / Secret Service. Aliased as `secret` (singular) for backward compatibility |
| [`car auth`](#car-auth) | Parslee account authentication for CAR cloud-backed features |
| [`car permissions`](#car-permissions) | OS permission preflight — TCC / Windows Privacy / xdg-desktop-portal |
| [`car voice`](#car-voice) | Voiceprint enrollment — teach CAR your voice so it knows who's speaking (the owner drives commands; other voices are context). Proxies the daemon's `voice.*` surface |
| [`car onboard`](#car-onboard) | Onboarding readiness — what's set up and what's still pending (the headless equivalent of the CarHost setup wizard) |
| [`car approvals`](#car-approvals) | Agent approval policy — the default posture for what agents may do without asking. Proxies the daemon's `agent_permissions.*` surface (the CLI counterpart to the CarHost "Approvals" settings / onboarding step) |
| [`car accounts`](#car-accounts) | OS-native account discovery — Internet Accounts / WAM / GOA |
| [`car cal`](#car-cal) | OS-native Calendar integration |
| [`car contacts`](#car-contacts) | OS-native Contacts integration |
| [`car mail`](#car-mail) | OS-native Mail integration |
| [`car messages`](#car-messages) | OS-native Messages integration |
| [`car notes`](#car-notes) | macOS Notes integration |
| [`car reminders`](#car-reminders) | macOS Reminders integration |
| [`car photos`](#car-photos) | macOS Photos integration |
| [`car bookmarks`](#car-bookmarks) | Browser bookmark integration |
| [`car files`](#car-files) | Account-backed file locations |
| [`car keychain`](#car-keychain) | OS keychain integration |
| [`car health`](#car-health) | Wearable / activity data (HealthKit + Fitbit/Garmin/Oura/etc.) |
| [`car install`](#car-install) | Install a contributed agent — from a local directory OR a registry reference (Parslee-ai/car#182 phases 4 + 5) |
| [`car ls`](#car-ls) | List every installed contributed agent (Parslee-ai/car#182 phase 4). Calls the daemon's `agents.list` and renders the result. Long alias: `agents` |
| [`car inspect`](#car-inspect) | Inspect a single installed agent (Parslee-ai/car#182 phase 4). Shows the on-disk manifest plus the supervisor's current status. Resolves unqualified names to the highest installed semver per the contributed-agents proposal |
| [`car start`](#car-start) | Start an installed contributed agent |
| [`car stop`](#car-stop) | Stop an installed contributed agent |
| [`car restart`](#car-restart) | Restart an installed contributed agent |
| [`car tail-log`](#car-tail-log) | Tail the most recent stdout/stderr lines captured from a supervised agent (Parslee-ai/car#231 §5.2). Calls the daemon's `agents.tail_log`. Closes the DX gap where the daemon captured logs to `~/.car/logs/` (`%USERPROFILE%\.car\logs\` on Windows) but offered no CLI surface to read them. Long alias: `logs` |
| [`car uninstall`](#car-uninstall) | Uninstall a contributed agent (Parslee-ai/car#182 phase 4). Stops the running child if any, removes the manifest from `~/.car/agents/<id>/`, and reaps the legacy `agents.json` entry. Idempotent |
| [`car schedule`](#car-schedule) | Schedule commands to run on a cadence (launchd / cron / schtasks) |
| [`car registry`](#car-registry) | Registry tooling for the contributed-agents registry (Parslee-ai/car#182 phase 5): `digest` a manifest, or `validate` a registry directory (the CI gate run by Parslee-ai/car-agent-registry) |
| [`car publish`](#car-publish) | Publish a contributed agent to the registry (Parslee-ai/car#182 phase 5). Reads a local agent's `manifest.toml`, signs it for `--audience public` (ed25519 key at `$CAR_PUBLISH_KEY_PATH`), stages it at the versioned `agents/<namespace>/<name>/<version>/` path, updates `index.json` + the README catalog, re-runs the EXACT `car registry validate` CI gate locally, and opens a PR against the registry repo. Aborts (no PR) on a missing signing key or a validation failure |
| [`car help`](#car-help) | Print this message or the help of the given subcommand(s) |

---

## Command reference

Full `--help` output for every command, generated directly from the binary.

### car info

```text
Show runtime info

Usage: car info

Options:
  -h, --help  Print help
```

### car ui

```text
Open the browser dashboard served by the daemon

Usage: car ui [OPTIONS]

Options:
  -p, --port <PORT>  Daemon WS port; the dashboard is served on this + 1 [default: 9100]
  -h, --help         Print help
```

### car verify

```text
Statically verify a proposal

Usage: car verify [OPTIONS] <PROPOSAL>

Arguments:
  <PROPOSAL>  Path to proposal JSON file

Options:
      --state <STATE>  Path to initial state JSON file
      --tools <TOOLS>  Comma-separated tool names
  -h, --help           Print help
```

### car simulate

```text
Simulate a proposal's state effects without executing

Usage: car simulate [OPTIONS] <PROPOSAL>

Arguments:
  <PROPOSAL>  Path to proposal JSON file

Options:
      --state <STATE>  Path to initial state JSON file
  -h, --help           Print help
```

### car optimize

```text
Optimize a proposal (remove phantom dependencies)

Usage: car optimize <PROPOSAL>

Arguments:
  <PROPOSAL>  Path to proposal JSON file

Options:
  -h, --help  Print help
```

### car replay

```text
Replay an event journal and show reconstructed state

Usage: car replay <JOURNAL>

Arguments:
  <JOURNAL>  Path to JSONL journal file

Options:
  -h, --help  Print help
```

### car run-task

```text
Run a goal autonomously against stdio MCP tool servers, emitting a JSONL transcript. Headless entry
point for external eval harnesses

Usage: car run-task [OPTIONS] --goal-file <GOAL_FILE> --mcp-config <MCP_CONFIG> --transcript
<TRANSCRIPT> --model <MODEL>

Options:
      --goal-file <GOAL_FILE>    File whose contents are the task instruction
      --mcp-config <MCP_CONFIG>  JSON file listing the stdio MCP servers to expose as tools
      --transcript <TRANSCRIPT>  Where to write the JSONL transcript
      --eventlog <EVENTLOG>      Where to write the engine event journal (optional)
      --max-turns <MAX_TURNS>    Hard cap on agent loop turns [default: 100]
      --model <MODEL>            Inference model id (resolved by CAR's registry/router)
      --resume                   Resume from a checkpoint next to the transcript if one exists
      (survives a crash / SIGKILL / VM-host restart mid-run)
      --gui-subagent             Route GUI (mcp_cua_*) tools through a delegate_gui sub-agent
      instead of exposing them to the main model (also via CAR_RUNTASK_GUI_SUBAGENT=1)
  -h, --help                     Print help
```

### car code-task

```text
Run a coder session headlessly and IN THIS PROCESS: derive or accept an outcome contract, work in a
git worktree until the runtime's own re-run of that contract is green, then deliver the result as a
pull request.

No daemon is contacted and none needs to be running — this drives `car_server_core::coder` as a
library. `car code` is the interactive twin, and it does go through the daemon.

Usage: car code-task [OPTIONS] --repo <REPO>

Options:
      --repo <REPO>
          Repository to work in (must be a git repo)

      --intent-file <INTENT_FILE>
          File whose contents are the intent. Exactly one of --intent-file/--intent

      --intent <INTENT>
          Inline intent. Exactly one of --intent-file/--intent

      --contract-file <CONTRACT_FILE>
          JSON `OutcomeContract`. When present, contract derivation does not run

      --target-branch <TARGET_BRANCH>
          Stable delivery branch. Required for `--deliver pr`

      --pr-base <PR_BASE>
          PR base branch. Defaults to the repo's default branch

      --draft
          Open the pull request as a draft

      --deliver <DELIVER>
          pr | branch | none. Defaults to `pr` when --target-branch is given, else `branch`

          Possible values:
          - pr:     Push the delivery branch and reconcile exactly one pull request for it
          - branch: Create a local `car/coder/<id>` branch in the repo and stop there
          - none:   Verify only. Nothing leaves the worktree

      --model <MODEL>
          Pin the inference model for this session

      --max-iterations <MAX_ITERATIONS>
          Override the coder config's iteration ceiling (default 8)

      --max-session-wall-secs <MAX_SESSION_WALL_SECS>
          Override the coder config's session wall clock (default 3600). 0 = unlimited

      --max-check-timeout-secs <MAX_CHECK_TIMEOUT_SECS>
          Ceiling for ONE contract check's command (default 600). Raise it for a verification gate
          that legitimately runs longer than ten minutes; the model's own `shell` tool keeps the
          600s ceiling regardless

      --workspace-dir <WORKSPACE_DIR>
          Explicit workspace location. Reused when it is already a valid worktree

      --keep-workspace
          Keep the workspace on any non-zero exit (and on a green `--deliver none` run, where the
          worktree is the only copy), for the next round to reuse

      --transcript <TRANSCRIPT>
          Also mirror the JSONL event stream to this file

      --json
          Emit the JSONL event stream on stdout, one compact object per line

  -h, --help
          Print help (see a summary with '-h')
```

### car coder-ab

```text
A/B-test CAR's coder against an external agent (Codex / Claude Code) over a corpus, and grow that
corpus from git history — the productionized dogfooding loop (docs/proposals/coder-ab-dogfood.md)

Usage: car coder-ab <COMMAND>

Commands:
  run      Run the paired A/B over a corpus manifest, verify each arm against the task's own
  contract, and write a JSON report. Exits non-zero when CAR is significantly *behind* the external
  arm (McNemar), so it doubles as a CI regression gate. Needs a running daemon (`car code` routes to
  it)
  extract  Grow the corpus from a git repo's history: for each recent commit that fixes code AND
  touches a test, materialize the pre-fix (failing) state as a task (parent's source + the commit's
  test), keep only tasks whose test actually fails at that state, and append them to a corpus.
  Best-effort candidate generation for human review
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car coder-ab run

```text
Run the paired A/B over a corpus manifest, verify each arm against the task's own contract, and
write a JSON report. Exits non-zero when CAR is significantly *behind* the external arm (McNemar),
so it doubles as a CI regression gate. Needs a running daemon (`car code` routes to it)

Usage: car coder-ab run [OPTIONS] --corpus <CORPUS>

Options:
      --corpus <CORPUS>
          Corpus manifest (JSONL of tasks; see bench/coder-ab/README.md)
      --external <EXTERNAL>
          External comparison engine (codex | claude-code | gemini). Omit to run native-only
      --model <MODEL>
          Pin CAR's arm to a backbone, as a CAR model id (e.g. parslee/reasoning). Backbone choice
          is ~3x the harness spread, so an unpinned run measures the model, not the runtime. NOT
          forwarded to an external arm — a CAR id means nothing to another CLI; use --external-model
          for that arm
      --external-model <EXTERNAL_MODEL>
          Pin the external arm's backbone, in THAT CLI's own id namespace (e.g. gpt-5.5 for `codex
          -m`). Omit and the CLI uses its own configured default — the report then says UNPINNED,
          since the backbone is unverified. For a fair same-backbone A/B pass both flags naming the
          same model (--model parslee/reasoning --external-model gpt-5.5); to measure the cross-tier
          diagonal name different tiers (--model openai/gpt-5.4 --external-model gpt-5.5). Differing
          pins are reported as DIFFERENT PINS and are NOT a harness delta
      --iters <ITERS>
          Native arm's repair-iteration cap per task. Defaults to the coder's OWN shipping default,
          so the A/B measures the coder users actually get — it used to hardcode 4, i.e. half of it.
          Raise it when the cap binds: a weaker backbone needs more rounds, and a run whose losses
          all end at `iteration N/N` is measuring this number, not the harness (at gpt-5.4, 4 → 45%
          and 20 → 75%, every loss cap-bound at both). The external arm is not capped by this — it
          gets its CLI's own turn budget (`max_turns: 50` per invocation), so setting this low is a
          silent handicap [default: 8]
      --out-dir <OUT_DIR>
          Directory for the timestamped JSON report [default: bench/results/coder-ab]
      --timeout-secs <TIMEOUT_SECS>
          Per-task wall bound (seconds) for the NATIVE arm before it's infra. The native reasoning
          loop can legitimately take many minutes [default: 900]
      --external-timeout-secs <EXTERNAL_TIMEOUT_SECS>
          Per-task wall bound (seconds) for the EXTERNAL arm (Codex/Claude Code). An external CLI
          finishes fast or is stuck, so keep this well below `--timeout-secs` — a stuck external run
          otherwise burns the native budget and drags the whole suite [default: 300]
      --limit <LIMIT>
          Run at most this many not-yet-scored tasks, then stop (the rest resume on the next run).
          Omit to run all remaining. `--limit 1` runs one task so you can inspect it and fix what it
          surfaces before continuing
      --fresh
          Ignore any existing checkpoint for this corpus and re-score from scratch
      --report-issues
          File each durable-fix proposal that clears the reporting bar as an issue on --report-repo,
          skipping signatures already open there. Off by default: a measurement run must not open
          issues on a shared tracker as a side effect
      --report-repo <REPORT_REPO>
          Where --report-issues files. The releases repo by default, not the source repo — filing a
          defect report needs no source checkout [default: Parslee-ai/car-releases]
  -h, --help
          Print help
```

#### car coder-ab extract

```text
Grow the corpus from a git repo's history: for each recent commit that fixes code AND touches a
test, materialize the pre-fix (failing) state as a task (parent's source + the commit's test), keep
only tasks whose test actually fails at that state, and append them to a corpus. Best-effort
candidate generation for human review

Usage: car coder-ab extract [OPTIONS] --out <OUT>

Options:
      --repo <REPO>
          Repo to mine (default: current dir)
          
          [default: .]

      --out <OUT>
          Corpus directory to write (`manifest.jsonl` + `tasks/<id>/`)

      --test-cmd <TEST_CMD>
          Command that verifies a task (the contract check), run in each task dir. `pytest -q`
          rather than `python3 -m pytest -q`: `python3` does not exist on a standard Windows
          python.org install, and `python` is often absent on macOS/Linux — pytest's console script
          is the portable spelling
          
          [default: "pytest -q"]

      --path <PATH>
          Only mine commits touching paths under this prefix

      --max <MAX>
          Limit to this many recent commits scanned
          
          [default: 50]

      --max-files <MAX_FILES>
          Skip a commit whose changed-file count exceeds this (keep tasks small)
          
          [default: 6]

      --full-tree
          Materialize the FULL pre-fix source tree into each task (not just the changed files), so a
          package-structured repo's sibling imports resolve and the test fails on the real bug — not
          a `ModuleNotFoundError`. Recommended for any repo whose modules import each other

      --subject-filter <SUBJECT_FILTER>
          Keep only commits whose subject contains this substring (e.g. `fix(`).
          
          On a Rust repo this is close to required: a `feat` commit's test imports a symbol the
          commit itself adds, so it cannot compile at the pre-fix parent. Such tasks are rejected
          anyway, but only after a full tree materialize + build, which costs 30-200s each.

  -h, --help
          Print help (see a summary with '-h')
```

### car keys

```text
Store cloud-provider API keys in the OS keychain, so a native-app user never sets an environment
variable (docs/proposals/native-secrets-no-env.md). The key is read env-first, keychain-fallback by
the runtime

Usage: car keys <COMMAND>

Commands:
  set     Store a provider key in the keychain. `<name>` is a provider
  (openai/anthropic/gemini/elevenlabs/github/aws) or a raw env-var name. Omit `<value>` to read it
  from stdin (keeps it out of shell history)
  list    Show which provider keys are configured (keychain or env); values hidden
  remove  Remove a stored provider key from the keychain
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car keys set

```text
Store a provider key in the keychain. `<name>` is a provider
(openai/anthropic/gemini/elevenlabs/github/aws) or a raw env-var name. Omit `<value>` to read it
from stdin (keeps it out of shell history)

Usage: car keys set <NAME> [VALUE]

Arguments:
  <NAME>   
  [VALUE]  

Options:
  -h, --help  Print help
```

#### car keys list

```text
Show which provider keys are configured (keychain or env); values hidden

Usage: car keys list

Options:
  -h, --help  Print help
```

#### car keys remove

```text
Remove a stored provider key from the keychain

Usage: car keys remove <NAME>

Arguments:
  <NAME>  

Options:
  -h, --help  Print help
```

### car daemon

```text
Start the daemon server (delegates to car-server binary)

Usage: car daemon [OPTIONS]

Options:
  -p, --port <PORT>  Port to listen on [default: 9100]
  -h, --help         Print help
```

### car models

```text
Manage local inference models

Usage: car models <COMMAND>

Commands:
  list             List available models and download status
  discover         Discover models exposed by a running vLLM-MLX server
  pull             Download a model
  resource-policy  Inspect or update the local-model RAM policy
  preflight        Evaluate one local model without downloading or loading it
  adopt            Adopt an already-usable local artifact into CAR ownership
  recommend        Recommend the best model for this machine and what you want to do
  remove           Remove a downloaded model
  upgrades         Show installed models that have curated newer replacements
  upgrade          Upgrade installed models to curated newer replacements when CAR can do so
  serve            Start an external MLX runtime for a cataloged local-server model
  add              Add any HuggingFace model by repo id, deriving its schema automatically
  register         Register a custom model from a JSON schema file
  unregister       Unregister a model by ID
  stats            Show performance stats for models based on observed outcomes
  benchmark        Benchmark curated models and write benchmark priors for cold-start routing
  doctor           Report configured defaults, provider health, and modality coverage
  smoke            Run representative live model checks across text, code, tool, vision, and speech
  route            Route a prompt and show which model would be selected (dry run)
  help             Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car models list

```text
List available models and download status

Usage: car models list [OPTIONS]

Options:
  -c, --capability <CAPABILITY>  Filter by capability (generate, embed, code, reasoning, etc.)
      --provider <PROVIDER>      Filter by provider (e.g., openai, qwen, google, vllm-mlx)
      --local-only               Only show local models
  -h, --help                     Print help
```

#### car models discover

```text
Discover models exposed by a running vLLM-MLX server

Usage: car models discover [OPTIONS]

Options:
      --json  Output as JSON
  -h, --help  Print help
```

#### car models pull

```text
Download a model

Usage: car models pull <NAME>

Arguments:
  <NAME>  Model name (e.g., Qwen3-0.6B, Qwen3-1.7B)

Options:
  -h, --help  Print help
```

#### car models resource-policy

```text
Inspect or update the local-model RAM policy

Usage: car models resource-policy <COMMAND>

Commands:
  get   Show the saved policy and its evaluated machine budget
  set   Persist a policy. Custom values are exact MB in 512 MB increments
  help  Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car models preflight

```text
Evaluate one local model without downloading or loading it

Usage: car models preflight [OPTIONS] <MODEL_ID>

Arguments:
  <MODEL_ID>  

Options:
      --context-tokens <CONTEXT_TOKENS>  [default: 0]
  -h, --help                             Print help
```

#### car models adopt

```text
Adopt an already-usable local artifact into CAR ownership

Usage: car models adopt <MODEL_ID>

Arguments:
  <MODEL_ID>  

Options:
  -h, --help  Print help
```

#### car models recommend

```text
Recommend the best model for this machine and what you want to do

Usage: car models recommend [OPTIONS]

Options:
      --for <USE_CASE>  What you'll use it for: assistant, coding, search, vision, transcription,
      summarize [default: assistant]
      --tier <TIER>     Speed/quality: fastest, balanced, most-capable [default: balanced]
      --cloud-ok        Allow cloud models to compete (default: on-device only)
  -h, --help            Print help
```

#### car models remove

```text
Remove a downloaded model

Usage: car models remove <NAME>

Arguments:
  <NAME>  Model name

Options:
  -h, --help  Print help
```

#### car models upgrades

```text
Show installed models that have curated newer replacements

Usage: car models upgrades [OPTIONS]

Options:
      --json  Output as JSON
  -h, --help  Print help
```

#### car models upgrade

```text
Upgrade installed models to curated newer replacements when CAR can do so

Usage: car models upgrade [OPTIONS]

Options:
      --apply       Actually perform supported downloads/removals. Without this, print a plan
      --remove-old  Remove the older local model after a replacement is available
      --json        Output as JSON
  -h, --help        Print help
```

#### car models serve

```text
Start an external MLX runtime for a cataloged local-server model

Usage: car models serve [OPTIONS] <MODEL>

Arguments:
  <MODEL>  Model id, short alias, or Hugging Face repo to serve

Options:
      --port <PORT>  Port for the OpenAI-compatible local server [default: 8000]
      --dry-run      Print the command without starting the server
      --json         Output as JSON
  -h, --help         Print help
```

#### car models add

```text
Add any HuggingFace model by repo id, deriving its schema automatically

Reads the repo's `config.json` and picks the right backend for you: architectures with an in-process
Rust MLX backend register as native, everything else routes to the supervised vLLM-MLX runtime. This
is the path that does NOT require a CAR release to adopt a new model.

Usage: car models add [OPTIONS] <REPO>

Arguments:
  <REPO>
          HuggingFace repo id, e.g. `mlx-community/Qwen3.8-27B-4bit`

Options:
      --dry-run
          Show the derived schema without registering it

      --pull
          Download the weights now instead of on first use

  -h, --help
          Print help (see a summary with '-h')
```

#### car models register

```text
Register a custom model from a JSON schema file

Usage: car models register <SCHEMA>

Arguments:
  <SCHEMA>  Path to model schema JSON file

Options:
  -h, --help  Print help
```

#### car models unregister

```text
Unregister a model by ID

Usage: car models unregister <ID>

Arguments:
  <ID>  Model ID (e.g., "anthropic/claude-sonnet-4-6:latest")

Options:
  -h, --help  Print help
```

#### car models stats

```text
Show performance stats for models based on observed outcomes

Usage: car models stats [ID]

Arguments:
  [ID]  Model ID (omit for all models)

Options:
  -h, --help  Print help
```

#### car models benchmark

```text
Benchmark curated models and write benchmark priors for cold-start routing

Usage: car models benchmark [OPTIONS]

Options:
      --json                       Output as JSON
      --models <MODELS>            Optional comma-separated model names to benchmark
      --cases <CASES>              Optional comma-separated benchmark case ids
      --judge-model <JUDGE_MODEL>  Optional judge model override
  -h, --help                       Print help
```

#### car models doctor

```text
Report configured defaults, provider health, and modality coverage

Usage: car models doctor [OPTIONS]

Options:
      --json  Output as JSON
      --mlx   Only report MLX runtime/tooling diagnostics
  -h, --help  Print help
```

#### car models smoke

```text
Run representative live model checks across text, code, tool, vision, and speech

Usage: car models smoke [OPTIONS]

Options:
      --json     Output as JSON
      --dry-run  Only validate routing/orchestration without making live model calls
  -h, --help     Print help
```

#### car models route

```text
Route a prompt and show which model would be selected (dry run)

Usage: car models route <PROMPT>

Arguments:
  <PROMPT>  Prompt to route

Options:
  -h, --help  Print help
```

### car setup

```text
Set up the right model for this machine — detect hardware, recommend, and install. Run with no flags
for an interactive walkthrough

Usage: car setup [OPTIONS]

Options:
      --use-case <USE_CASE>  What you'll mainly do: assistant, coding, search, vision,
      transcription, summarize. Prompted if omitted
      --tier <TIER>          Speed/quality preference: fastest, balanced, most-capable [default:
      balanced]
      --cloud-ok             Allow cloud models to compete (default: on-device only)
      --yes                  Don't prompt — accept the top recommendation. For scripts/CI
  -h, --help                 Print help
```

### car speech

```text
Manage CAR speech runtime, health checks, and smoke tests

Usage: car speech <COMMAND>

Commands:
  install  Install the managed speech runtime and curated local speech models
  doctor   Report managed speech runtime, local model cache, and remote-provider health
  smoke    Run end-to-end speech smoke tests through CAR
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car speech install

```text
Install the managed speech runtime and curated local speech models

Usage: car speech install [OPTIONS]

Options:
      --json  Output as JSON
  -h, --help  Print help
```

#### car speech doctor

```text
Report managed speech runtime, local model cache, and remote-provider health

Usage: car speech doctor [OPTIONS]

Options:
      --json  Output as JSON
  -h, --help  Print help
```

#### car speech smoke

```text
Run end-to-end speech smoke tests through CAR

Usage: car speech smoke [OPTIONS]

Options:
      --local-only   Only run the local speech path
      --remote-only  Only run the remote speech path
      --json         Output as JSON
  -h, --help         Print help
```

### car infer

```text
Run text generation with a local model

Usage: car infer [OPTIONS] <PROMPT>

Arguments:
  <PROMPT>  Prompt text

Options:
  -m, --model <MODEL>              Model name (default: Qwen3-1.7B)
      --image <IMAGE>              Local image path to include for vision-language inference. May be
      repeated
      --workload <WORKLOAD>        Workload class for routing: interactive, batch, or background
      [default: interactive]
      --max-tokens <MAX_TOKENS>    Max tokens to generate [default: 512]
      --temperature <TEMPERATURE>  Temperature (0.0 = greedy) [default: 0.7]
      --thinking <THINKING>        Qwen3 thinking mode: `off` injects `/no_think` and prefills a
      closed `<think></think>` block (direct answer, no reasoning); `on` injects `/think` (force
      reasoning); `auto` trusts the model's trained default. CLI defaults to `off` because Qwen3's
      trained default is reasoning-on, which chews through small `--max-tokens` budgets inside an
      unclosed `<think>` block and makes the post-strip text empty (issue #168). Set `auto` or `on`
      for tasks that actually want reasoning, and pair with a larger `--max-tokens` so the model can
      both think and answer [default: off]
  -h, --help                       Print help
```

### car image

```text
Generate an image with a local MLX model

Usage: car image [OPTIONS] <PROMPT>

Arguments:
  <PROMPT>  Prompt text

Options:
  -m, --model <MODEL>        Model name
  -o, --output <OUTPUT>      Output path
      --width <WIDTH>        Image width
      --height <HEIGHT>      Image height
      --steps <STEPS>        Sampling steps
      --guidance <GUIDANCE>  CFG / guidance scale
      --seed <SEED>          Random seed
  -h, --help                 Print help
```

### car video

```text
Generate a video with a local MLX model

Usage: car video [OPTIONS] <PROMPT>

Arguments:
  <PROMPT>  Prompt text

Options:
  -m, --model <MODEL>          Model name
  -o, --output <OUTPUT>        Output path
      --width <WIDTH>          Video width
      --height <HEIGHT>        Video height
      --frames <FRAMES>        Number of frames
      --steps <STEPS>          Sampling steps
      --guidance <GUIDANCE>    CFG / guidance scale
      --fps <FPS>              Frames per second
      --seed <SEED>            Random seed
      --image <IMAGE>          Reference image for image-to-video (first frame anchor)
      --audio-video            Enable joint audio+video synthesis (text-to-(video+audio))
      --audio <AUDIO>          Audio-reference conditioning (#113) — drives video timing off the
      audio bytes using the LTX audio-to-video path. Mutually exclusive with `--audio-video` and
      `--audio-mux`
      --audio-mux <AUDIO_MUX>  Audio path for downstream muxing. The generated video is text-only
      (no audio conditioning); the path is recorded on the request so downstream tooling (e.g.
      Musicart) can find it and mux a final track. The path-records-only behavior previously hid
      behind `--audio` and silently produced text-only video; `--audio-mux` makes the intent
      explicit (Parslee-ai/car#183). Mutually exclusive with `--audio` and `--audio-video`
  -h, --help                   Print help
```

### car embed

```text
Generate embeddings for text

Usage: car embed [OPTIONS] <TEXT>

Arguments:
  <TEXT>  Text to embed

Options:
  -m, --model <MODEL>  Model name (default: Qwen3-0.6B)
  -h, --help           Print help
```

### car skills

```text
Manage learned skills (SkillRL-inspired)

Usage: car skills <COMMAND>

Commands:
  distill  Distill skills from an event log journal
  list     List skills in a memory file
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car skills distill

```text
Distill skills from an event log journal

Usage: car skills distill [OPTIONS] <JOURNAL>

Arguments:
  <JOURNAL>  Path to JSONL journal file

Options:
  -o, --output <OUTPUT>  Output skills to this JSON file (default: print to stdout)
  -h, --help             Print help
```

#### car skills list

```text
List skills in a memory file

Usage: car skills list [OPTIONS] <MEMORY>

Arguments:
  <MEMORY>  Path to memory JSON file

Options:
  -d, --domain <DOMAIN>  Filter by domain
  -h, --help             Print help
```

### car reason

```text
Reason about code: diagnose, suggest fixes, explain

Usage: car reason [OPTIONS] <PROBLEM>

Arguments:
  <PROBLEM>  Problem description or question

Options:
      --format <FORMAT>  Output format: text (default) or json [default: text]
  -h, --help             Print help
```

### car eval

```text
Evaluate agent improvement from stored trajectories

Usage: car eval [OPTIONS]

Options:
  -t, --trajectories <TRAJECTORIES>  Path to trajectory store directory (default:
  ~/.car/trajectories/)
      --json                         Output as JSON instead of human-readable
  -h, --help                         Print help
```

### car identity

```text
Show or change the name your assistant answers to — in conversation, in the host apps, and as its
voice wake word

Usage: car identity [COMMAND]

Commands:
  show      Show the current name, the spoken forms it wakes on, and where the record lives
  set       Name the assistant. Takes effect for its system prompt, the host apps, and its voice
  wake word
  set-user  Tell the assistant what to call YOU
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car identity show

```text
Show the current name, the spoken forms it wakes on, and where the record lives

Usage: car identity show

Options:
  -h, --help  Print help
```

#### car identity set

```text
Name the assistant. Takes effect for its system prompt, the host apps, and its voice wake word

Usage: car identity set [OPTIONS] <NAME>

Arguments:
  <NAME>  What to call it, e.g. `Jarvis`

Options:
      --also-hear <SPELLING>  Another way speech-to-text might hear the name, e.g. `jervis`.
      Repeatable. Only useful for voice
  -h, --help                  Print help
```

#### car identity set-user

```text
Tell the assistant what to call YOU

Usage: car identity set-user <NAME>

Arguments:
  <NAME>  Your name, or `-` to clear it

Options:
  -h, --help  Print help
```

### car init

```text
Initialize a .car/ project directory for team-shared configuration

Usage: car init [OPTIONS]

Options:
  -d, --dir <DIR>  Directory to create .car/ in (default: current directory)
  -h, --help       Print help
```

### car doctor

```text
Diagnose (and optionally repair) a CAR install: corrupt model weights, unparseable `~/.car` state
files, version skew, and leftover files from a previous install. Runs entirely against the local
filesystem — no daemon required, so it works even when `car-server` won't start

Usage: car doctor [OPTIONS]

Options:
      --repair  Apply safe repairs: purge corrupt cache files (re-pull afterward), back up
      unparseable state files, refresh the version stamp. Never deletes unrecognized entries or
      anything not provably corrupt
      --deep    Deep-verify model weights (recompute sha256 vs the HuggingFace etag) instead of the
      cheap presence/non-empty check. Slower but catches truncated-but-non-empty corruption
  -h, --help    Print help
```

### car update

```text
Update the locally-installed `car` CLI and its sibling `car-server` daemon to the latest release (or
`--version <X.Y.Z>`), in place — regardless of how they were installed. Reconciles the drift that
otherwise builds up when one channel updates and another doesn't (e.g. CarHost.app auto-updates its
bundled daemon via Sparkle but leaves the `/usr/local/bin/car` CLI behind). The npm/PyPI
`car-runtime` client packages are separate — this command never touches them; `car doctor` reports
which of your agents have drifted, and prints the exact command per environment. Both remedies pin:
`npm install car-runtime@<version>` (`npm update` CANNOT cross a 0.x minor — npm reads `^0.41.0` as
`>=0.41.0 <0.42.0`, so it is a no-op) and `<venv>/bin/python -m pip install -U
car-runtime==<version>` (a bare `-U` can be silently defeated by the consumer's own pin, and the
wrong interpreter installs into an environment that does not hold the stale wheel)

Usage: car update [OPTIONS]

Options:
      --check              Report whether a newer version exists without downloading anything
      --version <VERSION>  Install a specific version (e.g. `0.34.0`) instead of the latest
      --force              Re-install even if already on the target version (repair a partial or
      corrupt install)
  -h, --help               Print help
```

### car purge

```text
Remove this CAR install's own state under `~/.car` (config, logs, managed models, binaries) and reap
any OS-level schedules CAR installed — for a clean slate before a reinstall. On macOS this also
clears CarHost.app's user-level state and resets its privacy (TCC) permissions, so a reinstall
really does re-run permission onboarding. NEVER touches the shared HuggingFace model cache (other
tools use it); managed models are symlinks into it, so only the links are removed, not the multi-GB
blobs. (To uninstall a single contributed agent instead, use `car uninstall <id>`.)

Usage: car purge [OPTIONS]

Options:
      --dry-run           Show what would be removed and exit without deleting anything
  -y, --yes               Skip the confirmation prompt
      --keep-secrets      Keep `~/.car/env` (the dotenv secrets file) so a reinstall doesn't need
      API keys re-entered
      --keep-permissions  macOS: keep CarHost.app's privacy (TCC) grants — Accessibility, Screen
      Recording, Automation, … — instead of resetting them. For using `car purge` as a state reset
      rather than an uninstall
  -h, --help              Print help
```

### car code

```text
Built-in coding agent: state an intent, confirm the verifiable outcome contract, and CAR delivers it
in an isolated git worktree — natively or via an installed frontier CLI. Results land on a
`car/coder/<id>` branch after your approval; your checkout is never touched

Usage: car code [OPTIONS] [INTENT]...

Arguments:
  [INTENT]...  What to build or fix, in plain English

Options:
      --repo <REPO>
          Repository to work on. Relative paths (`.`, `../sibling`) resolve against your current
          directory (default: `.`)
      --engine <ENGINE>
          Engine: auto | native | external[:agent_id] | foreman[:agent_id]. Foreman farms subtasks
          to the external CLI in parallel worktrees behind a merge-verify gate; auto prefers it for
          broad tasks
  -y, --yes
          Skip the interactive contract and merge prompts
      --max-iterations <MAX_ITERATIONS>
          Max plan→edit→verify iterations before giving up
      --model <MODEL>
          Pin the native loop's inference model for this session (e.g. `parslee/reasoning` for
          gpt-5.5), overriding `~/.car/coder.toml`. Blank/omitted keeps the config default, then
          adaptive routing
  -h, --help
          Print help
```

### car board

```text
Fullscreen supervision board for coder sessions — one screen for every run on this host, whoever
started it (`car code`, CarHost, milo, another board). Attach to a run's full history, confirm its
outcome contract, answer its questions, approve its diff, or scope work in a repo-grounded
discussion first. Closing the board never stops a run

Usage: car board [OPTIONS]

Options:
      --repo <REPO>  Repository the board opens against — pre-fills new runs and grounds
      discussions. Relative paths (`.`, `../sibling`) resolve against your current directory
      (default: `.`)
  -h, --help         Print help
```

### car do

```text
CAR Assistant: a general-purpose agent that works out of the box.

With a goal it runs once and prints the result; with no goal it opens an interactive REPL. It comes
wired with files, a real shell, web access, and durable memory, and runs sandbox-first (a hardened
Docker container) so edits are isolated. `--local` runs on the host; `--serve` runs it as a
supervised, conversational agent for CarHost.

Usage: car do [OPTIONS] [GOAL]...

Arguments:
  [GOAL]...
          What you want done, in plain English. Omit for an interactive REPL

Options:
      --local
          Run on the LOCAL host instead of the default Docker sandbox. Writes and shell then require
          --full-access

  -y, --full-access
          Allow file writes and shell on the local host without prompting. (No effect in the
          sandbox, which is already isolated.)

      --dir <DIR>
          Working directory (default: current directory)

      --model <MODEL>
          Inference model id (default: a tool-capable model chosen for you)

      --image <IMAGE>
          Docker image for the sandbox (default: python:3.11, which bundles git/gcc/curl). Ignored
          with --local

      --max-turns <MAX_TURNS>
          Safety cap on agent turns. This is a backstop, not the expected stop: the loop ends on its
          own when the model finishes (stops calling tools). 12 was too low for whole-project builds
          — it cut real work off mid-task; raise it further for large jobs
          
          [default: 50]

      --until <SHELL>
          Goal mode: keep working until this shell command exits 0 (a DETERMINISTIC completion check
          the runtime runs itself — unlike `/goal`, which asks a model to judge the transcript).
          Re-drives the agent each round with the failure as guidance. E.g. `--until 'cargo test
          -q'`

      --infer-until
          Infer a deterministic --until check from the prompt and working directory, then run goal
          mode. Refuses to run if no concrete check can be inferred

      --goal-max-iterations <GOAL_MAX_ITERATIONS>
          In goal mode, the hard cap on re-drive iterations (the governor's turn budget). A hard
          bound, not a soft prose clause
          
          [default: 10]

      --serve
          Run as a supervised, conversational agent (for CarHost / agents.chat)

      --governed-host
          Run the supervised assistant on the real host with repository, approval, and
          durable-action governance. Requires an explicit `--dir` naming a Git repository; rejects
          `/` and the home directory

      --json
          Machine-readable output for a calling agent or script: exactly one JSON document on
          stdout, JSONL progress events on stderr, and no human progress rendering. Needs a goal —
          there is no JSON shape for an interactive REPL. See docs/car-do-json.md

  -h, --help
          Print help (see a summary with '-h')
```

### car policy-check-hook

```text
Evaluate a host's proposed tool call against `.car/policies/` and answer on stdout with that host's
hook decision envelope.

Reads a Claude Code / Codex `PreToolUse` payload on stdin. Wire it into a plugin as a `PreToolUse`
command hook and the operator's policy rules govern the agent in their editor, not just CAR's own
loop.

Fails OPEN on anything it cannot evaluate (and says why on stderr), and CLOSED on a genuine deny —
including a policy file that will not parse.

Usage: car policy-check-hook

Options:
  -h, --help
          Print help (see a summary with '-h')
```

### car project

```text
Manage CAR-managed projects (a named, git-backed workspace CAR creates for you — no repo to pick)

Usage: car project <COMMAND>

Commands:
  new   Create a managed project (idempotent — re-running loads it)
  list  List your managed projects
  help  Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car project new

```text
Create a managed project (idempotent — re-running loads it)

Usage: car project new [OPTIONS] [NAME]...

Arguments:
  [NAME]...  A friendly name (CAR derives a slug)

Options:
      --kind <KIND>  `app` (code) or `agent` (an in-daemon agent) [default: app]
  -h, --help         Print help
```

#### car project list

```text
List your managed projects

Usage: car project list

Options:
  -h, --help  Print help
```

### car parslee

```text
Parslee platform capabilities for the signed-in account (requires `car auth login`)

Usage: car parslee <COMMAND>

Commands:
  capabilities       Discover what your Parslee account can do — identity, product entitlements, and
  Studio reachability. Read-only
  generate-document  Generate a Word document from a natural-language brief and save it to your
  connected drive (OneDrive/Google Drive). Requires the `aie` product
  help               Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car parslee capabilities

```text
Discover what your Parslee account can do — identity, product entitlements, and Studio reachability.
Read-only

Usage: car parslee capabilities [OPTIONS]

Options:
      --json  Print the raw JSON response instead of a summary
  -h, --help  Print help
```

#### car parslee generate-document

```text
Generate a Word document from a natural-language brief and save it to your connected drive
(OneDrive/Google Drive). Requires the `aie` product

Usage: car parslee generate-document [OPTIONS] --brief <BRIEF> --out <OUT>

Options:
      --brief <BRIEF>    What the document should contain (20–2000 chars)
      --out <OUT>        Output path in your drive, e.g. "Generated/report.docx"
      --type <DOC_TYPE>  Report | Proposal | Memo | Letter | Contract | ExecutiveSummary |
      MeetingMinutes | ProjectPlan [default: Report]
      --title <TITLE>    Optional title override
      --author <AUTHOR>  Optional author name for document metadata
  -h, --help             Print help
```

### car agent

```text
Build and run in-daemon agents from plain-language descriptions. An agent runs inside CAR — nothing
to install

Usage: car agent <COMMAND>

Commands:
  new       Describe an agent in plain language; CAR builds, verifies, and registers it to run
  in-daemon
  run       Run a registered agent on an input
  list      List registered in-daemon agents
  external  Show installed external agentic CLIs (Claude Code, Codex, Gemini): which binary each
  resolved to, and whether it can actually run
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car agent new

```text
Describe an agent in plain language; CAR builds, verifies, and registers it to run in-daemon

Usage: car agent new [OPTIONS] [DESCRIPTION]...

Arguments:
  [DESCRIPTION]...  What the agent should do

Options:
  -y, --yes   Skip the interactive confirm/approve prompts
  -h, --help  Print help
```

#### car agent run

```text
Run a registered agent on an input

Usage: car agent run <ID> [INPUT]...

Arguments:
  <ID>        The agent id (its project slug)
  [INPUT]...  The input to give it

Options:
  -h, --help  Print help
```

#### car agent list

```text
List registered in-daemon agents

Usage: car agent list

Options:
  -h, --help  Print help
```

#### car agent external

```text
Show installed external agentic CLIs (Claude Code, Codex, Gemini): which binary each resolved to,
and whether it can actually run.

Runs detection in-process, so it works with the daemon stopped — diagnosing a CLI that won't start
should not require a healthy daemon. Exits non-zero if any detected CLI cannot be executed.

Usage: car agent external [OPTIONS]

Options:
      --json
          Emit the raw `[ExternalAgentSpec]` JSON instead of a table

  -h, --help
          Print help (see a summary with '-h')
```

### car build

```text
Build a runnable workflow from a natural-language goal.

Generates a car-workflow manifest with a model, validates it with the runtime verifier (repairing on
failure), shows it for approval, and saves it. Use --update to edit an existing workflow file.

Usage: car build [OPTIONS] [GOAL]...

Arguments:
  [GOAL]...
          What the workflow should do, in plain English

Options:
  -o, --output <OUTPUT>
          Where to write the workflow JSON (default: ~/.car/workflows/<id>.json)

  -u, --update <UPDATE>
          Update this existing workflow file instead of creating a new one

  -y, --yes
          Save without the interactive approval prompt

      --max-attempts <MAX_ATTEMPTS>
          Max generate→validate→repair attempts per round
          
          [default: 3]

  -h, --help
          Print help (see a summary with '-h')
```

### car dream

```text
Run memory consolidation ("dream") — prune, GC, embed, evolve

Usage: car dream [OPTIONS]

Options:
  -m, --memory <MEMORY>          Path to memory graph JSON file (default: ~/.car/memory.json)
  -e, --embeddings <EMBEDDINGS>  Path to embeddings cache file (default: ~/.car/embeddings.bin)
      --json                     Output as JSON instead of human-readable
  -h, --help                     Print help
```

### car browse

```text
Browser automation — drive Chromium through the CAR runtime

Usage: car browse <COMMAND>

Commands:
  run     Execute a script of browser operations in order. See docs for the script JSON schema (see
  crates/car-cli/BROWSE.md once published)
  schema  Print the script schema and the list of supported operations
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car browse run

```text
Execute a script of browser operations in order. See docs for the script JSON schema (see
crates/car-cli/BROWSE.md once published)

Usage: car browse run [OPTIONS] <SCRIPT>

Arguments:
  <SCRIPT>  Path to the script JSON file. Use `-` for stdin

Options:
      --width <WIDTH>    Viewport width in pixels [default: 1280]
      --height <HEIGHT>  Viewport height in pixels [default: 720]
      --headed           Launch a visible Chromium window instead of headless. Intended for
      interactive flows (first-time auth, 2FA, captcha) where a human completes a step mid-script
      before the automation runs headless against the captured session
      --pretty           Output trace as pretty JSON instead of compact
  -h, --help             Print help
```

#### car browse schema

```text
Print the script schema and the list of supported operations

Usage: car browse schema

Options:
  -h, --help  Print help
```

### car secrets

```text
OS-native secret store — Keychain / Credential Manager / Secret Service. Aliased as `secret`
(singular) for backward compatibility

Usage: car secrets <COMMAND>

Commands:
  put               Store a secret. Value is read from --value or piped stdin
  get               Retrieve a secret — prints the value on stdout
  delete            Delete a secret (idempotent)
  status            Check whether a secret exists, without returning the value
  available         Probe whether the OS secret store is reachable on this host
  migrate-from-env  Walk known remote-model env vars and copy any non-empty values from process env
  into the OS keychain. Idempotent — running again only rewrites entries when the env value differs
  from what's stored
  help              Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car secrets put

```text
Store a secret. Value is read from --value or piped stdin

Usage: car secrets put [OPTIONS] <KEY>

Arguments:
  <KEY>  

Options:
      --service <SERVICE>  
      --value <VALUE>      
  -h, --help               Print help
```

#### car secrets get

```text
Retrieve a secret — prints the value on stdout

Usage: car secrets get [OPTIONS] <KEY>

Arguments:
  <KEY>  

Options:
      --service <SERVICE>  
  -h, --help               Print help
```

#### car secrets delete

```text
Delete a secret (idempotent)

Usage: car secrets delete [OPTIONS] <KEY>

Arguments:
  <KEY>  

Options:
      --service <SERVICE>  
  -h, --help               Print help
```

#### car secrets status

```text
Check whether a secret exists, without returning the value

Usage: car secrets status [OPTIONS] <KEY>

Arguments:
  <KEY>  

Options:
      --service <SERVICE>  
  -h, --help               Print help
```

#### car secrets available

```text
Probe whether the OS secret store is reachable on this host

Usage: car secrets available

Options:
  -h, --help  Print help
```

#### car secrets migrate-from-env

```text
Walk known remote-model env vars and copy any non-empty values from process env into the OS
keychain. Idempotent — running again only rewrites entries when the env value differs from what's
stored.

One-time setup for users moving away from `~/.car/env`. After migration, you can `unset
OPENAI_API_KEY` (etc.) in your shell rc and the keychain entries will be picked up at runtime by
car-inference.

Usage: car secrets migrate-from-env [OPTIONS]

Options:
      --dry-run
          Print what would be migrated without writing anything

      --service <SERVICE>
          Service to write entries under. Defaults to "car" (the per-app namespace; same one
          car-inference reads at runtime)

      --include <ENV_VAR>
          Additional env-var names to migrate beyond the built-in remote-model defaults
          (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY). Repeatable

  -h, --help
          Print help (see a summary with '-h')
```

### car auth

```text
Parslee account authentication for CAR cloud-backed features

Usage: car auth <COMMAND>

Commands:
  login           Sign in with a Parslee account using browser-based OAuth + PKCE
  status          Show whether CAR has a usable Parslee account token
  logout          Remove stored Parslee account tokens from the OS keychain
  orgs            List the organizations the signed-in account belongs to (active marked)
  switch-org      Switch the account's active organization by id (e.g. `org_parslee`)
  accounts        List all stored Parslee logins (active marked)
  switch-account  Switch the active Parslee login by account id
  help            Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car auth login

```text
Sign in with a Parslee account using browser-based OAuth + PKCE

Usage: car auth login [OPTIONS]

Options:
      --api-base <API_BASE>            Parslee API base URL [default: https://api.parslee.ai]
      --client-id <CLIENT_ID>          OAuth client id registered in the Parslee backend [default:
      parslee-car]
      --callback-port <CALLBACK_PORT>  Local callback port. The backend must allow this exact
      redirect URI [default: 53682]
      --provider <PROVIDER>            Provider hint forwarded to Parslee authorize (`microsoft` or
      `google`)
      --add                            Add a second Parslee login alongside the current one (forces
      the account chooser) instead of replacing it
  -h, --help                           Print help
```

#### car auth status

```text
Show whether CAR has a usable Parslee account token

Usage: car auth status [OPTIONS]

Options:
      --api-base <API_BASE>  Parslee API base URL override
      --json                 Print the raw session object from the Parslee API instead of a summary.
      The shape is the upstream API's and is not a CAR contract
  -h, --help                 Print help
```

#### car auth logout

```text
Remove stored Parslee account tokens from the OS keychain

Usage: car auth logout

Options:
  -h, --help  Print help
```

#### car auth orgs

```text
List the organizations the signed-in account belongs to (active marked)

Usage: car auth orgs [OPTIONS]

Options:
      --api-base <API_BASE>  Parslee API base URL override
  -h, --help                 Print help
```

#### car auth switch-org

```text
Switch the account's active organization by id (e.g. `org_parslee`)

Usage: car auth switch-org [OPTIONS] <ORGANIZATION_ID>

Arguments:
  <ORGANIZATION_ID>  Target organization id

Options:
      --api-base <API_BASE>  Parslee API base URL override
  -h, --help                 Print help
```

#### car auth accounts

```text
List all stored Parslee logins (active marked)

Usage: car auth accounts [OPTIONS]

Options:
      --api-base <API_BASE>  Parslee API base URL override
  -h, --help                 Print help
```

#### car auth switch-account

```text
Switch the active Parslee login by account id

Usage: car auth switch-account [OPTIONS] <ACCOUNT_ID>

Arguments:
  <ACCOUNT_ID>  Target account id (from `car auth accounts`)

Options:
      --api-base <API_BASE>  Parslee API base URL override
  -h, --help                 Print help
```

### car permissions

```text
OS permission preflight — TCC / Windows Privacy / xdg-desktop-portal

Usage: car permissions <COMMAND>

Commands:
  status   Report current grant state for a domain
  request  Trigger a native prompt if the OS supports one
  explain  Human-readable explanation and fix suggestion
  domains  List all known domains
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car permissions status

```text
Report current grant state for a domain

Usage: car permissions status [OPTIONS] <DOMAIN>

Arguments:
  <DOMAIN>  

Options:
      --target <TARGET>  macOS Automation only: bundle ID of the target app to control. Ignored for
      other domains
  -h, --help             Print help
```

#### car permissions request

```text
Trigger a native prompt if the OS supports one

Usage: car permissions request [OPTIONS] <DOMAIN>

Arguments:
  <DOMAIN>  

Options:
      --target <TARGET>  
  -h, --help             Print help
```

#### car permissions explain

```text
Human-readable explanation and fix suggestion

Usage: car permissions explain [OPTIONS] <DOMAIN>

Arguments:
  <DOMAIN>  

Options:
      --target <TARGET>  
  -h, --help             Print help
```

#### car permissions domains

```text
List all known domains

Usage: car permissions domains

Options:
  -h, --help  Print help
```

### car voice

```text
Voiceprint enrollment — teach CAR your voice so it knows who's speaking (the owner drives commands;
other voices are context). Proxies the daemon's `voice.*` surface

Usage: car voice <COMMAND>

Commands:
  enroll  Enroll a voiceprint from a WAV recording. The daemon decodes the file and saves a
  voiceprint under `~/.car/voiceprints/<label>.toml`
  list    List enrolled voiceprints
  remove  Remove an enrolled voiceprint by label
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car voice enroll

```text
Enroll a voiceprint from a WAV recording. The daemon decodes the file and saves a voiceprint under
`~/.car/voiceprints/<label>.toml`

Usage: car voice enroll --label <LABEL> --wav <WAV>

Options:
      --label <LABEL>  A name for this voice, e.g. your first name
      --wav <WAV>      Path to a WAV recording of the speaker (a few seconds is enough)
  -h, --help           Print help
```

#### car voice list

```text
List enrolled voiceprints

Usage: car voice list

Options:
  -h, --help  Print help
```

#### car voice remove

```text
Remove an enrolled voiceprint by label

Usage: car voice remove --label <LABEL>

Options:
      --label <LABEL>  
  -h, --help           Print help
```

### car onboard

```text
Onboarding readiness — what's set up and what's still pending (the headless equivalent of the
CarHost setup wizard)

Usage: car onboard

Options:
  -h, --help  Print help
```

### car approvals

```text
Agent approval policy — the default posture for what agents may do without asking. Proxies the
daemon's `agent_permissions.*` surface (the CLI counterpart to the CarHost "Approvals" settings /
onboarding step)

Usage: car approvals <COMMAND>

Commands:
  default  Set the default approval preset for all agents (`cautious` asks before any
  edit/full-access, `balanced` allows sandboxed edits, `trusting` allows everything without asking)
  get      Show the current default approval posture
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car approvals default

```text
Set the default approval preset for all agents (`cautious` asks before any edit/full-access,
`balanced` allows sandboxed edits, `trusting` allows everything without asking)

Usage: car approvals default <PRESET>

Arguments:
  <PRESET>  One of: cautious | balanced | trusting

Options:
  -h, --help  Print help
```

#### car approvals get

```text
Show the current default approval posture

Usage: car approvals get

Options:
  -h, --help  Print help
```

### car accounts

```text
OS-native account discovery — Internet Accounts / WAM / GOA

Usage: car accounts <COMMAND>

Commands:
  list  List accounts visible to the OS
  open  Open the native account-management UI
  help  Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car accounts list

```text
List accounts visible to the OS

Usage: car accounts list

Options:
  -h, --help  Print help
```

#### car accounts open

```text
Open the native account-management UI

Usage: car accounts open [OPTIONS]

Options:
      --account-id <ACCOUNT_ID>  
  -h, --help                     Print help
```

### car cal

```text
OS-native Calendar integration

Usage: car cal <COMMAND>

Commands:
  list    List visible calendars across all sources
  events  List events in an ISO-8601 time range
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car cal list

```text
List visible calendars across all sources

Usage: car cal list

Options:
  -h, --help  Print help
```

#### car cal events

```text
List events in an ISO-8601 time range

Usage: car cal events [OPTIONS] --start <START> --end <END>

Options:
      --start <START>          RFC3339 / ISO-8601 start time
      --end <END>              RFC3339 / ISO-8601 end time
      --calendars <CALENDARS>  Optional comma-separated list of calendar IDs
  -h, --help                   Print help
```

### car contacts

```text
OS-native Contacts integration

Usage: car contacts <COMMAND>

Commands:
  containers  List containers (a.k.a. sources / accounts within Contacts)
  find        Free-text contact search
  help        Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car contacts containers

```text
List containers (a.k.a. sources / accounts within Contacts)

Usage: car contacts containers

Options:
  -h, --help  Print help
```

#### car contacts find

```text
Free-text contact search

Usage: car contacts find [OPTIONS] <QUERY>

Arguments:
  <QUERY>  

Options:
      --limit <LIMIT>            [default: 50]
      --containers <CONTAINERS>  
  -h, --help                     Print help
```

### car mail

```text
OS-native Mail integration

Usage: car mail <COMMAND>

Commands:
  accounts   List mail accounts known to the backend
  inbox      Inbox summaries per account
  mailboxes  List every mailbox (folder) per account, nested ones included (on Microsoft Graph the
  nested walk is bounded: depth 8, 64 requests)
  messages   Read message rows from one mailbox, newest first across all matched accounts (not
  newest-first per account, then concatenated)
  body       Fetch one message body by the `id` from `car mail messages`
  send       Send (or draft) a message. JSON payload on stdin matching SendRequest
  help       Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car mail accounts

```text
List mail accounts known to the backend

Usage: car mail accounts

Options:
  -h, --help  Print help
```

#### car mail inbox

```text
Inbox summaries per account

Usage: car mail inbox [OPTIONS]

Options:
      --accounts <ACCOUNTS>  
  -h, --help                 Print help
```

#### car mail mailboxes

```text
List every mailbox (folder) per account, nested ones included (on Microsoft Graph the nested walk is
bounded: depth 8, 64 requests)

Usage: car mail mailboxes [OPTIONS]

Options:
      --accounts <ACCOUNTS>  
  -h, --help                 Print help
```

#### car mail messages

```text
Read message rows from one mailbox, newest first across all matched accounts (not newest-first per
account, then concatenated)

Usage: car mail messages [OPTIONS]

Options:
      --accounts <ACCOUNTS>  
      --mailbox <MAILBOX>    Mailbox selector — a `full_name` from `car mail mailboxes`, or a bare
      leaf name like "Travel". Defaults to INBOX
      --limit <LIMIT>        [default: 50]
      --since <SINCE>        Only messages received at or after this RFC3339 instant
      --include-body         Include each message's body inline (bounded per message)
  -h, --help                 Print help
```

#### car mail body

```text
Fetch one message body by the `id` from `car mail messages`

Usage: car mail body <ID>

Arguments:
  <ID>  

Options:
  -h, --help  Print help
```

#### car mail send

```text
Send (or draft) a message. JSON payload on stdin matching SendRequest

Usage: car mail send

Options:
  -h, --help  Print help
```

### car messages

```text
OS-native Messages integration

Usage: car messages <COMMAND>

Commands:
  services  List Messages.app services/accounts
  chats     List recent Messages.app chats
  send      Send a message. JSON payload on stdin matching Messages SendRequest
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car messages services

```text
List Messages.app services/accounts

Usage: car messages services

Options:
  -h, --help  Print help
```

#### car messages chats

```text
List recent Messages.app chats

Usage: car messages chats [OPTIONS]

Options:
      --limit <LIMIT>  [default: 50]
  -h, --help           Print help
```

#### car messages send

```text
Send a message. JSON payload on stdin matching Messages SendRequest

Usage: car messages send

Options:
  -h, --help  Print help
```

### car notes

```text
macOS Notes integration

Usage: car notes <COMMAND>

Commands:
  accounts  List Notes.app accounts
  find      Free-text note search
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car notes accounts

```text
List Notes.app accounts

Usage: car notes accounts

Options:
  -h, --help  Print help
```

#### car notes find

```text
Free-text note search

Usage: car notes find [OPTIONS] <QUERY>

Arguments:
  <QUERY>  

Options:
      --limit <LIMIT>  [default: 50]
  -h, --help           Print help
```

### car reminders

```text
macOS Reminders integration

Usage: car reminders <COMMAND>

Commands:
  lists  List Reminders.app lists
  items  List incomplete reminders
  help   Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car reminders lists

```text
List Reminders.app lists

Usage: car reminders lists

Options:
  -h, --help  Print help
```

#### car reminders items

```text
List incomplete reminders

Usage: car reminders items [OPTIONS]

Options:
      --limit <LIMIT>  [default: 50]
  -h, --help           Print help
```

### car photos

```text
macOS Photos integration

Usage: car photos <COMMAND>

Commands:
  albums  List Photos.app albums
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car photos albums

```text
List Photos.app albums

Usage: car photos albums

Options:
  -h, --help  Print help
```

### car bookmarks

```text
Browser bookmark integration

Usage: car bookmarks <COMMAND>

Commands:
  list  List Safari bookmarks
  help  Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car bookmarks list

```text
List Safari bookmarks

Usage: car bookmarks list [OPTIONS]

Options:
      --limit <LIMIT>  [default: 100]
  -h, --help           Print help
```

### car files

```text
Account-backed file locations

Usage: car files <COMMAND>

Commands:
  locations  List standard account-backed file locations
  help       Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car files locations

```text
List standard account-backed file locations

Usage: car files locations

Options:
  -h, --help  Print help
```

### car keychain

```text
OS keychain integration

Usage: car keychain <COMMAND>

Commands:
  status  Backend availability status
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car keychain status

```text
Backend availability status

Usage: car keychain status

Options:
  -h, --help  Print help
```

### car health

```text
Wearable / activity data (HealthKit + Fitbit/Garmin/Oura/etc.)

Usage: car health <COMMAND>

Commands:
  status    Backend availability + guidance
  sleep     Sleep windows in an ISO-8601 time range
  workouts  Workouts in an ISO-8601 time range
  activity  Daily activity summaries across a date range (YYYY-MM-DD)
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car health status

```text
Backend availability + guidance

Usage: car health status

Options:
  -h, --help  Print help
```

#### car health sleep

```text
Sleep windows in an ISO-8601 time range

Usage: car health sleep --start <START> --end <END>

Options:
      --start <START>  
      --end <END>      
  -h, --help           Print help
```

#### car health workouts

```text
Workouts in an ISO-8601 time range

Usage: car health workouts --start <START> --end <END>

Options:
      --start <START>  
      --end <END>      
  -h, --help           Print help
```

#### car health activity

```text
Daily activity summaries across a date range (YYYY-MM-DD)

Usage: car health activity --start <START> --end <END>

Options:
      --start <START>  
      --end <END>      
  -h, --help           Print help
```

### car install

```text
Install a contributed agent — from a local directory OR a registry reference (Parslee-ai/car#182
phases 4 + 5).

A local directory MUST contain a `manifest.toml` per the bundle spec. A registry reference is
`<namespace>/<name>[@<version>]` (e.g. `parslee/ui-improver` or `parslee/ui-improver@1.2.3`); it is
resolved against the catalog at `--registry` and then handed to the SAME local-install path. Either
way, install-time validation runs against the daemon's host capability advertisement before the
agent is adopted.

Usage: car install [OPTIONS] <PATH>

Arguments:
  <PATH>
          Either a local path to a directory containing `manifest.toml` (or the file itself), OR a
          registry reference `<namespace>/<name>[@<version>]`. An existing filesystem path wins;
          otherwise a `namespace/name` shape is resolved via the registry

Options:
      --registry <REGISTRY>
          Registry source for `<namespace>/<name>` references: an `http(s)://…/index.json` URL or a
          LOCAL registry directory (or `file://` URL). Defaults to the public mirror. The private
          source needs a token — set `CAR_REGISTRY_TOKEN`
          
          [default: https://raw.githubusercontent.com/Parslee-ai/car-releases/main/index.json]

      --url <URL>
          WebSocket URL of the running car-server daemon
          
          [default: ws://127.0.0.1:9100/]

      --json
          Output as JSON instead of human-readable

  -h, --help
          Print help (see a summary with '-h')
```

### car ls

```text
List every installed contributed agent (Parslee-ai/car#182 phase 4). Calls the daemon's
`agents.list` and renders the result. Long alias: `agents`

Usage: car ls [OPTIONS]

Options:
      --url <URL>  WebSocket URL of the running car-server daemon [default: ws://127.0.0.1:9100/]
      --json       Output as JSON instead of a human table
  -h, --help       Print help
```

### car inspect

```text
Inspect a single installed agent (Parslee-ai/car#182 phase 4). Shows the on-disk manifest plus the
supervisor's current status. Resolves unqualified names to the highest installed semver per the
contributed-agents proposal

Usage: car inspect [OPTIONS] <ID>

Arguments:
  <ID>  Agent id, or `<namespace>/<name>[@<version>]`

Options:
      --url <URL>  WebSocket URL of the running car-server daemon [default: ws://127.0.0.1:9100/]
      --json       Output as JSON
  -h, --help       Print help
```

### car start

```text
Start an installed contributed agent

Usage: car start [OPTIONS] <ID>

Arguments:
  <ID>  Agent id, or `<namespace>/<name>[@<version>]`

Options:
      --url <URL>  WebSocket URL of the running car-server daemon [default: ws://127.0.0.1:9100/]
  -h, --help       Print help
```

### car stop

```text
Stop an installed contributed agent

Usage: car stop [OPTIONS] <ID>

Arguments:
  <ID>  Agent id, or `<namespace>/<name>[@<version>]`

Options:
      --url <URL>  WebSocket URL of the running car-server daemon [default: ws://127.0.0.1:9100/]
  -h, --help       Print help
```

### car restart

```text
Restart an installed contributed agent

Usage: car restart [OPTIONS] <ID>

Arguments:
  <ID>  Agent id, or `<namespace>/<name>[@<version>]`

Options:
      --url <URL>  WebSocket URL of the running car-server daemon [default: ws://127.0.0.1:9100/]
  -h, --help       Print help
```

### car tail-log

```text
Tail the most recent stdout/stderr lines captured from a supervised agent (Parslee-ai/car#231 §5.2).
Calls the daemon's `agents.tail_log`. Closes the DX gap where the daemon captured logs to
`~/.car/logs/` (`%USERPROFILE%\.car\logs\` on Windows) but offered no CLI surface to read them. Long
alias: `logs`

Usage: car tail-log [OPTIONS] <ID>

Arguments:
  <ID>  Agent id, or `<namespace>/<name>[@<version>]`

Options:
  -n, --lines <LINES>  Number of trailing lines to show [default: 100]
      --url <URL>      WebSocket URL of the running car-server daemon [default:
      ws://127.0.0.1:9100/]
      --json           Output as JSON (`{ "lines": [...] }`)
  -h, --help           Print help
```

### car uninstall

```text
Uninstall a contributed agent (Parslee-ai/car#182 phase 4). Stops the running child if any, removes
the manifest from `~/.car/agents/<id>/`, and reaps the legacy `agents.json` entry. Idempotent

Usage: car uninstall [OPTIONS] <ID>

Arguments:
  <ID>  Agent id, or `<namespace>/<name>[@<version>]`

Options:
      --url <URL>  WebSocket URL of the running car-server daemon [default: ws://127.0.0.1:9100/]
  -h, --help       Print help
```

### car schedule

```text
Schedule commands to run on a cadence (launchd / cron / schtasks)

Usage: car schedule <COMMAND>

Commands:
  add        Schedule a command to run on a cadence
  list       List scheduled commands and whether each is OS-durable
  remove     Remove a scheduled command: drops any OS schedule and deletes the task
  reconcile  Reconcile OS schedules against the task store, reaping orphans
  help       Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car schedule add

```text
Schedule a command to run on a cadence.

The cadence is expressed once and CAR picks the backend: durable schedules install to the OS
(launchd / cron / schtasks) so they fire even when car-server is down.

Usage: car schedule add [OPTIONS] --name <NAME> -- <COMMAND>...

Arguments:
  <COMMAND>...
          The program to run, then its arguments. Put it after `--`, e.g. `car schedule add --name
          backup --cron "0 3 * * *" -- /usr/bin/rsync -a src dst`

Options:
      --name <NAME>
          Human-readable name for the task

      --cron <CRON>
          Cron expression, e.g. "0 9 * * *" for 9am daily. `*/N` forms are normalized so the same
          input works on macOS and Linux

      --every <EVERY>
          Interval between runs, in seconds

      --no-durable
          Run via the in-daemon timer instead of the OS scheduler. Fires only while car-server is
          up, and misses anything scheduled while it is down. Interval cadences only

      --working-dir <WORKING_DIR>
          Working directory for the command

  -h, --help
          Print help (see a summary with '-h')
```

#### car schedule list

```text
List scheduled commands and whether each is OS-durable

Usage: car schedule list [OPTIONS]

Options:
      --json  Emit raw JSON instead of a table
  -h, --help  Print help
```

#### car schedule remove

```text
Remove a scheduled command: drops any OS schedule and deletes the task

Usage: car schedule remove <ID>

Arguments:
  <ID>  Task id, or the full OS label

Options:
  -h, --help  Print help
```

#### car schedule reconcile

```text
Reconcile OS schedules against the task store, reaping orphans.

Run this if schedules were left behind by an interrupted uninstall, or after editing `~/.car/tasks/`
by hand.

Usage: car schedule reconcile

Options:
  -h, --help
          Print help (see a summary with '-h')
```

### car registry

```text
Registry tooling for the contributed-agents registry (Parslee-ai/car#182 phase 5): `digest` a
manifest, or `validate` a registry directory (the CI gate run by Parslee-ai/car-agent-registry)

Usage: car registry <COMMAND>

Commands:
  digest    Print the canonical SHA-256 hex digest of a manifest.toml
  validate  Validate a registry directory (index.json + manifests + schema). This is the registry CI
  gate
  schema    Print the canonical registry index JSON Schema (the single source of truth, embedded in
  this binary) to stdout. Regenerate the registry repo's copy with: `car registry schema >
  schema/index.schema.json`
  help      Print this message or the help of the given subcommand(s)

Options:
  -h, --help  Print help
```

#### car registry digest

```text
Print the canonical SHA-256 hex digest of a manifest.toml

Usage: car registry digest <MANIFEST>

Arguments:
  <MANIFEST>  Path to the agent's manifest.toml

Options:
  -h, --help  Print help
```

#### car registry validate

```text
Validate a registry directory (index.json + manifests + schema). This is the registry CI gate

Usage: car registry validate <DIR>

Arguments:
  <DIR>  Path to the registry directory containing `index.json` and `schema/index.schema.json`

Options:
  -h, --help  Print help
```

#### car registry schema

```text
Print the canonical registry index JSON Schema (the single source of truth, embedded in this binary)
to stdout. Regenerate the registry repo's copy with: `car registry schema >
schema/index.schema.json`

Usage: car registry schema

Options:
  -h, --help  Print help
```

### car publish

```text
Publish a contributed agent to the registry (Parslee-ai/car#182 phase 5). Reads a local agent's
`manifest.toml`, signs it for `--audience public` (ed25519 key at `$CAR_PUBLISH_KEY_PATH`), stages
it at the versioned `agents/<namespace>/<name>/<version>/` path, updates `index.json` + the README
catalog, re-runs the EXACT `car registry validate` CI gate locally, and opens a PR against the
registry repo. Aborts (no PR) on a missing signing key or a validation failure

Usage: car publish [OPTIONS] <PATH>

Arguments:
  <PATH>  Path to a local agent directory containing `manifest.toml`, OR the `manifest.toml` file
  itself

Options:
      --audience <AUDIENCE>            Catalog audience for this agent. `internal` rows are
      unsigned; `public` rows are signed with the publisher's ed25519 key (loaded from
      `$CAR_PUBLISH_KEY_PATH`) and carry the publisher fields in the index [default: internal]
      [possible values: internal, public]
      --registry-repo <REGISTRY_REPO>  The registry repository (`owner/repo`) the PR is opened
      against [default: Parslee-ai/car-agent-registry]
      --category <CATEGORY>            Catalog category written into the index row (a required,
      min-length-1 schema field). Free-form publisher copy; scanned by the internal-infra denylist
      for public agents [default: general]
      --registry-dir <REGISTRY_DIR>    Stage into this EXISTING local registry clone instead of `gh
      repo clone`-ing a fresh one. Required for offline testing — when set, the staged branch is
      created locally and (if the clone has no `origin` remote) the `gh pr create` step is skipped,
      printing the staged branch name instead
  -h, --help                           Print help
```

### car help

```text
Print this message or the help of the given subcommand(s)

Usage: car help [COMMAND]...

Arguments:
  [COMMAND]...  Print help for the subcommand(s)
```

{% endraw %}
