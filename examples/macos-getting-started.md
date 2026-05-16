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

## 2. Find it in the menu bar

After installing, look at the top-right of your screen — the macOS
menu bar. There's a new **CAR icon**. Click it. That's CAR Host: it
runs quietly in the background and is always one click away. There's
no Dock icon and no window until you open one.

The icon's shape tells you the status at a glance; a different shape
means CAR wants your attention (usually an approval — see step 5).

## 3. Sign in

The first time, CAR opens a **sign-in window** (Parslee). Follow it
through your browser and come back. This connects CAR to your account
so it can do real work.

> If sign-in says *"Your CAR background service is out of date"*, the
> installer didn't finish replacing an older copy — reinstall the
> `.pkg` from the latest release and try again.

## 4. Ask it something

From the menu-bar icon, open **CAR Dashboard**. It has tabs across the
top — the one you want is **Chat**. It works like ChatGPT or Claude:

1. Pick an assistant from the **agent picker** ("Select an agent").
   What's listed depends on what's been set up for you.
2. Type what you want in plain English and press send.
3. Your conversations are saved in the sidebar — search them, pin
   them, start new ones.

Ask for things the way you'd ask a capable assistant: *"summarize
this note for me,"* *"draft a reply to this email,"* *"find last
quarter's numbers and pull out the top three changes."* What it can
actually reach (your mail, files, calendar, the web) depends on which
agent you pick and what's been enabled — if something isn't available,
it'll tell you.

## 5. Approvals — you're always in control

CAR will **not** do anything sensitive without asking you first.
Sending an email, running a system automation, reading the screen —
each one pauses and shows up in the **Approvals** tab (and the
menu-bar icon changes shape to nudge you). You **Approve** or **Deny**.
Nothing happens until you say so. If you walk away, it just waits.

This is the whole point of CAR: the assistant proposes, and actions
that touch the real world go through you.

## Where things are

- **Open the dashboard** — click the menu-bar icon → *CAR Dashboard*.
- **Settings** — menu-bar icon → *Settings…* (or ⌘,). Models,
  connections, notifications, launch-at-login.
- **Other tabs** — *Overview* (status at a glance), *Agents*,
  *Capabilities*, *Approvals*, *Diagnostics*.
- **Quit** — menu-bar icon → *Quit* (⌘Q). Quitting stops CAR
  entirely; relaunch it from Applications or Spotlight.

That's it. Install, click the menu-bar icon, sign in, open Chat, ask.
Approve the things that matter. No terminal, ever.
