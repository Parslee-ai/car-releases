# Changelog

All notable changes are documented in the [GitHub Releases](https://github.com/Parslee-ai/car-releases/releases) for this repo.
This file is a chronological index linking to each release's full notes.

## [v0.58.0] — 2026-10-15

### Changes

- Build an Agent: a build whose agent passed its own test scenarios no longer fails at the independent check that follows. That check handed the agent's scenario placeholder, `(in-daemon scenario evaluation)`, to a shell, which failed with "command not found" every time, so every agent build ended with "verification made no progress". The independent check now re-runs the delivered `agent.json` scenarios inside the daemon, the same way the build ran them, and passes or fails on their real result. The placeholder is never run as a shell command. If inference fails during that re-run, the session ends as an infrastructure failure instead of blaming the agent.

- Build an Agent: an agent that works in a folder now passes the independent check after its build. The check re-runs the agent's test scenarios in fresh copies of its working folder, as the build does, instead of in the build's project folder, which holds only `agent.json`, so an agent that reads files from its folder no longer fails there. If a copy of the folder cannot be made, the check ends as an infrastructure failure instead of grading the agent as failed, and making the copies counts against the check's time limit.

- Node and Python agent loops: a caller-owned runtime that was closed and reused, or that reconnected after a daemon restart, now registers its tools and policies again on the new daemon session, and a serving chat agent (`serveChat` / `serve_chat`, `--serve`) does the same before each chat turn instead of failing every turn after a daemon restart. The loops remembered registrations per runtime object, so the second run on a blank session failed with the tool not registered and ran without its declared policies. New `CarRuntime.connectionEpoch()` (Node) / `connection_epoch()` (Python) reports which daemon session calls land on; the loops key their once-per-session registration on it.

- **Android: approving or denying a chat approval now reaches the waiting
  turn.** The Android host sent `agents.chat.approve` as `{id, resolution}`,
  which the daemon rejects for want of `session_id` and `approval_id`, so every
  answer failed and the turn waited out its timeout. Android now answers a chat
  approval with `session_id`, `approval_id` and `decision`, and any other
  approval through `host.resolve_approval`, as CarHost does. The approval list
  is rebuilt from the `host.subscribe` snapshot on every connect, so an
  approval resolved while the phone was offline drops and one requested
  meanwhile appears, while a request that raced the snapshot is kept. An
  answer given offline keeps its card pending until it is delivered and lands;
  it is resent after a dropped connection, but not after the daemon refused
  it, and an approval resolved elsewhere settles it. A timeout on a live
  connection shows the error and keeps the card, so tapping again resends. A
  refused answer, a chat reply without `resolved: true`, or a ledger row
  already resolved another way shows the approval error instead of reporting
  success, including from a notification action. `approval.resolved` closes
  the card and withdraws its notification, a chat `approval_resolved` frame or
  a resolved row in the snapshot settles the inline card, and only
  `approval.requested` opens a card.

- Parslee Core is now told the local date, time and time zone on every turn, so requests that say "today", "tomorrow" or "this week" (in chat, `car do` and the MCP assistant) use the real date instead of a guessed one.
- Multi-turn assistant runs on Anthropic models read their conversation history from the prompt cache again when the turn carries a task list or remembered facts; the cache breakpoint no longer lands on the per-turn state text that the next request does not re-send.

- Built-in assistant: after a restart in the middle of a turn, resume now finds the durable action record the turn wrote. Before, it looked the record up under the provider's tool-call id while the turn had recorded it under its own `turn_<n>_call_<k>` id, so every interrupted call was closed as "interrupted before approval; not replayed". A call that was already dispatched is now reported as indeterminate and not replayed, so the model is no longer told an action that may have run never ran. A call approved before the restart is now replayed once, after the usual re-checks. Two host-visible ids change as a result: a `delegate` child's calls are recorded under `<parent call id>/<child call id>`, so the `action_id` on its `approval_pending` frames (a digest of that id) differs from before; and receipts replayed from earlier turns of a thread now number turns with the same compaction-aware count as live `tool_call`/`tool_result` ids, so the two agree.

- On macOS and Linux, approved local assistant shell commands now run inside CAR's OS secret sandbox, which denies reads of the daemon `auth-token` and `host-token` files after path resolution and refuses a protected inode with a pre-existing hard-link alias. Encoders, split reads, globs, symlinks, `/dev/fd`, and subshells can no longer return token-derived bytes; exact-value output redaction remains as a second layer. Windows keeps its existing approval and redaction behavior while its OS read-denial boundary is tracked in car-96vm.

- `browser_await_signin` no longer reports `signed_in: true` for a sign-in nobody completed. A call like `{url: "https://github.com/login", success_url_contains: "github.com"}` ended on its first check with the login form still up, and so did a call without `success_url_contains` that started on a page whose URL has no login marker. A start page that already passes the success test is now refused with an error that says why. `success_url_contains` is matched against the URL without its query string. The wait also reads the browser's live URL, so a sign-in completed by a form POST or an identity-provider redirect is detected; it used to read a cache those never update. `browse_wait` with `url_changed` reads the live URL for the same reason.

- `car bench` decode-speed calibration now measures a generation only after an earlier one has succeeded. When just one of the two calibration generations succeeds, the run keeps the base time limits instead of scaling them from the timing of the generation that loaded the model.

- `car-bench-run` could-not-run records now scrub their saved reason with the same redactor `car feedback` uses, then mask any user directory left mid-word, so every user directory is masked: several paths joined in one word (`/Users/a/models:/Users/b/models`, a `PATH`), Windows profiles (`C:\Users\<name>`, the `USERPROFILE` directory, `/mnt/c/Users/<name>` under WSL), other volumes' `Users` folders, and profile names with a space. Previously the second username and path stayed visible in a result meant for sharing, and a `HOME` that prefixed another user's directory (`/Users/al` vs `/Users/alice`) left part of that name behind. The reason also takes the shared token scrub, so a 40+ character high-entropy run such as a full commit SHA or digest now reads `[REDACTED]`.
- The shared redactor (`car feedback` bundles and the `car coder-ab` ledger) now masks a home path after `;` or `|` and in a `file:///Users/<name>` URL, and no longer reads the `s:` of `models:/Users/<name>` as a Windows drive, which had dropped the separator from a joined path list and could hide a real `C:\Users\<name>` path that followed.

- `car code` and `car board` no longer lose text you wrote when a send fails. A refused conversation message goes back into the composer (several refusals in the order you sent them, ahead of anything typed since), its "you:" line is removed so it does not read as sent, and Enter retries it; if the composer is closed it is held until you reopen it, and switching, closing, or quitting warns first. Messages queued before a conversation failed to open come back the same way, or are listed in the exit summary when the daemon does not support conversations. An answer to a coder question that never reached the daemon is kept and the question stays answerable. When the daemon connection drops (including while you are on another screen, for answers, guidance and revisions), a refusal arrives for a conversation you have left, or an answer's question has closed, the text is printed in the exit summary marked "may not have been sent". A refused or unhonored contract revision is kept for retry: `e` in the board and `c` at the `car code` approval menu reopen it filled in, and a failed revision there returns to the menu instead of ending the review.

- Model-reachable HTTP reads beyond `http_request` stop at a byte cap instead of downloading the whole body first, so a server sending a huge or endless body costs at most the cap rather than holding the read open until the timeout (or, for remote MCP connectors, which have no timeout, forever). Parslee Core's `web_search` reads the result page up to 256 KB and the instant-answer JSON up to 1 MiB; a longer answer is reported as a failed search. The daemon's `web_fetch` reads up to 8 MiB and a longer page's `text` ends in `…[truncated]…`; the keyless DuckDuckGo `search` fallback reads its result page up to 8 MiB. A remote MCP connector reply longer than 8 MiB is an error naming the cap. Bodies are still decoded by their `Content-Type` charset.

- CAR release binaries can now carry a `YYYYMMDD-sha7` build ID in `--version` output, and the daemon records it in `version.json`.

- `runs.cancel`: when the audit-journal append fails after a cancellation has already made the run terminal in the run store, the exact retry now finishes whichever journal rows are missing (the terminal row, the `run_cancellation_result` receipt, or both), each exactly once, before answering. Before, it returned the receipt from the run store while the journal never got it. This covers host cancellation of an orphaned run and confirmed owner cancellation, including a retry from another connection after the owner disconnected and a same-key request that was waiting while the first one failed. The owner's retry also releases the run's journal binding. If the daemon restarts first, startup reconciliation restores the receipt from the durable terminal.

- `car claude` no longer adds a second `car-collaboration` server beside the plugin's (which still refused, so the model saw two near-identical tool sets). It writes the session's identity to an owner-only file and gives `claude` only that path in `CAR_COLLABORATION_CREDENTIALS`, which `car-mcp --collaboration` reads when no `CAR_AGENT_ID` is set. Its cleanup of a killed launcher's leftover agent now works on Windows too (`OpenProcess` liveness, shared with `car doctor`).

- New `car claude`: starts Claude Code as a CAR-supervised collaboration session, so the plugin's `car-collaboration` tools (`collaboration_status`, `peer_*`, `lattice_*`) work instead of reporting "launch this coding session through CAR supervision". It binds the work context `car auth resolve` names for the directory (no org argument), enrolls a per-session agent whose token is scoped to the collaboration methods, passes the identity only to a session-only MCP server rather than to `claude`'s environment, and removes the agent when `claude` exits. Arguments after `--` go to `claude`.

- Ctrl-C (or SIGTERM) at a waiting `car do` approval prompt, or at the conversational `car do` `›` prompt, now ends the run at once with the "interrupted" line and exit code 130 (143 for SIGTERM) instead of waiting for Enter; the pending call is not approved.
- `car agent new`'s "Build this agent?" and "Add it to your agents?" prompts now cancel the build session on Ctrl-C, SIGTERM or SIGHUP, including when the answer comes from piped stdin, instead of ignoring Ctrl-C or leaving the session open. `car code`'s approval prompts and contract menu also turn SIGTERM and SIGHUP into a cancel, so the terminal is no longer left in raw mode. On a terminal, Escape and Ctrl-D at the car agent new prompts cancel too, and the prompt closes with a pointer to `car board` if another client changes the task.
- `car code` and `car agent new` exit 130 when Ctrl-C, or Escape or Ctrl-D at a terminal, interrupts one of their prompts, 143 for SIGTERM and 129 for SIGHUP, after cancelling the session. They used to exit 0, which reads as finished work; the codes match `car do`. Answering no still exits 0.

- Every on-device last resort — `car do`, the daemon's chat and `infer` paths, and streaming inference — now falls back only to a model installed through CAR: its files in CAR's models directory (from `car models install`/`pull`, CarHost's Models setup, or placed there by hand) or a CAR install receipt. OS-provided models such as Apple's foundation model still qualify. A complete snapshot that only sits in the shared Hugging Face cache is no longer used; when a chain then runs out, the error names `car models adopt <id>` for each such model. Among eligible models the fallback is the most capable one that fits in free memory (tool-capable first, then the largest) rather than the smallest. `car do`'s startup choice of a substitute for a model that cannot call tools follows the same rule (car#1439).
- A `car.do/1` run answered by a model other than the one it named now reports `status: "success_substituted"` instead of `"success"` (still an answer, still exit 0), with top-level `substituted_from` and `substitution_reason`. The reason is `credential_rejected`, `credential_absent`, `rate_limited`, `quota_exhausted`, `timed_out` or `failed` for a request-time fallback, or `not_tool_capable` / `unavailable` for `car do`'s startup substitution. The same two fields ride on each substituted `models_served` entry and on `model_served` events: the `car do --json` stream, the host `agents.chat.event` stream, and `coder.discuss` events. CarHost's answer caption and the coder conversation now name the model a fallback replaced. `--strict-model` still disables substitution entirely (car#1439).
- Streaming reports an on-device last-resort substitution too. When a model installed through CAR answers a remote-only streaming request in place of the routed model, the `infer_stream` final result and the voice fast track's `voice.turn.fast_done` frame (daemon and the UniFFI host) carry `local_last_resort: true`, `substituted_from` and `substitution_reason`, the same fields the non-streaming surfaces use. Internally the stream leads with a new `StreamEvent::Substituted` (car#1439).

- `car do`: a one-shot run that tried an action and never got it done now ends as not done and exits 1, instead of exiting 0 because the model's final answer explained what happened. That covers an action declined at the approval prompt or by a saved "don't allow", one that could not be approved because nobody could be asked (piped input, a script, CI, a timed-out request), and one that could not run. The answer still prints, followed by a plain line saying the request did not finish. `--json` reports `status: "error"` with `error` / `failure.cause` of `ApprovalDenied` / `approval_denied`, `NeededApproval` / `needed_approval`, or `ActionFailed` / `action_failed`. A refusal is cleared only by a later successful call of the same tool with the same arguments, a failure by any later successful call of that tool; a command that ran and exited non-zero (a `grep` that found nothing) is a result, not a failed action. Batch exit codes now follow the turn outcome contract: `max_turns` exits 1 (was 0) and `auth_required` exits 3 (was 1). In Chat, the built-in assistant's `error` terminal now carries `state: "not_done"` and a `cause`, and such a turn ends on that frame instead of `done`. `assistant_poll` keeps reporting the handle as `ok` when such a run settles; the nested document carries the not-done status.

- `car do --resume` keeps the run's full turn count after history compaction, so turn numbers are not reused and `max_turns` still caps the whole run. A run stopped between the model's tool calls and their results now resumes with those calls answered as failed with an unknown outcome (not replayed) instead of asking the model for a new turn over unanswered calls. The guard runs on every assistant-loop entry; it is mainly reachable on `car do --resume`, since durable chat already answers these calls before its loop starts.
- Rust API: `AssistantDurability::checkpoint` (car-server-core) gained a `turns_completed: Option<u32>` parameter carrying the agent loop's turn counter. External implementors of the trait must add it; an implementation that saves no turn count can ignore it.

- `car do --serve` now refuses `--org` and `--personal` with an error instead of ignoring them. Before, `car do --serve --org <ORG>` started a personal agent with personal tools and storage; a served agent's organization comes from its registration with the daemon. Every option `--serve` refuses is now rejected before CarHost registration, so an invalid invocation leaves no registration behind.

- `scripts/car-lane.sh` now admits a release pair to a lane only when it satisfies Apple's Developer ID requirement for team `3R69WXRDNY` (an Apple-anchored chain, not the signer name `codesign` prints), so a self-made certificate that copies the expected name is refused. `install-release` and `promote` also put the previous pair back (or leave a first install empty) when a rename fails or the command is interrupted mid-swap, instead of continuing without a rollback path or leaving half a pair; exit status 5 from a failed or interrupted swap means restoring the previous pair failed and the lane needs manual repair, while a cleanly restored swap interrupted by SIGINT or SIGTERM exits 130 or 143. A `promote` rollback that cannot copy the previous pair no longer restarts the failed release and reports success.

- macOS: `car update` and `car doctor --repair` now create the `car-mcp` link beside a `car` that links into CarHost.app (for example `/usr/local/bin/car-mcp`), and replace a dangling or wrong-bundle one. Sparkle updates never re-run the package postinstall, so an install that predates `car-mcp` kept `car` working while the Claude Code / Codex CAR plugin, which runs `car-mcp`, silently had no CAR tools. `car doctor` reports the problem without `--repair`; a regular file at that path is never overwritten, and a permission error prints the exact `sudo ln -sfn` command and exits non-zero.

- CarHost's Parslee account display no longer goes back to an older state when an `auth.status` answer arrives late. An answer to a read sent before a sign-in, sign-out, account switch, org switch, or account removal that CAR has since confirmed changes nothing, and neither does an older read answering after a newer one or a read that answers while a sign-in is still finishing. A failed read now leaves the account status unknown, with Verify and sign-in still offered, instead of treating the account as signed out (Chat no longer shows the Parslee sign-in card after a failed check). A sign-in that is still finishing when another account change is confirmed now reports that it was superseded by a newer account change. Connections keeps its state when the account rejects a Verify answer as stale, and a late passive credential hint no longer overrides a confirmed sign-in. The Accounts list and the default organization ignore late answers the same way. On iPhone, a Parslee runtime found for an account that signed out while it was being looked up is no longer used, so the phone does not connect after a sign-out.

- CarHost: Approve or Deny on a chat approval from Approvals or Command Deck, and an inline chat approval in the iOS app, now show an error when the daemon reports the decision did not reach the waiting turn, instead of looking accepted. Approvals, Command Deck and `car-host approve`/`deny` also report an error when the approval was already resolved some other way (another decision won, or it expired) instead of claiming the answer was applied.

- macOS setup's "Let Parslee control your Mac" step now shows Automation as Granted once it is allowed. macOS cannot say whether an app may control System Events while System Events is not running, and it usually is not, so the row kept offering "Allow…" after the person had allowed it. CarHost now starts System Events in the background (it has no window) and reads the permission again, and re-reads it when you come back from System Settings. "Allow…" starts System Events first too, so macOS's own prompt actually appears; if System Events takes more than two seconds to start, that press shows no prompt and the next one does. The Automation row in Settings → General gets the same fix. Mail is never opened just to check its permission; while Mail is closed its permission still reads as not yet known (#2719).

- In CarHost Chat, deleting a chat whose images can't be moved to the Trash no longer removes it: its file is put back, the chat stays in the list, and an alert says so, so you can delete it again. Only if the file can't be put back does the chat go without its images, and the alert names the folder they're still in. A chat file copied into the chats folder outside CAR is loaded once every image its original still has can be copied with it; until then it stays on disk, Chat says so once, and it's tried again each time Chat opens. Images the original no longer has don't hide the copy: it's loaded without them, with a note in the chat, and Chat says so once.
- CarHost Chat forks and copies now keep the source chat's task list. An image that exists but can't be read right now (a permissions or disk error) is now named as not copied by a fork, copy or export, instead of being skipped as if it were already gone.
- In CarHost Chat, an image that loads slowly (pasted from a slow source) goes to the chat it was pasted into, even if you've switched chats since.
- A CarHost chat with no reply yet now remembers its agent by id, so when two agents share a name it picks the agent the chat was started with. When a chat's agent isn't available, or an older chat's agent name is shared by two agents, Chat no longer falls back to the default agent or keeps the previous chat's agent: no agent is picked, and the message box asks you to add one. A new chat with no agent recorded still starts with the default.
- A CarHost chat turn sent to an external CLI agent (Claude Code, Codex, Gemini) now gets the stall watchdog from the moment it's sent. Before, a CLI that died before its first output left the chat waiting forever. After a CLI turn, the next supervised turn starts a new daemon session, so it no longer picks up a thread that never saw the CLI exchange.
- In CarHost Chat, a reply that has gone silent is given up 15 minutes after CAR stops waiting for it, and its turn is stopped on the daemon; a reply that arrives within those 15 minutes still lands. The same applies to a reply CAR couldn't confirm had started. Sending a new message after a turn was given up on (stalled, or not confirmed as started) now drops that turn's event subscription. Image files left behind when Edit & Resend drops later messages are now removed the next time the Chat screen opens.

- CarHost no longer shows a change as saved when its disk write failed. A Coder task or saved-conversation link whose write fails is put back as it was, and opening it again writes it, where before the retry found the unsaved link in memory and skipped the write, so the link vanished on restart. A Coder draft that cannot be saved is now reported in the conversation. A chat rename, goal or working folder that fails to save is not kept, but the name, goal or folder you entered stays in its field with the error so you can try again without retyping. Pins, archives and pinned order are put back whole. A new chat or transcript that fails to save stays listed, is written again by the next save or reload, and the chat rail says how many chats are still unsaved. Exporting one chat as Markdown now reports a failed write. A Multiplayer stages list that fails to save is written again on the next refresh and at Quit.

- CarHost chat no longer sends a message without its image when the image cannot be saved. A failed save (Application Support unavailable, or the image file failing to write) used to send the text alone and clear the image from the composer with no message. Now nothing is sent, Chat says which image could not be saved, and the text and images stay in the composer to send again.
- CarHost chat now says when an image goes missing in the other places it used to drop one quietly. A regenerate or edit whose earlier image file is gone still sends and names that image, and a fork or duplicate names any images it could not copy, both under "Some images weren't included" rather than as a failed send. Paste, drop and the file picker name any file whose contents could not be read. Export all says how many images could not be copied beside the Markdown, and exporting one chat shows an alert when the file cannot be written.
- Exporting one CarHost chat as Markdown now copies its images into an `attachments/` folder beside the file, as Export All already did, so the exported image links resolve. Before, the links pointed at files that were never written. Images that could not be copied are counted in an alert.

- CarHost now decides whether a loaded LaunchAgent owns its daemon port from the arguments launchd actually loaded (`launchctl print`), not from the plist on disk. When `car-lane.sh` had rewritten a lane's plist for a new port but launchd was still running the old job, CarHost used to record launchd supervision of the new port and start nothing there; it now treats the new port as unowned and serves it.
- When CarHost attaches to a launchd lane it reads that lane's auth and host tokens from the lane's own `CAR_HOME` (or the default directory, for a lane that unsets it), instead of from CarHost's own home, which can belong to a different daemon.
- `car-lane.sh install-plist` now boots out an already-loaded lane before bootstrapping it again, and does every bootout before replacing the plist. Reinstalling a loaded lane used to fail at `launchctl bootstrap` and leave the new plist beside the old running job; a failed bootout now leaves the plist matching the job launchd is still running.

- CarHost Chat's Regenerate and Send again now keep the reply they replace in the saved chat until the new reply arrives, so quitting or crashing mid-reply no longer loses it.

- CarHost's **Run scenarios** on a registered agent now shows the scenario report, with Keep and Revert, instead of always failing with "CAR returned unreadable scenario results". The host read any `0` or `1` in the daemon's reply as a JSON boolean, and the first scenario is always numbered 1. The same misreading hid the agent builder's live progress line during a first attempt; it now shows.
- A multiplayer stage's saved locked contract no longer turns a `0` or `1` into `false` or `true` when CarHost writes its stage file, so confirming that contract after a restart sends the numbers the item locked.

- CarHost Chat: Send again on a reply whose outcome is unknown now decides whether the message can go out before it cancels the first attempt. When it can't (another chat is on screen, the reply is no longer the latest, or a turn is running), the first attempt is left running and listened to, the chat says why, and the reply still offers Send again. When it can, the cancel is queued on the socket and the message goes out with nothing in between, so the first attempt can no longer be cancelled with no replacement sent.

- CarHost Chat's completion receipt now lists only the checks the turn you just watched recorded. A check from an earlier turn, such as a GitHub sign-in browser proof, no longer repeats as "1 of 6 check recorded" on every later turn, including turns that called no tools. A goal turn's receipt covers every iteration of that goal run, and its desktop actions and tool rows now include the earlier iterations too, not just the last one. When a goal turn has more rows than the receipt holds, the latest ones are kept, since the final iteration is the one that met the goal. The `receipt_report` frame's `completion` field is built from the turn's own tool receipts. Each evidence string carries the turn's `call_id` and the call's redacted excerpt, bounded to 2,048 bytes overall, and a call that succeeded but reported an `error` no longer counts as a check.

- CarHost's Command Deck and Dashboard now show a Chat approval as the tool, its target and the call's parameters, instead of the raw approval JSON with the chat session id in it. Slack, iMessage and Windows tray approval summaries for a Chat approval now open with `Agent: <agent_id>` followed by the call's parameters, and never fall back to the whole approval blob with the chat session id in it (which happened when the call sent no parameters or non-object ones). iOS no longer shows `<null>` for a Chat approval with no parameters.

- CarHost Chat: drop any file anywhere on the chat screen, the message list included, and it attaches to the chat on screen. One highlight shows while you drag, and says so when a drop can't be taken. Several files can go at once, and a drop that mixes files and images keeps them all. Dropping a file on the message box attaches it; it no longer types the file's path into your message. Dragging the floating thumbnail that appears after ⌘⇧4 attaches the screenshot, the same as a saved PNG from Finder: the file is copied the moment it is dropped, so the thumbnail going away can't lose it. Refs #2447. Refs #2374.
- A dropped or pasted file shows in the message box at once, with a spinner, while it is read; Send waits for it. A file another app still has to hand over (a promised file, or several from one drag) is waited for up to 30 seconds, and if some never arrive the chat names each one. A pasted item the other app never hands over is given the same 30 seconds, then marked "It didn't arrive within 30 seconds" so Send works again, and the rest of the paste still loads. It always ends up in the chat it was dropped on, even if you switch chats first; one dropped on a new chat you leave before it is ready is dropped and said so, not moved into the next chat. Files are read in the background, one pasted file at a time, no file is read past its size limit, and one message holds at most 100 MB of attachments in all, Attach Image… included. While Send saves a message's files, that chat's message box shows "Saving files…" and waits until the message has started, so nothing typed or dropped then is lost and pressing Send again does nothing; other chats are not held. A save that hasn't finished after a minute stops holding the message box; the message stays unsent, the file shows it is still saving, and Send works again once that save has finished.
- What the agent gets for each file. Images are sent as images, as before. Text files, code, CSV, Markdown and JSON go into your message as text, up to 256 KB each; a text file saved in Windows Latin 1 (such as an Excel CSV) is read too. A larger text file is saved with the chat and referenced, and the message says it was too large to include as text. A PDF is saved with the chat like any other file: the agent is told its name, type, size and where it is saved, with a line saying "PDF text isn't extracted; open the file at its path to read it." CarHost doesn't read a PDF's text itself. Any other file, and any text file that can't be read as text, is saved with the chat and the agent is told its name, type, size and where it is saved, not its contents. Files other than images are saved up to 25 MB each, and images up to 50 MB, whether dropped or pasted as a file or as image data. A file's text can't end or fake the section it is placed in: a literal attached_file tag inside a file is escaped, and the message says so. A symlink is treated as what it points to. Folders can't be attached: use Choose Folder in the + menu to work in one. Pipes, devices and other special files are refused. A file another app hands over (a promised file, or a pasted file) must be a real file in the place it was handed over, and it is copied from the file that was checked; a link, or a file reached through a linked folder that leads elsewhere, is refused with "This app sent a link, not a file". A pasted image whose file is somewhere else is taken as image data instead.
- When something can't be attached, the chat it was dropped on says why above the message box: for example that the chat's agent can't read images, "Too large (max 25 MB)", "Not a regular file", or "Wait for this reply to finish, then attach it again". If a file can't be saved with the chat when you press Send, the message isn't sent and the file stays, marked, so you can remove it or send again. Text and other files attach for any agent that can chat; only images need an agent that reads images.
- Files saved with a chat, images included, are readable only by you (their folders 0700, the files 0600). Copies of files waiting to be sent are removed when they are sent, removed, or their window closes, and any left by a quit or crash are cleared at the next launch after a day; each build keeps its own, and nothing still in use is touched. If there's no room to receive a promised file, the chat says so instead of waiting.
- Paste: a file copied in Finder attaches with ⌘V, and a screenshot copied with ⌘⇧⌃4 still attaches as an image; both get their place in the message box the moment you paste.
- Known limit: an image dragged or pasted only as in-memory data (not as a file) is read in full before the 50 MB image limit refuses it, because macOS gives no size for such data until it is read. Nothing over the limit is kept, and a pasted image is taken as a file whenever the source offers one.

- CarHost Chat: a late approval result no longer turns an Expired card into a decision, in any chat view or the saved transcript, including a host-ledger resolution of a card the sending view has already expired.
- Daemon: an agent's `approval_resolved` for a reused approval id now closes the approval it belongs to. A decision matches the oldest answered approval with that id and a timeout the oldest unanswered one, and a late result from a replaced, cancelled or failed turn is consumed against that turn's own approvals, so an older call's result can no longer close a newer approval and leave it unanswerable. When the agent refuses a decision (`resolved: false` or an error), the daemon closes the mirrored ledger row (`timeout` or `interrupted`) instead of leaving it pending.

- Docs no longer say Python `register_tool_handler` raises `NotImplementedError` (`docs/a2a.md`, the agent authoring guide): it installs a process-wide callback that multiplexes on the tool name, and the packaged `agent_loop` helpers pass their own handler per call and leave it in place. The Node and Python agent-loop tests now run on every pull request.

- CarHost Chat: you can type in the message box while a reply is coming in, and while the reply waits for you to answer an approval. Press Return or Send and your message is queued: it shows above the message box marked Queued, and can go out by itself once the reply ends, whether it finished, you stopped it or it failed after it started. Queue more than one and they can go out in order, one reply at a time. Edit puts a queued message back in the message box, and the cross cancels it. Each chat keeps its own queue, and a queued message is only ever sent in the chat you wrote it in. Queued messages wait, and say why, while their agent isn't available, while no Chat window is open, while CAR isn't connected, after a reply CAR can't tell ended, and after a message that didn't go through; once CAR is connected, Edit lets you send one yourself. A queued message is text only; images wait in the message box for the next message you send after the reply. Refs #2371.
- While a reply is coming in, you can now change the model and the reasoning effort: the change applies to your next message, queued ones included, and the reply already running keeps the model it started with. The approval mode can't change while a reply of that agent is running in any chat, because a change would apply to what that reply does next; its tooltip says so.
- Long bullet and numbered list items in a reply now wrap onto as many lines as they need, instead of being cut to one line ending in "…"; paragraphs and headings always do too. Refs #2448.

- New host-only daemon methods `openai_codex.status`, `openai_codex.auth_start`, `openai_codex.auth_cancel` and `openai_codex.sign_out` run the `car auth login --provider openai-codex` sign-in for a host: the daemon owns the callback on port 1455, the code exchange and the keychain write. When Codex's own sign-in already holds that port, `auth_start` fails at once with "Codex's sign-in is open. Finish or close it, then try again." instead of waiting.
- A ChatGPT model that is unavailable because nobody signed in now says to sign in from Settings → AI accounts, with `car auth login --provider openai-codex` as the second option.

- `car coder-ab` now refuses a delivered patch when an approved check credential's value is stored uncompressed in a binary file (for example a SQLite database), including a renamed file and one a later commit deletes. The scan previously read only the encoded patch bytes, so a binary hunk carried the value into `delivered.patch` unnoticed. As with text files, a value the base version already held does not block delivery; compressed or re-encoded content is still matched only as raw bytes.

- `car coder-ab` no longer lets two ledgers in one `ledgers/` folder overwrite each other's attempt evidence. New attempts copy their artifacts into `artifacts/ledgers/<ledger stem>/<task>/<attempt>/` instead of the shared `artifacts/<task>/<attempt>/`. Rows written before this keep their stored paths and their files stay where they are. `coder-ab rescore` without `--ledger` finds the owning ledger in either layout, using the paths the row stores. `ledger check` and `scripts/check-replay-ledger-paths.sh` no longer report another ledger's artifacts as this ledger's. Each older shared attempt folder is checked by the ledgers whose rows store a path in it, and a folder no row references is still checked by every ledger beside it. `scripts/check-replay-ledger-paths.sh` accepts the row order `car coder-ab` writes today, with `attempt_patch` and `attempt_patch_error` and a re-score row's `rescore_of`, and checks that `attempt_patch` exists. Before this it rejected every current row as "keys are not in a supported historical or current order".

- **Coder audit: refining a defect updates it instead of duplicating it.** A follow-up audit finding that repeats an existing `defect_id` (`D1`, …) with the same kind and outcome now replaces that blocker, so rewording a retained defect's claim or reproduction keeps its id rather than adding a second blocker while the stale wording stays active in repair feedback, the attestation, and the delivery ledger. An id repeated with a different kind or outcome, an unknown id, or an id already used earlier in the reply gets a new id and leaves the original blocker in place, so a repeated id can never silently move or retype a blocker. A finding that repeats an id the same reply withdraws gets a new id, and the withdrawal still applies. Explicit ids are matched before unlabelled restatements, rewording one blocker into another's exact claim keeps both blockers active instead of dropping one, and withdrawals tolerate surrounding whitespace in the id.

- `car code` mandatory audit: a JSON object without a `findings` field is no longer accepted as a clean audit. Previously a reply that ended with unrelated JSON (for example `{"usage":123}`) after the real audit was read as an empty audit, erasing the auditor's findings and letting delivery proceed; such a reply now falls back to the real audit, and a reply with no audit object fails closed.

- Coder check evidence now redacts an approved credential split from stderr into stdout as well as from stdout into stderr, so the two persisted stream files no longer keep complementary fragments of one value. A coder shell command counts as a replay of a contract check's script only when it executes that same script path: `cd`, `pushd`/`popd`, subshells and `sh -c` are followed, and a script that is only read or edited (`sed -i`, `chmod`, `cat`) is not a replay. So a different script that shares the file name keeps its worktree edits, and checks that run a script outside the worktree keep replay protection. A timed-out `car coder-ab` re-score keeps the redacted stdout and stderr the check printed before its deadline instead of recording empty logs. A re-score no longer hangs when a finished check leaves a background process holding its output: collection stops 5 seconds after the check exits or is killed. Each re-score stream is capped at the check-evidence size limit. A note records any truncation, a read error, or that collection stopped while a process still held the stream.

- A daemon no longer deletes or rewrites a `car code-task` session the CLI is still running or delivering. `car code-task` now holds the same session lease `coder.start` does for its whole run, so a daemon booting mid-run no longer marks the task "interrupted by a daemon restart" and reaps its processes, and daemon boot no longer restores protected files into the worktree of a leased session that has gone terminal but is still delivering. If `car code-task` cannot take the lease it ends `InfraSetup { retriable: true }`. Daemon retention sweeps skip leased sessions and apply a two-hour minimum age, the floor `car code-task`'s own sweep never goes below, so a tight `max_sessions` cap cannot delete a session that went terminal moments ago. Boot no longer deletes the journal or outcomes file of a session another process holds before its first snapshot, and it removes old, unheld lease files with nothing beside them, left by a run killed before its first write. Continuing a retained task with `coder.start`, or reopening a review, now refuses with a clear message while another process still holds that task, instead of recovering files into its worktree; the review refusal arrives as `review_restore_error` on `coder.subscribe`.

- CarCoder no longer scores correct work as a failed verification when the verifier's own machinery fails. A failure writing the verifier's frozen copy, Git failing to start or being killed while it reads the worktree, setting up the verifier, or re-hashing or diffing its copy now ends the session as `Failed(Infrastructure)` (headless `car code`: exit 2, `infra_setup`), outside the scored results; so does headless `car code` failing to rebuild the copy for its pre-delivery check that the tree being delivered is the one the verifier graded. Faults in what the builder can change still end as verification failures, so none of them takes a run out of scoring: a nested repository, a symlink that escapes, dangles, loops or runs through a file, an unsupported file type, an invalid path, a file whose permissions deny reading it, a corrupt delivered Git index, or a worktree `.git` link Git rejects. The worktree's Git common directory is now recorded when the worktree is provisioned, before the builder runs, so the verifier no longer asks the delivered worktree for it.

- `coder.respond`, `coder.revise_contract`, `coder.confirm_contract`, `coder.refresh_review`, `coder.approve_merge` and `coder.cancel` now act only for the run's owner agent or a host-authorized client (the CAR app, `car board` at a terminal, or an SDK program using the host-management call — confirm/approve on an agent build still need a person); a run a person started also accepts any connection not bound to an agent. An agent connected to CAR can act only on Coder runs it started: it can no longer answer, steer, redraft, confirm, re-check, approve, reject or stop another agent's or a person's run. A run now records the agent that started it as `owner_agent_id` on `coder.get`, absent when a person started it. A run saved by an earlier version belongs to a person.
- `car board` (and the board `car code` opens) keeps showing and acting on every run, including ones an agent started: on a terminal it now authenticates with CAR's local host key when the daemon is on this machine and the key file exists, and connects as before otherwise. A board started by an agent (`CAR_AGENT_ID` set) never presents the key. If the board is refused on an agent's run because no key could be presented, it says to use the CAR app or restart CAR to recreate the key. Like every host-only action, this doesn't stop a program running as you that reads CAR's local host key.
- The SDKs' host-management call (`daemonCallHostManagement` / `daemon_call_host_management`) now accepts those six Coder methods, so an SDK client acting for you can still answer, revise, confirm, re-check, approve or cancel a run an agent started by presenting CAR's host credential. It refuses `coder.confirm_contract` and `coder.approve_merge` on an agent build with "Building an agent needs the CAR app or `car agent new` in your terminal.", so building an agent stays your decision in the CAR app or at your terminal. Like the agent-build rule, this doesn't stop a program running as you that reads CAR's local host key.

- CarCoder grades a contract check that loads a helper with `source checks/x.sh` or `. checks/x.sh`, a `BASH_ENV=`/`bash --rcfile` startup file, or a node preload (`-r`, `--require`, `--import`, `--loader` or `--experimental-loader`, as `FLAG x` or `FLAG=x`) against that file's session-start copy, so a builder that edits it no longer changes the grade. Sourced files and scripts run by `bash`/`sh` are scanned even without a `.sh` extension or shebang; list a sourced product library in `editable_paths` when the builder is expected to fix it. `partially_protected` now also lists runtime-selected logic on a check's own command line (labelled `<check command>`), a file sourced through a variable, process substitution, a startup file missing from the start commit, and a protected Python or JavaScript helper's import of a module from its own directory, other than a sibling-name import from a helper at the repository root (list such modules in `protected_paths`).

- The Codex CLI inference route (`openai/gpt-5.6-sol:high`) now passes a conversation's images in conversation order: earlier turns' images first, then the current message's. It used to send the current message's images first, so a question about "the first image" or "this one" could be answered about the wrong file. Each message in the encoded conversation now lists the positions of the images it carried, so the model can tell which turn an image came from. An inline image larger than 32 MiB is refused before it is decoded and written, the same limit the `external:codex` adapter applies.

- The Codex CLI model (`openai/gpt-5.6-sol:high`) counts as available only when Codex is signed in. CAR asks `codex login status` (cached for 30 seconds) instead of trusting that the binary exists, so a signed-out Codex no longer shows in model menus or gets picked by automatic routing only to fail at run time. An answer CAR can't read keeps the old behavior. On Windows the binary check alone still decides.

- **ChatGPT subscription credentials go only to the ChatGPT backend.** An
  `openai-codex` model whose schema names an endpoint other than
  `https://chatgpt.com/backend-api` is now refused before any request, instead
  of receiving the ChatGPT bearer token and account id. A blank endpoint still
  resolves to the ChatGPT backend. Codex requests also follow a redirect only
  when it stays on the ChatGPT origin; a redirect to another host now fails the
  request rather than carrying the `chatgpt-account-id` header there.

- The ChatGPT-subscription Codex model (`openai/gpt-5.6-sol:high`) now lists image support and is no longer tagged `text-only`, so clients that check a model's image capability before sending offer it for chats with images. It reads inline images only and doesn't stream: a request routed by CAR that carries an image link, video or audio, or a streaming request with any image, is never routed to it.
- CarHost now says before Send when the chat's chosen model can't read images: "This model can't read images. Pick another model or remove the image." Send stays off and the images stay in the draft until another model is picked or the images are removed. Send again, Regenerate and Edit & Resend of a message with images check the same way. The check uses the model's image capability from the model list, so a local text model is caught before the turn starts. While the model list is still loading, Send, Regenerate and Edit & Resend of a message with images wait for it and say so. With Automatic, Send is not blocked.
- The ChatGPT sign-in models (`openai-codex/*`: GPT-5.6 Sol, Luna and Terra) now read images. A turn's images go to ChatGPT with its text, and a turn with images is no longer dropped from the request. Chats whose chosen model is a Parslee model (`parslee/*`, such as `parslee/reasoning` and `parslee/advisor`) now show "This model can't read images" before sending an image, instead of failing the turn or sending it without the image.
- CarHost's model menu now names the two ChatGPT routes apart: "GPT-5.6 Sol · ChatGPT" for CAR's own ChatGPT sign-in and "GPT-5.6 Sol · Codex app" for the Codex app on this Mac.
- `models.list_unified` rows carry a new `source_kind` field naming where each model runs (`codex_cli`, `remote_api`, `proprietary`, ...). CarHost's model menu uses it to keep two routes to one model, such as the ChatGPT-subscription and API-key versions of GPT-5.6 Sol, as separate entries, so picking a reasoning effort never switches which account pays.

- Organization-bound collaboration sessions now discover their colleagues. `peer_list` in a session bound to an organization (for example `car claude` in an organization's repository) returns `organization_directory`: that organization's colleagues, emails and devices from the Lattice directory. It comes from the new `agents.peers { organization_directory: true }`, which takes the org from the connection's own binding, reads only what this CAR already holds (never a relay fetch, so agents cannot spend the operator's relay budget), and leaves out the operator's own Lattice connection records. When the CAR holds no directory for the org, the field carries an `error` and the peer list still arrives. The adapter's device-selector surface (`target_device`, `reply_target_device`, `recipient_catalog`, and its `agents.peers.directory` / `agents.peers.agents` calls) is removed: those daemon methods never shipped, so `peer_list` failed in every organization-bound session. Address recipients with `to`. `lattice.directory` itself is unchanged and stays host-only.

- A directory under `models_dir` whose name normalizes to the id of an already-registered model (user, catalog, or builtin row under a different name) no longer replaces that row with an inferred one, and deleting the directory no longer removes the registered model from `models.list` (#1650).

- `car-commons`: a contribution with `\n` in any field (author, description, parents, tags, metadata keys or values), `,` in a parent or tag, `=` in a metadata key, or `;` in a metadata key or value no longer shares an id with a different contribution, so publishing tags `["a,b"]` after `["a", "b"]` is accepted instead of refused as an `IdCollision`. Ids of every other contribution are unchanged (a comma in a description, for example, keeps its id). A contribution matching that rule (a multi-line description, for example) now has a different id than before, so a stored child naming its old id would load as orphaned. `LoadReport::is_clean()` now returns `false` when records from a newer schema were skipped.

- **`car models update-policy auto` now ends the first week under the default.** Setting the policy that was already the unchosen default used to be ignored, so the maintenance pass kept only suggesting until the week ran out. It now counts as your choice, and the next `car concierge maintain` acts as `auto`. CarHost's Upkeep section adds "Start taking care of it now" during that week, since picking the already-selected "Take care of it" changes nothing. `models.update_prefs_set` treats `policy_chosen: true` sent with a `policy` as an explicit choice; writing back the preferences to change another field still is not one. Against a daemon older than the CLI or CarHost, which cannot record that choice, both now say so (the CLI exits non-zero) instead of reporting success.

- CarHost: a new **AI accounts** section in Connect apps and in Settings → AI accounts (shown whatever the Command Deck setting) connects the AI plans a person already pays for. **Sign in with ChatGPT** opens the browser and runs CAR's own ChatGPT sign-in, with no Codex install; once it finishes, the ChatGPT models (GPT-5.6 Sol, Luna and Terra) appear in every model menu and the section names the account. **Claude** shows whether Claude Code is installed and signed in, and **Sign in to Claude…** opens Terminal on Claude Code's own sign-in, then turns green on its own when it finishes; a line points to Settings → Secrets for an Anthropic API key instead. An installed Codex CLI shows its status. Opening or returning to the section reads no saved credential: until CAR has checked, ChatGPT shows **Not checked yet** with a **Verify** button, the one place it reads the saved sign-in (and macOS may ask for Keychain access). Verify shows "Checking…" and then what it found, such as "Checked just now: signed in as …", even when nothing changed. The onboarding Model step offers the same two sign-ins in a card, and a connected ChatGPT or Claude account completes that step just as the Parslee sign-in does. The Chat model menu gains **Connect AI accounts…**.

- `agents.invoke_external` refuses an inference consumer socket in its own handler, and an `agents.chat` a consumer sends is never recorded as host-started, even on a daemon with no host token. The read loop's consumer method scope already refused both methods; the handlers no longer depend on it.

- Fixed the daemon-client reachability test to derive expected roles from the generated role source, matching the corrected roles from #2640.

- Daemon: a `declagents.json` that exists but cannot be read or parsed (bad JSON, a missing required field, a permission error) is now an error naming the file, instead of being read as "no built agents". `declagents.list`, `declagents.get`, `declagents.invoke`, `declagents.run_scenarios`, `declagents.route`, `declagents.route_split` and `coder.projects.create` with `existing_agent_id` return the error, and registering, removing, enabling, disabling or reverting a built agent refuses rather than rewrite the damaged file with only the new change, so the existing agents stay on disk for the operator to repair. A missing file is still an empty list.
  - `agents.list` keeps every supervised agent and leaves out only the built ones, logging why; `discovery.resolve` skips built agents with a logged warning.
  - `agents.chat` to an id that is not attached keeps its "agent `<id>` is not attached to this daemon — …" refusal with the registry error appended.
  - `fleet.inventory` (and each local row of `fleet.composite`) carries `error` naming the file, never its local path, with the built agents left out.
  - `concierge.portfolio` still answers and carries `pins_unreadable`; `models.retire` and `concierge.maintain` refuse until the file is repaired.
  - Concurrent changes to built agents in one daemon no longer overwrite each other.
  - Rust API (crates.io `car-registry`): `car_registry::declarative::DeclRegistry::list` now returns `Result<Vec<DeclarativeAgentSpec>, String>` and `DeclRegistry::get` returns `Result<Option<DeclarativeAgentSpec>, String>`.

- `car lattice directory --refresh` now runs the device-certificate pass whenever a certificate it would read cannot be used by a relay call (missing, expired, or not bound to this device's sealing key), and with no `--org` it checks every held organization. Before, the no-`--org` refresh skipped the pass when any one certificate was current, and no refresh checked whether a current certificate was bound to this device's sealing key, so the colleagues Parslee certifies in such an organization were silently missing from the refreshed listing.

- A streaming `agents.invoke_external` run an agent hands off while answering a chat now belongs to that chat turn. It stops when the turn ends (finished, failed, cancelled with `agents.chat.cancel`, replaced by the session's next turn, or its host or agent disconnected), and none of its tokens, tool calls or final `done`/`error` reach a later turn under the same `session_id` or mark that turn's goal finished. Before, the run kept going unseen, streamed into the next turn, and the host could no longer cancel it.
- A host's own streaming `agents.invoke_external` run (one with no chat routed under its `session_id`) and a declarative agent's turn now stop when the same connection's next `agents.chat` under that `session_id` replaces the route (from a host, only a declarative agent's turn can), as they already did on `agents.chat.cancel`. They keep running if the host disconnects, as before. Their frames, too, reach only their own route, and a finished external run no longer removes a newer turn that replaced its route.

- `sync.pump` no longer re-reads the credential store on every call after a sign-in change when listing the Parslee logins fails (a locked keychain): the failure restarts the five-minute fallback listing clock, so a failing store is not re-read on every pump. A pending `setup_failed` retry runs on its own five-minute clock and can still prompt a listing, and a newer nonzero credential generation still lists immediately.

- Keep feedback submission and server history on one login's organization, API endpoint, and renewable bearer after another login is selected.

- Queued feedback stays bound to the Parslee login that created it after a daemon restart instead of uploading through a newly selected account.

- Fit verdicts now size an installed model's KV cache from its checkpoint's own `config.json`, the geometry load-time admission reads, instead of from the parameter count. `models.list_unified`'s `fit`, `models.recommend` and `models.setup_plan`, the portfolio's `never_runs_here`, the concierge and `car models fit` therefore agree with admission on an installed row's memory estimate; only admission's live-memory check can still refuse a row the list calls `fits`. A model that is not installed keeps the parameter-count estimate. Admission and every fit verdict re-read a checkpoint's `config.json` when its mtime or length changes, so removing, replacing or re-downloading a model takes effect without restarting the daemon (car#2213).
- Rust API: `car_inference::model_fit`, `recommend`, `recommend_with_policy`, `decide_concierge(_with_policy)` and `evaluate_concierge(_with_policy)` take a trailing `&CheckpointGeometry`. New public items: `CheckpointGeometry`, `estimate_model_memory_for_checkpoint`, `LocalAdmissionCoordinator::checkpoint_geometry` and `InferenceEngine::checkpoint_geometry`. Build it with `InferenceEngine::checkpoint_geometry` (admission's models directory and cache) or `CheckpointGeometry::read`; `CheckpointGeometry::default()` keeps the parameter-count estimate for every row.

- macOS: the Apple FoundationModels backend now refuses an image request it cannot fully serve, with `UnsupportedMode` (backend `foundation-models`), so routing falls through to a richer model. Previously an image inside `messages` was routed to the system model as vision and then generated without; a request carrying both images and tools took the image path and lost its tools; an image request with a JsonSchema `response_format` lost the schema; and an image URL or text block beside an inline image was silently removed. Any block in `images` other than inline image bytes (a URL, text, audio or video block) is now refused. All of these report mode `multimodal-content` except the schema case, which reports `structured-output`. A JsonObject image request now gets the same JSON instruction the text path injects. A request pinned with `strict_model` now gets the error instead of an answer that ignored part of its input.
- macOS/iOS: streaming from the Apple FoundationModels backend now honors `response_format`, except when tools are present (ignored with a warning, as on the non-streaming path). A JsonSchema stream runs native constrained decoding and arrives as one text chunk plus completion, and a JsonObject stream gets the JSON instruction; before, both streamed unconstrained text. A stream that carries images no longer routes to this backend, whose streaming path takes text only.

- Apple Foundation Models: constrained output now keeps the JSON Schema the caller supplied. A required property that allows `null` (`"type": ["integer", "null"]`, `anyOf` with a `null` branch, or an `enum` containing `null`) can produce `null` again: it goes to the model as an optional property, and when the model leaves it out, the `null` is written back into the structured output or tool-call arguments, against the union branch the value satisfies. Constraints beside `anyOf`/`oneOf` (such as `type`, `enum`, `properties` and `required`) are now applied to every branch rather than dropped. A branch they contradict is dropped. A sibling keyword that cannot be intersected with a branch's own keeps the branch's value and is warned about, with no `allOf` fallback. A property no value satisfies is omitted and reported; at the root it becomes a permissive string. `const` and enum members of the wrong type are no longer lost. A `oneOf` whose branches can overlap is now reported with a `tracing::warn!`, because it is generated as `anyOf`. So are `null` outside an object property and `array` without `items`.

- Pressing Stop in a Parslee Core (`car do --serve`) goal chat while the final reply is being written now ends the turn as stopped; the goal check no longer runs afterwards (a check that had already finished is still graded). A Stop also closes any approval card the turn is waiting on (a tool call's or the goal check's) as `cancelled` and refuses the call, instead of leaving the turn waiting up to two minutes (goal check) or five minutes (tool call) on a card nobody could answer; a stopped turn shows no new card, and an approval that lands with the Stop, or a call approved just before it, does not run. A Stop now reaches every turn in flight on the chat session, where before a second overlapping turn took the first turn's Stop away. The same holds for an MCP `assistant_start { until }` run cancelled with `assistant_cancel`: the cancel skips a goal check that has not started, and a check it interrupts is not graded.

- A supervised agent's bound connection can no longer replace or clear a standing chat goal it does not own, through `goal.set`, `goal.suggest { set: true }`, `goal.clear` or an inline `agents.chat` goal; it may still create a goal on a session id that has none, and its `goal.clear` without a `session_id` clears only its own goals. Its goal never steers another caller's turn and is not reported as that session's goal in their `goal.status`, and a turn's events update a goal only when the turn's driver owns it, so an agent's turn on the host's session no longer records the host's goal met. That turn still runs the host's goal when it sends no inline goal, and is refused when it sends one. Only bound connections are restricted: CarHost and unbound clients (CLI, SDK, mobile on the daemon token) keep full control of every goal. Goals saved before this release load as host-owned, so an agent cannot replace or clear a goal it stored before the upgrade; the host can (car#2168).

- Fixed a governed assistant running some shell commands that change things without approval. The read-only shell shortcut now admits `git branch` and `git remote` only in their listing forms, and `sed` only with allowlisted flags and programs that have no `w` or `e` command, so `git branch -D`, `git remote rm` and `sed 'w file'` now ask first. A `sed`, `git` or `rg` command whose arguments the shell would expand (`$VAR`, `{a,b}`, a bare `*` glob) also asks first, as do `rg --pre`, `--hostname-bin` and `-z`, and on Windows any command containing `^`, `%`, `!` or `'`.

- Harness evolution: approved prompt and tool-description guidance now accumulates. Proposals from one analysis round were each computed from the same starting overlay and applied wholesale, so approving a second one erased the guidance approved just before it; the same happened in the daemon's coder overlay store when two sessions approved guidance. Each apply now merges the change into the config as it stands under the lock (`HarnessConfig::apply_from`, `HarnessConfigPatch::rebase`), including both `evolution.run` harness apply paths (human-approved and gate-promoted), so a change that lands during a replay is no longer overwritten, and a smaller budget move from the same snapshot no longer undoes a larger one. `evolution.run`'s context step now refuses a human-approved patch whose `conversation_keep_recent` moved after diagnosis, reporting the new status `config_moved_since_diagnosis` and applying nothing, as the graded path already did. The coder A/B fixer's status note also stops counting prompt and tool proposals, which are waiting for approval, as work that still needs human design. Rust API breaks in `car-server-core`: `coder::HarnessApply::apply` gains a `base: &HarnessConfig` parameter (the config the mutation was computed against), and `coder::harness_overlay::record_patch` gains the same `base`. Because overlays now merge by line set, overlay text can reorder: a rewritten line moves to the end, and duplicate lines collapse to one.

- Since 0.56.1, `car code` runs that deliver — every plain `car code` run (default `--deliver branch` when no `--target-branch` is given), `--deliver pr`, and `--target-branch` — reached green checks and then failed `contract_not_green` with "headless verification has no start commit", delivering nothing and keeping the worktree. They now record the commit their worktree started on, so independent verification runs and a green run delivers.

- Explicit `--full-access` local runs no longer pause for ordinary file and shell edits, while host-side local image and speech generation now asks for approval even from sandboxed sessions.

- CarHost (macOS) no longer erases setup progress and the CAR Chat model choice when moving them into `<CAR_HOME>/host-state.json` fails. The old preferences are cleared only after the new file is durably written (fsynced before and after the rename). On a read-only or full disk they stay in place, the failure is logged, and the move completes on the next successful save. During the move, a value the file cannot hold stays in the old preferences instead of being deleted. Saves are serialized, so the file can no longer fall behind what the app shows. A value the file cannot hold is refused instead of breaking every later save. An unreadable `host-state.json` is kept as `host-state.json.corrupt` instead of being overwritten. `host-state.json` is now readable only by its owner (mode 0600, previously 0644) (car#1986).

- The assistant's `http_request` tool now decodes gzip, deflate and br response bodies, including when a server compresses a request that asked for `identity`, instead of returning the compressed bytes as the body. Decoding stops at the body cap, so a small compressed body that expands enormously is never decoded in full. A body that is not text after decoding (it contains a NUL byte) now comes back with its status, final URL and Content-Type, flagged `"binary": true` and with no body; one in a coding that cannot be decoded is flagged `"undecodable": true` with its `content_encoding`. Other HTTP clients in CAR are unchanged.

- `agents.invoke_external` now refuses an unbound caller holding only the daemon-wide token when a host token is configured. Hosts, supervised agents answering a host-started chat, and unbound developer clients on daemons without a host token keep working. This stops CAR from handing external-agent execution to a supervised agent that reconnects without its identity; it is not process confinement, because software running as the same user can launch an external CLI itself (car#2456).

- Release-lab setup and health now authenticate GitHub App requests with a Bearer header (the previous `gh api` call was rejected with HTTP 401), keeping the JWT out of process arguments.

- Release-lab nightlies now resume after post-tag upload, mirror, or verification failures by reusing the matching tag and releases, skipping assets whose SHA-256 already matches, and refusing conflicting tags.

- Release-lab operator keys are now readable by the `car-release` SSH account while remaining writable only by root.
- The installed release-lab forced command now resolves its setup-created symlink back to the service checkout before loading its libraries.

- LAN peer discovery no longer sends mDNS through point-to-point tunnel interfaces (macOS `utun*`/`ipsec*`/`ppp*`/`gif*`/`stf*`, Linux `tun*`/`wg*`/`ppp*`). A tunnel cannot deliver link-local mDNS to peers on the local network, and when a VPN tunnel ran out of buffers every advertise and browse send through it failed with `No buffer space available (os error 55)` and logged an error, filling the daemon log. A tunnel that comes up after the daemon starts is dropped within 5 seconds. Turning "discoverable" off and on no longer leaks an mDNS daemon thread and its sockets each time.
- `coder.start` now prepares the task workspace (the inputs snapshot, `git worktree add`, the session lease and snapshot writes) on the blocking thread pool, and a baseline check verifies its cache provenance (`git rev-parse`, `git status` over the copied tree) there too, so a slow checkout no longer holds one of the daemon's async worker threads.

- Organization-bound sessions can collaborate with the same organization's nodes on colleagues' CARs. A node bound to an organization is now published, tagged with its org, on Lattice connections that organization verified (and only those), so a colleague's sessions bound to the same org can list, find and message it; personal and other-org connections, and the owner's own devices, never carry it. Messages crossing CARs carry the sender's org in a new `carPeerFromOrg` A2A metadata field, which the receiving CAR accepts only over a connection that org verified and delivers only to that org's node; a message without it reaches only personal nodes. A sender older than this release sends no `carPeerFromOrg`, so its messages reach only personal nodes. A message the sender's context would refuse is now refused before a cross-owner hold, instead of waiting in the operator's queue first. Only contexts under the default Parslee authority cross CARs; an organization under a staging or self-hosted `api_base` stays on its own CAR.

- Organization collaboration across CARs is now covered end to end in the test suite: an organization question and its answer travel over the Parslee relay and between the same owner's devices to the receiving inboxes. No behavior changes.

- Organization-bound sessions on two of the same owner's devices can now find and message each other. A device speaks for an organization only from the device roster of the login that holds that organization on this CAR — not from the whole trusted own-device set, which spans every login signed in here. Organization rows in a Lattice listing now travel in a separate `org_nodes` field, so a CAR from before organization tags shows only personal nodes instead of presenting an organization's node as an ordinary one; this also covers colleagues' CARs on organization-verified connections. A cached remote listing is read only for the key that sent it. An organization's message to an own-device address that no listing showed as that organization's is refused before sending, except an answer. An agent that rejoins the Lattice in a different work context releases only the old context's claims, and the `display_name` check no longer reveals to an organization's agent which personal agents are running.

- The Lattice is per work context. A session bound to an organization (a supervised agent, `car claude` in an organization's repository, or an organization-bound `coder.start { lattice }` run) can now use `lattice.join`/`nodes`/`find`/`claim`/`release`/`claims`/`wait`/`leave`, which were refused there. Its node is listed and found only by sessions bound to the same organization and by the operator, is never published to another CAR or matched by an `agents:<project>` share, and its claims live in that organization's own table, so the same item claimed in two contexts no longer collides. Organization-bound callers see no human nodes or other CARs' nodes; personal callers no longer see organization nodes. Personal and MCP behavior is otherwise unchanged.

- Declarative agents pinned to an older Anthropic model (4.5 and earlier) with a saved `low`, `medium`, or `high` reasoning effort now run instead of failing before they answer. On Claude and OpenAI reasoning models the runner adds the reasoning budget on top of its answer allowance, capped at the model's output limit; other models keep the plain answer allowance, so a pin such as `gpt-4o` is not pushed past its output cap. The Anthropic request builder raises a thinking budget below 1024 tokens to that minimum and sends extended thinking only when the budget fits below `max_tokens`, and the automatic thinking budget for code and complex turns now shrinks to fit a legacy Claude model's `max_tokens` instead of being dropped (car#1989).
- Editing a pinned agent in CarHost's Agent Builder now shows its saved model, provider, and reasoning effort on the review screen instead of "Adaptive routing". "Save & rebuild" now keeps the fields set on the registered spec that the build never writes (the inference pin, a `self` context policy, the cadence request, `denied_tools`, and enabled state), read when the build runs. Before, a Builder rebuild reset all of them (car#1989).

- Fixed the agent-permissions reader so a symbolic link at `agent-permissions.json` pointing to an older-format policy file is no longer followed or remembered as the valid policy; the daemon keeps the last policy it read from the real file, or falls back to the cautious posture plus any readable denials.

- `m365_task` no longer reports success when the Parslee M365 service answers a task with its "Something went wrong on our end … quote code …" reply over HTTP 200. That reply now returns `ok: false` with an `error` and the support code in `support_code`.
- The assistant now records a tool result that reports its own failure (`"ok": false`, a non-null `error`, `"success": false`, or `"status": "Failed"` at the top level) as a failed call on its live chat row (`tool_failed` in `car do --json`), its receipt, its transcript result and its approval record, including an approved call replayed after a restart. One shared check now decides this for the live loop, the receipts rebuilt from a saved transcript, and receipt scoring, so they agree.
- Remote MCP connectors return a tool result marked `isError: true` as a failed call carrying its text, as stdio MCP servers already did, instead of as a successful result.

- macOS keychain writes no longer put any secret on the `/usr/bin/security` command line. Values too large for the helper's 4,096-byte stdin line, such as the roughly 7 KB Parslee auth state that used to appear in `ps` output for the duration of every write, are now stored as chunk items that each fit one line. Chunk items are created trusting `/usr/bin/security`, the helper CAR reads through, so any same-user process running that helper can read them without a prompt; keychain items CAR creates already allow any application, and for an older item whose access list excludes the helper this is narrower than before, when the whole value sat on a command line every same-user process could read. The existing item is still updated in place, keeping its access grants, and is never decrypted to prepare a write, so these writes add no prompts. Writes of one value are serialized across every CAR process of the user, and one keychain operation, including any wait, stays within 15 seconds. Chunks from a replaced value are removed after each write; if a removal fails, the next write or delete of that key retries it, and a delete that leaves a chunk behind reports an error. Values containing a newline or NUL are sent hex-encoded. An older CAR build on the same Mac cannot read a chunked value; it sees only a chunk marker where the value should be.

- The daemon's HTTP MCP endpoint no longer lists its token-gated daemon tools (`events_query`, `events_stats`, `events_cost_by_agent`, `workflow_verify`, `workflow_list_paused`, `scheduler_list`, and the opt-in mutations) to a caller with no Authorization header. Such a call always failed with "daemon MCP tools require the caller's Authorization: Bearer token", and the Claude Code plugin's `car-local-peers` server sends no header, so its sessions were shown tools they could never use. The peer and Lattice tools on the same endpoint work without a token and are still listed (#2526).

- `car models fit` no longer names a smallest Mac for a row CAR cannot run on Apple Silicon. Each row now reports `platform_compatible` (the check `models.list_unified` and the recommender apply), and a row that fails it, such as a GGUF/Candle row whose memory would fit, gets `smallest_mac_gb: null` under both policies. `scripts/discover-candidates.py --draft` shows such a row as `n/a`, marks it `platform_compatible: false` in `draft-rows.json`, and keeps its sizes as marked estimates when the `car` it runs predates the check.
- CarHost's Model Library no longer offers "Download & Use in CAR Chat" for a model this Mac cannot run (a GGUF/Candle row in the "don't fit this Mac" disclosure). An installed copy stays usable as before.

- `car mp submit` and `car mp check` no longer fail with "daemon read timeout after 30s of silence" while the work item's contract is still running. Both run the whole contract (builds and test suites) inside one daemon call, which shared the generic 30-second client read timeout; every real Build submission was reaped mid-compile, and the dropped connection cancelled the daemon's run. They now wait up to an hour, or longer if `CAR_DAEMON_TIMEOUT` is set higher.

- CarHost (macOS) and the Windows tray host now start a new Multiplayer Build on the model entered in the Multiplayer screen's model field, as taking a stage already did. Before, `coder.start` was sent without it and the Build ran on the daemon's configured default model. A blank field still leaves that default in charge.

- Nightly releases can now pass a read-only Mac-side verification before Linux, Windows, pip, and npm catch up, with cross-mirror checksums, notarization, build identity, and update-feed checks reported separately.

- Agents made with Build an Agent can do an everyday office job. Each one
  keeps a folder, `~/CAR Agents/<agent name>` unless you pick another, that
  holds its inputs (such as a Word template) and everything it makes. It
  reads and writes only inside that folder and runs no shell commands, and
  links already in its folder can't lead it out: it won't follow a link that
  points outside or change a file that is hard-linked from somewhere else.
  In the access step you can let it read Mail on this Mac: it can find and
  read messages but is never given a way to write drafts, send, reply or
  forward. New tools add a row to an Excel or CSV spreadsheet (after the last
  row with a value, on the first visible sheet, writing into a formatted empty
  row rather than skipping it) and fill a Word template's `{{placeholders}}`
  (including ones Word split), with no Office scripting. A template with a
  placeholder left without a value, or anything still shaped like one after
  filling, is not saved; the agent is told which ones. Spreadsheets and Word documents change only through these tools, never
  by a plain file write. Text that starts like a formula is written as text, a row with every
  value empty is refused, a hidden row or column (or a sheet that hides rows by default) is never
  written into, and a file
  that is a link is refused. A file they can't
  edit safely, such as a sheet with merged cells, an Excel table, a PivotTable or a filter, is left
  unchanged with a plain message saying what to fix. A line break in a value
  becomes a real line break in the Word document. Test runs during a build
  use a whole copy of the folder (a folder too big to copy is refused with a
  message). A run whose spreadsheet or Word step failed on a file, and was not redone on that file, reports "The agent
  stopped without finishing" with the reason, whatever its last answer says. The Inbox Brief starter now really reads Mail.
  Agents that keep a folder are not given the Parslee platform tools (they
  write to a connected cloud drive, not the folder); rebuilding an older agent
  that had them says so on the review step. Spec fields: `working_folder`, and
  `builder_draft.mail_access` / `.working_folder`.
- In Build an Agent, the delivery answer is optional (an agent saves its
  work in its folder and says what it made), a step that can't continue yet
  says what it needs, the agent's folder is shown in plain words ("In your
  home folder › CAR Agents › …", full path on hover) on the builder and on
  the agent's page, and the build plan shows in a few lines what you are
  approving; its check reads "Runs after you approve" until you do.
- You pick the model that builds an agent on the review step (Automatic, or a
  connected model that is ready now). The build never waits on a model
  download: spec generation and test runs prefer models that can answer now,
  a chosen model that doesn't answer stops the build at once with a plain
  message, and the build screen shows what it is doing and for how long.

- macOS setup's About-you page no longer treats a failed profile read as an empty profile. A failed read is retried on the next refresh and before saving, and Save refuses with "Couldn't read your saved profile" rather than overwriting stored details the page never loaded. A profile that arrives late merges in without losing typed answers or stored details, and when Save is what loaded it, Save stops with "Loaded your saved profile — review and Save." instead of writing answers the user has not seen. The seeded first task now offers calendar or email work only when the assistant advertises the `calendar_events` or `mail_search` tool, the same rule Chat's starter cards use, and its file suggestion uses Chat's wording. The approvals step now shows the preset the daemon actually enforces, so selecting the row that looks current cannot quietly replace a default changed in Settings (#1694).

- `car-mcp --collaboration`: `peer_inbox` now drains messages already queued in the adapter while the local daemon is down or restarting. It used to need a daemon round trip first, so an outage returned a connection error instead of the queued messages, and an adapter that exited before the daemon came back lost them. Each poll still reconnects, so a session that only polls its inbox re-attaches after a daemon restart. The poll's identity check waits at most 5 s for the daemon's answer, while connecting keeps its own timeouts; the result's new `broker` field reads `connected` or `unreachable: <reason>`. A daemon that fails the identity or context check still blocks the drain until a later check passes. `collaboration_status` during an outage now returns `available: false` with the reason, the launch context and the `queued` count instead of an error. The inbox is still ephemeral; every other collaboration tool still needs the daemon.

- Promoted stable releases are now verified across 13 named areas without waiting for the bookkeeping pull request, including tag provenance, notarization, Linux arm64, and docs from the promoted nightly. crates.io is the one channel where "never recompiles" does not hold.

- Fixed Python task and chat helpers so concurrent calls route tool requests only to their own handler and leave the caller's registered handler unchanged.

- A rate-limited, failing or unreachable Parslee is no longer reported as a sign-in problem. `car do` stopped telling you to run `car auth login` when the Parslee account lookup answered HTTP 429 or a 5xx, the coder loop no longer pauses for a sign-in on those, and `parslee.capabilities`, `parslee.auth`, the Studio and product-gated `parslee.*` tools, and the `car coder-ab` Jev arm now return the real failure instead of "not signed in", and queued feedback reports hold with that failure instead of asking you to sign in. Only an HTTP 401 (the status Parslee returned, not one quoted in its error body), or a session answer naming no signed-in account, still counts as a sign-in failure. A 403 means the account is signed in and lacks access, so it is now reported as access denied — "ask an organization admin" — instead of advising `car auth login`. Any provider's `API returned <status>:` error is likewise judged by its status, so a 400 or 503 whose body quotes "401 Unauthorized" no longer advises signing in again.

- Prevent an authenticated daemon client or supervised agent's governed-skill approval from authorizing another recipient's identical candidate on the normal session and per-agent memory paths.

- Personal work now refuses organization-scoped credentials instead of silently adopting the issuer's default organization, while account-pinned cross-device sync continues using the signed-in account's selected organization.

- Release CI now gets the lab build ID only from its lab-mode detector, so Linux and Windows binaries retain the annotated tag's build identity instead of relying on the lightweight tag ref created by checkout.

- Release-lab setup now removes the administrator's Azure session even when a later step fails after bootstrapping the durable `car-release` session, without logging out the service account or hiding the setup failure.

- Add a read-only release baseline capture and comparator so pre-lab releases, package registries, update feeds, the main ruleset, and the operator Mac can be checked for unintended changes.

- Release CI now recognises a nightly cut by the release lab (an annotated tag with a `Build-Id:` trailer) and only catches up: Linux and Windows build as the base version with the build ID, their files are attached to the release the lab already created on GitHub and on car-releases, the nightly npm and PyPI packages publish as before, and nothing creates, edits or deletes a release or touches a macOS file. Each finished lane leaves a `catch-up-<linux|windows|pip|npm>.txt` marker on the release. Tags without the trailer build exactly as before.

- Release lab promotions no longer rebuild anything in CI. When a stable tag carries both `Build-Id:` and `Promoted-From:`, `build.yml` skips every build, test, release, mirror and attach job and runs one `promote-publish` job: it waits up to an hour for the lab's `promotion-assets-complete.txt` on both the primary and the car-releases stable release, relabels the nightly's wheels to the stable version and publishes them to PyPI, publishes the npm package as `latest`, and records `pypi-latest-moved.txt` and `npm-latest-moved.txt` on the primary release before the usual install smoke tests run. A laptop promotion (`Promoted-From:` without `Build-Id:`) runs the normal path unchanged.

- Release-lab setup now finds an existing Apple Silicon Homebrew installation in fresh SSH shells instead of rerunning the Homebrew installer.

- Release-lab nightlies now attach failure markers and notify GitHub and Teams when Linux, Windows, pip, or npm catch-up fails, including the Actions log and exact failed-job rerun command.

- Added the `car-release` laptop client for non-interactive nightly planning, promotion and status commands against the release lab, with a three-line initial plan, local fake-lab testing and refusal of malformed versions before connecting.

- Release-lab setup now keeps its service checkout detached at the exact selected commit and repairs clean checkouts left attached to `main`, without letting a mirror fetch move any checked-out branch.

- Fixed release-lab nightlies so forced-command and detached preflight runs use the setup-managed toolchain, the advertised detached `nightly --dry-run` admission probe cannot create or publish a release, GitHub App tokens use the required Bearer authentication, and token-mint failures are reported before planning instead of hidden behind a later refusal.

- Release-lab Mac process watches now distinguish fleet scratch and worktree Rust builds from release-checkout builds without recording process paths or arguments.

- Release-lab setup now validates its GitHub App through the documented App identity endpoint instead of a nonexistent installation endpoint.

- Release-lab health now identifies a blocked signing phase without signaling Keychain clients, runs in the service account's Background launchd context, and provisions a pinned Sparkle signing tool during setup.

- Release-lab health now runs its secret scanner on the managed Python runtime, preserves bounded scrubbed output from failed tooling tests, and keeps concurrent client/server fixtures from deleting a live initializing release lock.

- Release-lab health now validates the configured GitHub App through its App JWT and ignores unrelated issue or pull-request activity when checking inert write permissions.

- Release-lab health self-tests now pass under the service account's restrictive umask and nested health context, and a failed tooling suite reports its first failing assertion before the bounded output tail.

- Add a release-lab health command that checks pinned tools, lab credentials and GitHub App permissions without publishing, free disk, headless signing, scheduler state, and the release tooling tests.

- CarHost now shows the release-lab build ID in About, uses its date as Sparkle's numeric bundle version, and compares daemon build identity when available.

- Release-lab runs now erase temporary signing material and scratch keychains after every exit, remove disposable build output, and retain only the most recent 30 days of nightly archives.

- Release-lab failures now open one GitHub issue per failing step (labelled release-failure), comment on repeats, and comment when a later run of the same kind succeeds, without ever closing an issue; if GitHub is down the run is unaffected and the post says the issue could not be filed.

- Added read-only release-lab probes that verify a lab run did not start local release builds, grow local release staging or `~/.car-release*` by 1 GiB, restart the live CAR daemon, change its daemon LaunchAgent or CarHost identity, or re-enable its retired 03:30 nightly job.

- Release-lab operators can now update the detached service checkout to an allow-listed reviewed branch with `car-release update`, which refuses active runs, validates setup and quick health in the service account's Background context, and rolls back a failed update without requiring sudo.

- Release scripts now have an off-switch for laptops: once the release lab becomes the release path, `release.sh`, `release-bootstrap.sh` and `nightly-release.sh` refuse to run anywhere but the lab and point to `car-release`. The switch is not turned on yet, so nothing changes today.

- Release-lab health and schedule commands now load the setup-managed toolchain environment, keep generic `python3` on the pinned 3.13 interpreter, and mint a fresh GitHub App token when schedule state is mirrored off the lab.

- Added a 7 AM Eastern GitHub Actions alarm that posts to Teams when no complete nightly was published the night before, naming the last nightly and why (a running promotion, a stuck main, or no lab report).

- Release-lab nightlies now plan from the newest main commit whose live required checks and daemon-client reachability check are all green, while explaining skipped, cancelled, stuck, and no-build outcomes.

- Add the release lab's nightly runner (`scripts/lab/lab-nightly.sh`): one command on the lab plans the nightly, refuses on a bad toolchain or credential before building, builds and notarizes the Mac files from a fresh checkout, tags with the build ID, publishes pre-releases on both GitHub repositories with every macOS file attached, adds the nightly appcast entry, and runs the Mac-side verifier, cleaning up the signing keychain and build output on every exit. The Key Vault credential and scratch-keychain setup moved from `release-bootstrap.sh` into `scripts/lib/release-credentials.sh` so the laptop release and the lab share it unchanged.

- Release-lab Teams notices now link the filed GitHub issue, report when filing failed, and explain when a run is not promotable because platform catch-up failed.

- Release-lab run records can now be rendered as one scrubbed Teams post and one GitHub issue body, with plain step names, the step's useful failure lines, and either the exact retry command or the runbook action a person must take.

- Added per-person release-lab SSH access with forced commands, isolated revocation, and team-name attribution in release history.

- Release-lab operators can now read the latest or a named run's scrubbed, size-bounded run, after-finish, and notification logs with `car-release log [run-id]`, without shell or sudo access.

- Added release-lab preflight refusals for pinned toolchain drift, missing release tools, unusable GitHub or Azure identities, an unreachable release vault, and insufficient disk space before a build can start.

- Release-lab Mac process watches now discard unrelated process arguments and scrub the remaining CAR build metadata before writing evidence.

- Lab promotions publish the stable changelog directly from the promoted nightly's fragments, record consumed fragment names on the stable tag, and open the main bookkeeping pull request from an isolated worktree only after verification, without switching or moving branches in the operator checkout.

- Release-lab promotions now stop before publishing when the source nightly is untrusted, stale, unfinished, missing catch-up builds, already used, targeted at the wrong stable, or blocked by another run; status reports the same refusal reason.

- Add the release-lab stable promotion runner, including artifact relabeling, dual-release completion markers, registry and verifier gates, resumable publication, and post-verification bookkeeping.

- Release lab promotions now publish the stable winget manifests and public car-releases documentation from the promoted nightly before moving PyPI or npm to the stable version; repeating the promotion leaves the already-published copies unchanged, and the full stable verifier checks the rendered winget files alongside the docs mirror.

- Added the release lab's credential and setup proposals under `docs/release-lab/` for maintainers, including idempotent Azure secret reconciliation with a temporary vault-scoped write role.
- Documented the exact pause, retirement, cleanup, and verification commands for Keenan's retired 03:30 nightly job.

- Release-lab setup now installs its forced-command server link so both the administrator and `car-release` can resolve it, and repairs the unreadable mode-0700 link left by older setup runs without replacing a correct link.

- Added promotion tools that turn a lab nightly into stable wheels, a re-signed and notarized CarHost app, and an installer without recompiling CAR binaries, with signature-stripped hash checks for the reused code.

- Release-lab setup now uses its resolved Homebrew prefix for command discovery, so setup and check-only finish successfully in a fresh administrator SSH shell without profile initialization.

- Release-lab setup now refuses root callers before changing Remote Login, preventing a fresh Mac from creating an SSH allow-list that omits the rental administrator.

- Release-lab runs now mirror scrubbed metadata, logs, schedule state, and blocked-run reasons to the private off-lab records repository after every step and at completion, while remote failures remain non-fatal and direct teammates to `car-release status`.

- Added an internal release-lab runbook covering fresh-machine setup, pinned tools, dedicated identities, credential rotation, operator access, client use, failure recovery, scheduling, retention, outages, and moving to another Apple Silicon Mac.

- The release lab gains an off-by-default nightly scheduler: `schedule.sh on|off|show` controls a 03:30 job that starts the nightly, waits behind a running promotion until 06:45, and then records why it was blocked.

- Release-lab dry runs now find `notarytool` through the selected Xcode when it is absent from the service account's restricted `PATH`.

- Added the release lab's SSH command entry point with detached runs, one-run locking, status history, verifier-gated completion, and recovery after an interrupted lab run.

- Release-lab setup now validates the pre-login retention job without repeatedly reinstalling it, reads Remote Login with administrator authorization, and prevents ephemeral GitHub App tokens from reaching Git credential helpers.

- Release-lab setup now installs the real nightly LaunchAgent disabled until `schedule.sh on`, removes the obsolete scheduler plist, and disables the obsolete scheduler job on existing labs.

- Release-lab setup now checks service-owned files as `car-release`, so rerunning setup recognizes an existing mode-700 lab home instead of trying to recreate its mirror, checkout, and configuration.

- Release-lab setup now works for the `car-release` service account on a fresh Mac: it keeps its scratch files under `/private/tmp` instead of the administrator's private `TMPDIR`, runs Homebrew with shared permissions and checks that `car-release` can run every installed tool, registers Metal for `car-release` itself, keeps the Azure lab certificate at a fixed root-protected path so token refresh keeps working after setup exits, and recognises the Homebrew 7 Azure CLI cask as already installed.

- Release-lab setup now installs and verifies the exact commit running setup by default, supports an explicit named source ref, and refuses missing refs instead of falling back to `main`.

- Added an idempotent release-lab bootstrap that pins the Apple and Rust toolchains, installs release dependencies and lab identities, caps builds for 16 GB of RAM, and leaves scheduled nightlies disabled until Target 1 passes.

- Release-lab setup now makes SSH key-only once the administrator bootstrap key is installed: it refuses to run without that key, installs an `/etc/ssh/sshd_config.d` drop-in that turns off password and keyboard-interactive login while keeping public-key login for the administrator and forced-command keys for `car-release`, and checks the effective `sshd -T` configuration, so wrong SSH passwords can no longer lock the administrator account and block the valid key. The runbook now limits the vault password to the provider console and the first bootstrap login.

- Release-lab retries now resume at the failed step, avoid duplicate publication after a crash, and show the exact failed-step log excerpt and retry command.

- Release-lab retention, notice draining, and scheduled nightlies now run as `car-release` system LaunchDaemons, so they recover after reboot without automatic login or a stored login password.

- Add the release lab's Teams sender: one post per run to the one channel through an incoming webhook, with failed posts spooled and delivered later, marked with the time the outcome really happened, and never blocking a release.

- Release-lab shell test suites now come from independent list files, so parallel suites can merge without both editing the hosted and local CI definitions.

- `car-release update` now runs directly in the operator-key SSH session instead of attempting the root-only `launchctl asuser` transition, and clearly names Background-only health checks it skips.

- Added a shared release-output scrubber and secret scanner so credentials and private operator details are removed from lab logs, status output, notices and issue text.

- Release preparation now stops with a clear error when selecting the preceding published tag fails, instead of treating that failure as a first release.

- A remote request whose connection never opened (refused, unreachable host, or the 10 s connect timeout elapsed) is now retried up to 3 attempts with 3 s and 6 s backoff, within any armed `infer.deadline`, on the remote paths that used to send exactly once: openai-codex (buffered and streaming), Parslee managed inference (buffered and streaming, its org and session lookups, and System One), AWS Bedrock, streaming requests to every other remote provider, OpenAI-compatible embeddings, and ElevenLabs speech-to-text and text-to-speech. Only connect failures are retried. A timeout, reset, or truncated body after the request was written is reported and never resent, because the provider may already be running and billing it. Before this, one connect timeout to chatgpt.com ended the call on its first attempt, which could fail a pinned `car code` session during contract derivation before any work began. When every attempt fails to connect, the error begins with `could not reach <host> for <N>s (<attempts> attempts)` and keeps the transport detail after it. It is reported as a transient failure, so `car run-task` classifies it as `infra_inference` (re-run) rather than a configuration error. A Parslee session lookup that gets no answer no longer caches the `car` placeholder user id for the life of the sign-in.

- A model ID that the signed catalog revokes no longer comes back after a restart from the unsigned provider discovery cache, and a revocation that arrives while the daemon runs removes a provider-discovered row with that ID. The cached row stays on disk, and a later catalog that lifts the revocation restores it immediately, never over a row the user registered.
- The release link gate (`scripts/check-public-doc-links.sh`) now excuses a `car.parslee.ai` 404 as pending only when the sync script publishes that exact path. It used to match the filename alone, so a broken link such as `/wrong/README.md` passed because `README.md` is published elsewhere. Files under `examples/` and the WebSocket namespace files now count as published, and a URL template such as `/websocket-protocol/<namespace>.md` is no longer fetched as its prefix.

- Fixed daemon capability discovery so operator-only multiplayer, sandbox-binding, and fleet-enrollment methods are no longer advertised to supervised agents, while Lattice methods report their attached-agent ownership requirement.

- `runs.start` retried after a failed run-index append now lists the run. Before, if other runs started between the failure and the retry, the retry reported success (or failed with "run summary index contains a duplicate sequence") while `runs.list` left the run out until the daemon restarted. A retried run that has to be re-sequenced lists as the newest run in paginated `runs.list`.

- Security: rustls updated to 0.23.46 for four advisories against 0.23.45: RUSTSEC-2026-0346 (the `Debug` output of TLS client session values included the TLS 1.2 master secret or TLS 1.3 resumption PSK), RUSTSEC-2026-0347 (after an ECH rejection, buffered application data could be sent to the outer server), RUSTSEC-2026-0348 (brotli certificate decompression could allocate up to 1 GiB before authentication) and RUSTSEC-2026-0349 (an unauthenticated ServerHello could downgrade later connections to classical key exchange).

- `car lattice connect share` now warns, on stderr, for each shared name that is not a Lattice node on this CAR yet: a stopped agent, the built-in assistant before it joins, or a typo. The share is still kept, because sharing a node before it joins is supported. But the other CAR sees nothing to address until it joins, and the command used to report plain success (#2523).

- Approving an agent build no longer overwrites a different agent. An edit starts from the agent's registered spec and records which version it edits, and every approval records the version it registered; a build is refused, with nothing committed or registered, if that agent was removed, changed, or its id was taken by another agent. Reopening a changed agent restarts the edit from its current version. Approving an edit no longer re-enables a disabled agent, and the declarative-agent registry refuses to write over a `declagents.json` it cannot parse instead of emptying it.

- Fixed a Parslee login removed outside the daemon (the `car auth` CLI) keeping its devices trusted until restart when the credential-authority hint could not be updated. `sync.pump` now re-lists the held logins on a five-minute fallback schedule even when the hint's generation has not moved, so a removed login's devices, the boot login's included, stop being trusted on the first `sync.pump` once five minutes have passed since the last unprompted (fallback) listing attempt, provided that listing succeeds. A listing prompted by a generation change or a `setup_failed` retry does not reset that clock unless it fails; a failed listing restarts the five-minute clock. A generation change can prompt an earlier listing.

- Parslee Core chat: the next turn on the same session after a Stop now asks for approval again when it repeats a call the stopped turn made. A stopped turn (or a halted goal turn) was dropped from the session's thread, so the next turn numbered its call ids from the same place, reused the stopped turn's durable action identities, and refused the call as "terminal and cannot be replayed" without showing a card. The stopped turn now stays in the thread and its checkpoint, and any call it never ran reaches the model as stopped. A turn sent while another turn of the same session is still running now waits for it, instead of numbering its calls from the same thread and overwriting the other turn's exchange.

- Reopening an existing Agent project now requires agent-build authority even when the request labels it as an app; the project's stored type decides the gate.

- Tool-calling turns no longer report zero output tokens. Apple FoundationModels now counts a captured tool call's name and arguments as completion tokens, streamed or not; its streams also report usage now, which they never did. Gemini thinking models' `thoughtsTokenCount` is counted as output in both the streaming and non-streaming parsers. Where a provider or delegated runner reports no usage (or a zero output count for a turn that visibly generated something), the routing profile's output estimate now covers the text and the tool calls at ~4 bytes per token, replacing the whitespace word count of the text alone, so a tool-only answer is no longer booked as zero tokens and keeps its mechanical-success credit. A delegated runner's own output count is now what its turn books. The remote key pool's `total_output_tokens` used to be 0 on every call; it now records the provider's `completion_tokens`, and `total_input_tokens` records the provider's whole input count, cached part included, when one is reported. Streamed remote calls now return their key lease and book their tokens; before, every stream left a phantom in-flight request on its key, which skewed every later key choice. A retried non-streaming call now holds one in-flight slot rather than releasing it once per failed attempt. The delegated runner's generation span now carries the usage the runner reported (car#1765).

- Fixed turn receipts scoring web actions backwards: a `web_search` that returned no results is no longer marked verified, and an `http_request` GET whose final response was 2xx with a body (or binary content) is now verified instead of only attempted. A result that reports its own failure (`"ok": false`, `"success": false`, a non-null `error`, a `browse_wait` that was not met, a `browser_await_answer` that did not settle, a timeout) is never verified. A write is confirmed only by a later verified read naming the same object id; fetching the URL a write targeted with `http_request` no longer confirms it, while a browser read at the page a browser write navigated to (`browse_observe`'s `url`, with a trailing `/` added or dropped) confirms it. A receipt's `requested_url` evidence now gets the same scrub as the rest of the tool result (tokens and long high-entropy runs are masked, not only credential query values), so it compares equal to the page a later read reports.

- CarHost: **Use in CAR Chat** in the Models tab's **Set up a model** section now selects the local model for CAR Chat. It used to report the model ready in Chat while saving the choice to the shared `ai.parslee.car` preferences, which Chat no longer reads, so Chat kept using the home's saved choice (adaptive routing by default). Setup's "Set up a local model in Settings → Models" link now opens the Models pane instead of whichever pane Settings last showed. Setup progress, a model choice, or a verified mark an earlier build saved to the shared preferences is moved into the current CAR home on the next launch (the home's own value wins if it has one, and verified marks are combined) and removed from the shared preferences, so wiping `~/.car` no longer brings it back.

- The coder's verifier and auditor now get their own tool-call refusals as runtime feedback, where before they came framed as untrusted tree data they were told to ignore. In one observed session a `run_check` without `outcome_id` took three tries because the correction was framed as data to ignore; the refusal now names the accepted shape `{"check":"<name>","outcome_id":"<id>"}`. This covers argument errors from `run_check`, `shell`, `read_file`, `list_dir`, `find_files` and `grep_files`, dispatch-allowlist refusals (including the auditor's refusals of `grade` and `run_check`), and `grade`'s Page and Artifact evidence requirements. A shell probe the command policy refuses now says "shell refused by runtime policy", with only the policy's reason framed. Any argument a refusal repeats back is quoted and capped at 120 characters, so it cannot forge a runtime line. Probe output and anything else that can carry repository content stay framed.

- CarHost setup's **Enroll my voice** on a Mac with no audio input device now shows "No microphone found. Connect one and try again." instead of terminating the app. The iOS host's push-to-talk recording shows the same message instead of crashing when the device reports no audio input.

- `web_search` reports a failed search as an error instead of an empty one. Before, when DuckDuckGo throttled CAR (HTTP 202 with a challenge page, or 403/429), when its result page answered an error status, or when the page could not be reached, the search returned `results: []` with the note "No results were found", so the agent could not tell a throttled search from a search that found nothing. It now returns an error naming the cause. When the instant-answer fallback still has an answer, that answer comes back with a note naming the result-page failure. An error status from the instant-answer fallback is also reported as a failed search. A result page that loads and holds no results is still reported as no results.

- Fixed Windows coder checks being allowed to write outside the worktree through cmd expansion: a `%NAME%` variable such as `%USERPROFILE%\.ssh\config` (including one whose closing `%` is later on the line), a `for` loop variable such as `%~i`, or a delayed-expansion `!NAME!` is now refused as a write target or `cd` destination. `copy`, `move`, `xcopy`, `robocopy` (and its `/LOG:` files), `md` and `mklink` destinations are now checked too, including a destination with a redirection glued to it (`copy a C:\out>nul`), and `chdir` is tracked like `cd`. The runtime's own check roots still work under any letter case (`%car_check_tmpdir%`), and `%CD%` still resolves to the check's current directory.

- Windows CI is green again: a Unix-only test helper in the declarative-agent builder (`MarkerScript`) is compiled only on Unix, like the one test that uses it.

- The Windows lint gate passes again: the allowance for unix-only test fixtures is now an outer attribute, which Windows clippy accepts.

- The Windows tray's Approvals screen now says when an Approve or Deny did not land: the daemon refused it, another decision had already resolved the approval, or the connection dropped before the daemon answered. It used to show nothing, so the decision looked taken.
- A failed refresh of the tray's approvals, activity, chat-agent or coder list now keeps the last list and shows the error, instead of emptying the list into "No pending approvals" and similar. A chat turn whose cancel the daemon refused now says in the transcript that it may still be running.

- Windows CI is green again: test fixtures that only unix-only tests use (added with the Build an Agent run check) no longer fail the Windows clippy gate as dead code.

See the [release notes][v0.58.0].

## [v0.57.4] — 2026-10-11
Changes. See the [release notes][v0.57.4].

## [v0.57.2] — 2026-10-10
Changes. See the [release notes][v0.57.2].

## [v0.56.1] — 2026-10-07
Changes. See the [release notes][v0.56.1].

## [v0.55.0] — 2026-09-21
Changes. See the [release notes][v0.55.0].

## [v0.54.0] — 2026-09-15
Changes. See the [release notes][v0.54.0].

## [v0.53.0] — 2026-09-09
Changes. See the [release notes][v0.53.0].

## [v0.52.1] — 2026-09-04
Added; Fixed; Security. See the [release notes][v0.52.1].

## [v0.52.0] — 2026-09-04
Added; Fixed; Added. See the [release notes][v0.52.0].

## [v0.51.0] — 2026-08-30
Changed; Added; Fixed; Changed; Fixed; Changed; Added; Changed; Fixed. See the [release notes][v0.51.0].

## [v0.50.0] — 2026-08-25
Fixed; Added; Changed. See the [release notes][v0.50.0].

## [v0.49.0] — 2026-08-23
Security; Fixed; Changed; Added; Fixed; Added; Fixed; Added. See the [release notes][v0.49.0].

## [v0.48.0] — 2026-08-18
Added; Added; Fixed; Added. See the [release notes][v0.48.0].

## [v0.47.0] — 2026-08-08
Added; Changed; Added; Fixed. See the [release notes][v0.47.0].

## [v0.46.1] — 2026-08-06
Fixed. See the [release notes][v0.46.1].

## [v0.46.0] — 2026-08-05
Added; Changed; Fixed. See the [release notes][v0.46.0].

## [v0.45.0] — 2026-08-01
Added; Added; Fixed; Added; Fixed; Added. See the [release notes][v0.45.0].

## [v0.44.0] — 2026-07-31
Added; Changed; Fixed. See the [release notes][v0.44.0].

## [v0.43.0] — 2026-07-31
Fixed; Changed; Added; Added; Added; Fixed; Fixed; Fixed. See the [release notes][v0.43.0].

## [v0.42.0] — 2026-07-30
Added; Changed; Fixed. See the [release notes][v0.42.0].

## [v0.41.0] — 2026-07-28
Added; Security; Changed; Fixed. See the [release notes][v0.41.0].

## [v0.40.0] — 2026-07-23
Added; Fixed. See the [release notes][v0.40.0].

## [v0.39.1] — 2026-07-21
Fixed. See the [release notes][v0.39.1].

## [v0.39.0] — 2026-07-21
Added; Fixed. See the [release notes][v0.39.0].

## [v0.38.0] — 2026-07-17
Changed; Fixed. See the [release notes][v0.38.0].

## [v0.37.0] — 2026-07-16
Fixed; Added. See the [release notes][v0.37.0].

## [v0.36.0] — 2026-07-15
Fixed; Added; Added; Fixed; Changed; Security; Changed: safer, higher-signal built-in coding tools (H1 in the CAR coding-runtime audit 2026-07-06); Fixed: extended thinking on CAR-native coding (Anthropic). See the [release notes][v0.36.0].

## [v0.35.0] — 2026-07-06
Added: version-skew detection + car update self-updater; Fixed. See the [release notes][v0.35.0].

## [v0.34.0] — 2026-07-06
Added: cross-device sync via the Parslee backend (#527, #528, #533); Added: Windows desktop accessibility tree via UI Automation (#530); Added: Microsoft Graph write scopes + mutations (#531); Added: cross-platform sound-event classificati… See the [release notes][v0.34.0].

## [v0.33.0] — 2026-07-04
Added: daemon-native deterministic scheduler (tasks.*) — car-releases#72; Fixed: car-accounts enumerated only iCloud, not all Internet Accounts — car-releases#73; Added: complete onboarding wizard + per-agent approval permissions; Changed:… See the [release notes][v0.33.0].

## [v0.32.1] — 2026-07-03
Fixed: v0.32.0 macOS daemon dead on arrival — car-server SIGABRT at launch (missing Swift rpath). See the [release notes][v0.32.1].

## [v0.32.0] — 2026-07-02
Added: multi-device sync B6 — the sync.* / lease.* wire surface, dispatch fence, and E2E encryption boundary; Added: multi-device sync B2 — transcript resume (car-sync); Fixed: B2 transcript resume — kernel-review hardening (car-sync) + ne… See the [release notes][v0.32.0].

## [v0.31.0] — 2026-06-25
Added: car purge — clean removal of a CAR install's own state; Added: car doctor — offline install diagnosis + repair; Added: self-healing model load — a corrupt cache re-pulls and retries instead of failing; Fixed: presence-only HuggingFa… See the [release notes][v0.31.0].

## [v0.30.0] — 2026-06-24
Removed: judged task_33 (probability) — no local-tier signal (#421); Changed: judged track — better local-tier discriminators (#405); Changed: judged track no longer lets a contestant grade itself (#405); Fixed: gpt-5.5 rejected every call… See the [release notes][v0.30.0].

## [v0.29.0] — 2026-06-23
Changed: router seed ships local-model PERF, not quality (benchmark doesn't discriminate yet); Fixed: benchmark contribution flow — MoE discovery + a per-row perf trust gate; Added: CAR supervises the vllm-mlx server — multimodal models "j… See the [release notes][v0.29.0].

## [v0.28.0] — 2026-06-20
Added: secret.list / secretList — enumerate stored secret names for a CarHost Secrets pane (#366); Added: router quality follow-ups — frontier-less guard, above-frontier telemetry, shadow calibration (#369, #370, #371); Changed: benchmark … See the [release notes][v0.28.0].

## [v0.27.0] — 2026-06-18
Added: agent-chat surface — converse with create-car-agent agents (car#364, car#365); Added: local (in-process) tool-calling for Qwen3, plus honest tool-capability routing; Docs: clarify conversation persistence after the 0.25 store remova… See the [release notes][v0.27.0].

## [v0.26.0] — 2026-06-17
Changed (breaking for external Rust consumers of car-inference); Added: stakes-aware routing for the in-process autonomous loops; Added: stakes-aware routing for the coder loop; Added: persistent outcome scoreboard (outcomes.scoreboard — t… See the [release notes][v0.26.0].

## [v0.25.0] — 2026-06-15
Fixed: model-path follow-ups (streaming telemetry, sampler, stop sequences, etc.); Added: car run-task completion-discipline mode (experimental, opt-in); Fixed: MCP tool errors (isError: true) were silently surfaced as success; Fixed: Pars… See the [release notes][v0.25.0].

## [v0.24.1] — 2026-06-14
Fixed: CUDA-built Linux artifacts now load on machines without CUDA installed; Fixed: McpSubstrate spoke a wire protocol no bridge implements — every VM op failed; Fixed: car run-task sent dot-named inference tools to the model, 400ing Ant… See the [release notes][v0.24.1].

## [v0.24.0] — 2026-06-14
Fixed: resumed releases no longer break Sparkle signatures (publish-appcast-entry.sh) — closes #272; Security: Windows auth-token encrypted at rest with DPAPI (#295); A2UI Image accepts inline data: URIs (car-releases#57); Fixed: tool-call… See the [release notes][v0.24.0].

## [v0.23.0] — 2026-06-06
Added: proactive model concierge (car-inference, car-server, CarHost); Fix: Apple Silicon detected as CPU, hiding MLX models from the recommender (car-inference). See the [release notes][v0.23.0].

## [v0.22.1] — 2026-06-05
Fix: CarHost Runs tab no longer renders a blank "Run trace" pane (CarHost). See the [release notes][v0.22.1].

## [v0.22.0] — 2026-06-05
Added; Fixed. See the [release notes][v0.22.0].

## [v0.21.0] — 2026-06-04
Calendar event mutations across the integration surface; A2UI: standard components CAR's catalog lacked — Icon, Video, AudioPlayer, DateTimeInput; Web renderer: CAR-only components rendered (A2UI component-set extend); A2UI v0.9 form-input… See the [release notes][v0.21.0].

## [v0.20.0] — 2026-05-30
First-class model UX — intent → recommend → keep current. See the [release notes][v0.20.0].

## [v0.19.0] — 2026-05-29
Fix: Windows platform findings from issue #231 (car-registry, car-inference, car-ffi-common, car-cli); Added: car tail-log <id> (alias car logs) (car-cli) — #231 §5.2. See the [release notes][v0.19.0].

## [v0.18.0] — 2026-05-26
Fix: MLX backends fail cleanly when mlx.metallib is missing instead of aborting (car-inference); Fix: Host.app Chat tab renders the done.text reply from supervised agents (CarHost); Fix: verify now validates tool_call parameters against re… See the [release notes][v0.18.0].

## [v0.17.0] — 2026-05-24
Note: car video LTX-2 multi-issue (Parslee-ai/car-releases#53); Add: images parameter on infer_tracked (NAPI + PyO3); Diagnostic: log dropped agent.chat.event forwards; Fix: CarHost dashboard window stays open when clicking away; CarHost: … See the [release notes][v0.17.0].

## [v0.16.1] — 2026-05-23
Fix: prepareDiarizer / prepareParakeet now reach the daemon; Fix: CAR Host menubar Settings… opens Settings even when Dashboard is closed; Fix: macOS Keychain no longer prompts on every CAR rebuild; Fix: First-launch onboarding now gates o… See the [release notes][v0.16.1].

## [v0.16.0] — 2026-05-18
Added: CarHost approval rows now show what an agent is asking to do; Fixed: MLX Device::gpu() aborted with "Failed to load the default metallib"; Removed: Homebrew distribution path for macOS (use the .pkg + Sparkle instead); Fixed: launch… See the [release notes][v0.16.0].

## [v0.15.2] — 2026-05-17
Fixed: car-browser leaked headless Chrome subprocesses on shutdown and on panic; Fixed: task=code didn't prioritise quality over speed/cost in routing (car-releases#52); Fixed: CarHost Chat tab rendered nothing for supervised agents (#222)… See the [release notes][v0.15.2].

## [v0.15.1] — 2026-05-17
Fixed: car start | stop | restart missing for contributed agents (#221); Fixed: car ls and car inspect mis-handled the flat agents.list response shape (#219, #220); Fixed: contributed-agent install rejected the stock template (#218); Fixed… See the [release notes][v0.15.1].

## [v0.15.0] — 2026-05-16
Fixed: CarHost sign-in showed a cryptic error against a stale daemon (#217); Fixed: Codex/Gemini chat replies never reached the host in streaming mode (#213); Fixed: ad-hoc-signed macOS host bundle crashed at launch on Sparkle load (#212);… See the [release notes][v0.15.0].

## [v0.14.0] — 2026-05-15
Fixed: car-server FD leak on WS peer disconnect → EMFILE (car#209); Fixed: stale approvals never reaped on agent disconnect (car-releases#48); Fixed: host.mail_send silently sent from the wrong account (car-releases#47); Added: car-auth cr… See the [release notes][v0.14.0].

## [v0.13.0] — 2026-05-15
`host.resolve_approval` fans out to the owning session (cross-session approval UIs no longer error) + `release.sh` auto-publishes the Sparkle appcast entry. See the [release notes][v0.13.0].

## [v0.12.0] — 2026-05-14
**Portable release path via Azure Key Vault** — any authorized operator can cut a release, not just the cert-owner's machine. `car-runtime` umbrella crate (#205), menubar badge, CI hardening. See the [release notes][v0.12.0].

## [v0.11.1] — 2026-05-13
A2UI Text renders Markdown. See the [release notes][v0.11.1].

## [v0.11.0] — 2026-05-13
agent-chat protocol, Chat tab, External streaming, Settings IA. See the [release notes][v0.11.0].

## [v0.10.1] — 2026-05-12
CAR Host.app via Homebrew Cask. See the [release notes][v0.10.1].

## [v0.10.0] — 2026-05-12
observe-only fallback (#44), dashboard productionization, AudioRefVideo. See the [release notes][v0.10.0].

## [v0.9.0] — 2026-05-12
multi-tenant scoping (car#187 phase 3), daemon-routed inference + reasoning, contributed agents GA, Homebrew tap automation. See the [release notes][v0.9.0].

## [v0.8.2] — 2026-05-11
macOS npm hotfix (continued). See the [release notes][v0.8.2].

## [v0.8.1] — 2026-05-11
macOS npm hotfix. See the [release notes][v0.8.1].

## [v0.8.0] — 2026-05-10
daemon-only FFI, macOS host overhaul, external-agent orchestration, MCP server foundation. See the [release notes][v0.8.0].

## [v0.7.0] — 2026-05-09
**Voice sidecar shipped end-to-end, mobile platform scaffolds, FFI parity story complete.** Two-track voice dispatch (fast LLM streams audio while sidecar runs the substantive turn in parallel) with `IntentHint::prefer_fast`, classifier, telemetry, and `DirectDataFetcher` fast-data bypass. Per-session policy scoping. Host-registered inference runner for delegated wire formats (Anthropic / OpenAI / Vercel AI SDK). ElevenLabs Realtime STT streaming. iOS host scaffold + Android AAR build chain. crates.io publishing of 36 library crates. See the [release notes][v0.7.0].

## [v0.6.1] — 2026-05-07
Daemon contract follow-ups (#139 fu1+fu2+fu3) + ElevenLabs secrets (#140) + debug rpath (#150). See the [release notes][v0.6.1].

## [v0.6.0] — 2026-05-07
Apple-frameworks expansion + daemon-mode FFI hardening + browser/voice fixes. See the [release notes][v0.6.0].

## [v0.5.2] — 2026-05-07
Notes only — no binaries published. Use [v0.5.1] or [the latest release](https://github.com/Parslee-ai/car-releases/releases/latest).

## [v0.5.1] — 2026-05-01
`car-server-core` library extraction; WS session leak fix; AST ignore handling. See the [release notes][v0.5.1].

## [v0.4.9] — 2026-04-25
Release pipeline fix — darwin `.node` upload + mirror assets, bumped timeout. See the [release notes][v0.4.9].

## [v0.4.8] — 2026-04-24
Speaker enrollment + diarization API; Anthropic `message_start` / `message_delta` usage parsing; FFI streaming `Usage` events. See the [release notes][v0.4.8].

## [v0.4.7] — 2026-04-21
Bumped `MACOSX_DEPLOYMENT_TARGET` to 15.0 so the wheel tag matches what it actually requires. See the [release notes][v0.4.7].

## [v0.4.6] — 2026-04-21
**Renamed Python import `car_native` → `car_runtime` to match package name.** See the [release notes][v0.4.6].

## [v0.4.5] — 2026-04-21
`publish-pypi` pulls wheels from the GitHub release, not CI artifacts. See the [release notes][v0.4.5].

## [v0.4.4] — 2026-04-21
npm `install.js` exits non-zero on download failure; release preflight + auto-mirror to `car-releases`. See the [release notes][v0.4.4].

## [CAR v0.4.0] — 2026-04-20
**OS Integration Foundations.** `car-secrets` (cross-platform OS keyring — macOS Keychain, Windows Credential Manager, Linux Secret Service), broader installer surface, Windows binary parity. See the [release notes][v0.4.0].

## [v0.3.2] — 2026-04-20
**Browser automation on the release contract** — reachable from CLI (`car browse run`), Python / Node bindings, and the WebSocket method, all backed by one implementation. See the [release notes][v0.3.2].

## [v0.3.1] — 2026-04-19
Windows x64 binaries and wheel; `car`, `car-server`, `car-memgine-eval` ship as `.exe` in `car-win32-x64-msvc.zip`; `win_amd64` wheel; CI Windows compile-check on every push. See the [release notes][v0.3.1].

## [v0.3.0] — 2026-04-19
First public release. Full Python / Node.js binding parity, macOS + Linux binaries and wheels. See the [release notes][v0.3.0].

[v0.58.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.58.0
[v0.57.4]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.57.4
[v0.57.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.57.2
[v0.56.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.56.1
[v0.55.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.55.0
[v0.54.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.54.0
[v0.53.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.53.0
[v0.52.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.52.1
[v0.52.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.52.0
[v0.51.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.51.0
[v0.50.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.50.0
[v0.49.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.49.0
[v0.48.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.48.0
[v0.47.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.47.0
[v0.46.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.46.1
[v0.46.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.46.0
[v0.45.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.45.0
[v0.44.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.44.0
[v0.43.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.43.0
[v0.42.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.42.0
[v0.41.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.41.0
[v0.40.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.40.0
[v0.39.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.39.1
[v0.39.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.39.0
[v0.38.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.38.0
[v0.37.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.37.0
[v0.36.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.36.0
[v0.35.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.35.0
[v0.34.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.34.0
[v0.33.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.33.0
[v0.32.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.32.1
[v0.32.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.32.0
[v0.31.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.31.0
[v0.30.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.30.0
[v0.29.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.29.0
[v0.28.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.28.0
[v0.27.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.27.0
[v0.26.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.26.0
[v0.25.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.25.0
[v0.24.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.24.1
[v0.24.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.24.0
[v0.23.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.23.0
[v0.22.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.22.1
[v0.22.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.22.0
[v0.21.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.21.0
[v0.20.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.20.0
[v0.19.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.19.0
[v0.18.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.18.0
[v0.17.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.17.0
[v0.16.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.16.1
[v0.16.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.16.0
[v0.15.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.15.2
[v0.15.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.15.1
[v0.15.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.15.0
[v0.14.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.14.0
[v0.13.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.13.0
[v0.12.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.12.0
[v0.11.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.11.1
[v0.11.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.11.0
[v0.10.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.10.1
[v0.10.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.10.0
[v0.9.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.9.0
[v0.8.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.8.2
[v0.8.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.8.1
[v0.8.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.8.0
[v0.7.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.7.0
[v0.6.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.6.1
[v0.6.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.6.0
[v0.5.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.5.2
[v0.5.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.5.1
[v0.4.9]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.9
[v0.4.8]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.8
[v0.4.7]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.7
[v0.4.6]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.6
[v0.4.5]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.5
[v0.4.4]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.4
[v0.4.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.4.0
[v0.3.2]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.3.2
[v0.3.1]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.3.1
[v0.3.0]: https://github.com/Parslee-ai/car-releases/releases/tag/v0.3.0
