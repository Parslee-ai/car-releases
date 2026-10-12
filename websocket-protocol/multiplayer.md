{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### multiplayer

Multiplayer development: a **work item** moves Build → Improve → Polish through
**different developers**, each stage an ordinary `coder.*` session on its
owner's own machine with the engine they chose (CAR native, Claude Code, Codex,
Gemini, Foreman). Design and rationale: `docs/proposals/multiplayer-development.md`.

What travels between stages is a git commit and a small record, nothing else.
The record is committed at `.car/multiplayer/<id>.json` on the branch
`car/mp/<id>` in the team's shared remote. It has no free-text field except the
intent fixed at Build and rejects unknown fields, so a hand-off cannot carry the
previous owner's reasoning. Stage sessions never run on anyone else's machine
and never spend anyone else's coding-CLI seat; this namespace coordinates, it
does not dispatch.

**Eligibility is advisory.** A stage is attributed to the caller's signed-in
Parslee account (`auth.snapshot`'s `active_account_id`), written into a git
file anyone with push access could edit. The rules catch honest mistakes;
unforgeable ownership needs server-attested stage receipts (proposal slice 5).
Every `multiplayer.*` method is operator-only: a session bound to an agent id is
refused (even `list`/`get` fetch into the repository the caller names, which
runs that repository's git config and hooks). Network git runs with
`GIT_TERMINAL_PROMPT=0`, so a remote needing interactive credentials fails
instead of hanging the daemon.

**Running other developers' checks.** `submit_stage` and `merge_check` run a
contract other people wrote, on this machine. They run it the way the model's
own shell runs: **without inherited environment credentials** (reading the operator's files or other processes is a known open gap, tracked separately). CAR removes the forge tokens,
neutralizes git/gh/ssh credential helpers, scrubs inherited credential-shaped
environment names, and applies the inspector chain that refuses
credential-shaped commands whatever `allow_credentials` says. Ordinary
environment such as PATH, HOME, locale, terminal, shell, temporary-directory,
and toolchain variables remains inherited.

Typical flow: Build runs `coder.start` → `coder.confirm_contract` →
`coder.approve_merge`, then `multiplayer.publish { session_id }` creates the
item. Each later developer runs `multiplayer.start_stage { repo, item }`,
confirms with `coder.confirm_contract { contract: <multiplayer.locked_contract> }`
(adding checks is fine), approves the diff or accepts a no-change finding, and
runs `multiplayer.publish { session_id, item }`. Work done in a developer's own
assistant instead of a coder session goes through `multiplayer.submit_stage`
at any stage: with `item` for a later stage, or with `intent` + `contract` and
no `item` for the Build itself. Anyone runs
`multiplayer.merge_check` once Polish is published and opens a pull request from
the branch it produces. The terminal front end is `car mp list | show | take |
publish | submit | check | abandon`, a thin wrapper over these methods.

The record carries `schema_version` (currently **2**; version 2 added
`abandoned`). A reader accepts every version up to its own and refuses a newer
one with "update CAR", because the record rejects unknown fields — so any field
change bumps the version.

#### `multiplayer.publish`
- **Params**: `{ session_id: string, item?: string, remote?: string }` — `remote` defaults to `"origin"`. Without `item` this publishes a **Build** and creates the work item; with it, the item's next stage.
- **Returns**: `{ item_id, stage: "build"|"improve"|"polish"|"extra", commit, branch: "car/mp/<id>", remote, next_stage, owners: [string] }`.
- The session must be finished: `merged` or `reported` (an accepted no-change finding; not valid for Build). For `merged`, the stage's work is the `car/coder/<id>` branch **only while it is still the single approved commit on the session's start** — a branch moved since approval is refused, because its tip is no longer the reviewed work. Refused when the caller's account already owns a stage of the item, when the session did not start at the item's tip (`coder.start { base: <tip> }`), when the stage touched `.car/multiplayer/`, when the contract fails the coder's own validation, names a check twice, or carries `baseline`/`differential` checks (every stage and the merge check re-run it cold, where no before-value exists), and when it drops or changes a locked check or grants credential access the locked one did not (adding checks is allowed and becomes the new locked contract). A Build must start from a commit already on the remote — the final squash is based there, so unpushed commits under it would reach the pull request unowned. Managed-project sessions are refused.
- The record stores the contract with its prose `description` replaced by the item's intent, so the description cannot carry the previous owner's reasoning. Checks only grow in *command*: a later stage can still weaken a script a check runs, which is what the next stage's review and the merge check's final run are for.
- Commits the updated record on top of the stage's work with a private index (the user's index and checkout are untouched; commits are never signed), pushes `car/mp/<id>` **without force** — two developers finishing the same stage race, and the second is refused — and then moves the local branch of the same name unless a worktree has it checked out (`local_branch_updated` says which; a successful push is never reported as a failure because of it). The record gains `{ stage, account_id, session_id?, engine, model?, base_commit, result_commit, no_change, contract_hash, finished_at, signals: { files_changed, lines_added, lines_removed, checks_added }, cost_usd? }` — `cost_usd` only when the stage's engine metered its spend (absent is unknown, not free).

#### `multiplayer.start_stage`
- **Params**: `{ repo: string, item: string, remote?: string, engine?: string, model?: string }`.
- **Returns**: `coder.start`'s reply (the session starts at the item's tip via `base`, with the item's intent), plus `multiplayer: { item_id, stage, locked_contract, owners }`. Confirm with `coder.confirm_contract { contract: locked_contract }`. `locked_contract` always has `allow_credentials: false`: a credential grant does not travel to the next owner, who grants it again only if they choose to.
- Fetches the item and refuses when the caller already owns a stage. The same checks run again at `publish`, which is the one that counts.

#### `multiplayer.submit_stage`
- **Params**: `{ repo: string, commit: string, item?: string, remote?: string, contract_additions?: [ContractCheck], intent?: string, contract?: OutcomeContract, base?: string }` — `remote` defaults to `"origin"`. Two shapes, as with `publish`: **with `item`** it submits that item's next stage (`contract_additions` allowed; `intent`, `contract`, `base` refused); **without `item`** it submits a **Build** and creates the work item (`intent` and `contract` required, `base` optional; `contract_additions` refused). A field from the other shape, or an unknown field, is refused, never ignored.
- **Returns**: `multiplayer.publish`'s reply plus `checks: [CheckResult]`.
- For work done **outside CAR** — a developer's own Claude Code (with the CAR plugin) or Codex session in their terminal — so a team need not switch assistants for any stage, Build included. CAR did not watch those edits, so it verifies only what it can itself: `commit` descends from where the stage starts (the item's tip; for a Build, `base`), differs from it (an empty submission is refused: "no change" cannot be judged for work CAR did not see), leaves `.car/multiplayer/` alone, and passes the contract, run here **cold** in a fresh worktree without credentials. A red run is refused with an error naming each failing check, its exit, and the end of its output; nothing is recorded or pushed. The stage is recorded with `engine: "external-unmanaged"` and no `session_id`. Operator-only; the same one-stage-per-account rule applies, so whoever submits a Build cannot then take its Improve (advisory, like all ownership here).
- **Stage**: the locked contract plus `contract_additions` (checks only, never replacing one) is what runs and becomes the new locked contract.
- **Build**: `contract` is the operator-authored contract and becomes the item's locked contract, under the same rules `publish` applies to a Build session's contract — the coder's own validation, no check named twice, no `baseline`/`differential` checks — and additionally `allow_credentials: true` is refused, since it runs without credentials here and at every later stage. Its prose `description` is replaced by `intent` in the record; `intent` (non-blank) is fixed here and is the only authored text that travels. `base` defaults to the tip of the remote's default branch (asked of the remote with `ls-remote --symref`, so a clone without `refs/remotes/<remote>/HEAD` works); an explicit `base` must be an ancestor of that tip — on the default branch, not merely on some remote ref such as another item's `car/mp/*` branch, whose unmerged stages would otherwise ride into this item's squash. (`publish`'s on-the-remote check for a Build session's start now ignores `car/mp/*` branches for the same reason.) The record's `origin_commit` and the stage's `base_commit` are `base`, `result_commit` is `commit`, and `car/mp/<id>` is pushed **without force**, exactly as `publish` does.

#### `multiplayer.abandon`
- **Params**: `{ repo: string, item: string, remote?: string }`.
- **Returns**: `{ item_id, commit, branch, remote, local_branch_updated, abandoned: { account_id, at } }`.
- Retires an item — for example when its locked contract turned out to be wrong. **Nothing is deleted**: a record-only commit marks the item abandoned on top of its tip and is pushed without force, so its history stays, and every later `publish`, `start_stage`, `submit_stage` and `merge_check` refuses it (`list` shows it with `abandoned` set and `eligible: false`). Any operator may abandon an item; the record names who. There is no reason field, deliberately: free text on the record is the channel it exists to shut. Start a new Build to try again. Like ownership, this is advisory: a record hand-edited to drop the mark is still refused by `merge_check` (which names the abandoning commit), but only a force-push that rewinds the branch past it — which anyone with push access can do — truly revives the item.

#### `multiplayer.list`
- **Params**: `{ repo: string, remote?: string }`.
- **Returns**: `{ items: [{ item_id, intent, tip, stages: [{ stage, account_id, engine, no_change, signals, cost_usd }], next_stage, abandoned: { account_id, at }|null, eligible: boolean|null, ready_to_merge }], unreadable: [{ item_id, error }] }` — `eligible` is `null` when signed out; `ready_to_merge` is the stage shape only (count and distinct owners) — `merge_check` is the verdict.

#### `multiplayer.get`
- **Params**: `{ repo: string, item: string, remote?: string }`.
- **Returns**: `{ tip, item }` — the full record.

#### `multiplayer.merge_check`
- **Params**: `{ repo: string, item: string, remote?: string, push?: boolean }`.
- **Returns**: `{ item_id, tip, mergeable, problems: [string], checks: [CheckResult], final_branch: string|null, final_commit: string|null, pushed: boolean, push_error: string|null, advisory }`.
- `push: true` also pushes `car/mp/<id>-final` to the remote once it verifies, **without force**: if that branch already exists there with other content (an earlier check, or review fixes pushed to its pull request) the push is refused rather than overwriting it, reported as `pushed: false` with `push_error` beside the unchanged verdict. Without `push`, nothing leaves the machine. An abandoned item fails immediately with no commands run.
- Re-verifies the whole history rather than trusting the latest record, and ties the record to the code: build, improve and polish are recorded in order by distinct accounts; every commit that changed the record changed **only** the record (a forged trailer on a commit that also changes code is caught); each version appends exactly one stage and only grows the contract; record commit *i* sits directly on stage *i*'s result and stage *i* started from record commit *i-1* (Build from the origin), so every code commit on the branch is some stage's work; and the tip **is** the last record commit, so code pushed after Polish is caught. A branch that fails any of this gets no commands run at all. Otherwise it builds the squash that would merge — the tip's tree without the record, on the item's origin — runs the final contract **on that commit** (not the tip), and only if green names it `car/mp/<id>-final` (refused if that branch is checked out). CAR pushes it only with `push: true` — the exact verified commit, never forced — and never pushes to `main`.


{% endraw %}
