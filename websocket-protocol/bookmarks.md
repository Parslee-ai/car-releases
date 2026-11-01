{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### bookmarks

#### `bookmarks.list`
- **Params**: `{ limit?: number = 100 }`
- **Returns**: `{ available, backend, reason?, bookmarks: Bookmark[], skipped: number }`. `Bookmark` is `{ title, url, source }`. macOS reads Safari's `Bookmarks.plist` (backend `safari_bookmarks`); elsewhere every Chromium profile (Chrome, Edge, Brave; backend `chromium_bookmarks`). `skipped` counts entries that looked like bookmarks but could not be read (a Safari leaf with no usable URL, a Chromium `url` node with no string `url`) and were left out, rather than failing the whole listing; only entries visited before `limit` was reached are counted. When `available` is false, a read macOS refused (no Full Disk Access) names Full Disk Access in `reason`, a file whose own permissions deny reading says so instead, and a file that reads but does not parse says it is not a readable property list.


{% endraw %}
