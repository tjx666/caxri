import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import process from 'node:process';

import { agentProviderCatalog } from '../shared/agents';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import type { RuntimeMethod } from '../shared/ipc/methods';
import type {
    AgentProvider,
    BootstrapState,
    PersistedWindowState,
    TerminalKind,
    TerminalRecord,
} from '../shared/types';
import { resolveActiveWork } from '../shared/work-item';
import { AgentDispatchService, createAgentCommandHandlers } from './agent-dispatch';
import {
    AgentCoordinator,
    AgentHookManager,
    AgentService,
    createLocalAgentAdapters,
    defaultAgentEnvironment,
} from './agents';
import { createServiceHandlers } from './bootstrap-service-handlers';
import type { Runtime, RuntimeDependencies } from './bootstrap-types';
import { DiagnosticsService } from './diagnostics';
import type { RuntimeHandlers } from './dispatch';
import { createIntrospectionServices } from './introspection';
import { ProjectStatusService } from './project-status';
import { createRootServices } from './root-services';
import type { TerminalWorkingDirectoryIdentity } from './terminal';
import { ShellIntegrationService, TerminalManager, TerminalRestoreSupervisor } from './terminal';
import { createWorkbenchRootHandlers } from './workbench-roots';

const DEFAULT_WINDOW_BOUNDS: PersistedWindowState['bounds'] = { width: 1440, height: 900 };
const VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS = 5_000;
export type { Runtime, RuntimeDependencies } from './bootstrap-types';
/**
 * Methods the Renderer may call but that only Electron Main can satisfy.
 */
function mainOwned(method: RuntimeMethod): never {
    throw new CaxriError('CONFLICT', `${method} must be handled by Electron Main`);
}

/**
 * Composition root: constructs every Runtime service, wires the event flow between them, and returns the typed handler
 * table plus one disposal path. Nothing is constructed at module scope, so a test can create several isolated Runtimes
 * in one process.
 */
