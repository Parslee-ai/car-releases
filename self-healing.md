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

This is a **watch-only, ledger-first** capability. A detection is evidence, not a
work order. CAR does not propose a fix, execute remediation, restart an agent, or
grant itself new authority. Every tick appends detections and its summary to the
owner-private `<CAR_HOME>/selfheal/detections.jsonl` ledger. Operator dismissals
are append-only records too; history is not deleted.

## Operator commands

The CLI is a thin client over the daemon's `selfheal.*` JSON-RPC methods, so a
running `car-server` (or CAR Host) is required.

```bash
car selfheal status
car selfheal run
car selfheal list
car selfheal list --kind metrics_alert --severity critical --since 2026-09-01T00:00:00Z
car selfheal show <dedup-key>
car selfheal dismiss <dedup-key>
```

- `status` shows the cadence, active/dismissed counts, and the route resolved by
  the last tick, including either a validated checkout path or a refusal reason.
- `run` performs one tick immediately.
- `list` renders active detections with their route and, for local routing, the
  issue-document path.
- `show` prints the trusted local issue document for one deduplication key.
- `dismiss` suppresses that key from later active lists and ticks without
  deleting ledger history.

There are deliberately no filing-control commands yet. The feedback sink is
pending Parslee-ai/car#1137, so `car selfheal enable-filing` and
`disable-filing` are not shipped.

## Source-presence gate and routing

At each tick, the daemon checks a bounded set of local candidates for a Git
checkout whose origin is `Parslee-ai/car`. It performs file reads only: no broad
filesystem scan, Git subprocess, or network lookup. An explicit
`[selfheal] source_checkout = "/path/to/car"` in `<CAR_HOME>/config.toml` is
authoritative and fails closed when invalid rather than falling through to an
auto-discovered candidate.

The routing policy has two intended arms:

1. **Source present — local route.** A validated CAR checkout identifies a
   maintainer machine. Each active detection gets one owner-private
   `<CAR_HOME>/selfheal/issues/<dedup-key>.md` document. Recurrence updates that
   same document. CAR never writes into the source checkout.
2. **Source absent — feedback route.** A consumer machine will submit to the
   Parslee feedback database rather than a source repository. This arm is
   **pending Parslee-ai/car#1137 and is not live**. Until that sink lands, source
   absence or a refused checkout resolves to `ledger-only`, with the refusal
   reason visible in `status`; nothing is filed off-machine.

`CAR_SELFHEAL_INTERVAL_SECS` changes cadence only. It does not bypass the source
check, enable filing, or select another implementation.

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
same deterministic detector records; neither authorizes automatic remediation.

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
