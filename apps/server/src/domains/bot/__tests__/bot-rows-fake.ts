import type { CaxriBotRowReader } from '../../db';

/**
 * Caxri Bot row lookups a notifier fake needs, with a fixed system Project and Session. `terminalId` is read on every
 * call, so a test can stop or replace Caxri Bot by changing what it returns. The caller supplies `getSession`, which
 * must report `projectId: 'bot-project'`.
 */
export function botRowReader(
    terminalId: () => string | undefined,
): Omit<CaxriBotRowReader, 'getSession'> {
    return {
        getAppState: () => {
            const id = terminalId();
            return id
                ? {
                      projectId: 'bot-project',
                      sessionId: 'bot-session',
                      terminalId: id,
                      sessionIds: [],
                  }
                : undefined;
        },
        getProject: (id) => ({ id }),
        getTerminal: (id) => ({ id, sessionId: 'bot-session' }),
    };
}
