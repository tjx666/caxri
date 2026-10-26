---
kind: living
status: current
---

# Mobile computer status

The Computer status screen shows the paired computer's load on the phone: system CPU and memory,
each Session's load from its running Terminals, Caxri's own services, and the busiest processes. It
is the read-only phone counterpart of Desktop's [Process Explorer](../process-explorer.md). It has no
Stop action.

## Entry and polling

A `control` device opens it from the Session home header menu (**Computer status**), route
`/h/[hostId]/status`. The screen calls `mobile.host.status` every 2 seconds, and only while it is
focused, the app is in the foreground, and the connection is up. Opening a Session from the list
stops polling until the user comes back. A pull to refresh reads immediately. The read uses the
mobile fast-read timeout.

When the phone goes offline or a refresh fails, the last reading stays on screen under a banner that
says so, and the header keeps the time of that reading. Without any reading, offline and failure
each get their own message, and failure offers Retry.

## What the Server samples

Server Core answers, not Desktop Main, because the phone talks to Server Core and it can outlive the
Desktop window. One `HostStatusSampler`
([host-status.ts](../../apps/server/src/core/mobile/host-status.ts)) serves every device. It shares
one sample for a second and coalesces concurrent requests, so several phones never multiply the
`ps` calls.

- **CPU**: the busy share of all cores between two `os.cpus()` reads. When the previous read is
  older than 10 seconds, the sampler takes a fresh pair 300 ms apart rather than averaging over a
  long idle gap. The load average and core count come with it.
- **Memory**: on macOS, used memory is anonymous minus purgeable plus wired plus compressed pages
  from `vm_stat`, the figure Activity Monitor reports, and swap comes from `sysctl vm.swapusage`. Linux
  uses `/proc/meminfo` `MemAvailable`. Other platforms fall back to total minus free. See
  [system-resources.ts](../../packages/system/src/process/system-resources.ts).
- **Sessions**: one `ps` table, plus Server Core's `terminal.processes` list, the same pairing
  Process Explorer uses. Each Terminal's figure is the sum of its PTY process tree, and a Session's
  is the sum of its Terminals. The high marker uses the shared
  [Terminal resource thresholds](../process-explorer.md#thresholds), so the phone flags the same
  Terminals Desktop alerts on.
- **Caxri services**: Server Core, Terminal Host, and Extension Host, each counting only its own
  process.
- **Top processes**: the union of the ten busiest by CPU and the ten largest by memory, so the
  phone's CPU and memory sort each show a true top ten.

The reply never carries a command line, only executable names (an interpreter adds its script
name), because command lines can hold credentials. If `ps` fails, the reply keeps the system figures
and omits the process sections, and the screen says processes are unavailable. If the Terminal list
fails, the Session section is empty but the rest stays. Each failing part logs
`mobile_gateway.host_status_sample_failed` once with a closed `part` (`processTable` or `terminals`),
and logs again only after that part has recovered and failed anew.

## Authorization and size

`mobile.host.status` is `control`-only, because the Session list spans every Project on the
computer, not only the device's granted ones. See [Mobile authorization](authorization.md).

The reply must fit one gateway frame. `projectHostStatusForMobile`
([mobile-host-status-contract.ts](../../packages/protocol/src/mobile/mobile-host-status-contract.ts))
orders Sessions busiest first, clips titles, keeps at most 8 Terminals per Session and 40 Sessions,
and drops the quietest Sessions first when the 48 KiB budget runs out. `sessionTotal` and
`terminalTotal` tell the phone how many it did not receive, and the screen says so.
