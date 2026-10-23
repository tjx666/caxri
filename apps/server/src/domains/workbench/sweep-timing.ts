import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * A full Workbench Root sweep that finishes faster than this stays silent. Focus fires it on every app activation, so
 * logging each one would bury the rare slow sweep this exists to explain.
 */
const SWEEP_SLOW_LOG_MS = 200;

/**
 * Collects the phases of one all-Session Workbench Root sweep so a slow one can be attributed after the fact. A 7s
 * sweep was once visible only as a long `session.validateWorkbenchRoots` request, with no way to tell whether the time
 * went into listing Sessions, a forced Git topology read (which queues behind the shared Git command budget), or a
 * filesystem identity check. Per-command Git `queueMs` / `execMs` stay in the `git.command` debug events.
 */
export class SweepTimer {
    private readonly startedAt: number;
    private listSessionsMs = 0;
    private sessionCount = 0;
    private bindingCount = 0;
    private ownerCount = 0;
    private topologyMs = 0;
    private slowestOwner: { projectId: string; sessions: number; topologyMs: number } | undefined;
    private rootIdentityMs = 0;
    private slowestRootIdentityMs = 0;

    constructor(
        private readonly logger: StructuredLogger,
        private readonly now: () => number = () => performance.now(),
    ) {
        this.startedAt = this.now();
    }

    /**
     * Times the synchronous `listSessions` plus binding lookups that group Sessions by owner Project.
     */
    listed(startedAt: number, sessionCount: number, bindingCount: number): void {
        this.listSessionsMs = this.now() - startedAt;
        this.sessionCount = sessionCount;
        this.bindingCount = bindingCount;
    }

    topology(projectId: string, sessions: number, startedAt: number): void {
        const elapsed = this.now() - startedAt;
        this.ownerCount += 1;
        this.topologyMs += elapsed;
        if (!this.slowestOwner || elapsed > this.slowestOwner.topologyMs)
            this.slowestOwner = { projectId, sessions, topologyMs: elapsed };
    }

    rootIdentity(startedAt: number): void {
        const elapsed = this.now() - startedAt;
        this.rootIdentityMs += elapsed;
        this.slowestRootIdentityMs = Math.max(this.slowestRootIdentityMs, elapsed);
    }

    mark(): number {
        return this.now();
    }

    finish(): void {
        const durationMs = this.now() - this.startedAt;
        if (durationMs < SWEEP_SLOW_LOG_MS) return;
        this.logger.write('warn', logEventCatalog.workbenchRoot.sweepSlow, {
            durationMs,
            fields: {
                bindingCount: this.bindingCount,
                listSessionsMs: this.listSessionsMs,
                ownerCount: this.ownerCount,
                rootIdentityMs: this.rootIdentityMs,
                sessionCount: this.sessionCount,
                slowestOwnerProjectId: this.slowestOwner?.projectId ?? null,
                slowestOwnerSessions: this.slowestOwner?.sessions ?? null,
                slowestOwnerTopologyMs: this.slowestOwner?.topologyMs ?? null,
                slowestRootIdentityMs: this.slowestRootIdentityMs,
                topologyMs: this.topologyMs,
            },
        });
    }
}
