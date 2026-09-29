import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type {
    CaxriRequest,
    CommandAdapter,
    CommandId,
    Keybinding,
    PersistedWindowState,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError, errorMessage, isMainRequest } from '@caxri/protocol';
import type { EventLoopMonitor } from '@caxri/system';
import {
    installProcessErrorMonitor,
    logEventCatalog,
    readE2EAgentPolicy,
    startEventLoopMonitor,
} from '@caxri/system';
import type { WebContents } from 'electron';
import { app, BrowserWindow, dialog, Menu, powerMonitor, shell } from 'electron';

import { isBenignRendererErrorMessage } from '../shared/renderer-error-policy';
import { shouldEnableAcceptanceAccessibility } from './acceptance-accessibility';
import { createAcceptanceUpdateFixture } from './acceptance-update';
import type { AgentCommanderWindowController } from './agent-commander-window';
import { resolveDevelopmentDockIconPath } from './app-icon';
import type { AppQuitIntent } from './app-quit';
import {
    confirmAppQuit,
    createAppQuitHandler,
    createReviewCommentsQuitOptions,
    notifyAppQuitStopFailure,
} from './app-quit';
import { updateArgvConfig } from './argv-config';
import {
    persistAllWindowState,
    reopenAuxiliaryWindowsAtStartup,
} from './auxiliary-window-lifecycle';
import { consoleErrorLogFields } from './console-error-fields';
import { createDesktopActions } from './desktop-actions';
import { createDesktopLogger } from './desktop-logger';
import type { DesktopNotifications } from './desktop-notifications';
import { createDesktopNotifications } from './desktop-notifications';
import { createDesktopOperationHandler } from './desktop-operations';
import {
    configureDesktopProfile,
    hasProfileSingleInstanceLock,
    installSecondInstanceFocus,
    remoteDebuggingState,
} from './desktop-profile';
import { e2eLaunchLogFields } from './e2e-launch';
import { createMainEventRelay } from './event-relay';
import { createGpuDiagnostics } from './gpu-diagnostics';
import { createGpuRecoveryCoordinator, prepareGpuBoot } from './gpu-recovery';
import { createElectronIpcCommandAdapter } from './ipc-command-adapter';
import { createMainMethodHandler } from './main-methods';
import { buildAppMenuTemplate } from './menu';
import { createMenuKeybindingFailureInjection } from './menu-keybinding-failure';
import { createMenuRefreshController } from './menu-refresh';
import { createOnDemandWindows } from './on-demand-windows';
import type { ProcessExplorerWindowController } from './process-explorer-window';
import { observeRendererCrashes } from './renderer-crash-recovery';
import { loadRendererEntry } from './renderer-entry';
import { observeRendererHangs } from './renderer-hang-observer';
import { RendererReadiness } from './renderer-readiness';
import { ProjectRootGrants } from './root-grants';
import { DesktopServerConnection, resolveDesktopLaunch, wirePowerWake } from './server-connection';
import { shouldContinueStartup } from './server-startup';
import { StartupProfile } from './startup-profile';
import { createTestRootPathResolver } from './test-root';
import { UpdateService, updateStateLogFields } from './updates';
import {
    createWindowZoomController,
    mainWindowChromeOptions,
    zoomFactorForLevel,
} from './window-chrome';
import { createWindowCloseHandler } from './window-close';
import { resolveE2EWindowMode } from './window-mode';
import type { WindowPlacement } from './window-placement';
import { defaultWindowState, showWhenPlaced } from './window-placement';
import { installWorkbenchIpc } from './workbench-ipc';
import { createWorkbenchRootAuthority } from './workbench-root-authority';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Stamps these before logging so Server and Desktop records correlate to this build; see `global.d.ts` and
 * `electron.vite.config.ts` for the injected constants.
 */
const caxriVersion = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
process.env.CAXRI_APP_VERSION = caxriVersion;
process.env.CAXRI_GIT_COMMIT = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
/**
 * Electron derives automatic native role labels such as `About` and `Hide` from `app.name`, while macOS derives the
 * unpackaged process identity from `process.title`. Configure both so development menus expose product names instead of
 * the workspace package name without making the dev process indistinguishable from the packaged app.
 *
 * @see https://www.electronjs.org/docs/latest/api/app#appsetnamename
 */
