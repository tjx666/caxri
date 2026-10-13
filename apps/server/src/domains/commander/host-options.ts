import type { ServerEvent } from '@caxri/protocol';
import { isChatTerminal, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator, AgentEnvironment } from '../agents';
import { grantClaudeFolderTrust } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { TerminalManager } from '../terminal';
import type { AgentCommanderServiceOptions } from './service';

export type CommanderHostOptions = Omit<
    AgentCommanderServiceOptions,
    'database' | 'inbox' | 'onLaunching' | 'pullRequests' | 'userDataPath'
>;

/**
 * Adapts the composed Server's Terminal, restore, and event primitives to the Commander service's host contract, so
 * `createDomainServices` passes its primitives instead of spelling out every Commander-specific closure inline.
 */
export function commanderHostOptions(dependencies: {
    agentChat: Pick<AgentChatService, 'closeSession' | 'resumeSession'>;
    agentEnvironment: AgentEnvironment;
    coordinator: Pick<AgentCoordinator, 'probeTerminal'>;
    database: Pick<CaxriDatabase, 'getTerminal'>;
    createAndStartTerminal: CommanderHostOptions['createAndStartTerminal'];
    logger: StructuredLogger;
    onStopped: () => void;
    /**
     * The Workbench's own `terminal.restart`, so the Commander's conversation reset and Agent switch relaunch through
     * the same fresh restart.
     */
    restartTerminal: DomainHandlers['terminal.restart'];
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
        logger: dependencies.logger,
        onStopped: dependencies.onStopped,
        /**
         * Claude Code asks whether to trust a new folder even under `--dangerously-skip-permissions`, and only its own
         * config can answer that, so the workspace is marked trusted there before every launch. Codex takes its trust
         * as a launch argument instead (`commanderLaunchArguments`).
         */
        prepareLaunch: async (agent, workspacePath) => {
            if (agent !== 'claude') return;
            const outcome = await grantClaudeFolderTrust(dependencies.agentEnvironment, [
                workspacePath,
            ]);
            dependencies.logger.write(
                outcome === 'granted' || outcome === 'already_trusted' ? 'debug' : 'warn',
                logEventCatalog.agentCommander.claudeTrustPrepared,
                { fields: { outcome } },
            );
        },
        probeTerminal: (terminalId) => coordinator.probeTerminal(terminalId),
        relaunchFresh: async (terminalId) => {
            await dependencies.restartTerminal({ terminalId, mode: 'fresh' });
        },
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
