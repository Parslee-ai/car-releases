{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### feedback

The `feedback.*` namespace is CAR's in-app feedback intake (Parslee-ai/car#1137):
compose a redacted diagnostic bundle, preview it, durably spool it, and read the
local outbox. **All four methods first require the connection to negotiate the
optional `feedback.v1` capability in `server.handshake`**; protocol version
alone is not consent to this surface. They also require the exact current
protocol version (`car-proto::PROTOCOL_VERSION`) and return `-32005` (`protocol
handshake required:`) until that handshake succeeds, because a legacy host has
no consent UI for feedback. They are *not* host-management-gated: any
authenticated client that negotiated the current protocol and `feedback.v1`
may call them. Failures (spool I/O, invalid params, unknown ids, the throttle)
surface as ordinary JSON-RPC errors whose message names the cause.

**Closed world by construction**: no method on this surface accepts a path
parameter, and unknown params are ignored — a client-sent `path` or
`log_tails` field is inert. The log set is built daemon-side: the supervised
agents' `<id>.{stdout,stderr}` log files (ids read from the `agents.json`
registry manifest — only the `id` field; env maps never enter the bundle) plus
the daemon stderr-tee file (`<CAR_HOME>/logs/car-server.stderr.log`). A client
cannot name a file to include.

**Consent semantics (toggles are authoritative)**:

- `include_diagnostics: false` (the default) collects **no** log tails, no
  doctor report, and no runtime context — the bundle carries an explicit
  `diagnostics` manifest item noting the exclusion.
- `include_screenshot: false` (the default) drops any supplied
  `screenshot_b64` bytes entirely: no screenshot item exists anywhere in the
  bundle, not even a manifest note. With the toggle on, the host-captured
  JPEG (base64, ≤5MB decoded — the ChatAttachments per-image cap) rides
  `bundle.runtime_context.screenshot` as `{jpeg_b64, byte_len}` and is
  accounted as a `screenshot` manifest item.

A current-protocol session without `feedback.v1` gets the standard `protocol capability mismatch:` refusal and nothing is composed or spooled.

#### `feedback.compose_preview`
- **Params**: `{ description: string, include_screenshot?: boolean = false, include_diagnostics?: boolean = false, screenshot_b64?: string }`
- **Returns**: `{ preview_id: string, bundle: RedactedBundle, manifest }` — `manifest` is the bundle's own manifest echoed top-level for cheap rendering; `preview_id` is an opaque handle to the exact composed bytes
- The consent preview: assembles the exact post-redaction bundle `feedback.submit` would spool — both run the one compose path — and **persists nothing to the spool**. The composed bundle is held in a small in-memory daemon cache (5 entries per CAR home, 10-minute TTL) keyed by `preview_id` and the composing WebSocket session, so another session cannot redeem a leaked handle. `feedback.submit { preview_id }` from the owning session enqueues the PREVIEWED bytes byte-for-byte (the same-bytes consent handoff). A supplied screenshot that fails validation (base64 decode, JPEG SOI/EOI magic, ≤5MB decoded) never aborts: it soft-fails to an omitted manifest item with a why-note. A `feedback.submit` carrying an invalid/expired/foreign-session `preview_id` returns a `PREVIEW_EXPIRED` error instead of silently composing unseen bytes — the host re-previews and asks the user to submit again; only a submit WITHOUT a `preview_id` composes fresh (explicit consent to current state).

#### `feedback.submit`
- **Params**: the `feedback.compose_preview` params **plus** `{ lane: "authenticated" | "anonymous", org_id?: string, preview_id?: string }` — with a valid `preview_id` the daemon enqueues the stored previewed bundle byte-for-byte; an expired/unknown `preview_id` is a `PREVIEW_EXPIRED` error (re-preview and resubmit); omitting `preview_id` composes fresh. For the authenticated lane, `org_id` is optional compatibility input and never authority: the daemon derives the organization from its signed-in Parslee session and rejects a supplied mismatch.
- **Returns**: `{ submission_id: string, client_submission_id: string, state: { state: "queued" }, source: "local" }`
- Composes the same bundle and durably enqueues it in the local spool (`<CAR_HOME>/feedback-outbox`), then wakes the upload drain. The identity lane is bound at enqueue — the consent moment — into durable spool state with no rewrite API, so a signed-out submission can never later drain with a bearer: `lane: "authenticated"` requires a signed-in Parslee session with an active organization; that session-derived id is persisted, and any client-supplied `org_id` must match it. `org_id` alongside `lane: "anonymous"` is ignored. `client_submission_id` is the immutable idempotency key. A client-side per-install throttle (10 submissions per rolling hour, checked before enqueue) rejects the call with a message naming `retry in <n>s`.

#### `feedback.status`
- **Params**: `{ submission_id?: string, limit?: integer }`
- **Returns**: `{ entries: [SpoolEntryRow], has_more: boolean, staleness: { pending_count, oldest_age_days } | null }` — filtered to the one entry when `submission_id` is given (unknown id → error; `limit` ignored), otherwise the same bounded rows as `feedback.list`. If the selected bundle is corrupt, its durable summary still returns with `description: null` instead of failing the RPC.

#### `feedback.list`
- **Params**: `{ limit?: integer }`
- **Returns**: `{ entries: [SpoolEntryRow], has_more: boolean, staleness }` — the newest `limit` merged local/server rows, kept in oldest-first order. `limit` defaults to 100 and is clamped to the hard maximum of 200; `has_more` says whether older rows were omitted.

A `SpoolEntryRow` is
`{ id, client_submission_id, state, lane, title, created_at, age_days, source: "local" | "server", note? }`:
`state` is the tagged spool lifecycle object — `{ state: "queued" }`,
`{ state: "sending" }`, `{ state: "acknowledged", server_id }`,
`{ state: "terminal_actionable", reason: "auth_required" | "reconsent_required" | "forbidden" }`
(waits for the user; never retried automatically), or
`{ state: "terminal_rejected", message }` (server 400-class; never retried).
`lane` is `{ lane: "anonymous" }` or `{ lane: "authenticated", org_id }`.
`created_at` is unix seconds at enqueue; `age_days` is whole days since, at
list time. `source` distinguishes local spool rows from server rows: for the
authenticated lane, `feedback.list` merges the signed-in user's rows from
CAR's own Parslee feedback intake (`GET /api/v1/orgs/{orgId}/car-feedback/mine`,
fetched via the Parslee session; any fetch failure degrades to
local-only, never an error) by acknowledged server id — a local row whose
server counterpart advanced shows the server state. Queued entries drain
to `POST /api/v1/orgs/{orgId}/car-feedback` only while the anonymous capability probe
(`GET /api/v1/car-feedback/capability`) advertises the entry's lane:
`authenticatedIntake` gates signed-in entries, and anonymous entries hold
while `anonymousIntake` is `false` (the v1 server reality). `note?` carries per-row daemon annotations on TERMINAL settles (the
drain persists upload-time omission notes when an entry settles
terminal); for successful uploads, omissions surface at submit time in
the manifest/UI warning, not as a persisted row note.
`staleness` is non-null when any pending entry has waited more than 2 days.


{% endraw %}
