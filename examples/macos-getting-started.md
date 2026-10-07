{% raw %}
# Getting started on macOS (no code)

For people who installed **CAR Host** and just want to use it. You
don't need to know how to program, open a terminal, or run a server.
If you're a developer embedding CAR in Python/Node, the code examples
next to this file are for you instead.

## 1. Install

Download **`CAR-darwin-arm64.pkg`** from the
[latest release](https://github.com/Parslee-ai/car-releases/releases/latest)
and double-click it. That's the whole install — it puts **CAR Host**
in your menu bar. (Apple Silicon Mac, macOS 26 or newer.)

The app keeps itself up to date automatically. You won't need to do
this again.

## 2. The window and the menu bar

When CAR starts, its window opens (the window is called **CAR**). CAR
also puts a **CAR icon** in the macOS menu bar, top-right of your
screen. Close the window and CAR keeps running there; click the icon
and choose **Open Dashboard…** to bring the window back.

The icon's shape tells you the status at a glance; a different shape
means CAR wants your attention (usually an approval — see step 5).

## 3. Sign in

The first time, CAR opens a **sign-in window** (Parslee). Follow it
through your browser and come back. This connects CAR to your account
so it can do real work.

> If sign-in says *"Your CAR background service is out of date"*, the
> installer didn't finish replacing an older copy — reinstall the
> `.pkg` from the latest release and try again.

After setup, the window opens once on **Home**, a short Getting
started guide to the app. From then on CAR opens straight into your
last chat. Home is always the first row of the sidebar if you want
the guide again.

## 4. Ask it something

The window works like ChatGPT or Claude: your chats are down the
left-hand side, and the chat you're in fills the rest.

1. Click **New chat** in the sidebar, under Home and your pinned
   tools (or press ⌘N).
2. Type what you want in plain English in the message box and press
   Return to send. Shift-Return starts a new line.
3. The agent chips above the message show who's in the chat. The
   highlighted one answers your next message; click another to hand
   it the next turn. To add an agent, click **+** in the message box
   and choose **Add Agent**.

Ask for things the way you'd ask a capable assistant: *"summarize
this note for me,"* *"draft a reply to this email,"* *"find last
quarter's numbers and pull out the top three changes."* What it can
actually reach (your mail, files, calendar, the web) depends on which
agent answers and what's been enabled — if something isn't available,
it'll tell you. Not sure what to ask? **Ideas** in the sidebar shows
things CAR can do, by category; pick one and it opens a new chat with
the request typed in for you, ready to edit. Nothing is sent until you
send it.

## 5. Approvals — you're always in control

CAR asks you before it does anything sensitive. Sending an email,
running a system automation, reading the screen — each one pauses and
shows up under **Approvals** (in the sidebar's Tools, or in **More**
if you unpinned it), and the menu-bar icon changes shape to nudge you. You **Approve** or **Deny**. Nothing runs
unless you approve it. A request doesn't wait forever, though: if you
don't answer in time, the action doesn't run. An approval an agent
asks for in a chat is treated as declined after five minutes. A
request another app or agent makes to CAR directly (to send mail or
run an automation, say) gives up after one minute. Ask again when
you're back.

The shield next to **+** in the message box sets how much Parslee
Core, CAR's own agent, may do without asking: **Ask first** (it asks
before every action, reads included), **Balanced** (Read-only
actions run on their own; Edit files and Full access actions ask
first), or **Approve for me** (Read-only and Edit files actions run
on their own; Full access actions ask first). It's the same setting
as Settings → Agent Permissions.

This is the whole point of CAR: the assistant proposes, and actions
that touch the real world go through you.

## Where things are

- **Home** — the first row of the sidebar, always there. It opens the
  Getting started guide.
- **Tools** — below Home: *Coder*, *Agents*, *Work*, *Live controls
  (A2UI)*, *A2A*, *Approvals*, *Models*, *Connect apps* and *Build an
  agent*. *Agents* lists the agents built into CAR, the agents you
  built and your local processes, each with its status, the ones that
  need you first; click one to open its page, which for an agent you
  built is where you edit it or give it work. Coding agents such as
  Codex and Claude Code are not on that list: you add them to a chat
  with **+**. Click the *Tools*
  heading to fold it away. Right-click a
  screen and choose *Unpin from Sidebar* to move it into **More**;
  *More → Pin to Sidebar* brings it back. Unpin everything and the
  Tools heading goes away; Home always stays. You can ignore most of
  them; chats and Approvals are what you'll use day to day.
- **Your chats** — below Home and any pinned Tools, under **New chat**
  and the search box. *Projects* first (unpinned chats that work in a
  folder, grouped by folder), then *Chat history*: pinned chats
  (right-click a chat → *Pin*; a pinned chat stays here even when it
  has a folder), then *Today*, *Yesterday*, *Previous 7 days* and
  *Earlier*. Each chat shows once. Search looks through all of them.
- **Ideas** and **More** — at the bottom of the sidebar.
- **Settings** — the gear at the bottom of the sidebar, or ⌘,.
  Models, connections, notifications, launch-at-login.
- **Report a problem** — next to the gear.
- **Quit** — menu-bar icon → *Quit CAR*. Quitting stops CAR
  entirely; relaunch it from Applications or Spotlight.

That's it. Install, sign in, start a chat, ask. Approve the things
that matter. No terminal, ever.

{% endraw %}
