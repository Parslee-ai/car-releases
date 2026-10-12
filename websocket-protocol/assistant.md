{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### assistant

The name the flagship assistant answers to — in its own system prompt, in every
host's addressing copy, and as its voice wake word — plus the user profile that
makes a first conversation personal. One record (`~/.car/identity.json`, via
the `car-identity` crate) feeds the prompt, addressing surfaces, and memory.

Not to be confused with `assistants.invoke` (invoking a *named assistant*) or
with `session.identity` (which identifies the connected *client*).

#### `assistant.identity.get`
- **Params**: `{}`
- **Returns**: `{ name, spellings: string[], aliases: string[], user_name: string | null, role: string | null, focus_areas: ("calendar" | "email" | "files" | "browser" | "research" | "writing" | "other")[], apps: string[], brand, updated_at_unix }`
- `aliases` is derived, not stored: the name and its alternate spellings crossed
  with `hey`/`hi`/`ok`/`okay`, longest first. Hosts match wake phrases against it
  **locally** (their matcher has to work before the daemon answers), and deriving
  it in one place is what keeps Swift, Kotlin, and Rust from drifting into three
  different wake sets.
- `spellings` are the ways speech-to-text is likely to mangle the name
  (`jervis` for `Jarvis`). The shipped default carries `parsley` for `Parslee`,
  which is the existing proof that one spelling never survives STT.
- `brand` is the fixed product name (`Parslee Core`) and never changes. The
  chosen name is a nickname layered on top: store copy uses `brand`, addressing
  copy uses `name`.
- **Ungated**, unlike the neighbouring `openrouter.status`. A name is not a
  credential — it is what every connected surface must render to address the
  assistant at all, and mobile hosts reach the daemon without approval
  authority. It also ships in the `server.handshake` reply, so gating the RPC
  would protect nothing while breaking mobile.
- A malformed `identity.json` is an **error**, not a silent fall back to the
  default name. This is the surface a user checks when the assistant stopped
  answering to the name they set, and "everything is fine, it's called Parslee"
  is the least useful possible answer.

#### `assistant.identity.set`
- **Params**: `{ name?: string, spellings?: string[], user_name?: string | null, role?: string | null, focus_areas?: ("calendar" | "email" | "files" | "browser" | "research" | "writing" | "other")[] | null, apps?: string[] | null }`
- **Returns**: the updated identity, same shape as `assistant.identity.get`
- Read-modify-write: every field is optional and unset fields are preserved, so
  a host that only knows about the name cannot wipe spellings or profile fields
  another surface wrote. Pass `null` to clear `user_name`, `role`,
  `focus_areas`, or `apps`; an empty array also clears an array field.
- The built-in assistant renders non-empty profile fields in an **About the
  person** prompt block. The daemon also upserts the profile into a
  `MemKind::Identity` node so memory recall sees it. That node is deliberately
  omitted from generic memory snapshots and rebuilt from `identity.json` when
  an engine starts, avoiding two durable copies of the profile.
- `name` is validated: 1–32 characters, at least one letter or digit, and not a
  conversational role (`system`, `user`, `assistant`, …).
- **Host/local-auth gated** (`require_approval_authority`), the same trust root
  as `auth.*` / `openrouter.*` / `messaging.*`. A rename repoints the voice wake
  word; an ungated write would let any authenticated local connection make the
  assistant stop answering to the name its user knows.
- Broadcasts `host.event { kind: "assistant.identity.changed", payload: <identity> }`
  so a live rename reaches open sessions without a reconnect.

The assistant can also rename itself through the gated `set_assistant_name`
tool, which is what makes "call yourself Friday" work hands-free. That tool is
routed through human approval on **every** session including `--full-access`
ones — unlike the tier-gated write tools, the risk there is not what the session
may do but where the instruction came from, since a rename can arrive inside a
fetched page, a file, or a recalled memory.


{% endraw %}
