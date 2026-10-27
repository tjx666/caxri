import os from 'node:os';
import process from 'node:process';

import type { AuxiliaryWindowState, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { app } from 'electron';

import { BenchmarkWindowController } from './benchmark-window';
import { CaxriBotWindowController } from './caxri-bot-window';
import {
    createSharedProcessReader,
    gpuRasterState,
    readServerProcess,
    summarizeProcesses,
} from './performance-monitor/metrics';
import { PerformanceMonitorWindowController } from './performance-monitor/window';
import { kilobytesToMegabytes, ProcessExplorerSampler } from './process-explorer';
import { ProcessExplorerWindowController } from './process-explorer-window';
import type { DesktopServerConnection } from './server-connection';
import type { E2EWindowMode } from './window-mode';
import type { CompanionRendererPolicy } from './workbench-ipc';

/**
 * Creates the controllers of Main's on-demand windows: Process Explorer, Performance Monitor, Caxri Bot, and Benchmark.
 * No window opens here; each controller creates its BrowserWindow on first `open()`.
 */
export function createOnDemandWindows(options: {
    currentDirectory: string;
    logger: StructuredLogger;
    mainWindow: () => BrowserWindow | undefined;
    sendEvent: (event: ServerEvent) => void;
    supervisor: DesktopServerConnection;
    windowMode: E2EWindowMode;
    zoomLevel: () => number;
}) {
    const { currentDirectory, supervisor, windowMode } = options;
    /**
     * The previous quit's combined bounds/open state, fetched at most once and shared by both controllers'
     * `loadWindowState`: each window only needs its own half, but they persist to one Server row (see
     * `auxiliaryWindowStateSchema`), so there is exactly one read here to match the one write below.
     */
    let auxiliaryWindowStatePromise: Promise<AuxiliaryWindowState> | undefined;
    const auxiliaryWindowState = (): Promise<AuxiliaryWindowState> =>
        (auxiliaryWindowStatePromise ??= supervisor.request('app.auxiliaryWindowState.get'));
    /**
     * Set right after Process Explorer's own construction below. Declared first only so Caxri Bot's `saveWindowState`
     * can fold in Process Explorer's half of the combined row without a circular `const` initializer; by the time
     * either `saveWindowState` actually runs (at quit), both controllers already exist.
     */
    let processExplorerState: () => AuxiliaryWindowState['processExplorer'] = () => ({});
    const caxriBot = new CaxriBotWindowController({
        currentDirectory,
        detachTerminal: (terminalId) => supervisor.request('terminal.detach', { terminalId }),
        isPackaged: app.isPackaged,
        loadWindowState: async () => (await auxiliaryWindowState()).caxriBot,
        logger: () => options.logger,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        /**
         * Folds in Process Explorer's own current state so one window's persistence never clobbers the other's half of
         * the combined row; see `ProcessExplorerWindowController.currentWindowState`.
         */
        saveWindowState: (state) =>
            supervisor.request('app.auxiliaryWindowState.update', {
                caxriBot: state,
                processExplorer: processExplorerState(),
            }),
        sendEvent: options.sendEvent,
        stopBot: () => supervisor.request('bot.stop'),
        windowMode,
        zoomLevel: options.zoomLevel,
    });
    const benchmark = new BenchmarkWindowController({
        currentDirectory,
        isPackaged: app.isPackaged,
        logger: () => options.logger,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        sendEvent: options.sendEvent,
        windowMode,
        zoomLevel: options.zoomLevel,
    });
    /**
     * One `getAppMetrics()` reading shared by Process Explorer and the Performance Monitor; see
     * `createSharedProcessReader` for why two independent readers would distort each other's CPU.
     */
    const readElectronProcesses = createSharedProcessReader(() =>
        app.getAppMetrics().map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            name: metric.name,
            serviceName: metric.serviceName,
            cpuPercent: metric.cpu.percentCPUUsage,
            memoryMb: kilobytesToMegabytes(metric.memory.workingSetSize),
        })),
    );
    const performanceMonitor: PerformanceMonitorWindowController =
        new PerformanceMonitorWindowController({
            currentDirectory,
            isPackaged: app.isPackaged,
            language: async () =>
                (await supervisor.request('settings.get')).value['workbench.language'],
            logger: options.logger,
            metrics: async (workbenchProcessId) => {
                const mainWindow = options.mainWindow();
                const serverPid = supervisor.serverProcessId();
                const server =
                    serverPid === undefined ? undefined : await readServerProcess(serverPid);
                return {
                    sampledAt: Date.now(),
                    gpuRaster: gpuRasterState(app.getGPUFeatureStatus()),
                    processes: summarizeProcesses(
                        readElectronProcesses(),
                        workbenchProcessId ??
                            (mainWindow && !mainWindow.isDestroyed()
                                ? mainWindow.webContents.getOSProcessId()
                                : undefined),
                        server,
                    ),
                };
            },
            rendererUrl: process.env.ELECTRON_RENDERER_URL,
            target: options.mainWindow,
            theme: async () => (await supervisor.request('theme.get')).value,
            windowMode,
            zoomLevel: options.zoomLevel,
        });
    const processExplorer: ProcessExplorerWindowController = new ProcessExplorerWindowController({
        currentDirectory,
        forceRenderError:
            process.env.CAXRI_E2E === '1' &&
            process.env.CAXRI_TEST_PROCESS_EXPLORER_RENDER_ERROR === '1',
        logger: options.logger,
        isPackaged: app.isPackaged,
        language: async () =>
            (await supervisor.request('settings.get')).value['workbench.language'],
        loadWindowState: async () => (await auxiliaryWindowState()).processExplorer,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        saveWindowState: (state) =>
            supervisor.request('app.auxiliaryWindowState.update', {
                caxriBot: caxriBot.currentWindowState(),
                processExplorer: state,
            }),
        sampler: new ProcessExplorerSampler({
            rootPid: process.pid,
            serverPid: () => supervisor.serverProcessId(),
            systemMemoryMb: () => kilobytesToMegabytes(os.totalmem() / 1024),
            terminals: async () => (await supervisor.request('terminal.processes', {})).terminals,
            /**
             * Resolved lazily at sample time: the diagnostics window is created on demand, so its renderer process does
             * not exist yet while this controller is being constructed.
             */
            rendererRoles: () => {
                const roles = new Map<number, string>();
                const mainWindow = options.mainWindow();
                const workbenchPid =
                    mainWindow && !mainWindow.isDestroyed()
                        ? mainWindow.webContents.getOSProcessId()
                        : undefined;
                if (workbenchPid !== undefined) roles.set(workbenchPid, 'workbench');
                const explorerPid = processExplorer.processId();
                if (explorerPid !== undefined) roles.set(explorerPid, 'process explorer');
                const botPid = caxriBot.processId();
                if (botPid !== undefined) roles.set(botPid, 'Caxri Bot');
                const benchmarkPid = benchmark.processId();
                if (benchmarkPid !== undefined) roles.set(benchmarkPid, 'benchmark');
                const monitorPid = performanceMonitor.processId();
                if (monitorPid !== undefined) roles.set(monitorPid, 'performance monitor');
                return roles;
            },
            electronProcesses: readElectronProcesses,
        }),
        stopTerminal: (terminalId) => supervisor.request('terminal.suspend', { terminalId }),
        theme: async () => (await supervisor.request('theme.get')).value,
        windowMode,
        zoomLevel: options.zoomLevel,
    });
    processExplorerState = () => processExplorer.currentWindowState();
    /**
     * Process Explorer loads no Workbench snapshot, so it hears about `workbench.language` from here. The event names
     * no key, so every settings change re-sends the current value.
     */
    supervisor.onEvent((event) => {
        if (event.event !== 'settings.changed') return;
        void processExplorer.refreshLanguage();
        void performanceMonitor.refreshLanguage();
    });
    performanceMonitor.installIpc();
    return { caxriBot, benchmarkWindow: benchmark, performanceMonitor, processExplorer };
}

/**
 * An optional window that shares the Workbench preload and Main's Desktop connection as a Workbench IPC companion.
 */
interface CompanionWindow {
    companion(): CompanionRendererPolicy;
    openWindow(): BrowserWindow | undefined;
    renderer(): WebContents | undefined;
}

/**
 * The companion policy of the optional window `sender` belongs to, or `undefined` when it is none of them.
 */
export function companionWindowFor(
    sender: WebContents,
    windows: ReadonlyArray<CompanionWindow | undefined>,
): CompanionRendererPolicy | undefined {
    return windows.find((window) => window?.renderer() === sender)?.companion();
}

/**
 * Whether `window` is one of the optional windows that zoom along with the Workbench's app-wide `window.zoomLevel`.
 */
export function isZoomingWithApp(
    window: BaseWindow,
    windows: ReadonlyArray<CompanionWindow | undefined>,
): boolean {
    return windows.some((candidate) => candidate?.openWindow() === window);
}
