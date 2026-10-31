import { join } from 'node:path';
import process from 'node:process';

import { chatStateStore, createAgentChatHandlers } from './agent-chat';
import type { AgentDelegationService } from './agent-delegation';
import { createAgentLifecycleFanOut } from './agent-lifecycle-fan-out';
import { createAgentCommandRuntime, createAgentRuntime } from './agent-runtime';
import { AgentSecretService, createAgentSecretHandlers } from './agent-secrets';
import { AgentAttentionRequests, CompactionReadiness, createLongPasteService } from './agents';
import { createAppHandlers } from './app-handlers';
import { createBenchmarkService } from './benchmark-service-creation';
import { createBestEffortTeardown } from './best-effort-teardown';
import { botHostOptions, BotTerminalHooks, createBotServices } from './bot';
import { createBugReportDeliveryHandler } from './bug-report-delivery';
import { createAgentChatService } from './chat-service-creation';
import { createChatTerminalCreator } from './chat-terminal-creation';
import { createClaudeWindowService } from './claude-window-service-creation';
import { coreRoutedHandlers } from './core-routed';
import { createDeletionHandlers } from './deletion-handlers';
import { DiagnosticsService } from './diagnostics';
import type { DomainDependencies, DomainHandlers, DomainServices } from './domain-services';
import { createGitReviewHandlers } from './git-review';
import { createIntrospectionServices } from './introspection';
import { createSessionMaintenanceServices } from './maintenance-services-creation';
import { createMobileDomainHandlers, MobileTerminalMutationQueue } from './mobile';
import { createOrderingHandlers } from './ordering-handlers';
import { createSessionHandlers } from './parking-handlers';
import {
    createProjectFolderBrowser,
    createProjectHidingHandlers,
    resolveOwnerProjectRoot,
} from './project';
import { PullRequestSettlementWiring } from './pull-request';
import { createRestoreServices } from './restore-services-creation';
import { createRootServices } from './root-services';
import { createServiceHandlers } from './service-handlers';
import {
    createSessionAgentRuntimeHandlers,
    createSessionCreationHandlers,
    createSessionCreator,
    createSessionMarkReadHandler,
    createSessionRuntimeForgetter,
    createSessionSelectionHandlers,
} from './session';
import { createStatusServices } from './status-service-creation';
import { createTerminalSupervision } from './supervision-services-creation';
import type { TerminalSuspensionService } from './terminal';
import {
    createLifecycleEnvironment,
    createRelaunchHandlers,
    createShellIntegration,
    createTerminalCreation,
    createTerminalInputHandlers,
    createTerminalLifecycleHandlers,
    createTerminalMoveHandler,
    terminalDirectoryIdentity,
    TerminalManager,
    TerminalRestoreSupervisor,
} from './terminal';
import { SystemAppearance } from './theme';
import { pushUsageGuardToPtyTerminals } from './usage';
import { createPresenceEffects, WindowPresence } from './window-presence';
import { createWindowStateHandlers } from './window-state-handlers';
import * as provenance from './workbench';
import {
    createLiveTerminalRecord,
    createWorkbenchRootHandlers,
    createWorkbenchSnapshots,
    validateWorkbenchRequestContext,
} from './workbench';

/**
 * The single top-level composition: it only orders dependencies and fixes the close order (the database closes last).
 * Each service slice owns its own lifecycle in its module, for example `status-service-creation.ts`.
 */
