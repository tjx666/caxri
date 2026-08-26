import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import process from 'node:process';

import type {
    AgentProvider,
    BootstrapState,
    PersistedWindowState,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, errorMessage } from '@caxri/protocol';

import { logEventCatalog } from '../shared/node/logger';
import { visiblePaneTerminalIds } from '../shared/pane-layout';
import { AgentDispatchService, createAgentCommandHandlers } from './agent-dispatch';
import {
    AgentCoordinator,
    AgentHookManager,
    AgentService,
    createLocalAgentAdapters,
    defaultAgentEnvironment,
} from './agents';
import { createBackgroundTasks } from './background-tasks';
import { createServiceHandlers, mainOwned } from './bootstrap-service-handlers';
import type { Runtime, RuntimeDependencies } from './bootstrap-types';
import { DiagnosticsService } from './diagnostics';
import type { RuntimeHandlers } from './dispatch';
import { createIntrospectionServices } from './introspection';
import { assertInsideRoot } from './path-security';
import { ProjectStatusService } from './project-status';
import { createRootServices } from './root-services';
import { validateRuntimeRequestContext } from './runtime-request-context';
import { SessionSelectionQueue } from './session-selection';
import type { TerminalWorkingDirectoryIdentity } from './terminal';
import { ShellIntegrationService, TerminalManager, TerminalRestoreSupervisor } from './terminal';
import { createTerminalMoveHandler } from './terminal-move';
import * as provenance from './workbench-provenance';
import { createWorkbenchRootHandlers } from './workbench-roots';

