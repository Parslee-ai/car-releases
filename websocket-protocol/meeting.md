{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### meeting

The meeting surface is built on `car-voice` and persists transcripts/summaries under `.car/meetings/<id>/`. See [`car-rs/examples/meetily-clone/`](../../car-rs/examples/meetily-clone/) for a working consumer.

#### `meeting.start`
- **Params**: `{ id?: string, audio_source: object, ... }` — `id` auto-generated if omitted
- **Returns**: `{ id: string, started_at: string, ... }`
- Pushes `voice.event` notifications back to the client. Transcript segments also flow into `car-memgine` automatically as Conversation nodes.

#### `meeting.stop`
- **Params**: `{ meeting_id: string, summarize?: boolean = true }`
- **Returns**: `{ summary, transcript, ... }`

#### `meeting.list`
- **Params**: `{ root?: string }` — defaults to current working directory
- **Returns**: `{ meetings: MeetingMetadata[] }`

#### `meeting.get`
- **Params**: `{ meeting_id: string, root?: string }`
- **Returns**: full meeting record


{% endraw %}
