import { useEffect } from 'react';

import { Power } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip, TooltipProvider } from '../../components/ui/tooltip';
import { useWorkbenchAppearance } from '../../hooks/use-workbench-appearance';
import { queryClient } from '../../queries/client';
import { useTerminal } from '../../stores/selectors';
import { subscribeAgentChatPatches } from '../agent-chat/agent-chat-client';
import { ConfirmationDialog } from '../confirmations/confirmation-dialog';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { canSwitchTerminalSurface } from '../terminal/terminal-surface-commands';
import { ToastOutlet } from '../toasts/toast-outlet';
import { useWindowZoomFactor } from '../window-zoom/use-window-zoom-factor';
import { CommanderBoardView } from './commander-board-view';
import { useAgentCommanderStore } from './commander-client';
import { stopCommander } from './commander-commands';
import { useCommanderShortcuts } from './commander-shortcuts';
import { CommanderTerminal } from './commander-terminal';
import { useAgentCommander } from './use-agent-commander';

/**
 * The Agent Commander window: the board of every Workbench Session on the left, the Commander's own Terminal on the
 * right. It renders no Workbench chrome and runs no Workbench commands; menu accelerators stay with the Workbench
 * window, and the keyboard reaches only its Terminal's own actions.
 */
export function AgentCommanderApp() {
    const { retry, status } = useAgentCommander();
    useWorkbenchAppearance();
    useWindowZoomFactor();
    useCommanderShortcuts();
    // The Chat pane reads its projection from the query cache, which these patches keep current once it runs as a Chat.
    useEffect(() => subscribeAgentChatPatches(queryClient), []);
    return (
        <TooltipProvider>
            <div className="agent-commander flex h-screen w-screen flex-col bg-background text-foreground">
                <AgentCommanderHeader />
                <div className="flex min-h-0 flex-1">
                    <aside
                        aria-label="Sessions"
                        className="agent-commander-board flex w-90 flex-none flex-col bg-surface"
                    >
                        <CommanderBoardView />
                    </aside>
                    <main className="agent-commander-terminal relative min-h-0 min-w-0 flex-1">
                        <CommanderTerminal onRetry={retry} status={status} />
                    </main>
                </div>
                <ConfirmationDialog />
                <ToastOutlet />
            </div>
        </TooltipProvider>
    );
}

/**
 * The window's whole title bar, and its drag region. Its left padding clears the macOS `hiddenInset` traffic lights,
 * the same zoom-aware clearance the Workbench's collapsed header uses. The Workbench tab rail's `Terminal | Chat`
 * switch sits beside Stop, so the Commander opens as either surface with the same control and shortcut.
 */
function AgentCommanderHeader() {
    const workspacePath = useAgentCommanderStore((state) => state.workspacePath);
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    return (
        <header className="agent-commander-header flex h-11 flex-none items-center gap-2 bg-surface pr-3 pl-(--traffic-light-clearance) [-webkit-app-region:drag]">
            <h1 className="m-0 flex-none text-[13px] font-medium">Agent Commander</h1>
            {workspacePath && (
                <span
                    className="overflow-fade min-w-0 text-[12px] text-muted"
                    title={workspacePath}
                >
                    {workspacePath}
                </span>
            )}
            <div className="ml-auto flex flex-none items-center gap-2 [-webkit-app-region:no-drag]">
                {terminal && canSwitchTerminalSurface(terminal) && (
                    <AgentSurfaceToggle terminal={terminal} />
                )}
                <Tooltip content="Stop the Commander and close this window. Tasks it delegated keep running, and opening it again resumes the same conversation.">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="agent-commander-stop text-muted"
                        onClick={stopCommander}
                    >
                        <Power size={13} />
                        Stop
                    </Button>
                </Tooltip>
            </div>
        </header>
    );
}
