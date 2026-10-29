import { readActiveContext } from './active-context';
import type { CaxriDatabase } from './db';
import { lastDatabaseRebuildReport } from './diagnostics';
import type { DomainHandlers } from './domain-services';
import type { WindowPresence } from './window-presence';
import type { createWorkbenchSnapshots } from './workbench';

/**
 * The `app.*` reads every client starts from: the workbench bootstrap and records, the active context, and health.
 */
export function createAppHandlers(options: {
    countRunning: () => number;
    database: CaxriDatabase;
    pid: number;
    presence: Pick<WindowPresence, 'currentSessionId'>;
    snapshots: ReturnType<typeof createWorkbenchSnapshots>;
    startedAt: number;
}): Pick<
    DomainHandlers,
    'app.activeContext' | 'app.bootstrap' | 'app.health' | 'app.records' | 'app.sessionContext'
> {
    const { database, presence, snapshots } = options;
    return {
        'app.bootstrap': ({ windowKey }) => snapshots.bootstrap(windowKey),
        'app.activeContext': () => readActiveContext(database, () => presence.currentSessionId()),
        'app.sessionContext': ({ sessionId }) => readActiveContext(database, () => sessionId),
        'app.records': ({ sessionIds, terminalIds }) => snapshots.records(sessionIds, terminalIds),
        'app.health': () => ({
            ready: true,
            pid: options.pid,
            startedAt: options.startedAt,
            activePtyCount: options.countRunning(),
            lastDatabaseRebuild: lastDatabaseRebuildReport(database),
        }),
    };
}
