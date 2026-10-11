import type { TerminalRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { EditorTabActions } from '../editor/editor-tab-actions';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { NewTerminalButton } from '../terminal/new-terminal-button';

/**
 * Hover-revealed controls stay hidden until the pointer enters the tab bar, keyboard focus lands on them, their popup
 * is open, or (for the surface toggle) a switch is still pending, so the bar reads as just its tabs at rest.
 */
const REVEAL_ON_HOVER =
    'opacity-0 group-hover/work-tabs:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 has-[[aria-busy=true]]:opacity-100';

/**
 * The bar's trailing strip. With one tab, the Terminal | Chat toggle and + float over its end: a reserved slot showed
 * the bar's fill as a block.
 */
export function PaneTabActions({
    editorPath,
    hasPaneTabs,
    hasTabsToSwitch,
    paneId,
    surfaceTerminal,
}: {
    editorPath: string | undefined;
    hasPaneTabs: boolean;
    hasTabsToSwitch: boolean;
    paneId: string;
    /**
     * The active tab's Agent Terminal when it can switch between Terminal and Chat.
     */
    surfaceTerminal: TerminalRecord | undefined;
}) {
    if (!editorPath && !hasPaneTabs) return null;
    return (
        <div
            className={`tab-actions relative flex h-11 flex-none items-center [-webkit-app-region:no-drag] ${editorPath || hasTabsToSwitch ? 'px-1' : ''}`}
        >
            {editorPath && <EditorTabActions paneId={paneId} path={editorPath} />}
            {hasPaneTabs && (
                <div
                    className={cn(
                        'flex items-center gap-1',
                        !hasTabsToSwitch &&
                            `absolute top-0 right-full z-[5] h-11 pr-1 [-webkit-app-region:no-drag] ${REVEAL_ON_HOVER}`,
                    )}
                >
                    {surfaceTerminal && (
                        <div className={cn('flex', hasTabsToSwitch && REVEAL_ON_HOVER)}>
                            <AgentSurfaceToggle terminal={surfaceTerminal} />
                        </div>
                    )}
                    <NewTerminalButton paneId={paneId} />
                </div>
            )}
        </div>
    );
}
