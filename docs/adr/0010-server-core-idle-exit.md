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

**Decision**: once the aggregate authenticated connection count across every transport (Desktop, Mobile, Agent, or
CLI) has stayed at zero continuously for `DEFAULT_IDLE_EXIT_MS` (30 minutes — long enough to outlive an ordinary
Desktop restart or update-relaunch gap, short enough to bound an abandoned orphan's resource cost), Server Core exits
through its normal shutdown path: snapshot every live Terminal, then stop Terminal Host and Extension Host. The sweep
never reads the Desktop lease directly — a connected Desktop occupies one of the counted control connections, so the
lease expiring (or the socket simply dropping) already zeroes that connection the same instant, with no separate lease
check needed. This applies to packaged builds too, since ADR 0004 already makes the Server independently deployable
and Mobile-only access must not be starved by treating "no Desktop" as the exit signal on its own. The threshold is
never a user-facing setting — it is overridable only through the internal `CAXRI_SERVER_IDLE_EXIT_MS` environment seam
(`apps/server/src/core/idle-exit.ts`), which `switch-worktree dev` live verification uses to shorten the wait.

The sweep never fires while at least one Terminal PTY is active (`app.health.activePtyCount > 0`), the same signal the
interactive `host.stop` command checks: it throws `CONFLICT` unless the caller passes `confirmLivePtys`
(`apps/server/src/core/server-core.ts`), because stopping live PTYs always needs an explicit confirmation from
somebody. An unattended idle-exit sweep has nobody to ask, so it defers instead of guessing — logged with the closed
reason `active-pty` — and rechecks after another full threshold window. A failed health check during the check is also
treated as busy, for the same reason. The consequence is deliberate and permanent: a Server whose Sessions still own
live PTYs never idle-exits on its own, however long it sits at zero connections; `switch-worktree`'s
`orphans`/`doctor` commands remain the discovery path for that case.

## Considered options

- **Enable idle-exit only for development/unpackaged builds.** Rejected: it would leave the exact packaged orphan
  this decision exists to fix, and Mobile-only access to a packaged Server should still self-clean when genuinely
  unused, not just when a Desktop happens to be involved.
- **Keep relying on discovery/notification only (issue #1231).** Rejected: it surfaces an orphan to a human but never
  reclaims it, so a machine that is never inspected keeps paying the resource cost forever.
