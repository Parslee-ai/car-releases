{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### calendar

#### `calendar.list`
- **Params**: `{}`
- **Returns**: `{ calendars: Calendar[] }`

#### `calendar.create_event`
- **Params**: `{ calendar_id, title, start, end, all_day?, notes?, location?, url? }` — `start`/`end` are RFC3339.
- **Approval**: required by the default high-risk WS gate.
- **Returns**: `{ ok: bool, event?: Event, reason?: string }` — on success `event` carries the host-assigned id, calendar metadata, and the round-trip times.
- Calendar must be writable; if it isn't, `ok: false` with `reason: "calendar_is_read_only"`. Permission failures surface as `unavailable` errors at the request layer (same as `calendar.list`/`events`).

#### `calendar.update_event`
- **Params**: `{ event_id, title?, start?, end?, all_day?, notes?, location?, url? }` — any absent field leaves the existing value alone. Empty-string for `notes`/`location`/`url` *clears* that field; `null` is treated the same as absent.
- **Approval**: required by the default high-risk WS gate.
- **Returns**: `{ ok: bool, event?: Event, reason?: string }` with the round-tripped event on success.

#### `calendar.delete_event`
- **Params**: `{ event_id: string }`
- **Approval**: required by the default high-risk WS gate.
- **Returns**: `{ ok: bool, reason?: string }`

#### `calendar.events`
- **Params**: `{ start: string (RFC3339), end: string (RFC3339), calendar_ids?: string[] }`
- **Returns**: `{ events: CalendarEvent[] }`. Each event carries `status` (`confirmed` | `tentative` | `canceled` | `none`, from `EKEvent.status`) and `attendees` as objects — `{ name?, email?, status?, role?, is_current_user }` where `status` is `accepted` | `declined` | `tentative` | `pending` | `delegated` | `completed` | `in_process` | `unknown` (`EKParticipant.participantStatus`) and `role` is `required` | `optional` | `chair` | `non_participant` | `unknown` — so a consumer can distinguish a firm commitment from a tentative RSVP.


{% endraw %}
