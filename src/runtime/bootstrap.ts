import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { CaxriError } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { RuntimeMethod } from '../shared/ipc/methods';
import type { StructuredLogger } from '../shared/node/logger';
import type {
    AgentProvider,
    BootstrapState,
    PersistedWindowState,
    TerminalKind,
    TerminalRecord,
} from '../shared/types';
import { AgentCoordinator } from './agents/coordinator';
import { AgentService, createLocalAgentAdapters, type AgentAdapter } from './agents/service';
import { ConfigurationService } from './configuration';
import { CURRENT_SCHEMA_VERSION } from './db';
import { CaxriDatabase } from './db/repository';
import { DiagnosticsService } from './diagnostics';
import type { RuntimeHandlers } from './dispatch';
import { FileService } from './files/service';
import { GitService } from './git';
import { ProjectStatusService } from './project-status';
import {
    TerminalManager,
    type TerminalManagerOptions,
    TerminalRestoreSupervisor,
    type TerminalWorkingDirectoryIdentity,
} from './terminal';
import { ProjectRootResolver } from './project-roots';

const DEFAULT_WINDOW_BOUNDS: PersistedWindowState['bounds'] = { width: 1440, height: 900 };

/**
 * Everything the Runtime cannot discover for itself. The entry point supplies the real Electron
 * utility-process values; an in-process test supplies temporary directories and a fake event sink,
 * which is what makes the handler table testable without launching Electron.
 */
export interface RuntimeDeps {
    /** Directory that owns `caxri.db` and the `config/` tree. */
    userDataPath: string;
    logger: StructuredLogger;
    /** Receives every Runtime event; the entry point forwards these to the Electron parent port. */
    send: (event: RuntimeEvent) => void;
    /** Wall-clock Runtime start reported by `app.health` and diagnostics. Defaults to now. */
    startedAt?: number;
    /** Process identity reported by `app.health`. Defaults to this process. */
    pid?: number;
    /** Trailing Agent metadata refresh delay after Agent Terminal output. */
    agentRefreshDelayMs?: number;
    /** PTY launch seam so an in-process test never spawns a real shell. */
    terminal?: TerminalManagerOptions;
    /** Agent adapter seam so an in-process test never executes an Agent CLI. */
    agentAdapters?: Record<AgentProvider, AgentAdapter>;
}

export interface Runtime {
    handlers: RuntimeHandlers;
    /** Releases every owned resource: schedulers, PTYs, watchers, and the database. */
    close(): Promise<void>;
}

/** Methods the Renderer may call but that only Electron Main can satisfy. */
function mainOwned(method: RuntimeMethod): never {
    throw new CaxriError('CONFLICT', `${method} must be handled by Electron Main`);
}

/**
 * Composition root: constructs every Runtime service, wires the event flow between them, and returns
 * the typed handler table plus one disposal path. Nothing is constructed at module scope, so a test
 * can create several isolated Runtimes in one process.
 */
