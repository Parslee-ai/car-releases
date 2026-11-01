{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### notes

#### `notes.accounts`
- **Params**: `{}`
- **Returns**: `{ available, backend, reason?, accounts: NoteAccount[] }`

#### `notes.find`
- **Params**: `{ query: string, limit?: number = 50 }`
- **Returns**: `{ available, backend, reason?, notes: NoteSummary[] }`

#### `notes.read`
- **Params**: `{ id: string }` — a `NoteSummary.id` from `notes.find`.
- **Returns**: `{ available, backend, reason?, id, name?, folder?, modified?, body?, truncated }`

Reads one note and changes nothing. `body` is the note's HTML exactly as
Notes.app stores it, so a read-back shows what was written: an empty list item
comes back as `<li><br></li>`. A body over 100,000 UTF-16 code units is cut there (never inside a surrogate pair) and
`truncated` is `true`. A note that is not there is `available: false` with
`reason: "note <id> not found"`; Notes not answering (not running, Automation
not granted, an Apple Events timeout) is `available: false` with that reason.
macOS only: elsewhere it answers `available: false` with no body.


{% endraw %}
