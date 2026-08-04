import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
    getRuntimeRequestSchema,
    type RuntimeEvent,
    type RuntimeMethod,
    type RuntimeResponse,
} from '../shared/contracts';
import type {
    BootstrapState,
    PersistedWindowState,
    SessionState,
    TerminalKind,
} from '../shared/types';
import { AgentService } from './agent';
import { ConfigurationService } from './configuration';
import { CaxriDatabase } from './database';
import { DiagnosticsService } from './diagnostics';
import { FileService } from './files';
import { GitService } from './git';
import { StructuredLogger } from './logger';
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
const emit = (event: RuntimeEvent): void => parentPort.postMessage(event);
const configuration = new ConfigurationService(userDataPath, emit, logger);
await configuration.initialize();
database.setAppState('schemaVersion', 1);
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
        sessions: database.listSessions(),
        terminals: database.listTerminals(),
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

async function handle(method: RuntimeMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
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
            const state = params as unknown as PersistedWindowState;
            database.setAppState('windowBounds', state.bounds);
            database.setAppState('windowState', {
                isMaximized: state.isMaximized,
                isFullScreen: state.isFullScreen,
            });
            return state;
        }
        case 'session.create': {
            const created = database.createSession(
                params.rootPath as string,
                params.defaultAgent as TerminalKind,
            );
            try {
                await terminals.start(created.terminal);
            } catch {
                // The failed durable terminal remains visible and restartable; Session creation still succeeds.
            }
            database.selectSession(created.session.id);
            void files.watchSession(created.session.id);
            emit({ event: 'state.changed', payload: { reason: 'session.create' } });
            return {
                session: database.getSession(created.session.id),
                terminal: database.getTerminal(created.terminal.id),
            };
        }
        case 'session.select':
            database.selectSession(params.sessionId as string);
            void files.watchSession(params.sessionId as string);
            emit({ event: 'state.changed', payload: { reason: 'session.select' } });
            return database.getSession(params.sessionId as string);
        case 'session.delete':
            terminals.terminateSession(params.sessionId as string);
            database.deleteSession(params.sessionId as string);
            void files.watchSession(
                database.getAppState<string | null>('lastSelectedSessionId') ?? undefined,
            );
            emit({ event: 'state.changed', payload: { reason: 'session.delete' } });
            return bootstrap();
        case 'session.updateState':
            database.updateSessionState(params as unknown as SessionState);
            return database.getSessionState(params.sessionId as string);
        case 'terminal.create': {
            const terminal = await createAndStartTerminal(
                params.sessionId as string,
                params.kind as TerminalKind,
            );
            emit({ event: 'state.changed', payload: { reason: 'terminal.create' } });
            return terminal;
        }
        case 'terminal.input':
            terminals.write(params.terminalId as string, params.data as string);
            return null;
        case 'terminal.resize':
            terminals.resize(
                params.terminalId as string,
                params.cols as number,
                params.rows as number,
            );
            return null;
        case 'terminal.close':
            terminals.close(params.terminalId as string);
            emit({ event: 'state.changed', payload: { reason: 'terminal.close' } });
            return null;
        case 'terminal.attach':
            return terminals.attach(params.terminalId as string);
        case 'terminal.detach':
            terminals.detachView(params.terminalId as string);
            return null;
        case 'terminal.restart': {
            const terminal = await terminals.restart(params.terminalId as string);
            emit({ event: 'state.changed', payload: { reason: 'terminal.restart' } });
            return terminal;
        }
        case 'terminal.snapshot':
            return database.getSnapshot(params.terminalId as string) ?? null;
        case 'terminal.runningCount':
            return terminals.runningCount(params.sessionId as string | undefined);
        case 'terminal.terminateAll':
            terminals.shutdown();
            return null;
        case 'files.list':
            return files.list(params.sessionId as string, params.directory as string | undefined);
        case 'files.read':
            return files.read(params.sessionId as string, params.path as string);
        case 'files.write':
            return files.write(
                params.sessionId as string,
                params.path as string,
                params.content as string,
            );
        case 'git.summary':
            return git.summary(params.sessionId as string);
        case 'git.diff':
            return git.diff(params.sessionId as string, params.path as string);
        case 'agent.snapshot':
            return agents.snapshot(params.provider as 'claude' | 'codex');
        case 'settings.get':
            return configuration.getSettings();
        case 'settings.update':
            await configuration.updateSettings(params.source as string);
            return configuration.getSettings();
        case 'keybindings.get':
            return configuration.getKeybindings();
        case 'keybindings.update':
            await configuration.updateKeybindings(params.source as string);
            return configuration.getKeybindings();
        case 'theme.get':
            return configuration.getTheme();
        case 'theme.update':
            await configuration.updateTheme(params.source as string);
            database.setAppState('activeThemeId', configuration.getTheme().value.id);
            return configuration.getTheme();
        case 'theme.importPath': {
            const theme = await configuration.importTheme(params.path as string);
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
            return diagnostics.export(params.destination as string);
        case 'runtime.shutdown':
            terminals.shutdown();
            await files.close();
            await configuration.close();
            database.close();
            return null;
        case 'app.openConfigFile':
        case 'dialog.selectDirectory':
        case 'diagnostics.export':
        case 'theme.import':
            throw new Error(`${method} must be handled by Electron Main`);
    }
}

process.parentPort.on('message', (event) => {
    void (async () => {
        const request = event.data as { id: string; method: RuntimeMethod; params: unknown };
        const started = performance.now();
        try {
            const schema = getRuntimeRequestSchema(request.method);
            if (!schema) throw new Error('Unknown Runtime method');
            const params = schema.parse(request.params) as Record<string, unknown>;
            const result = await handle(request.method, params);
            const response: RuntimeResponse = { id: request.id, ok: true, result };
            parentPort.postMessage(response);
            /** PTY input and resize are measured by aggregated throughput metrics, never synchronous per-event log writes. */
            if (request.method !== 'terminal.input' && request.method !== 'terminal.resize') {
                logger.write('debug', 'ipc.request', {
                    correlationId: request.id,
                    durationMs: performance.now() - started,
                    fields: { method: request.method },
                });
            }
            if (request.method === 'runtime.shutdown') setTimeout(() => process.exit(0), 10);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown Runtime error';
            const response: RuntimeResponse = {
                id: request.id,
                ok: false,
                error: { code: 'RUNTIME_ERROR', message },
            };
            parentPort.postMessage(response);
            logger.write('error', 'ipc.request_failed', {
                correlationId: request.id,
                durationMs: performance.now() - started,
                fields: { method: request.method, error: message },
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
