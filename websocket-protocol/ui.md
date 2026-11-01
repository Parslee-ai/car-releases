{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### ui

The dashboard is served on the daemon's dashboard port (the WebSocket port
plus one). A browser signs in to it once with a one-time link that `car ui`
prints and opens (`http://127.0.0.1:<dashboard port>/#login=<code>`); the
code lasts 10 minutes and works once. `car ui` gets the link from the daemon
over its host-authenticated connection (`ui.sign_in`), so the link names the
dashboard address the daemon actually serves, never a guessed port; the code
records that address, and a daemon refuses a code recorded for any other
dashboard address. The page then makes a browser key that
cannot be exported, and on later visits signs a fresh challenge with it, so it
stays signed in across daemon restarts until a sign-out or until the dashboard
port moves.

On macOS and Windows `car ui` opens the link in the browser. On Linux it only
prints it: a browser opener would carry the code in its command line, which
any user on the machine can read from `/proc`, and a process that read it
could redeem the single-use code first. macOS and Windows show a command line
only to its own user and to administrators, who can read the code file anyway;
the Mac is not a wall against the user's own processes.

The sign-in HTTP routes on the dashboard port (`POST /sign-in`,
`POST /sign-in/challenge`, `GET /ws`) answer only a loopback peer whose
request comes from the dashboard's own origin; anything else gets `403`.
When the request carries `Origin`, it must equal the request's own origin
exactly (`http://<Host>`, or `https://<Host>`), so a page on another loopback
port or on `localhost` is refused. When it carries no `Origin`,
`Sec-Fetch-Site` must be `same-origin` or `none`. No route ever returns the
daemon token or the host token.

- `POST /sign-in/challenge` (no body) → `{ nonce }`. The nonce is good for
  60 seconds and is accepted once.
- `POST /sign-in { login, public_key }` → `{ ticket, key }`: redeem a
  one-time code and register the browser's Ed25519 public key (raw,
  base64url). `key` is the key id, the lowercase hex SHA-256 of the raw key.
- `POST /sign-in { key, nonce, signature }` → `{ ticket }`: sign in again
  with a registered key. `signature` is Ed25519 over
  `"car-dashboard-sign-in-v1\n" + nonce`, base64url.
- `POST /sign-in {}` → `401` with a sentence saying to run `car ui`. On a
  daemon with auth disabled, every `POST /sign-in` answers
  `{ "ticket": null }`.
- `GET /ws` is the dashboard's own WebSocket. A ticket is redeemed there with
  `session.auth { browser_ticket }` (see [session](session.md#session)).

No HTTP route on any CAR port serves the daemon token or the host token.
The dashboard's old `GET /auth-token` route, which handed the daemon token
to a loopback page, was removed in front doors step 6c: on every CAR
listener, every `/auth-token` path now answers exactly what an unknown path
answers (`404` on the dashboard port), to every caller. A browser signs in with the one-time link above. A local program
reads the token from its `0600` file (`car_daemon_client::auth_token`), as
the FFI bindings do.

Every response carries `Content-Security-Policy: worker-src 'none'`.

#### `ui.sign_in`
- **Params**: `{}`
- **Returns**: `{ link: string, expires_in_secs: number }`
- Mints a one-time sign-in code for this daemon's own dashboard address and
  returns the link, `http://<dashboard address>/#login=<code>` (an unspecified
  bind address such as `0.0.0.0` is written as `127.0.0.1` on the same port).
  `expires_in_secs` is the code's lifetime, 600. The code is single use and is
  refused by any daemon whose dashboard address differs from the one recorded
  with it. On a daemon with auth disabled the link has no code
  (`http://<dashboard address>/`).
- **Authorization**: the host-management session only, as for `ui.sign_out`.
  A dashboard session cannot call it.
- Errors with `this daemon serves no dashboard sign-in` when the daemon
  started without one. `car ui` calls this method; with no daemon answering
  it mints nothing and says to start CAR.

#### `ui.sign_out`
- **Params**: `{}`
- **Returns**: `{ signed_out: true, generation: number }`
- Signs every browser out of the dashboard: deletes every registered browser
  key, every unredeemed one-time code and every unredeemed ticket, raises the
  sign-in generation, and closes every live dashboard session with close code
  `4005`. A second daemon on the same `CAR_HOME` adopts the new generation and
  closes its own dashboard sessions within about 5 seconds.
- **Authorization**: the host-management session (`session.auth { host_token }`)
  only, on a daemon that has a host token installed. A daemon with no host
  token (`--no-auth`, or an embedder that never installed one) still admits
  any session to the host-management methods, this one included, as it does
  today. A dashboard session cannot call it; it is not on the dashboard list.
- Errors with `this daemon serves no dashboard sign-in` when the daemon started
  without one. `car ui --sign-out` calls this method when a daemon answers and
  otherwise updates the sign-in files itself.

{% endraw %}
