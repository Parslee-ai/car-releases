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
- **Returns**: `{ available, backend, reason?, summaries: InboxSummary[], unresolved?: UnresolvedInbox[] }` where
  `InboxSummary` is `{ account_id, unread, total, most_recent_subject? }` and
  `UnresolvedInbox` is `{ account_id, reason }`
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS the
  Mail.app backend uses the daemon process's Mail Automation permission, and
  Full Disk Access when available for the read-only Envelope Index, falling
  back to Automation alone when the index is unreadable.
- **Note**: returns counts per account, **not** message rows — use
  `mail.messages` for rows. (This entry previously documented
  `{ messages: Message[] }`, which the code has never returned.)
- **Note**: on macOS, `unread` and `total` come from Mail's Envelope Index
  row for the INBOX, the same row `mail.mailboxes` reads, and
  `most_recent_subject` from the newest INBOX row, so the call never asks
  Mail.app to load the whole INBOX. Through Apple Events (no readable index,
  or an account the index has no INBOX row for) the INBOX is found the way
  `mail.messages` finds it, so an Exchange inbox Mail names `Inbox` is read;
  the counts come from Mail's message count and the mailbox's unread count and
  the subject from one bulk date read, not one Apple Event per message
  (`most_recent_subject` is `null` when Mail cannot return the dates). A
  locked or slow index returns `available: false` with the reason.
