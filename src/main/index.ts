import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    Menu,
    nativeImage,
    shell,
    type WebContents,
} from 'electron';

import { agentProviderCatalog } from '../shared/agents';
import type { CommandAdapter } from '../shared/ipc/dispatcher';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import { isMainRequest, type CaxriRequest, type MainRequest } from '../shared/ipc/methods';
import { readE2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
import { themeImportExtensions } from '../shared/theme-import';
import type { PersistedWindowState } from '../shared/types';
import { resolveDevelopmentDockIconPath } from './app-icon';
import { createElectronIpcCommandAdapter } from './ipc-command-adapter';
import {
    deleteProjectPrompt,
    deleteSessionPrompt,
    externalLinkChoice,
    externalLinkPrompt,
    trashPrompt,
    unsavedChangesChoice,
    unsavedChangesPrompt,
} from './confirmations';
import { decideCrashRecovery } from './crash-policy';
import { createDesktopOperationHandler } from './desktop-operations';
import { openExternalUrl } from './external-links';
import { createMainEventRelay } from './event-relay';
import { DesktopHostConnection, resolveDesktopLaunch } from './host-connection';
import { resolveLogLevel } from './log-level';
import { resolveLogDirectory } from './log-path';
import { buildApplicationMenuTemplate } from './menu';
import { kilobytesToMegabytes, ProcessExplorerSampler } from './process-explorer';
import { ProcessExplorerWindowController } from './process-explorer-window';
import { loadRendererEntry } from './renderer-entry';
import { ProjectRootGrants } from './root-grants';
import { RendererReadiness } from './renderer-readiness';
import { createTestRootPathResolver } from './test-root';
import { shouldStartAutomaticUpdateCheck, UpdateService } from './updates';
import { resolveE2EWindowMode } from './window-mode';
import { createWindowCloseHandler } from './window-close';
import { createWorkbenchRootAuthority } from './workbench-root-authority';
import { installWorkbenchIpc } from './workbench-ipc';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Stamps these before logging so Host and Desktop records correlate to this build; see
 * `global.d.ts` and `electron.vite.config.ts` for the injected constants.
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
let mainRenderer: WebContents | undefined;
let supervisor: DesktopHostConnection;
let mainLogger: StructuredLogger | undefined;
const processErrorMonitor = installProcessErrorMonitor({
    bootstrapWriter: () => (mainLogger ??= createMainLogger()),
    processName: 'main',
});
let processExplorer: ProcessExplorerWindowController;
let updateService: UpdateService;
let forceWindowClose = false;
let quitStarted = false;
let automaticUpdateCheckStarted = false;
const grantedRoots = new ProjectRootGrants();
const rendererReadiness = new RendererReadiness();
const resolveNextTestRootPath = createTestRootPathResolver({ isPackaged: app.isPackaged });
const workbenchRootAuthority = createWorkbenchRootAuthority({
    getHost: () => supervisor,
    getWindow: () => mainWindow,
    grants: grantedRoots,
    nextTestRoot: resolveNextTestRootPath,
});
const e2eWindowMode = resolveE2EWindowMode({
    isE2E: process.env.CAXRI_E2E === '1',
    requestedMode: process.env.CAXRI_E2E_WINDOW_MODE,
});
const e2eAgentPolicy = readE2EAgentPolicy();
const eventRelay = createMainEventRelay({
    deliver: (message) => {
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('caxri:event', message);
    },
    loadState: () => supervisor.request('app.bootstrap'),
    logger: () => mainLogger,
    onKeybindingsChanged: () => void installMenu(),
});
function createMainLogger(): StructuredLogger {
    return new StructuredLogger(
        resolveLogDirectory({
            currentDirectory,
            rendererUrl: process.env.ELECTRON_RENDERER_URL,
            userDataPath: app.getPath('userData'),
        }),
        'main',
        resolveLogLevel({ isPackaged: app.isPackaged }),
    );
}
function sendEvent(event: RuntimeEvent): void {
    eventRelay.send(event);
}
async function handleExternalUrl(
    url: string,
    options: { allowTrust: boolean; window?: BrowserWindow },
) {
    return openExternalUrl(
        url,
        {
            getTrustedDomains: async () =>
                (await supervisor.request('settings.get')).value['security.trustedDomains'],
            prompt: async (parsed) => {
                const messageBoxOptions = externalLinkPrompt(parsed, options.allowTrust);
                const result = options.window
                    ? await dialog.showMessageBox(options.window, messageBoxOptions)
                    : await dialog.showMessageBox(messageBoxOptions);
                return externalLinkChoice(result.response, options.allowTrust);
            },
            trust: async (domain) => {
                await supervisor.request('settings.trustDomain', { domain });
            },
            open: (target) => shell.openExternal(target),
        },
        { allowTrust: options.allowTrust },
    );
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
    rendererReadiness.track(window.webContents);
    let persistTimer: NodeJS.Timeout | undefined;
    let rendererCrashTimestampsMs: number[] = [];
    const persistWindowState = (): void => {
        /** `before-quit` performs the final ordered write before Runtime shutdown. */
        if (quitStarted || window.isDestroyed()) return;
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
        sendEvent({
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
        if (
            shouldStartAutomaticUpdateCheck({
                alreadyStarted: automaticUpdateCheckStarted,
                isE2E: process.env.CAXRI_E2E === '1',
                isPackaged: app.isPackaged,
            })
        ) {
            automaticUpdateCheckStarted = true;
            /** Update discovery stays off the awaited startup path and never delays the first window. */
            void updateService.check();
        }
    });
    /** Passive page content never inherits authority from an explicitly trusted Terminal link. */
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
        const currentUrl = window.webContents.getURL();
        if (url === currentUrl) return;
        event.preventDefault();
    });
    /** Renderer console errors are otherwise invisible in logs; mirror them so triage can see UI faults. */
    window.webContents.on('console-message', (details) => {
        if (details.level !== 'error') return;
        mainLogger?.write('error', 'renderer.console_error', {
            fields: { code: 'CONSOLE_ERROR' },
        });
    });
    window.webContents.on('preload-error', () => {
        mainLogger?.write('error', 'renderer.preload_error', {
            fields: { code: 'PRELOAD_ERROR' },
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
                    code: 'RENDER_PROCESS_GONE',
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
            fields: {
                code: 'RENDER_PROCESS_CRASH_LOOP',
                reason: details.reason,
                crashCount: decision.crashCount,
            },
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
                detail: 'Keeping them running leaves the Caxri Host active without a window. Quit Desktop disconnects the window but does not stop the Host.',
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
        /** Explicit quit can close the window before its already-queued IPC reaches Main. Retain
         * the trusted sender identity until process exit without reading the destroyed window. */
        if (mainWindow === window && !quitStarted) {
            mainWindow = undefined;
            mainRenderer = undefined;
        }
        mainLogger?.write('info', 'window.closed');
    });
    loadRendererEntry(window, {
        currentDirectory,
        isPackaged: app.isPackaged,
        page: 'index.html',
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
    });
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
    mainRenderer = mainWindow.webContents;
}

async function focusMainWindow(): Promise<BrowserWindow> {
    await openMainWindow();
    const window = mainWindow!;
    await rendererReadiness.wait(window.webContents);
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    window.focus();
    return window;
}

const handleHostDesktopOperation = createDesktopOperationHandler({
    focus: async () => void (await focusMainWindow()),
    open: (target) =>
        sendEvent({
            event: 'desktop.openRequested',
            payload: {
                sessionId: target.sessionId,
                kind: target.kind,
                ...(target.kind === 'file' ? { path: target.path } : {}),
            },
        }),
    reveal: (path) => shell.showItemInFolder(path),
    status: () => (mainWindow && !mainWindow.isDestroyed() ? 'window' : 'background'),
});

function assertNever(value: never): never {
    throw new CaxriError('INTERNAL', `Unhandled Main request: ${String(value)}`);
}

async function handleMainMethod(request: MainRequest): Promise<unknown> {
    switch (request.method) {
        case 'external.open':
            return handleExternalUrl(request.params.url, { allowTrust: true, window: mainWindow });
        case 'dialog.selectDirectory':
            return workbenchRootAuthority.selectProjectDirectory();
        case 'session.continueInWorktree':
            return workbenchRootAuthority.continueInWorktree(request.params);
        case 'session.authorizeWorkbenchRoot':
            return workbenchRootAuthority.authorizeSelection(request.params);
        case 'project.create':
            return workbenchRootAuthority.createProject(request.params);
        case 'project.cancelCreate':
            return workbenchRootAuthority.cancelProjectCreate(request.params);
        case 'files.trash': {
            const item = await supervisor.request('files.authorizeTrash', request.params);
            const result = await dialog.showMessageBox(
                mainWindow!,
                trashPrompt({ ...item, hasUnsavedChanges: request.params.hasUnsavedChanges }),
            );
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
            const result = await dialog.showMessageBox(
                mainWindow!,
                deleteProjectPrompt(projectTitle, count),
            );
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
            const result = await dialog.showMessageBox(
                mainWindow!,
                deleteSessionPrompt(sessionTitle, count),
            );
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
        case 'editor.confirmDiscard': {
            const result = await dialog.showMessageBox(
                mainWindow!,
                unsavedChangesPrompt(request.params.name),
            );
            return { choice: unsavedChangesChoice(result.response) };
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

function installIpc(): void {
    const dispatchCommand = createElectronIpcCommandAdapter({
        host: {
            invoke: (request, _context, invocation) =>
                request.method === 'events.recover'
                    ? eventRelay.recover(request.params.afterCursor)
                    : supervisor.forward(request.method, request.params, invocation.requestId),
        },
        desktop: {
            isAvailable: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
            invoke: ((request: CaxriRequest) => {
                if (!isMainRequest(request))
                    throw new CaxriError('INTERNAL', 'Host command reached the Desktop adapter');
                return handleMainMethod(request);
            }) satisfies CommandAdapter['invoke'],
        },
    });
    installWorkbenchIpc({
        isQuitting: () => quitStarted,
        logger: () => mainLogger,
        onEventsReady: () => {
            if (mainRenderer) rendererReadiness.ready(mainRenderer);
            void supervisor.markDesktopReady().catch((error: unknown) =>
                mainLogger?.write('error', 'host.desktop_ready_failed', {
                    fields: { error: errorMessage(error, 'unknown') },
                }),
            );
        },
        renderer: () => mainRenderer,
        transport: dispatchCommand,
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
    mainLogger ??= new StructuredLogger(logDirectory, 'main', logLevel);
    processErrorMonitor.attach(mainLogger);
    mainLogger.write('info', 'app.ready', { durationMs: performance.now() - bootStartedAt });
    if (process.env.CAXRI_E2E === '1') {
        mainLogger.write('info', 'e2e.launch', {
            fields: {
                agentMode: e2eAgentPolicy?.mode ?? 'blocked',
                agentProvider:
                    e2eAgentPolicy?.mode === 'real'
                        ? e2eAgentPolicy.provider
                        : e2eAgentPolicy?.mode === 'fake'
                          ? Object.keys(e2eAgentPolicy.executables).sort().join(',')
                          : null,
                windowMode: e2eWindowMode,
            },
        });
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
    supervisor = new DesktopHostConnection({
        agentHooksPath:
            process.env.CAXRI_E2E === '1'
                ? process.env.CAXRI_E2E_AGENT_HOOKS === '1'
                    ? join(userDataPath, 'agent-hooks')
                    : undefined
                : join(app.getPath('appData'), 'caxri', 'agent-hooks'),
        currentDirectory,
        cliPath: app.isPackaged
            ? join(process.resourcesPath, 'cli', 'caxri.cjs')
            : resolve(currentDirectory, '../../packages/cli/dist/caxri.cjs'),
        desktopId: randomUUID(),
        desktopLaunch: resolveDesktopLaunch({
            currentDirectory,
            executable: process.execPath,
            isPackaged: app.isPackaged,
        }),
        e2eAgentPolicy,
        handleCommand: handleHostDesktopOperation,
        logger: mainLogger,
        userDataPath,
    });
    processExplorer = new ProcessExplorerWindowController({
        currentDirectory,
        forceRenderError:
            process.env.CAXRI_E2E === '1' &&
            process.env.CAXRI_TEST_PROCESS_EXPLORER_RENDER_ERROR === '1',
        logger: mainLogger,
        isPackaged: app.isPackaged,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        sampler: new ProcessExplorerSampler({
            rootPid: process.pid,
            hostPid: () => supervisor.hostProcessId(),
            runtimePid: () => supervisor.processId(),
            /**
             * Resolved lazily at sample time: the diagnostics window is created on demand, so its
             * renderer process does not exist yet while this controller is being constructed.
             */
            rendererRoles: () => {
                const roles = new Map<number, string>();
                const workbenchPid =
                    mainWindow && !mainWindow.isDestroyed()
                        ? mainWindow.webContents.getOSProcessId()
                        : undefined;
                if (workbenchPid !== undefined) roles.set(workbenchPid, 'workbench');
                const explorerPid = processExplorer?.processId();
                if (explorerPid !== undefined) roles.set(explorerPid, 'process explorer');
                return roles;
            },
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
            mainLogger?.write('info', 'host.attached', {
                durationMs: performance.now() - runtimeStartedAt,
            }),
        )
        .catch((error: unknown) =>
            mainLogger?.write('error', 'host.attach_failed', {
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
    void supervisor.request('session.validateWorkbenchRoots').catch(() => undefined);
});

app.on('browser-window-focus', () => {
    void supervisor.request('session.validateWorkbenchRoots').catch(() => undefined);
});

app.on('window-all-closed', () => {
    // macOS keeps the Desktop client alive; the Host-owned Runtime survives either way.
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
        await supervisor.request('terminal.detachAll').catch(() => undefined);
        await supervisor.shutdown();
    })()
        .catch(() => undefined)
        .finally(() => app.exit(0));
});
