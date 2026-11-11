{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### accounts

#### `accounts.list`
- **Params**: `{}`
- **Returns**: `{ accounts: Account[] }`
- OS-native account discovery.

#### `accounts.open`
- **Params**: `{ account_id?: string }`
- **Returns**: settings/UI data for account configuration

#### `accounts.usage`
- **Params**: `{}`
- **Returns**: `{ accounts: SubscriptionAccount[], soonest_reset: number | null, anthropic_backoff_until: number, endpoint_status: string }`
- Operator-only: refused to supervised agents. Reads saved usage without making provider requests or reading secret values.
- Each account carries `label`, `vendor` (`anthropic` | `openai`), `endpoints` (`authorize_url`, `token_url`, `usage_url`), `benched`, `next_poll_at`, `next_refresh_at`, `needs_login`, `last_error` (a fixed error code or null), and `last_reading` (null before a successful read).
- A reading carries `observed_at`, `windows: [{ name, used_percent, headroom, resets_at: number | null }]`, `used_percent` (the maximum across windows), and `headroom` (`100 - used_percent`). All reported quota windows are retained, including Anthropic five-hour/session limits. Unknown vendor window names receive generated labels. Anthropic numeric-string percentages and millisecond reset epochs are normalized; returned times are Unix seconds.
- `binding_window` names the most-used window; `reset` is that window's own reset, or null when unknown. Ties use the first parsed window. `soonest_reset` is separately the minimum future known reset across all windows; `soonest_reset_window` names that window, or null when no future reset is known. For example, a primary window at 10% resetting in one hour and a secondary at 100% resetting in four days reports `used_percent: 100`, `binding_window: "secondary_window"`, and the four-day `reset`, while `soonest_reset_window: "primary_window"` labels the one-hour `soonest_reset`. The top-level `soonest_reset` takes the minimum future **binding-window** reset across unbenched accounts. Readings retain their observation time after failures; they are not a claim of current availability. New reset-label fields on older saved readings are null until the next successful poll.
- The daemon polls each configured account every 300 seconds (10-second scheduler resolution). Bench excludes an account from the future seat pool and the aggregate soonest reset, while sensing continues. Refresh is checked independently with up to 300 seconds of lead time and one account lock covering refresh and publication. Short-lived tokens refresh halfway through their remaining lifetime.
- One Anthropic usage, refresh, or interactive-login token exchange returning 429 pauses all Anthropic usage requests, refreshes, and login token exchanges until the shared persisted backoff ends. Retry-After seconds or an HTTP date are honored; an absent/invalid value pauses for one hour. OpenAI remains independent. Before each Anthropic request, a conservative one-hour pause is saved; normal completion clears it, and 429 replaces it with Retry-After. A crash or publication failure during a request therefore retains a pause.
- Before a refresh that may rotate its token, CAR durably sets `needs_login: true`; it clears the flag only after saving the replacement grant and refresh schedule (or receiving a token-endpoint failure). A failed replacement save reports `refresh_grant_not_stored_login_required`. While `needs_login` is true, polling and refresh stop across restarts, so the old token is never silently retried. Complete `car accounts login <label> --vendor anthropic|openai` again to recover.
- CAR stores grants through its existing secret store under CAR-owned refs scoped to the state root. Public state is under `<CAR_HOME>/subscriptions/usage.json`. No Throttle or vendor CLI credentials/cache are read. Use `car accounts login <label> --vendor anthropic|openai` to obtain each grant directly.
- Generic secret methods refuse the `CAR_SUBSCRIPTION_` namespace, including chunk records. Agent file tools and child sandboxes protect the subscription directory because changing an endpoint could redirect an OAuth bearer.
- **UNPROVEN defaults**: Anthropic `https://api.anthropic.com/api/oauth/usage?at_wall=1&skip_spend=1&cedar_ember=1`; OpenAI `https://chatgpt.com/backend-api/wham/usage`. These match reference source, but have not been validated with CAR-owned grants. `car accounts login ... --usage-url URL` configures the endpoint explicitly; the account returns that configuration. Endpoints require HTTPS, except HTTP loopback for tests. Redirects are refused.

#### `accounts.bench`
- **Params**: `{ label: string, benched: boolean }`
- **Returns**: the same snapshot as `accounts.usage`, after durable publication.
- Operator-only. Unknown labels fail. `benched: false` makes usage immediately due and restores the account to the aggregate reset calculation. CLI: `car accounts bench <label>` / `car accounts unbench <label>`. No token is accepted or returned.

{% endraw %}
