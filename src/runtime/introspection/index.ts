import { homedir } from 'node:os';
import { dirname } from 'node:path';

import type { StructuredLogger } from '../../shared/node/logger';
import type { CaxriDatabase } from '../db';
import { LogQueryService } from './logs';
import { RecordQueryService } from './records';

export * from './logs';
export * from './records';

/**
 * Keeps the Runtime composition root small while all introspection sources remain Runtime-owned.
 */
export function createIntrospectionServices(database: CaxriDatabase, logger: StructuredLogger) {
    return {
        logs: new LogQueryService(dirname(logger.path)),
        records: new RecordQueryService(
            {
                currentProjectId: () => database.getAppState('lastSelectedProjectId') ?? undefined,
                currentSessionId: () => database.getAppState('lastSelectedSessionId') ?? undefined,
                projects: () => database.listProjects(),
                sessions: () => database.listSessions(),
                terminals: () => database.listTerminals(),
            },
            homedir(),
        ),
    };
}