const DEFAULT_WINDOW_BOUNDS: PersistedWindowState['bounds'] = { width: 1440, height: 900 };
const VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS = 5_000;
export type { Runtime, RuntimeDependencies } from './bootstrap-types';
export async function createRuntime(dependencies: RuntimeDependencies): Promise<Runtime> {
    const { logger, send, userDataPath } = dependencies;
    const startedAt = dependencies.startedAt ?? Date.now();
    const pid = dependencies.pid ?? process.pid;
    const {
        acknowledgeFileMutation,
        configuration,
        database,
        files,
        git,
        transcripts,
        watchHub,
        workbenchRoots,
    } = await createRootServices(dependencies);
    workbenchRoots.setRootChangedHandler((sessionId) => {
        if (selectedSessionId() === sessionId)
            // `setRootChangedHandler` takes a synchronous callback, so this cannot become `await`.
            // eslint-disable-next-line unicorn/prefer-await -- sync callback signature; see comment above
            files.refreshWatchSession(sessionId).catch((error: unknown) =>
                logger.write('error', logEventCatalog.files.refreshWatchSessionFailed, {
                    fields: { sessionId, error: errorMessage(error, 'unknown') },
                }),
            );
    });
    const agentLaunchSettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].launch;
    const agentOutputRecoverySettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].recovery;
    const agentEnvironment = dependencies.agentEnvironment ?? defaultAgentEnvironment();
    const agents = new AgentService(
        logger,
        dependencies.agentAdapters ??
            createLocalAgentAdapters(agentEnvironment, agentLaunchSettings),
    );
    const coordinator = new AgentCoordinator(database, agents, send, logger, {
        refreshDelayMs: dependencies.agentRefreshDelayMs,
    });
    const agentHooks = new AgentHookManager({
        environment: agentEnvironment,
        logger,
        onAuthorityLost: (provider) => coordinator.resetHookAuthority(provider),
        onLaunchEnded: (terminalId) => coordinator.endTerminalLaunch(terminalId),
        onLaunchStarted: (terminalId, launchId) =>
            coordinator.beginTerminalLaunch(terminalId, launchId),
        onSignal: (signal) =>
            provenance.didHandleAgentLifecycleSignal(coordinator, workbenchRoots, signal),
        runtimeExecutable: dependencies.runtimeExecutable ?? process.execPath,
        send,
        sharedPath: dependencies.agentHooksPath,
        userDataPath,
        watchHub,
    });
    await agentHooks.initialize(configuration.getSettings().value['agents.providers']);
    let agentSettingsReconcile = Promise.resolve();
    const unsubscribeHookSettings = configuration.subscribeSettings((settings) => {
        /**
         * Preserve setting-update order so a slow probe cannot restore authority after disable.
         */
        agentSettingsReconcile = (async () => {
            try {
                await agentSettingsReconcile;
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
    let shellIntegration: ShellIntegrationService | undefined;
    try {
        shellIntegration = await ShellIntegrationService.create(userDataPath);
    } catch (error: unknown) {
        logger.write('warn', logEventCatalog.pty.shellIntegrationUnavailable, {
            fields: { error: error instanceof Error ? error.message : String(error) },
        });
    }
    /**
     * Explicit Terminal-to-Agent wiring keeps provider checks in the composition root instead of a shared event sink.
     */
    const agentDispatchState: { service?: AgentDispatchService } = {};
    const terminals = new TerminalManager(database, send, logger, {
        ...dependencies.terminal,
        agentLaunchSettings: dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        agentOutputRecoverySettings:
            dependencies.terminal?.agentOutputRecoverySettings ?? agentOutputRecoverySettings,
        lifecycleEnvironment: async (terminal, launch) => {
            const hookEnvironment = agentHooks.terminalEnvironment(terminal.id, terminal.provider);
            if (!launch || terminal.kind === 'shell' || !dependencies.agentEndpoints)
                return hookEnvironment;
            const session = database.getSession(terminal.sessionId);
            if (!session) throw new CaxriError('CONFLICT', 'Agent Session no longer exists');
            const endpointEnvironment = await provenance.prepareAgentWorkbenchProvenance({
                endpoints: dependencies.agentEndpoints,
                projectId: session.projectId,
                settings: configuration.getSettings().value['agents.providers'][terminal.kind],
                terminal,
                workbenchRoots,
            });
            return {
                ...hookEnvironment,
                ...endpointEnvironment,
            };
        },
        onLifecycleStarted: (terminal) =>
            terminal.kind === 'shell'
                ? undefined
                : dependencies.agentEndpoints?.activate(terminal.id),
        onLifecycleRetired: async (terminalId) => {
            agentHooks.endTerminalLaunch(terminalId);
            await provenance.retireAgentWorkbenchProvenance({
                endpoints: dependencies.agentEndpoints,
                logger,
                terminalId,
                workbenchRoots,
            });
        },
        onOutputActivity: (terminalId, processId) =>
            coordinator.observeOutput(terminalId, processId),
        onStateChanged: (terminalId, state) =>
            agentDispatchState.service?.observeTerminalState(terminalId, state),
        shellIntegration: (executable, environment) =>
            shellIntegration?.resolve(executable, environment),
        terminalColors:
            dependencies.terminal?.terminalColors ??
            (() => configuration.getTheme().value.terminal),
    });
    const unsubscribeTerminalSettings = configuration.subscribeSettings(() =>
        terminals.reconcileOutputRecoverySettings(),
    );
    const terminalRestores = new TerminalRestoreSupervisor();
    const projectStatus = new ProjectStatusService(git, logger, undefined, { emit: send });
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

    function bootstrapState(): BootstrapState {
        const settings = configuration.getSettings();
        const keybindings = configuration.getKeybindings();
        const theme = configuration.getTheme();
        const terminalRecords = database.listTerminals();
        return {
            projects: database.listProjects(),
            sessions: database.listSessions(),
            terminals: terminalRecords.map(liveTerminalRecord),
            selectedProjectId: database.getAppState('lastSelectedProjectId') ?? undefined,
            selectedSessionId: database.getAppState('lastSelectedSessionId') ?? undefined,
            sessionStates: database.listSessionStates(terminalRecords),
            settings: settings.value,
            keybindings: keybindings.value,
            keybindingConflicts: keybindings.conflicts,
            configurationErrors: configuration.getErrors(),
            theme: theme.value,
            runtime: { status: 'ready', restartCount: 0 },
        };
    }

    function recordState(sessionIds: readonly string[], terminalIds: readonly string[]) {
        return {
            sessions: [...new Set(sessionIds)].flatMap((sessionId) => {
                const session = database.getSession(sessionId);
                return session ? [session] : [];
            }),
            terminals: [...new Set(terminalIds)].flatMap((terminalId) => {
                const terminal = database.getTerminal(terminalId);
                return terminal ? [liveTerminalRecord(terminal)] : [];
            }),
        };
    }
    function selectedSessionId(): string | undefined {
        return database.getAppState('lastSelectedSessionId') ?? undefined;
    }

    async function terminalWorkingDirectory(
        projectRoot: string,
        requestedCwd?: string,
    ): Promise<string> {
        if (requestedCwd) {
            if (!isAbsolute(requestedCwd))
                throw new CaxriError('VALIDATION', 'Terminal working directory must be absolute');
            let canonicalRoot: string;
            let canonical: string;
            try {
                [canonicalRoot, canonical] = await Promise.all([
                    realpath(projectRoot),
                    realpath(requestedCwd),
                ]);
                if (!(await stat(canonical)).isDirectory())
                    throw new CaxriError(
                        'VALIDATION',
                        'Terminal working directory must be a folder',
                    );
                await access(canonical, constants.X_OK);
            } catch (error) {
                if (error instanceof CaxriError) throw error;
                throw new CaxriError('IO', 'Terminal working directory is unavailable');
            }
            const nested = relative(canonicalRoot, canonical);
            assertInsideRoot(
                nested,
                'Terminal working directory must stay inside the Project root',
            );
            return canonical;
        }
        const configured = configuration.getSettings().value['terminal.defaultWorkingDirectory'];
        if (!configured) return projectRoot;
        const expanded =
            configured === '~'
                ? homedir()
                : configured.startsWith('~/')
                  ? join(homedir(), configured.slice(2))
                  : configured;
        if (!isAbsolute(expanded))
            throw new CaxriError(
                'VALIDATION',
                'Terminal default working directory must be absolute or start with ~',
            );
        try {
            const canonical = await realpath(expanded);
            if (!(await stat(canonical)).isDirectory())
                throw new Error('Configured path is not a directory');
            await access(canonical, constants.X_OK);
            return canonical;
        } catch (error) {
            throw new CaxriError(
                'IO',
                `Terminal default working directory is unavailable: ${String(error)}`,
            );
        }
    }

    async function createAndStartTerminal(
        sessionId: string,
        kind: TerminalKind,
        requestedCwd?: string,
    ): Promise<TerminalRecord> {
        const session = database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const ownerProject = database.getProject(session.projectId);
        if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
        const cwd = await terminalWorkingDirectory(ownerProject.rootPath, requestedCwd);
        const expectedWorkingDirectory = await terminalDirectoryIdentity(cwd);
        const terminal = database.createTerminal(sessionId, kind, cwd);
        coordinator.prepareTerminalStart(terminal.id);
        try {
            return await terminals.start(terminal, { expectedWorkingDirectory });
        } catch {
            return database.getTerminal(terminal.id)!;
        }
    }

    async function terminalDirectoryIdentity(
        path: string,
    ): Promise<TerminalWorkingDirectoryIdentity> {
        const stats = await lstat(path, { bigint: true });
        if (stats.isSymbolicLink() || !stats.isDirectory())
            throw new CaxriError('CONFLICT', 'Terminal working directory changed before launch');
        return {
            path,
            device: stats.dev.toString(),
            inode: stats.ino.toString(),
        };
    }

    /**
     * Auto-restores a Session's Terminals that an orderly shutdown left `interrupted` (GitHub issue #18). A Terminal
     * with a bound Agent conversation (`terminal.provider` set) resumes it via its Runtime provider descriptor, so
     * `coordinator.prepareTerminalStart` — which clears the Agent session binding through `resetAgentMetadataForStart`
     * — must be skipped for that Terminal; that clearing is exactly what a normal (non-resuming) start wants. A
     * Terminal without a bound conversation (a shell, or an Agent Terminal that never reached a capability-detected
     * session id) gets a fresh start instead. A spawn failure is left as `failed`; the user can restart it manually.
     * Restore work shares a global concurrency budget. Selecting another Session invalidates queued work, and the
     * generation is checked again after executable discovery immediately before spawn.
     */
    async function restoreInterruptedTerminals(sessionId: string): Promise<void> {
        const sessionTerminals = database.listTerminals(sessionId);
        // Every pane shows its own active tab, so more than one Terminal can be on screen at once; each of them waits
        // for the attached grid size before replaying, which an off-screen Terminal has no reason to do.
        const visibleTerminalIds = new Set(
            visiblePaneTerminalIds(database.getSessionState(sessionId).paneLayout),
        );
        const interrupted = sessionTerminals.filter(
            (terminal) => terminal.lastProcessState === 'interrupted',
        );
        const restored = await terminalRestores.restore(
            sessionId,
            interrupted.map((terminal) => async (isCurrent, abortSignal) => {
                const resumeAgentSessionId = terminal.provider
                    ? terminal.agentSessionId
                    : undefined;
                if (resumeAgentSessionId) coordinator.prepareTerminalResume(terminal.id);
                else coordinator.prepareTerminalStart(terminal.id);
                try {
                    const expectedWorkingDirectory = await terminalDirectoryIdentity(terminal.cwd);
                    const restarted = await terminals.restart(terminal.id, {
                        expectedWorkingDirectory,
                        resumeAgentSessionId,
                        shouldStart: isCurrent,
                        abortSignal,
                        waitForAttachedSizeMs: visibleTerminalIds.has(terminal.id)
                            ? (dependencies.terminalRestoreGridWaitMs ??
                              VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS)
                            : undefined,
                    });
                    if (restarted.lastProcessState !== 'running') return false;
                } catch {
                    const current = database.getTerminal(terminal.id);
                    if (current?.lastProcessState === 'interrupted') {
                        database.updateTerminalState(
                            terminal.id,
                            'failed',
                            'working_directory_unavailable',
                        );
                        logger.write('warn', logEventCatalog.terminal.restoreCwdRejected, {
                            fields: { terminalId: terminal.id },
                        });
                    }
                    if (database.getTerminal(terminal.id)?.lastProcessState === 'failed')
                        send({
                            event: 'state.changed',
                            payload: {
                                kind: 'records',
                                sessionIds: [],
                                terminalIds: [terminal.id],
                            },
                        });
                    return false;
                }
                if (terminal.provider) coordinator.probeTerminal(terminal.id);
                return true;
            }),
        );
        const restoredTerminalIds: string[] = [];
        for (const [index, terminal] of interrupted.entries())
            if (restored[index]) restoredTerminalIds.push(terminal.id);
        if (restoredTerminalIds.length > 0)
            send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: restoredTerminalIds },
            });
    }

    const { restoreInterruptedTerminalsInBackground, watchSessionInBackground } =
        createBackgroundTasks(logger, files, restoreInterruptedTerminals);

    const dispatchService = new AgentDispatchService({
        database,
        coordinator,
        emit: send,
        endpoints: dependencies.agentEndpoints,
        launchSettings: agentLaunchSettings,
        terminalDirectoryIdentity,
        terminalWorkingDirectory,
        terminals,
    });
    agentDispatchState.service = dispatchService;
    dispatchService.initialize();
    const sessionSelections = new SessionSelectionQueue();

    let isClosed = false;
    async function close(): Promise<void> {
        if (isClosed) return;
        isClosed = true;
        terminalRestores.close();
        coordinator.close();
        unsubscribeTerminalSettings();
        await terminals.shutdown('orderly');
        dispatchService.close();
        await workbenchRoots.close();
        unsubscribeHookSettings();
        await agentSettingsReconcile;
        await agentHooks.close();
        await dependencies.agentEndpoints?.close();
        await files.close();
        await configuration.close();
        await git.close();
        await transcripts.close();
        await watchHub.close();
        database.close();
    }
    const terminalMoveDependencies = {
        coordinator,
        database,
        send,
        terminals,
        watchSessionInBackground,
    };
    const handlers: RuntimeHandlers = {
        'extensions.retry': () => mainOwned('extensions.retry'),
        'requests.cancel': () => mainOwned('requests.cancel'),
        'viewContainers.cancelRequest': () => mainOwned('viewContainers.cancelRequest'),
        'viewContainers.catalog': () => mainOwned('viewContainers.catalog'),
        'viewContainers.executeCommand': () => mainOwned('viewContainers.executeCommand'),
        'viewContainers.treeChildren': () => mainOwned('viewContainers.treeChildren'),
        'viewContainers.viewOperation': () => mainOwned('viewContainers.viewOperation'),
        'agent.context': () => mainOwned('agent.context'),
        'agent.list': () => mainOwned('agent.list'),
        'agent.worktree.created': () => mainOwned('agent.worktree.created'),
        'agent.grants': () => mainOwned('agent.grants'),
        'agent.grant': () => mainOwned('agent.grant'),
        'agent.revoke': () => mainOwned('agent.revoke'),
        ...createAgentCommandHandlers({
            coordinator,
            dispatch: dispatchService,
            endpoints: dependencies.agentEndpoints,
            mainOwned,
            terminals,
        }),
        'agent.message.send': () => mainOwned('agent.message.send'),
        'agent.message.reply': () => mainOwned('agent.message.reply'),
        'agent.message.wait': () => mainOwned('agent.message.wait'),
        'agent.message.check': () => mainOwned('agent.message.check'),
        'agent.message.receipt': () => mainOwned('agent.message.receipt'),
        'agent.message.policy.get': () => mainOwned('agent.message.policy.get'),
        'agent.message.policy.set': () => mainOwned('agent.message.policy.set'),
        'agent.message.held': () => mainOwned('agent.message.held'),
        'agent.message.held.get': () => mainOwned('agent.message.held.get'),
        'agent.message.approve': () => mainOwned('agent.message.approve'),
        'agent.message.deny': () => mainOwned('agent.message.deny'),
        'app.bootstrap': () => bootstrapState(),
        'events.recover': () => mainOwned('events.recover'),
        'events.query': () => mainOwned('events.query'),
        'app.records': ({ sessionIds, terminalIds }) => recordState(sessionIds, terminalIds),
        'app.health': () => ({
            ready: true,
            pid,
            startedAt,
            activePtyCount: terminals.runningCount(),
        }),
        'host.status': () => mainOwned('host.status'),
        'host.stop': () => mainOwned('host.stop'),
        'desktop.status': () => mainOwned('desktop.status'),
        'desktop.focus': () => mainOwned('desktop.focus'),
        'desktop.openPath': () => mainOwned('desktop.openPath'),
        'desktop.openProject': () => mainOwned('desktop.openProject'),
        'desktop.openFile': () => mainOwned('desktop.openFile'),
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
        'external.open': () => mainOwned('external.open'),
        'argv.get': () => mainOwned('argv.get'),
        'argv.update': () => mainOwned('argv.update'),
        'processExplorer.open': () => mainOwned('processExplorer.open'),
        'dialog.selectDirectory': () => mainOwned('dialog.selectDirectory'),
        ...createWorkbenchRootHandlers(workbenchRoots, mainOwned, (endpoint) =>
            provenance.isCurrentAgentWorkbenchEndpoint(dependencies.agentEndpoints, endpoint),
        ),
        ...createTerminalMoveHandler(terminalMoveDependencies),
        'editor.confirmDiscard': () => mainOwned('editor.confirmDiscard'),
        'diagnostics.export': () => mainOwned('diagnostics.export'),
        'bugReport.captureScreenshot': () => mainOwned('bugReport.captureScreenshot'),
        'bugReport.context': () => diagnostics.reportContext(),
        'bugReport.send': () => mainOwned('bugReport.send'),
        'bugReport.deliver': ({ pasteImage, report, sessionId, terminalId }) => {
            const terminal = database.getTerminal(terminalId);
            if (!terminal) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
            if (terminal.sessionId !== sessionId)
                throw new CaxriError(
                    'CONFLICT',
                    'The selected Agent no longer belongs to this Session',
                );
            if (!terminal.provider)
                throw new CaxriError(
                    'CONFLICT',
                    'Bug reports can only be sent to an Agent Terminal',
                );
            if (
                terminal.lastProcessState !== 'running' ||
                terminals.processId(terminalId) === undefined
            )
                throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            if (pasteImage) {
                const imageInput = agentProviderCatalog[terminal.provider].imageInput;
                if (!imageInput)
                    throw new CaxriError(
                        'CONFLICT',
                        'The selected Agent does not support screenshot delivery',
                    );
                if (!terminals.write(terminalId, imageInput.terminalInput))
                    throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            }
            /**
             * Bracketed paste keeps Markdown newlines inside one Agent prompt; the validated report cannot contain
             * control characters capable of terminating the paste sequence.
             */
            if (!terminals.write(terminalId, `\u{1B}[200~${report}\u{1B}[201~\r`))
                throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            return null;
        },
        'files.reveal': () => mainOwned('files.reveal'),
        'project.openInEditor': () => mainOwned('project.openInEditor'),
        'files.trash': () => mainOwned('files.trash'),
        'updates.getState': () => mainOwned('updates.getState'),
        'updates.check': () => mainOwned('updates.check'),
        'updates.download': () => mainOwned('updates.download'),
        'updates.cancel': () => mainOwned('updates.cancel'),
        'updates.open': () => mainOwned('updates.open'),
        'theme.import': () => mainOwned('theme.import'),
        'project.cancelCreate': () => {
            throw new CaxriError(
                'CONFLICT',
                'Project creation cancellation is owned by the Main process',
            );
        },
        'project.delete': ({ projectId }) => {
            const ownedSessions = database.listSessions(projectId);
            const affectedWorkbenchSessions = database.listSessionsUsingWorkbenchProject(projectId);
            const affectedSessionIds = [
                ...new Set(
                    [...ownedSessions, ...affectedWorkbenchSessions].map((session) => session.id),
                ),
            ];
            for (const session of ownedSessions) {
                terminalRestores.forget(session.id);
                coordinator.forgetSession(session.id);
                transcripts.forgetSession(session.id);
                terminals.terminateSession(session.id);
            }
            git.evictSessions(affectedSessionIds);
            projectStatus.evictSessions(affectedSessionIds);
            database.deleteProject(projectId);
            workbenchRoots.projectDeleted(affectedWorkbenchSessions.map((session) => session.id));
            watchSessionInBackground(selectedSessionId());
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'project.delete' } });
            return bootstrapState();
        },
        'project.list': () => ({ view: 'desktop', projects: database.listProjects() }),
        'project.query': () => mainOwned('project.query'),
        'project.queryForPrincipal': ({ principal, query }) =>
            introspection.records.project(query, principal),
        'project.reorder': ({ projectId, targetIndex }) => {
            const reordered = database.reorderProject(projectId, targetIndex);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'project.reorder' } });
            return reordered;
        },
        'session.create': async ({ projectId, defaultAgent }) => {
            const project = database.getProject(projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            const cwd = defaultAgent ? await terminalWorkingDirectory(project.rootPath) : undefined;
            const created = database.createSession(projectId, defaultAgent, cwd);
            if (created.terminal) {
                const expectedWorkingDirectory = await terminalDirectoryIdentity(cwd!);
                coordinator.prepareTerminalStart(created.terminal.id);
                try {
                    await terminals.start(created.terminal, { expectedWorkingDirectory });
                } catch {
                    // The failed durable terminal remains visible and restartable; Session creation still succeeds.
                }
            }
            database.selectSession(created.session.id);
            watchSessionInBackground(created.session.id);
            if (created.terminal?.provider) coordinator.probeTerminal(created.terminal.id);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.create' } });
            return {
                session: database.getSession(created.session.id)!,
                terminal: created.terminal ? database.getTerminal(created.terminal.id)! : null,
            };
        },
        'session.select': ({ sessionId }) =>
            sessionSelections.run(async () => {
                await workbenchRoots.validateSession(sessionId);
                database.selectSession(sessionId);
                watchSessionInBackground(sessionId);
                restoreInterruptedTerminalsInBackground(sessionId);
                coordinator.probeSessionPrimaryAgent(sessionId);
                send({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'session.select' },
                });
                return database.getSession(sessionId)!;
            }),
        'session.markRead': ({ sessionId, attentionEpoch }) => {
            const result = database.markSessionAttentionRead(sessionId, attentionEpoch);
            if (result.acknowledged)
                send({
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
                });
            return result.session;
        },
        'session.rename': ({ sessionId, displayTitle }) => {
            const session = database.renameSession(sessionId, displayTitle);
            send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
            });
            return session;
        },
        'session.archive': ({ sessionId }) => {
            terminalRestores.cancel(sessionId);
            const session = database.archiveSession(sessionId);
            watchSessionInBackground(selectedSessionId());
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.archive' } });
            return session;
        },
        'session.unarchive': ({ sessionId }) => {
            const session = database.unarchiveSession(sessionId);
            send({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'session.unarchive' },
            });
            return session;
        },
        'session.delete': ({ sessionId }) => {
            terminalRestores.forget(sessionId);
            coordinator.forgetSession(sessionId);
            transcripts.forgetSession(sessionId);
            terminals.terminateSession(sessionId);
            git.evictSessions([sessionId]);
            projectStatus.evictSessions([sessionId]);
            database.deleteSession(sessionId);
            watchSessionInBackground(selectedSessionId());
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.delete' } });
            return bootstrapState();
        },
        'session.updateState': (state) => {
            database.updateSessionState(state);
            return database.getSessionState(state.sessionId);
        },
        'session.query': () => mainOwned('session.query'),
        'session.queryForPrincipal': ({ principal, query }) =>
            introspection.records.session(query, principal),
        'terminal.create': async ({ sessionId, kind, cwd }) => {
            const terminal = await createAndStartTerminal(sessionId, kind, cwd);
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'terminal.create' } });
            return terminal;
        },
        'terminal.openFileLink': () => mainOwned('terminal.openFileLink'),
        'terminal.input': ({ terminalId, data }) => {
            if (terminals.processId(terminalId) !== undefined)
                coordinator.observeInput(terminalId, data);
            terminals.write(terminalId, data);
            return null;
        },
        'terminal.resize': ({ terminalId, cols, rows }) => {
            terminals.resize(terminalId, cols, rows);
            return null;
        },
        'terminal.close': ({ terminalId }) => {
            const sessionId = database.getTerminal(terminalId)?.sessionId;
            coordinator.forgetTerminal(terminalId);
            transcripts.forgetTerminal(terminalId);
            terminals.close(terminalId);
            /**
             * Closing the primary Agent Terminal promotes another one, whose metadata must catch up.
             */
            if (sessionId) coordinator.probeSessionPrimaryAgent(sessionId);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'terminal.close' } });
            return null;
        },
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
        'terminal.restart': async ({ mode, terminalId }) => {
            const current = database.getTerminal(terminalId);
            if (!current) throw new CaxriError('NOT_FOUND', 'Terminal not found');
            const expectedWorkingDirectory = await terminalDirectoryIdentity(current.cwd);
            const isStartsFresh = mode === 'fresh';
            const resumeAgentSessionId = isStartsFresh ? undefined : current.agentSessionId;
            if (resumeAgentSessionId) coordinator.prepareTerminalResume(terminalId);
            else coordinator.prepareTerminalStart(terminalId);
            const terminal = await terminals.restart(terminalId, {
                expectedWorkingDirectory,
                resumeAgentSessionId,
            });
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
            send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [terminal.id] },
            });
            return terminal;
        },
        'terminal.snapshot': ({ terminalId }) => terminals.snapshot(terminalId),
        'terminal.runningCount': ({ sessionId }) => terminals.runningCount(sessionId),
        'terminal.resources': ({ terminalId }) => terminals.resources(terminalId),
        'terminal.query': () => mainOwned('terminal.query'),
        'terminal.queryForPrincipal': ({ principal, query }) =>
            introspection.records.terminal(query, principal),
        'terminal.terminateAll': async () => {
            terminalRestores.close();
            coordinator.close();
            await terminals.shutdown('terminate');
            return null;
        },
        ...createServiceHandlers({
            acknowledgeFileMutation,
            agentEnvironment,
            agentHooks,
            awaitAgentSettingsReconcile: () => agentSettingsReconcile,
            configuration,
            database,
            emit: send,
            diagnostics,
            files,
            git,
            introspection,
            projectStatus,
            transcripts,
            userDataPath,
        }),
        'runtime.shutdown': async () => {
            await close();
            return null;
        },
    };
    watchSessionInBackground(selectedSessionId());
    // Background Terminal restore preserves the three-second startup gate.
    const initialSessionId = selectedSessionId();
    if (initialSessionId) {
        restoreInterruptedTerminalsInBackground(initialSessionId);
        coordinator.probeSessionPrimaryAgent(initialSessionId);
    }
    return {
        handlers,
        close,
        validateRequestContext: (context) => validateRuntimeRequestContext(database, context),
    };
}
