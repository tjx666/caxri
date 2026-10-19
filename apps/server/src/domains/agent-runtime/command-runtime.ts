import type { AgentDelegationReceipt, AppSettings, FullStateChangeReason } from '@caxri/protocol';

import { AgentDelegationService, createDelegationHandlers } from '../agent-delegation';
import type { AgentDispatchServiceOptions } from '../agent-dispatch';
/**
 * Server domain composition uses the public dispatch boundary required by the repository architecture.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import {
    AgentDispatchService,
    claudeTrustPreparer,
    createAgentCommandHandlers,
} from '../agent-dispatch';
import type { AgentEnvironment } from '../agents';
import {
    delegationAdapter,
    readAgentTranscript,
    readDelegationTranscript,
    readVersion,
} from '../agents';
import {
    commanderHandoverAccess,
    createCommanderSession,
    discardCommanderSession,
} from '../commander';
import { coreRouted } from '../core-routed';
import { createBackgroundSession, discardEmptySession } from '../session';
import type { DelegationChats } from './delegation-chats';
import { delegationChatFor, didAcceptDelegationChatWrite } from './delegation-chats';

/**
 * Composes managed Terminal commands with private task ownership and their shared launch dependencies.
 */
export function createAgentCommandRuntime(
    options: AgentDispatchServiceOptions & {
        userDataPath: string;
        agentEnvironment: AgentEnvironment;
        /**
         * A Chat Terminal target for both dispatch and delegation: a delegated child may open as one, and its
         * follow-ups, stops, and answer go through it.
         */
        agentChat?: DelegationChats;
        settings(): Pick<AppSettings, 'agents.delegation' | 'session.openAgentsInChat'>;
        /**
         * Feeds every announced delegation receipt change to the Commander completion notifier. Optional so a unit test
         * can construct this runtime without one; the composed Server always passes it.
         */
        onDelegationReceiptChanged?(
            receipt: AgentDelegationReceipt,
            previous?: AgentDelegationReceipt,
        ): void;
    },
) {
    const dispatchService = new AgentDispatchService({
        ...options,
        prepareLaunch: claudeTrustPreparer(options.agentEnvironment, options.logger),
    });
    const announce = (reason: FullStateChangeReason) =>
        options.emit({ event: 'state.changed', payload: { kind: 'full', reason } });
    const chatOf = (terminalId: string) =>
        delegationChatFor(options.database, options.agentChat, terminalId);
    const delegationService = new AgentDelegationService({
        database: options.database,
        delegationSettings: () => options.settings()['agents.delegation'],
        opensAgentsInChat: () =>
            options.agentChat !== undefined && options.settings()['session.openAgentsInChat'],
        isChatTerminal: (terminalId) => chatOf(terminalId) !== undefined,
        isChatLive: (terminalId) => chatOf(terminalId)?.isLive(terminalId) === true,
        readChatTurn: (terminalId, turnId) =>
            chatOf(terminalId)?.delegation.turnAnswer(terminalId, turnId),
        dispatch: dispatchService,
        logger: options.logger,
        userDataPath: options.userDataPath,
        newSessions: {
            create: (projectId, title, isCommander, createdBySessionId) => {
                const sessionId = isCommander
                    ? createCommanderSession(options.database, projectId, options.logger, title)
                    : createBackgroundSession(
                          options.database,
                          projectId,
                          title,
                          createdBySessionId,
                      );
                announce('session.create');
                return sessionId;
            },
            discard: (sessionId) => {
                if (options.database.agentCommanderRows()?.sessionIds.includes(sessionId))
                    discardCommanderSession(options.database, sessionId, options.logger, () =>
                        announce('session.delete'),
                    );
                else
                    discardEmptySession(options.database, sessionId, () =>
                        announce('session.delete'),
                    );
            },
        },
        commanderHandovers: commanderHandoverAccess(options.database, options.logger),
        dimensions: (terminalId) => options.terminals.dimensions(terminalId),
        inputEpoch: (terminalId) =>
            chatOf(terminalId)?.delegation.inputEpoch(terminalId) ??
            options.terminals.inputEpoch(terminalId),
        currentLaunchId: (terminalId) => {
            const chats = chatOf(terminalId);
            if (chats) return chats.delegation.liveLaunchId(terminalId);
            return options.terminals.agentProcessId(terminalId) === undefined
                ? undefined
                : options.terminals.agentLaunchId(terminalId);
        },
        isIdle: (terminalId, launchId, turnId) =>
            options.coordinator.hasIdleProof(terminalId, launchId, turnId),
        write: (terminalId, launchId, data, onDelivered) => {
            const chats = chatOf(terminalId);
            if (chats)
                return didAcceptDelegationChatWrite(chats, terminalId, launchId, data, onDelivered);
            const accepted = options.terminals.writeAgentExact(
                terminalId,
                data,
                launchId,
                'delegation',
                onDelivered,
            );
            if (accepted) options.coordinator.observeInput(terminalId, data);
            return accepted;
        },
        launchSettings: (provider) => options.launchSettings(provider),
        verifyLaunch: async (launch, provider) =>
            delegationAdapter(provider).verifyVersion(
                await readVersion(provider, launch.executable),
            ),
        readNativeTranscript: (terminalId, sessionId, offset, turnId) =>
            readDelegationTranscript(
                options.database,
                terminalId,
                sessionId,
                offset,
                options.agentEnvironment,
                turnId,
            ),
        readTranscript: (terminalId) =>
            readAgentTranscript(options.database, terminalId, true, options.agentEnvironment),
        /**
         * A Session-scoped records change instead of a dedicated event: the Agent Commander board already refetches on
         * any `state.changed`, and the Workbench answers a Session-only change with one `app.records` read.
         */
        onReceiptChanged: (receipt, previous) => {
            options.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [receipt.sessionId], terminalIds: [] },
            });
            options.onDelegationReceiptChanged?.(receipt, previous);
        },
    });
    dispatchService.initialize();
    delegationService.initialize();
    return {
        dispatchService,
        delegationService,
        handlers: {
            ...createDelegationHandlers(delegationService),
            ...createAgentCommandHandlers({
                ...options,
                dispatch: dispatchService,
                mainOwned: coreRouted,
            }),
        },
    };
}
