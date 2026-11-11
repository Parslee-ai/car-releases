{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### board

The **shared work board**: a durable record of what every session has in flight, who is driving it, what it waits on, and what was decided. Coding sessions (`car claude`, `car codex`), CAR agents and people read and keep it; design in [shared-work-board.md](../proposals/shared-work-board.md).

**Awareness, not exclusion.** Nothing on the board locks or refuses work. Two items that share a ticket, branch or PR are *related*: the write that creates the overlap reports it in its result (`overlaps`) and sends the other item's last-writing session a `handoff` peer message, through the same admission as `agents.message`. That includes two sessions of the same account. Neither write is refused. Exclusion stays with resources that cannot be shared (worktree slots, test locks); `lattice.claim` is unchanged.

**One writer per item.** An item's `owner` is the account the daemon bound the writing session to: the work context's `account_id`, or `personal` for unbound personal work. It is set by the daemon and refused as a client field. Any session of the owning account may change the item; every change records the session that made it (`updated_by`, and `node` in the history). Any session that can see the item may append a comment, which never changes it.

**One board per work context.** A session bound to an organization uses that organization's board (every account of the org on this CAR shares it); a personal account, and unbound personal work, each have their own. A session never names another board. The operator's host client uses the personal board, names an organization this CAR holds a login for with `org`, or names a personal account context with `account` (and `api_base`, default Parslee's): the board a session bound to that account writes.

**Storage.** Each board is an append-only JSONL event log, `<state root>/lattice/board/<board>.jsonl` (0600, fsynced per event), folded to the current record on read.
- **Torn and unreadable files.** A torn line, even one cut inside a multi-byte character, is skipped, and the next write starts a fresh line. A board file that exists but cannot be read is an error for every method. It is never treated as empty.
- **Compaction.** Past 4 MiB, and after that only once the file has doubled since the last rewrite, the board is rewritten from the snapshot just written (temp file, fsync, rename, directory fsync). Items closed more than 90 days ago are dropped. Every other item keeps its first record, its newest 50 changes and its newest 200 comments. A leading `mark` event carries the highest sequence number, so numbers never repeat.
- **Other CARs.** A board also shows the items of the CARs this one reaches directly. They are read-only here: an item is changed, commented on and read in full on the CAR that holds it, and a write naming one is refused with that CAR's name. Each daemon pulls them every 15 seconds beside the Lattice listings, over the peer-authenticated A2A method `car/latticeBoard`, and checks each item as it would a local write; an item that fails is dropped.
  - **Your own devices** see every board. The same work context has the same board name on every device, and a device's items show only on that board. They count as `mine`. A daemon knows its own devices only from the host endpoints published on the encrypted sync oplog, so this needs Parslee sync: a Parslee login and the same sync passphrase on each device (`car keys set PARSLEE_SYNC_PASSPHRASE`, then restart the daemon). Without it, another of your Macs is reachable only as a Lattice connection, and is treated as one: only shared projects, never `mine`. One device's answer carries at most 64 boards (500 items each): those with something to share, most recently changed first. When more are in use, the answer counts the rest in `omitted_boards`, and the receiving daemon logs a warning naming the device whenever that number changes.
  - **Another owner's CAR over a Lattice connection** sees only items in projects shared on that connection as `agents:<project>` (`lattice.connect.share`), from the board the connection serves: its verifying organization's, or the unbound personal board for a personal connection. The batch is sealed with the connection's key, and an item that looks like it contains a credential is withheld. These are never `mine`, even when both owners are `personal`.
  - **Never shadowing.** An id this board holds is always its own: another CAR's item with the same id is dropped. A pull that fails, times out or does not open clears what that CAR showed until its next good answer.
  - **Notices across a connection** name only items in projects this owner shares on that connection. A project name is just a string: the other owner's shared `web` is not consent to show them this owner's `web`, so that overlap shows as related here only.
  - **Over the Parslee relay** (a connection neither CAR can dial), items are not pulled: each side mails its batch, sealed, as relay method `latticeBoard` when it changes (checked on every relay pump, and again after a restart; an empty batch is sent only to clear items sent before), and the other keeps it until the next one or until the connection ends. Which batch the relay last took is kept per connection in `<state root>/lattice/board/relay-sent.json`, so a project unshared while the daemon was down is cleared after a restart. Same scope as a direct connection; one batch is at most 500 items and 160 KiB.
  - **Not covered yet.** A connection over the org stream is not covered. Nothing rides the encrypted sync oplog.
  - **Overlap found by a sync.** When a pull or a relay batch brings in another CAR's item that overlaps an open item here (both written before either CAR saw the other's), no write reports it. The daemon tells that item's live last writer instead, as the reserved node `car-board` (`no_reply`, kind `handoff`, through ordinary admission in that session's own context): once per pair, only when one of the two changed in the last 10 minutes, and never for a pair the write already reported. `car-board` cannot be an agent id.
  - Own devices are sent every board on every pull, with no check for an unchanged board.

