import { join } from 'node:path';

import { AgentTimelineService } from '../../../apps/server/src/domains/agents/timeline';
import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    userData: string;
    sessionId: string;
    homeDirectory: string;
    variables: Record<string, string>;
}

/**
 * Reads the newest 80 Timeline items of a Session's primary Agent the way Server Core projects them.
 */
export async function run(input: Input): Promise<unknown> {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const session = database.getSession(input.sessionId);
        if (!session?.primaryAgentTerminalId)
            throw new Error('Synthetic Conversation primary Agent is unavailable');
        const timeline = new AgentTimelineService(database, {
            homeDirectory: input.homeDirectory,
            variables: input.variables,
        });
        return await timeline.read(session.id, session.primaryAgentTerminalId, undefined, 80);
    } finally {
        database.close();
    }
}
