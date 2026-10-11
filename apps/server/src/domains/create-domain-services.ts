import { join } from 'node:path';
import process from 'node:process';

import type { FullStateChangeReason, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { readActiveContext } from './active-context';
import { createAgentChatHandlers } from './agent-chat';
import type { AgentDelegationService } from './agent-delegation';
import type { AgentDispatchService } from './agent-dispatch';
import { createAgentCommandRuntime, createAgentRuntime } from './agent-runtime';
import { AgentAttentionRequests, CompactionReadiness, LongPasteService } from './agents';
import { createBackgroundTasks, refreshWatchSessionInBackground } from './background-tasks';
import { createBugReportDeliveryHandler } from './bug-report-delivery';
import { createAgentChatService } from './chat-service-creation';
import { createChatTerminalCreator } from './chat-terminal-creation';
import {
    commanderHostOptions,
    CommanderTerminalHooks,
    createCommanderCompletionNotifier,
} from './commander';
import { coreRoutedHandlers } from './core-routed';
import { createDeletionHandlers } from './deletion-handlers';
import { DiagnosticsService } from './diagnostics';
import type { DomainDependencies, DomainHandlers, DomainServices } from './domain-services';
import { createGitReviewHandlers } from './git-review';
import { createIntrospectionServices } from './introspection';
import { createMobileDomainHandlers, MobileTerminalMutationQueue } from './mobile';
import { createOrderingHandlers } from './ordering-handlers';
import { createSessionParkingHandlers, createTerminateAllHandler } from './parking-handlers';
import { createProjectHidingHandlers } from './project';
import { ProjectStatusService, VercelDeploymentStore } from './project-status';
import { createRootServices } from './root-services';
import { createServiceHandlers } from './service-handlers';
import {
    createMobileSessionHandler,
    createSessionAgentRuntimeHandlers,
    createSessionCreator,
    SessionCompaction,
    SessionSelectionQueue,
} from './session';
import {
    createCommanderTerminalRestorer,
    createInterruptedTerminalRestorer,
    createLifecycleEnvironment,
    createRelaunchHandlers,
    createShellIntegration,
    createTerminalAgentExactInputHandler,
    createTerminalBinaryInputHandler,
    createTerminalCreation,
    createTerminalHandlers,
    createTerminalInputHandler,
    createTerminalMoveHandler,
    terminalDirectoryIdentity,
    TerminalManager,
    TerminalResourceMonitor,
    TerminalRestoreSupervisor,
    TerminalSuspensionService,
} from './terminal';
import { createWindowStateHandlers } from './window-state-handlers';
import * as provenance from './workbench';
import {
    createWorkbenchRootHandlers,
    createWorkbenchSnapshots,
    validateWorkbenchRequestContext,
} from './workbench';

const VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS = 5_000;
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
    const selectedSessionId = () => database.getAppState('lastSelectedSessionId') ?? undefined;
    const attentionRequests = new AgentAttentionRequests();
    const suspensionState: { service?: TerminalSuspensionService } = {};
    const delegationState: { service?: AgentDelegationService } = {};
    const commanderHooks = new CommanderTerminalHooks(database, logger);
    const compactionReadiness = new CompactionReadiness();
    const agentRuntime = await createAgentRuntime({
        attentionRequests,
        configuration,
        database,
        dependencies,
        logger,
        onLifecycleSignal: (signal) => {
            compactionReadiness.observe(signal);
            if (!signal.agentTurnContinues) suspensionState.service?.observeLifecycle(signal);
            delegationState.service?.observe(signal, 'evidence');
        },
        onLifecycleApplied: (signal) => {
            delegationState.service?.observe(signal);
            commanderHooks.notifier?.onLifecycleApplied(signal);
        },
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
        coordinator,
        sessionRenames,
    } = agentRuntime;
    const shellIntegration = await createShellIntegration(userDataPath, logger);
    const agentDispatchState: { service?: AgentDispatchService } = {};
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
            commanderHooks.launched(
                terminal.id,
                terminals.agentLaunchId(terminal.id) !== undefined,
            );
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
        onInput: (terminalId, data) => {
            compactionReadiness.input(terminalId, data);
            suspensionState.service?.observeInput(terminalId);
            commanderHooks.notifier?.observeInput(terminalId, data);
            delegationState.service?.interruptTerminal(terminalId, true);
        },
        onAgentStateChanged: (terminalId, state, cause) =>
            agentDispatchState.service?.observeTerminalState(terminalId, state, cause),
        shellIntegration: (executable, environment) =>
            shellIntegration?.resolve(executable, environment),
        terminalColors:
            dependencies.terminal?.terminalColors ??
            (() => configuration.getTheme().value.terminal),
    });
    const longPastes = new LongPasteService(
        userDataPath,
        database,
        () => configuration.getSettings().value,
        (terminalId) => terminals.agentLaunchId(terminalId),
    );
    await longPastes.initialize();
    const unsubscribeTerminalSettings = configuration.subscribeSettings(() =>
        terminals.reconcileOutputRecoverySettings(),
    );
    const agentChat = createAgentChatService({
        agentRuntime,
        commanderHooks,
        configuration,
        database,
        dependencies,
        logger,
        send,
    });
    const terminalRestores = new TerminalRestoreSupervisor();
    const terminalSuspension = new TerminalSuspensionService({
        database,
        logger,
        selectedSessionId,
        send,
        settings: () => configuration.getSettings().value,
        ...dependencies.terminalSuspension,
        terminals,
        watchHub,
    });
    suspensionState.service = terminalSuspension;
    const terminalResourceMonitor = new TerminalResourceMonitor({
        database,
        logger,
        send,
        terminals,
        watchHub,
    });
    const vercel = new VercelDeploymentStore(externalStatus.run);
    const projectStatus = new ProjectStatusService(git, logger, externalStatus.run, {
        emit: send,
        github: externalStatus.github,
        listWatchedSessions: () =>
            database
                .listVisibleSessions()
                .filter((session) => session.archivedAt === undefined)
                .map((session) => session.id),
        sessionContext: (sessionId) => sessionContext.readSession(sessionId),
        settings: () => configuration.getSettings().value,
        vercel,
    });
    projectStatus.startDeliveryWatch();
    workbenchRoots.setRootChangedHandler((sessionId) => {
        /**
         * Root changes end the old projection lifetime before consumers re-read. An inactive root has no file watcher,
         * so retaining its settled Git snapshot can keep both Source Control and its badge stale when returning.
         */
        git.evictSessions([sessionId]);
        projectStatus.evictSessions([sessionId]);
        if (selectedSessionId() === sessionId) {
            projectStatus.setPolledSession(sessionId);
            refreshWatchSessionInBackground(files, git, logger, sessionId);
        }
    });
    const countRunning = (sessionId?: string): number =>
        terminals.runningCount(sessionId) + agentChat.liveCount(sessionId);
    const diagnostics = new DiagnosticsService(
        database,
        logger,
        () => configuration.getSettings().value,
        () => countRunning(),
        startedAt,
        () => watchHub.snapshot(),
    );
    const introspection = createIntrospectionServices(database, logger);
    const liveTerminalRecord = (terminal: TerminalRecord): TerminalRecord => ({
        ...terminal,
        agentOperation: coordinator.agentOperation(terminal.id),
        processId: terminals.processId(terminal.id),
    });
    const forgetSessionRuntime = (sessionId: string): void => {
        // Retire naming before resetting its revision fence or removing the Session's database identity.
        agentRuntime.automaticNaming.forgetSession(sessionId);
        sessionRenames.forgetSession(sessionId);
        terminalRestores.forget(sessionId);
        terminalSuspension.forgetSession(sessionId);
        coordinator.forgetSession(sessionId);
        transcripts.forgetSession(sessionId);
        terminals.terminateSession(sessionId);
        // eslint-disable-next-line no-void -- Session teardown is synchronous; provider exit completes on its own.
        void agentChat.closeSession(sessionId);
        agentRuntime.revokeAutoAllow(sessionId, 'sessionDeleted'); // Archive keeps it (caxri#1295).
    };
    const evictSessionCaches = (sessionIds: readonly string[]): void => {
        git.evictSessions(sessionIds);
        projectStatus.evictSessions(sessionIds);
    };
    const snapshots = createWorkbenchSnapshots({
        automaticNamingNotices: () => agentRuntime.automaticNaming.automaticNamingNotices(),
        configuration,
        database,
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
        visibleGridWaitMs:
            dependencies.terminalRestoreGridWaitMs ?? VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS,
    };
    const restoreInterruptedTerminals = createInterruptedTerminalRestorer({
        ...restorerOptions,
        terminalRestores,
    });
    const { restoreInterruptedTerminalsInBackground, watchSessionInBackground } =
        createBackgroundTasks(logger, files, git, restoreInterruptedTerminals);
    terminalSuspension.setOnSuspendedSessionReselected(restoreInterruptedTerminalsInBackground);
    const { restore: restoreCommander, supervisor: commanderRestores } =
        createCommanderTerminalRestorer(restorerOptions);
    const restoreCommanderTerminals = createBackgroundTasks(
        logger,
        files,
        git,
        restoreCommander,
    ).restoreInterruptedTerminalsInBackground;
    /**
     * The one place that tells background services which Session is now current. Project Status polls only this
     * Session, so every path that changes durable selection must go through here: a missed update either leaves the
     * Status panel cold or keeps spending the shared delivery-CLI budget on a Session nobody is looking at. Archive and
     * deletion must also restore their database-selected fallback because they bypass `session.select`.
     */
    const observeSelectedSession = (
        sessionId: string | undefined,
        shouldRestoreFallback = false,
    ): void => {
        watchSessionInBackground(sessionId);
        projectStatus.setPolledSession(sessionId);
        if (shouldRestoreFallback && sessionId) restoreInterruptedTerminalsInBackground(sessionId);
    };
    /**
     * Announces that the whole workbench view has to be re-read. Twelve handlers send the identical envelope, and the
     * `reason` is the only part that carries information: it is what the Renderer's command convergence matches on.
     */
    const sendFullStateChange = (reason: FullStateChangeReason): void => {
        send({ event: 'state.changed', payload: { kind: 'full', reason } });
    };
    const sessionParking = {
        agentChat,
        commanderRestores,
        database,
        evictSessions: evictSessionCaches,
        mobileTerminalMutations,
        restoreSelection: () => observeSelectedSession(selectedSessionId(), true),
        sendFullStateChange,
        terminalRestores,
        terminalSuspension,
    };
    const createSessionForProject = createSessionCreator({
        coordinator,
        database,
        observeSelectedSession,
        sendFullStateChange: () => sendFullStateChange('session.create'),
        startChat: (terminalId) => agentChat.read(terminalId),
        terminalSuspension,
        terminalWorkingDirectory,
        terminals,
    });
    const createMobileSessionForPrincipal = createMobileSessionHandler(
        database,
        createSessionForProject,
    );
    const agentCommands = createAgentCommandRuntime({
        logger,
        delegationSettings: () => configuration.getSettings().value['agents.delegation'],
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
    agentDispatchState.service = agentCommands.dispatchService;
    delegationState.service = agentCommands.delegationService;
    /**
     * Constructed only once the exact-launch write path it fences against exists.
     */
    commanderHooks.notifier = createCommanderCompletionNotifier({
        agentChat,
        coordinator,
        database,
        logger,
        terminals,
    });
    const sessionSelections = new SessionSelectionQueue();
    let isClosed = false;
    async function close(): Promise<void> {
        if (isClosed) return;
        isClosed = true;
        projectStatus.dispose();
        terminalRestores.close();
        commanderRestores.close();
        await agentChat.shutdown();
        await terminalSuspension.close();
        await terminalResourceMonitor.close();
        coordinator.close();
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
        database,
        coordinator,
        terminals,
        logger,
        readiness: compactionReadiness,
        environment: agentEnvironment,
    });
    const terminalInput = createTerminalInputHandler({ coordinator, database, send, terminals });
    const handlers: DomainHandlers = {
        ...coreRoutedHandlers,
        'session.compactWarm': (_parameters, signal) => compaction.run(signal),
        ...agentCommands.handlers,
        'app.bootstrap': () => snapshots.bootstrap(),
        'app.activeContext': () => readActiveContext(database),
        'app.records': ({ sessionIds, terminalIds }) => snapshots.records(sessionIds, terminalIds),
        'app.health': () => ({
            ready: true,
            pid,
            startedAt,
            activePtyCount: countRunning(),
        }),
        ...createAgentChatHandlers(agentChat, { database, agentEnvironment }),
        ...createWindowStateHandlers(database),
        ...createWorkbenchRootHandlers(workbenchRoots),
        ...createTerminalMoveHandler({
            coordinator,
            database,
            send,
            terminals,
            mobileTerminalMutations,
            observeSelectedSession,
        }),
        'bugReport.context': () => diagnostics.reportContext(),
        ...createBugReportDeliveryHandler({ database, terminals }),
        'project.list': () => ({ view: 'desktop', projects: database.listVisibleProjects() }),
        'project.queryForPrincipal': ({ principal, query }) =>
            introspection.records.project(query, principal),
        ...createOrderingHandlers({ database, sendFullStateChange }),
        ...createProjectHidingHandlers({ ...sessionParking, bootstrapState: snapshots.bootstrap }),
        'session.create': ({ projectId, defaultAgent, surface }) =>
            createSessionForProject(projectId, defaultAgent, 'select', undefined, surface),
        'mobile.session.create': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Session creation requires a paired device');
        },
        'mobile.session.createForPrincipal': createMobileSessionForPrincipal,
        ...createMobileDomainHandlers({
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
        'session.select': ({ sessionId }) =>
            sessionSelections.run(async () => {
                await workbenchRoots.validateSession(sessionId);
                database.selectSession(sessionId);
                terminalSuspension.observeSelection();
                observeSelectedSession(sessionId);
                restoreInterruptedTerminalsInBackground(sessionId);
                coordinator.probeSessionPrimaryAgent(sessionId);
                sendFullStateChange('session.select');
                return database.getSession(sessionId)!;
            }),
        'session.markRead': ({ sessionId, attentionEpoch }) => {
            const result = database.markSessionAttentionRead(sessionId, attentionEpoch);
            if (result.acknowledged)
                send({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
                });
            return {
                acknowledged: result.acknowledged,
                sessionId: result.session.id,
                attentionEpoch: result.session.attentionEpoch,
                hasUnread: result.session.hasUnread,
            };
        },
        'session.rename': ({ sessionId, displayTitle }, signal, finalizeDurably) =>
            sessionRenames.rename(sessionId, displayTitle, signal, finalizeDurably),
        ...createSessionParkingHandlers(sessionParking),
        // Under `session.detach`'s Session lock: a resume sent mid-detach relaunches everything it handed over.
        'session.resume': ({ sessionId }) =>
            sessionSelections.run(() =>
                mobileTerminalMutations.runSessions([sessionId], async () => {
                    await workbenchRoots.validateSession(sessionId);
                    database.selectSession(sessionId);
                    terminalSuspension.observeSelection();
                    observeSelectedSession(sessionId);
                    // Detached Chats and PTY Agents both relaunch here, on the Agent Sessions they handed over.
                    agentChat.resumeSession(sessionId);
                    restoreInterruptedTerminalsInBackground(sessionId, { includeDetached: true });
                    coordinator.probeSessionPrimaryAgent(sessionId);
                    sendFullStateChange('session.resume');
                    return database.getSession(sessionId)!;
                }),
            ),
        ...createSessionAgentRuntimeHandlers(agentRuntime),
        ...createDeletionHandlers({
            database,
            delegations: agentCommands.delegationService,
            mobileTerminalMutations,
            bootstrapState: snapshots.bootstrap,
            forgetSessionRuntime,
            evictSessions: evictSessionCaches,
            projectDeleted: (ids) => workbenchRoots.projectDeleted(ids),
            restoreSelection: () => observeSelectedSession(selectedSessionId(), true),
            send,
        }),
        'session.updateState': (state) => {
            database.updateSessionState(state);
            return database.getSessionState(state.sessionId);
        },
        'session.queryForPrincipal': ({ principal, query }) =>
            introspection.records.session(query, principal),
        'terminal.create': async ({ sessionId, kind, cwd, surface }) => {
            const terminal =
                surface === 'chat'
                    ? await createChatTerminal(sessionId, kind, cwd)
                    : await createAndStartTerminal(sessionId, kind, cwd);
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
            sendFullStateChange('terminal.create');
            return terminal;
        },
        'terminal.createInExternalDirectory': async ({ sessionId, cwd }) => {
            const terminal = await createAndStartTerminal(sessionId, 'shell', cwd, undefined, cwd);
            sendFullStateChange('terminal.create');
            return terminal;
        },
        'terminal.input': terminalInput,
        'terminal.inputBinary': createTerminalBinaryInputHandler({
            coordinator,
            database,
            send,
            terminals,
        }),
        'terminal.inputAgentExact': createTerminalAgentExactInputHandler({
            coordinator,
            database,
            send,
            terminals,
        }),
        'terminal.close': ({ terminalId }) =>
            mobileTerminalMutations.run(terminalId, () => {
                const sessionId = database.getTerminal(terminalId)?.sessionId;
                coordinator.forgetTerminal(terminalId);
                transcripts.forgetTerminal(terminalId);
                // eslint-disable-next-line no-void -- the provider exits on its own; the record is removed now.
                void agentChat.close(terminalId);
                terminals.close(terminalId);
                if (sessionId) coordinator.probeSessionPrimaryAgent(sessionId);
                sendFullStateChange('terminal.close');
                return null;
            }),
        ...createRelaunchHandlers({ ...restorerOptions, agentChat, mobileTerminalMutations }),
        ...createTerminalHandlers({
            countRunning,
            database,
            resourceMonitor: terminalResourceMonitor,
            terminals,
            terminalSuspension,
        }),
        'terminal.queryForPrincipal': ({ principal, query }) =>
            introspection.records.terminal(query, principal),
        ...createTerminateAllHandler(sessionParking),
        ...createServiceHandlers({
            acknowledgeFileMutation,
            agentChat,
            agentEnvironment,
            agentHooks,
            awaitAgentSettingsReconcile: agentRuntime.awaitSettingsReconcile,
            commander: commanderHostOptions({
                agentChat,
                coordinator,
                database,
                createAndStartTerminal,
                onStopped: () => commanderHooks.notifier?.onStopped(),
                restores: commanderRestores,
                restoreTerminals: restoreCommanderTerminals,
                scopedWorkbench: snapshots.commander,
                send,
                sendFullStateChange: () => sendFullStateChange('session.create'),
                terminals,
            }),
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
            terminals,
            timeline,
            transcripts,
            userDataPath,
            vercel,
        }),
        ...createGitReviewHandlers({ database, git, longPastes, send, terminalInput, terminals }),
    };
    observeSelectedSession(selectedSessionId());
    terminalSuspension.start();
    terminalResourceMonitor.start();
    // Background Terminal restore preserves the three-second startup gate.
    const initialSessionId = selectedSessionId();
    if (initialSessionId) {
        restoreInterruptedTerminalsInBackground(initialSessionId);
        coordinator.probeSessionPrimaryAgent(initialSessionId);
    }
    return {
        handlers,
        close,
        protocolRecovery: database.protocolState,
        validateRequestContext: (context) => validateWorkbenchRequestContext(database, context),
    };
}
