{% raw %}
# Evaluate an outcome contract without a coding loop

`car evaluate-contract` runs an operator-supplied `OutcomeContract` through CAR's
existing deterministic evaluator. It does not call a model, edit a solution,
create a worktree, publish code, or close a ticket. Unlike `car verify`, which
statically validates a proposal, this command executes the declared checks.

```sh
car evaluate-contract \
  --repo /isolated/input/repository \
  --contract-file /isolated/input/contract.json \
  --expected-commit FULL_LOWERCASE_GIT_OBJECT_ID \
  --expected-contract-sha256 SHA256_OF_EXACT_CONTRACT_BYTES \
  --evidence-dir /isolated/output/new-run \
  --max-check-timeout-secs 120
```

The repository must be at that exact commit and clean, including ignored and
untracked files. Symlinks, submodules, skip-worktree and assume-unchanged index
entries are refused. Every regular repository file is hashed before execution
and checked again before and after each check, including file permissions.
Unlike the coding loop, this entry point does not restore a check's source edits
automatically; a persistent change makes the result inconclusive. The contract
bytes are also rechecked. Checks must write build artifacts outside the repository, for example
under `CAR_CHECK_EVIDENCE_DIR`. This strict initial command does not support a
working directory with installed ignored dependencies.

Network isolation, including denial of connections to host loopback services,
must be available before any check is dispatched. An unavailable
platform sandbox produces an inconclusive result without dispatching checks.
On macOS this entry point adds a final Seatbelt `deny network*` rule to the
existing secret-protection profile; on Linux it keeps the existing user, mount
and process namespace protections and adds a network namespace without bringing
loopback up. Linux filesystem
Unix sockets are not blocked by that mechanism: the external verifier host must
remove access to those services. The report labels the common guarantee
`deny_host_ip_network_including_loopback`, not complete host isolation.
Credential-enabled contracts and baseline/differential checks are rejected.
Baseline evidence must be held independently; this command never invents a
passing baseline. Check commands use the existing policy inspectors and withhold
forge credentials. A positive per-check wall-clock ceiling is mandatory.

Production networking is not supported by this command. An offline passing check
cannot prove what is deployed. Production verification needs a separately trusted,
read-only host probe bound to the approved target and deployment identity. Its
immutable, provenance-bearing capture can then be checked offline, or validated
as a separately approved host stage. This command does not collect or authenticate
that production capture, and has no network-approval switch.

## Evidence and exit status

The output directory must be new, with an existing parent outside the repository.
It contains the exact `contract.json`, hashed `input-files.json`, `events.jsonl`,
per-check output/evidence, and `result.json`. The last file includes SHA-256,
relative path and byte count for every other artifact, the run ID, exact input
revision and contract digest, CAR version, and all check results. Its artifact
manifest excludes `result.json` itself. Consumers should hash the exact result
bytes separately when binding them to a signed envelope.

The JSON report uses `schema_version: 1`:

| Field | Meaning |
| --- | --- |
| `run_id` | New UUID for this invocation; not an authenticated principal |
| `car_version` | Package version; the external host must pin the evaluator binary itself |
| `commit`, `contract_sha256` | Exact lowercase Git object ID and raw contract SHA-256 |
| `started_at`, `completed_at` | Unix seconds; completion is null when the clock is invalid |
| `status` | `passed`, `failed`, or `inconclusive` |
| `reasons` | String array explaining admission or integrity failures |
| `authority` | Always `unsigned_execution_evidence` |
| `filesystem_isolation` | `not_provided_requires_external_host` in local mode; `oci_child_readonly_source_parent_evidence` in OCI mode |
| `evidence_mode` | `local_check_files` or `stdout_stderr_only` |
| `toolchain_image_digest` | Exact cached OCI image ID in OCI mode; null in local mode |
| `network_policy` | Required `deny_host_ip_network_including_loopback`; per-check isolation must also be present |
| `checks` | Existing CAR check results, including terminal exit, timeout, output tail, environment and evidence paths |
| `artifacts` | Sorted objects with `path` relative to the evidence directory, lowercase `sha256`, and integer `bytes` |

A consumer must require both exit 0 and `status: passed`, validate the schema and
bindings, and verify artifact bytes. The report is not a signature and does not
identify who approved the contract. A valid digest only establishes byte equality.

Exit 0 means every declared check passed with terminal results, network isolation,
complete check journal entries, unchanged inputs, and persisted evidence. Exit 1
means failed or inconclusive evaluation. Exit 2 means setup or final evidence
publication failed. Clock errors or a clock moving backwards are inconclusive;
`completed_at` remains null when no trustworthy completion timestamp exists.
A killed process or missing terminal `result.json` is inconclusive; never reuse an old output directory or infer success from partial
files. The report's `status` is `passed`, `failed`, or `inconclusive`.

