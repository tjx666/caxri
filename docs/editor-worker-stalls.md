---
kind: living
status: current
---

# Editor Worker stalls

A comparison with no answer is incomplete, not an unchanged file. The diff surface reports a
failure after its eight-second budget and records a bounded `renderer.editor_worker_stall`
diagnostic. A computation that subsequently answers removes the failure; a previously logged
timeout also records `recovered`. Rate-limited stalls update aggregate counts without another pair.
Diagnostics contain counts, durations and outcomes, never document contents.

The startup watcher records the first Worker reply. Passing its five-second budget establishes
only that no reply arrived; it does not prove that the module never executed. A delayed reply
clears the current stall, so a later Retry cannot terminate a Worker that already recovered.

## Automatic recovery

Chromium's dedicated-worker path is the suspected root cause (see "Debugger pauses" below), so the
product fallback stays at the diff surface instead of waiting on an upstream fix: a stalled
comparison heals itself once, without the user having to find and press Retry.

A stall that is still unresolved a second, equal eight-second window after its `timeout` report
gets one automatic attempt: `diff-stall-watch.ts`'s `recoveryGraceMs` offers the caller
`onRecoveryDue`, which is recorded as a `worker-recreated` diagnostic (the active counterpart to
`recovered`: the surface gave up waiting on the original Worker instead of it answering late) and
destroys and recreates the stalled Worker before asking Monaco to recompute, the same mechanical
steps the manual Retry button already performed. `git-monaco-diff-editor.tsx` owns this decision
per diff surface; `diff-worker-recovery.ts` is the pure state machine that bounds it to one
automatic attempt (`MAX_AUTOMATIC_WORKER_RECOVERIES`) so a Worker that keeps failing is surfaced to
the user instead of retried forever on its own. A manual Retry click always resets that budget, since
it is a fresh user-initiated attempt.

The extra window exists so this mechanism never competes with a Worker whose startup was merely
delayed rather than dead: passive recovery (the `recovered` outcome, and the scenario
`git-diff-worker-recovery.e2e.ts` exercises) always gets first refusal, because the grace period is
racy against `waitForDiff()` resolving on its own the whole time it is running.

## Debugger pauses

An isolated Electron experiment reproduced a startup stall with a connected CDP client using
`Target.setAutoAttach` and `waitForDebuggerOnStart: true` without resuming its Worker targets.
A baseline Worker posted its startup message; with that client connected, two new Workers did
not. `Runtime.runIfWaitingForDebugger` resumed the paused Worker. Hard-disconnecting the client
also allowed both an existing paused Worker and a newly created Worker to run.

This disproves a persistent pause left by that disconnected client in the tested runtime. It
does not establish which client, if any, caused a historical long-running-window incident.
Resume or disconnect a debugger that intentionally pauses Workers before retrying a comparison.
Caxri does not disable its debugging endpoint or override another debugger's pause automatically.

Use raw CDP for this experiment: browser automation clients can auto-attach and resume Workers,
masking the condition being measured. Use the owned worktree's hidden, Agent-blocked launch and
an independently allocated port; do not experiment on a resident user window. The focused
`git-diff-worker-recovery.e2e.ts` regression delays the actual editor Worker bootstrap, verifies
the visible failure, resumes it, and checks highlights plus the timeout/recovered log pair.
