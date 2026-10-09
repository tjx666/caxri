import type { ServerEvent } from '@caxri/protocol';

import type { AgentCoordinator } from '../agents';
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
    coordinator: Pick<AgentCoordinator, 'probeTerminal'>;
    createAndStartTerminal: CommanderHostOptions['createAndStartTerminal'];
    restores: { cancel(sessionId: string): void; settled(sessionId: string): Promise<void> };
    restoreTerminals: (sessionId: string, options: { includeDetached: boolean }) => void;
    scopedWorkbench: CommanderHostOptions['scopedWorkbench'];
    send: (event: ServerEvent) => void;
    sendFullStateChange: () => void;
    terminals: Pick<TerminalManager, 'suspend'>;
}): CommanderHostOptions {
    const { coordinator, restores, send, terminals } = dependencies;
    return {
        cancelRestore: (sessionId) => {
            restores.cancel(sessionId);
            return restores.settled(sessionId);
        },
        createAndStartTerminal: dependencies.createAndStartTerminal,
        probeTerminal: (terminalId) => coordinator.probeTerminal(terminalId),
        /**
         * `includeDetached` is what lets an explicit reopen resume a Commander the user stopped: `commander.stop` parks
         * it as `detached`, which an ordinary restore leaves alone.
         */
        restoreTerminals: (sessionId) =>
            dependencies.restoreTerminals(sessionId, { includeDetached: true }),
        scopedWorkbench: dependencies.scopedWorkbench,
        sendFullStateChange: dependencies.sendFullStateChange,
        sendTerminalChange: (terminalId) =>
            send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
            }),
        stopTerminal: (terminalId) => terminals.suspend(terminalId, 'detached'),
    };
}
