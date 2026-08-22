import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import type { WebContents } from 'electron';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';

import type { CommandAdapter } from '../shared/ipc/dispatcher';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { CaxriRequest } from '../shared/ipc/methods';
import { isMainRequest } from '../shared/ipc/methods';
import { readE2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { logEventCatalog, StructuredLogger } from '../shared/node/logger';
import { installProcessErrorMonitor } from '../shared/node/process-error-monitor';
import type { PersistedWindowState } from '../shared/types';
import { resolveDevelopmentDockIconPath } from './app-icon';
import { consoleErrorLogFields } from './console-error-fields';
import { decideCrashRecovery } from './crash-policy';
import { createDesktopOperationHandler } from './desktop-operations';
import { createMainEventRelay } from './event-relay';
import { launchExternalEditor } from './external-editor';
import { applyGpuStabilityWorkarounds } from './gpu-stability';
import { DesktopHostConnection, resolveDesktopLaunch } from './host-connection';
import { shouldContinueStartup } from './host-startup';
import { createElectronIpcCommandAdapter } from './ipc-command-adapter';
import { resolveLogLevel } from './log-level';
import { createMainMethodHandler } from './main-methods';
import { buildAppMenuTemplate } from './menu';
import { kilobytesToMegabytes, ProcessExplorerSampler } from './process-explorer';
import { ProcessExplorerWindowController } from './process-explorer-window';
import { loadRendererEntry } from './renderer-entry';
import { RendererReadiness } from './renderer-readiness';
import { ProjectRootGrants } from './root-grants';
import {
    configureRuntimeProfile,
    hasProfileSingleInstanceLock,
    installSecondInstanceFocus,
} from './runtime-profile';
import { createTestRootPathResolver } from './test-root';
import { shouldStartAutomaticUpdateCheck, UpdateService, updateStateLogFields } from './updates';
import { createWindowCloseHandler } from './window-close';
import { resolveE2EWindowMode } from './window-mode';
import { installWorkbenchIpc } from './workbench-ipc';
import { createWorkbenchRootAuthority } from './workbench-root-authority';

const bootStartedAt = performance.now();
const currentDirectory = dirname(fileURLToPath(import.meta.url));
/**
 * Stamps these before logging so Host and Desktop records correlate to this build; see `global.d.ts` and
 * `electron.vite.config.ts` for the injected constants.
 */
const caxriVersion = typeof __CAXRI_VERSION__ === 'string' ? __CAXRI_VERSION__ : 'unknown';
process.env.CAXRI_APP_VERSION = caxriVersion;
process.env.CAXRI_GIT_COMMIT = typeof __CAXRI_COMMIT__ === 'string' ? __CAXRI_COMMIT__ : 'unknown';
/**
 * Work around macOS deriving the native application-menu name from Electron's development process title.
 * `app.setName()` only changes Electron's internal name, so keep this unsupported behavior limited to unpackaged macOS
 * launches until Electron exposes a development-host naming API.
 *
 * @see https://www.electronjs.org/docs/latest/api/app#appsetnamename
 */
if (process.platform === 'darwin' && !app.isPackaged) process.title = 'Caxri Dev';
// Must settle before Chromium, logging, Host attachment, or the single-instance lock captures launch identity.
const runtimeProfile = configureRuntimeProfile(app, process.env);
// Chromium switches must be appended before `app.whenReady()`.
applyGpuStabilityWorkarounds(app.commandLine, process.platform);
const ownsProfileInstance = hasProfileSingleInstanceLock(app, runtimeProfile);
if (!ownsProfileInstance) app.quit();

// Scoped in a bare block (rather than left at module top level) so the mutable Desktop bootstrap
// state below is a block-scoped variable, not a Program-scope one: the lifecycle callbacks that
// mutate it genuinely need module-lifetime shared state, and this keeps each variable's storage
// out of `unicorn/no-top-level-assignment-in-function`'s reach without changing any read/write site.
if (ownsProfileInstance) {
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
    let isForceWindowClose = false;
    let isQuitStarted = false;
    let isAutomaticUpdateCheckStarted = false;
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
        // `onKeybindingsChanged` is a synchronous listener; a failed menu rebuild is not user-actionable
        // here, so this is deliberately fire-and-forget rather than awaited.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        onKeybindingsChanged: () => installMenu().catch(() => {}),
    });
    function createMainLogger(): StructuredLogger {
        return new StructuredLogger(
            runtimeProfile.logDirectory,
            'main',
            resolveLogLevel({ isPackaged: app.isPackaged }),
        );
    }
    function sendEvent(event: RuntimeEvent): void {
        eventRelay.send(event);
    }
    function createWindow(initialState: PersistedWindowState): BrowserWindow {
        const window = new BrowserWindow({
            ...initialState.bounds,
            minWidth: 960,
            minHeight: 640,
            title: 'Caxri',
            /**
             * Deliberately a literal, and the one color literal left in the app: it paints the window before any
             * renderer CSS exists, which is what prevents a white flash on launch. It mirrors the default theme's
             * `--background`; an imported theme cannot change it.
             */
            backgroundColor: '#282a36',
            /**
             * No title bar row: the primarySidebar header is the drag region and carries the brand instead. `title`
             * stays for VoiceOver and Mission Control, which still read the window title.
             */
            titleBarStyle: 'hiddenInset',
            /**
             * Centers the 12px macOS traffic lights in the Renderer's 44px drag header.
             */
            trafficLightPosition: { x: 15, y: 15 },
            show: false,
            webPreferences: {
                preload: join(currentDirectory, '../preload/index.cjs'),
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        eventRelay.rendererPending();
        rendererReadiness.track(window.webContents);
        window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame) eventRelay.rendererPending();
        });
        let persistTimer: NodeJS.Timeout | undefined;
        let rendererCrashTimestampsMs: number[] = [];
        const persistWindowState = (): void => {
            /**
             * `before-quit` performs the final ordered write before Runtime shutdown.
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
        if (initialState.isMaximized) window.maximize();
        /**
         * `setFullScreen(true)` here fires `enter-full-screen` synchronously, before `mainWindow` is assigned by the
         * caller (it's only set once `createWindow` returns), so the module-level `sendEvent`/`mainWindow` path can't
         * be used for this push. `did-finish-load` covers the matching case where the Renderer loads (or
         * reloads/crash-recovers) while already fullscreen, so it observes the current state instead of missing the
         * one-shot restore event above.
         */
        if (initialState.isFullScreen) window.setFullScreen(true);
        mainLogger?.write('info', logEventCatalog.window.created);
        window.webContents.on('did-finish-load', sendFullScreenState);
        window.once('ready-to-show', () => {
            mainLogger?.write('info', logEventCatalog.window.readyToShow, {
                durationMs: performance.now() - bootStartedAt,
            });
            if (e2eWindowMode === 'visible') window.show();
            if (
                shouldStartAutomaticUpdateCheck({
                    alreadyStarted: isAutomaticUpdateCheckStarted,
                    isE2E: process.env.CAXRI_E2E === '1',
                    isPackaged: app.isPackaged,
                })
            ) {
                isAutomaticUpdateCheckStarted = true;
                /**
                 * Update discovery stays off the awaited startup path and never delays the first window;
                 * `updateService.check()` already publishes failures through its own state, so this is deliberately
                 * fire-and-forget rather than awaited.
                 */
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
                updateService.check().catch(() => {});
            }
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
            if (details.level !== 'error') return;
            mainLogger?.write('error', logEventCatalog.renderer.consoleError, {
                fields: consoleErrorLogFields(details),
            });
        });
        window.webContents.on('preload-error', () => {
            mainLogger?.write('error', logEventCatalog.renderer.preloadError, {
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
                mainLogger?.write('warn', logEventCatalog.window.renderProcessGone, {
                    fields: {
                        code: 'RENDER_PROCESS_GONE',
                        reason: details.reason,
                        exitCode: details.exitCode,
                        crashCount: decision.crashCount,
                        delayMs: decision.delayMs ?? 0,
                    },
                });
                setTimeout(() => {
                    if (!window.isDestroyed()) window.reload();
                }, decision.delayMs);
                return;
            }
            mainLogger?.write('error', logEventCatalog.window.renderProcessCrashLoop, {
                fields: {
                    code: 'RENDER_PROCESS_CRASH_LOOP',
                    reason: details.reason,
                    exitCode: details.exitCode,
                    crashCount: decision.crashCount,
                },
            });
            // `render-process-gone` is a synchronous listener; recovering from a repeated crash by
            // relaunching or exiting cannot block this handler, so the recovery flow below is
            // deliberately fire-and-forget rather than awaited.
            (async () => {
                const result = await dialog.showMessageBox(window, {
                    type: 'error',
                    title: 'Caxri Keeps Crashing',
                    message:
                        'The Caxri window has crashed repeatedly and automatic reload stopped.',
                    detail: 'Relaunch Caxri, or quit to investigate.',
                    buttons: ['Relaunch', 'Quit'],
                    defaultId: 0,
                    cancelId: 1,
                });
                try {
                    await supervisor.shutdown();
                } catch {
                    // Best-effort shutdown; the window still needs to relaunch or exit below.
                }
                if (result.response === 0) app.relaunch();
                app.exit(0);
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
            })().catch(() => {});
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
                    detail: 'Keeping them running leaves the Caxri Host active without a window. Quit Desktop disconnects the window but does not stop the Host.',
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
    async function openMainWindow(): Promise<void> {
        if (mainWindow) return;
        let initialState: PersistedWindowState;
        try {
            initialState = await supervisor.request('app.windowState.get');
        } catch {
            initialState = {
                bounds: { width: 1440, height: 900 },
                isMaximized: false,
                isFullScreen: false,
            };
        }
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

    const secondInstanceFocus = installSecondInstanceFocus(
        app,
        async () => {
            await focusMainWindow();
            mainLogger?.write('info', logEventCatalog.app.secondInstanceFocused, {
                fields: { profileId: runtimeProfile.id },
            });
        },
        (error) =>
            mainLogger?.write('error', logEventCatalog.app.secondInstanceFocusFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            }),
    );

    const handleHostDesktopOperation = createDesktopOperationHandler({
        focus: async () => {
            await focusMainWindow();
        },
        open: (target) =>
            sendEvent({
                event: 'desktop.openRequested',
                payload: {
                    sessionId: target.sessionId,
                    kind: target.kind,
                    ...(target.kind === 'file' && { path: target.path }),
                },
            }),
        openInEditor: async (path) => {
            const settings = await supervisor.request('settings.get');
            await launchExternalEditor(settings.value['workbench.externalEditor'], path);
        },
        reveal: (path) => shell.showItemInFolder(path),
        status: () => (mainWindow && !mainWindow.isDestroyed() ? 'window' : 'background'),
    });

    const handleMainMethod = createMainMethodHandler({
        getProcessExplorer: () => processExplorer,
        getUserDataPath: () => runtimeProfile.userDataPath,
        getSupervisor: () => supervisor,
        getUpdateService: () => updateService,
        getWindow: () => mainWindow,
        workbenchRootAuthority,
    });

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
                        throw new CaxriError(
                            'INTERNAL',
                            'Host command reached the Desktop adapter',
                        );
                    return handleMainMethod(request);
                }) satisfies CommandAdapter['invoke'],
            },
        });
        installWorkbenchIpc({
            isQuitting: () => isQuitStarted,
            logger: () => mainLogger,
            onEventsReady: () => {
                eventRelay.rendererReady();
                if (mainRenderer) rendererReadiness.ready(mainRenderer);
                // `onEventsReady` is a synchronous listener; a failed readiness handshake is only
                // logged, so this is deliberately fire-and-forget rather than awaited.
                // eslint-disable-next-line unicorn/prefer-await -- see comment above
                supervisor.markDesktopReady().catch((error: unknown) =>
                    mainLogger?.write('error', logEventCatalog.host.desktopReadyFailed, {
                        fields: { error: errorMessage(error, 'unknown') },
                    }),
                );
            },
            renderer: () => mainRenderer,
            transport: dispatchCommand,
        });
    }

    async function loadKeybindings() {
        try {
            return (await supervisor.request('keybindings.get')).value;
        } catch {
            return [];
        }
    }

    async function installMenu(): Promise<void> {
        const keybindings = await loadKeybindings();
        Menu.setApplicationMenu(
            Menu.buildFromTemplate(
                buildAppMenuTemplate({
                    keybindings,
                    dispatchCommand: (command, isViaAccelerator) =>
                        sendEvent({
                            event: 'command.execute',
                            payload: { command, viaAccelerator: isViaAccelerator },
                        }),
                    openProcessExplorer: () => processExplorer.open(),
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
            const developmentDockIconPath = resolveDevelopmentDockIconPath({
                currentDirectory,
                isPackaged: app.isPackaged,
            });
            if (developmentDockIconPath && app.dock) app.dock.setIcon(developmentDockIconPath);
            const { userDataPath, logDirectory } = runtimeProfile;
            const logLevel = resolveLogLevel({ isPackaged: app.isPackaged });
            mainLogger ??= new StructuredLogger(logDirectory, 'main', logLevel);
            processErrorMonitor.attach(mainLogger);
            mainLogger.write('info', logEventCatalog.app.ready, {
                durationMs: performance.now() - bootStartedAt,
                fields: {
                    profileId: runtimeProfile.id,
                    profileKind: runtimeProfile.kind,
                    remoteDebuggingPort:
                        runtimeProfile.remoteDebugging.transport === 'port'
                            ? runtimeProfile.remoteDebugging.port
                            : null,
                    remoteDebuggingTransport: runtimeProfile.remoteDebugging.transport,
                },
            });
            if (process.env.CAXRI_E2E === '1') {
                mainLogger.write('info', logEventCatalog.e2e.launch, {
                    fields: {
                        agentMode: e2eAgentPolicy?.mode ?? 'blocked',
                        agentProvider:
                            e2eAgentPolicy?.mode === 'real'
                                ? e2eAgentPolicy.provider
                                : e2eAgentPolicy?.mode === 'fake'
                                  ? Object.keys(e2eAgentPolicy.executables)
                                        .toSorted((left, right) => left.localeCompare(right))
                                        .join(',')
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
                        mainLogger?.write(
                            state.status === 'error' ? 'error' : 'info',
                            logEventCatalog.updates.state,
                            { fields: updateStateLogFields(state) },
                        );
                    sendEvent({ event: 'updates.state', payload: state });
                },
            });
            supervisor = new DesktopHostConnection({
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
                     * Resolved lazily at sample time: the diagnostics window is created on demand, so its renderer
                     * process does not exist yet while this controller is being constructed.
                     */
                    rendererRoles: () => {
                        const roles = new Map<number, string>();
                        const workbenchPid =
                            mainWindow && !mainWindow.isDestroyed()
                                ? mainWindow.webContents.getOSProcessId()
                                : undefined;
                        if (workbenchPid !== undefined) roles.set(workbenchPid, 'workbench');
                        const explorerPid = processExplorer.processId();
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
                theme: async () => (await supervisor.request('theme.get')).value,
                windowMode: e2eWindowMode,
            });
            supervisor.onEvent(sendEvent);
            if (
                !(await shouldContinueStartup({
                    dialog,
                    logger: mainLogger,
                    quit: () => app.quit(),
                    supervisor,
                }))
            )
                return;
            installIpc();
            processExplorer.installIpc();
            await installMenu();
            await openMainWindow();
            secondInstanceFocus.ready();
        })
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        .catch(() => {});
    // GPU/utility-process exits never reach `render-process-gone`; log them so GPU-backend crashes
    // (e.g. the Skia Graphite issue behind `applyGpuStabilityWorkarounds`) are diagnosable from logs.
    app.on('child-process-gone', (_event, details) => {
        if (details.reason === 'clean-exit') return;
        mainLogger?.write('error', logEventCatalog.app.childProcessGone, {
            fields: {
                code: 'CHILD_PROCESS_GONE',
                type: details.type,
                reason: details.reason,
                exitCode: details.exitCode,
                ...(details.name && { name: details.name }),
            },
        });
    });

    app.on('activate', () => {
        // `activate` is a synchronous listener; a failed reopen is not user-actionable here, so this
        // is deliberately fire-and-forget rather than awaited.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        if (!mainWindow) openMainWindow().catch(() => {});
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
        // macOS keeps the Desktop client alive; the Host-owned Runtime survives either way.
    });

    app.on('before-quit', (event) => {
        if (isQuitStarted) return;
        event.preventDefault();
        isQuitStarted = true;
        mainLogger?.write('info', logEventCatalog.app.quitRequested);
        // `before-quit` is a synchronous listener; the shutdown sequence below must not block it, so
        // it runs fire-and-forget and unconditionally exits the process once it settles.
        (async () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                try {
                    await supervisor.request('app.windowState.update', readWindowState(mainWindow));
                } catch {
                    // Best-effort persistence; quitting must proceed regardless.
                }
            }
            try {
                await supervisor.request('terminal.detachAll');
            } catch {
                // Best-effort detach; quitting must proceed regardless.
            }
            try {
                await supervisor.shutdown();
            } catch {
                // Best-effort shutdown; the process still needs to exit below.
            }
            app.exit(0);
            // eslint-disable-next-line unicorn/prefer-await -- see comment above
        })().catch(() => app.exit(0));
    });
}
