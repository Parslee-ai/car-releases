{% raw %}
# Self-healing

CAR watches the evidence it already owns and turns recurring failures into durable,
redacted detections. The detector is deterministic and runs inside `car-server`;
there is no LLM judge in the detection or routing path.

## Deterministic detectors

The daemon runs five pure detectors: `metrics_alerts.v1`, `agent_gave_up.v1`,
`agent_log_errors.v1`, `recurring_tool_failure.v1`, and `capability_miss.v1`.
`agent_log_errors.v1` closes two supervisor blind spots:

- **Healthy-but-erroring:** the process remains `running`, but its bounded
  activity-log tail repeats the same genuine error signature. A line is an error
  only when it carries an `ERROR`, `FATAL`, or `CRITICAL` level token or is a
  traceback header. INFO/WARN/unlevelled lines remain routine even when they say
  “failed”. Signatures normalize timestamps, UUIDs, long hex ids, numbers, and
  whitespace before counting.
- **Silently idle:** the process remains `running`, but the activity-log mtime is
  older than the configured threshold. Deduplication uses only the monotone
  `hour` / `day` / `week` / `month` age bucket, never a raw minute count or tick
  time. A measured zero bytes on both stdout and stderr is listed by the
  supervisor but produces no detection because no activity was observed.

The detector core reads none of this itself. The daemon supplies bounded tails,
stream sizes, and activity metadata explicitly on each supervisor snapshot.

Detection is **ledger-first**. CAR does not use a model to decide whether a
signal is worth fixing, restart an agent, merge code, or grant itself new
authority. Every tick appends detections and its summary to the owner-private
`<CAR_HOME>/selfheal/detections.jsonl` ledger. Operator dismissals and bounded
coder attempts are append-only records too; history is not deleted. Only the
eligible `recurring_tool_failure.v1` path has an auto-fix template in v1; every
other detector remains watch-only.

## Operator commands

The CLI is a thin client over the daemon's `selfheal.*` JSON-RPC methods, so a
running `car-server` (or CAR Host) is required.

```bash
car selfheal status
car selfheal run
car selfheal list
car selfheal list --kind metrics_alert --severity critical --since 2026-09-01T00:00:00Z
car selfheal show <dedup-key>
car selfheal fix <dedup-key>
car selfheal dismiss <dedup-key>
```

- `status` shows the cadence, active/dismissed counts, and the route resolved by
  the last tick, including either a validated checkout path or a refusal reason.
- `run` performs one tick immediately and applies the same default-on auto-fix
  cadence hook as the timer.
- `list` renders active detections with their route and, for local routing, the
  issue-document path. Recurring tool failures also show auto-fix eligibility,
  the reconstructed call when safe, and its private sidecar path.
- `show` prints the same recurring-call and attempt fields followed by the
  trusted local issue document for one deduplication key.
- `fix` explicitly starts one bounded coder round for an eligible key. It uses
  the same registry-owned template and limits as unattended rounds; the
  `auto_fix` off switch does not prohibit a deliberate operator request.
- `dismiss` suppresses that key from later active lists and ticks without
  deleting ledger history.

The consumer feedback sink remains pending Parslee-ai/car#1137, so
`car selfheal enable-filing` and `disable-filing` are not shipped. Auto-fix is a
separate maintainer-only, PR-only route described below.

## Reconstructed calls and eligibility

For each active `recurring_tool_failure`, the daemon matches the detection's
failure provenance to an `ActionFailed`, then joins that event's `proposal_id`
and `action_id` to `ProposalReceived.data.proposal` in the **same journal**.
This recovers the accepted tool name and exact parameter object without putting
raw parameters on outcome events.

The recovered params are serialized as JSON and passed through
`car_selfheal::Redactor`. The detection's `eligible` field is true only when
the failed event says `tool_source: "builtin"`, the tool is not the
side-effecting `delegate_gui`, the call was recovered, and redaction changed no
bytes. A secret-shaped value makes
the key ineligible and `reconstructed_call` is omitted, so the self-heal ledger
and derived artifacts never gain another raw-secret copy. Safe recovered calls
are exposed as `{ tool, params }`.

For the local route, every recurring key also gets an owner-private
`<CAR_HOME>/selfheal/issues/<dedup-key>.call.json` sidecar containing
`eligible` and the optional safe `reconstructed_call`; `selfheal.detections`
returns its `reconstructed_call_path`. The sidecar and detection ledger are
0600 on Unix. Other detector kinds omit all three reconstructed-call fields.
The attempt fields on `selfheal.detections` are `auto_fix_attempts`,
`auto_fix_in_progress`, `auto_fix_exhausted`, and `last_auto_fix_attempt`
(including terminal `exit_code` and `failure_class`). Remote deduplication adds
`auto_fix_awaiting_review`, `auto_fix_parked`, `remote_pr_number`, and
`remote_pr_url`. `car selfheal list` renders awaiting-review, parked, and
exhausted states explicitly.

