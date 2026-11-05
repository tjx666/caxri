import type { AgentChatService } from './agent-chat';
import { chatStateStore } from './agent-chat';
import type { AgentDelegationService } from './agent-delegation';
import { DelegationAutoHandBack, sessionControls } from './agent-delegation';
import type { AgentCoordinator } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import type { PullRequestSettlementWiring } from './pull-request';
import type { createRootServices } from './root-services';
import { ChatAwayRecap, ChatIdleCompaction } from './session';
import type { TerminalManager } from './terminal';
import {
    createTerminalHandlers,
    PtyUsageMonitor,
    TerminalResourceMonitor,
    TerminalSuspensionService,
} from './terminal';
import type { WindowPresence } from './window-presence';

type RootServices = Awaited<ReturnType<typeof createRootServices>>;

/**
 * Owns the background Agent supervision slice: idle suspension, Chat idle compaction and away recaps, automatic
 * continuation after a usage limit resets, automatic hand-back of a taken-over Session the user left, and the resource
 * and PTY usage monitors. Create: builds the services and publishes the suspension service through `suspensionState`
 * for the launch hooks wired before it exists. Register: the returned `handlers` are the Terminal methods that read
 * them. Start: `start` begins every poller once every handler is registered. Close: `close` stops suspension, idle
 * compaction, and away recaps before the resource monitor; the composition root calls it after Chats and benchmarks
 * shut down and before Terminals do.
 */
export function createTerminalSupervision({
    agentChat,
    configuration,
    coordinator,
    database,
    delegationState,
    dependencies,
    presence,
    settlementWiring,
    suspensionState,
    terminals,
    transcripts,
    watchHub,
}: Pick<RootServices, 'configuration' | 'transcripts' | 'watchHub'> & {
    agentChat: AgentChatService;
    coordinator: Pick<AgentCoordinator, 'maintenanceTurns'>;
    database: CaxriDatabase;
    /**
     * Late-bound like `suspensionState`: the delegation service is composed after this slice, and a caller it hosts
     * must stay running while a task it delegated is active or a notice about one is owed.
     */
    delegationState?: {
        service?: Pick<AgentDelegationService, 'handBacks'> & {
            notices: { holds(terminalId: string): boolean };
        };
    };
    dependencies: DomainDependencies;
    presence: Pick<
        WindowPresence,
        'isSettled' | 'onVisibleChange' | 'visibleSessionIds' | 'watchedSessionId'
    >;
    settlementWiring: Pick<PullRequestSettlementWiring, 'pullRequest'>;
    suspensionState: { service?: TerminalSuspensionService };
    terminals: TerminalManager;
}) {
    const { logger, send } = dependencies;
    const idleCompaction = new ChatIdleCompaction({
        agentChat,
        database,
        maintenanceTurns: coordinator.maintenanceTurns,
        logger,
        pullRequest: (sessionId) => settlementWiring.pullRequest(sessionId),
        settings: () => configuration.getSettings().value,
        watchHub,
    });
    const awayRecap = new ChatAwayRecap({
        agentChat,
        database,
        maintenanceTurns: coordinator.maintenanceTurns,
        logger,
        presence,
        pullRequest: (sessionId) => settlementWiring.pullRequest(sessionId),
        send,
        settings: () => configuration.getSettings().value,
        watchHub,
    });
    const autoHandBack = new DelegationAutoHandBack({
        autoHandBack: (sessionId) => delegationState?.service?.handBacks.autoHandBack(sessionId),
        isEnabled: () => configuration.getSettings().value['agents.delegation'].autoHandBack,
        isHumanControlled: (sessionId) =>
            sessionControls(database, [sessionId]).get(sessionId) === 'human',
        isObservedRemotely: (sessionId) => {
            const terminalId = database.getSession(sessionId)?.primaryAgentTerminalId;
            return terminalId !== undefined && agentChat.isObservedRemotely(terminalId);
        },
        presence,
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
        isChatMaintenancePending: (terminalId) =>
            idleCompaction.isPending(terminalId) || awayRecap.isPending(terminalId),
        isSuspensionHeld: (terminalId) =>
            delegationState?.service?.notices.holds(terminalId) === true,
        watchHub,
    });
    suspensionState.service = terminalSuspension;
    const resourceMonitor = new TerminalResourceMonitor({
        chatProcessGroups: () => chatStateStore(database).processGroups.list(),
        database,
        logger,
        send,
        terminals,
        watchHub,
    });
    const ptyUsage = new PtyUsageMonitor({ logger, send, watchHub });
    return {
        handlers: createTerminalHandlers({
            countLiveChats: (sessionId) => agentChat.liveCount(sessionId),
            database,
            ptyUsage,
            resourceMonitor,
            terminals,
            terminalSuspension,
        }),
        terminalSuspension,
        start: (): void => {
            terminalSuspension.start();
            idleCompaction.start();
            awayRecap.start();
            autoHandBack.start();
            agentChat.states.usageLimitWaits?.start(watchHub);
            resourceMonitor.start();
            ptyUsage.start();
        },
        close: async (): Promise<void> => {
            await terminalSuspension.close();
            await idleCompaction.close();
            await awayRecap.close();
            await autoHandBack.close();
            await agentChat.states.usageLimitWaits?.close();
            await resourceMonitor.close();
            await ptyUsage.close();
        },
    };
}
