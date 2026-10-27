import type { AgentChatService } from './agent-chat';
import type { AgentCoordinator } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import type { createRootServices } from './root-services';
import { ChatIdleCompaction } from './session';
import type { TerminalManager } from './terminal';
import {
    createTerminalHandlers,
    TerminalResourceMonitor,
    TerminalSuspensionService,
} from './terminal';
import type { WindowPresence } from './window-presence';

type RootServices = Awaited<ReturnType<typeof createRootServices>>;

/**
 * Owns the background Agent supervision slice: idle suspension, Chat idle compaction, automatic continuation after a
 * usage limit resets, and the resource monitor. Create: builds the services and publishes the suspension service
 * through `suspensionState` for the launch hooks wired before it exists. Register: the returned `handlers` are the
 * Terminal methods that read them. Start: `start` begins every poller once every handler is registered. Close: `close`
 * stops suspension and idle compaction before the resource monitor; the composition root calls it after Chats and
 * benchmarks shut down and before Terminals do.
 */
export function createTerminalSupervision({
    agentChat,
    configuration,
    coordinator,
    database,
    dependencies,
    presence,
    suspensionState,
    terminals,
    transcripts,
    watchHub,
}: Pick<RootServices, 'configuration' | 'transcripts' | 'watchHub'> & {
    agentChat: AgentChatService;
    coordinator: Pick<AgentCoordinator, 'maintenanceTurns'>;
    database: CaxriDatabase;
    dependencies: DomainDependencies;
    presence: Pick<WindowPresence, 'isSettled' | 'visibleSessionIds'>;
    suspensionState: { service?: TerminalSuspensionService };
    terminals: TerminalManager;
}) {
    const { logger, send } = dependencies;
    const idleCompaction = new ChatIdleCompaction({
        agentChat,
        database,
        maintenanceTurns: coordinator.maintenanceTurns,
        logger,
        settings: () => configuration.getSettings().value,
        watchHub,
    });
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
        isChatCompactionPending: (terminalId) => idleCompaction.isPending(terminalId),
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
            idleCompaction.start();
            agentChat.states.usageLimitWaits?.start(watchHub);
            resourceMonitor.start();
        },
        close: async (): Promise<void> => {
            await terminalSuspension.close();
            await idleCompaction.close();
            await agentChat.states.usageLimitWaits?.close();
            await resourceMonitor.close();
        },
    };
}
