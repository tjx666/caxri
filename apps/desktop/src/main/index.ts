import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { Keybinding, ServerEvent } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { EventLoopMonitor } from '@caxri/system';
import {
    installProcessErrorMonitor,
    logEventCatalog,
    readE2EAgentPolicy,
    startEventLoopMonitor,
} from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';
import { app, dialog, Menu, nativeTheme, powerMonitor, screen } from 'electron';

import { installAgentChatMediaProtocol } from './agent-chat/media-protocol';
import { applyDevelopmentAppIdentity } from './app-icon';
import { installBeforeQuitTrigger, installSignalQuitTriggers } from './app-quit-triggers';
import { updateArgvConfig } from './argv-config';
import { reopenAuxiliaryWindowsAtStartup } from './auxiliary-window/lifecycle';
import type { BenchmarkWindowController } from './benchmark/window';
import { stampBuildIdentity } from './build-identity';
import type { CaxriBotWindowController } from './caxri-bot-window';
import { caxriBotMenuOptions } from './caxri-bot-window';
import { startClaudeWindowJob } from './claude-windows';
import { DesktopServerConnection } from './connection/server-connection';
import { resolveServerConnectionOptions } from './connection/server-connection-options';
import { createDesktopActions } from './desktop-actions';
import { createDesktopLogger } from './desktop-logger';
import { createDesktopOperationHandler } from './desktop-operations';
import {
    configureDesktopProfile,
    hasProfileSingleInstanceLock,
    remoteDebuggingState,
} from './desktop-profile';
import { e2eLaunchLogFields } from './e2e-launch';
import { guardEnvironmentMethods } from './environment-method-policy';
import { createMainEventRelay } from './event-relay';
import { installExternalActivation } from './external-activation/activation';
import { createGpuDiagnostics } from './gpu-diagnostics';
import { createGpuRecoveryCoordinator, prepareGpuBoot } from './gpu-recovery';
import {
    createLocalWorkbenchEnvironment,
    createSshHostWindowMenu,
} from './local-workbench-environment';
import { createMainMethodHandler } from './main-methods';
import { createMainQuitHandler, createQuitIntent } from './main-quit-wiring';
import { createMenuRefreshController, createMenuStateLoader } from './menu/refresh';
import { buildAppMenuTemplate } from './menu/template';
import type { DesktopNotifications } from './notifications/desktop-notifications';
import { createDesktopNotifications } from './notifications/desktop-notifications';
import { companionWindowFor, createOnDemandWindows, isZoomingWithApp } from './on-demand-windows';
import type { PerformanceMonitorWindowController } from './performance-monitor/window';
import { wirePowerWake } from './power-wake';
import type { ProcessExplorerWindowController } from './process-explorer/window';
import { applyReadyAppearance, logAppReady } from './ready-setup';
import { RendererReadiness } from './renderer-readiness';
import { ProjectRootGrants } from './root-grants';
import { composeSshHostEnvironments } from './ssh/host-environment-composition';
import type { SshHostEnvironments } from './ssh/host-environments';
import { createStartupFailureWiring } from './startup/startup-failure-wiring';
import { StartupProfile } from './startup-profile';
import { createTestRootPathResolver } from './test-root';
import { createWorkbenchUnsavedEditors } from './unsaved-editors';
import { createDesktopUpdateService } from './updates/desktop-update-service';
import { offerMoveToApps as offerMoveToApps } from './updates/move-to-apps';
import type { UpdateService } from './updates/updates';
import { createWindowZoomController } from './window-chrome';
import { bringWindowForward, resolveE2EWindowMode } from './window-mode';
import type { WindowPlacement } from './window-placement';
import { loadWindowPlacement } from './window-placement';
import {
    createConnectionPresence,
    currentRequestWindowKey,
    PRIMARY_WINDOW_KEY,
} from './window-presence-registry';
import { createWorkbenchCommandAdapter } from './workbench-command-adapter';
import { createWorkbenchHandOffs, workbenchCommandDispatcher } from './workbench-hand-offs';
import { installWorkbenchIpc } from './workbench-ipc';
import { createWorkbenchRootAuthority } from './workbench-root-authority';
import {
    createTearOffWindows,
    createWorkbenchEventDelivery,
    createWorkbenchWindowFactory,
    eventAudience,
    WorkbenchWindows,
} from './workbench-windows';
import { installActivationHandlers } from './workbench-windows/activation-handlers';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const caxriVersion = stampBuildIdentity();
applyDevelopmentAppIdentity(app);
// Must settle before Chromium, logging, Server attachment, or the single-instance lock captures launch identity.
const desktopProfile = configureDesktopProfile(app, process.env);
const gpuBoot = prepareGpuBoot(app, desktopProfile.userDataPath);
const ownsProfileInstance = hasProfileSingleInstanceLock(app, desktopProfile);
if (!ownsProfileInstance) app.quit();
installAgentChatMediaProtocol();

