---
kind: living
status: current
---

# Process Explorer and resource alerts

Caxri watches the processes it runs so that a runaway Agent never goes unnoticed. Three surfaces
share one definition of "too much":

- The **resource alert** is a persistent warning toast. It appears when a Terminal's process tree
  stays above the thresholds.
- The **status bar memory chip** turns red while the active Terminal is above the thresholds.
- The **Process Explorer** window lists every process by Session and Agent, and flags the same
  Terminals.

## Thresholds

`TERMINAL_RESOURCE_ALERT_THRESHOLDS` in `packages/protocol/src/domain/terminal-resources.ts` sets
the limits: 4 GB of resident memory **or** 300% CPU, summed across a Terminal's whole process tree
(the PTY shell plus every descendant). CPU is the `ps` `%cpu` reading. On macOS that is already a
decaying average, so a short build burst does not cross the line on its own. All three surfaces
use `isTerminalResourceUsageHigh`, so they cannot disagree about whether a Terminal is high.

## Resource alert

Server Core's `TerminalResourceMonitor` (`apps/server/src/domains/terminal/resource-monitor.ts`)
samples every running Terminal every 10 seconds. One `ps -axo pid=,ppid=,pcpu=,rss=` call covers
all of them, and nothing runs while no Terminal is alive. Each alert covers one episode:

- It publishes `raised` after two high samples in a row.
- It publishes `cleared` when the tree drops back below the thresholds or the Terminal stops
  running. Either one re-arms the monitor for the next episode.

`terminal.resourceAlert` is a transient event. Replaying it after a reconnect would re-announce an
episode the user already dismissed.

The Workbench shows a raised alert as a warning toast that stays until dismissed:
`High resource use: <Agent> · <Session> is using <memory> of memory and <cpu> CPU.` It has two
buttons:

- **Stop** calls `terminal.suspend`. This suspends the Terminal rather than closing it: the process
  tree exits, and the Session and Agent conversation stay resumable from the Terminal pane. The
  button refuses to run if the Terminal is gone or now runs a different process.
- **View details** opens the Process Explorer.

A `cleared` event retracts the toast. The notification center keeps the entry, with both buttons.

The monitor writes three log events:

- `terminal.resource_alert_raised`, with the readings, provider, Session, and Terminal.
- `terminal.resource_alert_cleared`, with the episode `durationMs`, the peak readings, and a closed
  `reason` (`recovered` or `stopped`).
- `terminal.resource_sample_failed`, when a `ps` sample fails.

## Process Explorer

Open it from **View > Open Process Explorer**, the Command Palette, the status bar memory chip, or
a resource alert. Desktop Main samples the window every 2 seconds
(`apps/desktop/src/main/process-explorer.ts`). It combines Electron's app metrics, the `ps` tree
under Main, and Server Core's `terminal.processes` list. That list pairs each running Terminal
with its Session, Agent, and PTY root PID.

The window shows:

- **Summary bar**: total CPU, memory used out of system memory, the process count, and a filter.
  The filter matches names, command lines, and PIDs, and opens every row while it is active.
- **Sessions** group: each Session, then each Terminal named after its Agent, with a
  "N processes" tag. Terminal rows start folded, and the PTY process tree sits under them. A
  Terminal above the thresholds gets a warning dot and warning-colored readings. Its Stop button
  (on hover or focus, or the Delete key) suspends it.
- **Caxri** group: Caxri's own processes as a flat list with role labels. The roles are Caxri
  (Main process), Workbench and Process Explorer (Window), GPU, helpers such as Network Service,
  and Server Core, Extension Host, and Terminal Host (Service). Processes that no Terminal claims
  also land here.

Plain processes show only their executable. An interpreter shows its script too, such as
`bun <script>`. The full command line, redacted for credential flags, appears in the row tooltip.
If Server Core is unavailable, the Sessions group is empty and every process lists under Caxri.

The grid is a treegrid with a single roving Tab stop:

- Up, Down, Home, and End move between rows.
- Left and Right fold, unfold, and move between parent and child rows.
- Enter and Space toggle a row, and Alt-click toggles a whole subtree.
- Columns sort and resize, and the widths persist.
