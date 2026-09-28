---
kind: adr
status: accepted
---

# Server Core idle-exit policy

- Date: 2026-09-29
- Refs: issue #1234

Explicit Desktop quit already stops an idle Server Core directly (see
[Process ownership](../../.agents/skills/project-architecture/references/process-model.md)), but a Desktop that is
force-killed, crashes, or restarts mid-stop never runs that path: Server Core, Terminal Host, and Extension Host then
keep running as `PPID=1` orphans indefinitely — one observed case survived roughly 41 hours with no Project, Session,
or Desktop connection at all.

**Decision**: once the Desktop lease has expired and no authenticated connection of any kind (Desktop, Mobile, Agent,
or CLI) has existed continuously for `DEFAULT_IDLE_EXIT_MS` (30 minutes — long enough to outlive an ordinary Desktop
restart or update-relaunch gap, short enough to bound an abandoned orphan's resource cost), Server Core exits through
its normal shutdown path: snapshot every live Terminal, then stop Terminal Host and Extension Host. This applies to
packaged builds too, since ADR 0004 already makes the Server independently deployable and Mobile-only access must not
be starved by treating "no Desktop" as the exit signal on its own. The threshold is never a user-facing setting — it
is overridable only through the internal `CAXRI_SERVER_IDLE_EXIT_MS` environment seam
(`apps/server/src/core/idle-exit.ts`), which `switch-worktree dev` live verification uses to shorten the wait.

The sweep never fires while at least one Terminal PTY is active (`app.health.activePtyCount > 0`). Terminal Host does
not distinguish a busy Agent from an ordinary running shell command at this layer, and an unattended idle-exit sweep
has nobody to ask for confirmation the way the interactive `host.stop` command does when it hits the same signal — so
both cases defer identically, logged with the closed reason `active-pty`, and the sweep rechecks after another full
threshold window. A failed health check during the check is also treated as busy, for the same reason: defer, don't
guess.

## Considered options

- **Enable idle-exit only for development/unpackaged builds.** Rejected: it would leave the exact packaged orphan
  this decision exists to fix, and Mobile-only access to a packaged Server should still self-clean when genuinely
  unused, not just when a Desktop happens to be involved.
- **Keep relying on discovery/notification only (issue #1231).** Rejected: it surfaces an orphan to a human but never
  reclaims it, so a machine that is never inspected keeps paying the resource cost forever.
