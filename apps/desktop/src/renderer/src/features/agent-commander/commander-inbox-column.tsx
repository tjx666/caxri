import { useEffect } from 'react';

import { cn } from '../../lib/utilities';
import { PanelDivider } from '../workbench/panel-divider';
import { useCommanderBoardUiStore } from './commander-board-store';
import {
    COMMANDER_INBOX_DEFAULT_WIDTH,
    COMMANDER_INBOX_MAX_WIDTH,
    COMMANDER_INBOX_MIN_WIDTH,
    setCommanderInboxWidth,
    useCommanderInboxUiStore,
} from './commander-inbox-store';
import { CommanderInboxView } from './commander-inbox-view';

/**
 * Below these window widths the column overlays the Terminal as a drawer and hides its resize edge. With the board open
 * that is 1080px: the board (360px), a usable Terminal, and this column no longer fit side by side. A collapsed board
 * frees its 360px, so the column stays beside the Terminal down to 720px. Tailwind needs each breakpoint as a literal.
 */
const INBOX_DRAWER_CLASS_NAMES = {
    withBoard: {
        edge: 'max-[1080px]:hidden',
        column: 'max-[1080px]:absolute max-[1080px]:inset-y-0 max-[1080px]:right-0 max-[1080px]:z-20 max-[1080px]:max-w-[calc(100%-48px)] max-[1080px]:border-l max-[1080px]:border-border max-[1080px]:shadow-xl',
    },
    withoutBoard: {
        edge: 'max-[720px]:hidden',
        column: 'max-[720px]:absolute max-[720px]:inset-y-0 max-[720px]:right-0 max-[720px]:z-20 max-[720px]:max-w-[calc(100%-48px)] max-[720px]:border-l max-[720px]:border-border max-[720px]:shadow-xl',
    },
} as const;

/**
 * The resizable "Needs you" column on the right of the Agent Commander window. When the window cannot fit it beside the
 * Terminal (see {@link INBOX_DRAWER_CLASS_NAMES}), it overlays the Terminal as a drawer instead of squeezing it.
 */
export function CommanderInboxColumn() {
    const isVisible = useCommanderInboxUiStore((state) => state.isVisible);
    const isBoardVisible = useCommanderBoardUiStore((state) => state.isVisible);
    const width = useCommanderInboxUiStore((state) => state.width);
    useEffect(() => {
        document.documentElement.style.setProperty('--commander-inbox-width', `${width}px`);
    }, [width]);
    if (!isVisible) return null;
    const drawer = INBOX_DRAWER_CLASS_NAMES[isBoardVisible ? 'withBoard' : 'withoutBoard'];
    return (
        <>
            <div className={cn('flex flex-none', drawer.edge)}>
                <PanelDivider
                    ariaLabel="Resize Needs you"
                    size={width}
                    min={COMMANDER_INBOX_MIN_WIDTH}
                    max={COMMANDER_INBOX_MAX_WIDTH}
                    defaultSize={COMMANDER_INBOX_DEFAULT_WIDTH}
                    cssVariable="--commander-inbox-width"
                    growDirection={-1}
                    orientation="vertical"
                    onCommit={setCommanderInboxWidth}
                />
            </div>
            <aside
                aria-label="Needs you"
                className={cn(
                    'agent-commander-inbox flex w-[var(--commander-inbox-width,352px)] flex-none flex-col bg-surface',
                    drawer.column,
                )}
            >
                <CommanderInboxView />
            </aside>
        </>
    );
}
