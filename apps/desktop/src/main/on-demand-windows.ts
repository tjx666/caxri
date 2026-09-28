import process from 'node:process';

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
    supervisor: DesktopServerConnection;
    windowMode: E2EWindowMode;
    zoomLevel: () => number;
}) {
    const { currentDirectory, supervisor, windowMode } = options;
    const agentCommander = new AgentCommanderWindowController({
        currentDirectory,
        detachTerminal: (terminalId) => supervisor.request('terminal.detach', { terminalId }),
        isPackaged: app.isPackaged,
        logger: () => options.logger,
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
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
        rendererUrl: process.env.ELECTRON_RENDERER_URL,
        sampler: new ProcessExplorerSampler({
            rootPid: process.pid,
            serverPid: () => supervisor.serverProcessId(),
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
        theme: async () => (await supervisor.request('theme.get')).value,
        windowMode,
    });
    return { agentCommander, processExplorer };
}