export async function createRuntime(dependencies: RuntimeDependencies): Promise<Runtime> {
    const { logger, send, userDataPath } = dependencies;
    const startedAt = dependencies.startedAt ?? Date.now();
    const pid = dependencies.pid ?? process.pid;

    const { acknowledgeFileMutation, configuration, database, files, git, workbenchRoots } =
        await createRootServices(dependencies);
    workbenchRoots.setRootChangedHandler((sessionId) => {
        if (selectedSessionId() === sessionId)
            // `setRootChangedHandler` takes a synchronous callback, so this cannot become `await`.
            // eslint-disable-next-line unicorn/prefer-await -- sync callback signature; see comment above
            files.refreshWatchSession(sessionId).catch((error: unknown) =>
                logger.write('error', 'files.refresh_watch_session_failed', {
                    fields: { sessionId, error: errorMessage(error, 'unknown') },
                }),
            );
    });
    const agentLaunchSettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].launch;
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
        onLaunchStarted: (terminalId, launchId) => {
            coordinator.beginTerminalLaunch(terminalId, launchId);
            workbenchRoots.primeTerminal(terminalId);
        },
        onSignal: (signal) =>
            signal.phase === 'shellToolFinished'
                ? workbenchRoots.observeShellToolFinished(signal)
                : coordinator.observeLifecycleSignal(signal),
        runtimeExecutable: dependencies.runtimeExecutable ?? process.execPath,
        send,
        sharedPath: dependencies.agentHooksPath,
        userDataPath,
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
                logger.write('warn', 'agent.integration_reconcile_failed', {
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
        logger.write('warn', 'pty.shell_integration_unavailable', {
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
        lifecycleEnvironment: async (terminal, launch) => {
            const hookEnvironment = agentHooks.terminalEnvironment(terminal.id, terminal.provider);
            if (!launch || terminal.kind === 'shell' || !dependencies.agentEndpoints)
                return hookEnvironment;
            const session = database.getSession(terminal.sessionId);
            if (!session) throw new CaxriError('CONFLICT', 'Agent Session no longer exists');
            return {
                ...hookEnvironment,
                ...(await dependencies.agentEndpoints.environment(
                    terminal,
                    session.projectId,
                    configuration.getSettings().value['agents.providers'][terminal.kind],
                )),
            };
        },
        onLifecycleStarted: (terminal) =>
            terminal.kind === 'shell'
                ? undefined
                : dependencies.agentEndpoints?.activate(terminal.id),
        onLifecycleRetired: async (terminalId) => {
            agentHooks.endTerminalLaunch(terminalId);
            try {
                await dependencies.agentEndpoints?.retire(terminalId);
            } catch (error: unknown) {
                logger.write('warn', 'agent_endpoint.retire_failed', {
                    fields: {
                        terminalId,
                        error: error instanceof Error ? error.message : String(error),
                    },
                });
            }
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
    const terminalRestores = new TerminalRestoreSupervisor();
    const projectStatus = new ProjectStatusService(git, logger);
    const diagnostics = new DiagnosticsService(
        database,
        logger,
        () => configuration.getSettings().value,
        () => terminals.runningCount(),
        startedAt,
    );
    const introspection = createIntrospectionServices(database, logger);

    function bootstrapState(): BootstrapState {
        const settings = configuration.getSettings();
        const keybindings = configuration.getKeybindings();
        const theme = configuration.getTheme();
        return {
            projects: database.listProjects(),
            sessions: database.listSessions(),
            terminals: database
                .listTerminals()
                .map((terminal) => ({ ...terminal, processId: terminals.processId(terminal.id) })),
            selectedProjectId: database.getAppState('lastSelectedProjectId') ?? undefined,
            selectedSessionId: database.getAppState('lastSelectedSessionId') ?? undefined,
            sessionStates: database.listSessionStates(),
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
                return terminal
                    ? [{ ...terminal, processId: terminals.processId(terminalId) }]
                    : [];
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
            if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested))
                throw new CaxriError(
                    'PATH_DENIED',
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
     * with a bound Agent conversation (`terminal.provider` set) resumes it via `resumeArguments`, so
     * `coordinator.prepareTerminalStart` — which clears the Agent session binding through `resetAgentMetadataForStart`
     * — must be skipped for that Terminal; that clearing is exactly what a normal (non-resuming) start wants. A
     * Terminal without a bound conversation (a shell, or an Agent Terminal that never reached a capability-detected
     * session id) gets a fresh start instead. A spawn failure is left as `failed`; the user can restart it manually.
     * Restore work shares a global concurrency budget. Selecting another Session invalidates queued work, and the
     * generation is checked again after executable discovery immediately before spawn.
     */
    async function restoreInterruptedTerminals(sessionId: string): Promise<void> {
        const sessionTerminals = database.listTerminals(sessionId);
        const activeWork = resolveActiveWork({
            sessionState: database.getSessionState(sessionId),
            sessionTerminals,
        });
        const visibleTerminalId =
            activeWork?.kind === 'terminal' ? activeWork.terminalId : undefined;
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
                        waitForAttachedSizeMs:
                            terminal.id === visibleTerminalId
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
                        logger.write('warn', 'terminal.restore_cwd_rejected', {
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

    /**
     * File watching is recoverable background work (`FileWatcherService#watchSession` already catches and logs its own
     * setup failures) and must never delay a Runtime IPC response, so every call site fires this without awaiting it.
     */
    function watchSessionInBackground(sessionId: string | undefined): void {
        // This helper is intentionally synchronous (`void` return) so sync IPC handlers such as
        // `project.delete` can call it without becoming `async`; it cannot `await` its own promise.
        // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget helper, see comment above
        files.watchSession(sessionId).catch((error: unknown) =>
            logger.write('error', 'files.watch_session_failed', {
                fields: { sessionId: sessionId ?? 'none', error: errorMessage(error, 'unknown') },
            }),
        );
    }

    /**
     * Restoring interrupted Terminals spawns PTYs and probes Agent CLIs; it must never delay the triggering IPC
     * response, so every call site fires this without awaiting it.
     */
    function restoreInterruptedTerminalsInBackground(sessionId: string): void {
        // Same fire-and-forget rationale as `watchSessionInBackground` above.
        // eslint-disable-next-line unicorn/prefer-await -- fire-and-forget helper, see comment above
        restoreInterruptedTerminals(sessionId).catch((error: unknown) =>
            logger.write('error', 'terminal.restore_interrupted_failed', {
                fields: { sessionId, error: errorMessage(error, 'unknown') },
            }),
        );
    }

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

    let isClosed = false;
    async function close(): Promise<void> {
        if (isClosed) return;
        isClosed = true;
        terminalRestores.close();
        coordinator.close();
        terminals.shutdown('orderly');
        dispatchService.close();
        await workbenchRoots.close();
        unsubscribeHookSettings();
        await agentSettingsReconcile;
        await agentHooks.close();
        await dependencies.agentEndpoints?.close();
        await files.close();
        await configuration.close();
        await git.close();
        database.close();
    }
    const handlers: RuntimeHandlers = {
        'agent.context': () => mainOwned('agent.context'),
        'agent.list': () => mainOwned('agent.list'),
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
        ...createWorkbenchRootHandlers(workbenchRoots, mainOwned),
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
        'files.trash': () => mainOwned('files.trash'),
        'updates.getState': () => mainOwned('updates.getState'),
        'updates.check': () => mainOwned('updates.check'),
        'updates.download': () => mainOwned('updates.download'),
        'updates.cancel': () => mainOwned('updates.cancel'),
        'updates.open': () => mainOwned('updates.open'),
        'theme.import': () => mainOwned('theme.import'),
        'project.create': async ({ rootPath }) => {
            const project = database.createProject(await realpath(rootPath));
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'project.create' } });
            return project;
        },
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
                terminalRestores.cancel(session.id);
                coordinator.forgetSession(session.id);
                terminals.terminateSession(session.id);
            }
            git.evictSessions(affectedSessionIds);
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
        'session.select': async ({ sessionId }) => {
            await workbenchRoots.validateSession(sessionId);
            database.selectSession(sessionId);
            watchSessionInBackground(sessionId);
            restoreInterruptedTerminalsInBackground(sessionId);
            coordinator.probeSessionPrimaryAgent(sessionId);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.select' } });
            return database.getSession(sessionId)!;
        },
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
            terminalRestores.cancel(sessionId);
            coordinator.forgetSession(sessionId);
            terminals.terminateSession(sessionId);
            git.evictSessions([sessionId]);
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
        'terminal.snapshot': ({ terminalId }) => database.getSnapshot(terminalId) ?? null,
        'terminal.runningCount': ({ sessionId }) => terminals.runningCount(sessionId),
        'terminal.resources': ({ terminalId }) => terminals.resources(terminalId),
        'terminal.query': () => mainOwned('terminal.query'),
        'terminal.queryForPrincipal': ({ principal, query }) =>
            introspection.records.terminal(query, principal),
        'terminal.terminateAll': () => {
            terminalRestores.close();
            coordinator.close();
            terminals.shutdown('terminate');
            return null;
        },
        ...createServiceHandlers({
            acknowledgeFileMutation,
            agentEnvironment,
            agentHooks,
            awaitAgentSettingsReconcile: () => agentSettingsReconcile,
            configuration,
            database,
            diagnostics,
            files,
            git,
            introspection,
            projectStatus,
            userDataPath,
        }),
        'runtime.shutdown': async () => {
            await close();
            return null;
        },
    };
    watchSessionInBackground(selectedSessionId());
    workbenchRoots.primeAll();
    /**
     * Same fire-and-forget rationale as `files.watchSession` above: restoring the initially selected Session's
     * interrupted Terminals must never delay Runtime startup past the 3s large-Project gate.
     */
    const initialSessionId = selectedSessionId();
    if (initialSessionId) {
        restoreInterruptedTerminalsInBackground(initialSessionId);
        coordinator.probeSessionPrimaryAgent(initialSessionId);
    }
    return { handlers, close };
}
