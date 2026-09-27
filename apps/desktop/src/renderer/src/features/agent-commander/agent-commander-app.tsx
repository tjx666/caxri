import { Power } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip, TooltipProvider } from '../../components/ui/tooltip';
import { useWorkbenchAppearance } from '../../hooks/use-workbench-appearance';
import { ConfirmationDialog } from '../confirmations/confirmation-dialog';
import { ToastOutlet } from '../toasts/toast-outlet';
import { CommanderBoardView } from './commander-board-view';
import { useAgentCommanderStore } from './commander-client';
import { stopCommander } from './commander-commands';
import { CommanderTerminal } from './commander-terminal';
import { useAgentCommander } from './use-agent-commander';

/**
 * The Agent Commander window: the board of every Workbench Session on the left, the Commander's own Terminal on the
 * right. It renders no Workbench chrome and runs no global commands; menu accelerators stay with the Workbench window.
 */
export function AgentCommanderApp() {
    const { retry, status } = useAgentCommander();
    useWorkbenchAppearance();
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
 * The window's whole title bar, and its drag region. `pl-[78px]` clears the macOS `hiddenInset` traffic lights, the
 * same clearance the Workbench's collapsed header uses.
 */
function AgentCommanderHeader() {
    const workspacePath = useAgentCommanderStore((state) => state.workspacePath);
    return (
        <header className="agent-commander-header flex h-11 flex-none items-center gap-2 bg-surface pr-3 pl-[78px] [-webkit-app-region:drag]">
            <h1 className="m-0 flex-none text-[13px] font-medium">Agent Commander</h1>
            {workspacePath && (
                <span
                    className="overflow-fade min-w-0 text-[12px] text-muted"
                    title={workspacePath}
                >
                    {workspacePath}
                </span>
            )}
            <Tooltip content="Stop the Commander and close this window. Tasks it delegated keep running, and opening it again resumes the same conversation.">
                <Button
                    variant="ghost"
                    size="sm"
                    className="agent-commander-stop ml-auto flex-none text-muted [-webkit-app-region:no-drag]"
                    onClick={stopCommander}
                >
                    <Power size={13} />
                    Stop
                </Button>
            </Tooltip>
        </header>
    );
}
