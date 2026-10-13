import { useEffect } from 'react';

import { TooltipProvider } from '../../components/ui/tooltip';
import { useWorkbenchAppearance } from '../../hooks/use-workbench-appearance';
import { useTranslation } from '../../i18n';
import { queryClient } from '../../queries/client';
import { subscribeAgentChatPatches } from '../agent-chat/agent-chat-client';
import { ConfirmationDialog } from '../confirmations/confirmation-dialog';
import { ToastOutlet } from '../toasts/toast-outlet';
import { useWindowZoomFactor } from '../window-zoom/use-window-zoom-factor';
import { PanelDivider } from '../workbench/panel-divider';
import { AgentCommanderHeader } from './agent-commander-header';
import {
    COMMANDER_BOARD_DEFAULT_WIDTH,
    COMMANDER_BOARD_MAX_WIDTH,
    COMMANDER_BOARD_MIN_WIDTH,
    setCommanderBoardWidth,
    useCommanderBoardUiStore,
} from './commander-board-store';
import { CommanderBoardView } from './commander-board-view';
import { CommanderClearDataDialog } from './commander-clear-data-dialog';
import { CommanderCommandPalette } from './commander-command-palette';
import { CommanderHandoverDialog } from './commander-handover-dialog';
import { CommanderInboxColumn } from './commander-inbox-column';
import { useCommanderShortcuts } from './commander-shortcuts';
import { CommanderTerminal } from './commander-terminal';
import { useAgentCommander } from './hooks/use-agent-commander';

/**
 * The Agent Commander window: the board of every Workbench Session on the left, the Commander's own Terminal in the
 * middle, and on the right the Inbox of what the Commander raised for the user ("Needs you"). The user can collapse the
 * board and hide the Inbox from the title bar, and the Terminal takes the freed width. It renders no Workbench chrome
 * and runs no Workbench commands. Its own Command Palette (`Cmd+Shift+P`, which Desktop Main forwards here while this
 * window is focused) holds the window's actions, Clear Commander Data among them; every other menu accelerator stays
 * with the Workbench window, and the keyboard otherwise reaches only its Terminal's own actions.
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
    const boardWidth = useCommanderBoardUiStore((state) => state.width);
    useEffect(() => {
        document.documentElement.style.setProperty('--commander-board-width', `${boardWidth}px`);
    }, [boardWidth]);
    return (
        <TooltipProvider>
            <div className="agent-commander flex h-screen w-screen flex-col bg-background text-foreground">
                <AgentCommanderHeader />
                <div className="relative flex min-h-0 flex-1">
                    {isBoardVisible && (
                        <>
                            <aside
                                aria-label={t('agentCommander.window.sessionsLabel')}
                                className="agent-commander-board flex w-[var(--commander-board-width,360px)] flex-none flex-col bg-surface"
                            >
                                <CommanderBoardView />
                            </aside>
                            {/* The same seam as the Inbox column's: drag, arrow keys, and a double-click reset. */}
                            <div className="flex flex-none">
                                <PanelDivider
                                    ariaLabel={t('agentCommander.window.resizeSessions')}
                                    size={boardWidth}
                                    min={COMMANDER_BOARD_MIN_WIDTH}
                                    max={COMMANDER_BOARD_MAX_WIDTH}
                                    defaultSize={COMMANDER_BOARD_DEFAULT_WIDTH}
                                    cssVariable="--commander-board-width"
                                    growDirection={1}
                                    orientation="vertical"
                                    onCommit={setCommanderBoardWidth}
                                />
                            </div>
                        </>
                    )}
                    <main className="agent-commander-terminal relative min-h-0 min-w-0 flex-1">
                        <CommanderTerminal onRetry={retry} status={status} />
                    </main>
                    <CommanderInboxColumn />
                </div>
                <ConfirmationDialog />
                <CommanderHandoverDialog isFromWorkbench={false} />
                <CommanderCommandPalette />
                <CommanderClearDataDialog />
                <ToastOutlet />
            </div>
        </TooltipProvider>
    );
}