## Required external verifier boundary

**This is unsigned execution evidence, not proof of verifier independence.** The
report always identifies `authority: unsigned_execution_evidence`. The default
local mode reports `filesystem_isolation: not_provided_requires_external_host`.

The default local mode retains CAR's composed secret sandbox, including its keychain and
known secret-path restrictions. Those targeted protections are not a complete
filesystem or evidence-custody boundary: candidate code still shares the local
execution identity and writable evidence paths. Unlisted credentials, other host
paths and local Unix services need an independently enforced host boundary. Hash comparisons detect persistent input changes; they

do not prevent a check from changing and restoring a file during execution.
Toolchain binaries and dependencies outside the repository are not hashed here.

A trusted verifier service must own isolated execution under a separate identity,
prevent credential/filesystem/network access, pin the toolchain and approved
checks, materialize inputs from a trusted object store instead of accepting a
worker-prepared Git index, mount immutable inputs, retain evidence outside the
worker's custody, and validate the completed run before signing any external receipt. Candidate
code must also be separated from the evaluator process and its writable journal,
result files, and signing state (for example, a distinct UID/container with only
controlled output channels). Putting the evaluator and candidate subprocess in
one container together does not establish evidence authenticity: code under test
could modify or impersonate the evaluator's output. The default local executor
does not provide this separation. The isolated OCI mode below provides a child execution boundary, but an external
trusted host must still enforce worker-independent custody; this command alone
is not the independent verifier service. Never place signing
keys inside the check environment. Repository-clean status, exit 0, or a
self-asserted identity is insufficient to close an engineering ticket. This
command neither provisions that host nor authenticates its identity.

## Isolated OCI child checks

For a trusted verifier host, pair `--container-runtime /absolute/path/to/docker`
with `--container-image sha256:EXACT_CACHED_IMAGE_ID`. The operator selects these;
they are not contract fields. The runtime connects only to the local Unix socket,
requires a cached Linux image, and never pulls images. The host must pin the
runtime and evaluator binaries, image, source and approved contract independently
of the worker. This does not provision a verifier identity or signer.

Only the check subprocess enters the container. The source and root filesystem
are read-only, the child runs as UID/GID 65534, and network access, capabilities
and privilege escalation are denied. Memory, process, CPU, scratch, output and
execution time are bounded. The parent retains its journal and result directory
outside all child mounts. It reads the daemon's exact exec identity and terminal
exit code; command output cannot declare completion. A runtime error, missing
terminal result, interrupted supervisor or failed owned-container cleanup makes
the run inconclusive.

This mode captures **stdout and stderr only**. Check-created files are ephemeral
and never imported. Contracts requiring retained child-file artifacts are not
supported; unknown artifact requirement fields are rejected. Approved checks must
express their assertions using ordinary exit/output assertions and emit the
necessary evidence in their streams. Build scratch paths must point to `/tmp`
inside the container. The parent still writes its own per-check stdout, stderr,
result and `isolated-execution.json` records.

Before dispatch, the parent persists `container-lease.json` with the unique
container name, pinned image and `state: creating`. After awaited removal, it
persists `container-cleanup.json` with the same name and `removed: true`.
SIGINT/SIGTERM stop admission, interrupt the active check and await owned-container
cleanup. Signal observation remains active during synchronous evidence hashing
and receipt persistence. The parent writes and fsyncs a private nonterminal
receipt, checks the OS-level interruption flag, then atomically publishes
`result.json` without overwriting an existing result. That publication is the
terminal commit; signals after it do not retroactively revoke a completed run.
Interrupted preparation publishes an inconclusive result. Publication or final
directory-sync failure returns nonzero even if a result file exists; consumers
must require both a successful process exit and a passed result.
Timeout, interruption and cleanup failure are inconclusive. A dropped
execution future also attempts bounded cleanup, but that safeguard cannot produce
a successful result. SIGKILL or host failure can prevent cleanup entirely: the
external supervisor must reconcile the durable lease against its owned runtime
resources. Missing terminal evidence must never be admitted as a pass.

The top-level report identifies `evidence_mode: stdout_stderr_only`,
`filesystem_isolation: oci_child_readonly_source_parent_evidence`, and the exact
`toolchain_image_digest`. `isolated-execution.json` retains the observed container
configuration as `configuration_projection: validated_oci_posture_v1`, plus the
exact exec identity, approved command and terminal state. The original daemon
inspect object is validated before projecting enforced posture fields. Unrelated
image environment and labels are omitted; this is not a full raw inspect dump.
Machine identities and source paths remain exact; only child streams are redacted.
These are still unsigned records;
the external service must validate them before signing a receipt. Worker access
to the evaluator host, Docker socket or evidence storage defeats independence.
Production verification remains a separate trusted, read-only host stage.

{% endraw %}
