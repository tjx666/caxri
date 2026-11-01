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

**Session: Restore Sessions Stopped at Last Quit** in the Desktop command palette (also found by
searching `resume`, `reopen`, or `quit`) brings them back in one step.

## What is recorded

Every `terminal.terminateAll` that runs before Server Core stops carries `reason: 'serverStop'`:
**Quit and Stop Tasks**, Restart to Update, and a Host Environment's Stop Server. Right before
stopping anything, Server Core samples each Session that still has a live PTY or a live Chat and
stores, in the `quitStoppedSessions` app state row:

```json
{
  "stoppedAt": 1767225600000,
  "sessions": [
    { "sessionId": "s-1", "terminalIds": ["t-1", "t-2"], "shouldContinue": true },
    { "sessionId": "s-2", "terminalIds": [], "shouldContinue": false }
  ]
}
```

- `terminalIds` are the PTYs the stop is about to end; a Chat-only Session has none.
- `shouldContinue` uses the same "still working" test as
  [Airplane Mode](airplane-mode.md#entering): a running or waiting turn, Claude background work,
  or a running Chat task.
- Caxri Bot's Session is left out; it restores through its own supervisor on the next start.
- A stop that finds nothing live keeps the previous record, so quitting again from an idle app does
  not lose what was never restored. `Terminate and Close` (`reason: 'windowClose'`) records nothing,
  since Server Core keeps running and the user chose to end the work.

## Restoring

`session.restoreQuitStopped` consumes the record first, so a second run (or one from another
client) restores nothing twice, then relaunches the Sessions one at a time without moving any
window's selection, through the same path Airplane Mode resumes with:

1. The recorded `stopped` PTYs relaunch on their bound Agent conversations (`--resume`), and a
   shell Terminal restarts as a shell. Only the recorded Terminal IDs opt out of `stopped` being
   final; every other `stopped` Terminal stays down.
2. Chats start again on their bound conversation; an idle Chat simply starts on its next read.
3. A Session with `shouldContinue` has its primary Agent told to continue, with a prompt that says
   its last turn and background work were stopped by the quit.

A Session deleted or archived since the quit, or one whose relaunch fails, is skipped and keeps
its stopped Terminals for a manual restart. The toast reports how many Sessions were restored and
how many were skipped; with no record it says no Sessions were stopped at the last quit.

## Diagnostics

`session.quit_stopped_recorded` logs `sessionCount` and `workingCount` at every server stop.
`session.quit_stopped_restored` logs `restored`, `continued`, `skipped`, `durationMs`, and
`recordAgeMs` (time since the quit). A record that cannot be written logs
`session.quit_stopped_record_failed` with its `errorCode`; the stop still proceeds. None carries a
title or Session content.
