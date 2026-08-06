import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    app,
    BrowserWindow,
    dialog,
    ipcMain,
    Menu,
    shell,
    type IpcMainInvokeEvent,
} from 'electron';

import { getCommandDefinition } from '../shared/commands';
import { CaxriError, toWireError } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import { isMainRequest, type CaxriRequest, type MainRequest } from '../shared/ipc/methods';
import {
    parseCaxriResult,
    parseCaxriRequest,
    requestEnvelopeSchema,
    type CaxriReply,
} from '../shared/ipc/transport';
import { StructuredLogger } from '../shared/node/logger';
import { themeImportExtensions } from '../shared/theme-import';
import type { PersistedWindowState } from '../shared/types';
import { decideCrashRecovery } from './crash-policy';
import { resolveLogLevel } from './log-level';
import { resolveLogDirectory } from './log-path';
import { ProcessExplorerSampler } from './process-explorer';
import { ProcessExplorerWindowController } from './process-explorer-window';
import { ProjectRootGrants } from './root-grants';
import { RuntimeSupervisor } from './supervisor';
import { resolveTestRootPath } from './test-root';
import { createWindowCloseHandler } from './window-close';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Stamps these once at module load, before any logger or the Runtime supervisor is constructed, so
 * every log record and the forked Runtime's environment can be correlated to this build. See
 * src/main/global.d.ts and electron.vite.config.ts for where the constants come from.
 */
process.env.CAXRI_APP_VERSION =
    typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
process.env.CAXRI_GIT_COMMIT = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
if (process.env.CAXRI_USER_DATA_DIR) app.setPath('userData', process.env.CAXRI_USER_DATA_DIR);
let mainWindow: BrowserWindow | undefined;
let supervisor: RuntimeSupervisor;
let mainLogger: StructuredLogger | undefined;
let processExplorer: ProcessExplorerWindowController;
let forceWindowClose = false;
let quitStarted = false;
const grantedRoots = new ProjectRootGrants();

