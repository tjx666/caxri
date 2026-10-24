---
kind: living
status: current
---

# Performance Monitor

A draggable frame rate and resource monitor, modeled on Chromium's "Frame Rate" HUD (fps with a
per-frame bar graph, GPU raster state, GPU memory) and extended with Caxri-specific readings.
Open it with `Toggle Performance Monitor` (Help menu, command palette) or
`Open Performance Monitor Window`. It runs only on the local machine.

## Modes

- **Overlay**: a draggable card inside the Workbench window. Position and mode persist in the
  window's `localStorage`.
- **Window**: a separate always-on-top window (toggle in its footer). It survives a Workbench reload,
  so it can reload the Workbench (`Reload`, `Hard reload`) and time it. The mode switch at the bottom of
  either view moves the monitor to the other.

## Readings

| Reading                          | Source                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| fps, min, 1% low, bar graph      | `requestAnimationFrame` timestamps in the Workbench Renderer    |
| Long frames                      | `long-animation-frame` PerformanceObserver                      |
| JS heap                          | `performance.memory`                                            |
| Session switch                   | Time from `session.select` to its convergence in the Renderer   |
| GPU raster                       | `app.getGPUFeatureStatus().rasterization` (`enabled*` is on)    |
| GPU process memory, per-role CPU | `app.getAppMetrics()` via a reader shared with Process Explorer |
| Server CPU and memory            | `ps` on the Server Core process                                 |
| Monitor cost                     | Smoothed duration of the monitor's own frame callback           |

Sampling runs only while a view is open: with the monitor closed no frame callback, observer, or
timer exists (Renderer CPU 0.00% idle in the measurement below).

## Reload timeline

Main records each Workbench navigation, however it was triggered (button, menu, `Cmd+R`), with
stages measured from `did-start-navigation`: DOM ready, loaded, loader removed, first frame. The
last ten loads are kept; failures show where the load stopped.

## Measured overhead

Idle Workbench with no Session, visible window, average Renderer CPU over 12 samples:
closed 0.00%, overlay 0.13 to 0.18%, detached window 0.13 to 0.21%. Monitor frame callback cost
5 to 10 microseconds.

## Limits

- GPU memory "used / max" as in Chromium's HUD is not available: Electron exposes no GPU memory
  budget. The monitor shows the GPU process memory instead.
- fps is the main thread's frame callback rate, not the compositor's presented rate (that needs the
  debugger protocol). An idle page therefore reads the display refresh rate.
- The Window mode's bounds are not persisted. Only the primary Workbench window is monitored.
