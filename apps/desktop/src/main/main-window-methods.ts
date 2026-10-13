import type { MainRequest, SettingsTarget } from '@caxri/protocol';

import type { AgentCommanderWindowController } from './agent-commander-window';
import type { BenchmarkWindowController } from './benchmark-window';
import type { ProcessExplorerWindowController } from './process-explorer-window';

/**
 * The optional windows Main opens on request, and the Workbench hand-offs the Agent Commander window uses.
 */
export interface MainWindowMethodOptions {
    getProcessExplorer(): ProcessExplorerWindowController;
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
}

const WINDOW_METHODS = [
    'agentCommander.open',
    'agentCommander.openSettings',
    'agentCommander.revealSession',
    'agentCommander.stop',
    'benchmark.open',
    'processExplorer.open',
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
): Promise<null> {
    switch (request.method) {
        case 'processExplorer.open':
            options.getProcessExplorer().open();
            return null;
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
        case 'agentCommander.openSettings':
            await options.openSettingsInWorkbench(request.params.target);
            return null;
    }
}
