import type { TerminalRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { EditorTabActions } from '../editor/editor-tab-actions';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { NewTerminalButton } from '../terminal/new-terminal-button';

/**
 * With one tab, the + reveals on hover: hidden until the pointer enters the tab bar, keyboard focus lands on it, or its
 * popup is open, so the bar reads as just its tabs at rest. It collapses its width too, not only its opacity, so the
 * Terminal | Chat toggle that stays visible beside it sits flush against the tabs instead of beside an empty slot. The
 *
 * - Sits before the toggle, next to the tabs, so revealing it grows the strip toward the tabs and never moves the toggle
 *   out from under the pointer.
 */
const COLLAPSE_UNTIL_HOVER =
    'max-w-0 overflow-hidden opacity-0 group-hover/work-tabs:max-w-10 group-hover/work-tabs:overflow-visible group-hover/work-tabs:opacity-100 focus-within:max-w-10 focus-within:overflow-visible focus-within:opacity-100 has-[[data-popup-open]]:max-w-10 has-[[data-popup-open]]:overflow-visible has-[[data-popup-open]]:opacity-100';

/**
 * Hidden (opacity only) until the bar is hovered or focused: the one-tab strip without a toggle has nothing else to
 * keep visible, so it keeps the plain hover reveal.
 */
const REVEAL_ON_HOVER =
    'opacity-0 group-hover/work-tabs:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100';

/**
 * The Terminal | Chat toggle is visible at rest whenever the active tab can switch, so the user can find it without
 * hovering first, but muted until the bar is hovered or focused, or a switch is pending, so it does not compete with
 * the tabs.
 */
const MUTED_AT_REST =
    'opacity-60 group-hover/work-tabs:opacity-100 focus-within:opacity-100 has-[[aria-busy=true]]:opacity-100';

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
    const isFloating = !hasTabsToSwitch;
    return (
        <div
            className={`tab-actions relative flex h-11 flex-none items-center [-webkit-app-region:no-drag] ${editorPath || hasTabsToSwitch ? 'px-1' : ''}`}
        >
            {editorPath && <EditorTabActions paneId={paneId} path={editorPath} />}
            {hasPaneTabs && (
                <div
                    className={cn(
                        'flex items-center',
                        isFloating &&
                            'absolute top-0 right-full z-[5] h-11 pr-1 [-webkit-app-region:no-drag]',
                        isFloating && !surfaceTerminal && REVEAL_ON_HOVER,
                    )}
                >
                    <div
                        className={cn(
                            'flex',
                            isFloating && surfaceTerminal && COLLAPSE_UNTIL_HOVER,
                        )}
                    >
                        {/* The spacing lives inside the collapsing box, so a collapsed + leaves no gap. */}
                        <div className={cn('flex', surfaceTerminal && 'pr-1')}>
                            <NewTerminalButton paneId={paneId} />
                        </div>
                    </div>
                    {surfaceTerminal && (
                        <div className={cn('flex', MUTED_AT_REST)}>
                            <AgentSurfaceToggle terminal={surfaceTerminal} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
