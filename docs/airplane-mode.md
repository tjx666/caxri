---
kind: living
status: current
---

# Airplane Mode

Agent CLIs such as Claude Code and Codex keep retrying requests when the network disappears, for
example when a laptop leaves the phone hotspot it was tethered to. Airplane Mode is the switch the
user flips before going offline: Caxri compacts the conversations worth compacting, stops every
Agent, and holds them stopped until the user comes back and picks which Sessions to resume.

## Entering

Run **Session: Enter Airplane Mode** from the Desktop command palette (also found by searching
`offline`, `flight`, or `network`). A full-window dialog opens in every Workbench window; it has no
close button, and Escape or an outside press does nothing.

1. **Compacting**. Server Core runs the [batch compaction](session-compaction.md#batch-command):
   only idle Sessions whose prompt cache is still warm are submitted. It then waits for the
   submitted compactions to finish, for at most three minutes. The dialog shows how many are still
   running and offers **Cancel** (leave Airplane Mode without stopping anything) and **Stop Agents
   Now** (skip the wait). A compaction still running when the wait ends is stopped with its Agent.
2. **Parking**. Every Session with a live Agent, PTY or Chat, is detached the same way
   `session.detach` detaches it: the Agent stops, its record and bound conversation stay, and
   selecting the Session does not relaunch it. Shell tabs keep running.
3. **On**. The dialog lists the parked Sessions by title and Project, all ticked.

While parking or on, Server Core refuses every Agent launch, whatever its origin (a dispatch, Caxri
Bot, a Session switch, a restart): a PTY launch that lands is detached at once and its Session
joins the list, and a Chat start fails with `CONFLICT`.

## Resuming

**Resume N Sessions** relaunches the ticked Sessions on their bound conversations, one after
another, the same way `session.resume` does, without moving any window's selection. Unticked
Sessions stay detached; each resumes later through its own Resume action. With nothing ticked the
button reads **Leave Without Resuming**. The dialog closes once every picked Session has settled.

## Restart

The state is durable (`app_state.airplaneMode`), so the dialog and the parked list survive a
Server Core or app restart. An entry interrupted while compacting or parking finishes parking when
Server Core starts again (its Agents died with the old process, and a restore that lands is caught
by the launch fence). An interrupted resume ends: Sessions it had not reached stay detached.

## Logging

Every phase change writes `session.airplane_mode_changed` with `phase`, `previousPhase`, a closed
`reason` (`entered`, `compactionFinished`, `compactionSkipped`, `compactionTimedOut`,
`compactionFailed`, `parked`, `exited`, `resumed`, `serverRestarted`), `durationMs` spent in the
previous phase, `parkedCount`, and the compaction `submittedCount` and `pendingCount`. Parking adds
the number of Sessions that `failed` to detach; resuming adds `resumed` and `failed`. No Session
title or conversation content is logged.

## Code

- `apps/server/src/domains/session/airplane-mode.ts`: the phases, the compaction wait, parking, and
  resuming.
- `apps/server/src/domains/maintenance-services-creation.ts`: wiring to compaction, detach, restore,
  and the launch fence.
- `apps/server/src/domains/terminal/suspension.ts`: the PTY launch fence (`setAirplaneFence`).
- `apps/server/src/domains/agent-chat/chat-start.ts`: the Chat start fence.
- `apps/desktop/src/renderer/src/features/session/airplane-mode/`: the command and the dialog.
