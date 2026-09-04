{% raw %}
# Policies: deny, gate, require state

Policies are runtime guardrails that run on every action before execution. Four built-in rules cover the common cases without writing a custom callback.

Those four are registered **by code** — your host calls `registerPolicy`. There is a second set, registered **from files**: TOML rules the project checks into `.car/policies/`, so an operator can govern their own project without touching host code. Both sets land on the same engine and are enforced identically. See [File-loaded rules](#file-loaded-rules-carpoliciestoml) below.

## `deny_tool` — block a tool entirely

```typescript
rt.registerPolicy('no_shell', 'deny_tool', 'shell');
```

Any action with `"tool": "shell"` is denied. Useful for sandboxing — register the agent without dangerous tools rather than relying on prompt-level pleading.

## `deny_tool_param` — block a tool when a parameter matches

The most common policy. Substring-match on a stringified parameter value:

```typescript
rt.registerPolicy('no_rm_rf', 'deny_tool_param', 'shell', 'command', 'rm -rf');
rt.registerPolicy('no_drop_table', 'deny_tool_param', 'sql', 'query', 'DROP TABLE');
rt.registerPolicy('no_force_push', 'deny_tool_param', 'shell', 'command', 'git push --force');
```

Args: `name`, `'deny_tool_param'`, `target` (tool name), `key` (param name), `pattern` (substring).

## `require_state` — gate on runtime state

Block an action unless a state key has the required value. Use for ordering or feature flags:

```typescript
rt.registerPolicy(
  'tests_must_pass',
  'require_state',
  null,         // target: not used
  'tests_passed',
  null,         // pattern: not used
  'true',       // value_json: required value, JSON-encoded
);

// Now any action will be denied unless state['tests_passed'] === true.
rt.stateSet('tests_passed', JSON.stringify(true));
```

This is how you enforce DAG ordering at the policy level rather than relying on every model to remember it.

## `deny_tool_callback` (NAPI only) — custom JS gate

For complex predicates, store a JS callback and reference it by tool:

```typescript
import { registerAgentRunner } from 'car-runtime';

// The agent runner doubles as the policy callback host.
registerAgentRunner(async (specJson, task) => { /* ... */ });

rt.registerPolicy('audit_payment', 'deny_tool_callback', 'payment');
```

The callback receives the tool name and params and must return truthy to deny. Synchronous evaluation on the action hot path — keep it fast.

## File-loaded rules: `.car/policies/*.toml`

Everything above is registered by the host. This part is registered by a `.car` directory: every `*.toml` file in `.car/policies/` is read in sorted filename order, merged into one rule set, and lowered onto the same policy engine.

```
.car/
  policies/
    security.toml
    messaging.toml
```

**Put the file in the right `.car`.** Two loaders exist and they read different directories:

| Loader | Directory | Use it for |
|--------|-----------|------------|
| The daemon (`car-server`), per session | `~/.car/policies/*.toml` | rules that hold for everything you run on this machine. The daemon serves whatever project a client is in, so it cannot have per-project rules |
| `car do` / the assistant | `<working directory>/.car/policies/*.toml` | rules that belong to one project. Commit them and the whole team gets the same guardrails |

> ⚠️ **`car do` looks in its working directory only — there is no walk-up.** The working directory is `--dir` if you passed one, otherwise the directory you ran the command from. Run `car do` from a subdirectory and the repo-root `.car/policies/` is **not** loaded: no warning, no error, the rules simply do not apply. This fails open, so it is worth being deliberate — run from the project root, or pass `--dir <project root>`.
>
> Note the inconsistency, because you have been told the opposite elsewhere: `.car/connectors.toml` *does* walk up from cwd, and [10 — The `.car` project directory](10-car-project-directory.md) describes `.car/` discovery in general as walking up. Policies are the exception.

A missing `policies/` directory is fine — most setups have none. A **malformed** file fails the session: the daemon refuses the connection, `car do` exits 2, and the error names the file. That is deliberate. A security rule that silently fails to parse is a control you believe you have and do not.

Six rule kinds. Three of them (`deny_tool`, `deny_keyword`, `deny_tool_param`) are the file-authored form of prohibitions you already know; three (`allow_tool_param`, `deny_tool_param_matching`, `rate_limit_tool`) exist only here. A worked file:

```toml
# .car/policies/security.toml

# Never, under any parameters.
deny_tool = ["deploy"]

# Never, in any parameter of any tool.
deny_keyword = ["DROP TABLE", "rm -rf /"]

# Never, when this parameter looks like this.
[[deny_tool_param]]
tool     = "http_request"
param    = "url"
contains = "169.254.169.254"
```

## `allow_tool_param` — only these values, nothing else

The one allowlist in the format, and the natural rule for a side effect whose safe set is small and enumerable. An outbound-messaging allowlist is the motivating case: an agent may text the on-call rotation and nobody else.

```toml
# .car/policies/messaging.toml

# Only these channels are reachable at all.
[[allow_tool_param]]
tool  = "messaging.send"
param = "channel"
allow = ["imessage"]

# ...and only these recipients on them.
[[allow_tool_param]]
tool  = "messaging.send"
param = "to"
allow = ["+15550100", "oncall@example.invalid"]
```

It fails closed in all three directions, which is the whole point of a whitelist:

| Situation | Result |
|-----------|--------|
| parameter absent from the call | denied — nothing proves the call is permitted |
| `allow` is empty | denied — every call to that tool |
| value present but unlisted | denied |

Comparison is exact and case-sensitive, and a rule governs exactly one tool — actions for any other tool are untouched.

## `deny_tool_param_matching` — block a content *shape*

`deny_tool_param` needs a fixed substring. Credentials, account numbers and address families do not have one — they have a shape. This rule takes a regex over a single parameter:

```toml
# .car/policies/security.toml

# An obviously synthetic credential shape — write your own to match the
# secrets your organization actually issues.
[[deny_tool_param_matching]]
tool    = "messaging.send"
param   = "body"
matches = "(?i)demo-token-[A-Za-z0-9]{16,}"

[[deny_tool_param_matching]]
tool    = "http_request"
param   = "body"
matches = "sk-[A-Za-z0-9]{20,}"
```

Two things to know:

- **The match is unanchored.** The pattern fires anywhere in the value. Anchor with `^` / `$` when you mean the whole value.
- **An uncompilable pattern denies the tool.** A typo'd regex does not silently vanish — every call to that tool is refused until you fix it, with the compile error in the denial reason. It is compiled once when the rule set is applied, not once per action.

An absent parameter is not a violation — this is a deny rule and only fires on what it can see. Use `allow_tool_param` when absence itself must be refused.

The violation reason names the tool and the parameter but never the matched text: the matched text is precisely the secret the rule exists to catch, and denial reasons go to the event log.

## `rate_limit_tool` — cap the volume, not the call

Some harms are not in any single call — they are in a thousand of them. An hourly cap on messaging a human is the clearest case: no individual text is wrong, but a looping agent paging someone forty times is.

```toml
# .car/policies/messaging.toml

[[rate_limit_tool]]
tool          = "messaging.send"
max_calls     = 5
interval_secs = 3600.0

[[rate_limit_tool]]
tool          = "http_request"
max_calls     = 10
interval_secs = 60.0
```

A sliding window: the call is denied when admitting it would make it the `max_calls + 1`-th call within the trailing `interval_secs`. `max_calls = 0` denies every call.

Two properties, both deliberate:

- **Budget is consumed at admission, not at delivery.** A call that is admitted and later fails at dispatch still occupies its slot. The cap bounds *attempts*, not confirmed successes — the conservative direction for a rule whose job is to bound blast radius.
- **Only a call denied *by this rule* consumes no budget.** Being refused for being over the cap does not push the window further out, so a caller retrying into a full window is admitted again as soon as the oldest admitted call ages out. A call refused by a *different* rule — an allowlist, a content regex — is **not** free: the engine collects every violation rather than stopping at the first, so this rule's window already took the slot before the other refusal was reported. Size the cap against total attempts, including the ones you expect other rules to block.

The window is per rule and per policy engine, starts empty, and does not survive a restart. **On the daemon that means per WebSocket connection, not per machine** — each accepted connection builds its own runtime and engine, so two agents connected at once each get a full budget and a reconnect starts a fresh window. Size the cap for one agent-session's blast radius rather than as a machine-wide quota. (Under `car do`, one runtime is built per run, so the window is the run.) This is also distinct from the per-tool rate limit a `ToolSchema` can declare — that one is the tool's own backstop; this one is the operator's.

## Inspecting violations

When a policy denies an action, the result includes the violation:

```jsonc
{
  "policy_name": "no_rm_rf",
  "action_id": "a3",
  "reason": "param 'command' matches denied pattern 'rm -rf'"
}
```

The proposal then proceeds per the action's `failure_behavior`:

| `failure_behavior` | What happens after a policy denial |
|--------------------|------------------------------------|
| `"abort"` (default) | proposal halts, downstream actions don't run |
| `"skip"` | this action is skipped, rest continues |
| `"retry"` | treated as `"abort"` — no point retrying a denied action |

## Verifying policies before running

`verify` runs policies as part of static checking. If any action would be denied, `verify` returns issues — you can catch policy problems without ever calling a tool:

```typescript
const result = JSON.parse(await rt.verifyProposal(proposalJson));
if (!result.valid) {
  console.log('blocked by policies:', result.issues);
}
```

## Inspector chain (advanced, hot-path)

For dispatch-time gates — egress filtering, repetition detection, adversary review — `car-policy::inspectors::InspectorChain` evaluates `(tool_name, params)` short-circuit on first deny. Use this for guardrails that need to evaluate every actual tool call (not just every action). Wired via Rust today; FFI exposure is in flight.

## Policy patterns that show up a lot

```typescript
// Egress: only allow HTTP to specific hosts.
rt.registerPolicy('http_egress', 'deny_tool_param', 'http', 'url', 'http://localhost');
// (more usefully via the InspectorChain)

// Read-only mode for review agents.
rt.registerPolicy('no_writes', 'deny_tool', 'shell');
rt.registerPolicy('no_writes_2', 'deny_tool', 'write_file');
rt.registerPolicy('no_writes_3', 'deny_tool', 'edit_file');

// Approval-gated production deploys.
rt.registerPolicy('prod_approved', 'require_state', null, 'prod_approval', null, 'true');
```

{% endraw %}