if (process.platform === 'darwin' && !app.isPackaged) {
    app.setName('Caxri Desktop');
    process.title = 'Caxri Dev';
}
// Must settle before Chromium, logging, Server attachment, or the single-instance lock captures launch identity.
const desktopProfile = configureDesktopProfile(app, process.env);
const gpuBoot = prepareGpuBoot(app, desktopProfile.userDataPath);
const ownsProfileInstance = hasProfileSingleInstanceLock(app, desktopProfile);
if (!ownsProfileInstance) app.quit();

// Scoped in a bare block (rather than left at module top level) so the mutable Desktop bootstrap
// state below is a block-scoped variable, not a Program-scope one: the lifecycle callbacks that
// mutate it genuinely need module-lifetime shared state, and this keeps each variable's storage
// out of `unicorn/no-top-level-assignment-in-function`'s reach without changing any read/write site.
if (ownsProfileInstance) {
    let mainWindow: BrowserWindow | undefined;
    let mainRenderer: WebContents | undefined;
    let supervisor: DesktopServerConnection;
    let mainLogger: ReturnType<typeof createDesktopLogger> | undefined;
    /**
     * Resolves once Server Core is attached and Main's Server-backed services exist. The Workbench window is created
     * before that, so every Renderer request and the events handshake wait on it instead of failing `UNAVAILABLE`.
     */
    const serverReady = Promise.withResolvers<void>();
    const startupProfile = new StartupProfile(performance.timeOrigin, () => mainLogger);
    startupProfile.mark('mainModule', bootStartedAt);
    /**
     * Main is the process the Renderer cannot observe from the inside. Creating a Worker, loading its script out of
     * `app.asar`, and brokering a `BroadcastChannel` all traverse the browser process, so a blocked Main loop looks
     * from the Renderer like a Worker that exists and never runs — the exact shape of issue #962, which was diagnosable
     * only as "something outside the Renderer" because no main-thread metric existed. Server Core has had this monitor
     * since its own freeze investigation; Main never did.
     */
    let eventLoopMonitor: EventLoopMonitor | undefined;
    const createMainLogger = () => createDesktopLogger(desktopProfile.logDirectory);
    const gpuDiagnostics = createGpuDiagnostics({
        app,
        logger: () => mainLogger,
        window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
    });
    const processErrorMonitor = installProcessErrorMonitor({
        bootstrapWriter: () => (mainLogger ??= createMainLogger()),
        processName: 'desktop',
    });
    let processExplorer: ProcessExplorerWindowController;
    let agentCommander: AgentCommanderWindowController | undefined;
    let updateService: UpdateService;
    let notifications: DesktopNotifications | undefined;
    let isForceWindowClose = false;
    let isQuitStarted = false;
    let quitIntent: AppQuitIntent = 'user';
    const grantedRoots = new ProjectRootGrants();
    const rendererReadiness = new RendererReadiness();
    const resolveNextTestRootPath = createTestRootPathResolver({ isPackaged: app.isPackaged });
    const workbenchRootAuthority = createWorkbenchRootAuthority({
        getServer: () => supervisor,
        getWindow: () => mainWindow,
        grants: grantedRoots,
        logger: () => mainLogger,
        nextTestRoot: resolveNextTestRootPath,
        focusWindow: async () => {
            await focusMainWindow();
        },
    });
    const e2eWindowMode = resolveE2EWindowMode({
        isE2E: process.env.CAXRI_E2E === '1',
        requestedMode: process.env.CAXRI_E2E_WINDOW_MODE,
    });
    const e2eAgentPolicy = readE2EAgentPolicy();
    const menuRefreshController = createMenuRefreshController({
        applyKeybindings: installMenu,
        loadKeybindings: loadMenuKeybindings,
    });
    const eventRelay = createMainEventRelay({
        deliver: (message) => {
            const isForWorkbench = agentCommander?.relay(message) ?? true;
            if (isForWorkbench && mainWindow && !mainWindow.isDestroyed())
                mainWindow.webContents.send('caxri:event', message);
        },
        loadState: () => supervisor.request('app.bootstrap'),
        logger: () => mainLogger,
        // `onMenuRefreshRequested` is a synchronous listener; the controller preserves the installed menu on failure
        // here, so this is deliberately fire-and-forget rather than awaited.
        onMenuRefreshRequested: () => menuRefreshController.refresh(),
    });
    const windowZoom = createWindowZoomController({
        loadLevel: async () => (await supervisor.request('settings.get')).value['window.zoomLevel'],
        windows: () => [mainWindow, agentCommander?.openWindow(), processExplorer.openWindow()],
    });
    function sendEvent(event: ServerEvent): void {
        eventRelay.send(event);
        notifications?.observe(event);
        if (event.event === 'settings.changed') windowZoom.refresh();
    }
    const gpuRecovery = createGpuRecoveryCoordinator({
        app,
        boot: gpuBoot,
        diagnostics: gpuDiagnostics,
        isE2E: process.env.CAXRI_E2E === '1',
        logger: () => mainLogger,
        prepareRelaunch: () => {
            quitIntent = 'relaunch';
        },
        sendEvent,
        updateArgvConfig: (changes) => updateArgvConfig(desktopProfile.userDataPath, changes),
    });
    gpuRecovery.install();
    const requestAppQuit = createAppQuitHandler({
        acceptQuit: () => {
            isQuitStarted = true;
            eventLoopMonitor?.stop();
            notifications?.dispose();
        },
        closeDesktop: () => supervisor.shutdown(),
        confirm: (impact) => confirmAppQuit(dialog, mainWindow, impact),
        ...createReviewCommentsQuitOptions(dialog, mainWindow, () => supervisor),
        detachAll: () => supervisor.request('terminal.detachAll'),
        exit: () => app.exit(0),
        logFailure: (level, stage, error) =>
            mainLogger?.write(level, logEventCatalog.app.quitFailed, {
                fields: { stage, error },
            }),
        notifyStopFailure: () => notifyAppQuitStopFailure(dialog, mainWindow),
        persistWindowState: async () => {
            const window = mainWindow;
            await persistAllWindowState([
                () =>
                    window && !window.isDestroyed()
                        ? supervisor.request('app.windowState.update', readWindowState(window))
                        : undefined,
                () => agentCommander?.persistWindowState(),
                () => processExplorer.persistWindowState(),
            ]);
        },
        quitIntent: () => quitIntent,
        readStatus: () => supervisor.request('host.status'),
        stopServer: () => supervisor.stopServer(),
    });
    function createWindow(placement: Promise<WindowPlacement>): BrowserWindow {
        const zoomFactor = zoomFactorForLevel(windowZoom.level());
        const window = new BrowserWindow({
            ...defaultWindowState.bounds,
            minWidth: 960,
            minHeight: 640,
            title: 'Caxri',
            ...mainWindowChromeOptions(zoomFactor),
            show: false,
            webPreferences: {
                preload: join(currentDirectory, '../preload/index.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                /**
                 * The window stays hidden while it loads in parallel with Server Core startup; an unthrottled page
                 * reaches its first paint, and so `ready-to-show`, without waiting for visibility. Throttling returns
                 * once the window is shown.
                 */
                backgroundThrottling: false,
                zoomFactor,
            },
        });
        eventRelay.rendererPending();
        rendererReadiness.track(window.webContents);
        window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame) eventRelay.rendererPending();
        });
        let persistTimer: NodeJS.Timeout | undefined;
        const persistWindowState = (): void => {
            /**
             * `before-quit` performs the final ordered write before Server shutdown.
             */
            if (isQuitStarted || window.isDestroyed()) return;
            const state = readWindowState(window);
            // `persistWindowState` is a synchronous timer callback; a failed persist is not
            // user-actionable here, so this is deliberately fire-and-forget rather than awaited.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            supervisor.request('app.windowState.update', state).catch(() => {});
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
        /**
         * `did-finish-load` covers the Renderer loading (or reloading/crash-recovering) while already fullscreen, so it
         * observes the current state instead of missing the one-shot `enter-full-screen` of a restored placement.
         */
        startupProfile.mark('windowCreated');
        mainLogger?.write('info', logEventCatalog.window.created);
        window.webContents.on('did-finish-load', sendFullScreenState);
        window.once('ready-to-show', () => {
            startupProfile.mark('readyToShow');
            mainLogger?.write('info', logEventCatalog.window.readyToShow, {
                durationMs: performance.now() - bootStartedAt,
            });
            updateService.startAutomaticCheck({ isE2E: process.env.CAXRI_E2E === '1' });
        });
        showWhenPlaced(window, placement, () => {
            startupProfile.mark('windowShown');
            window.webContents.setBackgroundThrottling(true);
            if (e2eWindowMode === 'visible') window.show();
        });
        /**
         * Passive page content never inherits authority from an explicitly trusted Terminal link.
         */
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event, url) => {
            const currentUrl = window.webContents.getURL();
            if (url === currentUrl) return;
            event.preventDefault();
        });
        /**
         * Renderer console errors are otherwise invisible in logs; mirror them so triage can see UI faults.
         */
        window.webContents.on('console-message', (details) => {
            if (details.level !== 'error' || isBenignRendererErrorMessage(details.message)) return;
            mainLogger?.write('error', logEventCatalog.renderer.consoleError, {
                fields: consoleErrorLogFields(details),
            });
        });
        window.webContents.on('preload-error', () => {
            mainLogger?.write('error', logEventCatalog.renderer.preloadError, {
                fields: { code: 'PRELOAD_ERROR' },
            });
        });
        observeRendererHangs(window.webContents, logEventCatalog.window, () => mainLogger);
        observeRendererCrashes(window, {
            logger: () => mainLogger,
            shutdown: () => supervisor.shutdown(),
        });
        const requestWindowClose = createWindowCloseHandler({
            close: () => {
                isForceWindowClose = true;
                window.close();
                isForceWindowClose = false;
            },
            confirm: async (count) => {
                mainLogger?.write('info', logEventCatalog.window.closeConfirmation, {
                    fields: { runningTerminals: count },
                });
                const result = await dialog.showMessageBox(window, {
                    type: 'warning',
                    title: 'Terminals are still running',
                    message: `${count} Terminal${count === 1 ? ' is' : 's are'} still running.`,
                    detail: 'Keep Running closes this window and leaves Caxri Server active. To exit the app, use Quit Caxri and choose whether running tasks should stop.',
                    buttons: ['Keep Running', 'Terminate and Close', 'Cancel'],
                    defaultId: 2,
                    cancelId: 2,
                });
                mainLogger?.write('info', logEventCatalog.window.closeDecision, {
                    fields: { response: result.response },
                });
                return result.response === 2
                    ? 'cancel'
                    : result.response === 1
                      ? 'terminate'
                      : 'close';
            },
            countRunning: () => supervisor.request('terminal.runningCount'),
            detachAll: () => supervisor.request('terminal.detachAll'),
            logFailure: (message) =>
                mainLogger?.write('error', logEventCatalog.window.closeFailed, {
                    fields: { error: message },
                }),
            terminateAll: () => supervisor.request('terminal.terminateAll'),
        });
        window.on('close', (event) => {
            if (isForceWindowClose || isQuitStarted) return;
            if (persistTimer) clearTimeout(persistTimer);
            persistTimer = undefined;
            persistWindowState();
            event.preventDefault();
            // `close` is a synchronous listener; the handler already resolves the window's fate
            // (confirm/terminate/close) internally, so this is deliberately fire-and-forget here.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            requestWindowClose().catch(() => {});
        });
        window.on('closed', () => {
            if (persistTimer) clearTimeout(persistTimer);
            /**
             * Explicit quit can close the window before its already-queued IPC reaches Main. Retain the trusted sender
             * identity until process exit without reading the destroyed window.
             */
            if (mainWindow === window && !isQuitStarted) {
                mainWindow = undefined;
                mainRenderer = undefined;
                // Closing the Workbench detaches every Terminal view, the Commander's included.
                agentCommander?.close();
            }
            mainLogger?.write('info', logEventCatalog.window.closed);
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
    async function readWindowPlacement(): Promise<WindowPlacement> {
        const readState = async (): Promise<PersistedWindowState> => {
            try {
                return await supervisor.request('app.windowState.get');
            } catch {
                return defaultWindowState;
            }
        };
        const [state, zoomLevel] = await Promise.all([readState(), windowZoom.load()]);
        return { state, zoomLevel };
    }

    /**
     * Creates the Workbench window at once and shows it when `placement` lands. Startup passes a placement that waits
     * for Server Core, so the Renderer loads while Server Core is still starting.
     */
    function openMainWindow(placement?: Promise<WindowPlacement>): void {
        if (mainWindow) return;
        mainWindow = createWindow(placement ?? readWindowPlacement());
        mainRenderer = mainWindow.webContents;
    }

    async function focusMainWindow(): Promise<BrowserWindow> {
        openMainWindow();
        const window = mainWindow!;
        await rendererReadiness.wait(window.webContents);
        if (window.isMinimized()) window.restore();
        window.show();
        app.focus({ steal: true });
        window.focus();
        return window;
    }

    const secondInstanceFocus = installSecondInstanceFocus(
        app,
        async () => {
            await focusMainWindow();
            mainLogger?.write('info', logEventCatalog.app.secondInstanceFocused, {
                fields: { profileId: desktopProfile.id },
            });
        },
        (error) =>
            mainLogger?.write('error', logEventCatalog.app.secondInstanceFocusFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            }),
    );

    function dispatchWorkbenchCommand(command: CommandId, isViaAccelerator: boolean): void {
        sendEvent({
            event: 'command.execute',
            payload: { command, viaAccelerator: isViaAccelerator },
        });
    }

    const handleMainMethod = createMainMethodHandler({
        ...gpuRecovery.mainMethodOptions,
        getProcessExplorer: () => processExplorer,
        getAgentCommander: () => agentCommander,
        revealSessionInWorkbench: async (sessionId) => {
            await supervisor.request('session.select', { sessionId });
            await focusMainWindow();
        },
        openSettingsInWorkbench: async (target) => {
            // Unlike a menu pick, wait for the Workbench Renderer: a reopened window must be listening for the event.
            await focusMainWindow();
            if (target) sendEvent({ event: 'settings.openRequested', payload: { target } });
            else dispatchWorkbenchCommand('settings.open', false);
        },
        getRemoteDebugging: () => remoteDebuggingState(desktopProfile),
        getUserDataPath: () => desktopProfile.userDataPath,
        getSupervisor: () => supervisor,
        getUpdateService: () => updateService,
        getWindow: () => mainWindow,
        workbenchRootAuthority,
    });

    const handleServerDesktopOperation = createDesktopOperationHandler(
        createDesktopActions({
            focusMainWindow,
            getMainWindow: () => mainWindow,
            sendEvent,
        }),
    );

    function installIpc(): void {
        const dispatchCommand = createElectronIpcCommandAdapter({
            server: {
                invoke: async (request, _context, invocation) => {
                    await serverReady.promise;
                    return request.method === 'events.recover'
                        ? eventRelay.recover(request.params.afterCursor)
                        : supervisor.forward(request.method, request.params, invocation.requestId);
                },
            },
            desktop: {
                isAvailable: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
                invoke: (async (request: CaxriRequest) => {
                    if (!isMainRequest(request))
                        throw new CaxriError(
                            'INTERNAL',
                            'Server command reached the Desktop adapter',
                        );
                    await serverReady.promise;
                    return handleMainMethod(request);
                }) satisfies CommandAdapter['invoke'],
            },
        });
        const completeRendererHandshake = (): void => {
            eventRelay.rendererReady();
            if (mainRenderer) rendererReadiness.ready(mainRenderer);
            // A failed readiness handshake is only logged, so this is deliberately fire-and-forget.
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
            supervisor.markDesktopReady().catch((error: unknown) =>
                mainLogger?.write('error', logEventCatalog.serverConnection.desktopReadyFailed, {
                    fields: { error: errorMessage(error, 'unknown') },
                }),
            );
        };
        installWorkbenchIpc({
            isQuitting: () => isQuitStarted,
            isRecovering: () => supervisor.isRecovering(),
            logger: () => mainLogger,
            onRendererDiagnostic: gpuDiagnostics.recordRendererDiagnostic,
            readEventLoopStalls: () => eventLoopMonitor?.summary(),
            onStartupFrame: (frame) => startupProfile.complete(frame),
            onEventsReady: () => {
                startupProfile.mark('rendererReady');
                // eslint-disable-next-line no-void -- replays the synchronous handshake once Server Core is attached
                void serverReady.promise.then(completeRendererHandshake);
            },
            renderer: () => mainRenderer,
            companion: agentCommander?.companion(),
            transport: dispatchCommand,
        });
    }

    const injectMenuKeybindingFailure = createMenuKeybindingFailureInjection();
    async function loadMenuKeybindings(): Promise<Keybinding[]> {
        return injectMenuKeybindingFailure((await supervisor.request('keybindings.get')).value);
    }

    function installMenu(keybindings: Keybinding[]): void {
        Menu.setApplicationMenu(
            Menu.buildFromTemplate(
                buildAppMenuTemplate({
                    keybindings,
                    dispatchCommand: dispatchWorkbenchCommand,
                    openProcessExplorer: () => processExplorer.open(),
                    openAgentCommander: () => agentCommander?.open(),
                    stopAgentCommander: () => {
                        // eslint-disable-next-line no-void -- the controller logs a failed stop, and the status bar keeps showing the Commander
                        void agentCommander?.stop().catch(() => {});
                    },
                    workbenchWindow: () =>
                        mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
                    isFollowingAppZoom: (window) => window === agentCommander?.openWindow(),
                    focusWorkbench: () => {
                        // eslint-disable-next-line no-void -- best effort: the command reaches the Workbench whether or not it came forward
                        void focusMainWindow().catch(() => {});
                    },
                }),
            ),
        );
    }

    // Top-level await is unavailable in this bundle target, so the bootstrap sequence below is
    // deliberately fire-and-forget from module scope rather than awaited; `shouldContinueStartup`
    // and each awaited step already report their own failures.
    app.whenReady()
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        .then(async () => {
            if (
                shouldEnableAcceptanceAccessibility({
                    environment: process.env,
                    platform: process.platform,
                })
            )
                app.setAccessibilitySupportEnabled(true);
            const developmentDockIconPath = resolveDevelopmentDockIconPath({
                currentDirectory,
                isPackaged: app.isPackaged,
            });
            if (developmentDockIconPath && app.dock) app.dock.setIcon(developmentDockIconPath);
            const { userDataPath } = desktopProfile;
            mainLogger ??= createMainLogger();
            processErrorMonitor.attach(mainLogger);
            eventLoopMonitor = startEventLoopMonitor(mainLogger);
            startupProfile.mark('appReady');
            mainLogger.write('info', logEventCatalog.app.ready, {
                durationMs: performance.now() - bootStartedAt,
                fields: {
                    profileId: desktopProfile.id,
                    profileKind: desktopProfile.kind,
                    remoteDebuggingPort:
                        desktopProfile.remoteDebugging.transport === 'port'
                            ? desktopProfile.remoteDebugging.port
                            : null,
                    remoteDebuggingTransport: desktopProfile.remoteDebugging.transport,
                },
            });
            gpuRecovery.recordBoot();
            // GPU collection is asynchronous and must never delay window startup.
            // eslint-disable-next-line no-void -- snapshot failures write their own bounded diagnostic
            void gpuDiagnostics.captureBaseline();
            if (process.env.CAXRI_E2E === '1')
                mainLogger.write('info', logEventCatalog.e2e.launch, {
                    fields: e2eLaunchLogFields(e2eAgentPolicy, e2eWindowMode),
                });
            updateService = new UpdateService({
                acceptanceDiscovery: createAcceptanceUpdateFixture({
                    environment: process.env,
                    isPackaged: app.isPackaged,
                    userDataPath,
                }),
                currentVersion: caxriVersion,
                downloadDirectory: join(userDataPath, 'updates'),
                enabled: app.isPackaged,
                openPath: (path) => shell.openPath(path),
                onState: (state) => {
                    if (state.status !== 'downloading')
                        mainLogger?.write(
                            state.status === 'error' ? 'error' : 'info',
                            logEventCatalog.updates.state,
                            { fields: updateStateLogFields(state) },
                        );
                    sendEvent({ event: 'updates.state', payload: state });
                },
            });
            supervisor = new DesktopServerConnection({
                buildIdentity: {
                    commit: process.env.CAXRI_GIT_COMMIT,
                    version: caxriVersion,
                },
                agentHooksPath:
                    process.env.CAXRI_E2E === '1'
                        ? process.env.CAXRI_E2E_AGENT_HOOKS === '1'
                            ? join(userDataPath, 'agent-hooks')
                            : undefined
                        : join(app.getPath('appData'), 'caxri', 'agent-hooks'),
                currentDirectory,
                cliPath: app.isPackaged
                    ? join(process.resourcesPath, 'cli', 'caxri.cjs')
                    : resolve(currentDirectory, '../../apps/cli/dist/caxri.cjs'),
                desktopId: randomUUID(),
                desktopLaunch: resolveDesktopLaunch({
                    currentDirectory,
                    executable: process.execPath,
                    isPackaged: app.isPackaged,
                }),
                e2eAgentPolicy,
                handleCommand: handleServerDesktopOperation,
                logger: mainLogger,
                serverArtifactRoot: app.isPackaged
                    ? join(process.resourcesPath, 'server')
                    : resolve(currentDirectory, '../../apps/server/dist/server'),
                userDataPath,
            });
            ({ agentCommander, processExplorer } = createOnDemandWindows({
                currentDirectory,
                logger: mainLogger,
                mainWindow: () => mainWindow,
                supervisor,
                windowMode: e2eWindowMode,
                zoomLevel: () => windowZoom.level(),
            }));
            supervisor.onEvent(sendEvent);
            wirePowerWake(powerMonitor, () => (quitIntent = 'system-shutdown'), supervisor);
            const attaching = shouldContinueStartup({
                dialog,
                logger: mainLogger,
                quit: () => app.quit(),
                supervisor,
            });
            // The window loads while Server Core starts; its IPC waits on `serverReady`, and it shows once placed.
            installIpc();
            const startupPlacement = async (): Promise<WindowPlacement> => {
                if (!(await attaching)) return new Promise<never>(() => {});
                await serverReady.promise;
                await menuRefreshController.refresh();
                return readWindowPlacement();
            };
            openMainWindow(startupPlacement());
            if (!(await attaching)) return;
            startupProfile.mark('serverAttached');
            notifications = createDesktopNotifications({
                sendEvent,
                currentDirectory,
                focusMainWindow,
                getWindow: () => mainWindow,
                handleMainMethod,
                isPackaged: app.isPackaged,
                logger: () => mainLogger,
                resourcesPath: process.resourcesPath,
                supervisor,
            });
            void notifications.initialize(); // eslint-disable-line no-void -- background-only startup state
            processExplorer.installIpc();
            serverReady.resolve();
            // `openMainWindow` alone only creates the window; wait for its Renderer too (see `reopenAuxiliaryWindowsAtStartup`).
            await rendererReadiness.wait(mainWindow!.webContents);
            await reopenAuxiliaryWindowsAtStartup(agentCommander, processExplorer);
            secondInstanceFocus.ready();
        })
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        .catch(() => {});
    app.on('activate', () => {
        openMainWindow();
        // `activate` is a synchronous listener; a failed validation pass surfaces on the next one.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        supervisor.request('session.validateWorkbenchRoots').catch(() => {});
    });

    app.on('browser-window-focus', () => {
        // `browser-window-focus` is a synchronous listener; a failed validation pass surfaces on the
        // next one.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        supervisor.request('session.validateWorkbenchRoots').catch(() => {});
    });

    app.on('window-all-closed', () => {
        // macOS keeps the Desktop client alive; the independently supervised Server survives either way.
    });
    app.on('before-quit', (event) => {
        event.preventDefault();
        if (isQuitStarted) return;
        mainLogger?.write('info', logEventCatalog.app.quitRequested);
        // Coalesce repeated Cmd+Q events and commit shutdown only after the user accepts.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        requestAppQuit().catch(() => app.exit(0));
    });
}
