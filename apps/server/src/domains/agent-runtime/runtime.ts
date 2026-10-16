import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider, ServerEvent } from '@caxri/protocol';
import { errorMessage, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

// Server domain composition uses the public dispatch boundary required by the repository architecture.
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { AgentDispatchStateRelay } from '../agent-dispatch';
import type {
    AgentAttentionRequests,
    AgentLifecycleSignal,
    PermissionAutoAllowRevokeReason,
} from '../agents';
import {
    AgentCoordinator,
    AgentHookManager,
    AgentService,
    createLocalAgentAdapters,
    createPermissionAutoAllowController,
    defaultAgentEnvironment,
    discoverExecutable,
    reconcilePrimaryTurnFailure,
    SessionSearchIndex,
    shouldAutoAllowAttention,
} from '../agents';
import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';
import type { DomainDependencies } from '../domain-services';
import { SessionAutoNamingService, SessionRenameService } from '../session';
import type { WatchHub } from '../watch';
import type { WorkbenchRootService } from '../workbench';
import * as provenance from '../workbench';
import { AgentTurnContext } from './turn-context';

interface CreateAgentRuntimeOptions {
    attentionRequests: AgentAttentionRequests;
    configuration: ConfigService;
    database: CaxriDatabase;
    dependencies: Pick<
        DomainDependencies,
        | 'agentAdapters'
        | 'agentEndpoints'
        | 'agentEnvironment'
        | 'agentHooksPath'
        | 'agentRefreshDelayMs'
        | 'agentUnknownRecoveryMs'
        | 'hookExecutable'
        | 'hasMobileAttentionRecipient'
        | 'searchWorkers'
    >;
    logger: StructuredLogger;
    /**
     * Observes every accepted lifecycle signal after the coordinator has applied it.
     */
    onLifecycleSignal?: (signal: AgentLifecycleSignal) => void;
    onLifecycleApplied?: (signal: AgentLifecycleSignal) => void;
    send: (event: ServerEvent) => void;
    userDataPath: string;
    watchHub: WatchHub;
    workbenchRoots: WorkbenchRootService;
}

/**
 * Composes the Agent provider, lifecycle-hook, and native rename services. Keeping their shared launch identity and
 * settings reconciliation here makes the domain root consume one cohesive Agent runtime.
 */
export async function createAgentRuntime(options: CreateAgentRuntimeOptions) {
    const {
        configuration,
        database,
        dependencies,
        logger,
        send,
        userDataPath,
        watchHub,
        workbenchRoots,
    } = options;
    const agentLaunchSettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].launch;
    const agentOutputRecoverySettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].recovery;
    const agentEnvironment = dependencies.agentEnvironment ?? defaultAgentEnvironment();
    const sessionSearchIndex = new SessionSearchIndex({
        databasePath: join(userDataPath, 'session-search.db'),
        environment: agentEnvironment,
        logger,
        workerPath: dependencies.searchWorkers?.session?.workerPath,
    });
    const agents = new AgentService(
        logger,
        dependencies.agentAdapters ??
            createLocalAgentAdapters(agentEnvironment, agentLaunchSettings),
    );
    const namingState: { service?: SessionAutoNamingService } = {};
    const coordinator = new AgentCoordinator(database, agents, send, logger, {
        /**
         * A parent Stop can be deferred until background subagents finish; raw hook acceptance is not completion.
         */
        onLifecycleApplied: (signal) => {
            namingState.service?.observe(signal);
            options.onLifecycleApplied?.(signal);
        },
        refreshDelayMs: dependencies.agentRefreshDelayMs,
        unknownRecoveryMs: dependencies.agentUnknownRecoveryMs,
    });
    const sessionRenames = new SessionRenameService(database, agents, coordinator, send, logger);
    const automaticNaming = new SessionAutoNamingService(
        database,
        agents,
        sessionRenames,
        agentEnvironment,
        (terminalId, launchId) => {
            const terminal = database.getTerminal(terminalId);
            const provider = terminal?.provider;
            /**
             * A Chat's lifecycle comes from the provider protocol, not hooks, so the hooks switch does not gate it.
             */
            return Boolean(
                terminal &&
                provider &&
                (isChatTerminal(terminal) ||
                    configuration.getSettings().value['agents.providers'][provider].hooks
                        .enabled) &&
                coordinator.isCurrentTerminalLaunch(terminalId, launchId),
            );
        },
        logger,
        (notice) => send({ event: 'agent.automaticNamingUnavailable', payload: notice }),
    );
    namingState.service = automaticNaming;
    /**
     * Sole writer of the "Always allow in this Session" grant (issue caxri#1295); every caller (mobile's
     * `answerInternal`, Desktop's `session.revokePermissionAutoAllow`, and the lifecycle hooks below) goes through this
     * controller so the transition log and the live `agent.permissionAutoAllowChanged` event are always attached.
     */
    const attentionAutoAllow = createPermissionAutoAllowController({ logger, send });
    const turnContext = new AgentTurnContext(database);
    const agentHooks = new AgentHookManager({
        discoverExecutable,
        environment: agentEnvironment,
        logger,
        onAuthorityLost: (provider) => coordinator.resetHookAuthority(provider),
        onLaunchEnded: (terminalId) => {
            coordinator.endTerminalLaunch(terminalId);
            options.attentionRequests.supersedeTerminal(terminalId);
            turnContext.forget(terminalId);
            /**
             * "The Agent restarts" (issue caxri#1295's grant boundary) is this Agent-hook-bound launch ending, not a
             * generic Shell PTY closing: `HookLaunchRegistry` only calls `onLaunchEnded` for launches it activated.
             */
            const sessionId = database.getTerminal(terminalId)?.sessionId;
            if (sessionId) attentionAutoAllow.revoke(sessionId, 'agentRestart');
        },
        onLaunchStarted: (terminalId, launchId) =>
            coordinator.beginTerminalLaunch(terminalId, launchId),
        turnContext: (signal) => turnContext.for(signal),
        onSignal: async (rawSignal) => {
            // Only Codex reaches the transcript read here (issue caxri#1345): every other provider's own StopFailure
            // hook already classifies its failure, so `resolvePrimaryTurnFailure` is unset and this returns immediately.
            const signal = coordinator.classifyLifecycleSignal(
                await reconcilePrimaryTurnFailure(database, agentEnvironment, rawSignal),
            );
            const decision = await provenance.handleAgentLifecycleSignal(
                coordinator,
                workbenchRoots,
                signal,
            );
            if (decision === 'accepted') {
                options.onLifecycleSignal?.(signal);
            }
            return decision;
        },
        onAttention: async (request, signal) => {
            const terminal = database.getTerminal(request.terminalId);
            if (terminal?.lastProcessState !== 'running') return null;
            const session = database.getSession(terminal.sessionId);
            if (!session) return null;
            /**
             * Only PreToolUse can return question answers; a permission decision alone cannot complete this tool.
             *
             * @see https://code.claude.com/docs/en/hooks#askuserquestion
             */
            if (request.attentionKind === 'permission' && request.toolName === 'AskUserQuestion')
                return null;
            const attentionSignal = {
                provider: 'claude' as const,
                phase: 'attentionRequested' as const,
                terminalId: request.terminalId,
                launchId: request.launchId,
            };
            const decision = await provenance.handleAgentLifecycleSignal(
                coordinator,
                workbenchRoots,
                attentionSignal,
            );
            if (decision !== 'accepted') return null;
            options.onLifecycleSignal?.(attentionSignal);
            /**
             * "Always allow in this Session" (issue caxri#1295) answers directly from Server memory, before the
             * mobile-recipient check, so a granted Session keeps auto-allowing even while no phone is online.
             */
            if (
                shouldAutoAllowAttention(
                    request.attentionKind,
                    attentionAutoAllow.isGranted(terminal.sessionId),
                )
            ) {
                const autoAllowCount = attentionAutoAllow.recordAutoAllow(terminal.sessionId);
                logger.write('info', logEventCatalog.agent.permissionAutoAllowed, {
                    fields: {
                        sessionId: terminal.sessionId,
                        terminalId: request.terminalId,
                        toolName: request.toolName,
                        autoAllowCount,
                    },
                });
                return { decision: 'allow' };
            }
            if (!dependencies.hasMobileAttentionRecipient?.(session.projectId)) return null;
            const disconnected = new AbortController();
            const monitor = setInterval(() => {
                if (!dependencies.hasMobileAttentionRecipient?.(session.projectId))
                    disconnected.abort();
            }, 1_000);
            monitor.unref();
            try {
                const { requestId, answer } = await options.attentionRequests.offer({
                    sessionId: terminal.sessionId,
                    terminalId: request.terminalId,
                    launchId: request.launchId,
                    kind: request.attentionKind,
                    toolName: request.toolName,
                    summary: request.summary,
                    questions: request.questions,
                    signal: AbortSignal.any([signal, disconnected.signal]),
                });
                if (answer) options.attentionRequests.markApplied(requestId);
                return answer;
            } finally {
                clearInterval(monitor);
            }
        },
        hookExecutable: dependencies.hookExecutable ?? process.execPath,
        send,
        sharedPath: dependencies.agentHooksPath,
        userDataPath,
        watchHub,
    });
    await agentHooks.initialize(configuration.getSettings().value['agents.providers']);
    let settingsReconcile = Promise.resolve();
    const unsubscribeSettings = configuration.subscribeSettings((settings) => {
        /**
         * Preserve setting-update order so a slow probe cannot restore authority after disable.
         */
        settingsReconcile = (async () => {
            try {
                await settingsReconcile;
            } catch (error: unknown) {
                logger.write('warn', logEventCatalog.agent.integrationReconcileFailed, {
                    fields: { error: errorMessage(error, 'unknown') },
                });
            }
            await Promise.all([
                agentHooks.reconcile(settings['agents.providers']),
                dependencies.agentEndpoints?.reconcile(settings['agents.providers']),
            ]);
        })();
    });

    return {
        agentEnvironment,
        agentHooks,
        automaticNaming,
        agentLaunchSettings,
        agentOutputRecoverySettings,
        agents,
        // "Always allow in this Session" (issue caxri#1295): read-only status, plus grant/revoke.
        attentionAutoAllowStatus: (sessionId: string) => attentionAutoAllow.status(sessionId),
        awaitSettingsReconcile: () => settingsReconcile,
        close: async () => {
            unsubscribeSettings();
            await automaticNaming.close();
            await settingsReconcile;
            await agentHooks.close();
            await sessionSearchIndex.close();
        },
        coordinator,
        /**
         * Routes PTY and Chat Agent process state to dispatch receipts; the domain root binds the dispatch service.
         */
        dispatchState: new AgentDispatchStateRelay(),
        /**
         * Entry for lifecycle signals a Chat synthesizes from its provider protocol. It takes the same provenance and
         * downstream path as an authenticated hook signal.
         */
        observeChatLifecycleSignal: async (rawSignal: AgentLifecycleSignal) => {
            const signal = coordinator.classifyLifecycleSignal(rawSignal);
            const decision = await provenance.handleAgentLifecycleSignal(
                coordinator,
                workbenchRoots,
                signal,
            );
            if (decision === 'accepted') options.onLifecycleSignal?.(signal);
            return decision;
        },
        grantAutoAllow: (sessionId: string) => attentionAutoAllow.grant(sessionId),
        revokeAutoAllow: (sessionId: string, reason: PermissionAutoAllowRevokeReason) =>
            attentionAutoAllow.revoke(sessionId, reason),
        sessionRenames,
        sessionSearchIndex,
    };
}
