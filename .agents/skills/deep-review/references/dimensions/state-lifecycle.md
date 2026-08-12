---
id_prefix: life
verify: true
skip_when: no async resource, persistence, identity, PTY, watcher, Runtime, editor model, or window lifecycle touched
---

# State and Lifecycle

Check ownership over time: creation, attachment, switching, failure, restart, deletion, and disposal.

## Quick checklist

- Session-scoped Renderer state, Monaco model URI, search result, layout, editor buffer, or inspector
  selection survives a Session switch under the wrong identity
- Project-scoped authority is duplicated into Session-supplied paths or leaks across Projects
- Switching Sessions or moving a Terminal view restarts, duplicates, resizes, or terminates the
  Runtime-owned PTY
- Snapshot replay is not awaited before buffered live output, snapshot bytes are replayed twice, or
  output is sent to detached views
- Runtime crash/restart implies an operating-system PTY survived, or persisted snapshots are treated
  as proof of a live process
- Runtime and Renderer crash loops lose their cap/backoff/fail-closed behavior
- Terminal close, Session delete, or in-flight Agent discovery can create an orphan process or bind
  stale metadata after ownership was removed
- Listener, timer, watcher, subscription, AbortController, pending request, SQLite handle, or child
  process has no bounded cleanup path
- SQLite schema changes are hand-written, migrations are not bundled, transactions/foreign keys are
  weakened, or readers cannot handle state written by the previous app version
- Settings/config updates replace the last valid in-memory value before atomic disk replacement and
  validation succeed
- File watcher fallback runs beside a healthy native watcher, watches stale roots, or fails to reset
  on identity changes

## How to check

1. Draw the resource owner and state transitions for the changed object.
2. Trace create, attach, detach, exit, restart, delete, and application quit paths.
3. Check late async completions against current durable identity before they mutate state.
4. For persistence changes, inspect generated SQL, old readers/writers, startup migration loading,
   and rollback behavior.

## Rule sources

- `.agents/skills/project-architecture/references/architecture.md`
- `.agents/skills/debug/SKILL.md`
- `.agents/skills/unit-test/SKILL.md` and `.agents/skills/e2e-testing/SKILL.md`

## Not violations

- Metadata-only Project or Session deletion that deliberately retains files
- A Runtime restart marking terminals dead; that is the documented recovery limit
- Renderer-local Terminal clear behavior that intentionally does not affect PTY state
