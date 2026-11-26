{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### messages

#### `messages.services`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, services: MessageService[] }`

#### `messages.chats`
- **Params**: `{ limit?: number }`
- **Returns**: `{ available, backend, reason?, chats: Chat[] }`

#### `messages.read`
- **Params**: `{ chat_ids?: string[], since?: string (RFC3339), limit?: number (maximum `500`), include_body?: boolean }`
- **Returns**: `{ available, backend, reason?, messages: ChatMessage[] }` where
  `ChatMessage` is `{ id, chat_id?, handle?, is_from_me, own_echo, date, text? }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled and, on macOS, Full Disk Access for the daemon/CLI process to read
  `chat.db`. It is **not** in the default approval-transport gate; operators
  may add it with `ServerStateConfig::with_approval_gate`.
- **Notes**:
  - `chat_ids` contains the `chat.guid` values returned by `messages.chats`.
    Omit it to read across chats. `id` is the stable `message.guid` and must be
    treated as opaque. `handle` is commonly absent on rows where `is_from_me`
    is `true`.
  - Rows are newest first. `since` is applied in SQLite **before** `limit`, and
    `date` is RFC3339 converted from Messages.app's Apple-epoch nanoseconds.
  - `text` is decoded from `attributedBody` (falling back to the text column)
    only when `include_body` is true, and is bounded to 100,000 characters.
  - `own_echo` is always a boolean. Only a received twin of a **daemon-recorded
    send** can be marked. The daemon persists the exact final transport text,
    recipient, Apple-epoch send time, and pre-send database ROWID in
    `$CAR_HOME/messages-send-log.json` (default state root: `~/.car`).
    Readback correlates the new same-text sent row in that chat and saves its
    ROWID/GUID. Pairing then uses that identity, with exact text and same-chat
    checks. A bare `is_from_me = 1` row is never evidence of daemon authorship:
    the owner's iPhone creates those rows too. Its received twin stays unmarked
    and can answer the floor or resolve `A0 approve`.
  - A script send declared through `run_applescript`'s `imessage_send`
    ([automation](automation.md#automationrun_applescript)) is the other kind
    of daemon-recorded send. Its declaration holds `id`, `db`, `to`, `tagged`
    (the body plus a 64-character tag of U+200B/U+200C), `after_rowid` and
    `declared_at_ns`. After each read's query, the earliest received row above
    `after_rowid` whose decoded text equals `tagged` exactly is saved as a
    positive judgment, and the declaration closes. No time window or chat check
    applies: the tag is the identity. A copy of the tagged text pasted back
    before the echo arrives is marked instead; a later copy is not. A
    declaration is never compacted. It closes unmatched on the first read at
    least 24 hours after it was declared, after recognition has looked at every
    newer row. At most 500 may be open. `declared.matched`, `declared.unmatched`
    and `declared.open` in the log count them.
  - Each send record matches at most one received row, persisted by ROWID.
    A persisted ROWID cursor per database advances only over new rows, in
    chats with open reservations (a chat counts when an open entry's recipient
    is one of its participants). No SQLite query holds the send-log lock.
    Restarts, history, limits and metadata-only reads retain positive marks. Intervening owner
    messages do not erase daemon send records. Text is compared before output
    truncation, without case folding or whitespace normalization.
  - Every outbound path shares the durable sender: floor questions and notices,
    approval prompts, `messaging.test_send`, outbound adapters and direct
    `messages.send`/binding calls. The 0600 log is replaced atomically under
    `messages-send-log.lock`. Entry fields are `id`, `recipient`, `text`,
    `sent_at_ns`, `after_rowid`, `sent_row`, `echo_row`, `confirmed`, `matched_at_ns`; identities
    contain `rowid`, `guid`, `chat`. `next_id` allocates reservation IDs and
    `databases` stores each path's `last_rowid`, `last_join_rowid`, `observed_at_ns` and bounded
    pending twin rows.
    Startup and subsequent reads/writes keep **unmatched entries for 24 hours
    after send time**, including uncertain transport outcomes. Matched entries
    expire after the delay plus **60 seconds after matching** (65 seconds by
    default); `matched_at_ns` records that time (old logs fall back to send time).
    A **500-entry cap** evicts oldest sends first, including unmatched sends.
    Send/match/retention changes are flushed; cursor-only changes use atomic
    replacement without a durability flush and can replay after power loss.
    Pending context is capped at 1,000 rows per database and cleared when no
    live entries remain. Database cursors have a 24-hour idle expiry and a
    500-database oldest-first cap.
  - Positive judgments persist independently as 0600 identity records at
    `$CAR_HOME/messages-own-echo/<sha256-of-database-path>/<ROWID>.json`.
    Records contain only `rowid`, `guid` and `chat`, without message text, and
    are atomically written and flushed before returning a marked row. They do
    not expire with the send log; both inbound and history reads point-lookup
    selected rows and require the saved GUID to match. The index grows with
    marked messages and is protected from agent file-tool writes. SQLite is never read or modified while holding the log lock.
    Correlation considers only rows newer than the persisted cursor plus its
    bounded pending context, and only with a matching open send entry; history
    reads do not re-judge the entire history or turn unrelated false rows true.
  - `CAR_IMESSAGE_OWN_ECHO_DELAY_MS` sets the positive inclusive delay after
    the recorded send time. Unset, zero, malformed or overflowing values use
    5,000 ms. The repo's 2026-06-23 on-device probe establishes the twin shape,
    without a latency distribution. The default covers the 2 s fixture; it is
    not a measured device upper bound. Echoes beyond the delay stay unmarked.
  - Messages.app's send call does not return a database identity. Initial
    correlation uses the pre-send ROWID, recipient/chat, exact text and time;
    subsequent matching prefers the persisted sent ROWID/GUID. Indistinguishable
    concurrent same-text sends can still make this initial correlation
    ambiguous. This is transport correlation, not sender authentication.
    Unconfirmed transport outcomes and sends whose database row is not yet
    readable remain unmarked. The floor retains its closed approval grammar.
  - If Full Disk Access or the database is unavailable, the method returns
    `available: false`, a `reason` naming the database failure, and
    `messages: []`. Callers must not interpret that envelope as an empty
    conversation.

#### `messages.send`
- **Params**: `{ recipient: string, body: string, service_id?: string }`
- **Returns**: `{ available, backend, reason?, sent: boolean }`

> **`messages.send` is not the governed agent send surface.** It is a macOS
> host-automation integration RPC, a sibling of `mail.send` and
> `notes.accounts`, and it dispatches straight to the local Messages app. It
> does not run through the validator, the policy engine, the rate limiter or
> the event log; its only gate is the interactive per-call `ApprovalGate`
> (which `car-server --no-approvals` removes).
>
> The governed agent path is the **`messaging.send` tool** — one character
> apart. Rules written in `.car/policies` against the `messaging.send` tool do
> **not** constrain this RPC. Agents should use the tool.


{% endraw %}
