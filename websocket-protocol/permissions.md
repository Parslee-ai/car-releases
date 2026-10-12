{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### permissions

#### `permissions.status`
- **Params**: `{ domain: string, target_bundle_id?: string }`
- **Returns**: `{ domain, status, target_bundle_id }`. `status` is one of `granted` | `denied` | `not_determined` | `restricted` | `not_applicable` | `restart_required` | `signature_changed` | `unknown`. The `calendar` domain reports a real, non-prompting EventKit query (not a stub) and can additionally return `write_only` (macOS-14 write-only calendar grant). On macOS, the `automation` domain uses `target_bundle_id` for a non-prompting, target-specific Apple Events readiness check; omitting the target remains `not_determined` because Automation grants are per app.

#### `permissions.request`
- **Params**: `{ domain: string, target_bundle_id?: string }`
- **Returns**: request result (granted / denied / pending)

#### `permissions.explain`
- **Params**: `{ domain: string, target_bundle_id?: string }`
- **Returns**: human-readable explanation of what the permission grants

#### `permissions.domains`
- **Params**: `{}`
- **Returns**: `string[]` — all known permission domain names


{% endraw %}
