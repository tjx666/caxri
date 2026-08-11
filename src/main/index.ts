import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    shell,
    type IpcMainInvokeEvent,
} from 'electron';

import { agentProviderCatalog } from '../shared/agents';
import { CaxriError, errorMessage, toWireError } from '../shared/ipc/errors';
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
import { resolveDevelopmentDockIconPath } from './app-icon';
import { decideCrashRecovery } from './crash-policy';
import { resolveLogLevel } from './log-level';
import { resolveLogDirectory } from './log-path';
import { buildApplicationMenuTemplate } from './menu';
import { kilobytesToMegabytes, ProcessExplorerSampler } from './process-explorer';
import { ProcessExplorerWindowController } from './process-explorer-window';
import { ProjectRootGrants } from './root-grants';
import { RuntimeSupervisor } from './supervisor';
import { createTestRootPathResolver } from './test-root';
import { UpdateService } from './updates';
import { resolveE2EWindowMode } from './window-mode';
import { createWindowCloseHandler } from './window-close';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Stamps these once at module load, before any logger or the Runtime supervisor is constructed, so
 * every log record and the forked Runtime's environment can be correlated to this build. See
 * src/main/global.d.ts and electron.vite.config.ts for where the constants come from.
 */
const caxriVersion = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
process.env.CAXRI_APP_VERSION = caxriVersion;
process.env.CAXRI_GIT_COMMIT = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
/**
 * Work around macOS deriving the native application-menu name from Electron's development process
 * title. `app.setName()` only changes Electron's internal name, so keep this unsupported behavior
 * limited to unpackaged macOS launches until Electron exposes a development-host naming API.
 * @see https://www.electronjs.org/docs/latest/api/app#appsetnamename
 */
