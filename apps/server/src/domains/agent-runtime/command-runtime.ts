import type { AgentDelegationReceipt, AppSettings, FullStateChangeReason } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

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
import { botHandoverAccess, createBotSession, discardBotSession } from '../bot';
import { coreRouted } from '../core-routed';
import { createBackgroundSession, discardEmptySession } from '../session';
import type { AgentUsageGuards } from '../usage';
import { prepareDelegatedWorktree } from './delegated-worktree';
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
        settings(): Pick<
            AppSettings,
            'agents.delegation' | 'agents.providers' | 'session.openAgentsInChat'
        >;
        /**
         * Refuses a dispatch or delegation launch while its provider's account is at the weekly usage guard (issue
         * #2580). Optional so a unit test can construct this runtime without one.
         */
        usageGuards?: Pick<AgentUsageGuards, 'assertAdmitted'>;
        /**
         * Feeds every announced delegation receipt change to Caxri Bot's completion notifier. Optional so a unit test
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
        launchSettings: (provider) => {
            options.usageGuards?.assertAdmitted(provider, 'dispatch');
            return options.launchSettings(provider);
        },
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
        hasLifecycleHooks: (provider) =>
            options.settings()['agents.providers'][provider].hooks.enabled,
        isChatTerminal: (terminalId) => chatOf(terminalId) !== undefined,
        isChatLive: (terminalId) => chatOf(terminalId)?.isLive(terminalId) === true,
        readChatTurn: (terminalId, turnId) =>
            chatOf(terminalId)?.delegation.turnAnswer(terminalId, turnId),
        dispatch: dispatchService,
        logger: options.logger,
        userDataPath: options.userDataPath,
        newSessions: {
            create: (projectId, title, isBot, createdBySessionId, worktree) => {
                const sessionId = isBot
                    ? createBotSession(options.database, projectId, options.logger, title)
                    : createBackgroundSession(
                          options.database,
                          projectId,
                          title,
                          createdBySessionId,
                      );
                if (worktree)
                    options.database.selectWorkbenchProject(
                        sessionId,
                        worktree.projectId,
                        worktree.identity,
                    );
                announce('session.create');
                return sessionId;
            },
            prepareWorktree: (projectId, branch) => {
                const project = options.database
                    .listVisibleProjects()
                    .find((candidate) => candidate.id === projectId);
                if (!project || !isTopLevelProject(project))
                    throw new CaxriError('NOT_FOUND', 'Project is unavailable for a new Session');
                return prepareDelegatedWorktree(options, projectId, project.rootPath, branch);
            },
            discard: (sessionId) => {
                if (options.database.caxriBotRows()?.sessionIds.includes(sessionId))
                    discardBotSession(options.database, sessionId, options.logger, () =>
                        announce('session.delete'),
                    );
                else
                    discardEmptySession(options.database, sessionId, () =>
                        announce('session.delete'),
                    );
            },
        },
        botHandovers: botHandoverAccess(options.database, options.logger),
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
        verifyLaunch: async (launch, provider) => {
            options.usageGuards?.assertAdmitted(provider, 'delegation');
            return delegationAdapter(provider).verifyVersion(
                await readVersion(provider, launch.executable),
            );
        },
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
         * A Session-scoped records change instead of a dedicated event: Caxri Bot's board already refetches on any
         * `state.changed`, and the Workbench answers a Session-only change with one `app.records` read.
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
            ...createDelegationHandlers(delegationService, options.database),
            ...createAgentCommandHandlers({
                ...options,
                dispatch: dispatchService,
                mainOwned: coreRouted,
            }),
        },
    };
}
