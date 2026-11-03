---
kind: living
status: current
---

# Idle CPU and memory baseline

What the Desktop app costs while nobody touches it: CPU share and memory of every Caxri process with
a visible window. Agent CLI processes are excluded, since their cost belongs to the Agent.

## How it is measured

```bash
CAXRI_BENCHMARK_PROJECT_ROOT=/path/to/repository bun run benchmark:idle
```

`e2e/idle.performance.e2e.ts` launches a fresh isolated profile with a **visible window and GPU
enabled** (a hidden or GPU-less window paints differently: with `--disable-gpu`, the blinking
Terminal cursor alone read as 6% Renderer CPU), adds the repository as a Project, and samples two
states for 60 seconds each after a 20 second settle:

- `terminal`: one shell Terminal Session in front.
- `chat`: an Agent Chat opened in front of it (a fake Codex, so no real Agent runs).

`sampleIdleResources` (`e2e/support/process-resources.ts`) groups processes by role: Electron's
`app.getAppMetrics()` types (`electron:Browser` is Desktop Main, `electron:Tab` the Renderer,
`electron:GPU`, `electron:Utility`) plus `server-core`, `terminal-host`, and `extension-host`. Per
role it reports:

- `cpuPercent`: CPU time used over the window as a share of one core (100 = one core busy).
- `footprintMb`: physical footprint, the value Activity Monitor's Memory column shows. Use this for
  totals.
- `rssMb`: resident set size. Electron processes map the same framework pages, so summing RSS
  across roles counts them repeatedly and overstates the app by roughly 2x.

The receipt goes to `test-results/receipts/idle-resources.json` and stdout
(`CAXRI_IDLE_BENCHMARK`). The benchmark asserts no budget: idle numbers depend on the machine, the
display, and the macOS version, so compare receipts from the same machine only.

## Baseline (2026-11, v0.0.155, Apple M5 Max, Retina display)

Fresh profile, this repository as the Project, production build:

| Role                 | `terminal` CPU | `terminal` footprint | `chat` CPU | `chat` footprint |
| -------------------- | -------------- | -------------------- | ---------- | ---------------- |
| Desktop Main         | 0.3%           | 108 MB               | 0.2%       | 110 MB           |
| Renderer             | 1.0-1.4%       | 313 MB               | 0.4-0.7%   | 295 MB           |
| GPU                  | 0.7%           | 465-471 MB           | 0.5%       | 82-86 MB         |
| Utility              | 0%             | 8 MB                 | 0%         | 8 MB             |
| Server Core          | 0.3%           | 108 MB               | 0.5%       | 85 MB            |
| Terminal Host        | 0.1%           | 43 MB                | 0.1%       | 29 MB            |
| Extension Host       | 0%             | 33 MB                | 0%         | 33 MB            |
| **Total** (two runs) | 2.4-3.6%       | 1,076-1,084 MB       | 1.7-2.0%   | 642-662 MB       |

A visible Terminal holds about 380 MB more GPU memory than the same window showing a Chat. That GPU
memory is the largest single idle cost and the first place to look when reducing the footprint.

Daily use, sampled read-only from the installed app over 60 seconds (11 Projects, 33 open Sessions,
3 Agents running, Chat in front): about 1.7% CPU and 950 MB footprint (Renderer 451 MB, Server Core
240 MB, GPU 123 MB, Desktop Main 92 MB, Extension Host 35 MB). Server Core grows with the number of
Sessions and Agent histories it holds, so it is about 2.5x the fresh-profile figure.
