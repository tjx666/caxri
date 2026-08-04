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
import {
    requestEnvelopeSchema,
    requestSchemas,
    type CaxriMethod,
    type RuntimeEvent,
} from '../shared/contracts';
import type { Keybinding, PersistedWindowState } from '../shared/types';
import { StructuredLogger } from '../runtime/logger';
import { resolveLogDirectory } from './log-path';
import { RuntimeSupervisor } from './supervisor';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
if (process.env.CAXRI_USER_DATA_DIR) app.setPath('userData', process.env.CAXRI_USER_DATA_DIR);
let mainWindow: BrowserWindow | undefined;
let supervisor: RuntimeSupervisor;
let mainLogger: StructuredLogger | undefined;
let forceWindowClose = false;
let quitStarted = false;
const grantedRoots = new Set<string>();

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
        backgroundColor: '#282a36',
        show: false,
        webPreferences: {
            preload: join(currentDirectory, '../preload/index.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    let persistTimer: NodeJS.Timeout | undefined;
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
    window.webContents.on('render-process-gone', (_event, details) => {
        if (details.reason !== 'clean-exit' && !window.isDestroyed())
            setTimeout(() => window.reload(), 250);
    });
    window.on('close', (event) => {
        if (forceWindowClose || quitStarted) return;
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = undefined;
        persistWindowState();
        event.preventDefault();
        void (async () => {
            const count = await supervisor.request<number>('terminal.runningCount', {});
            if (count === 0) {
                forceWindowClose = true;
                window.close();
                forceWindowClose = false;
                return;
            }
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
            if (result.response === 2) return;
            if (result.response === 1) await supervisor.request('terminal.terminateAll', {});
            forceWindowClose = true;
            window.close();
            forceWindowClose = false;
        })();
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
        .request<PersistedWindowState>('app.windowState.get', {})
        .catch(() => ({
            bounds: { width: 1440, height: 900 },
            isMaximized: false,
            isFullScreen: false,
        }));
    mainWindow = createWindow(initialState);
}

function assertSender(event: IpcMainInvokeEvent): void {
    if (!mainWindow || event.sender !== mainWindow.webContents)
        throw new Error('Untrusted IPC sender');
}

async function handleMainMethod(
    method: CaxriMethod,
    params: Record<string, unknown>,
): Promise<unknown> {
    switch (method) {
        case 'dialog.selectDirectory': {
            if (process.env.CAXRI_TEST_ROOT_PATH) {
                /** Deterministic native-dialog seam for real Electron E2E; never active in production launches. */
                grantedRoots.add(process.env.CAXRI_TEST_ROOT_PATH);
                return process.env.CAXRI_TEST_ROOT_PATH;
            }
            const result = await dialog.showOpenDialog(mainWindow!, {
                title: 'Choose a Session directory',
                properties: ['openDirectory', 'createDirectory'],
            });
            const path = result.filePaths[0];
            if (!result.canceled && path) grantedRoots.add(path);
            return result.canceled ? null : path;
        }
        case 'session.create':
            if (!grantedRoots.has(params.rootPath as string))
                throw new Error('Session root was not selected by the user');
            return supervisor.request(method, params);
        case 'session.delete': {
            const count = await supervisor.request<number>('terminal.runningCount', {
                sessionId: params.sessionId,
            });
            const result = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                title: 'Delete Session',
                message:
                    count > 0
                        ? `Delete this Session and terminate ${count} running Terminal${count === 1 ? '' : 's'}?`
                        : 'Delete this Session?',
                detail: 'Only Caxri metadata and snapshots are removed. The selected directory and its files are never deleted.',
                buttons: ['Delete Session', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            });
            if (result.response !== 0) return { canceled: true };
            return supervisor.request(method, params);
        }
        case 'theme.import': {
            const result = await dialog.showOpenDialog(mainWindow!, {
                title: 'Import Theme',
                properties: ['openFile'],
                filters: [
                    {
                        name: 'Theme files',
                        extensions: ['json', 'jsonc', 'itermcolors', 'yaml', 'yml'],
                    },
                ],
            });
            const path = result.filePaths[0];
            return result.canceled || !path
                ? null
                : supervisor.request('theme.importPath', { path });
        }
        case 'app.openConfigFile': {
            const paths = await supervisor.request<Record<string, string>>('config.paths', {});
            const path = paths[params.kind as string];
            if (!path) throw new Error('Unknown configuration file');
            const error = await shell.openPath(path);
            if (error) throw new Error(error);
            return null;
        }
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
        default:
            return supervisor.request(method, params);
    }
}

function installIpc(): void {
    ipcMain.handle('caxri:request', async (event, raw: unknown) => {
        assertSender(event);
        const request = requestEnvelopeSchema.parse(raw);
        const schema = requestSchemas[request.method];
        const params = schema.parse(request.params) as Record<string, unknown>;
        return handleMainMethod(request.method, params);
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
        .request<{ value: Keybinding[] }>('keybindings.get', {})
        .then((result) => result.value)
        .catch(() => []);
    const accelerator = (id: string): string | undefined =>
        electronAccelerator(keybindings.find((binding) => binding.command === id)?.key);
    const command = (id: string, label?: string) => ({
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
                    command('theme.openSettings', 'Settings…'),
                    { type: 'separator' },
                    { role: 'quit' },
                ],
            },
            {
                label: 'Session',
                submenu: [
                    command('session.create', 'New Session…'),
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
    mainLogger = new StructuredLogger(logDirectory, 'main');
    mainLogger.write('info', 'app.ready', { durationMs: performance.now() - bootStartedAt });
    supervisor = new RuntimeSupervisor(currentDirectory, userDataPath, logDirectory);
    supervisor.on('event', sendEvent);
    const runtimeStartedAt = performance.now();
    await supervisor.start();
    mainLogger.write('info', 'runtime.attached', {
        durationMs: performance.now() - runtimeStartedAt,
    });
    installIpc();
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
