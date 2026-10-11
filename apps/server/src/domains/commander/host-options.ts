import type { ServerEvent } from '@caxri/protocol';
import { isChatTerminal } from '@caxri/protocol';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalManager } from '../terminal';
import type { AgentCommanderServiceOptions } from './service';

export type CommanderHostOptions = Omit<
    AgentCommanderServiceOptions,
    'database' | 'pullRequests' | 'userDataPath'
>;

/**
 * Adapts the composed Server's Terminal, restore, and event primitives to the Commander service's host contract, so
 * `createDomainServices` passes its primitives instead of spelling out every Commander-specific closure inline.
 */
export function commanderHostOptions(dependencies: {
    agentChat: Pick<AgentChatService, 'closeSession' | 'resumeSession'>;
    coordinator: Pick<AgentCoordinator, 'probeTerminal'>;
    database: Pick<CaxriDatabase, 'getTerminal'>;
    createAndStartTerminal: CommanderHostOptions['createAndStartTerminal'];
    restores: { cancel(sessionId: string): void; settled(sessionId: string): Promise<void> };
    restoreTerminals: (sessionId: string, options: { includeDetached: boolean }) => void;
    scopedWorkbench: CommanderHostOptions['scopedWorkbench'];
    send: (event: ServerEvent) => void;
    sendFullStateChange: () => void;
    terminals: Pick<TerminalManager, 'suspend'>;
}): CommanderHostOptions {
    const { agentChat, coordinator, database, restores, send, terminals } = dependencies;
    return {
        cancelRestore: (sessionId) => {
            restores.cancel(sessionId);
            return restores.settled(sessionId);
        },
        createAndStartTerminal: dependencies.createAndStartTerminal,
        probeTerminal: (terminalId) => coordinator.probeTerminal(terminalId),
        /**
         * `includeDetached` is what lets an explicit reopen resume a Commander the user stopped: `commander.stop` parks
         * it as `detached`, which an ordinary restore leaves alone. A Chat Commander the user stopped is parked the
         * same way and resumes through the Chat service; one that is merely not running starts on the window's first
         * read.
         */
        restoreTerminals: (sessionId) => {
            dependencies.restoreTerminals(sessionId, { includeDetached: true });
            agentChat.resumeSession(sessionId);
        },
        scopedWorkbench: dependencies.scopedWorkbench,
        sendFullStateChange: dependencies.sendFullStateChange,
        sendTerminalChange: (terminalId) =>
            send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
            }),
        /**
         * The Commander Session holds only the Commander Terminal, so parking its Chats parks exactly the Commander.
         * `detached` keeps a read from relaunching it until the next `commander.ensure`.
         */
        stopTerminal: (terminalId) => {
            const terminal = database.getTerminal(terminalId);
            return terminal && isChatTerminal(terminal)
                ? agentChat.closeSession(terminal.sessionId, 'detached')
                : terminals.suspend(terminalId, 'detached');
        },
    };
}
