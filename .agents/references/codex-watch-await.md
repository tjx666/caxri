# Codex Watch Await

Use this protocol only in Codex when collecting a long-running watch script. Claude Code uses
one native background shell and collects its result; it does not need this orchestration.
The calling workflow owns the watch command, target, deadline, and interpretation of terminal
statuses. This protocol only collects the existing process reliably.

## One waiter per watcher

Delegate each active watcher to one fresh-context waiter with `spawn_agent` and
`fork_turns: "none"`. Explicitly select an available low-cost model with low reasoning effort;
prefer `model: "gpt-5.6-luna"` and `reasoning_effort: "low"` when available. Supply this reference,
the exact command, task checkout, run ID or other watch target, and any existing session/cell
identity. Let the waiter start the watcher and own its shell session from the beginning.

The waiter collects output without progress narration, repository investigation, extra GitHub
probes, or changes. It returns the complete captured output in order and the terminal shell
`exit_code`. On collection failure, return the diagnostic, partial output, and known handles;
never invent an exit code. The primary agent interprets the result using the calling workflow.

Reuse an active waiter. A tool yield, interrupted parent turn, or missing completion notification
never authorizes restarting the watcher. Collect or confirm the old process stopped before an
explicitly justified replacement for a new target.

## Collect the same process

When `functions.exec` exposes `tools.exec_command`, `tools.write_stdin`, and `store`/`load`, keep
mechanical continuations in one awaited JavaScript loop inside the waiter:

1. Store an attempt-specific record before launch. Retain accumulated output, shell `session_id`,
   terminal `exit_code`, and phase. If the record already exists, inspect or resume it instead of
   launching again.
2. Run the supplied command exactly once in the supplied checkout. Append each returned output
   chunk and save the session identity and exit status after every tool return.
3. Until an explicit `exit_code` arrives, call `tools.write_stdin` with that same `session_id`.
   A running session is not a timeout or an automatic completion notification. Include nonzero
   exits in the terminal result. Do not call `yield_control()` between continuations.
4. If the outer call yields a cell ID, the waiter collects that same cell with `functions.wait`
   until it finishes. Retain the cell ID alongside the shell identity; do not launch another loop
   that competes with the active cell for shell output.

Prefer `yield_time_ms: 3600000` for the outer exec and every outer wait when the deployed host and
higher-priority instructions permit it. Explicitly request the duration on each continuation
instead of inheriting a short default. Shorter shell waits, such as a 30-second launch and
60-second continuations, can run inside that outer call without another model turn.

Distinguish the script's polling interval and deadline, shell continuation wait, outer cell yield,
and main-agent wait. Do not describe a default or an instruction to avoid long blocking calls as
a proven hard tool limit. Follow the current tool contract and higher-priority instructions;
when they require shorter waits, renew those waits while retaining the same process. A one-hour
wait is not a one-hour script deadline or permission to override an actual host limit.

Preserve every output chunk with sufficient tool output budgets. Truncation is incomplete
collection: recover stored output, or arrange an output artifact at launch when needed. Never
rerun a finished watcher just to recover its output. Shell output may combine stdout and stderr.

After interruption or tool error, inspect retained state before recovery. Collect a still-running
cell with `functions.wait`. Once that cell has ended, resume a recorded nonterminal shell session
with `write_stdin`, without another `exec_command`. An exited record is already collected. A
starting record without a handle requires process-state diagnosis; report a concrete blocker if
recovery is unavailable. A new attempt key alone does not justify a replacement launch.

## Main agent waiting

Finish useful independent work while the waiter runs. When its result is the only remaining work,
prefer `wait_agent({ timeout_ms: 3600000 })`, subject to the current tool contract and
higher-priority instructions. Keep shell collection and `functions.wait` in the waiter so the
primary remains available for user input.

Do not poll the waiter, narrate unchanged queue state, or issue extra GitHub probes to manufacture
progress. Handle new user input and resume waiting on the same waiter. Renewing a wait after its
permitted timeout is different from deliberately polling at short intervals.

After one hour without a terminal result, inspect the existing waiter's status once with
`list_agents`. If it is still running normally, repeat the long wait and hourly check until
completion, user cancellation, or a concrete blocker. When shorter tool waits are required,
renew them without extra status queries until the hourly check is due. For an error, unexpected
idle state, or unclear progress, ask the same waiter to diagnose its retained handles and state.
Do not compete for its shell output. A script's terminal timeout is a finished result for the
calling workflow to handle, not a normally running watcher to restart.

## Capability fallback

Without JavaScript orchestration, the waiter directly starts the command and continues the same
shell session with `write_stdin`, preserving output and exit status under the same lifecycle rules.
Without delegation, the original process owner collects the supported resumable session until
completion and reports the responsiveness limitation. For a foreground-only harness, keep the
script deadline within the command time limit; report a concrete limitation if the terminal result
cannot be collected reliably. Never treat unavailable delegation as permission to abandon a
running watcher or start duplicates.
