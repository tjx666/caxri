---
kind: living
status: current
---

# Getting started

Caxri is an Agent Development Environment (ADE) for macOS: you build software through the coding
Agents you already use (Claude Code, Codex, Grok Build), and Caxri keeps their work organized,
automated and in view.
This page is the model in five minutes. Install steps are in [install.md](install.md).

## The model

- **Project.** A folder on your Mac that you authorize, usually a Git repository. Adding a Project
  never copies or changes the folder, and removing one never deletes it.
- **Session.** One task inside a Project, such as "fix the login bug". A Session keeps its Agent
  conversation, Terminals, editor tabs and layout, and comes back after you quit and reopen Caxri.
- **Chat and Terminal.** An Agent opens as a Chat by default: a readable conversation with
  collapsible tool steps and approval cards. Run **Open as Terminal or Chat** from the Command
  Palette to see the same Agent in a real terminal, and switch back without losing the conversation.
  See [agent-chat.md](agent-chat.md).
- **Shell.** A plain terminal in the Session's folder, for builds, Git and anything else you would
  do in Terminal. Shells always run in a terminal and need no Agent.

## Knowing when an Agent needs you

The Primary Agent of each Session reports when it is waiting for you, finished, or failed. The
Activity view in the side bar is a queue of the Sessions waiting on you across every Project; see
[activity-view.md](activity-view.md). Caxri can also show a macOS banner for these events.

System notifications depend on a small helper (`alerter`, installed with Homebrew). Open
**Settings → Notifications → System notifications** to see its status, choose **Check Again** after
installing it, and **Send Test Notification** to confirm a banner appears. The notification center
and reminder types are described in [notifications.md](notifications.md).

## Agent permissions

Agents start with full access: they can edit files and run commands without asking. The Create
Session dialog repeats this, and **Settings → Agents** is where you change an Agent's launch
defaults. In a Chat you can also change the permission mode for the current conversation from the
Command Palette (**Change Permission Mode…**).

## Keyboard and menus

- **Command Palette.** Open it with its shortcut (listed in the Keyboard Shortcuts Reference),
  to reach almost every action by name, including **Install 'caxri' Command in PATH**.
- **Keyboard Shortcuts Reference.** **Help → Keyboard Shortcuts Reference** lists every shortcut; customize
  them as described in [keybindings.md](keybindings.md).
- **Help menu.** **Documentation** opens this guide, **Release Notes** opens the GitHub releases,
  **Report an Issue** opens the issue chooser, and **Reveal Logs in Finder** opens the log folder.
  Use **Export Diagnostics** when you report a problem.

When something goes wrong, see [troubleshooting.md](troubleshooting.md).
