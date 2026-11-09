import { join } from 'node:path';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * The profile directory that holds `caxri.db`. The app must not be running on it.
     */
    userData: string;
    /**
     * The host to resolve; without it, the newest unarchived top-level Session that has an Agent.
     */
    sessionId?: string;
}

export interface ChatHost {
    projectId: string;
    sessionId: string;
}

/**
 * Resolves the Session a `delegated-chat-seed` run seeds under, with its Project. Read-only.
 */
export function run(input: Input): ChatHost {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const host =
            input.sessionId === undefined
                ? database
                      .listSessions()
                      .filter(
                          (session) =>
                              session.createdBySessionId === undefined &&
                              session.archivedAt === undefined &&
                              session.primaryAgentTerminalId !== undefined,
                      )
                      .toSorted((left, right) => right.createdAt - left.createdAt)[0]
                : database.getSession(input.sessionId);
        if (!host) {
            throw new Error(
                'No host Session found; open a Chat with `drive-app.ts open-chat` first',
            );
        }
        return { projectId: host.projectId, sessionId: host.id };
    } finally {
        database.close();
    }
}
