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


{% endraw %}
