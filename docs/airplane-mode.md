---
kind: living
status: current
---

# Airplane Mode

Agent CLIs such as Claude Code and Codex keep retrying requests when the network disappears, for
example when a laptop leaves the phone hotspot it was tethered to. Airplane Mode is the switch the
user flips before going offline: Caxri interrupts the running turns, compacts the conversations
worth compacting, stops every Agent, and holds them stopped until the user comes back and picks
which Sessions to resume. Agents that were still working continue on their own once resumed.

## Entering

Run **Session: Enter Airplane Mode** from the Desktop command palette (also found by searching
`offline`, `flight`, or `network`). A full-window dialog opens in every Workbench window; it has no
close button, and Escape or an outside press does nothing.

1. **Compacting**. Server Core first records which Sessions are still working: the primary
   Agent's turn is running or waiting, a Claude PTY Agent has background work (a subagent,
   workflow, monitor, or background command other than a long-running server), or a Chat has a
   running task, background shells included. It interrupts their running turns without stopping
   the Agents, waits up to 15 seconds for those turns to settle, then runs the
   [batch compaction](session-compaction.md#batch-command): Sessions that are idle now and whose
   prompt cache is still warm are submitted. It then waits for the submitted compactions to
   finish, for at most three minutes. The dialog shows how many are still running and offers
   **Cancel** (leave Airplane Mode without stopping anything; turns it already interrupted are
   told to continue at once) and **Stop Agents Now** (skip the waits). A compaction still running when the wait
   ends is stopped with its Agent.

   A Chat turn is interrupted the way its Stop button does it. A PTY turn is interrupted with a
   standalone Escape only when its composer is provably empty: the turn was submitted by a
   standalone Enter, nothing was typed since, and it already reached a tool
   (`CompactionReadiness.armInterrupt`). The last condition matters because Claude Code and Codex
   put a prompt back into the composer when it is interrupted before the model answered. That empty
   composer is what lets the batch type `/compact` afterwards without submitting a draft along
   with it. Any other running PTY turn is left alone and simply stops with its Agent.

2. **Parking**. Every Session with a live Agent, PTY or Chat, is detached the same way
   `session.detach` detaches it: the Agent stops, its record and bound conversation stay, and
   selecting the Session does not relaunch it. Shell tabs keep running.
3. **On**. The dialog lists the parked Sessions by title and Project, all ticked. A Session
   that was working on entry is marked **Continues**.

While parking or on, Server Core refuses every Agent launch, whatever its origin (a dispatch, Caxri
Bot, a Session switch, a restart): a PTY launch that lands is detached at once and its Session
joins the list, and a Chat start fails with `CONFLICT`.

## Resuming

**Resume N Sessions** relaunches the ticked Sessions on their bound conversations, one after
another, the same way `session.resume` does, without moving any window's selection. A Session that
was working on entry also tells its primary Agent to continue: a PTY Agent receives the prompt as
its resume launch argument (`--resume <id> -- <prompt>`), so it arrives once the CLI is ready, and a
Chat queues it as a message right after its resume. The prompt says the last turn and any
background subagents or commands were stopped, so the Agent reruns what it still needs instead of
waiting for results that will never come. A Session that was idle on entry only relaunches. Unticked
Sessions stay detached; each resumes later through its own Resume action. With nothing ticked the
button reads **Leave Without Resuming**. The dialog closes once every picked Session has settled.

## Restart

The state is durable (`app_state.airplaneMode`), so the dialog, the parked list, and which
Sessions continue survive a
Server Core or app restart. An entry interrupted while compacting or parking finishes parking when
Server Core starts again (its Agents died with the old process, and a restore that lands is caught
by the launch fence). An interrupted resume ends: Sessions it had not reached stay detached.

## Logging

Every phase change writes `session.airplane_mode_changed` with `phase`, `previousPhase`, a closed
`reason` (`entered`, `compactionFinished`, `compactionSkipped`, `compactionTimedOut`,
`compactionFailed`, `parked`, `exited`, `resumed`, `serverRestarted`), `durationMs` spent in the
previous phase, `parkedCount`, `workingCount` (Sessions still working on entry), and the
compaction `submittedCount` and `pendingCount`. Parking adds the number of turns `interrupted` and
of Sessions that `failed` to detach; resuming adds `resumed`, `continued`, and `failed`. No Session
title or conversation content is logged.

## Code

- `apps/server/src/domains/session/airplane-mode.ts`: the phases, the compaction wait, parking, and
  resuming.
- `apps/server/src/domains/maintenance-services-creation.ts`: wiring to compaction, the working
  check, the interrupts, detach, restore with the continue prompt, and the launch fence.
- `apps/server/src/domains/agents/compaction-readiness.ts`: the empty-composer proof a PTY interrupt
  needs.
- `apps/server/src/domains/terminal/suspension.ts`: the PTY launch fence (`setAirplaneFence`).
- `apps/server/src/domains/agent-chat/chat-start.ts`: the Chat start fence.
- `apps/desktop/src/renderer/src/features/session/airplane-mode/`: the command and the dialog.
