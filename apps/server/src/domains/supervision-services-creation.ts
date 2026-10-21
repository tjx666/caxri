import type { AgentChatService } from './agent-chat';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import type { createRootServices } from './root-services';
import type { TerminalManager } from './terminal';
import {
    createTerminalHandlers,
    TerminalResourceMonitor,
    TerminalSuspensionService,
} from './terminal';
import type { WindowPresence } from './window-presence';

type RootServices = Awaited<ReturnType<typeof createRootServices>>;

/**
 * Owns the background Terminal supervision slice: idle suspension and the resource monitor. Create: builds both
 * services and publishes the suspension service through `suspensionState` for the launch hooks wired before it exists.
 * Register: the returned `handlers` are the Terminal methods that read them. Start: `start` begins both pollers once
 * every handler is registered. Close: `close` stops suspension before the resource monitor; the composition root calls
 * it after Chats and benchmarks shut down and before Terminals do.
 */
export function createTerminalSupervision({
    agentChat,
    configuration,
    database,
    dependencies,
    presence,
    suspensionState,
    terminals,
    transcripts,
    watchHub,
}: Pick<RootServices, 'configuration' | 'transcripts' | 'watchHub'> & {
    agentChat: AgentChatService;
    database: CaxriDatabase;
    dependencies: DomainDependencies;
    presence: Pick<WindowPresence, 'isSettled' | 'visibleSessionIds'>;
    suspensionState: { service?: TerminalSuspensionService };
    terminals: TerminalManager;
}) {
    const { logger, send } = dependencies;
    const terminalSuspension = new TerminalSuspensionService({
        database,
        logger,
        send,
        settings: () => configuration.getSettings().value,
        isPresenceSettled: () => presence.isSettled(),
        visibleSessionIds: () => presence.visibleSessionIds(),
        ...dependencies.terminalSuspension,
        remoteObservers: [dependencies.terminalExecution, transcripts, agentChat],
        terminals,
        chats: agentChat,
        watchHub,
    });
    suspensionState.service = terminalSuspension;
    const resourceMonitor = new TerminalResourceMonitor({
        database,
        logger,
        send,
        terminals,
        watchHub,
    });
    return {
        handlers: createTerminalHandlers({
            countLiveChats: (sessionId) => agentChat.liveCount(sessionId),
            database,
            resourceMonitor,
            terminals,
            terminalSuspension,
        }),
        terminalSuspension,
        start: (): void => {
            terminalSuspension.start();
            resourceMonitor.start();
        },
        close: async (): Promise<void> => {
            await terminalSuspension.close();
            await resourceMonitor.close();
        },
    };
}
