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
    currentSessionId: () => string | undefined,
    /**
     * The live Runtime-only fields only a running Server Core knows, so they are not stored columns: when a Chat
     * continues after a plan limit resets, and the Agent's current subphase (`background` lets the phone tell an Agent
     * waiting on its own background work from a live turn).
     */
    live: {
        agentOperation: (terminalId: string) => TerminalRecord['agentOperation'];
        usageLimitWaitAt: (terminalId: string) => number | undefined;
    },
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
                        const waitingAt = live.usageLimitWaitAt(terminal.id);
                        const agentOperation = live.agentOperation(terminal.id);
                        return {
                            ...terminal,
                            ...(waitingAt !== undefined && { usageLimitWaitAt: waitingAt }),
                            ...(agentOperation !== undefined && { agentOperation }),
                        };
                    }),
            },
            homedir(),
        ),
    };
}
