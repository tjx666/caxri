import { useEffect } from 'react';

import { TooltipProvider } from '../../components/ui/tooltip';
import { useWorkbenchAppearance } from '../../hooks/use-workbench-appearance';
import { useTranslation } from '../../i18n';
import { queryClient } from '../../queries/client';
import { subscribeAgentChatPatches } from '../agent-chat/agent-chat-client';
import { ConfirmationDialog } from '../confirmations/confirmation-dialog';
import { ToastOutlet } from '../toasts/toast-outlet';
import { useWindowZoomFactor } from '../window-zoom/use-window-zoom-factor';
import { WindowZoomHud } from '../window-zoom/window-zoom-hud';
import { PanelDivider } from '../workbench/panel-divider';
import {
    BOT_BOARD_DEFAULT_WIDTH,
    BOT_BOARD_MAX_WIDTH,
    BOT_BOARD_MIN_WIDTH,
    setBotBoardWidth,
    useBotBoardUiStore,
} from './bot-board-store';
import { BotBoardView } from './bot-board-view';
import { BotClearDataDialog } from './bot-clear-data-dialog';
import { BotCommandPalette } from './bot-command-palette';
import { BotHandoverDialog } from './bot-handover-dialog';
import { BotInboxColumn } from './bot-inbox-column';
import { useBotShortcuts } from './bot-shortcuts';
import { BotTerminal } from './bot-terminal';
import { CaxriBotHeader } from './caxri-bot-header';
import { useCaxriBot } from './hooks/use-caxri-bot';

/**
 * The Caxri Bot window: the board of every Workbench Session on the left, Caxri Bot's own Terminal in the middle, and
 * on the right the Inbox of what Caxri Bot raised for the user ("Needs you"). The user can collapse the board and hide
 * the Inbox from the title bar, and the Terminal takes the freed width. It renders no Workbench chrome and runs no
 * Workbench commands. Its own Command Palette (`Cmd+Shift+P`, which Desktop Main forwards here while this window is
 * focused) holds the window's actions, Clear Caxri Bot Data among them; every other menu accelerator stays with the
 * Workbench window, and the keyboard otherwise reaches only its Terminal's own actions.
 */
export function CaxriBotApp() {
    const { t } = useTranslation();
    const { retry, status } = useCaxriBot();
    useWorkbenchAppearance();
    useWindowZoomFactor();
    useBotShortcuts();
    // The Chat pane reads its projection from the query cache, which these patches keep current once it runs as a Chat.
    useEffect(() => subscribeAgentChatPatches(queryClient), []);
    const isBoardVisible = useBotBoardUiStore((state) => state.isVisible);
    const boardWidth = useBotBoardUiStore((state) => state.width);
    useEffect(() => {
        document.documentElement.style.setProperty('--bot-board-width', `${boardWidth}px`);
    }, [boardWidth]);
    return (
        <TooltipProvider>
            <div className="caxri-bot flex h-screen w-screen flex-col bg-background text-foreground">
                <CaxriBotHeader />
                <div className="relative flex min-h-0 flex-1">
                    {isBoardVisible && (
                        <>
                            <aside
                                aria-label={t('caxriBot.window.sessionsLabel')}
                                className="caxri-bot-board flex w-[var(--bot-board-width,360px)] flex-none flex-col bg-surface"
                            >
                                <BotBoardView />
                            </aside>
                            {/* The same seam as the Inbox column's: drag, arrow keys, and a double-click reset. */}
                            <div className="flex flex-none">
                                <PanelDivider
                                    ariaLabel={t('caxriBot.window.resizeSessions')}
                                    size={boardWidth}
                                    min={BOT_BOARD_MIN_WIDTH}
                                    max={BOT_BOARD_MAX_WIDTH}
                                    defaultSize={BOT_BOARD_DEFAULT_WIDTH}
                                    cssVariable="--bot-board-width"
                                    growDirection={1}
                                    orientation="vertical"
                                    onCommit={setBotBoardWidth}
                                />
                            </div>
                        </>
                    )}
                    <main className="caxri-bot-terminal relative min-h-0 min-w-0 flex-1">
                        <BotTerminal onRetry={retry} status={status} />
                    </main>
                    <BotInboxColumn />
                </div>
                <ConfirmationDialog />
                <BotHandoverDialog isFromWorkbench={false} />
                <BotCommandPalette />
                <BotClearDataDialog />
                <ToastOutlet />
                <WindowZoomHud />
            </div>
        </TooltipProvider>
    );
}