## Auto-fix

`recurring_tool_failure.v1` is the only detector registered for auto-fix in v1.
Its registry-owned template writes an intent whose first line begins
`selfheal:` and an `OutcomeContract` with exactly these commands:

```text
cd car-rs && cargo build -p car-cli
car tools call <tool> --params-file <private-params-path>
cd car-rs && cargo test -p <tool-owning-crate>
```

The replay check requires both exit zero and the compact JSON success marker
`"ok":true`; a permissive replay verb that exits zero while returning
`{"ok":false,...}` remains red. The model receives that runtime-owned contract;
the intent explicitly declares changes to the replay verb or its assertion out
of bounds.

Before a recurring key becomes eligible, CAR builds `car-cli` from the validated
checkout into a private probe target and requires that checkout-built binary's
`car tools call --help` to exit zero. A checkout predating the verb leaves the
key ineligible and writes `checkout predates the replay verb` into its private
issue document. Before a round, CAR revalidates the checkout origin and runs
`git fetch origin main`. Any validation or fetch failure is recorded and fails
closed before the coder starts. CAR then spawns its `car code-task` command with the validated checkout,
private intent/contract files, `--deliver pr`, stable branch
`car/selfheal/<dedup-key>`, base `main`, and isolated workspace
`<checkout>/.worktrees/selfheal-<dedup-key>`. The PR body starts with
`<!-- car-selfheal:key=<dedup-key> -->`. The child receives
`CARGO_TARGET_DIR=<CAR_HOME>/selfheal/target`; that target's debug directory is
first on the child `PATH`, so the contract's literal `car tools call` exercises
the CLI just built from the repair worktree rather than the older installed
binary. The Cargo checks explicitly enter `car-rs/`, CAR's workspace root.
Each child has a 15-minute wall-clock budget inside the daemon RPC ceiling and
mirrors flushed JSONL to the private `code-task-round-<n>.jsonl` attempt file.
If a child exits without a terminal `run_end`, the attempt ledger records
`failure_class: missing_run_end` rather than treating absent output as success.

Configuration lives in `<CAR_HOME>/config.toml`:

```toml
[selfheal]
auto_fix = true
max_concurrent = 1
max_per_day = 3
max_rounds_per_key = 3
# source_checkout = "/absolute/path/to/Parslee-ai/car"
```

`auto_fix` defaults to **true**. Set it to `false` and restart the daemon to turn
off unattended rounds; explicit `car selfheal fix <key>` remains available.
The hard safety ceilings cannot be raised: `max_concurrent` must be 1, while
`max_per_day` and `max_rounds_per_key` may be lowered from 3 but not raised.
Malformed or raised-limit configuration disables auto-fix and exposes
`auto_fix_refusal_reason` in `selfheal.status`. A durable start marker prevents
a daemon restart from starting the same round twice, and cadence starts only
the first round for a key. Before that initial spawn, CAR runs `gh pr list
--head car/selfheal/<dedup-key> --state all`: an open marker-bearing PR records
`awaiting_review` for a human maintainer, while a closed-unmerged PR records
`parked`; neither path spawns or reopens a coder round. This release runs only
the initial bounded round; review-driven continuation is not wired into the
daemon. CAR never merges.

Auto-fix is deliberately unsupported on forks. The source gate requires the
origin to normalize exactly to `github.com/Parslee-ai/car`; a fork, absent
checkout, ineligible/nonbuiltin call, redactor change, daily limit, or exhausted
key remains ledger-only/watch-only rather than falling through to another
implementation.

## Consuming local issues

Local issue documents and their `.call.json` sidecars remain owner-private
handoff evidence under `<CAR_HOME>/selfheal/issues/`. Consumers should key on
`Dedup-Key`, inspect the append-only detection and attempt records, and treat
`last_auto_fix_attempt.failure_class` as the machine-readable terminal result.
Do not parse coder prose or infer success from a process existing. A PR marker
identifies the one stable review artifact for the key; the local issue remains
the evidence record and is never itself committed or uploaded.

## Source-presence gate and routing

At each tick, the daemon checks a bounded set of local candidates for a Git
checkout whose origin is `Parslee-ai/car`. That source-presence probe itself
performs file reads only: no broad filesystem scan, Git subprocess, or network
lookup. Auto-fix eligibility and remote deduplication subsequently run the
bounded build/help and `gh pr list` checks documented above. An explicit
`[selfheal] source_checkout = "/path/to/car"` in `<CAR_HOME>/config.toml` is
authoritative and fails closed when invalid rather than falling through to an
auto-discovered candidate.

The routing policy has two intended arms:

