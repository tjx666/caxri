import { homedir } from 'node:os';
import { dirname } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { LogQueryService } from './logs';
import { RecordQueryService } from './records';

export * from './logs';
export * from './records';

/**
 * Keeps the domain-service composition root small while all introspection sources remain domain-owned.
 */
export function createIntrospectionServices(
    database: CaxriDatabase,
    logger: StructuredLogger,
    presence: { currentSessionId(): string | undefined },
    /**
     * The Workbench's live projection, so CLI queries report the same Runtime-only fields Clients see, such as when a
     * Chat continues after a plan limit resets and whether an Agent only waits on its own background work.
     */
    liveTerminalRecord: (terminal: TerminalRecord) => TerminalRecord,
) {
    return {
        logs: new LogQueryService(dirname(logger.path)),
        records: new RecordQueryService(
            {
                currentProjectId: () => {
                    const sessionId = presence.currentSessionId();
                    const session = sessionId ? database.getSession(sessionId) : undefined;
                    return (
                        session?.projectId ??
                        database.getAppState('lastSelectedProjectId') ??
                        undefined
                    );
                },
                currentSessionId: () => presence.currentSessionId(),
                // Hidden Projects stay out of CLI queries exactly as they stay out of the Workbench.
                projects: () => database.listVisibleProjects(),
                sessions: () => database.listVisibleSessions(),
                terminals: () => database.listTerminals().map(liveTerminalRecord),
            },
            homedir(),
        ),
    };
}
