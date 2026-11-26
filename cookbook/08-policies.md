{% raw %}
# Policies: deny, gate, require state

Policies are runtime guardrails checked before each action a runtime executes (`car do`, daemon sessions and the bindings; see the README's Policies table for the surfaces that do not check them). Four built-in rules cover the common cases.

Those four are registered **by code** — your host calls `registerPolicy`. There is a second set, registered **from files**: TOML rules the project checks into `.car/policies/`, so an operator can govern their own project without touching host code. Both sets land on the same engine and are enforced identically. See [File-loaded rules](#file-loaded-rules-carpoliciestoml) below.

## `deny_tool` — block a tool entirely

```typescript
rt.registerPolicy('no_shell', 'deny_tool', 'shell');
```

Any action with `"tool": "shell"` is denied. Useful for sandboxing — register the agent without dangerous tools rather than relying on prompt-level pleading.

`deny_tool` is also the one rule kind the flagship assistant acts on when it builds the tool list it shows the model: a tool denied this way is **not advertised at all**, so `car do` does not spend a schema on it every request or a whole turn discovering it is forbidden. The tool stays registered with the validator, so a model that names it anyway is refused with "denied by project policy" rather than the misleading "unregistered tool". This applies to both registration routes above — the `registerPolicy` call here and the `deny_tool` list in a `.car/policies/*.toml` file.

Only `deny_tool` is withheld this way. The other rule kinds forbid particular *calls* rather than the tool, so their tool stays advertised and the offending call is refused at dispatch.

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

## `deny_connector` — block a whole remote MCP connector

```typescript
// Deny every tool of the connector whose slug is "github".
rt.registerPolicy('no_github', 'deny_connector', 'github');
```

Connector tools are named `mcp_<slug>_<tool>`, so one rule covers all of a connector's tools. There is no callback rule: `deny_tool_callback` is not accepted by any binding.

## File-loaded rules: `.car/policies/*.toml`

Everything above is registered by the host. This part is registered by a `.car` directory: every `*.toml` file in `.car/policies/` is read in sorted filename order, merged into one rule set, and lowered onto the same policy engine.

Field names must be exact. An unknown field is a load error that names the field, not a discarded value — a misspelling would otherwise leave the real field at its default and quietly change what the rule means. These files are security controls, so they fail loudly rather than plausibly.

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
| `car do` / the assistant | `.car/policies/*.toml` in the nearest `.car/` from the working directory up to the git repository root | rules that belong to one project. Commit them and the whole team gets the same guardrails |

> **`car do` looks from its working directory up to the repository root.** The working directory is `--dir` if you passed one, otherwise the directory you ran the command from. Run `car do` from a subdirectory and the repo-root `.car/policies/` still applies. Nothing above the repository root is read, and CAR's own `~/.car` is never read as a project. Outside a git repository only the working directory's own `.car/` applies.
>
> `.car/connectors.toml` has the same bound: the nearest team file up to the repository root, never the one in `~/.car`, and outside a repository only the working directory's own. [10 — The `.car` project directory](10-car-project-directory.md) describes the discovery rule in general.

A missing `policies/` directory is fine — most setups have none. A **malformed** file fails the session: the daemon refuses the connection, `car do` exits 2, and the error names the file. That is deliberate. A security rule that silently fails to parse is a control you believe you have and do not.

Seven rule kinds. Three of them (`deny_tool`, `deny_keyword`, `deny_tool_param`) are the file-authored form of prohibitions you already know; four (`allow_tool_param`, `deny_tool_param_matching`, `deny_stale_write`, `rate_limit_tool`) exist only here. A worked file:

```toml
# .car/policies/security.toml

# Never, under any parameters — and not advertised to the model at all.
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

## `deny_tool_param_matching` — block or require a content *shape*

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
reason  = "API keys never leave in a request body; send a key reference instead"

# The same matcher can enforce an open-ended allowlist. Docker removal is
# denied unless the governed name starts with the trusted project prefix.
[[deny_tool_param_matching]]
tool    = "docker.rm"
param   = "name"
matches = "^parslee-"
negate  = true
```

Three things to know:

- **The match is unanchored.** The pattern fires anywhere in the value. Anchor with `^` / `$` when you mean the whole value.
- **`negate = true` denies a mismatch.** It is the "unless" form: the Docker example denies `foo` and allows `parslee-x`. The field defaults to `false`, preserving the ordinary deny-on-match behavior.
- **An uncompilable pattern denies the tool.** A typo'd regex does not silently vanish — every call to that tool is refused until you fix it, with the compile error in the denial reason. It is compiled once when the rule set is applied, not once per action.

With the default `negate = false`, an absent parameter is not a violation — the rule only fires on what it can see. A negated rule fails closed: absence cannot prove the required pattern, so the tool call is denied. Use `allow_tool_param` instead when the safe values are finite and enumerable.

The violation reason names the tool and the parameter but never the matched text: the matched text is precisely the secret the rule exists to catch, and denial reasons go to the event log.

Give a rule an optional `reason` to tell the refused caller which rule fired and how to rewrite the call. It is appended verbatim to the refusal: `tool 'http_request' parameter 'body' matched a denied pattern: API keys never leave in a request body; send a key reference instead (deny_tool_param_matching in .car/policies/security.toml)`. That matters most in a file of several rules, where the file name alone does not say which one refused. The reason goes to the event log too, so write the explanation, never the secret. A rule without a `reason` refuses exactly as before.

A negated rule on a URL is a destination allowlist: an agent may sign up or post on its approved sites and nowhere else. End the host at `/` or the end of the value, so `docs.example.org.evil.net` is not taken for `docs.example.org`. A rule sees the call, not who made it. A per-class allowlist therefore needs each class of agent to load its own folder, and only the surfaces rooted in a project do that: `car do`, the coder and the Claude Code/Codex hook read that project's `.car/policies/`. They also apply `~/.car/policies/` first, and the rules from both folders must all pass, so an allowlist in `~/.car/policies/` also limits every project's agents. The daemon loads one folder, `~/.car/policies/`, for every session it serves, so there one allowlist binds every agent connected to it.

```toml
[[deny_tool_param_matching]]
tool    = "browser.navigate"
param   = "url"
matches = '^https://(docs\.example\.org|status\.example\.org)(/|$)'
negate  = true
```

## `deny_stale_write` — refuse a write over a file that changed since it was read

An agent that read a file, worked on it, then writes it back can overwrite an edit someone made in between. This rule refuses that write when the check sees it. The agent passes the sha256 of the file as it read it, and the call is denied when the file on disk no longer has that digest:

```toml
# .car/policies/files.toml
[[deny_stale_write]]
tool         = "write_file"
path_param   = "path"
digest_param = "base_sha256"
filesystem   = "host"         # required: the tool writes this host's files
```

| Situation | Result |
|-----------|--------|
| the file still has the digest the agent read (exact hex, either case) | allowed |
| the file doesn't exist yet, and its folder does | allowed: a new file can't be stale |
| the file changed since it was read | denied |
| the file exists and no digest was passed | denied |
| it isn't a regular file, is over 16 MiB, or can't be read | denied: its version is unknown |
| the call names no path, a relative one, or one with `..` | denied: the rule can't tell which file is meant |
| the file's folder doesn't exist on this host | denied: the file may exist where the tool writes |
| the path is a symlink to nothing | denied: the write goes wherever the link points |

**The digest must be a parameter of the governed tool.** The hook maps Claude Code's `Write` and `Edit` and Codex's `apply_patch` onto `file_path`, and none of them carries a digest. A rule on them refuses every write over an existing file. Govern a tool whose own schema takes the digest the agent read.

**The check runs before the tool writes, not with it.** A write that lands between the check and the tool's own write isn't caught. That includes two calls to the same path that both carry the old digest and run at once. Closing that window needs the tool itself to compare and swap.

Give the tool an absolute path with no `..`. The rule sees the call, not the folder the tool resolves a relative path against, and a writer that creates folders turns `missing/../isa.md` into an existing file.

**Only govern a tool that writes this host's files.** The rule reads the files of the host that runs the check, and it can't see which filesystem a tool writes. That's why `filesystem = "host"` is required, and a rule without it fails to load. A tool that writes a sandbox (`car do`'s container), a VM, a container or a remote MCP target must not be governed by `deny_stale_write`. A file there is invisible to the host, so a write to `/tmp/isa.md` in the VM would pass as a new file whenever the host has `/tmp` but no `isa.md`.

**A check on a tool's result belongs outside policy.** Every rule kind judges a tool **call** before it runs, from the call alone. None can see what the tool returns. Refusing a result that carries a secret back into an agent's context is the job of the code that produces or relays that result, such as the tool itself or a harness's post-call hook, not of a `.car/policies` rule.

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