function sendEvent(event: RuntimeEvent): void {
    if (event.event === 'runtime.status') {
        mainLogger?.write(event.payload.status === 'failed' ? 'error' : 'info', 'runtime.status', {
            fields: { status: event.payload.status, restartCount: event.payload.restartCount },
        });
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('caxri:event', event);
    if (event.event === 'keybindings.changed' && !event.payload.error) void installMenu();
}

async function confirmExternalUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return;
    const result = await dialog.showMessageBox({
        type: 'question',
        title: 'Open External Link',
        message: `Open ${parsed.hostname} in your default browser?`,
        buttons: ['Open', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
    });
    if (result.response === 0) await shell.openExternal(parsed.toString());
}

function createWindow(initialState: PersistedWindowState): BrowserWindow {
    const window = new BrowserWindow({
        ...initialState.bounds,
        minWidth: 960,
        minHeight: 640,
        title: 'Caxri',
        /**
         * Deliberately a literal, and the one color literal left in the app: it paints the window
         * before any renderer CSS exists, which is what prevents a white flash on launch. It
         * mirrors the default theme's `--background`; an imported theme cannot change it.
         */
        backgroundColor: '#282a36',
        /**
         * No title bar row: the sidebar header is the drag region and carries the brand instead.
         * `title` stays for VoiceOver and Mission Control, which still read the window title.
         */
        titleBarStyle: 'hiddenInset',
        show: false,
        webPreferences: {
            preload: join(currentDirectory, '../preload/index.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    let persistTimer: NodeJS.Timeout | undefined;
    let rendererCrashTimestampsMs: number[] = [];
    const persistWindowState = (): void => {
        const state = readWindowState(window);
        void supervisor.request('app.windowState.update', state).catch(() => undefined);
    };
    const scheduleWindowState = (): void => {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(persistWindowState, 250);
    };
    window.on('move', scheduleWindowState);
    window.on('resize', scheduleWindowState);
    window.on('maximize', scheduleWindowState);
    window.on('unmaximize', scheduleWindowState);
    window.on('enter-full-screen', scheduleWindowState);
    window.on('leave-full-screen', scheduleWindowState);
    if (initialState.isMaximized) window.maximize();
    if (initialState.isFullScreen) window.setFullScreen(true);
    mainLogger?.write('info', 'window.created');

    window.once('ready-to-show', () => {
        mainLogger?.write('info', 'window.ready_to_show', {
            durationMs: performance.now() - bootStartedAt,
        });
        window.show();
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        void confirmExternalUrl(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        const currentUrl = window.webContents.getURL();
        if (url === currentUrl) return;
        event.preventDefault();
        void confirmExternalUrl(url);
    });
    /** Renderer console errors are otherwise invisible in logs; mirror them so triage can see UI faults. */
    window.webContents.on('console-message', (details) => {
        if (details.level !== 'error') return;
        mainLogger?.write('error', 'renderer.console', {
            fields: {
                message: details.message.slice(0, 4096),
                source: `${details.sourceId ?? 'unknown'}:${details.lineNumber ?? 0}`,
            },
        });
    });
    window.webContents.on('render-process-gone', (_event, details) => {
        if (details.reason === 'clean-exit' || window.isDestroyed()) return;
        const { decision, crashTimestampsMs } = decideCrashRecovery(
            rendererCrashTimestampsMs,
            Date.now(),
        );
        rendererCrashTimestampsMs = crashTimestampsMs;
        if (decision.action === 'reload') {
            mainLogger?.write('warn', 'window.render_process_gone', {
                fields: {
                    reason: details.reason,
                    crashCount: decision.crashCount,
                    delayMs: decision.delayMs ?? 0,
                },
            });
            setTimeout(() => {
                if (!window.isDestroyed()) window.reload();
            }, decision.delayMs);
            return;
        }
        mainLogger?.write('error', 'window.render_process_crash_loop', {
            fields: { reason: details.reason, crashCount: decision.crashCount },
        });
        void dialog
            .showMessageBox(window, {
                type: 'error',
                title: 'Caxri Keeps Crashing',
                message: 'The Caxri window has crashed repeatedly and automatic reload stopped.',
                detail: 'Relaunch Caxri, or quit to investigate.',
                buttons: ['Relaunch', 'Quit'],
                defaultId: 0,
                cancelId: 1,
            })
            .then((result) =>
                supervisor
                    .shutdown()
                    .catch(() => undefined)
                    .finally(() => {
                        if (result.response === 0) app.relaunch();
                        app.exit(0);
                    }),
            );
    });
    const requestWindowClose = createWindowCloseHandler({
        close: () => {
            forceWindowClose = true;
            window.close();
            forceWindowClose = false;
        },
        confirm: async (count) => {
            mainLogger?.write('info', 'window.close_confirmation', {
                fields: { runningTerminals: count },
            });
            const result = await dialog.showMessageBox(window, {
                type: 'warning',
                title: 'Terminals are still running',
                message: `${count} Terminal${count === 1 ? ' is' : 's are'} still running.`,
                detail: 'Keeping them running leaves Caxri active without a window. Explicit App Quit always terminates them.',
                buttons: ['Keep Running', 'Terminate and Close', 'Cancel'],
                defaultId: 2,
                cancelId: 2,
            });
            mainLogger?.write('info', 'window.close_decision', {
                fields: { response: result.response },
            });
            return result.response === 2 ? 'cancel' : result.response === 1 ? 'terminate' : 'close';
        },
        countRunning: () => supervisor.request('terminal.runningCount'),
        detachAll: () => supervisor.request('terminal.detachAll'),
        logFailure: (message) =>
            mainLogger?.write('error', 'window.close_failed', {
                fields: { error: message },
            }),
        terminateAll: () => supervisor.request('terminal.terminateAll'),
    });
    window.on('close', (event) => {
        if (forceWindowClose || quitStarted) return;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = undefined;
        persistWindowState();
        event.preventDefault();
        void requestWindowClose();
    });
    window.on('closed', () => {
        if (persistTimer) clearTimeout(persistTimer);
        if (mainWindow === window) mainWindow = undefined;
        mainLogger?.write('info', 'window.closed');
    });

    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(currentDirectory, '../renderer/index.html'));
    return window;
}

function readWindowState(window: BrowserWindow): PersistedWindowState {
    return {
        bounds: window.getNormalBounds(),
        isMaximized: window.isMaximized(),
        isFullScreen: window.isFullScreen(),
    };
}

async function openMainWindow(): Promise<void> {
    if (mainWindow) return;
    const initialState = await supervisor
        .request('app.windowState.get')
        .catch((): PersistedWindowState => ({
            bounds: { width: 1440, height: 900 },
            isMaximized: false,
            isFullScreen: false,
        }));
    mainWindow = createWindow(initialState);
}

function assertSender(event: IpcMainInvokeEvent): void {
    if (!mainWindow || event.sender !== mainWindow.webContents)
        throw new CaxriError('PATH_DENIED', 'Untrusted IPC sender');
}

function assertNever(value: never): never {
    throw new CaxriError('INTERNAL', `Unhandled Main request: ${String(value)}`);
}

async function handleMainMethod(request: MainRequest): Promise<unknown> {
    switch (request.method) {
        case 'dialog.selectDirectory': {
            const testRoot = resolveTestRootPath({ isPackaged: app.isPackaged });
            if (testRoot) {
                grantedRoots.grant(testRoot);
                return testRoot;
            }
            const result = await dialog.showOpenDialog(mainWindow!, {
                title: 'Choose a Project directory',
                properties: ['openDirectory', 'createDirectory'],
            });
            const path = result.filePaths[0];
            if (!result.canceled && path) grantedRoots.grant(path);
            /** A dismissed or empty selection must resolve to null, never to an absent value. */
            return result.canceled ? null : (path ?? null);
        }
        case 'project.create': {
            const { rootPath } = request.params;
            return grantedRoots.use(rootPath, () =>
                supervisor.request('project.create', { rootPath }),
            );
        }
        case 'project.cancelCreate':
            grantedRoots.revoke(request.params.rootPath);
            return null;
        case 'project.delete': {
            const { projectId } = request.params;
            const state = await supervisor.request('app.bootstrap');
            const sessions = state.sessions.filter((session) => session.projectId === projectId);
            const counts = await Promise.all(
                sessions.map((session) =>
                    supervisor.request('terminal.runningCount', { sessionId: session.id }),
                ),
            );
            const count = counts.reduce((sum, value) => sum + value, 0);
            const projectTitle =
                state.projects.find((project) => project.id === projectId)?.displayTitle ??
                'this Project';
            const result = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                title: 'Remove Project',
                message:
                    count > 0
                        ? `Remove '${projectTitle}' and terminate ${count} running Terminal${count === 1 ? '' : 's'}?`
                        : `Remove '${projectTitle}'?`,
                detail: 'Only Caxri metadata and snapshots are removed. The Project directory and its files are never deleted.',
                buttons: ['Remove Project', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            });
            if (result.response !== 0) return { canceled: true };
            return supervisor.request('project.delete', { projectId });
        }
        case 'session.delete': {
            const { sessionId } = request.params;
            const count = await supervisor.request('terminal.runningCount', { sessionId });
            const bootstrap = await supervisor.request('app.bootstrap');
            const sessionTitle =
                bootstrap.sessions.find((session) => session.id === sessionId)?.displayTitle ??
                'this Session';
            const result = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                title: 'Delete Session',
                message:
                    count > 0
                        ? `Delete '${sessionTitle}' and terminate ${count} running Terminal${count === 1 ? '' : 's'}?`
                        : `Delete '${sessionTitle}'?`,
                detail: 'Only Caxri metadata and snapshots are removed. The selected directory and its files are never deleted.',
                buttons: ['Delete Session', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            });
            if (result.response !== 0) return { canceled: true };
            return supervisor.request('session.delete', { sessionId });
        }
        case 'theme.import': {
            const result = await dialog.showOpenDialog(mainWindow!, {
                title: 'Import Theme',
                properties: ['openFile'],
                filters: [
                    {
                        name: 'Theme files',
                        extensions: [...themeImportExtensions],
                    },
                ],
            });
            const path = result.filePaths[0];
            return result.canceled || !path
                ? null
                : supervisor.request('theme.importPath', { path });
        }
        case 'app.openConfigFile': {
            const paths = await supervisor.request('config.paths');
            const path = paths[request.params.kind];
            if (!path) throw new CaxriError('NOT_FOUND', 'Unknown configuration file');
            const error = await shell.openPath(path);
            if (error) throw new CaxriError('IO', error);
            return null;
        }
        case 'processExplorer.open':
            processExplorer.open();
            return null;
        case 'diagnostics.export': {
            const result = await dialog.showSaveDialog(mainWindow!, {
                title: 'Export Diagnostics',
                defaultPath: `caxri-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.zip`,
                filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
            });
            if (result.canceled || !result.filePath) return null;
            return supervisor.request(
                'diagnostics.exportPath',
                { destination: result.filePath },
                60_000,
            );
        }
    }
    return assertNever(request);
}

async function handleCaxriRequest(request: CaxriRequest): Promise<unknown> {
    /** Runtime results are validated by the supervisor; only Main-owned results need parsing here. */
    if (isMainRequest(request))
        return parseCaxriResult(request.method, await handleMainMethod(request));
    return supervisor.forward(request.method, request.params);
}

function installIpc(): void {
    ipcMain.handle('caxri:request', async (event, raw: unknown): Promise<CaxriReply> => {
        try {
            assertSender(event);
            const envelope = requestEnvelopeSchema.parse(raw);
            const request = parseCaxriRequest(envelope.method, envelope.params);
            const result = await handleCaxriRequest(request);
            return { ok: true, result };
        } catch (error) {
            /** Replying with a classified envelope keeps the error code intact across the preload. */
            const wire = toWireError(error);
            mainLogger?.write('error', 'ipc.request_failed', {
                fields: { code: wire.code, error: wire.message },
            });
            return { ok: false, error: wire };
        }
    });
}

function electronAccelerator(key: string | undefined): string | undefined {
    if (!key) return undefined;
    const names: Record<string, string> = {
        cmd: 'Command',
        command: 'Command',
        ctrl: 'Control',
        control: 'Control',
        alt: 'Alt',
        option: 'Alt',
        shift: 'Shift',
    };
    return key
        .split('+')
        .map((part) => names[part.trim().toLowerCase()] ?? part.trim().toUpperCase())
        .join('+');
}

async function installMenu(): Promise<void> {
    const keybindings = await supervisor
        .request('keybindings.get')
        .then((result) => result.value)
        .catch(() => []);
    const accelerator = (id: string): string | undefined =>
        electronAccelerator(keybindings.find((binding) => binding.command === id)?.key);
    const command = (id: string, label?: string) => ({
        id: `command.${id}`,
        label: label ?? getCommandDefinition(id).title,
        accelerator: accelerator(id),
        click: () => sendEvent({ event: 'command.execute', payload: { command: id } }),
    });
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            {
                label: 'Caxri',
                submenu: [
                    { role: 'about' },
                    { type: 'separator' },
                    command('settings.open', 'Settings…'),
                    { type: 'separator' },
                    { id: 'app.hide', role: 'hide', accelerator: 'Command+H' },
                    { role: 'hideOthers' },
                    { role: 'unhide' },
                    { type: 'separator' },
                    { role: 'quit' },
                ],
            },
            {
                label: 'Project',
                submenu: [
                    command('project.create', 'Add Project…'),
                    command('project.delete', 'Remove Project…'),
                ],
            },
            {
                label: 'Session',
                submenu: [
                    command('session.create', 'New Session'),
                    command('session.delete', 'Delete Session…'),
                    { type: 'separator' },
                    command('session.selectPrevious', 'Previous Session'),
                    command('session.selectNext', 'Next Session'),
                ],
            },
            {
                label: 'Terminal',
                submenu: [
                    command('terminal.new'),
                    command('terminal.clear'),
                    command('terminal.restart'),
                    command('terminal.close'),
                ],
            },
            {
                label: 'Edit',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    { role: 'selectAll' },
                ],
            },
            {
                label: 'View',
                submenu: [
                    { role: 'reload' },
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                    command('commandPalette.open', 'Command Palette…'),
                ],
            },
            {
                label: 'Window',
                submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
            },
            {
                label: 'Help',
                submenu: [
                    {
                        id: 'command.processExplorer.open',
                        label: getCommandDefinition('processExplorer.open').title,
                        click: () => processExplorer.open(),
                    },
                    { type: 'separator' },
                    command('diagnostics.export'),
                ],
            },
        ]),
    );
}

