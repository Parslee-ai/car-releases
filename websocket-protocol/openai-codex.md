{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### openai_codex

The `openai_codex.*` namespace is CAR's own ChatGPT sign-in for the
`openai-codex` provider, the one `car auth login --provider openai-codex` runs
in a terminal, driven by a host instead (car#2372). It needs no Codex install.
A host opens the URL `openai_codex.auth_start` returns in the user's browser
and polls `openai_codex.status`; the daemon owns the PKCE verifier, the
loopback callback, the code exchange and the keychain write, and stores the
same credential the CLI stores. Once it is stored, the `openai-codex/*` models
in `models.list_unified` report `available: true`.

**All four methods require the host-management role** (`session.auth {
host_token }`), the same trust root as `openrouter.*`: signing the user out,
starting a sign-in that replaces theirs, or reading which account is signed in
is not another client's business. As with the other host-gated surfaces, the
gate is a no-op when the daemon runs with no host token configured.

No result carries a token or the ChatGPT account id.

Every read, write and delete of the stored credential (Verify, the save at
the end of a sign-in, sign-out) runs on the blocking pool with no daemon lock
held, ordered among themselves by an async lock. A Keychain prompt can make
one of them wait, but plain `openai_codex.status` never waits on them.

The callback port is fixed at `127.0.0.1:1455`, because OpenAI registered
`http://localhost:1455/auth/callback` for this client, and the Codex CLI's own
sign-in uses the same port. While another program holds it, `auth_start` fails
at once with `Codex's sign-in is open. Finish or close it, then try again.`
and nothing is left pending. While `car auth login --provider openai-codex`
is running, it fails with `A ChatGPT sign-in is already running in Terminal.
Finish or close it, then try again.` (both share one cross-process login lock).
If accepting connections on the callback port keeps failing (for example the
daemon is out of file handles), the attempt backs off (100 ms doubling to 1 s)
and after six failures in a row ends as `failed`.
Requests to any other path on the callback port, such as Codex's own `/cancel`
probe, get a 404 and the wait continues; a callback that does not carry this
attempt's `state` gets a 400 and the wait continues too, so an old browser tab
or another local program cannot end the sign-in.

#### `openai_codex.status`
- **Params**: `{ verify?: boolean }`
- **Reads no credential by default.** Without `verify` the answer comes from
  what this daemon last learned (a Verify, a sign-in it completed, a
  sign-out) and the catalog's sign-in hint, so a host may call it on every
  screen open and return without any secret-store access or prompt
  ([demand-driven Keychain access](../solutions/demand-driven-keychain-access.md)).
  `verify: true` reads the stored credential once; send it only when the
  person asks (a Verify button).
- **Returns**: `{ state, account_email, pending, last_result, message }`
  - `state`: `not_checked` | `signed_out` | `in_progress` | `signed_in` |
    `error`. `not_checked` until the daemon has learned anything (offer
    Verify); `in_progress` while a sign-in started here waits for the browser;
    `error` when a Verify could not read the stored sign-in (for example a
    locked keychain), explained in `message`. A sign-in OpenAI revoked reads
    `signed_out` with a `message` asking the user to sign in again.
  - `account_email`: the signed-in account's email when `state` is
    `signed_in` and the token names one, else `null` (also while a new
    sign-in is in progress, since it may replace that account).
  - `pending`: `{ flow_id, deadline_unix_ms }` or `null`.
  - `last_result`: `{ flow_id, kind, message }` for the most recent attempt,
    or `null`. `kind` is `signed_in`, `cancelled` (in CAR or in the browser),
    `timed_out` (15 minutes) or `failed`; `message` is written for the user.
- A Verify also refreshes the catalog's sign-in hint, so the
  `openai-codex/*` rows follow what it found.
- Only a successful Verify or a sign-in completed here makes the status
  `signed_in`. What was learned stands otherwise: a presence-only signal
  (such as an explicit model list checking that a credential exists) or a
  request that used the sign-in never turns `signed_out` (including "sign in
  again") or `not_checked` into `signed_in`. Presence may only move a learned
  `signed_in` to `signed_out` when the credential is found gone. A sign-in
  that stops working is shown by the next Verify.

#### `openai_codex.auth_start`
- **Params**: `{}`
- **Returns**: `{ authorize_url, flow_id, deadline_unix_ms }`. Open
  `authorize_url` in the browser. While a sign-in is already waiting, returns
  that same attempt again rather than starting a second one.
- **Errors**: the two plain messages above when the port or the login lock is
  taken; any other failure to listen on the port.

#### `openai_codex.auth_cancel`
- **Params**: `{ flow_id?: string }`
- **Returns**: status, as `openai_codex.status`. Ends the waiting sign-in and
  frees the port. A `flow_id` naming another attempt is a no-op, so a late
  cancel cannot end a newer one.

#### `openai_codex.sign_out`
- **Params**: `{}`
- **Returns**: status. Ends any waiting sign-in and deletes the stored ChatGPT
  sign-in, after any token refresh already in flight finishes (so that refresh
  cannot save the sign-in back). The Parslee sign-in and any `OPENAI_API_KEY`
  are unchanged.
- **Errors**: `A ChatGPT sign-in is already running in Terminal. Finish or
  close it, then try again.` while `car auth login --provider openai-codex`
  holds the login lock, because that sign-in would save after the sign-out.
  `CAR is still finishing the ChatGPT sign-in. Try signing out again in a
  moment.` when a sign-in this daemon is finishing hasn't let go in time
  (sign-out waits up to 30 s once its save has begun, 2 s otherwise).

{% endraw %}
