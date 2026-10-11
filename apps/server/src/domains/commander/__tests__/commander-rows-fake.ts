import type { AgentCommanderRowReader } from '../../db';

/**
 * The Commander row lookups a notifier fake needs, with a fixed system Project and Session. `terminalId` is read on
 * every call, so a test can stop or replace the Commander by changing what it returns. The caller supplies
 * `getSession`, which must report `projectId: 'commander-project'`.
 */
export function commanderRowReader(
    terminalId: () => string | undefined,
): Omit<AgentCommanderRowReader, 'getSession'> {
    return {
        getAppState: () => {
            const id = terminalId();
            return id
                ? {
                      projectId: 'commander-project',
                      sessionId: 'commander-session',
                      terminalId: id,
                      sessionIds: [],
                  }
                : undefined;
        },
        getProject: (id) => ({ id }),
        getTerminal: (id) => ({ id, sessionId: 'commander-session' }),
    };
}
