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
| `readyToShowMs`    | The hidden window painted its inline startup loader                   |
| `windowShownMs`    | The window was placed (bounds, zoom) and shown                        |
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
under two environments. Every milestone reports its warm median and p95 (nearest rank).

`--seed projects,sessions,archived,terminals` fills each profile after its first launch with that
many synthetic Projects (roots under the profile), Sessions (the first `archived` of them
archived), and stopped Shell Terminals, so warm restarts measure a realistic bootstrap instead of an
empty one. No real Project, path, or Terminal content enters the seed.

## Startup design

- **Window first.** Main creates the Workbench window right after `app.whenReady()`, before Server
  Core attaches, so the Renderer loads its bundle while Server Core starts. Renderer requests and
  the events handshake wait on Server Core attachment in Main instead of failing `UNAVAILABLE`.
  The window stays hidden until its saved bounds and zoom, both owned by Server Core, have been
  applied (`window-placement.ts`), so it never appears at the default size and jumps.
- **Unthrottled while hidden.** `backgroundThrottling: false` until the window is shown, so the
  hidden page reaches its first paint and first frames without waiting for visibility.
- **Node compile cache.** Packaged builds enable `module.enableCompileCache()` for Main and Server
  Core from dedicated bootstrap entries (`apps/desktop/src/main/bootstrap.ts`,
  `apps/server/src/core/bootstrap.ts`), because ESM compiles every static import before any module
  body runs. Both flush once loaded; Node otherwise writes the cache only on a normal exit. The
  cache lives in `<userData>/compile-cache`. Dev builds leave it off.

## Current baseline

Warm medians on an Apple Silicon laptop, empty profile, September 2026, before and after the
window-first change with the compile cache and unthrottled hidden window:

| Milestone          | Before | After |
| ------------------ | -----: | ----: |
| `appReadyMs`       |    116 |   113 |
| `serverAttachedMs` |    416 |   464 |
| `windowCreatedMs`  |    477 |   173 |
| `readyToShowMs`    |    565 |   273 |
| `windowShownMs`    |      - |   478 |
| `firstFrameMs`     |    607 |   507 |

October 2026, 11 warm launches each, empty profile versus `--seed 175,245,201,253` (a long-used
profile's row counts):

| Milestone          | Empty p50 | Empty p95 | Seeded p50 | Seeded p95 |
| ------------------ | --------: | --------: | ---------: | ---------: |
| `serverAttachedMs` |       401 |       415 |        410 |        436 |
| `windowShownMs`    |       418 |       432 |        443 |        469 |
| `loaderRemovedMs`  |       436 |       452 |        559 |        584 |
| `firstFrameMs`     |       440 |       456 |        590 |        616 |

A realistic bootstrap adds about 150 ms between attachment and the first frame; attachment itself
barely moves. [Client-local data](client-local-data.md) records why that does not justify painting
a saved bootstrap before attachment.

Server Core attachment is now the critical path: the window waits for its placement, and the
Workbench for Server Core data. Attachment got slower because the Renderer now loads in parallel
and competes for CPU. The next lever is showing the window before attachment, which needs its
placement without a Server Core round trip.

## Not applicable

- **Renderer V8 code cache**: packaged Renderer pages load from `file://`, and Chromium keeps a disk
  code cache only for HTTP(S) and schemes registered with `codeCache: true`.
- **VS Code's GPU channel feature switches**: Chromium 155 no longer defines
  `EarlyEstablishGpuChannel` or `EstablishGpuChannelAsync`, and `CalculateNativeWinOcclusion` is
  Windows-only.
