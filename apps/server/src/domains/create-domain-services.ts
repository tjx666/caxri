import { join } from 'node:path';
import process from 'node:process';

import type { FullStateChangeReason } from '@caxri/protocol';

import { readActiveContext } from './active-context';
import { chatStateStore, createAgentChatHandlers } from './agent-chat';
import type { AgentDelegationService } from './agent-delegation';
import { createAgentLifecycleFanOut } from './agent-lifecycle-fan-out';
import { createAgentCommandRuntime, createAgentRuntime } from './agent-runtime';
import { AgentAttentionRequests, CompactionReadiness, createLongPasteService } from './agents';
import { createBenchmarkService } from './benchmark-service-creation';
import { createBugReportDeliveryHandler } from './bug-report-delivery';
import { createAgentChatService } from './chat-service-creation';
import { createChatTerminalCreator } from './chat-terminal-creation';
import { commanderHostOptions, CommanderTerminalHooks, createCommanderServices } from './commander';
import { coreRoutedHandlers } from './core-routed';
import { createDeletionHandlers } from './deletion-handlers';
import { DiagnosticsService } from './diagnostics';
import type { DomainDependencies, DomainHandlers, DomainServices } from './domain-services';
import { createGitReviewHandlers } from './git-review';
import { createIntrospectionServices } from './introspection';
import { createMobileDomainHandlers, MobileTerminalMutationQueue } from './mobile';
import { createOrderingHandlers } from './ordering-handlers';
import { createSessionHandlers, createTerminateAllHandler } from './parking-handlers';
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
    SessionCompaction,
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
        configuration,
        database,
        externalStatus,
        files,
        git,
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
    const commanderHooks = new CommanderTerminalHooks(database, logger);
    const settlementWiring = new PullRequestSettlementWiring(commanderHooks.sessionActivityChanged);
    const compactionReadiness = new CompactionReadiness();
    const agentRuntime = await createAgentRuntime({
        attentionRequests,
        configuration,
        database,
        dependencies,
        logger,
        ...createAgentLifecycleFanOut({
            commanderHooks,
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
        sessionRenames,
    } = agentRuntime;
    const shellIntegration = await createShellIntegration(userDataPath, logger);
    const mobileTerminalMutations = new MobileTerminalMutationQueue();
    const terminals = new TerminalManager(database, send, logger, {
        ...dependencies.terminal,
        execution: dependencies.terminalExecution,
        agentLaunchArguments: commanderHooks.launchArguments,
        agentLaunchPrompt: commanderHooks.launchPrompt,
        agentLaunchSettings: dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        agentOutputRecoverySettings:
            dependencies.terminal?.agentOutputRecoverySettings ?? agentOutputRecoverySettings,
        shellEnvironment: (terminal) => agentHooks.shellEnvironment(terminal.id),
        onShellRetired: (terminalId) => agentHooks.endShellLaunch(terminalId),
        lifecycleEnvironment: createLifecycleEnvironment({
            agentHooks,
            configuration,
            database,
            delegationState,
            endpoints: dependencies.agentEndpoints,
            workbenchRoots,
        }),
        onLaunched: (terminal) => {
            commanderHooks.launched(terminal.id, terminals.agentLaunchId(terminal.id));
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
            if (origin === 'human') commanderHooks.input(terminalId, data);
            if (origin === 'human') coordinator.maintenanceTurns.end(terminalId, 'humanInput');
            delegationState.service?.interruptTerminal(terminalId, true);
        },
        onAgentStateChanged: dispatchState.observe,
        shellIntegration: (executable, environment) =>
            shellIntegration?.resolve(executable, environment),
        terminalColors:
            dependencies.terminal?.terminalColors ??
            (() => configuration.getTheme().value.terminal),
    });
    const longPastes = await createLongPasteService({
        userDataPath,
        database,
        settings: () => configuration.getSettings().value,
        agentLaunchId: (terminalId) => terminals.agentLaunchId(terminalId),
    });
    const unsubscribeTerminalSettings = configuration.subscribeSettings(() =>
        terminals.reconcileOutputRecoverySettings(),
    );
    const agentChat = createAgentChatService({
        agentRuntime,
        commanderHooks,
        configuration,
        database,
        delegationState,
        dependencies,
        logger,
        onObservationLeaseReady: () => suspensionState.service?.requestSweep(),
        send,
    });
    const benchmark = createBenchmarkService({
        agentRuntime,
        database,
        dependencies,
        logger,
        send,
    });
    const terminalRestores = new TerminalRestoreSupervisor();
    const terminalSupervision = createTerminalSupervision({
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
    const introspection = createIntrospectionServices(database, logger, () =>
        presence.currentSessionId(),
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
        liveTerminalRecord: createLiveTerminalRecord(
            coordinator,
            terminals,
            chatStateStore(database).subagents,
        ),
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
        commanderRestores,
        restoreCommanderTerminals,
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
    /**
     * Announces a full workbench re-read; `reason` is what the Renderer's command convergence matches on.
     */
    const sendFullStateChange = (reason: FullStateChangeReason): void => {
        send({ event: 'state.changed', payload: { kind: 'full', reason } });
    };
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
        commanderRestores,
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
        onDelegationReceiptChanged: commanderHooks.receiptChanged,
    });
    dispatchState.service = agentCommands.dispatchService;
    delegationState.service = agentCommands.delegationService;
    const { inbox: commanderInbox, handovers: commanderHandovers } = createCommanderServices({
        agentChat,
        coordinator,
        database,
        environment: agentEnvironment,
        github: externalStatus.github,
        hooks: commanderHooks,
        ignoredChecks: () => configuration.getSettings().value['projectStatus.ignoredChecks'],
        logger,
        resolveProjectRoot: resolveOwnerProjectRoot,
        run: externalStatus.run,
        send,
        sendFullStateChange: () => sendFullStateChange('session.create'),
        terminals,
        workingDirectory: userDataPath,
    });
    let isClosed = false;
    async function close(): Promise<void> {
        if (isClosed) return;
        isClosed = true;
        presenceEffects.unsubscribe();
        statusServices.dispose();
        settlementWiring.dispose();
        terminalRestores.close();
        commanderRestores.close();
        commanderInbox.close();
        await agentChat.shutdown();
        await benchmark.service.shutdown();
        await terminalSupervision.close();
        await coordinator.close();
        longPastes.close();
        unsubscribeTerminalSettings();
        await terminals.shutdown('orderly');
        agentCommands.dispatchService.close();
        agentCommands.delegationService.close();
        await workbenchRoots.close();
        await agentRuntime.close();
        await dependencies.agentEndpoints?.close();
        await files.close();
        await configuration.close();
        await git.close();
        await transcripts.close();
        await watchHub.close();
        database.close();
    }
    const compaction = new SessionCompaction({
        agentChat,
        database,
        coordinator,
        terminals,
        logger,
        readiness: compactionReadiness,
        environment: agentEnvironment,
    });
    const terminalInputs = createTerminalInputHandlers({ coordinator, database, send, terminals });
    const terminalInput = terminalInputs['terminal.input'];
    const relaunchHandlers = createRelaunchHandlers({
        ...restorerOptions,
        agentChat,
        mobileTerminalMutations,
    });
    const handlers: DomainHandlers = {
        ...coreRoutedHandlers,
        'session.compactWarm': (_parameters, signal) => compaction.run(signal),
        ...agentCommands.handlers,
        'app.bootstrap': ({ windowKey }) => snapshots.bootstrap(windowKey),
        'app.activeContext': () => readActiveContext(database, () => presence.currentSessionId()),
        'app.sessionContext': ({ sessionId }) => readActiveContext(database, () => sessionId),
        'app.records': ({ sessionIds, terminalIds }) => snapshots.records(sessionIds, terminalIds),
        'app.health': () => ({
            ready: true,
            pid,
            startedAt,
            activePtyCount: countRunning(),
        }),
        ...createAgentChatHandlers(agentChat, {
            database,
            agentEnvironment,
            createSessionForProject,
        }),
        ...benchmark.handlers,
        ...createWindowStateHandlers(database),
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
        ...createTerminateAllHandler(sessionParking),
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
            restoreSelection: presenceEffects.restoreWindowSelections,
            send,
        }),
        'session.updateState': (state) => {
            database.updateSessionState(state, 'clientWrite');
            return database.getSessionState(state.sessionId);
        },
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
            agentChat,
            agentEnvironment,
            agentThroughput,
            agentHooks,
            agentRuntime,
            commander: commanderHostOptions({
                agentChat,
                agentEnvironment,
                coordinator,
                database,
                createAndStartTerminal,
                logger,
                onStopped: () => commanderHooks.notifier?.onStopped(),
                restartTerminal: relaunchHandlers['terminal.restart'],
                restores: commanderRestores,
                restoreTerminals: restoreCommanderTerminals,
                scopedWorkbench: snapshots.commander,
                send,
                sendFullStateChange: () => sendFullStateChange('session.create'),
                terminals,
            }),
            commanderHandovers,
            commanderInbox,
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
    // No presence exists until Desktop Main reports its windows, so nothing is watched, polled, or restored here:
    // `observeVisibleSessions` does that for the Sessions the first reports show.
    return {
        handlers,
        close,
        onActiveContextChanged: (listener) => presence.onCurrentChange(listener),
        onConnectionClosed: (connectionId) => presence.dropConnection(connectionId),
        protocolRecovery: database.protocolState,
        validateRequestContext: (context) => validateWorkbenchRequestContext(database, context),
    };
}