export async function createRuntime(deps: RuntimeDeps): Promise<Runtime> {
    const { logger, send, userDataPath } = deps;
    const startedAt = deps.startedAt ?? Date.now();
    const pid = deps.pid ?? process.pid;

    const database = new CaxriDatabase(join(userDataPath, 'caxri.db'), {
        onSessionStateRepair: ({ reason, sessionId, stateVersion }) =>
            logger.write('warn', 'db.session_state_repaired', {
                fields: { reason, sessionId, stateVersion },
            }),
    });
    const configuration = new ConfigurationService(userDataPath, send, logger);
    await configuration.initialize();
    database.setAppState('schemaVersion', CURRENT_SCHEMA_VERSION);
    database.setAppState('activeThemeId', configuration.getTheme().value.id);

    const files = new FileService(
        database,
        send,
        logger,
        () => configuration.getSettings().value['files.maxFileBytes'],
        {
            fileTreeExcludes: () => configuration.getSettings().value['files.exclude'],
            mutationJournalPath: join(userDataPath, 'file-operations.json'),
        },
    );
    await files.initialize();
    const agentLaunchSettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].launch;
    const agents = new AgentService(
        logger,
        deps.agentAdapters ?? createLocalAgentAdapters(undefined, agentLaunchSettings),
    );
    const coordinator = new AgentCoordinator(database, agents, send, logger, {
        refreshDelayMs: deps.agentRefreshDelayMs,
    });
    /**
     * Explicit Terminal-to-Agent wiring. Agent probes react to Terminal output here, in the
     * composition root, instead of hiding a provider check inside a shared event sink.
     */
    const terminals = new TerminalManager(
        database,
        (event) => {
            send(event);
            if (event.event === 'terminal.output')
                coordinator.observeOutput(
                    event.payload.terminalId,
                    terminals.processId(event.payload.terminalId),
                );
        },
        logger,
        {
            ...deps.terminal,
            agentLaunchSettings: deps.terminal?.agentLaunchSettings ?? agentLaunchSettings,
        },
    );
    const terminalRestores = new TerminalRestoreSupervisor();
    const git = new GitService(new ProjectRootResolver(database), logger);
    const projectStatus = new ProjectStatusService(git, logger);
    const diagnostics = new DiagnosticsService(
        database,
        logger,
        () => configuration.getSettings().value,
        () => terminals.runningCount(),
        startedAt,
    );

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
            selectedProjectId:
                database.getAppState<string | null>('lastSelectedProjectId') ?? undefined,
            selectedSessionId:
                database.getAppState<string | null>('lastSelectedSessionId') ?? undefined,
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
        return database.getAppState<string | null>('lastSelectedSessionId') ?? undefined;
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
        const cwd = await terminalWorkingDirectory(session.rootPath, requestedCwd);
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
     * Auto-restores a Session's Terminals that an orderly shutdown left `interrupted` (GitHub issue
     * #18). A Terminal with a bound Agent conversation (`terminal.provider` set) resumes it via
     * `resumeArguments`, so `coordinator.prepareTerminalStart` — which clears the Agent session
     * binding through `resetAgentMetadataForStart` — must be skipped for that Terminal; that clearing
     * is exactly what a normal (non-resuming) start wants. A Terminal without a bound conversation
     * (a shell, or an Agent Terminal that never reached a capability-detected session id) gets a
     * fresh start instead. A spawn failure is left as `failed`; the user can restart it manually.
     * Restore work shares a global concurrency budget. Selecting another Session invalidates queued
     * work, and the generation is checked again after executable discovery immediately before spawn.
     */
    async function restoreInterruptedTerminals(sessionId: string): Promise<void> {
        const interrupted = database
            .listTerminals(sessionId)
            .filter((terminal) => terminal.lastProcessState === 'interrupted');
        const restored = await terminalRestores.restore(
            sessionId,
            interrupted.map((terminal) => async (isCurrent) => {
                const resumeAgentSessionId = terminal.provider
                    ? terminal.agentSessionId
                    : undefined;
                if (!resumeAgentSessionId) coordinator.prepareTerminalStart(terminal.id);
                try {
                    const expectedWorkingDirectory = await terminalDirectoryIdentity(terminal.cwd);
                    const restarted = await terminals.restart(terminal.id, {
                        expectedWorkingDirectory,
                        resumeAgentSessionId,
                        shouldStart: isCurrent,
                    });
                    if (restarted.lastProcessState !== 'running') return false;
                } catch {
                    const current = database.getTerminal(terminal.id);
                    if (current?.lastProcessState === 'interrupted') {
                        database.updateTerminalState(terminal.id, 'failed');
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

    let closed = false;
    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        terminalRestores.close();
        coordinator.close();
        terminals.shutdown('orderly');
        await files.close();
        await configuration.close();
        database.close();
    }

    const handlers: RuntimeHandlers = {
        'app.bootstrap': () => bootstrapState(),
        'app.records': ({ sessionIds, terminalIds }) => recordState(sessionIds, terminalIds),
        'app.health': () => ({
            ready: true,
            pid,
            startedAt,
            activePtyCount: terminals.runningCount(),
        }),
        'app.windowState.get': () => ({
            bounds:
                database.getAppState<PersistedWindowState['bounds']>('windowBounds') ??
                DEFAULT_WINDOW_BOUNDS,
            ...(database.getAppState<Pick<PersistedWindowState, 'isMaximized' | 'isFullScreen'>>(
                'windowState',
            ) ?? { isMaximized: false, isFullScreen: false }),
        }),
        'app.windowState.update': (state) => {
            database.setAppState('windowBounds', state.bounds);
            database.setAppState('windowState', {
                isMaximized: state.isMaximized,
                isFullScreen: state.isFullScreen,
            });
            return state;
        },
        'app.openConfigFile': () => mainOwned('app.openConfigFile'),
        'processExplorer.open': () => mainOwned('processExplorer.open'),
        'dialog.selectDirectory': () => mainOwned('dialog.selectDirectory'),
        'diagnostics.export': () => mainOwned('diagnostics.export'),
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
            for (const session of database.listSessions(projectId)) {
                terminalRestores.cancel(session.id);
                coordinator.forgetSession(session.id);
                terminals.terminateSession(session.id);
            }
            database.deleteProject(projectId);
            void files.watchSession(selectedSessionId());
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'project.delete' } });
            return bootstrapState();
        },
        'project.reorder': ({ projectId, targetIndex }) => {
            const reordered = database.reorderProject(projectId, targetIndex);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'project.reorder' } });
            return reordered;
        },
        'session.create': async ({ projectId, defaultAgent }) => {
            const project = database.getProject(projectId);
            if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
            const cwd = await terminalWorkingDirectory(project.rootPath);
            const expectedWorkingDirectory = await terminalDirectoryIdentity(cwd);
            const created = database.createSession(projectId, defaultAgent, cwd);
            coordinator.prepareTerminalStart(created.terminal.id);
            try {
                await terminals.start(created.terminal, { expectedWorkingDirectory });
            } catch {
                // The failed durable terminal remains visible and restartable; Session creation still succeeds.
            }
            database.selectSession(created.session.id);
            void files.watchSession(created.session.id);
            if (created.terminal.provider) coordinator.probeTerminal(created.terminal.id);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.create' } });
            return {
                session: database.getSession(created.session.id)!,
                terminal: database.getTerminal(created.terminal.id)!,
            };
        },
        'session.select': ({ sessionId }) => {
            database.selectSession(sessionId);
            void files.watchSession(sessionId);
            /** Restoring interrupted Terminals spawns PTYs and probes Agent CLIs; it must never delay
                the Session-select response, so it runs fire-and-forget like `files.watchSession`. */
            void restoreInterruptedTerminals(sessionId);
            coordinator.probeSessionPrimaryAgent(sessionId);
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.select' } });
            return database.getSession(sessionId)!;
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
            void files.watchSession(selectedSessionId());
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
            database.deleteSession(sessionId);
            void files.watchSession(selectedSessionId());
            send({ event: 'state.changed', payload: { kind: 'full', reason: 'session.delete' } });
            return bootstrapState();
        },
        'session.updateState': (state) => {
            database.updateSessionState(state);
            return database.getSessionState(state.sessionId);
        },
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
            /** Closing the primary Agent Terminal promotes another one, whose metadata must catch up. */
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
            const startsFresh = mode === 'fresh';
            const resumeAgentSessionId = startsFresh ? undefined : current.agentSessionId;
            if (startsFresh) coordinator.prepareTerminalStart(terminalId);
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
        'terminal.terminateAll': () => {
            terminalRestores.close();
            coordinator.close();
            terminals.shutdown('terminate');
            return null;
        },
        'files.list': ({ sessionId, directory }) => files.list(sessionId, directory),
        'files.browse': (params) => files.browse(params),
        'files.create': (params) => files.create(params),
        'files.copy': (params) => files.copy(params),
        'files.rename': (params) => files.rename(params),
        'files.move': (params) => files.move(params),
        'files.operation.get': async ({ operationId }) =>
            (await files.getMutationOperation(operationId)) ?? null,
        'files.operation.list': () => files.listMutationOperations(),
        'files.operation.cancel': ({ operationId }) => files.cancelMutationOperation(operationId),
        'files.operation.acknowledge': async ({ operationId }) => {
            await files.acknowledgeMutationOperation(operationId);
            return null;
        },
        'files.authorizeTrash': (params) => files.authorizeTrash(params),
        'files.authorizeOpen': (params) => files.authorizeOpen(params),
        'files.read': ({ sessionId, path }) => files.read(sessionId, path),
        'files.write': ({ sessionId, path, content }) => files.write(sessionId, path, content),
        'files.search': (params) => files.search(params),
        'git.summary': ({ sessionId }) => git.summary(sessionId),
        'git.branches': (params) => git.branches(params),
        'git.switchBranch': (params) => git.switchBranch(params),
        'git.diff': ({ sessionId, repositoryId, path }) => git.diff(sessionId, repositoryId, path),
        'git.diffDocument': ({ sessionId, repositoryId, path }) =>
            git.diffDocument(sessionId, repositoryId, path),
        'git.pullRequestChanges': (params) => git.pullRequestChanges(params),
        'git.pullRequestDiffDocument': (params) => git.pullRequestDiffDocument(params),
        'git.commits': (params) => git.commits(params),
        'git.commitDetails': (params) => git.commitDetails(params),
        'git.blame': (params) => git.blame(params),
        'projectStatus.summary': ({ sessionId }) => projectStatus.summary(sessionId),
        'projectStatus.overview': ({ sessionId }) => projectStatus.overview(sessionId),
        'settings.get': () => configuration.getSettings(),
        'settings.update': async ({ source }) => {
            await configuration.updateSettings(source);
            return configuration.getSettings();
        },
        'keybindings.get': () => configuration.getKeybindings(),
        'keybindings.update': async ({ source }) => {
            await configuration.updateKeybindings(source);
            return configuration.getKeybindings();
        },
        'theme.get': () => configuration.getTheme(),
        'theme.update': async ({ source }) => {
            await configuration.updateTheme(source);
            database.setAppState('activeThemeId', configuration.getTheme().value.id);
            return configuration.getTheme();
        },
        'theme.importPath': async ({ path }) => {
            const theme = await configuration.importTheme(path);
            database.setAppState('activeThemeId', theme.id);
            return theme;
        },
        'config.paths': () => ({
            settings: configuration.settingsPath,
            keybindings: configuration.keybindingsPath,
            theme: configuration.themePath,
        }),
        'diagnostics.exportPath': ({ destination }) => diagnostics.export(destination),
        'runtime.shutdown': async () => {
            await close();
            return null;
        },
    };

    /** File watching is recoverable background work and must never delay Runtime IPC or the first Terminal. */
    void files.watchSession(selectedSessionId());
    /** Same fire-and-forget rationale as `files.watchSession` above: restoring the initially selected
        Session's interrupted Terminals must never delay Runtime startup past the 3s large-Project gate. */
    const initialSessionId = selectedSessionId();
    if (initialSessionId) {
        void restoreInterruptedTerminals(initialSessionId);
        coordinator.probeSessionPrimaryAgent(initialSessionId);
    }

    return { handlers, close };
}