export async function createDomainServices(
    dependencies: DomainDependencies,
): Promise<DomainServices> {
    const { logger, send, userDataPath } = dependencies;
    const startedAt = dependencies.startedAt ?? Date.now();
    const pid = dependencies.pid ?? process.pid;
    const {
        acknowledgeFileMutation,
        archivedWorktrees,
        configuration,
        database,
        externalStatus,
        files,
        git,
        sendFullStateChange,
        sessionContext,
        timeline,
        transcripts,
        watchHub,
        workbenchRoots,
    } = await createRootServices(dependencies);
    const presence = new WindowPresence();
    const attentionRequests = new AgentAttentionRequests();
    const suspensionState: { service?: TerminalSuspensionService } = {};
    const delegationState: { service?: AgentDelegationService } = {};
    const botHooks = new BotTerminalHooks(database, logger);
    const settlementWiring = new PullRequestSettlementWiring(botHooks.sessionActivityChanged);
    const compactionReadiness = new CompactionReadiness();
    const agentRuntime = await createAgentRuntime({
        attentionRequests,
        configuration,
        database,
        dependencies,
        logger,
        ...createAgentLifecycleFanOut({
            botHooks,
            compactionReadiness,
            delegationState,
            settlementWiring,
            suspensionState,
        }),
        send,
        userDataPath,
        watchHub,
        workbenchRoots,
    });
    const {
        agentEnvironment,
        agentHooks,
        agentLaunchSettings,
        agentOutputRecoverySettings,
        agentThroughput,
        coordinator,
        dispatchState,
        hookLaunchEnvironment,
        sessionRenames,
    } = agentRuntime;
    pushUsageGuardToPtyTerminals({ guards: agentRuntime.usageGuards, database, send });
    const shellIntegration = await createShellIntegration(userDataPath, logger);
    const mobileTerminalMutations = new MobileTerminalMutationQueue();
    const systemAppearance = new SystemAppearance(configuration);
    const terminals = new TerminalManager(database, send, logger, {
        ...dependencies.terminal,
        execution: dependencies.terminalExecution,
        agentLaunchArguments: botHooks.launchArguments,
        agentLaunchPrompt: botHooks.launchPrompt,
        agentLaunchSettings: dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        agentOutputRecoverySettings:
            dependencies.terminal?.agentOutputRecoverySettings ?? agentOutputRecoverySettings,
        shellEnvironment: (terminal) => hookLaunchEnvironment.shellEnvironment(terminal.id),
        onShellRetired: (terminalId) => agentHooks.endShellLaunch(terminalId),
        lifecycleEnvironment: createLifecycleEnvironment({
            agentHooks: hookLaunchEnvironment,
            configuration,
            database,
            delegationState,
            endpoints: dependencies.agentEndpoints,
            workbenchRoots,
        }),
        onLaunched: (terminal) => {
            botHooks.launched(terminal.id, terminals.agentLaunchId(terminal.id));
            return suspensionState.service?.parkLaunch(terminal);
        },
        onLifecycleStarted: (terminal) => {
            suspensionState.service?.observeLaunch(terminal.id);
            return dependencies.agentEndpoints?.activate(terminal.id);
        },
        onLifecycleRetired: async (terminalId, launchId) => {
            compactionReadiness.forget(terminalId);
            delegationState.service?.interruptTerminal(terminalId, false, launchId);
            suspensionState.service?.forgetTerminal(terminalId);
            agentHooks.endTerminalLaunch(terminalId, launchId);
            await provenance.retireAgentWorkbenchProvenance({
                endpoints: dependencies.agentEndpoints,
                logger,
                terminalId,
                workbenchRoots,
            });
        },
        onOutputActivity: (terminalId, processId) =>
            coordinator.observeOutput(terminalId, processId),
        onInput: (terminalId, data, origin) => {
            compactionReadiness.input(terminalId, data);
            suspensionState.service?.observeInput(terminalId, data);
            if (origin === 'human') botHooks.input(terminalId, data);
            if (origin === 'human') coordinator.maintenanceTurns.end(terminalId, 'humanInput');
            delegationState.service?.interruptTerminal(terminalId, true);
        },
        onAgentStateChanged: dispatchState.observe,
        shellIntegration: (executable, environment) =>
            shellIntegration?.resolve(executable, environment),
        terminalColors: dependencies.terminal?.terminalColors ?? systemAppearance.terminalColors,
    });
    const longPastes = await createLongPasteService({
        userDataPath,
        database,
        settings: () => configuration.getSettings().value,
        agentLaunchId: (terminalId) => terminals.agentLaunchId(terminalId),
    });
    const unsubscribeTerminalSettings = systemAppearance.onChange(() =>
        terminals.reconcileOutputRecoverySettings(),
    );
    const agentChat = createAgentChatService({
        agentRuntime,
        botHooks,
        configuration,
        database,
        delegationState,
        dependencies,
        logger,
        onObservationLeaseReady: () => suspensionState.service?.requestSweep(),
        send,
    });
    const providerServiceOptions = { agentRuntime, database, dependencies, logger, send };
    const benchmark = createBenchmarkService(providerServiceOptions);
    const claudeWindows = createClaudeWindowService(providerServiceOptions);
    const agentSecrets = new AgentSecretService({ database, logger, send, userDataPath });
    const terminalRestores = new TerminalRestoreSupervisor();
    const terminalSupervision = createTerminalSupervision({
        agentChat,
        configuration,
        coordinator,
        database,
        dependencies,
        presence,
        settlementWiring,
        suspensionState,
        terminals,
        transcripts,
        watchHub,
    });
    const { terminalSuspension } = terminalSupervision;
    const statusServices = createStatusServices({
        configuration,
        database,
        externalStatus,
        files,
        git,
        logger,
        primaryVisibleSessionId: () => presence.primaryVisibleSessionId(),
        send,
        sessionContext,
        visibleSessionIds: () => presence.visibleSessionIds(),
        workbenchRoots,
    });
    const { projectStatus, vercel } = statusServices;
    const countRunning = (sessionId?: string): number =>
        terminals.runningCount(sessionId) +
        agentChat.liveCount(sessionId) +
        (sessionId === undefined ? benchmark.service.liveCount() : 0);
    const diagnostics = new DiagnosticsService(
        database,
        logger,
        () => configuration.getSettings().value,
        () => countRunning(),
        startedAt,
        () => watchHub.snapshot(),
    );
    const liveTerminalRecord = createLiveTerminalRecord(
        coordinator,
        terminals,
        chatStateStore(database).subagents,
        { waitingAt: (id) => agentChat.states.usageLimitWaits?.waitingAt(id) },
        agentRuntime.usageGuards,
    );
    const introspection = createIntrospectionServices(
        database,
        logger,
        presence,
        liveTerminalRecord,
    );
    const forgetSessionRuntime = createSessionRuntimeForgetter({
        agentChat,
        agentRuntime,
        settlementWiring,
        terminalRestores,
        terminals,
        terminalSuspension,
        transcripts,
    });
    const evictSessionCaches = (sessionIds: readonly string[]): void => {
        git.evictSessions(sessionIds);
        projectStatus.evictSessions(sessionIds);
    };
    const snapshots = createWorkbenchSnapshots({
        automaticNamingNotices: () => agentRuntime.automaticNaming.automaticNamingNotices(),
        configuration,
        database,
        logger,
        liveTerminalRecord,
    });
    const { createAndStartTerminal, newTerminalWorkingDirectory, terminalWorkingDirectory } =
        createTerminalCreation({ configuration, coordinator, database, terminals });
    const createChatTerminal = createChatTerminalCreator({
        agentChat,
        database,
        newTerminalWorkingDirectory,
    });
    const restorerOptions = {
        agentEnvironment,
        coordinator,
        database,
        logger,
        send,
        terminalDirectoryIdentity,
        terminals,
        userDataPath,
        visibleGridWaitMs: dependencies.terminalRestoreGridWaitMs,
    };
    const {
        botRestores,
        restoreBotTerminals,
        restoreInterruptedTerminalsInBackground,
        watchSessionInBackground,
    } = createRestoreServices({
        agentChat,
        files,
        git,
        restorerOptions,
        terminalRestores,
        terminalSuspension,
    });
    const presenceEffects = createPresenceEffects({
        coordinator,
        database,
        presence,
        projectStatus,
        restoreInterruptedTerminalsInBackground,
        sendFullStateChange,
        terminalSuspension,
        watchSessionInBackground,
    });
    /**
     * The Session parking slice has no lifecycle of its own; its handlers (project hiding, archive and detach,
     * terminate all) are registered together below.
     */
    const sessionParking = {
        agentChat,
        archivedWorktrees,
        botRestores,
        database,
        evictSessions: evictSessionCaches,
        mobileTerminalMutations,
        restoreSelection: presenceEffects.restoreWindowSelections,
        sendFullStateChange,
        terminalRestores,
        terminalSuspension,
    };
    const createSessionForProject = createSessionCreator({
        coordinator,
        database,
        noteWindowViewing: presenceEffects.noteWindowViewing,
        sendFullStateChange: () => sendFullStateChange('session.create'),
        startChat: (terminalId) => agentChat.read(terminalId),
        terminalSuspension,
        terminalWorkingDirectory,
        terminals,
    });
    const agentCommands = createAgentCommandRuntime({
        agentChat,
        usageGuards: agentRuntime.usageGuards,
        logger,
        settings: () => configuration.getSettings().value,
        database,
        coordinator,
        emit: send,
        endpoints: dependencies.agentEndpoints,
        launchSettings: agentLaunchSettings,
        terminalDirectoryIdentity,
        terminalWorkingDirectory,
        terminals,
        userDataPath,
        agentEnvironment,
        onDelegationReceiptChanged: botHooks.receiptChanged,
    });
    dispatchState.service = agentCommands.dispatchService;
    delegationState.service = agentCommands.delegationService;
    const { inbox: botInbox, handovers: botHandovers } = createBotServices({
        agentChat,
        coordinator,
        database,
        environment: agentEnvironment,
        github: externalStatus.github,
        hooks: botHooks,
        ignoredChecks: () => configuration.getSettings().value['projectStatus.ignoredChecks'],
        logger,
        readTopology: (path) => git.worktreeTopology(path),
        resolveProjectRoot: resolveOwnerProjectRoot,
        run: externalStatus.run,
        send,
        sendFullStateChange: () => sendFullStateChange('session.create'),
        terminals,
        workingDirectory: userDataPath,
    });
    const sessionMaintenance = createSessionMaintenanceServices({
        agentChat,
        compactionReadiness,
        parking: sessionParking,
        restorerOptions,
        terminalSuspension,
    });
    let isClosed = false;
    const close: DomainServices['close'] = async (runStep = (_step, action) => action()) => {
        if (isClosed) return;
        isClosed = true;
        presenceEffects.unsubscribe();
        sessionMaintenance.close();
        statusServices.dispose();
        settlementWiring.dispose();
        terminalRestores.close();
        botRestores.close();
        botInbox.close();
        const { attempt, closeEach, rethrow } = createBestEffortTeardown();
        await attempt(
            () => agentChat.shutdown(),
            () => benchmark.service.shutdown(),
            () => claudeWindows.service.shutdown(),
        );
        await closeEach(agentSecrets, terminalSupervision, coordinator, longPastes);
        await attempt(unsubscribeTerminalSettings);
        await attempt(() => runStep('terminals', () => terminals.shutdown('orderly')));
        await closeEach(agentCommands.dispatchService, agentCommands.delegationService);
        await attempt(() => Promise.all([archivedWorktrees.close(), workbenchRoots.close()]));
        await attempt(
            () => agentRuntime.close(),
            () => dependencies.agentEndpoints?.close(),
        );
        await closeEach(files, configuration, git, transcripts, watchHub, database);
        rethrow();
    };
    const terminalInputs = createTerminalInputHandlers({ coordinator, database, send, terminals });
    const terminalInput = terminalInputs['terminal.input'];
    const relaunchHandlers = createRelaunchHandlers({
        ...restorerOptions,
        agentChat,
        mobileTerminalMutations,
    });
    const handlers: DomainHandlers = {
        ...coreRoutedHandlers,
        ...sessionMaintenance.handlers,
        ...agentCommands.handlers,
        ...createAppHandlers({ countRunning, database, pid, presence, snapshots, startedAt }),
        ...createAgentChatHandlers(agentChat, {
            database,
            agentEnvironment,
            createSessionForProject,
        }),
        ...benchmark.handlers,
        ...claudeWindows.handlers,
        ...createAgentSecretHandlers(agentSecrets),
        ...createWindowStateHandlers(database, systemAppearance),
        ...presenceEffects.handlers,
        ...createWorkbenchRootHandlers(workbenchRoots),
        ...createTerminalMoveHandler({
            coordinator,
            database,
            send,
            terminals,
            mobileTerminalMutations,
            noteWindowViewing: presenceEffects.noteWindowViewing,
        }),
        'bugReport.context': () => diagnostics.reportContext(),
        ...createBugReportDeliveryHandler({ agentChat, database, terminals }),
        'project.list': () => ({ view: 'desktop', projects: database.listVisibleProjects() }),
        'project.queryForPrincipal': ({ principal, query }) =>
            introspection.records.project(query, principal),
        ...createOrderingHandlers({ database, sendFullStateChange }),
        ...createProjectHidingHandlers({ ...sessionParking, bootstrapState: snapshots.bootstrap }),
        ...createSessionHandlers(database, sessionParking, sessionRenames),
        ...createProjectFolderBrowser(),
        ...createSessionCreationHandlers(database, createSessionForProject),
        ...createMobileDomainHandlers({
            agentChat,
            autoAllow: agentRuntime,
            attentionRequests,
            imageDirectory: join(userDataPath, 'mobile-attachments'),
            configuration,
            database,
            emit: send,
            endpoints: dependencies.agentEndpoints,
            files,
            git,
            queue: mobileTerminalMutations,
            terminals,
            timeline,
            transcripts,
        }),
        ...createSessionSelectionHandlers({
            agentChat,
            coordinator,
            database,
            mobileTerminalMutations,
            noteWindowViewing: presenceEffects.noteWindowViewing,
            restoreInterruptedTerminalsInBackground,
            sendFullStateChange,
            terminalSuspension,
            workbenchRoots,
        }),
        ...createSessionMarkReadHandler(database, send),
        ...createSessionAgentRuntimeHandlers(agentRuntime),
        ...createDeletionHandlers({
            database,
            delegations: agentCommands.delegationService,
            mobileTerminalMutations,
            bootstrapState: snapshots.bootstrap,
            forgetSessionRuntime,
            evictSessions: evictSessionCaches,
            projectDeleted: (ids) => workbenchRoots.projectDeleted(ids),
            projectMetadataDeleted: () => {
                void agentSecrets.pruneDeletedProjects();
            },
            restoreSelection: presenceEffects.restoreWindowSelections,
            send,
        }),
        'session.queryForPrincipal': ({ principal, query }) =>
            introspection.records.session(query, principal),
        ...terminalInputs,
        ...createTerminalLifecycleHandlers({
            agentChat,
            coordinator,
            createAndStartTerminal,
            createChatTerminal,
            database,
            mobileTerminalMutations,
            sendFullStateChange,
            terminals,
            transcripts,
        }),
        ...relaunchHandlers,
        ...terminalSupervision.handlers,
        'terminal.queryForPrincipal': ({ principal, query }) =>
            introspection.records.terminal(query, principal),
        ...createServiceHandlers({
            acknowledgeFileMutation,
            archivedWorktrees,
            agentChat,
            agentEnvironment,
            agentThroughput,
            agentHooks,
            agentRuntime,
            bot: botHostOptions({
                agentChat,
                agentEnvironment,
                coordinator,
                database,
                createAndStartTerminal,
                logger,
                onStopped: () => botHooks.notifier?.onStopped(),
                restartTerminal: relaunchHandlers['terminal.restart'],
                restores: botRestores,
                restoreTerminals: restoreBotTerminals,
                scopedWorkbench: snapshots.bot,
                send,
                sendFullStateChange: () => sendFullStateChange('session.create'),
                terminals,
            }),
            botHandovers,
            botInbox,
            configuration,
            database,
            emit: send,
            diagnostics,
            externalStatus,
            files,
            git,
            introspection,
            longPastes,
            logger,
            projectStatus,
            sessionContext,
            settlementWiring,
            archiveSession: (sessionId) => handlers['session.archive']({ sessionId }),
            terminals,
            timeline,
            transcripts,
            userDataPath,
            vercel,
        }),
        ...createGitReviewHandlers({
            agentChat,
            database,
            git,
            longPastes,
            send,
            terminalInput,
            terminals,
        }),
    };
    terminalSupervision.start();
    sessionMaintenance.start();
    // No presence exists until Desktop Main reports its windows, so nothing is watched, polled, or restored here:
    // `observeVisibleSessions` does that for the Sessions the first reports show.
    return {
        handlers,
        close,
        onActiveContextChanged: (listener) => presence.onCurrentChange(listener),
        onConnectionClosed: (connectionId) => presence.dropConnection(connectionId),
        visibleSessionIds: () => (presence.isSettled() ? presence.visibleSessionIds() : undefined),
        credentials: database.credentials,
        protocolRecovery: database.protocolState,
        validateRequestContext: (context) => validateWorkbenchRequestContext(database, context),
    };
}
