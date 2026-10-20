import type { ServerEvent } from '@caxri/protocol';

import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { MobileTerminalMutationQueue } from '../mobile';
import type { TerminalManager } from './manager';

/**
 * Registers `terminal.moveToNewSession`, which moves a Terminal into a fresh Session and selects it.
 */
export function createTerminalMoveHandler(dependencies: {
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    mobileTerminalMutations: MobileTerminalMutationQueue;
    /**
     * `moveTerminalToNewSession` makes the new Session the requesting window's active one, so the window's presence
     * must follow at once or the Session it left stays the one the watchers and Project Status serve.
     */
    noteWindowViewing: (windowKey: string, sessionId: string) => void;
    send: (event: ServerEvent) => void;
    terminals: TerminalManager;
}): Pick<DomainHandlers, 'terminal.moveToNewSession'> {
    const { coordinator, database, mobileTerminalMutations, noteWindowViewing, send, terminals } =
        dependencies;
    return {
        // Moves a live Terminal into a brand-new Session (DB ownership + PTY cache, see
        // `TerminalManager.reassignSession`'s JSDoc for why both must stay in sync).
        'terminal.moveToNewSession': ({ terminalId, windowKey }) => {
            const sourceSessionId = database.getTerminal(terminalId)?.sessionId ?? '';
            const projectId = database.getSession(sourceSessionId)?.projectId;
            return mobileTerminalMutations.runProjectSessionTerminal(
                projectId,
                sourceSessionId,
                terminalId,
                () => {
                    const sourceSessionId = database.getTerminal(terminalId)?.sessionId;
                    const moved = database.moveTerminalToNewSession(terminalId, windowKey);
                    terminals.reassignSession(terminalId, moved.session.id);
                    if (sourceSessionId) coordinator.probeSessionPrimaryAgent(sourceSessionId);
                    if (windowKey) noteWindowViewing(windowKey, moved.session.id);
                    if (moved.terminal.provider) coordinator.probeTerminal(moved.terminal.id);
                    send({
                        event: 'state.changed',
                        payload: { kind: 'full', reason: 'terminal.moveToNewSession' },
                    });
                    return moved;
                },
            );
        },
    };
}
