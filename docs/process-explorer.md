---
kind: living
status: current
---

# Process Explorer and resource alerts

Caxri watches the processes it runs so that a runaway Agent never goes unnoticed, and the
machine's PTY slots so that running out of them never arrives without warning. Three surfaces
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

Electron coverage (`e2e/statusbar.e2e.ts`) drives one Terminal above and back below the thresholds
without real load. Under `CAXRI_E2E=1`, `CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE` names a JSON
file mapping Terminal IDs to an injected `cpuPercent` or `memoryMb`. Server Core re-reads it on
every sample and applies it to both `terminal.resources` (the status bar chip) and the monitor, which
then samples every second instead of every 10 seconds. Production launches ignore the variable
(`apps/server/src/domains/terminal/e2e-resource-override.ts`).

## Process Explorer

The window is read-only except for one action: a Terminal's **Stop** button calls the dedicated
`stopTerminal` preload method, which Main validates (trusted sender, valid identifier) and forwards
as `terminal.suspend` for that Terminal only. It is not a general request bridge and cannot end
arbitrary processes. Closing the window never changes Server or PTY lifecycle.

Open it from **View > Open Process Explorer**, the Command Palette, the status bar memory chip, or
a resource alert. Desktop Main samples the window every 2 seconds
(`apps/desktop/src/main/process-explorer.ts`). It combines Electron's app metrics, the `ps` tree
under Main, and Server Core's `terminal.processes` list. That list pairs each running Terminal
with its Session, Agent, and PTY root PID.

The window shows:

- **Summary bar**: total CPU, memory used out of system memory, the process count, PTY slots in
  use out of the machine limit (see [PTY slots](#pty-slots)), and a filter.
  The filter matches names, command lines, and PIDs, and opens every row while it is active.
- **Sessions** group: each Session, then each Terminal named after its Agent, with a
  "N processes" tag. Terminal rows start folded, and the PTY process tree sits under them. A
  Terminal above the thresholds gets a warning dot and warning-colored readings. Its Stop button
  (on hover or focus, or the Delete key) suspends it.
- **Caxri** group: Caxri's own processes as a flat list with role labels. The roles are Caxri
  (Main process), Workbench and Process Explorer (Window), GPU, helpers such as Network Service,
  and Server Core, Extension Host, and Terminal Host (Service). Processes that no Terminal claims
  also land here.
- **Other apps** group: processes outside Caxri that hold PTY slots, such as another terminal app
  or `tmux`. It is read-only, starts folded, and appears only when the machine reports PTY holders.
- **PTY** column: how many PTY slots each row holds. A Terminal row counts its own PTY plus every
  PTY its process tree opened, and Session and group rows sum their children.

Plain processes show only their executable. An interpreter shows its script too, such as
`bun <script>`. The full command line, redacted for credential flags, appears in the row tooltip.
If Server Core is unavailable, the Sessions group is empty and every process lists under Caxri.

A paired phone shows a read-only summary of the same data, sampled by Server Core instead of Main;
see [Mobile computer status](mobile/host-status.md).

The grid is a treegrid with a single roving Tab stop:

- Up, Down, Home, and End move between rows.
- Left and Right fold, unfold, and move between parent and child rows.
- Enter and Space toggle a row, and Alt-click toggles a whole subtree.
- Columns sort and resize, and the widths persist.

## PTY slots

Every Terminal, in Caxri or any other app, needs one PTY (pseudo-terminal) slot, and the kernel
caps how many exist at once: `kern.tty.ptmx_max` on macOS (511 by default) and
`/proc/sys/kernel/pty/max` on Linux. Once they are all taken, no app on the machine can open a new
terminal until something closes one.

Server Core's `PtyUsageMonitor` (`apps/server/src/domains/terminal/pty-usage-monitor.ts`) reads
the machine's PTY use through `@caxri/system`'s `samplePtyUsage`. On macOS it lists PTY master
holders with `lsof /dev/ptmx`; on Linux it counts `/dev/pts` entries and scans `/proc/<pid>/fd`.
An unprivileged `lsof` cannot see masters held by another user's processes (for example a
root-owned `sshd`), so the macOS figure is a lower bound; the Linux count covers every user.
`terminal.ptyUsage` returns the reading (limit, slots in use, and per-PID holders); it is cached
for 1.5 seconds so the Process Explorer's 2-second refresh and the background check share one
scan.

Process Explorer attributes the holders to rows. Terminal Host holds one PTY master per running
Terminal, so Desktop Main moves those slots from the Terminal Host row onto each Terminal row.
Holders outside Caxri's process trees form the **Other apps** group. The `lsof` and `sysctl`
queries themselves (including their exited, not yet reaped `(lsof)` form) are dropped from the
listing, like the `ps` that took the sample. A failed scan is logged as `terminal.pty_sample_failed`
and the window simply omits the PTY figures.

### PTY alert

The monitor checks every 30 seconds. It first counts PTY device nodes (`/dev/ttys*` on macOS,
`/dev/pts/*` on Linux), which never undercounts, and runs the full holder scan only when that
count reaches the alert share, so an ordinary machine never pays for `lsof` in the background.

- It publishes `raised` once slots in use reach 80% of the limit (`PTY_USAGE_ALERT_RATIO` in
  `packages/protocol/src/domain/terminal-resources.ts`).
- It publishes `cleared` only below 75%, so a machine hovering at the line does not flicker the
  notice, or with reason `stopped` when Server Core shuts down.

`terminal.ptyAlert` is a transient event delivered to the focused window. The Workbench shows a
persistent warning toast, `Almost out of terminal slots (PTYs): <in use> of <limit> in use.`, with
**View details** opening the Process Explorer (left out in an SSH Host window, whose processes the
local Process Explorer cannot see). A `cleared` event retracts it.

The monitor writes three log events: `terminal.pty_alert_raised` (readings plus the top five
holders as `pid:count`), `terminal.pty_alert_cleared` (episode `durationMs`, peak use, and a
closed `reason`), and `terminal.pty_sample_failed`.

### Exhausted launch

When node-pty fails to allocate a PTY (`forkpty(3) failed.`, `openpty(3) failed.`, or
`posix_openpt`), `TerminalManager` takes a fresh reading. If use is within two slots of the limit,
the Terminal records the `pty_exhausted` failure reason instead of `spawn_failed`, and the Terminal
pane and the mobile client say the computer is out of terminal slots and to close Terminals before
restarting. A failed or missing reading keeps `spawn_failed`, so an unrelated launch failure is
never blamed on PTYs.

Under `CAXRI_E2E=1`, `CAXRI_E2E_PTY_USAGE_OVERRIDE_FILE` names a JSON file holding the
`{ "inUse", "limit" }` Server Core should report. It is re-read on every sample, skips the
device-node pre-check, and makes the monitor sample every second. Production launches ignore the
variable (`apps/server/src/domains/terminal/e2e-pty-usage-override.ts`).
