{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### automation

Bridges around the OS-shipped scripting layer. `run_applescript` and the `shortcuts.*` methods are macOS-only (Apple CLIs); `run_powershell` is the Windows analog. Each method errors with a PlatformUnsupported message on the platforms it doesn't target.

#### `automation.run_applescript`
- **Params**: `{ script: string, language?: "applescript" | "javascript", args?: string[], timeout_ms?: number }`
- **Returns**: `{ stdout: string, stderr: string, exit_code: number | null }`
- Wraps `osascript -l <lang> -` with the script piped to stdin. `args` are passed positionally to the script's `on run argv` (AppleScript) or `function run(argv)` (JXA). Subprocess exit codes other than 0 surface as JSON-RPC errors with the script's own stderr in the message. macOS-only.

#### `automation.run_powershell`
- **Params**: `{ script: string, timeout_ms?: number }`
- **Returns**: `{ stdout: string, stderr: string, exit_code: number | null }`
- The Windows analog of `run_applescript`. Runs the script through `powershell.exe` (Windows PowerShell 5.1, `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`, UTF-8 output) to drive the host desktop and its apps — toast notifications, clipboard, Explorer/COM automation (Office, browsers), UI Automation, window/process control. Distinct from the `shell` tool (which runs `cmd.exe` and can't reach the GUI/COM surface). Windows-only; errors PlatformUnsupported elsewhere. **High-risk** — gated by the approval gate like `run_applescript`.

#### `automation.shortcuts.list`
- **Params**: `{ folder?: string, with_identifiers?: boolean }`
- **Returns**: `[ { name, identifier, tool_slug, tool_description, parameters_schema }, ... ]`
- Enumerates Shortcuts.app entries. The list contains both user-authored workflows and AppShortcuts donated by apps via the App Intents framework — they look identical from the CLI. The `tool_*` fields are pre-shaped for registering each shortcut as a runtime tool through `tools.register_schema`. `folder` accepts the literal `"none"` to list shortcuts not in any folder.

#### `automation.shortcuts.run`
- **Params**: `{ name_or_id: string, input?: string, output_type?: string, timeout_ms?: number }`
- **Returns**: `{ stdout: string, stderr: string, exit_code: number | null }`
- Invokes a Shortcut. Prefer `name_or_id` as a UUID from `automation.shortcuts.list` since names can collide. `input` is staged through a tempfile and passed as Shortcut Input. `output_type` is a Uniform Type Identifier (e.g. `"public.plain-text"`); when omitted the shortcut decides.


{% endraw %}
