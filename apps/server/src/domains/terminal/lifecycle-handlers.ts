import type { FullStateChangeReason, TerminalKind, TerminalRecord } from '@caxri/protocol';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator, AgentTranscriptWatcher } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { MobileTerminalMutationQueue } from '../mobile';
import type { createTerminalCreation } from './creation';
import type { TerminalManager } from './manager';

interface TerminalLifecycleHandlerOptions {
    agentChat: Pick<AgentChatService, 'close'>;
    coordinator: Pick<
        AgentCoordinator,
        'forgetTerminal' | 'probeSessionPrimaryAgent' | 'probeTerminal'
    >;
    createAndStartTerminal: ReturnType<typeof createTerminalCreation>['createAndStartTerminal'];
    createChatTerminal: (
        sessionId: string,
        kind: TerminalKind,
        cwd?: string,
    ) => Promise<TerminalRecord>;
    database: CaxriDatabase;
    mobileTerminalMutations: MobileTerminalMutationQueue;
    sendFullStateChange: (reason: FullStateChangeReason) => void;
    terminals: Pick<TerminalManager, 'close'>;
    transcripts: Pick<AgentTranscriptWatcher, 'forgetTerminal'>;
}

/**
 * Creating and closing a Terminal on either surface. A Chat is created without a PTY and its provider starts on the
 * first read; closing one ends its provider process alongside the record.
 */
export function createTerminalLifecycleHandlers(
    options: TerminalLifecycleHandlerOptions,
): Pick<
    DomainHandlers,
    'terminal.close' | 'terminal.create' | 'terminal.createInExternalDirectory'
> {
    const { agentChat, coordinator, database, sendFullStateChange, terminals } = options;
    return {
        'terminal.create': async ({ sessionId, kind, cwd, surface }) => {
            const terminal =
                surface === 'chat'
                    ? await options.createChatTerminal(sessionId, kind, cwd)
                    : await options.createAndStartTerminal(sessionId, kind, cwd);
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
            sendFullStateChange('terminal.create');
            return terminal;
        },
        'terminal.createInExternalDirectory': async ({ sessionId, cwd }) => {
            const terminal = await options.createAndStartTerminal(
                sessionId,
                'shell',
                cwd,
                undefined,
                cwd,
            );
            sendFullStateChange('terminal.create');
            return terminal;
        },
        'terminal.close': ({ terminalId }) =>
            options.mobileTerminalMutations.run(terminalId, () => {
                const sessionId = database.getTerminal(terminalId)?.sessionId;
                coordinator.forgetTerminal(terminalId);
                options.transcripts.forgetTerminal(terminalId);
                void agentChat.close(terminalId);
                terminals.close(terminalId);
                if (sessionId) coordinator.probeSessionPrimaryAgent(sessionId);
                sendFullStateChange('terminal.close');
                return null;
            }),
    };
}