**The code host.** A project can opt in to follow its repository (`car board reconcile add --project <p> --repo <checkout>`, which writes `<state root>/lattice/board/reconcile.json`). The daemon reads that repository's forge every 5 minutes, and within 30 seconds of the config changing. It uses the coder's PR seam: `az repos pr` for Azure DevOps or `gh` for GitHub, chosen from the checkout's `origin`, with the credential the checkout already uses.
- **What it changes.** For each open item in that project with `refs.branch`, it looks at the branch's newest pull request:
  - open: `review`, with `refs.pr` set;
  - merged: `done`;
  - abandoned: `abandoned`.
  - With no pull request, a branch confirmed deleted on `origin` makes the item `abandoned`.
- **Main pipelines.** For each pipeline on the main branch (`--main-branch`, default `main`), the newest completed run decides: a failed run opens an `incident` titled `main is red: <pipeline>`, and a later successful run closes it. Cancelled, skipped and in-progress runs are ignored. Pipelines are Azure DevOps pipelines or GitHub Actions workflows (a timed-out or startup-failed workflow counts as failed). A repository on another forge is skipped with a log line.
- **It reports, never guesses.**
  - A merged pull request wins over a deleted branch, because Azure DevOps deletes the source branch on merge.
  - A forge or `git` error defers the item instead of reading as "no PR".
  - It acts only when what it observes changes, so an owner's own later edit is not overridden.
  - It changes an item only if it is still in the state it was read in.
- **How its writes look.** These are the one write that bypasses the owner rule. They are daemon-internal (no RPC can make them), and each appears in the history as `node: "code-host"`, `event: "code-host"`. Incidents it opens are owned by `code-host`: anyone may comment, and it closes them.

**The record**: `{ id, project, kind, title, owner, state, waiting_on?, refs?, note?, created_at_ms, created_by, updated_at_ms, updated_by }`.
- `kind`: `work`, `incident` (main or a shared gate is red), `policy` (a standing rule), `ask` (a named person must act; requires `waiting_on`), `finding` (a defect nobody owns).
- `state`: `open`, `in_progress`, `waiting`, `review`, `done`, `abandoned`. `stale` is never stored or set: a listing reports `stale: true` for an open item untouched for 24 hours whose last writer is no longer live (never for one the operator or the code host last wrote).
- `refs`: `{ tickets?: [string], branch?: string, pr?: string, commits?: [string], runs?: [string], urls?: [string] }`, at most 32 entries per list of at most 512 characters. Tickets, branch and PR decide overlap, after normalizing (`#9875` = `9875`, case-insensitive; `refs/heads/` and `origin/` stripped from branches). A default branch (`main`, `master`) is never an overlap key. Only open items in the same project overlap.
- `title` is one line of at most 200 characters; `note` is the item's current state in at most 1,024 bytes, replaced on each change.

Claude Code and Codex reach these through `car-mcp --collaboration` as `board_list`, `board_upsert`, `board_transition`, `board_comment` and `board_history`, and the daemon's `/mcp` endpoint serves the same tools keyed on the session's `mcp:<peer-id>`. People use `car board items` and `car board history`. The plugin's session-start hook (`car board-hook`) briefs each Claude Code session from `board.list`. `agents.session_brief` returns the same briefing as `board`, and `car codex` puts it in Codex's developer instructions.

#### `board.list`
- **Params**: `{ project?: string, state?: string, kind?: string, mine?: boolean, related_to?: string, include_closed?: boolean, limit?: integer, org?: string, account?: string, api_base?: string }`.
  - `related_to` is a ticket, branch or PR — bare, or prefixed `ticket:`, `branch:` or `pr:` — or an item id (its tickets, branch and PR). It matches items sharing any of them.
  - Done and abandoned items older than 14 days are left out unless `state` names one or `include_closed` is true. `mine` keeps the caller's account's items. `limit` is 1–500 (default 100).
  - `org`, `account` and `api_base` are for the operator's host client only, here and on every board method.
