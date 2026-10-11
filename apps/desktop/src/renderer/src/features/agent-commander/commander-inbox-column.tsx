import { useEffect } from 'react';

import { PanelDivider } from '../workbench/panel-divider';
import {
    COMMANDER_INBOX_DEFAULT_WIDTH,
    COMMANDER_INBOX_MAX_WIDTH,
    COMMANDER_INBOX_MIN_WIDTH,
    setCommanderInboxWidth,
    useCommanderInboxUiStore,
} from './commander-inbox-store';
import { CommanderInboxView } from './commander-inbox-view';

/**
 * The resizable "Needs you" column on the right of the Agent Commander window. Below 1080px the window cannot fit the
 * board, a usable Terminal, and this column side by side, so the column overlays the Terminal as a drawer instead of
 * squeezing it, and its resize edge is hidden.
 */
export function CommanderInboxColumn() {
    const isVisible = useCommanderInboxUiStore((state) => state.isVisible);
    const width = useCommanderInboxUiStore((state) => state.width);
    useEffect(() => {
        document.documentElement.style.setProperty('--commander-inbox-width', `${width}px`);
    }, [width]);
    if (!isVisible) return null;
    return (
        <>
            <div className="flex flex-none max-[1080px]:hidden">
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
                className="agent-commander-inbox flex w-[var(--commander-inbox-width,352px)] flex-none flex-col bg-surface max-[1080px]:absolute max-[1080px]:inset-y-0 max-[1080px]:right-0 max-[1080px]:z-20 max-[1080px]:max-w-[calc(100%-48px)] max-[1080px]:border-l max-[1080px]:border-border max-[1080px]:shadow-xl"
            >
                <CommanderInboxView />
            </aside>
        </>
    );
}
