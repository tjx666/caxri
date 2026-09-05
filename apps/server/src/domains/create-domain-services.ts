import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import process from 'node:process';

import type {
    BootstrapState,
    PersistedWindowState,
    TerminalKind,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, errorMessage } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { AgentDispatchService, createAgentCommandHandlers } from './agent-dispatch';
import { createAgentRuntime } from './agent-runtime';
import { LongPasteService } from './agents';
import { createBackgroundTasks } from './background-tasks';
import { DiagnosticsService } from './diagnostics';
import type { DomainDependencies, DomainHandlers, DomainServices } from './domain-services';
import { createIntrospectionServices } from './introspection';
import { assertInsideRoot } from './path-security';
import { ProjectStatusService } from './project-status';
import { createRootServices } from './root-services';
import { createServiceHandlers, mainOwned } from './service-handlers';
import { SessionSelectionQueue } from './session-selection';
import type { TerminalWorkingDirectoryIdentity } from './terminal';
import {
    ShellIntegrationService,
    TerminalManager,
    TerminalRestoreSupervisor,
    TerminalSuspensionService,
} from './terminal';
import { createTerminalAgentExactInputHandler, createTerminalInputHandler } from './terminal-input';
import { createTerminalMoveHandler } from './terminal-move';
import { createTerminalRestartHandler } from './terminal-restart';
import { createInterruptedTerminalRestorer } from './terminal-restore';
import * as provenance from './workbench-provenance';
import { validateWorkbenchRequestContext } from './workbench-request-context';
import { createWorkbenchRootHandlers } from './workbench-roots';

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
        transcripts,
        watchHub,
        workbenchRoots,
    } = await createRootServices(dependencies);
    const selectedSessionId = () => database.getAppState('lastSelectedSessionId') ?? undefined;
    workbenchRoots.setRootChangedHandler((sessionId) => {
        if (selectedSessionId() === sessionId)
            // eslint-disable-next-line unicorn/prefer-await -- synchronous callback cannot await
            files.refreshWatchSession(sessionId).catch((error: unknown) =>
                logger.write('error', logEventCatalog.files.refreshWatchSessionFailed, {
                    fields: { sessionId, error: errorMessage(error, 'unknown') },
                }),
            );
    });
    const suspensionState: { service?: TerminalSuspensionService } = {};
    const agentRuntime = await createAgentRuntime({
        configuration,
        database,
        dependencies,
        logger,
        onLifecycleSignal: (signal) => suspensionState.service?.observeLifecycle(signal),
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
        agents,
        coordinator,
        sessionAutoNaming,
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
    /**
     * Explicit Terminal-to-Agent wiring keeps provider checks in the composition root instead of a shared event sink.
     */
    const agentDispatchState: { service?: AgentDispatchService } = {};
    const terminals = new TerminalManager(database, send, logger, {
        ...dependencies.terminal,
        execution: dependencies.terminalExecution,
        agentLaunchSettings: dependencies.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        agentOutputRecoverySettings:
            dependencies.terminal?.agentOutputRecoverySettings ?? agentOutputRecoverySettings,
        lifecycleEnvironment: async (terminal, launch, launchId) => {
            if (!launchId)
                throw new CaxriError('CONFLICT', 'Managed Agent launch identity is unavailable');
            const hookEnvironment = agentHooks.terminalEnvironment(
                terminal.id,
                terminal.provider,
                launchId,
            );
            if (!launch || terminal.kind === 'shell') return hookEnvironment;
            const session = database.getSession(terminal.sessionId);
            if (!session) throw new CaxriError('CONFLICT', 'Agent Session no longer exists');
            const providerSettings =
                configuration.getSettings().value['agents.providers'][terminal.kind];
            /**
             * A launch with no active provider-hook context can never report a paired tool boundary. Avoid placing a
             * forced Git topology read on every Agent launch when hooks are disabled or unavailable.
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
            return terminal.kind === 'shell'
                ? undefined
                : dependencies.agentEndpoints?.activate(terminal.id);
        },
        onLifecycleRetired: async (terminalId, launchId) => {
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
        onInput: (terminalId) => suspensionState.service?.observeInput(terminalId),
        onAgentStateChanged: (terminalId, state) =>
            agentDispatchState.service?.observeTerminalState(terminalId, state),
        shellIntegration: (executable, environment) =>
            shellIntegration?.resolve(executable, environment),
        terminalColors:
            dependencies.terminal?.terminalColors ??
            (() => configuration.getTheme().value.terminal),
    });
    const longPastes = new LongPasteService(
        userDataPath,
        database,
        agents,
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
    const projectStatus = new ProjectStatusService(git, logger, externalStatus.run, {
        emit: send,
        github: externalStatus.github,
        settings: () => configuration.getSettings().value,
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
        terminalRestores.forget(sessionId);
        terminalSuspension.forgetSession(sessionId);
        sessionAutoNaming.forgetSession(sessionId);
        coordinator.forgetSession(sessionId);
        transcripts.forgetSession(sessionId);
        terminals.terminateSession(sessionId);
    };
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
    const restoreInterruptedTerminals = createInterruptedTerminalRestorer({
        coordinator,
        database,
        logger,
        send,
        terminalDirectoryIdentity,
        terminalRestores,
        terminals,
        visibleGridWaitMs:
            dependencies.terminalRestoreGridWaitMs ?? VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS,
    });
    const { restoreInterruptedTerminalsInBackground, watchSessionInBackground } =
        createBackgroundTasks(logger, files, restoreInterruptedTerminals);
    /**
     * The one place that tells background services which Session is now current. Project Status polls only this
     * Session, so every path that changes durable selection must go through here: a missed update either leaves the
     * Status panel cold or keeps spending the shared delivery-CLI budget on a Session nobody is looking at.
     */
    const observeSelectedSession = (sessionId: string | undefined): void => {
        watchSessionInBackground(sessionId);
        projectStatus.setPolledSession(sessionId);
    };
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
        projectStatus.dispose();
        terminalRestores.close();
        await terminalSuspension.close();
        await sessionAutoNaming.close();
        coordinator.close();
        longPastes.close();
        unsubscribeTerminalSettings();
        await terminals.shutdown('orderly');
        dispatchService.close();
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
    const handlers: DomainHandlers = {
        'extensions.retry': () => mainOwned('extensions.retry'),
        'requests.cancel': () => mainOwned('requests.cancel'),
        'viewContainers.cancelRequest': () => mainOwned('viewContainers.cancelRequest'),
        'viewContainers.catalog': () => mainOwned('viewContainers.catalog'),
        'viewContainers.executeCommand': () => mainOwned('viewContainers.executeCommand'),
        'viewContainers.treeChildren': () => mainOwned('viewContainers.treeChildren'),
        'viewContainers.viewOperation': () => mainOwned('viewContainers.viewOperation'),
        'agent.context': () => mainOwned('agent.context'),
        'agent.list': () => mainOwned('agent.list'),
        'agent.grants': () => mainOwned('agent.grants'),
        'agent.grant': () => mainOwned('agent.grant'),
        'agent.revoke': () => mainOwned('agent.revoke'),
        ...createAgentCommandHandlers({
            coordinator,
            database,
            dispatch: dispatchService,
            emit: send,
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
        'mobile.access.status': () => mainOwned('mobile.access.status'),
        'mobile.access.enable': () => mainOwned('mobile.access.enable'),
        'mobile.access.disable': () => mainOwned('mobile.access.disable'),
        'mobile.pairing.create': () => mainOwned('mobile.pairing.create'),
        'mobile.device.list': () => mainOwned('mobile.device.list'),
        'mobile.dashboard': () => mainOwned('mobile.dashboard'),
        'mobile.device.revoke': () => mainOwned('mobile.device.revoke'),
        'mobile.device.revoke.apply': () => mainOwned('mobile.device.revoke.apply'),
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
        'gpu.restartInSafeMode': () => mainOwned('gpu.restartInSafeMode'),
        'gpu.testInjectContextLoss': () => mainOwned('gpu.testInjectContextLoss'),
        'processExplorer.open': () => mainOwned('processExplorer.open'),
        'dialog.selectDirectory': () => mainOwned('dialog.selectDirectory'),
        ...createWorkbenchRootHandlers(workbenchRoots, mainOwned),
        ...createTerminalMoveHandler({
            coordinator,
            database,
            send,
            terminals,
            observeSelectedSession,
        }),
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
                terminal.lastAgentProcessState !== 'running' ||
                terminals.agentProcessId(terminalId) === undefined
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
            // Covers the worktree Projects deleted alongside this one, so nothing under them keeps a live cache.
            const { owned: ownedSessions, workbench: affectedWorkbenchSessions } =
                database.projectDeletionScope(projectId);
            const affectedSessionIds = [
                ...new Set(
                    [...ownedSessions, ...affectedWorkbenchSessions].map((session) => session.id),
                ),
            ];
            for (const session of ownedSessions) forgetSessionRuntime(session.id);
            git.evictSessions(affectedSessionIds);
            projectStatus.evictSessions(affectedSessionIds);
            database.deleteProject(projectId);
            workbenchRoots.projectDeleted(affectedWorkbenchSessions.map((session) => session.id));
            observeSelectedSession(selectedSessionId());
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
            terminalSuspension.observeSelection();
            observeSelectedSession(created.session.id);
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
                terminalSuspension.observeSelection();
                observeSelectedSession(sessionId);
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
            return {
                acknowledged: result.acknowledged,
                sessionId: result.session.id,
                attentionEpoch: result.session.attentionEpoch,
                hasUnread: result.session.hasUnread,
            };
        },
        'session.rename': ({ sessionId, displayTitle }, signal, finalizeDurably) => {
            sessionAutoNaming.pauseSession(sessionId);
            return sessionRenames.rename(sessionId, displayTitle, signal, finalizeDurably);
        },
        'session.resumeAutomaticNaming': ({ sessionId }) =>
            sessionAutoNaming.resumeSession(sessionId),
        'session.archive': async ({ sessionId }) => {
            terminalRestores.cancel(sessionId);
            sessionAutoNaming.forgetSession(sessionId);
            const session = database.archiveSession(sessionId);
            await terminalSuspension.suspendSession(sessionId);
            observeSelectedSession(selectedSessionId());
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.archive' } });
            return session;
        },
        'session.detach': async ({ sessionId }) => {
            if (!database.getSession(sessionId))
                throw new CaxriError('NOT_FOUND', 'Session not found');
            // A queued restore could relaunch the Agent right after it was handed over; drop it first.
            terminalRestores.cancel(sessionId);
            await terminalSuspension.detachSession(sessionId);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.detach' } });
            return database.getSession(sessionId)!;
        },
        'session.resume': ({ sessionId }) =>
            sessionSelections.run(async () => {
                await workbenchRoots.validateSession(sessionId);
                database.selectSession(sessionId);
                terminalSuspension.observeSelection();
                observeSelectedSession(sessionId);
                restoreInterruptedTerminalsInBackground(sessionId, { includeDetached: true });
                coordinator.probeSessionPrimaryAgent(sessionId);
                send({
                    event: 'state.changed',
                    payload: { kind: 'full', reason: 'session.resume' },
                });
                return database.getSession(sessionId)!;
            }),
        'session.unarchive': ({ sessionId }) => {
            const session = database.unarchiveSession(sessionId);
            send({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'session.unarchive' },
            });
            return session;
        },
        'session.delete': ({ sessionId }) => {
            forgetSessionRuntime(sessionId);
            git.evictSessions([sessionId]);
            projectStatus.evictSessions([sessionId]);
            database.deleteSession(sessionId);
            observeSelectedSession(selectedSessionId());
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
        'terminal.input': createTerminalInputHandler({ coordinator, database, send, terminals }),
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
        'terminal.close': ({ terminalId }) => {
            const sessionId = database.getTerminal(terminalId)?.sessionId;
            sessionAutoNaming.forgetTerminal(terminalId);
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
        'terminal.query': () => mainOwned('terminal.query'),
        'terminal.queryForPrincipal': ({ principal, query }) =>
            introspection.records.terminal(query, principal),
        'terminal.terminateAll': async () => {
            terminalRestores.close();
            await sessionAutoNaming.close();
            coordinator.close();
            await terminals.shutdown('terminate');
            return null;
        },
        ...createServiceHandlers({
            acknowledgeFileMutation,
            agentEnvironment,
            agentHooks,
            awaitAgentSettingsReconcile: agentRuntime.awaitSettingsReconcile,
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
            transcripts,
            userDataPath,
        }),
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