- **Returns**: `{ self, owner, count, total, items: [record + { mine, last_writer_is_you, stale, remote?, related?: [{ id, title, owner, state, updated_by, shared, remote? }] }] }`, newest change first. `remote` is this CAR's name for the CAR that holds the item; another CAR's item is `stale` when it has not changed for a day, since its sessions are not visible here. `owner` is the account the caller writes as; `total` counts matches before `limit`; `shared` names the overlapping refs (`ticket:8292`, `branch:fix/x`).

#### `board.upsert`
- **Params**: `{ id?: string, project?: string, title?: string, kind?: string, state?: string, waiting_on?: string | null, refs?: object, note?: string | null, org?: string }`.
  - Without `id` it creates an item: `project` and `title` are required, `kind` defaults to `work` and `state` to `open`.
  - With `id` it changes an item the caller's account owns, replacing only the fields given. `refs` is replaced whole. `null` or `""` clears `waiting_on` or `note`.
  - An `owner` field, an unknown field, or `state: "stale"` is refused. Changing another account's item is refused with a message naming its owner and last writer.
  - An open `ask` must name `waiting_on`; one being closed may clear it.
  - **An ask reaches the person.** When a write leaves an open `ask` waiting on `human:<name>` that has not been sent yet, the daemon sends the person a `question` peer message from the writing session, with the item's title and note. It uses the human-request ledger, approval mirroring and admission any message to a person goes through, so it reaches them in `lattice.requests`, CarHost, iMessage or Slack. The request id is recorded on the item (`asked`, set by CAR only). The result's `asked` is the send's result (`request_id`, `outcome: "awaiting_human"`, and `answer_token` for the asker alone), or `{ to, queued: false, reason }`: the operator wrote it (no peer address), or the person is not a Lattice node here. Editing the ask does not send it again; changing `waiting_on` to someone else clears `asked` and asks them. The answer goes to the asking session (`lattice_wait` with the request id). The board item gets a comment saying who answered and where the answer went, never the answer itself.
  - A board holds at most 5,000 open items, counting reopened ones.
- **Returns**: `{ item, overlaps: [{ id, title, owner, state, updated_by, shared, remote? }], notified: [{ item, node, to?, remote?, queued, reason? }], asked?, hint? }`. Overlap includes the other CARs' items this board shows; the notice for one goes to `<its last writer>@<that CAR>`, under ordinary cross-CAR message admission (a connection's shares included).
  - `overlaps` lists only items that became related with this write; a later change that keeps an overlap does not report it again.
  - For each, `notified` says where the `handoff` went: the other item's last writer when it is live, else the person's `inbox:<org>` on an organization's board. Otherwise it is `queued: false` with the reason: the caller is that item's last writer too, the operator wrote (no peer address), the last writer is not live, or the per-write cap was reached.
  - At most 5 notices go out per write; the remaining overlaps show as `related` only.
  - Delivery runs in the background: `queued: true` means the send started, not that it arrived. A refused delivery is logged by the daemon.

#### `board.transition`
- **Params**: `{ id: string, state: string, note?: string | null, waiting_on?: string | null, org?: string }`.
- Moves an item the caller's account owns to `state`, replacing `note` and `waiting_on` in the same event when given. Any other field is refused (use `board.upsert`).
- **Returns**: as `board.upsert`.

#### `board.comment`
- **Params**: `{ id: string, body: string, org?: string }`. `body` is at most 2,048 bytes.
- Appends a remark to any item on the caller's board, whoever owns it. It never changes the item. An item closed more than 90 days ago (which compaction drops) refuses new comments.
- **Returns**: `{ id, commented: true, seq }`.

#### `board.history`
- **Params**: `{ id: string, org?: string }`.
- **Returns**: `{ self, item: record + { mine }, count, truncated, events: [...] }`, oldest first, at most the newest 500 events (`truncated` counts the older ones left out; compaction may already have dropped more). A change is `{ seq, at_ms, node, event: "created" | "updated" | "transition" | "code-host", from_state?, state, note, waiting_on, refs, title }` (`code-host`: written by the code-host reconciler, `node: "code-host"`); a comment is `{ seq, at_ms, node, event: "comment", author, body }`. `node` is the session that wrote the event, `author` the commenter's account.

{% endraw %}
