import type { AgentDelegationReceipt, AppSettings, FullStateChangeReason } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { DelegationPullRequestSource, WorkspacePathResolver } from '../agent-delegation';
import {
    AgentDelegationService,
    createDelegationHandlers,
    delegationChatStep,
    delegationUsageLimitResetsAt,
    laterResetTime,
} from '../agent-delegation';
import type { AgentDispatchServiceOptions } from '../agent-dispatch';
/**
 * Server domain composition uses the public dispatch boundary required by the repository architecture.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import {
    AgentDispatchService,
    createAgentCommandHandlers,
    folderTrustPreparer,
} from '../agent-dispatch';
import type { AgentEnvironment, AgentLifecycleSignal } from '../agents';
import {
    delegationAdapter,
    discoverExecutable,
    readAgentTranscript,
    readDelegationTranscript,
    readVersion,
} from '../agents';
import { botHandoverAccess, createBotSession, discardBotSession } from '../bot';
import { coreRouted } from '../core-routed';
import { resolveDelegationFolder } from '../project';
import { createBackgroundSession, discardEmptySession } from '../session';
import { didPasteAndSubmitAgentText } from '../terminal';
import type { AgentUsageGuards } from '../usage';
import { chatNoticeCallerState } from './chat-notice-caller';
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
        /**
         * What approval handling borrows from the composition root; without it a delegated Chat's permission requests
         * are never covered.
         */
        approvals?: {
            raiseAttention(signal: AgentLifecycleSignal): boolean;
            resolveWorkspacePath: WorkspacePathResolver;
            subscribeSettings(listener: () => void): () => void;
        };
        settings(): Pick<
            AppSettings,
            'agents.delegation' | 'agents.providers' | 'session.openAgentsInChat'
        >;
        /**
         * Refuses a dispatch or delegation launch while its provider's account is at the weekly usage guard (issue
         * #2580). Optional so a unit test can construct this runtime without one.
         */
        usageGuards?: Pick<AgentUsageGuards, 'assertAdmitted' | 'current'>;
        /**
         * The Session pull request cache a settled task's `result` and `wait` answers carry. Optional so a unit test
         * can construct this runtime without one.
         */
        pullRequests?: DelegationPullRequestSource;
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
        prepareLaunch: folderTrustPreparer(options.agentEnvironment, options.logger),
    });
    const announce = (reason: FullStateChangeReason) =>
        options.emit({ event: 'state.changed', payload: { kind: 'full', reason } });
    const chatOf = (terminalId: string) =>
        delegationChatFor(options.database, options.agentChat, terminalId);
    const { approvals } = options;
    const delegationService = new AgentDelegationService({
        database: options.database,
        delegationSettings: () => options.settings()['agents.delegation'],
        opensAgentsInChat: () =>
            options.agentChat !== undefined && options.settings()['session.openAgentsInChat'],
        hasAgentChat: () => options.agentChat !== undefined,
        hasLifecycleHooks: (provider) =>
            options.settings()['agents.providers'][provider].hooks.enabled,
        isChatTerminal: (terminalId) => chatOf(terminalId) !== undefined,
        isChatLive: (terminalId) => chatOf(terminalId)?.isLive(terminalId) === true,
        claimChatUsageLimitWait: (terminalId) =>
            options.agentChat?.states?.usageLimitWaits?.claimForDelegationRetry(terminalId) ??
            'none',
        readChatTurn: (terminalId, turnId) =>
            chatOf(terminalId)?.delegation.turnAnswer(terminalId, turnId),
        chatStep: (terminalId) =>
            delegationChatStep(chatOf(terminalId)?.delegation.snapshot(terminalId)),
        callerTurnId: (terminalId) =>
            chatOf(terminalId)?.delegation.snapshot(terminalId)?.activeTurnId,
        /**
         * The provider's limit notice on the failed turn and the weekly usage guard of its account, combined by
         * {@link laterResetTime}.
         */
        limitResetsAt: ({ provider, terminalId, turnId }) =>
            laterResetTime(
                terminalId && turnId
                    ? delegationUsageLimitResetsAt(
                          chatOf(terminalId)?.delegation.snapshot(terminalId),
                          turnId,
                      )
                    : undefined,
                options.usageGuards?.current(provider)?.resetsAt,
            ),
        onProgress: (progress) =>
            options.emit({ event: 'agent.delegation.progress', payload: progress }),
        chatCallerState: (terminalId) =>
            chatNoticeCallerState(
                chatOf(terminalId)?.delegation.snapshot(terminalId),
                options.agentChat?.states?.usageLimitWaits?.waitingAt?.(terminalId) !== undefined,
            ),
        deliverNotice: (terminalId, launchId, text, onDelivered) => {
            const chats = chatOf(terminalId);
            return chats
                ? didAcceptDelegationChatWrite(
                      chats,
                      terminalId,
                      launchId,
                      `\u{1B}[200~${text}\u{1B}[201~\r`,
                      onDelivered,
                  )
                : didPasteAndSubmitAgentText(
                      options.terminals,
                      terminalId,
                      text,
                      launchId,
                      onDelivered,
                  );
        },
        pendingChatRequests: (terminalId) =>
            chatOf(terminalId)?.delegation.snapshot(terminalId)?.requests.length ?? 0,
        approvals: approvals && {
            enabled: () => options.settings()['agents.delegation'].approval,
            appliedPermission: (terminalId) =>
                chatOf(terminalId)?.delegation.appliedPermission(terminalId),
            chat: (terminalId) => {
                const snapshot = chatOf(terminalId)?.delegation.snapshot(terminalId);
                return (
                    snapshot && { requests: snapshot.requests, activeTurnId: snapshot.activeTurnId }
                );
            },
            offers: (terminalId, requestId) =>
                chatOf(terminalId)?.delegation.requestOffers(terminalId, requestId),
            respond: (terminalId, requestId, decision) => {
                const chats = chatOf(terminalId);
                if (!chats) throw new CaxriError('CONFLICT', 'This request is no longer pending');
                chats.respond(terminalId, requestId, { kind: 'decision', decision });
            },
            resolveWorkspacePath: approvals.resolveWorkspacePath,
            applyItem: (terminalId, item) =>
                chatOf(terminalId)?.delegation.applyItem(terminalId, item),
            raiseAttention: (signal) => approvals.raiseAttention(signal),
            onChanged: (change) =>
                options.emit({ event: 'agent.delegation.approval', payload: change }),
            onSettingsChanged: (listener) => approvals.subscribeSettings(listener),
        },
        onQuestionChanged: (change) =>
            options.emit({ event: 'agent.delegation.questionChanged', payload: change }),
        dispatch: dispatchService,
        logger: options.logger,
        userDataPath: options.userDataPath,
        newSessions: {
            create: (projectId, title, isBot, createdBySessionId, createdByRelation, worktree) => {
                const sessionId = isBot
                    ? createBotSession(options.database, projectId, options.logger, title)
                    : createBackgroundSession(
                          options.database,
                          projectId,
                          title,
                          createdBySessionId,
                          createdByRelation,
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
            addProject: (absolutePath) =>
                resolveDelegationFolder(
                    options.database,
                    (event) => options.emit(event),
                    absolutePath,
                ),
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
        callerEndpoint: (terminalId) => {
            const endpoint = options.endpoints?.endpointForTerminal(terminalId);
            return (
                endpoint && {
                    endpointId: endpoint.ref.endpointId,
                    generation: endpoint.ref.generation,
                }
            );
        },
        steer: (terminalId, launchId, steer) =>
            chatOf(terminalId)?.delegation.steerToLaunch(terminalId, launchId, steer) ??
            Promise.reject(new CaxriError('CONFLICT', 'The task is not a Chat child')),
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
        isProviderInstalled: async (provider) =>
            (await discoverExecutable(provider, options.launchSettings(provider).executable)) !==
            undefined,
        isProviderGuarded: (provider) => options.usageGuards?.current(provider) !== undefined,
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
            ...createDelegationHandlers(delegationService, options.database, {
                pullRequests: options.pullRequests,
                logger: options.logger,
                transcripts: {
                    readChildChat: () => options.settings()['agents.delegation'].readChildChat,
                    isChatTerminal: (terminalId) => chatOf(terminalId) !== undefined,
                    snapshot: (terminalId) => chatOf(terminalId)?.delegation.snapshot(terminalId),
                    logger: options.logger,
                },
            }),
            ...createAgentCommandHandlers({
                ...options,
                dispatch: dispatchService,
                mainOwned: coreRouted,
            }),
        },
    };
}
