{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### notifications

#### `notifications.local`
- **Params**: `{ title: string, body: string, subtitle?: string, sound?: string }`
- **Returns**: `{ delivered: boolean, platform: string, backend: string }`
- Sends a user-visible local notification through the host platform when
  available. On macOS daemon builds this is a structured wrapper around the
  system notification Apple Event; on Windows a WinRT `ToastGeneric` toast
  (the AppUserModelId is registered in HKCU on first use so an unpackaged
  app's toasts appear). iOS notification delivery belongs to the signed host
  app, which uses `UserNotifications` directly.


{% endraw %}
