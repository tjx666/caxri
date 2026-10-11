import type { ServerEvent } from '@caxri/protocol';

import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { MobileTerminalMutationQueue } from '../mobile';
import type { TerminalManager } from './manager';

/**
 * Kept out of `create-domain-services.ts` to stay under the file's physical-line budget, matching
 * `../service-handlers.ts`. and `../workbench/roots.ts`'s precedent for extracted handler groups.
 */
export function createTerminalMoveHandler(dependencies: {
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    mobileTerminalMutations: MobileTerminalMutationQueue;
    /**
     * `moveTerminalToNewSession` makes the new Session the selected one, so this must be the composition root's shared
     * selection hook (not just the file watcher) or Project Status keeps polling the Session left behind.
     */
    observeSelectedSession: (sessionId: string | undefined) => void;
    send: (event: ServerEvent) => void;
    terminals: TerminalManager;
}): Pick<DomainHandlers, 'terminal.moveToNewSession'> {
    const {
        coordinator,
        database,
        mobileTerminalMutations,
        observeSelectedSession,
        send,
        terminals,
    } = dependencies;
    return {
        // Moves a live Terminal into a brand-new Session (DB ownership + PTY cache, see
        // `TerminalManager.reassignSession`'s JSDoc for why both must stay in sync).
        'terminal.moveToNewSession': ({ terminalId }) => {
            const sourceSessionId = database.getTerminal(terminalId)?.sessionId ?? '';
            const projectId = database.getSession(sourceSessionId)?.projectId;
            return mobileTerminalMutations.runProjectSessionTerminal(
                projectId,
                sourceSessionId,
                terminalId,
                () => {
                    const sourceSessionId = database.getTerminal(terminalId)?.sessionId;
                    const moved = database.moveTerminalToNewSession(terminalId);
                    terminals.reassignSession(terminalId, moved.session.id);
                    if (sourceSessionId) coordinator.probeSessionPrimaryAgent(sourceSessionId);
                    observeSelectedSession(moved.session.id);
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