// A bare block, not module top level, so the mutable bootstrap state below is block-scoped: its lifecycle callbacks
// need module-lifetime shared state, and this keeps it out of `unicorn/no-top-level-assignment-in-function`'s reach.
if (ownsProfileInstance) {
    /**
     * The primary Workbench window, which is also registered in `workbenchWindows` under `main`. Tear-off windows exist
     * only in the registry.
     */
    let mainWindow: BrowserWindow | undefined;
    const workbenchWindows = new WorkbenchWindows<BrowserWindow>();
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
     * from the Renderer like a Worker that exists and never runs, the exact shape of issue #962, which was diagnosable
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
    let performanceMonitor: PerformanceMonitorWindowController | undefined;
    let caxriBot: CaxriBotWindowController | undefined;
    let benchmarkWindow: BenchmarkWindowController | undefined;
    let updateService: UpdateService;
    let notifications: DesktopNotifications | undefined;
    /**
     * SSH Host windows, each with its own Server connection. Created once Main's logger and local connection options
     * exist; until then no window can request an SSH Host.
     */
    let sshHostEnvironments: SshHostEnvironments | undefined;
    let isQuitStarted = false;
    const quitIntent = createQuitIntent();
    const grantedRoots = new ProjectRootGrants();
    const rendererReadiness = new RendererReadiness();
    const e2eWindowMode = resolveE2EWindowMode(process.env);
    /**
     * Presence of the local Workbench windows on the local Server; see `WindowPresenceRegistry`. `supervisor` is read
     * lazily because the registry is built before the connection exists.
     */
    const localPresence = createConnectionPresence(
        () => supervisor,
        () => mainLogger,
        e2eWindowMode === 'hidden',
    );
    const resolveNextTestRootPath = createTestRootPathResolver({ isPackaged: app.isPackaged });
    const workbenchRootAuthority = createWorkbenchRootAuthority({
        getServer: () => supervisor,
        getWindow: () => requestWorkbenchWindow(),
        grants: grantedRoots,
        logger: () => mainLogger,
        nextTestRoot: resolveNextTestRootPath,
        focusWindow: async () => {
            await focusMainWindow();
        },
    });
    const e2eAgentPolicy = readE2EAgentPolicy();
    const menuRefreshController = createMenuRefreshController({
        applyKeybindings: installMenu,
        loadKeybindings: createMenuStateLoader(
            () => supervisor,
            // Chromium's locale, which honors `--lang` like the Renderer's `navigator.language` does.
            () => [app.getLocale()],
        ),
    });
    const deliverToWorkbench = createWorkbenchEventDelivery(workbenchWindows, eventAudience);
    const eventRelay = createMainEventRelay({
        deliver: (message, event, windowKey) => {
            benchmarkWindow?.relay(message);
            const isForWorkbench = caxriBot?.relay(message) ?? true;
            if (isForWorkbench) deliverToWorkbench(message, event, windowKey);
        },
        loadState: () => supervisor.request('app.bootstrap'),
        logger: () => mainLogger,
        // `onMenuRefreshRequested` is a synchronous listener; the controller preserves the installed menu on failure
        // here, so this is deliberately fire-and-forget rather than awaited.
        onMenuRefreshRequested: () => menuRefreshController.refresh(),
    });
    const windowZoom = createWindowZoomController({
        loadLevel: async () => (await supervisor.request('settings.get')).value['window.zoomLevel'],
        windows: () => [
            ...workbenchWindows.list().map(({ window }) => window),
            caxriBot?.openWindow(),
            benchmarkWindow?.openWindow(),
            processExplorer.openWindow(),
            performanceMonitor?.openWindow(),
            ...(sshHostEnvironments?.list().map((environment) => environment.window) ?? []),
        ],
    });
    /**
     * The window a native dialog for the current request attaches to: the calling Workbench window, else the primary.
     */
    function requestWorkbenchWindow(): BrowserWindow | undefined {
        return workbenchWindows.get(currentRequestWindowKey() ?? '') ?? mainWindow;
    }
    const startupFailure = createStartupFailureWiring({
        logDirectory: desktopProfile.logDirectory,
        prepareRelaunch: () => quitIntent.set('relaunch'),
        readSystemNotificationsEnabled: async () =>
            (await supervisor.request('settings.get')).value['agents.notifications.enabled'],
        userDataPath: desktopProfile.userDataPath,
    });
    function sendEvent(event: ServerEvent, windowKey?: string): void {
        eventRelay.send(event, windowKey);
        if (event.event === 'runtime.status')
            startupFailure.runtimeFailurePrompt.observe(event.payload.status);
        notifications?.observe(event);
        if (event.event === 'settings.changed') windowZoom.refresh();
    }
    const gpuRecovery = createGpuRecoveryCoordinator({
        app,
        boot: gpuBoot,
        diagnostics: gpuDiagnostics,
        isE2E: process.env.CAXRI_E2E === '1',
        isQuitting: () => isQuitStarted,
        logger: () => mainLogger,
        prepareRelaunch: () => quitIntent.set('relaunch'),
        sendEvent,
        updateArgvConfig: (changes) => updateArgvConfig(desktopProfile.userDataPath, changes),
    });
    gpuRecovery.install();
    const unsavedEditors = createWorkbenchUnsavedEditors({
        dialog,
        windows: () => workbenchWindows.list(),
        logger: () => mainLogger,
        sendEvent,
    });
    const requestAppQuit = createMainQuitHandler({
        caxriBot: () => caxriBot,
        // `updateService` is assigned on ready, and a quit can arrive before that, when nothing can have been staged yet.
        applyUpdate: async (update) =>
            (updateService as UpdateService | undefined)?.applyOnExit(update) ?? false,
        focusedWindow: () => workbenchWindows.focusedOrPrimary(),
        logger: () => mainLogger,
        mainWindow: () => mainWindow,
        onAccepted: () => {
            isQuitStarted = true;
            eventLoopMonitor?.stop();
            notifications?.dispose();
        },
        processExplorer: () => processExplorer,
        quitIntent: quitIntent.current,
        sshHostEnvironments: () => sshHostEnvironments,
        // Unset before ready.
        supervisor: () => supervisor,
        unsavedEditors,
    });
    const quitTriggers = {
        app,
        isQuitStarted: () => isQuitStarted,
        logger: () => mainLogger,
        requestAppQuit,
    };
    const tearOffWindows = createTearOffWindows<BrowserWindow>({
        // The factory and the tear-off controller reference each other; the call happens long after both exist.
        // eslint-disable-next-line no-use-before-define, @typescript-eslint/no-use-before-define
        createWindow: (input) => createWorkbenchWindow({ role: 'tearOff', ...input }),
        logger: () => mainLogger,
        primaryReady: (primary) => rendererReadiness.whenReady(primary.webContents),
        register: (windowKey, window, sessionId) => {
            registerWorkbenchWindow(windowKey, window);
            localPresence.setViewing(windowKey, sessionId);
        },
        serverReady: serverReady.promise,
        supervisor: () => supervisor,
        windows: workbenchWindows,
        workAreas: () => screen.getAllDisplays().map((display) => display.workArea),
        zoomLevel: () => windowZoom.level(),
    });
    const createWorkbenchWindow = createWorkbenchWindowFactory({
        bootStartedAt,
        closeTearOffsKeepingStrips: () => tearOffWindows.closeKeepingStrips(),
        currentDirectory,
        decideUnsavedEditors: (windowKey) => unsavedEditors.decide('close', windowKey),
        logDirectory: desktopProfile.logDirectory,
        e2eWindowMode,
        eventRelay,
        isQuitting: () => isQuitStarted,
        logger: () => mainLogger,
        onClosed: ({ role, windowKey, window }) => {
            eventRelay.windowClosed(windowKey);
            // Explicit quit can close a window before its already-queued IPC reaches Main, so its sender stays trusted.
            workbenchWindows.remove(windowKey, { keepSenderTrust: isQuitStarted });
            if (role === 'tearOff') return tearOffWindows.onClosed(windowKey, isQuitStarted);
            if (mainWindow !== window || isQuitStarted) return;
            mainWindow = undefined;
            // Closing the Workbench detaches every Terminal view, Caxri Bot's included.
            caxriBot?.close();
        },
        onPrimaryReadyToShow: () => {
            updateService.startAutomaticCheck({
                isE2E: process.env.CAXRI_E2E === '1',
                subscribeResume: (onResume) => powerMonitor.on('resume', onResume),
            });
            void offerMoveToApps({
                prepareRelaunch: () => quitIntent.set('relaunch'),
                restoreQuitIntent: () => quitIntent.set('user'),
                userDataPath: desktopProfile.userDataPath,
            });
        },
        rendererReadiness,
        sendEvent,
        startupProfile,
        supervisor: () => supervisor,
        zoomLevel: () => windowZoom.level(),
    });
    function registerWorkbenchWindow(windowKey: string, window: BrowserWindow): void {
        workbenchWindows.add(windowKey, window);
        localPresence.register(windowKey, window.webContents, window);
    }
    const readWindowPlacement = (): Promise<WindowPlacement> =>
        loadWindowPlacement(
            () => supervisor.request('app.windowState.get'),
            () => windowZoom.load(),
        );

    /**
     * Creates the Workbench window at once and shows it when `placement` lands. Startup passes a placement that waits
     * for Server Core, so the Renderer loads while Server Core is still starting.
     */
    function openMainWindow(placement?: Promise<WindowPlacement>): void {
        if (mainWindow) return;
        const window = createWorkbenchWindow({
            role: 'primary',
            windowKey: PRIMARY_WINDOW_KEY,
            placement: placement ?? readWindowPlacement(),
        });
        mainWindow = window;
        registerWorkbenchWindow(PRIMARY_WINDOW_KEY, window);
        // Startup and a dock reopen share this path, so torn-off windows come back in both.
        void tearOffWindows.restore(window);
    }

    /**
     * Raises a Workbench window, reopening the primary window when it was closed: the primary window by default, or the
     * window that owns the Session a hand-off is about.
     */
    async function focusMainWindow(windowKey: string = PRIMARY_WINDOW_KEY): Promise<BrowserWindow> {
        openMainWindow();
        const window = workbenchWindows.get(windowKey) ?? mainWindow!;
        await rendererReadiness.wait(window.webContents);
        bringWindowForward({ app, window, windowMode: e2eWindowMode });
        return window;
    }

    const externalActivation = installExternalActivation({
        app,
        focusMainWindow,
        logger: () => mainLogger,
        profileId: desktopProfile.id,
        sendEvent,
    });

    const dispatchWorkbenchCommand = workbenchCommandDispatcher(sendEvent);

    const handleMainMethod = guardEnvironmentMethods(
        'local',
        createMainMethodHandler({
            ...gpuRecovery.mainMethodOptions,
            environment: createLocalWorkbenchEnvironment(() => sshHostEnvironments),
            logger: () => mainLogger,
            getProcessExplorer: () => processExplorer,
            getPerformanceMonitor: () => performanceMonitor,
            requestWorkbenchProcessId: () => requestWorkbenchWindow()?.webContents.getOSProcessId(),
            getCaxriBot: () => caxriBot,
            getBenchmarkWindow: () => benchmarkWindow,
            onUnsavedEditorsReply: (parameters) => unsavedEditors.reply(parameters),
            ...createWorkbenchHandOffs({
                dispatchWorkbenchCommand,
                focusMainWindow,
                sendEvent,
                supervisor: () => supervisor,
            }),
            getRemoteDebugging: () => remoteDebuggingState(desktopProfile),
            getDesktopNotifications: () => notifications,
            relaunch: startupFailure.relaunch,
            decideUnsavedEditorsBeforeRelaunch: () => unsavedEditors.decide('quit'),
            getUserDataPath: () => desktopProfile.userDataPath,
            getSupervisor: () => supervisor,
            getUpdateService: () => updateService,
            getWindow: () => requestWorkbenchWindow(),
            sendEvent,
            tearOffSession: (input) => tearOffWindows.tearOff(input),
            windowPresence: localPresence,
            workbenchRootAuthority,
        }),
    );

    const handleServerDesktopOperation = createDesktopOperationHandler(
        createDesktopActions({
            focusMainWindow,
            getMainWindow: () => requestWorkbenchWindow(),
            sendEvent,
        }),
    );

    function installIpc(): void {
        const dispatchCommand = createWorkbenchCommandAdapter({
            connection: () => supervisor,
            eventRelay,
            handleMainMethod,
            isWindowAvailable: () => Boolean(mainWindow && !mainWindow.isDestroyed()),
            raiseOwnerWindow: (ownerWindowKey, method) => {
                mainLogger?.write('info', logEventCatalog.window.ownerRedirected, {
                    fields: { method },
                });
                // eslint-disable-next-line unicorn/prefer-await -- fire and forget
                focusMainWindow(ownerWindowKey).catch(() => {});
            },
            serverReady: serverReady.promise,
        });
        const completeRendererHandshake = (sender: WebContents): void => {
            const windowKey = workbenchWindows.keyOf(sender);
            if (windowKey) eventRelay.rendererReady(windowKey);
            rendererReadiness.ready(sender);
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
            onStartupFrame: (frame, sender) => {
                startupProfile.complete(frame);
                performanceMonitor?.recordStartupFrame(frame, sender);
            },
            sshHost: (sender) => sshHostEnvironments?.route(sender),
            onEventsReady: (sender) => {
                if (workbenchWindows.keyOf(sender) === PRIMARY_WINDOW_KEY)
                    startupProfile.mark('rendererReady');
                void serverReady.promise.then(() => completeRendererHandshake(sender));
            },
            isWorkbenchSender: (sender) => workbenchWindows.isWorkbenchSender(sender),
            windowKey: (sender) => localPresence.keyOf(sender),
            companion: (sender) => companionWindowFor(sender, [caxriBot, benchmarkWindow]),
            transport: dispatchCommand,
        });
    }

    const sshHostWindowMenu = createSshHostWindowMenu(() => sshHostEnvironments);
    function installMenu(keybindings: Keybinding[]): void {
        const template = buildAppMenuTemplate({
            keybindings,
            dispatchCommand: dispatchWorkbenchCommand,
            openProcessExplorer: () => processExplorer.open(),
            ...caxriBotMenuOptions(() => caxriBot),
            openBenchmark: () => benchmarkWindow?.open(),
            workbenchWindow: () => workbenchWindows.focusedOrPrimary(),
            isFollowingAppZoom: (window) => isZoomingWithApp(window, [caxriBot, benchmarkWindow]),
            dispatchToSshHostWindow: sshHostWindowMenu.dispatch,
            focusWorkbench: () => {
                void focusMainWindow().catch(() => {});
            },
        });
        sshHostWindowMenu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    // Top-level await is unavailable in this bundle target, so the bootstrap below is deliberately fire-and-forget;
    // `shouldContinueStartup` and each awaited step already report their own failures.
    app.whenReady()
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        .then(async () => {
            applyReadyAppearance(currentDirectory);
            const { userDataPath } = desktopProfile;
            mainLogger ??= createMainLogger();
            processErrorMonitor.attach(mainLogger);
            eventLoopMonitor = startEventLoopMonitor(mainLogger);
            startupProfile.mark('appReady');
            logAppReady(mainLogger, { bootStartedAt, profile: desktopProfile });
            gpuRecovery.recordBoot();
            // GPU collection is asynchronous and must never delay window startup.
            void gpuDiagnostics.captureBaseline();
            if (process.env.CAXRI_E2E === '1')
                mainLogger.write('info', logEventCatalog.e2e.launch, {
                    fields: e2eLaunchLogFields(e2eAgentPolicy, e2eWindowMode),
                });
            updateService = createDesktopUpdateService({
                currentVersion: caxriVersion,
                logger: () => mainLogger,
                quitIntent,
                requestAppQuit,
                sendEvent,
                server: () => supervisor,
                userDataPath,
            });
            const connectionOptions = resolveServerConnectionOptions({
                currentDirectory,
                e2eAgentPolicy,
                userDataPath,
                version: caxriVersion,
            });
            supervisor = new DesktopServerConnection({
                ...connectionOptions,
                handleCommand: handleServerDesktopOperation,
                logger: mainLogger,
                seedAttachment: (send) => localPresence.seed(send),
                systemAppearance: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
            });
            const logger = mainLogger;
            sshHostEnvironments = composeSshHostEnvironments({
                connection: connectionOptions,
                currentDirectory,
                isPackaged: app.isPackaged,
                isQuitting: () => isQuitStarted,
                logger: () => logger,
                nextTestRoot: resolveNextTestRootPath,
                shared: {
                    ...gpuRecovery.mainMethodOptions,
                    getCaxriBot: () => caxriBot,
                    getProcessExplorer: () => processExplorer,
                    getRemoteDebugging: () => remoteDebuggingState(desktopProfile),
                    getUpdateService: () => updateService,
                    getUserDataPath: () => desktopProfile.userDataPath,
                },
                userDataPath,
                zoomLevel: () => windowZoom.level(),
            });
            ({ caxriBot, benchmarkWindow, performanceMonitor, processExplorer } =
                createOnDemandWindows({
                    currentDirectory,
                    logger: mainLogger,
                    mainWindow: () => mainWindow,
                    sendEvent,
                    supervisor,
                    windowMode: e2eWindowMode,
                    zoomLevel: () => windowZoom.level(),
                }));
            supervisor.onEvent(sendEvent);
            wirePowerWake(powerMonitor, () => quitIntent.set('system-shutdown'), supervisor);
            installSignalQuitTriggers(quitTriggers);
            const attaching = startupFailure.startServer(supervisor, mainLogger);
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
                handleMainMethod,
                isPackaged: app.isPackaged,
                isSessionShown: (sessionId) => localPresence.isSessionShown(sessionId),
                logger: () => mainLogger,
                resourcesPath: process.resourcesPath,
                supervisor,
            });
            void notifications.initialize();
            startClaudeWindowJob({ supervisor, logger: () => mainLogger, userDataPath });
            processExplorer.installIpc();
            serverReady.resolve();
            // `openMainWindow` alone only creates the window; wait for its Renderer too (see `reopenAuxiliaryWindowsAtStartup`).
            await rendererReadiness.whenReady(mainWindow!.webContents);
            // An upgrade that replaced a stale Server stopped its live Terminals; say so once the window is up.
            // Fire-and-forget: it reads a Server setting, which must not delay reopening windows or second-instance focus.
            void startupFailure.announceReplacement(supervisor);
            await reopenAuxiliaryWindowsAtStartup(caxriBot, processExplorer);
            externalActivation.ready();
        })
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        .catch(() => {});
    installActivationHandlers({
        app,
        openMainWindow,
        validateWorkbenchRoots: () => supervisor.request('session.validateWorkbenchRoots'),
    });
    installBeforeQuitTrigger(quitTriggers);
}