1. **Source present — local route.** A validated CAR checkout identifies a
   maintainer machine. Each active detection gets one owner-private
   `<CAR_HOME>/selfheal/issues/<dedup-key>.md` document. Recurrence updates that
   same document. An active recurring-tool key also gets the private
   `<dedup-key>.call.json` eligibility sidecar described above. Eligible
   auto-fix uses only a dedicated Git worktree under `<checkout>/.worktrees/`;
   the maintainer's working tree and index are never edited.
2. **Source absent — feedback route.** A consumer machine will submit to the
   Parslee feedback database rather than a source repository. This arm is
   **pending Parslee-ai/car#1137 and is not live**. Until that sink lands, source
   absence or a refused checkout resolves to `ledger-only`, with the refusal
   reason visible in `status`; nothing is filed off-machine.

`CAR_SELFHEAL_INTERVAL_SECS` changes cadence only. It does not bypass the source
check, enable filing, or select another implementation.

## Consuming local issues

CAR ships the detector, private issue-document writer, query API, and dismissal
API. It does **not** ship a consumer that watches those documents, creates work
in a maintainer's backlog, or acts on a detection. A source-present maintainer
must attach and operate that consumer; “fleet-harvested” describes Parslee's
private consumer, not behavior included in CAR.

A local issue document has the following contract. The labels and section
headings below are exact and case-sensitive; text in angle brackets represents
the rendered value. Consumers may rely on this shape. A change to these names or
their meaning is a consumer-contract change and must update this document and
attached consumers in the same release.

```text
# CAR self-heal detection: <locator>

Trust-Tier: trusted
Dedup-Key: <SHA-256 dedup key>
Detector-ID: <detector id>
Severity: <severity>
Route: local
Occurrence-Count: <count>
First-Observed: <RFC 3339 timestamp>
Last-Observed: <RFC 3339 timestamp>

## Provenance

- CAR-Version: <version>
- Platform: <operating system>/<architecture>
- Event-IDs: <comma-separated values or (none)>
- Run-IDs: <comma-separated values or (none)>
- Evidence-Paths: <comma-separated values or (none)>

## REDACTED Evidence Excerpt

- <redacted excerpt, or (none)>

## Repro Hints

- Re-run `selfheal.run` and correlate the detector identity and provenance above.
- Inspect the named local CAR evidence source; do not send it off-machine.
```

For example, a maintainer-owned consumer can:

1. Poll `selfheal.detections` through JSON-RPC, following `next_offset`, and
   select records whose `route` is `local`. As a file-based alternative, watch
   `<CAR_HOME>/selfheal/issues/` for created or updated Markdown documents.
2. Read the returned `local_issue_path` or document, then create a ticket or run
   whatever maintainer-approved response the consumer owns. Carry `Dedup-Key`
   into that work so recurrence maps to the same item.
3. After the work is resolved or deliberately declined, call
   `selfheal.dismiss` with `{ "dedup_key": "<key>" }`, or run
   `car selfheal dismiss <key>`. Dismissal suppresses the key from active query
   results and later ticks but does not delete its ledger history or local
   document, so a directory watcher must also remember processed keys.

The local route is specific to the canonical repository: source validation
requires the checkout's `origin` to resolve to `github.com/Parslee-ai/car`.
A fork whose `origin` is `github.com/<owner>/car` fails that gate and therefore
does not receive local issue documents; it remains `ledger-only` unless its
operator separately attaches a consumer to the detection ledger/API.

## Trust tier policy

Routing determines how backlog consumers must treat the evidence:

- A local-route issue from a source-present machine is the **trusted tier**. It
  is a private, fleet-harvested handoff backed by the daemon's redacted evidence
  and validated checkout path.
- A feedback-database auto-filed report is the **consumer tier**. It must be
  reproduced before work begins; consumer routing does not inherit maintainer
  trust merely because CAR generated the report. This pipeline remains pending
  Parslee-ai/car#1137.

Trust changes triage posture, not detector output. Both tiers originate from the
same deterministic detector records. Only a trusted local route that also
passes builtin provenance, same-journal reconstruction, and the redactor gate
may enter the bounded PR-only auto-fix path.

## Relationship to car-tank

The external `car-tank` agent's daemon-adjacent signal sources are subsumed by
CAR's in-daemon deterministic detection. Its repository-side sources (open
issues, CI, parity checks, and benchmark artifacts) remain the responsibility of
whoever runs the repository backlog; they do not move into CAR's daemon.

Tank's LLM judge is retired from this path. Its calibration record at
`../car-tank/docs/calibration-probe-2026-08-11.md` reports a failed probe, while the
ratified CAR design requires deterministic detection with no LLM judge.
Goalpool filing is retired as the destination: routing is now source-presence
gated, producing local issues for the fleet on validated source-present machines
and, once Parslee-ai/car#1137 lands, feedback reports everywhere else.

Decommissioning the external Tank process is an operator decision, not an action
CAR takes. The principal may stop it with `car stop car-tank` or keep it
permanently `watchOnly`; CAR neither changes Tank's configuration nor stops it.

{% endraw %}