- **Note**: an unreadable INBOX is never reported as a `total: 0` summary.
  The two surfaces differ here: `mail.inbox` reports an inbox whose counts it
  cannot read as unresolved (counts unknown), while `mail.mailboxes` reports
  a count it cannot read as `0`.
  A selected account whose INBOX cannot be found or read has no entry in
  `summaries` and is listed in `unresolved` with the reason (`no mailbox named
  INBOX in the selected account(s) — list them with mail.mailboxes`, the
  wording `mail.messages` uses, the error Mail returned, or `INBOX message
  count unreadable` / `INBOX unread count unreadable` when Mail answered with
  no value instead of an error). `unresolved` is
  **omitted** when every selected account read, so the reply's shape is unchanged.
  When no selected account reads, the call returns `available: false` with a
  `reason` naming each account, and `unresolved` lists them. An `account_ids`
  filter matching no account returns `available: false` naming the unmatched
  ids.

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
  `500`), since?: string (RFC3339), include_body?: boolean, all_mailboxes?:
  boolean, timeout_ms?: number }`
- **Returns**: `{ available, backend, reason?, messages: MessageSummary[],
  unresolved?: UnresolvedMailbox[] }` where `MessageSummary` is `{ id,
  message_id: string | null, account_id, mailbox, subject?, sender?,
  recipients: string[], cc: string[], date_received?, read, preview?, body?,
  body_unavailable?: string }` and `UnresolvedMailbox` is `{ account_id,
  mailbox: string | null, reason, timed_out: boolean }`
- **Errors**: a Mail.app read that does not finish within its bound fails
  with error code `timeout` (not `backend`); passing both `mailbox` and
  `all_mailboxes: true` is invalid params (`-32602`).
- **Access**: requires the daemon auth token when daemon authentication is
  enabled. It is **not** in the default approval-transport gate. On macOS the
  Mail.app backend uses the daemon process's Mail Automation permission.
  Mailbox reads also use Full Disk Access when available, for the read-only Envelope
  Index, and fall back to Automation alone when the index is unreadable; Full
  Disk Access is therefore not a hard gate for this method.
- **Notes**:
  - `mailbox: null` (or omitted) reads `INBOX`, and `limit` defaults to `50`, so
    `{}` reproduces the pre-existing INBOX-only read for every current caller.
  - `recipients` is the **To** line only, in header order, as it always was;
    `cc` is the **CC** line, in header order, and is `[]` when the message has
    none or the backend could not read it. Every backend fills it: Mail.app's
    `cc recipients`, the Envelope Index's CC rows, Microsoft Graph's
    `ccRecipients`. BCC is not exposed.
  - `all_mailboxes: true` reads every mailbox of the selected accounts in one
    call (with `mailbox` unset), merged newest first **inside the backend**, so
    the ordering is global rather than "whichever mailboxes were visited
    first", and deduped by `message_id` within each account (a Gmail message
    in INBOX and under a label is one row, kept with the newest copy; the same
    `message_id` in two accounts, such as a message sent from one to the
    other, is one row per account). On macOS every mailbox the
    Envelope Index can place is read by one index query bounded by `limit`;
    the rest (all of them without Full Disk Access) go through Apple Events one
    mailbox at a time, smallest first when Mail's counts are known. No mailbox
    read starts once `timeout_ms` has elapsed (a read already running is
    itself bounded by `timeout_ms`), and after one read times out none
    starts, since Mail keeps working on the abandoned request. Every mailbox
    not read is listed in `unresolved` with a `reason` and `timed_out`
    (`true` when time ran out: retry later or with a larger `timeout_ms` or a
    `since` window). `unresolved` is omitted when nothing was skipped; when
    nothing could be read the call is `available: false`, and `unresolved`
    still names what was not read. When the Envelope Index is locked, no
    message is read through Apple Events, but one Apple Events walk of the
    mailbox names (no messages, bounded by the index's own 2 s or
    `timeout_ms` if lower) lists every mailbox (`timed_out: true`); if that
    walk does not finish, each requested account is listed with
    `mailbox: null`. When Mail reports it cannot list the accounts'
    mailboxes, each requested account is listed with `mailbox: null` too. In
    both whole-account cases, with `account_ids` empty there is no account to
    name and `unresolved` is empty. A walk that times out or fails outside a
    locked index is still an error, as before. On Microsoft Graph
    the read is `/me/messages` and each row's `mailbox` is its folder id.
    Every mailbox includes Sent, Drafts, Junk and Trash.
  - `timeout_ms` bounds each Mail.app Apple Events script the read runs
    (default 15,000; clamped to 1,000–120,000), the Envelope Index message
    query (never below its 2 s bound; a locked index still answers at about
    1 s), and on Graph the HTTP request.
    A Mail.app read that does not finish fails with error code `timeout`; a
    Graph request that times out is `available: false` with the reason. The
    `timeout` message still says Mail.app may stay busy; once Mail has
    answered earlier in the same process it no longer suggests checking
    automation permission, since a permission problem is then unlikely. With `include_body`, the index body
    budget is 10 s, less under a `timeout_ms` below 15 s.
  - Rows come back newest first, and that ordering is **global, not per
    account**: rows from every matched account are merged into one date-ordered
    list before `limit` is applied, so `limit: 1` across two accounts that both
    hold the mailbox returns the newer of the two messages rather than
    whichever account the backend enumerated first. `since` is applied
    **before** `limit`, so a narrow window still returns the newest `limit`
    matches.
  - On macOS, a mailbox read (INBOX, and since Parslee-ai/car-releases#93 any
    filed mailbox) comes from Mail's read-only local **Envelope
    Index** (the store `mail.mailboxes` reads counts from): the index query
    reads INBOX membership through Mail's own indexes and fetches details for
    at most `limit` rows, and it never asks Mail.app to load the whole
    mailbox. Through Apple Events, Mail answers an INBOX read by loading the
    whole mailbox: a Gmail INBOX label inside a large All Mail outlasted the
    15 s bound. Gmail's INBOX label members are included, rows Mail has marked
    deleted are not, and rows can lag Mail's live state by a sync cycle. An
    account the index has no INBOX row for is read through Apple Events and
    merged newest-first; when the index is unreadable (no Full Disk Access,
    an older schema), the whole read uses Apple Events. An index that is
    locked or does not answer within its 2 s bound returns `available: false`
    with the reason instead, because the Apple Events fallback is the slow
    read this path replaces. With `include_body`, bodies are fetched only for
    the rows returned, one lookup per row, and no new lookup starts once a
    10 s budget is spent. That budget covers every account's body lookups
    from the index together: each account's lookups get what the earlier
    accounts left. Rows for an account read through Apple Events get their
    bodies in that read, outside this budget. It is checked between lookups
    and cannot interrupt work already running, so a call can take the budget
    plus at most one lookup or one account/mailbox resolution already
    running (a script that starts resolves its account and mailbox through
    Apple Events before its first budget check), and a single slow step can
    still run to the 15 s bound. Bodies are
    best-effort: a row Mail cannot find by id, a row past the budget, a row
    whose lookup failed, or one whose Message-ID does not match the index row
    keeps `body: null`. A
    sender whose display name holds an RFC 5322 special other than `.` is rendered
    quoted (`"Doe, Jane" <jane@example.com>`), the form Mail's scripting
    `sender` is expected to use; that match is not verified live.
  - A filed mailbox is first resolved against Mail's own mailbox tree, by the
    same rules Apple Events use, and then placed on the index (Gmail's
    `[Gmail]/All Mail` is the `All Mail` Mail shows); rows are stamped with
    Mail's name for it. A mailbox the index has no row for, and every mailbox
    when the index is unreadable, is read through
    Apple Events: ordering uses an ID/date snapshot of the mailbox (or
    supported filed-mailbox date window), then reads details for at most
    `limit` candidates per account. This preserves newest-first results
    regardless of Mail's collection order without reading every message's
    details. An unreadable ordering snapshot returns `available: false`, never
    an arbitrary prefix reported as newest mail. So does a detail read that
    falls back to per-message reads and cannot get the page's message count
    (`Mail message count unreadable; retry the listing`), rather than
    returning no rows. On that fallback a subject or sender Mail returns no
    value for is `null`, not the text `"null"`.
  - A call Mail.app does not answer within the 15 s bound fails with an error
    saying Mail.app may stay busy: killing `osascript` does not cancel the
    Apple Event, so later Mail calls can also time out until Mail finishes it.
    Wait before retrying.
  - `body` is populated only when `include_body` is `true`, and each body is cut
    at 100,000 characters. A Mail.app row whose body was asked for but not
    returned carries `body_unavailable`, a sentence saying why (the call's
    body budget was spent, Mail found no message with that id, Mail could not
    read it or did not answer, or the message at that id has a different
    Message-ID) and, where it helps, to fetch it with `mail.message_body`. The
    field is absent when the body came back (an empty body is `""`) or was not
    asked for. `preview` is free on Graph (`bodyPreview`); on macOS
    it is `null` unless `include_body` was set.
  - `id` is opaque and backend-qualified — feed it to `mail.message_body`, do
    not parse it. A Mail.app id is composite because its numeric message id is
    only addressable inside one mailbox of one account.
  - On Mail.app rows, `message_id` is the RFC 5322 `Message-ID` header as
    Mail's scripting layer exposes it. INBOX rows read from the Envelope Index
    carry the stored header with one pair of angle brackets removed, on the
    expectation that Mail's scripting value has none; that expectation is not
    yet verified against a live Mail store. Through Apple Events
    it is read as one bulk property array for each bounded detail window, so
    it does not add a per-message Apple Event. The value can identify the same
    message across mailboxes; it is `null` when Mail does not expose the
    header and on Microsoft Graph rows.
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
- **Params**: `{ account_id: string, to: string[], cc?: string[], bcc?: string[], subject: string, body: string, draft_only?: bool }`. `draft_only: true` saves a draft in `account_id`'s Drafts instead of sending.
- **Returns**: `{ available: bool, backend: string, reason?: string, sent: bool, message_id: string | null }`. `sent: false` with a `reason` (e.g. `sender_override_failed: …` or `drafts_unavailable: …`, each saying what to change in Mail's account settings) when Mail will not use `account_id`'s address, or (for a draft) reports that account turned off or lists Drafts mailboxes for other accounts but none for it (when Mail cannot say, the draft goes ahead); nothing is sent or drafted from another account. On Mail.app, Mail can leave an autosaved copy of the message in Drafts: usually empty, or with the message if Mail moved the sender while it was being filled in (beside a saved draft, or after a refusal); CAR doesn't remove it. The outgoing message Mail creates for the call stays in Mail's (invisible) outgoing list until Mail quits.
- **Access**: this is a mutation, not a read. It requires the daemon auth token
  when daemon authentication is enabled, **is** in the default per-call
  approval-transport gate, and on macOS uses the daemon process's Mail
  Automation permission. It does not require Full Disk Access.


{% endraw %}