if (process.platform === 'darwin' && !app.isPackaged) process.title = 'Caxri Dev';
if (process.env.CAXRI_USER_DATA_DIR) app.setPath('userData', process.env.CAXRI_USER_DATA_DIR);
let mainWindow: BrowserWindow | undefined;
let supervisor: RuntimeSupervisor;
let mainLogger: StructuredLogger | undefined;
let processExplorer: ProcessExplorerWindowController;
let updateService: UpdateService;
let forceWindowClose = false;
let quitStarted = false;
let automaticUpdateCheckStarted = false;
const grantedRoots = new ProjectRootGrants();
const resolveNextTestRootPath = createTestRootPathResolver({ isPackaged: app.isPackaged });
const e2eWindowMode = resolveE2EWindowMode({
    isE2E: process.env.CAXRI_E2E === '1',
    requestedMode: process.env.CAXRI_E2E_WINDOW_MODE,
});

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
        /** Centers the 12px macOS traffic lights in the Renderer's 44px drag header. */
        trafficLightPosition: { x: 15, y: 15 },
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
    const sendFullScreenState = (): void => {
        window.webContents.send('caxri:event', {
            event: 'window.fullScreen',
            payload: { isFullScreen: window.isFullScreen() },
        });
    };
    window.on('enter-full-screen', () => {
        scheduleWindowState();
        sendFullScreenState();
    });
    window.on('leave-full-screen', () => {
        scheduleWindowState();
        sendFullScreenState();
    });
    if (initialState.isMaximized) window.maximize();
    /**
     * `setFullScreen(true)` here fires `enter-full-screen` synchronously, before `mainWindow` is
     * assigned by the caller (it's only set once `createWindow` returns), so the module-level
     * `sendEvent`/`mainWindow` path can't be used for this push. `did-finish-load` covers the
     * matching case where the Renderer loads (or reloads/crash-recovers) while already fullscreen,
     * so it observes the current state instead of missing the one-shot restore event above.
     */
    if (initialState.isFullScreen) window.setFullScreen(true);
    mainLogger?.write('info', 'window.created');

    window.webContents.on('did-finish-load', sendFullScreenState);

    window.once('ready-to-show', () => {
        mainLogger?.write('info', 'window.ready_to_show', {
            durationMs: performance.now() - bootStartedAt,
        });
        if (e2eWindowMode === 'visible') window.show();
        if (app.isPackaged && !automaticUpdateCheckStarted) {
            automaticUpdateCheckStarted = true;
            /** Update discovery stays off the awaited startup path and never delays the first window. */
            void updateService.check();
        }
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
            const testRoot = resolveNextTestRootPath();
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
        case 'files.reveal': {
            const item = await supervisor.request('files.authorizeOpen', request.params);
            shell.showItemInFolder(item.path);
            return null;
        }
        case 'files.trash': {
            const item = await supervisor.request('files.authorizeTrash', request.params);
            const result = await dialog.showMessageBox(mainWindow!, {
                type: 'warning',
                title: 'Move to Trash',
                message: `Move '${item.name}' to the Trash?`,
                detail: `${item.path}\n\nYou can recover this item from the Trash.`,
                buttons: ['Move to Trash', 'Cancel'],
                defaultId: 1,
                cancelId: 1,
            });
            if (result.response !== 0) return { canceled: true };
            /** Reauthorize after the native dialog so a replaced path cannot inherit approval. */
            const current = await supervisor.request('files.authorizeTrash', request.params);
            if (
                current.path !== item.path ||
                current.device !== item.device ||
                current.inode !== item.inode ||
                current.root.path !== item.root.path ||
                current.root.device !== item.root.device ||
                current.root.inode !== item.root.inode
            )
                throw new CaxriError('CONFLICT', 'File or folder changed before it reached Trash');
            /** Electron's Trash API is path-based, so authorization is repeated immediately before it. */
            await shell.trashItem(current.path);
            return item;
        }
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
                title: 'Remove Session',
                message:
                    count > 0
                        ? `Remove '${sessionTitle}' and terminate ${count} running Terminal${count === 1 ? '' : 's'}?`
                        : `Remove '${sessionTitle}'?`,
                detail: 'Only Caxri metadata and snapshots are removed. The selected directory and its files are never deleted.',
                buttons: ['Remove Session', 'Cancel'],
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
        case 'bugReport.send': {
            const { report, screenshot, sessionId, terminalId } = request.params;
            const records = await supervisor.request('app.records', {
                sessionIds: [],
                terminalIds: [terminalId],
            });
            const terminal = records.terminals[0];
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
            if (terminal.lastProcessState !== 'running' || terminal.processId === undefined)
                throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
            const imageInput = agentProviderCatalog[terminal.provider].imageInput;
            const pasteImage = Boolean(screenshot && imageInput);
            if (pasteImage && screenshot) {
                const image = nativeImage.createFromDataURL(screenshot.dataUrl);
                if (image.isEmpty())
                    throw new CaxriError('VALIDATION', 'Captured screenshot is not a valid image');
                /** The user explicitly opted into screenshot delivery. Codex's supported image
                 *  input reads the macOS clipboard, so disclose this replacement before Send. */
                clipboard.writeImage(image);
            }
            return supervisor.request('bugReport.deliver', {
                pasteImage,
                report,
                sessionId,
                terminalId,
            });
        }
        case 'bugReport.captureScreenshot': {
            if (!mainWindow || mainWindow.isDestroyed())
                throw new CaxriError('UNAVAILABLE', 'The Caxri window is not available');
            const image = await mainWindow.webContents.capturePage();
            const { height, width } = image.getSize();
            return {
                dataUrl: `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`,
                height,
                width,
            };
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
        case 'updates.getState':
            return updateService.getState();
        case 'updates.check':
            return updateService.check();
        case 'updates.download':
            return updateService.download();
        case 'updates.cancel':
            return updateService.cancel();
        case 'updates.open':
            return updateService.open();
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

async function installMenu(): Promise<void> {
    const keybindings = await supervisor
        .request('keybindings.get')
        .then((result) => result.value)
        .catch(() => []);
    Menu.setApplicationMenu(
        Menu.buildFromTemplate(
            buildApplicationMenuTemplate({
                keybindings,
                dispatchCommand: (command, viaAccelerator) =>
                    sendEvent({
                        event: 'command.execute',
                        payload: { command, viaAccelerator },
                    }),
                openProcessExplorer: () => processExplorer.open(),
            }),
        ),
    );
}

void app.whenReady().then(async () => {
    const developmentDockIconPath = resolveDevelopmentDockIconPath({
        currentDirectory,
        isPackaged: app.isPackaged,
    });
    if (developmentDockIconPath && app.dock) app.dock.setIcon(developmentDockIconPath);
    const userDataPath = app.getPath('userData');
    const logDirectory = resolveLogDirectory({
        currentDirectory,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        userDataPath,
    });
    const logLevel = resolveLogLevel({ isPackaged: app.isPackaged });
    mainLogger = new StructuredLogger(logDirectory, 'main', logLevel);
    mainLogger.write('info', 'app.ready', { durationMs: performance.now() - bootStartedAt });
    if (process.env.CAXRI_E2E === '1') {
        mainLogger.write('info', 'e2e.launch', { fields: { windowMode: e2eWindowMode } });
    }
    updateService = new UpdateService({
        currentVersion: caxriVersion,
        downloadDirectory: join(userDataPath, 'updates'),
        enabled: app.isPackaged,
        openPath: (path) => shell.openPath(path),
        onState: (state) => {
            if (state.status !== 'downloading')
                mainLogger?.write(state.status === 'error' ? 'error' : 'info', 'updates.state', {
                    fields: {
                        status: state.status,
                        ...('version' in state ? { version: state.version ?? null } : {}),
                    },
                });
            sendEvent({ event: 'updates.state', payload: state });
        },
    });
    supervisor = new RuntimeSupervisor(
        currentDirectory,
        userDataPath,
        logDirectory,
        mainLogger,
        logLevel,
        process.env.CAXRI_E2E === '1'
            ? undefined
            : join(app.getPath('appData'), 'caxri', 'agent-hooks'),
    );
    processExplorer = new ProcessExplorerWindowController({
        currentDirectory,
        forceRenderError:
            process.env.CAXRI_E2E === '1' &&
            process.env.CAXRI_TEST_PROCESS_EXPLORER_RENDER_ERROR === '1',
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
                    memoryMb: kilobytesToMegabytes(metric.memory.workingSetSize),
                })),
        }),
        theme: () => supervisor.request('theme.get').then((result) => result.value),
        windowMode: e2eWindowMode,
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
                fields: { error: errorMessage(error, 'unknown') },
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
