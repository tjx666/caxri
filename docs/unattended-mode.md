---
kind: living
status: current
---

# Unattended mode

Caxri is often left running for hours with many Agents working: overnight, or while the user is
away. Two settings make that cheap and safe, both under **Settings → General → Background** and both
on by default.

## Keep Mac awake while Agents work

`power.keepAwakeWhileAgentsWork`. While at least one Agent runs a turn or compacts, or a Chat waits
for its plan limit to reset (it continues on its own), Server Core holds a macOS idle-sleep
assertion so the Mac does not sleep in the middle of the work. When the work finishes the assertion
is released and the Mac sleeps normally.

- The hold is `/usr/bin/caffeinate -i -w <Server Core PID>`
  (`apps/server/src/core/keep-awake.ts`). `-i` blocks idle system sleep only: the display still
  turns off. `-w` ties the assertion to Server Core's process, so even a killed Server Core cannot
  leave the Mac awake.
- It lives in Server Core, not Desktop, so it keeps working with every window closed and with
  Desktop quit through **Keep Tasks Running**.
- The decision reads `session.workSummary` (the same counts the Activity view groups by), on every
  `state.changed` or `settings.changed` event, coalesced over 500 ms, with a 60-second fallback
  recheck. A failed assertion retries after 30 seconds, doubling up to 8 minutes.
- Limits: closing the lid on battery still sleeps the Mac. macOS has no unprivileged assertion
  against that; use a power adapter, or keep the lid open. Off macOS the setting does nothing.
- `caxri host status` reports `keepAwake.active` and its start time. Log events:
  `server_core.keep_awake_started`, `server_core.keep_awake_stopped` (closed reason, duration, peak
  working count), and `server_core.keep_awake_failed`.

## Keep running in the menu bar

`window.menuBarWhenClosed`. When the user closes the last Workbench window while Agents or Terminals
are still running, Caxri leaves the Dock and keeps a status item in the menu bar instead
(`apps/desktop/src/main/menu-bar/`). The Renderer, the largest idle cost, is gone with its window;
Desktop Main stays so system notifications keep arriving and one click brings Caxri back. With
nothing running, closing the window keeps the ordinary Dock presence.

- The icon shows a number only when Sessions need the user, so a quiet night shows a bare icon.
- The menu lists how many Agents work, Chats waiting for a plan limit, whether the Mac is held
  awake, and up to eight Sessions that need the user (the Activity view's Needs attention order,
  without worktree Projects and work that belongs to the Session that asked for it). Choosing one
  opens Caxri on that Session. The menu also toggles keep-awake, opens Caxri, and quits.
- Opening any window, turning the setting off, or quitting removes the status item and brings the
  Dock icon back. Quit keeps its usual confirmation for running work.
- The first time Caxri enters the menu bar it posts one notification explaining where it went.
- Log events: `window.menu_bar_entered` (running Chat and Terminal counts) and
  `window.menu_bar_left` (closed reason, duration, Sessions opened from the menu).

Quitting with Cmd+Q is unchanged: **Keep Tasks Running** still exits Desktop entirely, and Server
Core keeps the Agents (and the keep-awake hold) alive on its own.
