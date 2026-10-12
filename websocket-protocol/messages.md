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
  `ChatMessage` is `{ id, chat_id?, handle?, is_from_me, date, text? }`
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
