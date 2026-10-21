import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { Keybinding, PersistedWindowState, ServerEvent } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { EventLoopMonitor } from '@caxri/system';
import {
    installProcessErrorMonitor,
    logEventCatalog,
    readE2EAgentPolicy,
    startEventLoopMonitor,
} from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';
import { app, dialog, Menu, powerMonitor, screen } from 'electron';

import { shouldEnableAcceptanceAccessibility } from './acceptance-accessibility';
import type { AgentCommanderWindowController } from './agent-commander-window';
import { agentCommanderMenuOptions } from './agent-commander-window';
import { resolveDevelopmentDockIconPath } from './app-icon';
import type { AppQuitIntent } from './app-quit';
import { createAppQuitHandler, createAppQuitPromptOptions, readAppQuitStatus } from './app-quit';
import { installBeforeQuitTrigger, installSignalQuitTriggers } from './app-quit-triggers';
import { updateArgvConfig } from './argv-config';
import {
    persistAllWindowState,
    reopenAuxiliaryWindowsAtStartup,
} from './auxiliary-window-lifecycle';
import type { BenchmarkWindowController } from './benchmark-window';
import { stampBuildIdentity } from './build-identity';
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
import { createDesktopUpdateService } from './desktop-update-service';
import { e2eLaunchLogFields } from './e2e-launch';
import { guardEnvironmentMethods } from './environment-method-policy';
import { createMainEventRelay } from './event-relay';
import { createGpuDiagnostics } from './gpu-diagnostics';
import { createGpuRecoveryCoordinator, prepareGpuBoot } from './gpu-recovery';
import {
    createLocalWorkbenchEnvironment,
    createSshHostWindowMenu,
} from './local-workbench-environment';
import { setMainLanguage } from './locale';
import { createMainMethodHandler } from './main-methods';
import { buildAppMenuTemplate } from './menu';
import { createMenuRefreshController, createMenuStateLoader } from './menu-refresh';
import { companionWindowFor, createOnDemandWindows, isZoomingWithApp } from './on-demand-windows';
import { wirePowerWake } from './power-wake';
import type { ProcessExplorerWindowController } from './process-explorer-window';
import { RendererReadiness } from './renderer-readiness';
import { ProjectRootGrants } from './root-grants';
import { DesktopServerConnection } from './server-connection';
import { resolveServerConnectionOptions } from './server-connection-options';
import { shouldContinueStartup } from './server-startup';
import { composeSshHostEnvironments } from './ssh/host-environment-composition';
import type { SshHostEnvironments } from './ssh/host-environments';
import { StartupProfile } from './startup-profile';
import { createTestRootPathResolver } from './test-root';
import { createWorkbenchUnsavedEditors } from './unsaved-editors';
import type { UpdateService } from './updates';
import { createWindowZoomController } from './window-chrome';
import { bringWindowForward, resolveE2EWindowMode } from './window-mode';
import type { WindowPlacement } from './window-placement';
import { defaultWindowState, readWindowState } from './window-placement';
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

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const caxriVersion = stampBuildIdentity();
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
    /**
     * The primary Workbench window, which is also registered in `workbenchWindows` under `main`. Tear-off windows exist
     * only in the registry.
     */
    let mainWindow: BrowserWindow | undefined;
    const workbenchWindows = new WorkbenchWindows<BrowserWindow>();
    /**
     * Tear-off windows that must keep their Open Sessions when they close: the primary window closing takes them down
     * with it, and a window whose move failed never had a strip. Every other close releases the strip.
     */
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
    let agentCommander: AgentCommanderWindowController | undefined;
    let benchmarkWindow: BenchmarkWindowController | undefined;
    let updateService: UpdateService;
    let notifications: DesktopNotifications | undefined;
    /**
     * SSH Host windows, each with its own Server connection. Created once Main's logger and local connection options
     * exist; until then no window can request an SSH Host.
     */
    let sshHostEnvironments: SshHostEnvironments | undefined;
    let isQuitStarted = false;
    let quitIntent: AppQuitIntent = 'user';
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
            const isForWorkbench = agentCommander?.relay(message) ?? true;
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
            agentCommander?.openWindow(),
            benchmarkWindow?.openWindow(),
            processExplorer.openWindow(),
            ...(sshHostEnvironments?.list().map((environment) => environment.window) ?? []),
        ],
    });
    /**
     * The window a native dialog for the current request attaches to: the calling Workbench window, else the primary.
     */
    function requestWorkbenchWindow(): BrowserWindow | undefined {
        return workbenchWindows.get(currentRequestWindowKey() ?? '') ?? mainWindow;
    }
    function sendEvent(event: ServerEvent, windowKey?: string): void {
        eventRelay.send(event, windowKey);
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
        prepareRelaunch: () => {
            quitIntent = 'relaunch';
        },
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
    const requestAppQuit = createAppQuitHandler({
        acceptQuit: () => {
            isQuitStarted = true;
            (supervisor as DesktopServerConnection | undefined)?.markQuitting(); // Unset before ready.
            eventLoopMonitor?.stop();
            notifications?.dispose();
        },
        closeDesktop: async () => {
            await sshHostEnvironments?.detachAll();
            await supervisor.shutdown();
        },
        ...createAppQuitPromptOptions(dialog, () => mainWindow),
        decideUnsavedEditors: () => unsavedEditors.decide('quit'),
        detachAll: async () => {
            await sshHostEnvironments?.detachTerminals();
            return supervisor.request('terminal.detachAll');
        },
        exit: () => app.exit(0),
        logFailure: (level, stage, error) =>
            mainLogger?.write(level, logEventCatalog.app.quitFailed, {
                fields: { stage, error },
            }),
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
        readPendingReviewComments: () => supervisor.request('gitReview.pending', {}),
        readStatus: () => readAppQuitStatus(supervisor),
        stopServer: () => supervisor.stopServer(),
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
        cursorPoint: () => screen.getCursorScreenPoint(),
        logger: () => mainLogger,
        primaryReady: (primary) => rendererReadiness.wait(primary.webContents),
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
            // Closing the Workbench detaches every Terminal view, the Commander's included.
            agentCommander?.close();
        },
        onPrimaryReadyToShow: () =>
            updateService.startAutomaticCheck({ isE2E: process.env.CAXRI_E2E === '1' }),
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
        const window = createWorkbenchWindow({
            role: 'primary',
            windowKey: PRIMARY_WINDOW_KEY,
            placement: placement ?? readWindowPlacement(),
        });
        mainWindow = window;
        registerWorkbenchWindow(PRIMARY_WINDOW_KEY, window);
        // Startup and a dock reopen share this path, so torn-off windows come back in both.
        void tearOffWindows.restore(window); // eslint-disable-line no-void -- failures log themselves
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

    const dispatchWorkbenchCommand = workbenchCommandDispatcher(sendEvent);

    const handleMainMethod = guardEnvironmentMethods(
        'local',
        createMainMethodHandler({
            ...gpuRecovery.mainMethodOptions,
            environment: createLocalWorkbenchEnvironment(() => sshHostEnvironments),
            logger: () => mainLogger,
            getProcessExplorer: () => processExplorer,
            getAgentCommander: () => agentCommander,
            getBenchmarkWindow: () => benchmarkWindow,
            onUnsavedEditorsReply: (parameters) => unsavedEditors.reply(parameters),
            ...createWorkbenchHandOffs({
                dispatchWorkbenchCommand,
                focusMainWindow,
                sendEvent,
                supervisor: () => supervisor,
            }),
            getRemoteDebugging: () => remoteDebuggingState(desktopProfile),
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
            onStartupFrame: (frame) => startupProfile.complete(frame),
            sshHost: (sender) => sshHostEnvironments?.route(sender),
            onEventsReady: (sender) => {
                if (workbenchWindows.keyOf(sender) === PRIMARY_WINDOW_KEY)
                    startupProfile.mark('rendererReady');
                // eslint-disable-next-line no-void -- replays the synchronous handshake once Server Core is attached
                void serverReady.promise.then(() => completeRendererHandshake(sender));
            },
            isWorkbenchSender: (sender) => workbenchWindows.isWorkbenchSender(sender),
            windowKey: (sender) => localPresence.keyOf(sender),
            companion: (sender) => companionWindowFor(sender, [agentCommander, benchmarkWindow]),
            transport: dispatchCommand,
        });
    }

    const sshHostWindowMenu = createSshHostWindowMenu(() => sshHostEnvironments);
    function installMenu(keybindings: Keybinding[]): void {
        const template = buildAppMenuTemplate({
            keybindings,
            dispatchCommand: dispatchWorkbenchCommand,
            openProcessExplorer: () => processExplorer.open(),
            ...agentCommanderMenuOptions(() => agentCommander),
            openBenchmark: () => benchmarkWindow?.open(),
            workbenchWindow: () => workbenchWindows.focusedOrPrimary(),
            isFollowingAppZoom: (window) =>
                isZoomingWithApp(window, [agentCommander, benchmarkWindow]),
            dispatchToSshHostWindow: sshHostWindowMenu.dispatch,
            focusWorkbench: () => {
                // eslint-disable-next-line no-void -- best effort: the command reaches the Workbench whether or not it came forward
                void focusMainWindow().catch(() => {});
            },
        });
        sshHostWindowMenu.setApplicationMenu(Menu.buildFromTemplate(template));
    }

    // Top-level await is unavailable in this bundle target, so the bootstrap sequence below is
    // deliberately fire-and-forget from module scope rather than awaited; `shouldContinueStartup`
    // and each awaited step already report their own failures.
    app.whenReady()
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        .then(async () => {
            setMainLanguage(null, [app.getLocale()]); // Dialogs shown before the first menu read follow the system.
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
            updateService = createDesktopUpdateService({
                currentVersion: caxriVersion,
                logger: () => mainLogger,
                sendEvent,
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
                    getAgentCommander: () => agentCommander,
                    getProcessExplorer: () => processExplorer,
                    getRemoteDebugging: () => remoteDebuggingState(desktopProfile),
                    getUpdateService: () => updateService,
                    getUserDataPath: () => desktopProfile.userDataPath,
                },
                userDataPath,
                zoomLevel: () => windowZoom.level(),
            });
            ({ agentCommander, benchmarkWindow, processExplorer } = createOnDemandWindows({
                currentDirectory,
                logger: mainLogger,
                mainWindow: () => mainWindow,
                sendEvent,
                supervisor,
                windowMode: e2eWindowMode,
                zoomLevel: () => windowZoom.level(),
            }));
            supervisor.onEvent(sendEvent);
            wirePowerWake(powerMonitor, () => (quitIntent = 'system-shutdown'), supervisor);
            installSignalQuitTriggers(quitTriggers);
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
                handleMainMethod,
                isPackaged: app.isPackaged,
                isSessionShown: (sessionId) => localPresence.isSessionShown(sessionId),
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
    installBeforeQuitTrigger(quitTriggers);
}
