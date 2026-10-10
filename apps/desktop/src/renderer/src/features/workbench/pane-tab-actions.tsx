import type { TerminalRecord } from '@caxri/protocol';

import { cn } from '../../lib/utilities';
import { EditorTabActions } from '../editor/editor-tab-actions';
import { AgentSurfaceToggle } from '../terminal/agent-surface-toggle';
import { NewTerminalButton } from '../terminal/new-terminal-button';

/**
 * The bar's trailing strip. With one tab, + floats over its end: a reserved slot showed the bar's fill as a block.
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
            className={`tab-actions relative flex h-11 flex-none items-center [-webkit-app-region:no-drag] ${editorPath || surfaceTerminal || hasTabsToSwitch ? 'px-1' : ''}`}
        >
            {editorPath && <EditorTabActions paneId={paneId} path={editorPath} />}
            {surfaceTerminal && <AgentSurfaceToggle terminal={surfaceTerminal} />}
            {hasPaneTabs && (
                <div
                    className={cn(
                        !hasTabsToSwitch &&
                            'absolute top-0 right-full z-[5] flex h-11 items-center pr-1 opacity-0 [-webkit-app-region:no-drag] group-hover/work-tabs:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100',
                    )}
                >
                    <NewTerminalButton paneId={paneId} />
                </div>
            )}
        </div>
    );
}
