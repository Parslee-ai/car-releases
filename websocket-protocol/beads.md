{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### beads

Git-backed work across enrolled repositories. Files in each repository's own
`.car/beads/<id>.json` contain `id`, `title`, `parent` (null for a root), `owner`,
`requester`, `claim` (ISA id), `touch_cadence_ms`, `last_touch_ms`, `status`,
`evidence` (links), `operations`, and optional `brief:{claim,falsifier}` (the task
contract for compiled minds). Times and cadences are integer milliseconds.
Serialization uses stable field order, two-space JSON indentation and a final
newline. Keep these files in git; CAR does not commit them for you.

Each returned entry is `{project, repo, file, root, bead}`. Ids are unique across
the entire index. Every root cites a claim present on its project's ISA; children stay in that root's project,
repository and claim. Grace's configured root agent creates and owns roots only;
a bound factory creates roots under its exact `(project, claim)` bindings and
children under roots it owns. A factory also gets one standing operations root
under an exact bound project claim. Its allocation survives file deletion and index rebuild.

Each repository defaults to `ISA.md` at its root. To configure another path,
commit `.car/beads.toml` containing `isa_path = "DIGITAL_ASSISTANT/ISA.md"`.
The path must stay inside that repository. Roots and factory bindings require
an exact id from a line `- [ ] <ID>:` or `- [x] <ID>:` in that file; a missing
file or unknown id is refused with the ISA filename in the reason.

Identity comes from the attached agent session, never a request field. The host
can administer enrollment and bindings; any other caller must be an attached
agent. This first surface is for personal work contexts; organization-bound
sessions are refused rather than reading or writing the person's personal index.

Index, enrollment, bindings, operations allocations and refusal events ride the
existing sync oplog's registry kinds `bead_index`, `bead_config`, `bead_factory`,
`bead_operations`, `bead_event`. Generic `sync.append` cannot write those kinds.
Ledger readers can use `SyncSubsystem::registry_payloads("bead_event")`, or
`beads.events`. Refusals contain `{id, kind:"beads.refused", actor, method,
reason, at_ms}`. Policy refusals are errors, never successful no-ops.

Takes use the same Lattice single-holder table as `lattice.claim`, with project
and item `bead:<root id>`. A losing take names the holder in its error. Lattice's
claim is held only across the ownership read-check-write and is released on
success or error. Holding many durable roots does not consume Lattice slots.
A disconnect does not clear durable ownership in the bead file. Handoff
changes the original root's owner and cadence, keeping its id and requester.
Staleness means `now - last_touch > touch_cadence`, only for an owned bead; no
fixed age is used. A missed cadence does not automatically release ownership.

A file write precedes its index projection. If the oplog write fails, the error
is returned and the source file remains recoverable with `beads.rebuild`. Rebuild
reports malformed or invalid files in an optional `skipped: [{file, reason}]`
array (omitted when empty) and records a `beads.scan_skipped` event with
`{id, kind, actor, file, reason, at_ms}` for each. These files and descendants
whose parent is skipped are omitted; other repositories and creates continue.
Source files remain untouched. Every copy of a duplicate id is skipped; each
report and event names all conflicting paths in its reason. Creates that would
reuse an existing source id are still refused. The prospective index replaces
one registry snapshot. Remove duplicate copies or repair skipped source files
in git and rebuild to restore their entries.
This is a single-daemon ownership guarantee: the sync registry's LWW merge does not coordinate simultaneous takes
on separate daemons. Git merges and cross-device ownership arbitration remain
outside this surface. A multi-file subtree handoff is not crash-atomic; an I/O failure can require reconciling those files before rebuild.

#### `beads.index`
- **Params**: `{ repos: [{project, path}], root_agent }`. Paths must be git worktree roots with their own `.car/`; discovery never crosses a worktree boundary.
- **Role**: host; host authority required to enroll or replace repositories.
- **Returns**: `{entries: {<id>: entry}, skipped?: [{file, reason}]}`, sorted by id, after reading all repositories.

#### `beads.rebuild`
- **Params**: `{}`
- **Role**: host; host authority required.
- **Returns**: `{entries: {<id>: entry}, skipped?: [{file, reason}]}`. Reports skipped files with parse/validation errors. Replaces the derived index entirely from enrolled files, removing deleted entries.

#### `beads.list`
- **Params**: `{ project?, owner?, roots_only? }`
- **Returns**: `[entry]` in id order. No repository scan; use rebuild to index external file changes.

#### `beads.get`
- **Params**: `{ id }`
- **Returns**: one `entry`; unknown id is refused.

#### `beads.create_root`
- **Params**: `{ project, id, title, claim, operations?, evidence?, brief? }`
- **Returns**: the new unowned `entry`, with requester set from the caller. Accept it with a cadence before it has an owner. A root citing an id absent from its project's ISA, unbound factory root, or second operations bead is refused and logged.

#### `beads.create_child`
- **Params**: `{ project, id, title, claim, parent, evidence?, brief? }`
- **Returns**: the new unowned child `entry`. Only a factory owning the root may create its children (host administration is also allowed).

#### `beads.accept`
- **Params**: `{ id, touch_cadence_ms }`. A missing or zero cadence is refused and logged.
- **Returns**: updated `entry` with owner and last touch set to the caller and server time.

#### `beads.touch`
- **Params**: `{ id }`
- **Returns**: updated `entry`. Only its current owner may touch it.

#### `beads.handoff`
- **Params**: `{ id, owner, touch_cadence_ms }`
- **Returns**: updated root `entry`. Current owner or host only; recipient must be the root agent or an eligible factory and must declare its cadence. Owned descendants move to the same factory with the declared cadence; files, ids and requesters stay in place. Children are not copied or linked.

#### `beads.bind_factory`
- **Params**: `{ id, claims: [{project, claim}] }`
- **Role**: host; host authority required.
- **Returns**: `{ok:true}`. Replaces the factory's allowed root citations. Every citation is checked against the enrolled project's ISA before saving; a missing ISA is refused with its filename. The root agent cannot also be a factory.

#### `beads.stale`
- **Params**: `{ project?, owner?, roots_only? }`
- **Returns**: `[entry]` for missed declared cadences only.

#### `beads.events`
- **Params**: `{}`
- **Returns**: refusal and scan-skipped events ordered by `(at_ms, id)` for ledger readers.

CLI: `car beads <index|rebuild|list|get|create-root|create-child|accept|touch|handoff|bind-factory|stale|events>` prints JSON and exits nonzero on refusal.
Node/Python expose generated JSON-params wrappers on `CarRuntime`, for example
`beadsList('{}')` / `beads_list('{}')`; all methods retain daemon authorization. Host-only enrollment, rebuild and factory binding wrappers live on `HostClient`; other generated wrappers preserve the attached agent credential on `CarRuntime`.

{% endraw %}
