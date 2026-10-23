import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { GitWorktreeTopology } from '../git';
import { SweepTimer } from './sweep-timing';

export type TopologyValidation =
    { status: 'available'; topology: GitWorktreeTopology } | { status: 'unavailable' };

type SessionBinding = NonNullable<ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>>;

interface SweepOptions {
    database: CaxriDatabase;
    /**
     * True once the owning service is closing; the sweep then stops at the next owner or binding boundary.
     */
    isClosed(): boolean;
    loadTopology(ownerRoot: string): Promise<GitWorktreeTopology>;
    logger: StructuredLogger;
    validateBinding(
        sessionId: string,
        binding: SessionBinding,
        topologyValidation: TopologyValidation,
        timer: SweepTimer,
    ): Promise<boolean>;
}

/**
 * Revalidates every Session's Workbench Root binding, grouped by owning Project so each owner's Git topology is read
 * once, and logs a per-phase breakdown when the sweep is slow.
 */
export async function sweepWorkbenchRoots(options: SweepOptions): Promise<void> {
    const timer = new SweepTimer(options.logger);
    const listStartedAt = timer.mark();
    const groups = new Map<string, Array<{ binding: SessionBinding; sessionId: string }>>();
    const sessions = options.database.listSessions();
    let bindingCount = 0;
    for (const session of sessions) {
        const binding = options.database.getSessionWorkbenchBinding(session.id);
        if (!binding || binding.workbenchProjectId === binding.projectId) continue;
        const entries = groups.get(binding.projectId) ?? [];
        entries.push({ binding, sessionId: session.id });
        groups.set(binding.projectId, entries);
        bindingCount += 1;
    }
    timer.listed(listStartedAt, sessions.length, bindingCount);
    /**
     * This sweep gates Workbench Root filesystem authorization, so it deliberately stays sequential: an unexpected
     * throw must stop the remaining validations instead of letting concurrently dispatched entries finish mutating
     * Session bindings after the failure.
     */
    for (const [ownerProjectId, entries] of groups) {
        if (options.isClosed()) return;
        const owner = options.database.getProject(ownerProjectId);
        let topologyValidation: TopologyValidation = { status: 'unavailable' };
        const topologyStartedAt = timer.mark();
        if (owner)
            try {
                topologyValidation = {
                    status: 'available',
                    // eslint-disable-next-line no-await-in-loop -- fail-fast ordering, see above
                    topology: await options.loadTopology(owner.rootPath),
                };
            } catch {
                // Every Session in this owner group receives the same fail-closed result.
            }
        timer.topology(ownerProjectId, entries.length, topologyStartedAt);
        for (const entry of entries) {
            if (options.isClosed()) return;
            // eslint-disable-next-line no-await-in-loop -- fail-fast ordering, see above
            await options.validateBinding(
                entry.sessionId,
                entry.binding,
                topologyValidation,
                timer,
            );
        }
    }
    timer.finish();
}
