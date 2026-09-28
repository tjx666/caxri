import { join } from 'node:path';
import process from 'node:process';

import type {
    FullStateChangeReason,
    PersistedWindowState,
    SessionRestorePlacement,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { readActiveContext } from './active-context';
import { createAgentCommandRuntime } from './agent-command-runtime';
import type { AgentDelegationService } from './agent-delegation';
import type { AgentDispatchService } from './agent-dispatch';
import { createAgentRuntime } from './agent-runtime';
import { AgentAttentionRequests, CompactionReadiness, LongPasteService } from './agents';
import { createBackgroundTasks, refreshWatchSessionInBackground } from './background-tasks';
import { createBugReportDeliveryHandler } from './bug-report-delivery';
import { commanderLaunchArguments } from './commander';
import { createDeletionHandlers } from './deletion-handlers';
import { DiagnosticsService } from './diagnostics';
import type { DomainDependencies, DomainHandlers, DomainServices } from './domain-services';
import { createGitReviewHandlers } from './git-review-comments';
import { createIntrospectionServices } from './introspection';
import { createMobileDomainHandlers } from './mobile';
import { MobileTerminalMutationQueue } from './mobile-terminal-mutation-queue';
import { createOrderingHandlers } from './ordering-handlers';
import { createProjectHidingHandlers } from './project-hiding-handlers';
import { ProjectStatusService } from './project-status';
import { VercelDeploymentStore } from './project-status-vercel-store';
import { createRootServices } from './root-services';
import { createServiceHandlers, mainOwned, mainOwnedHandlers } from './service-handlers';
import { SessionCompaction } from './session-compaction';
import { createMobileSessionHandler, createSessionCreator } from './session-creation';
import { createSessionPermissionAutoAllowHandlers } from './session-permission-auto-allow-handlers';
import { SessionSelectionQueue } from './session-selection';
import {
    ShellIntegrationService,
    terminalDirectoryIdentity,
    TerminalManager,
    TerminalRestoreSupervisor,
    TerminalSuspensionService,
} from './terminal';
import {
    createTerminalAgentExactInputHandler,
    createTerminalBinaryInputHandler,
    createTerminalInputHandler,
} from './terminal-input';
import { createTerminalMoveHandler } from './terminal-move';
import { createTerminalRestartHandler } from './terminal-restart';
import { createInterruptedTerminalRestorer } from './terminal-restore';
import { resolveTerminalWorkingDirectory } from './terminal-working-directory';
import * as provenance from './workbench-provenance';
import { validateWorkbenchRequestContext } from './workbench-request-context';
import { createWorkbenchRootHandlers } from './workbench-root-handlers';
import { createWorkbenchSnapshots } from './workbench-snapshot';

const DEFAULT_WINDOW_BOUNDS: PersistedWindowState['bounds'] = { width: 1440, height: 900 };
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
        onLifecycleApplied: (signal) => delegationState.service?.observe(signal),
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
    let shellIntegration: ShellIntegrationService | undefined;
    try {
        shellIntegration = await ShellIntegrationService.create(userDataPath);
    } catch (error: unknown) {
        logger.write('warn', logEventCatalog.pty.shellIntegrationUnavailable, {
            fields: { error: error instanceof Error ? error.message : String(error) },
        });
    }
    const agentDispatchState: { service?: AgentDispatchService } = {};
    const mobileTerminalMutations = new MobileTerminalMutationQueue();
    const terminals = new TerminalManager(database, send, logger, {
        ...dependencies.terminal,
        execution: dependencies.terminalExecution,
        agentLaunchArguments: (terminal) => {
            const commander = database.agentCommanderRows();
            return commanderLaunchArguments(terminal, {
                terminalId: commander?.terminalId,
                workspacePath: commander && database.getProject(commander.projectId)?.rootPath,
            });
        },
        agentLaunchSettings: dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        agentOutputRecoverySettings:
            dependencies.terminal?.agentOutputRecoverySettings ?? agentOutputRecoverySettings,
        shellEnvironment: (terminal) => agentHooks.shellEnvironment(terminal.id),
        onShellRetired: (terminalId) => agentHooks.endShellLaunch(terminalId),
        lifecycleEnvironment: async (terminal, launch, launchId, delegationId) => {
            if (!launchId)
                throw new CaxriError('CONFLICT', 'Managed Agent launch identity is unavailable');
            const hookEnvironment = agentHooks.terminalEnvironment(
                terminal.id,
                terminal.provider,
                launchId,
            );
            delegationState.service?.bindEnvironment(
                terminal.id,
                launchId,
                hookEnvironment,
                delegationId,
            );
            if (!launch || terminal.kind === 'shell') return hookEnvironment;
            const session = database.getSession(terminal.sessionId);
            if (!session) throw new CaxriError('CONFLICT', 'Agent Session no longer exists');
            const providerSettings =
                configuration.getSettings().value['agents.providers'][terminal.kind];
            /**
             * Prime topology only when paired hook events can report a worktree change.
             */
            if (providerSettings.hooks.enabled && hookEnvironment.CAXRI_HOOK_TOKEN)
                await provenance.primeAgentWorkbenchProvenance({
                    launchId,
                    projectId: session.projectId,
                    terminal,
                    workbenchRoots,
                });
            if (!dependencies.agentEndpoints) return hookEnvironment;
            const endpointEnvironment = await dependencies.agentEndpoints.environment(
                terminal,
                session.projectId,
                providerSettings,
                launchId,
                database.agentCommanderRows()?.terminalId === terminal.id ? 'commander' : undefined,
            );
            if (!dependencies.agentEndpoints.preparedEndpointForTerminal(terminal.id))
                throw new CaxriError(
                    'UNAVAILABLE',
                    'Agent Endpoint generation was not prepared before launch',
                );
            return {
                ...hookEnvironment,
                ...endpointEnvironment,
            };
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
    const diagnostics = new DiagnosticsService(
        database,
        logger,
        () => configuration.getSettings().value,
        () => terminals.runningCount(),
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
    const terminalWorkingDirectory = (options: {
        authorizedRoots: readonly string[];
        defaultRoot: string;
        requestedCwd?: string;
    }) =>
        resolveTerminalWorkingDirectory({
            ...options,
            configured:
                configuration.getSettings().value['terminal.defaultWorkingDirectory'] ?? undefined,
        });
    async function createAndStartTerminal(
        sessionId: string,
        kind: TerminalKind,
        requestedCwd?: string,
        beforeStart?: (terminal: TerminalRecord) => void,
    ): Promise<TerminalRecord> {
        const session = database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const ownerProject = database.getProject(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        const cwd = await terminalWorkingDirectory({
            authorizedRoots: [ownerProject.rootPath, session.rootPath],
            defaultRoot: session.rootPath,
            requestedCwd,
        });
        const expectedWorkingDirectory = await terminalDirectoryIdentity(cwd);
        const terminal = database.createTerminal(sessionId, kind, cwd);
        beforeStart?.(terminal);
        coordinator.prepareTerminalStart(terminal.id);
        try {
            return await terminals.start(terminal, { expectedWorkingDirectory });
        } catch {
            return database.getTerminal(terminal.id)!;
        }
    }
    const restorerOptions = {
        coordinator,
        database,
        logger,
        send,
        terminalDirectoryIdentity,
        terminals,
        visibleGridWaitMs:
            dependencies.terminalRestoreGridWaitMs ?? VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS,
    };
    const restoreInterruptedTerminals = createInterruptedTerminalRestorer({
        ...restorerOptions,
        terminalRestores,
    });
    const { restoreInterruptedTerminalsInBackground, watchSessionInBackground } =
        createBackgroundTasks(logger, files, git, restoreInterruptedTerminals);
    /**
     * The Agent Commander Session is never selected, so it restores through its own supervisor: sharing the Workbench's
     * would let the next Session selection abort the Commander's resume.
     */
    const commanderRestores = new TerminalRestoreSupervisor(1);
    const restoreCommanderTerminals = createBackgroundTasks(
        logger,
        files,
        git,
        createInterruptedTerminalRestorer({
            ...restorerOptions,
            terminalRestores: commanderRestores,
        }),
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
     * `reason` is the only part that carries information — it is what the Renderer's command convergence matches on.
     */
    const sendFullStateChange = (reason: FullStateChangeReason): void => {
        send({ event: 'state.changed', payload: { kind: 'full', reason } });
    };
    const createSessionForProject = createSessionCreator({
        coordinator,
        database,
        observeSelectedSession,
        sendFullStateChange: () => sendFullStateChange('session.create'),
        terminalSuspension,
        terminalWorkingDirectory,
        terminals,
    });
    const createMobileSessionForPrincipal = createMobileSessionHandler(
        database,
        createSessionForProject,
    );
    const unarchiveSessions = (
        sessionIds: readonly string[],
        placement: SessionRestorePlacement,
    ) => {
        const restored = database.unarchiveSessions(sessionIds, placement);
        sendFullStateChange('session.unarchive');
        return restored;
    };
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
    });
    agentDispatchState.service = agentCommands.dispatchService;
    delegationState.service = agentCommands.delegationService;
    const sessionSelections = new SessionSelectionQueue();
    let isClosed = false;
    async function close(): Promise<void> {
        if (isClosed) return;
        isClosed = true;
        projectStatus.dispose();
        terminalRestores.close();
        commanderRestores.close();
        await terminalSuspension.close();
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
        ...mainOwnedHandlers,
        'session.compactWarm': (_parameters, signal) => compaction.run(signal),
        ...agentCommands.handlers,
        'app.bootstrap': () => snapshots.bootstrap(),
        'app.activeContext': () => readActiveContext(database),
        'app.records': ({ sessionIds, terminalIds }) => snapshots.records(sessionIds, terminalIds),
        'app.health': () => ({
            ready: true,
            pid,
            startedAt,
            activePtyCount: terminals.runningCount(),
        }),
        'app.windowState.get': () => ({
            bounds: database.getAppState('windowBounds') ?? DEFAULT_WINDOW_BOUNDS,
            ...(database.getAppState('windowState') ?? {
                isMaximized: false,
                isFullScreen: false,
            }),
        }),
        'app.windowState.update': (state) => {
            database.setAppState('windowBounds', state.bounds);
            database.setAppState('windowState', {
                isMaximized: state.isMaximized,
                isFullScreen: state.isFullScreen,
            });
            return state;
        },
        ...createWorkbenchRootHandlers(workbenchRoots, mainOwned),
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
        'project.cancelCreate': () => {
            throw new CaxriError(
                'CONFLICT',
                'Project creation cancellation is owned by the Main process',
            );
        },
        'project.list': () => ({ view: 'desktop', projects: database.listVisibleProjects() }),
        'project.queryForPrincipal': ({ principal, query }) =>
            introspection.records.project(query, principal),
        ...createOrderingHandlers({ database, sendFullStateChange }),
        ...createProjectHidingHandlers({
            database,
            bootstrapState: snapshots.bootstrap,
            evictSessions: evictSessionCaches,
            restoreSelection: () => observeSelectedSession(selectedSessionId(), true),
            sendFullStateChange,
            terminalRestores,
            terminalSuspension,
        }),
        'session.create': ({ projectId, defaultAgent }) =>
            createSessionForProject(projectId, defaultAgent, 'select'),
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
        'session.archive': ({ sessionId }) =>
            mobileTerminalMutations.runSessions([sessionId], async () => {
                terminalRestores.cancel(sessionId);
                const session = database.archiveSession(sessionId);
                await terminalSuspension.suspendSession(sessionId);
                observeSelectedSession(selectedSessionId(), true);
                sendFullStateChange('session.archive');
                return session;
            }),
        'session.detach': ({ sessionId }) =>
            mobileTerminalMutations.runSessions([sessionId], async () => {
                if (!database.getSession(sessionId))
                    throw new CaxriError('NOT_FOUND', 'Session not found');
                // A queued restore could relaunch the Agent right after it was handed over; drop it first.
                terminalRestores.cancel(sessionId);
                await terminalSuspension.detachSession(sessionId);
                sendFullStateChange('session.detach');
                return database.getSession(sessionId)!;
            }),
        'session.resume': ({ sessionId }) =>
            sessionSelections.run(async () => {
                await workbenchRoots.validateSession(sessionId);
                database.selectSession(sessionId);
                terminalSuspension.observeSelection();
                observeSelectedSession(sessionId);
                restoreInterruptedTerminalsInBackground(sessionId, { includeDetached: true });
                coordinator.probeSessionPrimaryAgent(sessionId);
                sendFullStateChange('session.resume');
                return database.getSession(sessionId)!;
            }),
        ...createSessionPermissionAutoAllowHandlers(agentRuntime),
        'session.unarchive': ({ placement, sessionId }) =>
            unarchiveSessions([sessionId], placement)[0],
        'session.unarchiveMany': ({ placement, sessionIds }) =>
            unarchiveSessions([...new Set(sessionIds)], placement),
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
        'terminal.create': async ({ sessionId, kind, cwd }) => {
            const terminal = await createAndStartTerminal(sessionId, kind, cwd);
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
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
        'terminal.resize': ({ terminalId, cols, rows }) => {
            terminals.resize(terminalId, cols, rows);
            return null;
        },
        'terminal.close': ({ terminalId }) =>
            mobileTerminalMutations.run(terminalId, () => {
                const sessionId = database.getTerminal(terminalId)?.sessionId;
                coordinator.forgetTerminal(terminalId);
                transcripts.forgetTerminal(terminalId);
                terminals.close(terminalId);
                if (sessionId) coordinator.probeSessionPrimaryAgent(sessionId);
                sendFullStateChange('terminal.close');
                return null;
            }),
        'terminal.attach': ({ cols, rows, terminalId }) =>
            terminals.attach(
                terminalId,
                cols === undefined || rows === undefined ? undefined : { cols, rows },
            ),
        'terminal.detach': ({ terminalId }) => {
            terminals.detachView(terminalId);
            return null;
        },
        'terminal.detachAll': () => {
            terminals.detachAllViews();
            return null;
        },
        'terminal.restart': createTerminalRestartHandler({
            coordinator,
            database,
            send,
            terminalDirectoryIdentity,
            terminals,
        }),
        'terminal.snapshot': ({ terminalId }) => terminals.snapshot(terminalId),
        'terminal.preview': ({ terminalId }) => terminals.preview(terminalId),
        'terminal.runningCount': ({ sessionId }) => terminals.runningCount(sessionId),
        'terminal.resources': ({ terminalId }) => terminals.resources(terminalId),
        'terminal.queryForPrincipal': ({ principal, query }) =>
            introspection.records.terminal(query, principal),
        'terminal.terminateAll': async () => {
            terminalRestores.close();
            commanderRestores.close();
            coordinator.close();
            await terminals.shutdown('terminate');
            return null;
        },
        ...createServiceHandlers({
            acknowledgeFileMutation,
            agentEnvironment,
            agentHooks,
            awaitAgentSettingsReconcile: agentRuntime.awaitSettingsReconcile,
            commander: {
                cancelRestore: (sessionId) => {
                    commanderRestores.cancel(sessionId);
                    return commanderRestores.settled(sessionId);
                },
                createAndStartTerminal,
                probeTerminal: (terminalId) => coordinator.probeTerminal(terminalId),
                /**
                 * `includeDetached` is what lets an explicit reopen resume a Commander the user stopped:
                 * `commander.stop` parks it as `detached`, which an ordinary restore leaves alone.
                 */
                restoreTerminals: (sessionId) =>
                    restoreCommanderTerminals(sessionId, { includeDetached: true }),
                scopedWorkbench: snapshots.commander,
                sendFullStateChange: () => sendFullStateChange('session.create'),
                sendTerminalChange: (terminalId) =>
                    send({
                        event: 'state.changed',
                        payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
                    }),
                stopTerminal: (terminalId) => terminals.suspend(terminalId, 'detached'),
            },
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
            timeline,
            transcripts,
            userDataPath,
            vercel,
        }),
        ...createGitReviewHandlers({ database, git, longPastes, send, terminalInput, terminals }),
    };
    observeSelectedSession(selectedSessionId());
    terminalSuspension.start();
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
