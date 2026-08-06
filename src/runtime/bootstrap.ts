import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

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
import { AgentService, type AgentAdapter } from './agents/service';
import { ConfigurationService } from './configuration';
import { CURRENT_SCHEMA_VERSION } from './db';
import { CaxriDatabase } from './db/repository';
import { DiagnosticsService } from './diagnostics';
import type { RuntimeHandlers } from './dispatch';
import { FileService } from './files/service';
import { GitService } from './git';
import { ProjectStatusService } from './project-status';
import { TerminalManager, type TerminalManagerOptions } from './terminal';
import { WorkspacePaths } from './workspace-paths';

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

    const database = new CaxriDatabase(join(userDataPath, 'caxri.db'));
    const configuration = new ConfigurationService(userDataPath, send, logger);
    await configuration.initialize();
    database.setAppState('schemaVersion', CURRENT_SCHEMA_VERSION);
    database.setAppState('activeThemeId', configuration.getTheme().value.id);

    const files = new FileService(
        database,
        send,
        logger,
        () => configuration.getSettings().value['files.maxFileBytes'],
    );
    const agents = new AgentService(logger, deps.agentAdapters);
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
                coordinator.observeOutput(event.payload.terminalId);
        },
        logger,
        deps.terminal,
    );
    const git = new GitService(new WorkspacePaths(database), logger);
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

    function selectedSessionId(): string | undefined {
        return database.getAppState<string | null>('lastSelectedSessionId') ?? undefined;
    }

    async function createAndStartTerminal(
        sessionId: string,
        kind: TerminalKind,
    ): Promise<TerminalRecord> {
        const terminal = database.createTerminal(sessionId, kind);
        coordinator.prepareTerminalStart(terminal.id);
        try {
            return await terminals.start(terminal);
        } catch {
            return database.getTerminal(terminal.id)!;
        }
    }

    let closed = false;
    async function close(): Promise<void> {
        if (closed) return;
        closed = true;
        coordinator.close();
        terminals.shutdown();
        await files.close();
        await configuration.close();
        database.close();
    }

    const handlers: RuntimeHandlers = {
        'app.bootstrap': () => bootstrapState(),
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
        'theme.import': () => mainOwned('theme.import'),
        'project.create': async ({ rootPath }) => {
            const project = database.createProject(await realpath(rootPath));
            send({ event: 'state.changed', payload: { reason: 'project.create' } });
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
                coordinator.forgetSession(session.id);
                terminals.terminateSession(session.id);
            }
            database.deleteProject(projectId);
            void files.watchSession(selectedSessionId());
            send({ event: 'state.changed', payload: { reason: 'project.delete' } });
            return bootstrapState();
        },
        'session.create': async ({ projectId, defaultAgent }) => {
            const created = database.createSession(projectId, defaultAgent);
            coordinator.prepareTerminalStart(created.terminal.id);
            try {
                await terminals.start(created.terminal);
            } catch {
                // The failed durable terminal remains visible and restartable; Session creation still succeeds.
            }
            database.selectSession(created.session.id);
            void files.watchSession(created.session.id);
            if (created.terminal.provider) coordinator.probeTerminal(created.terminal.id);
            send({ event: 'state.changed', payload: { reason: 'session.create' } });
            return {
                session: database.getSession(created.session.id)!,
                terminal: database.getTerminal(created.terminal.id)!,
            };
        },
        'session.select': ({ sessionId }) => {
            database.selectSession(sessionId);
            void files.watchSession(sessionId);
            send({ event: 'state.changed', payload: { reason: 'session.select' } });
            return database.getSession(sessionId)!;
        },
        'session.delete': ({ sessionId }) => {
            coordinator.forgetSession(sessionId);
            terminals.terminateSession(sessionId);
            database.deleteSession(sessionId);
            void files.watchSession(selectedSessionId());
            send({ event: 'state.changed', payload: { reason: 'session.delete' } });
            return bootstrapState();
        },
        'session.updateState': (state) => {
            database.updateSessionState(state);
            return database.getSessionState(state.sessionId);
        },
        'terminal.create': async ({ sessionId, kind }) => {
            const terminal = await createAndStartTerminal(sessionId, kind);
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
            send({ event: 'state.changed', payload: { reason: 'terminal.create' } });
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
            send({ event: 'state.changed', payload: { reason: 'terminal.close' } });
            return null;
        },
        'terminal.attach': ({ terminalId }) => terminals.attach(terminalId),
        'terminal.detach': ({ terminalId }) => {
            terminals.detachView(terminalId);
            return null;
        },
        'terminal.detachAll': () => {
            terminals.detachAllViews();
            return null;
        },
        'terminal.restart': async ({ terminalId }) => {
            coordinator.prepareTerminalStart(terminalId);
            const terminal = await terminals.restart(terminalId);
            if (terminal.provider) coordinator.probeTerminal(terminal.id);
            send({ event: 'state.changed', payload: { reason: 'terminal.restart' } });
            return terminal;
        },
        'terminal.snapshot': ({ terminalId }) => database.getSnapshot(terminalId) ?? null,
        'terminal.runningCount': ({ sessionId }) => terminals.runningCount(sessionId),
        'terminal.terminateAll': () => {
            coordinator.close();
            terminals.shutdown();
            return null;
        },
        'files.list': ({ sessionId, directory }) => files.list(sessionId, directory),
        'files.read': ({ sessionId, path }) => files.read(sessionId, path),
        'files.write': ({ sessionId, path, content }) => files.write(sessionId, path, content),
        'git.summary': ({ sessionId }) => git.summary(sessionId),
        'git.diff': ({ sessionId, repositoryId, path }) => git.diff(sessionId, repositoryId, path),
        'git.diffDocument': ({ sessionId, repositoryId, path }) =>
            git.diffDocument(sessionId, repositoryId, path),
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
    for (const session of database.listSessions()) coordinator.probeSessionPrimaryAgent(session.id);

    return { handlers, close };
}
