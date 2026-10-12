{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### health

#### `health.status`
- **Params**: `{}`
- **Returns**: current health permission/availability status

#### `health.sleep`
- **Params**: `{ start: string (RFC3339), end: string (RFC3339) }`
- **Returns**: sleep windows for the date range

#### `health.workouts`
- **Params**: `{ start: string (RFC3339), end: string (RFC3339) }`
- **Returns**: `{ workouts: Workout[] }`

#### `health.activity`
- **Params**: `{ start: string (YYYY-MM-DD), end: string (YYYY-MM-DD) }` — note date-only format
- **Returns**: activity data for the range


{% endraw %}
