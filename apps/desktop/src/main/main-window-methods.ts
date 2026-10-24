import type { MainRequest, PerformanceMonitorMetrics, SettingsTarget } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentCommanderWindowController } from './agent-commander-window';
import type { BenchmarkWindowController } from './benchmark-window';
import type { PerformanceMonitorWindowController } from './performance-monitor/window';
import type { ProcessExplorerWindowController } from './process-explorer-window';
import type { WindowPresenceRegistry } from './window-presence-registry';
import { currentRequestWindowKey } from './window-presence-registry';

/**
 * The optional windows Main opens on request, and the Workbench hand-offs the Agent Commander window uses.
 */
export interface MainWindowMethodOptions {
    getProcessExplorer(): ProcessExplorerWindowController;
    /**
     * Absent in an SSH Host window and in handler tests that do not exercise the monitor.
     */
    getPerformanceMonitor?(): PerformanceMonitorWindowController | undefined;
    /**
     * The Renderer process of the Workbench window making the current request; the in-window monitor reports that one.
     */
    requestWorkbenchProcessId?(): number | undefined;
    getAgentCommander(): AgentCommanderWindowController | undefined;
    /**
     * Absent in an SSH Host window, which has no Benchmark window of its own.
     */
    getBenchmarkWindow?(): BenchmarkWindowController | undefined;
    /**
     * Selects a Session in the Workbench and raises the main window; used by the Agent Commander board.
     */
    revealSessionInWorkbench(sessionId: string): Promise<void>;
    /**
     * Raises the Workbench, reopening it if needed, and opens Settings there; used by the Agent Commander window, which
     * has no Settings of its own. An optional `target` scrolls Settings to one specific row instead of its default
     * view.
     */
    openSettingsInWorkbench(target?: SettingsTarget): Promise<void>;
    /**
     * Where a Workbench window's reported Session goes. Absent in handler tests that do not exercise presence.
     */
    windowPresence?: Pick<WindowPresenceRegistry, 'setViewing'>;
    /**
     * Opens a Session in a new window for the calling window; see `createTearOffController`. Absent in an SSH Host
     * window, which is a single window.
     */
    tearOffSession?(input: { sourceKey: string; sessionId: string }): Promise<{ opened: boolean }>;
}

const WINDOW_METHODS = [
    'agentCommander.open',
    'agentCommander.openSettings',
    'agentCommander.revealSession',
    'agentCommander.stop',
    'benchmark.open',
    'performanceMonitor.metrics',
    'performanceMonitor.window',
    'processExplorer.open',
    'window.reportViewing',
    'window.tearOffSession',
] as const;

type WindowRequest = Extract<MainRequest, { method: (typeof WINDOW_METHODS)[number] }>;

export function isWindowRequest(request: MainRequest): request is WindowRequest {
    return (WINDOW_METHODS as readonly string[]).includes(request.method);
}

/**
 * Opens, raises, or stops an optional window, or hands the Agent Commander's request over to the Workbench.
 */
export async function handleWindowRequest(
    request: WindowRequest,
    options: MainWindowMethodOptions,
): Promise<PerformanceMonitorMetrics | { opened: boolean } | null> {
    switch (request.method) {
        case 'processExplorer.open':
            options.getProcessExplorer().open();
            return null;
        case 'performanceMonitor.metrics': {
            const monitor = options.getPerformanceMonitor?.();
            if (!monitor)
                throw new CaxriError('FORBIDDEN', 'The Performance Monitor is not available here');
            return monitor.readMetrics(options.requestWorkbenchProcessId?.());
        }
        case 'performanceMonitor.window': {
            const monitor = options.getPerformanceMonitor?.();
            if (request.params.action === 'open') monitor?.open();
            else if (request.params.action === 'close') monitor?.close();
            else monitor?.toggle();
            return null;
        }
        case 'agentCommander.open':
            options.getAgentCommander()?.open(request.params.target);
            return null;
        case 'benchmark.open':
            options.getBenchmarkWindow?.()?.open();
            return null;
        case 'agentCommander.stop':
            await options.getAgentCommander()?.stop();
            return null;
        case 'agentCommander.revealSession':
            await options.revealSessionInWorkbench(request.params.sessionId);
            return null;
        case 'window.reportViewing': {
            const windowKey = currentRequestWindowKey();
            if (!windowKey)
                throw new CaxriError(
                    'FORBIDDEN',
                    'Only a Workbench window reports the Session it shows',
                );
            options.windowPresence?.setViewing(windowKey, request.params.viewingSessionId);
            return null;
        }
        case 'window.tearOffSession': {
            const sourceKey = currentRequestWindowKey();
            if (!sourceKey || !options.tearOffSession)
                throw new CaxriError('FORBIDDEN', 'Only a Workbench window can tear off a Session');
            return options.tearOffSession({ sourceKey, ...request.params });
        }
        case 'agentCommander.openSettings':
            await options.openSettingsInWorkbench(request.params.target);
            return null;
    }
}