void app.whenReady().then(async () => {
    const userDataPath = app.getPath('userData');
    const logDirectory = resolveLogDirectory({
        currentDirectory,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        userDataPath,
    });
    const logLevel = resolveLogLevel({ isPackaged: app.isPackaged });
    mainLogger = new StructuredLogger(logDirectory, 'main', logLevel);
    mainLogger.write('info', 'app.ready', { durationMs: performance.now() - bootStartedAt });
    supervisor = new RuntimeSupervisor(
        currentDirectory,
        userDataPath,
        logDirectory,
        mainLogger,
        logLevel,
    );
    processExplorer = new ProcessExplorerWindowController({
        currentDirectory,
        logger: mainLogger,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        sampler: new ProcessExplorerSampler({
            rootPid: process.pid,
            runtimePid: () => supervisor.processId(),
            electronProcesses: () =>
                app.getAppMetrics().map((metric) => ({
                    pid: metric.pid,
                    type: metric.type,
                    name: metric.name,
                    serviceName: metric.serviceName,
                    cpuPercent: metric.cpu.percentCPUUsage,
                    memoryMb: Math.round((metric.memory.workingSetSize / 1024) * 10) / 10,
                })),
        }),
        theme: () => supervisor.request('theme.get').then((result) => result.value),
    });
    supervisor.on('event', sendEvent);
    const runtimeStartedAt = performance.now();
    await supervisor
        .start()
        .then(() =>
            mainLogger?.write('info', 'runtime.attached', {
                durationMs: performance.now() - runtimeStartedAt,
            }),
        )
        .catch((error: unknown) =>
            mainLogger?.write('error', 'runtime.attach_failed', {
                durationMs: performance.now() - runtimeStartedAt,
                fields: { error: error instanceof Error ? error.message : 'unknown' },
            }),
        );
    installIpc();
    processExplorer.installIpc();
    await installMenu();
    await openMainWindow();
});

app.on('activate', () => {
    if (!mainWindow) void openMainWindow();
});

app.on('window-all-closed', () => {
    // macOS keeps the application and Runtime alive so Keep Running has real semantics.
});

app.on('before-quit', (event) => {
    if (quitStarted) return;
    event.preventDefault();
    quitStarted = true;
    mainLogger?.write('info', 'app.quit_requested');
    void (async () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            await supervisor
                .request('app.windowState.update', readWindowState(mainWindow))
                .catch(() => undefined);
        }
        await supervisor.shutdown();
    })()
        .catch(() => undefined)
        .finally(() => app.exit(0));
});
