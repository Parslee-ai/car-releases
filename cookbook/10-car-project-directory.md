# `.car/` project directory

`.car/` is the team-shareable knowledge layer for a project. Checked into git. Auto-discovered by walking up from `cwd`. Where rubrics, policies, identity, and project-scoped facts live.

## Initialize

```bash
cd /path/to/your/project
car init
```

This scaffolds:

```
.car/
  config.toml          # speech policy, model preferences, feature flags
  identity.md          # who the agent is when working in this project
  constraints.md       # hard rules (no eval, no force push, no rm -rf in prod)
  facts/               # project-scoped pattern facts
    architecture.md
    conventions.md
  skills/              # learned procedures
  rubrics/             # evaluation specs (used by car-bench, car-verify rubrics)
  meetings/            # populated by car-meeting (gitignored by default)
```

One directory `car init` does **not** create, because most projects have none — create it yourself when you want one:

```
.car/
  policies/            # *.toml guardrails the runtime enforces on every action
    security.toml      #   deny_tool / deny_keyword / deny_tool_param / …
    messaging.toml     #   allow_tool_param / deny_tool_param_matching / rate_limit_tool
```

Every `*.toml` in `.car/policies/` is read in sorted filename order and merged into one rule set, so split them by concern however you like. A missing directory is fine; a malformed file fails the session rather than being silently skipped.

One wrinkle worth knowing before you put a file here: `car do` loads the **project's** `<root>/.car/policies/`, but the **daemon** loads `~/.car/policies/` — it serves whatever project a client happens to be in, so its rule set is the operator's, not any one project's. Rules you want enforced on daemon-backed sessions go in your home `.car`. Full rule reference: [Policies](08-policies.md#file-loaded-rules-carpoliciestoml).

## How discovery works

When you instantiate a runtime, CAR walks up from `cwd` looking for an existing `.car/` directory. The first one found wins — same convention as `.git/`. This means:

- a runtime instantiated in any subdirectory of your project picks up the project's `.car/`
- a runtime instantiated outside the project falls back to `~/.car/`
- you can override explicitly via `MeetingOptions::root` and similar config knobs

## What goes in vs. out

**In `.car/` (commit to git):**

- `identity.md` — agent persona / authority level for this project
- `constraints.md` — hard rules everyone on the team should follow
- `policies/*.toml` — guardrails the runtime *enforces*, as opposed to `constraints.md`, which the agent merely reads
- `facts/*.md` — durable project knowledge (architecture, conventions, decisions)
- `skills/*.json` — learned procedures the team should share
- `rubrics/*.toml` — eval specs for `car-bench` task definitions
- `config.toml` — speech policy, model preferences, feature flags

**Not in `.car/` (gitignore):**

- `meetings/` — meeting transcripts may be sensitive
- per-user runtime state (`*.runtime.json`)
- model caches

A reasonable `.gitignore` inside `.car/`:

```gitignore
meetings/
*.runtime.json
```

## Config

`.car/config.toml`:

```toml
# Speech policy (see car-voice).
speech_prefer_local = true
speech_allow_remote_fallback = true
speech_preferred_local_stt = "Parakeet-TDT-0.6B-v3-MLX"
speech_preferred_local_tts = "Qwen3-TTS-12Hz-1.7B-Base-5bit"

# Model preferences for this project.
preferred_planning_model = "claude-opus-4-7"
preferred_routine_model = "claude-haiku-4-5"

# Skill-optimization model (SkillOpt's optimizer_model). Routes the
# distill / evolve / repair inference for the skill validation gate through a
# stronger model than the runtime default. Omit to use default routing.
optimizer_model = "claude-opus-4-8"

# Utility-aware retrieval (U-Mem). When utility_weight > 0, fact retrieval
# blends each fact's learned utility posterior (an upper-confidence bound) on
# top of semantic relevance — proven facts are exploited, cold-start facts get
# an explore bonus. 0 (default) keeps pure-relevance ordering. The daemon seeds
# its shared and per-agent engines from these at boot, so it's the persistent,
# team-shareable enable path (vs. the per-session `memory.utility_set` runtime
# override). utility_weight is clamped to [0,1], utility_exploration to [0,4].
# The daemon finds this file from $CAR_PROJECT_DIR (else its cwd) — set
# CAR_PROJECT_DIR when launching car-server outside the project tree (e.g. the
# macOS host app) so these overrides are picked up.
utility_weight = 0.3
utility_exploration = 1.4

# Feature flags.
allow_browser_automation = true
allow_shell_tool = false
```

## Identity and constraints as graph nodes

When CAR boots in a project, it ingests `identity.md` and `constraints.md` into the memgine graph:

- `identity.md` becomes the Identity layer of every `buildContext()`
- each entry in `constraints.md` becomes a `kind: "constraint"` fact in the Constraints layer
- entries in `facts/*.md` become `kind: "pattern"` facts

You can write these as plain markdown — CAR parses headings as fact subjects and bodies as fact bodies. No special syntax beyond standard markdown.

## Skills checked into git

Skills under `.car/skills/` are loaded on boot. To share a skill the team should use:

```bash
# After ingesting a skill that worked, dump it:
echo '{
  "name": "deploy-staging",
  "code": "pnpm build && pnpm deploy --env staging",
  "platform": "node",
  "trigger": {"persona": "engineer", "url_pattern": "", "task_keywords": ["deploy", "staging"]},
  "description": "Deploy current branch to staging"
}' > .car/skills/deploy-staging.json
```

Commit it. Now everyone on the team gets the skill on next runtime boot.

## When NOT to use `.car/`

- if the knowledge is per-user, not per-project — use `~/.car/` instead
- for transient runtime state — use `state_set` / `state_get`
- for credentials / API keys — use `car-secrets` (OS keychain) and `~/.car/env`

The split is the same as `.git/` (project) vs `~/.gitconfig` (user) — knowledge that's about *the project* belongs in `.car/`, knowledge that's about *the user* belongs in `~/.car/`.
