import { useEffect } from 'react';

import { TooltipProvider } from '../../components/ui/tooltip';
import { useWorkbenchAppearance } from '../../hooks/use-workbench-appearance';
import { useTranslation } from '../../i18n';
import { queryClient } from '../../queries/client';
import { subscribeAgentChatPatches } from '../agent-chat/agent-chat-client';
import { ConfirmationDialog } from '../confirmations/confirmation-dialog';
import { ToastOutlet } from '../toasts/toast-outlet';
import { useWindowZoomFactor } from '../window-zoom/use-window-zoom-factor';
import { AgentCommanderHeader } from './agent-commander-header';
import { useCommanderBoardUiStore } from './commander-board-store';
import { CommanderBoardView } from './commander-board-view';
import { CommanderHandoverDialog } from './commander-handover-dialog';
import { CommanderInboxColumn } from './commander-inbox-column';
import { useCommanderShortcuts } from './commander-shortcuts';
import { CommanderTerminal } from './commander-terminal';
import { useAgentCommander } from './hooks/use-agent-commander';

/**
 * The Agent Commander window: the board of every Workbench Session on the left, the Commander's own Terminal in the
 * middle, and on the right the Inbox of what the Commander raised for the user ("Needs you"). The user can collapse the
 * board and hide the Inbox from the title bar, and the Terminal takes the freed width. It renders no Workbench chrome
 * and runs no Workbench commands; menu accelerators stay with the Workbench window, and the keyboard reaches only its
 * Terminal's own actions.
 */
export function AgentCommanderApp() {
    const { t } = useTranslation();
    const { retry, status } = useAgentCommander();
    useWorkbenchAppearance();
    useWindowZoomFactor();
    useCommanderShortcuts();
    // The Chat pane reads its projection from the query cache, which these patches keep current once it runs as a Chat.
    useEffect(() => subscribeAgentChatPatches(queryClient), []);
    const isBoardVisible = useCommanderBoardUiStore((state) => state.isVisible);
    return (
        <TooltipProvider>
            <div className="agent-commander flex h-screen w-screen flex-col bg-background text-foreground">
                <AgentCommanderHeader />
                <div className="relative flex min-h-0 flex-1">
                    {isBoardVisible && (
                        <aside
                            aria-label={t('agentCommander.window.sessionsLabel')}
                            className="agent-commander-board flex w-90 flex-none flex-col bg-surface"
                        >
                            <CommanderBoardView />
                        </aside>
                    )}
                    <main className="agent-commander-terminal relative min-h-0 min-w-0 flex-1">
                        <CommanderTerminal onRetry={retry} status={status} />
                    </main>
                    <CommanderInboxColumn />
                </div>
                <ConfirmationDialog />
                <CommanderHandoverDialog isFromWorkbench={false} />
                <ToastOutlet />
            </div>
        </TooltipProvider>
    );
}
