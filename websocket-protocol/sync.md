{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### sync

Multi-device sync (B6, `docs/proposals/multi-device-sync.md`). The daemon holds
**one `SyncSubsystem` per device** — a `car_sync::SyncSession` over an `FsRelay`
rooted at `~/.car/sync/relay/` (the single-user two-device case converges out of
the box) — lazily opened on first contact and shared across connections. All
methods are FFI-proxied (`syncStatus` etc. NAPI / `sync_status` etc. PyO3).

Domain wiring is an honest boundary: **Conversation** is wired end-to-end
(`sync.record_turn` → oplog → `sync.resume`), the **leased-intent** ledger is
wired (`sync.record_intent` + `sync.fence_check`), and `sync.append` is a generic
tee for any other surface. Auto-teeing the daemon's *internal* conversation /
knowledge write paths into the oplog is a documented follow-up. E2E payload
encryption ships as a tested `car_sync::crypto` library boundary (ChaCha20-Poly1305)
but is not yet applied to the live oplog stream (decrypt-before-fold + key
distribution are follow-ups).

**Agent sessions bound to a work context** also reach `secret.get` (the agent's policy still applies, and reserved OAuth slots are still refused) and `browser.producer.register` (the agent's own browser stream). Daemon-global calls such as `models.list`, `host.devices` and `host.notify` stay refused.

**Sessions bound to a work context.** A connection authenticated as a supervised
agent whose `AgentSpec.work_context` is set keeps its own records in a private,
device-local store for that agent in that context:
- **Store:** under the journal directory, keyed by the context's storage key
  and the agent id, with no relay. Two agents enrolled in the same org never
  share one.
- **Which calls:** `sync.append`, `sync.record_turn`, `sync.transcript`,
  `sync.resume`, `sync.knowledge` and both `sync.assistant_checkpoint.*` and
  `sync.assistant_action.*`. None of these reaches the personal subsystem or an
  org's shared one.
- **Reads:** `sync.knowledge` returns only that store's facts.
- **Refused:**
  - naming a scope (`org` / `scope.org`) on these calls;
  - `sync.status`, `sync.pump`, `sync.checkpoint`, `sync.rebase`,
    `sync.record_intent`, `sync.fence_check` and `lease.*`, which act on the
    personal log. They stay refused by the context gate, like every other
    daemon-global route.
- **Unchanged:** an unbound connection behaves exactly as before.

#### `sync.status`
- **Params**: `{}`
- **Returns**: `{ device_id, state_hash, journal_frontier: { device: seq }, stable_frontier: Hlc | null, base_checkpoint: string | null, roster: RosterEntry[] }`
- The device roster, this device's journal frontier (per-device max seq), the relay's stable frontier, and the divergence-invariant fold `state_hash` two synced devices must agree on. FFI: `syncStatus` (NAPI) / `sync_status` (PyO3).

#### `sync.append`
- **Params**: `{ surface: "knowledge" | "skill" | "declagent" | "conversation" | "routing" | "trajectory" | "run" | "intent" | "registry:<kind>", payload: object, scope?: "personal" | { org: string } }`
- **Returns**: `{ op_id, seq, hlc }`
- Record an op on any surface — the generic domain tee for wiring knowledge/registry/routing state into the oplog. FFI: `syncAppend` / `sync_append`.
- `payload` is opaque to the daemon, but each surface has a shape its readers expect. For `"knowledge"` — the assistant's synced `remember` facts — that shape is `{ subject: string, body: string, kind: "fact" | "preference" | "procedure" }`. There is no explicit id: the op is **content-addressed by the whole payload**, so on the grow-only Knowledge tier an edit appends a new entity (both survive the fold) while an identical re-remember dedups. `kind` is part of that address, which matters on upgrade: a fact synced before `kind` existed and then re-remembered folds as a second entity rather than deduping. That is harmless because readers reduce newest-per-subject first (see `sync.knowledge`), so only the newer, kinded entity is ever seen. A payload with no `kind`, or one this device does not recognize, reads as `"fact"`.

#### `sync.assistant_checkpoint.put` / `sync.assistant_checkpoint.get`
- **Put params**: `{ checkpoint: AssistantCheckpoint }`; **returns** the oplog append receipt `{ op_id, seq, hlc }`.
- **Get params**: `{ session_id: string }`; **returns** the latest `AssistantCheckpoint | null`.
- A checkpoint contains the exact provider-facing `Message[]` (including multimodal input, tool calls/results, thinking signatures, and provider output items), repository root, monotone revision, goal/compaction state, and the stage-separated completion matrix. Put fails closed for an empty/mismatched session id or a non-increasing revision.
- FFI: `syncAssistantCheckpointPut` / `sync_assistant_checkpoint_put` and `syncAssistantCheckpointGet` / `sync_assistant_checkpoint_get`.

#### `sync.assistant_action.put` / `sync.assistant_action.get`
- **Put params**: `{ record: SupervisedActionRecord }`; **returns** the oplog append receipt `{ op_id, seq, hlc }`.
- **Get params**: `{ action_id: string }`; **returns** the latest `SupervisedActionRecord | null`.
- The record binds an exact canonical action digest to session, tool call, parameters, repository, target environment, and named credential capabilities. Its lifecycle moves forward only: `proposed -> approved|denied`, `approved -> dispatched`, and `dispatched -> completed|failed|indeterminate`. There is one replacement: an `approved` record whose receipt has a `grant` key (a saved answer gave the approval) may be replaced by `approved` with another receipt (an approval on the call's own card, or another saved-answer approval when the same call is decided again) or by `denied`. An `approved` record whose receipt has no `grant` key is never replaced, and `denied` never becomes `approved`. Invalid transitions and scope mutation fail closed. A resumed `dispatched` action becomes `indeterminate` and is never automatically replayed.
- FFI: `syncAssistantActionPut` / `sync_assistant_action_put` and `syncAssistantActionGet` / `sync_assistant_action_get`.

#### `sync.knowledge`
- **Params**: `{ pump?: boolean, org?: string | string[], working_dir?: string }`
- **Returns**: `{ facts: object[], skipped_orgs?: string[] }` — the folded `Surface::Knowledge` payloads, **ascending by `(hlc, op_id)`** within each scope
- Read the synced knowledge facts, optionally pumping the oplog first so the read reflects peers with no interleave window (the daemon pumps under the same lock it reads under). Payloads are returned verbatim, unreduced: the ascending order is the contract, and callers converge a subject by taking the **last** entry for it, never the first. Daemon-only — `car do --serve` uses it for cross-device assistant memory; there is no FFI wrapper.
- With org-scope sync on, the selected orgs' knowledge comes first, in sorted org-id order, and personal knowledge last, so personal wins a subject it holds and, between two named orgs, the later org id does. `org` names the org(s) to merge; each must be configured and open (an open in flight is waited for), or the read is refused rather than silently missing that org's facts. Without `org`: with one org configured, that org's knowledge is merged when it is open — the result is what it was before several orgs were possible; with several configured **no org is merged** — the reply carries personal knowledge only, plus `skipped_orgs` naming every configured org it did not read — because merging several orgs by position would let one org's fact silently shadow another's, and refusing would cost a caller that cannot choose its personal facts from other devices too. `working_dir` (absolute) lets the daemon pick for a caller that cannot: with several orgs configured and no `org`, the daemon resolves that directory's work context (its `[organization]`, else the default org — the `auth.resolve_context` rule; the directory's own declaration is read on each call, off the runtime and bounded to 2 s, while the held and default work contexts are cached as one entry for a minute, until sign-ins change, and until the default org changes — with an unknown credential-authority hint only the minute and the default-org file bound it) and, when it binds a configured org that opens, merges that org and skips the rest. `working_dir` reveals about one bit to its caller — whether that directory's work context binds a configured org — to an operator-role caller who could already name any configured org. `car do` sends its working directory, so its process never reads the credential store; serve usually runs outside any repository, which means the default org. Only the orgs a read merges are opened.

#### `sync.record_turn`
- **Params**: `{ conversation_id: string, role: "user" | "assistant" | "tool", content: string, tool_calls?: ToolCall[], tool_use_id?: string, timestamp?: number, provenance?: "external", ok?: boolean, scope? }`
- **Returns**: `{ op_id, seq, hlc }`
- For a tool turn, `provenance: "external"` marks content from outside the trust boundary, and `ok` records whether the call succeeded (it ran, a command exited 0, no `error` in its output). Both are carried through the oplog and come back from `sync.transcript` and `sync.resume`. Record `ok` whenever it is known: a tool result's `content` is the text a model read, so a reader of a resumed transcript without it has to re-derive the outcome from that text.
- Route a conversation turn **through the oplog** (a `Surface::Conversation` op) so `sync.resume` is a real, provider-valid transcript replay across devices. FFI: `syncRecordTurn` / `sync_record_turn`.
- **Validated** (fails fast rather than persist a malformed turn): `conversation_id` must be non-empty — it's the scoping key `sync.resume` folds on, so a blank one would pool unrelated conversations into one anonymous thread. A turn must also carry `content`, **unless** it's a tool turn identified by `tool_use_id` (or carries `tool_calls`), which may have empty content.

`sync.record_intent` and `sync.fence_check` carry an `agent_id` and are subject
to the same bound-identity rule as `lease.*` below.

#### `sync.record_intent`
- **Params**: `{ agent_id: string, run_id: string, epoch: number, status: "pending" | "committed" | "failed", scope? }`
- **Returns**: `{ recorded: boolean, op_id?: string, reason?: string }`
- Write the leased-execution intent ledger (`Surface::Intent`), **terminal-guarded**: a `pending`/`failed` write for an already-committed run is a no-op. Populates the committed-run oracle `sync.fence_check` reads. FFI: `syncRecordIntent` / `sync_record_intent`.

#### `sync.pump`
- **Params**: `{}`
- **Returns**: `{ pushed, push_deduped, folded, acked: Hlc | null, state_hash }`; with org-scope sync on, `{ user: <that>, orgs: { <org>: { result } | { error } } }`, plus `org` (the result) or `org_error` when exactly one org is configured — the single-org shape from before.
- With org-scope sync on, each configured org's delivery subsystem is pumped on its own; one org's failure never hides the personal result or another org's. An org whose subsystem failed to open is retried first.
- One reconciliation round against the relay: push journal-durable own ops → pull → verify → fold → ack. Returns `FrontierTruncated` (as an error) when the relay has GC'd past this device's frontier — call `sync.rebase` and pump again. FFI: `syncPump` / `sync_pump`. With the Parslee backend and more than one signed-in login (`car auth login --add`), the reply also carries `accounts: { <account_id>: <pump result | {error} | {error, setup_failed: true}> }` — one personal subsystem per login other than the one present at daemon start, pumped best-effort so one login's relay failure never hides another's. They exist only to carry this host's A2A endpoint to each login's other devices and read theirs back for `parslee` peer discovery and peer trust (fleet work keeps one shared budget for all of them); knowledge, transcripts, config and leases stay on the primary subsystem. `auth.remove_account` and `auth.logout` drop the affected login's subsystem and rebuild trust before replying. Every login's key is derived from the same `PARSLEE_SYNC_PASSPHRASE`; a device that used a different one simply does not appear. `setup_failed` marks a login whose subsystem could not be opened (a locked keychain, a full disk, the relay down); it is retried at most every five minutes. The login list is otherwise re-read only when the credential-authority generation changes, so a steady pump timer reads no credentials — except while the generation is unknown (no hint could be published), when it is re-read at most every five minutes. Absent with one login, so that reply is unchanged.

#### `sync.checkpoint`
- **Params**: `{}`
- **Returns**: `{ published: boolean, checkpoint_hash?: string }`
- Compute + upload a device-side checkpoint at the relay's stable frontier (the E2E-ready snapshot; the relay never folds). FFI: `syncCheckpoint` / `sync_checkpoint`.

#### `sync.rebase`
- **Params**: `{}`
- **Returns**: `{ rebased: boolean, base_checkpoint?: string }`
- Cold bootstrap / straggler re-entry: re-anchor on the relay's latest checkpoint, carrying uncovered local ops across. FFI: `syncRebase` / `sync_rebase`.

#### `sync.transcript`
- **Params**: `{ conversation_id?: string }`
- **Returns**: `Turn[]` `{ conversation_id, role, content, tool_calls?, tool_use_id?, provenance?, ok?, timestamp, hlc, op_id }`
- `provenance` is `"external"` on a tool turn whose bytes came from outside the trust boundary (a web page, an HTTP response, a remote MCP server); omitted otherwise, which means internal. Carried through the oplog so a resumed conversation does not silently re-trust fetched content (car#723).
- The ordered, role-threaded raw transcript projection of the conversation ops. FFI: `syncTranscript` / `sync_transcript`.

#### `sync.resume`
- **Params**: `{ conversation_id?: string }`
- **Returns**: `Message[]` (`user` / `assistant {content, tool_calls}` / `tool_result {tool_use_id, content, provenance?, ok?}`)
- `provenance` is `"external"` for retrieved content and omitted for internal results. Hosts that render or re-send these messages should preserve the field; CAR's own protocol handlers fence external content before it reaches a model.
- The **repaired, provider-valid** message sequence a host replays to continue the conversation — the verbatim resume path. FFI: `syncResume` / `sync_resume`.

#### `sync.fence_check`
- **Params**: `{ agent_id: string, run_id: string, epoch: number }`
- **Returns**: `{ decision: { decision: "proceed" | "already_committed" | "stale_epoch" | "not_held", .. }, may_dispatch: boolean }`
- The **executor dispatch fence** at the point of effect (B5's deferred exactly-once completion): the durable, fence-independent committed-run oracle read **first** (an already-committed run never re-executes, whatever the epoch), then the linearizable "am I still epoch N?" read (a stale-epoch zombie is refused). Only `may_dispatch == true` authorizes the external side effect. FFI: `syncFenceCheck` / `sync_fence_check`.


{% endraw %}
