import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import {
    CaxriError,
    parseRuntimeRequest,
    toWireError,
    type RuntimeEvent,
    type RuntimeRequest,
    type RuntimeResponse,
} from '../shared/ipc';
import { StructuredLogger } from '../shared/node/logger';
import type { BootstrapState, PersistedWindowState, TerminalKind } from '../shared/types';
import { AgentService } from './agent';
import { CoalescedScheduler } from './coalesced-scheduler';
import { ConfigurationService } from './configuration';
import { CaxriDatabase } from './database';
import { DiagnosticsService } from './diagnostics';
import { FileService } from './files';
import { GitService } from './git';
import { TerminalManager } from './terminal';

const bootStartedAt = performance.now();
const startedAt = Date.now();
const userDataPath = process.env.CAXRI_USER_DATA_PATH;
if (!userDataPath) throw new Error('CAXRI_USER_DATA_PATH is required');
const logDirectory = process.env.CAXRI_LOG_DIRECTORY ?? join(userDataPath, 'logs');
const parentPort = process.parentPort;
if (!parentPort) throw new Error('Caxri Runtime must run as an Electron utilityProcess');

await mkdir(userDataPath, { recursive: true });
const logger = new StructuredLogger(
    logDirectory,
    'runtime',
    process.env.CAXRI_LOG_LEVEL === 'info' ? 'info' : 'debug',
);
const database = new CaxriDatabase(join(userDataPath, 'caxri.db'));
const agentTerminalIds = new Set(
    database
        .listTerminals()
        .filter((terminal) => terminal.provider)
        .map((terminal) => terminal.id),
);
function emit(event: RuntimeEvent): void {
    parentPort.postMessage(event);
    if (event.event === 'terminal.output' && agentTerminalIds.has(event.payload.terminalId))
        agentMetadataRefreshes.schedule(event.payload.terminalId);
}
const configuration = new ConfigurationService(userDataPath, emit, logger);
await configuration.initialize();
database.setAppState('schemaVersion', 4);
database.setAppState('activeThemeId', configuration.getTheme().value.id);
const files = new FileService(
    database,
    emit,
    logger,
    () => configuration.getSettings().value['files.maxFileBytes'],
);
const terminals = new TerminalManager(database, emit, logger);
const git = new GitService(files, logger);
const agents = new AgentService(logger);
const agentMetadataRefreshes = new CoalescedScheduler(2_000, (terminalId: string) =>
    probeTerminalAgent(terminalId).catch((error: unknown) =>
        logAgentProbeFailure(terminalId, error),
    ),
);
const diagnostics = new DiagnosticsService(
    database,
    logger,
    () => configuration.getSettings().value,
    () => terminals.runningCount(),
    startedAt,
);
function bootstrap(): BootstrapState {
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

async function createAndStartTerminal(sessionId: string, kind: TerminalKind) {
    const terminal = database.createTerminal(sessionId, kind);
    try {
        return await terminals.start(terminal);
    } catch {
        return database.getTerminal(terminal.id)!;
    }
}

async function probeTerminalAgent(terminalId: string): Promise<void> {
    const terminal = database.getTerminal(terminalId);
    if (!terminal?.provider) return;
    const session = database.getSession(terminal.sessionId);
    if (!session) return;
    const snapshot = await agents.snapshot(terminal.provider, {
        agentSessionId: terminal.agentSessionId,
        rootPath: session.rootPath,
        processState: terminal.lastProcessState,
    });
    if (database.updateAgentMetadata(terminal.id, snapshot))
        emit({ event: 'state.changed', payload: { reason: 'agent.metadata' } });
}

function schedulePrimaryAgentProbe(sessionId: string): void {
    const session = database.getSession(sessionId);
    if (session?.primaryAgentTerminalId) scheduleAgentProbe(session.primaryAgentTerminalId);
}

function logAgentProbeFailure(terminalId: string, error: unknown): void {
    logger.write('warn', 'agent.probe_failed', {
        fields: {
            terminalId,
            error: error instanceof Error ? error.message : 'unknown',
        },
    });
}

function scheduleAgentProbe(terminalId: string): void {
    void probeTerminalAgent(terminalId).catch((error: unknown) =>
        logAgentProbeFailure(terminalId, error),
    );
}

/** `request` is a discriminated union, so narrowing `request.method` also narrows `request.params`. */
async function handle(request: RuntimeRequest): Promise<unknown> {
    switch (request.method) {
        case 'app.bootstrap':
            return bootstrap();
        case 'app.health':
            return {
                ready: true,
                pid: process.pid,
                startedAt,
                activePtyCount: terminals.runningCount(),
            };
        case 'app.windowState.get':
            return {
                bounds: database.getAppState<PersistedWindowState['bounds']>('windowBounds') ?? {
                    width: 1440,
                    height: 900,
                },
                ...(database.getAppState<
                    Pick<PersistedWindowState, 'isMaximized' | 'isFullScreen'>
                >('windowState') ?? {
                    isMaximized: false,
                    isFullScreen: false,
                }),
            } satisfies PersistedWindowState;
        case 'app.windowState.update': {
            const state = request.params;
            database.setAppState('windowBounds', state.bounds);
            database.setAppState('windowState', {
                isMaximized: state.isMaximized,
                isFullScreen: state.isFullScreen,
            });
            return state;
        }
        case 'project.create': {
            const project = database.createProject(await realpath(request.params.rootPath));
            emit({ event: 'state.changed', payload: { reason: 'project.create' } });
            return project;
        }
        case 'project.cancelCreate':
            throw new CaxriError(
                'CONFLICT',
                'Project creation cancellation is owned by the Main process',
            );
        case 'project.delete': {
            const { projectId } = request.params;
            for (const session of database.listSessions(projectId)) {
                for (const terminal of database.listTerminals(session.id)) {
                    agentTerminalIds.delete(terminal.id);
                    agentMetadataRefreshes.cancel(terminal.id);
                }
                terminals.terminateSession(session.id);
            }
            database.deleteProject(projectId);
            void files.watchSession(
                database.getAppState<string | null>('lastSelectedSessionId') ?? undefined,
            );
            emit({ event: 'state.changed', payload: { reason: 'project.delete' } });
            return bootstrap();
        }
        case 'session.create': {
            const created = database.createSession(
                request.params.projectId,
                request.params.defaultAgent,
            );
            try {
                await terminals.start(created.terminal);
            } catch {
                // The failed durable terminal remains visible and restartable; Session creation still succeeds.
            }
            if (created.terminal.provider) agentTerminalIds.add(created.terminal.id);
            database.selectSession(created.session.id);
            void files.watchSession(created.session.id);
            if (created.terminal.provider) scheduleAgentProbe(created.terminal.id);
            emit({ event: 'state.changed', payload: { reason: 'session.create' } });
            return {
                session: database.getSession(created.session.id)!,
                terminal: database.getTerminal(created.terminal.id)!,
            };
        }
        case 'session.select': {
            const { sessionId } = request.params;
            database.selectSession(sessionId);
            void files.watchSession(sessionId);
            emit({ event: 'state.changed', payload: { reason: 'session.select' } });
            return database.getSession(sessionId)!;
        }
        case 'session.delete': {
            const { sessionId } = request.params;
            for (const terminal of database.listTerminals(sessionId)) {
                agentTerminalIds.delete(terminal.id);
                agentMetadataRefreshes.cancel(terminal.id);
            }
            terminals.terminateSession(sessionId);
            database.deleteSession(sessionId);
            void files.watchSession(
                database.getAppState<string | null>('lastSelectedSessionId') ?? undefined,
            );
            emit({ event: 'state.changed', payload: { reason: 'session.delete' } });
            return bootstrap();
        }
        case 'session.updateState':
            database.updateSessionState(request.params);
            return database.getSessionState(request.params.sessionId);
        case 'terminal.create': {
            const terminal = await createAndStartTerminal(
                request.params.sessionId,
                request.params.kind,
            );
            if (terminal.provider) agentTerminalIds.add(terminal.id);
            if (terminal.provider) scheduleAgentProbe(terminal.id);
            emit({ event: 'state.changed', payload: { reason: 'terminal.create' } });
            return terminal;
        }
        case 'terminal.input':
            terminals.write(request.params.terminalId, request.params.data);
            return null;
        case 'terminal.resize':
            terminals.resize(request.params.terminalId, request.params.cols, request.params.rows);
            return null;
        case 'terminal.close': {
            const { terminalId } = request.params;
            const sessionId = database.getTerminal(terminalId)?.sessionId;
            agentTerminalIds.delete(terminalId);
            agentMetadataRefreshes.cancel(terminalId);
            terminals.close(terminalId);
            if (sessionId) schedulePrimaryAgentProbe(sessionId);
            emit({ event: 'state.changed', payload: { reason: 'terminal.close' } });
            return null;
        }
        case 'terminal.attach':
            return terminals.attach(request.params.terminalId);
        case 'terminal.detach':
            terminals.detachView(request.params.terminalId);
            return null;
        case 'terminal.detachAll':
            terminals.detachAllViews();
            return null;
        case 'terminal.restart': {
            const terminal = await terminals.restart(request.params.terminalId);
            if (terminal.provider) scheduleAgentProbe(terminal.id);
            emit({ event: 'state.changed', payload: { reason: 'terminal.restart' } });
            return terminal;
        }
        case 'terminal.snapshot':
            return database.getSnapshot(request.params.terminalId) ?? null;
        case 'terminal.runningCount':
            return terminals.runningCount(request.params.sessionId);
        case 'terminal.terminateAll':
            agentMetadataRefreshes.close();
            terminals.shutdown();
            return null;
        case 'files.list':
            return files.list(request.params.sessionId, request.params.directory);
        case 'files.read':
            return files.read(request.params.sessionId, request.params.path);
        case 'files.write':
            return files.write(
                request.params.sessionId,
                request.params.path,
                request.params.content,
            );
        case 'git.summary':
            return git.summary(request.params.sessionId);
        case 'git.diff':
            return git.diff(
                request.params.sessionId,
                request.params.repositoryId,
                request.params.path,
            );
        case 'settings.get':
            return configuration.getSettings();
        case 'settings.update':
            await configuration.updateSettings(request.params.source);
            return configuration.getSettings();
        case 'keybindings.get':
            return configuration.getKeybindings();
        case 'keybindings.update':
            await configuration.updateKeybindings(request.params.source);
            return configuration.getKeybindings();
        case 'theme.get':
            return configuration.getTheme();
        case 'theme.update':
            await configuration.updateTheme(request.params.source);
            database.setAppState('activeThemeId', configuration.getTheme().value.id);
            return configuration.getTheme();
        case 'theme.importPath': {
            const theme = await configuration.importTheme(request.params.path);
            database.setAppState('activeThemeId', theme.id);
            return theme;
        }
        case 'config.paths':
            return {
                settings: configuration.settingsPath,
                keybindings: configuration.keybindingsPath,
                theme: configuration.themePath,
            };
        case 'diagnostics.exportPath':
            return diagnostics.export(request.params.destination);
        case 'runtime.shutdown':
            agentMetadataRefreshes.close();
            terminals.shutdown();
            await files.close();
            await configuration.close();
            database.close();
            return null;
        case 'app.openConfigFile':
        case 'dialog.selectDirectory':
        case 'diagnostics.export':
        case 'theme.import':
            throw new CaxriError('CONFLICT', `${request.method} must be handled by Electron Main`);
    }
}

process.parentPort.on('message', (event) => {
    void (async () => {
        const envelope = event.data as { id: string; method: string; params: unknown };
        const started = performance.now();
        try {
            const result = await handle(parseRuntimeRequest(envelope.method, envelope.params));
            const response: RuntimeResponse = { id: envelope.id, ok: true, result };
            parentPort.postMessage(response);
            /** PTY input and resize are measured by aggregated throughput metrics, never synchronous per-event log writes. */
            if (envelope.method !== 'terminal.input' && envelope.method !== 'terminal.resize') {
                logger.write('debug', 'ipc.request', {
                    correlationId: envelope.id,
                    durationMs: performance.now() - started,
                    fields: { method: envelope.method },
                });
            }
            if (envelope.method === 'runtime.shutdown') setTimeout(() => process.exit(0), 10);
        } catch (error) {
            /** Zod failures become VALIDATION, CaxriError keeps its code, everything else is INTERNAL. */
            const wire = toWireError(error);
            const response: RuntimeResponse = { id: envelope.id, ok: false, error: wire };
            parentPort.postMessage(response);
            logger.write('error', 'ipc.request_failed', {
                correlationId: envelope.id,
                durationMs: performance.now() - started,
                fields: {
                    method: envelope.method,
                    code: wire.code,
                    error: wire.message,
                    /** Only unclassified faults justify a stack trace in the Runtime log. */
                    stack:
                        wire.code === 'INTERNAL' && error instanceof Error
                            ? (error.stack ?? null)
                            : null,
                },
            });
        }
    })();
});

logger.write('info', 'runtime.ready', {
    durationMs: performance.now() - bootStartedAt,
    fields: { pid: process.pid },
});
emit({ event: 'runtime.status', payload: { status: 'ready', restartCount: 0 } });
/** File watching is recoverable background work and must never delay Runtime IPC or the first Terminal. */
void files.watchSession(database.getAppState<string | null>('lastSelectedSessionId') ?? undefined);
for (const session of database.listSessions()) schedulePrimaryAgentProbe(session.id);
