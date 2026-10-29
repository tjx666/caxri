import { homedir } from 'node:os';
import { dirname } from 'node:path';

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
    currentSessionId: () => string | undefined,
    /**
     * When a Chat continues after a plan limit resets; only a running Server Core knows it, so it is not a stored
     * column.
     */
    usageLimitWaitAt: (terminalId: string) => number | undefined,
) {
    return {
        logs: new LogQueryService(dirname(logger.path)),
        records: new RecordQueryService(
            {
                currentProjectId: () => {
                    const sessionId = currentSessionId();
                    const session = sessionId ? database.getSession(sessionId) : undefined;
                    return (
                        session?.projectId ??
                        database.getAppState('lastSelectedProjectId') ??
                        undefined
                    );
                },
                currentSessionId,
                // Hidden Projects stay out of CLI queries exactly as they stay out of the Workbench.
                projects: () => database.listVisibleProjects(),
                sessions: () => database.listVisibleSessions(),
                terminals: () =>
                    database.listTerminals().map((terminal) => {
                        const waitingAt = usageLimitWaitAt(terminal.id);
                        return waitingAt === undefined
                            ? terminal
                            : { ...terminal, usageLimitWaitAt: waitingAt };
                    }),
            },
            homedir(),
        ),
    };
}
