{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### mail

#### `mail.accounts`
- **Params**: `{}`
- **Returns**: `{ accounts: MailAccount[] }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS the
  Mail.app path uses the daemon process's Mail Automation permission (and can
  fall back to Internet Accounts); it does not require Full Disk Access.

#### `mail.inbox`
- **Params**: `{ account_ids?: string[] }`
- **Returns**: `{ available, backend, reason?, summaries: InboxSummary[] }` where
  `InboxSummary` is `{ account_id, unread, total, most_recent_subject? }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS the
  Mail.app backend uses the daemon process's Mail Automation permission, not
  Full Disk Access.
- **Note**: returns counts per account, **not** message rows — use
  `mail.messages` for rows. (This entry previously documented
  `{ messages: Message[] }`, which the code has never returned.)

#### `mail.mailboxes`
- **Params**: `{ account_ids?: string[] }` — omit to enumerate all accounts
- **Returns**: `{ available, backend, reason?, mailboxes: Mailbox[] }` where
  `Mailbox` is `{ account_id, name, full_name, unread, total }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS it
  uses Full Disk Access when available for the read-only Envelope Index, but
  falls back to the daemon process's Mail Automation permission when the index
  is unreadable; Full Disk Access is therefore not a hard gate for this method.
- **Notes**:
  - Nested mailboxes are included on **both** backends. `full_name` is the
    **selector** — pass it back verbatim as `mail.messages`'s `mailbox`. On
    macOS it is the slash-joined path from the account root (`"Travel"`,
    `"Travel/2026"`); on the Microsoft Graph backend it is the folder id.
    `name` is the leaf label.
  - Graph's `/me/mailFolders` returns only root-level folders, so nested ones
    come from a bounded `childFolders` walk: depth 8 (matching the macOS walk),
    at most 64 requests, following `@odata.nextLink` up to 5 pages per listing.
    A folder tree deeper or wider than that is truncated.
  - An `account_ids` filter that matches no account returns `available: false`
    with a reason naming the unmatched ids — not an empty list.
  - On macOS, `total` (and `unread` for nested mailboxes) is read from Mail's
    read-only local **Envelope Index** rather than live Apple Events, so both
    can lag Mail's live state by a sync cycle. When that index is unreadable
    (no Full Disk Access, fresh profile) the listing falls back to per-mailbox
    Apple Events — slower but live; a mailbox the index has no row for keeps a
    best-effort `total: 0` and its observed unread rather than failing the
    listing.

#### `mail.messages`
- **Params** (the params object *is* the `MessageQuery`; every field defaults):
  `{ account_ids?: string[], mailbox?: string | null, limit?: number (maximum
  `500`), since?: string (RFC3339), include_body?: boolean }`
- **Returns**: `{ available, backend, reason?, messages: MessageSummary[] }`
  where `MessageSummary` is `{ id, message_id: string | null, account_id,
  mailbox, subject?, sender?, recipients: string[], date_received?, read,
  preview?, body? }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS the
  Mail.app backend uses the daemon process's Mail Automation permission, not
  Full Disk Access.
- **Notes**:
  - `mailbox: null` (or omitted) reads `INBOX`, and `limit` defaults to `50`, so
    `{}` reproduces the pre-existing INBOX-only read for every current caller.
  - Rows come back newest first, and that ordering is **global, not per
    account**: rows from every matched account are merged into one date-ordered
    list before `limit` is applied, so `limit: 1` across two accounts that both
    hold the mailbox returns the newer of the two messages rather than
    whichever account the backend enumerated first. `since` is applied
    **before** `limit`, so a narrow window still returns the newest `limit`
    matches.
  - On macOS, ordering uses an ID/date snapshot of the mailbox (or supported
    filed-mailbox date window), then reads details for at most `limit`
    candidates per account. This preserves newest-first results regardless of
    Mail's collection order without reading every message's details. An
    unreadable ordering snapshot returns `available: false`, never an
    arbitrary prefix reported as newest mail.
  - `body` is populated only when `include_body` is `true`, and each body is cut
    at 100,000 characters. `preview` is free on Graph (`bodyPreview`); on macOS
    it is `null` unless `include_body` was set.
  - `id` is opaque and backend-qualified — feed it to `mail.message_body`, do
    not parse it. A Mail.app id is composite because its numeric message id is
    only addressable inside one mailbox of one account.
  - On Mail.app rows, `message_id` is the RFC 5322 `Message-ID` header exactly
    as Mail exposes it. It is read as one bulk property array for each bounded
    detail window, so adding it does not add a per-message Apple Event. The
    value can identify the same message across mailboxes; it is `null` when
    Mail does not expose the header and on Microsoft Graph rows.
  - A row's `mailbox` is the mailbox as the backend **resolved** it, not the
    selector the caller sent: a query for `"travel"` returns rows stamped
    `"Travel"`, and one for the bare leaf `"2026"` returns rows stamped
    `"Travel/2026"`, so rows can be matched against `mail.mailboxes` output.
  - A `mailbox` that resolves in no selected account — or an `account_ids`
    filter that matches no account — returns `available: false` with a reason
    naming it. An unreachable mailbox must not read as an empty one, which is
    the silent failure this method exists to end.

#### `mail.message_body`
- **Params**: `{ message_id: string }` — an `id` from a `mail.messages` row
- **Returns**: `{ available, backend, reason?, id, content_type: "text" | "html",
  body: string | null, truncated: boolean }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS the
  Mail.app backend uses the daemon process's Mail Automation permission, not
  Full Disk Access. An operator who wants message bodies to require approval
  may add it via `ServerStateConfig::with_approval_gate`.

#### `mail.send`
- **Params**: raw mail message object (`to`, `subject`, `body`, etc.)
- **Returns**: `{ message_id: string, ... }`
- **Access**: this is a mutation, not a read. It requires the daemon auth token
  when daemon authentication is enabled, **is** in the default per-call
  approval-transport gate, and on macOS uses the daemon process's Mail
  Automation permission. It does not require Full Disk Access.


{% endraw %}
