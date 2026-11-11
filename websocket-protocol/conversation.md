{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### conversation

One durable floor for this daemon's local owner, shared with the iMessage
and Slack approval transports. Callers cannot choose a different owner or
recipient to evade arbitration. Questions wait by descending caller-supplied
`harm_rank`, FIFO for ties. The owner's subject change parks the current topic;
afterwards parked topics return in reverse interruption order. Emergencies
interrupt ordinary topics and start with `Emergency:`; another emergency waits
for the current emergency. A subject change during an emergency queues immediately after it, ahead of earlier parked work.

Deadlines are Unix milliseconds, checked before every transition and on the
enabled transport's polling tick. Expired topics never resume. The parsed
answer kind comes from a trusted host; CAR does not classify natural language.
An expired presented topic makes bare answers ambiguous only inside the explicit
30-second grace window after its deadline. An emergency interrupting a presented
topic starts the same grace window. The first ambiguous bare answer parks the
current topic and raises one clarification with a 60-second deadline; repeated
bare replies settle neither topic and do not extend that deadline. After the
clarification expires, the next topic takes the floor. A named answer to a live,
previously presented topic (including a parked topic) clears the grace window
and closes any live clarification. Answer records preserve raw text and attribution.

The phone accepts a topic code followed by its answer. Approval codes accept
`A0 approve` or `A0 deny`; general questions display a `Q0 <answer>` form and
accept free text. A bare plain-words answer applies to the current general
question. An unknown topic code followed by text settles nothing. A clarification accepts an explicit live topic code and answer;
an expired approval cannot authorize an action. Host clients can name a
non-approval topic with `answer.kind = "topic"` and `topic_id`.

New conversation questions use the configured, enabled, paired iMessage
transport. Slack keeps its existing approval buttons; general conversation
delivery on Slack is not implemented. Reservations are persisted before I/O. A known `sent:false` releases the
reservation and retries on the next tick. An unknown error or cancelled send
retains its reservation to avoid duplicates. `sent_channels` means reserved, not confirmed delivery.
Floor state is restored from the device-local sync oplog registry on daemon open,
including parked/waiting topics, reservations, approval rows and codes. This is
restart recovery for one device, not cross-device arbitration. Answers are inert data and
do not resolve approvals or grant permissions. Approval topics must use the
existing approval transport or `host.resolve_approval`.

Node and Python expose `conversationOpen` / `conversation_open` and the matching
`Emergency`, `Get`, `Answer`, `ChangeSubject`, and `List` suffixes. Every method
takes a JSON string and returns result JSON. Answer, change-subject, and list
live on `HostClient` and use host authority. Swift/Kotlin can use the generic daemon bridge. CLI view:
`car conversation --json` (host authority).

#### `conversation.open`
- **Params**: `{ id: string, question: string, harm_rank: number, deadline_ms: number }`.
- **Returns**: `{ topic_id: string, delivery_error: string | null }` after queuing. A null error does not establish delivery (the channel may be disabled). `id` is unique in this daemon's persisted floor, 1–200 bytes, excluding `approval:` and `__floor_` prefixes; question is 1–16384 bytes. Deadline must be future. At most 1024 retained topics and 1024 answers; capacity exhaustion refuses new work.
- Available to authenticated askers. The daemon derives the asker from the session principal. A waiting ask does not send a second question.

#### `conversation.emergency`
- **Params**: `{ id: string, question: string, harm_rank: number, deadline_ms: number }`.
- **Returns**: `{ topic_id: string, delivery_error: string | null }`.
- Same caller access and validation as open. The caller judges emergency status; abuse/ranking judgment is outside this mechanism.

#### `conversation.change_subject`
- **Params**: `{ id: string, question: string, harm_rank: number, deadline_ms: number }`.
- **Returns**: `{ topic_id: string, delivery_error: string | null }`.
- Host authority required. Parks the current ordinary topic and follows this one.

#### `conversation.answer`
- **Params**: `{ answer: { kind: "bare" } | { kind: "topic", topic_id: string }, raw_text: string }`.
- **Returns**: `{ answer: { raw_text: string, attribution: { kind: "topic", topic_id: string } | { kind: "clarify" } }, delivery_error: string | null }`.
- Host authority required. A bare answer requires a presented current topic; a named answer requires a live previously presented topic, including a parked topic. A plain-words answer to a new subject belongs to that subject. Empty/oversized text and attempts to answer approval topics are refused.

#### `conversation.list`
- **Params**: `{}`.
- **Returns**: `{ current: string | null, topics: { [id]: { id, question, asker, harm_rank, deadline_ms, kind, state, sent_channels, order, presented, presented_before_send } }, answers: [{raw_text, attribution}], parked: string[], stale_until_ms: number, approval_codes: object, approval_records: object, expired_approval_alerts: string[], assistant_agent_id?: string|null, refused_sends?: object[], withdrawals?: object[], approval_openers?: object, next: number }`. States are `waiting`, `open`, `parked`, `expired`, `settled`; kinds are `ask`, `emergency`, `clarification`.
- Host authority required; includes raw owner text.

#### `conversation.get`
- **Params**: `{ topic_id: string }`.
- **Returns**: `{ topic: object, answer: { raw_text, attribution } | null }` (topic shape above).
- Only the original asker principal or host may read a topic. A supervised agent principal survives its connection reconnect; an unbound client principal does not. Poll this method to resume an asker after settlement. Another asker's id receives the same refusal as an unknown id.

#### `conversation.assistant.bind`

- **Params**: `{ agent_id: string }`.
- **Returns**: `{ agent_id: string }` after durable persistence.
- Host-management authority only. Installation binds the owner's assistant by
  stable agent id, which must already be installed. `agents.install` can also
  bind it with the optional top-level `owner_assistant: true`.
  Unbound floors refuse submissions. Only that authenticated agent may open owner
  questions or send messages to the owner's handle. Plain sessions and CLIs
  cannot spoof it with a request field. Refused requests are recorded.

The additive floor fields `assistant_agent_id`, `refused_sends`, `withdrawals`,
and `approval_openers` default to null, empty arrays, and an empty map for old
records. `approval_openers` maps approval ids to the server-stamped opener
principal. A withdrawal row is `{id, reason, opener, at}`. Refusal rows carry
`method`, `agent_id`, `at`, `reason: "not_owner_assistant"`, and an optional
`approval_id` when a mirrored approval was refused. Times are Unix milliseconds.
These records share the existing durable floor journal.

{% endraw %}
