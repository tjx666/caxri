import os from 'node:os';
import process from 'node:process';

import type { AuxiliaryWindowState, ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { app } from 'electron';

import { AgentCommanderWindowController } from './agent-commander-window';
import { kilobytesToMegabytes, ProcessExplorerSampler } from './process-explorer';
import { ProcessExplorerWindowController } from './process-explorer-window';
import type { DesktopServerConnection } from './server-connection';
import type { E2EWindowMode } from './window-mode';

/**
 * Creates the controllers of Main's on-demand windows: Process Explorer and the Agent Commander. Neither window opens
 * here; each controller creates its BrowserWindow on first `open()`.
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
     * Set right after Process Explorer's own construction below. Declared first only so the Agent Commander's
     * `saveWindowState` can fold in Process Explorer's half of the combined row without a circular `const` initializer;
     * by the time either `saveWindowState` actually runs (at quit), both controllers already exist.
     */
    let processExplorerState: () => AuxiliaryWindowState['processExplorer'] = () => ({});
    const agentCommander = new AgentCommanderWindowController({
        currentDirectory,
        detachTerminal: (terminalId) => supervisor.request('terminal.detach', { terminalId }),
        isPackaged: app.isPackaged,
        loadWindowState: async () => (await auxiliaryWindowState()).agentCommander,
        logger: () => options.logger,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        /**
         * Folds in Process Explorer's own current state so one window's persistence never clobbers the other's half of
         * the combined row; see `ProcessExplorerWindowController.currentWindowState`.
         */
        saveWindowState: (state) =>
            supervisor.request('app.auxiliaryWindowState.update', {
                agentCommander: state,
                processExplorer: processExplorerState(),
            }),
        sendEvent: options.sendEvent,
        stopCommander: () => supervisor.request('commander.stop'),
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
        loadWindowState: async () => (await auxiliaryWindowState()).processExplorer,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        saveWindowState: (state) =>
            supervisor.request('app.auxiliaryWindowState.update', {
                agentCommander: agentCommander.currentWindowState(),
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
                const commanderPid = agentCommander.processId();
                if (commanderPid !== undefined) roles.set(commanderPid, 'agent commander');
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
        stopTerminal: (terminalId) => supervisor.request('terminal.suspend', { terminalId }),
        theme: async () => (await supervisor.request('theme.get')).value,
        windowMode,
        zoomLevel: options.zoomLevel,
    });
    processExplorerState = () => processExplorer.currentWindowState();
    return { agentCommander, processExplorer };
}
