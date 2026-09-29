---
kind: living
status: current
---

# Startup performance

Caxri records every launch's critical path as one structured log record and ships a runner that
turns repeated packaged launches into medians. Use the medians, never a single launch: identical
builds vary by several hundred milliseconds between runs.

## What is recorded

Desktop Main writes one `app.startup_profile` record per launch to `<userData>/logs/desktop.jsonl`.
Each field is milliseconds since the Main process time origin:

| Field              | Milestone                                                             |
| ------------------ | --------------------------------------------------------------------- |
| `mainModuleMs`     | Main's entry module started evaluating                                |
| `appReadyMs`       | Electron `app.whenReady()` resolved                                   |
| `serverAttachedMs` | Main attached to a running Server Core (launched or adopted)          |
| `windowCreatedMs`  | The Workbench `BrowserWindow` was constructed                         |
| `readyToShowMs`    | The window painted its inline startup loader and was shown            |
| `rendererReadyMs`  | The preload attached its event listener                               |
| `loaderRemovedMs`  | The Workbench attached and removed `#startup-loader`                  |
| `firstFrameMs`     | Two animation frames later: the attached Workbench has been presented |

The Renderer reports the last two through the `startup-frame` Renderer diagnostic; Main rebases
them from the Renderer's time origin onto its own. A Renderer reload never reopens the profile.

The runner also reports `server.readyMs`, the `durationMs` of Server Core's `server_core.ready`
record in `server-core.jsonl`: Server Core's own startup, Extension Host start included, measured
from its entry module (Node boot excluded).

## Measuring

```bash
bun run package
bun run .agents/skills/switch-worktree/scripts/switch-worktree.ts desktop --label "startup profile" -- \
  bun run .agents/skills/performance/scripts/startup-profile.ts \
  --variant base=/tmp/Caxri-base.app/Contents/MacOS/Caxri \
  --variant head=release.noindex/mac-arm64/Caxri.app/Contents/MacOS/Caxri --runs 7
```

Each variant gets its own temporary profile. Launch zero of a profile is reported separately as the
first launch; the rest are warm restarts, each with a freshly spawned Server Core. Variants are
interleaved per round so machine drift lands on both sides. `--env label:KEY=VALUE` runs one build
under two environments.

## Current baseline

Warm medians on an Apple Silicon laptop, empty profile, September 2026:

| Milestone          |  ms |
| ------------------ | --: |
| `appReadyMs`       | 135 |
| `serverAttachedMs` | 464 |
| `windowCreatedMs`  | 530 |
| `readyToShowMs`    | 624 |
| `firstFrameMs`     | 697 |

About half of the launch sits between `appReady` and `serverAttached`: Main does not create the
window until Server Core, including its Extension Host start (~70 ms), is listening.

## Measured and rejected

These were A/B tested with the runner and showed no gain outside run-to-run noise, so they are not
enabled. Retest them only when the startup path changes materially.

- **Node compile cache** (`module.enableCompileCache()` from a bootstrap entry, Main and Server
  Core). The cache was verified to hit (1.5 MB of bytecode for Server Core's main chunk), yet
  neither `firstFrameMs` nor Server Core's process uptime moved: V8 compiles lazily, so the
  avoided parse work is small.
- **Unthrottled hidden window** (`backgroundThrottling: false` until `ready-to-show`). The window
  is hidden only until its first paint of static HTML, so there is nothing to unthrottle.
- **Renderer V8 code cache** was not attempted: packaged Renderer pages load from `file://`, and
  Chromium keeps a disk code cache only for HTTP(S) and schemes registered with `codeCache: true`.
- **VS Code's GPU channel feature switches** were not attempted: Chromium 155 no longer defines
  `EarlyEstablishGpuChannel` or `EstablishGpuChannelAsync`, and `CalculateNativeWinOcclusion` is
  Windows-only.
