---
kind: living
status: current
---

# Restore Sessions Stopped at Last Quit

Quitting Caxri while Terminals or Chats are running asks whether to keep them running in the
background or **Quit and Stop Tasks**. Stopping writes every live Terminal as `stopped`, which is
final: unlike an `interrupted` Terminal left by an orderly shutdown, nothing relaunches it on the
next start or on Session selection. Without help, the user would have to remember which Sessions
were running and restart each one by hand.

The next launch offers to bring them back: once the Renderer attaches, it reads
`session.quitStoppedCount`, and when that is above zero it shows a persistent notice, "2 Sessions
were stopped at the last quit, 3 hours ago.", with a **Restore** button. The notice stays until the user
handles or closes it, so Zen Mode does not filter it, and it is checked once per Renderer
launch. Reading the count never consumes the record: closing the notice leaves
**Session: Restore Sessions Stopped at Last Quit** in the Desktop command palette (also found by
searching `resume`, `reopen`, or `quit`), which brings them back in one step too. The count leaves
out Sessions deleted or archived since the quit, since a restore would only skip them. A quit older than
three days (`QUIT_RESTORE_NOTICE_MAX_AGE_MS`) gets no notice; the command stays available.

Restart to Update (on the computer or from a paired phone) needs none of this: the next Server Core
start restores the stopped work on its own (see [After an update](#after-an-update)).

## What is recorded

Every `terminal.terminateAll` that runs before Server Core stops carries a recording reason:
`serverStop` for **Quit and Stop Tasks** and a Host Environment's Stop Server, `update` for
Restart to Update. Right before stopping anything, Server Core samples each Session that still has
a live PTY or a live Chat and stores, in the `quitStoppedSessions` app state row:

```json
{
  "stoppedAt": 1767225600000,
  "restartedForUpdate": true,
  "sessions": [
    { "sessionId": "s-1", "terminalIds": ["t-1", "t-2"], "shouldContinue": true },
    { "sessionId": "s-2", "terminalIds": [], "shouldContinue": false }
  ]
}
```

- `restartedForUpdate` is present only when Restart to Update wrote the record.
- `terminalIds` are the PTYs the stop is about to end; a Chat-only Session has none.
- `shouldContinue` uses the same "still working" test as
  [Airplane Mode](airplane-mode.md#entering): a running or waiting turn, Claude background work,
  or a running Chat task.
- Caxri Bot's Session is left out; it restores through its own supervisor on the next start.
- A stop that finds nothing live keeps the previous record, so quitting again from an idle app does
  not lose what was never restored. `Terminate and Close` (`reason: 'windowClose'`) records nothing,
  since Server Core keeps running and the user chose to end the work.

## Restoring

`session.restoreQuitStopped` marks a restore as running in memory first, so a second run (or one
from another client) restores nothing twice, then relaunches the Sessions one at a time without moving any
window's selection, through the same path Airplane Mode resumes with:

1. The recorded `stopped` PTYs relaunch on their bound Agent conversations (`--resume`), and a
   shell Terminal restarts as a shell. Only the recorded Terminal IDs opt out of `stopped` being
   final; every other `stopped` Terminal stays down.
2. Chats start again on their bound conversation; an idle Chat simply starts on its next read.
3. A Session with `shouldContinue` has its primary Agent told to continue, with a prompt that says
   its last turn and background work were stopped by the quit, or by the update for a
   `restartedForUpdate` record.

A Session deleted or archived since the quit, or one whose relaunch fails, is skipped and keeps
its stopped Terminals for a manual restart. The toast reports how many Sessions were restored and
how many were skipped; with no record it says no Sessions were stopped at the last quit.

The stored record is not cleared up front. Each Session leaves it just before its relaunch starts,
so if Server Core is killed or crashes partway through, for example during the third of 6, the
three Sessions after it stay in the record: the next start restores them (an update record still
within 30 minutes) or the launch notice offers them. The Session being relaunched when the process
died is not retried, so a relaunch that itself takes Server Core down cannot loop across restarts;
it keeps its stopped Terminals for a manual restart. A failed automatic relaunch is written back to
the record for the launch notice; a failed manual one is dropped.

## After an update

The user asked for an immediate restart, so running work should carry on in the new version
without another click. When Server Core starts and finds a `restartedForUpdate` record written
within the last 30 minutes (`QUIT_RESTORE_AUTO_MAX_AGE_MS`), it runs the same restore by itself
(`QuitRestore.restoreAfterUpdate`). It claims the record before any Client can attach, so the
launch notice never offers it, and starts relaunching once the rest of Server Core's start has run.
The interrupted turn itself is not saved: a working Agent picks up from its conversation and reruns
the command or subagent the restart killed.

An older update record means the relaunch did not happen right away (a failed install, a Mac that
shut down before reopening). Telling Agents to continue that late could restart work the user has
moved on from, so it falls back to the launch notice and the command above.

## Diagnostics

`session.quit_stopped_recorded` logs `cause` (`quit` or `update`), `sessionCount`, and
`workingCount` at every server stop.
`session.quit_stopped_offered` logs the launch notice's read: `count` (what a restore would
relaunch), `recordedCount`, and `recordAgeMs`; it never consumes the record.
`session.quit_stopped_restored` logs `cause` (`update` for the automatic restore after an
update), `restored`, `continued`, `skipped`, `durationMs`, and `recordAgeMs` (time since the quit). A record that cannot be written logs
`session.quit_stopped_record_failed` with its `errorCode`; the stop still proceeds. None carries a
title or Session content.
