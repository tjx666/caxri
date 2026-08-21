---
id_prefix: perf
verify: true
skip_when: no startup, loop, IO, subprocess, watcher, logging, terminal, search, list, or render-path behavior touched
---

# Performance and Observability

Review cost at large-Project and terminal-throughput scale, then check whether failures remain
diagnosable without leaking user content.

## Quick checklist

- React StrictMode or concurrent callers duplicate expensive native requests instead of sharing one
  in-flight operation
- Synchronous filesystem/process work blocks Main or a Runtime hot path without a documented strict
  startup or better-sqlite3 boundary
- File traversal, search, Git, Agent discovery, process sampling, or directory metadata has
  unbounded concurrency, duration, output, candidates, or memory
- Terminal input/resize/output logs per event, crosses redundant sizes over IPC, broadcasts to
  detached views, or rebuilds/persists whole snapshots on a high-frequency interval
- Native watcher success still leaves root polling active; fallback polling scans more than the
  active root and expanded visible directories
- Timers/listeners/maps/caches/queues grow with Terminal, Session, file, output, or elapsed time
  without a cap and disposal
- Monaco/editor-only dependencies enter the terminal-first Renderer bundle, or large diff/list
  surfaces mount all editors/rows eagerly
- Startup, Runtime attachment, PTY spawn, Files, Git, Agent probes, or watcher readiness can exceed
  the three-second large-Project gate without benchmark coverage
- A non-obvious fix or workaround lacks a why-comment, or a catch silently swallows failure
- New boundary work lacks correlation/timing logs, while added logs contain content rather than
  timings, counts, IDs, relative paths, or byte totals
- A framed transport bounds individual payloads but not buffered bytes, pending requests, queued
  frames, or partial-write lifetime, so slow or disconnected peers can exceed the intended capacity

## How to check

1. Put a bound and lifetime on every loop, queue, map, cache, watcher, subprocess, and payload.
2. Multiply per-Terminal and per-file work by the documented global/session capacity.
3. Inspect existing coalescing, debounce, semaphore, and disposal helpers before proposing new ones.
4. Check the relevant benchmark assertion and structured log event for changed startup/hot paths.
5. For framed transports, put independent limits on frame bytes, buffered bytes, pending request
   count, queue depth, and write/close lifetime. Verify capacity is released on reply, timeout,
   cancellation, parse failure, and peer close.

## Rule sources

- `.agents/skills/performance/SKILL.md`
- `.agents/skills/project-architecture/references/architecture.md` performance section

## Not violations

- Micro-optimizations on cold settings or one-shot tooling paths
- Synchronous better-sqlite3 calls isolated inside the Runtime by design
- Missing telemetry that would require collecting user source, terminal, prompt, or transcript data
